@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo 未找到 Node.js。请安装 Node.js 22 或 24 LTS 后重试。
    pause
    exit /b 1
)
node server.js
if errorlevel 1 (
    echo.
    echo 服务启动失败，请查看上方错误。端口冲突时可设置 PORT 为其他端口。
    pause
)
