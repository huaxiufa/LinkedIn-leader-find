@echo off
setlocal EnableExtensions

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

REM Reuse an already-running Lead Finder Chrome when CDP is available.
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }"
if not errorlevel 1 goto CDPOK

echo [2/3] Preparing dedicated Lead Finder Chrome...
echo Profile: %PROFILE%
echo CDP:     http://localhost:9222
echo.
echo IMPORTANT:
echo - This launcher uses a separate Chrome profile for Lead Finder.
echo - Log in to LinkedIn in that Chrome window.
echo - Keep that Chrome window open while the Lead Finder is working.
echo.

echo Closing existing Chrome processes so the dedicated profile can start cleanly...
taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM Remove only stale singleton locks from the dedicated profile.
del /F /Q "%PROFILE%\SingletonLock" >nul 2>&1
del /F /Q "%PROFILE%\SingletonCookie" >nul 2>&1
del /F /Q "%PROFILE%\SingletonSocket" >nul 2>&1

REM --remote-allow-origins=* lets Playwright connect over CDP from Docker.
start "LinkedIn Lead Finder Chrome" /D "%~dp0" "%CHROME%" --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check

echo Waiting for Chrome CDP...
for /L %%i in (1,1,30) do (
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }"
  if not errorlevel 1 goto CDPOK
  timeout /t 1 /nobreak >nul
)

echo.
echo [ERROR] Chrome did not open CDP on port 9222.
echo.
echo Diagnostic command:
echo   Invoke-WebRequest http://localhost:9222/json/version
echo.
echo If Chrome is visible, keep it open and run the diagnostic command above.
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
