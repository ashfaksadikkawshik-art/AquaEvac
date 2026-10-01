@echo off
setlocal
cd /d "%~dp0"

echo ================================================
echo AquaEvac - Python AI Setup (XAMPP + VS Code)
echo ================================================
echo.

where py >nul 2>&1
if %errorlevel%==0 (
    set "PY=py"
) else (
    where python >nul 2>&1
    if %errorlevel%==0 (
        set "PY=python"
    ) else (
        echo ERROR: Python was not found in PATH.
        echo Install Python 3.10+ and enable "Add Python to PATH".
        pause
        exit /b 1
    )
)

if not exist "venv\Scripts\python.exe" (
    echo Creating Python virtual environment...
    %PY% -m venv venv
    if errorlevel 1 (
        echo ERROR: Could not create the virtual environment.
        pause
        exit /b 1
    )
)

echo Activating virtual environment...
call "venv\Scripts\activate.bat"

echo Upgrading pip...
python -m pip install --upgrade pip

echo Installing AquaEvac AI dependencies...
pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: Dependency installation failed.
    pause
    exit /b 1
)

echo.
echo Setup complete.
echo Start the AI engine with: run_ai.bat
pause
