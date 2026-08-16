# Registers the "AVWAP Earnings Publisher" scheduled task on DESKTOP2.
# Runs every 5 minutes, 6:25 AM - 1:10 PM PT (9:25 AM - 4:10 PM ET), weekdays —
# sweeps the MASTER TradingView watchlist on the 39-minute chart and publishes
# each symbol's distance from its earnings-anchored VWAP to the StockAgentHub
# cloud, which fires the line-cross alerts.
# Run from an elevated PowerShell:  .\setup_publisher_task.ps1

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
$script = Join-Path $here "publish_avwap.mjs"

if (-not (Test-Path (Join-Path $here ".env"))) {
    Write-Warning "No .env found next to publish_avwap.mjs — copy .env.example and fill it in first."
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Daily -At "06:25"
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At "06:25" `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Hours 7)).Repetition

# A full 193-symbol sweep runs ~4 min. The limit is generous but finite so a
# hung CDP session can never sit on the lock forever; IgnoreNew means a slow
# sweep is skipped rather than stacked on top of the running one.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 9) `
    -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask -TaskName "AVWAP Earnings Publisher" `
    -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "Task 'AVWAP Earnings Publisher' registered (every 5 min, 6:25 AM-1:25 PM PT daily;"
Write-Host "the script itself skips weekends/after-hours). Test now with:"
Write-Host "  node `"$script`" --force --dry-run --limit 5"
