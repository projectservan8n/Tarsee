| A3 | merged | - | merged after 2a25f20 | 2403 | 125 of 126 cases (1 belongs to R2). Spend compared with Node on 659,488 answers. Review to run |
| A4 | running | s6 | | | |
| S1 | running | s10 | | | |
| U1 | running | s4 | | | Starting and stopping programs, in one place || E1 | reviewed | - | 55fa65f, fixes 96f4ac4 | 1573 | 128 of 128 cases. Review: faithful, 2 minor; fixes and two Node bug fixes confirmed by a second reviewer || I0 | reviewed | - | 7957ca6, fixes 38a6adb | 1562 | Interfaces and fakes; `INTERFACES.md`. Review: 1 important, 4 minor, all confirmed fixed by a second reviewer || B1 | reviewed | - | 1649cf7, fixes 9aa27aa | 1757 | 36 of 36 cases. Review: nothing critical or important in the package; 2 minor and two Node bugs fixed, confirmed by a second reviewer |# Tarsee in Rust: status ledger

The lead keeps this file. It is the record that survives a lost context: trust it and `git log` over memory.
Plan: `docs/rust-port/PLAN.md`. Spec: `docs/rust-port/DESIGN.md`.

## Packages

States: `running` (an agent is porting it), `merged` (on `rust-rewrite`, whole suite green), `reviewed` (a second
agent checked it against the Node code and its findings are fixed or parked below).

| Package | State | Slot | Commits | Tests after merge | Notes |
|---|---|---|---|---|---|
| F0 | merged | - | 9956468..fe6015b | 96 | Foundation, by the lead |
| I0 | reviewed | - | 7957ca6, fixes 38a6adb | 1562 | Interfaces and fakes; `INTERFACES.md`. Review: 1 important, 4 minor, all addressed |
| A1 | reviewed | - | 92f9739, fixes d5772a9 | 2016 | 161 of 181 cases. Review: 1 important, 5 minor; all confirmed fixed by a second reviewer |
| A3 | running | s2 | | | |
| A5 | merged, fixed | - | 2d96d1c, fixes 0a15a7a | 2137 | 66 of 66 cases. Review: 1 important, 4 minor; all fixed, one Node bug fixed. Second review running |
| A2 | reviewed | - | 74e0e4f, fixes 82edd82 | 1723 | 107 of 109 cases (2 wait for G2, G3). Review: 3 important, 8 minor; all 11 confirmed fixed by a second reviewer; passes on Linux |
| B1 | merged, fixed | - | 1649cf7, fixes 9aa27aa | 1757 | 36 of 36 cases. Review: nothing critical or important in the package; 2 minor, fixed; two Node bugs fixed. Second review running |
| B2 | reviewed | - | 7094777, fixes a1ce610 | 2016 | 62 of 69 own cases, plus 27 of the 32 `pdf-read` cases. Review: 2 critical, 1 important, 6 minor, all fixed with five Node bugs; confirmed by a second reviewer, who attacked the files route with 87 hostile paths |
| C1 | merged, fixed | - | 9dd5372, fixes 2f14fc4 | 2201 | 32 of 32 cases. Review: 1 critical, 4 important, 22 minor; 25 fixed, 2 answered, four Node bugs fixed. Second review running |
| D1 | merged, fixed | - | 48bb9ff, fixes 8a3ff04 | 2201 | 59 of 68 cases, plus 5 browser cases now in `tests/ui`. Review: 1 important, 11 minor; all addressed (the lock race: 0 wrong in 200,000 stress rounds). Second review running |
| V2 | merged, fixed | - | 7205d05, fixes 344c47a | 2031 | 71 of 71 cases. Review: 5 important, 13 minor; 15 fixed, 3 belong to the server-wide wiring (Z1). Second review running |
| S4 | merged | - | 40c3723 | 2118 | 41 of 42 cases (1 waits for S3). The real `codex` and `claude` programs each connected to the Rust endpoint and listed all 27 tools. Review running |
| T1 | merged, fixed | - | 40e4ee7, fixes bac416f | 2131 | 102 of 107 cases (5 wait for S3). Review: 2 critical, 1 important, 4 minor; all fixed (the shell runs in a job object). Second review running |
| W1a | merged | - | fcfc2ba | 1328 | 116 of 141 cases of the browser files run in a real browser (`cargo test --test ui`); 25 wait for A1, A4, R2 |
| E1 | reviewed | - | 55fa65f, fixes 96f4ac4 | 1573 | 128 of 128 cases. Review: faithful, 2 minor, addressed; two Node bugs fixed |
| V1 | reviewed | - | dbb96bb, fixes 64fb45d | 1742 | 42 of 42 cases. Review: 2 critical, 3 important, 7 minor; all 12 confirmed fixed by a second reviewer |

