/**
 * Tests for curatedSearchService (co-ceyz3.1 — Federated Memory Search phase 1)
 *
 * Uses a temp-dir fixture corpus shaped like the real roots:
 *   <tmp>/bundleA/                       — an OKF bundle (with an excluded subdir)
 *   <tmp>/projects/-p-One/memory/        — an auto-memory dir
 *   <tmp>/projects/-p-Two/               — a project WITHOUT a memory dir (skipped)
 *
 * Config is injected by monkey-patching scoringService's cached config, which
 * is how getConfig() consumers see it in production.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const scoring = require('../server/services/scoringService.js');
import { search, _resetCache } from '../server/services/curatedSearchService.js';

let tmp;
let realGetConfig;
let fakeConfig;

function writeFixture(rel, content) {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
}

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-curated-test-'));

    writeFixture('bundleA/zebra-convention.md',
        '---\ntype: convention\ntitle: Zebra Handling\n---\nThe zebra migration corridor is sacred infrastructure.\n');
    writeFixture('bundleA/other-topic.md',
        '---\ntype: runbook\n---\nNothing relevant here.\n');
    writeFixture('bundleA/zepo-prompts/excluded-note.md',
        'zebra zebra zebra — excluded directory, must never be indexed\n');
    writeFixture('projects/-p-One/memory/giraffe-memory.md',
        '---\nname: giraffe\n---\nThe giraffe preference was confirmed on Tuesday.\n');
    writeFixture('projects/-p-One/memory/MEMORY.md', '- [giraffe](giraffe-memory.md) — giraffe hook\n');
    fs.mkdirSync(path.join(tmp, 'projects', '-p-Two'), { recursive: true });

    fakeConfig = {
        weights: { bm25: 0.4, semantic: 0.4, curated: 0.6, entity: 0.2 },
        defaultLimit: 10,
        curated: {
            refreshSeconds: 0, // rescan every query — tests mutate the corpus
            bundles: [path.join(tmp, 'bundleA')],
            autoMemoryParent: path.join(tmp, 'projects'),
            exclude: ['zepo-prompts'],
        },
    };

    realGetConfig = scoring.getConfig;
    // getConfig caches in module state; seed the cache with the fixture config.
    const cacheRef = scoring.getConfig();
    Object.keys(cacheRef).forEach(k => delete cacheRef[k]);
    Object.assign(cacheRef, fakeConfig);
});

afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
    _resetCache();
});

describe('curated search: corpus and tiers', () => {
    test('finds an OKF bundle concept and labels its tier', async () => {
        const r = await search('zebra migration corridor');
        expect(r.count).toBeGreaterThanOrEqual(1);
        const top = r.hits[0];
        expect(top.tier).toBe('okf');
        expect(top.source_path.endsWith('zebra-convention.md')).toBe(true);
        expect(top.snippet.toLowerCase()).toContain('zebra');
    });

    test('finds an auto-memory fact and labels tier + project', async () => {
        const r = await search('giraffe preference Tuesday');
        expect(r.count).toBeGreaterThanOrEqual(1);
        const top = r.hits[0];
        expect(top.tier).toBe('auto-memory');
        expect(top.project).toBe('-p-One');
        expect(top.source_path.endsWith('giraffe-memory.md')).toBe(true);
    });

    test('excluded directories are never indexed', async () => {
        const r = await search('excluded directory must never be indexed');
        const excludedHits = r.hits.filter(h => h.source_path.includes('zepo-prompts'));
        expect(excludedHits.length).toBe(0);
    });

    test('all-terms-present ranks above single-term (shared scoring)', async () => {
        const r = await search('zebra sacred infrastructure');
        expect(r.hits[0].source_path.endsWith('zebra-convention.md')).toBe(true);
    });

    test('empty query terms return empty hits, not an error', async () => {
        const r = await search('a'); // below the 2-char token floor
        expect(r.count).toBe(0);
        expect(r.hits).toEqual([]);
    });
});

describe('curated search: freshness', () => {
    test('an edited file is searchable on the next scan', async () => {
        await search('zebra'); // build cache
        writeFixture('bundleA/fresh-note.md', 'the quokka doctrine arrived today\n');
        const r = await search('quokka doctrine');
        expect(r.count).toBe(1);
        expect(r.hits[0].source_path.endsWith('fresh-note.md')).toBe(true);
        fs.rmSync(path.join(tmp, 'bundleA', 'fresh-note.md'));
    });

    test('a deleted file drops out of the corpus', async () => {
        writeFixture('bundleA/ephemeral.md', 'wombat singularity\n');
        let r = await search('wombat singularity');
        expect(r.count).toBe(1);
        fs.rmSync(path.join(tmp, 'bundleA', 'ephemeral.md'));
        _resetCache();
        r = await search('wombat singularity');
        expect(r.count).toBe(0);
    });
});

describe('curated search: degradation contract', () => {
    test('one missing root degrades gracefully and is reported', async () => {
        fakeConfig.curated.bundles = [path.join(tmp, 'bundleA'), path.join(tmp, 'no-such-bundle')];
        const r = await search('zebra');
        expect(r.count).toBeGreaterThanOrEqual(1);
        expect(r.missing_roots).toContain(path.join(tmp, 'no-such-bundle'));
        fakeConfig.curated.bundles = [path.join(tmp, 'bundleA')];
    });

    test('no readable roots at all throws (marks signal degraded upstream)', async () => {
        const saved = { ...fakeConfig.curated };
        fakeConfig.curated.bundles = [path.join(tmp, 'nope-a')];
        fakeConfig.curated.autoMemoryParent = path.join(tmp, 'nope-b');
        await expect(search('zebra')).rejects.toThrow(/no readable roots/);
        Object.assign(fakeConfig.curated, saved);
    });
});
