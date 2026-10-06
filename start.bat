@echo off
cd /d "%~dp0"
title Landing Admin Server
if not exist .env (
  echo Chua co file .env - hay copy .env.example thanh .env va dien DATABASE_URL
  pause
  exit /b
)
if not exist node_modules call npm install
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000/admin"
npm run dev
pause
