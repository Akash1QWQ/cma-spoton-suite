@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=%~dp0runtime\node\node.exe"
set "PY=%~dp0runtime\python\python.exe"
if not exist "%NODE%" set "NODE=node"
if not exist "%PY%" set "PY=python"

echo ==========================================
echo   更新价格 - 全部（非洲 + 中南美 + 地中海黑海）
echo   会重新联网查一遍，约 6~10 分钟
echo   中途弹出的浏览器窗口别关
echo ==========================================
echo.
"%NODE%" fetch.js --region 非洲 --fresh 1 %*
if errorlevel 1 goto err
"%NODE%" fetch.js --region 中南美 --fresh 1 %*
if errorlevel 1 goto err
"%NODE%" fetch.js --region 地中海黑海 --fresh 1 %*
if errorlevel 1 goto err
echo.
"%PY%" to_xlsx.py
echo.
echo 完成，结果在 output 文件夹里。
pause
exit /b 0

:err
echo.
echo 出错了，看上面的提示。
pause
exit /b 1
