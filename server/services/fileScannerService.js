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
