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
    skipEmptyScans: process.env.SKIP_EMPTY_SCANS !== 'false', // Default true - don't store zero-change scans

    // CASS search integration
    cassBinary: process.env.CASS_BINARY || '/usr/local/bin/cass',
    cassWindowsDataDir: process.env.CASS_WINDOWS_DATA_DIR || '/root/.local/share/coding-agent-search-windows',
    cassTimeoutMs: parseInt(process.env.CASS_TIMEOUT_MS) || 30000,

    // File scanner
    scanRoots: JSON.parse(process.env.SCAN_ROOTS || JSON.stringify([
        { path: '/root/.claude', mode: 'direct' },
        { path: '/root/projects', mode: 'projects' }
    ])),
    scanStateFile: process.env.SCAN_STATE_FILE || path.join(rootDir, 'data', 'scan-state.json'),

    // ECC seed data
    eccSeedPath: process.env.ECC_SEED_PATH || path.join(rootDir, 'server', 'data', 'ecc-seed.json'),
};

export default config;
