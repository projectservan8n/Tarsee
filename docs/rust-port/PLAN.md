# Tarsee in Rust: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Tarsee's Node.js server with a Rust one that behaves the same, tested as thoroughly, on the single
branch `rust-rewrite`.

**Architecture:** One crate, `tarsee`, with a library and a binary. Its modules mirror the Node folders one to one.
Shared state hangs off an `App` value instead of module-level singletons, so tests run in parallel in one process.
The browser UI is served unchanged.

**Tech stack:** Rust 2024, tokio, axum (HTTP and WebSocket), rusqlite (bundled SQLite), reqwest behind a `Fetch`
trait, serde_json, serenity (Discord), lettre/async-imap/mail-parser (email), chromiumoxide (browser automation),
portable-pty (web terminal), croner (schedules).

**Spec:** `docs/rust-port/DESIGN.md`. The behaviour itself is specified by the Node sources and tests in this
repository, which stay in place until the port is complete.

## Global constraints

- Everything observable stays identical to the Node version: routes, JSON shapes, WebSocket and SSE messages,
  setting keys, environment variables, files on disk, log lines, chat messages, prompts, tool names and schemas.
- A database and stored secrets made by the Node version work unchanged under the Rust version.
- No global mutable state and no reads of the real environment outside `src/main.rs`, `src/env.rs` and `testbin/`.
- All outgoing HTTP goes through the `Fetch` trait.
- Every case of every Node test file is ported, or listed with the reason it could not be.
- Tests pass on Windows and Linux, never touch the network, and never write outside a temporary folder.
- The browser files under `src/public/`, the Python workers and the skills are not modified by the port.
- No secrets, personal names or machine paths anywhere in the repository.

## Review focus

Conditions the Node tests do not exercise, most likely first. Each is pinned by a test in the package named.

1. **An existing install's data.** A database written by the Node version, with encrypted settings, hashed
   sessions and stored API tokens, opens under Rust and every secret decrypts (B1 for the vault and sessions,
   S1 for settings, Z1 for a whole-database check against a fixture made by the Node code).
2. **The unchanged browser UI against the Rust API.** A field that was `null` and is now missing, or a number that
   is now a string, breaks the UI without an error. Route tests assert whole response bodies, not single fields
   (every R package), and the UI is driven against the Rust server in a real browser (W1).
3. **A turn that stops badly.** The engine process crashes, hangs or is stopped mid-way: the child process and its
   children are gone, the conversation's lock is released and the UI gets its `done` event (G1, G2, G3).
4. **Text that is not ASCII.** Limits counted in UTF-16 units (Telegram 4096, Discord 2000, titles 200) cut where
   the Node version cut and never split an emoji (E1, H1, H2, D1).
5. **Windows and Linux.** Paths with spaces and non-ASCII characters, programs started through `.cmd` shims,
   stopping a process tree, file modes that do not exist on Windows (A2, G1, G2, V1, T1).
6. **Two things at once.** Two messages for one conversation, a scheduled task firing during a turn, a shutdown
   during a turn: no deadlock, no lost message, no lock held across an await on the database (D1, S5, G3, Z1).

## How the work is run

1. The lead wrote the foundation (package F0) and the skeleton: every Rust file of the port already exists as a
   one-line stub naming its package, and every `mod.rs` already declares it.
2. Each package below is ported by one agent in its own git worktree, on its own local branch
   `port/<package>` cut from `rust-rewrite`. The agent replaces its stubs, ports its tests, and commits there.
3. The lead merges each finished branch into `rust-rewrite`, runs the whole test suite, and pushes. Packages start
   as soon as everything they need is merged.
4. When every package is merged: the Node sources and tests are removed, the browser UI moves to `web/`, the
   Docker image, CI, README and docs are rewritten for the Rust build, and the whole thing is checked end to end.

An agent changes only its own package's files, plus these shared files when it needs to: `Cargo.toml` (a new
dependency), `testbin/main.rs` and a new `testbin/<role>.rs` (a new stand-in), `tests/it/main.rs` and a new
`tests/it/<area>.rs`, a new file under `src/testkit/`. Changes to anything else (the foundation, another package's
module) are proposed in the agent's report, not made.

## Work packages

Each package lists the Node files to port (with line counts), the Rust files they become, the Node test files whose
cases must be ported with them, and the packages that must be merged first.

