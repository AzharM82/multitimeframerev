<#
.SYNOPSIS
    One-time setup for the TradingView sidecar on the trading desktop.

.DESCRIPTION
    Does three things:
      1. Pulls TIMER_SECRET from the live Static Web App and stores it as a USER
         environment variable. The value is never printed - it goes straight
         from Azure into the environment.
      2. Registers a Scheduled Task that starts the sidecar at logon.
      3. Optionally starts it immediately.

    The sidecar must be running for the portal's Chart Analysis tab to work:
    the cloud cannot reach this machine, so the sidecar polls outbound. It is
    also what launches TradingView on demand, so "type a ticker and TradingView
    opens" only holds while this task is alive.

.PARAMETER StartNow
    Start the task immediately after registering it.

.PARAMETER Uninstall
    Remove the scheduled task (leaves the environment variable in place).

.EXAMPLE
    .\install-sidecar.ps1 -StartNow
#>
[CmdletBinding()]
param(
    [switch]$StartNow,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$TaskName = 'MTF TradingView Sidecar'
$SidecarDir = $PSScriptRoot
$Entry = Join-Path $SidecarDir 'index.js'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
    } else {
        Write-Host "Task '$TaskName' was not registered." -ForegroundColor Yellow
    }
    exit 0
}

if (-not (Test-Path $Entry)) { throw "Sidecar entry point not found at $Entry" }

# --- 1. TIMER_SECRET ---------------------------------------------------------
$existing = [Environment]::GetEnvironmentVariable('TIMER_SECRET', 'User')
if ($existing) {
    Write-Host "TIMER_SECRET already set for this user - leaving it alone." -ForegroundColor Green
} else {
    Write-Host "Fetching TIMER_SECRET from mtfrev-app..." -ForegroundColor Cyan
    $secret = az staticwebapp appsettings list `
        --name mtfrev-app --resource-group rg-mtfrev `
        --query "properties.TIMER_SECRET" -o tsv
    if (-not $secret) {
        throw "Could not read TIMER_SECRET from mtfrev-app. Run 'az login' first, or set it manually."
    }
    [Environment]::SetEnvironmentVariable('TIMER_SECRET', $secret, 'User')
    Remove-Variable secret
    Write-Host "TIMER_SECRET stored as a user environment variable (value not displayed)." -ForegroundColor Green
}

# --- 2. Scheduled task -------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe not found on PATH." }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Task '$TaskName' exists - re-registering." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$Entry`"" -WorkingDirectory $SidecarDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
# Restart on failure: TradingView restarts and transient network blips should
# not silently leave the portal with a sidecar that never answers.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description 'Polls the MTF portal for chart-analysis requests and reads TradingView Desktop over CDP.' | Out-Null

Write-Host "Registered scheduled task '$TaskName' (starts at logon)." -ForegroundColor Green

# --- 3. Start now ------------------------------------------------------------
if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    $state = (Get-ScheduledTask -TaskName $TaskName).State
    Write-Host "Task state: $state" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "NOTE: the sidecar can only attach to TradingView if it was launched with CDP." -ForegroundColor Yellow
    Write-Host "      Use tools\tv-launch.ps1 (not the Start Menu shortcut) to open it." -ForegroundColor Yellow
} else {
    Write-Host "Run with -StartNow, or log out and back in, to start it." -ForegroundColor Cyan
}
