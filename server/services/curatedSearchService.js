/**
 * Curated Search Service (co-ceyz3.1 — Federated Memory Search, phase 1)
 *
 * Keyword search over the enterprise's CURATED memory tiers, so unified search
 * stops covering only the involuntary tiers (transcripts, mempalace) while
 * skipping the deliberately-written ones:
 *
 *   - OKF bundles  — git-tracked concept files (COO `conventions/`, plus any
 *     domain bundles listed in config). Curated, typed, human-authored truth.
 *   - auto-memory  — every zgent's agent-written memory files under
 *     `~/.claude/projects/<project>/memory/`. Staging-tier capture.
 *
 * Why files, not a DB table: both tiers are already plain markdown on disk,
 * small (low hundreds of files), and owned by OTHER writers — CM must never
 * become a second writer or a sync layer for them (okf-memory.md governance).
 * Reading in place with an mtime-aware cache keeps CM a pure consumer and
 * means an edit is searchable within `refreshSeconds`, no ingest pipeline.
 *
 * Contract: `search(query, { limit })` returning
 *   { query, total_matches, count, hits: [{ snippet, content, score, source_path, tier, project }] }
 * — same consumer shape as transcriptSearchService, so unifiedSearchService
 * can fan out to it as a peer retriever.
 *
 * Degradation contract: throws only when NO configured root is readable
 * (unified search then marks the `curated` signal degraded). Individual
 * missing roots are logged once and reported in `missing_roots`.
 */

import fs from 'fs';
import path from 'path';

import logger from './logService.js';

import { tokenize, buildSnippet, coverageTfScore } from './textSearchUtils.js';

const { getConfig } = require('./scoringService.js');

// ── corpus cache ─────────────────────────────────────────────────────────────
// { builtAt: ms epoch, files: Map<absPath, {mtimeMs, content, tier, project}> }
let _cache = { builtAt: 0, files: new Map() };
const _warnedRoots = new Set();

const DEFAULT_REFRESH_SECONDS = 60;
const MAX_FILE_BYTES = 512 * 1024; // curated files are small; skip anything absurd

/**
 * Resolve the curated-corpus configuration with safe defaults.
 * @returns {{refreshSeconds:number, bundles:string[], autoMemoryParent:string, exclude:string[]}}
 */
function curatedConfig() {
    const c = getConfig().curated || {};
    return {
        refreshSeconds: c.refreshSeconds ?? DEFAULT_REFRESH_SECONDS,
        bundles: c.bundles ?? [],
        autoMemoryParent: c.autoMemoryParent ?? null,
        exclude: c.exclude ?? [],
    };
}

/**
 * List markdown files under a directory, recursively, honoring excludes.
 * @param {string} dir
 * @param {string[]} exclude - directory basenames to skip
 * @returns {string[]} absolute paths
 */
function listMarkdown(dir, exclude) {
    const out = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (exclude.includes(e.name)) continue;
            out.push(...listMarkdown(p, exclude));
        } else if (e.isFile() && e.name.endsWith('.md')) {
            out.push(p);
        }
    }
    return out;
}

/**
 * Enumerate every curated file with its tier and owning project.
 * @returns {{entries: Array<{path:string, tier:string, project:string|null}>, missing: string[]}}
 */
