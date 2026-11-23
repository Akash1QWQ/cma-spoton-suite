@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "DEST=%~dp0..\..\CMA报价程序-便携版"

echo ==========================================
echo   生成便携版（可复制到别的电脑直接用）
echo   目标：%DEST%
echo ==========================================
echo.

if exist "%DEST%" rmdir /s /q "%DEST%"

pushd "%~dp0.."
robocopy "." "%DEST%" /E /NFL /NDL /NJH /NJS /NP ^
  /XD ".git" ".browser-profile" ".tmp" "output" "__pycache__" ^
  /XF ".auth-state.json" "settings.json"
popd
if not exist "%DEST%\app\output" mkdir "%DEST%\app\output"
if errorlevel 8 goto err

echo.
echo 完成：%DEST%  （约 185 MB）
echo 整个文件夹拷到别的电脑，双击里面的 .bat 就能用。
echo 第一次用需要登录一次：双击「更新价格-非洲.bat」，在弹出的窗口里登录。
pause
exit /b 0

:err
echo.
echo 复制失败，检查目标路径权限。
pause
exit /b 1