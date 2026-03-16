# WSL Native File Scanner Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PowerShell file scanner with a native Node.js scanner that monitors WSL `.claude/` folders, producing the same scan data shape the existing API and dashboard consume.

**Architecture:** New `fileScannerService.js` does in-process file enumeration and state diffing. `schedulerService.js` calls it directly instead of spawning PowerShell. Config gains `scanRoots` array. State persisted as JSON file (same pattern as PS1). Timestamps use JS `Intl.DateTimeFormat` for Central Time formatting (backward compat with dashboard) plus native ISO 8601.

**Tech Stack:** Node.js `fs` module, Bun runtime, existing SQLite via `scanService.createScan()`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `server/services/fileScannerService.js` | Create | Project discovery, file enumeration, state diffing, scan result formatting |
| `server/services/schedulerService.js` | Modify | Replace PowerShell spawn with direct `fileScannerService.scan()` call |
| `server/config.js` | Modify | Add `scanRoots` configuration |
| `server/services/logService.js` | Modify | Remove WSL detection (no longer needed — always WSL) |
| `tests/fileScannerService.test.js` | Create | Unit tests for scanner logic |
| `tests/schedulerIntegration.test.js` | Create | Integration test: scheduler -> scanner -> scanService |

---

## Chunk 1: File Scanner Service

### Task 1: Add scan roots to config

**Files:**
- Modify: `server/config.js`

- [ ] **Step 1: Add scanRoots to config**

```js
// Add after cassTimeoutMs line:
    // File scanner
    scanRoots: JSON.parse(process.env.SCAN_ROOTS || JSON.stringify([
        { path: '/root/.claude', mode: 'direct' },
        { path: '/root/projects', mode: 'projects' }
    ])),
    scanStateFile: process.env.SCAN_STATE_FILE || path.join(rootDir, 'data', 'scan-state.json'),
```

- [ ] **Step 2: Add test script to package.json**

Add `"test": "bun test"` to the scripts section.

- [ ] **Step 3: Commit**

```bash
git add server/config.js package.json
git commit -m "feat: add scanRoots config for WSL native file scanner [gt-cm-wsl]"
```

---

### Task 2: Write failing tests for file scanner core logic

**Files:**
- Create: `tests/fileScannerService.test.js`

- [ ] **Step 1: Create test file with imports and test fixtures**

The tests use a temp directory with a fake project structure. Each test creates its own fixture to avoid coupling.

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/projects/claude-monitor && bun test tests/fileScannerService.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Commit test file**

```bash
git add tests/fileScannerService.test.js
git commit -m "test: add failing tests for WSL file scanner service [gt-cm-wsl]"
```

---

### Task 3: Implement fileScannerService.js

**Files:**
- Create: `server/services/fileScannerService.js`

- [ ] **Step 1: Implement the service**

