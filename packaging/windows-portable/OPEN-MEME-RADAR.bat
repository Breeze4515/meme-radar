@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist "runtime\node.exe" (
  echo 运行环境不完整，请重新解压完整的Windows便携版。
  pause
  exit /b 1
)

echo Meme雷达正在启动，请稍候……
echo 浏览器打开后可正常使用；关闭此窗口会停止雷达。
start "" /B "runtime\node.exe" scripts\wait-and-open.mjs
"runtime\node.exe" --use-env-proxy src\main.mjs

if errorlevel 1 (
  echo.
  echo 启动失败，请截图此窗口发给维护者。
  pause
)
endlocal
