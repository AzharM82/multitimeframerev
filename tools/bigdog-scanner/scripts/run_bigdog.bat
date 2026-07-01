@echo off
REM BigDog Trades scanner — Task Scheduler entry point.
REM Runs one scan cycle; the script self-gates on market hours.
set PYTHONIOENCODING=utf-8
cd /d "%~dp0\..\scanner"
python bigdog_scanner.py < NUL >> "%~dp0\..\scanner\.state\bigdog.log" 2>&1