- **Batch 1:** I0, A1, A2, B1, B2, C1, D1, E1, V1
- **Batch 2:** A3, A5, V2, T1
- **Batch 3:** A4, S1, S4
- **Batch 4:** S2, S5, G1, G2, H1, H2
- **Batch 5:** S3, G3, H3, R4
- **Batch 6:** K1, R2, R3
- **Batch 7:** R1
- **Batch 8:** Z1
- **Batch 9:** W1, Y1

### F0: Foundation (done by the lead)

- **Needs:** A1
- **Size:** 1053 lines of source, 142 lines of tests
- **Files:**
  - `src/config/env.js` (227) -> `src/config/env.rs`
  - `src/config/constants.js` (181) -> `src/config/constants.rs`
  - `src/db/sqlite.js` (358) -> `src/db/sqlite.rs`
  - `src/db/usage-schema.js` (53) -> `src/db/usage_schema.rs`
  - `src/lib/log-capture.js` (104) -> `src/lib/log_capture.rs`
  - `src/lib/redact.js` (72) -> `src/lib/redact.rs`
  - `src/lib/local-time.js` (58) -> `src/lib/local_time.rs`
- **Tests to port:**
  - `test/redact.test.js` (142)

### I0: Shared interfaces for the turn, tools, commands and channels

- **Needs:** only the foundation
- **Size:** 0 lines of source, 0 lines of tests

### A1: AI provider registry

- **Needs:** only the foundation
- **Size:** 2246 lines of source, 1904 lines of tests
- **Files:**
  - `src/lib/model-picker.js` (422) -> `src/lib/model_picker.rs`
  - `src/ai/provider-registry.js` (1031) -> `src/ai/provider_registry.rs`
  - `src/ai/model-ref.js` (55) -> `src/ai/model_ref.rs`
  - `src/ai/engine-errors.js` (284) -> `src/ai/engine_errors.rs`
  - `src/lib/openrouter-catalog.js` (454) -> `src/lib/openrouter_catalog.rs`
- **Tests to port:**
  - `test/engine-errors.test.js` (233)
  - `test/model-picker.test.js` (316)
  - `test/model-ref.test.js` (101)
  - `test/openrouter-catalog.test.js` (407)
  - `test/provider-registry.test.js` (847)

### A2: Engine environment and Codex CLI basics

- **Needs:** only the foundation
- **Size:** 1580 lines of source, 1735 lines of tests
- **Files:**
  - `src/ai/context-limits.js` (95) -> `src/ai/context_limits.rs`
  - `src/ai/engine-env.js` (800) -> `src/ai/engine_env.rs`
  - `src/ai/codex-cli.js` (240) -> `src/ai/codex_cli.rs`
  - `src/lib/run-cmd.js` (62) -> `src/lib/run_cmd.rs`
  - `src/ai/codex-rollouts.js` (32) -> `src/ai/codex_rollouts.rs`
  - `src/lib/codex-thread-dbs.js` (213) -> `src/lib/codex_thread_dbs.rs`
  - `src/lib/turn-leftovers.js` (49) -> `src/lib/turn_leftovers.rs`
  - `src/ai/preamble.js` (89) -> `src/ai/preamble.rs`
- **Tests to port:**
  - `test/claude-cli-env-names.test.js` (165)
  - `test/codex-cli.test.js` (102)
  - `test/codex-thread-dbs.test.js` (390)
  - `test/engine-env.test.js` (818)
  - `test/preamble.test.js` (102)
  - `test/turn-leftovers.test.js` (158)

### A3: Provider status, sign-ins and spend

- **Needs:** A1, A2, B1
- **Size:** 2048 lines of source, 1681 lines of tests
- **Files:**
  - `src/ai/session-handle.js` (95) -> `src/ai/session_handle.rs`
  - `src/ai/settings-guard.js` (113) -> `src/ai/settings_guard.rs`
  - `src/lib/claude-transcript.js` (193) -> `src/lib/claude_transcript.rs`
  - `src/ai/codex-device-login.js` (493) -> `src/ai/codex_device_login.rs`
  - `src/ai/codex-models.js` (294) -> `src/ai/codex_models.rs`
  - `src/ai/provider-status.js` (509) -> `src/ai/provider_status.rs`
  - `src/ai/spend.js` (351) -> `src/ai/spend.rs`
- **Tests to port:**
  - `test/codex-device-login.test.js` (440)
  - `test/codex-models.test.js` (292)
  - `test/provider-status.test.js` (422)
  - `test/session-handle.test.js` (144)
  - `test/settings-guard.test.js` (199)
  - `test/spend.test.js` (184)

