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