```js
/**
 * File Scanner Service
 * Native Node.js replacement for Monitor-ClaudeFiles.ps1
 * Discovers projects, enumerates .claude/ files, diffs against previous state.
 */

import fs from 'fs';
import path from 'path';
import config from '../config.js';
import logger from './logService.js';
import scanService from './scanService.js';

/**
 * Format a Date as Central Time string: "M/d/yy h:mm tt"
 * Matches the PowerShell Format-Timestamp output for backward compatibility.
 */
function formatCentralTime(date = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        year: '2-digit',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
    // Intl gives "3/16/26, 7:00 AM" — strip the comma
    return formatter.format(date).replace(',', '');
}

/**
 * Discover projects under a root directory.
 * Folders starting with _ or . are containers — their children are projects.
 * Skips .claude folders (they're monitoring targets, not projects).
 */
function discoverProjects(rootPath) {
    const projects = [];

    let entries;
    try {
        entries = fs.readdirSync(rootPath, { withFileTypes: true });
    } catch (err) {
        logger.warn(`Cannot read project root: ${rootPath}`, { error: err.message });
        return projects;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === '.claude') continue;
        if (entry.name === 'node_modules') continue;

        if (entry.name.startsWith('_') || entry.name.startsWith('.')) {
            // Container — enumerate children as projects
            const containerPath = path.join(rootPath, entry.name);
            let children;
            try {
                children = fs.readdirSync(containerPath, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const child of children) {
                if (!child.isDirectory() || child.name === '.claude') continue;
                const childPath = path.join(containerPath, child.name);
                const claudePath = path.join(childPath, '.claude');
                projects.push({
                    name: child.name,
                    path: childPath,
                    container: entry.name,
                    root: rootPath,
                    hasClaude: fs.existsSync(claudePath)
                });
            }
        } else {
            const projPath = path.join(rootPath, entry.name);
            const claudePath = path.join(projPath, '.claude');
            projects.push({
                name: entry.name,
                path: projPath,
                container: null,
                root: rootPath,
                hasClaude: fs.existsSync(claudePath)
            });
        }
    }

    return projects;
}

/**
 * Enumerate files in a directory (recursive).
 * Skips node_modules directories.
 * Returns array of { path, filename, sizeBytes, mtimeMs, lastModified }
 */
function enumerateFiles(dirPath) {
    const files = [];

    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            logger.debug(`Cannot read directory: ${dir}`, { error: err.message });
            return;
        }

        for (const entry of entries) {
            if (entry.name === 'node_modules') continue;
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile()) {
                try {
                    const stat = fs.statSync(fullPath);
                    files.push({
                        path: fullPath,
                        filename: entry.name,
                        sizeBytes: stat.size,
                        mtimeMs: stat.mtimeMs,
                        lastModified: formatCentralTime(stat.mtime)
                    });
                } catch {
                    // File may have been deleted between readdir and stat
                    continue;
                }
            }
        }
    }

    walk(dirPath);
    return files;
}

/**
 * Diff current file state against previous state.
 * Returns array of change objects matching scanService.createScan() format.
 * @param {Object} current - { [path]: { sizeBytes, mtimeMs } }
 * @param {Object} previous - same shape
 * @param {number} windowMs - only report MODIFIED if mtime within this window (default 5 min)
 */
function diffState(current, previous, windowMs = 5 * 60 * 1000) {
    const changes = [];
    const now = Date.now();

    // Check for NEW and MODIFIED
    for (const [filePath, cur] of Object.entries(current)) {
        if (!(filePath in previous)) {
            changes.push({
                path: filePath,
                sizeBytes: cur.sizeBytes,
                deltaSizeBytes: null,
                status: 'NEW',
                attributes: [],
                lastModified: formatCentralTime(new Date(cur.mtimeMs))
            });
        } else if (cur.mtimeMs > now - windowMs) {
            const prev = previous[filePath];
            changes.push({
                path: filePath,
                sizeBytes: cur.sizeBytes,
                deltaSizeBytes: cur.sizeBytes - prev.sizeBytes,
                status: 'MODIFIED',
                attributes: [],
                lastModified: formatCentralTime(new Date(cur.mtimeMs))
            });
        }
    }

    // Check for DELETED
    for (const [filePath, prev] of Object.entries(previous)) {
        if (!(filePath in current)) {
            changes.push({
                path: filePath,
                sizeBytes: prev.sizeBytes,
                deltaSizeBytes: null,
                status: 'DELETED',
                attributes: [],
                lastModified: formatCentralTime(new Date(prev.mtimeMs))
            });
        }
    }

    return changes;
}

/**
 * Load previous scan state from disk.
 */
function loadState(stateFilePath) {
    try {
        if (fs.existsSync(stateFilePath)) {
            return JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
        }
    } catch (err) {
        logger.warn('Could not load scan state, starting fresh', { error: err.message });
    }
    return { files: {} };
}

/**
 * Save scan state to disk.
 */
function saveState(stateFilePath, state) {
    const dir = path.dirname(stateFilePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
}

/**
 * Run a full scan across all configured roots.
 * Returns the scan result in the shape scanService.createScan() expects.
 */
function scan() {
    const startTime = Date.now();
    const roots = config.scanRoots;
    const stateFilePath = config.scanStateFile;

    const previousState = loadState(stateFilePath);
    const currentFiles = {};
    let projectsScanned = 0;
    let projectsMissingClaude = 0;

    for (const root of roots) {
        if (!fs.existsSync(root.path)) {
            logger.warn(`Scan root does not exist, skipping: ${root.path}`);
            continue;
        }

        if (root.mode === 'direct') {
            // Scan files directly in this folder (like PS1's first root)
            for (const file of enumerateFiles(root.path)) {
                currentFiles[file.path] = {
                    sizeBytes: file.sizeBytes,
                    mtimeMs: file.mtimeMs
                };
            }
        } else if (root.mode === 'projects') {
            const projects = discoverProjects(root.path);
            for (const project of projects) {
                projectsScanned++;
                if (project.hasClaude) {
                    const claudePath = path.join(project.path, '.claude');
                    for (const file of enumerateFiles(claudePath)) {
                        currentFiles[file.path] = {
                            sizeBytes: file.sizeBytes,
                            mtimeMs: file.mtimeMs
                        };
                    }
                } else {
                    projectsMissingClaude++;
                }
            }
        }
    }

    // Diff against previous state
    const filesWithChange = diffState(currentFiles, previousState.files);
    const filesNoChange = Object.keys(currentFiles).length - filesWithChange.filter(
        c => c.status !== 'DELETED'
    ).length;

    // Save new state
    saveState(stateFilePath, {
        lastScan: new Date().toISOString(),
        files: currentFiles
    });

    const scanDurationMs = Date.now() - startTime;

    // Build result in the shape scanService.createScan() expects
    const scanResult = {
        scanTime: formatCentralTime(),
        scanDurationMs,
        projectsScanned,
        projectsMissingClaude,
        filesNoChange: Math.max(0, filesNoChange),
        filesWithChange
    };

    // Store in DB via scanService
    const dbResult = scanService.createScan(scanResult);

    logger.info('File scan completed', {
        duration: scanDurationMs,
        projects: projectsScanned,
        changes: filesWithChange.length,
        tracked: Object.keys(currentFiles).length,
        stored: dbResult.stored
    });

    return {
        ...scanResult,
        dbResult
    };
}

export {
    formatCentralTime,
    discoverProjects,
    enumerateFiles,
    diffState,
    loadState,
    saveState,
    scan
};

export default { scan };
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /root/projects/claude-monitor && bun test tests/fileScannerService.test.js`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add server/services/fileScannerService.js
git commit -m "feat: add WSL native file scanner service [gt-cm-wsl]"
```

---

## Chunk 2: Wire Scanner Into Scheduler and Clean Up

### Task 4: Replace PowerShell spawn in schedulerService.js

**Files:**
- Modify: `server/services/schedulerService.js`

- [ ] **Step 1: Rewrite schedulerService.js**

Replace the entire file. Key changes:
- Remove `detectWSL()`, `spawn` import, PowerShell path
- Import `fileScannerService` and call `scan()` directly
- `_runScan()` becomes a synchronous call wrapped in try/catch (file scanning is fast, no need for async subprocess management)

```js
/**
 * Scheduler Service
 * Runs native file scanner on a configurable interval
 */

