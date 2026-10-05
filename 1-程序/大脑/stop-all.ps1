# 小喵 · 一键关闭（顺序：大脑 → 监视窗口 → 隐身客户端 → 服务器 → 收尾窗口）
$ErrorActionPreference = 'SilentlyContinue'
$CFG = Get-Content (Join-Path $PSScriptRoot '..\..\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$UND = (Resolve-Path (Join-Path $PSScriptRoot '..\底层')).Path   # 底层脚本目录
function Say($m) { Write-Host $m }

Write-Host ''
Write-Host '=================================================='
Write-Host '      小喵 · 关闭（大脑 / 窗口 / 身体 / 服务器）'
Write-Host '=================================================='

# ---------- ① 大脑 ----------
$brains = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*voice-ai.cjs*' }
if ($brains) {
  foreach ($b in $brains) { Say "关大脑 (pid $($b.ProcessId))"; Stop-Process -Id $b.ProcessId -Force }
} else { Say '大脑：没在跑' }

# ---------- ② 监视窗口（独立 Edge profile mew-ai-ui，只杀小喵自己的那扇窗口） ----------
$edge = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*mew-ai-ui*' }
if ($edge) {
  foreach ($e in $edge) { Say "关监视窗口 (pid $($e.ProcessId))"; Stop-Process -Id $e.ProcessId -Force }
} else { Say '监视窗口：没开' }

# ---------- ③ 隐身客户端 ----------
$pidFile = Join-Path $UND 'mew-client.pid'
if (Test-Path $pidFile) {
  $cp = [int]((Get-Content $pidFile -Raw).Trim())
  if (Get-Process -Id $cp -ErrorAction SilentlyContinue) { Say "关隐身客户端 (pid $cp)"; Stop-Process -Id $cp -Force }
  else { Say '隐身客户端：没在跑（pid 文件是旧的）' }
  Remove-Item $pidFile -Force
} else { Say '隐身客户端：没在跑' }

# ---------- ④ 服务器 ----------
$rcon = Join-Path $UND 'rcon.mjs'
$wasUp = Test-NetConnection 127.0.0.1 -Port 25565 -InformationLevel Quiet -WarningAction SilentlyContinue
if ($wasUp) {
  Say '让服务器自己保存并退出…'
  & node $rcon 'stop' | Out-Null
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Test-NetConnection 127.0.0.1 -Port 25565 -InformationLevel Quiet -WarningAction SilentlyContinue)) { break }
  }
}
$srvPat = '*' + ([string]$CFG.paths.serverDir).TrimEnd('\') + '*'   # 按你配置的服务器目录认进程
$srv = Get-CimInstance Win32_Process -Filter "Name='java.exe' OR Name='javaw.exe'" | Where-Object { $_.CommandLine -like $srvPat }
if ($srv) { foreach ($s in $srv) { Say "关服务器 (pid $($s.ProcessId))"; Stop-Process -Id $s.ProcessId -Force } }
elseif ($wasUp) { Say '服务器：已经退出了' }
else { Say '服务器：没在跑' }

# ---------- ⑤ 收尾：关残留 cmd 窗口（服务器/大脑，因 pause 停在那不自动关） ----------
Start-Sleep -Seconds 1
$win = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*server.cmd*' -or $_.CommandLine -like '*brain.cmd*' }
if ($win) { foreach ($w in $win) { Say "关窗口 (pid $($w.ProcessId))"; Stop-Process -Id $w.ProcessId -Force } }

Write-Host ''
Say '都关掉了。想回来就双击桌面上的「小喵」。'
Write-Host ''
