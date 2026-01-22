#!/usr/bin/env node
/**
 * Backfill Conversations Script
 *
 * Scans ~/.claude/projects/ directories for historical JSONL conversation files
 * and imports them into the claude-monitor database.
 *
 * Usage:
 *   node scripts/backfill-conversations.js [options]
 *
 * Options:
 *   --dry-run      Show what would be imported without making changes
 *   --project=X    Only import from specific project directory
 *   --limit=N      Limit to N files (useful for testing)
 *   --verbose      Show detailed progress
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize database before importing services
import db from '../server/db/index.js';
import conversationParser from '../server/services/conversationParserService.js';

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
    dryRun: args.includes('--dry-run'),
    verbose: args.includes('--verbose'),
    limit: parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0'),
    project: args.find(a => a.startsWith('--project='))?.split('=')[1] || null
};

// Claude Code stores projects in ~/.claude/projects/
const CLAUDE_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/**
 * Find all JSONL files in Claude projects directory
 */
function findConversationFiles() {
    const files = [];

    if (!fs.existsSync(PROJECTS_DIR)) {
        console.error(`Projects directory not found: ${PROJECTS_DIR}`);
        return files;
    }

    const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    for (const projectDir of projectDirs) {
        // Filter by project if specified
        if (options.project && !projectDir.includes(options.project)) {
            continue;
        }

        const projectPath = path.join(PROJECTS_DIR, projectDir);

        try {
            const entries = fs.readdirSync(projectPath, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                    const filePath = path.join(projectPath, entry.name);
                    const stats = fs.statSync(filePath);

                    files.push({
                        path: filePath,
                        projectDir: projectDir,
                        filename: entry.name,
                        size: stats.size,
                        modified: stats.mtime
                    });
                }
            }
        } catch (err) {
            console.error(`Error reading ${projectPath}: ${err.message}`);
        }
    }

    // Sort by modification time (oldest first for chronological import)
    files.sort((a, b) => a.modified - b.modified);

    return files;
}

/**
 * Decode project directory name back to path
 * e.g., "C--myStuff--infra-claude-monitor" -> "C:\myStuff\_infra\claude-monitor"
 */
function decodeProjectPath(dirName) {
    // Claude Code encodes paths by replacing separators
    // This is a best-effort decode
    return dirName
        .replace(/^([A-Za-z])--/, '$1:\\')  // Drive letter
        .replace(/--/g, '\\')                // Double dash = backslash
        .replace(/-/g, '-');                 // Single dash stays as dash (or underscore?)
}

/**
 * Find or create project record in database
 */
function findOrCreateProject(projectDir) {
    const database = db.getDb();

    // Decode the directory name to a path
    const decodedPath = decodeProjectPath(projectDir);

    // Check if project exists
    let project = database.prepare(`
        SELECT * FROM projects WHERE path LIKE ?
    `).get(`%${decodedPath.split('\\').pop()}%`);

    if (!project) {
        // Try exact path match
        project = database.prepare(`
            SELECT * FROM projects WHERE path = ?
        `).get(decodedPath);
    }

    if (!project) {
        // Create new project record
        const name = decodedPath.split(/[/\\]/).pop() || projectDir;
        const now = new Date().toISOString();

        try {
            database.prepare(`
                INSERT INTO projects (path, name, root, has_claude_folder, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, 1, ?, ?)
            `).run(decodedPath, name, decodedPath, now, now);

            project = database.prepare(`
                SELECT * FROM projects WHERE path = ?
            `).get(decodedPath);

            if (options.verbose) {
                console.log(`  Created project: ${name}`);
            }
        } catch (err) {
            // May fail on unique constraint - that's ok
            if (options.verbose) {
                console.log(`  Could not create project (may already exist): ${err.message}`);
            }
        }
    }

    return project?.id || null;
}

/**
 * Format bytes as human-readable
 */
function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format duration in ms as human-readable
 */
