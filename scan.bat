@echo off
REM Launch TradingView with CDP and run the watchlist scanner
REM Usage: double-click or run from terminal

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

REM Check if CDP is already running
curl -s http://localhost:%CDP_PORT%/json/version >nul 2>&1
if not errorlevel 1 (
    echo TradingView CDP already running on port %CDP_PORT%.
    goto RUN_SCAN
)

echo Found: %TV_EXE%
echo Launching TradingView with CDP on port %CDP_PORT%...
taskkill /F /IM TradingView.exe >nul 2>&1
timeout /t 2 /nobreak >nul
start "" "%TV_EXE%" --remote-debugging-port=%CDP_PORT%

echo Waiting for CDP...
:WAIT_LOOP
timeout /t 1 /nobreak >nul
curl -s http://localhost:%CDP_PORT%/json/version >nul 2>&1
if errorlevel 1 goto WAIT_LOOP

echo CDP ready. Waiting for chart to load...
timeout /t 5 /nobreak >nul

:RUN_SCAN
echo.
echo Running watchlist scanner...
node "%~dp0scan_watchlist.js"
echo.
pause
