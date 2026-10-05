# Window/input worker. Must be started ON the target desktop (not the user's),
# because EnumWindows / SetForegroundWindow / ClipCursor are all per-desktop.
# Reads one command from hd-cmd.txt, writes the result to hd-res.txt.
# Commands: ping | info | focus | chat <text> | keys <vks> | clip | unclip
param([string]$Dir = '')
if (-not $Dir) { $Dir = $PSScriptRoot }

Add-Type -Namespace W -Name I -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
[DllImport("user32.dll")] public static extern bool GetClipCursor(out RECT r);
[DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr r);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

$CMD = Join-Path $Dir 'hd-cmd.txt'
$RES = Join-Path $Dir 'hd-res.txt'

function Get-Rect([IntPtr]$h) {
  $r = New-Object W.I+RECT
  [void][W.I]::GetWindowRect($h, [ref]$r)
  return "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"
}
function Find-Glfw {
  $script:glfw = [IntPtr]::Zero
  $cb = [W.I+EnumWindowsProc]{
    param($w, $l)
    $sb = New-Object System.Text.StringBuilder 128
    [void][W.I]::GetClassNameW($w, $sb, 128)
    if ($sb.ToString() -match '^GLFW30') { $script:glfw = $w; return $false }
    return $true
  }
  [void][W.I]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:glfw
}
function Send-Key([IntPtr]$h, [int]$vk) {
  [void][W.I]::PostMessageW($h, 0x100, [IntPtr]$vk, [IntPtr]0)
  Start-Sleep -Milliseconds 40
  [void][W.I]::PostMessageW($h, 0x101, [IntPtr]$vk, [IntPtr]0xD0000001)
}
function Send-Char([IntPtr]$h, [char]$c) {
  [void][W.I]::PostMessageW($h, 0x102, [IntPtr][int]$c, [IntPtr]0)
  Start-Sleep -Milliseconds 12
}
function Focus-Glfw([IntPtr]$h) {
  [void][W.I]::ShowWindow($h, 9)
  [void][W.I]::BringWindowToTop($h)
  $ok = [W.I]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 250
  return "setfg=$ok isfg=$([W.I]::GetForegroundWindow() -eq $h) iconic=$([W.I]::IsIconic($h)) rect=$(Get-Rect $h)"
}
function Invoke-Chat([IntPtr]$h, [string]$text) {
  Send-Key $h 0x54
  Start-Sleep -Milliseconds 250
  for ($i = 0; $i -lt 24; $i++) { Send-Key $h 0x08 }   # 清空输入框：可能残留上一次没发出去的字（曾把 "#eta" 变成 "eta#e"）
  Start-Sleep -Milliseconds 80
  foreach ($c in $text.ToCharArray()) { Send-Char $h $c; Start-Sleep -Milliseconds 12 }
  Start-Sleep -Milliseconds 80
  Send-Key $h 0x0D
  return "chat sent hwnd=$h len=$($text.Length)"
}

$line = ''
try { if (Test-Path $CMD) { $line = ([System.IO.File]::ReadAllText($CMD)).Trim() } } catch {}
$sp = $line.IndexOf(' ')
if ($sp -lt 0) { $verb = $line; $rest = '' } else { $verb = $line.Substring(0, $sp); $rest = $line.Substring($sp + 1) }
$out = "unknown command: $verb"
try {
  switch ($verb) {
    'ping'  { $out = 'pong' }
    'info'  {
      $list = New-Object System.Collections.ArrayList
      $fg = [W.I]::GetForegroundWindow()
      $cb = [W.I+EnumWindowsProc]{
        param($w, $l)
        $cb2 = New-Object System.Text.StringBuilder 128
        [void][W.I]::GetClassNameW($w, $cb2, 128)
        $tb = New-Object System.Text.StringBuilder 200
        [void][W.I]::GetWindowTextW($w, $tb, 200)
        [void]$list.Add(("{0} cls={1} vis={2} mini={3} fg={4} rect={5} title={6}" -f $w, $cb2.ToString(), [W.I]::IsWindowVisible($w), [W.I]::IsIconic($w), ($w -eq $fg), (Get-Rect $w), $tb.ToString()))
        return $true
      }
      [void][W.I]::EnumWindows($cb, [IntPtr]::Zero)
      $out = ($list -join ' | ')
    }
    'focus' {
      $h = Find-Glfw
      if ($h -eq [IntPtr]::Zero) { $out = 'no GLFW30 window' } else { $out = "focus $h -> $(Focus-Glfw $h)" }
    }
    'chat'  {
      $h = Find-Glfw
      if ($h -eq [IntPtr]::Zero) { $out = 'no GLFW30 window' } else { $out = "hwnd=$h $(Invoke-Chat $h $rest)" }
    }
    'chatf' {
      $h = Find-Glfw
      if ($h -eq [IntPtr]::Zero) { $out = 'no GLFW30 window' } else { $out = "$(Focus-Glfw $h) ; $(Invoke-Chat $h $rest)" }
    }
    'keys'  {
      $h = Find-Glfw
      if ($h -eq [IntPtr]::Zero) { $out = 'no GLFW30 window' } else {
        $f = Focus-Glfw $h
        $sent = @()
        foreach ($p in $rest.Split(',')) { if ($p.Trim()) { Send-Key $h ([int]$p.Trim()); $sent += $p.Trim() } }
        $out = "$f ; keys=$($sent -join ',')"
      }
    }
    'clip'  {
      $r = New-Object W.I+RECT
      [void][W.I]::GetClipCursor([ref]$r)
      $out = "clip=$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"
    }
    'unclip' { [void][W.I]::ClipCursor([IntPtr]::Zero); $out = 'unclipped' }
  }
} catch { $out = "err: $($_.Exception.Message)" }

# Minecraft grabs the cursor (system-wide ClipCursor) while it believes it is playing,
# which would trap the user's real mouse. Release it, but only when the clip rectangle
# lies inside OUR hidden client's window (never touch a clip owned by someone else).
$notes = @()
try {
  $gh = Find-Glfw
  if ($gh -ne [IntPtr]::Zero) {
    $wr = New-Object W.I+RECT
    [void][W.I]::GetWindowRect($gh, [ref]$wr)
    $cr = New-Object W.I+RECT
    [void][W.I]::GetClipCursor([ref]$cr)
    if ($cr.Left -ge $wr.Left -and $cr.Top -ge $wr.Top -and $cr.Right -le $wr.Right -and $cr.Bottom -le $wr.Bottom) {
      [void][W.I]::ClipCursor([IntPtr]::Zero)
      $notes += "clip $($cr.Left),$($cr.Top),$($cr.Right),$($cr.Bottom) released"
    }
  }
} catch { $notes += "clip check failed" }

if (-not $out) { $out = '(empty)' }
if ($notes.Count) { $out = "$out ; $($notes -join ' ; ')" }
try { [System.IO.File]::WriteAllText($RES, $out) } catch {}
