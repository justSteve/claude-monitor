/**
 * Database migration runner
 *
 * Usage: npm run migrate
 */

const db = require('../server/db');

console.log('Running database migrations...');

try {
    // Initialize database (creates tables from schema.sql)
    db.init();
    console.log('Database schema initialized successfully.');

    // Show table info
    const database = db.getDb();
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
