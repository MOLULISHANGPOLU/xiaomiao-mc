# 小喵 · 一键启动
# 起三件：① MC 服务器 ② 隐身客户端（独立隐藏桌面）③ 独立大脑 voice-ai.cjs（自带监视窗口）
# 已经在跑的那件会自动跳过。过程写进本目录 launcher.log。
$ErrorActionPreference = 'Continue'
# 统一配置：仓库根 config.json（唯一要改的配置文件）
$CFG = Get-Content (Join-Path $PSScriptRoot '..\..\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$BOT = if ($CFG.players.bot) { [string]$CFG.players.bot } else { 'LittleMew' }
$DIR = $PSScriptRoot                                # 本文件所在目录（大脑）
$MC  = (Resolve-Path (Join-Path $PSScriptRoot '..\底层')).Path   # 底层脚本目录
$LOG = Join-Path $DIR 'launcher.log'

function Say([string]$m) {
  $line = '{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
  try { Add-Content -LiteralPath $LOG -Value $line -Encoding UTF8 } catch {}
}
function PortUp([int]$p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}
function ProcByCmd([string]$name, [string]$pat) {
  return @(Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match $pat })
}
function ClientAlive() {
  $f = Join-Path $MC 'mew-client.pid'
  if (-not (Test-Path $f)) { return $null }
  $v = (Get-Content -LiteralPath $f -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($v -notmatch '^\d+$') { return $null }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$v)" -ErrorAction SilentlyContinue
  if ($p -and $p.Name -match '^javaw?\.exe$' -and $p.CommandLine -match 'mew') { return [int]$v }
  return $null
}
function BrainAlive() {
  $a = ProcByCmd 'node.exe' 'voice-ai\.cjs'
  if ($a.Count -gt 0) { return $a[0].ProcessId }
  return $null
}
function RconList() {                       # 问服务器「谁在线」——进程活着不等于真连上了
  try { return (& node (Join-Path $MC 'rcon.mjs') list 2>&1 | Out-String) } catch { return '' }
}
function BrainUp() {                       # 认端口最保险：命令行匹配偶尔查不到，但 8799 在听就说明大脑活着
  if (BrainAlive) { return $true }
  return [bool](Get-NetTCPConnection -LocalPort 8799 -State Listen -ErrorAction SilentlyContinue)
}

Write-Host ''
Write-Host '=================================================='
Write-Host '      小喵 · 一键启动（服务器 / 身体 / 大脑）'
Write-Host '=================================================='

# ---------- ① MC 服务器 ----------
Say '检查 MC 服务器…'
if (PortUp 25565) {
  Say '服务器已经在跑了，跳过。'
} else {
  Say '正在开服务器（内存上限 4G；第一次要等它把世界读出来）…'
  Start-Process -FilePath (Join-Path $DIR 'server.cmd') -WorkingDirectory $DIR -WindowStyle Minimized
  $ok = $false
  for ($i = 0; $i -lt 150; $i++) {
    Start-Sleep -Seconds 2
    if (PortUp 25565) { $ok = $true; break }
    if ($i % 10 -eq 9) { Say ('  还在开…（已等 {0} 秒）' -f (($i + 1) * 2)) }
  }
  if ($ok) { Say '服务器已就绪（端口 25565）。' }
  else { Say '！等了 5 分钟服务器还没起来，先往下走；请看看「小喵服务器」那个窗口里的报错。' }
}

