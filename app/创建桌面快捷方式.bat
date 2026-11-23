@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ==========================================
echo   创建桌面快捷方式：CMA报价助手
echo ==========================================
echo.

if not exist "%~dp0app.ico" echo [警告] 找不到 app.ico，图标可能显示不出来
if not exist "%~dp0报价助手.vbs" echo [错误] 找不到 报价助手.vbs& pause& exit /b 1

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0创建桌面快捷方式.ps1"
if errorlevel 1 echo.& echo [提示] 上面有报错，可以把这个窗口截图发我
echo.
pause