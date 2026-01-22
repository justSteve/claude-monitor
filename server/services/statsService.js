import db from '../db/index.js';

/**
 * Get aggregate statistics
 */
function getStats(period = 'day') {
    const database = db.getDb();

    // Calculate start date based on period
    let startIso;
    const now = new Date();

    switch (period) {
        case 'day':
            startIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
            break;
        case 'week':
            startIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
            break;
        case 'month':
            startIso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
            break;
        case 'all':
        default:
            startIso = '1970-01-01T00:00:00.000Z';
    }

    // Total scans in period
    const scanStats = database.prepare(`
        SELECT
            COUNT(*) as totalScans,
            SUM(files_with_change) as totalChanges
        FROM scans
        WHERE scan_time_iso >= ?
    `).get(startIso);

    // Total files tracked (ever)
    const fileStats = database.prepare(`
        SELECT
            COUNT(*) as totalFilesTracked,
            COUNT(CASE WHEN is_deleted = 0 THEN 1 END) as activeFiles
        FROM tracked_files
    `).get();

    // Projects stats
    const projectStats = database.prepare(`
        SELECT
            COUNT(*) as totalProjects,
            COUNT(CASE WHEN has_claude_folder = 0 THEN 1 END) as projectsMissingClaude
        FROM projects
    `).get();

    // Changes by status in period
    const changesByStatus = database.prepare(`
        SELECT
            COUNT(CASE WHEN fc.status = 'NEW' THEN 1 END) as new,
            COUNT(CASE WHEN fc.status = 'MODIFIED' THEN 1 END) as modified,
            COUNT(CASE WHEN fc.status = 'DELETED' THEN 1 END) as deleted
        FROM file_changes fc
        JOIN scans s ON s.id = fc.scan_id
        WHERE s.scan_time_iso >= ?
    `).get(startIso);

    // Most active files (most changes in period)
    const mostActiveFiles = database.prepare(`
        SELECT
            fc.path,
            COUNT(*) as changeCount,
            MAX(s.scan_time) as lastChange
        FROM file_changes fc
        JOIN scans s ON s.id = fc.scan_id
        WHERE s.scan_time_iso >= ?
        GROUP BY fc.path
        ORDER BY changeCount DESC
        LIMIT 10
    `).all(startIso);

    return {
        period,
        totalScans: scanStats.totalScans || 0,
        totalChanges: scanStats.totalChanges || 0,
        totalFilesTracked: fileStats.totalFilesTracked || 0,
        activeFiles: fileStats.activeFiles || 0,
        totalProjects: projectStats.totalProjects || 0,
        projectsMissingClaude: projectStats.projectsMissingClaude || 0,
        changesByStatus: {
            NEW: changesByStatus.new || 0,
            MODIFIED: changesByStatus.modified || 0,
            DELETED: changesByStatus.deleted || 0
        },
        mostActiveFiles
    };
}

/**
 * Get change trends over time
 */
function getTrends(days = 7, granularity = 'hour') {
    const database = db.getDb();

    const startIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    let groupFormat;
    if (granularity === 'hour') {
        groupFormat = '%Y-%m-%dT%H:00:00.000Z';
    } else {
        groupFormat = '%Y-%m-%dT00:00:00.000Z';
    }

    const trends = database.prepare(`
        SELECT
            strftime('${groupFormat}', scan_time_iso) as timestamp,
            COUNT(*) as scans,
            SUM(files_with_change) as changes
        FROM scans
        WHERE scan_time_iso >= ?
        GROUP BY strftime('${groupFormat}', scan_time_iso)
        ORDER BY timestamp ASC
    `).all(startIso);

    return {
        granularity,
        days,
        data: trends.map(t => ({
            timestamp: t.timestamp,
            scans: t.scans,
            changes: t.changes || 0
        }))
    };
}

/**
 * Get recent activity summary (for dashboard)
 */
function getRecentActivity(hours = 24) {
    const database = db.getDb();

    const startIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const recentScans = database.prepare(`
        SELECT COUNT(*) as count FROM scans WHERE scan_time_iso >= ?
    `).get(startIso);

    const recentChanges = database.prepare(`
        SELECT COUNT(*) as count
        FROM file_changes fc
        JOIN scans s ON s.id = fc.scan_id
        WHERE s.scan_time_iso >= ?
    `).get(startIso);

    const lastScan = database.prepare(`
        SELECT scan_time as scanTime, scan_time_iso as scanTimeIso
        FROM scans ORDER BY scan_time_iso DESC LIMIT 1
    `).get();

    return {
        recentScans: recentScans.count,
        recentChanges: recentChanges.count,
        lastScan: lastScan || null
    };
}

export {
    getStats,
    getTrends,
    getRecentActivity
};

export default {
    getStats,
    getTrends,
    getRecentActivity
};
