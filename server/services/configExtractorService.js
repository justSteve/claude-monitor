import fs from 'fs';
import crypto from 'crypto';
import db from '../db/index.js';
import logger from './logService.js';

/**
 * Config Extractor Service
 *
 * Extracts structured metadata from Claude Code configuration files:
 * - settings.local.json: model, permissions, features
 * - plugin.json: installed plugins
 * - hooks.md: configured hooks
 * - CLAUDE.md: project instructions
 */

/**
 * Generate SHA256 hash of file content
 */
function hashFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Check if a config snapshot already exists for this file hash
 */
function snapshotExists(filePath, fileHash) {
    const database = db.getDb();
    const result = database.prepare(`
        SELECT id FROM config_snapshots
        WHERE file_path = ? AND file_hash = ?
    `).get(filePath, fileHash);
    return !!result;
}

/**
 * Store a config snapshot
 */
function storeSnapshot(projectId, filePath, fileType, fileHash, metadata) {
    const database = db.getDb();
    database.prepare(`
        INSERT INTO config_snapshots (
            project_id, file_path, file_type, file_hash, captured_at, metadata
        ) VALUES (?, ?, ?, ?, datetime('now'), ?)
    `).run(projectId, filePath, fileType, fileHash, JSON.stringify(metadata));

    logger.info(`Stored config snapshot for ${filePath}`);
}

/**
 * Extract metadata from settings.local.json
 */
function extractSettings(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const settings = JSON.parse(content);

        return {
            model: settings.model || null,
            permissions: settings.permissions || [],
            features: settings.features || {},
            hasApiKey: !!settings.apiKey,
            autoApprove: settings.autoApprove || [],
            denyPatterns: settings.denyPatterns || []
        };
    } catch (err) {
        logger.warn(`Failed to parse settings: ${filePath}: ${err.message}`);
        return { error: err.message };
    }
}

/**
 * Extract metadata from plugin.json
 */
function extractPlugins(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const config = JSON.parse(content);

        const plugins = (config.plugins || []).map(plugin => ({
            name: plugin.name || plugin,
            version: plugin.version || null,
            enabled: plugin.enabled !== false
        }));

        return {
            pluginCount: plugins.length,
            plugins
        };
    } catch (err) {
        logger.warn(`Failed to parse plugins: ${filePath}: ${err.message}`);
        return { error: err.message };
    }
}

/**
 * Extract metadata from hooks.md
 */
function extractHooks(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        // Find hook definitions (typically in code blocks or specific patterns)
        const hookPatterns = [
            /PreToolUse/i,
            /PostToolUse/i,
            /SessionStart/i,
            /SessionEnd/i,
            /UserPrompt/i
        ];

        const hooks = [];
        const sectionHeaders = [];

        for (const line of lines) {
            // Extract section headers
            const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
            if (headerMatch) {
                sectionHeaders.push(headerMatch[2].trim());
            }

            // Check for hook names
            for (const pattern of hookPatterns) {
                if (pattern.test(line) && !hooks.includes(pattern.source.replace(/\\i?/g, ''))) {
                    const hookName = line.match(pattern)?.[0];
                    if (hookName && !hooks.includes(hookName)) {
                        hooks.push(hookName);
                    }
                }
            }
        }

        return {
            hookCount: hooks.length,
            hooks,
            sectionHeaders,
            lineCount: lines.length
        };
    } catch (err) {
        logger.warn(`Failed to parse hooks: ${filePath}: ${err.message}`);
        return { error: err.message };
    }
}

/**
 * Extract metadata from CLAUDE.md
 */
function extractClaudeMd(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        const sectionHeaders = [];
        let hasCodeBlocks = false;
        let codeBlockCount = 0;

        for (const line of lines) {
            // Extract section headers
            const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
            if (headerMatch) {
                sectionHeaders.push({
                    level: headerMatch[1].length,
                    title: headerMatch[2].trim()
                });
            }

            // Check for code blocks
            if (line.trim().startsWith('```')) {
                hasCodeBlocks = true;
                codeBlockCount++;
            }
        }

        // Code blocks are pairs, so divide by 2
        codeBlockCount = Math.floor(codeBlockCount / 2);

        return {
            lineCount: lines.length,
            sectionHeaders: sectionHeaders.map(h => h.title),
            sectionStructure: sectionHeaders,
            hasCodeBlocks,
            codeBlockCount,
            charCount: content.length
        };
    } catch (err) {
        logger.warn(`Failed to parse CLAUDE.md: ${filePath}: ${err.message}`);
        return { error: err.message };
    }
}

