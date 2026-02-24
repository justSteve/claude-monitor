# claude-monitor Worker Context

> **Context Recovery**: Run `bd ready` to see available work after compaction or new session.

## Startup Protocol

1. Check for available work: `bd ready`
2. If work is available → claim it with `bd update <id> --status in_progress` and execute
3. If nothing available → wait for user instructions

## Key Commands

- `bd ready` - Find available work (no blockers)
- `bd create -t "title"` - Create a new bead for untracked work
- `bd update <id> --status in_progress` - Claim work
- `bd close <id>` - Mark work complete
- `bd sync` - Sync beads changes with git

## Session Close Protocol

Before signaling completion:
1. `git status` (check what changed)
2. `git add <files>` (stage code changes)
3. `bd sync` (commit beads changes)
4. `git commit -m "..."` (commit code)
5. `bd sync` (commit any new beads changes)
6. `git push` (push to remote)

## What This Is NOT

This is an independent zgent, not a Gas Town managed agent. Do not use `gt` commands (`gt mol`, `gt mail`, `gt feed`, `gt done`, `gt prime`). Those are for Gas Town polecats/workers. Use `bd` for all beads operations.
