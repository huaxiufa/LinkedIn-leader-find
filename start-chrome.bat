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

echo [1/4] Chrome found:
echo %CHROME%
echo.
echo [PROFILE] Persistent Lead Finder profile:
echo %PROFILE%
echo.
echo This profile stores the Lead Finder Chrome session locally.
echo Your normal Chrome profile is not used.
echo.

REM Reuse an already-running Lead Finder Chrome when CDP is available.
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }"
if not errorlevel 1 goto CDPOK

echo [2/4] Starting the persistent Lead Finder Chrome profile...
echo.
echo IMPORTANT:
echo - First run: log into LinkedIn normally in this Chrome window.
echo - Later runs: the same Chrome profile is reused automatically.
echo - Do not delete the chrome-profile folder if you want to keep the session.
echo - Keep this Chrome window open while Lead Finder is working.
echo.

REM Do not close the user's normal Chrome windows.
REM The dedicated profile is reused automatically whenever CDP is already available.
REM Remove only stale singleton locks from this dedicated profile.
del /F /Q "%PROFILE%\SingletonLock" >nul 2>&1
del /F /Q "%PROFILE%\SingletonCookie" >nul 2>&1
del /F /Q "%PROFILE%\SingletonSocket" >nul 2>&1

REM Chrome 136+ requires a non-default user-data-dir for remote debugging.
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
echo If a Chrome window using this profile is already open, close that Lead Finder Chrome window and run this launcher again.
echo Do NOT delete chrome-profile unless you intentionally want to reset the saved session.
echo.
echo Diagnostic command:
echo   Invoke-WebRequest http://localhost:9222/json/version
echo.
pause
exit /b 1

:CDPOK
echo.
echo [3/4] [OK] Chrome CDP is available at http://localhost:9222
echo.
echo [4/4] Session persistence:
echo - Profile: %PROFILE%
echo - The application will reuse this browser session.
echo - LinkedIn login state is checked by the worker when a search starts.
echo.
echo Next step:
echo   docker compose up --build
echo.
pause
