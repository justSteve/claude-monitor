CREATE TABLE IF NOT EXISTS entities (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK(type IN ('zgent','convention','person','tool','concept','inferred')),
    source      TEXT NOT NULL CHECK(source IN ('ecc','nlp')),
    confidence  REAL NOT NULL DEFAULT 0.5,
    aliases     TEXT DEFAULT '[]',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS entity_links (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    memory_id     TEXT NOT NULL,
    memory_source TEXT NOT NULL CHECK(memory_source IN ('transcript','mempalace')),
    co_occurrence INTEGER DEFAULT 1,
    last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS entity_relations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    from_entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    to_entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relation        TEXT NOT NULL CHECK(relation IN ('serves','owns','uses','mentions')),
    source          TEXT NOT NULL CHECK(source IN ('ecc','inferred')),
    strength        REAL DEFAULT 0.5
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entity_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entity_source ON entities(source);
CREATE INDEX IF NOT EXISTS idx_entity_links_entity ON entity_links(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_memory ON entity_links(memory_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_relations_pair ON entity_relations(from_entity_id, to_entity_id, relation);
