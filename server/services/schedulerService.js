/**
 * Scheduler Service
 * Runs native file scanner on a configurable interval
 */

import config from '../config.js';
import logger from './logService.js';
import fileScanner from './fileScannerService.js';

class SchedulerService {
    constructor() {
        this.intervalMs = config.scanIntervalMs;
        this.timer = null;
        this.isRunning = false;
        this.lastRun = null;
        this.lastRunDuration = null;
        this.lastRunStatus = null;
        this.lastRunChanges = 0;
        this.nextRun = null;
        this.runCount = 0;
        this.errorCount = 0;
    }

    start() {
        if (this.timer) {
            logger.warn('Scheduler already running');
            return;
        }

        logger.logSchedulerEvent('started', { intervalMs: this.intervalMs });

        // Run immediately on start
        this._runScan();

        // Then run on interval
        this.timer = setInterval(() => {
            this._runScan();
        }, this.intervalMs);

        this._updateNextRun();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            logger.logSchedulerEvent('stopped');
        }
    }

    async runNow() {
        logger.info('Manual scan triggered');
        return this._runScan();
    }

    getStatus() {
        return {
            running: this.timer !== null,
            scanning: this.isRunning,
            intervalMs: this.intervalMs,
            lastRun: this.lastRun,
            lastRunDuration: this.lastRunDuration,
            lastRunStatus: this.lastRunStatus,
            lastRunChanges: this.lastRunChanges,
            nextRun: this.nextRun,
            runCount: this.runCount,
            errorCount: this.errorCount
        };
    }

    _updateNextRun() {
        if (this.timer) {
            this.nextRun = new Date(Date.now() + this.intervalMs).toISOString();
        } else {
            this.nextRun = null;
        }
    }

    _runScan() {
        if (this.isRunning) {
            logger.warn('Scan already in progress, skipping');
            return { skipped: true, reason: 'already_running' };
        }

        this.isRunning = true;
        this.runCount++;
        const startTime = Date.now();

        try {
            const result = fileScanner.scan();

            this.lastRunChanges = result.filesWithChange.length;
            this.lastRun = new Date().toISOString();
            this.lastRunDuration = Date.now() - startTime;
            this.lastRunStatus = 'success';
            this._updateNextRun();

            return {
                success: true,
                duration: this.lastRunDuration,
                changes: this.lastRunChanges
            };

        } catch (err) {
            this.errorCount++;
            this.lastRun = new Date().toISOString();
            this.lastRunDuration = Date.now() - startTime;
            this.lastRunStatus = 'error';
            this._updateNextRun();

            logger.error('Scan failed', { error: err.message });

            return {
                success: false,
                error: err.message,
                duration: this.lastRunDuration
            };

        } finally {
            this.isRunning = false;
        }
    }
}

const schedulerService = new SchedulerService();
export default schedulerService;
