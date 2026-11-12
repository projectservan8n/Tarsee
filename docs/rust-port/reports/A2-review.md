# A2 review: engine environment and Codex CLI basics

Reviewed at the merged code (`74e0e4f`, worktree at `7094777`) against the Node files beside it.

## How it was checked

- **Side-by-side runs of both versions.** One case file was put through the Node modules (`node`, main checkout) and
  through the Rust port (a throwaway test in `tests/it/`, since deleted), and the outputs were compared as JSON. The
  Rust side built its `ProviderEntry`s from a dump of the real `provider-registry.js` (wrong-slot patterns translated
  as the report tells A1 to). The cases:
  - 127 variable names for `isAuthEnvName` and `baseEnv`: mixed case, prefixes, suffixes, `ı`, `ſ`, `ß`, `İ`, NUL and
    line breaks, the strip list.
  - `baseEnv`, `finalizeEnv` and `codexChildEnv` on a server environment full of canaries, with a vault full of them
    too.
  - 50 `claudeEnvFor` and 25 `codexEnvFor` calls on every provider and engine: keys with quotes, Unicode spaces and
    wrong slots; models, tiers and context sizes; titles and referers; the test seam; missing homes and state folders;
    bare ids; entries without an id.
  - 28 `hostFor` calls, including WHATWG URL edge cases.
  - 25 `testBaseUrl` and `codexChatgptTestHosts` calls.
  - 14 `homeFor` and `homeKeyFor` calls.
  - 52 `config.toml` texts through `codexConfigGuard` and `stripCodexConfig`.
  - 36 settings files through `settingsFileGuard`.
  - 23 `.claude.json` texts through `homeIsolationRefusal`, plus 13 home, provider and engine combinations.
  - 34 environments through `costSaverEnv`, `compactWindowTokens` and `effectiveContextWindow`.
  - `stripAnsi`, every constant, and `buildPreamble` for 5 engine values.

  Everything matched except what is listed below.
- **The suite.** `cargo test` on Windows: 818 unit and 57 integration tests, all pass.
- **Linux.** This port's author could not compile the `#[cfg(unix)]` code. The lead's Linux run in WSL, at `1649cf7`
  (B1 merged), shows it compiles: every unit test passes (967), and 2 of the 57 integration tests fail. Both are
  A2's (finding 2). A2's own source and test files are unchanged between `74e0e4f` and `1649cf7`; only the module
  lists in `testkit/mod.rs`, `testbin/main.rs` and `tests/it/main.rs` gained other packages' lines.
- **Windows spawn errors.** Checked with Node and Rust on an `.exe` denied execution with `icacls` (finding 6).
- **Lists compared one by one:** every export, every test case, the reviewed and known CLI variable lists, and the
  registry copy.

## Claims in the report

| Claim | Checked |
|---|---|
| `AUTH_ENV_RE` byte-identical | Holds. The pattern sources are equal, and neither has flags. All 127 names give the same answer in both versions. |
| 106 of 109 cases ported | Holds. engine-env: 73 of 74 (72 `it`, one in a loop of 3). codex-cli: 8 of 8. thread-dbs: 15 of 15. preamble: 5 of 5. leftovers: 3 of 5. cli-env-names: 2 of 2. |
| Preamble byte for byte | Holds for codex, claude-code, none, an unknown engine and "Codex". |
| Difference 6: the guards fail closed on JSON that serde rejects | Holds for the settings guard. **Does not hold for the login-key check** (finding 1). |
| Registry copy is "a copy of the registry's values" | Not quite (finding 7). |
| Risk 3: the Unix code was never compiled | It is now compiled and run (see "How it was checked"). Two tests fail (finding 2). |

## Findings

### 1. The login-key check fails open on JSON that `JSON.parse` reads but `serde_json` refuses — Important

- **Node:** `src/ai/engine-env.js:503-512` (`holdsLoginKey`). **Rust:** `src/ai/engine_env.rs:1036-1056`
  (`holds_login_key`, `LOGIN_KEY_TEXT`).
- **What differs.** When a home's `.claude.json` or `.config.json` fails to parse, both versions fall back to a text
  regex. The two parsers fail on different files: `serde_json` also refuses a lone surrogate escape (`"\ud800"`), a
  number beyond f64 (`1e400`) and nesting past 128 levels, which `JSON.parse` reads. On those files the Rust check
  uses the text regex while Node used the parsed JSON, and the two can disagree in either direction:
  - `{"x":"\ud800","primary\u0041piKey":"sk-ant-k"}` and `{"x":1e400,"primary\u0041piKey":"k"}`: Node refuses the
    turn (credential-isolation); Rust lets it run. The regex needs the literal text `"primaryApiKey"`, and here the
    key name is written with an escape.
  - `{"x":1e400,"primaryApiKey":"\u0020"}`: Node lets the turn run (the key is blank); Rust refuses it.
- **Why it matters.** This is R1's guard against a Console key being sent to a gateway's host. The CLI writes the
  key name unescaped, so a file the CLI wrote is still caught. A hand-made or planted file is not. The report's
  difference 6 says these files "fail closed"; for this check they don't.
