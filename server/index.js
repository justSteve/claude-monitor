import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';

import config from './config.js';
import db from './db/index.js';
import logger from './services/logService.js';
import scheduler from './services/schedulerService.js';
import errorHandler from './middleware/errorHandler.js';

// Import routes
import scansRouter from './routes/scans.js';
import filesRouter from './routes/files.js';
import statsRouter from './routes/stats.js';
import schedulerRouter from './routes/scheduler.js';
import conversationsRouter from './routes/conversations.js';
import artifactsRouter from './routes/artifacts.js';
import configsRouter from './routes/configs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Initialize database
db.init();
logger.info('Database initialized');

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false // Allow inline scripts for simple frontend
}));

// CORS
app.use(cors({
    origin: config.corsOrigins,
    credentials: true
}));

// Request logging - write to our logger
app.use(morgan('short', {
    stream: {
        write: (message) => logger.debug(message.trim())
    }
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
const apiBase = `/api/${config.apiVersion}`;
app.use(`${apiBase}/scans`, scansRouter);
app.use(`${apiBase}/files`, filesRouter);
app.use(`${apiBase}/stats`, statsRouter);
app.use(`${apiBase}/scheduler`, schedulerRouter);
app.use(`${apiBase}/conversations`, conversationsRouter);
app.use(`${apiBase}/artifacts`, artifactsRouter);
app.use(`${apiBase}/config-snapshots`, configsRouter);

// Health check - includes scheduler status
app.get(`${apiBase}/health`, (req, res) => {
    const database = db.getDb();
    const lastScan = database.prepare('SELECT scan_time FROM scans ORDER BY scan_time_iso DESC LIMIT 1').get();
    const schedulerStatus = scheduler.getStatus();

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: 'connected',
        lastStoredScan: lastScan ? lastScan.scan_time : null,
        scheduler: {
            running: schedulerStatus.running,
            lastRun: schedulerStatus.lastRun,
            lastRunStatus: schedulerStatus.lastRunStatus,
            nextRun: schedulerStatus.nextRun,
            runCount: schedulerStatus.runCount,
            errorCount: schedulerStatus.errorCount
        }
    });
});

// Fallback to index.html for SPA-like behavior
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handling
app.use(errorHandler);

// Graceful shutdown
function shutdown() {
    logger.info('Shutting down gracefully...', {}, true);
    scheduler.stop();
    db.close();
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Uncaught exception handler
process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
});

// Start server
const server = app.listen(config.port, config.host, () => {
    logger.info(`Server started at http://${config.host}:${config.port}`, {}, true);
    logger.info(`API available at http://${config.host}:${config.port}/api/${config.apiVersion}`);

    // Auto-start scheduler if configured
    if (config.autoStartScheduler) {
        logger.info('Auto-starting scheduler', { intervalMs: config.scanIntervalMs });
        scheduler.start();
    }
});

export default app;
