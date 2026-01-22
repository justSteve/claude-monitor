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

        const snapshots = configExtractor.listConfigSnapshots({
            projectId: project_id ? parseInt(project_id) : undefined,
            fileType: file_type,
            limit: Math.min(parseInt(limit), config.maxPageSize),
            offset: (parseInt(page) - 1) * parseInt(limit)
        });

        res.json({
            data: snapshots,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit)
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
        const configs = configExtractor.getProjectConfigs(parseInt(projectId));

        res.json({
            projectId: parseInt(projectId),
            configs: configs.map(c => ({
                ...c,
                metadata: JSON.parse(c.metadata)
            }))
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
