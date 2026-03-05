import express from 'express';
import * as fileService from '../services/fileService.js';
import config from '../config.js';

const router = express.Router();

/**
 * GET /api/v1/files
 * List tracked files with filtering
 */
router.get('/', (req, res, next) => {
    try {
        const {
            projectId,
            includeDeleted,
            page = 1,
            limit = config.defaultPageSize
        } = req.query;

        const parsedPage = parseInt(page);
        const parsedLimit = parseInt(limit);
        const parsedProjectId = projectId ? parseInt(projectId) : undefined;

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
        if (projectId && isNaN(parsedProjectId)) {
            const error = new Error('projectId must be a valid integer');
            error.statusCode = 400;
            throw error;
        }

        const result = fileService.getTrackedFiles({
            projectId: parsedProjectId,
            includeDeleted: includeDeleted === 'true',
            page: parsedPage,
            limit: Math.min(parsedLimit, config.maxPageSize)
        });

        res.json(result);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/files/search
 * Search files by path pattern
 */
router.get('/search', (req, res, next) => {
    try {
        const { q, limit = 50 } = req.query;

        if (!q || q.length < 2) {
            const error = new Error('Search query must be at least 2 characters');
            error.statusCode = 400;
            throw error;
        }

        const files = fileService.searchFiles(q, Math.min(parseInt(limit), 100));
        res.json({ data: files });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/files/:id
 * Get single file details
 */
router.get('/:id', (req, res, next) => {
    try {
        const { id } = req.params;
        const parsedId = parseInt(id);

        if (isNaN(parsedId) || parsedId < 1) {
            const error = new Error('id must be a positive integer');
            error.statusCode = 400;
            throw error;
        }

        const file = fileService.getFileById(parsedId);

        if (!file) {
            const error = new Error('File not found');
            error.statusCode = 404;
            throw error;
        }

        res.json(file);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/files/:id/history
 * Get change history for a file
 */
router.get('/:id/history', (req, res, next) => {
    try {
        const { id } = req.params;
        const { limit = 50 } = req.query;

        const parsedId = parseInt(id);
        const parsedLimit = parseInt(limit);

        if (isNaN(parsedId) || parsedId < 1) {
            const error = new Error('id must be a positive integer');
            error.statusCode = 400;
            throw error;
        }
        if (isNaN(parsedLimit) || parsedLimit < 1) {
            const error = new Error('limit must be a positive integer');
            error.statusCode = 400;
            throw error;
        }

        const result = fileService.getFileHistory(parsedId, parsedLimit);

        if (!result) {
            const error = new Error('File not found');
            error.statusCode = 404;
            throw error;
        }

        res.json(result);
    } catch (err) {
        next(err);
    }
});

export default router;
