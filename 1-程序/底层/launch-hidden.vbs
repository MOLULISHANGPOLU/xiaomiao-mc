' LittleMew Home: one-click hidden launch (server + LittleMew body + game auto-join)
' ASCII-only on purpose: WScript reads .vbs as ANSI, so a Chinese path written into
' this file would come out as mojibake and clicking the shortcut would do nothing.
' The folder is taken from this script's own location at runtime instead, so the
' file keeps working wherever it gets moved to.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
q = Chr(34)
d = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = d
' Find node.exe: prefer the default installer location, else rely on PATH.
nodeExe = "node"
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
  nodeExe = "C:\Program Files\nodejs\node.exe"
End If
sh.Run q & nodeExe & q & " " & q & d & "\launch.mjs" & q, 0, False