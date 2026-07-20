/**
 * Unified Search Service
 * Orchestrates fan-out queries to BM25 (CASS), semantic (MemPalace), and entity
 * backends, normalizes scores, fuses results, and returns ranked unified results.
 *
 * Factory pattern: createUnifiedSearch({ cassSearch, mempalaceSearch, entityStore })
 * returns a service with a single `query()` method.
 *
 * Part of co-1pc: unified memory search — Phase 2, Task 7.
 */

import logger from './logService.js';

const { getConfig, normalizeBM25, fuseRankedLists } = require('./scoringService.js');

/**
 * Create a unified search service with injected backends.
 *
 * @param {object} deps
 * @param {object} deps.cassSearch    - CASS search backend ({ search(query, filters) })
 * @param {object} deps.mempalaceSearch - MemPalace search backend ({ search(query, options) })
 * @param {object} deps.entityStore   - Entity store (createEntityStore result)
 * @returns {object} Unified search API with `query()` method
 */
export function createUnifiedSearch({ cassSearch, mempalaceSearch, entityStore }) {
    const config = getConfig();
    const weights = config.weights;

    /**
     * Execute a unified search across all enabled backends.
     *
     * @param {string} queryText - The search query
     * @param {object} [options={}]
     * @param {number} [options.limit] - Max results (default from config)
     * @param {string[]} [options.signals] - Enabled backends: ['bm25','semantic','entity'] (default: all)
     * @param {string} [options.scope] - Search scope label (informational)
     * @returns {Promise<{query, scope, results, degraded, timings}>}
     */
    async function query(queryText, options = {}) {
        const {
            limit = config.defaultLimit,
            signals = ['bm25', 'semantic', 'entity'],
            scope = 'all',
        } = options;

        const enableBM25 = signals.includes('bm25');
        const enableSemantic = signals.includes('semantic');
        const enableEntity = signals.includes('entity');

        const timings = {};
        const degraded = [];

        // ── 1. Fan-out (parallel) ──────────────────────────────────

        const fanOutPromises = [];

        if (enableBM25) {
            fanOutPromises.push(
                fanOutBM25(queryText, timings)
                    .catch(err => {
                        logger.warn('BM25 backend failed', { error: err.message });
                        degraded.push('bm25');
                        return [];
                    })
            );
        } else {
            fanOutPromises.push(Promise.resolve([]));
        }

        if (enableSemantic) {
            fanOutPromises.push(
                fanOutSemantic(queryText, timings)
                    .catch(err => {
                        logger.warn('Semantic backend failed', { error: err.message });
                        degraded.push('semantic');
                        return [];
                    })
            );
        } else {
            fanOutPromises.push(Promise.resolve([]));
        }

        let entityMatches = [];
        if (enableEntity) {
            const entityStart = Date.now();
            try {
                entityMatches = fanOutEntity(queryText);
                timings.entity = Date.now() - entityStart;
            } catch (err) {
                timings.entity = Date.now() - entityStart;
                logger.warn('Entity backend failed', { error: err.message });
                degraded.push('entity');
            }
        }

        const [bm25Candidates, semanticCandidates] = await Promise.all(fanOutPromises);

        // ── 2. Normalize BM25 scores ───────────────────────────────
        // Sigmoid normalization is monotonic, so it does not change BM25's own
        // ordering — it exists so the reported signal is a readable 0-1 value.

        for (const candidate of bm25Candidates) {
            candidate.rawScore = normalizeBM25(candidate.rawScore);
        }

        // Semantic rawScore is already 0-1 cosine similarity; left as-is.

        // ── 3. Fuse by RANK, not by score ──────────────────────────
        //
        // These two retrievers draw from different corpora and their scores are
        // not on comparable scales: normalizeBM25 saturates near 1.0 while
        // cosine for relevant prose sits at 0.4-0.6. Weighted-sum fusion
        // therefore ranked every keyword hit above every semantic hit
        // regardless of relevance — the first semantic result landed past rank
        // 20 against a default limit of 10, so the signal was invisible even
        // when working perfectly. Reciprocal rank fusion compares positions
        // instead of magnitudes, needs no calibration, and gives a document
        // found by BOTH retrievers the sum of its contributions. co-n7mx.
        //
        // Do not "restore" fuseScores here without re-reading that bead.

        const entityBoostFor = (enableEntity && entityMatches.length > 0)
            ? (content) => computeBestEntityBoost(content, entityMatches)
            : undefined;

        const fused = fuseRankedLists({
            lists: { bm25: bm25Candidates, semantic: semanticCandidates },
            weights,
            entityBoostFor,
            entityWeight: weights.entity ?? 0,
        });

        const results = fused.slice(0, limit);

        logger.debug('Unified search completed', {
            query: queryText,
            bm25Count: bm25Candidates.length,
            semanticCount: semanticCandidates.length,
            entityCount: entityMatches.length,
            fusedCount: results.length,
            degraded,
        });

        return {
            query: queryText,
            scope,
            results,
            degraded,
            timings,
        };
    }

    // ── backend wrappers ───────────────────────────────────────────

    /**
     * Fan out to BM25/CASS backend.
     * @param {string} queryText
     * @param {object} timings - Mutated with bm25 timing
     * @returns {Promise<Array>} Candidate objects with content, rawScore, source
     */
    async function fanOutBM25(queryText, timings) {
        const start = Date.now();
        try {
            const result = await cassSearch.search(queryText, { limit: 20 });
            timings.bm25 = Date.now() - start;
            return (result.hits || []).map(hit => ({
                content: hit.snippet || hit.content || '',
                rawScore: hit.score || 0,
                source: { type: 'transcript', path: hit.source_path || '' },
            }));
        } catch (err) {
            timings.bm25 = Date.now() - start;
            throw err;
        }
    }

    /**
     * Fan out to semantic/MemPalace backend.
     * @param {string} queryText
     * @param {object} timings - Mutated with semantic timing
     * @returns {Promise<Array>} Candidate objects with content, rawScore, source
     */
    async function fanOutSemantic(queryText, timings) {
        const start = Date.now();
        try {
            const results = await mempalaceSearch.search(queryText, { limit: 10 });
            timings.semantic = Date.now() - start;
            return (results || []).map(hit => ({
                content: hit.content || '',
                rawScore: hit.score || 0,
                source: hit.source || { type: 'mempalace' },
            }));
        } catch (err) {
            timings.semantic = Date.now() - start;
            throw err;
        }
    }

    /**
     * Extract entities from query and compute boost scores.
     * Synchronous -- entity store uses in-process sqlite.
     * @param {string} queryText
     * @returns {Array<{entity, boost}>} Matched entities with precomputed boost
     */
    function fanOutEntity(queryText) {
        const matched = entityStore.extractEntitiesFromQuery(queryText);
        return matched.map(entity => ({
            entity,
            boost: entityStore.computeEntityBoost(entity.id),
        }));
    }

    /**
     * Compute the best entity boost for a candidate result.
     * Checks if any matched entity name or alias appears in the candidate content.
     * Returns the highest boost among matching entities, or null if none match.
     *
     * @param {string} content - Candidate result content
     * @param {Array<{entity, boost}>} entityMatches - Entities extracted from query
     * @returns {number|null} Best entity boost score, or null
     */
    function computeBestEntityBoost(content, entityMatches) {
        if (!content || entityMatches.length === 0) return null;

        const lowerContent = content.toLowerCase();
        let bestBoost = null;

        for (const { entity, boost } of entityMatches) {
            // Check entity name
            if (lowerContent.includes(entity.name.toLowerCase())) {
                bestBoost = bestBoost === null ? boost : Math.max(bestBoost, boost);
                continue;
            }

            // Check aliases
            const aliases = Array.isArray(entity.aliases) ? entity.aliases : [];
            for (const alias of aliases) {
                if (lowerContent.includes(alias.toLowerCase())) {
                    bestBoost = bestBoost === null ? boost : Math.max(bestBoost, boost);
                    break;
                }
            }
        }

        return bestBoost;
    }

    return { query };
}

export default createUnifiedSearch;
