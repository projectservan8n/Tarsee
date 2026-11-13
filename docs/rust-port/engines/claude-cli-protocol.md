# The `claude` program, as Tarsee's Node version drives it

The Node version runs a Claude Code turn through `@anthropic-ai/claude-agent-sdk` 0.3.319, which starts the `claude`
program and talks to it in JSON lines. The Rust version has no SDK: `src/ai/providers/claude_code.rs` starts the
program itself. This document says exactly what the SDK does for the options Tarsee uses, so the Rust engine can do
the same, and what the program answers.

**Versions.** SDK 0.3.319. The program it ships: Claude Code 2.1.319 (`claude --version` prints
`2.1.319 (Claude Code)`; the SDK's `manifest.json` gives build date 2026-11-05). Everything was recorded on
Windows 11 with Node 22.18. The SDK's code is minified, so the identifiers quoted from `sdk.mjs` (`Vx`, `Yy`, `ck`,
`uk`) are that build's; search for the strings next to them.

**How to read the evidence marks.**

- **[capture: path]** seen happening, and written down in a file under `tests/fixtures/claude-cli/`. The fixture
  folder's `README.md` says how each kind was made.
- **[source: name]** read in the SDK's `sdk.mjs` or its type file `sdk.d.ts`, not seen happening.
- **NOT CONFIRMED** could not be checked; what was tried is said.

