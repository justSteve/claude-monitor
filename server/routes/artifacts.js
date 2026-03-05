import express from 'express';
import * as artifactExtractor from '../services/artifactExtractorService.js';
import config from '../config.js';

const router = express.Router();

/**
 * GET /api/v1/artifacts/search
 * Search artifacts across all conversations
 */
router.get('/search', (req, res, next) => {
    try {
        const {
            q,
            project_id,
            type,
            page = 1,
            limit = config.defaultPageSize
        } = req.query;

        if (!q || q.trim().length < 2) {
            const error = new Error('Search query (q) must be at least 2 characters');
            error.statusCode = 400;
            throw error;
        }

        const parsedPage = parseInt(page);
        const parsedLimit = parseInt(limit);
        const parsedProjectId = project_id ? parseInt(project_id) : undefined;

        if (isNaN(parsedPage) || parsedPage < 1) {
            const error = new Error('page must be a positive integer');
            error.statusCode = 400;
            throw error;
        }
        if (isNaN(parsedLimit) || parsedLimit < 1) {
            const error = new Error('limit must be a positive integer');
            error.statusCode = 400;
            throw error;
        }
        if (project_id && isNaN(parsedProjectId)) {
            const error = new Error('project_id must be a valid integer');
            error.statusCode = 400;
            throw error;
        }

        const artifacts = artifactExtractor.searchArtifacts(q.trim(), {
            projectId: parsedProjectId,
            type,
            limit: Math.min(parsedLimit, config.maxPageSize),
            offset: (parsedPage - 1) * parsedLimit
        });

        res.json({
            data: artifacts,
            query: q.trim(),
            pagination: {
                page: parsedPage,
                limit: parsedLimit
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/artifacts/stats
 * Get global artifact statistics
 */
router.get('/stats', (req, res, next) => {
    try {
        const stats = artifactExtractor.getArtifactStats();
        res.json(stats);
    } catch (err) {
        next(err);
    }
});

export default router;
