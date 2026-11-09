@echo off
rem Windows shim for the fake codex: run fake-codex.mjs next to this file with the test's node (FAKE_CODEX_NODE) or node on PATH.
setlocal
set "NODE_EXE=%FAKE_CODEX_NODE%"
if "%NODE_EXE%"=="" set "NODE_EXE=node"
"%NODE_EXE%" "%~dp0fake-codex.mjs" %*
exit /b %ERRORLEVEL%
