# Review of I0: shared interfaces for the turn, tools, commands and channels

Reviewed at `a9bc6da` (the package is `55fa65f..7957ca6`), against the Node code in the same tree. Every finding
below was confirmed in both sources side by side, and where it says so, by running the Node code or a throwaway Rust
test (deleted again).

`cargo test`: `677 passed` (unit), `51 passed` (integration), `18 ignored` (doc tests). No failures.

## Findings

### 1. A command cannot tell whether its caller handed it the channel manager: `/status` and `/doctor` change on six of seven callers

**Severity: Important** (a missing optional field one caller uses; also a wrong rule in `INTERFACES.md`)

- Node: `src/lib/commands.js:957` (`/status`: `if (ctx.channelManager) { ... "📡 **Channels:** ..." }`),
  `src/lib/commands.js:1174` (`/doctor`: `runDiagnostics(ctx)` with the command's own context) and
  `src/lib/self-heal.js:107` (`if (ctx.channelManager) results.push(checkChannels(ctx.channelManager))`).
- Callers: only `src/routes/chat.js:416` puts `channelManager` in the context of `processCommand`. These do not:
  `src/channels/telegram.js:178`, `discord.js:244`, `slack.js:725` and `:814`, `whatsapp.js:348`, `email.js:320`,
  `websocket.js:363`.
- Rust: `src/lib/command_api.rs:29-48` (`CommandContext { conversation_id, platform, owner }`; line 32 says the
  channel manager is "the app's own now"); `docs/rust-port/INTERFACES.md:19-21` ("`channelManager` ... not in any
  context or option struct").

In Node, `/status` shows the channels line and `/doctor` checks the channels only when the command came through
`POST /api/chat/send`. From Telegram, Discord, Slack, WhatsApp, email and the dashboard's WebSocket neither appears.
With the manager taken from the `App`, K1 always has one, so both answers gain a line on those six callers. K1 cannot
work it out from what it is given: `platform` is `"web"` or `"api"` for both `routes/chat.js:421` and
`channels/websocket.js:369`, and only the first passed a manager. The rule in `INTERFACES.md` is right for the tool
context (`lib/tools.js:914` falls back to the module's manager, so a tool always had one) but not for the command
context.

Confirmed by running Node `processCommand` with the context Telegram builds and with the one `routes/chat.js` builds,
against a stand-in manager:

```
/status with the channels' ctx: (no channel line)
/status with routes/chat.js ctx: 📡 **Channels:** telegram: running · slack: error
/doctor with the channels' ctx: (no channel line)
/doctor with routes/chat.js ctx: ▲ **channels**: slack: token refused
```

What the interface lacks: a way for the caller to say it handed over the channel manager (R1's `POST /send` does;
the channels and Z1's WebSocket do not), and the matching correction to `INTERFACES.md` rule 1 and
`command_api.rs:32`.

### 2. `I0.md` lists `lib/build-system-prompt.js` as "passed through only (now the app's)", but which callers pass the manager changes the prompt

**Severity: Minor** (a wrong claim in the report; the function itself is S1's)

- Node: `src/lib/build-system-prompt.js:68` (`channelManager = null`) and `:160` hand it to
  `src/lib/credential-inventory.js:98-99`, which renders a "**Channels:**" section (`:151-158`) only when it has one.
  Passed by `routes/chat.js:595`, `channels/websocket.js:459`, `routes/external-api.js:86`. Not passed by
  `channels/telegram.js:245`, `discord.js:316`, `slack.js:524`, `whatsapp.js:409`, `email.js:351`,
  `lib/cron.js:639`, `lib/heartbeat.js:93`, `lib/boot-runner.js:100`, `lib/subagents.js:242`, `routes/acp.js:66`.
- Rust guidance: `docs/rust-port/reports/I0.md:129-132`.

Same pattern as finding 1, outside I0's own structs: a turn from a chat channel, a scheduled task, the heartbeat,
BOOT.md, a subagent or ACP has no channels section in its system prompt; the web chat, the WebSocket and the external
API do. Confirmed by running Node `buildSystemPromptParts` with and without a manager (`false` / `true` for the
section). S1 must keep the parameter, and its callers must keep passing it only where Node did; the report should not
say it is the app's.

### 3. `Usage::merge_into` is not `{ ...usage, ...event.usage }` for a usage that leaves counts out

**Severity: Minor**

- Node: every caller gathers usage by spreading (`channels/telegram.js:462`, `routes/chat.js:827`,
  `channels/websocket.js:560`, ...). `routes/chat.js:890` and `websocket.js:591` send the result to the page.
- Rust: `src/ai/turn_types.rs:354-368` (`Usage` reads a missing count as 0 and always writes all four),
  `:391-397` (`merge_into`); `INTERFACES.md:87` presents it as the spread.

A usage event that names only some counts (the scripted ones in `test/channel-turns.test.js:63` and
`test/slack-bot.test.js:177`) gathers `{"input_tokens":12,"output_tokens":3}` in Node and
`{"input_tokens":12,"output_tokens":3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}` in Rust
(confirmed with a throwaway test). The real engines always send all four (`claude-code.js:669-676`,
`codex-events.js:107-114`), so the page sees no difference in production; a ported test that asserts a whole `done`
body built from a partial scripted usage would. The same goes for a partial scripted `route`: `I0.md` difference 2
says the missing fields write back as `null`/`false`, but `provider`, `label` and `providerLabel` write back as `""`.

### 4. The fake engine's sleep test sleeps for real, and the report says paused time is unavailable when it is not

**Severity: Minor** (rule of the port, DESIGN.md test rule 4)

- Rust: `src/testkit/fake_engine.rs:468` (`sleep_waits_that_long_or_ends_aborted_when_stopped_first` waits 40 ms of
  wall time and measures it); `docs/rust-port/reports/I0.md:214-216` ("`tokio`'s `test-util` feature is not
  enabled").
- `Cargo.toml:84-87` has `tokio = { features = ["test-util"] }` as a dev-dependency, at the merged commit and already
  at the package's base `55fa65f`; `src/lib/slack_stream/tests.rs:187` uses `start_paused = true`.

The test can run on paused time like the others; the "changes needed outside this package" item 1 is out of date.

### 5. `command_api.rs` and `I0.md` say `lib/commands.js` reads `ctx.autoSummarize`; it does not

**Severity: Minor** (documentation)

- Rust: `src/lib/command_api.rs:33-35`; `docs/rust-port/reports/I0.md:237`.
- Node: nothing in `src/` reads `autoSummarize`; only `test/commands-model.test.js:274` and `:287` pass it, and
  `commands.js` ignores it. The three it does read and no caller passes are `clearConversation` (`:379`),
  `abortController` (`:1154`) and `ai` (`:49`).

## Checked and found consistent

- **Events.** Every event object yielded or pushed in `ai/turn.js`, `providers/claude-code.js`, `providers/codex.js`,
  `providers/codex-events.js` and `lib/tool-steps.js` has its variant, with every field Node sets, optional where
  Node omits it and nullable where Node sets `null` (`error.code`'s three states, `route.model/engine/effort/vendor`).
  Field types match what Node produces (`status` is a 3-digit number, token counts are integers, `ok` is always a
  boolean). Every variant keeps unknown fields, so no consumer field is lost: `tool_result.name`
  (`routes/chat.js:823`, `websocket.js:557`), `error.code` (`routes/chat.js:830`), `done.overBudget/ceilingUsd/
  spentUsd` and `usage.costUsd` (`lib/background-turn.js:240-253`), the route's `label`, `providerLabel`,
  `streaming`, `backup`. No consumer forwards a whole event to the browser: `routes/chat.js` and `websocket.js` build
  their own SSE/WebSocket messages from fields, and the live timeline gets `step.payload()`, a free-form map in
  Node's key order.
- **Turn options.** Every option every caller passes (`websocket.js:521`, `routes/chat.js:716`,
  `external-api.js:112`, `acp.js:82`, the five channels, `background-turn.js:220`, `subagents.js:271`,
  `verify-model.js:459`) and every `opts.<name>` `turn.js` reads is in `TurnOptions` with its default, except the
  ones it lists as not read (`sessionHandle`, `onSessionHandle`, `store`, the legacy four).
- **Engines.** `EngineOptions` carries all 23 keys `runAttempt` passes (`turn.js:759-785`; `mcp`/`mcpGrant` and
  `onSessionId`/`onSessionHandle` merged, the same values). `Target` and `TargetCaps` match `targetFor` and `capsFor`
  (exactly five caps). `SessionChoice` covers `Object.hasOwn(opts, "sessionId")` (`claude-code.js:444`) and Codex's
  handle-first order (`codex.js:202-208`); `EngineMedia` covers both `media` forms. The fake engine plays every item
  of `test/fakes/fake-engine.js` with the same rules (record at first read, session without a yield, wait/sleep end
  aborted, throw ends the stream, the signal checked before each event, the last script repeats, async functions).
- **Tools, commands, channels.** `executeTool`'s three arguments and text result; the tool context's every key
  (`toolCtx` built at the 15 sites in `src/`; `channel` read and never set, as reported). `processCommand`,
  `extractPlaybookPrompt`, `getCommandList` are all that is imported from `lib/commands.js`; the result and list shapes
  match Node (all 28 commands have string fields, checked by running Node). Every call on a channel manager outside
  `channels/` (`startAll`, `start`, `stop`, `stopAll`, `restart`, `sendMessage`, `sendFile`, `getStatus`,
  `channels.get(kind)` with `bot`, `status`, `error`) and on a bot (`health`, `admin`, `sendNew`, `handleInbound`) is
  in `ChannelApi`, `ChannelEntry` and `Channel`; `ChannelStatuses` serialises as `getStatus()` in Node's order.
- **The import graph.** Every import from a package to one not merged before it (PLAN.md "Needs", closed over, with
  the batches) goes through one of these interfaces, as the report says (the one other hit,
  `credential-inventory.js` to `channels/manager.js`, is a JSDoc type only).
- **Fakes.** The hand-built managers and streams of `test/channel-turns.test.js`, `test/slack-bot.test.js`,
  `test/send-file.test.js`, `test/voice-call.test.js`, `test/discord-admin.test.js`, `test/whatsapp.test.js`,
  `test/channel-health-slack.test.js` and the fake-engine scripts of `test/turn.test.js`,
  `test/scheduled-tasks.test.js`, `test/background-callers.test.js` can be written with `FakeTurnRunner`
  (`stream_with` for a stream that ignores the stop), `FakeChannels`/`FakeChannel` and `FakeEngine` (a script that
  calls a tool captures an `App` clone). The two background test files need the real turn layer, as `INTERFACES.md`
  says.
- **Rules of the port.** Registries and installed implementations are `App` services (`app.set`, `get_or_init`); no
  `static` state, no environment reads; no lock is held across an `.await` in the fakes or the registry.

## Verdict

COMPLETE: yes
FAITHFUL: no
