' CMA 报价助手 - 启动器
' 后台隐藏启动服务，然后优先用 Chrome / Edge 的应用模式打开（无地址栏独立窗口）
Option Explicit
Dim sh, fso, base, nodeExe, url, i, browser, candidates, ok

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
url = "http://127.0.0.1:8899"

' 1) 后台启动本地服务（0 = 不显示窗口）
nodeExe = base & "\runtime\node\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"
sh.Run """" & nodeExe & """ server.js", 0, False

' 2) 等待服务就绪（最多 8 秒）
ok = False
For i = 1 To 32
  WScript.Sleep 250
  On Error Resume Next
  Dim http
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", url & "/api/state", False
  http.Send
  If Err.Number = 0 And http.Status = 200 Then
    ok = True
  End If
  Err.Clear
  On Error GoTo 0
  If ok Then Exit For
Next

' 3) 找一个支持应用模式的浏览器：Chrome → Edge
Dim pf, pf86, lad
pf = sh.ExpandEnvironmentStrings("%ProgramFiles%")
pf86 = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%")
lad = sh.ExpandEnvironmentStrings("%LocalAppData%")

candidates = Array( _
  pf & "\Google\Chrome\Application\chrome.exe", _
  pf86 & "\Google\Chrome\Application\chrome.exe", _
  lad & "\Google\Chrome\Application\chrome.exe", _
  pf86 & "\Microsoft\Edge\Application\msedge.exe", _
  pf & "\Microsoft\Edge\Application\msedge.exe" _
)

browser = ""
For i = 0 To UBound(candidates)
  If fso.FileExists(candidates(i)) Then
    browser = candidates(i)
    Exit For
  End If
Next

If browser <> "" Then
  sh.Run """" & browser & """ --app=" & url & " --window-size=1560,960 --window-position=30,40", 1, False
Else
  ' 既没有 Chrome 也没有 Edge，才退回默认浏览器
  sh.Run url, 1, False
End If