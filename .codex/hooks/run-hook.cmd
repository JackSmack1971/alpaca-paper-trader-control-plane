@echo off
setlocal
for /f "delims=" %%R in ('git rev-parse --show-toplevel 2^>NUL') do set "ROOT=%%R"
if not defined ROOT exit /b 1
if /I "%~1"=="session-start" set "HOOK=session-start"
if /I "%~1"=="pre-tool-use" set "HOOK=pre-tool-use"
if /I "%~1"=="post-tool-use" set "HOOK=post-tool-use"
if not defined HOOK exit /b 2
node "%ROOT%\.codex\hooks\%HOOK%.mjs"
exit /b %ERRORLEVEL%