- **How confirmed.** Run through both versions with an `exists` that answers false and a `readFile` that returns the
  text. Node returned a refusal and Rust returned `None` for both escaped-name files; the reverse for the blank key.

### 2. Two A2 integration tests fail on Linux: an environment value over 128 KiB — Important

- **Rust:** `tests/it/codex_cli.rs:196-213` (`output_past_the_cap_is_cut_and_the_program_still_runs_to_the_end`)
  passes `TARSEE_TESTBIN_STDERR` of 300,000 bytes. `tests/it/run_cmd.rs:48-64`
  (`output_past_the_cap_is_cut_once_with_a_note`) passes one of 200,000 bytes. These are new tests; Node has no
  counterparts.
- **What differs.** Linux refuses `execve` when a single environment string is over `MAX_ARG_STRLEN` (131,072 bytes)
  and fails with E2BIG. `run_codex` returns `SpawnFailed` ("Codex couldn't start (Argument list too long (os error
  7)).") and `run_cmd` returns code 127. Both tests fail. The test rules require every test to pass on Linux.
- **How confirmed.** The lead's WSL run at `1649cf7` (its `linux-ci.log`): `55 passed; 2 failed`, with exactly these
  two tests and these errors. `git diff 74e0e4f 1649cf7` shows no change to these test files or to the code they run.

### 3. `home_for` reads the real process home when no `home_dir` is given — Important (a rule of the port)

- **Node:** `src/ai/engine-env.js:477` (`homeDir || os.homedir()`). **Rust:** `src/ai/engine_env.rs:962-968` and
  `1590-1592` (`os_homedir()`, which is `config::env::home_dir(&Env::new())`).
- **What differs.** The Rust deliberately passes an empty `Env`, so the foundation helper falls through to
  `std::env::home_dir()`, which reads `$HOME` (or USERPROFILE) of the real process.
- **Why it matters.** DESIGN says no module reads the real environment. A test app whose `Env` sets HOME, or a later
  package that calls `home_for("claude", CLAUDE_CODE, &HomeOpts::default())`, gets the machine's real `~/.claude`.
  Provider status, for example, would then look at the real sign-in file.
- **Note.** The report lists this as difference 7. It is still a broken rule, not a Node difference.
- **How confirmed.** By reading the sources (`src/config/env.rs:163-173`, `src/env.rs:21-24`).

### 4. A trailing lone CR at the end of `config.toml` is read differently — Minor

- **Node:** `src/ai/engine-env.js:701` and `735` (`src.split(/\r?\n/)`). **Rust:** `src/ai/engine_env.rs:1403-1405`
  (`toml_lines` strips a `\r` from every piece, the last one included).
