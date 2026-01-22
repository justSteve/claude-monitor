import fs from 'fs';
import crypto from 'crypto';
import db from '../db/index.js';
import logger from './logService.js';

/**
 * Artifact Extractor Service
 *
 * Extracts structured artifacts from conversation entries:
 * - Code blocks (with language detection)
 * - Tool calls (with parameters and outcomes)
 * - Tool results (with error classification)
 * - JSON objects
 *
 * Implements tiered storage for outputs based on size and type.
 */

const MAX_OUTPUT_SIZE = 10240; // 10KB
const SUMMARY_LENGTH = 500;
const PROMPT_CONTEXT_LENGTH = 200;

/**
 * Generate SHA256 hash of content
 */
function hashContent(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Check if artifact already exists
 */
function artifactExists(conversationId, contentHash) {
    const database = db.getDb();
    const result = database.prepare(`
        SELECT id FROM artifacts
        WHERE conversation_id = ? AND content_hash = ?
    `).get(conversationId, contentHash);
    return !!result;
}

/**
 * Store an artifact
 */
function storeArtifact(artifact) {
    const database = db.getDb();

    database.prepare(`
        INSERT INTO artifacts (
            conversation_id, entry_id, artifact_type, language, tool_name,
            content, metadata, content_hash, outcome,
            output_summary, output_full, output_size_bytes, output_truncated,
            error_type, prompt_context, follow_up_action
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        artifact.conversationId,
        artifact.entryId || null,
        artifact.type,
        artifact.language || null,
        artifact.toolName || null,
        artifact.content || null,
        artifact.metadata ? JSON.stringify(artifact.metadata) : null,
        artifact.contentHash,
        artifact.outcome || null,
        artifact.outputSummary || null,
        artifact.outputFull || null,
        artifact.outputSizeBytes || null,
        artifact.outputTruncated ? 1 : 0,
        artifact.errorType || null,
        artifact.promptContext || null,
        artifact.followUpAction || null
    );
}

/**
 * Extract code blocks from text content
 */
function extractCodeBlocks(text) {
    const codeBlocks = [];
    const regex = /```(\w*)\n([\s\S]*?)```/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
        codeBlocks.push({
            language: match[1] || 'text',
            content: match[2].trim(),
            startIndex: match.index
        });
    }

    return codeBlocks;
}

/**
 * Extract JSON objects from text
 */
function extractJsonObjects(text) {
    const jsonObjects = [];

    // Look for JSON-like patterns
    const jsonPatterns = [
        /\{[\s\S]*?\}/g,  // Simple objects
    ];

    for (const pattern of jsonPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            try {
                const parsed = JSON.parse(match[0]);
                // Only include if it's a meaningful object (not empty, has keys)
                if (typeof parsed === 'object' && Object.keys(parsed).length > 0) {
                    jsonObjects.push({
                        content: match[0],
                        parsed,
                        startIndex: match.index
                    });
                }
            } catch (e) {
                // Not valid JSON, skip
            }
        }
    }

    return jsonObjects;
}

/**
 * Determine output storage based on size and type
 */
function processOutput(output, isError = false) {
    if (!output) return { summary: null, full: null, size: 0, truncated: false };

    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    const size = outputStr.length;
    const summary = outputStr.slice(0, SUMMARY_LENGTH);

    // Always store full output for errors
    if (isError) {
        return {
            summary,
            full: outputStr,
            size,
            truncated: false
        };
    }

    // Store full if small enough
    if (size <= MAX_OUTPUT_SIZE) {
        return {
            summary,
            full: outputStr,
            size,
            truncated: false
        };
    }

    // Large output - only summary
    return {
        summary,
        full: null,
        size,
        truncated: true
    };
}

/**
 * Classify error type from output or error message
 */
function classifyError(output, errorMessage) {
    const text = (output || '') + (errorMessage || '');
    const lowerText = text.toLowerCase();

    if (lowerText.includes('permission denied') || lowerText.includes('access denied')) {
        return 'permission';
    }
    if (lowerText.includes('not found') || lowerText.includes('no such file')) {
        return 'not_found';
    }
    if (lowerText.includes('timeout') || lowerText.includes('timed out')) {
        return 'timeout';
    }
    if (lowerText.includes('connection') || lowerText.includes('network')) {
        return 'network';
    }
    if (lowerText.includes('syntax error') || lowerText.includes('parse error')) {
        return 'syntax';
    }
    if (lowerText.includes('validation') || lowerText.includes('invalid')) {
        return 'validation';
    }

    return 'unknown';
}

/**
 * Get prompt context (text before a position)
 */
function getPromptContext(entries, currentIndex) {
    if (currentIndex <= 0 || !entries || entries.length === 0) return null;

    // Look at previous entry
    const prevEntry = entries[currentIndex - 1];
    if (!prevEntry?.content) return null;

    const content = prevEntry.content;
    return content.slice(-PROMPT_CONTEXT_LENGTH);
}

/**
 * Process a JSONL file to extract artifacts
 */
function processJSONLFile(filePath, conversationId) {
    if (!fs.existsSync(filePath)) {
        logger.warn(`File not found for artifact extraction: ${filePath}`);
        return { success: false, error: 'File not found' };
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());

    const results = {
        codeBlocks: 0,
        toolCalls: 0,
        toolResults: 0,
        jsonObjects: 0,
        skipped: 0
    };

    // Track tool calls and their results for outcome tracking
    const toolCallMap = new Map(); // id -> { name, input, lineIndex }

    // First pass: collect tool calls and results
    for (let i = 0; i < lines.length; i++) {
        try {
            const entry = JSON.parse(lines[i]);

            // Find tool_use blocks in assistant messages
            if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
                for (const block of entry.message.content) {
                    if (block.type === 'tool_use') {
                        toolCallMap.set(block.id, {
                            name: block.name,
                            input: block.input,
                            lineIndex: i,
                            timestamp: entry.timestamp
                        });
                    }
                }
            }

            // Find tool_result blocks in user messages
            if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
                for (const block of entry.message.content) {
                    if (block.type === 'tool_result') {
                        const call = toolCallMap.get(block.tool_use_id);
                        if (call) {
                            call.result = block.content;
                            call.isError = block.is_error;
                            call.resultLineIndex = i;
                        }
                    }
                }
            }
        } catch (e) {
            // Skip malformed lines
        }
    }

    // Second pass: extract and store artifacts
    const entries = [];
    for (let i = 0; i < lines.length; i++) {
        try {
            const entry = JSON.parse(lines[i]);
            entries.push(entry);
        } catch (e) {
            entries.push(null);
        }
    }

    // Process tool calls
    for (const [toolId, call] of toolCallMap) {
        const contentHash = hashContent(JSON.stringify({ id: toolId, input: call.input }));

        if (artifactExists(conversationId, contentHash)) {
            results.skipped++;
            continue;
        }

        const isError = call.isError === true;
        const outputData = processOutput(call.result, isError);

        const artifact = {
            conversationId,
            type: 'tool_call',
            toolName: call.name,
            content: JSON.stringify(call.input),
            metadata: {
                toolUseId: toolId,
                inputKeys: Object.keys(call.input || {})
            },
            contentHash,
            outcome: isError ? 'error' : (call.result ? 'success' : 'pending'),
            outputSummary: outputData.summary,
            outputFull: outputData.full,
            outputSizeBytes: outputData.size,
            outputTruncated: outputData.truncated,
            errorType: isError ? classifyError(call.result) : null,
            promptContext: getPromptContext(entries, call.lineIndex)
        };

        storeArtifact(artifact);
        results.toolCalls++;

        // Also store the result as a separate artifact if it exists
        if (call.result) {
            const resultHash = hashContent(JSON.stringify({ id: toolId, result: call.result }));

            if (!artifactExists(conversationId, resultHash)) {
                storeArtifact({
                    conversationId,
                    type: 'tool_result',
                    toolName: call.name,
                    content: outputData.summary,
                    metadata: { toolUseId: toolId },
                    contentHash: resultHash,
                    outcome: isError ? 'error' : 'success',
                    outputSummary: outputData.summary,
                    outputFull: outputData.full,
                    outputSizeBytes: outputData.size,
                    outputTruncated: outputData.truncated,
                    errorType: isError ? classifyError(call.result) : null
                });
                results.toolResults++;
            }
        }
    }

    // Extract code blocks from assistant text content
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry || entry.type !== 'assistant') continue;

        const content = entry.message?.content;
        if (!content) continue;

        // Get text content
        let textContent = '';
        if (typeof content === 'string') {
            textContent = content;
        } else if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type === 'text') {
                    textContent += block.text + '\n';
                }
            }
        }

        // Extract code blocks
        const codeBlocks = extractCodeBlocks(textContent);
        for (const block of codeBlocks) {
            const contentHash = hashContent(block.content);

            if (artifactExists(conversationId, contentHash)) {
                results.skipped++;
                continue;
            }

            storeArtifact({
                conversationId,
                type: 'code_block',
                language: block.language,
                content: block.content,
                contentHash,
                promptContext: getPromptContext(entries, i)
            });
            results.codeBlocks++;
        }
    }

    logger.info(`Extracted artifacts from ${filePath}: ${results.toolCalls} tool calls, ${results.toolResults} results, ${results.codeBlocks} code blocks`);

    return { success: true, ...results };
}

/**
 * Process conversation entries directly from database
 */
function processConversationEntries(conversationId) {
    const database = db.getDb();

    const conversation = database.prepare(`
        SELECT * FROM conversations WHERE id = ?
    `).get(conversationId);

    if (!conversation) {
        return { success: false, error: 'Conversation not found' };
    }

    // If source is JSONL, process the file directly for richer extraction
    if (conversation.source_file_type === 'jsonl' && fs.existsSync(conversation.source_file_path)) {
        return processJSONLFile(conversation.source_file_path, conversationId);
    }

    // For TXT or other sources, extract from stored entries
    const entries = database.prepare(`
        SELECT * FROM conversation_entries
        WHERE conversation_id = ?
        ORDER BY entry_index ASC
    `).all(conversationId);

    const results = {
        codeBlocks: 0,
        jsonObjects: 0,
        skipped: 0
    };

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.role !== 'assistant') continue;

        // Extract code blocks
        const codeBlocks = extractCodeBlocks(entry.content);
        for (const block of codeBlocks) {
            const contentHash = hashContent(block.content);

            if (artifactExists(conversationId, contentHash)) {
                results.skipped++;
                continue;
            }

            const prevContent = i > 0 ? entries[i - 1].content : null;

            storeArtifact({
                conversationId,
                entryId: entry.id,
                type: 'code_block',
                language: block.language,
                content: block.content,
                contentHash,
                promptContext: prevContent ? prevContent.slice(-PROMPT_CONTEXT_LENGTH) : null
            });
            results.codeBlocks++;
        }
    }

    return { success: true, ...results };
}

/**
 * Get artifacts for a conversation
 */
function getConversationArtifacts(conversationId, options = {}) {
    const database = db.getDb();
    const { type, toolName, outcome, limit = 100, offset = 0 } = options;

    let sql = 'SELECT * FROM artifacts WHERE conversation_id = ?';
    const params = [conversationId];

    if (type) {
        sql += ' AND artifact_type = ?';
        params.push(type);
    }

    if (toolName) {
        sql += ' AND tool_name = ?';
        params.push(toolName);
    }

    if (outcome) {
        sql += ' AND outcome = ?';
        params.push(outcome);
    }

    sql += ' ORDER BY id ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const results = database.prepare(sql).all(...params);

    return results.map(row => ({
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
}

/**
 * Search artifacts across all conversations
 */
function searchArtifacts(query, options = {}) {
    const database = db.getDb();
    const { projectId, type, limit = 50, offset = 0 } = options;

    let sql = `
        SELECT a.*, c.project_id, p.name as project_name
        FROM artifacts a
        JOIN conversations c ON c.id = a.conversation_id
        LEFT JOIN projects p ON p.id = c.project_id
        WHERE a.content LIKE ?
    `;
    const params = [`%${query}%`];

    if (projectId) {
        sql += ' AND c.project_id = ?';
        params.push(projectId);
    }

    if (type) {
        sql += ' AND a.artifact_type = ?';
        params.push(type);
    }

    sql += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const results = database.prepare(sql).all(...params);

    return results.map(row => ({
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
}

/**
 * Get artifact statistics
 */
function getArtifactStats(conversationId = null) {
    const database = db.getDb();

    let whereClause = conversationId ? 'WHERE conversation_id = ?' : '';
    const params = conversationId ? [conversationId] : [];

    const stats = database.prepare(`
        SELECT
            COUNT(*) as total,
            COUNT(CASE WHEN artifact_type = 'code_block' THEN 1 END) as code_blocks,
            COUNT(CASE WHEN artifact_type = 'tool_call' THEN 1 END) as tool_calls,
            COUNT(CASE WHEN artifact_type = 'tool_result' THEN 1 END) as tool_results,
            COUNT(CASE WHEN artifact_type = 'json_object' THEN 1 END) as json_objects,
            COUNT(CASE WHEN outcome = 'error' THEN 1 END) as errors
        FROM artifacts ${whereClause}
    `).get(...params);

    return stats;
}

export {
    processJSONLFile,
    processConversationEntries,
    getConversationArtifacts,
    searchArtifacts,
    getArtifactStats,
    extractCodeBlocks,
    extractJsonObjects
};

export default {
    processJSONLFile,
    processConversationEntries,
    getConversationArtifacts,
    searchArtifacts,
    getArtifactStats,
    extractCodeBlocks,
    extractJsonObjects
};
