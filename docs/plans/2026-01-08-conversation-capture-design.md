# Conversation Capture Design

**Date**: 2026-01-08
**Status**: Draft
**Purpose**: Extend claude-monitor to capture and store conversation content for review and prompt learning

## Overview

Enhance the existing file monitoring system to capture conversation history from Claude Code sessions. The goal is to make it easier to review past conversations, understand what worked, and learn from errors - particularly around prompt effectiveness.

## Goals

- Store conversation content incrementally (only new entries)
- Extract structured artifacts (code blocks, tool calls, JSON objects)
- Capture full provenance metadata (model, version, git branch, hooks)
- Enable project-grouped browsing of conversation history
- Track config file changes that affect Claude behavior

## Non-Goals

- Real-time streaming of active conversations
- Auditing or compliance logging
- Storing unnecessarily large tool outputs verbatim

## Data Model

### New Tables

#### conversations

One row per detected conversation session.

```sql
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT UNIQUE,         -- UUID from filename or generated
    project_id INTEGER,                  -- FK to existing projects table
    source_file_path TEXT NOT NULL,      -- Original .jsonl or .txt path
    source_file_type TEXT NOT NULL,      -- 'jsonl' or 'txt'
    started_at TEXT,                     -- First message timestamp
    ended_at TEXT,                       -- Last message timestamp
    duration_seconds INTEGER,
    message_count INTEGER DEFAULT 0,
    model_used TEXT,                     -- e.g., 'claude-opus-4-5-20251101'
    claude_code_version TEXT,
    git_branch TEXT,                     -- Branch at conversation start
    working_directory TEXT,
    active_hooks TEXT,                   -- JSON array of hook names
    config_snapshot_ids TEXT,            -- JSON array of config_snapshots IDs
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX idx_conv_project ON conversations(project_id);
CREATE INDEX idx_conv_started ON conversations(started_at);
CREATE INDEX idx_conv_source ON conversations(source_file_path);
```

#### conversation_entries

Individual messages/lines with hash-based deduplication.

```sql
CREATE TABLE IF NOT EXISTS conversation_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,    -- FK to conversations
    entry_hash TEXT NOT NULL,            -- SHA256 of content for dedup
    entry_index INTEGER NOT NULL,        -- Order within conversation
    role TEXT NOT NULL,                  -- 'user', 'assistant', 'system', 'tool'
    content TEXT NOT NULL,               -- The actual message content
    timestamp TEXT,                      -- If parseable from entry
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    UNIQUE(conversation_id, entry_hash)
);

CREATE INDEX idx_entries_conv ON conversation_entries(conversation_id);
CREATE INDEX idx_entries_hash ON conversation_entries(entry_hash);
CREATE INDEX idx_entries_role ON conversation_entries(role);
```

#### artifacts

Extracted structured content from conversations.

```sql
CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,    -- FK to conversations
    entry_id INTEGER,                    -- FK to conversation_entries (source)
    artifact_type TEXT NOT NULL,         -- 'code_block', 'tool_call', 'tool_result', 'json_object'
    language TEXT,                       -- For code blocks: 'python', 'javascript', etc.
    tool_name TEXT,                      -- For tool calls: 'Read', 'Edit', 'Bash', etc.
    content TEXT,                        -- The artifact content
    metadata TEXT,                       -- JSON: file paths, line numbers, parameters
    content_hash TEXT,                   -- For dedup of identical artifacts
    outcome TEXT,                        -- 'success', 'error', 'partial', 'truncated'
    output_summary TEXT,                 -- Always stored: first 500 chars or error message
    output_full TEXT,                    -- Only for errors or small successes (<10KB)
    output_size_bytes INTEGER,           -- Original size before any truncation
    output_truncated INTEGER DEFAULT 0,  -- 1 if full output was too large to store
    error_type TEXT,                     -- 'permission', 'not_found', 'timeout', etc.
    prompt_context TEXT,                 -- 200 chars preceding the tool call
    follow_up_action TEXT,               -- What happened next (retry, different approach, etc.)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (entry_id) REFERENCES conversation_entries(id)
);

CREATE INDEX idx_artifacts_conv ON artifacts(conversation_id);
CREATE INDEX idx_artifacts_type ON artifacts(artifact_type);
CREATE INDEX idx_artifacts_tool ON artifacts(tool_name);
CREATE INDEX idx_artifacts_outcome ON artifacts(outcome);
```

#### conversation_parse_state

Track incremental parsing progress per file.

```sql
CREATE TABLE IF NOT EXISTS conversation_parse_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE NOT NULL,
    last_line_number INTEGER DEFAULT 0,  -- For JSONL: resume point
    last_entry_hash TEXT,                -- Last entry hash processed
    last_parsed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

#### config_snapshots

Extracted metadata from non-conversation files.

```sql
CREATE TABLE IF NOT EXISTS config_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    file_path TEXT NOT NULL,
    file_type TEXT NOT NULL,             -- 'settings', 'hooks', 'claude_md', 'plugin'
    file_hash TEXT NOT NULL,             -- Only re-extract if hash changes
    captured_at TEXT NOT NULL,
    metadata TEXT NOT NULL,              -- JSON: extracted structured data
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    UNIQUE(file_path, file_hash)
);

CREATE INDEX idx_config_project ON config_snapshots(project_id);
CREATE INDEX idx_config_type ON config_snapshots(file_type);
```

### Views

```sql
-- Conversation summary with counts
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

