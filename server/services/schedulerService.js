/**
 * Scheduler Service
 * Runs native file scanner and conversation ingestion on a configurable interval
 */

import fs from 'fs';
import path from 'path';
import config from '../config.js';
import logger from './logService.js';
import fileScanner from './fileScannerService.js';
import conversationParser from './conversationParserService.js';
import db from '../db/index.js';

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

    _lookupProjectId(projectDirName) {
        try {
            const database = db.getDb();
            const row = database.prepare('SELECT id FROM projects WHERE name = ?').get(projectDirName);
            return row?.id || null;
        } catch {
            return null;
        }
    }

    async _ingestConversations() {
        const claudeProjectsDir = path.join(config.scanRoots.find(r => r.mode === 'direct')?.path || '/root/.claude', 'projects');
        if (!fs.existsSync(claudeProjectsDir)) return { parsed: 0, errors: 0 };

        let parsed = 0;
        let errors = 0;

        let projectDirs;
        try {
            projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
        } catch {
            return { parsed: 0, errors: 0 };
        }

        for (const dir of projectDirs) {
            if (!dir.isDirectory()) continue;
            const dirPath = path.join(claudeProjectsDir, dir.name);
            const projectId = this._lookupProjectId(dir.name);

            let files;
            try {
                files = fs.readdirSync(dirPath);
            } catch {
                continue;
            }

            for (const file of files) {
                if (!file.endsWith('.jsonl')) continue;
                const filePath = path.join(dirPath, file);
                try {
                    const result = await conversationParser.processFile(filePath, projectId);
                    if (result.newEntries > 0) {
                        parsed += result.newEntries;
                        logger.info('Ingested conversation entries', {
                            file: file,
                            project: dir.name,
                            newEntries: result.newEntries
                        });
                    }
                } catch (err) {
                    errors++;
                    logger.warn('Failed to parse conversation file', {
                        file: filePath,
                        error: err.message
                    });
                }
            }
        }

        return { parsed, errors };
    }

    async _runScan() {
        if (this.isRunning) {
            logger.warn('Scan already in progress, skipping');
            return { skipped: true, reason: 'already_running' };
        }

        this.isRunning = true;
        this.runCount++;
        const startTime = Date.now();

        try {
            const result = fileScanner.scan();
            const convoResult = await this._ingestConversations();

            this.lastRunChanges = result.filesWithChange.length;
            this.lastRun = new Date().toISOString();
            this.lastRunDuration = Date.now() - startTime;
            this.lastRunStatus = 'success';
            this._updateNextRun();

            return {
                success: true,
                duration: this.lastRunDuration,
                changes: this.lastRunChanges,
                conversations: convoResult
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
