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

node scripts\open.mjs
if errorlevel 1 (
  echo.
  echo Meme Radar 启动失败，请查看 logs\radar-launch.log。
  pause
  exit /b 1
)
endlocal