## Rulings

Decisions the lead made on the owner's behalf, in order. Each says what it costs if wrong.

1. Ruling: the browser UI (`src/public/`) stays JavaScript and is served unchanged — a browser runs JavaScript, and
   rewriting 18,000 lines of working UI into WebAssembly would risk every screen for no gain the owner asked for —
   if wrong: the UI rewrite is a separate project on top of this branch; nothing here is wasted.
2. Ruling: the two Python speech workers stay Python — they only wrap Python-only libraries — if wrong: they would
   need a different speech library altogether.
3. Ruling: packages are ported in parallel, each in its own git worktree, and merged one at a time by the lead —
   the owner's standing preference is parallel agents, and the worktrees remove the file conflicts the
   one-at-a-time rule guards against — if wrong: merge conflicts in the few shared files, resolved at merge.
4. Ruling: a package is merged as soon as its own tests and the whole suite pass, and its review runs afterwards,
   with fixes as follow-up commits — packages that depend on it can start at once — if wrong: a dependent package
   builds on something a review later changes, and needs a small follow-up.
5. Ruling: the base of the branch is `feat/multi-provider` as it stood (7438f62). The open draft PRs #10
   (`fix/after-merge`) and #11 (`fix/security-holes`) are not in it — they are unmerged drafts and merging them was
   not asked for — if wrong: their fixes have to be ported to Rust after they land; until then the Rust version has
   the behaviour of the base, including what those PRs fix.
6. Ruling: JavaScript hooks and plugins in the workspace are not run by the Rust version (DESIGN.md, decision 5) —
   a Rust process cannot load JavaScript modules — if wrong: an embedded JavaScript engine could be added later.
7. Ruling: the Claude and Codex engines start the `claude` and `codex` programs directly instead of through the
   Node SDKs (DESIGN.md, decisions 2 to 4) — there are no Rust SDKs — if wrong: none; this is what the SDKs do.

8. Ruling: the tests of the browser files are ported to Rust and run the real files in a real headless browser
   (`tests/ui`, its own test binary, so the rest of the suite never needs a browser) — the files stay JavaScript,
   but the project then has one test command — if wrong: the Node tests of those files can be restored from git.
9. Ruling: two places in the message splitters differ from Node on purpose (package E1): a cut that would split an
   emoji moves the emoji whole to the next piece, and the fence-safe splitter stops where the Node one looped until
   it ran out of memory — a Rust string cannot hold half a character, and an endless loop is not behaviour to keep
   — if wrong: none; both only change output that was broken.
10. Ruling: the `codex` program is found by an explicit path, then `TARSEE_CODEX_PATH`, then `TARSEE_CODEX_BIN` (the
    Node name, kept so existing installs work), then the PATH (package A2) — there is no `node_modules` to look in
    — if wrong: one lookup order to change in `ai/codex_cli.rs`.
11. Ruling: the system service installed by `daemon/service` runs `tarsee start` instead of `node src/server.js`
    (package C1) — if wrong: one line.

12. Ruling: a bug the port finds in the Node code that can destroy data or weaken a security check is fixed in the
    Rust version, with a test, instead of being carried over; every other oddity is ported as it is. Each fix is
    listed under "Node bugs fixed in the Rust version" below — the owner's standing rule is to fix issues fully,
    and a rewrite that knowingly ships a way to delete the workspace would be wrong — if wrong: each fix is one
    small, named change that can be reverted.

13. Ruling: Edge's read-aloud voice speaks the protocol of `node-edge-tts` 1.2.12, not the 1.2.10 the Node version
    pins — Microsoft's service now answers 403 to the old one (checked live: the Node version's Edge voice is
    broken today), and the Rust engine got audio back with the new one — if wrong: none; the old protocol no
    longer works for anyone.

14. Ruling: the Claude engine gives the `claude` program its MCP token in a configuration file that is deleted as
    soon as the program has started, not in an environment variable or on the command line — the engine research
    showed a token in the environment can be read by a shell the agent starts, and one on the command line by
    anyone who can list processes; the Node version had no token at all for Claude — if wrong: one function in
    the Claude engine.
