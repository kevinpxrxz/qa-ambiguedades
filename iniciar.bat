@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto sinNode

if not exist ".env" goto sinEnv
if not exist "node_modules" goto instalar
goto iniciar

:sinNode
echo No se encontro Node.js en el PATH.
echo Instale Node.js 22.15 o superior desde https://nodejs.org/ y vuelva a intentar.
pause
exit /b 1

:sinEnv
copy ".env.example" ".env" >nul
echo Se creo el archivo .env a partir de .env.example.
echo Complete AZDO_PAT y la clave de IA (GEMINI_API_KEY o ANTHROPIC_API_KEY) y guarde.
notepad ".env"
pause
exit /b 0

:instalar
echo Instalando dependencias...
call npm.cmd install --omit=dev
if errorlevel 1 goto errorInstalar
goto iniciar

:errorInstalar
echo Fallo la instalacion de dependencias.
pause
exit /b 1

:iniciar
echo.
echo Iniciando Ambiguedades de HUs en http://127.0.0.1:3300
echo Deje esta ventana abierta mientras usa la aplicacion.
echo.
if not defined NO_ABRIR start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:3300'"
call npm.cmd start
echo.
echo El servidor se detuvo.
pause
