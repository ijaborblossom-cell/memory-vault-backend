@echo off
cd /d "C:\Users\Blossomation\Desktop\Memory Vault"
npm install dotenv 2>nul
timeout /t 1 /nobreak >nul
node server.js
pause
