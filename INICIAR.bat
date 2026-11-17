@echo off
chcp 65001 >nul
title SafeRide
cd /d "%~dp0"
echo === SafeRide: iniciando servidor y app ===
start "SafeRide - Servidor (no cerrar)" cmd /k "cd /d %~dp0backend && call .venv\Scripts\activate && uvicorn main:app --host 0.0.0.0 --port 8000"
timeout /t 4 >nul
start "SafeRide - Expo (no cerrar)" cmd /k "cd /d %~dp0app && npx expo start"
echo.
echo Listo. Se abrieron 2 ventanas negras: NO las cierres.
echo Abre Expo Go en el celular y escanea el QR de la ventana "Expo".
echo Cuenta de prueba: demo@saferide.app / demo1234
pause
