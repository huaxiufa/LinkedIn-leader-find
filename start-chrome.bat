@echo off
setlocal

echo ========================================
echo LinkedIn Lead Finder - Windows Chrome
echo ========================================
echo.

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if not exist "%CHROME%" (
  echo [ERROR] Google Chrome was not found.
  echo Please install Google Chrome first.
  pause
  exit /b 1
)

set "PROFILE=%~dp0chrome-profile"
if not exist "%PROFILE%" mkdir "%PROFILE%"

echo [1/3] Chrome found:
echo %CHROME%
echo.
echo [2/3] Starting Chrome with a dedicated Lead Finder profile...
echo Profile: %PROFILE%
echo CDP:     http://localhost:9222
echo.
echo IMPORTANT:
echo - Close all normal Chrome windows before running this file.
echo - A separate Chrome profile will open for Lead Finder.
echo - Log in to LinkedIn in that Chrome window.
echo - Your LinkedIn login state is saved in chrome-profile.
echo - Keep this Chrome window open while the Lead Finder is working.
echo.

start "LinkedIn Lead Finder Chrome" "%CHROME%" --remote-debugging-port=9222 --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check

echo Waiting for Chrome CDP...
for /L %%i in (1,1,15) do (
  powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://localhost:9222/json/version -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }"
  if not errorlevel 1 goto CDPOK
  timeout /t 1 /nobreak >nul
)

echo.
echo [ERROR] Chrome did not open CDP on port 9222.
echo Check that no other Chrome process is running, then run this file again.
pause
exit /b 1

:CDPOK
echo.
echo [3/3] [OK] Chrome CDP is available at http://localhost:9222
echo.
echo Next step:
echo   docker compose up --build
echo.
pause
