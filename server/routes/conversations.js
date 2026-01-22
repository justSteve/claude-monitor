import express from 'express';
import * as conversationParser from '../services/conversationParserService.js';
import * as artifactExtractor from '../services/artifactExtractorService.js';
import config from '../config.js';

const router = express.Router();

/**
 * GET /api/v1/conversations
 * List conversations with filtering and pagination
 */
router.get('/', (req, res, next) => {
    try {
        const {
            project_id,
            since,
            has_errors,
            page = 1,
            limit = config.defaultPageSize
        } = req.query;

        const conversations = conversationParser.listConversations({
            projectId: project_id ? parseInt(project_id) : undefined,
            since,
            hasErrors: has_errors === 'true',
            limit: Math.min(parseInt(limit), config.maxPageSize),
            offset: (parseInt(page) - 1) * parseInt(limit)
        });

        res.json({
            data: conversations,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit)
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/conversations/:id
 * Get single conversation with metadata
 */
router.get('/:id', (req, res, next) => {
    try {
        const { id } = req.params;
        const conversation = conversationParser.getConversation(parseInt(id));

        if (!conversation) {
            const error = new Error('Conversation not found');
            error.statusCode = 404;
            throw error;
        }

        res.json(conversation);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/conversations/:id/entries
 * Get conversation entries with pagination and filtering
 */
router.get('/:id/entries', (req, res, next) => {
    try {
        const { id } = req.params;
        const {
            role,
            page = 1,
            limit = config.defaultPageSize
        } = req.query;

        const entries = conversationParser.getConversationEntries(parseInt(id), {
            role,
            limit: Math.min(parseInt(limit), config.maxPageSize),
            offset: (parseInt(page) - 1) * parseInt(limit)
        });

        res.json({
            data: entries,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit)
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/conversations/:id/artifacts
 * Get artifacts for a conversation with filtering
 */
router.get('/:id/artifacts', (req, res, next) => {
    try {
        const { id } = req.params;
        const {
            type,
            tool_name,
            outcome,
            page = 1,
            limit = config.defaultPageSize
        } = req.query;

        const artifacts = artifactExtractor.getConversationArtifacts(parseInt(id), {
            type,
            toolName: tool_name,
            outcome,
            limit: Math.min(parseInt(limit), config.maxPageSize),
            offset: (parseInt(page) - 1) * parseInt(limit)
        });

        res.json({
            data: artifacts,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit)
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/v1/conversations/:id/extract
 * Trigger artifact extraction for a conversation
 */
router.post('/:id/extract', (req, res, next) => {
    try {
        const { id } = req.params;

        const conversation = conversationParser.getConversation(parseInt(id));
        if (!conversation) {
            const error = new Error('Conversation not found');
            error.statusCode = 404;
            throw error;
        }

        const result = artifactExtractor.processConversationEntries(parseInt(id));

        res.json({
            success: result.success,
            conversationId: parseInt(id),
            extracted: {
                toolCalls: result.toolCalls || 0,
                toolResults: result.toolResults || 0,
                codeBlocks: result.codeBlocks || 0,
                jsonObjects: result.jsonObjects || 0
            },
            skipped: result.skipped || 0
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/conversations/:id/stats
 * Get artifact statistics for a conversation
 */
router.get('/:id/stats', (req, res, next) => {
    try {
        const { id } = req.params;

        const conversation = conversationParser.getConversation(parseInt(id));
        if (!conversation) {
            const error = new Error('Conversation not found');
            error.statusCode = 404;
            throw error;
        }

        const stats = artifactExtractor.getArtifactStats(parseInt(id));

        res.json({
            conversationId: parseInt(id),
            ...stats
        });
    } catch (err) {
        next(err);
    }
});

export default router;
