import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
import config from '../config.js';

let db = null;

/**
 * Wraps Bun's SQLite Database to provide better-sqlite3 compatible API
 * Maps: db.prepare(sql) -> db.query(sql) with same .all()/.get()/.run() interface
 */
function wrapDatabase(bunDb) {
    return {
        prepare(sql) {
            return bunDb.query(sql);
        },
        exec(sql) {
            return bunDb.exec(sql);
        },
        pragma(pragma) {
            // Convert better-sqlite3 pragma format to SQL
            return bunDb.exec(`PRAGMA ${pragma}`);
        },
        transaction(fn) {
            return bunDb.transaction(fn);
        },
        close() {
            return bunDb.close();
        }
    };
}

/**
 * Initialize database connection
 */
function init() {
    if (db) return db;

    // Ensure db directory exists
    const dbDir = path.dirname(config.dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    const bunDb = new Database(config.dbPath);
    db = wrapDatabase(bunDb);

    // Enable WAL mode for better concurrent read performance
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Run schema
    const schemaPath = path.join(import.meta.dir, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schema);

    console.log(`Database initialized at ${config.dbPath}`);
    return db;
}

/**
 * Get database instance
 */
function getDb() {
    if (!db) {
        return init();
    }
    return db;
}

/**
 * Close database connection
 */
function close() {
    if (db) {
        db.close();
        db = null;
        console.log('Database connection closed');
    }
}

/**
 * Transaction wrapper
 */
function transaction(fn) {
    const database = getDb();
    return database.transaction(fn)();
}

export {
    init,
    getDb,
    close,
    transaction
};

export default {
    init,
    getDb,
    close,
    transaction
};
