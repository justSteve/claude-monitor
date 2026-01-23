# Specification: Claude Context File Monitor

## Overview

A Windows PowerShell script that runs every 5 minutes via Task Scheduler, detecting file changes within `.claude` folders under specified root directories. Outputs to daily rolling JSON log files with human-friendly timestamps in Central Time.

---

## Repository Structure

```
C:\MyStuff\_infra\claude-monitor\
├── .git\
├── .gitignore
├── README.md
├── Monitor-ClaudeFiles.ps1       # Main script
├── config.json                   # User configuration
├── state.json                    # Auto-generated runtime state (gitignored)
└── logs\
    └── 01-02-26.json             # Daily rolling log (gitignored)
```

### Git Remote

- **Origin**: `https://github.com/justSteve/claude-monitor.git`

### .gitignore Contents

```
state.json
logs/
```

---

## Configuration File: `config.json`

```json
{
  "roots": [
    "C:\\Users\\Steve\\.claude",
    "C:\\MyStuff"
  ],
  "logDirectory": "./logs",
  "stateFile": "./state.json",
  "timezone": "Central Standard Time"
}
```

### Config Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `roots` | string[] | Directories to scan. First root scans only that folder. Second root scans recursively for any `.claude` subfolders. |
| `logDirectory` | string | Relative or absolute path for daily log files |
| `stateFile` | string | Path to persistent state between runs |
| `timezone` | string | Windows timezone ID for timestamp formatting |

---

## Timestamp Format

All timestamps use Central Time in human-friendly format:

```
1/2/26 2:28 PM
```

PowerShell format string: `M/d/yy h:mm tt`

Rationale: Readability over ISO 8601. No programmatic reason to use formal timestamps - these logs are for human review. Any downstream tooling can parse this format.

---

## Log File Schema: `MM-DD-YY.json`

Filename example: `01-02-26.json`

Each file contains an array of scan results for that day, appended with each run:

```json
[
  {
    "scanTime": "1/2/26 2:25 PM",
    "scanDurationMs": 187,
    "filesNoChange": 42,
    "filesWithChange": []
  },
  {
    "scanTime": "1/2/26 2:30 PM",
    "scanDurationMs": 234,
    "filesNoChange": 40,
    "filesWithChange": [
      {
        "path": "C:\\Users\\Steve\\.claude\\settings.json",
        "sizeBytes": 1842,
        "deltaSizeBytes": 128,
        "status": "MODIFIED",
        "attributes": ["hidden", "system"],
        "lastModified": "1/2/26 2:28 PM"
      },
      {
        "path": "C:\\MyStuff\\strades\\.claude\\context.md",
        "sizeBytes": 4096,
        "deltaSizeBytes": null,
        "status": "NEW",
        "attributes": [],
        "lastModified": "1/2/26 2:29 PM"
      }
    ]
  }
]
```

### Log Field Definitions

#### Scan-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `scanTime` | string | When this scan executed (Central Time) |
| `scanDurationMs` | integer | Milliseconds to complete scan |
| `filesNoChange` | integer | Count of tracked files with no changes this scan |
| `filesWithChange` | array | Files that changed (empty array if no changes) |

#### File-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | Full file path |
| `sizeBytes` | integer | Current file size |
| `deltaSizeBytes` | integer \| null | Size change from previous state. `null` if NEW, `0` if touched but same size, positive/negative for actual change |
| `status` | string | One of: `NEW`, `MODIFIED`, `DELETED` |
| `attributes` | string[] | File attributes as array - captures any combination. Possible values: `hidden`, `system`, `readonly`. Empty array `[]` for normal files with no special attributes. Examples: `["hidden"]`, `["hidden", "system"]`, `["readonly"]`, `["hidden", "system", "readonly"]` |
| `lastModified` | string | File's LastWriteTime (Central Time) |

---

## State File Schema: `state.json`

Runtime persistence between scans. Not committed to git.

```json
{
  "lastScan": "1/2/26 2:25 PM",
  "files": {
    "C:\\Users\\Steve\\.claude\\settings.json": {
      "sizeBytes": 1714,
      "lastModified": "1/2/26 12:15 PM"
    },
    "C:\\MyStuff\\strades\\.claude\\context.md": {
      "sizeBytes": 3800,
      "lastModified": "1/2/26 11:00 AM"
    }
  }
}
```

