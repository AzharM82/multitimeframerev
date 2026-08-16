# Registers "TradingView CDP Launch" - starts TradingView Desktop WITH the
# remote-debugging port at logon.
#
# Why this exists: --remote-debugging-port only applies at LAUNCH. A normal
# Start-Menu launch or a reboot silently produces a TradingView with no CDP, and
# the AVWAP publisher then exits 2 every 10 minutes until someone notices. This
# task makes the flagged launch the default on this machine.
#
# Run from an elevated PowerShell:  .\setup_tv_launch_task.ps1

$ErrorActionPreference = "Stop"

# The package NAME is 31178TradingViewInc.TradingView. "TradingView.Desktop" is
# the Application Id inside AppxManifest.xml and resolves to nothing here
# (verified on DESKTOP2, 2026-08-15). The install path is version-stamped, so it
# is resolved at run time, never hardcoded.
$pkg = Get-AppxPackage -Name 31178TradingViewInc.TradingView
if (-not $pkg) {
    throw ("TradingView Desktop AppX package not found. Install it from the " +
           "STORE: winget install --id 9NDJWKSTBT25 --source msstore  " +
           "(the TradingView.TradingViewDesktop winget-source package is not " +
           "an AppX and Get-AppxPackage will never see it).")
}
$exe = Join-Path $pkg.InstallLocation "TradingView.exe"
if (-not (Test-Path $exe)) { throw "TradingView.exe not found at $exe" }

Write-Host "Found TradingView $($pkg.Version) at $exe"

# Resolve the path again at run time so a TradingView update does not leave the
# task pointing at a version directory that no longer exists.
$cmd = @'
$p = Get-AppxPackage -Name 31178TradingViewInc.TradingView
if ($p) { Start-Process (Join-Path $p.InstallLocation 'TradingView.exe') -ArgumentList '--remote-debugging-port=9222' }
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -EncodedCommand $encoded"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask -TaskName "TradingView CDP Launch" `
    -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "Task 'TradingView CDP Launch' registered (at logon)."
Write-Host ""
Write-Host "To apply it NOW without logging out: close TradingView completely, then"
Write-Host "  Start-ScheduledTask -TaskName 'TradingView CDP Launch'"
Write-Host "Verify with:  curl http://localhost:9222/json/version"
Write-Host "(Port-open does not mean app-ready - /json/list can block for tens of"
Write-Host " seconds while TradingView restores its tabs.)"
