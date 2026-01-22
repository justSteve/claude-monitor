import fs from 'fs';
import crypto from 'crypto';
import db from '../db/index.js';
import logger from './logService.js';

/**
 * Conversation Parser Service
 *
 * Parses JSONL and TXT conversation files from Claude Code sessions.
 * Implements hash-based deduplication for incremental processing.
 */

/**
 * Generate SHA256 hash of content for deduplication
 */
function hashContent(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Get or create parse state for a file
 */
function getParseState(filePath) {
    const database = db.getDb();
    return database.prepare(`
        SELECT * FROM conversation_parse_state WHERE file_path = ?
    `).get(filePath);
}

/**
 * Update parse state after processing
 */
function updateParseState(filePath, lineNumber, entryHash) {
    const database = db.getDb();
    database.prepare(`
        INSERT INTO conversation_parse_state (file_path, last_line_number, last_entry_hash, last_parsed_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(file_path) DO UPDATE SET
            last_line_number = excluded.last_line_number,
            last_entry_hash = excluded.last_entry_hash,
            last_parsed_at = excluded.last_parsed_at
    `).run(filePath, lineNumber, entryHash);
}

/**
 * Find or create a conversation record
 */
function findOrCreateConversation(sessionId, filePath, fileType, metadata = {}) {
    const database = db.getDb();

    let conversation = database.prepare(`
        SELECT * FROM conversations WHERE conversation_id = ?
    `).get(sessionId);

    if (!conversation) {
        database.prepare(`
            INSERT INTO conversations (
                conversation_id, source_file_path, source_file_type,
                model_used, claude_code_version, git_branch, working_directory
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            sessionId,
            filePath,
            fileType,
            metadata.model || null,
            metadata.version || null,
            metadata.gitBranch || null,
            metadata.cwd || null
        );

        conversation = database.prepare(`
            SELECT * FROM conversations WHERE conversation_id = ?
        `).get(sessionId);
    }

    return conversation;
}

/**
 * Insert a conversation entry if not duplicate
 * Returns true if inserted, false if duplicate
 */
function insertEntry(conversationId, entryHash, entryIndex, role, content, timestamp) {
    const database = db.getDb();

    try {
        database.prepare(`
            INSERT INTO conversation_entries (
                conversation_id, entry_hash, entry_index, role, content, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(conversationId, entryHash, entryIndex, role, content, timestamp);
        return true;
    } catch (err) {
        // UNIQUE constraint violation means duplicate
        if (err.message?.includes('UNIQUE constraint')) {
            return false;
        }
        throw err;
    }
}

/**
 * Update conversation statistics
 */
function updateConversationStats(conversationId) {
    const database = db.getDb();

    const stats = database.prepare(`
        SELECT
            COUNT(*) as message_count,
            MIN(timestamp) as started_at,
            MAX(timestamp) as ended_at
        FROM conversation_entries
        WHERE conversation_id = ?
    `).get(conversationId);

    let durationSeconds = null;
    if (stats.started_at && stats.ended_at) {
        const start = new Date(stats.started_at);
        const end = new Date(stats.ended_at);
        durationSeconds = Math.floor((end - start) / 1000);
    }

    database.prepare(`
        UPDATE conversations SET
            message_count = ?,
            started_at = ?,
            ended_at = ?,
            duration_seconds = ?
        WHERE id = ?
    `).run(stats.message_count, stats.started_at, stats.ended_at, durationSeconds, conversationId);
}

/**
 * Extract role from JSONL entry
 */
function extractRole(entry) {
    if (entry.message?.role) return entry.message.role;
    if (entry.type === 'user') return 'user';
    if (entry.type === 'assistant') return 'assistant';
    if (entry.type === 'tool_result' || entry.type === 'tool') return 'tool';
    return 'system';
}

/**
 * Extract content from JSONL entry
 */
function extractContent(entry) {
    if (!entry.message?.content) return null;

    const content = entry.message.content;

    // Handle array content (assistant messages with tool use)
    if (Array.isArray(content)) {
        return content.map(block => {
            if (typeof block === 'string') return block;
            if (block.type === 'text') return block.text;
            if (block.type === 'tool_use') {
                return `[Tool: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`;
            }
            if (block.type === 'tool_result') {
                const result = typeof block.content === 'string'
                    ? block.content
                    : JSON.stringify(block.content);
                return `[Tool Result: ${block.tool_use_id}]\n${result}`;
            }
            return JSON.stringify(block);
        }).join('\n\n');
    }

    return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * Parse a JSONL conversation file
 */
function parseJSONL(filePath, projectId = null) {
    if (!fs.existsSync(filePath)) {
        logger.warn(`JSONL file not found: ${filePath}`);
        return { success: false, error: 'File not found' };
    }

    const parseState = getParseState(filePath);
    const startLine = parseState?.last_line_number || 0;

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());

    if (lines.length <= startLine) {
        logger.debug(`No new lines in ${filePath}`);
        return { success: true, newEntries: 0, skipped: 0 };
    }

    let sessionId = null;
    let metadata = {};
    let newEntries = 0;
    let skipped = 0;
    let conversationId = null;
    let entryIndex = startLine;
    let lastHash = null;

    // First pass: find session info from any line
    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (entry.sessionId && !sessionId) {
                sessionId = entry.sessionId;
                metadata = {
                    version: entry.version,
                    gitBranch: entry.gitBranch,
                    cwd: entry.cwd,
                    model: entry.model
                };
            }
        } catch (e) {
            // Skip malformed lines
        }
    }

    // Generate session ID from filename if not found
    if (!sessionId) {
        const basename = filePath.split(/[/\\]/).pop().replace('.jsonl', '');
        sessionId = basename;
    }

    // Create/find conversation
    const conversation = findOrCreateConversation(sessionId, filePath, 'jsonl', metadata);
    conversationId = conversation.id;

    // Update project_id if provided and not set
    if (projectId && !conversation.project_id) {
        const database = db.getDb();
        database.prepare('UPDATE conversations SET project_id = ? WHERE id = ?')
            .run(projectId, conversationId);
    }

    // Process new lines
    for (let i = startLine; i < lines.length; i++) {
        const line = lines[i];
        const lineHash = hashContent(line);

        try {
            const entry = JSON.parse(line);

            // Skip non-message types
            if (!['user', 'assistant', 'tool_result'].includes(entry.type)) {
                continue;
            }

            const role = extractRole(entry);
            const content = extractContent(entry);

            if (!content) continue;

            const inserted = insertEntry(
                conversationId,
                lineHash,
                entryIndex,
                role,
                content,
                entry.timestamp || null
            );

            if (inserted) {
                newEntries++;
            } else {
                skipped++;
            }

            entryIndex++;
            lastHash = lineHash;
        } catch (e) {
            logger.debug(`Skipping malformed line ${i} in ${filePath}: ${e.message}`);
        }
    }

    // Update parse state and conversation stats
    if (newEntries > 0 || lines.length > startLine) {
        updateParseState(filePath, lines.length, lastHash);
        updateConversationStats(conversationId);
    }

    logger.info(`Parsed ${filePath}: ${newEntries} new entries, ${skipped} duplicates`);

    return {
        success: true,
        conversationId,
        sessionId,
        newEntries,
        skipped,
        totalLines: lines.length
    };
}

/**
 * Parse a TXT conversation file (human-readable transcript)
 */
function parseTXT(filePath, projectId = null) {
    if (!fs.existsSync(filePath)) {
        logger.warn(`TXT file not found: ${filePath}`);
        return { success: false, error: 'File not found' };
    }

    const parseState = getParseState(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const contentHash = hashContent(content);

    // Skip if file hasn't changed
    if (parseState?.last_entry_hash === contentHash) {
        logger.debug(`No changes in ${filePath}`);
        return { success: true, newEntries: 0, skipped: 0 };
    }

    // Generate session ID from filename
    const basename = filePath.split(/[/\\]/).pop().replace('.txt', '');
    const sessionId = `txt-${basename}`;

    // Create/find conversation
    const conversation = findOrCreateConversation(sessionId, filePath, 'txt', {});
    const conversationId = conversation.id;

    // Update project_id if provided
    if (projectId && !conversation.project_id) {
        const database = db.getDb();
        database.prepare('UPDATE conversations SET project_id = ? WHERE id = ?')
            .run(projectId, conversationId);
    }

    // Split on role markers
    const rolePattern = /^(Human:|Assistant:|>)\s*/gm;
    const blocks = content.split(rolePattern).filter(s => s.trim());

    let newEntries = 0;
    let skipped = 0;
    let currentRole = 'user';
    let entryIndex = 0;

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i].trim();

        // Check if this is a role marker
        if (block === 'Human:' || block === '>') {
            currentRole = 'user';
            continue;
        }
        if (block === 'Assistant:') {
            currentRole = 'assistant';
            continue;
        }

        if (!block) continue;

        const blockHash = hashContent(block);
        const inserted = insertEntry(
            conversationId,
            blockHash,
            entryIndex,
            currentRole,
            block,
            null
        );

        if (inserted) {
            newEntries++;
        } else {
            skipped++;
        }

        entryIndex++;
    }

    // Update parse state and conversation stats
    updateParseState(filePath, 0, contentHash);
    updateConversationStats(conversationId);

    logger.info(`Parsed TXT ${filePath}: ${newEntries} new entries, ${skipped} duplicates`);

    return {
        success: true,
        conversationId,
        sessionId,
        newEntries,
        skipped
    };
}

