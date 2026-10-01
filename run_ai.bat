@echo off
setlocal
cd /d "%~dp0"

echo ================================================
echo AquaEvac AI Engine
 echo XAMPP MySQL + VS Code Python mode
 echo ================================================
echo.

if not exist "venv\Scripts\python.exe" (
    echo Virtual environment not found.
    echo Run setup_xampp_ai.bat first.
    pause
    exit /b 1
)

call "venv\Scripts\activate.bat"
set DB_HOST=127.0.0.1
set DB_PORT=3306
set DB_NAME=aquaevac_db
set DB_USER=root
set DB_PASSWORD=
set AI_API_BASE_URL=http://127.0.0.1:5000

python app.py
pause