15. Ruling: the Rust engine does not set the two environment markers the Node SDK set
    (`CLAUDE_CODE_ENTRYPOINT=sdk-ts`, `CLAUDE_AGENT_SDK_VERSION`) — they tell Anthropic's service the caller is the
    TypeScript SDK at a version, which it is not; a turn works without them — if wrong: two lines.
16. Ruling: a turn is stopped by asking the `claude` program to interrupt first, then by the SDK's own sequence
    (close its input, then end it after the same waits) — the research measured the interrupt at under a second
    and showed that closing the input alone does not stop a model call in progress — if wrong: none; the SDK's
    sequence still follows.
17. Ruling: on Windows every program Tarsee starts is tied to the server so that it ends when the server ends —
    Node's runtime did this for every child process; a Rust program does not unless it asks — if wrong: a
    program meant to outlive the server would need to be started apart, and there is none today.
18. Ruling: three defects the engine research found in the Node Claude engine are fixed in the Rust one: a resumed
    turn's cost counted the whole session again (the monthly cap then tripped early); a stopped turn could not
    promise that nothing was sent; the "Claude Code isn't installed" message could never appear — each is plainly
    wrong output — if wrong: each is one branch.

## Pre-flight scan

- Packages share no source files: every Rust file is owned by exactly one package (the stub in each file names it).
- Shared files any package may add to: `Cargo.toml`, `testbin/main.rs`, `tests/it/main.rs`, `src/testkit/`.
  Conflicts there are additions next to each other, resolved by the lead at merge.
- Interfaces between packages that run at the same time go through package I0 (the turn, tools, commands and
  channel traits). Everything else is called directly, and the caller's package starts only after the callee's is
  merged (the "Needs" line of each package in PLAN.md).
- `db/settings.js` is used by packages that run before it is ported (S1): they take `&dyn Settings`
  (`src/db/settings.rs`). Its key lookups (`keyPlace`, `cleanKey`, `keyHint`, `getKeyWithSource`, `getApiKey`) are
  ported early, by A1, as free functions over `&dyn Settings`, because A3 and A4 need them before S1.

## Test cases not ported yet

- A2: `engine-env` R8 (needs the agent vault environment from B1); two exit-cleanup cases of `turn-leftovers`
  (need G2 and G3).
- W1a will list the cases of `model-picker-core` and `provider-guides-core` that need A1 and R2.

## Node bugs fixed in the Rust version

Fixed (in the list below, marked "done") or being fixed in each package's fix round:

- done: B2 `routes/files`: the workspace root can no longer be deleted, however the workspace folder is written; a
  rename must stay inside the workspace and never lands on a protected name; NTFS stream names (`name.db::$DATA`)
  are refused; a private address written as IPv6 is judged by its IPv4 form.
- done: B1 `middleware/security`: a CSRF token with a signature of the wrong length answers 403, not 500; a private
  address inside an IPv6 one is refused by the security manager.
- done: C1 `lib/skills-engine`, `lib/canvas`: a skill name must be one plain name, so install, uninstall, setup,
  update and delete cannot reach outside the skills folders; a canvas path cannot reach a sibling folder; a skill
  update that keeps the content no longer adds a blank line each time.
- done: A5 `ai/providers/codex-options`: switching the compact window off (`TARSEE_COMPACT_WINDOW=off`) no longer
  gives Codex a limit of 0, which made it compact on every turn.
- done: E1 `lib/discord-format`: a piece of a split message can no longer be over the limit when the line has emoji;
  code fences in text with CRLF line endings are recognised (also in the Slack stream).

## Node oddities ported as they are

Listed in each package report. The ones that touch security, for the owner to decide (the unmerged PR #11 covers
some): `http://[::ffff:127.0.0.1]/` passes the private-address check; `checkUrlSafety` lets loopback and private
names through; a `write_file` call with a non-text file name skips the tool policy.

## What the reviews found that applies everywhere

Each became a rule in `DESIGN.md` and, where possible, a fix in the foundation:

- Rust's `Path::join` replaces the base when the piece is absolute; Node's `path.join` stays under it. (C1: a skill
  name could delete a folder outside the skills area.)
- JavaScript's `trim` and `\s` differ from Rust's on U+0085 and U+FEFF. (V1: a damaged archive header accepted; the
  foundation: an `ENCRYPTION_KEY` with a byte order mark derived a different key.)
