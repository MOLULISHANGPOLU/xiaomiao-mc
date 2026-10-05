@echo off
title 小喵服务器
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-Content -Raw '%~dp0..\..\config.json' | ConvertFrom-Json; if (-not $c.paths.serverDir -or -not $c.paths.serverJava) { Write-Host '[配置] config.json 的 paths.serverDir / paths.serverJava 还没填 - 先照 AGENTS.md 配置'; Read-Host '回车关闭'; exit 1 }; Set-Location $c.paths.serverDir; $a = @('-Xms1G','-Xmx4G'); if ($c.paths.authlibJar) { $a += ('-javaagent:{0}={1}' -f $c.paths.authlibJar, $c.paths.authlibUrl) }; $a += @('-jar','fabric-server-launch.jar','nogui'); & $c.paths.serverJava @a"
echo.
echo == 服务器已退出 ==
pause