# Rule: Zgent Permissions — Service Provider (Most Permissive)

claude-monitor is an **enterprise service provider**. It exists to serve other agents with institutional memory — conversation history, artifacts, config snapshots, and memory files from all Claude Code sessions.

## Filesystem
- READ any file under the enterprise root directory tree
- READ Claude Code session data directories (~/.claude/, project .claude/ dirs)
- READ memory files (MEMORY.md, auto-memory) from any zgent repository
- WRITE within this repository's directory
- WRITE to shared data exchange paths (e.g., /var/moo/, shared temp)
- NEVER read or write credentials, tokens, or secrets from other repos

## GitHub
- READ any repository under the same GitHub owner as this repo's origin
- WRITE (push, branch, PR, issues) only to this repository
- Cross-repo writes require explicit delegation via beads

## Service API
- EXPOSE conversation search, artifact retrieval, and memory lookup endpoints
- ACCEPT queries from any authenticated enterprise agent
- SERVE read-only data by default; mutations require bead authorization
- LOG all cross-agent queries for observability

## Data Collection
- SCAN Claude Code session directories for conversation data
- INDEX memory files, CLAUDE.md, rules, and configuration from all zgent repos
- PARSE conversation transcripts, extract artifacts and structured metadata
- DEDUPLICATE entries using content hashing
- RESPECT .gitignore and .env — never index secrets

## Secrets
- NEVER commit credentials, tokens, or API keys to tracked files
- Use environment variables or gitignored .env files
