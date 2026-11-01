@echo off
cd /d "%~dp0"
echo === Bot Bybit: fase 0 (testnet) ===
if not exist .venv\Scripts\python.exe (
  python -m venv .venv || (echo ERRO: Python nao encontrado. Instala em python.org e marca "Add to PATH". & pause & exit /b 1)
)
.venv\Scripts\python.exe -m pip install -q -r requirements-bot.txt
if not exist .env .venv\Scripts\python.exe setup_env.py
.venv\Scripts\python.exe phase0.py
echo.
echo Copia o texto acima para o chat (NAO inclui chaves).
pause