import config from '../config.js';
import logger from './logService.js';
import fileScanner from './fileScannerService.js';

class SchedulerService {
    constructor() {
        this.intervalMs = config.scanIntervalMs;
        this.timer = null;
        this.isRunning = false;
        this.lastRun = null;
        this.lastRunDuration = null;
        this.lastRunStatus = null;
        this.lastRunChanges = 0;
        this.nextRun = null;
        this.runCount = 0;
        this.errorCount = 0;
    }

    start() {
        if (this.timer) {
            logger.warn('Scheduler already running');
            return;
        }

        logger.logSchedulerEvent('started', { intervalMs: this.intervalMs });

        // Run immediately on start
        this._runScan();

        // Then run on interval
        this.timer = setInterval(() => {
            this._runScan();
        }, this.intervalMs);

        this._updateNextRun();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            logger.logSchedulerEvent('stopped');
        }
    }

    async runNow() {
        logger.info('Manual scan triggered');
        return this._runScan();
    }

    getStatus() {
        return {
            running: this.timer !== null,
            scanning: this.isRunning,
            intervalMs: this.intervalMs,
            lastRun: this.lastRun,
            lastRunDuration: this.lastRunDuration,
            lastRunStatus: this.lastRunStatus,
            lastRunChanges: this.lastRunChanges,
            nextRun: this.nextRun,
            runCount: this.runCount,
            errorCount: this.errorCount
        };
    }

    _updateNextRun() {
        if (this.timer) {
            this.nextRun = new Date(Date.now() + this.intervalMs).toISOString();
        } else {
            this.nextRun = null;
        }
    }

    _runScan() {
        if (this.isRunning) {
            logger.warn('Scan already in progress, skipping');
            return { skipped: true, reason: 'already_running' };
        }

        this.isRunning = true;
        this.runCount++;
        const startTime = Date.now();

        try {
            const result = fileScanner.scan();

            this.lastRunChanges = result.filesWithChange.length;
            this.lastRun = new Date().toISOString();
            this.lastRunDuration = Date.now() - startTime;
            this.lastRunStatus = 'success';
            this._updateNextRun();

            return {
                success: true,
                duration: this.lastRunDuration,
                changes: this.lastRunChanges
            };

        } catch (err) {
            this.errorCount++;
            this.lastRun = new Date().toISOString();
            this.lastRunDuration = Date.now() - startTime;
            this.lastRunStatus = 'error';
            this._updateNextRun();

            logger.error('Scan failed', { error: err.message });

            return {
                success: false,
                error: err.message,
                duration: this.lastRunDuration
            };

        } finally {
            this.isRunning = false;
        }
    }
}

