$ErrorActionPreference = "Stop"
try {
    $base = Split-Path -Parent $MyInvocation.MyCommand.Path
    if (-not $base) { $base = (Get-Location).Path }

    # 图标必须放在短路径，否则 Windows 读不到（这是之前图标显示不出来的原因）
    $iconDirs = @("C:\ProgramData\cmaquote", (Join-Path $env:LOCALAPPDATA "cmaquote"))
    $iconDir = $null
    foreach ($d in $iconDirs) {
        try {
            New-Item -ItemType Directory -Force -Path $d | Out-Null
            Copy-Item (Join-Path $base "app.ico") (Join-Path $d "app.ico") -Force
            $iconDir = $d
            break
        } catch { }
    }
    if (-not $iconDir) { throw "图标没法复制到短路径（ProgramData / LocalAppData 都没权限）" }

    $vbs = Join-Path (Split-Path $base -Parent) "报价助手.vbs"
    if (-not (Test-Path $vbs)) { throw "找不到 报价助手.vbs" }

    $desktop = [Environment]::GetFolderPath("Desktop")
    $lnk = Join-Path $desktop "CMA报价助手.lnk"

    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnk)
    $sc.TargetPath = (Join-Path $env:SystemRoot "System32\wscript.exe")
    $sc.Arguments = '"' + $vbs + '"'
    $sc.WorkingDirectory = (Split-Path $base -Parent)
    $sc.IconLocation = (Join-Path $iconDir "app.ico") + ",0"
    $sc.Description = "CMA CGM 港口报价自动抓取"
    $sc.WindowStyle = 1
    $sc.Save()

    if (-not (Test-Path $lnk)) { throw "快捷方式没创建成功（桌面路径：$desktop）" }

    Write-Host ""
    Write-Host "  [完成] 桌面已创建：CMA报价助手" -ForegroundColor Green
    Write-Host "  图标位置：$iconDir\app.ico"
    Write-Host "  程序目录：$base"
    Write-Host ""
    Write-Host "  双击桌面图标即可打开（第一次要登录一次 CMA CGM）"
    exit 0
} catch {
    Write-Host ""
    Write-Host "  [失败] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  程序目录：$base"
    Write-Host ""
    Write-Host "  备用办法：右键「报价助手.vbs」→ 发送到 → 桌面快捷方式"
    exit 1
}