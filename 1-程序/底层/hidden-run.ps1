# Run a command on an isolated Windows desktop, so its windows never appear on
# the user's desktop and its input focus does not fight the user's windows.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File hidden-run.ps1 -Exe <path> [-Args "<string>"] [-Desktop mewdesk] [-WorkDir <dir>]
param(
  [string]$Desktop = 'mewdesk',
  [Parameter(Mandatory=$true)][string]$Exe,
  [string]$Args = '',
  [string]$WorkDir = ''
)
if (-not $WorkDir) { $WorkDir = $PSScriptRoot }

Add-Type -Namespace H -Name D -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateDesktopW(string name, IntPtr dev, IntPtr dm, int flags, uint access, IntPtr sa);
[DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr OpenDesktopW(string name, int flags, bool inherit, uint access);
[DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr h);
[DllImport("user32.dll", SetLastError=true)] public static extern bool EnumDesktopWindows(IntPtr h, EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO {
  public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
  public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
  public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
  public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
}
[StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
'@

$ACCESS = 0x10000000   # GENERIC_ALL
$h = [H.D]::CreateDesktopW($Desktop, [IntPtr]::Zero, [IntPtr]::Zero, 0, $ACCESS, [IntPtr]::Zero)
if ($h -eq [IntPtr]::Zero) { $h = [H.D]::OpenDesktopW($Desktop, 0, $false, $ACCESS) }
if ($h -eq [IntPtr]::Zero) {
  Write-Output "desktop failed err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  exit 1
}

# list windows currently on that desktop (handy for verification)
$names = New-Object System.Collections.ArrayList
$cb = [H.D+EnumWindowsProc]{
  param($w, $l)
  $sb = New-Object System.Text.StringBuilder 128
  [void][H.D]::GetClassNameW($w, $sb, 128)
  [void]$names.Add("${w}:$($sb.ToString())")
  return $true
}
[void][H.D]::EnumDesktopWindows($h, $cb, [IntPtr]::Zero)

if (-not $Args) { $Args = '' }
$si = New-Object H.D+STARTUPINFO
$si.cb = [Runtime.InteropServices.Marshal]::SizeOf([type][H.D+STARTUPINFO])
$si.lpDesktop = "winsta0\$Desktop"
$pi = New-Object H.D+PROCESS_INFORMATION
$cmdline = '"' + $Exe + '"'
if ($Args) { $cmdline += ' ' + $Args }
$ok = [H.D]::CreateProcessW($Exe, $cmdline, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0, [IntPtr]::Zero, $WorkDir, [ref]$si, [ref]$pi)
if (-not $ok) {
  Write-Output "launch failed err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()) cmd=$cmdline"
  [void][H.D]::CloseDesktop($h)
  exit 1
}
[void][H.D]::CloseHandle($pi.hProcess)
[void][H.D]::CloseHandle($pi.hThread)
Write-Output "started pid=$($pi.dwProcessId) desktop=$Desktop windows_before=[$($names -join ', ')]"
[void][H.D]::CloseDesktop($h)
