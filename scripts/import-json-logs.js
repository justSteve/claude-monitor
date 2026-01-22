/**
 * Import existing JSON log files into SQLite database
 *
 * Usage: npm run import-logs
 */

const fs = require('fs');
const path = require('path');
const db = require('../server/db');
const scanService = require('../server/services/scanService');

const LOGS_DIR = path.join(__dirname, '..', 'logs');

/**
 * Normalize log entries - handles PowerShell serialization quirks
 * where entries might be wrapped in { value: [...], Count: n }
 */
function normalizeLogEntry(entry) {
    if (entry && entry.value && Array.isArray(entry.value)) {
        return entry.value.flatMap(normalizeLogEntry);
    }
    if (entry && entry.scanTime) {
        return [entry];
    }
    return [];
}

/**
 * Parse all entries from a log file
 */
function parseLogFile(filePath) {
    try {
        let content = fs.readFileSync(filePath, 'utf8');
        // Remove BOM if present
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }
        const data = JSON.parse(content);
        const entries = Array.isArray(data) ? data : [data];
        return entries.flatMap(normalizeLogEntry);
    } catch (err) {
        console.error(`Error parsing ${filePath}:`, err.message);
        return [];
    }
}

/**
 * Create a unique key for deduplication
 */
function scanKey(scan) {
    return `${scan.scanTime}|${scan.projectsScanned}|${scan.filesNoChange}`;
}

/**
 * Import all JSON logs
 */
function importLogs() {
    console.log('Initializing database...');
    db.init();

    console.log(`Scanning logs directory: ${LOGS_DIR}`);

    if (!fs.existsSync(LOGS_DIR)) {
        console.log('No logs directory found. Nothing to import.');
        return;
    }

    const logFiles = fs.readdirSync(LOGS_DIR)
        .filter(f => f.endsWith('.json'))
        .sort();

    if (logFiles.length === 0) {
        console.log('No JSON log files found.');
        return;
    }

    console.log(`Found ${logFiles.length} log file(s)`);

    // Track seen scans for deduplication
    const seen = new Set();
    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const file of logFiles) {
        const filePath = path.join(LOGS_DIR, file);
        console.log(`\nProcessing ${file}...`);

        const scans = parseLogFile(filePath);
        console.log(`  Found ${scans.length} scan(s)`);

        for (const scan of scans) {
            const key = scanKey(scan);

            if (seen.has(key)) {
                skipped++;
                continue;
            }
            seen.add(key);

            try {
                // Transform to match API format
                const scanData = {
                    scanTime: scan.scanTime,
                    scanDurationMs: scan.scanDurationMs || 0,
                    projectsScanned: scan.projectsScanned || 0,
                    projectsMissingClaude: scan.projectsMissingClaude || 0,
                    filesNoChange: scan.filesNoChange || 0,
                    filesWithChange: scan.filesWithChange || []
                };

                scanService.createScan(scanData);
                imported++;
            } catch (err) {
                console.error(`  Error importing scan: ${err.message}`);
                errors++;
            }
        }
    }

    console.log('\n=== Import Summary ===');
    console.log(`Imported: ${imported}`);
    console.log(`Skipped (duplicates): ${skipped}`);
    console.log(`Errors: ${errors}`);

    db.close();
    console.log('\nImport complete.');
}

// Run if called directly
if (require.main === module) {
    importLogs();
}

module.exports = { importLogs };
