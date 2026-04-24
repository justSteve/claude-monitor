-- 003-decay-state.sql
-- Decay tier assignments and compression tracking.
-- Part of co-1pc: unified memory search — Phase 4.

CREATE TABLE IF NOT EXISTS memory_decay_state (
    memory_id         TEXT PRIMARY KEY,
    memory_source     TEXT NOT NULL,
    tier              TEXT NOT NULL CHECK(tier IN ('permanent','slow','fast')),
    current_stage     TEXT NOT NULL DEFAULT 'fresh' CHECK(current_stage IN ('fresh','summary','oneliner','archived')),
    original_content  TEXT,
    compressed_content TEXT,
    age_days          INTEGER DEFAULT 0,
    access_count      INTEGER DEFAULT 0,
    effective_age     REAL DEFAULT 0,
    last_decayed_at   TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_decay_tier ON memory_decay_state(tier);
CREATE INDEX IF NOT EXISTS idx_decay_stage ON memory_decay_state(current_stage);
CREATE INDEX IF NOT EXISTS idx_decay_effective_age ON memory_decay_state(effective_age);
