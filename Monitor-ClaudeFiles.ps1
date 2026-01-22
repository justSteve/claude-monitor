<#
.SYNOPSIS
    Monitors .claude folders for file changes and logs them to daily JSON files.

.DESCRIPTION
    Scans configured root directories for .claude folders, detects file changes
    by comparing with previous state, and appends results to daily rolling logs.

.PARAMETER Register
    Creates a Windows Task Scheduler task to run this script every 5 minutes.

.PARAMETER Unregister
    Removes the scheduled task.

.PARAMETER Status
    Shows the current status of the scheduled task.
#>

[CmdletBinding()]
param(
    [switch]$Register,
    [switch]$Unregister,
    [switch]$Status
)

$ErrorActionPreference = "Continue"
$ScriptPath = $PSScriptRoot
$TaskName = "ClaudeFileMonitor"

#region Task Scheduler Functions

function Register-MonitorTask {
    $scriptFullPath = Join-Path $ScriptPath "Monitor-ClaudeFiles.ps1"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptFullPath`""

    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 5)

    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden

    try {
        Register-ScheduledTask -TaskName $TaskName -Action $action `
            -Trigger $trigger -Settings $settings -Force | Out-Null
        Write-Host "Task '$TaskName' registered successfully."
        Write-Host "Script will run every 5 minutes."
    }
    catch {
        Write-Error "Failed to register task: $_"
    }
}

function Unregister-MonitorTask {
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host "Task '$TaskName' unregistered successfully."
    }
    catch {
        Write-Warning "Task '$TaskName' not found or could not be removed."
    }
}

function Get-MonitorTaskStatus {
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Host "Task '$TaskName' exists."
        Write-Host "State: $($task.State)"
        if ($taskInfo.LastRunTime) {
            Write-Host "Last run: $($taskInfo.LastRunTime)"
        }
        if ($taskInfo.NextRunTime) {
            Write-Host "Next run: $($taskInfo.NextRunTime)"
        }
    }
    catch {
        Write-Host "Task '$TaskName' is not registered."
    }
}

#endregion

#region Helper Functions

function Get-CentralTime {
    param([datetime]$UtcTime = (Get-Date).ToUniversalTime())

    $tz = [System.TimeZoneInfo]::FindSystemTimeZoneById("Central Standard Time")
    return [System.TimeZoneInfo]::ConvertTimeFromUtc($UtcTime, $tz)
}

function Format-Timestamp {
    param([datetime]$DateTime)
    return $DateTime.ToString("M/d/yy h:mm tt")
}

function Get-FileAttributes {
    param([System.IO.FileInfo]$File)

    $attributes = [System.Collections.ArrayList]::new()
    if ($File.Attributes -band [System.IO.FileAttributes]::Hidden) { [void]$attributes.Add("hidden") }
    if ($File.Attributes -band [System.IO.FileAttributes]::System) { [void]$attributes.Add("system") }
    if ($File.Attributes -band [System.IO.FileAttributes]::ReadOnly) { [void]$attributes.Add("readonly") }
    return ,$attributes.ToArray()
}

function Get-ProjectFolders {
    <#
    .SYNOPSIS
        Discovers project folders under a root directory.
    .DESCRIPTION
        Projects are direct children of the root.
        Folders starting with '_' or '.' are containers - their children are projects.
        Excludes '.claude' folders as they are monitoring targets, not projects.
    #>
    param([string]$Root)

    $projects = @()

    Get-ChildItem -Path $Root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $name = $_.Name

        # Skip .claude folders - they are monitoring targets, not projects
        if ($name -eq '.claude') {
            return
        }

        if ($name.StartsWith('_') -or $name.StartsWith('.')) {
            # Container - get its children as projects (excluding .claude)
            Get-ChildItem -Path $_.FullName -Directory -ErrorAction SilentlyContinue | Where-Object {
                $_.Name -ne '.claude'
            } | ForEach-Object {
                $projects += $_
            }
        } else {
            # Direct project
            $projects += $_
        }
    }

    return $projects
}

