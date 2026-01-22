import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

const config = {
    // Server
    port: process.env.PORT || 3000,
    host: process.env.HOST || 'localhost',

    // Paths
    rootDir,
    dbPath: process.env.DB_PATH || path.join(rootDir, 'db', 'claude_monitor.db'),
    logDir: process.env.LOG_DIR || path.join(rootDir, 'logs', 'server'),

    // Logging
    logLevel: process.env.LOG_LEVEL || 'info',

    // Scheduler
    scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS) || 5 * 60 * 1000, // 5 minutes
    autoStartScheduler: process.env.AUTO_START_SCHEDULER !== 'false', // Default true

    // CORS - allow local requests
    corsOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],

    // API
    apiVersion: 'v1',
    defaultPageSize: 50,
    maxPageSize: 100,

    // Scan behavior
    skipEmptyScans: process.env.SKIP_EMPTY_SCANS !== 'false' // Default true - don't store zero-change scans
};

export default config;
