
@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

title Eaglercraft Server Setup

echo ========================================
echo       Eaglercraft Server Launcher
echo ========================================
echo.

:: Check Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js 20+ is required.
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)

:: Verify Node.js version
for /f %%V in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%V"
if !NODE_MAJOR! LSS 20 (
    echo [ERROR] Node.js 20+ is required.
    pause
    exit /b 1
)

echo [OK] Node.js detected.
node --version

:: Locate Java 25
set "JDK_PATH="
call :find_java

:: Check Java 25 already available on PATH
if not defined JDK_PATH (
    set "JAVA_VERSION="
    for /f "tokens=3" %%V in ('java -version 2^>^&1 ^| findstr /i /c:"version"') do (
        set "JAVA_VERSION=%%~V"
    )
    if "!JAVA_VERSION:~0,3!"=="25." goto java_ready
)

:: Install Java if missing
if not defined JDK_PATH (
    echo.
    echo [INFO] Java 25 not found.
    echo [INFO] Installing Eclipse Temurin JDK 25...
    echo.

    where winget >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Windows Package Manager is unavailable.
        echo Install Java: https://adoptium.net/
        goto failed
    )

    winget install --id EclipseAdoptium.Temurin.25.JDK --exact --accept-package-agreements --accept-source-agreements

    if errorlevel 1 (
        echo [ERROR] Java installation failed.
        goto failed
    )

    call :find_java

    if not defined JDK_PATH (
        echo [ERROR] Java installed but its directory was not found.
        echo Restart Windows and try again.
        goto failed
    )
)

:: Configure Java for this session
set "JAVA_HOME=!JDK_PATH!"
set "PATH=!JAVA_HOME!\bin;!PATH!"

:java_ready
echo.
echo [OK] Java detected.
java -version
if errorlevel 1 goto failed

:: Install server dependencies
echo.
echo [INFO] Checking/installing server components...
call npm install

if errorlevel 1 (
    echo [ERROR] npm installation failed.
    goto failed
)

:: Start the server
echo.
echo [INFO] Starting Eaglercraft server...
call npm start

if errorlevel 1 goto failed
exit /b 0

:find_java
for /d %%J in ("%ProgramFiles%\Eclipse Adoptium\jdk-25*") do (
    if exist "%%~fJ\bin\java.exe" set "JDK_PATH=%%~fJ"
)
for /d %%J in ("%ProgramFiles%\Java\jdk-25*") do (
    if exist "%%~fJ\bin\java.exe" set "JDK_PATH=%%~fJ"
)
exit /b

:failed
echo.
echo [ERROR] Setup failed.
pause
exit /b 1
