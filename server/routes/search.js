/**
 * Search Routes
 * Enterprise search mediator API - wraps CASS for zgent consumption.
 */

import express from 'express';
import * as cassSearch from '../services/cassSearchService.js';
import config from '../config.js';

const router = express.Router();

/**
 * GET /api/v1/search
 * Search across Claude Code sessions in both WSL and Windows environments.
 *
 * Query params:
 *   q (required) - Search query string
 *   limit - Max results (default: 20, max: 100)
 *   offset - Pagination offset (default: 0)
 *   agent - Filter by agent slug (e.g., 'claude_code')
 *   workspace - Filter by workspace path
 *   since - Filter from date (YYYY-MM-DD)
 *   until - Filter to date (YYYY-MM-DD)
 *   days - Filter to last N days
 *   source - Comma-separated sources: 'wsl', 'windows' (default: both)
 */
router.get('/', async (req, res, next) => {
    try {
        const {
            q,
            limit = 20,
            offset = 0,
            agent,
            workspace,
            since,
            until,
            days,
            source
        } = req.query;

        if (!q || !q.trim()) {
            const error = new Error('Query parameter "q" is required');
            error.statusCode = 400;
            throw error;
        }

        const parsedLimit = Math.min(parseInt(limit) || 20, config.maxPageSize);
        const parsedOffset = parseInt(offset) || 0;
        const parsedDays = days ? parseInt(days) : undefined;

        if (parsedLimit < 1) {
            const error = new Error('limit must be a positive integer');
            error.statusCode = 400;
            throw error;
        }

        const sources = source ? source.split(',').map(s => s.trim()) : ['wsl', 'windows'];
        const validSources = sources.filter(s => ['wsl', 'windows'].includes(s));
        if (validSources.length === 0) {
            const error = new Error('source must be one or more of: wsl, windows');
            error.statusCode = 400;
            throw error;
        }

        const results = await cassSearch.search(q.trim(), {
            limit: parsedLimit,
            offset: parsedOffset,
            agent,
            workspace,
            since,
            until,
            days: parsedDays,
            sources: validSources
        });

        res.json(results);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/search/stats
 * Get CASS index statistics for both sources.
 */
router.get('/stats', async (req, res, next) => {
    try {
        const stats = await cassSearch.getStats();
        res.json(stats);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/search/health
 * Check CASS binary health.
 */
router.get('/health', async (req, res, next) => {
    try {
        const health = await cassSearch.getHealth();
        res.json(health);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/v1/search/reindex
 * Trigger CASS reindex of both sources.
 * Body: { full: boolean }
 */
router.post('/reindex', async (req, res, next) => {
    try {
        const { full = false } = req.body || {};
        const result = await cassSearch.reindex({ full });
        res.json(result);
    } catch (err) {
        next(err);
    }
});

export default router;
