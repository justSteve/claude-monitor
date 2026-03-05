# Architecture Decision: CM as Enterprise Search Mediator

**Date:** 2026-03-05
**Status:** Accepted
**Bead:** gt-cms (epic)

## Context

The enterprise needs a way for any zgent to search past Claude Code conversation transcripts. CASS (coding_agent_session_search) provides semantic + lexical hybrid search over agent sessions. claude-monitor (CM) already tracks file changes and conversation metadata.

The question: how do zgents access search capabilities?

## Decision

**claude-monitor is a WSL-native zgent that mediates enterprise access to CASS.**

### Principles

1. **CM is a zgent.** WSL-native, beads-first, tmux session, full enterprise conventions. No exceptions.
2. **CASS runs in WSL.** Installed as a Rust binary inside WSL, alongside CM. Not a Windows-only service.
3. **CASS indexes both environments.** WSL sessions directly, Windows sessions via `/mnt/c/` or remote sources.
4. **CM is the mediator.** Other zgents never interact with CASS directly. They request search through CM's API.
5. **CASS is the engine, CM is the interface.** CM translates enterprise search requests into CASS queries and returns structured results.

### Architecture

```
  WSL (zgent ecosystem)
  +-------------------------------------+
  |  Zgent A --+                        |
  |  Zgent B --+--> CM (mediator zgent) |
  |  Zgent C --+       |                |
  |                    v                |
  |              CASS (Rust binary)     |
  |              indexes:               |
  |               - WSL ~/.claude/      |
  |               - /mnt/c/Users/...    |
  +-------------------------------------+
```

### CM's Mediator Responsibilities

- Accept search requests from zgents (via Layer 0 JSONL, future MCP, or direct CLI)
- Translate to CASS `--robot` mode queries (JSON output)
- Return structured results: conversation ID, timestamp, matched content, source zgent/project
- Manage CASS index lifecycle (rebuild, sync, health checks)
- Expose search as a discoverable enterprise service

### What This Resolves

- **claude-monitor-x99** (archive vs maintain): Neither. CM wraps CASS, doesn't compete with it.
- **claude-monitor-ghe** (migrate to CASS): Reframed. Not a replacement — CM becomes the enterprise layer on top of CASS.
- **Inter-zgent search**: Any zgent asks CM. No zgent needs to know about CASS internals.

## Consequences

- CASS must be installable and functional in WSL (Rust binary, may need to compile from source or use Linux release)
- CM needs a search API layer (minimal: CLI wrapper around `cass --robot`)
- CM's existing conversation parsing may become redundant once CASS indexes the same data — evaluate after integration
- Windows-side PowerShell scanner remains useful for file change monitoring (not search)
