import db from '../db/index.js';

/**
 * Get all tracked files with optional filtering
 */
function getTrackedFiles(options = {}) {
    const database = db.getDb();
    const {
        projectId,
        includeDeleted = false,
        page = 1,
        limit = 100
    } = options;

    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (projectId) {
        conditions.push('tf.project_id = ?');
        params.push(projectId);
    }

    if (!includeDeleted) {
        conditions.push('tf.is_deleted = 0');
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Get total count
    const countSql = `SELECT COUNT(*) as total FROM tracked_files tf ${whereClause}`;
    const { total } = database.prepare(countSql).get(...params);

    // Get files
    const sql = `
        SELECT
            tf.id, tf.path, tf.filename, tf.project_id as projectId,
            p.name as projectName, tf.current_size_bytes as currentSizeBytes,
            tf.is_deleted as isDeleted, tf.first_seen_at as firstSeenAt,
            tf.last_seen_at as lastSeenAt
        FROM tracked_files tf
        LEFT JOIN projects p ON p.id = tf.project_id
        ${whereClause}
        ORDER BY tf.last_seen_at DESC
        LIMIT ? OFFSET ?
    `;

    const files = database.prepare(sql).all(...params, limit, offset);

    return {
        data: files.map(f => ({ ...f, isDeleted: Boolean(f.isDeleted) })),
        pagination: {
            page,
            limit,
            totalItems: total,
            totalPages: Math.ceil(total / limit)
        }
    };
}

/**
 * Get file by ID
 */
function getFileById(id) {
    const database = db.getDb();

    const file = database.prepare(`
        SELECT
            tf.id, tf.path, tf.filename, tf.project_id as projectId,
            p.name as projectName, tf.current_size_bytes as currentSizeBytes,
            tf.is_deleted as isDeleted, tf.first_seen_at as firstSeenAt,
            tf.last_seen_at as lastSeenAt
        FROM tracked_files tf
        LEFT JOIN projects p ON p.id = tf.project_id
        WHERE tf.id = ?
    `).get(id);

    if (file) {
        file.isDeleted = Boolean(file.isDeleted);
    }

    return file;
}

/**
 * Get change history for a specific file
 */
function getFileHistory(fileId, limit = 50) {
    const database = db.getDb();

    const file = getFileById(fileId);
    if (!file) return null;

    const history = database.prepare(`
        SELECT
            fc.scan_id as scanId, s.scan_time as scanTime, s.scan_time_iso as scanTimeIso,
            fc.status, fc.size_bytes as sizeBytes, fc.delta_size_bytes as deltaSizeBytes,
            fc.attributes, fc.last_modified as lastModified
        FROM file_changes fc
        JOIN scans s ON s.id = fc.scan_id
        WHERE fc.tracked_file_id = ?
        ORDER BY s.scan_time_iso DESC
        LIMIT ?
    `).all(fileId, limit);

    return {
        file,
        history: history.map(h => ({
            ...h,
            attributes: JSON.parse(h.attributes || '[]')
        }))
    };
}

/**
 * Get files by path pattern (for search)
 */
function searchFiles(pattern, limit = 50) {
    const database = db.getDb();

    const files = database.prepare(`
        SELECT
            tf.id, tf.path, tf.filename, tf.project_id as projectId,
            p.name as projectName, tf.current_size_bytes as currentSizeBytes,
            tf.is_deleted as isDeleted
        FROM tracked_files tf
        LEFT JOIN projects p ON p.id = tf.project_id
        WHERE tf.path LIKE ? OR tf.filename LIKE ?
        ORDER BY tf.last_seen_at DESC
        LIMIT ?
    `).all(`%${pattern}%`, `%${pattern}%`, limit);

    return files.map(f => ({ ...f, isDeleted: Boolean(f.isDeleted) }));
}

export {
    getTrackedFiles,
    getFileById,
    getFileHistory,
    searchFiles
};

export default {
    getTrackedFiles,
    getFileById,
    getFileHistory,
    searchFiles
};