### State Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `lastScan` | string | Timestamp of most recent scan |
| `files` | object | Dictionary keyed by full file path |
| `files[path].sizeBytes` | integer | File size at last scan |
| `files[path].lastModified` | string | File's LastWriteTime at last scan |

---

## Script Logic: `Monitor-ClaudeFiles.ps1`

### Execution Flow

1. **Load config** from `config.json`
2. **Load previous state** from `state.json` (empty object if first run)
3. **Discover files**:
   - For `C:\Users\Steve\.claude`: scan that folder directly (non-recursive)
   - For `C:\MyStuff`: find all `.claude` folders recursively, then get all files within each
4. **Build current state** dictionary with path, size, lastModified, attributes
5. **Compare states**:
   - File in current but not previous → `NEW`
   - File in both, lastModified within last 5 minutes → `MODIFIED`, calculate `deltaSizeBytes`
   - File in previous but not current → `DELETED` (size and lastModified from previous state)
6. **Count unchanged files** (in both states, not modified)
7. **Write updated state** to `state.json`
8. **Append to daily log**:
   - Determine filename from current date: `MM-DD-YY.json`
   - If file exists, read existing array, append new scan object, write back
   - If file doesn't exist, create with single-element array
   - Pretty-print with 2-space indentation

### Error Handling

- If a root path doesn't exist, log warning to console and skip (don't fail entire scan)
- If a file can't be accessed (locked), skip and continue
- If state.json is corrupted, start fresh (log warning)
- If logs directory doesn't exist, create it

### Attribute Detection Logic

```powershell
$attributes = @()
if ($file.Attributes -band [System.IO.FileAttributes]::Hidden) { $attributes += "hidden" }
if ($file.Attributes -band [System.IO.FileAttributes]::System) { $attributes += "system" }
if ($file.Attributes -band [System.IO.FileAttributes]::ReadOnly) { $attributes += "readonly" }
# Result: empty array [] for normal files, or any combination like ["hidden", "system"]
```

---

## Task Scheduler Setup

Script should include a `-Register` parameter that creates the scheduled task:

```powershell
.\Monitor-ClaudeFiles.ps1 -Register
```

Task configuration:
- **Name**: `ClaudeFileMonitor`
- **Trigger**: Every 5 minutes, indefinitely
- **Action**: `powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\MyStuff\_infra\claude-monitor\Monitor-ClaudeFiles.ps1"`
- **Run whether user is logged on or not**: No (run only when logged in)
- **Hidden**: Yes (no window flash)

Also support:
- `.\Monitor-ClaudeFiles.ps1 -Unregister` — removes the scheduled task
- `.\Monitor-ClaudeFiles.ps1 -Status` — shows if task exists and last run time

---

## README.md Contents

```markdown
# Claude Context File Monitor

Tracks file changes in `.claude` folders across configured directories.
Runs every 5 minutes via Windows Task Scheduler.

## Setup

1. Clone this repo to `C:\MyStuff\_infra\claude-monitor`
2. Edit `config.json` if roots need adjustment
3. Register the scheduled task:
   ```powershell
   .\Monitor-ClaudeFiles.ps1 -Register
   ```

## Usage

- Logs appear in `./logs/` with daily rollover
- Manual run: `.\Monitor-ClaudeFiles.ps1`
- Check status: `.\Monitor-ClaudeFiles.ps1 -Status`
- Uninstall: `.\Monitor-ClaudeFiles.ps1 -Unregister`

## Files

- `config.json` — scan roots and settings
- `state.json` — runtime state (gitignored)
- `logs/` — daily JSON logs (gitignored)
```

---

## Deliverables

1. `Monitor-ClaudeFiles.ps1` — complete script with all logic above
2. `config.json` — default configuration
3. `.gitignore` — excludes state and logs
4. `README.md` — setup and usage instructions
5. Git repository initialized with remote configured

---

## Implementation Notes for Agent

- Use `Get-ChildItem -Recurse -Directory -Filter ".claude"` for discovery under `C:\MyStuff`
- Use `[System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId()` for Central Time conversion
- Use `ConvertTo-Json -Depth 10` for output (default depth truncates nested objects)
- Test with `-WhatIf` style dry run before registering task
- PowerShell 5.1 compatibility required (ships with Windows 10/11)
- Attributes field must be an array to capture combinations (hidden+system, etc.)
