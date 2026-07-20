import { describe, it, expect } from 'bun:test';

describe('scoringService', () => {
    it('normalizes BM25 scores to 0-1 via sigmoid', () => {
        const { normalizeBM25 } = require('../server/services/scoringService.js');
        expect(normalizeBM25(0)).toBeCloseTo(0.5, 1);
        expect(normalizeBM25(10)).toBeGreaterThan(0.85);
        expect(normalizeBM25(-10)).toBeLessThan(0.15);
    });

    it('fuses three signals with configured weights', () => {
        const { fuseScores } = require('../server/services/scoringService.js');
        const weights = { bm25: 0.4, semantic: 0.4, entity: 0.2 };

        const score = fuseScores({ bm25: 1.0, semantic: 1.0, entity: 1.0 }, weights);
        expect(score).toBeCloseTo(1.0, 2);

        const half = fuseScores({ bm25: 0.5, semantic: 0.5, entity: 0.5 }, weights);
        expect(half).toBeCloseTo(0.5, 2);
    });

    it('handles missing signals by re-normalizing weights', () => {
        const { fuseScores } = require('../server/services/scoringService.js');
        const weights = { bm25: 0.4, semantic: 0.4, entity: 0.2 };

        // Semantic timed out — only bm25 + entity
        const score = fuseScores({ bm25: 0.8, semantic: null, entity: 0.6 }, weights);
        // Re-normalize: bm25 weight = 0.4/0.6 = 0.667, entity = 0.2/0.6 = 0.333
        const expected = (0.4 * 0.8 + 0.2 * 0.6) / (0.4 + 0.2);
        expect(score).toBeCloseTo(expected, 4);
    });

    it('returns 0 when all signals are null', () => {
        const { fuseScores } = require('../server/services/scoringService.js');
        const weights = { bm25: 0.4, semantic: 0.4, entity: 0.2 };
        expect(fuseScores({ bm25: null, semantic: null, entity: null }, weights)).toBe(0);
    });

    it('deduplicates results by content hash', () => {
        const { deduplicateResults } = require('../server/services/scoringService.js');

        const results = [
            { content: 'DReader uses pywinauto', score: 0.9, source: { type: 'mempalace' } },
            { content: 'DReader uses pywinauto', score: 0.7, source: { type: 'transcript' } },
            { content: 'Something different', score: 0.5, source: { type: 'transcript' } }
        ];

        const deduped = deduplicateResults(results);
        expect(deduped.length).toBe(2);
        expect(deduped[0].score).toBe(0.9);
        expect(deduped[0].additional_sources.length).toBe(1);
    });

    it('content hash is case-insensitive and whitespace-normalized', () => {
        const { contentHash } = require('../server/services/scoringService.js');
        const h1 = contentHash('Hello  World');
        const h2 = contentHash('hello world');
        expect(h1).toBe(h2);
    });

    it('deduplicates preserves higher-scoring result', () => {
        const { deduplicateResults } = require('../server/services/scoringService.js');

        const results = [
            { content: 'same content', score: 0.3, source: { type: 'transcript' } },
            { content: 'same content', score: 0.9, source: { type: 'mempalace' } },
        ];

        const deduped = deduplicateResults(results);
        expect(deduped.length).toBe(1);
        expect(deduped[0].score).toBe(0.9);
        expect(deduped[0].source.type).toBe('mempalace');
    });
});

// ── Reciprocal Rank Fusion (co-n7mx) ────────────────────────────────

describe('fuseRankedLists — rank fusion', () => {
    const weights = { bm25: 0.4, semantic: 0.4, entity: 0.2 };

    it('REGRESSION: a semantic hit reaches the default window despite a lower raw score', () => {
        // The defect this guards: normalizeBM25 saturates near 1.0 while cosine
        // for relevant prose sits at 0.4-0.6. Under weighted-sum fusion every
        // keyword hit outranked every semantic hit regardless of relevance, so
        // the first semantic result landed past rank 20 against a limit of 10.
        const { fuseRankedLists } = require('../server/services/scoringService.js');
        const bm25 = Array.from({ length: 25 }, (_, i) => ({
            content: 'kw' + i, rawScore: 0.99 - i * 0.002, source: { type: 'transcript' },
        }));
        const semantic = [0.56, 0.44, 0.41].map((s, i) => ({
            content: 'sem' + i, rawScore: s, source: { type: 'mempalace' },
        }));

        const top10 = fuseRankedLists({ lists: { bm25, semantic }, weights }).slice(0, 10);
        const semanticInWindow = top10.filter(r => r.source.type === 'mempalace').length;

        expect(semanticInWindow).toBeGreaterThan(0);
        // Equal weights means the two lists should interleave near the top.
        expect(top10[1].source.type).toBe('mempalace');
    });

    it('rewards a document both retrievers found', () => {
        const { fuseRankedLists } = require('../server/services/scoringService.js');
        const shared = fuseRankedLists({
            lists: {
                bm25: [{ content: 'shared', rawScore: 0.9, source: { type: 'transcript' } }],
                semantic: [{ content: 'shared', rawScore: 0.5, source: { type: 'mempalace' } }],
            }, weights,
        });
        const single = fuseRankedLists({
            lists: { bm25: [{ content: 'solo', rawScore: 0.9, source: { type: 'transcript' } }] },
            weights,
        });

        expect(shared).toHaveLength(1);                       // deduplicated
        expect(shared[0].ranks).toEqual({ bm25: 1, semantic: 1 });
        expect(shared[0].score).toBeGreaterThan(single[0].score);
    });

    it('ranks by position, so a saturated score cannot dominate', () => {
        const { rrfScore } = require('../server/services/scoringService.js');
        // Rank 1 in either list is worth the same; magnitude never enters.
        expect(rrfScore({ bm25: 1 }, weights)).toBeCloseTo(rrfScore({ semantic: 1 }, weights), 10);
        expect(rrfScore({ bm25: 1 }, weights)).toBeGreaterThan(rrfScore({ bm25: 2 }, weights));
    });

    it('tolerates an empty or missing list', () => {
        const { fuseRankedLists } = require('../server/services/scoringService.js');
        expect(fuseRankedLists({ lists: { bm25: [], semantic: [] }, weights })).toEqual([]);
        expect(fuseRankedLists({ lists: {}, weights })).toEqual([]);
    });

    it('applies the entity boost as a multiplier, not as a retriever', () => {
        const { fuseRankedLists } = require('../server/services/scoringService.js');
        const lists = { bm25: [{ content: 'alpha', rawScore: 0.9, source: { type: 't' } }] };
        const plain = fuseRankedLists({ lists, weights });
        const boosted = fuseRankedLists({
            lists, weights, entityBoostFor: () => 1.0, entityWeight: 0.2,
        });
        expect(boosted[0].score).toBeGreaterThan(plain[0].score);
        expect(boosted[0].signals.entity).toBe(1.0);
    });
});