A second person then checked this document without using the first captures: a new stub, a new stand-in API, a new
logging MCP server, and runs of the real program, on Windows and (for the SDK's stop) under Linux. Those files are
in `tests/fixtures/claude-cli/verify/`, cited here as **[capture: verify/…]**. What that pass confirmed, what it
corrected and what is still open is in [section 10](#10-checked-independently).

Nothing here came from a real account: no sign-in, no real key, no model call.

Contents: [0. The whole turn in short](#0-the-whole-turn-in-short) ·
[1. Starting the program](#1-starting-the-program) · [2. What is written to stdin](#2-what-is-written-to-stdin) ·
[3. What the program writes to stdout](#3-what-the-program-writes-to-stdout) ·
[4. Tarsee's tools (MCP)](#4-tarsees-tools-mcp) · [5. Stopping a turn](#5-stopping-a-turn) ·
[6. Ending and failing](#6-ending-and-failing) · [7. Sessions on disk](#7-sessions-on-disk) ·
[8. What the Node engine gets wrong](#8-what-the-node-engine-gets-wrong) ·
[9. Not confirmed](#9-not-confirmed) · [10. Checked independently](#10-checked-independently)

---

## 0. The whole turn in short

One turn is one process. In order:

1. Start `claude` with the arguments of 1.2, the environment of 1.4, the turn's workspace as the working folder,
   and stdin, stdout and stderr as pipes. No shell.
2. Write two lines to stdin, one after the other, without waiting for anything: the `initialize` control request
   (it carries the system prompt) and the user message (2.2, 2.3).
3. Read stdout a line at a time. Each line is one JSON object. A few kinds are the SDK's own business and never
   reach Tarsee's code (3.1); the rest are the messages of 3.2.
4. When the `result` message arrives the turn is over. Close stdin; the program exits within a tenth of a second
   or so, with code 0 after a success and 1 after a result that is an error (6.1).
5. To stop a turn early the SDK closes stdin and, when the program is still running after that, kills it (5).
   Closing stdin stops nothing by itself: the program goes on with the turn (more model calls, more tools) until
   its `result`, and only then exits. The program also takes an `interrupt` request, which the SDK never sends for
   Tarsee and which stops it far faster.

The real program was driven exactly this way with no SDK in between. The 30 runs in
`tests/fixtures/claude-cli/real/` and the runs in `mcp-http/` are the result **[capture: real/turn-plain-text.json
and the rest]**. It was also done once from Rust, with the standard library only (`scripts/rust-probe.rs.txt`, 90
lines): the program answered `initialize`, wrote `system/init` naming the MCP server from the `--mcp-config` JSON,
then its `result`, and exited when stdin was closed **[capture: real/rust-probe-output.txt]**.

---

## 1. Starting the program

### 1.1 The executable

**What the SDK starts.** Tarsee passes no `pathToClaudeCodeExecutable`, so the SDK looks for the binary in its own
optional platform package: `@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude` (`claude.exe` on Windows; on
Linux it tries the glibc package and the `-musl` one, whichever matches the system first), resolved from the SDK's
own folder. If none is there it throws
`Native CLI binary for <platform>-<arch> not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`
**[source: `v3`, and the block in `ck` that calls it]**. Recorded: the command was
`<TARSEE_ROOT>\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe` and the arguments were the flags
alone **[capture: sdk/20-plan-command-the-sdk-starts.json]**.

A path that ends in `.js`, `.mjs`, `.ts`, `.tsx` or `.jsx` is started as `node <path> <flags>` instead; anything
else is treated as a native binary and started directly **[source: `l5e`]**. Tarsee always gets the native form.

**What the Rust version uses.** Per DESIGN decision 2: the path in `TARSEE_CLAUDE_PATH`, else `claude` on the
PATH. Four things to know:

- The SDK never goes through a shell, and the arguments hold JSON, `*`, `[` and `~`. On Windows, start a real
  executable. Rust's `Command` hands the native `claude.exe` these arguments intact, the `--mcp-config` JSON
  included, with a cleared environment **[capture: real/rust-probe-output.txt]**.
- A `.cmd` wrapper (what an npm global install leaves on the PATH). A second probe, Rust 1.95 standard library,
  started a native program through a wrapper of the form `"%~dp0claude.exe" %*` with the HTTP-server argument list
  of 1.2 plus a folder name holding a space, `&` and `%`: every argument arrived unchanged
  **[capture: verify/rust-probe-windows.txt; scripts/verify/probe.rs.txt, shim.cmd.txt]**. Two things stay open or
  need care: npm's own wrapper (which may start `node cli.js %*` instead of a native file) was not tried, so that
  form is NOT CONFIRMED; and behind any wrapper the process the engine holds is `cmd.exe`, not `claude`, so killing
  it (5) leaves `claude` running: ending a process on Windows does not end the ones it started (seen with the
  second pass's stub, a launcher and its child: the SDK ended the launcher and the child lived on, 5.1). An engine
  that accepts a wrapper has to end the whole process tree (a job object on Windows). Prefer resolving to the
  native `claude.exe`.
- Everything below was seen on 2.1.319. The program on a machine's PATH may be newer. Three of the arguments the
  SDK passes for Tarsee are not in `claude --help`: `--thinking`, `--thinking-display` and `--max-turns`. All the
  others of 1.2 are **[capture: verify/help-2.1.319.txt, the whole help text]**. The three work on 2.1.319: with
  `--thinking=adaptive --thinking-display=summarized --effort=high` the program's request to the API carried
  `"thinking":{"type":"adaptive","display":"summarized"}` and `"output_config":{"effort":"high"}`
  **[capture: real/turn-thinking-and-effort.json, real/fail-max-turns.json;
  verify/models-credentials-retry-thinking.txt, last case; verify/real.json `s11-max-turns`]**.
- There is no `-p` / `--print`. The SDK does not pass it, and the program runs non-interactively without it when
  started this way **[capture: every file in real/]**.

### 1.2 The arguments

The SDK builds the list in a fixed order **[source: `Vx.initialize`]**. Two helpers decide the form
**[source: `Ye`, `jy`]**: almost every value is glued to its flag as one argument, `--flag=value`. The exceptions
are the first two pairs, which are separate arguments, and `--mcp-config`, whose flag and value are two arguments
(they would be one, `--mcp-config=<value>`, only if the value began with `-`).

The table lists every argument Tarsee's options produce, in the order they appear. Options Tarsee never sets
produce nothing and are left out (1.6 names them).

| # | Argument(s) | From (`query()` option) | Present when | Value in Tarsee |
| --- | --- | --- | --- | --- |
| 1 | `--output-format` `stream-json` | always | always | two arguments |
| 2 | `--verbose` | always | always | |
| 3 | `--input-format` `stream-json` | always | always | two arguments |
| 4 | `--thinking=adaptive` | `thinking.type` | `thinking` is set | only `{type:"adaptive", display:"summarized"}`: when the caller asked for thinking summaries **and** the provider is `claude` or `anthropic` |
| 5 | `--thinking-display=summarized` | `thinking.display` | with 4 | |
| 6 | `--effort=<level>` | `effort` | set | `low`, `medium`, `high`, `xhigh` or `max`, and only a level the model takes (DeepSeek: `low`, `high`, `max`) |
| 7 | `--max-turns=<n>` | `maxTurns` | the number is not 0 | the caller's number, else `50`. A caller's `0` gives **no flag at all**: Tarsee keeps the 0 (`opts.maxTurns ?? 50`) and the SDK leaves out a zero (`if (maxTurns)`) **[capture: verify/sdk.json `v-budget-forms`]**. The numbers the Node tree passes today are 50, 12 and 6 (`turn.js`, `BACKGROUND_DEFAULTS.MAX_TURNS`, `verify-model.js`) |
| 8 | `--max-budget-usd=<n>` | `maxBudgetUsd` | set | only `claude` and `anthropic`, and only a number above 0. The number is written as JavaScript prints it (see below) |
| 9 | `--model=<id>` | `model` | always in Tarsee | see below |
| 10 | `--resume=<session id>` | `resume` | resuming | the raw session id |
| 11 | `--allowedTools=Read,Write,Edit,Bash,Glob,Grep,mcp__tarsee__*` | `allowedTools`, joined with `,` | always | always this |
| 12 | `--tools=Read,Write,Edit,Bash,Glob,Grep,mcp__tarsee__*` | `tools`, joined with `,` | always | always this |
| 13 | `--mcp-config` `<json>` | `mcpServers`, without the in-process ones | a server that is not in-process | **never in the Node version** (its one server is in-process, 4.1). **The Rust version always has it** (4.2) |
| 14 | `--setting-sources=<list>` | `settingSources`, joined with `,` | always | `user,project,local` on `claude`; `project` on the other three |
| 15 | `--strict-mcp-config` | `strictMcpConfig` | true | every provider but `claude` |
| 16 | `--permission-mode=bypassPermissions` | `permissionMode` | always | |
| 17 | `--allow-dangerously-skip-permissions` | `allowDangerouslySkipPermissions` | always | |
| 18 | `--fallback-model=<ids>` | `fallbackModel` | set | see below |
| 19 | `--include-partial-messages` | `includePartialMessages` | always | |
| 20 | `--add-dir=<folder>` | each of `additionalDirectories` | always | Tarsee's bundled skills folder (`src/skills` in the Node tree) |

Complete lists as the program received them:

```text
# the Claude plan, new session  [capture: sdk/01-plan-new-session-plain-prompt.json]
--output-format stream-json --verbose --input-format stream-json
--max-turns=50 --model=claude-sonnet-5
--allowedTools=Read,Write,Edit,Bash,Glob,Grep,mcp__tarsee__*
--tools=Read,Write,Edit,Bash,Glob,Grep,mcp__tarsee__*
--setting-sources=user,project,local
--permission-mode=bypassPermissions --allow-dangerously-skip-permissions
--fallback-model=claude-haiku-4-5 --include-partial-messages
--add-dir=<TARSEE_ROOT>\src\skills

# the Claude plan, resuming, effort and thinking summaries  [capture: sdk/02-…]
--output-format stream-json --verbose --input-format stream-json
--thinking=adaptive --thinking-display=summarized --effort=high
--max-turns=50 --model=claude-opus-5 --resume=0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d
--allowedTools=… --tools=… --setting-sources=user,project,local
--permission-mode=bypassPermissions --allow-dangerously-skip-permissions
--fallback-model=claude-sonnet-5,claude-haiku-4-5 --include-partial-messages --add-dir=…

# the Anthropic key with a dollar ceiling  [capture: sdk/10-anthropic-key-budget-cap.json]
--output-format stream-json --verbose --input-format stream-json
--max-turns=50 --max-budget-usd=0.5 --model=claude-opus-4-8
--allowedTools=… --tools=… --setting-sources=project --strict-mcp-config
--permission-mode=bypassPermissions --allow-dangerously-skip-permissions
--fallback-model=claude-sonnet-5,claude-haiku-4-5 --include-partial-messages --add-dir=…

# DeepSeek Pro, effort max, resuming  [capture: sdk/12-deepseek-pro-effort-max-resume.json]
--output-format stream-json --verbose --input-format stream-json
--effort=max --max-turns=50 --model=deepseek-v4-pro[1m] --resume=0a1b2c3d-…
--allowedTools=… --tools=… --setting-sources=project --strict-mcp-config
--permission-mode=bypassPermissions --allow-dangerously-skip-permissions
--fallback-model=deepseek-flash[1m] --include-partial-messages --add-dir=…

# the form the Rust version uses: an HTTP MCP server  [capture: sdk/21-deepseek-http-mcp-server-through-the-sdk.json]
--output-format stream-json --verbose --input-format stream-json
--max-turns=50 --model=deepseek-flash[1m]
--allowedTools=… --tools=…
--mcp-config {"mcpServers":{"tarsee":{"type":"http","url":"http://127.0.0.1:45678/mcp","headers":{"Authorization":"Bearer ${TARSEE_MCP_TOKEN}"},"alwaysLoad":true}}}
--setting-sources=project --strict-mcp-config
--permission-mode=bypassPermissions --allow-dangerously-skip-permissions
--include-partial-messages --add-dir=…
```

(`--mcp-config` and its JSON are two arguments; the JSON is one argument with no line breaks.)

**The values, which are Tarsee's logic and not the SDK's** (`buildQueryOptions` in `claude-code.js`; listed so the
arguments above can be read):

- `--model`: on `claude` and `anthropic`, the requested model (or `CLAUDE_DEFAULT_MODEL`) with a tier word resolved
  to a model id. On `deepseek` and `openrouter`, the same string as the `ANTHROPIC_MODEL` environment variable: the
  provider's own id, with `[1m]` added when its context is at least a million tokens.
- `--fallback-model`: on `claude` and `anthropic`, every tier below the requested model's, newest model of each,
  joined with `,` (nothing for a Haiku model). On `deepseek`, Flash (with its `[1m]`) unless Flash is the model.
  Never on `openrouter`. The SDK refuses to start when it equals `--model`
  (`Fallback model cannot be the same as the main model.`) **[source: `Vx.initialize`]**.
- `--max-budget-usd`: the number as JavaScript prints it (`0.5`, `2`, `0.0001`). That is the shortest decimal
  that reads back as the same number, with no trailing `.0`; below 0.000001 JavaScript switches to the exponent
  form, so `0.0000001` is written `--max-budget-usd=1e-7` **[capture: verify/sdk.json `v-budget-forms`]**. Rust's
  `{}` never writes an exponent and writes `2` for `2.0`, so it agrees from 0.000001 up to (not including) 1e21. The
  program takes both spellings: `1e-7` and `0.0000001` gave the same stop
  **[capture: verify/real.json `s12-budget-1e-7`, `s12-budget-0.0000001`]**.
- `--resume`: left out when the session's transcript is over the size cap (the engine starts fresh instead)
  **[capture: sdk/19-deepseek-transcript-over-cap.json]**.

The order was not tested for whether it matters to the program. `--mcp-config` after the last flag, and written as
one `--mcp-config=<json>` argument, both worked **[capture: mcp-http/bearer-token-inline.json,
mcp-http/one-argument-form.json; verify/real.json `m3-one-argument-no-alwaysload`]**. Keep the SDK's order and
form; the fixtures compare against it.

One rule of the program's own argument reader matters to anyone who changes the order: `--mcp-config`,
`--add-dir`, `--allowedTools` and `--tools` each take **several** values (`--mcp-config <configs...>` in
`claude --help`). Written as two arguments, such a flag swallows every following argument that does not start with
`-`. In the SDK's order the argument after `--mcp-config <json>` is always another flag, so nothing is swallowed.
Never put a bare word after it.

### 1.3 Where the system prompt, the prompt and the tools' server are

Not on the command line. The system prompt travels in the `initialize` request on stdin (2.2), the prompt in the
user message on stdin (2.3), and the in-process MCP server is announced in the `initialize` request (4.1). So the
command line stays short however long the system prompt is. That matters on Windows, where a command line cannot
be longer than about 32,000 characters; stdin has no such limit.

### 1.4 The environment

Tarsee builds the whole environment itself (`engine-env.js` `claudeEnvFor`, plus `HOST_MANAGED` for every provider
but the plan) and hands it to the SDK as `options.env`. The SDK copies it and makes exactly these changes
**[capture: `env.sdk_changes` in every sdk/ file]** **[source: `ck`, `Vx.initialize`]**:

| Change | Rule | Seen |
| --- | --- | --- |
| adds `CLAUDE_CODE_ENTRYPOINT=sdk-ts` | when the name is missing or empty | every capture |
| adds `CLAUDE_AGENT_SDK_VERSION=0.3.319` | when the name is missing or empty | every capture |
| adds `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` | when no name spelled so, in any letter case, is present | every capture |
| removes `NODE_OPTIONS` | always (the name spelled exactly so) | every capture (the test environment carried one) |
| removes `DEBUG` | unless the environment handed over holds `DEBUG_CLAUDE_AGENT_SDK` set to something true, and then it sets `DEBUG=1` | removal: every capture; `DEBUG=1`: verify/direct-sdk.txt |

Nothing else. In particular the SDK does not add `CLAUDE_CONFIG_DIR`, a key or a host. (It has more switches,
none reachable from Tarsee's options: `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH`,
`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`, `CLAUDE_CODE_QUESTION_*`, and `TRACEPARENT` / `TRACESTATE` when an
OpenTelemetry trace is active **[source: `ck`]**.) The second pass got the same three additions and two removals
in every one of its 28 runs that started a program, on all four providers
**[capture: `env.added_by_sdk`, `env.removed_by_sdk` in verify/sdk.json]**. A value Tarsee sets to the empty
string (`ANTHROPIC_API_KEY=` on the gateways) reaches the program as a name that is present and empty, on Windows
too **[capture: verify/sdk.json `g-deepseek-default`, where `changed_by_sdk` is empty]**.

On Windows the process also receives `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `USERDOMAIN` and `USERNAME` (and
`PATH`, `SystemDrive`, `SystemRoot`, `TEMP`, `USERPROFILE`, `windir` when they were missing), copied from the
parent. That is Node's process start on Windows, not the SDK: a child started with one made-up variable sees them
too. The fixtures list them apart (`filled_in_by_windows_process_start_not_the_sdk`) so they are not taken for
something the engine must add. Under Linux nothing is filled in: the program received exactly the names it was
given plus the SDK's three **[capture: verify/linux-stop.txt]**. Rust's `Command` fills in nothing on either
system; in production that makes no difference, because Tarsee's environment is the server's own (which has those
names) minus the credentials.

**What each addition does to the program.**

- `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` makes the program write `system` messages with subtype
  `session_state_changed` (`running` when a turn starts, `idle` when it ends). Without it none are written
  **[capture: real/turn-plain-text.json has none; every other real/ file was run with it and has them]**.
  The SDK uses them to decide when to close stdin and hides them from its caller (3.1). Whether the variable
  changes anything else is NOT CONFIRMED.
- `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_AGENT_SDK_VERSION` go into what the program sends to the API
  **[capture: real/entrypoint-markers.json]**:

  | Environment | `User-Agent` | first `system` block |
  | --- | --- | --- |
  | neither set | `claude-cli/2.1.319 (external, sdk-cli)` | `x-anthropic-billing-header: cc_version=2.1.319.812; cc_entrypoint=sdk-cli;` |
  | `CLAUDE_CODE_ENTRYPOINT=sdk-ts` | `claude-cli/2.1.319 (external, sdk-ts)` | `…; cc_entrypoint=sdk-ts;` |
  | both | `claude-cli/2.1.319 (external, sdk-ts, agent-sdk/0.3.319)` | `…; cc_entrypoint=sdk-ts;` |

  (The three characters after the version in `cc_version` are not fixed: the same program, with the same system
  prompt, wrote `.812` when the first message was `one` and `.76b` when it was `say hi`
  **[capture: verify/system-blocks.txt]**. Nothing reads them.)

  The entrypoint is also written on every transcript row (`"entrypoint":"sdk-ts"`), and it goes into the
  `user-agent` the program sends to an MCP server (4.2). The turn works the same with neither set. **One more
  difference was found**: the words of a 404 for the model. With `CLAUDE_CODE_ENTRYPOINT=sdk-ts` they end at
  `…you may not have access to it.`; without it (`sdk-cli`) the program adds ` Run --model to pick a different
  model.` (6.2). The other four failures compared (401, 402, 403, 500) read the same with and without it, and with
  and without `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` **[capture: verify/failure-words-by-environment.txt]**.
  Whether anything else differs is NOT CONFIRMED: only those twenty runs and the plain turns were compared.

**For the Rust version.** Build the environment as `engine-env` does (that is package A-level work, not this
engine's) and pass exactly that. Then choose, and say which in the engine's report:

- to stay byte-for-byte with the fixtures, add the three variables as the SDK does. That makes the program tell the
  API it was started by the TypeScript SDK 0.3.319, which will not be true;
- or add none: the program then calls itself `sdk-cli`, writes no `session_state_changed` messages, and the engine
  needs none of them (it closes stdin on `result`, 2.5). One failure then reads differently: a 404 for the model
  gets the extra sentence ` Run --model to pick a different model.` (6.2). Tarsee's matcher and its classifier
  take both wordings, but a test that compares the whole sentence against the `real/` fixture will not.

Either way remove `NODE_OPTIONS` and `DEBUG`, as the SDK does.

**What Tarsee's environment holds, per provider** (recorded values; `engine-env.js` is the rule):

- `claude`: the server's environment minus every credential, plus the vault's keys, plus the cost savers
  (`CLAUDE_CODE_AUTO_COMPACT_WINDOW=180000`, `BASH_MAX_OUTPUT_LENGTH=8000`, `MAX_MCP_OUTPUT_TOKENS=3000`), plus the
  plan's sign-in variables that the server has (`CLAUDE_CODE_OAUTH_TOKEN` …). No `CLAUDE_CONFIG_DIR`: the plan's
  home is `~/.claude` **[capture: sdk/01]**.
- `anthropic`: the same base, plus `CLAUDE_CONFIG_DIR=<STATE_DIR>/.claude-home-anthropic`, `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` **[capture: sdk/10]**.
- `deepseek`, `openrouter`: the same base, plus `CLAUDE_CONFIG_DIR=<STATE_DIR>/.claude-home-<id>`,
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY=` (empty), `ANTHROPIC_MODEL`,
  `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
  `ANTHROPIC_DEFAULT_FABLE_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`,
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, `CLAUDE_CODE_ATTRIBUTION_HEADER=0`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`, and on OpenRouter
  `ANTHROPIC_CUSTOM_HEADERS` (`X-OpenRouter-Title: …` and, on a second line, `HTTP-Referer: …`)
  **[capture: sdk/11, sdk/12, sdk/13]**.

### 1.5 Working folder and pipes

`spawn(command, args, { cwd, stdio: ["pipe","pipe","pipe"], signal, env, windowsHide: true })`
**[source: `Vx.spawnLocalProcess`]**. So:

- the working folder is `options.cwd`: the caller's workspace, else `CLAUDE_WORKSPACE_DIR`
  **[capture: `spawn.cwd` in every sdk/ file]**;
- stdin, stdout and stderr are pipes; no console window on Windows (`CREATE_NO_WINDOW` in Rust);
- stderr is read all the time, as UTF-8 text. The SDK keeps its tail for its own error messages (the last 2,048
  characters, with anything shaped like a key replaced by `<token>`) and passes every chunk to
  `options.stderr`. Tarsee's callback keeps the last 2,000 characters (`stderrTail`). The Rust engine must also
  drain stderr continuously, or a full pipe stops the program.
- the working folder must exist. When it does not, the start fails and the SDK blames the program: the turn ends
  with `Claude Code native binary at <path> exists but failed to launch. …` (6.3)
  **[capture: verify/sdk.json `zc-working-folder-missing`]**. In Rust a missing working folder and a missing
  program give the same "not found" from the system on Linux, so check the folder first and say which it was.

When the Node process itself exits, the SDK ends every program it started: on Windows it closes their stdin, on
other systems it sends SIGTERM **[source: `w3.killAll`]**. It only ever acts on the `claude` process, never on the
processes that `claude` started (a Bash command, say).

### 1.6 What Tarsee does not use

So nobody adds them: `-p`, `--system-prompt` and `--append-system-prompt` (2.2 does this), `--session-id`,
`--continue`, `--fork-session`, `--no-session-persistence`, `--permission-prompt-tool` (the SDK adds
`--permission-prompt-tool=stdio` only when given a `canUseTool` callback, and Tarsee gives none; this one is not
in `claude --help` either), `--disallowedTools`, `--agents`, `--settings`, `--betas`, `--json-schema`,
`--include-hook-events`, `--replay-user-messages`, `--debug`.

One argument appears only when an operator asks for the SDK's own debug log. With `DEBUG_CLAUDE_AGENT_SDK` set in
the Node server's environment (the server's, not the turn's), the SDK prints `SDK debug logs: <file>` on the
server's stderr and adds `--debug-file=<config folder>\debug\sdk-<uuid>.txt` right after `--model`
**[capture: verify/direct-sdk.txt, last two lines]** **[source: `Vx.initialize`, `wG`]**. The Rust engine has no
such log and passes no `--debug-file`.

### 1.7 Before the program starts: what the Node engine does to the provider's home

`run()` does three things to files the program will read, in this order, before it calls the SDK. They are
Tarsee's logic (`claude-code.js`, `engine-env.js`), ported as they are; they are listed here because the second
one writes a file of the program's own.

1. For every provider but the plan: create the home (`ensureHome`, mode 0700) and refuse the turn when it holds a
   sign-in file or a stored Console key (`homeIsolationRefusal`, rule R1).
2. For `anthropic` only: `approveKeyInHome(home, key)` records the key as approved in the program's global config,
   so that the program will use an `ANTHROPIC_API_KEY` from its environment without asking anybody. The file is
   `<home>/.config.json` when that exists, else `<home>/.claude.json`; the entry is the key's **last 20
   characters** added to `customApiKeyResponses.approved` (and removed from `customApiKeyResponses.rejected`),
   everything else in the file kept, written as `JSON.stringify(json, null, 2)` with mode 0600, and not rewritten
   when the entry is already there.
3. For every provider: refuse the turn when a settings file that will load sets a credential
   (`settingsFileGuard`, rule R5).

What 2.1.319 does with that entry when it is started the way this document describes: **nothing that could be
seen.** With the key not approved, approved and even listed under `rejected`, with and without
`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`, the program reported `apiKeySource: "ANTHROPIC_API_KEY"` and sent the key
as `x-api-key` all four times, and it did not write the entry itself
**[capture: verify/anthropic-key-approval.txt; real/anthropic-key-approved.json,
real/anthropic-key-not-approved.json]**. Port the write all the same (the rule is the same behaviour, and another
version of the program may ask). A bearer token (`ANTHROPIC_AUTH_TOKEN`) goes out as `authorization: Bearer …`.

---

## 2. What is written to stdin

Every message is one JSON object on one line, UTF-8, ended with `\n` (`JSON.stringify(obj) + "\n"`). The key order
below is the order the SDK writes; the program reads JSON, so order does not matter to it. A test against the
fixtures should compare the parsed values, not the bytes.

When the program is gone before the lines are written, the turn's error is the exit's, not the write's
**[capture: sdk/18-program-exits-with-code-1.json, where the stub exited before it read anything;
verify/sdk.json `o-exit1-at-once`]**. Do the same: never turn a failed write into the turn's error.

Text is written as it is, in UTF-8: `é`, `你好` and an emoji arrived as their own bytes, not as `\u` escapes
**[capture: verify/sdk.json `c-plan-media-image-no-mcp`, second stdin line]**. `serde_json` writes the same.

### 2.1 Order

For a turn with a text prompt **[capture: `stdin` in sdk/01]**:

| When | Line |
| --- | --- |
| at once | the `initialize` control request (2.2) |
| about 1 ms later | the user message (2.3) |
| during the turn | one `control_response` for each `control_request` the program sends (4.1). With no in-process MCP server there are none |
| after the `result` message | stdin is closed (2.5) |

The SDK does not wait for the program's answer to `initialize` before it writes the user message. The answer
arrives when the program has started up: after 0.5 to 0.7 seconds in most of the 26 runs that got one, a few
seconds in some, and 14.9 seconds once, on a first run in a new home **[capture: the `t` of the first stdout line
in each real/ file; real/stop-stdin-closed-mid-stream.json is the slow one]**. The user message has been sitting in
the pipe all that time.

### 2.2 `initialize`

```json
{"request_id":"8pldox8ff5x","type":"control_request","request":{"subtype":"initialize","systemPrompt":["<the whole system prompt>"],"systemPromptSnapshot":false}}
```

**[capture: sdk/01, first stdin line]**

- `request_id`: any string unique among this process's requests. The SDK uses
  `Math.random().toString(36).substring(2,15)` (up to 13 letters and digits) **[source: `Yy.request`]**; `init1`
  worked just as well **[capture: every real/ file]**.
- `request`: only the keys that have a value are written. For Tarsee that is, in this order:
  `subtype`, then `sdkMcpServers` and `sdkMcpServerManifests` (only with the in-process MCP server, 4.1; the Rust
  version never writes them), then `systemPrompt`, then `systemPromptSnapshot` **[source:
  `Yy.buildInitializeRequest`]** **[capture: sdk/08, whose first stdin line has all five]**.

**`systemPrompt` is always an array of strings.** Tarsee's `systemPromptFor()` produces two shapes:

| Tarsee has | `options.systemPrompt` | `request.systemPrompt` on the wire | Capture |
| --- | --- | --- | --- |
| a plain system prompt, or parts with nothing volatile | `{type:"custom", prompt:"<preamble>\n\n<prompt>", snapshot:false}` | `["<preamble>\n\n<prompt>"]` (one element) | sdk/01, sdk/03 |
| stable and volatile parts | `{type:"custom", prompt:[head, MARKER, volatile], snapshot:false}` | `["<preamble>\n\n<stable>", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "<volatile>"]` (three elements) | sdk/02 |

- The marker's exact value is `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` **[source: the SDK exports it as
  `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`]**. It travels as its own array element, between the part that stays the same
  from turn to turn and the part that changes.
- `<preamble>` is `buildPreamble({engine:"claude-code", cwd})`; when there is no caller prompt the element is the
  preamble alone. Lone UTF-16 surrogates are removed from each string first (Tarsee's `clean`).
- What the program does with the three-element form: against the stand-in API it sent one `system` text block
  holding `STABLE PART\n\nVOLATILE PART`, after its own two blocks (a billing header line and
  `You are a Claude agent, built on Anthropic's Claude Agent SDK.`) **[capture: real/system-prompt-forms.json,
  first case]**. The second pass saw the same, and where the cache marks were: `"cache_control":{"type":"ephemeral"}`
  on the program's identity block and on the joined block, none on the billing line. So with a host that is not
  Anthropic's the marker changed nothing that could be seen: the volatile part sits inside the one marked block,
  exactly as for a one-element prompt **[capture: verify/system-blocks.txt]**. How it lays the two parts out, and
  where it puts cache marks, when the host is Anthropic's own is NOT CONFIRMED (that needs a real API call).

**`systemPromptSnapshot: false` must be sent, on every turn.** It is the `snapshot: false` of Tarsee's option.
Without it the program records the system prompt on a session's first turn and sends that same text on every
resumed turn, whatever the later `initialize` says: with `FIRST TURN PROMPT` on the first turn and
`SECOND TURN PROMPT` on the resumed one, the API was sent `FIRST TURN PROMPT` again. With `false` it was sent
`SECOND TURN PROMPT` **[capture: real/system-prompt-forms.json, second and third cases]**. Tarsee's prompt holds the
date, memory and context of each turn, so it must be fresh. Sending `false` once does not remove a record that is
already there: four turns of one session given `PROMPT A` (no key), `PROMPT B` (no key), `PROMPT C` (`false`) and
`PROMPT D` (no key) sent the API `PROMPT A`, `PROMPT A`, `PROMPT C`, `PROMPT A`
**[capture: verify/system-prompt-record.txt; verify/real.json `s13a` to `s13d`]**. A session whose every turn sent
`false` has no record: a later turn without the key then sent its own text
**[capture: verify/resumed-session.txt, the third turn]**.

**The answer.** The program replies on stdout, once it has started:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<the same id>","response":{ … },"pending_permission_requests":[],"pending_user_dialog_requests":[]}}
```

The inner `response` holds `commands`, `agents`, `output_style`, `available_output_styles`,
`user_output_styles_dir`, `models`, `account`, `pid`, `claude_code_version`, `current_permission_mode`,
`hook_on_failure_supported`, `feedback_mode`, `analytics_disabled`, several `remote_control_*` flags,
`fast_mode_state`, `fast_mode_disabled_reason`, `session_state`, `capabilities`
**[capture: real/turn-plain-text.json, first stdout line, whole]**. Tarsee reads none of it; the SDK keeps the
message to itself (3.1). The Rust engine reads the line and drops it. A request the program refuses comes back as
`{"type":"control_response","response":{"subtype":"error","request_id":"…","error":"<words>"}}`
**[source: `Yy.request`]**. That shape was seen from the real program for a request with a made-up subtype:
`{"type":"control_response","response":{"subtype":"error","request_id":"bad1","error":"Unsupported control request subtype: no_such_subtype"}}`
**[capture: verify/real.json `s19-unknown-control-request`]**. A refused `initialize` itself was not seen.

When the program fails before it gets that far (a session id it cannot resume, 6.2) there is no answer at all.
Never wait for it. The SDK does not wait either: a stub that never answered `initialize` was still given the user
message, and the turn ran to its `done{end_turn}` **[capture: verify/sdk.json `zb-no-init-answer`]**.

**Is `initialize` required?** No: a user message alone is answered, with the program's own default system prompt
**[capture: real/no-initialize-request.json; verify/real.json `s16-no-initialize`]**. And
`--system-prompt <text> --system-prompt-snapshot off` on the command line gives the same result as a one-element
`initialize` **[capture: real/system-prompt-forms.json, last case; verify/real.json `s21-system-prompt-flag`]**.
Use `initialize` all the same: it is what the SDK does, it is the only way to send the three-part form, and it
keeps a long prompt off the command line.

### 2.3 The user message

Tarsee gives the SDK a string when the turn has no media, and an async generator of one message when it has.

**Text only** (the SDK builds the message) **[capture: sdk/01]** **[source: `uk`]**:

```json
{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"say hi"}]},"parent_tool_use_id":null}
```

`text` is the last user message's text (its text blocks joined with a line break when its content is a list);
when there is neither text nor media it is the word `hello` **[capture: sdk/07-plan-empty-prompt.json]**.

**With media** (Tarsee builds the message and the SDK writes it unchanged: note there is no `session_id` key)
**[capture: sdk/04, sdk/05, sdk/06]** **[source: `Yy.streamInput`]**:

```json
{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"<base64>"}},{"type":"text","text":"what is in this picture?"}]},"parent_tool_use_id":null}
```

- `content` is every media block in order, then one text block when there is any text. With media and no text it
  is the media blocks alone **[capture: sdk/06-plan-picture-only-no-words.json]**.
- A picture: `{"type":"image","source":{"type":"base64","media_type":"<type, default image/png>","data":"<base64>"}}`.
- A PDF: `{"type":"document","source":{"type":"base64","media_type":"<type, default application/pdf>","data":"<base64>"}}`
  **[capture: sdk/05-plan-adapted-pdf-with-mcp.json]**.
- Where the blocks and the text come from (`opts.media` as `{media, text}` or as a bare array, else the last
  message's own blocks) is `run()`'s logic; the three fixtures cover the three cases.

Both shapes of the outer object work: the program answered messages with `"session_id":""` and without it
**[capture: every real/ file; wire/sdk-media-image.json]**.

What the program does with a picture: it passes the image block to the API, and also saves the picture under the
temp folder and adds a text block naming that file,
`[Image: source: <TEMP>\claude\<id>\<session id>\images\1.png]`
**[capture: wire/sdk-media-image.json, `api_requests[].last_user`]**. Seen again in the second pass: the user
content the API received was the program's own reminder blocks, then the image block with the same base64, then
`what is this?\n`, then the `[Image: source: …]` block
**[capture: verify/picture-prompt-flag-unknown-request.txt, first case]**. So every picture leaves a file under
the temp folder the program was given (`TEMP` / `TMP` on Windows).

### 2.4 Later in the turn

The only thing the SDK writes later is its answer to a control request from the program:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<the request's id>","response":{ … }}}
{"type":"control_response","response":{"subtype":"error","request_id":"<the request's id>","error":"<words>"}}
```

**[source: `Yy.handleControlRequest`]** **[capture: wire/sdk-mcp-tool-call.json; sdk/08, third stdin line]**

With Tarsee's options the program sends exactly one kind, `mcp_message`, for the in-process MCP server (4.1). With
an HTTP MCP server it sent none **[capture: `stdout_message_counts` in every mcp-http/ file; no `control_request`
in any real/ file]**. What the SDK would
answer to the other kinds, should the Rust engine ever meet one **[source: `Yy.processControlRequest`]**:

| `request.subtype` | SDK's answer with Tarsee's options |
| --- | --- |
| `can_use_tool` | error: `canUseTool callback is not provided.` |
| `hook_callback` | error: `No hook callback found for ID: <id>` |
| `mcp_message` for a server it does not have | error: `SDK MCP server not found: <name>` |
| `elicitation` | success, `{"action":"decline"}` |
| `request_user_dialog`, and the remote-tools kinds (`remote_tool_call`, `remote_plumbing_call`, `remote_tools_probe`, `remote_tools_reannounce`) | no answer |
| `oauth_token_refresh` | error: `getOAuthToken callback is not provided.` |
| `host_auth_token_refresh` | error: `getHostAuthToken callback is not provided.` |
| `remote_control_work_secret` | error: `refreshWorkSecret callback is not provided.` (source only) |
| anything else | error: `Unsupported control request subtype: <subtype>` |

Every row but the one marked was seen: a stub sent one request of each kind and recorded the answers, which were
written in the order the requests came **[capture: verify/sdk.json `w-unknown-control-requests`, stdin lines 3 to
9]**. The two shapes on the wire:

```json
{"type":"control_response","response":{"subtype":"error","request_id":"req-0","error":"canUseTool callback is not provided."}}
{"type":"control_response","response":{"subtype":"success","request_id":"req-3","response":{"action":"decline"}}}
```

For the Rust engine: answer a `control_request` it does not serve with the error of the last row (or the row's
own words), so the program is not left waiting. What the program does when a request of its own is never answered
is NOT CONFIRMED (not tried); with `--permission-mode=bypassPermissions` and an HTTP MCP server it sent none in
any run.

The SDK never sends `interrupt`, `set_model` or any other request of its own for Tarsee: those happen only when the
caller calls methods on the query object, and `claude-code.js` calls none.

### 2.5 When stdin is closed

| Turn | The SDK closes stdin | Capture |
| --- | --- | --- |
| text prompt | after the `result` message: at once, except that with the in-process MCP server registered and the last `session_state_changed` saying `running` it waits for the `idle` one (a few milliseconds later; 10 minutes at the very most) | sdk/01; wire/sdk-plain-turn.json; wire/sdk-mcp-tool-call.json |
| media, no in-process MCP server | **right after writing the user message**, before the program has replied | sdk/04 (`stdin closed` 1 ms after `user message read`, 168 ms before `result written`); wire/sdk-media-image.json |
| media, with the in-process MCP server | after the `result` message, as for text | sdk/05 |

**[source: `Yy.endRun`, `Yy.streamInput`, `Yy.hasBidirectionalNeeds`]** **[capture: verify/sdk.json
`a-plan-plain`, `c-plan-media-image-no-mcp` (stdin closed 1 ms after the user message was read, 412 ms before the
result), `d-plan-media-pdf-adapted-real-mcp` (closed 2 ms after the result)]**

The "10 minutes" is the SDK's default; a `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` in the turn's environment replaces
it **[source: `ck`]**. Tarsee sets none.

The program does not mind either way: with stdin closed before it has replied, it still runs the turn to its
result and then exits with code 0 **[capture: real/stdin-closed-before-the-reply.json; verify/real.json
`s14-stdin-closed-then-tool`, where it also ran a tool and made a second model call after stdin was closed]**. In
production Tarsee always passes the in-process server, so the middle row is only what tests and callers with
`mcpServer: null` see.

The Rust engine keeps stdin open until `result` in every case, then closes it. (Open stdin is what lets it send an
`interrupt`, 5.3.)

---

## 3. What the program writes to stdout

One JSON object per line, UTF-8 (the captures hold `·` and `—` in the program's own words). Split on `\n` only;
skip empty lines; a line that is not JSON is skipped (the SDK logs it as `Non-JSON stdout` and goes on)
**[source: `Vx.readMessages`]**. In the 30 runs in `real/`, 330
lines, none was not JSON, and none in the 86 runs of the second pass. Lines can be very long (a tool result, a
picture): do not cap the line length.

The SDK reads with Node's line reader. Played to it by a stub: a line of plain words, an empty line and a line
of spaces were skipped without a sound; a text holding U+2028 and U+2029 arrived whole, in one message (those
two are not line ends here) **[capture: verify/sdk.json `x-non-json-lines`]**; and a whole turn whose every line
ended with CR LF was read as usual **[capture: verify/sdk.json `zd-crlf-lines`]**. So `\n` is the only separator
a Rust reader needs, and a trailing `\r` is harmless to a JSON parser. The real program ended every line with
`\n` alone.

### 3.1 What the SDK keeps to itself

These never reach Tarsee's `for await` loop **[source: `Yy.readMessages`]**:

| Line | What the SDK does with it | Seen |
| --- | --- | --- |
| `{"type":"control_response",…}` | resolves its own pending request | yes |
| `{"type":"control_request",…}` | answers it (2.4) | yes (`mcp_message`) |
| `{"type":"control_cancel_request","request_id":…}` | cancels the answer it is working on | no |
| `{"type":"keep_alive",…}` | ignores it | no |
| `{"type":"transcript_mirror",…}` | only with a session store, which Tarsee does not use | no |
| `{"type":"system","subtype":"session_state_changed",…,"sdk_host_only":true}` | uses it to decide when to close stdin, then drops it | yes |

Counted in one turn: the program wrote 24 lines, of which 1 `control_response`, 2 `session_state_changed` and 1
`control_request`; the SDK handed its caller exactly the other 20
**[capture: wire/sdk-mcp-tool-call.json, `wire` against `messages_the_sdk_handed_to_its_caller`]**.

Everything else is passed on, including kinds Tarsee ignores (`system/status`, `system/thinking_tokens`). A
`session_state_changed` message **without** `"sdk_host_only": true` would be passed on too
**[source: `Yy.readMessages`]**; the program always wrote the flag. The SDK's reader also names kinds that no
capture produced and that it hands on untouched: `{"type":"active_goal"}`, `{"type":"autocompact_state"}`, and
`system` messages with subtype `commands_changed`, `post_turn_summary`, `task_summary`, `session_metadata`,
`compact_boundary`, `session_writes_lost`. `run()` does nothing with a `type` it does not know (it only counts
the message, 6.3), and for any `system` message it still reports a `session_id` and looks at `mcp_servers`. The
Rust engine must do the same: never fail on an unknown `type` or `subtype`.

Checked with a stub that wrote 1 `control_response`, 2 `session_state_changed` and 1 `control_request` among its
lines: Tarsee's loop saw none of the four **[capture: verify/sdk.json `e-plan-real-mcp-tool-call`,
`stub_timeline` against `sdk_messages_seen_by_tarsee`]**.

### 3.2 The messages, and what Tarsee reads from each

Every message has `session_id` and `uuid`. Fields not listed are not read by `claude-code.js`,
`lib/tool-steps.js` or anything they call.

#### `system` / `init`

Written once at the start of each turn, before any other message the caller sees. (A second user message on the
same process gets a second `init` **[capture: real/stop-interrupt-then-another-message.json]**.)

```json
{"type":"system","subtype":"init","cwd":"<WORKSPACE>","session_id":"0b502cd3-…","tools":["Bash","Edit","Glob","Grep","Read","Write"],"mcp_servers":[],"model":"claude-sonnet-4-5","permissionMode":"bypassPermissions","slash_commands":[…],"apiKeySource":"none","claude_code_version":"2.1.319", …}
```

**[capture: real/turn-plain-text.json]**

| Field | Tarsee's use |
| --- | --- |
| `session_id` | the session this turn runs in: reported once to the turn layer (`onSessionHandle`). On a resumed turn it is the resumed id **[capture: real/turn-resumed-session.json]** |
| `apiKeySource` | rule R6: must be one the provider allows, or the turn is stopped. Seen: `"none"` with a bearer token, with a sign-in token and with no credential at all; `"ANTHROPIC_API_KEY"` with that variable set, whether or not the key is approved in the home (1.7) **[capture: real/anthropic-key-approved.json; verify/anthropic-key-approval.txt; verify/real.json `s24-no-credential`]**. The type file lists `ANTHROPIC_API_KEY`, `apiKeyHelper`, `/login managed key`, `none`, `user`, `project`, `org`, `temporary`, `oauth` |
| `mcp_servers[]` `{name, status}` | a server whose `status` is not `connected` is logged as an error. Seen: `connected`, `failed`; the type file adds `needs-auth`, `pending`, `disabled`. Each entry also has `source` (`sdk` for the in-process server, `dynamic` for one from `--mcp-config`) |

`tools` is the list of tool names the model is offered, MCP tools included (`mcp__tarsee__tarsee_datetime`): handy
in a test, not read by Tarsee.

#### `stream_event`

The Messages API's own streaming events, passed through one for one because of `--include-partial-messages`.

```json
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from "}},"session_id":"…","parent_tool_use_id":null,"uuid":"…","api_message_id":"msg_…"}
```

| `event.type` | Fields read | Tarsee's use |
| --- | --- | --- |
| `message_start` | `event.message.id`; `event.message.usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens}`; the outer `parent_tool_use_id` | starts a model call in the live usage step. When `parent_tool_use_id` is null, input + cache read + cache creation is remembered as how full the context is (`context_input_tokens`) |
| `content_block_start` | `event.index`, `event.content_block.type` | `thinking` → event `thinking{status:"start"}`, and the live view starts collecting that block's summary |
| `content_block_delta` | `event.index`, `event.delta.type`; `event.delta.text` for `text_delta`; `event.delta.thinking` for `thinking_delta` | `text_delta` → event `text{content}`; `thinking_delta` → added to the summary (the first 4,000 characters). `input_json_delta` and `signature_delta` are ignored |
| `content_block_stop` | `event.index` | ends a thinking block: event `thinking{status:"stop"}` and a `thinking` step with the summary |
| `message_delta` | `event.usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens}`, each only when it is there and not null (a count that is there replaces the one from `message_start`); `event.usage.cost` | ends the model call in the live usage step (nothing happens when there is no `usage` object, or no call was started for that `parent_tool_use_id`). `usage.cost` is OpenRouter's own price for the call, summed over the turn when it is a finite number at or above 0 |
| `message_stop` | | ignored |

The events arrive exactly as the API sent them: the cache counts on `message_start` and a `cost` on
`message_delta.usage` came through unchanged **[capture: real/turn-usage-cost.json]**, and so did a thinking block
(`content_block_start` with `{"type":"thinking","thinking":"","signature":""}`, `thinking_delta`,
`signature_delta`) **[capture: real/turn-thinking-and-effort.json]**. Both were seen again with a different
stand-in API **[capture: verify/thinking-cost-token-agent-shell.txt, first and second cases; verify/real.json
`s33-thinking-block`, `s34-usage-cost`]**. A subagent's events have
`parent_tool_use_id` set to the tool call that started it **[source: `sdk.d.ts` `SDKPartialAssistantMessage`]**; not
seen.

#### `assistant`

One per finished content block: a reply with a thinking block and a text block arrives as two `assistant`
messages with the same `message.id`, each holding one block **[capture: real/turn-thinking-and-effort.json]**.
On these, `message.stop_reason` is null and `message.usage` is the count at the start of the call.

```json
{"type":"assistant","message":{"id":"msg_…","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"toolu_real_1","name":"Bash","input":{"command":"echo hi-from-bash","description":"say hi"}}],"stop_reason":null,"stop_sequence":null,"usage":{…}},"parent_tool_use_id":null,"session_id":"…","uuid":"…","timestamp":"…","request_id":"req_…"}
```

| Field | Tarsee's use |
| --- | --- |
| `parent_tool_use_id` | set: a subagent's message, skipped entirely |
| `error` | set: the reply is an API failure the program wrote as if it were an answer (6.2). Its code and the text are kept for the `result`, and nothing is shown. Values in the type file: `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`, `server_error`, `unknown`, `max_output_tokens`, `cloud_credential_error`. Seen: `authentication_failed`, `unknown`, `model_not_found`, `rate_limit`, `server_error` |
| `message.content[]` | `text` blocks → a `text` step, and the reply's text when nothing was streamed; `tool_use` blocks `{id, name, input}` → a `tool_start` step and event `tool_use{id, name, input}`. With no `error` and nothing shown yet, a text that matches the sign-in failure words is treated like `error: "authentication_failed"` |

In every capture the program wrote the `assistant` message of a block **before** that block's
`content_block_stop` event.

#### `user`

Written by the program for each tool result (and, when a turn is interrupted, for its own note).

```json
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_real_1","type":"tool_result","content":"hi-from-bash","is_error":false}]},"parent_tool_use_id":null,"session_id":"…","uuid":"…","timestamp":"…","tool_use_result":{"stdout":"hi-from-bash","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false},"tool_result_meta":[…]}
```

**[capture: real/turn-bash-tool-call.json]**

| Field | Tarsee's use |
| --- | --- |
| `isReplay`, `parent_tool_use_id` | either set: skipped. (`isReplay` marks earlier turns' messages echoed back; that needs `--replay-user-messages`, which is not passed, and none was seen on a resumed turn) |
| `message.content[]` blocks of type `tool_result`: `tool_use_id`, `is_error`, `content` | a `tool_end` step and event `tool_result{id, ok: !is_error, result}` (the text, cut to 2,000 characters) |

`content` of a tool result has three shapes, and the code handles each: a string (Bash, and **any failed MCP
call**), an array of blocks (`[{"type":"text","text":"…"}]`, a successful MCP call; an `image` block reads as
`[image]`), anything else (JSON-encoded) **[capture: real/turn-bash-tool-call.json, mcp-http/tool-errors.json,
mcp-http/tarsee-node-endpoint.json]**. `is_error` is absent, `false` or `true`.

#### `system`, other subtypes

| Subtype | Fields read | Tarsee's use | Seen |
| --- | --- | --- | --- |
| `api_retry` | `attempt`, `max_retries`, `retry_delay_ms`, `error_status` (a number or null), `error` | a `status` step. For the captured message: "Claude's API answered 529. Trying again in 1s (attempt 1 of 2)." (a reason in brackets follows the status for the `error` values `tool-steps.js` knows; `overloaded` is not one) | **[capture: real/turn-api-retry.json]**: `{"type":"system","subtype":"api_retry","attempt":1,"max_retries":2,"retry_delay_ms":593,"error_status":529,"error":"overloaded",…}` |
| `status` | `status` (`"compacting"`, `"requesting"` or null), `compact_result` (`"success"`, `"failed"`), `compact_error` | `compacting` and a failed compaction each make a `status` step; `requesting` is ignored | `requesting` only, before every model call. The compaction fields are from `sdk.d.ts` `SDKStatusMessage` |
| any with `session_id` | `session_id` | reported as the session (the same call as for `init`) | |
| any with `mcp_servers` | as for `init` | | |
| `thinking_tokens` | | ignored | **[capture: real/turn-thinking-and-effort.json]** |

#### `result`

The last message of a turn. `subtype` is `success`, `error_during_execution`, `error_max_turns`,
`error_max_budget_usd` or `error_max_structured_output_retries` **[source: `sdk.d.ts`]**.

```json
{"type":"result","subtype":"success","is_error":false,"result":"Hello from the fake.","stop_reason":"end_turn","session_id":"0b502cd3-…","num_turns":1,"duration_ms":120,"duration_api_ms":24,"total_cost_usd":0.000126,"usage":{"input_tokens":12,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":6, …},"modelUsage":{"claude-sonnet-4-5":{"inputTokens":12,"outputTokens":6,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.000126,"contextWindow":200000,"maxOutputTokens":32000, …}},"permission_denials":[],"terminal_reason":"completed","api_error_status":null, …,"model_usage_since_last_result":{ … }}
```

**[capture: real/turn-plain-text.json, whole]**

| Field | Tarsee's use |
| --- | --- |
| `session_id` (or `sessionId`) | reported as the session |
| `usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` | the `usage` event, with `context_input_tokens` added from the last top-level `message_start` |
| `total_cost_usd` | the turn's cost on `anthropic` (`costExact: true`). See 8.1 |
| `modelUsage` `{<model>: {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens}}` | on `deepseek`, and on `openrouter` when no `usage.cost` was streamed: priced from Tarsee's table, every model summed. See 8.1 |
| `subtype` | not `success`: the turn failed (below) |
| `errors[]` | joined with `; ` as the failure's words, for a non-success subtype |
| `num_turns` | in the turn-limit message |
| `is_error`, `result` | `subtype: "success"` with `is_error: true` is an API failure (6.2); `result` is the final text, shown only when nothing was streamed |

What `run()` does with a `result` (ported as it is; the cases are in `test/claude-engine.test.js`):

1. Report the session. Emit `usage` when there is a `usage` object or a cost.
2. `error_max_turns` → `error{code:"max_turns", subtype, message:"Stopped after hitting the turn limit (<num_turns> turns). …"}`, `done{max_turns}` **[capture: sdk/16, real/fail-max-turns.json]**.
3. `error_max_budget_usd` → `error{code:"budget", …}`, `done{budget}` **[capture: sdk/17, real/fail-max-budget.json]**.
4. Any other non-success subtype → classify the earlier `assistant` error's text, else `errors` joined; an
   unclassified one reads `Claude Code ended with <subtype>: <detail>`.
5. `success`, but `is_error`, or an `assistant` error was seen, or nothing was shown and `result` reads like an
   API error → classify and fail.
6. Otherwise `done{end_turn}`.

### 3.3 A turn from start to end

With `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`, a text reply after one tool call, in the order the program wrote it
**[capture: real/turn-bash-tool-call.json]**:

```text
control_response            (answer to initialize)            kept by the SDK
system/session_state_changed  state: running                  kept by the SDK
system/init
system/status               status: requesting
stream_event  message_start
stream_event  content_block_start   (tool_use)
stream_event  content_block_delta   (input_json_delta)
assistant                    content: [tool_use]
stream_event  content_block_stop
stream_event  message_delta         (stop_reason: tool_use)
stream_event  message_stop
user                         content: [tool_result]
system/status               status: requesting
stream_event  message_start … content_block_delta (text_delta) …
assistant                    content: [text]
stream_event  content_block_stop, message_delta (end_turn), message_stop
result/success
system/session_state_changed  state: idle                     kept by the SDK
```

---

## 4. Tarsee's tools (MCP)

### 4.1 Today: a server inside the Node process

`createTarseeMcp(ctx)` returns the SDK's `createSdkMcpServer({name:"tarsee", version:"1.0.0", tools})`: an object
`{type:"sdk", name:"tarsee", instance}`. Tarsee puts it in `options.mcpServers.tarsee`. What the SDK does with it:

**It is not on the command line.** A server with an `instance` is taken out of the `--mcp-config` list
**[source: `ck`: `if(Dn.type==="sdk"&&Dn.instance)_k.set(Bt,Dn); else hk[Bt]=Dn`]**; the argument list of a turn
with it is the same as without **[capture: sdk/08 against sdk/01]**.

**It is announced in `initialize`.** Before sending `initialize` the SDK runs the MCP handshake against the
server in memory (`initialize`, `notifications/initialized`, `tools/list`, with at most 250 ms to finish) and ships
the answers **[source: `Yy.captureSdkMcpServerManifests`]**:

```json
{"request_id":"…","type":"control_request","request":{"subtype":"initialize",
  "sdkMcpServers":["tarsee"],
  "sdkMcpServerManifests":{"tarsee":{
    "initializeResult":{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"tarsee","version":"1.0.0"}},
    "toolsListResult":{"tools":[{"name":"tarsee_send_message","description":"…","inputSchema":{…}}, … 27 in all]}}},
  "systemPrompt":["…"],"systemPromptSnapshot":false}}
```

**[capture: sdk/08-plan-with-mcp-tool-call.json, first stdin line, all 27 tools]**. The program then reports
`"mcp_servers":[{"name":"tarsee","status":"connected","source":"sdk"}]` and offers the model
`mcp__tarsee__tarsee_send_message` and the rest **[capture: wire/sdk-mcp-tool-call.json]**.

**A call travels over the control channel.** The program writes a control request holding the JSON-RPC message;
the SDK gives it to the in-memory server and writes the server's answer back:

```json
← {"type":"control_request","request_id":"38ea0772-3f90-437d-bdb0-c76797fc7631","request":{"subtype":"mcp_message","server_name":"tarsee","message":{"method":"tools/call","params":{"name":"tarsee_datetime","arguments":{"timezone":"UTC","format":"iso"},"_meta":{"claudecode/toolUseId":"toolu_datetime_1","progressToken":2}},"jsonrpc":"2.0","id":2}}}
→ {"type":"control_response","response":{"subtype":"success","request_id":"38ea0772-3f90-437d-bdb0-c76797fc7631","response":{"mcp_response":{"result":{"content":[{"type":"text","text":"2026-11-12T23:39:09.023Z"}]},"jsonrpc":"2.0","id":2}}}}
```

**[capture: wire/sdk-mcp-tool-call.json; the same exchange against the stub in sdk/08]**. A message from the
server to the program (a notification) goes the other way as a `control_request` with `subtype: "mcp_message"`
written by the SDK **[source: `Yy.sendMcpServerMessageToCli`]**; not seen.

**What the Rust version no longer needs:** the in-memory handshake, `sdkMcpServers`, `sdkMcpServerManifests`,
answering `mcp_message`, and keeping stdin open for the server's sake. With an HTTP server the control channel
carries nothing during a turn.

### 4.2 The replacement: the same tools over HTTP on loopback

The program takes an HTTP MCP server from `--mcp-config`. The JSON is `{"mcpServers": {<name>: <config>}}`, the
same object the SDK builds from `options.mcpServers` **[source: `Vx.initialize`: `jy("--mcp-config",
JSON.stringify({mcpServers:O}))`]**, and for HTTP the config is **[source: `sdk.d.ts` `McpHttpServerConfig`]**:

```json
{"mcpServers":{"tarsee":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer <token>"},"alwaysLoad":true}}}
```

| Key | Meaning |
| --- | --- |
| the name, `tarsee` | becomes the middle of every tool name: `mcp__tarsee__<tool>` |
| `type` | `"http"` |
| `url` | the endpoint |
| `headers` | sent on every request. A value may hold `${NAME}`, which the program replaces with that environment variable |
| `alwaysLoad` | `true`: the tools are always in the prompt, never put behind tool search, and the program waits for the server (5 seconds at most) before it builds the first prompt. The type file says that otherwise MCP start-up does not block and tools are deferred "when tool search is enabled" |
| `timeout` | optional: the longest one tool call may take, in milliseconds (values under 1000 are ignored); default `MCP_TOOL_TIMEOUT` |

**Proved against the real program**, with Tarsee's own endpoint (the Node `src/ai/mcp-http.js`, `startMcpHttp()`
and `grantTurn({})`) and the token passed as `${TARSEE_MCP_TOKEN}`
**[capture: mcp-http/tarsee-node-endpoint.json]**:

- `system/init` reported `{"name":"tarsee","status":"connected","source":"dynamic"}`;
- the model was offered all 27 tools in the first API request (and every later one), named
  `mcp__tarsee__tarsee_send_message`, `mcp__tarsee__tarsee_datetime` and so on, beside the six built-in ones
  (`tools_offered_to_the_model_in_each_api_request`);
- a scripted call to `mcp__tarsee__tarsee_datetime` reached the endpoint and its result went back to the model.

**The three ways to hand over the token, all of which work:**

| Way | Capture | Where the token can be read |
| --- | --- | --- |
| inline in the `--mcp-config` JSON | mcp-http/bearer-token-inline.json | the program's command line (visible to other processes of the same user) |
| `"Authorization":"Bearer ${TARSEE_MCP_TOKEN}"` with `TARSEE_MCP_TOKEN` in the environment | mcp-http/token-from-environment.json | the program's environment, **and the agent's own shell**: a Bash command run by the model printed `MCP_TOKEN_IN_SHELL` (the same run printed `AUTH_TOKEN_NOT_IN_SHELL` for the provider's key, which host-managed mode does keep out) **[capture: mcp-http/tarsee-node-endpoint.json, `tool_messages_on_stdout`]**. Seen again: with `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` the shell had the MCP token and a vault key but not `ANTHROPIC_AUTH_TOKEN`; without it, all three **[capture: verify/thinking-cost-token-agent-shell.txt, last case]** |
| `--mcp-config <path of a JSON file>` | mcp-http/config-from-a-file.json | the file. It can be deleted as soon as `system/init` has arrived: later tool calls still worked **[capture: mcp-http/other-checks.json]** |

`engine-env.js` strips `TARSEE_MCP_TOKEN` from every environment (`AUTH_ENV_RE`), so the second way means adding
it to the Claude block the way `codexEnvFor` adds it for Codex. Which way to use is a decision for the lead; the
grant lasts one turn whichever it is.

One thing outside this engine follows from this: in the Node version the turn layer asks for a grant (the URL and
token, `grantMcp`) only when the engine is Codex (`turn.js`: `if (target.engine === "codex")`), and hands the Claude
engine a tool context instead. In Rust the Claude engine needs the grant too (`EngineOptions.mcp_grant`).

**What the program sends**, in order **[capture: mcp-http/bearer-token-inline.json, every header and body]**:

| # | Request | Notes |
| --- | --- | --- |
| 1 | `POST /mcp` `{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.319","description":"Anthropic's agentic coding tool","websiteUrl":"https://claude.com/claude-code"},"io.modelcontextprotocol/clientCapabilities":{"roots":{"listChanged":true},"elicitation":{"form":{},"url":{}}}}}}` with headers `mcp-method: server/discover`, `mcp-protocol-version: 2026-07-28` | a probe for a newer protocol. Tarsee's endpoint answers **400** (`Unsupported protocol version: 2026-07-28 …`); a JSON-RPC "method not found" (`{"jsonrpc":"2.0","id":"server-discover-probe-1","error":{"code":-32601,"message":"Method not found"}}`) with status 200 was also fine. Either way the program goes on to 2 |
| 2 | `POST /mcp` `{"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":true},"elicitation":{"form":{},"url":{}}},"clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.319","description":"Anthropic's agentic coding tool","websiteUrl":"https://claude.com/claude-code"}},"jsonrpc":"2.0","id":0}` | no `mcp-protocol-version` header on this one |
| 3 | `POST /mcp` `{"jsonrpc":"2.0","method":"notifications/initialized"}` | answered 202 with no body |
| 4 | `GET /mcp` with `accept: text/event-stream` | the program asks for a server-to-client stream. 405 is fine |
| 5 | `POST /mcp` `{"method":"tools/list","jsonrpc":"2.0","id":1}` | |
| 6 | per call: `POST /mcp` `{"method":"tools/call","params":{"name":"tarsee_datetime","arguments":{…},"_meta":{"claudecode/toolUseId":"toolu_…","progressToken":2}},"jsonrpc":"2.0","id":2}` | `name` is the tool's own name, without `mcp__tarsee__` |

Headers on every request: `authorization: Bearer <token>`, `accept: application/json, text/event-stream` (on the
POSTs; `accept: text/event-stream` alone on the GET), `content-type: application/json` (on the POSTs),
`accept-encoding: identity`, `user-agent: claude-code/2.1.319 (sdk-ts)` (the entrypoint of 1.4 in brackets),
`connection: keep-alive`, and from request 3 on `mcp-protocol-version: <the version the server answered in 2>`.

**Checked a second time, with a different server.** A logging MCP server written for the purpose (two tools, JSON
answers, a bearer check) and a different stand-in API got the same six requests in the same order with the same
headers and bodies, in all three forms of the config: the token inline, the token as `${TARSEE_MCP_TOKEN}`, and
the path of a file (deleted when `system/init` arrived; the tool call after that still worked). `system/init`
said `{"name":"tarsee","status":"connected","source":"dynamic"}`, `tools` listed `mcp__tarsee__echo` and
`mcp__tarsee__second_tool` after the six built-in ones, both API requests of the turn offered all eight, the
scripted call reached the server as `"name":"echo"`, and the program wrote no `control_request`
**[capture: verify/real.json `m1-token-inline` and `m2-token-from-env`, each with its `mcp_requests`, and
`m9-config-from-a-file`]**. A tool reaches the model as
`{"name":"mcp__tarsee__echo","description":"<the server's>","input_schema":<the server's inputSchema>}`.

**What the server may do** **[capture: the files named]**:

- answer `initialize` with the version asked for, or an older one (`2025-06-18` and `2024-11-05` both worked, and
  the program then sends that version in its header) (mcp-http/other-checks.json; verify/real.json
  `m5-discover-400-session-id-older-protocol`);
- answer with `content-type: application/json` (no event stream is needed);
- hand out an `Mcp-Session-Id` header on `initialize`, which the program then sends back on every request from
  request 3 on (mcp-http/server-with-session-id.json; verify/real.json, the same `m5` run), or none at all, as
  Tarsee's endpoint does;
- answer nothing to a `DELETE`: none was sent when the program ended, with or without a session id.

**When the server cannot be used** (a 401, or nothing listening): `system/init` reports
`{"name":"tarsee","status":"failed","source":"dynamic"}`, no `mcp__tarsee__*` tool is offered, and the turn runs on
without them, exit code 0 **[capture: mcp-http/wrong-token-401.json, mcp-http/nothing-listening.json;
verify/real.json `m4-wrong-token`, `m8-nothing-listening`]**. After a 401 the program sent only requests 1 and 2
(both answered 401) and did not try again during the turn. That is the case `claude-code.js` logs as
`MCP server "tarsee" is failed: its tools are NOT available this turn.`

**How a call comes back.** A successful call: a `user` message whose `tool_result` has no `is_error` key and an
**array** `content`, `[{"type":"text","text":"echo: ping"}]`. Both an MCP result with `isError: true` and a
JSON-RPC error arrive as a `user` message whose `tool_result` has `"is_error": true` and the words as a
**string** `content` (`"the tool says no"`, and for the JSON-RPC error its `message`)
**[capture: mcp-http/tool-errors.json; verify/real.json `m1-token-inline`, `m6-tool-iserror`,
`m7-tool-rpc-error`]**.

**A call can run although the turn is then stopped.** When the reply that asks for a tool is also the one that
crosses `--max-budget-usd`, the program still sends the `tools/call` (a few milliseconds after `message_stop` in
the capture), then writes `result/error_max_budget_usd` with no `user` message for it (6.2). And after stdin is
closed the program goes on calling tools (5.2). A tool with an effect (sending a message) can therefore run in a
turn the owner sees as stopped
**[capture: verify/budget-tool-still-called.txt; verify/stops-and-interrupts.txt]**.

**The other arguments stay as they are.** `mcp__tarsee__*` in `--allowedTools` and `--tools` covers the HTTP
server's tools exactly as it covers the in-process one's; `--strict-mcp-config` (every provider but the plan) keeps
out every other MCP server and leaves this one, since it comes from `--mcp-config`. `MAX_MCP_OUTPUT_TOKENS` (1.4)
applies to its results too.

NOT CONFIRMED: whether, on the Claude plan against Anthropic's own host, tools would be put behind tool search
without `alwaysLoad`. In every capture (a stand-in API behind `ANTHROPIC_BASE_URL`) they were offered outright
with and without it. `alwaysLoad: true` is accepted and is the safe setting.

---

## 5. Stopping a turn

### 5.1 What the SDK does when the caller's signal fires

Tarsee's `run()` aborts the `AbortController` it gave the SDK. The SDK's only reaction is in its process transport
**[source: `Vx.initialize` (`abortHandler = () => this.close()`), `Vx.close`]**. It sends **no** control request.

| Time after the abort | Windows | Linux, macOS |
| --- | --- | --- |
| 0 | closes stdin (`stdin.end()`) | the same |
| 2,000 ms, if the process is still running | nothing yet | `kill("SIGTERM")` |
| 7,000 ms, if the process is still running | `kill("SIGKILL")` (the process is terminated) | `kill("SIGKILL")` |

Recorded on Windows with a program that never exits: stdin closed 1 ms after the abort, `kill("SIGKILL")` 7,006 ms
after that, exit with signal `SIGKILL` **[capture: sdk/14-stop-program-keeps-running.json, `sdk_process_calls`]**;
the same with the real program, 7,012 ms **[capture: wire/sdk-abort-mid-stream.json, `process_calls`]**. When the
program exits on its own in the first two seconds, nothing is killed
**[capture: sdk/15-stop-program-exits-when-stdin-closes.json]**. The second pass watched the process from outside
(the pid the SDK reports, polled every 10 ms): gone 7,024 ms after the abort
**[capture: verify/sdk.json `k-stop-hang`, `harness_notes`]**.

**The Linux column is confirmed for the SDK's half.** The same SDK under Linux Node 22 (WSL 2), with a stand-in
program that logs the signals it gets **[capture: verify/linux-stop.txt; scripts/verify/linux-stop.mjs.txt]**:

| The stand-in | stdin closed | SIGTERM received | Process gone | The SDK's stream ended |
| --- | --- | --- | --- | --- |
| ignores SIGTERM | 2 ms after the abort | 2,001 ms and 2,002 ms (it arrives **twice**: the SDK's own `kill` and Node's, through the signal the SDK gave `spawn`) | 7,010 ms (the SIGKILL) | 2,003 ms, throwing `Claude Code process aborted by user` |
| exits on SIGTERM | 1 ms | 2,000 ms | 2,012 ms | 2,001 ms, the same words |
| exits when stdin closes | 1 ms | never | 10 ms | 8 ms, throwing `Operation aborted` |

What the real program does when it gets SIGTERM is NOT CONFIRMED: there was no Linux build of it on the machine
(only the Windows package is installed), and none was fetched.

**What the caller sees.** The SDK's stream ends when the program's **stdout** ends (not when the process does),
or when the SDK gives up on it. Tarsee's loop checks the signal each time a message arrives, so:

- if a message arrives after the abort, the loop breaks, the SDK's clean-up waits up to 2 seconds for the process
  to go, and `done{aborted}` follows: about 2 seconds after Stop
  **[capture: wire/sdk-abort-mid-stream.json: the abort at 731 ms, `done` at 2,743 ms; verify/sdk.json
  `l-stop-hang-then-more`: the abort at 651 ms, `done` at 2,969 ms, the process gone at 7,681 ms]**;
- if none arrives, the loop sits until the stream throws `Operation aborted` (or
  `Claude Code process aborted by user`). On Windows that is when the process is killed: `done{aborted}` came 7
  seconds after Stop **[capture: sdk/14, `tarsee_events`: the abort at 520 ms, `done` at 7,559 ms; verify/sdk.json
  `k-stop-hang`: 603 ms and 7,705 ms]**. On Linux it is at 2 seconds, whether or not the program has gone (the
  table above): the SDK aborts the signal it gave `spawn` right after its SIGTERM, Node reports that as an error
  on the process, and the SDK closes its reader.

Either way exactly one `done{stopReason:"aborted"}` and no `error`.

**stdout, not the process.** In one run of the second pass the stand-in was a launcher that had started a second
process holding the same stdout. The SDK killed the launcher at 7 seconds; the second process lived on with the
pipe open, and the SDK's stream, and with it `done{aborted}`, did not come until that process exited, 13.6 seconds
after Stop. (That run was not kept as a file: the stub was then changed to end when its launcher does, see
scripts/verify/stub.mjs.txt, and `k-stop-hang` is the run after the change.) `claude` starts
its tools with pipes of their own, so this was not seen with the real program, but a Rust engine should not make
`done{aborted}` wait for the end of stdout: emit it, kill, and stop reading.

**A signal that is already aborted when `run()` is called.** The SDK still starts the program, writes nothing to
it, and closes its stdin at once; its stream throws and `run()` emits `done{aborted}`, 5 ms after the call. The
program, started with an stdin that is closed and empty, writes nothing and exits with code 0 about half a second
later **[capture: verify/sdk.json `n-signal-aborted-before-start`; verify/real.json `s8-empty-stdin`]**. The Rust
engine should emit `done{aborted}` without starting anything.

The same clock starts when Tarsee's loop returns after a `result`: the SDK then lets go of the process through the
same `Vx.close`, so a program that has not exited 2 seconds later gets SIGTERM on Linux, and one still there at 7
seconds is killed (on Windows only the kill at 7 seconds). In the captures it was gone 52 to 71 ms after its stdin
was closed (6.1). The same holds after the R6 refusal: `run()`'s events came at once, `run()` itself returned 2
seconds later (the SDK's clean-up waiting for the process), and the process was ended 7 seconds after the refusal
**[capture: verify/sdk.json `y-bad-key-source`]**.

### 5.2 What the program does

**Closing stdin is not a stop.** The program takes it to mean "no more messages" and carries on with the turn it
has: it finishes the model call, runs the tools the model asks for, makes the next model calls, writes its
`result`, and only then exits, with the usual code.

| What reaches it | What it does | Capture |
| --- | --- | --- |
| stdin closed while a reply is streaming, and the reply goes on to its end | keeps writing the stream events as they come, then `assistant`, `result/success`; exits with code 0 36 ms after the result (2.9 s after stdin was closed, the time the reply took) | verify/real.json `s6-stdin-closed-mid-stream-stream-completes` |
| stdin closed, and the model then asks for a tool | runs the tool (the MCP `tools/call` reached the server 54 ms after stdin was closed), makes the second model call, writes `result/success`, exits with code 0 | verify/stops-and-interrupts.txt; verify/real.json `s14-stdin-closed-then-tool` |
| stdin closed before the reply started | runs the whole turn, writes its `result`, exits with code 0 | real/stdin-closed-before-the-reply.json |
| stdin closed while a model call hangs (an API that sends `message_start` and then nothing) | waits for the call: no message, no exit. Still running 17 seconds later in one capture and 11 seconds later in the other, when the tests killed it | real/stop-stdin-closed-mid-stream.json; verify/real.json `s7-stdin-closed-api-hangs` |
| stdin closed at once, nothing ever written | writes nothing, exits with code 0 after half a second | verify/real.json `s8-empty-stdin` |
| killed | nothing more on stdout or stderr | real/stop-killed-mid-stream.json |
| SIGTERM | NOT CONFIRMED (no way to send one on Windows, and no Linux build of the program at hand; the SDK's side of it is in 5.1) | |
| an `interrupt` control request while a turn runs | stops at once: see below | real/stop-interrupt-request.json; verify/real.json `s5-interrupt`, `s15-interrupt-then-close` |
| an `interrupt` when no turn is running | answers `{"subtype":"success","request_id":"…","response":{"still_queued":[]}}` and writes **no** `result` | verify/real.json `s17-interrupt-idle` |

(The first capture of the fourth row was first read as "the program does nothing and does not exit". Its
stand-in API never finished the reply; with a reply that ends, the first row is what happens.)

So in the Node version a stopped turn keeps running, new tools and new model calls included, until the SDK ends
the process: SIGTERM at 2 seconds on Linux (what the program does with it is not confirmed) and the kill at 7
seconds on both systems. Nothing it does in that time is shown, because `run()` has stopped reading (8.4).

**`interrupt`.** Written to stdin while a turn runs:

```json
{"request_id":"int1","type":"control_request","request":{"subtype":"interrupt"}}
```

The program answered, in this order **[capture: real/stop-interrupt-request.json]**:

```text
control_response   {"subtype":"success","request_id":"int1","response":{"still_queued":[]}}
assistant          the text so far, with "aborted": true
user               {"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}
stream_event       content_block_stop, message_delta (stop_reason null), message_stop
result             subtype "error_during_execution", is_error true, terminal_reason "aborted_streaming",
                   errors ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"]
system             session_state_changed, state "idle"
```

The `result` came 50 ms after the request in one run and 650 ms in another (70 ms and 17 ms in the second pass).
The process stays up afterwards: a second user message on the same stdin was answered normally, with a second
`system/init` **[capture: real/stop-interrupt-then-another-message.json; verify/real.json `s5-interrupt`]**. The
exit code follows the **last** result: stdin closed right after the interrupted result gave code 1, stdin closed
after a later good turn gave code 0 **[capture: verify/real.json `s15-interrupt-then-close`, `s5-interrupt`]**.

### 5.3 For the Rust engine

To do what the SDK does: close stdin, wait 2 seconds, terminate (SIGTERM, then SIGKILL 5 seconds later; on Windows
terminate at 7 seconds), and emit `done{aborted}` once.

The captures show a better order, which keeps the same events and is the lead's call:

1. emit `done{aborted}` at once (nothing the program writes afterwards is shown);
2. write the `interrupt` request, and read stdout until a `result` arrives or a short limit passes (the fixtures
   show it within a second). The limit is needed: an interrupt that arrives when no turn is running is answered
   with a `control_response` and **no** `result` (5.2);
3. close stdin and wait for the exit; kill the process if it is still there after the limit.

It stops the model call within a second instead of 2 to 7, and leaves the transcript with the interruption written
in it (the `[Request interrupted by user]` row), which is what a later resume reads. The R6 refusal (the wrong
`apiKeySource`) should not wait for anything: kill the process at once (8.2).

Two facts about killing from Rust on Windows **[capture: verify/rust-probe-windows.txt]**:

- `Child::kill()` ends the process with **exit code 1**, the same code the program itself uses after an error
  `result` (6.1). `status.code()` cannot tell the two apart; the engine has to remember that it killed.
- it ends only the process it started. Behind a `.cmd` wrapper that is `cmd.exe` (1.1).

---

## 6. Ending and failing

### 6.1 Exit codes

| How the turn ended | Exit code | stderr |
| --- | --- | --- |
| `result` with `is_error: false`, then stdin closed | 0 | empty (or the `unrecognized_model` line below) |
| `result` with `is_error: true`, whatever its subtype, then stdin closed | 1 | empty, except for a failed resume |
| an unknown command-line flag | 1 | `error: unknown option '--no-such-flag'`, and nothing on stdout |
| stdin closed with nothing written | 0 | empty, and nothing on stdout |
| killed | no code on POSIX (a signal); on Windows the code the terminating call passes, which is **1** for Rust's `Child::kill()` and for Node's `kill()` | empty |

**[capture: `exit` in every real/ file: of the 30 runs, 11 ended with 0, 17 with 1, and 2 were killed; the same
codes in verify/real.json; verify/rust-probe-windows.txt for the killed row]**

The program does not always wait for stdin to close. After a failed `--resume` it exited by itself, with code 1,
34 ms after its one `result` line, stdin still open **[capture: verify/real.json `s18-resume-unknown-stdin-open`]**.
After a turn's `result` it waits: it stays up for the next message until stdin is closed (5.2).

Both stdout and stderr use `\n` alone as the line end on Windows too, and start with no byte-order mark
**[capture: verify/raw-line-ends.txt, the raw bytes of a failed resume]**.

One line appears on stderr in otherwise good runs: for a model id the program has no entry for (every DeepSeek and
OpenRouter id) it writes `[claude-code:unrecognized_model] {"model":"deepseek-flash[1m]","query_source":"sdk"}`
and carries on **[capture: wire/sdk-plain-turn.json `stderr`, real/turn-usage-cost.json]**. It is not an error.
The `[1m]` is the program's own mark: `system/init` reported `"model":"deepseek-flash[1m]"`, but the request to
the API named `deepseek-flash` **[capture: verify/models-credentials-retry-thinking.txt, first case]**.

After the `result` and the closing of stdin, the program exited 52 to 71 ms later
**[capture: `process_calls` in wire/sdk-plain-turn.json, wire/sdk-mcp-tool-call.json, wire/sdk-media-image.json]**,
and in under a second in every run in `real/` (whose `exit.at_ms` is read 100 ms late; see the fixtures' README).

### 6.2 Each failure

Every API failure has the same shape: an `assistant` message whose `message.model` is `"<synthetic>"`, with `error`
set, `is_api_error_message: true` and the words as its one text block; then a `result` with **`subtype: "success"`
and `is_error: true`**, the same words in `result`, `api_error_status` and `terminal_reason: "api_error"`; exit
code 1; nothing on stderr. The table gives the words. The last column is what the Node `classifyEngineError` makes
of each (the `assistant` error as `code`, the words as `message`), worked out by running it on the capture
(`scripts/classify.mjs.txt`).

| Case | `assistant.error` | Words (`assistant` text and `result.result`) | `api_error_status` | Capture (real/) | Tarsee's kind |
| --- | --- | --- | --- | --- | --- |
| no credential at all (empty home, no key, no token). No request is made | `authentication_failed` | `Not logged in · Please run /login` | null | fail-no-credentials | `claude`: `expired`; a key provider: `auth` |
| a sign-in token the API refuses: 401 `OAuth token has expired…` | `authentication_failed` | `Failed to authenticate. API Error: 401 OAuth token has expired. Please obtain a new token or refresh your existing token.` | 401 | fail-sign-in-token-rejected-401 | `claude`: `expired`; a key provider: `auth` |
| 401 `authentication_error` to a bearer token | `authentication_failed` | `Not logged in · Please run /login` | 401 | fail-api-401 | `claude`: `expired`; a key provider: `auth` |
| 403 `permission_error` | `authentication_failed` | `Failed to authenticate. API Error: 403 <the API's message>` | 403 | fail-api-403 | `claude`: `expired`; a key provider: `auth` |
| 402 `billing_error` | `unknown` | `API Error: 402 <the API's message>` | 402 | fail-api-402 | `billing` |
| 404 for the model | `model_not_found` | with `CLAUDE_CODE_ENTRYPOINT=sdk-ts`: `There's an issue with the selected model (<id>). It may not exist or you may not have access to it.` Without that variable one more sentence follows: `There's an issue with the selected model (<id>). It may not exist or you may not have access to it. Run --model to pick a different model.` Also on stderr: `[claude-code:unrecognized_model] {"model":"<id>","query_source":"sdk"}` | 404 | fail-unknown-model-404; verify/failure-words-by-environment.txt | `model` (both wordings) |
| 429 `rate_limit_error` | `rate_limit` | `API Error: Request rejected (429) · <the API's message>` | 429 | fail-api-429 | `rate` |
| 500 `api_error` | `server_error` | `API Error: 500 <message>. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (<host:port>).` | 500 | fail-api-500 | `unavailable` |
| 529 `overloaded_error` | `server_error` | `API Error: 529 Overloaded. This is a server-side issue, …` | 529 | fail-api-529 | `unavailable` |
| 400 `invalid_request_error` | `unknown` | `API Error: 400 <the API's message>` | 400 | fail-api-400 | `unknown` |
| nothing listening at the host | `server_error` | `API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)`; the `assistant` message and the `result` both have `"api_error":"connection_failed"` | null | fail-host-unreachable | `unavailable` |

(These ran with `CLAUDE_CODE_MAX_RETRIES=0`. With retries on, each retry is announced by a `system/api_retry`
message first.)

The captures in `real/` were all made in the gateway's environment (`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`,
`CLAUDE_CODE_ENTRYPOINT=sdk-ts`). The second pass ran the rows for no credential, 401, 402, 403, 404, 429, 500,
529, 400 and the unreachable host again with a stand-in API of its own, and 401, 402, 403, 404 and 500 four times
each: with neither variable, with each alone, and with both. Every `assistant.error`, status and exit code was
the same, and every sentence but the 404's **[capture: verify/real.json `s9-api-*`, `s24-no-credential`,
`s25-host-unreachable`, `s26-model-404`, `s31-*`; verify/failure-words-by-environment.txt]**. The kinds in the last
column were worked out again by giving these words to `classifyEngineError` for `claude` and for `deepseek`; they
agree **[capture: verify/classified-kinds.txt]**.

Failures that are not the API's:

| Case | stdout | stderr | Exit | Capture (real/) |
| --- | --- | --- | --- | --- |
| `--resume` with a well-formed id that has no transcript | **only** one line: `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"<the id asked for>","errors":["No conversation found with session ID: <id>"], …}`. No answer to `initialize`, no `system/init` | `No conversation found with session ID: <id>` | 1 | fail-resume-unknown-session |
| `--resume` with a value that is not a UUID | the same, with `errors: ["Error: --resume requires a valid session ID or session title when used with --print. Usage: claude -p --resume <session-id\|title>. Provided value \"<value>\" is not a UUID and does not match any session title."]` and a new random `session_id` | the same words | 1 | fail-resume-not-a-uuid |
| the turn limit | …, `result` with `subtype: "error_max_turns"`, `is_error: true`, `errors: ["Reached maximum number of turns (2)"]`, `terminal_reason: "max_turns"`, `num_turns: 3`. With `--max-turns=1`: `(1)` and `num_turns: 2`, after the first reply's tool had run and its `user` message was written | empty | 1 | fail-max-turns; verify/real.json `s11-max-turns` |
| the dollar ceiling | …, `result` with `subtype: "error_max_budget_usd"`, `errors: ["Reached maximum budget ($0.01)"]`, `terminal_reason: "budget_exhausted"`, right after the events of the call that crossed it. No `user` message follows for a tool that call asked for, **but the tool is started all the same**: its MCP `tools/call` reached the server before the `result` was written (4.2). The amount in the words is the flag's number as JavaScript prints it (`$0.0001`, `$1e-7`) | empty | 1 | fail-max-budget; verify/budget-tool-still-called.txt; verify/real.json `s12b-budget-tool`, `s12-budget-1e-7` |
| interrupted | `result` with `subtype: "error_during_execution"` (5.2) | empty | 1 | stop-interrupt-request; verify/real.json `s15-interrupt-then-close` |

`No conversation found with session ID` is what `engine-errors.js` reads as kind `session`, the one failure that is
`recoverable`: the turn layer starts a fresh session and tries once more. The not-a-UUID words classify as
`unknown` (not recoverable); the turn limit, the ceiling and the interruption never reach the classifier's kinds
that matter (the first two have their own branches in `run()`, 3.2).

**A crash** could not be produced in the real program. What the SDK does with any exit it did not expect is in 6.3,
recorded with the stub.

### 6.3 How the SDK reports to its caller

The SDK's stream throws in these cases, and **the words matter**: `claude-code.js` passes the message to
`classifyEngineError`, which reads statuses and phrases out of it. A Rust engine that reports the same situations
should use the same sentences.

| Situation | Error thrown by the SDK's stream | What `run()` emits | Capture |
| --- | --- | --- | --- |
| the program exits with a code other than 0 and no error `result` came before | `Error: Claude Code process exited with code <n>` then, when stderr was not empty, `. stderr: <the tail of stderr>` | `error{code:"unknown", message:"**Claude ran into a problem:** Claude Code process exited with code 1. stderr: …"}`, `done{error}` (or whatever kind the stderr words classify as). With nothing on stderr the message ends at the code: `**Claude ran into a problem:** Claude Code process exited with code 3` | sdk/18-program-exits-with-code-1.json; verify/sdk.json `o-exit1-at-once` (a key-shaped string on stderr came out as `<token>`), `za-exit3-no-stderr` |
| the program is ended by a signal | `Error: Claude Code process terminated by signal <SIG…>` plus the same stderr tail. The signal is its name (`SIGKILL`, `SIGSEGV`), as Node gives it. On Windows there are no signals: a process ended from outside shows the exit code it was ended with and falls in the row above | the same way | source: `Vx.getProcessExitError` |
| the program exits with a code other than 0 **after** an error `result` | `Error: Claude Code returned an error result: <result.result when the subtype is success, else each of errors trimmed, the empty ones dropped, joined with "; ">` | nothing: `run()` returned when it read the `result`, so it never reads the stream that far (and `if (doneSent) return` covers a caller that does) | verify/direct-sdk.txt, where the stream was read to its end: `Claude Code returned an error result: first thing went wrong; second thing` and `…: API Error: 529 Overloaded.`; `test/claude-engine.test.js` throws exactly this |
| the caller aborted | `Operation aborted`, or `Claude Code process aborted by user` | `done{aborted}` | sdk/14, sdk/15; verify/sdk.json `k-stop-hang`, `m-stop-exits-on-stdin-close` |
| no program at the path | `ReferenceError: Claude Code native binary not found at <path>. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.` | `error{code:"unknown", message:"**Claude ran into a problem:** Claude Code native binary not found at …"}`, `done{error}` | sdk/22-program-not-found.json; verify/sdk.json `s-program-not-found` |
| the program is there but cannot be started | `ReferenceError: Claude Code native binary at <path> exists but failed to launch. This usually means the binary does not match this system's libc — e.g. spawning a musl-linked binary on a glibc Linux host fails because the musl dynamic loader (/lib/ld-musl-*) is missing. Specify a matching binary with options.pathToClaudeCodeExecutable.`; any other start failure: `Failed to spawn Claude Code process: <the system's words>` | the same way: `**Claude ran into a problem:** Claude Code native binary at … exists but failed to launch. …` | verify/sdk.json `zc-working-folder-missing`: the cause there was a **working folder that does not exist** (1.5), which the SDK cannot tell from a bad binary. The second sentence is from the source: `c5e`, `Vx.initialize` |

When the program exits with code 0 the stream simply ends, and `run()` decides:

| Situation | What `run()` emits | Capture |
| --- | --- | --- |
| no message at all | `error{message:"**Claude ran into a problem:** Claude Code returned no response. <the last 300 characters of stderr>"}`, `done{error}`. With nothing on stderr the message ends at `response.` (no space after it) | sdk/23-program-exits-0-without-a-word.json; verify/sdk.json `p-exit0-at-once` |
| messages, but no `result` | `error{message:"**Claude ran into a problem:** Claude Code stopped without finishing its answer."}`, `done{error}` | sdk/24-program-exits-0-mid-answer.json; verify/sdk.json `r-exit0-mid-answer` |

"No message at all" counts the messages the SDK hands over: a program that wrote only its answer to `initialize`
and then exited with code 0 has still said nothing (3.1)
**[capture: verify/sdk.json `q-exit0-after-init-answer`]**. And once `run()` has sent its `done`, whatever happens
next (an error thrown, a bad exit code) is ignored.

The stderr tail in the SDK's sentences is the last 2,048 characters, trimmed, with key-shaped strings replaced
**[source: `Vx.formatStderrTail`, `hf`]**. Use Tarsee's own redaction on it in Rust.

The SDK has no time limit on a turn. (Its 60 second limit on the `initialize` answer applies only to a pre-warmed
query, which Tarsee does not use.) The turn layer's idle abort is the only clock.

---

## 7. Sessions on disk

### 7.1 Where

```text
<config folder>/projects/<project folder>/<session id>.jsonl
<config folder>/projects/<project folder>/<session id>/subagents/agent-<agent id>.jsonl      (subagents)
```

- **`<config folder>`** is `CLAUDE_CONFIG_DIR` when the program was given one, else `<home>/.claude`
  **[source: `Nt`: `CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")`]**. So the plan's sessions are under
  `~/.claude/projects/`, and a key provider's under `<STATE_DIR>/.claude-home-<id>/projects/`
  **[capture: real/turn-bash-tool-call.json: with `CLAUDE_CONFIG_DIR=<HOME>\.claude` the transcript was
  `<HOME>\.claude\projects\<WORKSPACE_AS_FOLDER_NAME>\<session id>.jsonl`]**.
- **`<project folder>`** is the working folder's full path (resolved, symbolic links followed) with **every
  character that is not an ASCII letter or digit replaced by `-`**, one for one, nothing collapsed
  **[source: `sl`: `e.replace(/[^a-zA-Z0-9]/g,"-")`]**. A working folder ending `\ws\session ws.dir_1` got a folder
  name ending `-ws-session-ws-dir-1`: each backslash, the space, the dot and the underscore are one `-` each, and a
  drive's `X:\` at the front becomes `X--` **[capture: real/transcript-location.json]**. "Character" means a
  **UTF-16 code unit**: `é` became one `-`, and an emoji (one character to Rust's `chars()`, two code units)
  became **two**: a folder named `emoji 😀 dir` gave `…-emoji----dir`
  **[capture: verify/transcript-folder-names.txt]**. In Rust: `path.encode_utf16().map(|u| if u < 128 &&
  (u as u8).is_ascii_alphanumeric() { u as u8 as char } else { '-' })`.

  Two further rules, read in the SDK's copy **[source: `Vu`, `Ab`, `QP`]** and then seen in the real program
  **[capture: verify/transcript-folder-names.txt; verify/real.json `s29-*`]**:

  - a name longer than 200 characters is cut to its first 200 and gets `-` plus a hash of the **whole path as
    it was before the replacing**: `h = 0; for each UTF-16 code unit c: h = (h * 31 + c) wrapped to a signed 32-bit
    integer`; then the absolute value of `h` in base 36, lower case (take the absolute value in 64 bits: JavaScript
    turns -2147483648 into 2147483648, where Rust's `i32::abs` would overflow). A 210-character path gave a
    207-character name ending `-z7altt`, and that formula gives the same;
  - `CLAUDE_CODE_PROJECT_DIR_NAME` (1 to 64 letters, digits, `_`, `-`) replaces the name when `CLAUDE_CONFIG_DIR`
    is set: with `my_proj-1` the transcript was at `<config folder>/projects/my_proj-1/<session id>.jsonl`. Tarsee
    does not set it; `engine-env` passes it through if the server's environment has it.

  Tarsee's own `slugifyCwd` (`/[\s/.]+/g` → `-`) is a different, older rule; that is why `claude-transcript.js`
  falls back to scanning every project folder for `<session id>.jsonl`, and why `token-usage.js` tries both
  spellings. Keep both behaviours.
- **`<session id>`** is the `session_id` of `system/init` and `result`: a UUID the program picks for a new session,
  the id given to `--resume` for a resumed one. A resumed turn appends to the same file.
- The subagent path is from the SDK's type file (`listSubagents`); no subagent ran in any capture.

Beside the transcripts, after a two-turn session the config folder held `.claude.json` (with `CLAUDE_CONFIG_DIR`
set it is inside that folder), `backups/`, `plugins/`, `session-env/<session id>/`, `sessions/`,
`shell-snapshots/` **[capture: real/transcript-location.json]**.

### 7.2 What a transcript holds

One JSON object per line **[capture: real/session-transcript.jsonl, the file of a session with a Bash call and a
resumed second turn]**. The rows Tarsee reads (`lib/token-usage.js`):

| Row | Fields Tarsee reads |
| --- | --- |
| `{"type":"assistant", …}` | `message.id`, `message.model` (`"<synthetic>"` rows are skipped), `message.usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens}`, `timestamp`, `requestRef`, `effort` |
| `{"type":"api-request", …}` | `id`, `timestamp`, `params.output_config.effort` |
| `{"type":"user", …}` | `timestamp`; a typed prompt is found by the text `"role":"user","content":"` |

In the capture the prompt's row holds a list, `"message":{"role":"user","content":[{"type":"text","text":"run echo"}]}`
(the shape of the user message on stdin, 2.3), so that text does not occur in it; and the `assistant` rows have
`perTurnEffort` and no `effort` key (the session was run without `--effort`).

Other rows seen, none read: `queue-operation`, `attachment` (environment, model, date, …), `api-request-shape`,
`api-request-blob`, `tools-used`, `last-prompt`, `atis-latch`, `mode`, and `cost-state` (the session's running
totals, the source of 8.1).

Sizes: `claude-transcript.js` only stats the file (`transcriptSizeMB`), and a session over 8 MB
(`TARSEE_SESSION_JSONL_MAX_MB`) is not resumed.

---

## 8. What the Node engine gets wrong

Five things the captures show (8.4 and 8.5 were added by the second pass). Each is reported, not fixed: the
port's rule is the same behaviour, so these are the lead's to decide.

### 8.1 A resumed turn's cost is the whole session's

`turnCost()` takes `result.total_cost_usd` as the turn's cost on `anthropic`, and prices `result.modelUsage` on
`deepseek` (and on `openrouter` without a streamed cost). On a resumed session both are **running totals of the
session**, restored from the transcript's `cost-state` row:

| | `usage` (in / out) | `total_cost_usd` | `modelUsage` (in / out) | `model_usage_since_last_result` |
| --- | --- | --- | --- | --- |
| turn 1 (two calls) | 24 / 12 | 0.000252 | 24 / 12 | 24 / 12, 0.000252 |
| turn 2, `--resume` (one call) | 12 / 6 | 0.000378 | 36 / 18 | 12 / 6, 0.000126 |

**[capture: real/turn-bash-tool-call.json, real/turn-resumed-session.json]**. Seen again over three turns of one
session, one call each: `total_cost_usd` 0.000123, 0.000246, 0.000369 and `modelUsage` 11/6, 22/12, 33/18, while
`usage` and `model_usage_since_last_result` stayed at 11/6 and 0.000123 every turn
**[capture: verify/resumed-session.txt; verify/real.json `s1a-turn1`, `s1b-turn2-resume`,
`s1c-turn3-resume-no-snapshot-key`]**. The SDK's type file says the same of both fields: "a resumed or forked session continues from the total its transcript saved, when it has one (so the
first result already carries the earlier turns)" **[source: `sdk.d.ts` `SDKResultError.total_cost_usd`,
`.modelUsage`]**. So the `costUsd` on the `usage` event of every turn after a chat's first counts all the turns
before it again, and the turn layer takes that figure as the turn's cost (`turn.js`: `evt.costUsd`). The Usage page
is not touched by this: it prices the transcripts itself (`lib/token-usage.js`). `usage` is this turn's alone, and
so is `model_usage_since_last_result` (present in the program's output, absent from the type file).

### 8.2 The R6 guard cannot promise "Nothing was sent"

On a wrong `apiKeySource` in `system/init`, `run()` aborts and says nothing was sent. The abort only closes stdin
(5.1), which does not stop a model call (5.2), and the first event of the API's reply followed `system/init` by 38
to 646 ms (median 86) in the 16 runs in `real/` that got a reply, so the request itself leaves sooner than that.
The request can go out long before the process is killed 2 to 7 seconds later. The Node test of this case uses an
API that hangs and checks only that no text was shown. A Rust engine that kills the process the moment it reads a
wrong `apiKeySource` narrows the window; whether it closes it was not measured. With a stand-in program that
reported `/login managed key` and then stayed up, the Node engine emitted its error and `done` at once, returned 2
seconds later and left the process running for 7 seconds **[capture: verify/sdk.json `y-bad-key-source`]**.

### 8.3 The "isn't installed" branch never runs

`run()` looks for `/ENOENT.*claude/i` in a thrown error to say "Claude Code isn't installed where Tarsee can run
it". The SDK 0.3.319 never lets `ENOENT` through: it rewrites a missing program into `Claude Code native binary not
found at …`, so the owner gets `**Claude ran into a problem:** Claude Code native binary not found at …` instead
**[capture: sdk/22-program-not-found.json]**. In Rust the start fails with the system's own "not found", and the
engine can say the clearer sentence. (A missing working folder is worse in the Node version: it is reported as a
binary that "exists but failed to launch", with advice about libc, 6.3.)

### 8.4 Stop does not stop the agent's work

After Stop the owner sees the turn end (`done{aborted}`), but the program was only told that no more messages are
coming. It goes on with the turn: it ran a tool 54 ms after its stdin was closed and made a second model call
(5.2), and it would go on until its `result`. What ends it is the SDK's clock: SIGTERM at 2 seconds on Linux, the
kill at 7 seconds on both systems. In that time a tool with an effect outside the conversation (a sent message, a
written file, a shell command) can still run, and nothing of it is shown. The same holds for the turn guard's
budget stop and the R6 refusal, which use the same abort. The `interrupt` request of 5.3 ends the model call
within a second **[capture: verify/stops-and-interrupts.txt; verify/sdk.json `k-stop-hang`]**.

### 8.5 A budget stop can still run one tool

When the reply that crosses `--max-budget-usd` asks for a tool, the program starts that tool before it writes
`result/error_max_budget_usd`, and reports nothing about it (6.2, 4.2). `run()` then says "Stopped after hitting
the configured spend ceiling for this task." The tool's effect, if it has one, has happened. This is the
program's behaviour, not the Node engine's; it is listed here because the message suggests otherwise
**[capture: verify/budget-tool-still-called.txt]**.

---

## 9. Not confirmed

| What | Why | Where it matters |
| --- | --- | --- |
| What the real program does when it gets SIGTERM (Linux, macOS), once or twice | the SDK's half was run under Linux (5.1), but there was no Linux build of the program on the machine and none was fetched; nothing at all was run on macOS | 5.1, 5.2 |
| How a three-part system prompt is laid out for Anthropic's own host (blocks, cache marks) | needs a real API call. With a loopback host both passes saw the two parts joined into one block, and the second saw that block carry the cache mark | 2.2 |
| Whether tools from an HTTP server are deferred behind tool search on the plan without `alwaysLoad` | needs Anthropic's own host. With a loopback host they were offered outright with and without it, in both passes | 4.2 |
| Whether npm's own `claude.cmd` can be started with these arguments on Windows | a hand-written wrapper of the form `"%~dp0claude.exe" %*` passed every argument through from Rust 1.95; npm's wrapper, and one that starts `node cli.js`, were not tried (no npm global install of the program on the machine) | 1.1 |
| Whether `CLAUDE_CODE_ENTRYPOINT=sdk-ts` or `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` change anything beyond what 1.4 lists | one more effect of the entrypoint was found (the 404's words); only the plain turns and twenty failure runs were compared | 1.4 |
| Whether the order of the arguments matters | only the SDK's order, plus `--mcp-config` last and `--system-prompt` last, were run | 1.2 |
| Subagent messages (`parent_tool_use_id` set), compaction (`system/status` `compacting`), a `control_cancel_request` or `keep_alive` written by the real program, a `user` message with `isReplay` | a scripted API cannot produce them; their shapes are from `sdk.d.ts` and `Yy.readMessages`. (A `keep_alive` line played by a stub was swallowed by the SDK; no `isReplay` message came on three resumed turns) | 3.1, 3.2 |
| A real crash of the program | none could be caused; an unexpected exit was recorded with the stub, in both passes | 6.2, 6.3 |
| What the program does when a `control_request` it wrote is never answered | not tried: with Tarsee's arguments and an HTTP MCP server it wrote none | 2.4 |
| A refused `initialize` (the error answer to that request) | the error shape was seen for another request only | 2.2 |
| What 2.1.319 uses `customApiKeyResponses` for | approved, absent and rejected all gave the same turn in this mode; an interactive start was not tried | 1.7 |
| Anything about a `claude` newer than 2.1.319 | only the program the SDK 0.3.319 ships was run | 1.1 |

Settled by the second pass and no longer in this table: the Linux timing of the SDK's stop (5.1), the
200-character and `CLAUDE_CODE_PROJECT_DIR_NAME` rules for the project folder (7.1), and the exit code Windows
reports for a killed process (6.1).

---

## 10. Checked independently

A second person read this document as the engineer would, then tried to break it. Nothing of the first pass's
harness was used: the stub (`stub.mjs` behind a launcher, `tramp.rs`), the capture script that drives Tarsee's own
`run()` through the real SDK (`cap.mjs`), the stand-in Messages API and the logging MCP server (`fakes.mjs`), the
driver for the real program (`drive.mjs`) and two Rust and Linux probes were written from nothing. They are in
`tests/fixtures/claude-cli/scripts/verify/`, their results in `tests/fixtures/claude-cli/verify/`. The same rules
held: an empty home and config folder, made-up keys, a loopback API, no sign-in and no model call. It ran on
Windows 11 with Node 22.18 and Rust 1.95, the same SDK 0.3.319 and program 2.1.319, and for the Linux stop on
Node 22.22 under WSL 2.

The SDK's minified source was read again for every **[source: …]** mark that a run could not replace: the
argument builder and the environment changes (`Vx.initialize`, `ck`), the two helpers (`Ye`, `jy`), the stop
(`Vx.close`), the reader (`Yy.readMessages`), when stdin is closed (`Yy.endRun`, `Yy.streamInput`), the control
requests (`Yy.processControlRequest`), the binary lookup (`v3`, `l5e`, `c5e`), and the folder naming (`sl`, `Vu`,
`Ab`). They say what this document says they say.

### 10.1 What was captured again, and agreed

| Area | How | Result |
| --- | --- | --- |
| The argument list (1.2) | 30 runs of `run()` → SDK → stub over the four providers: resume, parts, effort, thinking, media, both caps, the HTTP config | the 16 cases that have a counterpart in `sdk/` gave the same list, argument for argument, once the model ids are set aside (the two passes resolved the tier words to different ids, and asked OpenRouter for different models; that is Tarsee's model table, not the SDK) (`scripts/verify/compare.mjs.txt`); the order of the table holds in all 28 lists |
| The environment (1.4) | the same runs, the environment given against the one received | the three additions and two removals, nothing else, in all 28 runs that started a program; nothing filled in under Linux |
| stdin (2) | the same runs | the `initialize` line (key order, the one-element and three-element `systemPrompt`, `systemPromptSnapshot:false`), both user message shapes, the answer to `mcp_message`, and when stdin is closed in each of the three cases: as written. The 27-tool manifest of 4.1 equal to the fixture's but for the time zone named in two descriptions |
| What the SDK keeps to itself (3.1), non-JSON lines (3) | a stub that wrote them | as written |
| Stopping (5.1) | a stub that never exits, one that keeps writing, one that exits on a closed stdin; the process watched by pid | stdin closed at the abort, the kill 7.0 s later on Windows, `done{aborted}` at 7 s or at 2 s as described |
| Failing (6.3) | a stub exiting with 1, 3 and 0 at four points; a missing program | every sentence as written |
| `claude --help` (1.1, 1.6) | the program itself | every flag this document names is there except `--thinking`, `--thinking-display`, `--max-turns` and `--permission-prompt-tool` |
| The real program driven with no SDK and no `-p` (0) | 86 runs | the order of 3.3, exit codes, the transcript's place, `apiKeySource`, the `user-agent` |
| The HTTP MCP server (4.2) | a second logging server, nine runs | the six requests, their headers and bodies, the three ways to hand over the token, a 401, nothing listening, a session id, an older protocol version, both kinds of failed call |
| Sessions (7, 8.1) | three turns of one session, then four of another | the same `session_id`, the running totals of 8.1, the rows of 7.2 |
| API failures (6.2) | eleven kinds (the refused sign-in token among them), five of them in four environments | every code, status and sentence, but for the one in 10.2 |
| `interrupt` (5.2) | three runs | the order of messages, the `result`, the process staying up |
| A thinking block; a provider's own cost and cache counts on the stream (3.2) | a stand-in API that streams them | one `assistant` message per finished block, `system/thinking_tokens`, the counts and the `cost` unchanged, `total_cost_usd` the program's own figure |
| The entrypoint markers (1.4) | three runs | the three `user-agent` values and billing lines of the table |
| A Bash call, and what the agent's shell can read (3.2, 4.2) | two runs | the `user` message's shape; the MCP token readable in the shell either way, the provider's key only when the turn is not host-managed |

Not run again, so resting on the first pass alone: the run against Tarsee's own Node MCP endpoint
(`mcp-http/tarsee-node-endpoint.json`; the second pass used a server of its own with two tools), the protocol
version `2024-11-05`, the `wire/` chain of `run()` → SDK → real program as one piece (each half was run), and the
`timeout` and `alwaysLoad` meanings taken from the type file.

### 10.2 What was corrected

| # | The document said | It now says | Evidence |
| --- | --- | --- | --- |
| 1 | 5.2: with stdin closed while a model call runs the program does "nothing: it writes no message, does not stop the call and does not exit" | closing stdin stops nothing and ends nothing early: the program finishes the turn (the stream, tools, further model calls), writes its `result` and exits. The first capture's API never finished its reply, which is why that process never left | verify/real.json `s6-…`, `s14-…`, `s7-…`; the description in real/stop-stdin-closed-mid-stream.json was corrected too |
| 2 | 6.2: at the dollar ceiling the crossing call's "tool is not run" | the tool is started (its `tools/call` reached the MCP server) and only its result is not reported | verify/budget-tool-still-called.txt |
| 3 | 1.2: `--max-turns` is "always" present | a caller's `0` gives no flag (the SDK drops a zero) | verify/sdk.json `v-budget-forms` |
| 4 | 6.2: one wording of the 404 for the model | two: the sentence ` Run --model to pick a different model.` is added unless `CLAUDE_CODE_ENTRYPOINT=sdk-ts`. So the choice of 1.4 changes a failure's words | verify/failure-words-by-environment.txt |
| 5 | 1.4: whether `sdk-ts` changes anything else was not confirmed | one more effect found (row 4); the rest still open | the same |
| 6 | 5.1: the Linux column "from the source only" | run under Linux: stdin at once, SIGTERM at 2.0 s (delivered twice), the kill at 7.0 s; and on Linux the SDK's stream ends at 2 s even when the process ignores SIGTERM, where on Windows it ends at 7 s | verify/linux-stop.txt |
| 7 | 6.1, 9: the exit code of a killed process on Windows not confirmed | 1 from Rust's `Child::kill()`: the same code as after an error `result` | verify/rust-probe-windows.txt |
| 8 | 1.1, 9: a `.cmd` wrapper not confirmed | a `%*` wrapper passes the arguments intact from Rust 1.95; killing it leaves `claude` running; npm's own wrapper still open | the same |
| 9 | 7.1: "every character … replaced by `-`, one for one" | every UTF-16 code unit: an emoji gives two dashes. The 200-character rule and `CLAUDE_CODE_PROJECT_DIR_NAME`, "not seen", were seen | verify/transcript-folder-names.txt |
| 10 | 2.4: any other control request gets `Unsupported control request subtype` | three more kinds have words of their own | verify/sdk.json `w-unknown-control-requests` |
| 11 | 2.2: `systemPromptSnapshot: false` "must be sent" | on every turn: `false` does not remove a record made earlier | verify/system-prompt-record.txt |
| 12 | 2.2: the error answer to a control request "not seen" | seen from the real program | verify/real.json `s19-…` |
| 13 | 6.3: `Claude Code returned an error result: …` from the source | seen, by reading the SDK's stream to its end | verify/direct-sdk.txt |
| 14 | 6.3: "exists but failed to launch" from the source | seen, and its everyday cause: a working folder that does not exist | verify/sdk.json `zc-working-folder-missing` |
| 15 | 1.4: `cc_version=2.1.319.812` | the last three characters change with the first message | verify/system-blocks.txt |
| 16 | 3.2: `message_delta` reads `event.usage.{output_tokens, …}` | the four counts, named | `lib/tool-steps.js` `take()` |

### 10.3 What was added

- 1.7: what `run()` writes into the provider's home before a turn (`approveKeyInHome`), which the document did not
  mention, and that 2.1.319 uses the key whether or not it is approved.
- 1.2: how JavaScript writes the budget (`1e-7`), that the program takes both spellings, and that `--mcp-config`
  and three other flags take several values.
- 1.6: `--debug-file`, which the SDK adds when `DEBUG_CLAUDE_AGENT_SDK` is in the server's environment.
- 5.1: a signal already aborted before the start (the Node version still starts the program); that the SDK's
  stream follows stdout, not the process.
- 5.2, 5.3: an `interrupt` with no turn running gets no `result`; the exit code follows the last result; a failed
  resume exits without waiting for stdin.
- 2.2: where the cache marks are with a loopback host.
- 4.2: the whole body of the `server/discover` probe; that a tool can run in a turn that is then stopped.
- 8.4, 8.5: two more things the Node version gets wrong, or reports misleadingly.

### 10.4 What is still not confirmed

The table of section 9, whole. The three that matter most to the engine: what the real program does on SIGTERM
(so the Linux stop of 5.3 rests on the kill at 7 seconds unless `interrupt` is used); how the split system prompt
is cached on Anthropic's own host; and npm's `claude.cmd`.
