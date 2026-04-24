-- 004-promotion.sql
-- Promotion candidates table for 3-strike pattern detection.
-- Part of co-1pc: unified memory search — Phase 5.

CREATE TABLE IF NOT EXISTS promotion_candidates (
    id            TEXT PRIMARY KEY,
    pattern       TEXT NOT NULL,
    category      TEXT NOT NULL CHECK(category IN ('preference','convention','antipattern','tooling')),
    strikes       INTEGER DEFAULT 1,
    session_refs  TEXT NOT NULL DEFAULT '[]',
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    status        TEXT DEFAULT 'watching' CHECK(status IN ('watching','proposed','accepted','dismissed')),
    proposed_rule TEXT
);

CREATE INDEX IF NOT EXISTS idx_promotion_status ON promotion_candidates(status);
CREATE INDEX IF NOT EXISTS idx_promotion_pattern ON promotion_candidates(pattern);
CREATE INDEX IF NOT EXISTS idx_promotion_category ON promotion_candidates(category);
