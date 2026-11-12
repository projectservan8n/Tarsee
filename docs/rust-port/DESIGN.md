# Tarsee in Rust: design

Tarsee's server is being rewritten from Node.js to Rust on the branch `rust-rewrite`. This document is the set of
decisions every part of the port follows. `PLAN.md` beside it splits the work into packages; `STATUS.md` records
what is done.

## What is ported, and what is not

**Ported to Rust:** everything that ran in Node: `src/server.js` and the folders `ai`, `channels`, `cli`, `config`,
`daemon`, `db`, `hooks`, `lib`, `middleware`, `routes`, `voice`, `websocket` (about 51,000 lines), and their tests
(about 36,000 lines).

**Kept as they are:**

- **The browser UI** (`src/public/`: HTML, CSS and the JavaScript that runs in the browser). A browser runs
  JavaScript, so this code has nowhere else to go. The Rust server serves the same files, and every route, WebSocket
  message and JSON field they use stays exactly as it was, so the UI does not change at all.
- **The two Python workers** (`src/voice/stt_worker.py`, `src/voice/phonon_worker.py`). They are thin wrappers
  around Python-only speech libraries. Tarsee starts them as before.
- **Skills, workspace defaults and translations** (`src/skills/`, `src/workspace-defaults/`, `src/i18n/`). They are
  data, not code.

**The goal is the same Tarsee.** Same behaviour, same HTTP and WebSocket API, same database (a database made by
either version opens in the other), same environment variables, same files on disk, same stored secrets (what the
Node version encrypted, the Rust version decrypts). Someone who deploys the Rust build over a Node install must not
have to change or redo anything.

## Decisions that differ from the Node version

1. **One program.** The result is a single `tarsee` binary (server and command line). No Node at run time.
2. **The Claude engine starts the `claude` program itself.** The Node version used `@anthropic-ai/claude-agent-sdk`,
   which starts the Claude Code CLI and talks to it in JSON lines. There is no Rust SDK, so `ai/providers/claude_code.rs`
   starts `claude` the same way (`--output-format stream-json --input-format stream-json ...`) and speaks the same
   protocol. The CLI comes from the machine (`claude` on the PATH, or `TARSEE_CLAUDE_PATH`).
3. **The Codex engine starts the `codex` program itself.** `@openai/codex-sdk` did only that
   (`codex exec --experimental-json`); `ai/providers/codex.rs` does it directly (`codex` on the PATH, or
   `TARSEE_CODEX_PATH`).
4. **Tarsee's own tools reach both engines the same way: MCP over HTTP on loopback** (`ai/mcp_http.rs`). The Node
   version gave Claude an in-process SDK server and Codex the loopback endpoint. With no SDK there is no in-process
   server, so Claude is pointed at the same loopback endpoint through `--mcp-config`. Tool names seen by the model
   stay `mcp__tarsee__<tool>`.
5. **Hooks and plugins written in JavaScript cannot be loaded into a Rust process.** The three built-in hooks become
   Rust. A workspace hook file (`workspace/hooks/*.js`) and a plugin (`workspace/plugins/*/index.js`) are found and
   reported, with a clear log line saying they are not run. Workspace hooks get a replacement that needs no
   JavaScript: an executable or script in `workspace/hooks/` with a small JSON manifest, started with the event on
   stdin. This is the one place existing user files stop working, and the release notes must say so.
6. **Browser automation uses the Chrome DevTools Protocol** (`chromiumoxide`) instead of Playwright, driving the
   Chromium or Chrome on the machine (`TARSEE_CHROMIUM_PATH`, Playwright's download if present, else a system
   Chrome, Chromium or Edge).
7. **Channel libraries.** Discord: `serenity`. Telegram: the Bot API over HTTP directly. Slack: Socket Mode over a
   WebSocket plus the Web API over HTTP directly. Email: `async-imap`, `mail-parser`, `lettre`. WhatsApp was already
   plain HTTP.

## Layout

The Rust files mirror the Node files one to one, so anything known about the old code still says where to look:

