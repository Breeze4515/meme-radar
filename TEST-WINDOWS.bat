@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 未安装。请先从 https://nodejs.org/ 安装当前 LTS 版本。
  pause
  exit /b 1
)

node scripts\setup.mjs
if errorlevel 1 (
  pause
  exit /b 1
)

echo.
echo Meme雷达开源版测试地址：http://127.0.0.1:3791/
echo 测试结束后回到此窗口，按 Ctrl+C 停止雷达。
start "" /B node scripts\wait-and-open.mjs
node --use-env-proxy src\main.mjs
if errorlevel 1 pause
endlocal
