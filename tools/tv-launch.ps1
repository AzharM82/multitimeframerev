<#
.SYNOPSIS
    Launch TradingView Desktop with Chrome DevTools Protocol enabled.

.DESCRIPTION
    The CDP flag only takes effect AT LAUNCH. TradingView opened from the Start
    Menu or taskbar can never be attached to afterwards - it must be closed and
    relaunched through this script. Use this instead of the normal shortcut.

    TradingView is installed as a Microsoft Store (AppX) package, so:
      - the MCP/tooling default paths (%LOCALAPPDATA%\TradingView, Program Files)
        do not exist and any tool searching them will report "not found";
      - the install path is version-stamped
        (TradingView.Desktop_3.3.0.7992_x64__n534cwy3pjxzj), so it MUST be
        resolved dynamically - a hardcoded path breaks at the next auto-update.

.PARAMETER Port
    CDP port. Default 9222 (matches tools/tv-sidecar/config.json).

.PARAMETER Force
    Close any running TradingView first. Required if it was started without the
    CDP flag, since the flag cannot be applied to a live process.

.EXAMPLE
    .\tv-launch.ps1
    .\tv-launch.ps1 -Force
#>
[CmdletBinding()]
param(
    [int]$Port = 9222,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Test-Cdp([int]$p) {
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$p/json/version" -TimeoutSec 2
        return $true
    } catch { return $false }
}

if (Test-Cdp $Port) {
    Write-Host "TradingView is already running with CDP on port $Port." -ForegroundColor Green
    exit 0
}

$running = Get-Process -Name TradingView -ErrorAction SilentlyContinue
if ($running) {
    if (-not $Force) {
        Write-Warning "TradingView is running WITHOUT CDP - the sidecar cannot attach to it."
        Write-Warning "Re-run with -Force to close and relaunch it (unsaved layout changes may be lost)."
        exit 1
    }
    Write-Host "Closing $($running.Count) TradingView process(es)..." -ForegroundColor Yellow
    $running | Stop-Process -Force
    Start-Sleep -Seconds 3
}

$pkg = Get-AppxPackage -Name TradingView.Desktop
if (-not $pkg) { throw "TradingView.Desktop AppX package not found. Is TradingView installed from the Microsoft Store?" }

$exe = Join-Path $pkg.InstallLocation 'TradingView.exe'
if (-not (Test-Path $exe)) { throw "Executable not found at $exe" }

Write-Host "Launching TradingView $($pkg.Version) with --remote-debugging-port=$Port" -ForegroundColor Cyan
Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port"

# Cold start restores every saved tab, which takes a while on a large layout.
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-Cdp $Port) {
        Write-Host "CDP is up on port $Port." -ForegroundColor Green
        exit 0
    }
}

throw "TradingView launched but CDP never came up on port $Port within 90s."
