@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" set "NODE=node"

set "PORT=8899"
echo 正在启动 CMA 报价助手 ...
start "" /min "%NODE%" server.js
timeout /t 2 >nul

set "BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if defined BROWSER (
  "%BROWSER%" --app=http://127.0.0.1:%PORT% --window-size=1160,900 --window-position=160,80
) else (
  start "" "http://127.0.0.1:%PORT%"
)