### A4: Provider probes, model lists and self-heal

- **Needs:** A1, A2, A3, B1, C1
- **Size:** 2370 lines of source, 684 lines of tests
- **Files:**
  - `src/ai/provider-probes.js` (646) -> `src/ai/provider_probes.rs`
  - `src/ai/provider-models.js` (237) -> `src/ai/provider_models.rs`
  - `src/lib/model-catalog.js` (680) -> `src/lib/model_catalog.rs`
  - `src/lib/security-audit.js` (155) -> `src/lib/security_audit.rs`
  - `src/lib/boot-fixups.js` (55) -> `src/lib/boot_fixups.rs`
  - `src/lib/self-heal.js` (503) -> `src/lib/self_heal.rs`
  - `src/routes/health.js` (62) -> `src/routes/health.rs`
  - `src/middleware/error-handler.js` (32) -> `src/middleware/error_handler.rs`
- **Tests to port:**
  - `test/chatgpt-list-keys-only.test.js` (55)
  - `test/provider-models.test.js` (305)
  - `test/provider-probes.test.js` (324)

### A5: Codex options, events and the Local AI bridge

- **Needs:** A1, A2, D1
- **Size:** 1309 lines of source, 1085 lines of tests
- **Files:**
  - `src/ai/local-bridge.js` (520) -> `src/ai/local_bridge.rs`
  - `src/ai/providers/codex-options.js` (344) -> `src/ai/providers/codex_options.rs`
  - `src/ai/providers/codex-events.js` (445) -> `src/ai/providers/codex_events.rs`
- **Tests to port:**
  - `test/codex-events.test.js` (350)
  - `test/codex-options.test.js` (378)
  - `test/local-bridge.test.js` (357)

### B1: Vault, sign-in and security middleware

- **Needs:** only the foundation
- **Size:** 1315 lines of source, 382 lines of tests
- **Files:**
  - `src/lib/vault.js` (276) -> `src/lib/vault.rs`
  - `src/lib/key-vault.js` (143) -> `src/lib/key_vault.rs`
  - `src/lib/security-manager.js` (148) -> `src/lib/security_manager.rs`
  - `src/middleware/security.js` (101) -> `src/middleware/security.rs`
  - `src/middleware/auth.js` (357) -> `src/middleware/auth.rs`
  - `src/routes/auth-routes.js` (111) -> `src/routes/auth_routes.rs`
  - `src/db/audit.js` (61) -> `src/db/audit.rs`
  - `src/lib/loop-guard.js` (43) -> `src/lib/loop_guard.rs`
  - `src/ai/agent-env.js` (75) -> `src/ai/agent_env.rs`
- **Tests to port:**
  - `test/agent-vault-env-cache.test.js` (64)
  - `test/agent-vault-env.test.js` (39)
  - `test/auth-timers.test.js` (56)
  - `test/auth.test.js` (55)
  - `test/loop-guard.test.js` (64)
  - `test/vault.test.js` (104)

### B2: Safe paths, PDF text, brand icon and the files route

- **Needs:** only the foundation
- **Size:** 2283 lines of source, 767 lines of tests
- **Files:**
  - `src/lib/safe-path.js` (114) -> `src/lib/safe_path.rs`
  - `src/lib/url-safety.js` (157) -> `src/lib/url_safety.rs`
  - `src/lib/pdf-text.js` (1021) -> `src/lib/pdf_text.rs`
  - `src/lib/brand-icon.js` (763) -> `src/lib/brand_icon.rs`
  - `src/routes/files.js` (228) -> `src/routes/files.rs`
- **Tests to port:**
  - `test/brand-icon.test.js` (679) (also reads the browser files)
  - `test/safe-path.test.js` (88)

### C1: Workspace files, skills, memory, hooks and plugins

