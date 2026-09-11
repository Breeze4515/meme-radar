@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.23 或更高兼容版本：https://nodejs.org/
  pause
  exit /b 1
)

node scripts\setup.mjs
if errorlevel 1 (
  pause
  exit /b 1
)

node --use-env-proxy src\main.mjs
if errorlevel 1 pause
endlocal
