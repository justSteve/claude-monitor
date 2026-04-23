/**
 * MemPalace CLI Client
 * Wraps the mempalace CLI binary for programmatic search.
 * Part of the unified memory search pipeline (Phase 2).
 *
 * Graceful degradation: returns [] on any error, timeout, or missing binary.
 * Does not throw — callers can always safely iterate results.
 */

import config from '../config.js';
import logger from './logService.js';

/**
 * Search the MemPalace via its CLI binary.
 *
 * @param {string} query - Search query string
 * @param {object} [options] - Search options
 * @param {number} [options.limit=10] - Max results to return
 * @param {string} [options.wing] - Filter to a specific wing (e.g. 'projects', 'reference')
 * @returns {Promise<Array<{content: string, score: number, source: {type: string, wing: string, room: string, file: string}}>>}
 */
async function searchMempalace(query, options = {}) {
    const { limit = 10, wing } = options;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        logger.debug('mempalace search skipped: empty query');
        return [];
    }

    const binary = config.mempalaceBinary;
    const timeoutMs = config.mempalaceTimeoutMs;

    const args = ['search', query, '--limit', String(limit)];

    // Try JSON output first
    args.push('--json');

    if (wing) {
        args.push('--wing', wing);
    }

    let proc;
    try {
        proc = Bun.spawn([binary, ...args], {
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env },
        });
    } catch (err) {
        // Binary not found or spawn failure
        logger.debug('mempalace binary not available', {
            binary,
            error: err.message,
        });
        return [];
    }

    // Race the process against a timeout
    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });

    const processPromise = (async () => {
        try {
            const exitCode = await proc.exited;
            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            return { exitCode, stdout, stderr, timedOut: false };
        } catch (err) {
            return { exitCode: -1, stdout: '', stderr: err.message, timedOut: false };
        }
    })();

    const result = await Promise.race([processPromise, timeoutPromise]);

    if (result.timedOut) {
        logger.warn('mempalace search timed out', { query, timeoutMs });
        try { proc.kill(); } catch { /* best effort */ }
        return [];
    }

    if (result.exitCode !== 0) {
        logger.debug('mempalace search returned non-zero exit', {
            exitCode: result.exitCode,
            stderr: result.stderr?.substring(0, 200),
        });

        // If --json flag was rejected, retry without it
        if (result.stderr?.includes('--json') || result.stderr?.includes('unrecognized')) {
            return retryWithoutJson(binary, query, limit, wing, timeoutMs);
        }

        return [];
    }

    const parsed = parseMempalaceOutput(result.stdout);
    logger.debug('mempalace search completed', {
        query,
        resultCount: parsed.length,
    });
    return parsed;
}

/**
 * Retry search without the --json flag, falling back to text parsing.
 * @private
 */
async function retryWithoutJson(binary, query, limit, wing, timeoutMs) {
    const args = ['search', query, '--limit', String(limit)];
    if (wing) args.push('--wing', wing);

    let proc;
    try {
        proc = Bun.spawn([binary, ...args], {
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env },
        });
    } catch {
        return [];
    }

    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });

    const processPromise = (async () => {
        try {
            const exitCode = await proc.exited;
            const stdout = await new Response(proc.stdout).text();
            return { exitCode, stdout, timedOut: false };
        } catch {
            return { exitCode: -1, stdout: '', timedOut: false };
        }
    })();

    const result = await Promise.race([processPromise, timeoutPromise]);

    if (result.timedOut) {
        try { proc.kill(); } catch { /* best effort */ }
        return [];
    }

    if (result.exitCode !== 0) return [];

    return parseMempalaceOutput(result.stdout);
}

/**
 * Parse mempalace CLI output into structured results.
 * Tries JSON first, then falls back to line-based text parsing.
 *
 * Expected JSON format (array of objects):
 *   [{ "content": "...", "score": 0.95, "wing": "projects", "room": "COO", "file": "CLAUDE.md" }]
 *
 * Expected text format (one result per block, separated by blank lines):
 *   [0.95] projects/COO/CLAUDE.md
 *   Content line here...
 *
 * @param {string} raw - Raw stdout from mempalace CLI
 * @returns {Array<{content: string, score: number, source: {type: string, wing: string, room: string, file: string}}>}
 */
