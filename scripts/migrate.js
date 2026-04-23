/**
 * Database migration runner
 *
 * Usage: npm run migrate
 *
 * Runs schema.sql via db.init(), then applies numbered migrations
 * from server/db/migrations/ in alphabetical order. Each migration
 * is recorded in a `migrations` table and only applied once.
 */

import db from '../server/db/index.js';
import fs from 'fs';
import path from 'path';

console.log('Running database migrations...');

try {
    // Initialize database (creates tables from schema.sql)
    db.init();
    console.log('Database schema initialized successfully.');

    // --- Numbered migration support ---
    const database = db.getDb();

    // Ensure migrations tracking table exists
    database.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
            name       TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )
    `);

    // Read all .sql files from server/db/migrations/ sorted alphabetically
    const migrationsDir = path.join(import.meta.dir, '..', 'server', 'db', 'migrations');
    let migrationFiles = [];
    if (fs.existsSync(migrationsDir)) {
        migrationFiles = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.sql'))
            .sort();
    }

    // Apply each migration not yet recorded
    let applied = 0;
    for (const file of migrationFiles) {
        const existing = database.prepare('SELECT name FROM migrations WHERE name = ?').get(file);
        if (existing) {
            console.log(`  Skipping migration: ${file} (already applied)`);
            continue;
        }

        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        database.exec(sql);
        database.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
        console.log(`  Applied migration: ${file}`);
        applied++;
    }

    if (applied === 0 && migrationFiles.length > 0) {
        console.log('  All migrations already applied.');
    } else if (migrationFiles.length === 0) {
        console.log('  No migration files found.');
    }

    // Show table info
    const tables = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
    `).all();

    console.log('\nTables created:');
    for (const table of tables) {
        const count = database.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
        console.log(`  - ${table.name}: ${count.count} row(s)`);
    }

    const views = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='view'
        ORDER BY name
    `).all();

    if (views.length > 0) {
        console.log('\nViews created:');
        for (const view of views) {
            console.log(`  - ${view.name}`);
        }
    }

    db.close();
    console.log('\nMigration complete.');
} catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
}
