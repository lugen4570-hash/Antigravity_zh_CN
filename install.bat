@echo off
chcp 65001 >nul
setlocal

echo ==================================================
echo   Antigravity Simplified Chinese Localization
echo ==================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" goto :failed

echo.
echo [OK] Antigravity zh-CN deployed successfully.
echo      If Antigravity is currently running, close and reopen it once to apply.
goto :done

:no_node
echo [ERROR] Node.js (18+) was not found. Please install it from https://nodejs.org/
set "EXIT_CODE=1"
goto :done

:failed
echo.
echo [ERROR] Installation failed with exit code %EXIT_CODE%.

:done
echo.
if not "%ANTIGRAVITY_I18N_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