- **Needs:** only the foundation
- **Size:** 2582 lines of source, 302 lines of tests
- **Files:**
  - `src/lib/workspace-files.js` (461) -> `src/lib/workspace_files.rs`
  - `src/lib/skills-engine.js` (242) -> `src/lib/skills_engine.rs`
  - `src/routes/skills.js` (176) -> `src/routes/skills.rs`
  - `src/lib/checkpoint.js` (107) -> `src/lib/checkpoint.rs`
  - `src/lib/boot-context.js` (90) -> `src/lib/boot_context.rs`
  - `src/lib/canvas.js` (173) -> `src/lib/canvas.rs`
  - `src/lib/diagram-renderer.js` (203) -> `src/lib/diagram_renderer.rs`
  - `src/lib/hooks.js` (74) -> `src/lib/hooks.rs`
  - `src/lib/hook-loader.js` (41) -> `src/lib/hook_loader.rs`
  - `src/lib/plugin-sdk.js` (52) -> `src/lib/plugin_sdk.rs`
  - `src/lib/plugin-loader.js` (25) -> `src/lib/plugin_loader.rs`
  - `src/hooks/boot-announce.js` (8) -> `src/hooks/boot_announce.rs`
  - `src/hooks/command-logger.js` (16) -> `src/hooks/command_logger.rs`
  - `src/hooks/session-memory.js` (13) -> `src/hooks/session_memory.rs`
  - `src/lib/agent-registry.js` (176) -> `src/lib/agent_registry.rs`
  - `src/daemon/pid.js` (35) -> `src/daemon/pid.rs`
  - `src/daemon/service.js` (111) -> `src/daemon/service.rs`
  - `src/db/memory.js` (225) -> `src/db/memory.rs`
  - `src/lib/automation-approval.js` (152) -> `src/lib/automation_approval.rs`
  - `src/lib/memory-extractor.js` (37) -> `src/lib/memory_extractor.rs`
  - `src/lib/personality-learner.js` (56) -> `src/lib/personality_learner.rs`
  - `src/routes/memory.js` (61) -> `src/routes/memory.rs`
  - `src/cli/interactive.js` (48) -> `src/cli/interactive.rs`
- **Tests to port:**
  - `test/prompt-audit.test.js` (114)
  - `test/workspace-defaults.test.js` (188)

### D1: Conversations, the live timeline and chat files

- **Needs:** only the foundation
- **Size:** 2130 lines of source, 918 lines of tests
- **Files:**
  - `src/lib/live-bus.js` (316) -> `src/lib/live_bus.rs`
  - `src/db/conversations.js` (317) -> `src/db/conversations.rs`
  - `src/lib/conversation-lock.js` (198) -> `src/lib/conversation_lock.rs`
  - `src/lib/chat-files.js` (198) -> `src/lib/chat_files.rs`
  - `src/lib/sent-files.js` (194) -> `src/lib/sent_files.rs`
  - `src/lib/tool-steps.js` (278) -> `src/lib/tool_steps.rs`
  - `src/lib/message-tools.js` (129) -> `src/lib/message_tools.rs`
  - `src/ai/handoff.js` (143) -> `src/ai/handoff.rs`
  - `src/lib/stream-utils.js` (43) -> `src/lib/stream_utils.rs`
  - `src/lib/gateway.js` (136) -> `src/lib/gateway.rs`
  - `src/lib/acp.js` (107) -> `src/lib/acp.rs`
  - `src/lib/turn-watchdog.js` (71) -> `src/lib/turn_watchdog.rs`
- **Tests to port:**
  - `test/chat-files.test.js` (337) (also reads the browser files)
  - `test/conversation-lock.test.js` (91)
  - `test/handoff.test.js` (119)
  - `test/live-bus.test.js` (371)

### E1: Message formatting for Discord, Slack and email

- **Needs:** only the foundation
- **Size:** 1864 lines of source, 1264 lines of tests
- **Files:**
  - `src/lib/discord-format.js` (676) -> `src/lib/discord_format.rs`
  - `src/lib/reaction-parser.js` (52) -> `src/lib/reaction_parser.rs`
  - `src/lib/slack-format.js` (158) -> `src/lib/slack_format.rs`
  - `src/lib/slack-stream.js` (447) -> `src/lib/slack_stream.rs`
  - `src/lib/email-parser.js` (170) -> `src/lib/email_parser.rs`
  - `src/lib/email-threading.js` (117) -> `src/lib/email_threading.rs`
  - `src/lib/tool-status.js` (105) -> `src/lib/tool_status.rs`
  - `src/channels/turn-notes.js` (55) -> `src/channels/turn_notes.rs`
  - `src/lib/channel-errors.js` (9) -> `src/lib/channel_errors.rs`
  - `src/lib/chat-target.js` (75) -> `src/lib/chat_target.rs`
- **Tests to port:**
  - `test/discord-format.test.js` (296)
  - `test/email-parser.test.js` (350)
  - `test/slack-format.test.js` (175)
  - `test/slack-stream.test.js` (381)
  - `test/tool-status.test.js` (62)