function Test-ApiHealth {
    <#
    .SYNOPSIS
        Checks if the Claude Monitor API is available.
    #>
    param([string]$ApiUrl)

    try {
        $response = Invoke-RestMethod -Uri "$ApiUrl/health" `
            -Method Get `
            -TimeoutSec 5 `
            -ErrorAction Stop
        return $response.status -eq "ok"
    }
    catch {
        return $false
    }
}

function Submit-ScanToApi {
    <#
    .SYNOPSIS
        Submits scan results to the Claude Monitor API.
    #>
    param(
        [hashtable]$ScanResult,
        [string]$ApiUrl
    )

    try {
        $body = $ScanResult | ConvertTo-Json -Depth 10
        $response = Invoke-RestMethod -Uri "$ApiUrl/scans" `
            -Method Post `
            -ContentType "application/json" `
            -Body $body `
            -TimeoutSec 10 `
            -ErrorAction Stop

        if ($response.success) {
            Write-Host "  Submitted to API: scan ID $($response.scanId)"
            return $true
        }
        return $false
    }
    catch {
        Write-Warning "API submission failed: $_"
        return $false
    }
}

function New-MissingClaudeBead {
    <#
    .SYNOPSIS
        Files a beads issue for a project missing its .claude folder.
    #>
    param([string]$ProjectPath)

    $projectName = Split-Path $ProjectPath -Leaf
    $title = "Missing .claude folder: $projectName"
    $description = "Project at $ProjectPath does not have a .claude folder. Every project should have a .claude folder at its root level."

    # Check if bd command is available
    $bdPath = Get-Command "bd" -ErrorAction SilentlyContinue
    if (-not $bdPath) {
        Write-Warning "bd command not found - cannot file bead for missing .claude: $ProjectPath"
        return $null
    }

    # File bead in the myStuff repo
    Push-Location "C:\MyStuff"
    try {
        $result = & bd create $title -t bug -p 2 -d $description --json 2>$null
        if ($LASTEXITCODE -eq 0 -and $result) {
            $bead = $result | ConvertFrom-Json
            Write-Host "  Filed bead $($bead.id): $title"
            return $bead.id
        } else {
            Write-Warning "Failed to file bead for: $ProjectPath"
            return $null
        }
    }
    catch {
        Write-Warning "Error filing bead: $_"
        return $null
    }
    finally {
        Pop-Location
    }
}

#endregion

#region Main Monitoring Logic

