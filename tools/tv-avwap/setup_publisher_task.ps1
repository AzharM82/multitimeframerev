# Registers the "AVWAP Earnings Publisher" scheduled task on DESKTOP2.
# Runs ONCE PER 39-MINUTE CANDLE CLOSE, weekdays -
# sweeps the MASTER TradingView watchlist on the 39-minute chart and publishes
# each symbol's distance from its earnings-anchored VWAP to the StockAgentHub
# cloud, which fires the line-cross alerts.
# Run from an elevated PowerShell:  .\setup_publisher_task.ps1

$ErrorActionPreference = "Stop"

# Registering a scheduled task needs elevation. Check up front and say so,
# rather than letting Register-ScheduledTask fail deep in the script.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Must be run from an ELEVATED PowerShell - Register-ScheduledTask returns Access Denied (0x80070005) otherwise."
    exit 1
}
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
$script = Join-Path $here "publish_avwap.mjs"

if (-not (Test-Path (Join-Path $here ".env"))) {
    Write-Warning "No .env found next to publish_avwap.mjs - copy .env.example and fill it in first."
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Daily -At "06:31"
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At "06:31" `
    -RepetitionInterval (New-TimeSpan -Minutes 39) `
    -RepetitionDuration (New-TimeSpan -Hours 7)).Repetition

# Cadence is one sweep per CANDLE CLOSE, not a round-number grid.
#
# Alerts are decided on CLOSED 39-minute candles, so a new alert can only ever
# appear once every 39 minutes; sweeping more often finds nothing the bar-keyed
# dedup does not immediately discard. Aligning also makes alerts arrive SOONER:
# a fixed 10-minute grid can sit up to 10 minutes behind a close, whereas firing
# just after each close means the only delay is the sweep itself (~2 min for 193
# symbols on DESKTOP2).
#
# RTH 39m closes are 07:09, 07:48, 08:27, 09:06, 09:45, 10:24, 11:03, 11:42,
# 12:21, 13:00 PT. Starting 06:31 and repeating every 39 min gives
# 06:31, 07:10, 07:49, 08:28, 09:07, 09:46, 10:25, 11:04, 11:43, 12:22, 13:01 -
# one minute after each close, plus an at-the-open snapshot for the tab.
#
# NOT 06:30. That start lands every run EXACTLY on a close (07:09, 07:48, ...),
# giving zero settle margin: the first symbols would be read within seconds of
# the bar closing, while TradingView may still be finalising it. The MTF sidecar
# work already cost real debugging to a readiness race of exactly this kind, and
# the fix there was a settle delay. One minute is cheap insurance.
#
# Duration is 7h, NOT 6h. From 06:31 a 6-hour window stops repeating at 12:31,
# so the 13:01 run never fires and the session's FINAL bar (12:21-13:00) is
# never scored. The script's own market-window gate (9:25-16:05 ET) stops it
# after 13:05 PT, so the extra hour costs nothing.
#
# ExecutionTimeLimit is generous but finite so a hung CDP session can never sit
# on the lock forever; IgnoreNew skips a slow sweep rather than stacking on it.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 9) `
    -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask -TaskName "AVWAP Earnings Publisher" `
    -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

# Register-ScheduledTask raises a CIM error that $ErrorActionPreference="Stop"
# does NOT stop, so the script would otherwise print "registered" after a failed
# registration and the operator would find out only when things silently stopped
# working. Verify the task actually exists and fail loudly if it does not.
if (-not (Get-ScheduledTask -TaskName "AVWAP Earnings Publisher" -ErrorAction SilentlyContinue)) {
    Write-Error "Registration FAILED - 'AVWAP Earnings Publisher' does not exist after Register-ScheduledTask. Re-run from an elevated PowerShell."
    exit 1
}

Write-Host "Task 'AVWAP Earnings Publisher' registered (every 39 min from 7:10 AM PT,"
Write-Host "one sweep per 39m candle close, 10 runs a session;"
Write-Host "the script itself skips weekends/after-hours). Test now with:"
Write-Host "  node `"$script`" --force --dry-run --limit 5"
