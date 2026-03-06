@echo off
setlocal
:: Ensure we are in the project root directory
cd /d "%~dp0"

echo.
echo Starting Memory Vault Android Build...
echo.

:: Set Java path from Android Studio
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"

:: Check if android directory exists
if not exist "android" (
    echo [ERROR] Could not find the "android" folder. 
    echo Please make sure this script is in the project root.
    pause
    exit /b
)

:: Move into android directory
cd android

:: Check if gradlew.bat exists
if not exist "gradlew.bat" (
    echo [ERROR] Could not find gradlew.bat in the android folder.
    pause
    exit /b
)

:: Run the build
echo Building APK...
call .\gradlew.bat assembleDebug

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ======================================================
    echo BUILD SUCCESSFUL!
    echo.
    echo Your APK is located at: 
    echo %~dp0android\app\build\outputs\apk\debug\app-debug.apk
    echo ======================================================
) else (
    echo.
    echo [ERROR] BUILD FAILED.
    echo.
    echo This is usually due to a network connection issue.
    echo Please try running the build again (it will resume).
)

pause
