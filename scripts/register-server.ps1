<#
.SYNOPSIS
    Registers the Claude Monitor server as a Windows scheduled task to run at startup.

.DESCRIPTION
    Creates a scheduled task that starts the Node.js server when Windows boots.
    The server runs in the background and automatically restarts on failure.

.PARAMETER Unregister
    Removes the scheduled task instead of creating it.

.PARAMETER Status
    Shows the current status of the scheduled task.
#>

[CmdletBinding()]
param(
    [switch]$Unregister,
    [switch]$Status
)

$TaskName = "ClaudeMonitorServer"
$ScriptPath = Split-Path -Parent $PSScriptRoot
$BunPath = (Get-Command bun -ErrorAction SilentlyContinue).Source

if (-not $BunPath) {
    Write-Error "Bun not found in PATH. Please install Bun first."
    exit 1
}

function Register-ServerTask {
    $action = New-ScheduledTaskAction -Execute $BunPath `
        -Argument "server/index.js" `
        -WorkingDirectory $ScriptPath

    $trigger = New-ScheduledTaskTrigger -AtStartup

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Days 365)

    try {
        Register-ScheduledTask -TaskName $TaskName `
            -Action $action `
            -Trigger $trigger `
            -Settings $settings `
            -RunLevel Highest `
            -Force | Out-Null

        Write-Host "Task '$TaskName' registered successfully." -ForegroundColor Green
        Write-Host "Server will start automatically at Windows boot."
        Write-Host ""
        Write-Host "To start immediately, run:" -ForegroundColor Cyan
        Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
    }
    catch {
        Write-Error "Failed to register task: $_"
    }
}

function Unregister-ServerTask {
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host "Task '$TaskName' unregistered successfully." -ForegroundColor Green
    }
    catch {
        Write-Warning "Task '$TaskName' not found or could not be removed."
    }
}

function Get-ServerTaskStatus {
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName

        Write-Host "Task '$TaskName' Status:" -ForegroundColor Cyan
        Write-Host "  State: $($task.State)"
        if ($taskInfo.LastRunTime) {
            Write-Host "  Last run: $($taskInfo.LastRunTime)"
            Write-Host "  Last result: $($taskInfo.LastTaskResult)"
        }
        if ($taskInfo.NextRunTime) {
            Write-Host "  Next run: $($taskInfo.NextRunTime)"
        }

        # Check if server is actually running
        $serverRunning = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
        if ($serverRunning) {
            Write-Host "  Server: Running on port 3000" -ForegroundColor Green
        } else {
            Write-Host "  Server: Not running" -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host "Task '$TaskName' is not registered." -ForegroundColor Yellow
    }
}

# Main
if ($Unregister) {
    Unregister-ServerTask
}
elseif ($Status) {
    Get-ServerTaskStatus
}
else {
    Register-ServerTask
}
