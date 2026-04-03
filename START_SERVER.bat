@echo off
title SKYWAR Server
color 0B
echo.
echo  =============================================
echo    SKYWAR VACU vs NSTRO  --  GAME SERVER
echo  =============================================
echo.
echo  [*] Checking Node.js installation...
node --version >nul 2>&1
IF ERRORLEVEL 1 (
    echo  [!] Node.js not found!
    echo  [!] Download from: https://nodejs.org
    echo.
    pause
    exit /b
)
echo  [OK] Node.js found.
echo.
echo  [*] Starting SKYWAR Server on port 3000...
echo  [*] Dashboard: http://localhost:3000
echo  [*] Game:      Open index.html in your browser
echo.
echo  ─────────────────────────────────────────────
echo   TO ALLOW REMOTE PLAYERS (via ngrok):
echo   1. Download ngrok: https://ngrok.com/download
echo   2. Run in a NEW window: ngrok http 3000
echo   3. Copy the Forwarding URL (e.g. abc123.ngrok-free.app)
echo   4. Share it with players — they paste it in-game
echo  ─────────────────────────────────────────────
echo.
echo  Press Ctrl+C to stop the server.
echo  =============================================
echo.
node server.js
pause
