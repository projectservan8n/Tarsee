//! The shared interfaces of the port (docs/rust-port/INTERFACES.md), used from outside the crate the way the
//! packages and their tests use them: a caller of the turn layer, a turn layer over the engine registry, and the
//! tools reaching the channel manager, each against its stand-in.

use std::sync::Arc;

use futures::StreamExt;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tarsee::App;
use tarsee::ai::engine::{CLAUDE_CODE, EngineMedia, EngineOptions, SessionChoice, Target, load_engine};
use tarsee::ai::router::{chat_stream, install_turn_runner};
use tarsee::ai::turn_types::{
    ErrorEvent, RouteEvent, SessionCallback, SystemParts, TurnEvent, TurnMessage, TurnOptions, TurnStream, turn_channel,
};
use tarsee::channels::api::{ChannelStatus, SendOptions, channel_manager};
use tarsee::lib::command_api::{CommandContext, extract_playbook_prompt, process_command};
use tarsee::lib::tool_api::{ToolContext, execute_tool};
use tarsee::testkit::fake_engine::{Script, answer, items};
use tarsee::testkit::{ChannelCall, FakeChannels, FakeCommands, FakeEngine, FakeTools, FakeTurnRunner, test_app};

/// What one message came to, as a channel would report it.
#[derive(Debug, Default)]
struct Outcome {
    command_reply: Option<String>,
    reply: String,
    tools: Vec<String>,
    error: Option<String>,
    ran_on: Option<RouteEvent>,
    tokens_in: u64,
    stop_reason: Option<String>,
}

/// A message's way through a chat channel, as `channels/telegram.js` and the others take it: a command is answered
/// (or its playbook becomes the prompt), anything else is one turn whose events are read to the done.
async fn handle_message(app: &App, text: &str, stored_session: Arc<Mutex<Option<String>>>) -> anyhow::Result<Outcome> {
    let mut outcome = Outcome::default();
    let mut prompt = text.to_string();
    if text.starts_with('/') {
        // (A chat channel hands a command no channel manager; only the web chat's POST /send does.)
        let ctx = CommandContext {
            conversation_id: Some("conv-1".into()),
            platform: Some("telegram".into()),
            owner: false,
            ..Default::default()
        };
        let result = process_command(app, text, &ctx).await?;
        if result.handled {
            match extract_playbook_prompt(&result).filter(|playbook| !playbook.is_empty()) {
                Some(playbook) => prompt = playbook,
                None => {
                    outcome.command_reply = result.response;
                    return Ok(outcome);
                }
            }
        }
    }

    let store = stored_session.clone();
    let mut stream = chat_stream(
        app,
        TurnOptions {
            live_source: Some("telegram".into()),
            messages: vec![TurnMessage::user(prompt)],
            system_parts: Some(SystemParts {
                stable: "SOUL".into(),
                volatile: "\n\n## Today".into(),
            }),
            tool_ctx: ToolContext {
                message_id: Some("m1".into()),
                ..ToolContext::for_conversation("conv-1")
            },
            session_id: stored_session.lock().clone(),
            on_session_id: Some(SessionCallback::new(move |handle| {
                *store.lock() = Some(handle.to_string())
            })),
            ..Default::default()
        },
    );
    while let Some(event) = stream.next().await {
        match event? {
            TurnEvent::Route(route) => outcome.ran_on = Some(route),
            TurnEvent::Text(text) => outcome.reply.push_str(&text.content),
            TurnEvent::ToolUse(tool) => outcome.tools.push(tool.name),
            TurnEvent::Error(error) => outcome.error = Some(error.message),
            TurnEvent::Usage(usage) => {
                let u = usage.usage;
                outcome.tokens_in = u.input() + u.cache_read() + u.cache_creation();
            }
            TurnEvent::Done(done) => {
                outcome.stop_reason = done.reason().map(str::to_string);
                break;
            }
            _ => {}
        }
    }
    Ok(outcome)
}

