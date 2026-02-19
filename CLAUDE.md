# claude-monitor

claude-monitor is an observability zgent (in-process toward Zgent certification) that tracks file changes across `.claude/` directories in the enterprise. It watches how Claude Code sessions evolve — what rules change, what configs drift, what conversations accumulate — and surfaces that through a REST API and web dashboard.

## Mission

Provide enterprise-wide visibility into Claude Code session state. When the COO deploys artifacts to zgents, when rules change, when configs drift — claude-monitor sees it. Sibling zgents can query the API to understand the current state of the enterprise's Claude Code configurations.

## Architecture

| Component | Path | Purpose |
|-----------|------|---------|
| PowerShell Scanner | `Monitor-ClaudeFiles.ps1` | Windows Task Scheduler job, scans `.claude/` dirs every 5 min |
| API Server | `server/` | Node.js/Bun REST API with SQLite backend |
| Web Dashboard | `public/` | Browser UI — scan history, file changes, conversations |
| Scripts | `scripts/` | Migration, backfill, JSON log import utilities |
| Config | `config.json` | Scan roots (`C:\Users\Steve\.claude`, `C:\MyStuff`), API settings |

```
PowerShell Monitor → logs/*.json → Node.js Server (SQLite) → Web Dashboard
```

## Key Commands

```bash
bun install          # Install dependencies (or npm install)
bun run start        # Start API server on :3000
bun run scripts/migrate.js        # Run DB migrations
bun run scripts/backfill-conversations.js  # Backfill conversation data
```

## Graduation Status

In-process zgent. Standard artifacts deployed (beads-first, zgent-permissions). Observability role makes claude-monitor a natural candidate for early graduation — it watches the enterprise.

## Conventions

- Beads-first: self-bead for non-trivial work, reference bead ID in commits
- Enterprise permissions: read sibling repos, write only own path
- Uses `bd` (beads daemon) for issue tracking — see AGENTS.md
