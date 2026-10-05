# Send one command to the resident hidden-desktop agent and print its answer.
#   powershell -NoProfile -ExecutionPolicy Bypass -File hd-send.ps1 -Cmd "chat #follow 玩家名"
param(
  [Parameter(Mandatory=$true)][string]$Cmd,
  [int]$Timeout = 40,
  [string]$Dir = ''
)
if (-not $Dir) { $Dir = $PSScriptRoot }
$res = Join-Path $Dir 'hd-res.txt'
$req = Join-Path $Dir 'hd-req.txt'
Remove-Item $res -ErrorAction SilentlyContinue
Set-Content -Path $req -Value $Cmd -Encoding UTF8 -NoNewline
for ($i = 0; $i -lt ($Timeout * 4); $i++) {
  Start-Sleep -Milliseconds 250
  if (Test-Path $res) {
    $t = ''
    try { $t = [System.IO.File]::ReadAllText($res) } catch { continue }
    if ($t -and $t.Trim()) { Write-Output $t.Trim(); exit 0 }
    Write-Output '<empty>'; exit 0
  }
}
Write-Output '<timeout>'
exit 1
