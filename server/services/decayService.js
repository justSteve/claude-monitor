/**
 * Decay Service
 * Manages memory lifecycle — tier assignment, effective age computation,
 * compression stage transitions, and nightly decay cycle.
 *
 * Three tiers:
 *   - permanent: conventions, rules, ECC entities — never decay
 *   - slow: MemPalace drawers, extracted facts — long decay windows
 *   - fast: session transcripts, working memory — short decay windows
 *
 * Compression stages: fresh -> summary -> oneliner -> archived
 * Salience override: effective_age = actual_age / max(access_count, 1)
 *
 * Part of co-1pc: unified memory search — Phase 4.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import logger from './logService.js';

const configPath = join(import.meta.dir, '..', 'config', 'unified-search.json');
let _config;

function getDecayConfig() {
    if (!_config) {
        _config = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
    return _config.decay || {
        enabled: true,
        tiers: {
            fast: { summary: 14, oneliner: 30, archive: 90 },
            slow: { summary: 60, oneliner: 120, archive: 180 },
        },
        salience: true,
    };
}

/**
 * Create a decay service backed by the given database.
 *
 * @param {import('bun:sqlite').Database} db - Raw bun:sqlite Database
 * @returns {object} Decay service API
 */
export function createDecayService(db) {

    const stmts = {
        upsertState: db.query(`
            INSERT INTO memory_decay_state
                (memory_id, memory_source, tier, current_stage, original_content, age_days, access_count, effective_age, created_at)
            VALUES ($memoryId, $memorySource, $tier, $stage, $originalContent, $ageDays, $accessCount, $effectiveAge,
                    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            ON CONFLICT(memory_id) DO UPDATE SET
                age_days       = excluded.age_days,
                access_count   = excluded.access_count,
                effective_age  = excluded.effective_age,
                last_decayed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        `),

        getByMemoryId: db.query('SELECT * FROM memory_decay_state WHERE memory_id = ?'),

        getCandidatesByTierAndStage: db.query(`
            SELECT * FROM memory_decay_state
            WHERE tier = $tier AND current_stage = $stage AND effective_age >= $threshold
        `),

        updateStage: db.query(`
            UPDATE memory_decay_state
            SET current_stage = $newStage,
                compressed_content = $compressedContent,
                last_decayed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE memory_id = $memoryId
        `),

        getAccessCount: db.query(
            'SELECT COUNT(*) AS cnt FROM access_log WHERE memory_id = ?'
        ),

        allByTier: db.query(
            "SELECT * FROM memory_decay_state WHERE tier != 'permanent' ORDER BY effective_age DESC"
        ),

        countByStage: db.query(
            'SELECT current_stage, COUNT(*) AS cnt FROM memory_decay_state GROUP BY current_stage'
        ),
    };

    // ── Tier assignment ──────────────────────────────────────────

    /**
     * Assign a decay tier based on memory source and path.
     *
     * @param {string} memorySource - 'transcript' | 'mempalace'
     * @param {string} [sourcePath] - Optional path hint
     * @returns {'permanent' | 'slow' | 'fast'}
     */
    function assignTier(memorySource, sourcePath) {
        // Permanent: conventions, rules, arch decisions, ECC entities
        if (sourcePath) {
            const lower = sourcePath.toLowerCase();
            if (lower.includes('conventions/') ||
                lower.includes('.claude/rules/') ||
                lower.includes('claude.md') ||
                lower.includes('ecc/data/')) {
                return 'permanent';
            }
        }

        // MemPalace drawers default to slow
        if (memorySource === 'mempalace') return 'slow';

        // Transcripts default to fast
        if (memorySource === 'transcript') return 'fast';

        // Unknown: default to fast (conservative)
        return 'fast';
    }

    /**
     * Compute effective age with salience override.
     * Frequently accessed memories decay slower.
     *
     * @param {number} ageDays - Actual age in days
     * @param {number} accessCount - Number of acknowledgments
     * @returns {number} Effective age in days
     */
    function computeEffectiveAge(ageDays, accessCount) {
        return ageDays / Math.max(accessCount, 1);
    }

    /**
     * Determine the next compression stage based on effective age and tier thresholds.
     *
     * @param {string} currentStage - Current compression stage
     * @param {number} effectiveAge - Effective age in days
     * @param {string} tier - Decay tier
     * @returns {string|null} Next stage, or null if no transition needed
     */
    function getNextStage(currentStage, effectiveAge, tier) {
        if (tier === 'permanent') return null;

        const config = getDecayConfig();
        const thresholds = config.tiers[tier];
        if (!thresholds) return null;

        if (currentStage === 'fresh' && effectiveAge >= thresholds.summary) {
            return 'summary';
        }
        if (currentStage === 'summary' && effectiveAge >= thresholds.oneliner) {
            return 'oneliner';
        }
        if (currentStage === 'oneliner' && effectiveAge >= thresholds.archive) {
            return 'archived';
        }

        return null;
    }

    /**
     * Register or update a memory in the decay state table.
     *
     * @param {object} opts
     * @param {string} opts.memoryId
     * @param {string} opts.memorySource - 'transcript' | 'mempalace'
     * @param {string} [opts.sourcePath]
     * @param {string} [opts.content]
     * @param {number} [opts.ageDays]
     */
    function trackMemory({ memoryId, memorySource, sourcePath, content, ageDays = 0 }) {
        const tier = assignTier(memorySource, sourcePath);

        // Look up access count from access_log
        let accessCount = 0;
        try {
            const row = stmts.getAccessCount.get(memoryId);
            accessCount = row?.cnt || 0;
        } catch {
            // access_log table might not exist yet
        }

        const effectiveAge = computeEffectiveAge(ageDays, accessCount);
        const stage = tier === 'permanent' ? 'fresh' : 'fresh';

        stmts.upsertState.run({
            $memoryId: memoryId,
            $memorySource: memorySource,
            $tier: tier,
            $stage: stage,
            $originalContent: content || null,
            $ageDays: ageDays,
            $accessCount: accessCount,
            $effectiveAge: effectiveAge,
        });

        logger.debug('Memory tracked for decay', { memoryId, tier, effectiveAge });
    }

    /**
     * Get memories that need compression — past their tier's threshold.
     *
     * @returns {Array} Candidate memories with their target stage
     */
    function getDecayCandidates() {
        const config = getDecayConfig();
        const candidates = [];

        for (const tier of ['fast', 'slow']) {
            const thresholds = config.tiers[tier];
            if (!thresholds) continue;

            // Check fresh -> summary
            const freshCandidates = stmts.getCandidatesByTierAndStage.all({
                $tier: tier,
                $stage: 'fresh',
                $threshold: thresholds.summary,
            });
            for (const c of freshCandidates) {
                candidates.push({ ...c, targetStage: 'summary' });
            }

            // Check summary -> oneliner
            const summaryCandidates = stmts.getCandidatesByTierAndStage.all({
                $tier: tier,
                $stage: 'summary',
                $threshold: thresholds.oneliner,
            });
            for (const c of summaryCandidates) {
                candidates.push({ ...c, targetStage: 'oneliner' });
            }

            // Check oneliner -> archived
            const onelinerCandidates = stmts.getCandidatesByTierAndStage.all({
                $tier: tier,
                $stage: 'oneliner',
                $threshold: thresholds.archive,
            });
            for (const c of onelinerCandidates) {
                candidates.push({ ...c, targetStage: 'archived' });
            }
        }

        return candidates;
    }

    /**
     * Apply a compression stage transition to a memory.
     *
     * In production, the summary/oneliner content would be generated by an
     * LLM summarization pass. For now, we use placeholder compression.
     *
     * @param {string} memoryId - Memory to compress
     * @param {string} targetStage - Target stage ('summary', 'oneliner', 'archived')
     * @param {string} [compressedContent] - Pre-generated compressed content
     */
    function compressMemory(memoryId, targetStage, compressedContent) {
        const state = stmts.getByMemoryId.get(memoryId);
        if (!state) {
            logger.warn('Compress requested for unknown memory', { memoryId });
            return;
        }

        const content = compressedContent || generatePlaceholderCompression(state, targetStage);

        stmts.updateStage.run({
            $memoryId: memoryId,
            $newStage: targetStage,
            $compressedContent: content,
        });

        logger.info('Memory compressed', {
            memoryId,
            from: state.current_stage,
            to: targetStage,
        });
    }

    /**
     * Generate placeholder compression text.
     * In production, this would be an LLM call.
     * @private
     */
    function generatePlaceholderCompression(state, targetStage) {
        const source = state.compressed_content || state.original_content || '';
        if (targetStage === 'summary') {
            // First 200 chars as placeholder summary
            return source.substring(0, 200) + (source.length > 200 ? '...' : '');
        }
        if (targetStage === 'oneliner') {
            // First 80 chars as placeholder one-liner
            return source.substring(0, 80) + (source.length > 80 ? '...' : '');
        }
        if (targetStage === 'archived') {
            return '[ARCHIVED]';
        }
        return source;
    }

    /**
     * Run a full decay cycle:
     * 1. Update effective ages for all non-permanent memories
     * 2. Find candidates past their thresholds
     * 3. Compress candidates
     *
     * @returns {{ processed: number, compressed: number, errors: number }}
     */
    function runDecayCycle() {
        const config = getDecayConfig();
        if (!config.enabled) {
            logger.info('Decay cycle skipped — disabled in config');
            return { processed: 0, compressed: 0, errors: 0 };
        }

        let processed = 0;
        let compressed = 0;
        let errors = 0;

        // 1. Update effective ages
        const allMemories = stmts.allByTier.all();
        for (const mem of allMemories) {
            try {
                let accessCount = 0;
                try {
                    const row = stmts.getAccessCount.get(mem.memory_id);
                    accessCount = row?.cnt || 0;
                } catch {
                    // access_log not available
                }

                const now = new Date();
                const created = new Date(mem.created_at);
                const ageDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
                const effectiveAge = computeEffectiveAge(ageDays, accessCount);

                stmts.upsertState.run({
                    $memoryId: mem.memory_id,
                    $memorySource: mem.memory_source,
                    $tier: mem.tier,
                    $stage: mem.current_stage,
                    $originalContent: mem.original_content,
                    $ageDays: ageDays,
                    $accessCount: accessCount,
                    $effectiveAge: effectiveAge,
                });

                processed++;
            } catch (err) {
                logger.error('Decay age update failed', { memoryId: mem.memory_id, error: err.message });
                errors++;
            }
        }

        // 2. Find and compress candidates
        const candidates = getDecayCandidates();
        for (const candidate of candidates) {
            try {
                compressMemory(candidate.memory_id, candidate.targetStage);
                compressed++;
            } catch (err) {
                logger.error('Decay compression failed', { memoryId: candidate.memory_id, error: err.message });
                errors++;
            }
        }

        logger.info('Decay cycle complete', { processed, compressed, errors });
        return { processed, compressed, errors };
    }

    /**
     * Get decay statistics for the status endpoint.
     *
     * @returns {object} Stats by stage
     */
    function getStats() {
        try {
            const rows = stmts.countByStage.all();
            const stats = { fresh: 0, summary: 0, oneliner: 0, archived: 0 };
            for (const row of rows) {
                stats[row.current_stage] = row.cnt;
            }
            return stats;
        } catch {
            return { fresh: 0, summary: 0, oneliner: 0, archived: 0 };
        }
    }

    return {
        assignTier,
        computeEffectiveAge,
        getNextStage,
        trackMemory,
        getDecayCandidates,
        compressMemory,
        runDecayCycle,
        getStats,
    };
}

export default createDecayService;
