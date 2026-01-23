# Claude Context File Monitor

Tracks file changes in `.claude` folders across configured directories. Includes a PowerShell scanner (Windows Task Scheduler), Node.js/Bun API server, and web dashboard.

## QuickStart

**Prerequisites:** Windows 10/11, PowerShell 5.1+, Node.js 18+ or Bun

```powershell
# 1. Clone and configure
git clone https://github.com/justSteve/claude-monitor.git
cd claude-monitor
# Edit config.json to set your scan roots

# 2. Start the file monitor (runs every 5 minutes)
.\Monitor-ClaudeFiles.ps1 -Register

# 3. Start the API server
npm install   # or: bun install
npm start     # or: bun run start

# 4. Open dashboard
# Navigate to http://localhost:3000
```

That's it. The monitor scans your `.claude` folders every 5 minutes and the dashboard shows scan history and file changes.

## Architecture

```
┌──────────────────────┐     ┌─────────────────┐     ┌────────────────┐
│ PowerShell Monitor   │────▶│ Node.js Server  │────▶│ Web Dashboard  │
│ (Task Scheduler)     │     │ (REST API)      │     │ (viewer.html)  │
└──────────────────────┘     └─────────────────┘     └────────────────┘
         │                           │
         ▼                           ▼
    logs/*.json                 SQLite DB
```

## Web Dashboard

The dashboard provides two views at `http://localhost:3000`:

### File Changes View (`/`)
- Timeline of file change events
- Date picker with navigation
- Auto-refresh with configurable intervals (5s, 10s, 30s, 60s)
- Stats panel: scan count, projects, changes, files tracked

### Conversations View (`/conversations.html`)
- Browse Claude Code conversation transcripts
- Three-panel layout: conversation list, detail view, artifact inspector
- Filter by errors only
- View extracted artifacts (code blocks, tool calls, JSON objects)

## REST API

Base URL: `http://localhost:3000/api/v1`

### Scans
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/scans` | List scans (paginated, filterable by date/hasChanges) |
| `GET` | `/scans/:id` | Get scan with file changes |
| `GET` | `/scans/by-date/:date` | Get all scans for a date |
| `POST` | `/scans` | Submit scan result (used by PowerShell) |

### Files
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/files` | List tracked files |
| `GET` | `/files/search?q=` | Search files by path |
| `GET` | `/files/:id` | Get file details |
| `GET` | `/files/:id/history` | Get file change history |

### Conversations
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/conversations` | List conversations (filter by project, errors) |
| `GET` | `/conversations/:id` | Get conversation metadata |
| `GET` | `/conversations/:id/entries` | Get messages (filter by role) |
| `GET` | `/conversations/:id/artifacts` | Get extracted artifacts |
| `GET` | `/conversations/:id/stats` | Get artifact statistics |
| `POST` | `/conversations/:id/extract` | Trigger artifact extraction |

### Artifacts
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/artifacts/search?q=` | Search artifacts across conversations |
| `GET` | `/artifacts/stats` | Global artifact statistics |

### Statistics
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/stats?period=` | Aggregate stats (day/week/month/all) |
| `GET` | `/stats/trends?days=&granularity=` | Change trends over time |
| `GET` | `/stats/recent?hours=` | Recent activity summary |

### System
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check with scheduler status |

## Database

SQLite database at `server/db/claude_monitor.db` with these tables:

| Table | Purpose |
|-------|---------|
| `projects` | Discovered projects with `.claude` folders |
| `tracked_files` | All files ever seen in `.claude` folders |
| `scans` | One row per monitor execution |
| `file_changes` | File change events per scan |
| `conversations` | Parsed conversation sessions |
| `conversation_entries` | Individual messages (hash-deduplicated) |
| `artifacts` | Extracted code blocks, tool calls, JSON |
| `config_snapshots` | Captured config file metadata |

Views: `v_scans_summary`, `v_file_history`, `v_conversations_summary`, `v_artifacts_with_context`

## Usage

### PowerShell Monitor

| Command | Description |
|---------|-------------|
| `.\Monitor-ClaudeFiles.ps1` | Run scan manually |
| `.\Monitor-ClaudeFiles.ps1 -Register` | Install scheduled task |
| `.\Monitor-ClaudeFiles.ps1 -Unregister` | Remove scheduled task |
| `.\Monitor-ClaudeFiles.ps1 -Status` | Check task status |

### API Server

| Command | Description |
|---------|-------------|
| `npm start` | Start server on port 3000 |
| `npm run migrate` | Run database migrations |

## Configuration

### PowerShell Scanner (`config.json`)

```json
{
  "roots": [
    "C:\\Users\\YourName\\.claude",
    "C:\\Projects"
  ],
  "logDirectory": "./logs",
  "stateFile": "./state.json",
  "timezone": "Central Standard Time"
}
```

### Server (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `HOST` | localhost | Server host |
| `DB_PATH` | `./db/claude_monitor.db` | SQLite database path |
| `LOG_DIR` | `./logs/server` | Server log directory |
| `LOG_LEVEL` | info | Log level |
| `SCAN_INTERVAL_MS` | 300000 | Scheduler interval (5 min) |
| `AUTO_START_SCHEDULER` | true | Auto-start built-in scheduler |
| `SKIP_EMPTY_SCANS` | true | Don't store zero-change scans |

## Project Structure

```
├── Monitor-ClaudeFiles.ps1  # Windows file scanner
├── config.json              # Scan configuration
├── server/                  # Node.js API server
│   ├── index.js             # Express app entry point
│   ├── config.js            # Server configuration
│   ├── routes/              # REST API endpoints
│   ├── services/            # Business logic
│   ├── middleware/          # Error handling
│   └── db/                  # SQLite schema + connection
├── public/                  # Web dashboard
│   ├── index.html           # File changes view
│   ├── conversations.html   # Transcript viewer
│   ├── css/                 # Stylesheets
│   └── js/                  # Frontend JavaScript
├── viewer.html              # Standalone JSON log viewer
├── logs/                    # Daily JSON logs (gitignored)
└── docs/                    # Extended documentation
    ├── specification.md     # Full technical spec
    └── plans/               # Design documents
```

## Documentation

- [Full Specification](docs/specification.md) - Complete technical details
- [Conversation Capture Design](docs/plans/2026-01-08-conversation-capture-design.md) - Conversation storage design
- [Multi-Agent Workflow](docs/plans/2026-01-08-multi-agent-workflow-guide.md) - Agent collaboration patterns
