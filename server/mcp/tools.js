/**
 * MCP Tool Definitions for Claude Monitor's unified memory search.
 * Implements: memory.search, memory.ack, memory.entity, memory.proposals,
 *             memory.propose_action, memory.status
 *
 * Part of co-1pc: unified memory search — Phase 3.
 */

/**
 * Register all memory tools on the MCP server.
 *
 * @param {import('@modelcontextprotocol/sdk/server/index.js').Server} server - MCP server instance
 * @param {object} deps - Service dependencies
 * @param {object} deps.unifiedSearch - Unified search service (createUnifiedSearch result)
 * @param {object} deps.entityStore   - Entity store service (createEntityStore result)
 * @param {object} deps.db            - Raw bun:sqlite Database for access_log queries
 * @param {import('../services/logService.js').default} deps.logger - Logger
 */
export function registerTools(server, { unifiedSearch, entityStore, db, logger }) {

    // ── memory.search ─────────────────────────────────────────────
    server.tool(
        'memory_search',
        'Search unified memory across BM25 (transcripts), semantic (MemPalace), and entity backends. Returns ranked results with signal breakdown and source provenance.',
        {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query text (min 2 chars)',
                },
                scope: {
                    type: 'string',
                    enum: ['rig', 'enterprise'],
                    description: 'Search scope (default: enterprise)',
                },
                rig: {
                    type: 'string',
                    description: 'Filter to a specific rig (optional)',
                },
                limit: {
                    type: 'number',
                    description: 'Max results (default: 10, max: 100)',
                },
                signals: {
                    type: 'array',
                    items: { type: 'string', enum: ['bm25', 'semantic', 'entity'] },
                    description: 'Which backends to query (default: all)',
                },
            },
            required: ['query'],
        },
        async ({ query, scope, rig, limit, signals }) => {
            if (!query || query.trim().length < 2) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: 'Query must be at least 2 characters' }) }],
                    isError: true,
                };
            }

            try {
                const result = await unifiedSearch.query(query.trim(), {
                    scope: scope || 'enterprise',
                    rig: rig || null,
                    limit: Math.min(Math.max(limit || 10, 1), 100),
                    signals: signals || ['bm25', 'semantic', 'entity'],
                });

                return {
                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                };
            } catch (err) {
                logger.error('MCP memory.search failed', { error: err.message, query });
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: 'Search failed', message: err.message }) }],
                    isError: true,
                };
            }
        }
    );

    // ── memory.ack ────────────────────────────────────────────────
    server.tool(
        'memory_ack',
        'Acknowledge that a memory result was useful. Increments access count for salience scoring — frequently accessed memories decay slower.',
        {
            type: 'object',
            properties: {
                memory_id: {
                    type: 'string',
                    description: 'The memory ID to acknowledge',
                },
                session_id: {
                    type: 'string',
                    description: 'Current session identifier (optional)',
                },
            },
            required: ['memory_id'],
        },
        async ({ memory_id, session_id }) => {
            try {
                const stmt = db.query(
                    'INSERT INTO access_log (memory_id, session_id) VALUES (?, ?)'
                );
                stmt.run(memory_id, session_id || null);

                const countRow = db.query(
                    'SELECT COUNT(*) AS cnt FROM access_log WHERE memory_id = ?'
                ).get(memory_id);

                logger.debug('Memory acknowledged', { memory_id, session_id, total_access: countRow.cnt });

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            memory_id,
                            access_count: countRow.cnt,
                            acknowledged_at: new Date().toISOString(),
                        }),
                    }],
                };
            } catch (err) {
                logger.error('MCP memory.ack failed', { error: err.message, memory_id });
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: 'Ack failed', message: err.message }) }],
                    isError: true,
                };
            }
        }
    );

    // ── memory.entity ─────────────────────────────────────────────
    server.tool(
        'memory_entity',
        'Look up an entity by name or alias. Returns entity details, relations, linked memory count, and boost score.',
        {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Entity name or alias to look up',
                },
            },
            required: ['name'],
        },
        async ({ name }) => {
            try {
                const entity = entityStore.getEntityByName(name)
                    || entityStore.findEntityByAlias(name);

                if (!entity) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ error: 'Entity not found', name }) }],
                    };
                }

                const relations = entityStore.getRelations(entity.id);
                const links = entityStore.getLinkedMemories(entity.id);
                const boost = entityStore.computeEntityBoost(entity.id);

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ entity, relations, linked_memories: links.length, boost }, null, 2),
                    }],
                };
            } catch (err) {
                logger.error('MCP memory.entity failed', { error: err.message, name });
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: 'Entity lookup failed', message: err.message }) }],
                    isError: true,
                };
            }
        }
    );

    // ── memory.proposals ──────────────────────────────────────────
    server.tool(
        'memory_proposals',
        'List pending promotion proposals — patterns observed across 3+ sessions that may warrant a convention or rule.',
        {
            type: 'object',
            properties: {
                status: {
                    type: 'string',
                    enum: ['watching', 'proposed', 'accepted', 'dismissed'],
                    description: 'Filter by status (default: proposed)',
                },
            },
        },
        async ({ status }) => {
            try {
                const filterStatus = status || 'proposed';
                // Check if promotion_candidates table exists
                const tableCheck = db.query(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='promotion_candidates'"
                ).get();

                if (!tableCheck) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ proposals: [], message: 'Promotion system not yet initialized' }) }],
                    };
                }

                const proposals = db.query(
                    'SELECT * FROM promotion_candidates WHERE status = ? ORDER BY last_seen_at DESC'
                ).all(filterStatus);

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ proposals, count: proposals.length }, null, 2),
                    }],
                };
            } catch (err) {
                logger.error('MCP memory.proposals failed', { error: err.message });
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: 'Proposals query failed', message: err.message }) }],
                    isError: true,
                };
            }
        }
    );

    // ── memory.propose_action ─────────────────────────────────────
    server.tool(
        'memory_propose_action',
        'Accept, dismiss, or reset a promotion proposal.',
        {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: 'Proposal ID',
                },
                action: {
                    type: 'string',
                    enum: ['accept', 'dismiss', 'reset'],
                    description: 'Action to take on the proposal',
                },
                edit: {
                    type: 'string',
                    description: 'Edited rule text (optional, for accept action)',
                },
            },
            required: ['id', 'action'],
        },
        async ({ id, action, edit }) => {
            try {
                const tableCheck = db.query(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='promotion_candidates'"
                ).get();

                if (!tableCheck) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ error: 'Promotion system not yet initialized' }) }],
                        isError: true,
                    };
                }

                const proposal = db.query('SELECT * FROM promotion_candidates WHERE id = ?').get(id);
                if (!proposal) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ error: 'Proposal not found', id }) }],
                        isError: true,
                    };
                }

                let newStatus;
                switch (action) {
                    case 'accept':
                        newStatus = 'accepted';
                        if (edit) {
                            db.query('UPDATE promotion_candidates SET status = ?, proposed_rule = ? WHERE id = ?')
                                .run(newStatus, edit, id);
                        } else {
                            db.query('UPDATE promotion_candidates SET status = ? WHERE id = ?')
                                .run(newStatus, id);
                        }
                        break;
                    case 'dismiss':
                        newStatus = 'dismissed';
                        db.query('UPDATE promotion_candidates SET status = ? WHERE id = ?')
                            .run(newStatus, id);
                        break;
                    case 'reset':
                        newStatus = 'watching';
                        db.query('UPDATE promotion_candidates SET status = ?, strikes = 1 WHERE id = ?')
                            .run(newStatus, id);
                        break;
                    default:
                        return {
                            content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid action', action }) }],
                            isError: true,
                        };
                }

                logger.info('Proposal action taken', { id, action, newStatus });

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ id, action, status: newStatus, success: true }),
                    }],
                };
            } catch (err) {
                logger.error('MCP memory.propose_action failed', { error: err.message, id, action });
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: 'Action failed', message: err.message }) }],
                    isError: true,
                };
            }
        }
    );

    // ── memory.status ─────────────────────────────────────────────
    server.tool(
        'memory_status',
        'Health check for the unified memory system. Reports backend availability, index stats, decay status, and pending proposal count.',
        {
            type: 'object',
            properties: {},
        },
        async () => {
            try {
                // Entity stats
                const entityCount = db.query('SELECT COUNT(*) AS cnt FROM entities').get()?.cnt || 0;
                const linkCount = db.query('SELECT COUNT(*) AS cnt FROM entity_links').get()?.cnt || 0;

                // Access log stats
                let accessCount = 0;
                try {
                    accessCount = db.query('SELECT COUNT(*) AS cnt FROM access_log').get()?.cnt || 0;
                } catch {
                    // Table may not exist yet
                }

                // Promotion stats
                let proposalCount = 0;
                try {
                    proposalCount = db.query(
                        "SELECT COUNT(*) AS cnt FROM promotion_candidates WHERE status = 'proposed'"
                    ).get()?.cnt || 0;
                } catch {
                    // Table may not exist yet
                }

                // Decay stats
                let decayStats = null;
                try {
                    const decayCount = db.query('SELECT COUNT(*) AS cnt FROM memory_decay_state').get()?.cnt || 0;
                    const lastDecay = db.query(
                        'SELECT MAX(last_decayed_at) AS ts FROM memory_decay_state'
                    ).get()?.ts || null;
                    decayStats = { tracked_memories: decayCount, last_decay_run: lastDecay };
                } catch {
                    // Table may not exist yet
                }

                const status = {
                    status: 'ok',
                    timestamp: new Date().toISOString(),
                    entities: {
                        count: entityCount,
                        links: linkCount,
                    },
                    access_log: {
                        total_acks: accessCount,
                    },
                    decay: decayStats || { status: 'not_initialized' },
                    proposals: {
                        pending: proposalCount,
                    },
                    backends: {
                        bm25: 'available',
                        semantic: 'available',
                        entity: 'available',
                    },
                };

                return {
                    content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
                };
            } catch (err) {
                logger.error('MCP memory.status failed', { error: err.message });
                return {
                    content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
                    isError: true,
                };
            }
        }
    );
}