- **What differs.** The split only differs on a last line that ends in CR without a following LF:
  - Node keeps the `\r`. A final header or comment line with it fails the strict reader (`.` doesn't match CR), and
    the file is "can't be read safely".
  - Rust drops the `\r` and reads the line normally.
- **Results:**
  - `[tui]\r`, `# c\r`, `model = 1\n# c\r` and `model = 1\r\r\n[tui]\r`: Node refuses; Rust passes.
  - `[mcp_servers]\r`: Node says unreadable; Rust names `mcp_servers`.
  - `strip_codex_config("model=1\r")`: Node returns the text with its CR; Rust returns it without.
- No entry is hidden: Codex's own TOML parser rejects a lone CR.
- **How confirmed.** Run through both versions.

### 5. The settings guard calls a settings file with a number beyond f64 unreadable — Minor

- **Node:** `src/ai/engine-env.js:587`. **Rust:** `src/ai/engine_env.rs:1235`.
- **What differs.** `{"a":1e309}` and `{"a":-1e400}`: Node passes, and Rust refuses the turn ("can't be read as
  JSON"). `{"env":{"ANTHROPIC_X":1e999}}`: Node names `env.ANTHROPIC_X`, and Rust says unreadable. Both fail
  closed. Difference 6 names only surrogates and nesting.
- **How confirmed.** Run through both versions.

### 6. Spawn failures on Windows are worded differently — Minor

- **Node:** `src/ai/codex-cli.js:197-200` and `209`; `src/lib/run-cmd.js:20-22`. **Rust:** `src/ai/codex_cli.rs:513-519`;
  `src/lib/run_cmd.rs:58-66` and `187-191`.
- **What differs.** Checked on an `.exe` denied execution with `icacls`, and on a folder:

  | Call | Node | Rust |
  |---|---|---|
  | `runCodex(denied exe)` | `spawn-failed` "Codex couldn't start (EPERM)." (spawn throws EPERM synchronously) | `codex-missing`, with the install message (`PermissionDenied` covers EPERM) |
  | `runCmd(denied exe)` | Rejects with "Error: spawn EPERM" | Resolves `{127, "\n[spawn error] Error: spawn <path> EPERM\n"}` |
  | `runCmd("C:\\Windows")` | "Error: spawn C:\\Windows ENOENT" | "... EPERM" |
- **How confirmed.** `node` on the main checkout, and a throwaway Rust test.

### 7. The registry copy in the tests is not a full copy — Minor

- **Node:** `src/ai/provider-registry.js` (claude and anthropic each list 13 models). **Rust:**
  `src/ai/engine_env/tests.rs:89-100` (8 models).
- **What differs.** The copy is missing `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6` and
  `claude-sonnet-4-6`. No test result depends on them today. Everything else (ids, labels, engines, envKey, hosts,
  wrongSlot order and messages, tiers, defaultModel, kind, storageId, PROVIDER_IDS order) matches.
- **How confirmed.** Dumped the Node registry and compared field by field.

### 8. The `(?i)` guidance for A1's wrong-slot patterns folds Unicode; JS `/i` doesn't — Minor

- **Report:** `docs/rust-port/reports/A2.md:30`. **Rust:** `src/ai/engine_env/tests.rs:36-59`.
- **What differs.** Rust's `(?i)` folds `ſ` to `s` and the Kelvin sign `K` to `k`. JS `/i` without `u` does not. Results:
  - The key `ſk-ant-api03-x` on OpenAI: Node accepts it; Rust refuses it ("This is an Anthropic key").
  - The key `sk-` + 20×`K` + `t3blbkfj` + 20×`a` on DeepSeek: Node accepts it; Rust refuses it ("This is an OpenAI key").
- A1 should translate `/…/i` as ASCII-only case folding.
- **How confirmed.** Run through both versions, with the patterns translated as the report says.

### 9. Numbers ≥ 1e21 are written without an exponent — Minor (the foundation's `number_to_string`)

- **Node:** `String(n)`. **Rust:** `src/util/js.rs:85-96`, used at `src/ai/engine_env.rs:695-704` and
  `src/ai/context_limits.rs:86,110`.
- **What differs.** `contextTokens: 1e22` gives CLAUDE_CODE_MAX_CONTEXT_TOKENS "1e+22" in Node and
  "10000000000000000000000" in Rust. TARSEE_TOOL_RESULT_MAX_CHARS=4e21 gives MAX_MCP_OUTPUT_TOKENS "1e+21" in Node and
  "1000000000000000000000" in Rust.
- **How confirmed.** Run through both versions.

### 10. Two ported checks never run by default and read the real environment — Minor

- **Rust:** `tests/it/claude_cli_env_names.rs:237-239` (TARSEE_TEST_CLAUDE_CLI) and `tests/it/codex_cli.rs:250-252`
  (TARSEE_TEST_CODEX).
- **What differs.**
  - These tests read the real environment with `std::env::var_os`. The test rules forbid it.
  - With the variable unset they return early and report "ok". Node reported the CLI scan as skipped, and it ran on
    every `npm test` because the SDK ships the binary.
  - The scan is what catches a new credential variable after a CLI update; in the Rust suite it is off unless
    someone names a CLI.
- **How confirmed.** By reading the sources.

### 11. A rollout whose name isn't UTF-8 is removed in Rust, kept in Node (Unix) — Minor

- **Node:** `src/ai/codex-rollouts.js:20` and `24-25`. **Rust:** `src/ai/codex_rollouts.rs:71-87`.
- **What differs.** Node joins the lossy-decoded name, so the stat fails and an old `rollout-*.jsonl` with invalid
  UTF-8 in its name stays. Rust tests the lossy name but stats and removes the real `OsString` path. Codex writes
  ASCII names, so this has no practical effect.
- **How confirmed.** By reading the sources.

## Completeness

- **Exports.** Every export of `engine-env.js`, `context-limits.js`, `codex-cli.js`, `run-cmd.js`,
  `codex-rollouts.js`, `codex-thread-dbs.js`, `turn-leftovers.js` and `preamble.js` has a counterpart.
  `CODEX_IMAGE_DIR` became `codex_image_dir(&Env)` plus `CODEX_IMAGE_DIR_NAME`.
- **Test cases.** 106 of 109 are ported. The rest are listed with reasons that held at merge time:
  - R8 needs `agentVaultEnv` (B1).
  - Two exit-cleanup cases of `turn-leftovers` need G2 and G3.
- **Partly ported** (reasons hold):
  - The `null` half of "an object without an id", which Rust can't express.
  - The source read of `providers/codex.js`, which is G2's.
  - The `agentVaultEnv` half of "baseEnv is what the vault compares against".
- **B1 is merged now** (`1649cf7`). R8 and the vault half can be ported.
- **Assertions match Node's.** The Rust tests assert what the Node tests did, case by case, and often more (exact
  messages, JSON shapes). The one replaced case, "a codex child's error event never goes unheard", is replaced for a
  reason that holds (a Node-only mechanism).
- **Rules.**
  - No mutable statics; the only statics are regexes.
  - No `unwrap` or `expect` on run-time values outside tests; the only ones are regex literals.
  - The Node comments are carried over.
  - The real-environment reads are findings 3 and 10.

COMPLETE: yes
FAITHFUL: no
