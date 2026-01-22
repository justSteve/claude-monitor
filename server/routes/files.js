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

        const result = fileService.getTrackedFiles({
            projectId: projectId ? parseInt(projectId) : undefined,
            includeDeleted: includeDeleted === 'true',
            page: parseInt(page),
            limit: Math.min(parseInt(limit), config.maxPageSize)
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
        const file = fileService.getFileById(parseInt(id));

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

        const result = fileService.getFileHistory(parseInt(id), parseInt(limit));

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
