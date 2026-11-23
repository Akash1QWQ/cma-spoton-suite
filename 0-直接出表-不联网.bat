@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=%~dp0runtime\node\node.exe"
set "PY=%~dp0runtime\python\python.exe"
if not exist "%NODE%" set "NODE=node"
if not exist "%PY%" set "PY=python"

echo ==========================================
echo   直接出表（用今天已经查到的数据）
echo   不联网，几秒钟就好
echo ==========================================
echo.
"%NODE%" fetch.js --region 非洲
if errorlevel 1 goto err
"%NODE%" fetch.js --region 中南美
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