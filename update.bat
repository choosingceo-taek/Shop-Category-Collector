@echo off
rem ===========================================================================
rem  Market Lens — update in one double-click (Windows)
rem
rem  Put this file inside the extension folder (the one holding manifest.json)
rem  and run it. It downloads the latest version and replaces the files in
rem  place, keeping the same folder path — so Chrome keeps the same extension,
rem  the same settings and the same collected catalog.
rem
rem  You do NOT need to visit chrome://extensions afterwards: the extension
rem  notices its files changed and reloads itself within about five minutes
rem  (sooner if you open the panel), then puts the new engine into the shop
rem  tabs you already have open.
rem ===========================================================================
setlocal
set "DIR=%~dp0"
set "URL=https://github.com/choosingceo-taek/Shop-Category-Collector/archive/refs/heads/claude/main-session-cudnkx.zip"
set "ZIP=%TEMP%\marketlens.zip"
set "OUT=%TEMP%\marketlens_unpacked"

if not exist "%DIR%manifest.json" (
  echo.
  echo   This file has to sit INSIDE the Market Lens folder
  echo   ^(the folder that contains manifest.json^).
  echo.
  pause
  exit /b 1
)

echo.
echo   Downloading the latest Market Lens...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '%URL%' -OutFile '%ZIP%'" || goto :failed

if exist "%OUT%" rmdir /s /q "%OUT%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; Expand-Archive -Path '%ZIP%' -DestinationPath '%OUT%' -Force" || goto :failed

rem the zip holds one folder; that folder is what we copy from
set "SRC="
for /d %%D in ("%OUT%\*") do set "SRC=%%D"
if not defined SRC goto :failed
if not exist "%SRC%\manifest.json" goto :failed

rem /XF this script: cmd reads a running batch file from disk line by line, and
rem overwriting it mid-run corrupts the rest of the run.
robocopy "%SRC%" "%DIR%." /E /NFL /NDL /NJH /NJS /NP /XF update.bat >nul
if errorlevel 8 goto :failed

for /f "tokens=2 delims=:," %%V in ('findstr /c:"\"version\"" "%DIR%manifest.json"') do set "VER=%%~V"
echo.
echo   Updated to version %VER: =%
echo   Market Lens reloads itself shortly — nothing else to do.
echo.
timeout /t 5 >nul
exit /b 0

:failed
echo.
echo   Update failed. Check the internet connection and try again,
echo   or download the ZIP by hand:
echo   %URL%
echo.
pause
exit /b 1