/**
 * Process a conversation file (auto-detect format)
 */
function processFile(filePath, projectId = null) {
    const ext = filePath.toLowerCase().split('.').pop();

    if (ext === 'jsonl') {
        return parseJSONL(filePath, projectId);
    } else if (ext === 'txt') {
        return parseTXT(filePath, projectId);
    } else {
        logger.warn(`Unknown file format: ${filePath}`);
        return { success: false, error: 'Unknown format' };
    }
}

/**
 * Get conversation by ID
 */
function getConversation(id) {
    const database = db.getDb();
    return database.prepare(`
        SELECT * FROM conversations WHERE id = ?
    `).get(id);
}

/**
 * Get conversation entries
 */
function getConversationEntries(conversationId, options = {}) {
    const database = db.getDb();
    const { role, limit = 100, offset = 0 } = options;

    let sql = `
        SELECT * FROM conversation_entries
        WHERE conversation_id = ?
    `;
    const params = [conversationId];

    if (role) {
        sql += ' AND role = ?';
        params.push(role);
    }

    sql += ' ORDER BY entry_index ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return database.prepare(sql).all(...params);
}

/**
 * List conversations with filtering
 */
function listConversations(options = {}) {
    const database = db.getDb();
    const { projectId, since, hasErrors, limit = 50, offset = 0 } = options;

    let sql = 'SELECT * FROM v_conversations_summary WHERE 1=1';
    const params = [];

    if (projectId) {
        sql += ' AND project_id = ?';
        params.push(projectId);
    }

    if (since) {
        sql += ' AND started_at >= ?';
        params.push(since);
    }

    if (hasErrors) {
        sql += ' AND error_count > 0';
    }

    sql += ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return database.prepare(sql).all(...params);
}

export {
    processFile,
    parseJSONL,
    parseTXT,
    getConversation,
    getConversationEntries,
    listConversations,
    hashContent
};

export default {
    processFile,
    parseJSONL,
    parseTXT,
    getConversation,
    getConversationEntries,
    listConversations,
    hashContent
};
