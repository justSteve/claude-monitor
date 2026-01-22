-- ============================================================
-- Claude Monitor Database Schema
-- ============================================================

-- Projects table: tracks all discovered projects
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    container TEXT,
    root TEXT NOT NULL,
    has_claude_folder INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tracked files table: all files ever seen in .claude folders
CREATE TABLE IF NOT EXISTS tracked_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    project_id INTEGER,
    filename TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    current_size_bytes INTEGER,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- Scans table: one row per execution of the monitor
CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_time TEXT NOT NULL,
    scan_time_iso TEXT NOT NULL,
    scan_duration_ms INTEGER NOT NULL,
    projects_scanned INTEGER NOT NULL,
    projects_missing_claude INTEGER NOT NULL,
    files_no_change INTEGER NOT NULL,
    files_with_change INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- File changes table: one row per file change event per scan
CREATE TABLE IF NOT EXISTS file_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL,
    tracked_file_id INTEGER,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    delta_size_bytes INTEGER,
    status TEXT NOT NULL CHECK (status IN ('NEW', 'MODIFIED', 'DELETED')),
    attributes TEXT,
    last_modified TEXT NOT NULL,
    last_modified_iso TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (scan_id) REFERENCES scans(id),
    FOREIGN KEY (tracked_file_id) REFERENCES tracked_files(id)
);

-- Beads filed table: tracks beads created for missing .claude folders
CREATE TABLE IF NOT EXISTS beads_filed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL UNIQUE,
    bead_id TEXT NOT NULL,
    filed_at TEXT NOT NULL,
    filed_at_iso TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- CONVERSATION CAPTURE TABLES
-- ============================================================

-- Conversations: one row per detected conversation session
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT UNIQUE,
    project_id INTEGER,
    source_file_path TEXT NOT NULL,
    source_file_type TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    duration_seconds INTEGER,
    message_count INTEGER DEFAULT 0,
    model_used TEXT,
    claude_code_version TEXT,
    git_branch TEXT,
    working_directory TEXT,
    active_hooks TEXT,
    config_snapshot_ids TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- Conversation entries: individual messages with hash-based deduplication
CREATE TABLE IF NOT EXISTS conversation_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    entry_hash TEXT NOT NULL,
    entry_index INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    UNIQUE(conversation_id, entry_hash)
);

-- Artifacts: extracted structured content from conversations
CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    entry_id INTEGER,
    artifact_type TEXT NOT NULL,
    language TEXT,
    tool_name TEXT,
    content TEXT,
    metadata TEXT,
    content_hash TEXT,
    outcome TEXT,
    output_summary TEXT,
    output_full TEXT,
    output_size_bytes INTEGER,
    output_truncated INTEGER DEFAULT 0,
    error_type TEXT,
    prompt_context TEXT,
    follow_up_action TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (entry_id) REFERENCES conversation_entries(id)
);

-- Conversation parse state: track incremental parsing progress
CREATE TABLE IF NOT EXISTS conversation_parse_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE NOT NULL,
    last_line_number INTEGER DEFAULT 0,
    last_entry_hash TEXT,
    last_parsed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Config snapshots: extracted metadata from non-conversation files
CREATE TABLE IF NOT EXISTS config_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    file_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    UNIQUE(file_path, file_hash)
);

-- ============================================================
-- INDEXES for common queries
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_scans_scan_time_iso ON scans(scan_time_iso);
CREATE INDEX IF NOT EXISTS idx_file_changes_scan_id ON file_changes(scan_id);
CREATE INDEX IF NOT EXISTS idx_file_changes_status ON file_changes(status);
CREATE INDEX IF NOT EXISTS idx_file_changes_tracked_file_id ON file_changes(tracked_file_id);
CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes(path);
CREATE INDEX IF NOT EXISTS idx_tracked_files_project_id ON tracked_files(project_id);
CREATE INDEX IF NOT EXISTS idx_tracked_files_is_deleted ON tracked_files(is_deleted);
CREATE INDEX IF NOT EXISTS idx_projects_root ON projects(root);
CREATE INDEX IF NOT EXISTS idx_projects_has_claude ON projects(has_claude_folder);

-- Conversation capture indexes
CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_conv_started ON conversations(started_at);
CREATE INDEX IF NOT EXISTS idx_conv_source ON conversations(source_file_path);
CREATE INDEX IF NOT EXISTS idx_entries_conv ON conversation_entries(conversation_id);
CREATE INDEX IF NOT EXISTS idx_entries_hash ON conversation_entries(entry_hash);
CREATE INDEX IF NOT EXISTS idx_entries_role ON conversation_entries(role);
CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts(conversation_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(artifact_type);
CREATE INDEX IF NOT EXISTS idx_artifacts_tool ON artifacts(tool_name);
CREATE INDEX IF NOT EXISTS idx_artifacts_outcome ON artifacts(outcome);
CREATE INDEX IF NOT EXISTS idx_config_project ON config_snapshots(project_id);
CREATE INDEX IF NOT EXISTS idx_config_type ON config_snapshots(file_type);

-- ============================================================
-- VIEWS for common queries
-- ============================================================

CREATE VIEW IF NOT EXISTS v_scans_summary AS
SELECT
    s.id,
    s.scan_time,
    s.scan_time_iso,
    s.scan_duration_ms,
    s.projects_scanned,
    s.projects_missing_claude,
    s.files_no_change,
    s.files_with_change,
    COUNT(CASE WHEN fc.status = 'NEW' THEN 1 END) AS new_count,
    COUNT(CASE WHEN fc.status = 'MODIFIED' THEN 1 END) AS modified_count,
    COUNT(CASE WHEN fc.status = 'DELETED' THEN 1 END) AS deleted_count
FROM scans s
LEFT JOIN file_changes fc ON fc.scan_id = s.id
GROUP BY s.id;

CREATE VIEW IF NOT EXISTS v_file_history AS
SELECT
    tf.id AS tracked_file_id,
    tf.path,
    tf.filename,
    tf.project_id,
    p.name AS project_name,
    fc.scan_id,
    s.scan_time,
    s.scan_time_iso,
    fc.status,
    fc.size_bytes,
    fc.delta_size_bytes,
    fc.attributes,
    fc.last_modified
FROM tracked_files tf
LEFT JOIN file_changes fc ON fc.tracked_file_id = tf.id
LEFT JOIN scans s ON s.id = fc.scan_id
LEFT JOIN projects p ON p.id = tf.project_id;

-- Conversation summary view with counts
CREATE VIEW IF NOT EXISTS v_conversations_summary AS
SELECT
    c.id,
    c.conversation_id,
    c.project_id,
    p.name AS project_name,
    c.source_file_type,
    c.started_at,
    c.ended_at,
    c.duration_seconds,
    c.message_count,
    c.model_used,
    c.git_branch,
    COUNT(DISTINCT a.id) AS artifact_count,
    COUNT(CASE WHEN a.outcome = 'error' THEN 1 END) AS error_count
FROM conversations c
LEFT JOIN projects p ON p.id = c.project_id
LEFT JOIN artifacts a ON a.conversation_id = c.id
GROUP BY c.id;

-- Artifacts with conversation context view
CREATE VIEW IF NOT EXISTS v_artifacts_with_context AS
SELECT
    a.*,
    c.project_id,
    p.name AS project_name,
    c.started_at AS conversation_started,
    c.model_used
FROM artifacts a
JOIN conversations c ON c.id = a.conversation_id
LEFT JOIN projects p ON p.id = c.project_id;
