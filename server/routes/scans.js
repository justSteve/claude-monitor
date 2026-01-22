import express from 'express';
import * as scanService from '../services/scanService.js';
import config from '../config.js';

const router = express.Router();

/**
 * POST /api/v1/scans
 * Submit a new scan result (called by PowerShell)
 */
router.post('/', (req, res, next) => {
    try {
        const scanData = req.body;

        // Validate required fields
        if (!scanData.scanTime) {
            const error = new Error('scanTime is required');
            error.statusCode = 400;
            throw error;
        }

        const result = scanService.createScan(scanData);

        if (result.stored) {
            res.status(201).json({
                success: true,
                stored: true,
                scanId: Number(result.scanId),
                message: `Scan recorded successfully with ${result.filesProcessed} file changes`
            });
        } else {
            // Scan was not stored (no changes)
            res.status(200).json({
                success: true,
                stored: false,
                reason: result.reason,
                message: `Scan acknowledged but not stored (${result.reason})`,
                filesTracked: result.filesTracked
            });
        }
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/scans
 * List scans with pagination and filtering
 */
router.get('/', (req, res, next) => {
    try {
        const {
            page = 1,
            limit = config.defaultPageSize,
            startDate,
            endDate,
            hasChanges
        } = req.query;

        const result = scanService.getScans({
            page: parseInt(page),
            limit: Math.min(parseInt(limit), config.maxPageSize),
            startDate,
            endDate,
            hasChanges: hasChanges === 'true' ? true : hasChanges === 'false' ? false : undefined
        });

        res.json(result);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/scans/by-date/:date
 * Get all scans for a specific date
 */
router.get('/by-date/:date', (req, res, next) => {
    try {
        const { date } = req.params;
        const result = scanService.getScansByDate(date);

        if (result.error) {
            const error = new Error(result.error);
            error.statusCode = 400;
            throw error;
        }

        res.json(result.data);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/scans/:id
 * Get single scan with all file changes
 */
router.get('/:id', (req, res, next) => {
    try {
        const { id } = req.params;
        const scan = scanService.getScanById(parseInt(id));

        if (!scan) {
            const error = new Error('Scan not found');
            error.statusCode = 404;
            throw error;
        }

        res.json(scan);
    } catch (err) {
        next(err);
    }
});

export default router;
