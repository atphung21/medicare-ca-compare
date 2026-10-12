@echo off
title Medicare Compare
cd /d C:\MedicareCompare
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1"
if errorlevel 1 (
  echo.
  echo Medicare Compare did not open. Leave this window open and read the messages above.
  pause
)
