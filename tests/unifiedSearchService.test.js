import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { createUnifiedSearch } from '../server/services/unifiedSearchService.js';
import { createEntityStore } from '../server/services/entityStoreService.js';

const MIGRATION_PATH = path.join(
    import.meta.dir,
    '..',
    'server',
    'db',
    'migrations',
    '001-entity-store.sql',
);

// ── test fixtures ──────────────────────────────────────────────────

/** Build a mock CASS search backend. */
function mockCass(hits = []) {
    return {
        search: async (query, filters) => ({
            hits,
            total_matches: hits.length,
            count: hits.length,
        }),
    };
}

/** Build a mock MemPalace search backend. */
function mockMempalace(results = []) {
    return {
        search: async (query, options) => results,
    };
}

/** Build a failing backend that throws. */
function failingBackend(name) {
    return {
        search: async () => { throw new Error(`${name} is down`); },
    };
}

// ── setup: real entity store with in-memory sqlite ─────────────────

let db;
let entityStore;

beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    db.exec(migrationSql);
    entityStore = createEntityStore(db);
});

afterEach(() => {
    db.close();
});

/** Seed a test entity and optional links. */
function seedEntity(overrides = {}) {
    const defaults = {
        id: 'ent-coo',
        name: 'COO',
        type: 'zgent',
        source: 'ecc',
        confidence: 0.9,
        aliases: ['Chief Operating Officer'],
    };
    entityStore.upsertEntity({ ...defaults, ...overrides });
    return { ...defaults, ...overrides };
}

// ── core fan-out + fusion ──────────────────────────────────────────

