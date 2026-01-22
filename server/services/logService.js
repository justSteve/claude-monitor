/**
 * Logging Service
 * Handles file logging and Windows Event Log integration
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import config from '../config.js';

const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
};

const LOG_LEVEL_NAMES = ['ERROR', 'WARN', 'INFO', 'DEBUG'];

class LogService {
    constructor() {
        this.logDir = config.logDir;
        this.logLevel = LOG_LEVELS[config.logLevel.toUpperCase()] ?? LOG_LEVELS.INFO;
        this.eventSource = 'ClaudeMonitor';
        this.maxLogFiles = 7; // Keep 7 days of logs
        this.currentLogFile = null;
        this.currentLogDate = null;

        this._ensureLogDir();
        this._cleanOldLogs();
    }

    _ensureLogDir() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    _getLogFilePath() {
        const today = new Date().toISOString().split('T')[0];
        if (this.currentLogDate !== today) {
            this.currentLogDate = today;
            this.currentLogFile = path.join(this.logDir, `server-${today}.log`);
        }
        return this.currentLogFile;
    }

    _cleanOldLogs() {
        try {
            const files = fs.readdirSync(this.logDir)
                .filter(f => f.startsWith('server-') && f.endsWith('.log'))
                .sort()
                .reverse();

            // Remove files beyond maxLogFiles
            files.slice(this.maxLogFiles).forEach(file => {
                fs.unlinkSync(path.join(this.logDir, file));
            });
        } catch (err) {
            console.error('Error cleaning old logs:', err.message);
        }
    }

    _formatMessage(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
        return `[${timestamp}] [${LOG_LEVEL_NAMES[level]}] ${message}${metaStr}`;
    }

    _writeToFile(formattedMessage) {
        try {
            const logFile = this._getLogFilePath();
            fs.appendFileSync(logFile, formattedMessage + '\n');
        } catch (err) {
            console.error('Error writing to log file:', err.message);
        }
    }

    /**
     * Write to Windows Event Log
     * @param {string} message - Log message
     * @param {string} entryType - 'Information', 'Warning', or 'Error'
     */
    _writeToEventLog(message, entryType = 'Information') {
        // Use PowerShell to write to Event Log
        const script = `
            $source = '${this.eventSource}'
            if (-not [System.Diagnostics.EventLog]::SourceExists($source)) {
                try {
                    New-EventLog -LogName Application -Source $source -ErrorAction Stop
                } catch {
                    # Source might already exist or need admin rights
                }
            }
            try {
                Write-EventLog -LogName Application -Source $source -EntryType ${entryType} -EventId 1000 -Message '${message.replace(/'/g, "''")}'
            } catch {
                # Silently fail if can't write to event log
            }
        `;

        const ps = spawn('powershell', ['-NoProfile', '-Command', script], {
            stdio: 'ignore',
            detached: true
        });
        ps.unref();
    }

    _log(level, message, meta = {}, eventLog = false, eventType = 'Information') {
        if (level > this.logLevel) return;

        const formatted = this._formatMessage(level, message, meta);

        // Console output
        if (level === LOG_LEVELS.ERROR) {
            console.error(formatted);
        } else if (level === LOG_LEVELS.WARN) {
            console.warn(formatted);
        } else {
            console.log(formatted);
        }

        // File output
        this._writeToFile(formatted);

        // Event Log (for important events)
        if (eventLog) {
            this._writeToEventLog(message, eventType);
        }
    }

    error(message, meta = {}, eventLog = true) {
        this._log(LOG_LEVELS.ERROR, message, meta, eventLog, 'Error');
    }

    warn(message, meta = {}, eventLog = false) {
        this._log(LOG_LEVELS.WARN, message, meta, eventLog, 'Warning');
    }

    info(message, meta = {}, eventLog = false) {
        this._log(LOG_LEVELS.INFO, message, meta, eventLog);
    }

    debug(message, meta = {}) {
        this._log(LOG_LEVELS.DEBUG, message, meta, false);
    }

    /**
     * Log scan result - writes to Event Log for no-change scans
     */
    logScanResult(scanResult) {
        const hasChanges = scanResult.filesWithChange && scanResult.filesWithChange.length > 0;

        if (hasChanges) {
            this.info('Scan completed with changes', {
                changes: scanResult.filesWithChange.length,
                projects: scanResult.projectsScanned,
                duration: scanResult.scanDurationMs
            });
        } else {
            // No changes - log to Event Log only (not DB)
            const message = `Scan completed: ${scanResult.projectsScanned} projects, ` +
                `${scanResult.filesNoChange} files unchanged, ${scanResult.scanDurationMs}ms`;
            this._writeToEventLog(message, 'Information');
            this.debug('Scan completed with no changes', {
                projects: scanResult.projectsScanned,
                filesTracked: scanResult.filesNoChange,
                duration: scanResult.scanDurationMs
            });
        }
    }

    /**
     * Log scheduler events
     */
    logSchedulerEvent(event, details = {}) {
        const message = `Scheduler: ${event}`;
        this.info(message, details);

        // Important scheduler events go to Event Log
        if (['started', 'stopped', 'error'].includes(event)) {
            this._writeToEventLog(message, event === 'error' ? 'Error' : 'Information');
        }
    }
}

// Singleton instance
const logService = new LogService();

export default logService;