-- Artifacts with conversation context
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
```

## Parsing Logic

### JSONL Processing

Claude Code JSONL files contain one JSON object per line:

```json
{"type":"user","message":{"role":"user","content":"..."},"timestamp":"..."}
{"type":"assistant","message":{"role":"assistant","content":[...]},"toolCalls":[...]}
```

**Extraction steps:**
1. Read file line-by-line from last parsed position
2. Hash each line (SHA256) - skip if hash exists in `conversation_entries`
3. Parse JSON to extract: role, content, timestamp, tool calls
4. For assistant messages, scan content for:
   - Code blocks: regex for fenced code blocks with language
   - JSON objects: detect `{...}` patterns in tool results
5. Extract tool calls into artifacts with `tool_name` and parameters

### TXT Processing

TXT files are human-readable transcripts:

1. Split on role markers (`Human:`, `Assistant:`, `> `)
2. Hash each message block
3. Extract code blocks and structured content same as JSONL

### Config File Extraction

| File Type | Extracted Metadata |
|-----------|-------------------|
| `settings.local.json` | `{ model, permissions: [...], features: {...} }` |
| `plugin.json` | `{ plugins: [{ name, version, enabled }] }` |
| `hooks.md` | `{ hookCount, hooks: ["PreToolUse", ...], sectionHeaders: [...] }` |
| `CLAUDE.md` | `{ lineCount, sectionHeaders: [...], hasCodeBlocks }` |

## Tool Output Storage Strategy

### Tiered Storage Rules

| Scenario | What's Stored |
|----------|---------------|
| **Error** | Full output + error classification |
| **Success ≤10KB** | Full output |
| **Success >10KB** | Summary (first 500 chars) + size + truncated flag |
| **File Read** | Path + size + first 20 lines (for context) |
| **File Write/Edit** | Full content (these are outputs worth keeping) |
| **Bash** | Exit code + stderr always; stdout truncated if large |

### Prompt Learning Context

For each tool call, capture:
- `prompt_context`: 200 chars preceding the tool call (what triggered it)
- `follow_up_action`: What happened next (retry? different approach? success?)

This enables queries like: "Show me failed Edit calls and what I said before them."

## Integration

### Processing Flow

```
File Monitor detects change
    ├── JSONL/TXT file?
    │   └── conversationCollector.processFile()
    │       ├── Hash lines, skip duplicates
    │       ├── Extract entries by role
    │       ├── Parse artifacts (code, tools, JSON)
    │       └── Store with tiered output rules
    │
    └── Config file? (settings, hooks, CLAUDE.md)
        └── configExtractor.processFile()
            ├── Hash file, skip if unchanged
            ├── Parse type-specific metadata
            └── Store structured JSON snapshot
```

### Trigger Strategy

**Debounced processing**: Queue changed files, process after 5 minutes of no changes. The existing 5-minute scan interval naturally provides this debounce.

### Configuration

Extend `config.json`:

```json
{
  "conversationCapture": {
    "enabled": true,
    "filePatterns": ["*.jsonl", "*.txt"],
    "maxOutputSize": 10240,
    "summaryLength": 500,
    "promptContextLength": 200,
    "debounceMinutes": 5
  },
  "configExtraction": {
    "enabled": true,
    "filePatterns": ["settings.local.json", "plugin.json", "hooks.md", "CLAUDE.md"]
  }
}
```

## API Endpoints

### New Endpoints

```
GET  /api/v1/conversations
     ?project_id=X           - Filter by project
     ?since=ISO_DATE         - Conversations after date
     ?has_errors=true        - Only conversations with tool errors
     Response: List with message_count, artifact_count, duration

GET  /api/v1/conversations/:id
     Response: Full conversation with entries + artifacts

GET  /api/v1/conversations/:id/entries
     ?role=user|assistant    - Filter by role
     ?offset=N&limit=M       - Pagination
     Response: Paginated entries

GET  /api/v1/conversations/:id/artifacts
     ?type=code_block|tool_call|tool_result
     ?tool_name=Edit|Bash|Read
     ?outcome=error          - Just failures
     Response: Filtered artifacts

GET  /api/v1/projects/:id/conversations
     Response: All conversations for a project

GET  /api/v1/artifacts/search
     ?q=searchterm           - Full-text search across artifact content
     ?project_id=X           - Scope to project
     Response: Matching artifacts with conversation context

GET  /api/v1/config-snapshots
     ?project_id=X           - Filter by project
     ?file_type=hooks        - Filter by type
     Response: Config snapshots with metadata
```

### Stats Extension

Add to existing `/api/v1/stats`:

```json
{
  "conversations": { "total": 142, "thisWeek": 12 },
  "artifacts": { "codeBlocks": 534, "toolCalls": 2341, "errors": 23 },
  "configSnapshots": { "total": 89 }
}
```

## Frontend

### Conversation Browser View

New tab in existing frontend with three-panel layout:

1. **Left panel**: Project tree with conversation counts
2. **Center panel**: Conversation list with metadata badges (errors, duration, model)
3. **Detail panel**: Tabbed content view
   - Entries tab: Chronological messages
   - Code Blocks tab: Extracted code with language tags
   - Tool Calls tab: Tool invocations with outcomes
   - Errors tab: Failed operations with context

### Key UI Features

- Project grouping as primary navigation
- Error highlighting with red badges
- Filter to show only error conversations
- Expandable tool call details showing parameters and output
- Link from artifact back to conversation context

## Implementation Order

1. **Schema migration** - Add new tables
2. **JSONL parser** - Core extraction logic with hash dedup
3. **Artifact extractor** - Code blocks, tool calls, JSON objects
4. **Config extractor** - Settings/hooks metadata parsing
5. **API endpoints** - CRUD operations for new tables
6. **Frontend** - Conversation browser UI
7. **Integration** - Wire into existing file monitor flow

## Open Questions

- Should we support full-text search with SQLite FTS5?
- Retention policy: auto-delete conversations older than N days?
- Export format: ability to export conversations as markdown?
