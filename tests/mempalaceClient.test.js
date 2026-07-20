/**
 * mempalaceClient tests.
 *
 * Rewritten 2026-07-20 (co-ujjh). The previous suite asserted a JSON output
 * contract that MemPalace has never had — the CLI has no --json flag — so the
 * tests passed green against a parser that could not work on real output. That
 * is the worst kind of test: it certified a broken integration for months.
 * Every fixture below is verbatim CLI output.
 */

import { describe, it, expect } from 'bun:test';
import { parseSearchOutput } from '../server/services/mempalaceClient.js';

// Verbatim `mempalace search "beads dolt corruption" --results 2` output.
// Note: [1]/[2] are 1-based INDEXES; the score lives on the `Match:` line;
// separators are U+2500; content is indented 6 spaces and contains tabs.
const REAL_OUTPUT = `============================================================
  Results for: "beads dolt corruption"
============================================================

  [1] beads / cmd
      Source: dolt_test.go
      Match:  0.561

      if loadedCfg.DoltServerHost == "10.0.0.1" {
      \t\tt.Error("REGRESSION: known-bad production values")
      \t}
      }

  ────────────────────────────────────────────────────────
  [2] coo / general
      Source: beads-persistent-substrate.md
      Match:  0.556

      ---
      name: Beads are the persistent substrate
      description: Everything else gets repaved
`;

describe('parseSearchOutput — degenerate input', () => {
    it('returns [] for empty and nullish input', () => {
        expect(parseSearchOutput('')).toEqual([]);
        expect(parseSearchOutput(null)).toEqual([]);
        expect(parseSearchOutput(undefined)).toEqual([]);
        expect(parseSearchOutput('   \n  \n  ')).toEqual([]);
    });

    it('treats a banner with no result blocks as "no matches"', () => {
        const noHits = `============================================================
  Results for: "nothing whatsoever"
============================================================
`;
        expect(parseSearchOutput(noHits)).toEqual([]);
    });
});

describe('parseSearchOutput — real CLI grammar', () => {
    const results = parseSearchOutput(REAL_OUTPUT);

    it('finds every result block', () => {
        expect(results).toHaveLength(2);
    });

    it('REGRESSION: reads Match: as the score, not the [N] index', () => {
        // The original parser read `[1]`/`[2]` as the score, yielding 1.0 and
        // 2.0 — both outside the valid cosine range — and silently discarded
        // the real ranking. This is the defect that made the signal useless.
        expect(results[0].score).toBeCloseTo(0.561, 3);
        expect(results[1].score).toBeCloseTo(0.556, 3);
        for (const r of results) {
            expect(r.score).toBeGreaterThan(0);
            expect(r.score).toBeLessThanOrEqual(1);
        }
    });

    it('splits "wing / room" and captures the Source: filename', () => {
        expect(results[0].source).toMatchObject({
            type: 'mempalace', wing: 'beads', room: 'cmd', file: 'dolt_test.go',
        });
        expect(results[1].source).toMatchObject({
            type: 'mempalace', wing: 'coo', room: 'general',
            file: 'beads-persistent-substrate.md',
        });
    });

    it('keeps multi-line content without leaking header lines into it', () => {
        expect(results[0].content).toContain('loadedCfg.DoltServerHost');
        expect(results[0].content).toContain('REGRESSION');
        expect(results[0].content).not.toContain('Source:');
        expect(results[0].content).not.toContain('Match:');
    });

    it('strips the common indent but preserves relative indentation', () => {
        // The corpus contains source code, where indentation carries meaning.
        const lines = results[0].content.split('\n');
        expect(lines[0].startsWith(' ')).toBe(false);
        expect(results[0].content).toContain('\t\tt.Error');
    });

    it('does not let U+2500 separators become content', () => {
        expect(results[0].content).not.toContain('─');
        expect(results[1].content).not.toContain('─');
    });
});

describe('parseSearchOutput — content containing blank lines', () => {
    // The old parser split blocks on blank lines, shredding any multi-paragraph
    // result. Splitting on the [N] header is what fixes it.
    const withBlanks = `============================================================
  Results for: "x"
============================================================

  [1] coo / docs
      Source: notes.md
      Match:  0.900

      first paragraph

      second paragraph after a blank line

      third one
`;

    it('does not truncate a result at a blank line inside its content', () => {
        const r = parseSearchOutput(withBlanks);
        expect(r).toHaveLength(1);
        expect(r[0].content).toContain('first paragraph');
        expect(r[0].content).toContain('second paragraph');
        expect(r[0].content).toContain('third one');
    });

    it('does not mistake a bracketed number inside content for a new result', () => {
        const tricky = `  [1] coo / docs
      Source: notes.md
      Match:  0.5

      see item [2] below for details
      and [3] as well
`;
        const r = parseSearchOutput(tricky);
        // Content sits at 6-space indent; the header regex caps indent at 4,
        // so these must stay inside the single result.
        expect(r).toHaveLength(1);
        expect(r[0].content).toContain('[2]');
        expect(r[0].content).toContain('[3]');
    });
});