### V1: Voice: engines and installers, lower half

- **Needs:** only the foundation
- **Size:** 1912 lines of source, 623 lines of tests
- **Files:**
  - `src/voice/tts-interface.js` (50) -> `src/voice/tts_interface.rs`
  - `src/voice/install-common.js` (256) -> `src/voice/install_common.rs`
  - `src/voice/tar-extract.js` (278) -> `src/voice/tar_extract.rs`
  - `src/voice/speech-text.js` (72) -> `src/voice/speech_text.rs`
  - `src/voice/edge-tts-engine.js` (122) -> `src/voice/edge_tts_engine.rs`
  - `src/voice/elevenlabs-engine.js` (170) -> `src/voice/elevenlabs_engine.rs`
  - `src/voice/piper-engine.js` (198) -> `src/voice/piper_engine.rs`
  - `src/voice/tts-stub.js` (34) -> `src/voice/tts_stub.rs`
  - `src/voice/whisper-models.js` (202) -> `src/voice/whisper_models.rs`
  - `src/voice/python-runtime.js` (380) -> `src/voice/python_runtime.rs`
  - `src/voice/whisper-engine.js` (150) -> `src/voice/whisper_engine.rs`
- **Tests to port:**
  - `test/installer-downloads.test.js` (209)
  - `test/python-runtime.test.js` (240)
  - `test/whisper-models.test.js` (174)

### V2: Voice: Phonon, speech-to-text and the voice routes

- **Needs:** V1
- **Size:** 2674 lines of source, 1330 lines of tests
- **Files:**
  - `src/voice/phonon-engine.js` (398) -> `src/voice/phonon_engine.rs`
  - `src/voice/stt-install.js` (512) -> `src/voice/stt_install.rs`
  - `src/voice/engine-registry.js` (260) -> `src/voice/engine_registry.rs`
  - `src/voice/stt-handler.js` (395) -> `src/voice/stt_handler.rs`
  - `src/voice/clone-handler.js` (42) -> `src/voice/clone_handler.rs`
  - `src/voice/phonon-install.js` (438) -> `src/voice/phonon_install.rs`
  - `src/routes/voice.js` (552) -> `src/routes/voice.rs`
  - `src/cli/doctor.js` (77) -> `src/cli/doctor.rs`
- **Tests to port:**
  - `test/stt-install.test.js` (275)
  - `test/stt-local.test.js` (208)
  - `test/stt-routes.test.js` (223)
  - `test/tts-phonon.test.js` (624)

### T1: Web terminal, Discord admin and Railway admin

- **Needs:** B1
- **Size:** 1176 lines of source, 1347 lines of tests
- **Files:**
  - `src/websocket/terminal-handler.js` (169) -> `src/websocket/terminal_handler.rs`
  - `src/lib/discord-admin.js` (579) -> `src/lib/discord_admin.rs`
  - `src/lib/railway-admin.js` (428) -> `src/lib/railway_admin.rs`
- **Tests to port:**
  - `test/discord-admin.test.js` (712)
  - `test/railway-admin.test.js` (635)

### S1: Settings store, credentials, push, retention and the system prompt

- **Needs:** A1, A2, A3, B1, C1, D1, I0
- **Size:** 2469 lines of source, 1295 lines of tests
- **Files:**
  - `src/db/settings.js` (542) -> `src/db/settings.rs`
  - `src/lib/credential-inventory.js` (232) -> `src/lib/credential_inventory.rs`
  - `src/lib/push.js` (212) -> `src/lib/push.rs`
  - `src/routes/push.js` (80) -> `src/routes/push.rs`
  - `src/lib/auth-profiles.js` (225) -> `src/lib/auth_profiles.rs`
  - `src/lib/session-reset.js` (137) -> `src/lib/session_reset.rs`
  - `src/lib/auto-checkpoint.js` (264) -> `src/lib/auto_checkpoint.rs`
  - `src/lib/auto-summarize.js` (146) -> `src/lib/auto_summarize.rs`
  - `src/lib/retention.js` (376) -> `src/lib/retention.rs`
  - `src/routes/automation-approval.js` (63) -> `src/routes/automation_approval.rs`
  - `src/lib/build-system-prompt.js` (192) -> `src/lib/build_system_prompt.rs`
