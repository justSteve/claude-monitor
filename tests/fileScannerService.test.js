import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { discoverProjects, enumerateFiles, diffState, formatCentralTime } from '../server/services/fileScannerService.js';

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('formatCentralTime', () => {
    it('formats a Date to M/d/yy h:mm tt Central Time string', () => {
        // 2026-03-16T12:00:00Z = 7:00 AM CDT (UTC-5 during DST)
        const result = formatCentralTime(new Date('2026-03-16T12:00:00Z'));
        expect(result).toMatch(/^3\/16\/26\s+7:00\s+AM$/);
    });
});

describe('discoverProjects', () => {
    it('finds direct project children with .claude folders', () => {
        const projA = path.join(tmpDir, 'projectA');
        fs.mkdirSync(path.join(projA, '.claude'), { recursive: true });

        const result = discoverProjects(tmpDir);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('projectA');
        expect(result[0].hasClaude).toBe(true);
    });

    it('treats _ and . prefixed folders as containers', () => {
        const container = path.join(tmpDir, '_archive', 'subProject');
        fs.mkdirSync(path.join(container, '.claude'), { recursive: true });

        const result = discoverProjects(tmpDir);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('subProject');
        expect(result[0].container).toBe('_archive');
    });

    it('reports projects missing .claude folder', () => {
        fs.mkdirSync(path.join(tmpDir, 'noClaude'));

        const result = discoverProjects(tmpDir);
        expect(result).toHaveLength(1);
        expect(result[0].hasClaude).toBe(false);
    });
});

describe('enumerateFiles', () => {
    it('lists files in a directory recursively', () => {
        fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{}');
        fs.mkdirSync(path.join(tmpDir, 'rules'));
        fs.writeFileSync(path.join(tmpDir, 'rules', 'beads-first.md'), '# rules');

        const result = enumerateFiles(tmpDir);
        expect(result).toHaveLength(2);
        const filenames = result.map(f => f.filename).sort();
        expect(filenames).toEqual(['beads-first.md', 'settings.json']);
        expect(result[0]).toHaveProperty('sizeBytes');
        expect(result[0]).toHaveProperty('lastModified');
        expect(result[0]).toHaveProperty('path');
    });

    it('skips node_modules directories', () => {
        fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{}');
        fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), '');

        const result = enumerateFiles(tmpDir);
        expect(result).toHaveLength(1);
        expect(result[0].filename).toBe('settings.json');
    });
});

describe('diffState', () => {
    it('detects NEW files', () => {
        const current = { '/a/file.txt': { sizeBytes: 100, mtimeMs: Date.now() } };
        const previous = {};

        const changes = diffState(current, previous);
        expect(changes).toHaveLength(1);
        expect(changes[0].status).toBe('NEW');
        expect(changes[0].path).toBe('/a/file.txt');
    });

    it('detects MODIFIED files changed within window', () => {
        const now = Date.now();
        const current = { '/a/file.txt': { sizeBytes: 200, mtimeMs: now - 60000 } };
        const previous = { '/a/file.txt': { sizeBytes: 100, mtimeMs: now - 600000 } };

        const changes = diffState(current, previous, 300000);
        expect(changes).toHaveLength(1);
        expect(changes[0].status).toBe('MODIFIED');
        expect(changes[0].deltaSizeBytes).toBe(100);
    });

    it('ignores files not modified within window', () => {
        const now = Date.now();
        const current = { '/a/file.txt': { sizeBytes: 100, mtimeMs: now - 600000 } };
        const previous = { '/a/file.txt': { sizeBytes: 100, mtimeMs: now - 600000 } };

        const changes = diffState(current, previous, 300000);
        expect(changes).toHaveLength(0);
    });

    it('detects DELETED files', () => {
        const current = {};
        const previous = { '/a/gone.txt': { sizeBytes: 50, mtimeMs: Date.now() - 600000 } };

        const changes = diffState(current, previous);
        expect(changes).toHaveLength(1);
        expect(changes[0].status).toBe('DELETED');
    });
});
