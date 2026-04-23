import { describe, it, expect } from 'bun:test';
import { searchMempalace, parseMempalaceOutput } from '../server/services/mempalaceClient.js';

// ── parseMempalaceOutput ────────────────────────────────────────────

describe('parseMempalaceOutput', () => {
    it('returns [] for empty string', () => {
        expect(parseMempalaceOutput('')).toEqual([]);
    });

    it('returns [] for null/undefined', () => {
        expect(parseMempalaceOutput(null)).toEqual([]);
        expect(parseMempalaceOutput(undefined)).toEqual([]);
    });

    it('returns [] for whitespace-only input', () => {
        expect(parseMempalaceOutput('   \n  \n  ')).toEqual([]);
    });

    it('parses a valid JSON array', () => {
        const input = JSON.stringify([
            { content: 'COO is the operations agent', score: 0.95, wing: 'projects', room: 'COO', file: 'CLAUDE.md' },
            { content: 'DReader is a reading app', score: 0.82, wing: 'projects', room: 'DReader', file: 'README.md' },
        ]);

        const results = parseMempalaceOutput(input);

        expect(results).toHaveLength(2);
        expect(results[0]).toEqual({
            content: 'COO is the operations agent',
            score: 0.95,
            source: { type: 'mempalace', wing: 'projects', room: 'COO', file: 'CLAUDE.md' },
        });
        expect(results[1].source.room).toBe('DReader');
    });

    it('normalizes alternative JSON field names', () => {
        const input = JSON.stringify([
            { text: 'alt text field', score: 0.7, category: 'reference', project: 'MemPalace', path: 'notes.md' },
        ]);

        const results = parseMempalaceOutput(input);

        expect(results).toHaveLength(1);
        expect(results[0].content).toBe('alt text field');
        expect(results[0].source.wing).toBe('reference');
        expect(results[0].source.room).toBe('MemPalace');
        expect(results[0].source.file).toBe('notes.md');
    });

    it('falls through to text parser for malformed JSON', () => {
        // JSON parse fails, text parser wraps as raw content
        const results = parseMempalaceOutput('[{broken json');
        expect(results).toHaveLength(1);
        expect(results[0].content).toBe('[{broken json');
        expect(results[0].score).toBe(0);
        expect(results[0].source.type).toBe('mempalace');
    });

    it('falls through to text parser for non-JSON bracket input', () => {
        // Starts with [ but fails JSON parse, text parser wraps as raw content
        const results = parseMempalaceOutput('[not json at all');
        expect(results).toHaveLength(1);
        expect(results[0].content).toBe('[not json at all');
        expect(results[0].source.type).toBe('mempalace');
    });

    it('parses JSONL format (one object per line)', () => {
        const input = [
            JSON.stringify({ content: 'line one', score: 0.9, wing: 'projects', room: 'COO', file: 'a.md' }),
            JSON.stringify({ content: 'line two', score: 0.8, wing: 'reference', room: 'docs', file: 'b.md' }),
        ].join('\n');

        const results = parseMempalaceOutput(input);

        expect(results).toHaveLength(2);
        expect(results[0].content).toBe('line one');
        expect(results[1].content).toBe('line two');
    });

    it('skips malformed JSONL lines gracefully', () => {
        const input = [
            JSON.stringify({ content: 'good line', score: 0.9, wing: 'w', room: 'r', file: 'f' }),
            '{broken',
            JSON.stringify({ content: 'also good', score: 0.7, wing: 'w2', room: 'r2', file: 'f2' }),
        ].join('\n');

        const results = parseMempalaceOutput(input);

        expect(results).toHaveLength(2);
        expect(results[0].content).toBe('good line');
        expect(results[1].content).toBe('also good');
    });

    it('parses text format with [score] path header', () => {
        const input = `[0.95] projects/COO/CLAUDE.md
COO is the Chief Operating Officer

[0.80] reference/docs/architecture.md
Architecture overview content here`;

        const results = parseMempalaceOutput(input);

        expect(results).toHaveLength(2);
        expect(results[0]).toEqual({
            content: 'COO is the Chief Operating Officer',
            score: 0.95,
            source: { type: 'mempalace', wing: 'projects', room: 'COO', file: 'CLAUDE.md' },
        });
        expect(results[1].score).toBe(0.80);
        expect(results[1].source.file).toBe('architecture.md');
    });

    it('parses text format with "score: N" header', () => {
        const input = `score: 0.88
projects/COO/notes.md
Some content from the notes file`;

        const results = parseMempalaceOutput(input);

        expect(results).toHaveLength(1);
        expect(results[0].score).toBe(0.88);
        expect(results[0].content).toBe('Some content from the notes file');
        expect(results[0].source.wing).toBe('projects');
    });

    it('falls back to raw content when format is unrecognized', () => {
        const input = 'Just some plain text result with no metadata';

        const results = parseMempalaceOutput(input);

        expect(results).toHaveLength(1);
        expect(results[0].content).toBe('Just some plain text result with no metadata');
        expect(results[0].score).toBe(0);
        expect(results[0].source.type).toBe('mempalace');
    });

    it('handles missing score in JSON (defaults to 0)', () => {
        const input = JSON.stringify([
            { content: 'no score', wing: 'w', room: 'r', file: 'f' },
        ]);

        const results = parseMempalaceOutput(input);
        expect(results[0].score).toBe(0);
    });

    it('handles deeply nested path in text format', () => {
        const input = '[0.75] projects/COO/docs/plans/deep/file.md\nDeep content';

        const results = parseMempalaceOutput(input);

        expect(results[0].source.wing).toBe('projects');
        expect(results[0].source.room).toBe('COO');
        expect(results[0].source.file).toBe('docs/plans/deep/file.md');
    });
});

// ── searchMempalace ─────────────────────────────────────────────────

describe('searchMempalace', () => {
    it('returns [] when binary is not found (graceful degradation)', async () => {
        // The default binary path won't exist in test env
        const results = await searchMempalace('test query');
        expect(results).toEqual([]);
    });

    it('returns [] for empty query', async () => {
        const results = await searchMempalace('');
        expect(results).toEqual([]);
    });

    it('returns [] for null query', async () => {
        const results = await searchMempalace(null);
        expect(results).toEqual([]);
    });

    it('returns [] for whitespace-only query', async () => {
        const results = await searchMempalace('   ');
        expect(results).toEqual([]);
    });
});
