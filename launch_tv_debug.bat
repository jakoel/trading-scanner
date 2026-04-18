@echo off
REM Launch TradingView Desktop with Chrome DevTools Protocol enabled
REM Auto-detects the installed version via PowerShell

set CDP_PORT=9222

REM Find TradingView via PowerShell (works with Windows Store apps)
for /f "delims=" %%P in ('powershell -NoProfile -Command "(Get-AppxPackage -Name '*TradingView*' | Select-Object -First 1).InstallLocation" 2^>nul') do set TV_DIR=%%P

if "%TV_DIR%"=="" (
    echo ERROR: TradingView Desktop not found. Install it from the Microsoft Store.
    pause
    exit /b 1
)

set TV_EXE=%TV_DIR%\TradingView.exe
if not exist "%TV_EXE%" (
    echo ERROR: TradingView.exe not found in %TV_DIR%
    pause
    exit /b 1
)

echo Found: %TV_EXE%
echo Killing existing TradingView instances...
taskkill /F /IM TradingView.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo Launching TradingView with CDP on port %CDP_PORT%...
start "" "%TV_EXE%" --remote-debugging-port=%CDP_PORT%

echo Waiting for CDP to become available...
:WAIT_LOOP
timeout /t 1 /nobreak >nul
curl -s http://localhost:%CDP_PORT%/json/version >nul 2>&1
if errorlevel 1 goto WAIT_LOOP

echo.
echo TradingView is running with CDP on port %CDP_PORT%!
echo You can now run: node scan_watchlist.js
pause
