/**
 * CASS Search Service
 * Wraps the CASS (coding_agent_session_search) CLI binary for programmatic search.
 * Queries both WSL and Windows CASS indexes and merges results.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from './logService.js';

const execFileAsync = promisify(execFile);

const CASS_BINARY = process.env.CASS_BINARY || '/usr/local/bin/cass';
const CASS_WSL_DATA_DIR = process.env.CASS_WSL_DATA_DIR || null; // null = default
const CASS_WINDOWS_DATA_DIR = process.env.CASS_WINDOWS_DATA_DIR || '/root/.local/share/coding-agent-search-windows';
const CASS_TIMEOUT_MS = parseInt(process.env.CASS_TIMEOUT_MS) || 30000;

/**
 * Execute a CASS CLI command and return parsed JSON output.
 * @param {string[]} args - Arguments to pass to CASS
 * @param {object} [options] - Options
 * @param {string} [options.dataDir] - Override CASS data directory
 * @returns {Promise<object>} Parsed JSON output
 */
async function execCass(args, options = {}) {
    const fullArgs = [...args];

    if (options.dataDir) {
        // --data-dir must come after the subcommand for CASS
        // Insert after the first arg (the subcommand name)
        fullArgs.splice(1, 0, '--data-dir', options.dataDir);
    }

    try {
        const { stdout, stderr } = await execFileAsync(CASS_BINARY, fullArgs, {
            timeout: CASS_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024, // 10MB
            env: {
                ...process.env,
                CODING_AGENT_SEARCH_NO_UPDATE_PROMPT: '1',
                CASS_NO_COLOR: '1'
            }
        });

        if (stderr && !stderr.includes('WARN') && !stderr.includes('INFO')) {
            logger.debug('CASS stderr', { stderr: stderr.substring(0, 500) });
        }

        try {
            return JSON.parse(stdout);
        } catch (parseErr) {
            logger.error('Failed to parse CASS JSON output', {
                error: parseErr.message,
                stdout: stdout.substring(0, 200)
            });
            throw new Error(`CASS returned invalid JSON: ${parseErr.message}`);
        }
    } catch (err) {
        if (err.killed) {
            throw new Error(`CASS command timed out after ${CASS_TIMEOUT_MS}ms`);
        }
        if (err.code === 'ENOENT') {
            throw new Error(`CASS binary not found at ${CASS_BINARY}`);
        }
        throw err;
    }
}

/**
 * Search across both WSL and Windows CASS indexes.
 * @param {string} query - Search query string
 * @param {object} [filters] - Search filters
 * @param {number} [filters.limit=20] - Max results per source
 * @param {number} [filters.offset=0] - Pagination offset
 * @param {string} [filters.agent] - Filter by agent (e.g., 'claude_code')
 * @param {string} [filters.workspace] - Filter by workspace path
 * @param {string} [filters.since] - Filter from date (YYYY-MM-DD)
 * @param {string} [filters.until] - Filter to date (YYYY-MM-DD)
 * @param {number} [filters.days] - Filter to last N days
 * @param {string[]} [filters.sources] - Which sources to search: ['wsl', 'windows'] (default: both)
 * @returns {Promise<object>} Merged search results
 */
async function search(query, filters = {}) {
    const {
        limit = 20,
        offset = 0,
        agent,
        workspace,
        since,
        until,
        days,
        sources = ['wsl', 'windows']
    } = filters;

    const baseArgs = ['search', query, '--json', '--limit', String(limit), '--offset', String(offset)];

    if (agent) baseArgs.push('--agent', agent);
    if (workspace) baseArgs.push('--workspace', workspace);
    if (since) baseArgs.push('--since', since);
    if (until) baseArgs.push('--until', until);
    if (days) baseArgs.push('--days', String(days));

    const searchPromises = [];

    if (sources.includes('wsl')) {
        searchPromises.push(
            execCass(baseArgs, { dataDir: CASS_WSL_DATA_DIR })
                .then(result => ({ source: 'wsl', ...result }))
                .catch(err => {
                    logger.warn('WSL CASS search failed', { error: err.message });
                    return { source: 'wsl', hits: [], count: 0, total_matches: 0, error: err.message };
                })
        );
    }

    if (sources.includes('windows')) {
        searchPromises.push(
            execCass(baseArgs, { dataDir: CASS_WINDOWS_DATA_DIR })
                .then(result => ({ source: 'windows', ...result }))
                .catch(err => {
                    logger.warn('Windows CASS search failed', { error: err.message });
                    return { source: 'windows', hits: [], count: 0, total_matches: 0, error: err.message };
                })
        );
    }

    const results = await Promise.all(searchPromises);

    return mergeResults(query, results, limit);
}

