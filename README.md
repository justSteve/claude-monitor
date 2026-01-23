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

Edit `config.json`:

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

## Project Structure

```
├── Monitor-ClaudeFiles.ps1  # Windows file scanner
├── config.json              # Scan configuration
├── server/                  # Node.js API server
│   ├── routes/              # REST endpoints
│   ├── services/            # Business logic
│   └── db/                  # SQLite + migrations
├── public/                  # Static web assets
├── viewer.html              # Standalone log viewer
├── logs/                    # Daily JSON logs (gitignored)
└── docs/                    # Extended documentation
    ├── specification.md     # Full technical spec
    └── plans/               # Design documents
```

## Documentation

- [Full Specification](docs/specification.md) - Complete technical details
- [Conversation Capture Design](docs/plans/2026-01-08-conversation-capture-design.md) - Planned conversation storage
- [Multi-Agent Workflow](docs/plans/2026-01-08-multi-agent-workflow-guide.md) - Agent collaboration patterns

## Files

- `config.json` — scan roots and settings
- `state.json` — runtime state (gitignored)
- `logs/` — daily JSON logs (gitignored)
