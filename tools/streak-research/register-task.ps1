<#
  Registers the SPY streak research agent as a weekday scheduled task.

  Runs on THIS machine (the dev box), like tools/journal-sync - it needs the
  Claude CLI and the Polygon key, neither of which belongs in Azure.

  TIMING: 13:30 PT, thirty minutes after the 13:00 close, reporting on TODAY.

  Same-day is possible because TradingView serves the current session's option
  bars; Polygon refuses them (403, T-1 and older only) and stays as the fallback
  for EXPIRED contracts, which TradingView will not serve. The thirty minutes is
  for the delayed OPRA feed (_DLY) to finish filling the closing bars.

  If TradingView is not running the agent silently reports on the PREVIOUS
  session instead, since that is all Polygon can price.

  NOTE: a sweep drives the TradingView chart through dozens of contracts, taking
  a couple of minutes. Operator accepted this for an end-of-day run. The chart is
  saved and restored around the sweep.

  The sweep is slow by design the FIRST time a day is analysed: option
  aggregates are rate-limited to ~5 requests/minute, so a cold run takes
  10-20 minutes. Bars are cached afterwards, so re-runs are seconds.

  Keep this file pure ASCII: PowerShell 5.1 reads .ps1 as ANSI, so a UTF-8 dash
  arrives as three bytes and breaks the parse (it did once already, 2026-08-08).

  Usage (normal PowerShell - no admin needed for a user-scope task):
    .\register-task.ps1
    .\register-task.ps1 -At 14:30
    .\register-task.ps1 -Unregister
#>
param(
  [string]$At = "13:30",
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"
$TaskName = "MTF SPY Streak Research"
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script   = Join-Path $Here "research.mjs"

if ($Unregister) {
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; "Unregistered '$TaskName'." }
  catch { "No task named '$TaskName' was registered." }
  return
}

if (-not (Test-Path $Script)) { throw "research.mjs not found next to this script ($Script)" }
$envFile = Join-Path $Here "research.env"
if (-not (Test-Path $envFile)) {
  throw "research.env not found. Copy .env.example to research.env and fill it in first."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node is not on PATH" }

# node.exe, not the .cmd shim, so Task Scheduler does not flash a console window.
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$Script`"" -WorkingDirectory $Here
# Weekdays only - there are no streaks on a day the market did not open.
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $At
# StartWhenAvailable catches up if the machine was asleep at the trigger time.
# 60 minutes is generous for a cold, rate-limited sweep.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 60)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "Replay the day's SPY breadth streaks against real option bars and publish the research report to the portal." -Force | Out-Null

"Registered '$TaskName' - weekdays at $At on $env:COMPUTERNAME."
"Run it now with:  Start-ScheduledTask -TaskName '$TaskName'"
"Check it with:    Get-ScheduledTaskInfo -TaskName '$TaskName'"