/**
 * Determine file type from filename
 */
function getFileType(filePath) {
    const filename = filePath.split(/[/\\]/).pop().toLowerCase();

    if (filename === 'settings.local.json' || filename === 'settings.json') {
        return 'settings';
    }
    if (filename === 'plugin.json' || filename === 'plugins.json') {
        return 'plugin';
    }
    if (filename === 'hooks.md' || filename.includes('hook')) {
        return 'hooks';
    }
    if (filename === 'claude.md') {
        return 'claude_md';
    }

    return 'unknown';
}

/**
 * Process a config file and extract metadata
 */
function processFile(filePath, projectId = null) {
    if (!fs.existsSync(filePath)) {
        logger.warn(`Config file not found: ${filePath}`);
        return { success: false, error: 'File not found' };
    }

    const fileHash = hashFile(filePath);

    // Skip if already processed with this hash
    if (snapshotExists(filePath, fileHash)) {
        logger.debug(`Config unchanged: ${filePath}`);
        return { success: true, unchanged: true };
    }

    const fileType = getFileType(filePath);
    let metadata;

    switch (fileType) {
        case 'settings':
            metadata = extractSettings(filePath);
            break;
        case 'plugin':
            metadata = extractPlugins(filePath);
            break;
        case 'hooks':
            metadata = extractHooks(filePath);
            break;
        case 'claude_md':
            metadata = extractClaudeMd(filePath);
            break;
        default:
            logger.warn(`Unknown config file type: ${filePath}`);
            return { success: false, error: 'Unknown file type' };
    }

    storeSnapshot(projectId, filePath, fileType, fileHash, metadata);

    return {
        success: true,
        fileType,
        metadata
    };
}

/**
 * Get latest config snapshots for a project
 */
function getProjectConfigs(projectId) {
    const database = db.getDb();

    return database.prepare(`
        SELECT cs1.*
        FROM config_snapshots cs1
        INNER JOIN (
            SELECT file_path, MAX(captured_at) as max_captured
            FROM config_snapshots
            WHERE project_id = ?
            GROUP BY file_path
        ) cs2 ON cs1.file_path = cs2.file_path AND cs1.captured_at = cs2.max_captured
        WHERE cs1.project_id = ?
    `).all(projectId, projectId);
}

/**
 * Get config snapshots with filtering
 */
function listConfigSnapshots(options = {}) {
    const database = db.getDb();
    const { projectId, fileType, limit = 50, offset = 0 } = options;

    let sql = 'SELECT * FROM config_snapshots WHERE 1=1';
    const params = [];

    if (projectId) {
        sql += ' AND project_id = ?';
        params.push(projectId);
    }

    if (fileType) {
        sql += ' AND file_type = ?';
        params.push(fileType);
    }

    sql += ' ORDER BY captured_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const results = database.prepare(sql).all(...params);

    // Parse metadata JSON
    return results.map(row => ({
        ...row,
        metadata: JSON.parse(row.metadata)
    }));
}

/**
 * Get config history for a specific file
 */
function getFileHistory(filePath) {
    const database = db.getDb();

    const results = database.prepare(`
        SELECT * FROM config_snapshots
        WHERE file_path = ?
        ORDER BY captured_at DESC
    `).all(filePath);

    return results.map(row => ({
        ...row,
        metadata: JSON.parse(row.metadata)
    }));
}

export {
    processFile,
    extractSettings,
    extractPlugins,
    extractHooks,
    extractClaudeMd,
    getProjectConfigs,
    listConfigSnapshots,
    getFileHistory,
    getFileType
};

export default {
    processFile,
    extractSettings,
    extractPlugins,
    extractHooks,
    extractClaudeMd,
    getProjectConfigs,
    listConfigSnapshots,
    getFileHistory,
    getFileType
};