- On Windows an environment variable's name matches in any case. (V1: programs never found on the `Path`.)
- Arithmetic on a number read from a file or the network must be checked. (V1: an overflow in the archive reader.)
- `(?i)` in a Rust pattern folds a few characters JavaScript's `/i` does not.
- `serde_json` parsed long decimals one unit off until `float_roundtrip` was switched on.
- Windows rewrites a file name with a trailing dot or space, and names like `nul`, unless the path is handed over in
  its literal form, which Node always did. (B2: `delete "..."` removed the whole workspace; V1: archive entries
  merged.) `util::node_path::to_namespaced`.
- A Node promise runs whether or not anyone waits for it; a Rust future stops when it is dropped. (A1: a shared
  refresh stalled when its caller went away.)
- An axum handler is dropped when the client disconnects; an Express handler ran to its end. (V2: a speech
  request whose client left stayed pending and broke every later one; recordings were left in the temp folder.)
- Windows reuses the id of a process that has ended, and a process keeps the id of a parent long gone, so the
  children of a process cannot be found by parent id alone. (T1: ending a web terminal could have ended unrelated
  programs; patched at once with a creation-time check, and being replaced by a job object.)
- Tests that start real programs with time limits can miss them when the machine is busy. They are rerun alone
  before a merge is refused, and are to be made robust in the cleanup.

## Linux

The branch is built and tested on Linux inside WSL after merges. First run (five packages): everything compiles;
678 unit tests pass; 2 of 51 integration tests fail (both in A2: output past the size cap), to be fixed in A2's fix
round. Clippy on the newer compiler there reports 3 warnings (a large error type) to clear in the cleanup.

## Engine protocols

Two specifications are being written and independently checked from captures of the real SDKs: how the Node
version starts and talks to the `claude` and `codex` programs (`docs/rust-port/engines/`, with fixtures under
`tests/fixtures/claude-cli/` and `tests/fixtures/codex-cli/`). Packages G1 and G2 are built from them.

## Follow-ups owed by later packages

- A4: `routes::skills::unhandled_error` calls the `record_error` of self-heal.
- Z1: `canvas_middleware(app, signed_in, req)` gets the sign-in state from B1; a `tarsee whisper-models download
  <model> <folder>` command (`voice::whisper_models::run_download_command`); `server.rs` calls the `install(app)`
  of each implementing module.
- H1, H2, H3: channel constructors are `create_<name>_bot(app, config, opts)`; H2 implements
  `slack_stream::SlackClient`; H3 fills `email_parser::ThreadHeaders` and `email_threading::IncomingMail`.
- G3: `turn_notes::RouteLabels` for the route event; in Node an `error` event gains its `code` after the turn ends.
- Cleanup: the JavaScript-behaviour helpers that C1 (`lib::workspace_files::jstext`), E1 (`discord_format::js_text`)
  and A2 wrote for themselves move to `util::js`.
- Z1: `SessionStore::init(&app)?` and `AuditLog::init(&app)` at boot; serve with
  `into_make_service_with_connect_info::<SocketAddr>()` so `middleware::auth::client_ip` sees the socket address.
- Z1: what Express did to every response, done once for the whole server: `application/json; charset=utf-8`, the
  weak `ETag` with the 304 answer on a fresh GET, a trailing slash treated as none, and paths matched in any case
  where that can be done without changing the case of a parameter. `/terminal` is wired after the sign-in check.
  The settings store is stored in the App also as `Arc<dyn Settings>` (the voice routes read it that way).
- R1: run a turn in a spawned task (a closed socket never cancels a turn) inside `scope_queued_turn`.
- Cleanup: `Config::load` normalises the paths it joins, as Node's `path.join` did; one `express.json()` rule for
  request bodies; JSON responses say `application/json; charset=utf-8` as Express did.

## Deferred minor findings

For the final cleanup; none blocks a package.

- B2 `lib/url_safety`: only the `::ffff:a.b.c.d` spelling of IPv4 inside IPv6 is judged by its IPv4 form; the
  compatible, NAT64 and 6to4 spellings still pass (Node let every IPv6 literal through, so this is not worse).
- B2 `routes/files` rename on Windows: a folder renamed onto an existing file replaces the file and answers 200;
  Node's rename refused. It stays inside the workspace.
- V1/V2/A2 tests that start real programs with time limits: make each wait on the event itself.
- The JavaScript-behaviour helpers still private to packages (`js_to_fixed`, `js_to_precision`, `js_json_stringify`,
  `js_string`, `js_stringify`, `Clock`, `node_header`) move to `util::js`.
- The conversion from a registry provider to the engine environment's entry lives in `codex_options.rs`; it belongs
  beside the registry.
- Clippy on the newest compiler reports a few warnings the pinned one does not.
