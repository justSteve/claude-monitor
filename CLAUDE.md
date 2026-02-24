# claude-monitor — Enterprise Institutional Memory Service

**Zgent Status:** zgent (in-process toward Zgent certification)
**Role:** Infrastructure service provider — the enterprise's memory and recall layer
**Bead Prefix:** `claude-monitor`

## STOP — Beads Gate (Read This First)

**This repo is beads-first. You MUST authorize work before doing it.**

Before making ANY substantive changes (creating/modifying files, installing deps, changing config), do this:

```bash
bd ready                    # See if there's already an open bead for this work
bd create -t "Short title"  # Create one if not — YOU own this, don't ask the user
bd update <id> --status in_progress  # Claim it
```

When done:
```bash
bd close <id>               # Mark complete
bd sync                     # Sync with git
```

Reference the bead ID in your commit messages: `[claude-monitor-xxx] description`.

**No bead = no work.** Minor housekeeping (typos, status fields) is exempt. Everything else gets a bead. If in doubt, create one — it's cheap. See `.claude/rules/beads-first.md` for the full rule.

**This is not optional. This is not a Gas Town thing. This is how THIS repo works, every session, every instance.**

## What This Is

claude-monitor is the **institutional memory** of Steve's Zgent enterprise. It collects, indexes, and serves conversation history, extracted artifacts, configuration snapshots, and memory files from all Claude Code sessions across all projects.

Every agent in the enterprise benefits from recall. When any zgent needs to know "what was decided about X" or "when did we last discuss Y" or "what code was written for Z" — claude-monitor is the answer.

## Why This Is Foundational

DReader surfaces **external** intel (Discord channels). claude-monitor surfaces **internal** intel (every conversation Claude has had across the enterprise). This makes it more foundational than DReader because:

- Architectural decisions live in past conversations
- Bug fixes, workarounds, and anti-patterns are captured in session history
- Memory files (MEMORY.md) across repos contain distilled knowledge
- Configuration evolution is tracked through snapshots
- Every agent's context improves when institutional memory is queryable

## Service Contract

claude-monitor **serves other agents** with:

1. **Conversation Search** — Full-text and semantic search across all Claude Code sessions
2. **Artifact Retrieval** — Code blocks, tool calls, JSON objects extracted from conversations
3. **Memory Aggregation** — Collected MEMORY.md files, rules, and CLAUDE.md from all zgent repos
4. **Config History** — How .claude/ configurations have evolved over time
5. **Session Timeline** — When work happened, what changed, who was involved

## Architecture

```
┌──────────────────────┐     ┌─────────────────┐     ┌────────────────┐
│ PowerShell Monitor   │────▶│ Bun API Server  │────▶│ Web Dashboard  │
│ (Task Scheduler)     │     │ (REST API)      │     │ (viewer.html)  │
└──────────────────────┘     └─────────────────┘     └────────────────┘
         │                           │
         ▼                           ▼
    logs/*.json                 SQLite DB
                                     │
                               ┌─────┴─────┐
                               │ CASS Index │  (semantic search layer)
                               └───────────┘
```

## API Endpoints

Base URL: `http://localhost:3000/api/v1`

Key endpoints for agent consumers:
- `GET /conversations` — List/search conversations
- `GET /conversations/:id/entries` — Get conversation messages
- `GET /conversations/:id/artifacts` — Get extracted artifacts
- `GET /artifacts/search?q=` — Search artifacts across all conversations
- `GET /files/search?q=` — Search tracked config files
- `GET /health` — Health check

## Current State

- **Scanner:** PowerShell file monitor on Windows Task Scheduler (5-min interval)
- **Server:** Bun-powered Express API with SQLite storage
- **Dashboard:** Web UI for file changes + conversation browsing
- **CASS:** Migration in progress (coding_agent_session_search — semantic search, 11-agent support)
- **Beads:** `bd` CLI for work authorization (standalone — not a Gas Town managed agent)

## Environment — READ THIS

This repo runs on **Windows**. Your working directory is `C:\myStuff\_infra\claude-monitor`.

- **`bd` works.** The beads daemon runs cross-platform. Use `bd ready`, `bd create`, `bd close`, etc.
- **`gt` does NOT apply here.** Gas Town CLI (`gt mol`, `gt mail`, `gt feed`, `gt status`) is for Gas Town managed agents (polecats, mayor, deacon). claude-monitor is an independent zgent, not a GT worker. Do NOT run `gt` commands.
- **Do NOT `cd` to your own directory.** You are already there. Compound `cd && command` triggers Claude Code security prompts and is unnecessary.
- **No tmux.** This is Windows. tmux sessions are a WSL concept.
- **PowerShell is available** for Windows-native operations.
- **Bun and Node are available** for running the server and scripts.

## What Every Claude Instance Must Understand

1. **This is infrastructure, not an application.** claude-monitor exists to make every other agent smarter.
2. **Beads-first is non-negotiable.** Read the gate at the top of this file. Use `bd` commands. No exceptions.
3. **This is not a Gas Town agent.** `gt` commands do not apply. Use `bd` for beads, `bun`/`npm` for dev, `powershell` for system tasks.
4. **Service provider permissions.** This zgent has broad READ access across the enterprise. See `.claude/rules/zgent-permissions.md`.
5. **CASS is the search future.** The CASS migration (semantic + lexical hybrid search) is the path forward for query capabilities.
6. **Memory aggregation is the next frontier.** Indexing MEMORY.md files across all zgent repos turns scattered per-repo knowledge into enterprise-wide recall.

## Graduation Status

claude-monitor is on the path to Zgent certification. Current progress:

- **Standard artifacts deployed** — beads-first, zgent-permissions, .gitignore, .gitattributes, .vscode ✓
- **ECC session declared** — infrastructure category, bootPriority 5, narrative channel ✓
- **CLAUDE.md with enterprise identity** — mission, architecture, service contract ✓
- **Memory aggregation pipeline** — scan + index MEMORY.md files from all zgent repos (gt-zf1.2, open)
- **MCP server** — expose query API as MCP tools so sibling zgents can call directly (gt-zf1.3, open)
- **Session boot script** — tmux session creation per ECC declaration (gt-zf1.4, open)
- **Structured logging conformance** — adopt AOE logging patterns (future)

## Development

```bash
# Install dependencies
bun install

# Start API server
bun run start

# Run database migrations
bun run migrate

# Run file monitor manually
powershell .\Monitor-ClaudeFiles.ps1
```

## Key Files

| Path | Purpose |
|------|---------|
| `server/index.js` | Express API entry point |
| `server/config.js` | Server configuration |
| `Monitor-ClaudeFiles.ps1` | Windows file scanner |
| `config.json` | Scan root configuration |
| `db/claude_monitor.db` | SQLite database |
| `.beads/` | GT beads (work authorization) |
