@echo off
set "DIR=%~dp0"
cd /d "%DIR%"

:: Check if already running
netstat -ano 2>nul | find ":3456 " | find "LISTENING" >nul
if %errorlevel% equ 0 (
    start "" "http://localhost:3456"
    exit /b 0
)

:loop
"%DIR%node_modules\.bin\tsx.cmd" "%DIR%src\index.ts"
if %errorlevel% equ 42 (
    echo Restarting to load new code...
    timeout /t 2 /nobreak >nul
    goto loop
)

timeout /t 3 /nobreak >nul
start "" "http://localhost:3456"
