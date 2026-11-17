@echo off
chcp 65001 >nul
title SafeRide
cd /d "%~dp0"
echo === SafeRide: iniciando servidor y app ===

if not exist "backend\.venv\Scripts\activate.bat" (
  echo Primera vez: creando entorno de Python e instalando dependencias...
  python -m venv backend\.venv || (echo No se encontro Python. Instalalo desde python.org & pause & exit /b 1)
  call backend\.venv\Scripts\activate && pip install -r backend\requirements.txt
)
if exist "app\package.json" if not exist "app\node_modules" (
  echo Primera vez: instalando dependencias de la app...
  pushd app && call npm install && popd
)

start "SafeRide - Servidor (no cerrar)" cmd /k "cd /d %~dp0backend && call .venv\Scripts\activate && uvicorn main:app --host 0.0.0.0 --port 8000"
timeout /t 4 >nul
start "SafeRide - Expo (no cerrar)" cmd /k "cd /d %~dp0app && npx expo start"
echo.
echo Listo. Se abrieron 2 ventanas negras: NO las cierres.
echo Abre la app en el celular y escanea el QR de la ventana "Expo".
echo (Para el casco por Bluetooth usa el development build; ver README).
echo Cuenta de prueba: demo@saferide.app / demo1234
pause
