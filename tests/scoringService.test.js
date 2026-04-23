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
