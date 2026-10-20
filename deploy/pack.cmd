@echo off
setlocal
chcp 65001 >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pack.ps1"
if errorlevel 1 exit /b 1

endlocal
