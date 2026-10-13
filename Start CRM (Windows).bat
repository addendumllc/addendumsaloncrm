@echo off
REM Double-click to run the Addendum Salon CRM on this PC. It opens in a new Chrome window.
REM Leave this window open while you work; close it (or press Ctrl+C) to stop the app.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js isn't installed yet.
  echo Install the LTS version from https://nodejs.org, then double-click this file again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo This app needs Node.js 20 or newer. Install the LTS version from https://nodejs.org.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing ^(takes a minute or two^)...
  call npm install
  if errorlevel 1 (
    echo Install failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting Addendum Salon CRM... Chrome will open when it's ready.
call npm run dev
pause
