@echo off
setlocal
chcp 65001 >nul 2>&1

set "DISTRO=%~1"
if "%DISTRO%"=="" set "DISTRO=Ubuntu-22.04-new"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -Distro "%DISTRO%"
if errorlevel 1 exit /b 1

endlocal
