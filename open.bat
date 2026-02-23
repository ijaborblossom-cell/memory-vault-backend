@echo off
title Memory Vault - Open in Browser
cls

echo Opening Memory Vault at http://localhost:3000...
echo.

REM Check if server is running on port 3000
netstat -ano | find ":3000" > nul

if errorlevel 1 (
    echo ⚠️ Server not detected on port 3000
    echo.
    echo Please start the server first by running: start.bat
    echo.
    pause
    exit /b 1
)

echo ✓ Server is running
echo.
echo 🌐 Opening in browser...

REM Open the application in default browser
start http://localhost:3000

echo.
echo ✨ Application opened in your browser!
echo.
timeout /t 2 /nobreak
