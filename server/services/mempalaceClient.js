/**
 * MemPalace CLI Client
 * Wraps the mempalace CLI binary for programmatic semantic search.
 * Part of the unified memory search pipeline.
 *
 * FAILURE SEMANTICS — read before changing:
 *
 * This client THROWS when the backend is broken and returns [] only when the
 * backend answered and genuinely had no matches. That distinction is the whole
 * point. The previous version returned [] for every failure mode, so
 * unifiedSearchService's `degraded.push('semantic')` handler never fired, the
 * endpoint reported healthy while blind, and the semantic signal sat at null for
 * months without anyone noticing. A search backend that fails quietly is worse
 * than one that is switched off, because nothing downstream can tell.
 *
 * Caller contract (unifiedSearchService.fanOutSemantic) already wraps this in
 * .catch() -> logger.warn + degraded.push('semantic') + return [], so throwing
 * degrades the endpoint gracefully AND visibly. Do not "fix" this by catching
 * here.
 *
 * Rewritten 2026-07-20 under co-ujjh. The prior implementation was written
 * against a CLI interface that does not exist — see parseSearchOutput() for the
 * real grammar.
 */

import config from '../config.js';
import logger from './logService.js';

/** Thrown when the MemPalace backend cannot be reached or fails to answer. */
class MempalaceUnavailableError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'MempalaceUnavailableError';
        this.cause = cause;
    }
}

// ── Output grammar ───────────────────────────────────────────────────────────
// Captured live 2026-07-20 from `mempalace search "<q>" --results N`:
//
//   ============================================================
//     Results for: "<query>"
//   ============================================================
//
//     [1] <wing> / <room>
//         Source: <filename>
//         Match:  0.561
//
//         <content, indented 6 spaces, MAY CONTAIN BLANK LINES AND TABS>
//
//     <U+2500 box-drawing rule>
//     [2] <wing> / <room>
//         ...
//
// Two traps the old parser fell into:
//   1. `[1]` is a 1-BASED INDEX, not a score. The score is on the `Match:` line.
//      The old code parsed the index as the score, so every hit scored 1.0, 2.0…
//   2. Content contains blank lines, so splitting blocks on blank lines shreds
//      multi-paragraph results. Split on the `[N]` header instead.
// The separator is U+2500 (─), not an ASCII hyphen run.

const HEADER_RE = /^\s{0,4}\[(\d+)\]\s+(.+?)\s*$/;
const SOURCE_RE = /^\s+Source:\s*(.*?)\s*$/;
const MATCH_RE = /^\s+Match:\s*([0-9]*\.?[0-9]+)\s*$/;
const SEPARATOR_RE = /^\s*[─━┄┅=\-]{8,}\s*$/;

/**
 * Parse mempalace CLI stdout into structured results.
 *
 * @param {string} raw - Raw stdout from `mempalace search`
 * @returns {Array<{content: string, score: number, source: {type,wing,room,file}}>}
 */
function parseSearchOutput(raw) {
    if (!raw || typeof raw !== 'string') return [];

    const results = [];
    let current = null;

    const flush = () => {
        if (!current) return;
        const content = dedent(current.contentLines).trim();
        // A block with no content is a parse artifact, not a result.
        if (content.length > 0) {
            results.push({
                content,
                score: typeof current.score === 'number' ? current.score : 0,
                source: {
                    type: 'mempalace',
                    wing: current.wing,
                    room: current.room,
                    file: current.file || '',
                },
            });
        }
        current = null;
    };

    for (const line of raw.split('\n')) {
        const header = line.match(HEADER_RE);
        if (header) {
            // Headers sit at 2-space indent; content sits at 6. HEADER_RE caps
            // the indent at 4 precisely so a `[n]`-looking line inside content
            // cannot be mistaken for a new result.
            flush();
            const { wing, room } = splitWingRoom(header[2]);
            current = { wing, room, file: undefined, score: undefined, contentLines: [] };
            continue;
        }

        if (!current) continue; // banner / "Results for:" preamble

        if (current.file === undefined) {
            const src = line.match(SOURCE_RE);
            if (src) { current.file = src[1]; continue; }
        }
        if (current.score === undefined) {
            const m = line.match(MATCH_RE);
            if (m) { current.score = parseFloat(m[1]); continue; }
        }
        if (SEPARATOR_RE.test(line)) { flush(); continue; }

        current.contentLines.push(line);
    }
    flush();

    return results;
}

