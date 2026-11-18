@echo off
chcp 65001 >nul
setlocal

echo ==================================================
echo   Antigravity Simplified Chinese - Uninstall
echo ==================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1" -RemoveData %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" goto :failed

echo.
echo [OK] Uninstalled and restored original Antigravity files cleanly.
goto :done

:failed
echo.
echo [ERROR] Uninstall failed (close Antigravity first if files are locked).

:done
echo.
if not "%ANTIGRAVITY_I18N_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
