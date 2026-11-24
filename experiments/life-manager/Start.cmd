@echo off
cd /d "%~dp0"
if exist "runtime\python.exe" (
  if "%~1"=="" (start "" "ParkinsonLifeManager.exe") else ("runtime\python.exe" app.py %*)
) else (
  py -3 app.py %*
)
if errorlevel 1 pause