function enumerateCorpus() {
    const cfg = curatedConfig();
    const entries = [];
    const missing = [];

    for (const bundleDir of cfg.bundles) {
        try {
            for (const p of listMarkdown(bundleDir, cfg.exclude)) {
                entries.push({ path: p, tier: 'okf', project: path.basename(path.dirname(bundleDir)) });
            }
        } catch (err) {
            missing.push(bundleDir);
            if (!_warnedRoots.has(bundleDir)) {
                _warnedRoots.add(bundleDir);
                logger.warn('curated search: bundle root unreadable', { root: bundleDir, error: err.message });
            }
        }
    }

    if (cfg.autoMemoryParent) {
        try {
            const projects = fs.readdirSync(cfg.autoMemoryParent, { withFileTypes: true });
            for (const proj of projects) {
                if (!proj.isDirectory()) continue;
                const memDir = path.join(cfg.autoMemoryParent, proj.name, 'memory');
                let stat;
                try {
                    stat = fs.statSync(memDir);
                } catch {
                    continue; // most projects have no memory dir; not an error
                }
                if (!stat.isDirectory()) continue;
                for (const p of listMarkdown(memDir, cfg.exclude)) {
                    entries.push({ path: p, tier: 'auto-memory', project: proj.name });
                }
            }
        } catch (err) {
            missing.push(cfg.autoMemoryParent);
            if (!_warnedRoots.has(cfg.autoMemoryParent)) {
                _warnedRoots.add(cfg.autoMemoryParent);
                logger.warn('curated search: auto-memory root unreadable', {
                    root: cfg.autoMemoryParent,
                    error: err.message,
                });
            }
        }
    }

    return { entries, missing };
}

/**
 * Refresh the in-memory corpus if it is older than refreshSeconds.
 * Reloads only files whose mtime changed; drops files that vanished.
 * @returns {{missing: string[]}}
 */
function refreshCorpus() {
    const cfg = curatedConfig();
    const now = Date.now();
    if (now - _cache.builtAt < cfg.refreshSeconds * 1000) {
        return { missing: [] };
    }

    const { entries, missing } = enumerateCorpus();
    const next = new Map();
    let loaded = 0;

    for (const { path: p, tier, project } of entries) {
        let stat;
        try {
            stat = fs.statSync(p);
        } catch {
            continue;
        }
        if (stat.size > MAX_FILE_BYTES) continue;

        const prev = _cache.files.get(p);
        if (prev && prev.mtimeMs === stat.mtimeMs) {
            next.set(p, prev);
            continue;
        }
        try {
            next.set(p, { mtimeMs: stat.mtimeMs, content: fs.readFileSync(p, 'utf-8'), tier, project });
            loaded++;
        } catch (err) {
            logger.warn('curated search: file unreadable, skipped', { path: p, error: err.message });
        }
    }

    _cache = { builtAt: now, files: next };
    if (loaded > 0) {
        logger.info('curated corpus refreshed', { files: next.size, reloaded: loaded, missing_roots: missing });
    }
    return { missing };
}

/**
 * Search the curated corpus (OKF bundles + auto-memory) for the query terms.
 * Scoring is the shared coverage-weighted TF scheme (textSearchUtils) — the
 * unified layer fuses by rank, so only relative order matters here.
 *
 * @param {string} query
 * @param {object} [filters]
 * @param {number} [filters.limit=20]
 * @returns {Promise<{query, total_matches, count, hits: Array, missing_roots: string[]}>}
 */
async function search(query, filters = {}) {
    const { limit = 20 } = filters;
    const terms = tokenize(query);

    const { missing } = refreshCorpus();

    if (_cache.files.size === 0) {
        // Nothing readable at all: this is a real degradation, not an empty answer.
        throw new Error(`curated corpus empty — no readable roots (missing: ${missing.join(', ') || 'none configured'})`);
    }

    if (terms.length === 0) {
        return { query, total_matches: 0, count: 0, hits: [], missing_roots: missing, sources_queried: ['curated'] };
    }

    const scored = [];
    for (const [p, f] of _cache.files) {
        const score = coverageTfScore(f.content, terms);
        if (score === 0) continue;
        scored.push({
            snippet: buildSnippet(f.content, terms),
            content: f.content,
            score,
            source_path: p,
            tier: f.tier,
            project: f.project,
            match_type: 'curated_keyword',
            source_environment: 'cm-curated',
        });
    }

    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, limit);

    return {
        query,
        total_matches: scored.length,
        count: hits.length,
        hits,
        missing_roots: missing,
        sources_queried: ['curated'],
    };
}

/** Test seam: drop the cache so the next search rescans immediately. */
function _resetCache() {
    _cache = { builtAt: 0, files: new Map() };
    _warnedRoots.clear();
}

export { search, _resetCache };

export default { search, _resetCache };
