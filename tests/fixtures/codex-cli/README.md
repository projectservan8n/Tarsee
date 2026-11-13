# Captures of how `codex` is started and what it answers

These files are the evidence behind `docs/rust-port/engines/codex-cli-protocol.md`: what the Node version's Codex
engine, through `@openai/codex-sdk` 0.167.0, hands the `codex` program (`@openai/codex` 0.167.0), and what the
program does back. The Rust engine starts the program itself, so its tests can compare against these.

Nothing here came from a real account. No sign-in was made, no real key was used, and no model was asked anything:
the model was a local fake of the Responses API, the sign-in server a local stand-in, Tarsee's MCP server a local
logger, and every other address a proxy that is not there. Every key and token in the capture scripts is built from
parts (`"sk-" + "test-not-a-key-..."`) and replaced in the fixtures.

## The folders

| Folder | What ran | Where |
|---|---|---|
| `turns/` | Tarsee's own engine (`src/ai/providers/codex.js run()`), the real SDK, and a stub in place of the program. One file per combination of options. | Windows 11 |
| `sdk/` | The real SDK called directly, same stub: every option the SDK has, how `config` becomes arguments, the environment, stdout handling, exit codes, abort. | Windows 11 |
| `posix/` | The same questions where Linux answers differently: the environment, signals, process groups, PATH. | Linux (WSL2, Ubuntu), Node 22 |
| `real/` | The real `codex` 0.167.0, started with exactly the arguments, environment and stdin the SDK produced, against local servers. | Windows 11 |
| `other/` | The real program as Tarsee starts it without the SDK (`login status`, `logout`, `login --device-auth`, `app-server`), and three probes. | Windows 11 |
| `checked/` | An independent second capture, made when the document was checked (its section 13): another stub, other stand-ins for the model and the MCP server, a launcher in Rust, Tarsee's own engine run end to end. Eight files, one per subject. | Windows 11; Linux (WSL2, Ubuntu), Node 22 |
| `scripts/` | The scripts that made all of the above, and the stub's source, as `.txt` so nothing in the repo runs them. The second capture's are the ones named `checked-*`. | |

## What is in a file

Every file is one JSON object with `name`, `what` (one paragraph: what the capture shows) and `made_with`.

**`turns/NN-*.json`**

