import express from 'express';
import * as configExtractor from '../services/configExtractorService.js';
import config from '../config.js';

const router = express.Router();

/**
 * GET /api/v1/config-snapshots
 * List config snapshots with filtering
 */
router.get('/', (req, res, next) => {
    try {
        const {
            project_id,
            file_type,
            page = 1,
            limit = config.defaultPageSize
        } = req.query;

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

        const snapshots = configExtractor.listConfigSnapshots({
            projectId: parsedProjectId,
            fileType: file_type,
            limit: Math.min(parsedLimit, config.maxPageSize),
            offset: (parsedPage - 1) * parsedLimit
        });

        res.json({
            data: snapshots,
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
 * GET /api/v1/config-snapshots/project/:projectId
 * Get latest config snapshots for a project
 */
router.get('/project/:projectId', (req, res, next) => {
    try {
        const { projectId } = req.params;
        const parsedProjectId = parseInt(projectId);

        if (isNaN(parsedProjectId) || parsedProjectId < 1) {
            const error = new Error('projectId must be a positive integer');
            error.statusCode = 400;
            throw error;
        }

        const configs = configExtractor.getProjectConfigs(parsedProjectId);

        res.json({
            projectId: parsedProjectId,
            configs: configs.map(c => {
                let metadata;
                try {
                    metadata = JSON.parse(c.metadata);
                } catch {
                    metadata = {};
                }
                return { ...c, metadata };
            })
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/config-snapshots/history
 * Get config history for a specific file path
 */
router.get('/history', (req, res, next) => {
    try {
        const { file_path } = req.query;

        if (!file_path) {
            const error = new Error('file_path query parameter is required');
            error.statusCode = 400;
            throw error;
        }

        const history = configExtractor.getFileHistory(file_path);

        res.json({
            filePath: file_path,
            history
        });
    } catch (err) {
        next(err);
    }
});

export default router;
