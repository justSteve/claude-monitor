/**
 * Scheduler Service
 * Runs file monitoring on a configurable interval
 */

import { spawn } from 'child_process';
import path from 'path';
import config from '../config.js';
import logger from './logService.js';

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
        this.scriptPath = path.join(config.rootDir, 'Monitor-ClaudeFiles.ps1');
    }

    /**
     * Start the scheduler
     */
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

    /**
     * Stop the scheduler
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            logger.logSchedulerEvent('stopped');
        }
    }

    /**
     * Run a scan immediately (outside of schedule)
     */
    async runNow() {
        logger.info('Manual scan triggered');
        return this._runScan();
    }

    /**
     * Get scheduler status
     */
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

    /**
     * Execute the PowerShell monitoring script
     */
    async _runScan() {
        if (this.isRunning) {
            logger.warn('Scan already in progress, skipping');
            return { skipped: true, reason: 'already_running' };
        }

        this.isRunning = true;
        this.runCount++;
        const startTime = Date.now();

        try {
            logger.debug('Starting scan');

            const result = await new Promise((resolve, reject) => {
                const ps = spawn('powershell', [
                    '-NoProfile',
                    '-ExecutionPolicy', 'Bypass',
                    '-File', this.scriptPath
                ], {
                    cwd: config.rootDir,
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                let stdout = '';
                let stderr = '';

                ps.stdout.on('data', (data) => {
                    stdout += data.toString();
                });

                ps.stderr.on('data', (data) => {
                    stderr += data.toString();
                });

                ps.on('close', (code) => {
                    if (code === 0) {
                        resolve({ stdout, stderr, code });
                    } else {
                        reject(new Error(`PowerShell exited with code ${code}: ${stderr || stdout}`));
                    }
                });

                ps.on('error', (err) => {
                    reject(err);
                });

                // Timeout after 2 minutes
                setTimeout(() => {
                    ps.kill();
                    reject(new Error('Scan timed out after 2 minutes'));
                }, 120000);
            });

            // Parse output to get change count
            const changesMatch = result.stdout.match(/Files with changes:\s*(\d+)/);
            this.lastRunChanges = changesMatch ? parseInt(changesMatch[1]) : 0;

            this.lastRun = new Date().toISOString();
            this.lastRunDuration = Date.now() - startTime;
            this.lastRunStatus = 'success';
            this._updateNextRun();

            logger.debug('Scan completed', {
                duration: this.lastRunDuration,
                changes: this.lastRunChanges
            });

            return {
                success: true,
                duration: this.lastRunDuration,
                changes: this.lastRunChanges,
                output: result.stdout
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

// Singleton instance
const schedulerService = new SchedulerService();

export default schedulerService;