const schedulerService = new SchedulerService();
export default schedulerService;
```

- [ ] **Step 2: Commit**

```bash
git add server/services/schedulerService.js
git commit -m "feat: wire native file scanner into scheduler, remove PowerShell [gt-cm-wsl]"
```

---

### Task 5: Clean up logService WSL detection

**Files:**
- Modify: `server/services/logService.js`

- [ ] **Step 1: Remove WSL detection, always skip Windows Event Log**

The `_detectWSL()` method and `isWSL` flag are no longer needed. Since we're always in WSL, the `_writeToEventLog` method should be a permanent no-op. Simplify:

- Remove `_detectWSL()` method
- Remove `this.isWSL` from constructor
- Replace the body of `_writeToEventLog` with just `return;` (or remove calls to it)

Keep the method signature so callers don't break, but gut the implementation:

```js
_writeToEventLog(message, entryType = 'Information') {
    // Windows Event Log unavailable in WSL — permanent no-op
    return;
}
```

Remove from constructor:
```js
this.isWSL = this._detectWSL();
```

Remove the `_detectWSL()` method entirely.

- [ ] **Step 2: Commit**

```bash
git add server/services/logService.js
git commit -m "refactor: remove WSL detection from logService, always skip Event Log [gt-cm-wsl]"
```

---

### Task 6: Integration test — scheduler triggers scanner and stores results

**Files:**
- Create: `tests/schedulerIntegration.test.js`

- [ ] **Step 1: Write integration test**

```js
import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import { discoverProjects, formatCentralTime } from '../server/services/fileScannerService.js';

describe('File scanner against live WSL filesystem', () => {
    it('formatCentralTime returns expected format', () => {
        const ts = formatCentralTime(new Date());
        expect(ts).toMatch(/^\d{1,2}\/\d{1,2}\/\d{2}\s+\d{1,2}:\d{2}\s+(AM|PM)$/);
    });

    it('discovers real projects under /root/projects', () => {
        const projects = discoverProjects('/root/projects');
        expect(projects.length).toBeGreaterThan(0);
        // At least some should have .claude
        const withClaude = projects.filter(p => p.hasClaude);
        expect(withClaude.length).toBeGreaterThan(0);
    });

    it('/root/.claude exists and contains files', () => {
        expect(fs.existsSync('/root/.claude')).toBe(true);
    });
});
```

- [ ] **Step 2: Run integration test**

Run: `cd /root/projects/claude-monitor && bun test tests/schedulerIntegration.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/schedulerIntegration.test.js
git commit -m "test: add scheduler integration test [gt-cm-wsl]"
```

---

### Task 7: Verify full server startup with native scanner

- [ ] **Step 1: Start the server in tmux and verify health**

```bash
# In tmux session:
cd /root/projects/claude-monitor && bun run start
```

Verify:
- Server starts without errors
- `curl http://localhost:3000/health` returns `{"status":"ok"}` with scheduler running
- `curl http://localhost:3000/api/v1/scheduler/status` shows `running: true`, `lastRunStatus: "success"`
- `curl http://localhost:3000/api/v1/scans?limit=1` shows a recent scan with WSL file paths

- [ ] **Step 2: Trigger a manual scan and verify**

```bash
curl -X POST http://localhost:3000/api/v1/scheduler/run
```

Verify response shows `success: true` and `changes` count.

- [ ] **Step 3: Stop the server, commit any fixes needed**

---

### Task 8: Final cleanup

- [ ] **Step 1: Remove deleted config.json reference from PS1 if any imports remain**

The `config.json` was deleted in the crash recovery commit. Verify no code references it.

- [ ] **Step 2: Update metadata.json stub if needed**

The crash recovery left `{"database": ""}` — either populate with useful metadata or remove if unused.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: final cleanup for WSL native scanner migration [gt-cm-wsl]"
```