/**
 * Merge results from multiple CASS sources, sorted by score descending.
 * @param {string} query - Original query
 * @param {object[]} sourceResults - Results from each source
 * @param {number} limit - Max total results
 * @returns {object} Merged result set
 */
function mergeResults(query, sourceResults, limit) {
    const allHits = [];
    let totalMatches = 0;
    const errors = [];

    for (const result of sourceResults) {
        if (result.error) {
            errors.push({ source: result.source, error: result.error });
            continue;
        }

        totalMatches += (result.total_matches || 0);

        if (result.hits) {
            for (const hit of result.hits) {
                allHits.push({
                    ...hit,
                    source_environment: result.source
                });
            }
        }
    }

    // Sort by score descending
    allHits.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Trim to limit
    const hits = allHits.slice(0, limit);

    return {
        query,
        total_matches: totalMatches,
        count: hits.length,
        hits: hits.map(formatHit),
        sources_queried: sourceResults.map(r => r.source),
        errors: errors.length > 0 ? errors : undefined
    };
}

/**
 * Format a CASS hit into a consistent result structure.
 * @param {object} hit - Raw CASS hit
 * @returns {object} Formatted hit
 */
function formatHit(hit) {
    return {
        title: hit.title || null,
        snippet: hit.snippet || hit.content || null,
        score: hit.score || 0,
        source_path: hit.source_path || null,
        agent: hit.agent || 'unknown',
        workspace: hit.workspace || null,
        created_at: hit.created_at ? new Date(hit.created_at).toISOString() : null,
        line_number: hit.line_number || null,
        match_type: hit.match_type || 'unknown',
        source_environment: hit.source_environment || 'unknown',
        source_id: hit.source_id || null,
        origin_kind: hit.origin_kind || null
    };
}

/**
 * Get CASS index statistics from both sources.
 * @returns {Promise<object>} Combined statistics
 */
async function getStats() {
    const statPromises = [
        execCass(['stats', '--json'])
            .then(result => ({ source: 'wsl', ...result }))
            .catch(err => ({ source: 'wsl', error: err.message })),
        execCass(['stats', '--json'], { dataDir: CASS_WINDOWS_DATA_DIR })
            .then(result => ({ source: 'windows', ...result }))
            .catch(err => ({ source: 'windows', error: err.message }))
    ];

    const results = await Promise.all(statPromises);

    return {
        sources: results,
        totals: {
            conversations: results.reduce((sum, r) => sum + (r.conversations || 0), 0),
            messages: results.reduce((sum, r) => sum + (r.messages || 0), 0)
        }
    };
}

/**
 * Get CASS health status.
 * @returns {Promise<object>} Health status
 */
async function getHealth() {
    try {
        const { stdout } = await execFileAsync(CASS_BINARY, ['health'], {
            timeout: 5000,
            env: {
                ...process.env,
                CODING_AGENT_SEARCH_NO_UPDATE_PROMPT: '1'
            }
        });
        return { status: 'healthy', binary: CASS_BINARY };
    } catch (err) {
        return {
            status: 'unhealthy',
            binary: CASS_BINARY,
            error: err.message
        };
    }
}

/**
 * Trigger a CASS re-index of both sources.
 * @param {object} [options] - Index options
 * @param {boolean} [options.full=false] - Full rebuild
 * @returns {Promise<object>} Index results
 */
async function reindex(options = {}) {
    const args = ['index', '--json'];
    if (options.full) args.push('--full');

    const indexPromises = [
        execCass(args)
            .then(result => ({ source: 'wsl', ...result }))
            .catch(err => ({ source: 'wsl', error: err.message })),
        execFileAsync(CASS_BINARY, [args[0], '--data-dir', CASS_WINDOWS_DATA_DIR, ...args.slice(1)], {
            timeout: 300000, // 5 minutes for indexing
            maxBuffer: 10 * 1024 * 1024,
            env: {
                ...process.env,
                HOME: '/mnt/c/Users/Steve',
                CODING_AGENT_SEARCH_NO_UPDATE_PROMPT: '1'
            }
        })
            .then(({ stdout }) => ({ source: 'windows', ...JSON.parse(stdout) }))
            .catch(err => ({ source: 'windows', error: err.message }))
    ];

    const results = await Promise.all(indexPromises);
    logger.info('CASS reindex completed', {
        sources: results.map(r => ({
            source: r.source,
            conversations: r.total_conversations,
            error: r.error
        }))
    });

    return { sources: results };
}

export {
    search,
    getStats,
    getHealth,
    reindex
};
