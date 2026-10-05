param(
  [Parameter(Mandatory=$true)][string]$TextFile,
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Voice = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
if ($Voice -ne '') {
  $pick = $all | Where-Object { $_.Id -match $Voice -or $_.DisplayName -match $Voice } | Select-Object -First 1
  if ($null -eq $pick) { throw "找不到语音: $Voice" }
  $synth.Voice = $pick
}
Write-Output ("使用语音: " + $synth.Voice.DisplayName + " (" + $synth.Voice.Id + ")")
$stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$size = [uint32]$stream.Size
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
$null = Await ($reader.LoadAsync($size)) ([uint32])
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
[System.IO.File]::WriteAllBytes($Out, $bytes)
Write-Output ("已写出: " + $Out + "  " + $size + " 字节")
