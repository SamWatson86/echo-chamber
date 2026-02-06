Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
coreDir = baseDir & "\core"
shell.CurrentDirectory = coreDir
cargoPath = """" & shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.cargo\bin\cargo.exe"""
shell.Run cargoPath & " run -p echo-core-client", 0, False
