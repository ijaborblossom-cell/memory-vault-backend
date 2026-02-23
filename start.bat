@echo off
title Memory Vault - Server Running
color 0B
cls

echo ========================================
echo   🧠 Memory Vault Server
echo ========================================
echo.

REM Check if we're in the right directory
if not exist "package.json" (
    echo ❌ Error: package.json not found
    echo Please run this file from the Memory Vault directory
    pause
    exit /b 1
)

REM Check if node_modules exists
if not exist "node_modules" (
    echo ⚠️  Dependencies not found. Installing...
    call npm install
    if errorlevel 1 (
        echo ❌ Installation failed
        pause
        exit /b 1
    )
)

echo ✓ Dependencies ready
echo.
echo 🚀 Starting Memory Vault Server...
echo.

REM Start the server
call npm start

if errorlevel 1 (
    echo ❌ Server failed to start
    pause
    exit /b 1
)
