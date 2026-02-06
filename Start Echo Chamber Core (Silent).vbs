Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
coreDir = baseDir & "\core"
envPath = coreDir & "\control\.env"

scheme = "http"
port = "9090"

If fso.FileExists(envPath) Then
  Set ts = fso.OpenTextFile(envPath, 1, False)
  Do While Not ts.AtEndOfStream
    line = Trim(ts.ReadLine)
    If Len(line) > 0 And Left(line, 1) <> "#" Then
      parts = Split(line, "=", 2)
      If UBound(parts) = 1 Then
        key = Trim(parts(0))
        value = Trim(parts(1))
        If LCase(key) = "core_port" Then port = value
        If LCase(key) = "core_tls_cert" Then scheme = "https"
        If LCase(key) = "core_tls_self_signed" Then scheme = "https"
      End If
    End If
  Loop
  ts.Close
End If

shell.Run "powershell -ExecutionPolicy Bypass -File """ & coreDir & "\run-core.ps1""", 0, False

' Wait up to ~60s for control plane health before opening the viewer.
Dim attempts, healthy
healthy = False
For attempts = 1 To 30
  WScript.Sleep 2000
  If IsHealthy(scheme, port) Then
    healthy = True
    Exit For
  End If
Next

shell.Run scheme & "://127.0.0.1:" & port & "/viewer", 1, False

Function IsHealthy(scheme, port)
  On Error Resume Next
  Dim http, url
  url = scheme & "://127.0.0.1:" & port & "/health"
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  http.Option(4) = 13056 ' Ignore TLS cert errors
  http.Open "GET", url, False
  http.Send
  If Err.Number <> 0 Then
    IsHealthy = False
    Err.Clear
    Exit Function
  End If
  IsHealthy = (http.Status = 200)
End Function