function parseMempalaceOutput(raw) {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        return [];
    }

    const trimmed = raw.trim();

    // Strategy 1: JSON array
    if (trimmed.startsWith('[')) {
        try {
            const arr = JSON.parse(trimmed);
            if (!Array.isArray(arr)) return [];
            return arr
                .filter(item => item && typeof item === 'object')
                .map(normalizeJsonResult);
        } catch {
            // JSON parse failed, fall through to text parsing
        }
    }

    // Strategy 2: JSONL (one JSON object per line)
    if (trimmed.startsWith('{')) {
        try {
            const results = [];
            for (const line of trimmed.split('\n')) {
                const stripped = line.trim();
                if (!stripped || !stripped.startsWith('{')) continue;
                try {
                    const obj = JSON.parse(stripped);
                    results.push(normalizeJsonResult(obj));
                } catch {
                    // Skip malformed lines
                }
            }
            if (results.length > 0) return results;
        } catch {
            // Fall through to text parsing
        }
    }

    // Strategy 3: Line-based text parsing
    // Expected: "[score] wing/room/file\ncontent..."
    return parseTextOutput(trimmed);
}

/**
 * Normalize a JSON result object into the canonical structure.
 * @private
 */
function normalizeJsonResult(item) {
    const score = typeof item.score === 'number' ? item.score : 0;
    const content = item.content || item.text || item.snippet || '';
    const wing = item.wing || item.category || '';
    const room = item.room || item.project || item.namespace || '';
    const file = item.file || item.path || item.source || '';

    return {
        content,
        score,
        source: {
            type: 'mempalace',
            wing,
            room,
            file,
        },
    };
}

/**
 * Parse text-format output into structured results.
 * Handles "[score] path\ncontent" blocks separated by blank lines.
 * @private
 */
function parseTextOutput(text) {
    const results = [];
    // Split on double newlines to get result blocks
    const blocks = text.split(/\n\s*\n/);

    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length === 0) continue;

        const headerLine = lines[0].trim();

        // Try to match "[score] wing/room/file" pattern
        const headerMatch = headerLine.match(/^\[([0-9.]+)\]\s+(.+)$/);
        if (headerMatch) {
            const score = parseFloat(headerMatch[1]) || 0;
            const pathStr = headerMatch[2];
            const { wing, room, file } = parsePath(pathStr);
            const content = lines.slice(1).join('\n').trim();

            results.push({
                content,
                score,
                source: { type: 'mempalace', wing, room, file },
            });
            continue;
        }

        // Try "score: N" on first line, path on second, content after
        const scoreMatch = headerLine.match(/^score:\s*([0-9.]+)/i);
        if (scoreMatch && lines.length >= 2) {
            const score = parseFloat(scoreMatch[1]) || 0;
            const { wing, room, file } = parsePath(lines[1].trim());
            const content = lines.slice(2).join('\n').trim();

            results.push({
                content,
                score,
                source: { type: 'mempalace', wing, room, file },
            });
            continue;
        }

        // Last resort: treat entire block as content with no metadata
        if (headerLine.length > 0) {
            results.push({
                content: block.trim(),
                score: 0,
                source: { type: 'mempalace', wing: '', room: '', file: '' },
            });
        }
    }

    return results;
}

/**
 * Split a path string like "projects/COO/CLAUDE.md" into wing/room/file.
 * @private
 */
function parsePath(pathStr) {
    const parts = pathStr.split('/').filter(Boolean);
    if (parts.length >= 3) {
        return {
            wing: parts[0],
            room: parts[1],
            file: parts.slice(2).join('/'),
        };
    }
    if (parts.length === 2) {
        return { wing: parts[0], room: '', file: parts[1] };
    }
    return { wing: '', room: '', file: pathStr };
}

export { searchMempalace, parseMempalaceOutput };
