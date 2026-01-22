import express from 'express';
import scheduler from '../services/schedulerService.js';

const router = express.Router();

/**
 * GET /api/v1/scheduler/status
 * Get scheduler status and health information
 */
router.get('/status', (req, res) => {
    const status = scheduler.getStatus();
    res.json(status);
});

/**
 * POST /api/v1/scheduler/start
 * Start the scheduler
 */
router.post('/start', (req, res) => {
    scheduler.start();
    res.json({
        success: true,
        message: 'Scheduler started',
        status: scheduler.getStatus()
    });
});

/**
 * POST /api/v1/scheduler/stop
 * Stop the scheduler
 */
router.post('/stop', (req, res) => {
    scheduler.stop();
    res.json({
        success: true,
        message: 'Scheduler stopped',
        status: scheduler.getStatus()
    });
});

/**
 * POST /api/v1/scheduler/run
 * Trigger an immediate scan
 */
router.post('/run', async (req, res, next) => {
    try {
        const result = await scheduler.runNow();
        res.json({
            success: true,
            result,
            status: scheduler.getStatus()
        });
    } catch (err) {
        next(err);
    }
});

export default router;