function Invoke-FileMonitor {
    $startTime = Get-Date
    $centralNow = Get-CentralTime

    # Load configuration
    $configPath = Join-Path $ScriptPath "config.json"
    if (-not (Test-Path $configPath)) {
        Write-Error "Configuration file not found: $configPath"
        return
    }

    $config = Get-Content $configPath -Raw | ConvertFrom-Json

    # Resolve paths
    $logDir = if ([System.IO.Path]::IsPathRooted($config.logDirectory)) {
        $config.logDirectory
    } else {
        Join-Path $ScriptPath $config.logDirectory
    }

    $statePath = if ([System.IO.Path]::IsPathRooted($config.stateFile)) {
        $config.stateFile
    } else {
        Join-Path $ScriptPath $config.stateFile
    }

    # Ensure logs directory exists
    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }

    # Load previous state
    $previousState = @{}
    if (Test-Path $statePath) {
        try {
            $stateContent = Get-Content $statePath -Raw | ConvertFrom-Json
            if ($stateContent.files) {
                $stateContent.files.PSObject.Properties | ForEach-Object {
                    $previousState[$_.Name] = @{
                        sizeBytes = $_.Value.sizeBytes
                        lastModified = $_.Value.lastModified
                    }
                }
            }
        }
        catch {
            Write-Warning "Could not load state file, starting fresh: $_"
        }
    }

    # Discover files
    $currentFiles = @{}
    $fiveMinutesAgo = $centralNow.AddMinutes(-5)
    $missingClaudeFolders = @()
    $projectsScanned = 0

    for ($i = 0; $i -lt $config.roots.Count; $i++) {
        $root = $config.roots[$i]

        if (-not (Test-Path $root)) {
            Write-Warning "Root path does not exist, skipping: $root"
            continue
        }

        if ($i -eq 0) {
            # First root (C:\Users\Steve\.claude): scan directly (non-recursive)
            try {
                Get-ChildItem -Path $root -File -ErrorAction SilentlyContinue | ForEach-Object {
                    $fileCentralTime = Get-CentralTime -UtcTime $_.LastWriteTimeUtc
                    $currentFiles[$_.FullName] = @{
                        sizeBytes = $_.Length
                        lastModified = Format-Timestamp $fileCentralTime
                        lastModifiedDateTime = $fileCentralTime
                        attributes = Get-FileAttributes $_
                    }
                }
            }
            catch {
                Write-Warning "Error scanning $root : $_"
            }
        }
        else {
            # Project root (C:\MyStuff): use project-based discovery
            $projects = Get-ProjectFolders -Root $root

            foreach ($project in $projects) {
                $projectsScanned++
                $claudePath = Join-Path $project.FullName ".claude"

                if (Test-Path $claudePath) {
                    # Scan files in the .claude folder
                    try {
                        Get-ChildItem -Path $claudePath -File -ErrorAction SilentlyContinue | ForEach-Object {
                            $fileCentralTime = Get-CentralTime -UtcTime $_.LastWriteTimeUtc
                            $currentFiles[$_.FullName] = @{
                                sizeBytes = $_.Length
                                lastModified = Format-Timestamp $fileCentralTime
                                lastModifiedDateTime = $fileCentralTime
                                attributes = Get-FileAttributes $_
                            }
                        }
                    }
                    catch {
                        Write-Warning "Error scanning $claudePath : $_"
                    }
                }
                else {
                    # Project is missing .claude folder - track it
                    $missingClaudeFolders += $project.FullName
                }
            }
        }
    }

    # File beads for missing .claude folders (only on first detection)
    $beadsFiledPath = Join-Path $ScriptPath "beads-filed.json"
    $beadsFiled = @{}
    if (Test-Path $beadsFiledPath) {
        try {
            $beadsContent = Get-Content $beadsFiledPath -Raw | ConvertFrom-Json
            # Convert PSObject to hashtable (PowerShell 5.1 compatible)
            if ($beadsContent) {
                $beadsContent.PSObject.Properties | ForEach-Object {
                    $beadsFiled[$_.Name] = $_.Value
                }
            }
        } catch {
            $beadsFiled = @{}
        }
    }

    foreach ($missingPath in $missingClaudeFolders) {
        if (-not $beadsFiled.ContainsKey($missingPath)) {
            $beadId = New-MissingClaudeBead -ProjectPath $missingPath
            if ($beadId) {
                $beadsFiled[$missingPath] = [ordered]@{
                    beadId = $beadId
                    filedAt = Format-Timestamp $centralNow
                }
            }
        }
    }

    # Save beads-filed state
    if ($beadsFiled.Count -gt 0) {
        $beadsFiled | ConvertTo-Json -Depth 5 | Set-Content $beadsFiledPath -Encoding UTF8
    }

    # Compare states and build change list
    $filesWithChange = @()
    $filesNoChange = 0

    # Check for NEW and MODIFIED files
    foreach ($path in $currentFiles.Keys) {
        $current = $currentFiles[$path]

        if (-not $previousState.ContainsKey($path)) {
            # NEW file
            $attrs = if ($current.attributes.Count -eq 0) { ,@() } else { $current.attributes }
            $filesWithChange += [ordered]@{
                path = $path
                sizeBytes = $current.sizeBytes
                deltaSizeBytes = $null
                status = "NEW"
                attributes = $attrs
                lastModified = $current.lastModified
            }
        }
        elseif ($current.lastModifiedDateTime -gt $fiveMinutesAgo) {
            # MODIFIED file (changed within last 5 minutes)
            $previous = $previousState[$path]
            $delta = $current.sizeBytes - $previous.sizeBytes

            $attrs = if ($current.attributes.Count -eq 0) { ,@() } else { $current.attributes }
            $filesWithChange += [ordered]@{
                path = $path
                sizeBytes = $current.sizeBytes
                deltaSizeBytes = $delta
                status = "MODIFIED"
                attributes = $attrs
                lastModified = $current.lastModified
            }
        }
        else {
            # No change
            $filesNoChange++
        }
    }

    # Check for DELETED files
    foreach ($path in $previousState.Keys) {
        if (-not $currentFiles.ContainsKey($path)) {
            $previous = $previousState[$path]
            $filesWithChange += [ordered]@{
                path = $path
                sizeBytes = $previous.sizeBytes
                deltaSizeBytes = $null
                status = "DELETED"
                attributes = ,@()
                lastModified = $previous.lastModified
            }
        }
    }

    # Calculate scan duration
    $endTime = Get-Date
    $durationMs = [int]($endTime - $startTime).TotalMilliseconds

    # Build scan result
    $scanResult = [ordered]@{
        scanTime = Format-Timestamp $centralNow
        scanDurationMs = $durationMs
        projectsScanned = $projectsScanned
        projectsMissingClaude = $missingClaudeFolders.Count
        filesNoChange = $filesNoChange
        filesWithChange = $filesWithChange
    }

    # Save current state
    $newState = [ordered]@{
        lastScan = Format-Timestamp $centralNow
        files = [ordered]@{}
    }
    foreach ($path in $currentFiles.Keys) {
        $newState.files[$path] = @{
            sizeBytes = $currentFiles[$path].sizeBytes
            lastModified = $currentFiles[$path].lastModified
        }
    }
    $newState | ConvertTo-Json -Depth 10 | Set-Content $statePath -Encoding UTF8

    # Try API submission first (if enabled)
    $apiSubmitted = $false
    $apiEnabled = $config.PSObject.Properties['apiEnabled'] -and $config.apiEnabled
    $fallbackToJson = -not $config.PSObject.Properties['fallbackToJson'] -or $config.fallbackToJson

    if ($apiEnabled -and $config.apiUrl) {
        if (Test-ApiHealth -ApiUrl $config.apiUrl) {
            $apiSubmitted = Submit-ScanToApi -ScanResult $scanResult -ApiUrl $config.apiUrl
        } else {
            Write-Warning "API not available at $($config.apiUrl)"
        }
    }

    # Fallback to JSON if API failed or disabled
    if ($fallbackToJson -and (-not $apiSubmitted -or -not $apiEnabled)) {
        $logFilename = $centralNow.ToString("MM-dd-yy") + ".json"
        $logPath = Join-Path $logDir $logFilename

        $logArray = @()
        if (Test-Path $logPath) {
            try {
                $existingContent = Get-Content $logPath -Raw
                if ($existingContent) {
                    $logArray = @(ConvertFrom-Json $existingContent)
                }
            }
            catch {
                Write-Warning "Could not read existing log, starting fresh: $_"
            }
        }

        $logArray += $scanResult
        # Force array output even with single element
        $jsonOutput = ConvertTo-Json -InputObject @($logArray) -Depth 10
        Set-Content -Path $logPath -Value $jsonOutput -Encoding UTF8

        if ($apiEnabled -and -not $apiSubmitted) {
            Write-Host "  Saved to JSON (API fallback)"
        }
    }

    # Output summary
    Write-Host "Scan completed at $(Format-Timestamp $centralNow)"
    Write-Host "  Projects scanned: $projectsScanned"
    if ($missingClaudeFolders.Count -gt 0) {
        Write-Host "  Projects missing .claude: $($missingClaudeFolders.Count)" -ForegroundColor Yellow
    }
    Write-Host "  Files unchanged: $filesNoChange"
    Write-Host "  Files with changes: $($filesWithChange.Count)"
    Write-Host "  Duration: ${durationMs}ms"
}

#endregion

#region Main Entry Point

if ($Register) {
    Register-MonitorTask
}
elseif ($Unregister) {
    Unregister-MonitorTask
}
elseif ($Status) {
    Get-MonitorTaskStatus
}
else {
    Invoke-FileMonitor
}

#endregion
