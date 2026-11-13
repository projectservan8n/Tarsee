# Claude Code command-line fixtures

What the Node version's Claude engine really did, written down so the Rust engine
(`src/ai/providers/claude_code.rs`) can be built and tested without the npm SDK. The specification that reads these
is `docs/rust-port/engines/claude-cli-protocol.md`.

Made on 2026-11-13 with:

- `@anthropic-ai/claude-agent-sdk` 0.3.319 (the SDK the Node version calls)
- the `claude` program that SDK ships, version 2.1.319 (`claude --version` prints `2.1.319 (Claude Code)`)
- Tarsee's own `src/ai/providers/claude-code.js`, `src/ai/engine-env.js` and `src/ai/tarsee-mcp.js`, unchanged
- Node 22.18 on Windows 11

Nothing here came from a real account. No sign-in was used, no real key, and no model was ever called: the keys
are made-up strings, and wherever the real `claude` program ran it talked to a small stand-in for the Messages API
on `127.0.0.1` (the Node repository's `test/fixtures/fake-anthropic.js`) from an empty home folder.

## The folders

| Folder | What ran | What each file holds |
| --- | --- | --- |
| `sdk/` | Tarsee's `run()` → the real SDK → **a stub** in place of `claude` | The options Tarsee gave `query()`, the command line and environment the SDK made of them, every line the SDK wrote to the program's stdin, the stdout the stub played back, and the events Tarsee's engine emitted |
| `wire/` | Tarsee's `run()` → the real SDK → **the real `claude`** → a fake Messages API | Every line that crossed the program's stdin and stdout, both ways, in order, with times; which of them the SDK passed on to its caller |
| `real/` | **The real `claude`, started directly** (no SDK) → a fake Messages API | The arguments, the lines written to stdin, every stdout message, stderr and the exit code, for normal turns, stops and each kind of failure |
| `mcp-http/` | The real `claude` pointed at an HTTP MCP server on loopback | Every request the program sent (method, path, headers, body) and what the model was offered |
| `verify/` | A second, independent pass over all of the above: its own stub, stand-in API, logging MCP server and driver | What that pass recorded: see [`verify/`](#verify-the-independent-check) below |
| `scripts/` | | The scripts that made all of this, as `.txt` so the repository's tools leave them alone. `scripts/verify/` holds the second pass's |

### `sdk/`: one file per combination of options

Every branch of `claude-code.js` that changes what the SDK is given has a file. Fields:

- `tarsee_run_opts`: what was passed to `run()`
- `sdk_query.prompt`, `sdk_query.options`: what Tarsee passed to the SDK's `query()` (live objects are named, not
  shown; the environment is listed by name, with values only for the names that matter)
- `spawn.argv`, `spawn.cwd`: what the program was started with, as the program itself recorded it
- `env.given_to_sdk`, `env.received_by_program`, `env.sdk_changes`: the environment before and after the SDK
  (`filled_in_by_windows_process_start_not_the_sdk` lists names Windows adds to any new process; not the SDK's doing)
- `stdin`: each line the program received, parsed, with `t` (milliseconds since the stub started) and its size
- `stdin_events`: when the user message was read, when the result was written, when stdin was closed
- `stdout_played`: the lines the stub wrote (copies of real 2.1.319 output, cut down)
- `sdk_messages_seen_by_tarsee`: the type of each message the SDK handed on
- `tarsee_events`, `tarsee_logs`: what `run()` yielded and logged
- `sdk_process_calls`, `child_exit`, `abort_at_ms` (files 14, 15, 20 only): every `stdin.end()` and `kill()` the SDK
  made on the process, with times
- `sdk_error_thrown`: the error the SDK's stream ended with, if any

| File | Covers |
| --- | --- |
| `01` | The Claude plan, new session, plain system prompt. The base case |
| `02` | Resume, the system prompt in parts with the boundary marker, effort, thinking summaries |
| `03` | `systemParts` with nothing volatile (one string, no marker); `sessionId: null` beats a stored handle |
| `04` | A picture in the last message, no MCP server: the prompt is a generator; stdin closes at once |
| `05` | The turn layer's adapted media (a PDF) with the in-process MCP server: stdin stays open to the end |
| `06` | Media as a bare array and no words: the picture block alone |
| `07` | No words, no media: the word `hello` |
| `08` | The in-process MCP server announced, and one tool call over the control channel (the 27-tool manifest whole) |
| `09` | A background caller: `maxTurns` 8, `haiku` (no fallback), the session from a bare stored handle |
| `10` | The Anthropic key: its home, its key, host-managed, project settings only, strict MCP, the dollar ceiling |
| `11` | DeepSeek default: bearer token, base URL, model pins, an effort it doesn't take left out, no budget flag |
| `12` | DeepSeek Pro: effort `max`, fallback to Flash, resume from a tagged handle |
| `13` | OpenRouter: tier pins and the attribution headers from Settings |
| `14` | Stop while the program keeps running: stdin closed, then killed 7 s later (Windows) |
| `15` | Stop with a program that exits when stdin closes |
| `16`, `17` | The program's own stops: turn limit, spend ceiling |
| `18` | The program exits with code 1 before any message |
| `19` | A transcript over the size cap: no `--resume` |
| `20` | The command the SDK starts when nobody names one (the bundled `claude.exe`) |
| `21` | Not Tarsee's Node behaviour: an HTTP MCP server config handed to the SDK, for the `--mcp-config` arguments it makes |
| `22` | No program at the path |
| `23`, `24` | The program exits with code 0 without a result (silent, and mid-answer) |

### `real/`

`turn-*` are normal turns, `stop-*` are ways of stopping one, `fail-*` are failures: 30 runs. Each has `argv`,
`stdin_written`, `stdout` (every message, with `t` in milliseconds since the process started), `stderr` and `exit`.
`exit.at_ms` is read 100 ms after the process ended (the driver waits that long for the last output), so take the
exit's own time from the `wire/` files' `process_calls` instead. The catalog lists in the program's answer to
`initialize` and in `system/init` (commands, models, skills) are cut to a count everywhere except
`turn-plain-text.json`.

Also:

- `session-transcript.jsonl`: the transcript file of the two-turn session in `turn-bash-tool-call` and
  `turn-resumed-session`, as the program wrote it;
- `transcript-location.json`: where that file was, how its folder was named, and what else the program left in its
  config folder;
- `system-prompt-forms.json`: what reaches the API as `system` for each way of giving the system prompt;
- `entrypoint-markers.json`: what the SDK's two environment markers change;
- `rust-probe-output.txt`: what `scripts/rust-probe.rs.txt` printed. It is one whole turn driven from Rust with the
  standard library only (a cleared environment, the `--mcp-config` JSON as an argument), against a closed port so
  the turn ends in a connection error.

### `mcp-http/`

`tarsee-node-endpoint.json` is the important one: the real program against Tarsee's own loopback MCP endpoint (the
Node `src/ai/mcp-http.js`), with each request and the endpoint's answer. The others use a 60-line stand-in server to
try one thing each; `other-checks.json` (the config file deleted after start-up, an older protocol version) and
`tool-errors.json` (a failed tool call) hold several short cases each. `stdout_message_counts` in each one-run file
is how many stdout lines of each kind the program wrote (none is a `control_request`).

### `verify/`: the independent check

Made on 2026-11-13 by a second person checking the specification, with the same SDK and program and nothing from
the scripts above. Section 10 of the specification says what these files confirmed and what they corrected.

| File | What it holds |
| --- | --- |
| `sdk.json` | 30 runs of Tarsee's `run()` → the real SDK → a stub (`scripts/verify/cap.mjs.txt`, `stub.mjs.txt`, `tramp.rs.txt`). For each: the options given to `query()`, the arguments the stub received, what the SDK added to and removed from the environment, every stdin line (the long strings cut, with their length), the stub's timeline, the messages Tarsee's loop saw, the error the SDK threw, and Tarsee's events and logs. Cases the first pass does not have: a caller's `maxTurns` of 0 and a budget of 0.0000001 (`v-budget-forms`), a signal already aborted (`n-…`), nine kinds of control request (`w-…`), lines that are not JSON and lines ended with CR LF (`x-…`, `zd-…`), a wrong `apiKeySource` (`y-…`), a working folder that does not exist (`zc-…`) |
| `real.json` | 86 runs of the real `claude` started directly (`scripts/verify/drive.mjs.txt`, `fakes.mjs.txt`, `r1` to `r11`). For each: the arguments, the stdin lines with times, the kind of every stdout line with its time, the messages the specification cites (the `result` cut to the fields Tarsee reads plus the list of its keys), stderr, the exit, and for the `m…` runs every request the MCP server got. `s6`, `s7`, `s14`: stdin closed in the middle of a turn. `s5`, `s15`, `s17`: `interrupt`. `s13a` to `s13d`: the system prompt record. `s31-*`: five API failures in four environments |
| `help-2.1.319.txt` | `claude --help`, whole |
| `linux-stop.txt` | The SDK's stop under Linux Node 22 (WSL 2) with a stand-in that logs its signals (`scripts/verify/linux-stop.mjs.txt`, `linux-stub.txt`) |
| `rust-probe-windows.txt` | A Rust 1.95 standard-library probe (`scripts/verify/probe.rs.txt`): the arguments through a native program and through a `.cmd` wrapper, and the exit code of a killed process |
| `direct-sdk.txt` | The SDK called with no Tarsee code and its stream read to the very end: what it throws after an error result; what `DEBUG_CLAUDE_AGENT_SDK` adds |
| `budget-tool-still-called.txt` | The reply that crosses `--max-budget-usd` asks for a tool: the times of the program's stdout lines and of the requests its MCP server got |
| `stops-and-interrupts.txt` | The printed summary of `s14`, `s15`, `s17`, `s18`, with the time the MCP server got its `tools/call` |
| `resumed-session.txt` | Three turns of one session: each `result`'s totals, and the `system` blocks the API was sent on each |
| `system-prompt-record.txt`, `system-blocks.txt` | What reaches the API as `system`: with and without `systemPromptSnapshot`, and block by block with the cache marks |
| `failure-words-by-environment.txt` | The words of a 401, 402, 403, 404 and 500 with and without `CLAUDE_CODE_ENTRYPOINT=sdk-ts` and `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` |
| `classified-kinds.txt` | Those words given to the Node `classifyEngineError` for `claude` and for `deepseek` |
| `anthropic-key-approval.txt` | An `ANTHROPIC_API_KEY` not approved, approved and rejected in the home's `.claude.json` |
| `transcript-folder-names.txt` | The transcript folder for a working folder with odd characters, one longer than 200 characters, an emoji, and with `CLAUDE_CODE_PROJECT_DIR_NAME` |
| `raw-line-ends.txt` | The bytes of the program's stdout and stderr: line ends and byte-order mark |
| `models-credentials-retry-thinking.txt` | The printed summary of `s23` to `s28`: a model id the program does not know, no credential, an unreachable host, a 404, a retry, and what `--thinking`, `--thinking-display` and `--effort` put in the request |
| `picture-prompt-flag-unknown-request.txt` | The printed summary of `s20`, `s21`, `s19`: what the API is sent for a picture, the system prompt given by flag, and the program's answer to a control request it does not know |
| `thinking-cost-token-agent-shell.txt` | The printed summary of `s33` to `s37`: a thinking block, a provider's own cost on the stream, a refused sign-in token, the `user-agent` with the SDK's markers, and a Bash call that says which of the MCP token, the provider's key and a vault key the agent's shell can read |

In these files `t` in `real.json` is milliseconds since the process was started; in `sdk.json` it is milliseconds
since `run()` was called, except on stdin lines and in `stub_timeline`, where it is since the stub started.
`<SCRATCH>` is the second pass's own scratch folder and `<SCRATCH_AS_FOLDER_NAME>` that path as the program names a
transcript folder. Model ids in `sdk.json` are whatever Tarsee's model table resolved the tier words to on the day.

To make them again: copy `scripts/verify/*.txt` to an empty folder outside any repository without the `.txt`
(`stub.mjs`, `tramp.rs`, `probe.rs` and `shim.cmd` into `./stub/`, `linux-stub` and `linux-stop.mjs` into
`./linux/`), set `VERIFY_SCRATCH` to that folder and `TARSEE_NODE_PROJECT` to the Node checkout, build the
launcher (`rustc -O -o stub/fake-claude.exe stub/tramp.rs`, and write the path of `node` to `stub/node-path.txt`),
then run `cap.mjs`, `direct.mjs`, `direct2.mjs`, `help.mjs`, `rawcheck.mjs`, `classify.mjs` and `r1.mjs` to `r11.mjs` with `node`, the probe
(`rustc -O -o stub/probe.exe stub/probe.rs`), `linux-stop.mjs` under Linux with `SDK_MJS` set to the SDK's
`sdk.mjs`, and last `build-verify-fixtures.mjs <this folder>`, which replaces the machine's paths and names and
refuses to write a file that still holds one. The text files are those scripts' printed output, saved under
`notes/` in the scratch folder first.

## Placeholders

| Placeholder | Stands for |
| --- | --- |
| `<WORKSPACE>` | the turn's working folder |
| `<WORKSPACE_AS_FOLDER_NAME>` | that path as the program names its transcript folder (every character that is not a letter or digit replaced by `-`) |
| `<HOME>` | the home folder the run was given (`HOME` / `USERPROFILE`) |
| `<STATE_DIR>` | Tarsee's state folder (`config.STATE_DIR`) |
| `<TARSEE_ROOT>` | the Node checkout |
| `<CLAUDE_EXE>` | the program the SDK was told to start (the stub, in `sdk/`) |
| `<SCRATCH>`, `<TEMP>`, `<USER_HOME>`, `<POWERSHELL_EXE>`, `<OS_VERSION>`, `<NODE_EXE>`, `<STUB_SCRIPT>` | this machine's own paths and names |
| `127.0.0.1:<PORT>` | a loopback port picked at run time |
| `<TOKEN>`, `<ANTHROPIC_KEY>`, `<DEEPSEEK_KEY>`, `<OPENROUTER_KEY>`, `<PLAN_OAUTH_TOKEN>` | the made-up credentials |

Session ids, message ids and `uuid` values are the ones the runs produced; they mean nothing outside their file.
Model ids such as `claude-sonnet-5` come from a fixed table in `capture-lib.mjs` (the newest pinned row of each
tier in `src/config/constants.js`), not from a catalog.

## How they were made

1. **The stub** (`stub-claude.mjs`, started through `stub-claude.exe`, which is `trampoline.rs` compiled). The SDK
   lets the caller name the program; the stub records its arguments, working folder, environment and every stdin
   line, and plays back a scripted stdout so the SDK goes through a whole turn. It is a native executable because
   the SDK treats a path that does not end in `.js` or `.mjs` as a native binary, which is the path Tarsee's code
   takes. `capture-lib.mjs` runs Tarsee's real `run()` with a `deps.query` that adds only
   `pathToClaudeCodeExecutable` to the options; `cap-fixtures.mjs` lists the combinations.
2. **The hook** (files 14, 15, 20 in `sdk/`, and all of `wire/`). `options.spawnClaudeCodeProcess` makes the SDK
   hand over `{command, args, cwd, env, signal}` instead of starting anything. The harness records that, starts the
   process itself and wraps `stdin.write`, `stdin.end` and `kill` to log them. In `wire/` the process is the real
   `claude` (`tee-capture.mjs`), reached through engine-env's test-only base-URL seam (`NODE_ENV=test`,
   `TARSEE_TEST_BASE_URL_DEEPSEEK`), so it is a DeepSeek turn with a made-up key.
