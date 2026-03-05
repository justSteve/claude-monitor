import db from '../db/index.js';
import config from '../config.js';
import logger from './logService.js';

/**
 * Parse Central Time formatted date string to ISO 8601
 * Input: "M/d/yy h:mm tt" (e.g., "1/3/26 12:09 AM")
 * Output: ISO 8601 string
 */
function parseCentralTimeToISO(dateStr) {
    if (!dateStr) return null;

    // Parse "M/d/yy h:mm tt" format
    const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i);
    if (!match) return null;

    let [, month, day, year, hours, minutes, period] = match;
    month = parseInt(month);
    day = parseInt(day);
    year = 2000 + parseInt(year);
    hours = parseInt(hours);
    minutes = parseInt(minutes);

    // Convert 12-hour to 24-hour
    if (period.toUpperCase() === 'PM' && hours !== 12) {
        hours += 12;
    } else if (period.toUpperCase() === 'AM' && hours === 12) {
        hours = 0;
    }

    // Build an ISO-like string and interpret it in America/Chicago (Central Time)
    const pad = (n) => String(n).padStart(2, '0');
    const localStr = `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:00`;

    try {
        // Use Intl to determine the UTC offset for this specific date in Central Time
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Chicago',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        });

        // Create a probe date, then find the offset by comparing
        const probeUtc = new Date(`${localStr}Z`);
        const parts = formatter.formatToParts(probeUtc);
        const get = (type) => parts.find(p => p.type === type)?.value;
        const centralStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;

        // The difference between probe (treated as UTC) and what Central Time shows
        // tells us the UTC offset for Central Time at that moment
        const centralDate = new Date(`${centralStr}Z`);
        const offsetMs = centralDate.getTime() - probeUtc.getTime();

        // Apply the inverse offset to get the true UTC time
        const utcTime = new Date(probeUtc.getTime() - offsetMs);
        return utcTime.toISOString();
    } catch {
        // Fallback: assume CST (UTC-6) if Intl is unavailable
        const utcTime = new Date(Date.UTC(year, month - 1, day, hours + 6, minutes));
        return utcTime.toISOString();
    }
}

/**
 * Create a new scan with file changes
 * Returns { stored: false } if scan has no changes and skipEmptyScans is enabled
 */
function createScan(scanData) {
    const database = db.getDb();

    const scanTimeIso = parseCentralTimeToISO(scanData.scanTime) || new Date().toISOString();
    const filesWithChange = scanData.filesWithChange || [];

    // Log the scan result
    logger.logScanResult(scanData);

    // Skip storing empty scans if configured
    if (config.skipEmptyScans && filesWithChange.length === 0) {
        logger.debug('Skipping DB storage for zero-change scan');
        return {
            stored: false,
            reason: 'no_changes',
            scanTime: scanData.scanTime,
            filesTracked: scanData.filesNoChange || 0
        };
    }

    return db.transaction(() => {
        // Insert scan record
        const insertScan = database.prepare(`
            INSERT INTO scans (scan_time, scan_time_iso, scan_duration_ms, projects_scanned,
                               projects_missing_claude, files_no_change, files_with_change)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const scanResult = insertScan.run(
            scanData.scanTime,
            scanTimeIso,
            scanData.scanDurationMs || 0,
            scanData.projectsScanned || 0,
            scanData.projectsMissingClaude || 0,
            scanData.filesNoChange || 0,
            filesWithChange.length
        );

        const scanId = scanResult.lastInsertRowid;

        // Insert file changes
        if (filesWithChange.length > 0) {
            const insertChange = database.prepare(`
                INSERT INTO file_changes (scan_id, path, size_bytes, delta_size_bytes,
                                          status, attributes, last_modified, last_modified_iso)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const upsertFile = database.prepare(`
                INSERT INTO tracked_files (path, filename, first_seen_at, last_seen_at, current_size_bytes, is_deleted)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    last_seen_at = excluded.last_seen_at,
                    current_size_bytes = excluded.current_size_bytes,
                    is_deleted = excluded.is_deleted
            `);

            for (const change of filesWithChange) {
                const filename = change.path.split(/[/\\]/).pop();
                const lastModifiedIso = parseCentralTimeToISO(change.lastModified);
                const isDeleted = change.status === 'DELETED' ? 1 : 0;

                // Upsert tracked file
                upsertFile.run(
                    change.path,
                    filename,
                    scanTimeIso,
                    scanTimeIso,
                    change.sizeBytes,
                    isDeleted
                );

                // Get tracked file id
                const trackedFile = database.prepare('SELECT id FROM tracked_files WHERE path = ?').get(change.path);

                // Insert file change
                insertChange.run(
                    scanId,
                    change.path,
                    change.sizeBytes,
                    change.deltaSizeBytes,
                    change.status,
                    JSON.stringify(change.attributes || []),
                    change.lastModified,
                    lastModifiedIso
                );
            }
        }

        return { stored: true, scanId, filesProcessed: filesWithChange.length };
    });
}

/**
 * Get scans with pagination and filtering
 */
