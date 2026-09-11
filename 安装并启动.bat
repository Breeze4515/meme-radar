@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。
  echo 请先安装 Node.js 22.23 或更高兼容版本，再重新双击本文件。
  echo 下载地址：https://nodejs.org/
  pause
  exit /b 1
)

node scripts\open.mjs
if errorlevel 1 (
  echo.
  echo Meme雷达启动失败，请查看 logs\radar-launch.log。
  pause
  exit /b 1
)

endlocal
