/**
 * Unified Search route for multi-signal memory search.
 * Part of co-1pc: unified memory search — Phase 2, Task 8.
 *
 * Accepts a query and optional parameters, delegates to the unified search
 * service which fans out to BM25, semantic, and entity backends.
 */
import express from 'express';

/**
 * Create the unified search router with an injected unified search service.
 *
 * @param {object} unifiedSearch - The unified search service (from createUnifiedSearch)
 * @returns {express.Router}
 */
export function createUnifiedSearchRouter(unifiedSearch) {
    const router = express.Router();

    /**
     * GET /api/v1/search/unified
     * Execute a unified search across BM25, semantic, and entity backends.
     *
     * Query params:
     *   q (required)  - Search query string (min 2 chars)
     *   scope         - Search scope label: 'enterprise' | 'rig' (default: 'enterprise')
     *   limit         - Max results (default: 10, max: 100)
     *   signals       - Comma-separated backends to query: 'bm25,semantic,entity' (default: all)
     *
     * Response: { query, scope, results, degraded, timings }
     *   - results: ranked array of { content, score, source, signals, additional_sources? }
     *   - degraded: array of backend names that failed (graceful degradation)
     *   - timings: per-backend latency in ms
     */
    router.get('/', async (req, res) => {
        const { q, scope, limit, signals } = req.query;

        if (!q || q.trim().length < 2) {
            return res.status(400).json({
                error: 'Query parameter "q" is required and must be at least 2 characters'
            });
        }

        const parsedLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 100);
        const parsedSignals = signals
            ? signals.split(',').filter(s => ['bm25', 'semantic', 'entity'].includes(s.trim()))
            : ['bm25', 'semantic', 'entity'];

        if (parsedSignals.length === 0) {
            return res.status(400).json({
                error: 'signals must include at least one of: bm25, semantic, entity'
            });
        }

        try {
            const results = await unifiedSearch.query(q.trim(), {
                scope: scope || 'enterprise',
                limit: parsedLimit,
                signals: parsedSignals,
            });

            res.json(results);
        } catch (err) {
            res.status(500).json({ error: 'Search failed', message: err.message });
        }
    });

    return router;
}
