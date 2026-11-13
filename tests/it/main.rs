//! Integration tests: one binary, one module per area.
//!
//! A test belongs here, not next to the code, when it starts another program (the stand-ins in `tarsee-testbin`),
//! or drives the whole server. Everything else is a unit test in the module it tests.

mod support;

mod claude_cli_env_names;
mod codex_cli;
mod codex_thread_dbs;
mod daemon;
mod fake_python;
mod foundation;
mod hooks;
mod interfaces;
mod mcp_http;
mod pdf_text;
mod python_runtime;
mod run_cmd;
mod stt_install;
mod stt_local;
mod stt_routes;
mod terminal;
mod tts_phonon;
mod voice;
mod voice_fixtures;
