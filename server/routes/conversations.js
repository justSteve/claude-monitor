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

        const parsedPage = parseInt(page);
        const parsedLimit = parseInt(limit);
        const parsedProjectId = project_id ? parseInt(project_id) : undefined;

        if (isNaN(parsedPage) || parsedPage < 1) {
            const error = new Error('page must be a positive integer');
            error.statusCode = 400;
            throw error;
        }
        if (isNaN(parsedLimit) || parsedLimit < 1) {
            const error = new Error('limit must be a positive integer');
            error.statusCode = 400;
            throw error;
        }
        if (project_id && isNaN(parsedProjectId)) {
            const error = new Error('project_id must be a valid integer');
            error.statusCode = 400;
            throw error;
        }

        const conversations = conversationParser.listConversations({
            projectId: parsedProjectId,
            since,
            hasErrors: has_errors === 'true',
            limit: Math.min(parsedLimit, config.maxPageSize),
            offset: (parsedPage - 1) * parsedLimit
        });

        res.json({
            data: conversations,
            pagination: {
                page: parsedPage,
                limit: parsedLimit
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
        const parsedId = parseInt(id);

        if (isNaN(parsedId) || parsedId < 1) {
            const error = new Error('id must be a positive integer');
            error.statusCode = 400;
            throw error;
        }

        const conversation = conversationParser.getConversation(parsedId);

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

        const parsedId = parseInt(id);
        const parsedPage = parseInt(page);
        const parsedLimit = parseInt(limit);

        if (isNaN(parsedId) || parsedId < 1) {
            const error = new Error('id must be a positive integer');
            error.statusCode = 400;
            throw error;
        }
        if (isNaN(parsedPage) || parsedPage < 1) {
            const error = new Error('page must be a positive integer');
            error.statusCode = 400;
            throw error;
        }
        if (isNaN(parsedLimit) || parsedLimit < 1) {
            const error = new Error('limit must be a positive integer');
            error.statusCode = 400;
            throw error;
        }

        const entries = conversationParser.getConversationEntries(parsedId, {
            role,
            limit: Math.min(parsedLimit, config.maxPageSize),
            offset: (parsedPage - 1) * parsedLimit
        });

        res.json({
            data: entries,
            pagination: {
                page: parsedPage,
                limit: parsedLimit
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

        const parsedId = parseInt(id);
        const parsedPage = parseInt(page);
        const parsedLimit = parseInt(limit);

        if (isNaN(parsedId) || parsedId < 1) {
            const error = new Error('id must be a positive integer');
            error.statusCode = 400;
            throw error;
        }
        if (isNaN(parsedPage) || parsedPage < 1) {
            const error = new Error('page must be a positive integer');
            error.statusCode = 400;
            throw error;
        }
        if (isNaN(parsedLimit) || parsedLimit < 1) {
            const error = new Error('limit must be a positive integer');
            error.statusCode = 400;
            throw error;
        }

        const artifacts = artifactExtractor.getConversationArtifacts(parsedId, {
            type,
            toolName: tool_name,
            outcome,
            limit: Math.min(parsedLimit, config.maxPageSize),
            offset: (parsedPage - 1) * parsedLimit
        });

        res.json({
            data: artifacts,
            pagination: {
                page: parsedPage,
                limit: parsedLimit
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
        const parsedId = parseInt(id);

        if (isNaN(parsedId) || parsedId < 1) {
            const error = new Error('id must be a positive integer');
            error.statusCode = 400;
            throw error;
        }

        const conversation = conversationParser.getConversation(parsedId);
        if (!conversation) {
            const error = new Error('Conversation not found');
            error.statusCode = 404;
            throw error;
        }

        const result = artifactExtractor.processConversationEntries(parsedId);

        res.json({
            success: result.success,
            conversationId: parsedId,
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
        const parsedId = parseInt(id);

        if (isNaN(parsedId) || parsedId < 1) {
            const error = new Error('id must be a positive integer');
            error.statusCode = 400;
            throw error;
        }

        const conversation = conversationParser.getConversation(parsedId);
        if (!conversation) {
            const error = new Error('Conversation not found');
            error.statusCode = 404;
            throw error;
        }

        const stats = artifactExtractor.getArtifactStats(parsedId);

        res.json({
            conversationId: parsedId,
            ...stats
        });
    } catch (err) {
        next(err);
    }
});

export default router;