| Node | Rust |
|---|---|
| `src/ai/turn.js` | `src/ai/turn.rs` |
| `src/ai/providers/claude-code.js` | `src/ai/providers/claude_code.rs` |
| `src/lib/tools.js` | `src/lib/tools.rs` (module `crate::lib::tools`) |
| `src/cli/index.js` | `src/cli/mod.rs` |
| `src/server.js` | `src/server.rs` |
| `test/<name>.test.js` | unit tests inside the module, or `tests/it/<area>.rs` |

A dash in a file name becomes an underscore. Names inside follow Rust's conventions: `readSetting` is
`read_setting`, `SettingsStore` stays `SettingsStore`, `MAX_BUFFER` stays `MAX_BUFFER`. During the port the Node
files stay where they are, side by side with the Rust ones, as the reference. They are removed at the end.

New folders that have no Node counterpart:

- `src/app.rs`, `src/env.rs`, `src/error.rs`, `src/net/`, `src/util/`, `src/testkit/`: the foundation, below.
- `testbin/`: stand-ins for the programs Tarsee starts, for tests.
- `tests/it/`: integration tests.

## The foundation

Read these files before writing anything; they are short and every module uses them.

### `App` (`src/app.rs`): no global state

The Node version kept shared state in module-level variables (`initLiveBus(db)`, `setToolsChannelManager(m)`,
`app.set("settingsStore", s)`). That worked because each Node test file ran in its own process. Rust runs all tests
of a binary in one process, in parallel, so global state would make tests break each other.

**Rule: no `static` that holds state, and no reading of the real environment.** State lives in an `App`:

