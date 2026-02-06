Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
npmPath = """" & shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\npm.cmd"""
shell.CurrentDirectory = baseDir
shell.Run npmPath & " run start", 0, False
WScript.Sleep 2000
shell.Run "https://localhost:8443", 1, False
