@echo off
REM WA Sidecar watchdog — entry point for the "WA Sidecar Watchdog" task (5 min).
cd /d "%~dp0"

REM Absolute node path (Task Scheduler may not inherit the user PATH), and
REM CRITICALLY: watchdog.log is NOT redirected here. watchdog.js appendFileSync's
REM it directly, and cmd holding the same file open for a redirect makes those
REM appends fail silently. stdout is discarded; stderr goes to its own file,
REM which should stay 0 bytes when things are healthy.
"C:\Program Files\nodejs\node.exe" watchdog.js 1>NUL 2>> "%~dp0watchdog_boot.log"
