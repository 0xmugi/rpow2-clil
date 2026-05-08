@echo off
REM Auto-restart wrapper for rpow2 miner (gilang profile) on Windows.
REM Launched by Task Scheduler at logon. Output appended to miner-gilang.log.
REM CMD's goto loop is more robust than PowerShell against Ctrl+C signals.

setlocal
cd /d "%~dp0"
set LOG=%~dp0miner-gilang.log

:loop
echo === [%date% %time%] starting miner ===>>"%LOG%"
node rpow.js mine --profile=gilang --workers=10 >>"%LOG%" 2>&1
echo === [%date% %time%] miner exited, restart in 5s ===>>"%LOG%"
timeout /t 5 /nobreak >nul
goto loop
