@echo off
title Memory Vault - Setup & Installation
color 0A
cls

echo ========================================
echo   🧠 Memory Vault Auto-Installation
echo ========================================
echo.

echo Checking Node.js installation...
node --version > nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js is not installed. 
    echo Download from: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo ✓ Node.js found: %NODE_VERSION%

echo.
echo Installing dependencies...
echo This may take 1-2 minutes...
echo.
call npm install

if errorlevel 1 (
    echo ❌ Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo ========================================
echo   ✅ Setup Complete!
echo ========================================
echo.
echo Starting server in 3 seconds...
timeout /t 3 /nobreak

echo.
echo 🚀 Launching Memory Vault...
echo Opening http://localhost:3000 in your browser...
echo.

REM Start the server
start npm start

REM Wait for server to start
timeout /t 3 /nobreak

REM Open browser
start http://localhost:3000

echo.
echo ✨ Application is now running!
echo.
echo Server:  http://localhost:3000
echo To stop: Close this window or press Ctrl+C
echo.
pause

