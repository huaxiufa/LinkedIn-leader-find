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

echo [1/2] Chrome found:
echo %CHROME%
echo.
echo [2/2] Starting Chrome with remote debugging on port 9222...
echo.
echo IMPORTANT:
echo - Close all Chrome windows before running this file.
echo - Log in to LinkedIn in the Chrome window that opens.
echo - Keep Chrome running while the Lead Finder is working.
echo.

start "LinkedIn Chrome" "%CHROME%" --remote-debugging-port=9222

timeout /t 3 /nobreak >nul

powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://localhost:9222/json/version -TimeoutSec 3 | Out-Null; Write-Host '[OK] Chrome CDP is available at http://localhost:9222' } catch { Write-Host '[WARN] Chrome started, but port 9222 is not responding yet. Wait a few seconds and try again.' }"

echo.
echo Next step:
echo   docker compose up --build
 echo.
pause
