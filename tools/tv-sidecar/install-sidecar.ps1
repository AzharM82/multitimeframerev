<#
.SYNOPSIS
    One-time setup for the TradingView sidecar on the trading desktop.

.DESCRIPTION
    Installs a Startup-folder launcher that starts the sidecar at logon, and
    stores TIMER_SECRET as a user environment variable (the value is never
    printed - it goes straight from Azure into the environment).

    The Startup folder is used rather than a Scheduled Task deliberately:
    Register-ScheduledTask requires an elevated shell, and this job only ever
    needs to run as the logged-in user. Pass -UseScheduledTask if you want the
    task instead (that path DOES require "Run as Administrator").

    The sidecar must be running for the portal's Chart Analysis tab to work:
    the cloud cannot reach this machine, so the sidecar polls outbound. It is
    also what launches TradingView on demand.

.PARAMETER StartNow
    Start the sidecar immediately after installing.

.PARAMETER UseScheduledTask
    Register a Scheduled Task instead of a Startup-folder entry. Requires admin.

.PARAMETER Uninstall
    Remove whichever launcher is installed. Leaves the env var in place.

.EXAMPLE
    .\install-sidecar.ps1 -StartNow
#>
[CmdletBinding()]
param(
    [switch]$StartNow,
    [switch]$UseScheduledTask,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$TaskName   = 'MTF TradingView Sidecar'
$SidecarDir = $PSScriptRoot
$Entry      = Join-Path $SidecarDir 'index.js'
$LogFile    = Join-Path $SidecarDir 'sidecar.log'
$StartupDir = [Environment]::GetFolderPath('Startup')
$Launcher   = Join-Path $StartupDir 'mtf-tv-sidecar.vbs'

function Test-TaskExists {
    $null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
}

# Windows PowerShell 5.1's Process objects have no CommandLine property (that
# is a PS7 addition), so process lookup must go through CIM or it silently
# never matches and every "is it running?" check returns false.
function Get-SidecarProcess {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*tv-sidecar*' }
}

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
    $removed = @()
    if (Test-Path $Launcher) { Remove-Item $Launcher -Force; $removed += 'startup launcher' }
    if (Test-TaskExists) {
        try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; $removed += 'scheduled task' }
        catch { Write-Warning "Could not remove the scheduled task (needs admin): $($_.Exception.Message)" }
    }
    Get-Process node -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*tv-sidecar*" } |
        ForEach-Object { Stop-Process -Id $_.Id -Force; $removed += "running process $($_.Id)" }
    if ($removed) { Write-Host "Removed: $($removed -join ', ')" -ForegroundColor Green }
    else { Write-Host "Nothing to remove." -ForegroundColor Yellow }
    exit 0
}

if (-not (Test-Path $Entry)) { throw "Sidecar entry point not found at $Entry" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe not found on PATH." }

# ---------------------------------------------------------------- 1. secret
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

# A User-scope variable is only inherited by processes started AFTER it is set.
# This session (and anything it launches) predates that, so mirror it into the
# current process or -StartNow spawns a sidecar that refuses to run.
$env:TIMER_SECRET = [Environment]::GetEnvironmentVariable('TIMER_SECRET', 'User')

# ---------------------------------------------------------------- 2. launcher
if ($UseScheduledTask) {
    if (Test-TaskExists) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

    $action   = New-ScheduledTaskAction -Execute $node -Argument "`"$Entry`"" -WorkingDirectory $SidecarDir
    $trigger  = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)

    # Register-ScheduledTask raises a CimException that slips past
    # $ErrorActionPreference, so the result is VERIFIED rather than assumed.
    # An earlier version printed "Registered..." after an Access-denied failure.
    try {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
            -Settings $settings -ErrorAction Stop `
            -Description 'Polls the MTF portal for chart-analysis requests and reads TradingView Desktop over CDP.' | Out-Null
    } catch {
        throw "Register-ScheduledTask failed: $($_.Exception.Message)`n" +
              "This path needs an elevated shell. Re-run PowerShell as Administrator, " +
              "or drop -UseScheduledTask to use the Startup folder (no admin required)."
    }
    if (-not (Test-TaskExists)) {
        throw "Register-ScheduledTask reported no error but the task does not exist. Re-run as Administrator."
    }
    Write-Host "Verified scheduled task '$TaskName' is registered (starts at logon)." -ForegroundColor Green
}
else {
    # Hidden launcher: cmd carries the redirection, WScript hides the window.
    $cmd = "cmd /c cd /d ""$SidecarDir"" && ""$node"" ""$Entry"" >> ""$LogFile"" 2>&1"
    $vbs = @"
' Starts the MTF TradingView sidecar at logon, without a console window.
' Generated by install-sidecar.ps1 - edit that script, not this file.
CreateObject("WScript.Shell").Run "$($cmd -replace '"','""')", 0, False
"@
    Set-Content -Path $Launcher -Value $vbs -Encoding ASCII

    if (-not (Test-Path $Launcher)) { throw "Failed to write startup launcher to $Launcher" }
    Write-Host "Verified startup launcher at:" -ForegroundColor Green
    Write-Host "  $Launcher"
    Write-Host "  logs -> $LogFile"
}

# ---------------------------------------------------------------- 3. start
if ($StartNow) {
    $already = Get-Process node -ErrorAction SilentlyContinue |
               Where-Object { $_.CommandLine -like "*tv-sidecar*" }
    if ($already) {
        Write-Host "Sidecar already running (PID $($already.Id -join ', '))." -ForegroundColor Green
    } else {
        if ($UseScheduledTask) { Start-ScheduledTask -TaskName $TaskName }
        else { Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$Launcher`"" -WindowStyle Hidden }

        # Verify it actually came up rather than reporting success blindly.
        # The log line is the definitive signal: wscript -> cmd -> node startup
        # latency made a pure process check report a false negative while the
        # sidecar was in fact running.
        $up = $false
        foreach ($i in 1..20) {
            Start-Sleep -Seconds 1
            if ((Test-Path $LogFile) -and (Select-String -Path $LogFile -Pattern 'sidecar up' -Quiet)) { $up = $true; break }
            if (Get-SidecarProcess) { $up = $true; break }
        }
        if ($up) { Write-Host "Sidecar process is running." -ForegroundColor Green }
        else {
            Write-Warning "Sidecar did not appear within 10s. Check $LogFile"
            if (Test-Path $LogFile) { Get-Content $LogFile -Tail 15 }
        }
    }
}
else {
    Write-Host "Run with -StartNow, or log out and back in, to start it." -ForegroundColor Cyan
}

Write-Host ""
Write-Host "NOTE: the sidecar can only attach to TradingView if it was launched with CDP." -ForegroundColor Yellow
Write-Host "      Use tools\tv-launch.ps1 (not the Start Menu shortcut) to open it." -ForegroundColor Yellow