#[tokio::test]
async fn a_caller_of_the_turn_layer_runs_against_the_stand_ins() {
    let t = test_app();
    let commands = FakeCommands::install(&t.app);
    commands.respond("help", "Here is what I can do.");
    commands.respond("checkpoint", "__PLAYBOOK__\nSave a checkpoint now.");
    let turns = FakeTurnRunner::install(&t.app);
    turns.script(json!([
        {"type": "route", "provider": "deepseek", "engine": "claude-code", "model": "deepseek-v4-flash", "label": "DeepSeek Flash", "providerLabel": "DeepSeek API key", "effort": null},
        {"type": "session", "id": "deepseek/cc/deepseek:raw-1"},
        {"type": "text", "content": "Let me look. "},
        {"type": "tool_use", "id": "toolu_9", "name": "Bash", "input": {"command": "ls"}},
        {"type": "tool_result", "id": "toolu_9", "ok": true, "result": "a\nb"},
        {"type": "text", "content": "Two files."},
        {"type": "usage", "usage": {"input_tokens": 12, "output_tokens": 3, "cache_read_input_tokens": 100}},
        {"type": "done", "stopReason": "end_turn"},
    ]));
    let session = Arc::new(Mutex::new(None));

    // A command is answered without a turn.
    let help = handle_message(&t.app, "/help", session.clone()).await.unwrap();
    assert_eq!(help.command_reply.as_deref(), Some("Here is what I can do."));
    assert!(turns.calls().is_empty(), "a command never reaches the AI");

    // An ordinary message is one turn.
    let said = handle_message(&t.app, "list my files", session.clone()).await.unwrap();
    assert_eq!(said.reply, "Let me look. Two files.");
    assert_eq!(said.tools, ["Bash"]);
    assert_eq!(said.tokens_in, 112);
    assert_eq!(said.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(said.ran_on.as_ref().unwrap().label, "DeepSeek Flash");
    assert_eq!(
        session.lock().as_deref(),
        Some("deepseek/cc/deepseek:raw-1"),
        "the session it ran in was stored"
    );
    let call = &turns.calls()[0];
    assert_eq!(call.live_source.as_deref(), Some("telegram"));
    assert_eq!(call.messages, [TurnMessage::user("list my files")]);
    assert_eq!(call.session_id, None, "the first turn had no session to resume");
    assert!(call.provider.is_none() && call.model.is_none() && call.system_prompt.is_none());

    // A playbook command becomes the prompt of a turn, which resumes the stored session.
    handle_message(&t.app, "/checkpoint", session.clone()).await.unwrap();
    let call = &turns.calls()[1];
    assert_eq!(call.messages, [TurnMessage::user("Save a checkpoint now.")]);
    assert_eq!(call.session_id.as_deref(), Some("deepseek/cc/deepseek:raw-1"));
    assert_eq!(commands.calls().len(), 2);
    assert_eq!(commands.calls()[1].ctx.platform.as_deref(), Some("telegram"));

    // A turn that is refused: the reason is the reply and the error at once.
    let refusal = "Tarsee isn't connected to an AI yet: open Settings > AI.";
    turns.script(vec![
        TurnEvent::text(refusal),
        TurnEvent::Error(
            ErrorEvent::new(refusal)
                .with_subtype("not-ready")
                .with_recoverable(false),
        ),
        TurnEvent::done("not-ready"),
    ]);
    let refused = handle_message(&t.app, "hi", session.clone()).await.unwrap();
    assert_eq!(
        (refused.reply.as_str(), refused.error.as_deref()),
        (refusal, Some(refusal))
    );
    assert_eq!(refused.stop_reason.as_deref(), Some("not-ready"));
    assert!(refused.ran_on.is_none());

    // A turn layer that throws reaches the caller's own failure path.
    turns.script(json!([{"type": "text", "content": "half"}, {"type": "throw", "message": "the turn layer broke"}]));
    let failed = handle_message(&t.app, "hi", session).await.unwrap_err();
    assert_eq!(failed.to_string(), "the turn layer broke");
}

/// A turn layer in miniature over the engine registry: what `ai/turn.rs` does with an engine, less everything that
/// makes it the turn layer. It runs in a task of its own and sends its events down a channel.
fn tiny_turn_layer(app: &App, options: TurnOptions) -> TurnStream {
    let (tx, stream) = turn_channel(16);
    let app = app.clone();
    tokio::spawn(async move {
        let target = Target {
            provider: "claude".into(),
            provider_id: "claude".into(),
            engine: Some(CLAUDE_CODE.into()),
            model: Some("sonnet".into()),
            label: "Claude Sonnet".into(),
            ..Default::default()
        };
        let route = RouteEvent {
            provider: target.provider.clone(),
            engine: target.engine.clone(),
            model: target.model.clone(),
            label: target.label.clone(),
            streaming: true,
            ..Default::default()
        };
        if tx.send(Ok(TurnEvent::Route(route))).await.is_err() {
            return;
        }
        let engine = match load_engine(&app, CLAUDE_CODE) {
            Ok(engine) => engine,
            Err(err) => {
                let _ = tx.send(Ok(TurnEvent::error(err.to_string()))).await;
                let _ = tx.send(Ok(TurnEvent::done("error"))).await;
                return;
            }
        };
        let caller_callback = options.on_session_id.clone();
        let parts = options.system_parts.clone().unwrap_or_default();
        let mut events = engine.run(
            &app,
            EngineOptions {
                model: target.model.clone(),
                target,
                messages: options.messages.clone(),
                system_prompt: format!("{}{}", parts.stable, parts.volatile),
                system_parts: Some(parts),
                media: Some(EngineMedia::Blocks(Vec::new())),
                signal: options.signal.clone(),
                tool_ctx: options.tool_ctx.clone(),
                session_handle: options.session_id.clone(),
                session_id: SessionChoice::from_raw(options.session_id.clone()),
                on_session_handle: caller_callback,
                max_turns: Some(options.max_turns.unwrap_or(50)),
                turn_id: Some("turn-1".into()),
                live_source: options.live_source.clone(),
                background: options.background,
                ..Default::default()
            },
        );
        while let Some(item) = events.next().await {
            let event = match item {
                Ok(TurnEvent::Step(_)) => continue,
                Ok(event) => event,
                Err(err) => {
                    let _ = tx.send(Ok(TurnEvent::error(err.to_string()))).await;
                    let _ = tx.send(Ok(TurnEvent::done("error"))).await;
                    return;
                }
            };
            let done = event.is_done();
            if tx.send(Ok(event)).await.is_err() || done {
                return;
            }
        }
    });
    stream
}

async fn collect(stream: TurnStream) -> Vec<TurnEvent> {
    stream.map(|item| item.expect("the turn failed")).collect().await
}

#[tokio::test]
async fn a_turn_layer_runs_a_scripted_engine_that_calls_tarsees_tools() {
    let t = test_app();
    install_turn_runner(&t.app, Arc::new(tiny_turn_layer));
    let tools = FakeTools::install(&t.app);
    tools.respond("send_message", "Message sent to telegram (chat 42): Done");

    // The engine calls one of Tarsee's tools with the turn's own tool context, then answers
    // (test/scheduled-tasks.test.js does the same with `callInProcess(opts.toolCtx, ...)`).
    let app = t.app.clone();
    let tool_said = Arc::new(Mutex::new(Vec::<String>::new()));
    let outs = tool_said.clone();
    let engine = FakeEngine::register(
        &t.app,
        CLAUDE_CODE,
        [Script::from_fn(move |opts: EngineOptions, _index| {
            let (app, outs) = (app.clone(), outs.clone());
            async move {
                let said = execute_tool(
                    &app,
                    "send_message",
                    json!({"channel": "telegram", "message": "Done"}),
                    &opts.tool_ctx,
                )
                .await;
                outs.lock().push(said);
                items(json!([
                    {"type": "session", "id": "raw-7"},
                    {"type": "step", "kind": "tool_start", "id": "t1", "name": "tarsee_send_message"},
                    {"type": "tool_use", "id": "t1", "name": "mcp__tarsee__tarsee_send_message", "input": {"channel": "telegram", "message": "Done"}},
                    {"type": "tool_result", "id": "t1", "ok": true, "result": "sent"},
                    {"type": "text", "content": "Sent."},
                    {"type": "done", "stopReason": "end_turn"},
                ]))
            }
        })],
    );

    let stored = Arc::new(Mutex::new(None::<String>));
    let store = stored.clone();
    let events = collect(chat_stream(
        &t.app,
        TurnOptions {
            messages: vec![TurnMessage::user("tell me when it is done")],
            tool_ctx: ToolContext {
                background: Some("cron".into()),
                ..ToolContext::for_conversation("conv-9")
            },
            background: true,
            live_source: Some("cron".into()),
            on_session_id: Some(SessionCallback::new(move |handle| {
                *store.lock() = Some(handle.to_string())
            })),
            ..Default::default()
        },
    ))
    .await;

    assert_eq!(
        events.iter().map(TurnEvent::event_type).collect::<Vec<_>>(),
        ["route", "tool_use", "tool_result", "text", "done"],
        "steps stay with the turn layer"
    );
    assert_eq!(stored.lock().as_deref(), Some("raw-7"));
    assert_eq!(*tool_said.lock(), ["Message sent to telegram (chat 42): Done"]);

    // What each stand-in was asked.
    let call = &engine.calls()[0];
    assert_eq!(call.prompt, "tell me when it is done");
    assert_eq!(call.target.provider_id(), "claude");
    assert_eq!(
        (call.max_turns, call.background, call.live_source.as_deref()),
        (Some(50), true, Some("cron"))
    );
    assert_eq!(call.session_id, SessionChoice::Fresh);
    assert_eq!(call.tool_ctx.background.as_deref(), Some("cron"));

    let tool_call = &tools.calls()[0];
    assert_eq!(tool_call.name, "send_message");
    assert_eq!(tool_call.ctx.conversation_id.as_deref(), Some("conv-9"));
    assert_eq!(
        tool_call.ctx.background.as_deref(),
        Some("cron"),
        "the tool knows it runs in background work"
    );
}

/// What `lib/tools.js`'s send_message does with the channel manager: there may be none.
async fn send_through_channel(app: &App, channel: &str, chat_id: &str, message: &str) -> String {
    let Some(manager) = channel_manager(app) else {
        return "send_message error: channel manager unavailable".into();
    };
    match manager
        .send_message(channel, chat_id, message, SendOptions::default())
        .await
    {
        Ok(()) => format!("Message sent to {channel} (chat {chat_id}): {message}"),
        Err(err) => format!("send_message error: {err}"),
    }
}

#[tokio::test]
async fn a_tool_asks_the_app_for_the_channel_manager() {
    let t = test_app();
    assert_eq!(
        send_through_channel(&t.app, "telegram", "42", "Done").await,
        "send_message error: channel manager unavailable"
    );

    let channels = FakeChannels::install(&t.app);
    channels.set_status("telegram", ChannelStatus::running(Some("@test_bot")));
    assert_eq!(
        send_through_channel(&t.app, "telegram", "42", "Done").await,
        "Message sent to telegram (chat 42): Done"
    );
    assert_eq!(
        channels.calls(),
        [ChannelCall::SendMessage {
            kind: "telegram".into(),
            chat_id: "42".into(),
            message: "Done".into(),
            opts: SendOptions::default()
        }]
    );
    channels.respond_with(|_| {
        Err(anyhow::anyhow!(
            "Channel discord is not running or does not support outbound messages"
        ))
    });
    assert_eq!(
        send_through_channel(&t.app, "discord", "1", "hi").await,
        "send_message error: Channel discord is not running or does not support outbound messages"
    );
    let status = channel_manager(&t.app).unwrap().get_status();
    assert!(status.get("telegram").unwrap().is_running());
    assert_eq!(
        serde_json::to_value(&status).unwrap(),
        json!({"telegram": {"status": "running", "error": null, "identity": "@test_bot", "inviteUrl": null, "warning": null}})
    );
}

/// A command is not a tool: it has the channel manager only when its caller handed it over. Of the seven callers
/// of `processCommand` only `routes/chat.js` does, so `/status` shows its channels line there and nowhere else.
#[tokio::test]
async fn a_command_gets_the_channel_manager_from_its_caller_not_from_the_app() {
    let t = test_app();
    let channels = FakeChannels::install(&t.app);
    channels.set_status("telegram", ChannelStatus::running(Some("@test_bot")));
    let commands = FakeCommands::install(&t.app);
    // As lib/commands.js does: `if (ctx.channelManager) { ...getStatus()... }`.
    commands.respond_with("status", |call| {
        let mut lines = vec!["**Tarsee Status**".to_string()];
        if let Some(manager) = &call.ctx.channel_manager {
            let said: Vec<String> = manager
                .get_status()
                .iter()
                .map(|(kind, status)| format!("{kind}: {}", status.status.as_str()))
                .collect();
            lines.push(format!("📡 **Channels:** {}", said.join(" · ")));
        }
        Ok(tarsee::lib::command_api::CommandResult::handled(lines.join("\n")))
    });

    // A chat channel (and the dashboard's WebSocket): the context as they build it.
    let from_telegram = CommandContext {
        conversation_id: Some("conv-1".into()),
        platform: Some("telegram".into()),
        owner: true,
        ..Default::default()
    };
    let said = process_command(&t.app, "/status", &from_telegram).await.unwrap();
    assert_eq!(said.response.as_deref(), Some("**Tarsee Status**"));

    // The web chat's POST /send: `channelManager: req.app.get("channelManager")`.
    let from_the_web_chat = CommandContext {
        conversation_id: Some("conv-1".into()),
        platform: Some("web".into()),
        channel_manager: channel_manager(&t.app),
        ..Default::default()
    };
    let said = process_command(&t.app, "/status", &from_the_web_chat).await.unwrap();
    assert_eq!(
        said.response.as_deref(),
        Some("**Tarsee Status**\n📡 **Channels:** telegram: running")
    );
}

#[tokio::test]
async fn with_nothing_installed_each_interface_says_so_in_its_own_way() {
    let t = test_app();
    // A turn: an error and one done.
    let events = collect(chat_stream(&t.app, TurnOptions::default())).await;
    assert_eq!(
        events.iter().map(TurnEvent::event_type).collect::<Vec<_>>(),
        ["error", "done"]
    );
    // A tool: words, like any tool that fails.
    assert_eq!(
        execute_tool(&t.app, "datetime", json!({}), &ToolContext::default()).await,
        "Tool error (datetime): Tarsee's tools are not installed in this app."
    );
    // A command: a failure for the caller's own catch.
    assert!(
        process_command(&t.app, "/help", &CommandContext::default())
            .await
            .is_err()
    );
    // The channel manager: none, as the Node code allowed.
    assert!(channel_manager(&t.app).is_none());
    // An engine: no engine can run turns.
    assert!(load_engine(&t.app, CLAUDE_CODE).is_err());
}

#[tokio::test]
async fn a_crashed_or_missing_engine_is_the_turn_layers_to_report() {
    let t = test_app();
    install_turn_runner(&t.app, Arc::new(tiny_turn_layer));

    // No engine at all under the name.
    let events = collect(chat_stream(&t.app, TurnOptions::default())).await;
    let TurnEvent::Error(error) = &events[1] else {
        panic!("not an error: {:?}", events[1])
    };
    assert_eq!(
        error.message,
        "The claude-code engine can't run turns (it has no run())"
    );

    // One that crashes after its first words.
    FakeEngine::register(
        &t.app,
        CLAUDE_CODE,
        [Script::Items(items(
            json!([{"type": "text", "content": "half"}, {"type": "throw", "message": "spawn claude ENOENT"}]),
        ))],
    );
    let events = collect(chat_stream(&t.app, TurnOptions::default())).await;
    let shown: Vec<Value> = events.iter().skip(1).map(TurnEvent::to_value).collect();
    assert_eq!(
        shown,
        [
            json!({"type": "text", "content": "half"}),
            json!({"type": "error", "message": "spawn claude ENOENT"}),
            json!({"type": "done", "stopReason": "error"}),
        ]
    );

    // One that is stopped while it works.
    FakeEngine::register(
        &t.app,
        CLAUDE_CODE,
        [Script::Items(items(
            json!([{"type": "text", "content": "Working"}, {"type": "wait"}]),
        ))],
    );
    let options = TurnOptions::default();
    let stop = options.signal.clone();
    let mut stream = chat_stream(&t.app, options);
    assert_eq!(stream.next().await.unwrap().unwrap().event_type(), "route");
    assert_eq!(stream.next().await.unwrap().unwrap(), TurnEvent::text("Working"));
    stop.cancel();
    assert_eq!(stream.next().await.unwrap().unwrap(), TurnEvent::done("aborted"));

    // And back to the first engine's kind of answer, to show a registered engine is replaced by the next.
    FakeEngine::register(&t.app, CLAUDE_CODE, [Script::Items(answer("Fine."))]);
    assert_eq!(
        collect(chat_stream(&t.app, TurnOptions::default())).await[1],
        TurnEvent::text("Fine.")
    );
}
