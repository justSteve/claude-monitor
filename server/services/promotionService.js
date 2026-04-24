/**
 * Promotion Service
 * Detects recurring patterns across sessions and proposes candidate rules.
 * Uses 3-strike rule: same pattern in 3 separate sessions, spread across
 * at least 3 days, triggers a proposal.
 *
 * Part of co-1pc: unified memory search — Phase 5.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import logger from './logService.js';

const configPath = join(import.meta.dir, '..', 'config', 'unified-search.json');
let _config;

function getPromotionConfig() {
    if (!_config) {
        _config = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
    return _config.promotion || {
        enabled: true,
        strike_threshold: 3,
        min_days_spread: 3,
        categories: ['preference', 'convention', 'antipattern', 'tooling'],
        auto_write_rules: false,
    };
}

/**
 * Create a promotion service backed by the given database.
 *
 * @param {import('bun:sqlite').Database} db - Raw bun:sqlite Database
 * @returns {object} Promotion service API
 */
export function createPromotionService(db) {

    const stmts = {
        getByPattern: db.query('SELECT * FROM promotion_candidates WHERE pattern = ?'),

        insert: db.query(`
            INSERT INTO promotion_candidates (id, pattern, category, strikes, session_refs, first_seen_at, last_seen_at, status)
            VALUES ($id, $pattern, $category, $strikes, $sessionRefs, $firstSeen, $lastSeen, $status)
        `),

        update: db.query(`
            UPDATE promotion_candidates
            SET strikes = $strikes,
                session_refs = $sessionRefs,
                last_seen_at = $lastSeen,
                status = $status,
                proposed_rule = $proposedRule
            WHERE id = $id
        `),

        getByStatus: db.query('SELECT * FROM promotion_candidates WHERE status = ? ORDER BY last_seen_at DESC'),

        getById: db.query('SELECT * FROM promotion_candidates WHERE id = ?'),

        updateStatus: db.query('UPDATE promotion_candidates SET status = ? WHERE id = ?'),

        updateStatusAndRule: db.query('UPDATE promotion_candidates SET status = ?, proposed_rule = ? WHERE id = ?'),

        resetStrikes: db.query("UPDATE promotion_candidates SET status = 'watching', strikes = 1 WHERE id = ?"),
    };

    /**
     * Record an observation of a recurring pattern.
     * Increments strike count only if the session is new (not already recorded).
     *
     * @param {string} pattern - Description of the observed pattern
     * @param {string} category - One of: preference, convention, antipattern, tooling
     * @param {string} sessionId - Current session identifier
     * @returns {{ id: string, strikes: number, status: string, isNew: boolean }}
     */
    function observePattern(pattern, category, sessionId) {
        const config = getPromotionConfig();
        const existing = stmts.getByPattern.get(pattern);

        if (!existing) {
            // First observation
            const id = `promo-${randomUUID().slice(0, 8)}`;
            const now = new Date().toISOString();
            stmts.insert.run({
                $id: id,
                $pattern: pattern,
                $category: category,
                $strikes: 1,
                $sessionRefs: JSON.stringify([sessionId]),
                $firstSeen: now,
                $lastSeen: now,
                $status: 'watching',
            });

            logger.debug('New pattern observed', { id, pattern, category });
            return { id, strikes: 1, status: 'watching', isNew: true };
        }

        // Already dismissed — don't re-trigger
        if (existing.status === 'dismissed') {
            return { id: existing.id, strikes: existing.strikes, status: 'dismissed', isNew: false };
        }

        // Already proposed or accepted — no further strikes needed
        if (existing.status === 'proposed' || existing.status === 'accepted') {
            return { id: existing.id, strikes: existing.strikes, status: existing.status, isNew: false };
        }

        // Check if this session is already recorded
        let sessionRefs;
        try {
            sessionRefs = JSON.parse(existing.session_refs || '[]');
        } catch {
            sessionRefs = [];
        }

        if (sessionRefs.includes(sessionId)) {
            // Same session — no new strike
            return { id: existing.id, strikes: existing.strikes, status: existing.status, isNew: false };
        }

        // New session — increment strike
        sessionRefs.push(sessionId);
        const newStrikes = existing.strikes + 1;
        const now = new Date().toISOString();

        let newStatus = existing.status;

        // Check if we've hit the promotion threshold
        if (newStrikes >= config.strike_threshold) {
            // Check minimum days spread
            const firstSeen = new Date(existing.first_seen_at);
            const daySpread = (new Date(now) - firstSeen) / (1000 * 60 * 60 * 24);

            if (daySpread >= config.min_days_spread) {
                newStatus = 'proposed';
                logger.info('Pattern promoted to proposal', { id: existing.id, pattern, strikes: newStrikes, daySpread });
            }
        }

        stmts.update.run({
            $id: existing.id,
            $strikes: newStrikes,
            $sessionRefs: JSON.stringify(sessionRefs),
            $lastSeen: now,
            $status: newStatus,
            $proposedRule: existing.proposed_rule,
        });

        return { id: existing.id, strikes: newStrikes, status: newStatus, isNew: false };
    }

    /**
     * Check for patterns that have reached promotion threshold.
     * Returns candidates that need rule text generation.
     *
     * @returns {Array} Proposed candidates without rule text
     */
    function checkPromotions() {
        const proposed = stmts.getByStatus.all('proposed');
        return proposed.filter(p => !p.proposed_rule);
    }

    /**
     * Set the generated rule text for a proposed candidate.
     *
     * @param {string} id - Candidate ID
     * @param {string} ruleText - Generated rule text
     */
    function setProposedRule(id, ruleText) {
        stmts.updateStatusAndRule.run('proposed', ruleText, id);
        logger.info('Proposed rule text set', { id });
    }

    /**
     * List proposals by status.
     *
     * @param {string} [status='proposed'] - Filter by status
     * @returns {Array} Proposals
     */
    function getProposals(status = 'proposed') {
        return stmts.getByStatus.all(status);
    }

    /**
     * Accept a proposal.
     *
     * @param {string} id - Proposal ID
     * @param {string} [editedText] - Optional edited rule text
     * @returns {{ success: boolean, proposal: object|null }}
     */
    function acceptProposal(id, editedText) {
        const proposal = stmts.getById.get(id);
        if (!proposal) return { success: false, proposal: null };

        if (editedText) {
            stmts.updateStatusAndRule.run('accepted', editedText, id);
        } else {
            stmts.updateStatus.run('accepted', id);
        }

        logger.info('Proposal accepted', { id, pattern: proposal.pattern });
        return { success: true, proposal: { ...proposal, status: 'accepted' } };
    }

    /**
     * Dismiss a proposal — won't be proposed again.
     *
     * @param {string} id - Proposal ID
     * @returns {{ success: boolean }}
     */
    function dismissProposal(id) {
        const proposal = stmts.getById.get(id);
        if (!proposal) return { success: false };

        stmts.updateStatus.run('dismissed', id);
        logger.info('Proposal dismissed', { id, pattern: proposal.pattern });
        return { success: true };
    }

    /**
     * Reset a proposal back to watching with 1 strike.
     *
     * @param {string} id - Proposal ID
     * @returns {{ success: boolean }}
     */
    function resetProposal(id) {
        const proposal = stmts.getById.get(id);
        if (!proposal) return { success: false };

        stmts.resetStrikes.run(id);
        logger.info('Proposal reset', { id, pattern: proposal.pattern });
        return { success: true };
    }

    /**
     * Get a specific proposal by ID.
     *
     * @param {string} id
     * @returns {object|null}
     */
    function getProposal(id) {
        return stmts.getById.get(id) || null;
    }

    return {
        observePattern,
        checkPromotions,
        setProposedRule,
        getProposals,
        getProposal,
        acceptProposal,
        dismissProposal,
        resetProposal,
    };
}

export default createPromotionService;
