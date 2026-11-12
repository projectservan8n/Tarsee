# Shared interfaces: the turn, the engines, the tools, the channels, the commands

In Node about twenty files imported each other in a circle: the turn layer, the two engines, the agent tools, the MCP
server, scheduled tasks, chat commands and the channels. In Rust the calls between them go through the six files
below (package I0). Each interface is a trait whose implementation is stored in the `App`; a caller uses a free
function and never names the implementing module, so it compiles and runs before that module exists, against a fake.

| Interface | File | Implemented by | Called by | Fake (`src/testkit/`) |
|---|---|---|---|---|
| Turn data | `src/ai/turn_types.rs` | (types only) | everyone below | - |
| Start a turn | `src/ai/router.rs` | G3 `ai/turn.rs` | H1 H2 H3 (channels), S5 (cron, background turns, subagents), G3 (`verify_model`), R1 (chat, ACP, external API), Z1 (WebSocket) | `FakeTurnRunner` |
| Engines | `src/ai/engine.rs` | G1 `providers/claude_code.rs`, G2 `providers/codex.rs` | G3 `ai/turn.rs` | `FakeEngine` |
| Tools | `src/lib/tool_api.rs` | S3 `lib/tools.rs` | S4 (MCP server), S5 (a task's direct action), K1 (`/send`), G3 (`voice_call`) | `FakeTools` |
| Channel manager, one channel | `src/channels/api.rs` | H3 `channels/manager.rs`; H1 H2 H3 (the five bots) | S1 (credential inventory), S3 (tools), A4 (self-heal, `routes/health`), K1 (`/status`), G3 (`voice_call`), H1 (`routes/whapi`), H3 (`channel_health`), R1 R3 R4 (voice call, admin, debug, settings), Z1 (boot) | `FakeChannels`, `FakeChannel` |
| Commands | `src/lib/command_api.rs` | K1 `lib/commands.rs` | H1 H2 H3 (channels), R1 (web chat), Z1 (WebSocket) | `FakeCommands` |

## Rules for all of them

- **What Node passed around now comes from the `App`.** `db`, `settingsStore`, `channelManager`, `auditLog` and the
  channels' `chatStream` option are not in any context or option struct. `toolCtx.channelManager` is
  `channels::api::channel_manager(app)`.
- **Each implementing module exposes `pub fn install(app: &App)`** that stores its implementation, and `server.rs`
  (Z1) calls them at boot. Its own tests call it too.

  | Module | `install(app)` does |
  |---|---|
  | `ai/turn.rs` (G3) | `ai::router::install_turn_runner(app, Arc::new(run_turn))` |
  | `ai/providers/claude_code.rs` (G1) | `EngineRegistry::of(app).install(CLAUDE_CODE, engine)` |
  | `ai/providers/codex.rs` (G2) | `EngineRegistry::of(app).install(CODEX, engine)` |
  | `lib/tools.rs` (S3) | `lib::tool_api::install_tool_executor(app, executor)` |
  | `lib/commands.rs` (K1) | `lib::command_api::install_command_handler(app, handler)` |
  | `channels/manager.rs` (H3) | `channels::api::install_channel_manager(app, manager)` |

- **With nothing installed** (a test that did not install it, a package not merged yet):

  | Call | Answer |
  |---|---|
  | `chat_stream` | `{type:"error", message:"Tarsee's turn layer isn't available, so this turn can't run.", recoverable:false}`, then `{type:"done", stopReason:"error"}` |
  | `load_engine("claude-code")` | `Err`: `The claude-code engine can't run turns (it has no run())`; an unknown name: `No AI engine called "x"` |
  | `execute_tool("x", ..)` | `Tool error (x): Tarsee's tools are not installed in this app.` |
  | `channel_manager(app)` | `None` (the Node code allowed that everywhere: handle it as it did) |
  | `process_command` | `Err`: `Tarsee's chat commands are not installed in this app.` |
  | `get_command_list` | empty |

- **You may add to these files** (a field, a method with a default) when your package needs it. Keep
  `..Default::default()` working, and say so in your report.

## 1. Turn data: `ai::turn_types`

`TurnEvent` is what an engine and the turn layer yield. It serialises to the Node object exactly (checked against
events captured from the Node turn layer and both engines), keeps fields it has no name for (`extra`), and keeps an
event it does not know whole (`TurnEvent::Other`).

| Variant | JSON | Notes |
|---|---|---|
| `Route(RouteEvent)` | `{type:"route", provider, engine, model, label, providerLabel, effort, vendor, streaming, backup}` | turn layer only; first, and again with `backup: true` |
| `Text(TextEvent)` | `{type:"text", content}` | |
| `Thinking(ThinkingEvent)` | `{type:"thinking", status:"start"\|"stop"}` | |
| `ToolUse(ToolUseEvent)` | `{type:"tool_use", id, name, input}` | `input` is JSON |
| `ToolResult(ToolResultEvent)` | `{type:"tool_result", id, ok, result}` | `result` is text |
| `Usage(UsageEvent)` | `{type:"usage", usage:{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, context_input_tokens?}, costUsd?, costExact?}` | `costExact` written only when true |
| `Step(StepEvent)` | `{type:"step", kind, ...}` | engines yield them; the turn layer publishes `step.payload()` to the live bus and never passes one on |
| `Error(ErrorEvent)` | `{type:"error", message, subtype?, recoverable?, code?, status?, state?}` | `code` can be absent, `null` or a word: `Option<Option<String>>`, read it with `.code()` |
| `Done(DoneEvent)` | `{type:"done", stopReason, overBudget?, ceilingUsd?, spentUsd?}` | exactly one, last; `.reason()` is `event.stopReason \|\| ...` |
| `Other(Value)` | anything else | passed on untouched |

Reading a turn (what every `for await (const event of chatStream(...))` becomes). An item is `Err` where the Node
generator threw: handle it where the Node code had its `catch`.

```rust
let mut stream = chat_stream(&app, TurnOptions {
    live_source: Some("telegram".into()),
    messages,                                             // Vec<TurnMessage>, the prompt last
    system_parts: Some(SystemParts { stable, volatile }),
    tool_ctx: ToolContext { message_id, ..ToolContext::for_conversation(&conv_id) },
    session_id: conv_store.get_session_handle(&conv_id),
    on_session_id: Some(SessionCallback::new(move |handle| store.set_session_handle(&conv, handle))),
    signal: stop.clone(),                                 // CancellationToken: the Node AbortSignal
    ..Default::default()
});
while let Some(event) = stream.next().await {
    match event? {
        TurnEvent::Route(route) => routed = Some(route),
        TurnEvent::Text(text) => reply.push_str(&text.content),
        TurnEvent::ToolUse(tool) => show_tool(&tool.id, &tool.name, &tool.input).await,
        TurnEvent::ToolResult(result) => mark_done(&result.id, result.ok).await,
        TurnEvent::Usage(usage) => usage.usage.merge_into(&mut tokens),   // usage = { ...usage, ...event.usage }
        TurnEvent::Error(error) => surfaced = Some(error.message),
        TurnEvent::Done(done) => { stop_reason = done.reason().map(str::to_string); break; }
        _ => {}                                           // callers ignore types they don't know
    }
}
```

Making events:

```rust
TurnEvent::text("Hello");
TurnEvent::tool_use("t1", "Bash", json!({"command": "ls"}));
TurnEvent::tool_result("t1", true, "a\nb");
TurnEvent::thinking(ThinkingStatus::Start);
TurnEvent::step(StepEvent::new("status").with("text", "Trying again (2 of 5)."));
TurnEvent::step(StepEvent::from_value(serde_json::to_value(&live_step)?).unwrap());   // { type: "step", ...step }
TurnEvent::Error(ErrorEvent::new(message).with_subtype("not-ready").with_recoverable(false));
TurnEvent::Error(ErrorEvent::new(message).with_code(None));       // code: null
TurnEvent::done("end_turn");
TurnEvent::from_value(json!({"type": "usage", "usage": {...}}));  // never fails
```

An async generator is a `TurnStream` (`BoxStream<'static, anyhow::Result<TurnEvent>>`). `stream_of([...])` makes
one from a list; `turn_channel(n)` gives `(sender, stream)` for work that runs in its own task (stop when `send`
fails: the reader is gone). Dropping the stream is the generator's `return()`: stop the work.

Messages: `TurnMessage::user("hi")`, `TurnMessage::assistant(text).at(row.created_at)`, content blocks
`ContentBlock::image("image/png", base64)`, `::document(..)`, `::audio(..)`, `::text(..)`. A stored row deserialises
as it is (`created_at`, other columns kept in `extra`).

`TurnOptions` has every option `runTurn` read, each documented with its default. Not there: `apiKey`, `baseUrl`,
`tools`, `executeTool` (ignored in Node too), `sessionHandle` (use `session_id`), `onSessionHandle` (use
`on_session_id`), `store`.

## 2. Starting a turn: `ai::router`

`chat_stream(app, options) -> TurnStream` is the Node `chatStream` / `runTurn`. It calls the `TurnRunner` in the app.

```rust
// G3, in ai/turn.rs:
pub fn run_turn(app: &App, options: TurnOptions) -> TurnStream { ... }
pub fn install(app: &App) { ai::router::install_turn_runner(app, Arc::new(run_turn)); }

// A test of anything that starts turns:
let turns = FakeTurnRunner::install(&t.app);
turns.script(json!([
    {"type": "route", "provider": "deepseek", "engine": "claude-code", "model": "deepseek-v4-flash", "label": "DeepSeek Flash"},
    {"type": "text", "content": "Hello."},
    {"type": "done", "stopReason": "end_turn"},
]));
// ... run the code ...
assert_eq!(turns.calls()[0].live_source.as_deref(), Some("telegram"));
```

## 3. Engines: `ai::engine`

`Engine::run(&self, app, opts: EngineOptions) -> EngineStream`. `EngineOptions` is what `runAttempt` passed
(`target`, `messages`, `system_prompt`, `system_parts`, `media`, `signal`, `tool_ctx`, `session_handle`,
`session_id`, `on_session_handle`, `max_turns`, `max_budget_usd`, `thinking_summaries`, `turn_id`, `mcp_grant`, `cwd`,
...). `Target` is `resolveTarget`'s result. Three Node quirks are spelled out as types:

- `session_id: SessionChoice`: `Unset` (no `sessionId` passed: work it out from `session_handle`), `Fresh`
  (`sessionId: null`), `Resume(raw)`.
- `media: Option<EngineMedia>`: `None` (take the last message's own blocks), `Blocks(vec)` (the turn layer's),
  `Adapted { media, text }` (`adaptMedia`'s result; Claude engine only).
- `on_session_handle` stands for both `onSessionHandle` and `onSessionId`; `mcp_grant` for both `mcpGrant` and `mcp`.

An engine's own test seams (`opts.deps` in Node) are not part of this: put them on your engine struct.

```rust
// G1, in ai/providers/claude_code.rs:
impl Engine for ClaudeCodeEngine {
    fn run(&self, app: &App, opts: EngineOptions) -> EngineStream { ... }
}
pub fn install(app: &App) { EngineRegistry::of(app).install(CLAUDE_CODE, Arc::new(ClaudeCodeEngine::default())); }

// G3, in ai/turn.rs:
let engine = load_engine(app, target.engine.as_deref().unwrap_or(""))?;     // registered, else installed
let mut events = engine.run(app, EngineOptions { target, session_id: SessionChoice::from_raw(raw), ..opts });

// A test of the turn layer (test/fakes/fake-engine.js, same vocabulary):
let engine = FakeEngine::register(&t.app, "claude-code", [
    script(json!([{"type": "session", "id": "raw-1"}, {"type": "text", "content": "Hi"}, {"type": "done", "stopReason": "end_turn"}])),
    Script::from_fn(|opts: EngineOptions, call_index| async move { answer("second call") }),   // the last one repeats
]);
// ... run the turn ...
let call = &engine.calls()[0];                 // reads as the EngineOptions, plus .prompt
assert_eq!((call.target.provider.as_str(), call.prompt.as_str()), ("claude", "hi"));
register_engine(&t.app, "claude-code", None);  // take it out again
```

Script lines besides events: `{"type":"session","id"}` (calls `on_session_handle`), `{"type":"wait"}` (until the
signal, then done{aborted}), `{"type":"sleep","ms"}`, `{"type":"throw","message"}` (an `Err` item).

## 4. Tools: `lib::tool_api`

`execute_tool(app, name, args: Value, ctx: &ToolContext) -> String` is the Node `executeTool`. It never fails: a
refusal or an error is the text. `ToolContext` is the Node `toolCtx` without the four handles:
`conversation_id`, `message_id`, `dashboard`, `background`, `channel`, `turn_id`, `provider`, `verify`.

```rust
// S3, in lib/tools.rs:
#[async_trait]
impl ToolExecutor for Tools {
    async fn execute_tool(&self, app: &App, name: &str, args: Value, ctx: &ToolContext) -> ToolOutput { ... }
}
pub fn install(app: &App) { lib::tool_api::install_tool_executor(app, Arc::new(Tools)); }

// A caller (S4's MCP tool, S5's direct action):
let said = execute_tool(&app, "send_message", json!({"channel": "telegram", "message": text}), &ctx).await;

// A test:
let tools = FakeTools::install(&t.app);
tools.respond("send_message", "Message sent to telegram (chat 42): Done");
tools.respond_with("schedule_task", |call| format!("refused in {:?}", call.ctx.background));
assert_eq!(tools.calls()[0].args["channel"], "telegram");    // unscripted tools answer "Unknown tool: <name>"
```

## 5. Channels: `channels::api`

`channel_manager(app) -> Option<Arc<dyn ChannelApi>>`. `ChannelApi` has every call made on a channel manager from
outside `channels/`: `start_all`, `start(kind, config, opts)`, `stop(kind)`, `stop_all`, `restart(kind, opts)`,
`send_message(kind, chat_id, message, opts)`, `send_file(kind, chat_id, path, caption, opts)`, `get_status()`,
`channel(kind)` (the Node `channels.get(kind)`: `ChannelEntry { bot, kind, status, error }`).

`get_status()` gives `ChannelStatuses`, which serialises to the Node object in the manager's order:
`{"telegram":{"status":"running","error":null,"identity":"@bot","inviteUrl":null,"warning":null},"discord":{"status":"not_configured"}}`.

`Channel` is one bot: `stop`, `send_message` (all five), and with defaults `send_file` (not email), `identity`,
`invite_url` (Discord), `warning` (WhatsApp), `health` (Telegram, Slack: `ChannelHealth`), `admin` (Discord),
`send_new` (email), `handle_inbound` (WhatsApp). A default fails with `Unsupported`, which the manager turns into its
own words.

```rust
// H1/H2/H3, one bot:
#[async_trait]
impl Channel for TelegramBot {
    async fn stop(&self) -> anyhow::Result<()> { ... }
    async fn send_message(&self, chat_id: &str, text: &str, opts: &SendOptions) -> anyhow::Result<()> { ... }
    async fn send_file(&self, chat_id: &str, path: &Path, caption: Option<&str>, opts: &SendOptions) -> anyhow::Result<()> { ... }
    fn identity(&self) -> Option<String> { ... }
    fn health(&self) -> Option<ChannelHealth> { Some(ChannelHealth::Telegram { updates_received, handler_active, last_update_at }) }
}
// The constructor the manager calls, the same shape for all five (`config` is the stored `channel.<kind>` setting).
// A refused credential is `lib::channel_errors`' error (E1), so the manager can tell it from a passing failure.
pub async fn create_telegram_bot(app: &App, config: Value, opts: StartOptions) -> anyhow::Result<Arc<dyn Channel>>

// S3's send_message tool (Node: `if (!ctx.channelManager) return "... channel manager unavailable"`):
let Some(manager) = channel_manager(app) else { return "send_message error: channel manager unavailable".into() };
manager.send_message(channel, &target.chat_id, message, SendOptions::thread(target.thread_id)).await

// S3's discord_admin tool (Node: `ctx.channelManager?.channels?.get?.("discord")?.bot`):
let bot = channel_manager(app).and_then(|m| m.channel("discord")).and_then(|entry| entry.bot);

// A test:
let channels = FakeChannels::install(&t.app);
channels.set_status("telegram", ChannelStatus::running(Some("@test_bot")));
channels.set_channel("discord", Arc::new(FakeChannel::new().with_admin("admin says hi")));
channels.respond_with(|call| match call {
    ChannelCall::Restart { kind, .. } if kind == "slack" => Err(anyhow::anyhow!("slack is not configured or not enabled")),
    _ => Ok(()),
});
assert_eq!(channels.calls(), [ChannelCall::SendMessage { kind: "telegram".into(), chat_id: "42".into(), message: "Done".into(), opts: SendOptions::default() }]);
```

The manager's failure texts are the Node ones (`err.to_string()` is `err.message`):
`Channel <kind> is not running or does not support outbound messages`,
`Channel <kind> is not running or does not support file attachments`, `<kind> is not configured or not enabled`.

## 6. Commands: `lib::command_api`

`process_command(app, message, &CommandContext) -> anyhow::Result<CommandResult>`, `get_command_list(app)`,
`extract_playbook_prompt(&result)` are the three things the channels imported from `lib/commands.js`.
`CommandContext { conversation_id, platform, owner }`; `CommandResult { handled, response }`;
`CommandInfo { name, description, usage, category }`. `extract_playbook_prompt` is implemented here (it only reads
the result); `lib/commands.rs` re-exports it.

```rust
// K1, in lib/commands.rs:
#[async_trait]
impl CommandHandler for Commands {
    async fn process_command(&self, app: &App, message: &str, ctx: &CommandContext) -> anyhow::Result<CommandResult> { ... }
    fn get_command_list(&self) -> Vec<CommandInfo> { ... }
}
pub fn install(app: &App) { lib::command_api::install_command_handler(app, Arc::new(Commands)); }

// A channel:
let result = process_command(&app, &text, &CommandContext { conversation_id, platform: Some("telegram".into()), owner }).await?;
if result.handled {
    match extract_playbook_prompt(&result).filter(|p| !p.is_empty()) {      // `if (playbook)`
        Some(playbook) => ai_prompt_override = Some(playbook),
        None => return reply(result.response.unwrap_or_default()).await,
    }
}

// A test:
let commands = FakeCommands::install(&t.app);
commands.respond("help", "Here is what I can do.");
commands.respond("checkpoint", "__PLAYBOOK__\nSave a checkpoint now.");
commands.respond_with("cron", |call| Ok(CommandResult::handled(if call.ctx.owner { "No scheduled tasks yet." } else { "Only the owner can use /cron" })));
assert_eq!(commands.calls()[0].ctx.platform.as_deref(), Some("telegram"));   // unscripted commands are { handled: false }
```

## Porting the Node tests with these

| Node test | Rust |
|---|---|
| `createFakeEngine(scripts)` + `registerEngine(name, engine)` | `FakeEngine::register(&app, name, scripts)` |
| `engine.calls[0].target.provider`, `.prompt`, `.sessionId === null` | `engine.calls()[0].target.provider`, `.prompt`, `.session_id == SessionChoice::Fresh` |
| `createTelegramBot(cfg, db, { chatStream: modelStream })`, `model.script = () => [...]`, `model.calls` | `FakeTurnRunner::install(&app)`, `turns.script(json!([...]))`, `turns.calls()` |
| `model.script = (opts) => [...]` | `turns.script(Script::from_sync(\|opts: &TurnOptions, _\| items(json!([...]))))` |
| a custom `async function*` stream | `turns.stream_with(\|app, opts\| ...)` |
| `{ getStatus: () => ({...}), sendMessage: async (...) => sent.push(...) }` | `FakeChannels::install(&app)`, `set_status`, `calls()` |
| `channels: new Map([["email", { bot: { sendNew } }]])` | `channels.set_channel("email", Arc::new(FakeChannel::new().without_files().with_send_new(sent)))` |
| `executeTool(name, args, { db, settingsStore, background })` | `execute_tool(&app, name, args, &ToolContext { background, ..Default::default() })` |
| `processCommand(text, { settingsStore, db, platform: "web" })` | `process_command(&app, text, &CommandContext { platform: Some("web".into()), ..Default::default() })` |

A Node test that scripted an *engine* to test something above the turn layer (`test/background-callers.test.js`,
`test/scheduled-tasks.test.js`: cron, the heartbeat, BOOT.md) needs the real turn layer between the two. Until G3 is
merged, port it with `FakeTurnRunner` and assert on the `TurnOptions` your code passed (`background`, `model`,
`live_source`, `tool_ctx`, the ceilings); list the assertions about what the turn layer made of them (the provider
and model that ran, the engine's tool context) as waiting for G3.

`tests/it/interfaces.rs` uses all of them together from outside the crate.