- **Tests to port:**
  - `test/ai-security.test.js` (240)
  - `test/conversation-settings-cleanup.test.js` (91)
  - `test/credential-inventory.test.js` (74)
  - `test/db.test.js` (137)
  - `test/push-subject.test.js` (37)
  - `test/secret-fields.test.js` (135)
  - `test/settings-keys.test.js` (374)
  - `test/settings-ship-all.test.js` (67)
  - `test/stt-opt-in.test.js` (140)

### S2: Token usage and the analytics route

- **Needs:** A1, A3, D1, S1
- **Size:** 1552 lines of source, 869 lines of tests
- **Files:**
  - `src/lib/token-usage.js` (1261) -> `src/lib/token_usage.rs`
  - `src/routes/analytics.js` (291) -> `src/routes/analytics.rs`
- **Tests to port:**
  - `test/migration-012.test.js` (199)
  - `test/token-usage.test.js` (415)
  - `test/usage-backup.test.js` (141)
  - `test/usage-exact-cost.test.js` (114)

### S3: The agent tools

- **Needs:** A2, B1, B2, C1, D1, E1, I0, S1, S4, S5, T1
- **Size:** 1961 lines of source, 880 lines of tests
- **Files:**
  - `src/lib/tools.js` (1801) -> `src/lib/tools.rs`
  - `src/lib/tool-registry.js` (160) -> `src/lib/tool_registry.rs`
- **Tests to port:**
  - `test/pdf-read.test.js` (377)
  - `test/push-notification-policy.test.js` (112)
  - `test/send-file.test.js` (237)
  - `test/tool-policy.test.js` (154)

### S4: Tarsee MCP server and media for the engines

- **Needs:** A2, B2, D1, I0, V2
- **Size:** 1203 lines of source, 843 lines of tests
- **Files:**
  - `src/ai/tarsee-mcp.js` (478) -> `src/ai/tarsee_mcp.rs`
  - `src/ai/mcp-http.js` (444) -> `src/ai/mcp_http.rs`
  - `src/ai/media.js` (281) -> `src/ai/media.rs`
- **Tests to port:**
  - `test/mcp-http.test.js` (533)
  - `test/media.test.js` (310)

### S5: Scheduled tasks, background turns, heartbeat, boot checklist and subagents

- **Needs:** A1, A3, A4, B1, C1, D1, I0, S1
- **Size:** 2102 lines of source, 718 lines of tests
- **Files:**
  - `src/lib/cron.js` (869) -> `src/lib/cron.rs`
  - `src/lib/background-turn.js` (284) -> `src/lib/background_turn.rs`
  - `src/lib/heartbeat.js` (250) -> `src/lib/heartbeat.rs`
  - `src/lib/boot-runner.js` (149) -> `src/lib/boot_runner.rs`
  - `src/routes/webhooks.js` (139) -> `src/routes/webhooks.rs`
  - `src/lib/subagents.js` (411) -> `src/lib/subagents.rs`
- **Tests to port:**
  - `test/background-callers.test.js` (266)
  - `test/background-cost.test.js` (62)
  - `test/background-model.test.js` (208)
  - `test/mcp-tools.test.js` (182)

### G1: Claude engine

- **Needs:** A1, A2, A3, A4, B1, D1, I0, S1, S4
- **Size:** 784 lines of source, 1124 lines of tests
- **Files:**
  - `src/ai/providers/claude-code.js` (784) -> `src/ai/providers/claude_code.rs`
- **Tests to port:**
  - `test/claude-auth.test.js` (28)
  - `test/claude-engine.test.js` (692)
  - `test/claude-gateway.test.js` (404)

### G2: Codex engine

- **Needs:** A1, A2, A3, A5, B1, C1, I0, S4
- **Size:** 807 lines of source, 1934 lines of tests
- **Files:**
  - `src/ai/providers/codex.js` (807) -> `src/ai/providers/codex.rs`
- **Tests to port:**
  - `test/codex-engine.test.js` (1555)
  - `test/key-exposure-linux.test.js` (190)
  - `test/retention-codex.test.js` (189)

### G3: The turn layer, model verification and voice calls

- **Needs:** A1, A2, A3, A4, D1, I0, S1, S2, S4
- **Size:** 2122 lines of source, 3133 lines of tests
- **Files:**
  - `src/ai/turn.js` (1233) -> `src/ai/turn.rs`
  - `src/ai/router.js` (15) -> `src/ai/router.rs`
  - `src/ai/verify-model.js` (658) -> `src/ai/verify_model.rs`
  - `src/lib/voice-call.js` (216) -> `src/lib/voice_call.rs`