describe('unified search: fan-out and fusion', () => {
    it('fans out to all three backends and returns fused results', async () => {
        seedEntity();

        const cassHits = [
            { snippet: 'COO manages conventions', score: 8.5, source_path: '/root/projects/COO/CLAUDE.md' },
            { snippet: 'Factory pipeline overview', score: 5.2, source_path: '/root/projects/COO/factory/README.md' },
        ];

        const mempalaceHits = [
            { content: 'COO is the operations agent', score: 0.92, source: { type: 'mempalace', wing: 'projects', room: 'COO', file: 'CLAUDE.md' } },
        ];

        const search = createUnifiedSearch({
            cassSearch: mockCass(cassHits),
            mempalaceSearch: mockMempalace(mempalaceHits),
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('COO conventions');

        expect(result.query).toBe('COO conventions');
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.degraded).toEqual([]);
        expect(result.timings).toHaveProperty('bm25');
        expect(result.timings).toHaveProperty('semantic');
        expect(result.timings).toHaveProperty('entity');

        // Every result has a fused score and signals breakdown
        for (const r of result.results) {
            expect(typeof r.score).toBe('number');
            expect(r.score).toBeGreaterThanOrEqual(0);
            expect(r.score).toBeLessThanOrEqual(1);
            expect(r.signals).toBeDefined();
            expect(r.source).toBeDefined();
        }
    });

    it('results are sorted by fused score descending', async () => {
        const cassHits = [
            { snippet: 'Low relevance', score: 1.0, source_path: '/low.md' },
            { snippet: 'High relevance', score: 15.0, source_path: '/high.md' },
        ];

        const search = createUnifiedSearch({
            cassSearch: mockCass(cassHits),
            mempalaceSearch: mockMempalace([]),
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('test query');
        expect(result.results.length).toBe(2);
        expect(result.results[0].score).toBeGreaterThanOrEqual(result.results[1].score);
    });
});

// ── graceful degradation ───────────────────────────────────────────

describe('unified search: graceful degradation', () => {
    it('returns results from remaining backends when CASS fails', async () => {
        const mempalaceHits = [
            { content: 'Semantic result survives', score: 0.85, source: { type: 'mempalace', wing: 'projects', room: 'test', file: 'test.md' } },
        ];

        const search = createUnifiedSearch({
            cassSearch: failingBackend('CASS'),
            mempalaceSearch: mockMempalace(mempalaceHits),
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('test');

        expect(result.degraded).toContain('bm25');
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.results[0].content).toBe('Semantic result survives');
    });

    it('returns results from remaining backends when MemPalace fails', async () => {
        const cassHits = [
            { snippet: 'BM25 result survives', score: 6.0, source_path: '/test.md' },
        ];

        const search = createUnifiedSearch({
            cassSearch: mockCass(cassHits),
            mempalaceSearch: failingBackend('MemPalace'),
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('test');

        expect(result.degraded).toContain('semantic');
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.results[0].content).toBe('BM25 result survives');
    });

    it('returns empty results when all backends fail', async () => {
        const search = createUnifiedSearch({
            cassSearch: failingBackend('CASS'),
            mempalaceSearch: failingBackend('MemPalace'),
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('test');

        expect(result.degraded).toContain('bm25');
        expect(result.degraded).toContain('semantic');
        expect(result.results).toEqual([]);
    });
});

// ── signals parameter ──────────────────────────────────────────────

describe('unified search: signals parameter', () => {
    it('disables BM25 when signals excludes it', async () => {
        let cassCalled = false;
        const spyCass = {
            search: async () => { cassCalled = true; return { hits: [], total_matches: 0, count: 0 }; },
        };

        const mempalaceHits = [
            { content: 'Only semantic', score: 0.8, source: { type: 'mempalace', wing: 'p', room: 'r', file: 'f' } },
        ];

        const search = createUnifiedSearch({
            cassSearch: spyCass,
            mempalaceSearch: mockMempalace(mempalaceHits),
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('test', { signals: ['semantic', 'entity'] });

        expect(cassCalled).toBe(false);
        expect(result.results.length).toBeGreaterThan(0);
        // BM25 should not appear in timings
        expect(result.timings.bm25).toBeUndefined();
    });

    it('disables semantic when signals excludes it', async () => {
        let mempalaceCalled = false;
        const spyMempalace = {
            search: async () => { mempalaceCalled = true; return []; },
        };

        const cassHits = [
            { snippet: 'Only BM25', score: 5.0, source_path: '/test.md' },
        ];

        const search = createUnifiedSearch({
            cassSearch: mockCass(cassHits),
            mempalaceSearch: spyMempalace,
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('test', { signals: ['bm25', 'entity'] });

        expect(mempalaceCalled).toBe(false);
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.timings.semantic).toBeUndefined();
    });

    it('disables entity when signals excludes it', async () => {
        seedEntity();

        const cassHits = [
            { snippet: 'COO result', score: 5.0, source_path: '/test.md' },
        ];

        const search = createUnifiedSearch({
            cassSearch: mockCass(cassHits),
            mempalaceSearch: mockMempalace([]),
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('COO test', { signals: ['bm25', 'semantic'] });

        // Entity signal should be null for all results
        for (const r of result.results) {
            expect(r.signals.entity).toBeNull();
        }
        expect(result.timings.entity).toBeUndefined();
    });
});

// ── result structure ───────────────────────────────────────────────

describe('unified search: result structure', () => {
    it('BM25 results have correct source provenance', async () => {
        const cassHits = [
            { snippet: 'From CASS', score: 7.0, source_path: '/root/projects/COO/test.md' },
        ];

        const search = createUnifiedSearch({
            cassSearch: mockCass(cassHits),
            mempalaceSearch: mockMempalace([]),
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('test');
        const hit = result.results[0];

        expect(hit.source.type).toBe('transcript');
        expect(hit.source.path).toBe('/root/projects/COO/test.md');
        expect(hit.signals.bm25).toBeDefined();
        expect(typeof hit.signals.bm25).toBe('number');
    });

    it('semantic results have correct source provenance', async () => {
        const mempalaceHits = [
            { content: 'From MemPalace', score: 0.88, source: { type: 'mempalace', wing: 'projects', room: 'COO', file: 'test.md' } },
        ];

        const search = createUnifiedSearch({
            cassSearch: mockCass([]),
            mempalaceSearch: mockMempalace(mempalaceHits),
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('test');
        const hit = result.results[0];

        expect(hit.source.type).toBe('mempalace');
        expect(hit.source.wing).toBe('projects');
        expect(hit.signals.semantic).toBeCloseTo(0.88, 2);
    });

    it('entity boost is applied to matching results', async () => {
        seedEntity({ id: 'ent-coo', name: 'COO', confidence: 0.9 });
        entityStore.linkEntityToMemory('ent-coo', 'mem-001', 'transcript');

        const cassHits = [
            { snippet: 'COO manages the enterprise', score: 5.0, source_path: '/test.md' },
        ];

        const search = createUnifiedSearch({
            cassSearch: mockCass(cassHits),
            mempalaceSearch: mockMempalace([]),
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('COO');
        const hit = result.results[0];

        // Entity signal should be > 0 because "COO" is in content and query matches entity
        expect(hit.signals.entity).toBeGreaterThan(0);
    });
});

// ── deduplication ──────────────────────────────────────────────────

describe('unified search: deduplication', () => {
    it('deduplicates identical content across backends', async () => {
        const sharedContent = 'COO manages conventions and factory tooling';

        const cassHits = [
            { snippet: sharedContent, score: 6.0, source_path: '/test.md' },
        ];

        const mempalaceHits = [
            { content: sharedContent, score: 0.85, source: { type: 'mempalace', wing: 'p', room: 'r', file: 'f' } },
        ];

        const search = createUnifiedSearch({
            cassSearch: mockCass(cassHits),
            mempalaceSearch: mockMempalace(mempalaceHits),
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('COO');

        // Should be deduplicated to 1 result, with additional_sources
        expect(result.results.length).toBe(1);
        expect(result.results[0].additional_sources.length).toBe(1);
    });
});

// ── limit / scope ──────────────────────────────────────────────────

describe('unified search: options', () => {
    it('respects limit option', async () => {
        const cassHits = [];
        for (let i = 0; i < 15; i++) {
            cassHits.push({ snippet: `Result ${i}`, score: 15 - i, source_path: `/r${i}.md` });
        }

        const search = createUnifiedSearch({
            cassSearch: mockCass(cassHits),
            mempalaceSearch: mockMempalace([]),
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('test', { limit: 5 });
        expect(result.results.length).toBe(5);
    });

    it('uses default limit from config when not specified', async () => {
        const cassHits = [];
        for (let i = 0; i < 20; i++) {
            cassHits.push({ snippet: `Result ${i}`, score: 20 - i, source_path: `/r${i}.md` });
        }

        const search = createUnifiedSearch({
            cassSearch: mockCass(cassHits),
            mempalaceSearch: mockMempalace([]),
            entityStore,
            trialLog: () => {},
        });

        const result = await search.query('test');
        // Default limit is 10 from unified-search.json
        expect(result.results.length).toBeLessThanOrEqual(10);
    });
});

// ── vector-recall trial instrumentation (co-ta0m) ──────────────────

describe('unified search: trial instrumentation', () => {
    it('records a semantic-only hit that BM25 missed entirely', async () => {
        const cassHits = [
            { snippet: 'keyword result', score: 8.0, source_path: '/kw.md' },
        ];
        const mempalaceHits = [
            { content: 'a purely semantic memory', score: 0.61, source: { type: 'mempalace', wing: 'coo', room: 'technical', file: 'x.md' } },
        ];

        const records = [];
        const search = createUnifiedSearch({
            cassSearch: mockCass(cassHits),
            mempalaceSearch: mockMempalace(mempalaceHits),
            entityStore,
            trialLog: r => records.push(r),
        });

        await search.query('anything');

        expect(records.length).toBe(1);
        const rec = records[0];
        expect(rec.query).toBe('anything');
        expect(rec.candidates).toEqual({ bm25: 1, semantic: 1, curated: 0 });
        expect(rec.both).toBe(0);
        expect(rec.semanticOnly.length).toBe(1);
        expect(rec.semanticOnly[0].semanticScore).toBe(0.61);
        expect(rec.semanticOnly[0].source.wing).toBe('coo');
        expect(rec.semanticOnly[0].pos).toBeGreaterThanOrEqual(1);
    });

    it('counts agreement (both retrievers) and reports no semantic-only rows', async () => {
        const shared = 'identical content found by both retrievers';
        const cassHits = [
            { snippet: shared, score: 9.0, source_path: '/both.md' },
        ];
        const mempalaceHits = [
            { content: shared, score: 0.7, source: { type: 'mempalace', wing: 'coo', room: 'technical', file: 'both.md' } },
        ];

        const records = [];
        const search = createUnifiedSearch({
            cassSearch: mockCass(cassHits),
            mempalaceSearch: mockMempalace(mempalaceHits),
            entityStore,
            trialLog: r => records.push(r),
        });

        await search.query('overlap');

        expect(records.length).toBe(1);
        expect(records[0].both).toBe(1);
        expect(records[0].semanticOnly).toEqual([]);
    });

    it('a throwing trial logger does not break the query', async () => {
        const cassHits = [
            { snippet: 'result', score: 5.0, source_path: '/r.md' },
        ];

        const search = createUnifiedSearch({
            cassSearch: mockCass(cassHits),
            mempalaceSearch: mockMempalace([]),
            entityStore,
            trialLog: () => { throw new Error('disk full'); },
        });

        const result = await search.query('resilience');
        expect(result.results.length).toBe(1);
    });
});
