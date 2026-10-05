# Resident hidden-desktop agent (survivor process).
# Lives on the normal desktop, HOLDS the isolated desktop alive, and starts
# programs ON that desktop via CreateProcessW(lpDesktop = winsta0\<Desktop>).
# Requests come in through files so the caller needs no window/handle access.
#   request file: hd-req.txt          result file: hd-res.txt
#   worker cmd  : hd-cmd.txt          log file   : hd-agent.log
# Verbs: alive | launch [args] | quit | <anything else>  (anything else is handed
#        to hd-worker.ps1 which runs on the isolated desktop and writes hd-res.txt)
param(
  [string]$Desktop = 'mewdesk',
  [string]$Dir = ''
)
if (-not $Dir) { $Dir = $PSScriptRoot }   # 默认就在本文件所在目录
# 统一配置：仓库根 config.json
$CFG = Get-Content (Join-Path (Join-Path $PSScriptRoot '..\..') 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json

Add-Type -Namespace A -Name G -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateDesktopW(string name, IntPtr dev, IntPtr dm, int flags, uint access, IntPtr sa);
[DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr OpenDesktopW(string name, int flags, bool inherit, uint access);
[DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr h);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
[DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO {
  public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
  public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
  public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
  public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
}
[StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
[DllImport("user32.dll")] public static extern bool GetClipCursor(out RECT r);
[DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr r);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

$REQ = Join-Path $Dir 'hd-req.txt'
$RES = Join-Path $Dir 'hd-res.txt'
$CMD = Join-Path $Dir 'hd-cmd.txt'
$LOG = Join-Path $Dir 'hd-agent.log'
$NODE = if ($CFG.paths.nodeExe) { [string]$CFG.paths.nodeExe } else { 'node.exe' }
$DESKTOP_STR = "winsta0\$Desktop"
$ACCESS = 0x10000000
$CREATE_NO_WINDOW = 0x08000000

function Log([string]$m) {
  try { Add-Content -Path $LOG -Value ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 } catch {}
}
function Start-OnDesktop([string]$exe, [string]$argline, [string]$cwd, [uint32]$flags = 0) {
  $si = New-Object A.G+STARTUPINFO
  $si.cb = [Runtime.InteropServices.Marshal]::SizeOf([type][A.G+STARTUPINFO])
  $si.lpDesktop = $DESKTOP_STR
  $pi = New-Object A.G+PROCESS_INFORMATION
  $cmd = '"' + $exe + '"'
  if ($argline) { $cmd += ' ' + $argline }
  $ok = [A.G]::CreateProcessW($exe, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, $flags, [IntPtr]::Zero, $cwd, [ref]$si, [ref]$pi)
  if (-not $ok) { return @{ ok = $false; pid = 0; err = [Runtime.InteropServices.Marshal]::GetLastWin32Error() } }
  [void][A.G]::CloseHandle($pi.hThread)
  return @{ ok = $true; pid = $pi.dwProcessId; err = 0; handle = $pi.hProcess }
}
function Set-Res([string]$t) { try { [System.IO.File]::WriteAllText($RES, $t) } catch {} }

# Clip guard. Minecraft (including our hidden client) calls the session-wide ClipCursor
# while it believes it is playing, which traps the user's real mouse inside that window's
# rectangle (our hidden client is only 441x277). hd-worker releases such a clip, but only
# when it is invoked - i.e. only when a command is sent. So an unprompted clip stays until
# the next command. This runs every 5 loops (~1.5s):
#   clip == whole screen      -> nothing is locked, skip
#   clip == foreground window -> the foreground app locked it itself, legitimate, never touch
#   anything else             -> a stray clip from another desktop, release it and log
function Test-ClipGuard {
  try {
    $cr = New-Object A.G+RECT
    if (-not [A.G]::GetClipCursor([ref]$cr)) { return $null }
    $cx = [A.G]::GetSystemMetrics(0)
    $cy = [A.G]::GetSystemMetrics(1)
    if ($cr.Left -eq 0 -and $cr.Top -eq 0 -and $cr.Right -eq $cx -and $cr.Bottom -eq $cy) { return $null }
    $fgTxt = 'none'
    $h = [A.G]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero) {
      $fr = New-Object A.G+RECT
      if ([A.G]::GetWindowRect($h, [ref]$fr)) {
        $fgTxt = "$($fr.Left),$($fr.Top),$($fr.Right),$($fr.Bottom)"
        $tol = 8
        if ([Math]::Abs($cr.Left - $fr.Left) -le $tol -and [Math]::Abs($cr.Top - $fr.Top) -le $tol -and [Math]::Abs($cr.Right - $fr.Right) -le $tol -and [Math]::Abs($cr.Bottom - $fr.Bottom) -le $tol) { return $null }
      }
    }
    [void][A.G]::ClipCursor([IntPtr]::Zero)
    return "stray clip $($cr.Left),$($cr.Top),$($cr.Right),$($cr.Bottom) released (fg=$fgTxt)"
  } catch { return $null }
}

$hDesk = [A.G]::CreateDesktopW($Desktop, [IntPtr]::Zero, [IntPtr]::Zero, 0, $ACCESS, [IntPtr]::Zero)
$created = $true
if ($hDesk -eq [IntPtr]::Zero) {
  $created = $false
  $hDesk = [A.G]::OpenDesktopW($Desktop, 0, $false, $ACCESS)
}
if ($hDesk -eq [IntPtr]::Zero) {
  Log "desktop failed err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  Set-Res "agent desktop failed"
  exit 1
}
Log "agent start pid=$PID desktop=$Desktop created=$created desk=$hDesk dir=$Dir"
Set-Res "agent ready"

$n = 0
while ($true) {
  Start-Sleep -Milliseconds 300
  $n++
  if ($n % 200 -eq 0) { Log "alive $n desk=$hDesk" }
  if ($n % 5 -eq 0) { $g = Test-ClipGuard; if ($g) { Log "guard: $g" } }
  if (-not (Test-Path $REQ)) { continue }
  $line = $null
  try { $line = [System.IO.File]::ReadAllText($REQ) } catch { continue }
  if (-not $line) { continue }
  $line = $line.Trim()
  try { [System.IO.File]::WriteAllText($REQ, '') } catch {}
  if (-not $line) { continue }
  Log "req: $line"
  if ($line -eq 'quit') { Set-Res 'bye'; break }
  if ($line -eq 'alive') { Set-Res "agent alive pid=$PID desk=$hDesk"; continue }
  $sp = $line.IndexOf(' ')
  if ($sp -lt 0) { $verb = $line; $rest = '' } else { $verb = $line.Substring(0, $sp); $rest = $line.Substring($sp + 1) }
  if ($verb -eq 'launch') {
    $argline = (Join-Path $Dir 'launch-mew.mjs')
    if ($rest) { $argline += ' ' + $rest }
    $r = Start-OnDesktop $NODE $argline $Dir 0
    if ($r.ok) { Set-Res "launched pid=$($r.pid)"; Log "launch ok pid=$($r.pid)" } else { Set-Res "launch failed err=$($r.err)"; Log "launch failed err=$($r.err)" }
    continue
  }
  # everything else: run the worker on the isolated desktop (it writes hd-res.txt)
  try { [System.IO.File]::WriteAllText($CMD, $line) } catch { Log "cmd write failed" }
  Remove-Item $RES -ErrorAction SilentlyContinue
  $psExe = if ($CFG.paths.powershellExe) { [string]$CFG.paths.powershellExe } else { 'powershell.exe' }
  $w = Start-OnDesktop $psExe ("-NoProfile -ExecutionPolicy Bypass -File `"$Dir\hd-worker.ps1`"") $Dir $CREATE_NO_WINDOW
  if (-not $w.ok) { Set-Res "worker launch failed err=$($w.err)"; Log "worker launch failed err=$($w.err)" }
  else {
    [void][A.G]::WaitForSingleObject($w.handle, 30000)
    [void][A.G]::CloseHandle($w.handle)
    Log "worker pid=$($w.pid) done"
  }
}
Log 'agent exit'
[void][A.G]::CloseDesktop($hDesk)
