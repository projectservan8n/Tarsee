# The `codex` program as Tarsee starts it

The Node version runs a Codex turn through `@openai/codex-sdk` 0.167.0, which starts the `codex` program
(`@openai/codex` 0.167.0) once per turn. The Rust version has no SDK: `ai/providers/codex.rs` starts the program
itself. This document is everything the SDK did between Tarsee's options and the program, and everything the
program does back, written so the engine can be built from it without the SDK's source. It also covers the two
ways Tarsee starts `codex` without the SDK (the ChatGPT sign-in and the account's model list).

Scope: exactly what Tarsee uses. Options the SDK has and Tarsee never passes are listed once, in 1.3, so that
nobody has to wonder whether they were forgotten.

## How to read the evidence

Every statement carries one of these marks. Nothing here is filled in from how such tools usually behave.

- **[src: file, name]** read in source. The SDK is one file, `node_modules/@openai/codex-sdk/dist/index.js`
  (called "the SDK file" below); Tarsee's files are under `src/ai/` of the Node version.
- **[cap: path]** recorded by running the real thing. Paths are under `tests/fixtures/codex-cli/`. Its
  `README.md` says how each folder was made:
  - `turns/` Tarsee's own engine (`providers/codex.js run()`) through the real SDK to a stub program that records
    its argument list, environment and stdin (Windows)
  - `sdk/` the real SDK called directly, same stub (Windows)
  - `posix/` the same on Linux (WSL2, Ubuntu, Node 22)
  - `real/` the real `codex` 0.167.0 program, started with exactly what the SDK produced, against a local fake
    model server and a local logging MCP server
  - `other/` the real program for the sign-in and the model list, and three probes
- **[chk: path]** recorded again, independently, when this document was checked (section 13): a different stub
  (a script run by `node` itself), different stand-ins for the model and the MCP server, a launcher written in
  Rust, on Windows and on Linux (WSL2). Paths are under `tests/fixtures/codex-cli/checked/`. Where a [cap] and a
  [chk] disagree, the text says so and follows the [chk].
- **NOT CONFIRMED** could not be observed here; what was tried is said. Section 9 lists them all.

No account was signed in to, no real key was used, and no model was asked anything: the model was a local fake of
the Responses API, the "sign-in server" a local stand-in, and every run of the real program had a proxy that is
not there (`HTTPS_PROXY=http://127.0.0.1:9`) between it and any address but this machine's. The turn captures
(`real/`) were made once without that proxy and once with it, with the same results.

## 0. The engine in thirteen lines

1. Start the native `codex` program directly: no shell, three pipes, the server's own working folder, the
   environment given whole, not detached (1.1, 1.6).
2. Arguments: `exec --experimental-json`, then one `--config key=value` pair per config leaf, then `--model`,
   `--sandbox`, `--cd`, `--add-dir`, `--skip-git-repo-check`, then four more `--config` pairs, then for a resumed
   thread `resume <thread id>`, then `--image <file>` per picture (1.3).
3. Add `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_sdk_ts` to the environment, and `CODEX_API_KEY=<key>` for the
   OpenAI provider (1.6).
4. Write the prompt to stdin as UTF-8 and close stdin. The program does nothing until stdin ends (2). A write
   that fails because the program has already exited is not the turn's failure: carry on to the exit code (2).
5. Read stdout by lines. Every line is one JSON object, an event. A line that is not JSON is fatal (3).
6. Collect stderr. It is used only in the error text when the exit code is not 0 (3.4).
7. When stdout ends, wait for the exit. Code 0: the turn's stream is over. Anything else: the error
   `Codex Exec exited with code <n>: <all of stderr>` (or `... with signal <NAME>: ...`) (6).
8. Stop: end the process (SIGTERM, or on Windows plain termination), once, with no second signal and no time
   limit; then on Linux and macOS kill every process that carries the turn's `TARSEE_CODEX_TURN` mark (5).
9. The thread id is the `thread_id` of the first event, `thread.started`; to resume, pass it back (1.3, 3).
10. `turn.completed` carries the thread's running usage total, not the turn's (3.2).
11. Tarsee's tools: the program reads the MCP server's address from `--config` and the token from
    `TARSEE_MCP_TOKEN`, and sends `initialize`, `notifications/initialized` and `tools/list` to it before it
    prints anything (4).
12. Never start a turn with a prompt that is empty or only white space: the program exits 1 (2).
13. Never start the program for a turn that has already been stopped (5.1), and on Windows decide what happens to
    a running `codex` when the server itself dies: Node ended it, a Rust `Command` does not (5.3).

The whole order of a turn in the Node engine, with what it yields at each way out, is section 12.

## 1. Starting the program for a turn

### 1.1 The process

The SDK starts the program with `spawn(this.executablePath, commandArgs, { env, signal: args.signal })`
**[src: the SDK file, `CodexExec.run`]**. Those are all the options, so:

| What | Value | Evidence |
|---|---|---|
| Shell | none: the argument list is passed as an array | [src]; [cap: sdk/sdk-01-config-flattening.json] arguments with quotes, backslashes, spaces and non-ASCII arrive unchanged |
| stdin, stdout, stderr | three pipes (Node's default) | [src] |
| Working folder | not set: the server process's own. The agent's folder goes as `--cd` | [cap: turns/*.json `child.cwd` is `<SERVER_CWD>`] |
| Environment | the whole environment is given (1.6); nothing is inherited implicitly on Linux | [cap: posix/posix-01-env-option.json] |
| Process group | not detached: on Linux the caller's process group and session | [cap: posix/posix-02-no-env-option.json `processGroup`] |
| Window (Windows) | `windowsHide` is not set (Node's default, false) | [src]; [chk: checked-04-sdk-stop.json `whatNodeWasAskedToStart`: `windowsHide` false, `detached` false, three pipes, no `cwd`] |
| Tied to the server's life (Windows) | yes, by Node itself, not by the SDK: a program Node starts without `detached` ends when the Node process ends, however it ends | [chk: checked-07-rust-command.json `whenTheParentIsKilled`]; 5.3 |

One process runs one turn and then exits. A resumed thread is a new process.

For the Rust engine: `Command::new(program).args(argv).env_clear().envs(env)` with three piped streams. Rust's
own argument quoting carries a turn's argument list to the program intact: a whole turn was started through a
Rust `Command` (`scripts/bare-env.rs.txt`) with Tarsee's arguments and ran to the end
[cap: real/real-11-smaller-questions.json `turnsWithACutDownEnvironment`]; and in the other direction the Windows
stub is a Rust program reading `std::env::args_os()`, and what it recorded is what the SDK passed. Checked again
with a launcher of its own (`scripts/checked-launch.rs.txt`, rustc 1.95, Windows) [chk: checked-07-rust-command.json]:

- Tarsee's 113 arguments plus 18 awkward ones (`a"b`, `c\`, `d\"e`, a tab, a raw line break, a trailing
  backslash, `%PATH%`, `^&|<>()!`, non-ASCII, `\\server\share\`) arrived at a Rust program's `args_os()` identical
  [`argsRoundTrip`].
- `env_clear()` and nothing else gives the child no variable at all; with two given it has exactly those two, a
  lower-case `path` included [`envClearNoVariables`, `envClearTwoVariables`].
- The `CREATE_NO_WINDOW` creation flag (`0x0800_0000`) works with three pipes: the real program ran a turn to the
  end started that way, and a command it ran (PowerShell) still worked [`realProgram.fiveNamesAndSystemRoot_noWindowFlag`,
  `realProgram.stopWithACommandRunning`]. Use it: the SDK leaves `windowsHide` off, and a Rust server run as a
  service has no console for the child to share.
- What `Command::spawn()` returns when it cannot start the program (Windows): for a program that is not there,
  kind `NotFound`, `The system cannot find the file specified. (os error 2)`; for a command line past Windows'
  limit, kind `InvalidFilename`, `The filename or extension is too long. (os error 206)` (1.7)
  [`programMissing`, `commandLineTooLong`]. Node's words for the same two are `spawn <path> ENOENT` and
  `spawn ENAMETOOLONG` (6).

### 1.2 Which program

**What the SDK picks** [src: the SDK file, `CodexExec` constructor, `findCodexPath`, `resolveNativePackage`]:

1. `codexPathOverride` when given. Then nothing is added to PATH (`pathDirs = []`).
2. Otherwise the binary the `@openai/codex` npm package installed:
   - the target triple from `process.platform` and `process.arch`: `x86_64-unknown-linux-musl`,
     `aarch64-unknown-linux-musl` (also for `android`), `x86_64-apple-darwin`, `aarch64-apple-darwin`,
     `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`; anything else throws
     `Unsupported platform: <platform> (<arch>)`
   - the platform package: `@openai/codex-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64`,
     `-win32-x64`, `-win32-arm64`, resolved from `@openai/codex`'s own location
   - `<platform package>/vendor/<triple>/bin/codex` (`codex.exe` on Windows) when that file and
     `vendor/<triple>/codex-package.json` both exist; PATH then gets `vendor/<triple>/codex-path` in front, if
     that folder exists [cap: sdk/sdk-06-pinned-binary-package-layout.json, posix/posix-08-pinned-binary.json]
   - else `vendor/<triple>/codex/codex(.exe)`, with `vendor/<triple>/path` in front of PATH
     [cap: sdk/sdk-07-pinned-binary-legacy-layout.json]
   - else `Unable to locate Codex CLI binaries for <triple>. Ensure @openai/codex is installed with optional
     dependencies.` (or, when the packages themselves are missing, the same without `for <triple>`)

   0.167.0 ships the first layout: `bin/codex.exe`, `codex-package.json`, `codex-path/rg.exe`,
   `codex-resources/`.

**What Tarsee passes** [src: `providers/codex.js`, `codexOverride`]: `TARSEE_CODEX_BIN` from the server's
environment when it is set and not blank, as `codexPathOverride`; otherwise nothing, so the SDK's pinned binary.
Before that it refuses, with `CredentialError needs-setup`:
- on Windows, a path ending in `.cmd` or `.bat` (any case): "TARSEE_CODEX_BIN names <file>, a launcher script. On
  Windows it must name the Codex program itself (codex.exe), or be left unset to use the one Tarsee installs."
- a path that is not a file: "TARSEE_CODEX_BIN names <path>, and there's no program there. Point it at the codex
  program, or leave it unset to use the one Tarsee installs."

**What the Rust version should use.** `docs/rust-port/STATUS.md` ruling 10 already orders the lookup: an explicit
path, `TARSEE_CODEX_PATH`, `TARSEE_CODEX_BIN`, then `codex` on the PATH. Three things follow from what was
observed, and the engine must handle each:

1. **Windows: a `codex` that npm put on the PATH is `codex.cmd`, and a turn cannot go through it.** npm's bin
   folder gets three launchers, `codex` (a shell script), `codex.cmd` and `codex.ps1`, not the program (seen in
   the Node checkout's `node_modules/.bin`; `codex.cmd` ends `"%_prog%" "%dp0%\..\@openai\codex\bin\codex.js" %*`).
   `ai/codex_cli.rs codex_on_path` looks `codex` up with PATHEXT, so on such a machine it returns `codex.cmd`.
   Arguments passed through a `.cmd` (started as `ai/codex-cli.js spawnCodex()` starts one, `cmd.exe /d /s /c`)
   arrive unchanged
   for the sign-in's and the model list's short arguments, but a turn's do not: a string holding `&`, `|`, `<` or
   `>` is cut and the rest run as commands, and 24,000 characters in one argument (what Tarsee allows the
   instructions on Windows) fails with "The command line is too long." [cap: other/other-07-windows-cmd-launcher.json].
   So for a turn, when the lookup ends on a `.cmd`, `.bat` or `.ps1`, either refuse it in plain words as the Node
   engine did, or find the program behind the launcher: the launcher runs `<bin folder>/../@openai/codex/bin/codex.js`
   (`node_modules/@openai/codex/bin/codex.js` under npm's folder), whose own lookup is `<platform
   package>/vendor/<triple>/bin/codex.exe`, the platform package being resolved from `@openai/codex` (nested in its
   `node_modules`, or hoisted next to it) [src: `node_modules/@openai/codex/bin/codex.js`, `findCodexExecutable`].
2. **Linux and macOS: `codex` on the PATH from npm is that Node script, not the program.** What it does before
   the program runs [src: same file, read, not run: NOT CONFIRMED by capture]: it copies its environment and adds
   `CODEX_MANAGED_PACKAGE_ROOT=<the package's folder>` and one of `CODEX_MANAGED_BY_NPM=1`, `_BY_BUN`, `_BY_PNPM`,
   `_BY_VITE_PLUS` (removing the other three); then, where Node has `process.execve` and the system is not
   Windows, it replaces itself with the program (same pid, so signals reach the program); otherwise it starts the
   program as a child with inherited streams, forwards SIGINT, SIGTERM and SIGHUP to it, and exits with its code.
   It needs `node` on the PATH of the environment the turn is given.
3. **ripgrep.** The SDK puts the package's `codex-path` folder (it holds `rg`) first on PATH, but only for its own
   pinned binary. The program does not need it: started without that folder on PATH, its shell still found
   `rg` [cap: real/real-11-smaller-questions.json `ripgrep_withoutCodexPathOnPath`]. That was the program inside
   the npm package's layout; for a `codex` binary installed some other way it is NOT CONFIRMED. The Rust engine
   need not touch PATH.

### 1.3 The argument list

In this order, always [src: the SDK file, `CodexExec.run`; cap: sdk/sdk-02-every-option.json,
sdk/sdk-03-every-option-resumed.json for every row, turns/*.json for the rows Tarsee uses]. "Tarsee" says what
the Node engine passes; rows marked "never" exist in the SDK and are listed so they can be left out on purpose.

| # | Arguments | Emitted when | SDK option | Tarsee |
|---|---|---|---|---|
| 1 | `exec` | always | | always |
| 2 | `--experimental-json` | always | | always |
| 3 | `--config` `<key>=<value>`, one pair per leaf | `config` given | constructor `config` (1.4) | always (1.5) |
| 4 | `--config` `<raw>`, one pair per entry | `configOverrides` given | constructor `configOverrides` | never |
| 5 | `--config` `openai_base_url="<url>"` | `baseUrl` not empty | constructor `baseUrl` | never (the address goes in `config`) |
| 6 | `--model` `<model>` | `model` not empty | thread `model` | when a model is named (1.5) |
| 7 | `--thread-source` `<source>` | `threadSource` given and a new thread | thread `threadSource` | never |
| 8 | `--sandbox` `<mode>` | `sandboxMode` not empty | thread `sandboxMode` | always `danger-full-access` |
| 9 | `--cd` `<folder>` | `workingDirectory` not empty | thread `workingDirectory` | always, the workspace |
| 10 | `--add-dir` `<folder>`, one pair per folder | list not empty | thread `additionalDirectories` | Tarsee's bundled skills folder, when it exists |
| 11 | `--skip-git-repo-check` | `skipGitRepoCheck` true | thread `skipGitRepoCheck` | always |
| 12 | `--output-schema` `<file>` | `outputSchema` given | turn `outputSchema` | never |
| 13 | `--cyber-access-program` `<program>` | given | turn `cyberAccessProgram` | never |
| 14 | `--config` `model_reasoning_effort="<effort>"` | `modelReasoningEffort` not empty | thread `modelReasoningEffort` | when an effort is sent (1.5) |
| 15 | `--config` `sandbox_workspace_write.network_access=<true or false>` | `networkAccessEnabled` given | thread `networkAccessEnabled` | always `true` |
| 16 | `--config` `web_search="<mode>"` | `webSearchMode` not empty; else `"live"` for `webSearchEnabled` true, `"disabled"` for false | thread `webSearchMode`, `webSearchEnabled` | always `"disabled"` |
| 17 | `--config` `approval_policy="<policy>"` | `approvalPolicy` not empty | thread `approvalPolicy` | always `"never"` |
| 18 | `resume` `<thread id>` | resuming | `resumeThread(id)` | when resuming |
| 19 | `--image` `<file>`, one pair per picture | pictures | input items `local_image` | when the turn has pictures (2) |

Notes that matter:

- Rows 14, 16 and 17 put the value between plain double quotes with no escaping (`model_reasoning_effort="${effort}"`)
  [src]. The values are fixed words, so this never shows.
- `resume <id>` comes after every option and before `--image` [cap: turns/08-openrouter-resume-pictures.json]. The
  real program accepts `--sandbox`, `--cd` and `--add-dir` in front of `resume` although `codex exec resume
  --help` does not list them (they are options of `exec`), and accepts `--image` after it
  [cap: real/real-02-resumed-thread.json, real/real-09-pictures.json].
- `--image` must stay last. `codex exec --help` gives it as `-i, --image <FILE>...`: it takes every following
  word that is not an option as another picture, so a `resume` after it would be read as a file name. After
  `resume <id>` the option belongs to `exec resume`, whose help gives `-i, --image <FILE>` (one value each)
  [chk: checked-06-real-program.json `help`]. Both forms were run with a path that has a space in it
  [chk: same file, `resumedWithPicture`].
- `resume <id>` with an id that is not a UUID is not refused: `codex exec resume --help` says the argument is a
  "Conversation/session id (UUID) or thread name", and with `resume not-a-uuid` the program, about 9 s later,
  started a new thread and ran the turn (exit 0, a new `thread_id`) [chk: same file, `resumeNotAUuid`]. So a
  damaged stored id does not fail; it shows as a `thread.started` whose `thread_id` is not the one asked for. A
  well-formed UUID with no rollout is refused (6).
- `--experimental-json` is not in `codex exec --help` (which lists `--json`). The program accepts it, and with
  `--json` in its place printed events of the same shapes [cap: real/real-11-smaller-questions.json
  `jsonInsteadOfExperimentalJson`; chk: checked-06-real-program.json `jsonInsteadOfExperimentalJson`]. Use
  `--experimental-json`, as the SDK does.
- Every option of rows 3 to 19 was looked up in the real program's own help
  (`codex exec --help`, `codex exec resume --help`) [chk: same file, `help`]: `-c, --config <key=value>`,
  `-m, --model <MODEL>`, `--thread-source <SOURCE>`, `-s, --sandbox <SANDBOX_MODE>`, `-C, --cd <DIR>`,
  `--add-dir <DIR>`, `--skip-git-repo-check`, `--output-schema <FILE>`, `--cyber-access-program <PROGRAM>`
  (`standard`, `daybreak_blue`, `daybreak_red`), `-i, --image`, and the `resume` subcommand
  (`codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`) are all there; `--experimental-json` is the only one
  that is not.
- The possible values, from `codex exec --help` and the program's own refusals [cap: real/real-07-refused-arguments.json]:
  `--sandbox`: `read-only`, `workspace-write`, `danger-full-access`. `approval_policy`: `untrusted`, `on-failure`,
  `on-request`, `granular`, `never`. `model_reasoning_summary`: `auto`, `concise`, `detailed`, `none`.
  `forced_login_method`: `chatgpt`, `api`. Tarsee uses one sandbox mode only, `danger-full-access`; the other two
  were captured through the SDK to show the flag [cap: sdk/sdk-02-every-option.json `workspace-write`,
  sdk/sdk-03-every-option-resumed.json `read-only`].

The shortest command line the SDK produces is `exec --experimental-json` [cap: sdk/sdk-04-no-options.json].

A complete new-thread command line of Tarsee's (OpenRouter, 113 arguments, shown one option per line;
turns/07-openrouter-new-thread.json has it as the array it is):

```
exec
--experimental-json
--config developer_instructions="PREAMBLE ...\n\n## Workspace instructions (CLAUDE.md)\n\n...\n\nYou are Tarsee (capture run)."
--config project_doc_max_bytes=0
--config project_root_markers=[]
--config history.persistence="none"
--config cli_auth_credentials_store="file"
--config check_for_update_on_startup=false
--config model_reasoning_summary="none"
--config tool_output_token_limit=3000
--config shell_environment_policy.inherit="all"
--config shell_environment_policy.ignore_default_excludes=true
--config shell_environment_policy.filters.CODEX_API_KEY="exclude"
--config shell_environment_policy.filters.CODEX_ACCESS_TOKEN="exclude"
--config shell_environment_policy.filters.TARSEE_MCP_TOKEN="exclude"
--config shell_environment_policy.filters.TARSEE_PROVIDER_KEY="exclude"
--config shell_environment_policy.filters.TARSEE_CHATGPT_ACCESS_TOKEN="exclude"
--config mcp_servers.tarsee.url="http://127.0.0.1:45123/mcp"
--config mcp_servers.tarsee.bearer_token_env_var="TARSEE_MCP_TOKEN"
--config mcp_servers.tarsee.default_tools_approval_mode="approve"
--config mcp_servers.tarsee.required=true
--config mcp_servers.tarsee.startup_timeout_sec=20
--config mcp_servers.tarsee.tool_timeout_sec=300
--config features.apps=false
--config features.plugins=false
--config features.remote_plugin=false
--config features.plugin_discovery_prefetch=false
--config features.multi_agent=false
--config features.goals=false
--config features.computer_use=false
--config features.browser_use=false
--config features.browser_use_external=false
--config features.in_app_browser=false
--config features.image_generation=false
--config features.tool_suggest=false
--config features.skill_mcp_dependency_install=false
--config features.memories=false
--config features.hooks=false
--config features.unbounded_connection_retries=false
--config model_auto_compact_token_limit=170000
--config model_provider="tarsee_openrouter"
--config model_providers.tarsee_openrouter.name="OpenRouter"
--config model_providers.tarsee_openrouter.base_url="https://openrouter.ai/api/v1"
--config model_providers.tarsee_openrouter.env_key="TARSEE_PROVIDER_KEY"
--config model_providers.tarsee_openrouter.wire_api="responses"
--config model_providers.tarsee_openrouter.http_headers.X-OpenRouter-Title="My Tarsee"
--config model_providers.tarsee_openrouter.http_headers.HTTP-Referer="https://example.test/tarsee"
--config forced_login_method="api"
--config model_context_window=200000
--model openai/gpt-5.5
--sandbox danger-full-access
--cd <WORKSPACE>
--add-dir <TARSEE_SKILLS_DIR>
--skip-git-repo-check
--config model_reasoning_effort="medium"
--config sandbox_workspace_write.network_access=true
--config web_search="disabled"
--config approval_policy="never"
```

A resumed one with a picture ends (turns/08-openrouter-resume-pictures.json):

```
...
--config approval_policy="never"
resume 01a1c000-0000-7000-8000-0000000000aa
--image <TMP>\tarsee-codex\tarsee-images-<RANDOM>\image-1.png
```

### 1.4 How a `config` object becomes `--config` arguments

[src: the SDK file, `serializeConfigOverrides`, `flattenConfigOverrides`, `toTomlValue`, `formatTomlKey`; every
rule below is in cap: sdk/sdk-01-config-flattening.json]

**Flattening.** Walk the object in insertion order, depth first.

- A value that is a plain object (a table) is not written itself: each of its entries is written with the key
  `<parent>.<child>`. So one argument pair per leaf.
- An empty table below the top level is written as `<path>={}`. An empty top-level object writes nothing.
- An entry whose value is `undefined` is skipped. `null` throws `Codex config override at <path> cannot be null`.
  An empty key throws `Codex config override keys must be non-empty strings` (checked before the value, so even
  an empty key with an `undefined` value throws). A value that is none of these kinds throws `Unsupported Codex
  config override value at <path>: <its typeof>`, and a `config` that is not a plain object throws `Codex config
  overrides must be a plain object`. All of these are thrown before any process is started
  [chk: checked-01-sdk-arguments.json `refusedByTheSdk`].
- **Key segments on the dotted path are never quoted or escaped**, whatever they hold: the key `HTTP-Referer`
  gives `...http_headers.HTTP-Referer=...`, and a key with a space or a dot in it would be written raw (a dot then
  reads as a deeper table). Every key Tarsee writes is letters, digits, `_` and `-`.
- Anything that is not a table (a string, number, boolean or array) is a leaf: `<path>=<value>`, the value rendered
  as below. There is no space around `=`.

**Rendering a value.**

| Kind | Written as | Examples (the whole argument) |
|---|---|---|
| string | `JSON.stringify(value)`: double quotes; `"` and `\` escaped with a backslash; `\b \f \n \r \t` as those two-character escapes; every other character below U+0020 as `\u00XX` (lowercase hex); everything else as it is, non-ASCII included | `string_plain="hello"`; `string_quotes_backslash="say \"hi\" to C:\\Users\\me"`; `string_newline_tab="line one\nline two\ttabbed"`; `string_unicode="café ☃ 😀"`; `string_control="bell\u0007 esc\u001b del<U+007F raw>"`; `string_empty=""` |
| number | JavaScript's `String(n)`; not finite throws `... must be a finite number` | `integer=42`, `negative=-7`, `float=0.85`, `exponent_large=1e+21`, `exponent_small=1e-7` |
| boolean | `true` or `false` | `bool_true=true` |
| array | `[` items joined with `, ` (comma, space) `]`, each item rendered by these same rules; empty is `[]` | `array_strings=["a", "b c", "d\"e"]`; `array_mixed_nested=[1, "two", [3, 4], true]`; `array_empty=[]` |
| table inside an array | an inline table: `{` entries joined with `, ` `}`, each entry `<key> = <value>` (spaces around this `=`); the key bare when it matches `^[A-Za-z0-9_-]+$`, else `JSON.stringify(key)`; `undefined` entries skipped; nested tables inline too | `array_of_tables=[{name = "first", n = 1}, {"key with space" = "v", nested = {deep = true}}]` |

In Rust: `serde_json::to_string(&str)` gives the same text as `JSON.stringify` for a string (Rust strings hold no
lone surrogates; Tarsee's instructions have them stripped before this point, `codex-options.js capInstructions`).
Every number Tarsee passes is an integer; write it with no decimal point.

**What the program does with the value** [`codex exec --help`: "The value portion is parsed as TOML. If it fails
to parse as TOML, the raw string is used as a literal"]. Observed [cap: real/real-07-refused-arguments.json]:

- A later `--config` for the same key wins over an earlier one (the SDK's README says the same of its own
  ordering). So rows 14 to 17 of 1.3 win over anything the same keys had in `config`. Seen a second time with
  another key: `model_reasoning_effort="low"` among the first pairs and `"high"` in row 14's place sent the model
  `high` [chk: checked-06-real-program.json `refusedArguments.laterConfigWins_effort`].
- An option beats `--config` for the same setting wherever each stands: with `--model test-model` and, after
  it, `--config model="from-late-config"`, the model asked was `test-model` [chk: same file,
  `refusedArguments.laterConfigWins_model`]. One observation.
- `JSON.stringify` leaves U+007F as it is, which the TOML specification does not allow in a basic string. The
  program's parser takes it as part of the string anyway. It leaves U+0085, U+2028 and U+2029 as they are too
  [chk: checked-01-sdk-arguments.json `everyOption`]; those were not given to the real program.
- A key the program does not know is not an error: the turn runs, and before `turn.started` there are two
  `error` items, each with the message (one line break in it)
  ``Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n  session-flags: `not_a_real_setting` is ignored.``
  [chk: checked-06-real-program.json `refusedArguments.unknownKey`].
- A value of the wrong type stops the program before anything else (6). A word the setting does not take does so
  for the settings that are a fixed list in the program (`approval_policy`, `--sandbox`; 6), but **not for every
  setting**: `model_reasoning_effort="extreme"` was accepted, the turn ran, and the request to the model carried
  `"reasoning": {"effort": "extreme"}` [chk: same file, `refusedArguments.badEffortWord`]. Tarsee never sends
  such a word (1.5).
- A string value written without its quotes still arrives: `model_reasoning_summary=none` ran as `"none"` does
  (the help's "the raw string is used as a literal") [chk: same file, `refusedArguments.unquotedStringValue`].
  Always write the quotes, as the SDK does: unquoted, `true`, `1` or `[]` would be read as TOML.

### 1.5 What Tarsee passes

All of this is built by `providers/codex-options.js buildCodexOptions()` (already ported as
`ai/providers/codex_options.rs`); it is repeated here because the order of the keys is the order of the arguments.

**The constructor**: `new Codex({ env, config, apiKey?, codexPathOverride? })`
[src: `providers/codex.js`, line `const codex = new Codex({ env: o.env, config: o.config, ...(o.apiKey ? { apiKey:
o.apiKey } : {}), ...(codexPath ? { codexPathOverride: codexPath } : {}) })`]. `baseUrl` and `configOverrides` are
never passed.

**`config`, in insertion order** (so in argument order):

1. `developer_instructions` (string: the preamble, the workspace's CLAUDE.md, the stable system prompt, capped at
   24 KiB on Windows and 96 KiB elsewhere, `instructionsLimit`; how the three are put together is 12, step 4,
   and how the cap cuts is `codex-options.js capInstructions`, already ported). It is always there, as `""` when
   there is nothing to say [chk: checked-02-tarsee-options.json `chatgptEffortNotOffered`]
2. `project_doc_max_bytes` = `0`
3. `project_root_markers` = `[]`
4. `history.persistence` = `"none"`
5. `cli_auth_credentials_store` = `"file"`
6. `check_for_update_on_startup` = `false`
7. `model_reasoning_summary` = `"concise"` when the turn asks for thinking summaries, else `"none"`
8. `tool_output_token_limit` = `3000`
9. `shell_environment_policy.inherit` = `"all"`
10. `shell_environment_policy.ignore_default_excludes` = `true`
11. `shell_environment_policy.filters.<NAME>` = `"exclude"` for `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`,
    `TARSEE_MCP_TOKEN`, `TARSEE_PROVIDER_KEY`, `TARSEE_CHATGPT_ACCESS_TOKEN`, in that order
12. `mcp_servers.tarsee.url`, `.bearer_token_env_var` = `"TARSEE_MCP_TOKEN"`, `.default_tools_approval_mode` =
    `"approve"`, `.required` = `true`, `.startup_timeout_sec` = `20`, `.tool_timeout_sec` = `300`, in that order
13. `features.<name>` = `false` for `apps`, `plugins`, `remote_plugin`, `plugin_discovery_prefetch`,
    `multi_agent`, `goals`, `computer_use`, `browser_use`, `browser_use_external`, `in_app_browser`,
    `image_generation`, `tool_suggest`, `skill_mcp_dependency_install`, `memories`, `hooks`,
    `unbounded_connection_retries`, in that order
14. `model_auto_compact_token_limit`, only when the model's context is known:
    `min(compact, floor(context × 0.85))`, where
    - `context` is the turn's `contextTokens` when that is a number above 0 (rounded), else the provider entry's
      `defaultContext`, else unknown (the key is then left out). The engine passes
      `provider-registry.js contextTokensFor(provider, model, settings)`: the model's own window from the
      catalog, else the entry's `defaultContext` (in this version `chatgpt` 200,000, `openai` 400,000,
      `openrouter` 200,000, `deepseek` 1,000,000, `local` 128,000)
    - `compact` is `context-limits.js compactWindowTokens(TARSEE_COMPACT_WINDOW)` from the server's environment:
      unset, blank, not a number or not above 0 gives 180,000; a number, or a number followed by `k` (thousands),
      is clamped to 100,000 … 1,000,000 and rounded; `off` gives `null`, and `min(null, n)` is `0` in JavaScript,
      so the argument is then `model_auto_compact_token_limit=0` (10)

    Seen: `170000` (context 200,000), `180000` (contexts 272,000 and 400,000), `108800` (context 128,000),
    `0` (`off`) [chk: checked-02-tarsee-options.json]
15. then by provider:

| Provider | Keys, in order | Fixture |
|---|---|---|
| `chatgpt` | `forced_login_method="chatgpt"` (in tests only, then `chatgpt_base_url` and `openai_base_url`) | turns/01, 02, 03 |
| `openai` | `forced_login_method="api"`, `openai_base_url="https://api.openai.com/v1"` | turns/04, 05, 06, 12, 13 |
| `openrouter` | `model_provider="tarsee_openrouter"`; `model_providers.tarsee_openrouter.name="OpenRouter"`, `.base_url="https://openrouter.ai/api/v1"`, `.env_key="TARSEE_PROVIDER_KEY"`, `.wire_api="responses"`, `.http_headers.X-OpenRouter-Title="<title, default Tarsee>"`, `.http_headers.HTTP-Referer="<referer>"` only when one is set; `forced_login_method="api"`; `model_context_window=<n>` | turns/07, 08 |
| `deepseek` | `model_provider="tarsee_deepseek"`; `.name="DeepSeek"`, `.base_url="https://api.deepseek.com"`, `.env_key`, `.wire_api`; `forced_login_method="api"`; `model_context_window=<n>` | turns/09 |
| `local` | `model_provider="tarsee_local"`; `.name="Local AI"`, `.base_url="http://127.0.0.1:<port>/t/<turn id>/v1"` (the turn's bridge, never the owner's address), `.env_key`, `.wire_api`, `.stream_max_retries=1`; `forced_login_method="api"`; `model_context_window=<n>` | turns/10, 11 |

What the table leaves to be said [src: `codex-options.js`, `engine-env.js`; chk: checked-02-tarsee-options.json]:

- `model_context_window` is written only when the context is known (item 14's `context`), and is that number.
- `.env_key` is written only when the turn's environment has `TARSEE_PROVIDER_KEY` (1.6): always for
  `openrouter` and `deepseek`, whose key is required, and for `local`, whose key is the bridge's token.
- `X-OpenRouter-Title` is the setting `ai.openrouter.appTitle` with every run of CR, LF and NUL made one space
  and the ends trimmed; when that leaves nothing, the provider entry's `defaultAppTitle`, else `Tarsee`.
  `HTTP-Referer` is `ai.openrouter.referer` cleaned the same way, and is left out when that leaves nothing. Seen:
  a title of `My "Tarsee"`, CR, LF, `App` arrived as `...X-OpenRouter-Title="My \"Tarsee\" App"`.
- Every key (`TARSEE_PROVIDER_KEY`, and the `openai` key that becomes `CODEX_API_KEY`) is trimmed, has one pair
  of surrounding quotes (`"…"` or `'…'`) taken off, and is trimmed again; one that is then empty refuses the turn
  with `needs-key`, one with a CR, LF or NUL in it, or one that matches the provider entry's `wrongSlot`, with
  `bad-key` (`engine-env.js requireKey`). Seen: `  "sk-or-…"  ` arrived as `sk-or-…`.
- The bundled skills folder is `src/skills` of the Node checkout (`../../skills` from `providers/codex.js`).

**Thread options**, always `sandboxMode: "danger-full-access"`, `approvalPolicy: "never"`, `workingDirectory: <the
workspace>`, `skipGitRepoCheck: true`, `networkAccessEnabled: true`, `webSearchMode: "disabled"`; plus
`additionalDirectories: [<Tarsee's skills folder>]` when that folder exists; plus:

- `model`: the chosen model (trimmed), but nothing for no model or the word `default` in any case
  [cap: turns/12]; and for `chatgpt` only a model the signed-in account's live list has (an entry whose `id` is
  it), so nothing when that list is unknown or empty [cap: turns/01] and the model when it lists it
  [cap: turns/02, 03]
- `modelReasoningEffort`: the effort trimmed and made lower case, when that is one of `low`, `medium`, `high`,
  `xhigh`, `max`, else nothing [cap: turns/12 `extreme` dropped; chk: `HIGH` sent as `high`]; for `chatgpt`,
  nothing when the named model's entry in the account's list has a non-empty `efforts` and this is not one of
  them [cap: turns/03]. When no model is named (the list is unknown) the effort is still sent: there is no entry
  to check it against [chk: checked-02-tarsee-options.json `chatgptListUnknown`: no `--model`,
  `model_reasoning_effort="high"`]

**The call**: `codex.startThread(threadOptions)` or `codex.resumeThread(<raw thread id>, threadOptions)`, then
`thread.runStreamed(input, { signal })`. The raw id is the part of the stored session handle after its `:`
(`openrouter/cx/openai:<id>`), and only when the handle's provider, home and maker are this turn's
(`ai/session-handle.js sessionFor`); otherwise the turn starts a new thread
[chk: checked-08-node-engine.json `e6a` resumes, `e6c` (another provider's handle) and `e6d` (another maker's)
start new threads]. A thread whose instructions changed, or whose rollout grew past the cap, is not resumed
either, and that one is told to the turn layer (12, step 8). The `signal` is the engine's own, not the caller's
(12, step 13). A new `Codex` and a new thread object are made for every turn; the SDK's thread object is never
used twice (used twice, its second turn resumes by itself [chk: checked-01-sdk-arguments.json
`twoTurnsOnOneThreadObject`]).

**"Without the MCP server" is not a turn.** `buildCodexOptions` throws `needs-mcp-token` when there is no grant,
and the engine refuses before starting anything; the same for a missing key. What the engine yields then, with the
program never started: [cap: turns/14-refused-no-key.json, turns/15-refused-no-tools-grant.json].

### 1.6 The environment

**What the SDK does** [src: the SDK file, `CodexExec.run`], in this order:

1. If the caller passed `env`: a copy of exactly that object. If not: a copy of the server's whole process
   environment.
2. If `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` is missing or empty: set it to `codex_sdk_ts`.
3. If `apiKey` was given: set `CODEX_API_KEY` to it (replacing one that `env` had)
   [cap: sdk/sdk-02-every-option.json].
4. Only when the SDK resolved its own pinned binary: put its `codex-path` folder first on PATH. On Windows the
   variable used is `Path` if the environment has one, else the last key that is "path" in any case, else `PATH`;
   every other spelling of "path" is deleted; entries equal to the folder, and empty entries, are dropped from
   the old value
   [src: `prependPathDirs`, `pathEnvKey`; cap: sdk/sdk-06 (an `env` with both `PATH` and `Path`: `PATH` is gone,
   `Path` leads with the folder), posix/posix-08 (joined with `:`)]. The Rust engine need not do this (1.2).

Those are all the names the SDK sets or changes: `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, `CODEX_API_KEY`, and PATH.

**Does anything from the server's real environment get through when `env` is passed?**

- Linux: nothing. The child had exactly the passed names plus `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`
  [cap: posix/posix-01-env-option.json].
- Windows: yes, eleven names, and it is Node's doing, not the SDK's. When the passed `env` lacks any of
  `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`,
  `USERPROFILE`, `WINDIR`, Node copies it from the server's own environment into the child. Nothing else is copied
  (`APPDATA`, `LOCALAPPDATA`, `COMSPEC`, `PATHEXT`, `TMP`, `PROGRAMFILES` and the rest are not)
  [cap: sdk/sdk-19-windows-env-fill-in.json; chk: checked-01-sdk-arguments.json `emptyEnv`: with `env: {}` the
  child had exactly those eleven and `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`]. A name counts as present in any
  case: with `path`, `systemroot` and `Temp` passed, the child had those three as spelled and no second copy
  [chk: same file, `lowercaseNames`]. The mechanism is libuv's, the library Node starts processes with: its
  `src/win/process.c` has the list (`required_vars`, those eleven names) and the reason ("winsock will fail to
  initialize if SYSTEMROOT is not defined; some APIs make reference to TEMP") [read on libuv's `v1.x` branch;
  the copy inside this Node was not read]. Rust's `Command::env_clear()` copies nothing: a program started that
  way with no variables saw none [chk: checked-07-rust-command.json `envClearNoVariables`]. In production it
  makes no difference, because Tarsee's `env` is the server's whole environment minus
  credentials (below), so all eleven are already in it. A test that passes a cut-down environment on Windows will
  see the difference: **without `SYSTEMROOT` the real program cannot make any network request** (the turn died
  with the MCP failure of 4.4, "error sending request", and the endpoint never saw a request); with `SYSTEMROOT`
  added to `CODEX_HOME`, `TARSEE_MCP_TOKEN`, `TARSEE_PROVIDER_KEY` and `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` a
  text turn ran to the end [cap: real/real-11-smaller-questions.json `turnsWithACutDownEnvironment`; chk:
  checked-07-rust-command.json `realProgram.fiveNamesOnly` (exit 1, no request reached either server) and
  `fiveNamesAndSystemRoot` (exit 0), the same names and `TARSEE_CODEX_TURN`, started by a Rust `Command`]. A turn
  that ran a PowerShell command was started with those, `PATH` (the system's and PowerShell's folders), `TEMP`
  and `USERPROFILE`, and the command ran [chk: same file, `realProgram.stopWithACommandRunning`]; which of the
  three it needed was not narrowed down.

**What Tarsee passes as `env`** [src: `ai/engine-env.js baseEnv`, `finalizeEnv`, `codexEnvFor` (ported as
`ai/engine_env.rs`), `providers/codex-options.js`; cap: turns/*.json `child.envNames`, `envValues`,
`serverEnvNamesNotPassed`; chk: checked-02-tarsee-options.json `openrouterNewThread.environment`]. Built in four
layers; a name is compared in upper case throughout, and a value that is `null` or `undefined` is skipped:

1. The server's environment, minus every name that, in upper case,
   - matches the credential pattern below (`AUTH_ENV_RE`: among others everything starting `ANTHROPIC_` or
     `CODEX_`, and `OPENAI_BASE_URL`, `TARSEE_PROVIDER_KEY`, `TARSEE_CHATGPT_ACCESS_TOKEN`, `TARSEE_MCP_TOKEN`), or
   - is one of Tarsee's own secrets: `ENCRYPTION_KEY`, `SETUP_PASSWORD`, `TARSEE_API_TOKEN`, or
   - is one of the server's copies of the provider keys: `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
     `DEEPSEEK_API_KEY`, `TARSEE_LOCAL_AI_KEY`, or
   - is the provider entry's own `envKey`.
2. Over that, the vault's keys (`agent-env.js agentVaultEnv`).
3. From the result, every name matching the credential pattern is removed again. Only that pattern: so a vault
   key called `OPENAI_API_KEY` stays (it is how the owner gives scripts a key by name), and one called
   `CODEX_ANYTHING` does not [chk: a server `OPENAI_API_KEY` was not passed, a vault one was; a vault
   `CODEX_FROM_VAULT` was not].
4. Over that, the provider's block (the table below), which always wins; then `TARSEE_CODEX_TURN`.

```
AUTH_ENV_RE = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_SESSION_ACCESS_TOKEN$|CLAUDE_CODE_API_BASE_URL$|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_CUSTOM_OAUTH_URL$|CLAUDE_LOCAL_OAUTH_|CLAUDE_TRUSTED_DEVICE_TOKEN$|CLAUDE_SESSION_INGRESS_TOKEN_FILE$|CLAUDE_BG_AUTH_SNAPSHOT_PATH$|CLAUDE_[A-Z0-9_]*_FILE_DESCRIPTOR$|CLAUDE_BG_(?:CLAIM|PTY|RV)_AUTH$|CLAUDE_BG_SOCKET_TOKENS_PATH$|CLAUDE_BRIDGE_(?:BASE_URL|OAUTH_TOKEN|SESSION_INGRESS_URL)$|CLAUDE_REMOTE_TOOLS_BRIDGE_URL$|CLAUDE_CODE_ARTIFACTS_API_(?:BASE_URL|TOKEN)$|CLAUDE_CODE_ARTIFACT_(?:ASSET|LIVE|SYNC|VIEWER)_BASE_URL$|CLAUDE_CODE_MEMORY_API_|CLAUDE_CODE_GATEWAY_TOKEN$|CLAUDE_CODE_GB_BASE_URL$|CLAUDE_CODE_SESSIONS_OAUTH_TOKEN$|CLAUDE_CODE_(?:MCP_SERVE_AUTH|MESSAGING|SLACK_TAG|HFI_BEARER)_TOKEN$|CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID$|CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST$|CLAUDE_CODE_HOST_AUTH_|CLAUDE_CODE_HOST_CREDS_FILE$|CLAUDE_CODE_MODEL_CATALOG|CLAUDE_CODE_CLIENT_DATA_URL$|CLAUDE_CODE_REMOTE_SDK_URL$|CLAUDE_RUNNER_API_BASE_URL$|CLAUDE_CODE_SUBAGENT_MODEL$|CLAUDE_CONFIG_DIR$|CODEX_|OPENAI_BASE_URL$|AWS_BEARER_TOKEN_BEDROCK$|TARSEE_PROVIDER_KEY$|TARSEE_CHATGPT_ACCESS_TOKEN$|TARSEE_MCP_TOKEN$)/
```

The provider's block:

| Name | Value | Providers |
|---|---|---|
| `CODEX_HOME` | `<state>/.codex-home` for `chatgpt`, `<state>/.codex-home-keys` for every other | all |
| `TARSEE_MCP_TOKEN` | the turn's token for Tarsee's tools | all |
| `TARSEE_PROVIDER_KEY` | the provider's key; for `local` the bridge's per-turn token | `openrouter`, `deepseek`, `local` |
| `TARSEE_CODEX_TURN` | 24 hex characters, new for each turn (the mark Stop looks for, 5.3) | all |

and the SDK then adds `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_sdk_ts` (always: Tarsee strips every `CODEX_*`
name first, so it is never already there) and, for `openai`, `CODEX_API_KEY=<the key>`. No key or token is ever on
the command line [cap: turns/*.json]. The keys are cleaned as 1.5 says. The tools' token is trimmed; one that is
empty, or has a CR, LF or NUL in it, refuses the turn with `needs-mcp-token` ("This turn has no token for
Tarsee's tools."). For `openai` the key is required here too, though the block carries none: a missing one
refuses the turn before anything starts.

`CODEX_INTERNAL_ORIGINATOR_OVERRIDE` is not decoration. With it the program's requests carry `originator:
codex_sdk_ts` and `user-agent: codex_sdk_ts/0.167.0 (...)`, and the thread's rollout records that originator;
without it both read `codex_exec` [cap: real/real-11-smaller-questions.json `whatTheOriginatorVariableChanges`].
Keep the value `codex_sdk_ts` so a Rust turn looks to the provider as a Node turn did.

### 1.7 Size limits

Tarsee caps `developer_instructions` at 24 KiB on Windows and 96 KiB elsewhere before it becomes an argument
[src: `codex-options.js instructionsLimit`: "128 KiB per argument on Linux, 32K characters in all on Windows"].
The whole command line must fit the system's limit; nothing in the SDK checks it. The prompt is not on the
command line.

**The cap is on the text, and the limit is on the argument after escaping**, so the cap does not guarantee a
start. `JSON.stringify` writes each `"` and `\` as two characters, each line break as two, and each other control
character as six; on Windows the command line then doubles the backslash in front of each quote again. What was
seen at the cap [chk: checked-02-tarsee-options.json `instructionCaps`, checked-05-sdk-stdin.json
`linux.instructionsAtTheLinuxCap`]:

| System | Instructions after the cap | The argument | Result |
|---|---|---|---|
| Windows | 24,576 bytes of plain letters | 24,601 characters; the whole command line about 26,700 | started |
| Windows | 24,574 bytes, one line break in every five characters | 29,502 characters; the whole command line about 31,600 | started (Windows' limit is 32,767) |
| Windows | 24,576 quotes | about 49,200 characters before Windows' own quoting | **not started**: Node throws `spawn ENAMETOOLONG` (code `ENAMETOOLONG`) from the SDK call |
| Linux | 98,304 bytes of plain letters | 98,331 bytes | started |
| Linux | 98,299 bytes, one line break in every five characters | 117,974 bytes | started |
| Linux | 98,304 bytes, every third character a quote | 131,080 bytes | **not started**: `spawn E2BIG` (code `E2BIG`); the limit is 131,072 bytes for one argument with its ending NUL |

A Rust `Command` reports the Windows case as kind `InvalidFilename`, `The filename or extension is too long.
(os error 206)` (1.1); a 32,000-character argument was passed whole. The Node engine does nothing about either
case: the SDK's throw becomes the turn's error (12, step 16; the classifier makes it `unknown`). A Rust engine can
do better at no cost: measure the argument as it will be written and cut the instructions again when it would not
fit, or refuse in plain words.

## 2. What is written to stdin, and pictures

[src: the SDK file, `normalizeInput`, `CodexExec.run`: `child.stdin.write(args.input); child.stdin.end();`]

- The input is either a string, which is the prompt, or a list of items: the `text` items' texts joined with a
  blank line (`"\n\n"`) are the prompt, and each `local_image` item's `path` becomes one `--image <path>`
  argument, in order [cap: sdk/sdk-02-every-option.json: two texts and a picture give stdin `first part\n\nsecond
  part`].
- The prompt is written to stdin as UTF-8, in one write, and stdin is closed. Nothing is added: no newline, no
  length, no framing. The end of stdin is the end of the prompt [cap: sdk/sdk-20-long-unicode-prompt.json: 300,046
  characters, 300,051 bytes, byte for byte].
- The program reads stdin to its end before it does anything: with stdin written but left open it printed
  `Reading prompt from stdin...` on stderr and nothing on stdout for three seconds, and ran the turn once stdin
  was closed [cap: real/real-11-smaller-questions.json `stdinWrittenButNotClosedFor3s`]. What arrives at the model
  as the user's message is the stdin text unchanged [same file, `whatTheModelReceives`].
- **An empty stdin fails**: exit code 1, stderr `Reading prompt from stdin...` then `No prompt provided via
  stdin.` [same file, `emptyStdin`]. The SDK does not guard against it (it wrote 0 bytes,
  cap: sdk/sdk-04-no-options.json). See 10. **A stdin of white space only fails the same way**: two spaces and
  two line breaks gave the same exit code and the same two lines, and nothing was asked of the MCP server or the
  model [chk: checked-06-real-program.json `stdin.whitespaceOnlyStdin`]. A picture does not change that: empty
  stdin with `--image <a real file>` failed the same way [chk: same file, `stdin.emptyStdinWithPicture`].
- White space at the end of a prompt that has words is kept: three line breaks after the words arrived at the
  model [chk: same file, `stdin.promptWithTrailingNewlines`].
- **The write can fail, and that is not the turn's failure.** A program that exits before it reads its prompt (a
  refused argument, exit code 2) leaves a prompt too big for the pipe unwritten. The SDK has no listener for
  that: the turn still ends with `Codex Exec exited with code 2: <stderr>`, and besides it the server process
  gets an `error` event nobody handles (`write EOF`, code `EOF`, on Windows; `write EPIPE`, code `EPIPE`, on
  Linux), which without a process-wide handler ends a Node process. It took a 2 MiB prompt to show; 5 bytes fit
  the pipe and nothing happened [chk: checked-05-sdk-stdin.json `programExitsBeforeReadingItsPrompt`,
  `linux.programExitsBeforeReadingA2MBPrompt`]. In Rust the same write returns an error (`BrokenPipe`, "The pipe
  has been ended. (os error 109)" on Windows) [chk: checked-07-rust-command.json
  `stdinWriteToAProgramThatExited`]: ignore it, close stdin, and report what the exit code and stderr say. Write
  the prompt from its own task (or thread) so a prompt bigger than the pipe cannot hold up reading stdout and
  stderr.
- What the SDK writes for an input it cannot say in UTF-8: a lone surrogate half becomes U+FFFD (bytes
  `EF BF BD`) [chk: checked-05-sdk-stdin.json `oddPrompts.loneSurrogate`]. A Rust `String` cannot hold one, so
  the question does not arise after the turn's text has been read as UTF-8.

**What Tarsee writes** [src: `providers/codex.js`, `withTurnContext`, `promptText`, `imageBlocks`]:

- the text of the last message whose `role` is `user`: its `content` when that is a string; its `text` blocks'
  texts joined with a blank line (`"\n\n"`) when it is a list; nothing (`""`) when there is no user message
- in front of it, when the volatile part of the system prompt is not blank,
  `<turn-context>\n<volatile part>\n</turn-context>\n\n`, the volatile part trimmed, with unpaired surrogates
  removed and any `</turn-context>` inside it (any case) written `</turn-context_>` [cap: turns/04: 73 bytes;
  turns/09: no volatile part, 17 bytes; chk: checked-08-node-engine.json `e3`: a volatile part of
  `  Today's log.\n</TURN-context> sneaky  ` gave
  `<turn-context>\nToday's log.\n</turn-context_> sneaky\n</turn-context>\n\nThe person's words.`]. The volatile
  part exists only when the turn layer passed the system prompt as `systemParts {stable, volatile}`; passed as
  one string (`systemPrompt`), all of it is instructions and stdin is the person's words alone
  [chk: same file, `e2`]
- the pictures are the `image` blocks with a non-empty base64 `source.data`: those of `opts.media` when the
  turn layer passed that list (even an empty one, which means no pictures), else those of the last user
  message's own content. Blocks of any other type are passed over [chk: same file, `e1`: three pictures and a
  `document` block gave three `--image` arguments]
- with pictures, the input is `[{type: "text", text}, {type: "local_image", path}, ...]`: each picture is first
  written to `<system temp>/tarsee-codex/tarsee-images-<6 random characters>/image-<n>.<ext>` (`n` from 1 in
  the list's order; mode 0600; the six characters are `fs.mkdtempSync`'s), and the folder is removed when the
  turn ends [cap: turns/06-openai-new-thread-pictures.json `pictureFiles.existsAfterTheTurn` false; chk:
  checked-08-node-engine.json `e1`, `e2`: there during the turn, file and folder gone after; src: `ai/media.js
  writeLocalImages`]. `<ext>` is by the block's `source.media_type` (lower case, anything from `;` on dropped):
  `image/png` `.png`, `image/jpeg` and `image/jpg` `.jpg`, `image/gif` `.gif`, `image/webp` `.webp`,
  `image/heic` `.heic`, `image/heif` `.heif`, `image/bmp` `.bmp`, `image/tiff` `.tiff`, `image/avif` `.avif`;
  any other type, or none, `.png`

The program reads each picture file itself and sends it to the model inside the user's message as an
`input_image` part [cap: real/real-09-pictures.json `inputTypes`]. Seen again, with what stands around it
[chk: checked-06-real-program.json `resumedWithPicture.modelInput`]: the user's message has four parts in this
order, an `input_text` ``<image name=[Image #1] path="<the file's path as given>">``, the `input_image` (a
`data:image/png;base64,` address), an `input_text` `</image>`, and an `input_text` with the prompt. **So the
model is shown the temporary file's path.** A picture file that is not there is not an error: the turn runs
(exit 0) and in the picture's place the model gets the text ``Codex could not read the local image at `<path>`:
The system cannot find the file specified. (os error 2)`` (Windows wording) [chk: same file,
`stdin.pictureFileMissing`].

## 3. What the program writes to stdout

### 3.1 Framing

One JSON object per line, each line ended by `\n` (no `\r`), the last line too
[cap: real/real-01-new-thread.json `stdoutEndsWithNewline` true, `stdoutHasCarriageReturns` false]. Nothing else is
written to stdout in this mode.

How the SDK reads it [src: the SDK file, `CodexExec.run`: `readline.createInterface({ input: child.stdout,
crlfDelay: Infinity })`; `Thread.runStreamedInternal`]:

- stdout is split into lines; `\r\n` counts as one line end, and a last line with no line end still counts
  [cap: sdk/sdk-10-stdout-crlf-no-final-newline-unknown.json]. A `\r` alone is a line end for the SDK too:
  `{"type":"b"}\r{"type":"c"}\n` gave two events. U+2028, U+2029 and U+0085 are not line ends: written raw
  inside a string (as the program's JSON writer would leave them) the line stayed whole. A line of 300,000
  characters, and a character whose bytes arrived in two pieces 150 ms apart, came through whole
  [chk: checked-03-sdk-stdout-and-exit.json `stdoutReading`]. The real program never writes a raw `\r` (3.1's
  capture: no carriage return in its stdout; inside strings it is the two characters `\r`), so splitting on `\n`
  alone reads the same stream
- each line is given to `JSON.parse`. **A line that is not JSON, an empty line included, is fatal**: the events
  before it have been handed over, then the SDK throws `Failed to parse item: <the line>`, and on its way out ends
  the program [cap: sdk/sdk-08-stdout-not-json.json, sdk/sdk-09-stdout-blank-line.json,
  sdk/sdk-17-bad-line-ends-the-program.json, posix/posix-06-bad-line.json (SIGTERM)]
- the object is handed to the caller as it is, unknown `type`s and extra fields included [cap: sdk/sdk-10]; two
  things are done on the way: on `thread.started` the thread remembers `thread_id`; on `turn.completed`,
  `usage.cache_write_input_tokens` is set to 0 when the object has none (0.167.0 always sends it:
  cap: real/real-01)
- three things the SDK does with lines the program never writes, which the Rust engine should not copy
  [chk: checked-03-sdk-stdout-and-exit.json `stdoutReading`]: a line that is JSON but not an object is handed
  over as it is when it is a number or a string (Tarsee's mapping then passes over it), and when it is `null`
  the SDK itself fails with `TypeError: Cannot read properties of null (reading 'type')`; a `turn.completed`
  with no `usage` fails with `TypeError: Cannot read properties of undefined (reading
  'cache_write_input_tokens')`; a byte-order mark in front of the first line makes it "not JSON". In Rust: pass
  over a line that parses but is not an object, and read a missing `usage` (or a missing field of it) as zeros,
  which is what Tarsee's own reading of the usage does (`codex-events.js normalizeUsage`)

In Rust: read bytes, split on `\n`, drop one trailing `\r`, decode UTF-8, `serde_json::from_str` into a `Value`
(or an enum with a catch-all). Treat a parse failure as the SDK does: hand over what came before, end the
program, and fail the turn with `Failed to parse item: <the line>` (a blank line gives `Failed to parse item: `
with nothing after the space).

### 3.2 The events

The event types and item shapes, as the SDK's type declarations give them (`dist/index.d.ts`) and as they were
seen. "Seen" names a capture of the real 0.167.0 program; the Node repo's own captures
(`test/fixtures/codex/*.jsonl`, made the same way) are named where this work did not repeat them.

| `type` | Fields | Seen |
|---|---|---|
| `thread.started` | `thread_id` (a UUID, version 7) | always the first line; on a resumed thread it is the same id [cap: real/real-01, real-02] |
| `turn.started` | none | real/real-01 |
| `item.started` | `item` | real/real-03 (`mcp_tool_call`); `command_execution`, `file_change`: `test/fixtures/codex/tools.jsonl` |
| `item.updated` | `item` | NOT CONFIRMED: declared by the SDK, and Tarsee maps it for `todo_list` only; not captured |
| `item.completed` | `item` | real/real-01 and others |
| `turn.completed` | `usage`: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` | real/real-01 |
| `turn.failed` | `error.message` | real/real-05, real-06 |
| `error` | `message` | real/real-06 (`Reconnecting... 1/1 (...)`, then the failure itself) |

Items (`item.id` is `item_<n>`, counted from 0 in each process, a resumed thread included):

| `item.type` | Fields | Seen |
|---|---|---|
| `agent_message` | `text` | real/real-01 |
| `reasoning` | `text` (the summary) | real/real-01 |
| `error` | `message` (a warning the turn carries on after) | real/real-01: `Model metadata for ... not found ...`, between `thread.started` and `turn.started` |
| `mcp_tool_call` | `server`, `tool`, `arguments`, `result` (`null`, or `{content: [...], structured_content}`), `error` (`null`, or `{message}`), `status` (`in_progress`, `completed`, `failed`) | real/real-03 |
| `command_execution` | `command`, `aggregated_output`, `exit_code` (`null` while running), `status` (`in_progress`, `completed`, `failed`) | `test/fixtures/codex/tools.jsonl`; real/real-11 (`rg --version`: `exit_code` 0, `status` `completed`); real/real-10 (`item.started`); [chk: checked-06-real-program.json `commandThatExits3`]: a command that ended with code 3 gave `exit_code` 3, `status` `failed`. On Windows `command` is the whole line the program ran as one shell-quoted string: PowerShell's full path in double quotes with its backslashes doubled, ` -Command `, then the command quoted (`"Write-Output 'one'; Write-Error 'two'; exit 3"` in double quotes; one with `$` and single quotes in it in single-quoted pieces spliced with double-quoted ones; both strings are in the fixture, `commandThatExits3` and `stop.commandRunningWhenTheProgramIsTerminated`). `aggregated_output` has `\r\n` line ends |
| `file_change` | `changes`: `[{path, kind}]` with `kind` `add`, `update` or `delete`; `status` | `test/fixtures/codex/tools.jsonl` |
| `web_search` | `query` | NOT CONFIRMED (Tarsee switches web search off) |
| `todo_list` | `items`: `[{text, completed}]` | NOT CONFIRMED (declared; not captured) |

Facts the engine depends on:

- **Order**: `thread.started`, then possibly `error` items, then `turn.started`, then items, then exactly one of
  `turn.completed` or `turn.failed` as the last line. Seen again in every turn of
  [chk: checked-06-real-program.json]; the `error` items in front of `turn.started` take item ids too (the first
  model item of such a turn was `item_1`, or `item_3` after three of them).
- **`turn.completed.usage` is the thread's running total.** The first turn reported `input_tokens` 1200, the
  resumed second turn 2400 for a turn that itself used 1200 [cap: real/real-01-new-thread.json,
  real/real-02-resumed-thread.json]. The engine subtracts the total the thread had before the turn, read from its
  rollout (8).
- `error` events whose message matches `Reconnecting... <n>/<of> (<reason>)` are retries in progress, not the
  end; the event after the last of them repeats the reason alone, followed by `turn.failed` with the same words
  [cap: real/real-06-provider-errors.json `key401`; `test/fixtures/codex/auth-401.jsonl` shows 1/5 to 5/5].
- After `turn.failed` the program exits with code 1, so the SDK, having handed over every event, then throws
  (6). The Node engine has its `done` by then and ignores that throw.

How these become Tarsee's own events is `providers/codex-events.js` (ported as `ai/providers/codex_events.rs`); it
takes the parsed objects of this section as they are.

### 3.3 How the Node engine reads the stream

[src: `providers/codex.js run()`] For each event: on `thread.started` it stores the session handle (and, for a new
thread, the instructions' hash); `mapCodexEvent` turns it into Tarsee's events; a `done` and the usage of
`turn.completed` are held back while the engine keeps reading, for at most `DRAIN_MS` = 10,000 ms, until the
program exits by itself (it is still writing the rollout the next turn resumes from). If the program has not
exited by then, the engine leaves the loop and the program is stopped as in 5.

Seen with the stub [chk: checked-08-node-engine.json]: with a program that stayed alive 14 s after
`turn.completed`, the text came at once, the `usage` and the `done` (`end_turn`) at 10,059 ms, and the program
was then ended and the sweep called (`e7`); with one that exited 300 ms after `turn.completed`, they came then
(`e1`). The 10 s are counted again for each read while the `done` is held, so a program that kept printing
would hold it longer. Only the `usage` event is held; the `usage` step for the live view is given at once. The
whole loop, and what is given at each way out of it, is 12, steps 15 and 16.

### 3.4 stderr

The SDK collects every stderr chunk in memory and does nothing with it unless the exit code is not 0, when all of
it goes into the error text (6) [src: the SDK file; cap: sdk/sdk-13-exit-zero-with-stderr.json: dropped].

What the program writes there:

- first, on every run that gets as far as reading the prompt: `Reading prompt from stdin...\n` (the whole of
  stderr on a turn that ends normally, and on one that ends in `turn.failed`) [cap: real/real-01, real-06]. A
  run refused for its arguments or its configuration ends before that line and does not have it (6's rows show
  each stderr whole) [chk: checked-06-real-program.json `refusedArguments`]
- failures before the thread exists: plain lines such as `Error: ...`, and log lines of the form
  `<UTC timestamp>Z ERROR <module>: <text>` (6)
- under some conditions a line starting `WARNING: proceeding, even though we could not create PATH aliases`
  (seen when the Codex home is under the system's temp folder: `test/fixtures/codex/auth-401.jsonl`)

The Node engine strips, from an error text of the form `Codex Exec exited with ...: <stderr>`, the lines starting
`Reading prompt from stdin`, `Reading additional input from stdin` and that `WARNING`, and the `<timestamp>
ERROR|WARN|INFO <module>:` prefix of the rest, before reading it [src: `providers/codex-events.js cleanCodexError`].

## 4. Tools from Tarsee (MCP)

### 4.1 What Tarsee tells the program

Six `--config` pairs and one environment variable [cap: turns/*.json; src: `codex-options.js`]:

```
--config mcp_servers.tarsee.url="http://127.0.0.1:<port>/mcp"
--config mcp_servers.tarsee.bearer_token_env_var="TARSEE_MCP_TOKEN"
--config mcp_servers.tarsee.default_tools_approval_mode="approve"
--config mcp_servers.tarsee.required=true
--config mcp_servers.tarsee.startup_timeout_sec=20
--config mcp_servers.tarsee.tool_timeout_sec=300
TARSEE_MCP_TOKEN=<the turn's token>            (environment)
```

The address is the loopback endpoint of `ai/mcp-http.js` (`http://127.0.0.1:<port the system picked>/mcp`); the
token is a fresh 32 random bytes, base64url, per turn (`grantTurn`). The token is never an argument.

The program reads those pairs as a streamable-HTTP server with a bearer token from that variable: `codex mcp list
--json` and `codex mcp get tarsee --json` with the same pairs print `"transport": {"type": "streamable_http",
"url": ..., "bearer_token_env_var": "TARSEE_MCP_TOKEN", ...}`, `"startup_timeout_sec": 20.0`,
`"tool_timeout_sec": 300.0`; `list` also prints `"auth_status": "bearer_token"` (`get` has no such member; it
has `"enabled_tools": null, "disabled_tools": null`). Neither command sends the server anything
[cap: other/other-08-mcp-list-and-get.json: 0 requests received; chk: checked-06-real-program.json
`outsideATurn.mcpList`, `mcpGet`: the same output, 0 requests]. Nothing among `codex mcp`'s subcommands (`list`,
`get`, `add`, `remove`, `login`, `logout`, by `codex mcp --help`) lists a server's tools; the requests below were
seen from `codex exec` itself.

### 4.2 What the program sends

At the start of every turn, a resumed one included, before it prints `thread.started`
[cap: real/real-01-new-thread.json `requestsToTheMcpServer`, real/real-02-resumed-thread.json; that it comes
first: real/real-08, where a failed handshake leaves stdout empty]. Each is its own
`POST /mcp HTTP/1.1` with a JSON body. Headers as sent (lower case), in this order:

```
user-agent: codex-mcp-client/0.167.0
mcp-protocol-version: 2025-06-18        (every request after initialize; not on initialize itself)
accept: text/event-stream, application/json
content-type: application/json
authorization: Bearer <TARSEE_MCP_TOKEN's value>
host: 127.0.0.1:<port>
content-length: <n>
```

There is no `Origin` header and no `mcp-session-id` (the endpoint issues none). No GET (no event stream is
opened) and no DELETE at the end were seen.

All of this was recorded a second time by a logging server written for the check, with the same result to the
header: the three requests, their bodies, the header order, `mcp-protocol-version` missing from `initialize`
only, and all three before the first byte of stdout (in the run that is in the fixture the requests came 9,765
to 9,832 ms after the start and stdout at 10,021 ms; in an earlier run of the same scenario 1,564 to 1,617 ms
and 1,719 ms: how long the program takes to get going in a home that is new varied that much, and why was not
looked into) [chk: checked-06-real-program.json `newThread.mcp`, `newThread.order`]. Two things that capture
adds:

- **One connection.** The three requests of the handshake, and the `tools/call` after them, came over the same
  TCP connection (one client port for all four) [chk: same file, `newThread.mcpDistinctConnections`,
  `mcpToolCall.mcpDistinctConnections`: 1]. Calls made at the same time were not exercised (4.4).
- **The endpoint has to answer while the program runs.** When the listener took the connection and answered
  nothing, the program waited `startup_timeout_sec` and gave up (4.4). In a Rust server that means the task that
  serves `/mcp` must not be the one that blocks on the program.

1. `initialize`
   ```json
   {"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18",
    "capabilities":{"elicitation":{"form":{},"url":{}}},
    "clientInfo":{"name":"codex-mcp-client","title":"Codex","version":"0.167.0"}}}
   ```
2. `notifications/initialized` (no `id`, no `params`)
   ```json
   {"jsonrpc":"2.0","method":"notifications/initialized"}
   ```
3. `tools/list`
   ```json
   {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"progressToken":0}}}
   ```

When the model calls a tool [cap: real/real-03-mcp-tool-call.json], with no approval asked of anyone:

4. `tools/call`
   ```json
   {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
     "_meta":{"callId":"call_1_0",
              "x-codex-turn-metadata":{"session_id":"<thread id>","thread_id":"<thread id>","model":"test-model",
                "turn_id":"<uuid>","turn_started_at_unix_ms":1794526771865,"thread_source":"user",
                "turn_trigger":"exec","sandbox":"none","sandbox_mode":"danger-full-access",
                "auto_review_enabled":false,"node_repl_auto_review_required":false,"node_repl_disabled":false,
                "codex_version":"0.167.0"},
              "threadId":"<thread id>","sessionId":"<thread id>","windowId":"<thread id>:0",
              "itemId":"fc_1_0","progressToken":1},
     "name":"tarsee_datetime","arguments":{"timezone":"UTC"}}}
   ```
   Request ids count up from 0 within the process. On stdout the call is an `item.started` then an
   `item.completed` of type `mcp_tool_call` with `server: "tarsee"`, `tool: "tarsee_datetime"`. The model is
   offered the tools as a namespace called `mcp__tarsee` [same file, `requestsToTheModel.toolNames`].

   Seen again [chk: checked-06-real-program.json `mcpToolCall`], with three things to add. `x-codex-turn-metadata`
   also has `"reasoning_effort": "<effort>"` when the turn was given one (row 14 of 1.3), and its members are
   not in a fixed order: read it as an object. The model names the tool by `name` and `namespace`
   (`{"type":"function_call","name":"tarsee_datetime","namespace":"mcp__tarsee",...}`), and the tool entry it
   was offered is `{"type":"namespace","name":"mcp__tarsee","description":"Tools in the mcp__tarsee
   namespace.","tools":[{"type":"function","name":...,"description":...,"strict":false,"parameters":<the tool's
   inputSchema>}]}`. And an answer that has `structuredContent` beside `content` shows on stdout as
   `"result":{"content":[...],"structured_content":{...}}`, and **the model is then given the structured content,
   not the text** (`Wall time: 0.0276 seconds\nOutput:\n{"hour":12}` for an answer whose text was "It is noon.").
   Tarsee's endpoint sends no `structuredContent` today [src: `ai/mcp-http.js`, `ai/tarsee-mcp.js`: the word is
   in neither]; if the Rust one ever does, the text stops reaching the model.

### 4.3 What the endpoint must answer

What the Node endpoint answers to those same requests, replayed with the program's headers
[cap: other/other-06-tarsee-mcp-endpoint.json; src: `ai/mcp-http.js`]:

| Request | Status | Headers | Body |
|---|---|---|---|
| `initialize` | 200 | `content-type: application/json` | `{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"tarsee","version":"1.0.0"}},"jsonrpc":"2.0","id":0}` |
| `notifications/initialized` | 202 | none of note | empty |
| `tools/list` | 200 | `content-type: application/json` | `{"result":{"tools":[{name, description, inputSchema, execution}, ... 27 in all]},"jsonrpc":"2.0","id":1}` |
| wrong or revoked token | 401 | `www-authenticate: Bearer realm="tarsee"`, `cache-control: no-store`, `content-type: application/json` | `{"jsonrpc":"2.0","error":{"code":-32000,"message":"This needs a live grant's token."},"id":null}` |
| GET | 405 | `allow: POST`, `cache-control: no-store` | `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Only POST is served here."},"id":null}` |

The program accepts a plain JSON body (`content-type: application/json`) in answer to a POST; an event stream is
not needed [cap: real/real-01, real-03: the logging server answered exactly so and the turn ran].

### 4.4 When the endpoint fails

`required = true` makes each of these fatal before the thread exists: nothing on stdout, exit code 1
[cap: real/real-08-mcp-server-failures.json; the full stderr of each is in the file].

| Case | What the program did | The end of stderr |
|---|---|---|
| nothing listens at the address | three attempts over about 5 s | `Error: thread/start: thread/start failed: error creating thread: Fatal error: Failed to initialize session: required MCP servers failed to initialize: tarsee: handshaking with MCP server failed: ... http/request failed: error sending request for url (http://127.0.0.1:9/mcp), when send initialize request (code -32603)` |
| the endpoint answers 401 | one request, no retry | `... tarsee: handshaking with MCP server failed: ... error: Auth required, when send initialize request (code -32603)` |
| `TARSEE_MCP_TOKEN` is not set | no request | `... tarsee: Environment variable TARSEE_MCP_TOKEN for MCP server 'tarsee' is not set (code -32603)` |
| the endpoint takes the request and answers nothing | one request, then waits out `startup_timeout_sec` (20 s) | `Error: thread/start: thread/start failed: error creating thread: Fatal error: Failed to initialize session: required MCP servers failed to initialize: tarsee: timed out handshaking with MCP server after 19.9999995s: deadline has elapsed (code -32603)` (the digits after `19.` differ from run to run) |

The first three were produced again, with the same words, the same counts of requests and exit code 1
[chk: checked-06-real-program.json `mcpFailures`]; in front of the last line stderr has log lines of the form
`<timestamp>Z ERROR rmcp::transport::worker: worker quit with fatal: ...` (one for each attempt) and
`<timestamp>Z ERROR codex_core::session: Failed to create session: ...`. The fourth row is from the check only:
an endpoint that took the `initialize` request and never answered; the program exited with code 1 after 27 s,
nothing on stdout, the model never asked [chk: same file, `mcpFailures.endpointSilent`]. It is the row a server
produces when the task that serves `/mcp` is held up while the program runs. The Node classifier reads the first
and the fourth as `unavailable` [chk: checked-08-node-engine.json `classified`].

NOT CONFIRMED: what the program does when a tool call runs past `tool_timeout_sec`, and whether it sends tool
calls in parallel (`mcp-http.js` keeps up to four idle tool servers per grant "when Codex calls tools in
parallel"; not captured here). That it reuses one connection for requests made one after another is confirmed
(4.2).

## 5. Stopping a turn

### 5.1 What the SDK does

[src: the SDK file, `CodexExec.run`] The caller's `AbortSignal` is handed to Node's `spawn`. When it fires, Node
ends the child and reports an error on it; the SDK notes that error (`child.once("error", ...)`), keeps reading
until stdout closes, then throws the noted error. On every way out of the read loop (the end, an error, the caller
giving up) it runs `rl.close(); child.removeAllListeners(); if (!child.killed) child.kill();`. There is no timer,
no second signal and no wait in the SDK.

What the caller sees: an error with `name` `AbortError`, `code` `ABORT_ERR`, message `The operation was aborted`
[cap: sdk/sdk-15-abort-while-running.json, posix/posix-03-abort.json]. The events that had arrived were handed
over first: 200 lines the stub had written in one burst just before the abort were all handed over, then the
error [chk: checked-04-sdk-stop.json `abortDuringABurst`].

**If the signal has already fired when `runStreamed` starts, the program is still started, and ended at once.**
An earlier version of this document said it is never started; that was read off a stub that had left no record
(sdk/sdk-21). Watching Node itself shows a process is made (it gets a process id) and is ended on the next turn
of Node's loop, before a stub can write a byte; the caller gets the same `AbortError` within a few ms
[chk: checked-04-sdk-stop.json `signalAlreadyAborted`: Windows and Linux, `aProcessWasStarted` true,
`theStubGotAsFarAsWritingItsRecord` false; Node's `child_process.spawn` starts the child and only then looks at
the signal]. What the real `codex` gets done in those few moments was not looked at (NOT CONFIRMED). The Node
engine never gets there by its own check (12, step 11: an already stopped turn ends with `done` `aborted` and
nothing is started [chk: checked-08-node-engine.json `e5`]), except for a stop that lands between that check
and the start. **In Rust: look at the stop before `spawn()`, and do not start.**

The SDK also ends the program, the same way, when the caller stops reading early
[cap: posix/posix-07-caller-stops-reading.json] and after a stdout line that is not JSON [cap: posix/posix-06]
[chk: checked-04-sdk-stop.json `linux.callerStopsReading`, `linux.badLine`: one `SIGTERM` each].

For the Rust engine: "ends the program" is `SIGTERM` on Linux and macOS (5.2). Rust's `Child::kill()` sends
`SIGKILL` there (the standard library's documentation), which is not what the SDK did: send `SIGTERM` to the
child's pid yourself. On Windows `Child::kill()` is the same plain termination Node's is: the real program,
started by a Rust `Command` and ended with `Child::kill()` in the middle of a turn, was gone within 20 ms, and
`wait()` gave exit code 1 [chk: checked-07-rust-command.json `realProgram.childKillMidTurn`]. (Node reports its
own kill differently, as `signal: "SIGTERM"` with no code, on Windows too
[chk: checked-06-real-program.json `stop`]; that is Node's bookkeeping, not something the program did.)

### 5.2 What that means on each system

**Linux** (and by the same code macOS; macOS itself was not run: NOT CONFIRMED):

- one `SIGTERM`, to the program's own process only, at the moment of the abort
  [cap: posix/posix-03-abort.json `signalsTheStubReceived`]
- a process the program had started is not signalled and outlives it (same process group, never signalled)
  [same file, `theStubsOwnChild.stillRunningAfterwards` true]
- if the program ignores `SIGTERM`, nothing more is sent: no `SIGKILL`, no time limit, and the caller's read ends
  only when the program's stdout closes (4 s later in the capture, when the stub chose to exit)
  [cap: posix/posix-04-abort-ignored.json]
- all three seen again on Linux with another stub [chk: checked-04-sdk-stop.json `linux.abort` (one `SIGTERM`;
  the stub's own child still running afterwards; the stub in the caller's process group and session),
  `linux.abortIgnored` (one `SIGTERM`, the read ended at 4,083 ms when the stub exited at 4,022 ms)]
- NOT CONFIRMED: how the real `codex` reacts to `SIGTERM` on Linux (only the Windows build is installed here).
  The Node repo's own test "Stop during a long command kills codex and what it started within 3 s"
  (`test/codex-engine.test.js`) asserts that it exits.

**Windows**:

- the program is terminated at once (Node's `kill` there is not a signal the program can handle): the stub's
  heartbeat stopped within one 20 ms tick of the abort, and the caller's read ended within 100 ms
  [cap: sdk/sdk-15-abort-while-running.json, real/real-10-stop.json]
- the real program takes what it started with it: a PowerShell loop the model had asked for stopped when the
  program was terminated through the SDK's abort [cap: real/real-10-stop.json `sdkAbort.commandStillRunningAfterwards`
  false]. `providers/codex.js` says why: "On Windows Codex's own job object takes everything it started with it".
  The fact was seen twice more: with the program started and ended by Node, and with it started by a Rust
  `Command` (no Node between, `CREATE_NO_WINDOW`) and ended by `Child::kill()`; each time the loop's heartbeat
  file stopped changing the moment the program was gone and stayed so for 3 s
  [chk: checked-06-real-program.json `stop.commandRunningWhenTheProgramIsTerminated`,
  checked-07-rust-command.json `realProgram.stopWithACommandRunning`]. So the Rust engine can rely on it as the
  Node engine did. The reason given (a job object) is the Node source's comment and was not looked into: NOT
  CONFIRMED. The command ran in the program's pseudo-terminal (its `exec_command` tool: "Runs a command in a
  PTY"), and a command started some other way was not tried.

### 5.3 What Tarsee's engine adds

[src: `providers/codex.js run()`, `sweepTurnProcesses`, `trackLive`]

- **Its own stops.** Besides the caller's signal, the engine aborts the SDK itself when the turn has started more
  tools than `maxTurns` (default 50), and, for every provider but `chatgpt`, at the first `error` event whose
  message holds `status 401`, `402`, `403` or `404` (Codex would retry it five times). Exactly:
  - the count is `codex-events.js`'s `toolCount`: one for each `command_execution`, `mcp_tool_call` and
    `web_search` item and one for each `file_change` item (however many files), counted when the item is first
    seen, started or completed; `todo_list` items are not counted. The stop comes when the count is **greater**
    than `maxTurns` (a positive number, floored; anything else is 50), so with `maxTurns` 2 the third tool is
    announced (`tool_use`) and then closed as not finished [chk: checked-08-node-engine.json `e3`]
  - the status is read from a top-level `error` event (not an `error` item) with `/\bstatus (\d{3})\b/i`; the
    message kept for the failure is the event's, with a `Reconnecting... <n>/<of> (` … `)` wrapper taken off
    (`/^Reconnecting\.\.\.\s*\d+\s*\/\s*\d+\s*\(([\s\S]*)\)\s*$/`). With the real program a refused key shows as
    `Reconnecting... 1/5 (unexpected status 401 Unauthorized: <message>, url: <url>)`, the first of five about
    0.2, 0.4, 0.8, 1.7 and 3.4 s apart [chk: checked-06-real-program.json `providerErrors.status401`]; the engine
    stops at the first [chk: checked-08-node-engine.json `e4`]
  - neither check is made once the turn's `done` is being held (3.3)
- **At the end of every turn** (`finally`): if the stream had not ended, it aborts and closes the SDK's iterator,
  which ends the program as in 5.1.
- **The sweep.** When the turn was stopped (by anyone), or its stream had not ended, it then calls
  `sweepTurnProcesses(mark)`: on Windows nothing; elsewhere `SIGKILL` to every process whose environment holds
  `TARSEE_CODEX_TURN=<this turn's mark>` exactly, except the server itself. Linux reads each
  `/proc/<pid>/environ` (entries separated by NUL; the match must be a whole entry); macOS, when there is no
  `/proc`, runs `ps -axeww -o pid=,command=` and matches `TARSEE_CODEX_TURN=<mark>` as a whole word. This is what
  ends a command the program started that outlived it (5.2).
- **When the server itself exits** (`process.once("exit")`): for every running turn, abort, sweep, and remove the
  turn's picture folder, all synchronously.
- **When the server is killed (Windows).** No exit handler runs then, and the Node version still left nothing
  behind: a program Node starts without `detached` ends when the Node process ends, however it ends. Seen: a Node
  process that had started a child the way the SDK does was ended with `taskkill /F` (no `/T`), and the child
  was gone; the same child started by a Rust `Command` whose parent was ended the same way **kept running**
  [chk: checked-07-rust-command.json `whenTheParentIsKilled`]. It is libuv's doing: every process it starts
  that is not detached is put in a job object that ends its processes when the last handle to it closes, which
  is when the Node process goes [libuv `src/win/process.c`, `uv__init_global_job_handle`, read on its `v1.x`
  branch; the copy inside this Node was not read]. A Rust server that wants the same has to do it itself (a
  job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` that each `codex` is assigned to); without it a `codex`
  whose server was killed mid-turn keeps running. The job object is Windows code; what becomes of a `codex`
  on Linux when its Node server is killed was not tried (NOT CONFIRMED), and the next start's sweep of leftovers
  (`lib/turn-leftovers.js`) is about files, not processes. Whether a job of
  the server's own gets in the way of the program's own handling of what it starts was not tried (NOT
  CONFIRMED; under Node the program does run inside libuv's).
- Then, always: the turn's picture folder is removed, the Local AI bridge's turn is released, and a tools grant
  the engine made itself is revoked.

A stopped turn yields `done` with `stopReason: "aborted"` and no error; the AbortError never reaches the user.
A tool that was still running is first closed with a `tool_result` that has `ok: false` and the result
`Stopped before it finished.` [chk: checked-08-node-engine.json `e9`]. Every way a turn can end, with the events
it ends on, is in 12.

### 5.4 What Tarsee's own `killTree()` does, and when

`ai/codex-cli.js killTree(child, { graceMs = 2000 })` is not used for turns. It ends the programs Tarsee starts
without the SDK (7) [src; cap: posix/posix-09-killtree.json, real/real-10-stop.json `killTree`,
other/other-05-device-login.json `neverApprovedThenCancelled`]:

- if the child has already exited: nothing
- Windows: `taskkill /pid <pid> /T /F` (and `child.kill()` if `taskkill` cannot be started); the program then
  exits with code 1
- elsewhere: `SIGTERM` to the child's process group (`kill(-pid)`; the child was started as a group leader, see
  7.1), falling back to the child alone; if it is still running `graceMs` later, `SIGKILL` the same way. The stub
  that exits on `SIGTERM` was gone within a few ms; the one that ignores it was killed by the `SIGKILL` at
  2,000 ms. Its own child went with it either way.
- it resolves when the child has exited, or `graceMs` + 3,000 ms later regardless

It is called: by `runCodex` when a command passes its time limit; by the device sign-in when the code does not
show in time, the output is not OpenAI's page, the sign-in is cancelled, expires, fails, or (after waiting up to
1 s for the program to exit by itself) succeeds; and by the model list at the end of every conversation, after
giving the program 3 s to exit once its stdin is closed.

## 6. Ending and failing

How the SDK reports the end [src: the SDK file, `CodexExec.run`]: after stdout closes it waits for the exit, with
no time limit. If the code is 0 and there was no signal, the stream simply ends. Otherwise it throws an error
whose message is exactly

```
Codex Exec exited with code <n>: <stderr>          the exit code in decimal (1 if the system gave none)
Codex Exec exited with signal <NAME>: <stderr>     when a signal ended it; <NAME> as in SIGKILL, SIGTERM
```

where `<stderr>` is everything the program wrote to stderr, decoded as UTF-8, unchanged (so it usually starts
`Reading prompt from stdin...\n` and ends with a newline; it is empty when nothing was written). All of it is
kept, with no cap (200,000 characters came through), and bytes that are not UTF-8 become U+FFFD (`bad` then the
bytes `FF FE` arrived as `bad��`): `String::from_utf8_lossy` in Rust
[chk: checked-03-sdk-stdout-and-exit.json `exitCodes`]. A program that cannot be started throws Node's own error
(`spawn <path> ENOENT`, with `code: "ENOENT"`, `errno` -4058 on Windows, `syscall` `spawn <path>`)
[chk: checked-01-sdk-arguments.json `programMissing`].

The Rust engine should build the same two texts: the ported classifier (`codex-events.js cleanCodexError`)
recognises a failure of this kind by the pattern `^Codex Exec exited with (code \d+|signal \w+):\s*([\s\S]*)$` and
reads the rest as stderr. It should build the third too: the classifier knows a missing program by
`Unable to locate Codex CLI binaries`, `spawn <something with codex in it> ENOENT` or `codex(.exe)` followed by
`ENOENT` (`MISSING_BINARY_RE`), and Rust's own words for it, `The system cannot find the file specified. (os
error 2)`, match none of them: given those the classifier says `unknown`, "ran into a problem", instead of
"Codex isn't installed where Tarsee can run it" [chk: checked-08-node-engine.json `classified`]. So for a
`NotFound` from `spawn()` give the classifier `spawn <the path> ENOENT`.

On Windows the Rust engine has no signal to report: a program it ended itself, or one ended by `taskkill /F`,
both exit with code 1, and the text is `Codex Exec exited with code 1: <stderr>`.

Each row was produced with the real program unless it says otherwise; `...` stands for
`Reading prompt from stdin...\n`. "Tarsee" is what the Node classifier makes of the words
(`codex-events.js classifyCodexFailure`), recorded for every row in
real/real-12-how-tarsee-reads-each-failure.json.

| Case | stdout | Exit | stderr | What the caller gets | Tarsee |
|---|---|---|---|---|---|
| A normal end | events, `turn.completed` last | 0 | `...` | the stream ends | `end_turn` |
| The model's server refuses (unknown model, 404 or 400) | `thread.started`, ..., `error`, `turn.failed`, both with the server's message | 1 | `...` | every event, then `Codex Exec exited with code 1: ...` | `model` |
| The same, the two statuses apart [chk] | 404 with a body ``{"error":{"message":"The model `test-model` does not exist.",...}}``: one request, and the message is the body's `error.message` alone (no "status 404" in it). 400 with such a body: one request, and the message is the whole body as text, `{"error":{"message":"Bad request body.","type":"invalid_request_error","code":"bad"}}` | 1 | `...` | the same | `model` for the 404; `unknown` for the 400 |
| The key is refused (401) | the same, after `Reconnecting... n/N` errors: `unexpected status 401 Unauthorized: <message>, url: <url>` | 1 | `...` | the same | `auth` (`expired` on `chatgpt`) |
| The model's server answers 429 [chk] | one request; `error` and `turn.failed`: `exceeded retry limit, last status: 429 Too Many Requests` | 1 | `...` | the same | `rate` |
| The model's server answers 500 [chk] (the provider given `request_max_retries=1`, `stream_max_retries=1`; four requests) | `error` `Reconnecting... 1/1 (We’re currently experiencing high demand, which may cause temporary errors.)`, then `error` and `turn.failed` with those words alone (the apostrophe is U+2019; the server's own message is not in it) | 1 | `...` | the same | `unknown` |
| A custom provider's key variable is not set | `turn.failed`: ``Missing environment variable: `TARSEE_PROVIDER_KEY`.`` | 1 | `...` | the same | `unknown` |
| The OpenAI provider with no `CODEX_API_KEY`; the ChatGPT plan with no `auth.json` | not refused by the program: it sent the request with no `Authorization` header, and the fake model answered | 0 | `...` | the stream ends | (see below) |
| `resume` of a thread with no rollout | nothing | 1 | `...Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)\n` | `Codex Exec exited with code 1: <that>` | `session`, recoverable |
| The same, timed [chk] | nothing; the MCP server was not asked anything; the program took 7.4 s to say so | 1 | the same words | the same | the same |
| `resume` with an id that is not a UUID [chk] | not refused: a new thread, `thread.started` with a new id, the turn runs (first output after about 9 s) | 0 | `...` | the stream ends | `end_turn` (1.3) |
| A picture file that is not there [chk] | not refused: the turn runs and the model is told (2) | 0 | `...` | the stream ends | `end_turn` |
| A `--config` value of a word the setting does not take | nothing | 1 | ``Error loading config.toml: unknown variant `sometimes`, expected one of `untrusted`, `on-failure`, `on-request`, `granular`, `never`\nin `approval_policy`\n\n`` | the same form | `unknown` |
| A `--config` value of the wrong type | nothing | 1 | ``Error loading config.toml: invalid type: string "big", expected i64\nin `model_context_window`\n\n`` | the same form | `unknown` |
| A `--config` with no `=` | nothing | 1 | `Error parsing -c overrides: Invalid override (missing '='): justakey\n` | the same form | `unknown` |
| A `--config` key the program does not know | the turn runs; two `error` items name the key (1.4 has the words) | 0 | `...` | the stream ends | a status step |
| `model_reasoning_effort` with a word that is not an effort [chk] | not refused: the turn runs and the word goes to the model (1.4) | 0 | `...` | the stream ends | `end_turn` |
| `model_provider` names a provider that is not defined | nothing | 1 | ``Error: Model provider `nobody` not found\n`` | the same form | `model` |
| An option that does not exist | nothing | 2 | `error: unexpected argument '--bogus' found\n\n  tip: to pass '--bogus' as a value, use '-- --bogus'\n\nUsage: codex exec [OPTIONS] [PROMPT]\n       codex exec [OPTIONS] <COMMAND> [ARGS]\n\nFor more information, try '--help'.\n` | `Codex Exec exited with code 2: <that>` | `unknown` |
| A `--sandbox` value that does not exist | nothing | 2 | `error: invalid value 'wide-open' for '--sandbox <SANDBOX_MODE>'\n  [possible values: read-only, workspace-write, danger-full-access]\n\nFor more information, try '--help'.\n` | `Codex Exec exited with code 2: <that>` | `unknown` |
| `--cd` names a folder that is not there (Windows wording) | nothing | 1 | `Error: The system cannot find the file specified. (os error 2)\n` | the same form | `unknown` |
| Tarsee's MCP server cannot be reached, refuses the token, or its variable is unset | nothing | 1 | 4.4 | the same form | `unavailable` / `unknown` / `unknown` |
| Tarsee's MCP server takes the request and answers nothing [chk] | nothing; the exit came 27 s after the start | 1 | 4.4 | the same form | `unavailable` |
| Nothing on stdin, or white space only [chk] | nothing; neither server is asked anything | 1 | `...No prompt provided via stdin.\n` | the same form | `unknown` |
| The program exits before it has read a prompt bigger than the pipe [chk] (stub) | | as it exits | as it wrote | `Codex Exec exited with code <n>: <stderr>`, and an unhandled `write EOF` (Windows) or `write EPIPE` (Linux) beside it (2) | by the exit's words |
| The command line is too long to start [chk] | | | | Windows: `spawn ENAMETOOLONG`; Linux: `spawn E2BIG` (1.7) | `unknown` |
| The program is killed from outside, Windows (`taskkill /F`; stub) | the events so far | 1 | empty | `Codex Exec exited with code 1: ` | `unknown` |
| The program is killed from outside, Linux (`SIGKILL`; stub) | the events so far | signal | empty | `Codex Exec exited with signal SIGKILL: ` | `unknown` |
| The program is sent `SIGTERM` from outside, handles it and exits with 143 [chk] (Linux; stub) | the events so far | 143 | empty | `Codex Exec exited with code 143: ` | `unknown` |
| The caller stops the turn | the events so far | | | `AbortError` (5.1) | `aborted`, no error |
| The program is not at the path (stub path) | | | | `spawn <path> ENOENT` | `unknown` |
| A stdout line that is not JSON (stub) | the events before it | | | `Failed to parse item: <line>` | `unknown` |
| A crash of the program itself (a panic) | NOT CONFIRMED: none could be provoked; the stub rows above show what any exit code or signal turns into | | | | |

Captures: real/real-04 (unknown thread), real-05 (credentials), real-06 (model, key), real-07 (arguments), real-08
(MCP), real-11 (stdin); sdk/sdk-11 to sdk-14, sdk-16, sdk-18 and posix/posix-05 (the SDK's handling, with the
stub). Every row was produced a second time except the "not refused" credential row, the Windows `taskkill` row
and the crash row, and the rows marked [chk] are from that second time only: checked/checked-06-real-program.json (`stdin`,
`refusedArguments`, `mcpFailures`, `providerErrors`, `stop`), checked-03-sdk-stdout-and-exit.json,
checked-04-sdk-stop.json, checked-05-sdk-stdin.json; what the classifier makes of the new rows' words is in
checked-08-node-engine.json `classified`. The words of every row that was repeated came out the same.

About the two "not refused" rows: with `forced_login_method="api"` and no key, and with
`forced_login_method="chatgpt"` and no sign-in file, the program went to the model anyway, unauthenticated.
Both were captured with the model's address pointed at a local fake (Tarsee's test-only seam); what OpenAI's or
ChatGPT's own servers then answer was not captured (NOT CONFIRMED; the 401 row shows the shape a refusal takes).
The Node engine never gets there for a key provider: a missing key is refused before anything starts (1.5). For
`chatgpt` it does not check for a sign-in before starting. `ai/engine-errors.js` names the words codex 0.167 uses
for a ChatGPT sign-in it cannot renew ("Your access token could not be refreshed ...", "Your authentication
session could not be refreshed ..."); those were not reproduced here.

Two orderings the engine must get right:

- **`turn.failed` then exit code 1.** The failure is in the events; the non-zero exit that follows is not a second
  failure. The Node engine classifies the `turn.failed` message and ignores the SDK's throw after it.
- **No events, exit code not 0.** The only words are stderr, inside the SDK's error text. The Node engine cleans
  that text (3.4) and classifies it; `no rollout found` and `thread/resume failed` make it a recoverable session
  failure, so the turn layer starts a fresh thread.

## 7. The other invocations

### 7.1 What they share

[src: `ai/codex-cli.js`]

- **Arguments first**: `CODEX_BASE_ARGS`, three pairs, in front of the subcommand:
  `-c` `cli_auth_credentials_store="file"` `-c` `check_for_update_on_startup=false` `-c` `project_root_markers=[]`
- **Environment** (`codexChildEnv`): `engine-env.js baseEnv(server's environment)`, which is layer 1 of 1.6
  without its last line (every name matching `AUTH_ENV_RE`, Tarsee's three secrets and the four provider key
  names are left out; no vault keys are added), then the extras given, then `CODEX_HOME=<the home>`, each later
  one winning. No `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` here.
- **Working folder**: the Codex home itself.
- **Start** (`spawnCodex`): three pipes, `windowsHide`; on Windows a `.cmd` or `.bat` goes through
  `cmd.exe /d /s /c "<each argument quoted>"`, anything else is started directly; off Windows it is started
  detached, so it leads its own process group [cap: posix/posix-09-killtree.json `isItsOwnGroupLeader` true]. An
  `error` listener is always attached to the child and to its stdin.
- **Stop**: `killTree` (5.4).
- **`runCodex(bin, args, { timeoutMs = 15000, maxBytes = 256 KiB })`**: closes stdin at once, collects stdout and
  stderr up to `maxBytes` each, kills the tree at the time limit, resolves `{code, signal, stdout, stderr,
  timedOut}` on close; rejects only when the program cannot be started (`codex-missing` for ENOENT or EACCES, else
  `spawn-failed`).
- Before any of them runs, the home's `config.toml`, `.env` and `.codex/config.toml` must pass
  `codexConfigGuard` (`codexConfigFilesFor({ home, workspace: home })`).

### 7.2 `codex login status` and `codex logout`

[cap: other/other-04-login-status-and-logout.json] Everything is on **stderr**; stdout is empty.

| Command (after the base arguments) | Home holds | Exit | stderr |
|---|---|---|---|
| `login status` | no `auth.json` | 1 | `Not logged in\n` |
| `login status` | a ChatGPT sign-in | 0 | `Logged in using ChatGPT\n` |
| `login status` | an API key (`{"auth_mode":"apikey","OPENAI_API_KEY":"..."}`) | 0 | `API key configured - <first 8 characters>***<last 5>\nAuthentication is checked when you send a request.\n` |
| `logout` | no `auth.json` | 0 | `Not logged in\n` |
| `logout` | a ChatGPT sign-in | 0 | `Successfully logged out\n`; `auth.json` is gone |

Tarsee reads `login status` from stderr and stdout joined, after removing terminal colour codes: `Not logged in`
is none, `Logged in using ChatGPT` is `chatgpt`, `API key configured` or `Logged in using an API key` is `api`,
any other `Logged in using` is `other`, anything else is "could not tell" [src: `codex-device-login.js
statusMethod`]. Time limit 15 s. `logout` has 20 s, and Tarsee removes `auth.json` itself afterwards whatever
happened. With a sign-in present, `logout` took about 1 s here with the network blocked, so it tries to reach
something first (NOT CONFIRMED what; the program's text holds `https://auth.openai.com/oauth/revoke`).
Both leave `auth.json.lock`, `auth.lock` and `tmp/` in the home.

Three of the rows were produced again in a home of their own, with the same exit codes and the same words
[chk: checked-06-real-program.json `outsideATurn`]: `login status` with no `auth.json` (1, `Not logged in\n`),
`logout` with none (0, `Not logged in\n`), and `login status` with an API key file (0; a made-up key of 30
characters showed as its first 8, `***`, its last 5). One difference: in a home that had been empty,
`login status` left only `tmp/`; the two lock files appeared with `logout`. The two ChatGPT rows need a sign-in
file and were not repeated.

### 7.3 `codex login --device-auth`

Started as [src: `ai/codex-device-login.js begin`]:
`codex -c cli_auth_credentials_store="file" -c check_for_update_on_startup=false -c project_root_markers=[] login
--device-auth`, environment `codexChildEnv(env, home)`, working folder the home, **stdin closed at once**.

The captures used the program's own hidden option `--experimental_issuer <url>` (which Tarsee does not pass) to
point it at a local stand-in for the sign-in server, so no real sign-in was started
[cap: other/other-05-device-login.json, six runs]. The only difference from the real flow is the link's host.
The option is not in `codex login --help` (which lists `--with-api-key`, `--with-access-token`, `--device-auth`
and the `status` subcommand) and is accepted all the same: pointed at a port nothing listens on, the program
tried `POST http://127.0.0.1:9/api/accounts/deviceauth/usercode`, printed `Error logging in: error sending
request for url (http://127.0.0.1:9/api/accounts/deviceauth/usercode)\n` on stderr, exited 1, and left
`log/codex-login.log` in the home [chk: checked-06-real-program.json `outsideATurn.deviceAuth_hiddenIssuerOption_deadPort`,
`help.login`]. The six runs themselves were not repeated.

**What it prints, and in what order.**

1. On **stdout**, in one piece, as soon as the sign-in server has given a code, with terminal colour codes
   (`ESC[90m`, `ESC[94m`, `ESC[0m`) even though stdout is a pipe:
   ```
   (empty line)
   Welcome to Codex [v0.167.0]
   OpenAI's command-line coding agent
   (empty line)
   Follow these steps to sign in with ChatGPT using device code authorization:
   (empty line)
   1. Open this link in your browser and sign in to your account
      <issuer>/codex/device
   (empty line)
   2. Enter this one-time code (expires in 15 minutes)
      CAPT-12345
   (empty line)
   Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.
   (empty line)
   ```
   With the real sign-in server the link is `https://auth.openai.com/codex/device`: that is the Node repo's own
   capture of the real program (`test/fixtures/fake-codex-login/device-auth.stdout.txt`), which is byte for byte
   this text with that link; it was not captured again here because doing so starts a real sign-in. Tarsee passes
   on only that exact page (https, host `auth.openai.com`, no port, path `/codex/device`) and stops the login if
   any other link is printed with a code.
2. Then it waits, printing nothing, while it asks the sign-in server whether the person has entered the code.
3. On success: it writes `auth.json` in the home, then prints `Successfully logged in\n` on **stderr**, then exits
   with code 0, all three within a few tens of milliseconds, in that order.

**How it ends otherwise** (all on stderr, exit code 1):

| What happened | stderr | stdout before it |
|---|---|---|
| device-code sign-in is switched off for the account (the code request answers 404) | `Error logging in: device code login is not enabled for this Codex server. Use the browser login or verify the server URL.\n` | nothing |
| the code request fails otherwise (500) | `Error logging in: device code request failed with status 500 Internal Server Error\n` | nothing |
| refused while waiting (400) | `Error logging in: device auth failed with status 400 Bad Request\n` | the link and code |
| approved, but the last exchange fails | `Error logging in: device code exchange failed: token endpoint returned status 400 Bad Request: <description>\n` | the link and code |
| cancelled by Tarsee (`killTree`) | nothing | the link and code; exit code 1 on Windows (5.4) |
| the code expires | NOT CONFIRMED (15 minutes); the program's text holds `device auth timed out after 15 minutes` | |

**What Tarsee does with it** [src: `codex-device-login.js`]: reads the link and code off stdout (stderr too), with
colour codes removed; fails if they have not appeared within 30 s; then, every second, checks whether `auth.json`
is new (size and modification time changed) and, when it is, runs `codex login status` and takes the sign-in as
done when that says ChatGPT; gives up at the earlier of 15 minutes and the "expires in N minutes" the program
printed; when the program exits with 0 it checks once more; with anything else it reads the error from stderr.

**What it sends, for the record** (useful only for a test stand-in): `POST <issuer>/api/accounts/deviceauth/usercode`
with `{"client_id": ...}`, answered `{"device_auth_id", "user_code", "interval"}`; then `POST
<issuer>/api/accounts/deviceauth/token` with `{"device_auth_id", "user_code"}` every `interval` seconds, 403 while
waiting, 200 `{"authorization_code", "code_challenge", "code_verifier"}` when approved; then `POST
<issuer>/oauth/token` (form-encoded, `grant_type=authorization_code`, `redirect_uri=<issuer>/deviceauth/callback`)
answered `{"id_token", "access_token", "refresh_token"}`. The interval the real server gives is NOT CONFIRMED.

**The `auth.json` it writes** (tokens replaced):

```json
{"auth_mode":"chatgpt","OPENAI_API_KEY":null,
 "tokens":{"id_token":"<ID_TOKEN>","access_token":"<ACCESS_TOKEN>","refresh_token":"<REFRESH_TOKEN>",
           "oauth_provenance":{"issuer":"<issuer>","client_id":"<client id>"},
           "login_owner_id":"<...>","account_id":"<from the token>"},
 "last_refresh":"2026-11-12T23:47:17.262694400Z"}
```

Tarsee reads from it, for display only: `auth_mode`, whether `tokens` has a refresh or access token, the email and
plan inside `tokens.id_token`'s payload, and `last_refresh` (also the ChatGPT start gate's clock,
`providers/codex.js refreshStale`).

### 7.4 The account's model list: `codex app-server`

Started as [src: `ai/codex-models.js askCodex`]:
`codex -c cli_auth_credentials_store="file" -c check_for_update_on_startup=false -c project_root_markers=[]
app-server`, environment `codexChildEnv(env, home, { RUST_LOG: "error" })`, working folder the home. It is never
started when the home has no `auth.json` (the answer is then `not-signed-in` without running anything).

**Framing**: one JSON object per line in each direction, `\n` after each. There is no `"jsonrpc"` member in
either direction: Tarsee sends none and the program's answers have none. A request has `id` and `method`; an
answer has the same `id` and `result` or `error: {code, message}`; a line with `method` and no `id` is a
notification.

**The conversation** [cap: other/other-01-app-server-not-signed-in.json, other-02-app-server-signed-in.json,
other-03-app-server-list-fetch-fails.json]. `->` is Tarsee to the program.

```
-> {"id":1,"method":"initialize","params":{"clientInfo":{"name":"tarsee","title":"Tarsee","version":"<Tarsee's version>"}}}
<- {"id":1,"result":{"userAgent":"tarsee/0.167.0 (<system>) unknown (tarsee; <version>)","codexHome":"<home>","platformFamily":"windows","platformOs":"windows"}}
-> {"method":"initialized"}
-> {"id":2,"method":"account/read","params":{"refreshToken":false}}
<- {"method":"remoteControl/status/changed","params":{...},"emittedAtMs":...}        (a notification: ignore)
<- {"method":"account/updated","params":{"authMode":"chatgpt","planType":"free"},"emittedAtMs":...}   (when signed in: ignore)
<- {"id":2,"result":{"account":<see below>,"requiresOpenaiAuth":true,"workspaceRouting":<null or an object>}}
-> {"id":3,"method":"model/list","params":{"limit":100,"includeHidden":false}}
<- {"id":3,"result":{"data":[<model>, ...],"nextCursor":null}}
```

- `account` is `null` when nobody is signed in (Tarsee stops: `not-signed-in`); for a ChatGPT sign-in it is
  `{"type":"chatgpt","email":"person@example.test","planType":"free","workspaceName":null}`; any other `type`
  makes Tarsee stop with `not-chatgpt` (an API key sign-in is `{"type":"apiKey"}` in the Node repo's fake;
  NOT CONFIRMED against the real program).
- `account/read` can fail instead: `{"error":{"code":-32603,"message":"workspace routing discovery failed"},"id":2}`
  was seen when the account's backend did not answer the program's workspace question. Tarsee maps a failure whose
  message matches `refresh|sign in|signed out|log ?in|log out|expired|unauthori[sz]ed|401` to `sign-in-expired`,
  any other to `error`.
- `model/list` pages: while `nextCursor` is a non-empty string, Tarsee asks again with `"cursor": <it>` added, at
  most 20 pages. With `"limit":1` the program answered one model and `"nextCursor":"1"`, then the next with
  `"cursor":"1"` and `"nextCursor":null`.
- One model, as answered (the fields Tarsee reads are `id` or `model`, `hidden`, `displayName`, `description`,
  `supportedReasoningEfforts[].reasoningEffort`, `defaultReasoningEffort`, `inputModalities`, `isDefault`):
  ```json
  {"id":"gpt-6.1-sol","model":"gpt-6.1-sol","upgrade":null,"upgradeInfo":null,"availabilityNux":{"message":"..."},
   "displayName":"GPT-6.1-Sol","description":"Latest workhorse model for coding and everyday work.",
   "modelSpecialty":null,"hidden":false,
   "supportedReasoningEfforts":[{"reasoningEffort":"low","description":"..."}, ...],
   "defaultReasoningEffort":"low","inputModalities":["text","image"],"supportsPersonality":false,
   "multiAgentVersion":"v2","additionalSpeedTiers":["fast"],
   "serviceTiers":[{"id":"priority","name":"Fast","description":"2x speed, increased usage"}],
   "defaultServiceTier":null,"availableAccessPrograms":null,"isDefault":true}
  ```
- A request the program does not know is answered `{"error":{"code":-32600,"message":"Invalid request: unknown
  variant ..."},"id":4}`.
- If the program itself sends a request (a line with both `method` and `id`), Tarsee answers
  `{"id":<its id>,"error":{"code":-32601,"message":"Tarsee's model check doesn't handle this request."}}`
  [src: `RpcClient.onLine`]. None was seen (NOT CONFIRMED that the program ever does in this conversation).

**Whether the answer is the account's own list.** `model/list` always answers. With nobody signed in, or when
fetching the account's list fails, the answer is the catalog bundled in the program (nine models in 0.167.0) and
the only signs are on the side [cap: other-01, other-03]:

- stderr gets `<timestamp> ERROR codex_models_manager::manager: failed to refresh available models: <why>`
  (with terminal colour codes around its parts; captured with `RUST_LOG=error`, as Tarsee sets it), and
- no `models_cache.json` is written in the home.

When the fetch works [cap: other-02] the answer is the account's list, stderr is empty, and the home has
`models_cache.json`: `{"fetched_at": ..., "etag": ..., "client_version": "0.167.0", "identity": "<hash>",
"models": [{"slug": "<id>", "display_name": ..., ...}]}`. So Tarsee takes the answer as the account's only when:
`account/read` said ChatGPT; stderr (colour codes removed) does not match `failed to refresh available models`;
and `models_cache.json` lists (as `slug`, `id` or `model`) every model in the answer. Otherwise the reason is
`not-live`, or `empty` for no models.

**Ending it**: after the answers, Tarsee closes the program's stdin and waits up to 3 s for it to exit by itself
(so that everything it logged is in), then reads stderr, then always calls `killTree`. With stdin closed the
program exited by itself with code 0, between a few tens of ms and about 1 s later. The whole conversation has
20 s (`timeoutMs`); an answer is kept 5 minutes per sign-in file.

The two captures with a sign-in used a made-up `auth.json` and, so that its token stayed on this machine, two
extra `--config` pairs (`chatgpt_base_url`, `openai_base_url`) and `SSL_CERT_FILE`, none of which Tarsee passes.
They show where the program goes when signed in: `GET <chatgpt_base_url>wham/accounts/check` (the Node repo's
tests say its workspace routing refuses a plain-http address; the capture used https) and several
`.../plugins/...` addresses, and `GET <openai_base_url>/models?client_version=0.167.0` for the list,
each with `authorization: Bearer <access token>` and `chatgpt-account-id`. That is why Tarsee guards the home's
`config.toml` before starting it.

## 8. Sessions on disk

Everything is under the Codex home (`CODEX_HOME`): `<state>/.codex-home` for the ChatGPT plan,
`<state>/.codex-home-keys` for every other provider [src: `engine-env.js homeFor`].

**What a turn leaves there** [cap: real/real-01-new-thread.json `codexHomeAfterTheTurn`; chk:
checked-06-real-program.json `newThread.homeAfter`, `newThread.rollout`: the same list, in a home that was empty
before the turn; the rollout's folder and name in local time, its lines' four members, its line types, the
`session_meta` values and the `token_count` line as below; and on the resumed turn the same single file, with a
second `token_count` whose `total_token_usage` is the sum and whose `last_token_usage` is the second turn's]:

```
sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<thread id>.jsonl     the thread's rollout
state_5.sqlite  thread_history_1.sqlite  goals_1.sqlite  queue_1.sqlite  memories_1.sqlite  logs_2.sqlite
    (each with -shm and -wal files beside it while in use)
installation_id   .sandbox/sandbox.<date>.log   .sandbox_migration
skills/.system/...            the program's own bundled skills, unpacked
thread-writer-locks/.coordination.lock
tmp/arg0-windows/...          (Windows)
```

Other files seen in a home: `auth.json`, `auth.json.lock`, `auth.lock`, `log/codex-login.log` (the sign-in),
`models_cache.json`, `.tmp/` (the app-server). `history.persistence="none"` is passed on every turn and no
history file appeared. A turn wrote no `config.toml` (`engine-env.js` says the same of 0.167: "turns (`codex
exec`) write nothing there").

**The rollout.**

- The folder is the day the thread was created and the name its time, both in the machine's local time (a thread
  created at 23:39 UTC on the 12th, on a machine eight hours ahead, is in `sessions/2026/11/13/` as
  `rollout-2026-11-13T07-39-...`). The name ends `-<thread id>.jsonl`.
- A resumed turn appends to the same file [cap: real/real-02: the same single file, larger].
- The thread id is a UUID of version 7: its first 48 bits are the creation time in milliseconds, which is how
  Tarsee finds the day folder without a search [src: `providers/codex.js threadDay`, `findRollout`: the folder for
  that local day, the day before and the day after; then a walk of `sessions/` and `archived_sessions/`, three
  levels deep, for a name ending `-<id>.jsonl`].
- `archived_sessions/` is where `codex archive` moves a thread, by Tarsee's code (`findRollout` looks there
  second). `codex archive --help` confirms only that the command exists ("Archive a saved session by id or
  session name") and says nothing of a folder; the word `archived_sessions` is in the program's binary
  [chk: checked-06-real-program.json `help.archive`, `stringsInTheProgram`]. No thread was archived, so the
  folder itself was not seen (NOT CONFIRMED).
- Each line is `{"timestamp", "ordinal", "type", "payload"}` [cap: real/real-13-codex-home-after-turns.json
  `rollout`]. Types seen: `session_meta` (once; `payload.id` is the
  thread id, `payload.originator` is `codex_sdk_ts`, `payload.source` is `exec`), `turn_context`, `world_state`,
  `response_item`, `token_usage_record`, and `event_msg` with `payload.type` of `task_started`,
  `thread_settings_applied`, `item_completed`, `token_count`, `task_complete`.
- What Tarsee reads from it, from the last line that has it (reading back from the end, at most
  `TARSEE_SESSION_JSONL_MAX_MB`, default 8 MB) [src: `rolloutUsageTotal`, `rolloutLastCallInput`]:
  ```json
  {"timestamp":"...","ordinal":26,"type":"event_msg","payload":{"type":"token_count","info":{
    "total_token_usage":{"input_tokens":2400,"cached_input_tokens":400,"cache_write_input_tokens":0,
                         "output_tokens":60,"reasoning_output_tokens":24,"total_tokens":2460},
    "last_token_usage":{"input_tokens":1200, ...},
    "last_usage_includes_reasoning":false,"model_context_window":121600},"rate_limits":{...}}}
  ```
  `payload.info.total_token_usage` is the thread's running total (the baseline a resumed turn subtracts, and the
  usage of a turn that ended without `turn.completed`); `payload.info.last_token_usage.input_tokens` is how full
  the context was at the last model call.
- A rollout larger than that cap is not resumed: the turn reports a recoverable session failure and starts fresh.

**What Tarsee removes** [src: `ai/codex-rollouts.js`, `lib/codex-thread-dbs.js`, `lib/retention.js`]:

- `rollout-*.jsonl` files under each home's `sessions/` (three folder levels) not modified for
  `retention.codex_rollouts_days` (30), and the day folders that leaves empty
- then, in the six databases, every row of a thread whose rollout is gone and whose `threads` row is older than the
  same cutoff. The schema parts it relies on, as 0.167.0 made them
  [cap: real/real-13-codex-home-after-turns.json, read from the home a real turn left]:
  - `state_5.sqlite`, table `threads`: `id` TEXT, `rollout_path` TEXT, `updated_at` INTEGER (seconds),
    `updated_at_ms` INTEGER (among 43 columns). On Windows `rollout_path` is the extended form,
    `\\?\<drive>:\...\sessions\2026\11\13\rollout-....jsonl`.
  - a column named `thread_id`, `parent_thread_id` or `child_thread_id` in any table of any of the six: in
    `state_5` the tables `guardian_review_feedback`, `thread_attachments`, `thread_dynamic_tools`,
    `thread_read_receipts` (`thread_id`) and `thread_spawn_edges` (`parent_thread_id`, `child_thread_id`); in
    `thread_history_1` `thread_history_projection_state`, `thread_items`, `thread_realtime_items`, `thread_turns`;
    in `goals_1` `thread_goal_continuation_deferrals`, `thread_goals`; in `queue_1` `queued_items`,
    `queued_thread_revisions`; in `memories_1` `stage1_outputs`; in `logs_2` `logs`
  - tables starting `sqlite_` or `_sqlx_` are left alone
- its own note of databases still to be rebuilt: `<home>/.tarsee-vacuum-pending`

**What Tarsee refuses to start with**: a `config.toml` in the home with a root entry outside its allowlist, any
`.env` in the home, the workspace's `.codex/config.toml` with such an entry, and `auth.json` in the keys home
[src: `engine-env.js codexConfigGuard`, `homeIsolationRefusal`].

## 9. NOT CONFIRMED, in one place

| What | What was tried |
|---|---|
| The real `codex` on Linux and macOS: its reaction to `SIGTERM`, its stderr wording there | Only the Windows build is installed. The SDK's side was captured on Linux with a stub; the Node repo's tests assert the rest. |
| macOS: anything | No macOS here. The SDK's code has no macOS branch besides the binary's name; `sweepTurnProcesses`'s `ps` branch is by source only. |
| A crash (panic) of the program: its exit code and stderr | None could be provoked. The SDK's handling of any code or signal was captured with the stub. |
| What OpenAI's and ChatGPT's own servers answer a turn with no credential or an expired sign-in | Captured only against a local fake, which answers anything. |
| `item.updated`, `todo_list`, `web_search` | Declared in the SDK's types and mapped by Tarsee; no capture produced them. |
| The MCP client's parallel tool calls, and behaviour past `tool_timeout_sec` | Not exercised. (That requests made one after another share one connection is confirmed, 4.2.) |
| The real device sign-in: the link's host, the poll interval, the 15-minute expiry | The link is by the Node repo's own earlier capture of the real program; running it again starts a real sign-in. A local stand-in was used for everything else. |
| What `codex logout` contacts | It took about 1 s with the network blocked; the address was not observed. |
| The app-server sending a request of its own; `account` for an API-key sign-in | Not seen in three conversations. |
| A `codex` binary installed outside the npm package finding `rg` by itself | Only the npm package's layout was run. |
| The npm launcher `bin/codex.js` | Read, not run. |
| `archived_sessions/` | By Tarsee's code, and the word is in the program's binary; `codex archive --help` does not name a folder; no thread was archived. |
| Later `--config` wins, for every key | Two observations (two keys) and the SDK's README. One exception was seen: `--model` beats a later `--config model=` (1.4). |
| Which system names, beyond `SYSTEMROOT`, a Windows turn that runs shell commands needs in its environment | A PowerShell command ran with `SYSTEMROOT`, `PATH`, `TEMP` and `USERPROFILE` beside Tarsee's own names (1.6); which of the three it needed was not narrowed down. |
| What the program does with `model_auto_compact_token_limit=0` | The value was seen on the command line; no turn was run with it. |
| Why Node copies eleven names into the child on Windows, and why a program Node started dies with it there | Both observed exactly, and both found in libuv's `src/win/process.c` on its `v1.x` branch (1.6, 5.3). The copy of libuv inside the Node that was used was not read. |
| How the real program ends what it started when it is terminated on Windows | The fact was seen three times (5.2). The reason the Node source gives (the program's own job object) was not looked into, and only a command run through the program's pseudo-terminal tool was tried. |
| A Rust server's own kill-on-close job object around `codex` | Not tried. Under Node the program runs inside libuv's and works; whether a job made by a Rust server behaves the same with the program's own handling of what it starts is not known. |
| What becomes of a running `codex` on Linux when its server is killed | Not tried, for Node or for Rust. |
| What the real program does between being started and being ended when the stop had already fired | Not looked at; with a stub nothing was written (5.1). |
| Why `resume` of an id the program does not have takes 7 to 9 s, and what it does in that time | Timed twice with every address but this machine's blocked (6, 1.3); not looked into. |
| U+0085, U+2028 and U+2029 raw in a `--config` string | The SDK writes them raw (1.4); they were not given to the real program. |
| The real program on a command line near Windows' limit | A stub was started with 31,600 characters (1.7); the real program was not. |

## 10. Noticed on the way

Not part of the protocol, but the engineer porting the engine will meet them:

- **An empty prompt with pictures.** `promptText()` can be empty while `imageBlocks()` is not; the input is then
  `[{text: ""}, pictures...]`, stdin gets 0 bytes, and the program exits 1 with "No prompt provided via stdin."
  (2). The Node engine does not guard against it. Whether the turn layer can produce that input was not checked.
  More exactly: stdin is empty only when the person's words and the volatile part are both blank (a volatile
  part alone makes `<turn-context>…</turn-context>\n\n`, which the program takes as a prompt), and a prompt of
  white space only fails like an empty one. With no user message at all and no volatile part the Node engine
  did start the program with 0 bytes [chk: checked-08-node-engine.json `e12`].
- **The instructions' cap is not the argument's limit.** Text full of quotes, backslashes or control characters
  grows when it is written as an argument, and at the cap it can pass the system's limit; the start then fails
  with `spawn ENAMETOOLONG` (Windows) or `spawn E2BIG` (Linux) and the Node engine reports an unknown problem
  (1.7).
- **A prompt nobody reads takes the Node server down, unless something catches it.** The SDK listens for no
  error on the program's stdin (2).
- **On Windows the Node version's `codex` never outlived the server; a Rust server's will, unless it arranges
  otherwise** (5.3).
- **A stored thread id that is not a UUID does not fail to resume: it quietly starts a new thread** (1.3). The
  sign is a `thread.started` with another id. The Node engine stores that new id and carries on; it does not
  hand the conversation over, because nothing told it the old thread was not picked up.
- **How a command is shown.** `codex-events.js unwrapShellCommand` takes the program's wrapper off a
  `command_execution` item's `command`. On Windows, for a command with `$` and single quotes in it, what is left
  still has the program's quoting in it: the model asked for `... -LiteralPath '<path>' -Value $i; ...` and
  Tarsee shows `... -LiteralPath '"'<path, backslashes doubled>' -Value "'$i; ...`. A command with no `$` came
  out as asked [chk: checked-06-real-program.json `howTarseeShowsTheCommands`]. Display only; the port
  (`codex_events.rs`) copies it.
- **`TARSEE_COMPACT_WINDOW=off`** makes `model_auto_compact_token_limit=0` on the command line:
  `compactWindowTokens("off")` is `null` and `Math.min(null, n)` is `0`
  [checked by running `buildCodexOptions`]. What the program does with 0 was not tested.
- **JavaScript orders integer-like keys first.** The order of `--config` pairs follows the object's key order,
  which for keys like `"10"` is numeric order before insertion order. No key Tarsee writes is like that; a Rust
  map that keeps insertion order matches.

## 11. The fixtures

`tests/fixtures/codex-cli/README.md` describes the format and how to remake them. The `checked/` folder (the
independent re-capture, 13) is listed by file in 13 and described in the README. By section:

| Section | Fixtures |
|---|---|
| 1.2 program | sdk/sdk-06, sdk-07, sdk-16; posix/posix-08; other/other-07 |
| 1.3 arguments | turns/01 to 13; sdk/sdk-02 to sdk-05 |
| 1.4 config | sdk/sdk-01; real/real-07 |
| 1.6 environment | turns/*; sdk/sdk-04, sdk-06, sdk-19; posix/posix-01, posix-02; real/real-11 |
| 2 stdin, pictures | turns/06, 08, 09; sdk/sdk-02, sdk-20; real/real-09, real-11 |
| 3 stdout, stderr | real/real-01, real-02, real-03; sdk/sdk-08 to sdk-14, sdk-17 |
| 4 MCP | real/real-01, real-03, real-08; other/other-06, other-08 |
| 5 stop | sdk/sdk-15, sdk-21; posix/posix-03, 04, 06, 07, 09; real/real-10 |
| 6 failures | real/real-04 to real-08, real-11, real-12; sdk/sdk-11 to sdk-18; posix/posix-05; turns/14, 15 |
| 7 sign-in, model list | other/other-01 to other-05 |
| 8 sessions | real/real-01, real-02, real-13 |
| 12 the engine's turn | checked/checked-08; turns/14, 15 |
| 13 the independent check | checked/checked-01 to checked-08 |

## 12. The Node engine's turn, from start to finish

[src: `providers/codex.js run()`, read whole; chk: checked-08-node-engine.json, where `run()` itself was driven
through the real SDK to a stub for every way out named below]

Sections 1.5, 2, 3.3 and 5.3 each give a part of what the engine does around the program. This is the whole of
it in the order it happens, added when the document was checked, because the parts left the order, three of the
checks before the start, and the events at each way out to be guessed. The events are Tarsee's own (`{type:
"text" | "tool_use" | "tool_result" | "step" | "usage" | "error" | "done", ...}`), the ones `ai/turn.js` reads.

### 12.1 What the engine is given

| `run(opts)` | Use |
|---|---|
| `target {provider or providerId, model, effort}` | the provider, the model and the effort (1.5) |
| `messages` | the prompt is the last `user` message's words (2) |
| `systemParts {stable, volatile}`, or `systemPrompt` | two forms. With `systemParts` (an object) `stable` goes into `developer_instructions` and `volatile` in front of the prompt. With `systemPrompt` (a string) all of it is the stable part and there is no volatile part |
| `signal` | Stop |
| `toolCtx {settingsStore, conversationId, ...}` | the settings read (`ai.local.baseUrl`, `ai.openrouter.appTitle`, `ai.openrouter.referer`, `session.<conversationId>.instrHash`, the provider's stored key through `getKeyWithSource(<the entry's storageId>).key`), and what a tools grant is made from |
| `sessionHandle`, or `sessionId` | the thread to resume (step 8) |
| `onSessionHandle`, `onSessionId` | each is called once, with the thread's handle, at `thread.started` (when both are the same function, once) |
| `maxTurns` | the cap on tools started (5.3); default 50 |
| `thinkingSummaries` | `model_reasoning_summary` (1.5) |
| `media` | the pictures (2) |
| `mcpGrant {url, token}` | the tools' grant from the turn layer; without one the engine makes its own (step 3) |
| `turnId` | for the grant and the log line; default 12 random hex characters |
| `cwd` | the workspace; else `config.CLAUDE_WORKSPACE_DIR`, else the server's own folder |

A cost limit (`maxBudgetUsd`) is never given to Codex. The provider's key is the stored one, else the server's
variable named by the entry's `envKey`.

### 12.2 The order

A **refusal** is three events and nothing started: `{type: "text", content: <message>}`, `{type: "error",
message, code: <kind>, subtype: <kind>, recoverable: false}`, `{type: "done", stopReason: "error"}`. The kind and
the message come from `engine-errors.js classifyEngineError(provider, "codex", {code, message})` on the
`CredentialError`'s code and message [cap: turns/14, 15; chk `e11`: `needs-key`, "OpenRouter needs its API key
(Settings > AI, or the OPENROUTER_API_KEY variable)."].

1. A provider that does not run on Codex: refusal, `wrong-engine`, "<label> doesn't run on Codex.".
2. The turn's mark: 12 random bytes as 24 hex characters (1.6, 5.3). The turn is added to the list the exit
   hook walks (5.3).
3. The tools' grant: `opts.mcpGrant` when it has a `url`; else `mcp-http.js grantTurn({...toolCtx, turnId,
   provider}, {turnId, signal})`, revoked in step 16. If that fails: refusal, `needs-mcp-token`, "Tarsee's tools
   couldn't be opened for this turn: <why>".
4. The instructions: the preamble (`preamble.js buildPreamble({engine: "codex", cwd: <workspace>})`; if it
   cannot be built, a warning is logged and it is left out), the workspace's section, and the stable part; each
   trimmed, the empty ones dropped, the rest joined with a blank line (`"\n\n"`). The workspace's section is
   `<workspace>/CLAUDE.md` read as UTF-8, a byte-order mark taken off, trimmed; when anything is left,
   `## Workspace instructions (CLAUDE.md)\n\n` and the text, cut to 12 KiB by `lib/workspace-files.js
   truncateContent` (the first 70 % and the last 20 % of the limit, in whole characters, with
   `\n\n... [truncated — file too large] ...\n\n` between). A missing or unreadable file gives no section.
   [chk `e1`: `developer_instructions="PREAMBLE\n\nSTABLE PROMPT"`]
5. Local AI only: the owner's address (`ai.local.baseUrl`, else `TARSEE_LOCAL_AI_URL`) and key are checked
   (`hostFor`, `checkedProviderKey`) and a turn is opened on the bridge (`local-bridge.js localBridge().open({
   upstream, key})`, giving `{url, token, release()}`); if that fails: refusal, `needs-setup`, "Tarsee's Local AI
   bridge couldn't start: <why>".
6. The options (`buildCodexOptions`, 1.5 and 1.6) and the program (1.2). Any `CredentialError`: refusal.
7. The home: made with its parents, mode 0700, and set to 0700 if it was there (`ensureHome`); if that fails:
   refusal, `needs-setup`, "Codex's folder <home> couldn't be made: <why>". Then the two guards of 8's last
   paragraph (`homeIsolationRefusal`, `codexConfigGuard` on the home's `config.toml` and `.env` and the
   workspace's `.codex/config.toml`); either refuses with `credential-isolation`.
8. Resume or not. The thread to resume is: from `sessionHandle`, the raw id when the handle is this provider's,
   this home's and this maker's (1.5), else none; with no `sessionHandle`, a `sessionId` that has the handle's
   form is treated the same way and any other is taken as the raw id. With a thread to resume:
   - **Other instructions.** When there is a conversation id and a settings store, and the setting
     `session.<conversationId>.instrHash` is not the hash of this turn's `developer_instructions` (SHA-256 of the
     capped text as UTF-8, in hex, its first 32 characters; a setting that is missing counts as different), the
     turn ends before anything starts with `{type: "error", message: "This chat's Codex session was started
     with other instructions, so a fresh one starts with the conversation handed over.", code: "session",
     subtype: "session", recoverable: true}`, `{type: "done", stopReason: "error"}` [chk `e6b`]. The turn layer
     then starts a fresh thread and hands the chat over. (Codex keeps a resumed thread's first instructions.)
     The hash of `PREAMBLE\n\nSTABLE PROMPT` (a real line break twice) is `c60753fcf4b08d1a54ec02494ca0b361`.
   - **Too big.** When the thread's rollout is found (8) and is bigger than `TARSEE_SESSION_JSONL_MAX_MB`
     megabytes (default 8; the size in bytes over 1,048,576 is compared): the same two events with "This chat's
     Codex session grew past <cap> MB, so a fresh one starts with the conversation handed over.".
   - **The usage so far.** The rollout's last `total_token_usage` (8) is the baseline. A rollout read to its
     start with no total in it is a baseline of nothing. A rollout that is not found, cannot be read, or has its
     last total further back than the cap, leaves the baseline **not known**: a warning is logged and the turn
     gives no usage at all, since Codex's total would count the earlier turns again [chk `e6a`: no `usage`
     event].
9. The prompt and the pictures (2). The pictures are written now.
10. ChatGPT only, the start gate, so that two turns never renew the same sign-in at once. The sign-in is "due"
    when the home's `auth.json` can be read as JSON and its `last_refresh` is not a date or is 7 days old or
    more (a file that is missing or not JSON is not due). Not due: straight through. Due: turns on that home
    wait in line, each for the one in front; a turn stopped while it waits leaves the line at once; a turn whose
    wait is over looks again (the one in front may have renewed it) and, if it is still due, holds the gate
    until its first event after `turn.started` that is not an `error` event, or 30 s, or its own end, whichever
    is first [src: `refreshStale`, `acquireDeviceGate`; not run here].
11. A turn whose `signal` has already fired ends here: `{type: "done", stopReason: "aborted"}`, nothing started
    [chk `e5`].
12. Step 7's two guards again (the gate may have waited long enough for another turn to change the home).
13. The start (1.5's call). The SDK is given the engine's own stop signal; the caller's fires it, and so do the
    engine's own stops (5.3). One line is logged: `[codex] turn <turnId>: <provider> <model, or "(Codex's
    default model)">, <"resuming <id>" or "new thread">, <n> picture(s)`.
14. For each event from the program, in this order:
    - `thread.started` with a `thread_id`: the handle (`session-handle.js format({provider, engine: "codex",
      model}, thread_id)`, 1.5) goes to `onSessionHandle` and `onSessionId`; for a new thread the hash of step 8
      is stored under `session.<conversationId>.instrHash`. `turn.started` is noted; the first event after it
      that is not `error` lets the gate of step 10 go.
    - the event is mapped (`codex-events.js mapCodexEvent`, 3.2). Of what comes out, a `done` is held, a `usage`
      event is held, and everything else is given at once.
    - while no `done` is held, the two stops of 5.3 are looked at (the tool count, then the status).
    - once a `done` is held, each further read waits at most 10 s (3.3).

    An error thrown by the SDK ends the reading and is kept.
15. After the reading, the gate is let go, and then:
    - a held `usage` is given, with `context_input_tokens` added to its `usage` when the rollout's last
      `last_token_usage.input_tokens` can be read (8): how full the context was at the last model call
    - a held `done`: if it is not `end_turn` (the turn failed), the turn's share of the rollout's total is given
      first (below); then the `done`. That is the end.
    - no `done` yet: the ending is made by the reason (12.3), given without its `done`; then the turn's share
      of the rollout's total; then the `done`.

    The turn's share of the rollout's total: only when the baseline is known; the rollout of the thread
    (`thread.started`'s id, else the one resumed) is found and its last total read; a `usage` event and a
    `usage` step for the total less the baseline, given only when that is more than nothing, with
    `context_input_tokens` as above. Usage is Tarsee's shape: `input_tokens` is Codex's `input_tokens` less its
    `cached_input_tokens` and `cache_write_input_tokens` (not below 0), `cache_read_input_tokens` is
    `cached_input_tokens`, `cache_creation_input_tokens` is `cache_write_input_tokens`, `output_tokens` as it is;
    a baseline bigger than the total in any field means the count began again, and the whole total is the
    turn's (`codex-events.js usageDelta`, `tarseeUsage`). Seen: 1200 in, 200 of them cached, 30 out gave
    `{input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 30}`.
16. Whatever happened (the end, an error, the reader going away), in this order: the turn leaves the exit
    hook's list; the listener on the caller's signal is taken off; the gate is let go; if the program was started
    and its stream had not ended, the engine's signal is fired and the SDK's stream closed, which ends the
    program (5.1); if the turn was stopped by anyone, or its stream had not ended, the sweep (5.3); the pictures'
    folder is removed; the bridge's turn is released; a grant the engine made itself is revoked.

### 12.3 How a turn ends, and on what

[chk: checked-08-node-engine.json, one scenario for each row but the last]

| The turn | Its last events |
|---|---|
| ends itself (`turn.completed`) | tools still open are closed (`tool_result`, `ok: false`, "Ended without a result."); the `usage` step at once; then, when the program has exited (or 10 s later), the `usage` event and `{type: "done", stopReason: "end_turn"}` [`e1`, `e7`] |
| fails (`turn.failed`, the exit code 1 after it passed over) | open tools closed ("The turn failed before it finished."); `{type: "error", message, code: <kind>, subtype: <kind>, recoverable}`, `{type: "done", stopReason: "error"}` [`e8`: kind `model`]. For the kinds `auth` and `expired`: `{type: "text", content: <message>}`, `{type: "error", message, code: <kind>, subtype: "auth-expired", recoverable: false}`, `{type: "done", stopReason: "auth-expired"}`. The message classified is `turn.failed`'s `error.message`, else the last `error` event's, else "The turn failed." |
| starts more tools than `maxTurns` | the tool over the limit is announced; open tools closed ("Stopped: the turn limit was reached."); `{type: "error", subtype: "error_max_turns", code: "max_turns", recoverable: false, message: "Stopped after <maxTurns> tool steps, the limit for this task. The task needs to be broken into smaller steps."}`, `{type: "done", stopReason: "max_turns"}` [`e3`] |
| is refused by a key provider (401, 402, 403, 404 in an `error` event) | a status step for the retry ("<label> answered 401 Unauthorized. Trying again (1 of 5)."), then as a failed turn with the kept message [`e4`: `auth`, `auth-expired`] |
| is stopped | open tools closed ("Stopped before it finished."); `{type: "done", stopReason: "aborted"}`; no error [`e9`] |
| ends on an error from the SDK with no `done` (the program gone, a thread that cannot be resumed, a line that is not JSON) | open tools closed ("The turn ended before it finished."); then as a failed turn. The words classified are the SDK's text cleaned (3.4), unless the program had reported an `error` event first: then that event's words, except when the SDK's text is a thread that cannot be resumed or a missing program [`e10`: `session`, `recoverable: true`, "**The earlier conversation couldn't be picked up again**, so I'm starting a fresh one."] |
| ends with no word at all (exit 0 and no `done`) | `{type: "error", code: "unknown", recoverable: false, message: "<label> stopped without finishing its reply. Try again."}`, `{type: "done", stopReason: "error"}` [src: `finishCodexEvents`; not run] |

Every turn that got as far as `thread.started` has stored its handle by then, the failed ones too. There is
never more than one `done`.

### 12.4 Every option given to the SDK and every field read back, and where it is

| What | Where |
|---|---|
| `new Codex({env})` | 1.6 |
| `new Codex({config})` | 1.4, 1.5 |
| `new Codex({apiKey})`, `openai` only | 1.6 (`CODEX_API_KEY`), 1.5 (how the key is cleaned) |
| `new Codex({codexPathOverride})` | 1.2 |
| `startThread(options)` / `resumeThread(id, options)` | 1.3 row 18, 1.5, 12.2 step 8 |
| thread `model`, `modelReasoningEffort` | 1.3 rows 6, 14; 1.5 |
| thread `sandboxMode`, `approvalPolicy`, `workingDirectory`, `skipGitRepoCheck`, `networkAccessEnabled`, `webSearchMode`, `additionalDirectories` | 1.3 rows 8, 17, 9, 11, 15, 16, 10; 1.5 |
| `runStreamed(input)` as a string, or `[{type: "text"}, {type: "local_image"}, ...]` | 2; 1.3 row 19 |
| `runStreamed(input, {signal})` | 5.1, 12.2 step 13 |
| read back: the events' iterator (`events[Symbol.asyncIterator]()`, `next()`, `return()`) | 3.1, 3.3, 5.1 |
| read back: `thread.started.thread_id` | 3.2, 12.2 step 14 |
| read back: `item.started`, `item.updated`, `item.completed`: `item.id`, `item.type`, and by type `command`, `aggregated_output`, `exit_code`, `status`; `server`, `tool`, `arguments`, `result.content[].type`, `result.content[].text`, `result.structured_content`, `error.message`; `changes[].path`, `changes[].kind`; `items[].text`, `items[].completed`; `query`; `text`; `message` | 3.2 |
| read back: `turn.completed.usage` (five fields) | 3.2, 12.2 step 15 |
| read back: `turn.failed.error.message`; `error.message` | 3.2, 6, 12.3 |
| read back: what the SDK throws (its `message`; for a stop nothing is read from it) | 5.1, 6 |
| not used by Tarsee: `baseUrl`, `configOverrides`, thread `threadSource`, `webSearchEnabled`, turn `outputSchema`, `cyberAccessProgram`, `thread.run()`, `thread.id` | 1.3 (the rows marked "never") |

Before the check the document had every row of this table. What it did not have was on the engine's own side:
the two forms of the system prompt, the rule for `media`, a `sessionId` without a handle, steps 7, 8 (the
instructions' hash and the unknown baseline), 10 and 12, and the events of 12.3.

## 13. Checked independently

This document was checked before anything was built on it, by someone who had not made the first captures and
did not rely on them. What was done:

- the document read from start to finish, every claim about the command line, the environment, stdin, stdout,
  stopping and errors noted
- Tarsee's own files for this engine read whole (`providers/codex.js`, `providers/codex-options.js`,
  `providers/codex-events.js`, `ai/codex-cli.js`, `ai/codex-models.js`, `ai/engine-env.js`, and the parts of
  `ai/session-handle.js`, `ai/media.js`, `ai/context-limits.js` they lean on), and the SDK's one file; every
  option given to the SDK and every field read back listed and looked up in the document (12.4)
- a second capture made from nothing: a stub of its own (a script named `exec`, run by `node` itself as the
  "program", so the SDK's first argument is what starts it), a script that calls the real SDK directly and
  with Tarsee's own `buildCodexOptions()`, the same on Linux under WSL2, and Tarsee's own `run()` driven to
  every way a turn can end
- the real `codex` 0.167.0 run against a logging MCP server and a scripted stand-in for the Responses API
  written for the check, both on 127.0.0.1, every other address blocked; its `--help` read for every option
  and command the document names; a launcher written in Rust, so that what a Rust `Command` does was seen and
  not inferred
- the document read once more as the engineer who has nothing else, and every place that left a guess (an
  order not given, a value described and not stated, "...", words paraphrased) filled in or marked

No account was signed in to, no key was used and no model was asked anything. The records are
`tests/fixtures/codex-cli/checked/checked-01` to `checked-08`; the scripts are `scripts/checked-*.txt`.

**In numbers** (counted by hand, so read them as "about"): 215 claims were checked, 165 of them by producing
them again and 50 by reading the code or the program's own help. 18 were corrected (13.2). 14 things that were
not in the document were added (13.3). About 50 claims rest on the first capture alone, because repeating them
needs a sign-in file or was outside what this check set out to do (13.4).

### 13.1 Produced again, and the same

| Section | What was produced again | Where |
|---|---|---|
| 1.1 | no shell; three pipes; the working folder not set; not detached; `windowsHide` off; on Linux the caller's process group and session | checked-04 `whatNodeWasAskedToStart`, `linux.noEnvOption`; checked-02 `cwdIsTheCallersOwn` |
| 1.2 | the three npm launchers and `codex.cmd`'s last line; `bin/codex.js` (read); the layout of the 0.167.0 package (`bin/codex.exe`, `codex-package.json`, `codex-path/rg.exe`, `codex-resources/`); `TARSEE_CODEX_BIN`'s two refusals (read); ruling 10 and `codex_on_path` (read) | the Node checkout; source |
| 1.3 | all 19 rows in their order, each with its condition; `resume` after every option and before `--image`; `--thread-source` dropped on a resume; the shortest command line; the 113 arguments of an OpenRouter turn, compared one by one with turns/07: the same option or key at every position, and the six that differ are the six values given differently on purpose (the instructions, the summary, the compact limit, the title, the context window, the effort) | checked-01 `everyOption`, `resumed`, `noOptions`; checked-02 `openrouterNewThread`; checked-06 `help` |
| 1.4 | every flattening rule and every kind of value, the examples to the character; integer-like keys first; the three error texts; a later `--config` winning; the unknown key; the wrong type | checked-01 `everyOption`, `refusedByTheSdk`; checked-06 `refusedArguments` |
| 1.5 | the 15 config items in order for all five providers; the thread options; the model and effort rules; `"concise"` and `"none"`; the two refusals | checked-02; checked-08 `e11` |
| 1.6 | the SDK's three steps on the environment (a copy; the originator kept, set, or set over an empty one; `apiKey` over `CODEX_API_KEY`); nothing inherited on Linux; the eleven names on Windows; `env_clear()`; `SYSTEMROOT`; Tarsee's four names and what is stripped; `originator` and `user-agent` on the request and `originator` in the rollout | checked-01; checked-02; checked-04 `linux.envOption`; checked-07; checked-06 `newThread.requestToTheModel` |
| 1.7 | the two caps, 24,576 and 98,304 bytes | checked-02 `instructionCaps` |
| 2 | texts joined with a blank line; pictures in order; stdin byte for byte (180,050 bytes, the same SHA-256), nothing added; nothing happens until stdin ends; the model gets stdin unchanged; empty stdin exits 1 with those two lines; the `<turn-context>` form; the pictures' folder, names, and removal; `input_image` | checked-05; checked-06 `stdin`, `newThread`, `resumedWithPicture`; checked-08 `e1`, `e2`, `e3` |
| 3.1 | one object per line, `\n`, the last line too, no `\r`; `\r\n` and a last line with no end; a line that is not JSON, a blank one included, is fatal and ends the program; unknown types pass | checked-06 `newThread`; checked-03 `stdoutReading`; checked-04 `linux.badLine` |
| 3.2 | `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`, `turn.failed`, `error`; items `agent_message`, `reasoning`, `error`, `mcp_tool_call`, `command_execution`; the order; the same thread id on a resume; item ids from 0 in each process; the usage as the thread's running total (1,200 then 2,500 for turns of 1,200 and 1,300); `Reconnecting... n/5`; exit code 1 after `turn.failed` | checked-06 `newThread`, `resumedWithPicture`, `mcpToolCall`, `commandThatExits3`, `providerErrors` |
| 3.3, 3.4 | the `done` held for the program's exit, 10 s at most; stderr dropped on exit 0; `Reading prompt from stdin...` | checked-08 `e1`, `e7`; checked-03 `exitCodes`; checked-06 |
| 4 | the six pairs read as a streamable-HTTP server; `mcp list` and `mcp get` send nothing; the three requests, their bodies and headers to the character and in order, before any stdout, on a resumed turn too; no `Origin`, no session id, no GET, no DELETE; `tools/call`; a plain JSON answer is enough; the three failures of 4.4 | checked-06 `newThread.mcp`, `resumedWithPicture.mcpMethods`, `mcpToolCall`, `mcpFailures`, `outsideATurn` |
| 5.1, 5.2 | `AbortError`, `ABORT_ERR`, "The operation was aborted"; the events that had arrived first; the same on a walk-away and on a bad line; Linux: one `SIGTERM`, the program's own child untouched, nothing more when it is ignored; Windows: ended at once; the real program taking its command with it | checked-04; checked-06 `stop`; checked-07 `realProgram` |
| 5.3 | both of the engine's own stops; the sweep called with the turn's mark on a stop and on an unfinished stream, not otherwise; the pictures removed; `done` `aborted` | checked-08 `e3`, `e4`, `e7`, `e9`, `e1` |
| 6 | both texts of the SDK's error; every row but three (the list is under the table), to the word | checked-03; checked-06; checked-04 |
| 7 | `login status` and `logout` with no sign-in, `login status` with an API key; `--device-auth`'s first request; the words in the binary; `mcp`'s subcommands | checked-06 `outsideATurn`, `help`, `stringsInTheProgram` |
| 8 | what a turn leaves in a new home; the rollout's place and name in local time; one file for a resumed thread; version-7 thread ids; a line's four members; the line types; `session_meta`; `token_count` with the running total and the last call | checked-06 `newThread.homeAfter`, `newThread.rollout`, `resumedWithPicture` |

### 13.2 Corrected

| # | Where | What the document said | What is so | Evidence |
|---|---|---|---|---|
| 1 | 5.1; sdk/sdk-21 | with a stop that has already fired "the program is never started" | Node starts it and ends it at once; the stub was ended before it could leave a record, which is what had been read as "never" | checked-04 `signalAlreadyAborted` (Windows and Linux) |
| 2 | 1.4 | a word a setting does not take stops the program before anything else | so for `approval_policy` and `--sandbox`; `model_reasoning_effort="extreme"` ran and went to the model | checked-06 `refusedArguments.badEffortWord` |
| 3 | 3.4 | `Reading prompt from stdin...` is "always, first" on stderr | only on runs that get as far as reading the prompt; a run refused for its arguments or its configuration does not have it | checked-06 `refusedArguments` |
| 4 | 2; 0 | an empty stdin fails | so does one of white space only | checked-06 `stdin.whitespaceOnlyStdin` |
| 5 | 3.1 | `\r\n` counts as one line end | a `\r` alone is a line end for the SDK too; U+2028, U+2029 and U+0085 are not | checked-03 `stdoutReading` |
| 6 | 6 | stderr is "decoded as UTF-8, unchanged" | bytes that are not UTF-8 become U+FFFD; there is no cap | checked-03 `exitCodes` |
| 7 | 4.1 | `mcp list --json` and `mcp get --json` both print `"auth_status"` | `list` does; `get` has no such member | checked-06 `outsideATurn.mcpGet` (and other/other-08 itself) |
| 8 | 8; 9 | `archived_sessions/` is "by `codex archive --help`" | the help names no folder; the word is in the binary and in Tarsee's code | checked-06 `help.archive`, `stringsInTheProgram` |
| 9 | 1.6 | `SYSTEMROOT` "added to the four names of the next table" | the four were `CODEX_HOME`, `TARSEE_MCP_TOKEN`, `TARSEE_PROVIDER_KEY` and `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, not the table's | real/real-11 itself; checked-07 `realProgram` |
| 10 | 1.6 | the PATH step drops "entries equal to the folder" | and empty entries | the SDK file, `prependPathDirs` |
| 11 | 1.6; 7.1 | Tarsee's environment is the server's "minus every credential name (..., ...)" | the rule in full, with the pattern; a vault key named like a provider key stays, one named `CODEX_…` does not | `engine-env.js`; checked-02 `openrouterNewThread.environment` |
| 12 | 1.5 | the effort is "one of `low` … `max`, else nothing" | it is trimmed and made lower case first; and on `chatgpt` it is still sent when no model is named | checked-02 `openrouterNewThread`, `chatgptListUnknown` |
| 13 | 1.5 | `model_auto_compact_token_limit` = "an integer"; `model_context_window=<n>`; `.env_key` always | the formula; both only when the context is known; `.env_key` only when the key variable is set | `codex-options.js`; checked-02 |
| 14 | 5.2 | the real program takes what it started with it because of its own job object | the fact stands, seen three times; the reason is the Node source's comment and is NOT CONFIRMED | checked-06 `stop`; checked-07 `realProgram.stopWithACommandRunning` |
| 15 | 1.6; 9 | why Node copies eleven names: "the mechanism inside Node was not read" | it is libuv's list, `required_vars`, with the reason beside it; read on libuv's `v1.x` branch | 1.6 |
| 16 | 4.4; 9 | whether the MCP client reuses one connection: NOT CONFIRMED | it does, for requests made one after another | checked-06 `newThread.mcpDistinctConnections`, `mcpToolCall.mcpDistinctConnections` |
| 17 | 7.2 | `login status` and `logout` "both leave" the two lock files and `tmp/` | in a home that was empty, `login status` left only `tmp/` | checked-06 `outsideATurn` |
| 18 | 6; 2; 1.4 | words given in part (the two exit-code-2 texts, the unknown key's item, the pictures' extensions "...") | given whole | checked-06 `refusedArguments`; `ai/media.js` |

### 13.3 Added: what the document did not have

| Where | What | Evidence |
|---|---|---|
| 2; 0 | the write to stdin can fail when the program exits first: an error nobody handles in the Node server, `BrokenPipe` in Rust; ignore it and report the exit | checked-05; checked-07 `stdinWriteToAProgramThatExited` |
| 1.1; 5.3; 0 | on Windows a program Node started dies with the Node process, however that ends; one started by a Rust `Command` does not | checked-07 `whenTheParentIsKilled` |
| 1.7 | the instructions' cap is on the text and the limit on the escaped argument: `spawn ENAMETOOLONG`, `spawn E2BIG`, and Rust's own error | checked-02 `instructionCaps`; checked-05 `linux.instructionsAtTheLinuxCap`; checked-07 `commandLineTooLong` |
| 1.3 | `--image` takes several values on `exec`, so it must stay last | checked-06 `help.exec` |
| 1.3; 6 | `resume` with an id that is not a UUID is not refused: a new thread starts | checked-06 `resumeNotAUuid` |
| 2; 6 | a picture file that is not there is not an error; the model is shown the picture's path | checked-06 `stdin.pictureFileMissing`, `resumedWithPicture.modelInput` |
| 4.2; 4.4 | an endpoint that takes the request and does not answer; `structuredContent` replacing the text the model gets; `reasoning_effort` in the call's metadata | checked-06 `mcpFailures.endpointSilent`, `mcpToolCall` |
| 1.1; 6 | what a Rust `Command` returns when it cannot start the program, and that the ported classifier needs `spawn <path> ENOENT` to know a missing program | checked-07; checked-08 `classified` |
| 6 | the rows for 429, 500, 400 against 404, a `SIGTERM` the program handles, the over-long command line, the unread prompt | checked-06 `providerErrors`; checked-04 `linux` |
| 3.1 | three things the SDK does with lines the program never writes, not to be copied | checked-03 `stdoutReading` |
| 1.4 | `--model` beats a later `--config model=`; an unquoted string still arrives | checked-06 `refusedArguments` |
| 5.3 | what the tool count counts and when it stops the turn; the two patterns of the refused-key stop | `codex-events.js`; checked-08 `e3`, `e4` |
| 12 | the engine's whole order: the two forms of the system prompt, the rule for `media`, the home made with mode 0700, the instructions' hash, the unknown baseline, the ChatGPT start gate, the second look at the home, and the events at every way out | `providers/codex.js`; checked-08 |
| 10 | how a Windows command with `$` and quotes in it is shown; a non-UUID id resuming nothing | checked-06 `howTarseeShowsTheCommands` |

### 13.4 Not produced again: the first capture stands alone

For each of these the code was read where the claim is about Tarsee's or the SDK's code, and agrees; the
capture itself was not repeated.

- the real program with no credential (`real/real-05`), and everything that needs a ChatGPT sign-in file: two
  rows of 7.2, the six sign-in runs of 7.3 (`other/other-05`), the app-server's three conversations of 7.4
  (`other/other-01` to `other-03`), `models_cache.json`
- `--add-dir` in front of `resume` on the real program (the check's turns had no `--add-dir`); the word lists of
  `model_reasoning_summary` and `forced_login_method`; U+007F in a value given to the real program
- ripgrep with and without the `codex-path` folder; the originator variable left out (`codex_exec`)
- `killTree()` (`posix/posix-09`, `real/real-10`); the Windows `.cmd` launcher (`other/other-07`)
- Tarsee's own MCP endpoint's answers (`other/other-06`); the databases' tables (`real/real-13`)
- the SDK's own pinned binary and its PATH step (`sdk/sdk-06`, `sdk-07`, `posix/posix-08`); a program ended by
  `taskkill` from outside (`sdk/sdk-18`)

### 13.5 Still NOT CONFIRMED

Section 9 is the list. From this check it lost two entries (why Node copies the eleven names; whether the MCP
client reuses a connection) and gained these: how the real program ends what it started on Windows, and whether
a command not run through its pseudo-terminal goes too; a Rust server's own job object around `codex`; a
running `codex` on Linux when its server is killed; what the real program does in the moments before it is
ended when the stop had already fired; why `resume` of an id it does not have, and the first turn in a new
home, can take 7 to 10 s; U+0085, U+2028 and U+2029 in a value given to the real program; the real program on a
command line near Windows' limit. And everything about the real `codex` on Linux and macOS is as it was: only
the Windows build was to hand.
