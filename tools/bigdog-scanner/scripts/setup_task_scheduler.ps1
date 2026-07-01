# Registers the BigDog Trades scanner as a Windows Scheduled Task on DESKTOP2.
# Runs every 5 min from 6:25 AM for 6h35m (~1:00 PM PT); the script self-gates
# on market hours so extra fires are harmless. RunLevel Highest is REQUIRED —
# TOS runs elevated and Windows UIPI drops synthetic keystrokes from a
# non-elevated sender.
#
# Usage (from an elevated PowerShell):
#   .\setup_task_scheduler.ps1
#
# First run: launch the scanner once from a terminal to pick + save the TOS
# window ( python bigdog_scanner.py --force --pick-window ), then schedule.

param(
    [string]$TaskName = "BigDogScanner",
    [string]$StartTime = "6:25AM"
)

$ErrorActionPreference = "Stop"
$bat = Join-Path $PSScriptRoot "run_bigdog.bat"
if (-not (Test-Path $bat)) { throw "run_bigdog.bat not found at $bat" }

$action = New-ScheduledTaskAction -Execute $bat

$trigger = New-ScheduledTaskTrigger -Daily -At $StartTime
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $StartTime `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Hours 6 -Minutes 35)).Repetition

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 4) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force

Write-Host "Registered scheduled task '$TaskName' (every 5 min, ${StartTime}+6h35m, RunLevel Highest)."
Write-Host "Weekday + market-hours gating is handled inside bigdog_scanner.py."
