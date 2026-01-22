# CLAUDE.md

I will ensure that I adhere to beads patterns and practices.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Context File Monitor is a multi-tier web application that tracks file changes in `.claude` folders across configured directories. It consists of a Node.js/Express API server with SQLite storage, a PowerShell collector that runs every 5 minutes, and a modern web frontend.

## Technology Stack

- **Backend**: Node.js 18+, Express 4.x, better-sqlite3
- **Frontend**: Vanilla JavaScript (ES modules), no framework
- **Collector**: PowerShell 5.1+ (Windows native)
- **Database**: SQLite with WAL mode
- **Scheduling**: Windows Task Scheduler
- **Target Platform**: Windows 10/11

## Architecture

```
[PowerShell Collector] --POST--> [Express API :3000] ---> [SQLite DB]
                                         |
[Browser] <---polling--- [Static Frontend] <--GET-- [Express API]
```

### Execution Flow
```
PowerShell: Scan files -> Build result -> POST to API (or fallback to JSON)
API: Validate -> Store in SQLite -> Return scan ID
Frontend: Poll API -> Render timeline -> Display stats
```

## Commands

### Development
```powershell
npm install              # Install dependencies
npm run migrate          # Create/update database schema
npm run import-logs      # Import existing JSON logs to SQLite
npm start                # Start API server (includes scheduler)
npm run dev              # Start with auto-reload (Node 18+)
```

### Server Management
```powershell
.\scripts\register-server.ps1          # Register server to start at boot
.\scripts\register-server.ps1 -Status  # Check server status
.\scripts\register-server.ps1 -Unregister  # Remove startup task
```

### Scheduler Control (via API)
```powershell
# Check scheduler status
Invoke-RestMethod http://localhost:3000/api/v1/scheduler/status

# Manual scan trigger
Invoke-RestMethod -Method POST http://localhost:3000/api/v1/scheduler/run

# Stop/start scheduler
Invoke-RestMethod -Method POST http://localhost:3000/api/v1/scheduler/stop
Invoke-RestMethod -Method POST http://localhost:3000/api/v1/scheduler/start
```

### PowerShell Collector (legacy)
```powershell
.\Monitor-ClaudeFiles.ps1              # Run scan (submits to API)
.\Monitor-ClaudeFiles.ps1 -Register    # Create 5-minute scheduled task
.\Monitor-ClaudeFiles.ps1 -Unregister  # Remove scheduled task
.\Monitor-ClaudeFiles.ps1 -Status      # Show task status
```

### Web Viewer
Open http://localhost:3000 in browser (server must be running)

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v1/scans` | Submit new scan (PowerShell) |
| GET | `/api/v1/scans` | List scans (paginated) |
| GET | `/api/v1/scans/:id` | Single scan with file changes |
| GET | `/api/v1/scans/by-date/:date` | Scans for specific day |
| GET | `/api/v1/files` | List tracked files |
| GET | `/api/v1/files/:id/history` | File change history |
| GET | `/api/v1/stats` | Aggregate statistics |
| GET | `/api/v1/health` | Health check |

## Project Structure

```
claude-monitor/
├── Monitor-ClaudeFiles.ps1   # PowerShell collector
├── config.json               # Configuration (API URL, roots)
├── package.json              # Node.js dependencies
├── server/                   # Express API
│   ├── index.js              # App entry point
│   ├── config.js             # Server configuration
│   ├── db/                   # Database layer
│   │   ├── index.js          # SQLite connection
│   │   └── schema.sql        # Database schema
│   ├── routes/               # API routes
│   ├── services/             # Business logic
│   └── middleware/           # Express middleware
├── public/                   # Web frontend
│   ├── index.html            # Main page
│   ├── css/styles.css        # Styles
│   └── js/                   # ES modules
├── scripts/                  # Utility scripts
│   ├── migrate.js            # Database migrations
│   ├── import-json-logs.js   # JSON to SQLite import
│   └── register-server.ps1   # Windows startup task
├── db/                       # SQLite database (gitignored)
└── logs/                     # JSON logs (gitignored, fallback)
```

## Configuration

### config.json
```json
{
  "roots": ["C:\\Users\\Steve\\.claude", "C:\\MyStuff"],
  "apiUrl": "http://localhost:3000/api/v1",
  "apiEnabled": true,
  "fallbackToJson": true
}
```

- `apiEnabled`: When true, PowerShell submits to API
- `fallbackToJson`: When true, writes JSON if API unavailable

## Database Schema

**Core Tables:**
- `scans`: One row per monitor execution
- `file_changes`: File changes detected per scan
- `tracked_files`: All files ever seen
- `projects`: Discovered project folders

**Views:**
- `v_scans_summary`: Scans with change counts
- `v_file_history`: File changes with scan context

## Key Files

| File | Purpose | Git Status |
|------|---------|------------|
| `Monitor-ClaudeFiles.ps1` | PowerShell collector | Tracked |
| `config.json` | Configuration | Tracked |
| `server/` | Express API | Tracked |
| `public/` | Web frontend | Tracked |
| `db/claude_monitor.db` | SQLite database | Ignored |
| `state.json` | PowerShell state | Ignored |
| `logs/*.json` | JSON fallback logs | Ignored |

## Scheduler & Logging

### Built-in Scheduler
The server includes a built-in scheduler that runs file monitoring every 5 minutes:
- Auto-starts when server starts (configurable via `AUTO_START_SCHEDULER=false`)
- Runs the PowerShell collector script
- Tracks run count, error count, last run time, next run time
- Available via `/api/v1/scheduler/status` endpoint

### Logging
- **File logs**: `logs/server/server-YYYY-MM-DD.log` (rotates daily, keeps 7 days)
- **Windows Event Log**: Important events logged to Application log (source: ClaudeMonitor)
- **Console**: All log levels output to console

### Empty Scan Handling
- Scans with zero file changes are NOT stored in the database
- These are logged to Windows Event Log for auditing
- Reduces database size and query noise
- Configurable via `SKIP_EMPTY_SCANS=false`

### Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `LOG_LEVEL` | info | Log level (error, warn, info, debug) |
| `SCAN_INTERVAL_MS` | 300000 | Scan interval (5 min) |
| `AUTO_START_SCHEDULER` | true | Start scheduler on server start |
| `SKIP_EMPTY_SCANS` | true | Don't store zero-change scans |

## Implementation Notes

- PowerShell uses API-first with JSON fallback for resilience
- SQLite WAL mode enabled for concurrent read performance
- Frontend polls API at configurable intervals (5/10/30/60s)
- Timestamps stored in both display format and ISO 8601
- BOM handling in JSON import for PowerShell compatibility
- Beads integration for missing `.claude` folder tracking
- Graceful shutdown with SIGTERM/SIGINT handling
- Uncaught exception logging and recovery
