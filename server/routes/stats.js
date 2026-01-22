import express from 'express';
import * as statsService from '../services/statsService.js';

const router = express.Router();

/**
 * GET /api/v1/stats
 * Get aggregate statistics
 */
router.get('/', (req, res, next) => {
    try {
        const { period = 'day' } = req.query;

        if (!['day', 'week', 'month', 'all'].includes(period)) {
            const error = new Error('Invalid period. Use: day, week, month, or all');
            error.statusCode = 400;
            throw error;
        }

        const stats = statsService.getStats(period);
        res.json(stats);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/stats/trends
 * Get change trends over time
 */
router.get('/trends', (req, res, next) => {
    try {
        const { days = 7, granularity = 'hour' } = req.query;

        if (!['hour', 'day'].includes(granularity)) {
            const error = new Error('Invalid granularity. Use: hour or day');
            error.statusCode = 400;
            throw error;
        }

        const daysNum = Math.min(Math.max(parseInt(days), 1), 90);
        const trends = statsService.getTrends(daysNum, granularity);
        res.json(trends);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/stats/recent
 * Get recent activity summary
 */
router.get('/recent', (req, res, next) => {
    try {
        const { hours = 24 } = req.query;
        const hoursNum = Math.min(Math.max(parseInt(hours), 1), 168); // Max 1 week

        const activity = statsService.getRecentActivity(hoursNum);
        res.json(activity);
    } catch (err) {
        next(err);
    }
});

export default router;
