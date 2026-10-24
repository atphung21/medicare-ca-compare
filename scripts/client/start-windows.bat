@echo off
title Medicare Compare
cd /d C:\MedicareCompare
rem Always run the launcher inside the install folder, so a copy of this file on the desktop still gets updates.
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\MedicareCompare\scripts\client\start-windows.ps1"
if errorlevel 1 (
  echo.
  echo Medicare Compare did not open. Leave this window open and read the messages above.
  pause
)