- `app.config()`: the configuration (`config/env.js`'s default export). `config.STATE_DIR` is `app.config().state_dir`.
- `app.env()`: the environment variables (`process.env`). See `Env` below.
- `app.db()`: the database.
- `app.fetch()`: the HTTP client.
- **Services:** any other shared value, stored once and found by its type.

```rust
// What was `let bus; export function initLiveBus(db) { bus = new LiveBus(db); }`
pub struct LiveBus { /* ... */ }
impl LiveBus {
    /// Creates the live bus and stores it in the app.
    pub fn init(app: &App) -> Arc<LiveBus> { app.set(LiveBus::new(app.db().clone())) }
    /// The app's live bus. Panics if `init` was never called.
    pub fn of(app: &App) -> Arc<LiveBus> { app.expect::<LiveBus>() }
}
```

- Every module that had `initX`/`getX`/`setX` state follows this shape: `X::init(app)` and `X::of(app)`. Where the
  Node code tolerated the thing being absent, use `app.get::<X>()`. Where it created the thing on first use, use
  `app.get_or_init(...)`.
- A service that needs the app back stores a `WeakApp` (`app.downgrade()`), never an `App`.
- A function that the Node code wrote as `f(db, ...)` or that read a module-level singleton takes `&App` (or just the
  `&Db`, `&Config`, `&SettingsStore` it needs, when that is all it needs).
- Pure functions stay pure functions.
- A lookup table or compiled regex in a `static LazyLock` is fine: it holds no state.

### `Env` (`src/env.rs`)

`std::env::var` is used only in `src/main.rs`, `src/env.rs` and `testbin/`. Everything else reads `app.env()` or an
`&Env` it was given: `env.get("NAME")`, `env.trimmed("NAME")` (the JS `process.env.NAME?.trim() || null`),
`env.is_set("NAME")`. Code that builds the environment for a program it starts works on `env.snapshot()` (a
`BTreeMap`), the way the Node code worked on `{ ...process.env }`.

### `Db` (`src/db/mod.rs`)

`db.with(|conn| ...)` runs a closure with the `rusqlite::Connection`. Calls are synchronous and short, as with
`better-sqlite3`. `db.transaction(|conn| ...)` commits on `Ok` and rolls back on `Err`. `db::get`, `db::all` and
`db::run` return rows as JSON objects for code that handled rows as plain objects. Never `.await` inside `with`.

The schema is `src/db/sqlite.rs`. A new table or column is a new migration there, never an edit to an old one.

### Shipped files (`Config::assets_dir`)

The Node code found the browser UI, the bundled skills, the workspace defaults, the translations and the Python
workers next to its own source files (`path.join(__dirname, "..", "skills")`). A compiled program has no source
folder, so these come from `app.config()`: `public_dir()`, `bundled_skills_dir()`, `workspace_defaults_dir()`,
`i18n_dir()`, `voice_scripts_dir()`. Never build such a path from the source tree yourself.

### `Settings` (`src/db/settings.rs`)

Where a Node function took `store`, `settings` or `settingsStore` and only read or wrote settings, the Rust function
takes `&dyn Settings` (`get`, `set`, `delete`, `get_by_prefix`). The real store (`SettingsStore`, package S1)
implements it over the database; tests pass `testkit::MemorySettings`, as the Node tests passed a plain object.

### `Fetch` (`src/net/fetch.rs`)

All outgoing HTTP goes through `app.fetch()` (or an `Arc<dyn Fetch>` argument where the Node function took a `fetch`
argument). Never build a `reqwest::Client` in a module: tests could not see or stub its requests. The exceptions are
protocols `Fetch` cannot carry (WebSockets, IMAP, SMTP); those take their address from a setting or argument a test
can point at a local fake.

### TLS (`net::install_crypto_provider`)

`main` and `testkit::test_app()` choose the TLS cryptography backend once for the process. A test that opens a
secure connection without a test app calls `tarsee::net::install_crypto_provider()` first.

### Interfaces between packages (`docs/rust-port/INTERFACES.md`)

The turn, the engines, the tools, the commands and the channels call each other through traits stored in the
`App`. `INTERFACES.md` says who implements, calls and installs each one, with examples. Read it before porting
anything that starts a turn, runs a tool, handles a command or sends to a channel.

### Logging (`src/lib/log_capture.rs`)

`console.log(...)` is `log::info!(...)`, `console.warn` is `log::warn!`, `console.error` is `log::error!`. Keep the
text identical, including the `[tag]` prefix: people grep their logs for it.

### Errors

- Inside the crate: `anyhow::Result` where the caller only reports the failure; a `thiserror` enum where callers tell
  failures apart (the Node code checked `err.code`, `err.status` or `instanceof`).
- Error **messages are part of the behaviour**: they reach the UI, chat channels and logs. Keep the Node text.
- HTTP handlers return `ApiResult` (`src/error.rs`): `Err(ApiError::new(400, "message"))` is
  `res.status(400).json({ error: "message" })`.
- No `unwrap()` or `expect()` on anything that can fail at run time (input, files, network, the database). They are
  fine on things that cannot fail (a regex literal) and in tests.

### Tests (`src/testkit/`, `testbin/`, `tests/it/`)

- `testkit::test_app()` gives a complete `App` in its own temporary folder with its own database and environment,
  and an HTTP client that refuses any request the test did not stub (`t.fetch.respond(prefix, Answer::json(...))`).
- `testkit::http` calls an axum `Router` without a socket.
- `testkit::tmp_dir()` gives a temporary folder. Never write anywhere else in a test.
- `tarsee-testbin` (`testbin/`) plays the programs Tarsee starts. A new stand-in is a new role: a module in
  `testbin/` plus one line in `testbin/main.rs`. Tests that start it live in `tests/it/` (only integration tests can
  locate it: `support::testbin()`).

## Porting rules

1. **Port behaviour, not syntax.** Read the Node file and its tests until you know what it does and why, then write
   the Rust that does the same. Do not improve, simplify or "fix" behaviour on the way: if something looks like a
   bug, port it as it is and list it in your report. The one exception is a fix that the port itself needs.
2. **Everything observable stays identical:** route paths and methods, status codes, JSON field names and shapes
   (a field that was absent stays absent, `null` stays `null`), WebSocket message types, SSE event formats, cookie
   names and attributes, header names, setting keys, environment variable names, file names and formats on disk,
   log lines, messages sent to chat channels, prompts given to the model, tool names and their input schemas and
   descriptions. The browser UI and every existing install depend on these.
3. **Stored data stays readable both ways:** the database schema, the encryption of stored secrets (same algorithm,
   key derivation and encoding), password and session hashing, the layout of JSON stored in settings.
4. **Keep the comments.** The Node code's comments record why things are the way they are, often the bug that led
   there. Carry them over (as `///` on items, `//` inside), adjusted where the Rust differs. Do not add comments
   that only say what the next line does.
5. **Public names are the Node names in Rust style**, in the file that mirrors the Node file, so other packages can
   call them without asking. Every exported function, class and constant of a Node file has its counterpart.
6. **Types.** Use real structs and enums where the Node code had a fixed shape. Use `serde_json::Value` where the
   data really is free-form (setting values, tool arguments, JSON passed through to the UI). `serde_json` keeps
   object keys in insertion order here (`preserve_order`), like JavaScript.
7. **Injected dependencies.** Where a Node function took `deps` or an optional function argument so tests could
   replace something (a `fetch`, a `spawn`, a clock), the Rust function takes the same seam: a `Deps` struct with
   `Default`, a trait object, or a closure. That is how the tests are ported.
8. **JavaScript habits that need care:**
   - `text.length` and `text.slice()` count UTF-16 units. Where a limit is visible to a person or another system,
     use `util::js::utf16_len`, `utf16_truncate`, `utf16_slice`.
   - `\d`, `\w` and `\b` are ASCII-only in JavaScript regexes without the `u` flag. In the `regex` crate write
     `[0-9]`, `[A-Za-z0-9_]` and `(?-u:\b)`. Lookaheads, lookbehinds and backreferences need `fancy_regex`.
   - **Joining paths.** Node's `path.join(base, name)` always stays under `base` unless `name` has `..`. Rust's
     `base.join(name)` THROWS `base` AWAY when `name` is absolute (`/data`, `C:\\x`, `\\\\server\\share`): the result
     is `name` itself. So a name that Node turned into a harmless "not found" can become a path anywhere on the
     disk in Rust. Every path piece that comes from outside the program (a request, a tool argument, a setting, a
     name inside an archive, a file name from a chat platform) is checked before it is joined: one plain name
     (no separators, not `.` or `..`, not absolute) where the Node code expected a name, or `lib::safe_path` where
     it expected a relative path. Never `remove_dir_all`, write or copy to a path built from such a piece without
     that check, and test it with an absolute name and with `..`. Node's `path.join` also normalises its result
     (`a/../b`, doubled and trailing separators); Rust's does not, so compare paths as paths, not as text.
   - **File names on Windows.** Node hands every path to Windows in the literal form (`\\\\?\\C:\\...`), so a name
     means what it says. Rust's `std::fs` does not, and Windows then drops trailing dots and spaces from the last
     name and turns `nul`, `con`, `com1` into devices: `data.db.` opens `data.db`, and `...` is the folder
     itself. A check on the name as written then passes for a different file than the one opened (a reviewed
     package let `delete "..."` remove the whole workspace). Every file operation on a path holding a name from
     outside goes through `util::node_path::to_namespaced(&path)`, for the check and the operation alike.
   - `text.trim()` is `util::js::trim(text)`, not `str::trim`: JavaScript trims U+FEFF (a byte order mark) and
     not U+0085; Rust does the opposite. The same two characters differ in `\s`.
   - On Windows an environment variable's name matches whatever its case (`Path`). `Env` does that for `get`,
     `set` and `remove`; a `snapshot()` is a plain map, so look names up in the `Env`, not in a snapshot.
   - `||` treats `0`, `""` and `null` alike; `??` does not. Check which one the Node code used.
   - `JSON.stringify(x, null, 2)` is `serde_json::to_string_pretty`. `new Date().toISOString()` is
     `util::js::now_iso()`. `Date.now()` is `util::js::now_ms()`.
   - `setTimeout`/`setInterval` are tokio tasks; keep the handle so the matching `stopX` can end it. Use
     `tokio::time`, so tests can pause and advance time (`#[tokio::test(start_paused = true)]`).
   - **A promise runs whether or not anyone waits for it; a future does not.** In Node, `const p = refresh()` starts
     the work and it finishes even if every caller goes away. A Rust future does nothing until it is awaited and
     stops where it is the moment it is dropped (a client disconnects, a `select!` takes the other branch, a
     timeout fires). Work that must finish whoever is waiting (a refresh several callers share, a turn, a save,
     anything Node started without `await`) runs in a task of its own (`tokio::spawn`), and callers wait on its
     handle or a channel. A shared future (`futures::future::Shared`) is not enough: it only advances while some
     caller polls it. Test it: start the work, drop the caller, and check the work still completes.
   - `AbortSignal` is `tokio_util::sync::CancellationToken`. `EventEmitter` is `tokio::sync::broadcast`. An async
     generator is a `Stream` (often simplest as a `tokio::sync::mpsc` receiver).
   - `child_process.spawn` is `tokio::process::Command`. Build its environment explicitly from the `Env`; never let
     a child inherit the server's real environment by accident (`env_clear()` first, as the Node code built `env`).
9. **HTTP routes.** Each `routes/x.rs` exposes `pub fn router() -> axum::Router<App>` holding the same paths the
   Express router had (relative to where `server.js` mounted it), and handlers take `State(app): State<App>`.
   Middleware (`requireAuth`, `csrfProtect`) is applied where `server.js` applied it, in `server.rs`; a route file
   applies only what the Node route file applied itself.
10. **Async.** The server runs on tokio. Never block the runtime: file and process work that can take long goes
    through `tokio::fs`, `tokio::process` or `spawn_blocking`. Short synchronous database calls are fine.
11. **Platforms.** The server runs on Linux in Docker and on Windows and macOS for local use, as the Node version
    did. Use `std::path` (never string-joined paths), and `#[cfg(unix)]`/`#[cfg(windows)]` where the Node code
    branched on `process.platform`.

## Test rules

1. **Port every test case** of the Node test files listed for your package: same name in snake_case, same inputs,
   same assertions. A case that cannot be ported yet (it needs a module from a package not merged) or cannot be
   ported at all (it tests a Node-only mechanism) is listed in your report with the reason. Never drop one silently.
2. Add tests where the Rust has risk the Node code did not have (a hand-written protocol that a library used to
   provide) or where the Node tests left a public function untested.
3. Unit tests go in a `#[cfg(test)] mod tests` at the bottom of the module (or `src/<dir>/<name>/tests.rs` when the
   file would pass about 1,500 lines). Tests that start a program or need `tarsee-testbin` go in `tests/it/<area>.rs`.
4. Tests never touch the network, the real home folder, the real environment or the clock of the wall where time
   can be injected. They never sleep to wait for something; they wait on the thing itself.
5. Tests must pass on Windows and on Linux. A test that can only run on one is marked `#[cfg(unix)]` or
   `#[cfg(windows)]`, as the Node tests skipped by platform.
6. A test that passes for the wrong reason is worse than none. When a ported test passes on the first run, break the
   code once to see it fail.
7. Secrets in tests are obvious fakes, and key-shaped strings are built from parts (`format!("sk-{}", "test...")`)
   so the public repository's push protection does not block the push.

## Dependencies

`Cargo.toml` already holds the libraries the port is expected to need. Add one only when the standard library and
the listed crates cannot reasonably do the job: one line, alphabetical order, pure Rust preferred (no system
libraries beyond what is there), the newest release. Say so in your report. The crate versions are recent; if an API
differs from what you remember, read its source under `~/.cargo/registry/src/` rather than guessing.

## This repository is public and open source

No personal names, addresses, machine paths, real tokens or anything specific to one deployment in code, comments,
tests, fixtures or docs. Defaults stay generic.