function getScans(options = {}) {
    const database = db.getDb();
    const {
        page = 1,
        limit = 50,
        startDate,
        endDate,
        hasChanges
    } = options;

    const offset = (page - 1) * limit;
    const params = [];
    let whereClause = '';
    const conditions = [];

    if (startDate) {
        conditions.push('s.scan_time_iso >= ?');
        params.push(startDate);
    }
    if (endDate) {
        conditions.push('s.scan_time_iso <= ?');
        params.push(endDate);
    }
    if (hasChanges !== undefined) {
        conditions.push(hasChanges ? 's.files_with_change > 0' : 's.files_with_change = 0');
    }

    if (conditions.length > 0) {
        whereClause = 'WHERE ' + conditions.join(' AND ');
    }

    // Get total count
    const countSql = `SELECT COUNT(*) as total FROM scans s ${whereClause}`;
    const { total } = database.prepare(countSql).get(...params);

    // Get paginated results with change counts in a single query
    const sql = `
        SELECT
            s.id, s.scan_time as scanTime, s.scan_time_iso as scanTimeIso,
            s.scan_duration_ms as scanDurationMs, s.projects_scanned as projectsScanned,
            s.projects_missing_claude as projectsMissingClaude,
            s.files_no_change as filesNoChange, s.files_with_change as filesWithChange,
            COALESCE(SUM(CASE WHEN fc.status = 'NEW' THEN 1 ELSE 0 END), 0) as newCount,
            COALESCE(SUM(CASE WHEN fc.status = 'MODIFIED' THEN 1 ELSE 0 END), 0) as modifiedCount,
            COALESCE(SUM(CASE WHEN fc.status = 'DELETED' THEN 1 ELSE 0 END), 0) as deletedCount
        FROM scans s
        LEFT JOIN file_changes fc ON fc.scan_id = s.id
        ${whereClause}
        GROUP BY s.id
        ORDER BY s.scan_time_iso DESC
        LIMIT ? OFFSET ?
    `;

    const scans = database.prepare(sql).all(...params, limit, offset);

    return {
        data: scans,
        pagination: {
            page,
            limit,
            totalItems: total,
            totalPages: Math.ceil(total / limit)
        }
    };
}

/**
 * Get single scan by ID with file changes
 */
function getScanById(id) {
    const database = db.getDb();

    const scan = database.prepare(`
        SELECT
            id, scan_time as scanTime, scan_time_iso as scanTimeIso,
            scan_duration_ms as scanDurationMs, projects_scanned as projectsScanned,
            projects_missing_claude as projectsMissingClaude,
            files_no_change as filesNoChange, files_with_change as filesWithChangeCount
        FROM scans WHERE id = ?
    `).get(id);

    if (!scan) return null;

    const changes = database.prepare(`
        SELECT
            id, path, size_bytes as sizeBytes, delta_size_bytes as deltaSizeBytes,
            status, attributes, last_modified as lastModified
        FROM file_changes WHERE scan_id = ?
        ORDER BY status, path
    `).all(id);

    // Parse attributes JSON
    scan.filesWithChange = changes.map(c => {
        let attributes;
        try {
            attributes = JSON.parse(c.attributes || '[]');
        } catch {
            attributes = [];
        }
        return { ...c, attributes };
    });

    return scan;
}

/**
 * Get scans for a specific date
 */
function getScansByDate(dateStr) {
    const database = db.getDb();

    // Parse date string (MM-DD-YY or YYYY-MM-DD)
    let startIso, endIso;

    if (dateStr.match(/^\d{2}-\d{2}-\d{2}$/)) {
        // MM-DD-YY format
        const [mm, dd, yy] = dateStr.split('-');
        const year = 2000 + parseInt(yy);
        startIso = `${year}-${mm}-${dd}T00:00:00.000Z`;
        endIso = `${year}-${mm}-${dd}T23:59:59.999Z`;
    } else if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
        // YYYY-MM-DD format
        startIso = `${dateStr}T00:00:00.000Z`;
        endIso = `${dateStr}T23:59:59.999Z`;
    } else {
        return { data: [], error: 'Invalid date format' };
    }

    const scans = database.prepare(`
        SELECT
            id, scan_time as scanTime, scan_time_iso as scanTimeIso,
            scan_duration_ms as scanDurationMs, projects_scanned as projectsScanned,
            projects_missing_claude as projectsMissingClaude,
            files_no_change as filesNoChange, files_with_change as filesWithChangeCount
        FROM scans
        WHERE scan_time_iso >= ? AND scan_time_iso <= ?
        ORDER BY scan_time_iso ASC
    `).all(startIso, endIso);

    // Get file changes for each scan
    const getChanges = database.prepare(`
        SELECT
            id, path, size_bytes as sizeBytes, delta_size_bytes as deltaSizeBytes,
            status, attributes, last_modified as lastModified
        FROM file_changes WHERE scan_id = ?
        ORDER BY status, path
    `);

    for (const scan of scans) {
        const changes = getChanges.all(scan.id);
        scan.filesWithChange = changes.map(c => {
            let attributes;
            try {
                attributes = JSON.parse(c.attributes || '[]');
            } catch {
                attributes = [];
            }
            return { ...c, attributes };
        });
    }

    return { data: scans };
}

export {
    createScan,
    getScans,
    getScanById,
    getScansByDate,
    parseCentralTimeToISO
};

export default {
    createScan,
    getScans,
    getScanById,
    getScansByDate,
    parseCentralTimeToISO
};
