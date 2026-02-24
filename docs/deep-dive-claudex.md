# Deep Dive: Claudex

Research date: 2026-02-24
Repo: [kunwar-shah/claudex](https://github.com/kunwar-shah/claudex)
Stars: 46 | Language: JavaScript (React + Fastify) | License: MIT

## Summary

Full-stack web app most architecturally similar to claude-monitor: Fastify backend + SQLite FTS5 + React dashboard + MCP server. Features session metadata, structured memory, Zod validation, and multi-version JSONL parsing.

## Server Architecture

**Entry**: `server/src/server.js` (Fastify)

### Route Organization
| Module | Endpoints |
|--------|-----------|
| `projectRoutes` | `GET /api/projects`, `/projects/:id/sessions`, `/projects/:id/sessions/:sid`, `/projects/:id/token-stats` |
| `searchRoutes` | `POST /api/search`, `POST /api/search/index/build`, `GET /api/search/index/status` |
| `exportRoutes` | Session export to JSON/HTML/TXT |
| `sessionMetadataRoutes` | Custom titles, tags, visibility, notes |

### Performance Config
```javascript
PRAGMA journal_mode = WAL           // Write-Ahead Logging
PRAGMA synchronous = NORMAL
PRAGMA cache_size = 10000           // 10MB
PRAGMA temp_store = MEMORY
PRAGMA mmap_size = 30000000000      // 30GB memory-mapped I/O
PRAGMA busy_timeout = 5000          // For MCP concurrent reads
```

## SQLite FTS5 Search

**Primary table** (`messages_fts`):
```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  project_id, project_name, session_id, session_title,
  message_id, role, content, timestamp, file_path,
  line_number, template
)
```

**Query features**:
- BM25 ranking: `bm25(messages_fts)` for relevance
- Snippeting: `snippet(messages_fts, 6, '<mark>', '</mark>', '...', 64)`
- Filtering: project, role, date range
- Custom `escapeFTS5Query()` for reserved terms

**Batch indexing**: 500-1000 messages per INSERT, wrapped in single transaction.

## MCP Server

**Entry**: `bin/claudex-mcp.js` (stdio transport)

### 10 Tools
| Category | Tool | Purpose |
|----------|------|---------|
| Context | `get_project_context` | Condensed snapshot (3 detail levels: ~500/1500/3000 tokens) |
| Context | `list_projects` | All projects, current highlighted |
| Context | `list_sessions` | Paginated with sorting |
| Search | `search_conversations` | FTS5 across project or all |
| Search | `get_session` | Full conversation with pagination |
| Search | `get_session_summary` | Metadata only (cheap) |
| Memory | `store_memory` | Create/update with priority, confidence, TTL |
| Memory | `recall_memory` | Retrieve with filters |
| Memory | `list_memories` | All memories with stats |
| Memory | `delete_memory` | Remove by namespace/type/key |

### 2 Resources
- `claudex://projects` — All projects (static)
- `claudex://projects/{projectId}/recent` — Last 10 sessions (dynamic)

### 3 Prompts (slash commands)
- `/recall <topic>` — Search history
- `/catchup` — Summarize recent work
- `/history [count]` — List sessions

### Auto-Detection
```javascript
function detectCurrentProjectId() {
  const cwd = process.cwd()
  return cwd.replace(/\//g, '-')  // Claude Code spawns MCP from project dir
}
```

## JSONL Template System

**Waterfall detection** (newest first):
1. Claude Code V3 (universal, newest) — handles `role` field directly
2. Claude Code V2-Mixed — summary-only with `leafUuid`
3. Claude Code V1 — standard `uuid`, `sessionId`, `type`, `timestamp`
4. Generic fallback

**Zod validation schemas** per template with:
- Per-message validation
- Batch validation with stats
- `safeParse()` that tries all templates
- Breaking change detection with logging

**Normalized output**:
```javascript
{
  id: string,
  role: 'user' | 'assistant',
  content: string,
  contentKind: 'text' | 'markdown' | 'diff' | 'json',
  timestamp: ISO8601,
  toolsUsed: [{ id, name, details, type }],
  actions: [string],       // Human-readable descriptions
  metadata: Object,        // Template-specific
  raw: Object              // Original JSONL
}
```

## Memory Service

**Schema** (`project_memories`):
```sql
CREATE TABLE project_memories (
  id INTEGER PRIMARY KEY,
  project_id, namespace, memory_type, key,
  value JSON, metadata JSON,
  priority INTEGER (1-10),
  confidence REAL (0.0-1.0),
  ttl_hours INTEGER, expires_at DATETIME,
  created_at, updated_at DATETIME,
  UNIQUE(project_id, namespace, memory_type, key)
)
```

Recommended types: `map`, `convention`, `decision`, `snapshot`, `dependency`, `error_pattern`

## Key Design Patterns

1. **Non-destructive**: Never modifies original JSONL. Custom metadata in separate tables.
2. **Dual API surface**: REST (for UI) + MCP (for Claude), shared SQLite via WAL mode.
3. **Template detection as first-class**: Waterfall strategy with Zod validation.
4. **Streaming parse**: Line-by-line for large JSONL, batch inserts for indexing.
5. **Lazy init**: MCP services created on-demand, not at startup.
6. **TTL caching**: Simple in-memory cache (5-min TTL) for expensive token stats.

## Patterns to Adopt in claude-monitor

### High Priority
1. **FTS5 schema** — their `messages_fts` table is battle-tested, adopt as-is
2. **WAL + busy_timeout** — enables concurrent REST + MCP access to same DB
3. **MCP tool design** — auto-detect project from CWD, default to current, allow override
4. **Template detection waterfall** — handle V1/V2/V3 JSONL formats gracefully
5. **Batch indexing in transactions** — 500-1000 per INSERT, single COMMIT

### Medium Priority
6. **Structured memory service** — priority + confidence + TTL is a clean model
7. **MCP prompts** — `/recall`, `/catchup`, `/history` as slash commands
8. **MCP resources** — expose projects and recent sessions as resources
9. **Zod validation** — catch JSONL format changes early

### Reference Only
10. **React dashboard patterns** — we have our own viewer.html approach
11. **Export formats** — we generate HTML differently
