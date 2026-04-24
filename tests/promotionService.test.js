/**
 * Promotion Service Tests
 * Part of co-1pc: unified memory search — Phase 5.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { createPromotionService } from '../server/services/promotionService.js';

const PROMOTION_MIGRATION = path.join(import.meta.dir, '..', 'server', 'db', 'migrations', '004-promotion.sql');

let db;
let promo;

beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(fs.readFileSync(PROMOTION_MIGRATION, 'utf8'));
    promo = createPromotionService(db);
});

afterEach(() => {
    db.close();
});

// ── pattern observation ──────────────────────────────────────────

describe('observePattern', () => {
    it('creates a new watching pattern on first observation', () => {
        const result = promo.observePattern('Steve prefers dark mode', 'preference', 'session-001');

        expect(result.isNew).toBe(true);
        expect(result.strikes).toBe(1);
        expect(result.status).toBe('watching');

        const proposal = promo.getProposal(result.id);
        expect(proposal).not.toBeNull();
        expect(proposal.pattern).toBe('Steve prefers dark mode');
        expect(proposal.category).toBe('preference');
    });

    it('increments strike on observation from new session', () => {
        const first = promo.observePattern('always use bd', 'convention', 'session-001');
        const second = promo.observePattern('always use bd', 'convention', 'session-002');

        expect(second.strikes).toBe(2);
        expect(second.status).toBe('watching');
        expect(second.isNew).toBe(false);
    });

    it('does not increment strike for same session', () => {
        promo.observePattern('always use bd', 'convention', 'session-001');
        const repeat = promo.observePattern('always use bd', 'convention', 'session-001');

        expect(repeat.strikes).toBe(1);
        expect(repeat.isNew).toBe(false);
    });

    it('promotes to proposed after 3 strikes with sufficient day spread', () => {
        // First strike
        const first = promo.observePattern('read code first', 'convention', 'session-001');

        // Manually set first_seen_at to 5 days ago to satisfy min_days_spread
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
        db.query('UPDATE promotion_candidates SET first_seen_at = ? WHERE id = ?')
            .run(fiveDaysAgo, first.id);

        // Second and third strikes
        promo.observePattern('read code first', 'convention', 'session-002');
        const third = promo.observePattern('read code first', 'convention', 'session-003');

        expect(third.strikes).toBe(3);
        expect(third.status).toBe('proposed');
    });

    it('stays watching when 3 strikes but insufficient day spread', () => {
        // All strikes happen "now" — day spread is 0
        promo.observePattern('quick pattern', 'preference', 'session-001');
        promo.observePattern('quick pattern', 'preference', 'session-002');
        const third = promo.observePattern('quick pattern', 'preference', 'session-003');

        // Day spread is ~0, less than min_days_spread (3)
        expect(third.strikes).toBe(3);
        expect(third.status).toBe('watching');
    });

    it('does not re-trigger dismissed patterns', () => {
        const first = promo.observePattern('dismissed pattern', 'tooling', 'session-001');
        promo.dismissProposal(first.id);

        const retry = promo.observePattern('dismissed pattern', 'tooling', 'session-002');
        expect(retry.status).toBe('dismissed');
        expect(retry.isNew).toBe(false);
    });
});

// ── proposal listing ─────────────────────────────────────────────

describe('getProposals', () => {
    it('returns proposals filtered by status', () => {
        const r = promo.observePattern('pattern-a', 'convention', 'session-001');

        // Force to proposed status
        db.query("UPDATE promotion_candidates SET status = 'proposed' WHERE id = ?").run(r.id);

        const proposed = promo.getProposals('proposed');
        expect(proposed.length).toBe(1);
        expect(proposed[0].pattern).toBe('pattern-a');

        const watching = promo.getProposals('watching');
        expect(watching.length).toBe(0);
    });

    it('returns empty array when no proposals', () => {
        expect(promo.getProposals('proposed')).toEqual([]);
    });
});

// ── accept / dismiss / reset ─────────────────────────────────────

describe('acceptProposal', () => {
    it('marks proposal as accepted', () => {
        const r = promo.observePattern('accept me', 'convention', 'session-001');
        db.query("UPDATE promotion_candidates SET status = 'proposed' WHERE id = ?").run(r.id);

        const result = promo.acceptProposal(r.id);
        expect(result.success).toBe(true);

        const proposal = promo.getProposal(r.id);
        expect(proposal.status).toBe('accepted');
    });

    it('accepts with edited rule text', () => {
        const r = promo.observePattern('edit me', 'convention', 'session-001');
        db.query("UPDATE promotion_candidates SET status = 'proposed' WHERE id = ?").run(r.id);

        promo.acceptProposal(r.id, 'Custom rule text here');

        const proposal = promo.getProposal(r.id);
        expect(proposal.status).toBe('accepted');
        expect(proposal.proposed_rule).toBe('Custom rule text here');
    });

    it('returns failure for non-existent proposal', () => {
        const result = promo.acceptProposal('nonexistent');
        expect(result.success).toBe(false);
    });
});

describe('dismissProposal', () => {
    it('marks proposal as dismissed', () => {
        const r = promo.observePattern('dismiss me', 'antipattern', 'session-001');

        const result = promo.dismissProposal(r.id);
        expect(result.success).toBe(true);

        const proposal = promo.getProposal(r.id);
        expect(proposal.status).toBe('dismissed');
    });

    it('returns failure for non-existent proposal', () => {
        const result = promo.dismissProposal('nonexistent');
        expect(result.success).toBe(false);
    });
});

describe('resetProposal', () => {
    it('resets proposal to watching with 1 strike', () => {
        const r = promo.observePattern('reset me', 'tooling', 'session-001');
        promo.observePattern('reset me', 'tooling', 'session-002');

        promo.resetProposal(r.id);

        const proposal = promo.getProposal(r.id);
        expect(proposal.status).toBe('watching');
        expect(proposal.strikes).toBe(1);
    });
});

// ── checkPromotions ──────────────────────────────────────────────

describe('checkPromotions', () => {
    it('returns proposed candidates without rule text', () => {
        const r = promo.observePattern('needs rule', 'convention', 'session-001');
        db.query("UPDATE promotion_candidates SET status = 'proposed' WHERE id = ?").run(r.id);

        const candidates = promo.checkPromotions();
        expect(candidates.length).toBe(1);
        expect(candidates[0].proposed_rule).toBeNull();
    });

    it('excludes proposed candidates that already have rule text', () => {
        const r = promo.observePattern('has rule', 'convention', 'session-001');
        db.query("UPDATE promotion_candidates SET status = 'proposed', proposed_rule = 'some rule' WHERE id = ?")
            .run(r.id);

        const candidates = promo.checkPromotions();
        expect(candidates.length).toBe(0);
    });
});

// ── setProposedRule ──────────────────────────────────────────────

describe('setProposedRule', () => {
    it('sets the rule text on a proposed candidate', () => {
        const r = promo.observePattern('rule me', 'convention', 'session-001');
        db.query("UPDATE promotion_candidates SET status = 'proposed' WHERE id = ?").run(r.id);

        promo.setProposedRule(r.id, '# Rule: Always do X\n\nDo X because Y.');

        const proposal = promo.getProposal(r.id);
        expect(proposal.proposed_rule).toBe('# Rule: Always do X\n\nDo X because Y.');
        expect(proposal.status).toBe('proposed');
    });
});

// ── end-to-end 3-strike ─────────────────────────────────────────

describe('end-to-end 3-strike pipeline', () => {
    it('full lifecycle: observe -> propose -> accept', () => {
        // Strike 1
        const r = promo.observePattern('always check health', 'convention', 'session-001');
        expect(r.status).toBe('watching');

        // Set first_seen_at to 5 days ago
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
        db.query('UPDATE promotion_candidates SET first_seen_at = ? WHERE id = ?')
            .run(fiveDaysAgo, r.id);

        // Strike 2
        const r2 = promo.observePattern('always check health', 'convention', 'session-002');
        expect(r2.status).toBe('watching');

        // Strike 3 — should promote
        const r3 = promo.observePattern('always check health', 'convention', 'session-003');
        expect(r3.status).toBe('proposed');
        expect(r3.strikes).toBe(3);

        // Set rule text
        promo.setProposedRule(r.id, '# Rule: Health Check\n\nAlways check health on startup.');

        // Accept
        const acceptResult = promo.acceptProposal(r.id);
        expect(acceptResult.success).toBe(true);

        // Final state
        const final = promo.getProposal(r.id);
        expect(final.status).toBe('accepted');
        expect(final.proposed_rule).toContain('Health Check');
    });
});
