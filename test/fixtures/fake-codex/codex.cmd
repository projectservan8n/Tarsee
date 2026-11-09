@echo off
rem Windows shim for the fake codex (fake-codex.mjs next to this file). The Codex SDK can't start a .cmd file (it
rem spawns the binary with no shell), so the engine refuses one as TARSEE_CODEX_BIN on Windows: this file is what that
rem test points it at. From a shell it runs the fake with the test's node (FAKE_CODEX_NODE) or node on PATH.
setlocal
set "NODE_EXE=%FAKE_CODEX_NODE%"
if "%NODE_EXE%"=="" set "NODE_EXE=node"
"%NODE_EXE%" "%~dp0fake-codex.mjs" %*
exit /b %ERRORLEVEL%
