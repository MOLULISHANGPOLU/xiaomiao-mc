@echo off
title Ð¡ß÷ - ¹Ø±Õ
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-all.ps1"
echo.
pause