- **Tests to port:**
  - `test/token-diet.test.js` (118)
  - `test/turn-model-lists.test.js` (258)
  - `test/turn-spend.test.js` (287)
  - `test/turn.test.js` (1475)
  - `test/verify-codex.test.js` (99)
  - `test/verify-model.test.js` (571)
  - `test/voice-call.test.js` (325) (also reads the browser files)

### K1: Chat commands

- **Needs:** A1, A4, C1, D1, I0, S1, S3, S5, V2
- **Size:** 1331 lines of source, 357 lines of tests
- **Files:**
  - `src/lib/commands.js` (1331) -> `src/lib/commands.rs`
- **Tests to port:**
  - `test/commands-model.test.js` (357)

### H1: Telegram and WhatsApp channels

- **Needs:** C1, D1, E1, I0, S1, V2
- **Size:** 1797 lines of source, 1454 lines of tests
- **Files:**
  - `src/channels/telegram.js` (964) -> `src/channels/telegram.rs`
  - `src/channels/whatsapp.js` (747) -> `src/channels/whatsapp.rs`
  - `src/routes/whapi.js` (86) -> `src/routes/whapi.rs`
- **Tests to port:**
  - `test/channel-connect.test.js` (447)
  - `test/channel-tool-status.test.js` (88)
  - `test/channel-turns.test.js` (620)
  - `test/whatsapp.test.js` (299)

### H2: Discord and Slack channels

- **Needs:** C1, D1, E1, I0, S1, T1, V2
- **Size:** 1636 lines of source, 949 lines of tests
- **Files:**
  - `src/channels/discord.js` (724) -> `src/channels/discord.rs`
  - `src/channels/slack.js` (912) -> `src/channels/slack.rs`
- **Tests to port:**
  - `test/discord-format-quotes.test.js` (65)
  - `test/slack-bot.test.js` (671)
  - `test/slack.test.js` (213) (also reads the browser files)

### H3: Email channel, channel manager and channel health

- **Needs:** C1, D1, E1, H1, H2, I0, S1
- **Size:** 1208 lines of source, 188 lines of tests
- **Files:**
  - `src/channels/email.js` (787) -> `src/channels/email.rs`
  - `src/channels/manager.js` (281) -> `src/channels/manager.rs`
  - `src/lib/channel-health.js` (140) -> `src/lib/channel_health.rs`
- **Tests to port:**
  - `test/channel-health-slack.test.js` (47)
  - `test/email-smtp.test.js` (141)

### R1: Chat, models, call, external API and ACP routes

- **Needs:** A1, A2, A4, B1, C1, D1, E1, G3, I0, K1, S1, V2
- **Size:** 1534 lines of source, 797 lines of tests
- **Files:**
  - `src/routes/chat.js` (914) -> `src/routes/chat.rs`
  - `src/routes/models.js` (212) -> `src/routes/models.rs`
  - `src/routes/voice-call.js` (86) -> `src/routes/voice_call.rs`
  - `src/routes/external-api.js` (200) -> `src/routes/external_api.rs`
  - `src/routes/acp.js` (122) -> `src/routes/acp.rs`
- **Tests to port:**
  - `test/call-real-routes.test.js` (257) (also reads the browser files)
  - `test/models-route.test.js` (425)
  - `test/models.test.js` (115)

### R2: AI routes (Settings > AI and the setup wizard)

- **Needs:** A1, A2, A3, A4, B1, G3, I0, S1
- **Size:** 923 lines of source, 1903 lines of tests
- **Files:**
  - `src/routes/ai.js` (923) -> `src/routes/ai.rs`
- **Tests to port:**
  - `test/ai-routes-keys-only.test.js` (168)
  - `test/ai-routes.test.js` (873)
  - `test/ai-ui-real-routes.test.js` (366) (also reads the browser files)
  - `test/local-ai-railway.test.js` (88)
  - `test/local-model-rule.test.js` (150)
  - `test/settings-captcha-key.test.js` (258) (also reads the browser files)

### R4: Settings routes

- **Needs:** A1, A3, A4, B1, B2, C1, I0, S1, S5, V2
- **Size:** 739 lines of source, 2226 lines of tests
- **Files:**
  - `src/routes/settings.js` (739) -> `src/routes/settings.rs`