function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Main backfill function
 */
async function backfill() {
    console.log('='.repeat(60));
    console.log('Conversation Backfill Script');
    console.log('='.repeat(60));
    console.log();

    if (options.dryRun) {
        console.log('DRY RUN MODE - No changes will be made\n');
    }

    // Find all conversation files
    console.log(`Scanning ${PROJECTS_DIR}...`);
    const files = findConversationFiles();

    if (files.length === 0) {
        console.log('No JSONL conversation files found.');
        return;
    }

    // Apply limit if specified
    const filesToProcess = options.limit > 0 ? files.slice(0, options.limit) : files;

    // Group by project for summary
    const byProject = {};
    for (const file of files) {
        byProject[file.projectDir] = byProject[file.projectDir] || [];
        byProject[file.projectDir].push(file);
    }

    console.log(`\nFound ${files.length} conversation files across ${Object.keys(byProject).length} projects`);
    console.log(`Total size: ${formatBytes(files.reduce((sum, f) => sum + f.size, 0))}`);
    console.log(`Date range: ${files[0]?.modified.toISOString().split('T')[0]} to ${files[files.length - 1]?.modified.toISOString().split('T')[0]}`);

    if (options.limit > 0) {
        console.log(`\nLimited to ${options.limit} files for this run`);
    }

    console.log('\nProjects:');
    for (const [proj, projFiles] of Object.entries(byProject)) {
        console.log(`  ${proj}: ${projFiles.length} files (${formatBytes(projFiles.reduce((s, f) => s + f.size, 0))})`);
    }

    if (options.dryRun) {
        console.log('\n[DRY RUN] Would import the above files. Run without --dry-run to proceed.');
        return;
    }

    // Process files
    console.log('\n' + '-'.repeat(60));
    console.log('Importing conversations...\n');

    const startTime = Date.now();
    const results = {
        processed: 0,
        newConversations: 0,
        newEntries: 0,
        skipped: 0,
        errors: 0
    };

    for (let i = 0; i < filesToProcess.length; i++) {
        const file = filesToProcess[i];
        const progress = `[${i + 1}/${filesToProcess.length}]`;

        if (options.verbose) {
            console.log(`${progress} Processing: ${file.filename}`);
            console.log(`         Project: ${file.projectDir}`);
            console.log(`         Size: ${formatBytes(file.size)}`);
        } else {
            // Show progress on single line
            process.stdout.write(`\r${progress} ${file.projectDir}/${file.filename}`.padEnd(80));
        }

        try {
            // Find or create project
            const projectId = findOrCreateProject(file.projectDir);

            // Parse the file
            const result = conversationParser.parseJSONL(file.path, projectId);

            if (result.success) {
                results.processed++;
                results.newEntries += result.newEntries || 0;
                results.skipped += result.skipped || 0;

                if (result.newEntries > 0) {
                    results.newConversations++;
                }

                if (options.verbose) {
                    console.log(`         Result: ${result.newEntries} new entries, ${result.skipped} duplicates`);
                    console.log();
                }
            } else {
                results.errors++;
                if (options.verbose) {
                    console.log(`         ERROR: ${result.error}`);
                    console.log();
                }
            }
        } catch (err) {
            results.errors++;
            if (options.verbose) {
                console.log(`         ERROR: ${err.message}`);
                console.log();
            }
        }
    }

    const elapsed = Date.now() - startTime;

    // Summary
    console.log('\n\n' + '='.repeat(60));
    console.log('Backfill Complete');
    console.log('='.repeat(60));
    console.log(`Duration: ${formatDuration(elapsed)}`);
    console.log(`Files processed: ${results.processed}`);
    console.log(`New conversations: ${results.newConversations}`);
    console.log(`New entries imported: ${results.newEntries}`);
    console.log(`Duplicate entries skipped: ${results.skipped}`);
    console.log(`Errors: ${results.errors}`);
    console.log();
}

// Run
backfill().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
