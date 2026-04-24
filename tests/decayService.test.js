/**
 * Decay Service Tests
 * Part of co-1pc: unified memory search — Phase 4.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { createDecayService } from '../server/services/decayService.js';

const ENTITY_MIGRATION = path.join(import.meta.dir, '..', 'server', 'db', 'migrations', '001-entity-store.sql');
const ACCESS_MIGRATION = path.join(import.meta.dir, '..', 'server', 'db', 'migrations', '002-memory-metadata.sql');
const DECAY_MIGRATION  = path.join(import.meta.dir, '..', 'server', 'db', 'migrations', '003-decay-state.sql');

let db;
let decay;

beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    // Apply all migrations in order
    db.exec(fs.readFileSync(ENTITY_MIGRATION, 'utf8'));
    db.exec(fs.readFileSync(ACCESS_MIGRATION, 'utf8'));
    db.exec(fs.readFileSync(DECAY_MIGRATION, 'utf8'));
    decay = createDecayService(db);
});

afterEach(() => {
    db.close();
});

// ── tier assignment ──────────────────────────────────────────────

describe('assignTier', () => {
    it('assigns permanent to conventions paths', () => {
        expect(decay.assignTier('mempalace', 'conventions/beads-first.md')).toBe('permanent');
    });

    it('assigns permanent to .claude/rules paths', () => {
        expect(decay.assignTier('transcript', '/root/projects/COO/.claude/rules/tmux-first.md')).toBe('permanent');
    });

    it('assigns permanent to CLAUDE.md paths', () => {
        expect(decay.assignTier('mempalace', 'projects/COO/CLAUDE.md')).toBe('permanent');
    });

    it('assigns permanent to ECC data paths', () => {
        expect(decay.assignTier('mempalace', '/root/projects/COO/ecc/data/ecc-agents.json')).toBe('permanent');
    });

    it('assigns slow to mempalace drawers from general source', () => {
        expect(decay.assignTier('mempalace', 'projects/DReader/README.md')).toBe('slow');
    });

    it('assigns fast to transcripts', () => {
        expect(decay.assignTier('transcript', '/root/.claude/projects/some-session.jsonl')).toBe('fast');
    });

    it('assigns fast to unknown source without path', () => {
        expect(decay.assignTier('unknown')).toBe('fast');
    });
});

// ── effective age ────────────────────────────────────────────────

describe('computeEffectiveAge', () => {
    it('returns actual age when access count is 1', () => {
        expect(decay.computeEffectiveAge(30, 1)).toBe(30);
    });

    it('halves age with access count 2', () => {
        expect(decay.computeEffectiveAge(30, 2)).toBe(15);
    });

    it('reduces age with high access count', () => {
        // 90 days, accessed 6 times -> effective 15 days
        expect(decay.computeEffectiveAge(90, 6)).toBe(15);
    });

    it('returns full age when access count is 0', () => {
        // max(0, 1) = 1, so 30/1 = 30
        expect(decay.computeEffectiveAge(30, 0)).toBe(30);
    });

    it('handles zero age', () => {
        expect(decay.computeEffectiveAge(0, 5)).toBe(0);
    });
});

// ── stage transitions ────────────────────────────────────────────

describe('getNextStage', () => {
    it('returns null for permanent tier', () => {
        expect(decay.getNextStage('fresh', 100, 'permanent')).toBeNull();
    });

    it('transitions fresh -> summary at fast tier threshold', () => {
        expect(decay.getNextStage('fresh', 14, 'fast')).toBe('summary');
        expect(decay.getNextStage('fresh', 13, 'fast')).toBeNull();
    });

    it('transitions summary -> oneliner at fast tier threshold', () => {
        expect(decay.getNextStage('summary', 30, 'fast')).toBe('oneliner');
        expect(decay.getNextStage('summary', 29, 'fast')).toBeNull();
    });

    it('transitions oneliner -> archived at fast tier threshold', () => {
        expect(decay.getNextStage('oneliner', 90, 'fast')).toBe('archived');
        expect(decay.getNextStage('oneliner', 89, 'fast')).toBeNull();
    });

    it('uses slow tier thresholds', () => {
        expect(decay.getNextStage('fresh', 60, 'slow')).toBe('summary');
        expect(decay.getNextStage('fresh', 59, 'slow')).toBeNull();
        expect(decay.getNextStage('summary', 120, 'slow')).toBe('oneliner');
        expect(decay.getNextStage('oneliner', 180, 'slow')).toBe('archived');
    });

    it('returns null when already archived', () => {
        // Archived is terminal — no next stage
        expect(decay.getNextStage('archived', 500, 'fast')).toBeNull();
    });
});

// ── trackMemory and decay candidates ─────────────────────────────

describe('trackMemory + getDecayCandidates', () => {
    it('tracks a memory and retrieves it', () => {
        decay.trackMemory({
            memoryId: 'mem-001',
            memorySource: 'transcript',
            sourcePath: '/transcripts/session.jsonl',
            content: 'Some transcript content',
            ageDays: 5,
        });

        const state = db.query('SELECT * FROM memory_decay_state WHERE memory_id = ?').get('mem-001');
        expect(state).not.toBeNull();
        expect(state.tier).toBe('fast');
        expect(state.current_stage).toBe('fresh');
        expect(state.age_days).toBe(5);
    });

    it('finds decay candidates past threshold', () => {
        // Insert a fast-tier memory with effective age past summary threshold
        decay.trackMemory({
            memoryId: 'mem-old',
            memorySource: 'transcript',
            content: 'Old transcript',
            ageDays: 20,
        });

        // Manually set effective_age to be past the threshold
        db.query('UPDATE memory_decay_state SET effective_age = 20 WHERE memory_id = ?').run('mem-old');

        const candidates = decay.getDecayCandidates();
        expect(candidates.length).toBe(1);
        expect(candidates[0].memory_id).toBe('mem-old');
        expect(candidates[0].targetStage).toBe('summary');
    });

    it('does not find permanent memories as candidates', () => {
        decay.trackMemory({
            memoryId: 'mem-perm',
            memorySource: 'mempalace',
            sourcePath: 'conventions/beads-first.md',
            content: 'Beads first convention',
            ageDays: 365,
        });

        db.query('UPDATE memory_decay_state SET effective_age = 365 WHERE memory_id = ?').run('mem-perm');

        const candidates = decay.getDecayCandidates();
        expect(candidates.length).toBe(0);
    });
});

// ── compression ──────────────────────────────────────────────────

describe('compressMemory', () => {
    it('transitions stage and sets compressed content', () => {
        decay.trackMemory({
            memoryId: 'mem-compress',
            memorySource: 'transcript',
            content: 'A'.repeat(300),
            ageDays: 20,
        });

        decay.compressMemory('mem-compress', 'summary');

        const state = db.query('SELECT * FROM memory_decay_state WHERE memory_id = ?').get('mem-compress');
        expect(state.current_stage).toBe('summary');
        expect(state.compressed_content).toBeDefined();
        expect(state.compressed_content.length).toBeLessThan(300);
        expect(state.last_decayed_at).not.toBeNull();
    });

    it('accepts pre-generated compressed content', () => {
        decay.trackMemory({
            memoryId: 'mem-llm',
            memorySource: 'transcript',
            content: 'Original long content here',
            ageDays: 20,
        });

        decay.compressMemory('mem-llm', 'summary', 'LLM-generated summary text');

        const state = db.query('SELECT * FROM memory_decay_state WHERE memory_id = ?').get('mem-llm');
        expect(state.compressed_content).toBe('LLM-generated summary text');
    });
});

// ── full decay cycle ─────────────────────────────────────────────

describe('runDecayCycle', () => {
    it('processes memories and compresses candidates', () => {
        // Set up: one fresh memory with creation date 20 days ago
        decay.trackMemory({
            memoryId: 'mem-past',
            memorySource: 'transcript',
            content: 'Old content that should be summarized',
            ageDays: 20,
        });
        // Set created_at to 20 days ago so cycle recomputes effective_age correctly
        const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
        db.query('UPDATE memory_decay_state SET created_at = ? WHERE memory_id = ?')
            .run(twentyDaysAgo, 'mem-past');

        decay.trackMemory({
            memoryId: 'mem-young',
            memorySource: 'transcript',
            content: 'Recent content stays fresh',
            ageDays: 3,
        });
        // Young memory keeps its just-created timestamp (effective_age ~ 0)

        const result = decay.runDecayCycle();

        expect(result.processed).toBe(2);
        expect(result.compressed).toBe(1);
        expect(result.errors).toBe(0);

        // Verify the old one was compressed
        const pastState = db.query('SELECT * FROM memory_decay_state WHERE memory_id = ?').get('mem-past');
        expect(pastState.current_stage).toBe('summary');

        // Verify the young one stayed fresh
        const youngState = db.query('SELECT * FROM memory_decay_state WHERE memory_id = ?').get('mem-young');
        expect(youngState.current_stage).toBe('fresh');
    });

    it('skips permanent memories', () => {
        decay.trackMemory({
            memoryId: 'mem-perm',
            memorySource: 'mempalace',
            sourcePath: 'conventions/beads-first.md',
            content: 'Never decays',
            ageDays: 500,
        });

        const result = decay.runDecayCycle();
        // Permanent tier is excluded from allByTier query
        expect(result.compressed).toBe(0);
    });

    it('accounts for access count in effective age', () => {
        decay.trackMemory({
            memoryId: 'mem-popular',
            memorySource: 'transcript',
            content: 'Frequently accessed content',
            ageDays: 20,
        });

        // Simulate 5 accesses — effective age becomes 20/5 = 4 (below 14-day threshold)
        for (let i = 0; i < 5; i++) {
            db.query('INSERT INTO access_log (memory_id) VALUES (?)').run('mem-popular');
        }

        // Set a creation date 20 days ago for the cycle to compute
        const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
        db.query('UPDATE memory_decay_state SET created_at = ? WHERE memory_id = ?')
            .run(twentyDaysAgo, 'mem-popular');

        const result = decay.runDecayCycle();

        // With 5 accesses, effective age = 20/5 = 4, below summary threshold 14
        const state = db.query('SELECT * FROM memory_decay_state WHERE memory_id = ?').get('mem-popular');
        expect(state.current_stage).toBe('fresh');
        expect(state.access_count).toBe(5);
    });
});

// ── stats ────────────────────────────────────────────────────────

describe('getStats', () => {
    it('returns counts by stage', () => {
        decay.trackMemory({ memoryId: 'm1', memorySource: 'transcript', ageDays: 5 });
        decay.trackMemory({ memoryId: 'm2', memorySource: 'transcript', ageDays: 5 });
        decay.trackMemory({ memoryId: 'm3', memorySource: 'transcript', ageDays: 5 });

        // Manually compress one
        db.query("UPDATE memory_decay_state SET current_stage = 'summary' WHERE memory_id = 'm3'").run();

        const stats = decay.getStats();
        expect(stats.fresh).toBe(2);
        expect(stats.summary).toBe(1);
        expect(stats.oneliner).toBe(0);
        expect(stats.archived).toBe(0);
    });
});
