# Rule: Zgent Permissions

## Filesystem
- READ any file under the enterprise root directory tree
- WRITE only within this repository's directory
- NEVER read or write outside the enterprise root

## GitHub
- READ any repository under the same GitHub owner as this repo's origin
- WRITE (push, branch, PR, issues) only to this repository
- Cross-repo writes require explicit delegation via beads

## Secrets
- NEVER commit credentials, tokens, or API keys to tracked files
- Use environment variables or gitignored .env files