3. **Direct** (`real/`, `mcp-http/`). `real-drive.mjs` starts the real `claude` with the arguments the SDK would
   use, writes the stdin lines by hand and records everything. Its environment is built from nothing (a dozen
   system names, an empty `HOME` and `CLAUDE_CONFIG_DIR`, a made-up `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` at
   the fake), so the machine's own sign-in cannot be read or used.
4. `build-fixtures.mjs` copies the records here, replaces paths, ports and keys with the placeholders above, cuts
   the catalog lists, and reports any file that still names the machine or holds anything shaped like a key.
5. `classify.mjs` gives each recorded failure to the Node `classifyEngineError` and prints the kind it comes out as
   (the last column of the failure table in the specification).

To make them again (Windows; the scripts expect two variables and take everything else from them):

```bash
export CAPTURE_SCRATCH=<an empty folder outside any repository>
export TARSEE_NODE_PROJECT=<the Node checkout, with node_modules>
cd "$CAPTURE_SCRATCH"            # copy scripts/*.txt here without the .txt; stub-claude.mjs and the two .rs go in ./stub/
rustc -O -o stub/stub-claude.exe stub/trampoline.rs
where node > stub/node-path.txt  # the stub's launcher starts node by this path (its environment may have no PATH)
node cap-fixtures.mjs            # sdk/     (about 3 minutes; two of the runs wait out a 7 second kill)
node tee-capture.mjs             # wire/
node real-01-basic.mjs && node real-02-stop.mjs && node real-03-failures.mjs && node real-04-session.mjs
node real-05-mcp-http.mjs && node real-06-mcp-node-endpoint.mjs && node real-07-system-prompt.mjs
node real-08-more.mjs && node real-09-entrypoint.mjs && node real-10-cost.mjs && node real-11-mcp-error.mjs
rustc -O -o stub/rust-probe.exe stub/rust-probe.rs
stub/rust-probe.exe <the claude program> <an empty home folder> <a working folder> > real/12-rust-probe.txt
node build-fixtures.mjs <this folder>      # rewrites sdk/, wire/, real/, mcp-http/ and scripts/; leaves this README
node classify.mjs <this folder>/real
```

## What is not here

- Anything from Linux or macOS. Where the SDK does something different there (it sends SIGTERM when a turn is
  stopped), the specification says so from the SDK's source and marks it not confirmed.
- A turn on the real Messages API. How the program lays out the two parts of a split system prompt when it talks to
  Anthropic's own host was not seen.
- Compaction (`system/status` with `status: "compacting"`), subagents (`parent_tool_use_id` set) and a
  `control_cancel_request`: none could be produced with a scripted API. Their shapes are in the specification from
  the SDK's type file.