# ---------- ② 隐身客户端 ----------
Say ('检查 {0} 隐身客户端…' -f $BOT)
if ((RconList) -match $BOT) {
  Say ('{0} 已经在服务器里，跳过。' -f $BOT)
} else {
  $clientPid = ClientAlive
  if ($clientPid) {
    Say ('客户端进程在跑（pid {0}）但没连上服务器，先关掉再重开。' -f $clientPid)
    Stop-Process -Id $clientPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    Remove-Item -LiteralPath (Join-Path $MC 'mew-client.pid') -Force -ErrorAction SilentlyContinue
  }

  $agent = @(ProcByCmd 'powershell.exe' 'hd-agent\.ps1')
  if ($agent.Count -eq 0) { $agent = @(ProcByCmd 'pwsh.exe' 'hd-agent\.ps1') }
  if ($agent.Count -gt 1) {
    # 多个代理会同时响应 launch → 双客户端 → 服务器重复登录 → 粉红小方块。只留一个，杀掉其余。
    for ($i = 1; $i -lt $agent.Count; $i++) {
      Say ('清理多余的隐藏桌面代理（pid {0}）。' -f $agent[$i].ProcessId)
      Stop-Process -Id $agent[$i].ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    Say ('隐藏桌面代理已在跑（pid {0}），已清理 {1} 个重复。' -f $agent[0].ProcessId, ($agent.Count - 1))
  } elseif ($agent.Count -eq 1) {
    Say ('隐藏桌面代理已在跑（pid {0}）。' -f $agent[0].ProcessId)
  } else {
    Say '启动隐藏桌面代理…'
    Start-Process -FilePath 'powershell.exe' -WorkingDirectory $MC -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $MC 'hd-agent.ps1'), '-Desktop', 'mewdesk', '-Dir', $MC
    )
    Start-Sleep -Seconds 3
  }

  Say '让隐身客户端登录服务器…'
  $r = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $MC 'hd-send.ps1') -Cmd 'launch' -Timeout 90 2>&1 | Out-String
  $r = ($r.Trim() -replace '\s+', ' ')
  if ($r -match 'timeout' -or $r -eq '') { Say '！客户端启动没等到回话，先往下走（可看 launch-mew.log）。' }
  else { Say ('客户端回应：' + $r) }

  $joined = $false
  for ($i = 0; $i -lt 30; $i++) {                 # 最多等 2 分钟看它真进服务器
    Start-Sleep -Seconds 4
    if ((RconList) -match $BOT) { $joined = $true; break }
  }
  if ($joined) { Say ('{0} 已上线（pid {1}）。' -f $BOT, (ClientAlive)) }
  else { Say ('！{0} 没能进服务器：看 底层\launch-mew.log 与客户端日志（多半是登录票据问题）。' -f $BOT) }
}

# ---------- ③ 独立大脑 ----------
Say '检查独立大脑…'
if (BrainUp) {
  $brainPid = BrainAlive
  if ($brainPid) { Say ('大脑已经在跑（pid {0}），跳过。' -f $brainPid) }
  else { Say '大脑已经在跑（监视端口 8799 在听），跳过。' }
} else {
  Say '启动独立大脑（它自己会弹出监视窗口）…'
  Start-Process -FilePath (Join-Path $DIR 'brain.cmd') -WorkingDirectory $DIR -WindowStyle Minimized
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    if (BrainUp) { break }
  }
  if (BrainUp) { Say ('大脑已启动（pid {0}）。' -f ($(if (BrainAlive) { BrainAlive } else { '未知' }))) }
  else { Say '！大脑没起来，看看「小喵大脑」那个窗口里的报错。' }
}

# ---------- ③b 大脑去重：同时点两次启动会有两个大脑抢麦克风；只留 8799 的属主 ----------
$brains = @(ProcByCmd 'node.exe' 'voice-ai\.cjs')
if ($brains.Count -gt 1) {
  $owner = (Get-NetTCPConnection -LocalPort 8799 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
  foreach ($b in $brains) {
    if ($b.ProcessId -ne $owner) {
      Say ('清理多余的大脑进程（pid {0}），免得两个耳朵抢麦克风。' -f $b.ProcessId)
      Stop-Process -Id $b.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host ''
Say '三件检查完毕。'
Write-Host '  · 监视窗口：http://127.0.0.1:8799/     （大脑会自己弹出来；关掉网页不影响大脑）'
Write-Host '  · 进游戏喊「小喵」就能说话，回话会出现在聊天框里。'
Write-Host '  · 服务器窗口里敲 stop 关服；「小喵大脑」窗口关掉即停止听。'
Write-Host ''
