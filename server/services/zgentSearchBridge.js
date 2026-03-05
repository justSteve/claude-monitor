/**
 * Zgent Search Bridge
 * Watches a JSONL request file for search requests from other zgents,
 * processes them through CASS, and writes results to a JSONL response file.
 *
 * Protocol (Layer 0 JSONL):
 *   Request:  {"id":"uuid","from":"zgent-name","query":"search terms","filters":{},"timestamp":"ISO8601"}
 *   Response: {"id":"uuid","request_id":"uuid","results":[...],"timestamp":"ISO8601","status":"ok|error","error":"msg if error"}
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import * as cassSearch from './cassSearchService.js';
import logger from './logService.js';

const REQUEST_FILE = process.env.CM_SEARCH_REQUEST_FILE || '/tmp/cm-search-requests.jsonl';
const RESPONSE_FILE = process.env.CM_SEARCH_RESPONSE_FILE || '/tmp/cm-search-responses.jsonl';
const POLL_INTERVAL_MS = parseInt(process.env.CM_SEARCH_POLL_MS) || 2000;

let watcher = null;
let pollTimer = null;
let lastProcessedOffset = 0;
let running = false;

/**
 * Start the bridge watcher.
 * Creates request/response files if they don't exist, then watches for new requests.
 */
function start() {
    if (running) {
        logger.warn('Zgent search bridge already running');
        return;
    }

    // Ensure files exist
    ensureFile(REQUEST_FILE);
    ensureFile(RESPONSE_FILE);

    // Track current file size so we only process new lines
    try {
        const stat = fs.statSync(REQUEST_FILE);
        lastProcessedOffset = stat.size;
    } catch {
        lastProcessedOffset = 0;
    }

    running = true;

    // Use fs.watch for filesystem notifications, with polling fallback
    try {
        watcher = fs.watch(REQUEST_FILE, { persistent: false }, (eventType) => {
            if (eventType === 'change') {
                processNewRequests();
            }
        });

        watcher.on('error', (err) => {
            logger.warn('Request file watcher error, falling back to polling', { error: err.message });
            watcher = null;
            startPolling();
        });
    } catch (err) {
        logger.warn('Could not watch request file, using polling', { error: err.message });
        startPolling();
    }

    // Also poll as a safety net (handles edge cases where watch events are missed)
    startPolling();

    logger.info('Zgent search bridge started', {
        requestFile: REQUEST_FILE,
        responseFile: RESPONSE_FILE,
        pollIntervalMs: POLL_INTERVAL_MS
    });
}

/**
 * Stop the bridge watcher.
 */
function stop() {
    running = false;

    if (watcher) {
        watcher.close();
        watcher = null;
    }

    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }

    logger.info('Zgent search bridge stopped');
}

/**
 * Get bridge status.
 * @returns {object} Bridge status
 */
function getStatus() {
    return {
        running,
        requestFile: REQUEST_FILE,
        responseFile: RESPONSE_FILE,
        lastProcessedOffset
    };
}

/**
 * Start the polling fallback.
 */
function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
        if (running) processNewRequests();
    }, POLL_INTERVAL_MS);
}

/**
 * Ensure a file exists (create it if not).
 * @param {string} filePath - Path to ensure
 */
function ensureFile(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '');
    }
}

/**
 * Process any new request lines since the last read.
 */
async function processNewRequests() {
    let stat;
    try {
        stat = fs.statSync(REQUEST_FILE);
    } catch {
        return; // File disappeared
    }

    if (stat.size <= lastProcessedOffset) return; // No new data

    // Read new bytes
    const fd = fs.openSync(REQUEST_FILE, 'r');
    const newBytes = Buffer.alloc(stat.size - lastProcessedOffset);
    fs.readSync(fd, newBytes, 0, newBytes.length, lastProcessedOffset);
    fs.closeSync(fd);

    lastProcessedOffset = stat.size;

    const lines = newBytes.toString('utf-8').split('\n').filter(l => l.trim());

    for (const line of lines) {
        try {
            const request = JSON.parse(line);
            if (!request.id || !request.query) {
                logger.warn('Invalid search request (missing id or query)', { line: line.substring(0, 200) });
                continue;
            }

            // Process asynchronously but don't block reading more lines
            processRequest(request).catch(err => {
                logger.error('Unhandled error processing search request', {
                    requestId: request.id,
                    error: err.message
                });
            });
        } catch (parseErr) {
            logger.warn('Failed to parse search request line', {
                error: parseErr.message,
                line: line.substring(0, 200)
            });
        }
    }
}

/**
 * Process a single search request and write the response.
 * @param {object} request - Parsed request object
 */
async function processRequest(request) {
    const startTime = Date.now();

    logger.info('Processing zgent search request', {
        requestId: request.id,
        from: request.from,
        query: request.query
    });

    let response;

    try {
        const results = await cassSearch.search(request.query, request.filters || {});

        response = {
            id: randomUUID(),
            request_id: request.id,
            from: request.from || 'unknown',
            results: results.hits,
            total_matches: results.total_matches,
            sources_queried: results.sources_queried,
            timestamp: new Date().toISOString(),
            elapsed_ms: Date.now() - startTime,
            status: 'ok'
        };
    } catch (err) {
        response = {
            id: randomUUID(),
            request_id: request.id,
            from: request.from || 'unknown',
            results: [],
            total_matches: 0,
            timestamp: new Date().toISOString(),
            elapsed_ms: Date.now() - startTime,
            status: 'error',
            error: err.message
        };
    }

    // Append response to the response file
    try {
        fs.appendFileSync(RESPONSE_FILE, JSON.stringify(response) + '\n');
        logger.info('Zgent search response written', {
            requestId: request.id,
            status: response.status,
            resultCount: response.results.length,
            elapsedMs: response.elapsed_ms
        });
    } catch (writeErr) {
        logger.error('Failed to write search response', {
            requestId: request.id,
            error: writeErr.message
        });
    }
}

export {
    start,
    stop,
    getStatus
};
