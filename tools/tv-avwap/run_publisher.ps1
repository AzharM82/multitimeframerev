# Operator helper: run the AVWAP publisher by hand, or register its scheduled task.
#
#   .\run_publisher.ps1              - preflight, dry-run, then PUBLISH for real
#   .\run_publisher.ps1 -DryRunOnly  - preflight + dry-run, publishes nothing
#   .\run_publisher.ps1 -RegisterTask- register the every-10-min RTH task (ELEVATED)
#
# Deliberately runs a --dry-run first: the publisher fails closed on a wrong
# chart (exit 3/4), and it is better to learn that without a publish attempt.
# ASCII only - Windows PowerShell 5.1 decodes BOM-less UTF-8 as ANSI and
# mangles non-ASCII inside string literals.

[CmdletBinding()]
param(
    [switch]$DryRunOnly,
    [switch]$RegisterTask
)

$ErrorActionPreference = "Stop"
$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = "C:\Program Files\nodejs\node.exe"

function Explain([int]$code) {
    switch ($code) {
        0  { "OK (published, or dry-run, or outside the market window)" }
        1  { "TIMER_SECRET missing from .env" }
        2  { "TradingView CDP unreachable, or no chart target. Is TradingView running with --remote-debugging-port=9222?" }
        3  { "chart preflight failed" }
        4  { "WRONG CHART - resolution is not 39, or a level could not be resolved off the chart" }
        5  { "watchlist not found or empty" }
        6  { "sweep produced no readable rows" }
        7  { "publish REJECTED by the cloud (usually a bad TIMER_SECRET)" }
        8  { "another sweep holds the .sweep.lock" }
        10 { "unhandled error" }
        default { "unrecognised exit code" }
    }
}

if ($RegisterTask) {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
              [Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Registering the task needs an ELEVATED PowerShell. Re-open as Administrator."
    }
    & "$dir\setup_publisher_task.ps1"
    exit $LASTEXITCODE
}

# --- preconditions -----------------------------------------------------------
Write-Host "== preconditions ==" -ForegroundColor Cyan

try {
    $v = Invoke-RestMethod -Uri "http://localhost:9222/json/version" -TimeoutSec 20
    Write-Host ("  CDP        : OK  ({0})" -f $v.Browser)
} catch {
    throw "CDP not answering on 9222. TradingView must be LAUNCHED with --remote-debugging-port=9222 (Start-ScheduledTask -TaskName 'TradingView CDP Launch')."
}

if (-not (Test-Path "$dir\.env")) { throw ".env missing in $dir" }
$envLines = Get-Content "$dir\.env"
foreach ($key in @("TIMER_SECRET", "TV_CHART_URL")) {
    $line = $envLines | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
    $val  = if ($line) { ($line -split '=', 2)[1] } else { $null }
    if (-not $val -or -not $val.Trim()) { throw "$key is empty in .env" }
    if ($key -eq "TIMER_SECRET") { Write-Host "  TIMER_SECRET: set" }
    else { Write-Host ("  {0}: {1}" -f $key, $val) }
}

# --- dry run -----------------------------------------------------------------
Write-Host "`n== dry run (publishes nothing) ==" -ForegroundColor Cyan
& $node "$dir\publish_avwap.mjs" --force --dry-run --limit 5
$rc = $LASTEXITCODE
Write-Host ("  exit {0}: {1}" -f $rc, (Explain $rc))

if ($rc -ne 0) {
    # In -DryRunOnly the failure IS the result, so report it and exit with the
    # publisher's own code rather than throwing a "not publishing" error at
    # someone who never asked to publish.
    if ($DryRunOnly) {
        Write-Host "`nDry run failed (exit $rc). Run 'node inventory.mjs' to see what is on the chart." -ForegroundColor Red
        exit $rc
    }
    throw "Dry run failed (exit $rc) - NOT publishing. Run 'node inventory.mjs' to see what is on the chart."
}

if ($DryRunOnly) { Write-Host "`nDry run clean. -DryRunOnly set, so stopping here." -ForegroundColor Green; exit 0 }

# --- real publish ------------------------------------------------------------
Write-Host "`n== PUBLISHING FOR REAL ==" -ForegroundColor Yellow
$sw = [Diagnostics.Stopwatch]::StartNew()
& $node "$dir\publish_avwap.mjs" --force
$rc = $LASTEXITCODE
$sw.Stop()
Write-Host ("  exit {0}: {1}" -f $rc, (Explain $rc))
Write-Host ("  elapsed {0:N1}s" -f $sw.Elapsed.TotalSeconds)
if ($rc -eq 0) {
    Write-Host "`nPublished. Check the portal's 'AVWAP from Earnings' tab (#avwap):" -ForegroundColor Green
    Write-Host "  expect ~193 rows, host=DESKTOP2, and a fresh Published timestamp."
}
exit $rc