- **Tests to port:**
  - `test/cron-approval.test.js` (464) (also reads the browser files)
  - `test/provider-base-url.test.js` (116)
  - `test/readiness.test.js` (301)
  - `test/scheduled-tasks.test.js` (952) (also reads the browser files)
  - `test/brand-icon.test.js`: the four cases of the settings routes for the icon, listed under "For package R4" in
    `docs/rust-port/reports/B2.md`
  - `test/settings-key-leftovers.test.js` (147)
  - `test/settings-redact-toggle.test.js` (86)
  - `test/skills-dir.test.js` (46)
  - `test/slack-settings.test.js` (114)

### R3: Admin and debug routes

- **Needs:** A1, A2, A3, A4, B1, C1, I0, S3, S5, V2
- **Size:** 873 lines of source, 959 lines of tests
- **Files:**
  - `src/routes/admin.js` (445) -> `src/routes/admin.rs`
  - `src/routes/debug.js` (428) -> `src/routes/debug.rs`
- **Tests to port:**
  - `test/heartbeat-approval.test.js` (531) (also reads the browser files)
  - `test/usage-providers.test.js` (428)

### Z1: WebSocket channel, server boot and the CLI

- **Needs:** A1, A3, A4, B1, B2, C1, D1, G3, H1, H3, I0, K1, R1, R2, R3, R4, S1, S2, S3, S4, S5, T1, V2
- **Size:** 1264 lines of source, 917 lines of tests
- **Files:**
  - `src/channels/websocket.js` (646) -> `src/channels/websocket.rs`
  - `src/server.js` (488) -> `src/server.rs`
  - `src/cli/index.js` (130) -> `src/cli/mod.rs`
- **Tests to port:**
  - `test/chat-stop.test.js` (171)
  - `test/owner-session.test.js` (549) (also reads the browser files)
  - `test/server-boot.test.js` (197)

### W1: Browser UI: its own tests, and end-to-end tests against the Rust server

- **Needs:** Z1
- **Size:** 0 lines of source, 3932 lines of tests
- **Tests to port:**
  - `test/ai-settings-ui.test.js` (79) (also reads the browser files)
  - `test/ai-ui-browser.test.js` (1591) (also reads the browser files)
  - `test/call-browser.test.js` (693) (also reads the browser files)
  - `test/channel-guides-core.test.js` (75) (also reads the browser files)
  - `test/chat-core.test.js` (287) (also reads the browser files)
  - `test/dialogs.test.js` (235) (also reads the browser files)
  - `test/model-picker-core.test.js` (326) (also reads the browser files)
  - `test/no-native-dialogs.test.js` (285) (also reads the browser files)
  - `test/provider-guides-core.test.js` (251) (also reads the browser files)
  - `test/usage-core.test.js` (110) (also reads the browser files)

### Y1: Deploy files, CI, docs and the tests of the repository itself

- **Needs:** Z1
- **Size:** 0 lines of source, 1610 lines of tests
- **Tests to port:**
  - `test/deploy-docs.test.js` (301) (also reads the browser files)
  - `test/deploy-image.test.js` (675)
  - `test/deps-pins.test.js` (131)
  - `test/fixture-tls.test.js` (58)
  - `test/live-smoke-args.test.js` (84)
  - `test/no-personal-specifics.test.js` (77)
  - `test/provider-guards.test.js` (80)
  - `test/smoke-backends.test.js` (130)
  - `test/stt-worker-real.test.js` (74)

### WEB: tests of the browser files only


### REPO: tests of the repository itself (deploy files, docs, dependency pins)


## After the packages

- **Flip:** remove `src/**/*.js` outside `src/public/`, `test/`, `package.json`, `package-lock.json`,
  `eslint.config.js`; move `src/public/` to `web/`, `src/skills/` to `assets/skills/`, `src/workspace-defaults/` to
  `assets/workspace-defaults/`, `src/i18n/` to `assets/i18n/`, the Python workers to `assets/voice/`.
- **Deploy:** `Dockerfile` (a Rust build stage; a runtime image with the `claude` and `codex` programs, Chromium,
  Python and the speech models as before), `entrypoint.sh`, `railway.toml`, `docker-compose.yml`, `.dockerignore`,
  `.github/workflows/ci.yml` (fmt, clippy, tests on Linux and Windows).
- **Docs:** `README.md`, `docs/providers.md`, `docs/live-testing.md`, release notes with the one breaking change
  (JavaScript hooks and plugins).
- **Whole-system check:** the built binary is started against fake providers and driven through the unchanged
  browser UI; a database made by the Node version is opened by the Rust build.
