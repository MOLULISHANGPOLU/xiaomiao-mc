@echo off
title 小喵 · 一键启动
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1"
echo.
echo ------------------------------------------
echo  这个窗口可以直接关掉（服务器/大脑各有自己的窗口）
echo ------------------------------------------
pause