/** `coo / mydesk` -> {wing:'coo', room:'mydesk'} */
function splitWingRoom(s) {
    const parts = s.split('/').map(p => p.trim()).filter(Boolean);
    return { wing: parts[0] || '', room: parts.slice(1).join('/') || '' };
}

/**
 * Strip the common leading indent from content lines, preserving relative
 * indentation (the corpus contains code, where indentation is meaning).
 */
function dedent(lines) {
    const meaningful = lines.filter(l => l.trim().length > 0);
    if (meaningful.length === 0) return '';
    let min = Infinity;
    for (const l of meaningful) {
        const m = l.match(/^[ ]*/);
        min = Math.min(min, m ? m[0].length : 0);
    }
    if (!Number.isFinite(min) || min === 0) return lines.join('\n');
    return lines.map(l => (l.length >= min ? l.slice(min) : l.trimStart())).join('\n');
}

/**
 * Search the MemPalace via its CLI binary.
 *
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.limit=10] - Max results (maps to CLI `--results`)
 * @param {string} [options.wing]     - Restrict to one wing
 * @param {string} [options.room]     - Restrict to one room
 * @returns {Promise<Array<{content,score,source}>>} [] means "no matches"
 * @throws {MempalaceUnavailableError} when the backend is unreachable or errors
 */
async function searchMempalace(query, options = {}) {
    const { limit = 10, wing, room } = options;

    // An empty query is a caller bug, not a backend outage — do not throw.
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        logger.debug('mempalace search skipped: empty query');
        return [];
    }

    const binary = config.mempalaceBinary;
    const timeoutMs = config.mempalaceTimeoutMs;

    // Real CLI: search <query> [--wing W] [--room R] [--results N]
    // There is NO --json flag and NO --limit flag. The previous client sent
    // both; argparse rejected the invocation, and the retry path resent the
    // same bad --limit, so it failed identically.
    const args = ['search', query, '--results', String(limit)];
    if (wing) args.push('--wing', wing);
    if (room) args.push('--room', room);

    let proc;
    try {
        proc = Bun.spawn([binary, ...args], {
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env },
        });
    } catch (err) {
        throw new MempalaceUnavailableError(
            `mempalace binary not spawnable at "${binary}": ${err.message}. ` +
            `Set MEMPALACE_BINARY to an absolute path — it is typically absent ` +
            `from a systemd service PATH.`,
            err,
        );
    }

    const timeoutPromise = new Promise(resolve =>
        setTimeout(() => resolve({ timedOut: true }), timeoutMs));

    const processPromise = (async () => {
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        return { exitCode, stdout, stderr, timedOut: false };
    })();

    let result;
    try {
        result = await Promise.race([processPromise, timeoutPromise]);
    } catch (err) {
        throw new MempalaceUnavailableError(`mempalace search failed: ${err.message}`, err);
    }

    if (result.timedOut) {
        try { proc.kill(); } catch { /* best effort */ }
        // Cold-start measured at ~1.9s vs ~1.0s warm, so a tight timeout turns
        // a working backend into a silent one. Surface it rather than hide it.
        throw new MempalaceUnavailableError(
            `mempalace search timed out after ${timeoutMs}ms (cold start measures ~1.9s)`,
        );
    }

    if (result.exitCode !== 0) {
        throw new MempalaceUnavailableError(
            `mempalace exited ${result.exitCode}: ${(result.stderr || '').trim().slice(0, 300)}`,
        );
    }

    const parsed = parseSearchOutput(result.stdout);
    logger.debug('mempalace search completed', { query, resultCount: parsed.length });
    return parsed;
}

export {
    searchMempalace,
    parseSearchOutput,
    // Back-compat alias: the previous export name, kept so existing imports and
    // tests resolve.
    parseSearchOutput as parseMempalaceOutput,
    MempalaceUnavailableError,
};
