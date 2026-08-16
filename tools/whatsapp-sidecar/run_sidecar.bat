@echo off
REM WhatsApp sidecar — Task Scheduler entry point ("WA Sidecar" task).
REM cd first so dotenv (.env) and LocalAuth (.wwebjs_auth) resolve relative to
REM this directory — the task itself must not rely on its WorkingDirectory.
cd /d "%~dp0"

REM Rotate sidecar.log past ~20 MB, keeping one previous generation. A wedged
REM send path retries once a minute and has bloated this to ~48 MB in a day.
if exist "sidecar.log" (
  for %%A in ("sidecar.log") do (
    if %%~zA GTR 20000000 (
      if exist "sidecar.1.log" del /q "sidecar.1.log"
      move /y "sidecar.log" "sidecar.1.log" >NUL
    )
  )
)

REM Absolute node path: Task Scheduler does not always inherit the user PATH.
REM cmd's append redirect is the ONLY writer of sidecar.log (index.js logs to
REM stdout/stderr, never appendFileSync) — do not add a second writer here.
"C:\Program Files\nodejs\node.exe" src\index.js >> "%~dp0sidecar.log" 2>&1
