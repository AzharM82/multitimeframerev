<#
  Registers the Trade Journal sync as a daily Windows scheduled task.

  Runs on THIS machine (TheMachine, the dev box) - deliberately NOT on DESKTOP1
  or DESKTOP2. Those two run the ToS scanners and the journal must not be
  coupled to them.

  What depends on this task running, and what does not:
    DOES     pulling new Robinhood fills into the portal
    DOES     rebuilding the 10-point lessons list
    DOES NOT reading the Journal tab
    DOES NOT writing or saving a note   <- browser talks to the portal directly

  So if this machine is off, the tab still opens and you can still journal; the
  trades and the summary just catch up on the next run.

  Usage (normal PowerShell - no admin needed for a user-scope task):
  Keep this file pure ASCII: PowerShell 5.1 reads .ps1 as ANSI, so a UTF-8
  em-dash arrives as three bytes and breaks the parse (it did, 2026-08-08).
    .\register-task.ps1
    .\register-task.ps1 -At 18:15
    .\register-task.ps1 -Unregister
#>
param(
  [string]$At = "17:30",
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"
$TaskName = "MTF Trade Journal Sync"
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script   = Join-Path $Here "sync.mjs"

if ($Unregister) {
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; "Unregistered '$TaskName'." }
  catch { "No task named '$TaskName' was registered." }
  return
}

if (-not (Test-Path $Script)) { throw "sync.mjs not found next to this script ($Script)" }
$envFile = Join-Path $Here "journal-sync.env"
if (-not (Test-Path $envFile)) {
  throw "journal-sync.env not found. Copy .env.example to journal-sync.env and fill it in first."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node is not on PATH" }

# node.exe (not the .cmd shim) so Task Scheduler doesn't flash a console window
# over your charts at the trigger time.
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$Script`"" -WorkingDirectory $Here
$trigger = New-ScheduledTaskTrigger -Daily -At $At
# StartWhenAvailable catches up if the machine was asleep at the trigger time.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "Pull Robinhood fills into the MTF portal and rebuild the 10-point lessons list." -Force | Out-Null

"Registered '$TaskName' - daily at $At on $env:COMPUTERNAME."
"Run it now with:  Start-ScheduledTask -TaskName '$TaskName'"
"Check it with:    Get-ScheduledTaskInfo -TaskName '$TaskName'"
