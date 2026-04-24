-- 002-memory-metadata.sql
-- Access tracking for memory salience scoring.
-- Part of co-1pc: unified memory search — Phase 3.

CREATE TABLE IF NOT EXISTS access_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id   TEXT NOT NULL,
    accessed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    session_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_memory ON access_log(memory_id);
CREATE INDEX IF NOT EXISTS idx_access_session ON access_log(session_id);
