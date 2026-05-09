@echo off
REM Finviz → TOS → OCR → WhatsApp scanner — Task Scheduler entry point.
REM Runs one scan cycle (~3-5 min for 50-100 tickers), then exits.
REM Schedule every 10 min during market hours via Windows Task Scheduler.

cd /d C:\Users\reach\MultiTimeframeReversal\tools\chart-ocr
python finviz_scanner.py >> .state\scanner.log 2>&1
