# Extract conversation text from JSONL file
$jsonlPath = "\\wsl$\Ubuntu\root\.claude\projects\-root-projects-gtOps\a2d21086-fa52-458e-a83d-6140fe7a2b45.jsonl"
$outputPath = "\\wsl$\Ubuntu\root\projects\gtOps\docs\everything-claude-code-conversation.md"

$markdown = @"
# Everything Claude Code Implementation Conversation

**Date**: January 25, 2026
**Session ID**: a2d21086-fa52-458e-a83d-6140fe7a2b45
**Repository**: gtOps

This is a transcript of the conversation that implemented the everything-claude-code approach in gtOps.
Tool calls and results have been omitted for readability.

---

"@

$lines = Get-Content -LiteralPath $jsonlPath -Encoding UTF8
$lastRole = ""

foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    try {
        $entry = $line | ConvertFrom-Json

        # Skip non-message entries (queue-operation, file-history-snapshot, etc.)
        if ($entry.type -notin @("user", "assistant")) { continue }

        # Get the message content
        $content = $entry.message.content
        if (-not $content) { continue }

        $role = $entry.message.role
        $timestamp = $entry.timestamp

        foreach ($block in $content) {
            # For user messages: include text blocks, skip tool_result
            # For assistant messages: include text blocks, skip tool_use and thinking

            if ($block.type -eq "text" -and $block.text) {
                # Skip empty or whitespace-only text
                $text = $block.text.Trim()
                if ([string]::IsNullOrWhiteSpace($text)) { continue }

                # Skip thinking blocks that leaked through
                if ($text.StartsWith("<thinking>") -or $text.StartsWith("</thinking>")) { continue }

                # Only add role header if it changed (avoid duplicate headers)
                if ($role -ne $lastRole) {
                    $roleLabel = if ($role -eq "user") { "## User" } else { "## Assistant" }
                    $markdown += "`n$roleLabel`n`n"
                    $lastRole = $role
                }

                $markdown += "$text`n`n"
            }
        }
    }
    catch {
        # Skip malformed lines
        continue
    }
}

# Write output with UTF8 encoding (no BOM)
[System.IO.File]::WriteAllText($outputPath, $markdown, [System.Text.UTF8Encoding]::new($false))
Write-Host "Conversation extracted to: $outputPath"