- `turn`: what the turn layer gave the engine (`target`, `messages`, `systemParts`, `sessionHandle`, `pictures`,
  the settings and the server's environment names)
- `sdk`: what the engine gave the SDK: `"new Codex(options)"` (the `env`, `config`, `apiKey`,
  `codexPathOverride`), `thread` (`startThread` or `resumeThread`, with the thread options) and
  `"runStreamed(input, turnOptions)"`
- `child`: what the stub was started with: `argv` (everything after the program's name, in order), `cwd`,
  `envNames` (every name), `envValues` (the values of the names that matter), `serverEnvNamesNotPassed` (names
  the server's environment had and the child did not get), `stdin` (`text`, `bytes`, the `chunks` as they
  arrived with their offsets in ms since the stub started, and `eof_at_ms`), `pictureFiles`
- `stubStdout`: the lines the stub played back; `tarseeEvents`: what the engine yielded for them
- `14` and `15` are turns the engine refuses before starting anything: `sdk` and `child` are `null`

**`sdk/sdk-NN-*.json`, `posix/posix-NN-*.json`**: `sdk` (the options given), `child` (as above), `stub` (what the
stub was told to print and how to exit), `sdkYielded` (the events the SDK handed over), `sdkThrew` (`name`,
`message`, `code`, `cause`), and where it applies `abort`, `timing`, `signalsTheStubReceived`,
`programAfterTheError`, `theStubsOwnChild`.

**`real/real-NN-*.json`**: `child` (the arguments, environment names and stdin the real program got), `result`
(`exitCode`, `stdoutLines` exactly as printed, `stderr`), `requestsToTheMcpServer` (method, path, HTTP version,
headers in the order sent, body, and the answer given), `requestsToTheModel` (a summary), and for failures
`whatTheSdkThrows` (the text the SDK builds from the exit code and stderr).
`real-12` is different: it is what the Node version's classifier makes of each failure's words.
`real-13` is the Codex home after two turns: the rollout's line types and the databases' thread tables.

**`other/other-NN-*.json`**: `argv`, `envNames`, `cwd`; for the app-server a `transcript` of every line in both
directions with its time; for the sign-in the `output` in arrival order with the stream each piece came on, the
`exit`, the `auth.json` written and the requests the stand-in received.

**`checked/checked-NN-*.json`**: one file per subject, each a set of named scenarios (the document cites them as
``checked-06-real-program.json `stdin.whitespaceOnlyStdin` ``). Where the two captures looked at the same thing
they agree, with one exception, which `sdk/sdk-21` now says of itself (`corrected`).

| File | What is in it |
|---|---|
| `checked-01-sdk-arguments.json` | the SDK called directly: every option, awkward config values, the environment with and without `env`, what the SDK refuses before it starts anything, a program that is not there |
| `checked-02-tarsee-options.json` | `buildCodexOptions()` for each provider handed to the SDK as `providers/codex.js` hands it: arguments, stdin, the environment; the instructions' cap against the command line's limit |
| `checked-03-sdk-stdout-and-exit.json` | what the SDK makes of stdout of every shape and of every way of exiting |
| `checked-04-sdk-stop.json` | abort in the middle, abort before the start, the caller walking away; Windows and Linux |
| `checked-05-sdk-stdin.json` | stdin byte for byte; a program that exits before it reads its prompt; on Linux an argument past the limit |
| `checked-06-real-program.json` | the real program: its help, a new thread, a resumed one with a picture, an MCP tool call, stdin of every kind, refused arguments, MCP failures, the model's server refusing, stop, the commands outside a turn that need no sign-in |
| `checked-07-rust-command.json` | a Rust `std::process::Command` on Windows: arguments, `env_clear()`, errors from `spawn()`, `Child::kill()`, a broken stdin; the real program started that way; what becomes of a child when its parent is killed |
| `checked-08-node-engine.json` | `providers/codex.js run()` driven to every way a turn can end, with the events it yields; and what the classifier makes of each failure text |

The times in `checked-08` (`atMs`) are since `run()` was called. The keys and tokens in these files
(`sk-check-not-a-key`, `mcp-check-token`, `sk-or-quoted-key` and the like) are made-up words, left readable
because several scenarios are about how a key is cleaned.

## Placeholders

Paths, tokens and anything of the machine's own are replaced, in every spelling they took (either slash,
JSON-escaped once or more):

| Placeholder | Stands for |
|---|---|
| `<STATE_DIR>`, `<WORKSPACE>`, `<RUN_DIR>` | the run's state folder (`config.STATE_DIR`), the agent's workspace, the run's own folder |
| `<CODEX_HOME>` | the Codex home (`<STATE_DIR>/.codex-home` or `.codex-home-keys`) |
| `<CODEX_BIN>` | the program that was started (the stub, or the real `codex`) |
| `<CODEX_PATH_DIR>` | the `codex-path` folder of the npm package the real program is in |
| `<NODE_MODULES>` | a made-up `node_modules` holding a copy of the SDK's file and the stub as its "pinned binary" |
| `<TARSEE_SKILLS_DIR>`, `<TARSEE_ROOT>` | Tarsee's bundled skills folder, the Node checkout |
| `<TMP>`, `<USER_HOME>`, `<HOME>`, `<SERVER_CWD>`, `<CALLER_CWD>`, `<SCRATCH>`, `<RUNS>` | the temp folder, the user's home, the working folder of the process that started the program, the capture's own folders |
| `<MCP_TOKEN>`, `<OPENAI_KEY>`, `<OPENROUTER_KEY>`, `<DEEPSEEK_KEY>`, `<PROVIDER_KEY>`, `<API_KEY>`, `<LOCAL_AI_OWNER_KEY>`, `<VAULT_VALUE>` | the made-up secrets |
| `<BRIDGE_TOKEN>`, `<BRIDGE_PORT>`, `<BRIDGE_TURN_ID>` | the Local AI bridge's per-turn token and address |
| `<TURN_MARK>` | the value of `TARSEE_CODEX_TURN` (24 hex characters, new each turn) |
| `<THREAD_ID>` | the thread id the real program made |
| `<ACCESS_TOKEN>`, `<ID_TOKEN>`, `<REFRESH_TOKEN>`, `<CODEX_CLIENT_ID>`, `<LOGIN_OWNER_ID>` | parts of a made-up ChatGPT sign-in |
| `<PORT>`, `<MODEL_PORT>`, `<MCP_PORT>`, `<MACHINE_NAME>`, `<INSTALLATION_ID>`, `<RANDOM>` | what they say |
| `<NODE>`, `<SYSTEMROOT>`, `<SYSTEM>`, `<TIMEZONE>`, `<TID>` | in `checked/` only: the `node` program used as the stub's runner, the Windows folder, the system's name and version inside a `user-agent`, the machine's time zone, the made-up thread id in a log line |

Times (`at_ms`, `*_ms`) are what one run measured on one machine. Their order is the fact; their size is not.

## The stub

The SDK starts the program with no shell, so the stand-in has to be a program:

- Windows: `scripts/codex-stub.rs.txt`, a Rust program with no dependencies (`rustc -O codex-stub.rs`). Node will
  not start a `.cmd` launcher without a shell, and a `.cmd` changes the arguments (see `other/other-07`).
- Linux: `scripts/codex-stub.mjs.txt`, an executable Node script.

Either reads nothing from its arguments or environment (so neither is changed by the capture). What it does comes
from a folder called `plan` next to it: where to write its record (argument list, working folder, environment,
stdin with arrival times), which lines to print on stdout once stdin has ended, what to print on stderr, how long
to stay alive, and which exit code to use. The Linux one also logs the signals it receives.

## Making them again

After a bump of `@openai/codex-sdk` or `@openai/codex` in the Node version, from a checkout of it that has
`node_modules` (the scripts only read it):

```
export CAPTURE_PROJECT=/path/to/the/node/checkout
export CAPTURE_SCRATCH=/path/to/a/scratch/folder          # not inside either repository

# once: the stubs and the helper (copy the scripts out of scripts/, dropping .txt)
rustc -O codex-stub.rs -o "$CAPTURE_SCRATCH/stub/codex-stub.exe"          # Windows
rustc -O bare-env.rs   -o "$CAPTURE_SCRATCH/bare/bare-env.exe"            # Windows
cp codex-stub.mjs capture-posix.mjs "$CAPTURE_SCRATCH/posix/" && chmod +x "$CAPTURE_SCRATCH/posix/codex-stub.mjs"

node capture-turns.mjs          # -> $CAPTURE_SCRATCH/fixtures        (turns/)
node capture-sdk.mjs            # -> fixtures-sdk                     (sdk/)
node capture-real.mjs           # -> fixtures-real                    (real/01 to 11)
node inspect-home.mjs           # -> fixtures-real/real-13            (after capture-real)
node classify-failures.mjs      # -> fixtures-real/real-12            (after capture-real and capture-sdk)
node capture-other.mjs          # -> fixtures-other                   (other/01 to 05, 08)
node probe-mcp-endpoint.mjs     # -> fixtures-other/other-06
node try-cmd-shim.mjs           # -> fixtures-other/other-07          (Windows)
node posix/capture-posix.mjs    # -> fixtures-posix                   (posix/), on Linux or under WSL
```

The second capture (`checked/`) is made by its own scripts, from the same two variables (under WSL give
`posix` the same two folders as WSL names them):

```
# once: the stub and the launcher (copy the scripts out of scripts/, dropping checked- and .txt)
mkdir -p "$CAPTURE_SCRATCH/stub" "$CAPTURE_SCRATCH/rs"
cp stub-exec.js "$CAPTURE_SCRATCH/stub/exec"                    # no extension: node runs it as `node exec ...`
rustc -O launch.rs -o "$CAPTURE_SCRATCH/rs/launch.exe"          # Windows

cd "$CAPTURE_SCRATCH"            # the scripts sit here and write their records to ./out
node capture.mjs                 # the SDK and Tarsee's options, to the stub       (checked-01 to 05, Windows half)
node real.mjs                    # the real program; r2 needs r1 in the same run   (checked-06, 07)
node rust-checks.mjs             # the Rust Command                                (checked-07)
node orphan.mjs                  # a killed parent                                 (checked-07)
node engine.mjs                  # providers/codex.js run()                        (checked-08)
node classify.mjs && node unwrap.mjs
node posix.mjs                   # under WSL                                       (checked-04, 05, Linux half)
FIXTURES_DEST=/path/to/tests/fixtures/codex-cli/checked node make-fixtures.mjs
```

`capture.mjs`, `real.mjs` and `engine.mjs` take scenario names (`a8`, `r5`, `e3`) to run only those. The stub
here is not a program of its own: the SDK is given `node` as the program, `node` takes the first argument
(`exec`) as the script to run in the working folder, and everything after it arrives untouched. `make-fixtures`
replaces everything of the machine's own with the placeholders above.

Each script takes scenario names (or parts of them) to run only those. The scripts point `TARSEE_STATE_DIR`, the
temp folder and the user's home into the scratch folder before any of Tarsee's modules load, and give the real
program a Codex home of its own there, so nothing of the machine's own Codex or Tarsee is read or written.

What each script covers is in the comment at its top. Three things the scripts do that Tarsee does not, each said
again in the fixture it touches:

- `capture-other.mjs` passes the program's hidden `--experimental_issuer <local address>` to `login
  --device-auth`, so the sign-in goes to a local stand-in. The link the program prints then has that host instead
  of `https://auth.openai.com`.
- For the app-server with a made-up sign-in it adds two `-c` overrides (`chatgpt_base_url`, `openai_base_url`)
  and `SSL_CERT_FILE`, so the made-up token goes to a local stand-in for ChatGPT's backend.
- The real program's model is the Node repo's fake Responses server (`test/fixtures/fake-responses.js`), reached
  through Tarsee's test-only seam (`NODE_ENV=test`, `TARSEE_TEST_BASE_URL_*`), which is why those names show in
  `real/*`'s environment.
