# Link WSL Claude Code projects to Windows .claude/projects
# Run from elevated PowerShell

$wslRoot = "\\wsl$\Ubuntu\root\.claude\projects"
$winRoot = "$env:USERPROFILE\.claude\projects"

$projects = Get-ChildItem -Path $wslRoot -Directory -ErrorAction Stop

foreach ($proj in $projects) {
    $linkName = "wsl-$($proj.Name)"
    $linkPath = Join-Path $winRoot $linkName
    $targetPath = Join-Path $wslRoot $proj.Name

    if (Test-Path $linkPath) {
        Write-Host "Skip: $linkName (exists)" -ForegroundColor Yellow
    } else {
        cmd /c mklink /D "$linkPath" "$targetPath"
        Write-Host "Created: $linkName -> $targetPath" -ForegroundColor Green
    }
}

Write-Host "`nDone. Run 'cass index' to include WSL sessions."
