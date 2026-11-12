# Tarsee in Rust: status ledger

The lead keeps this file. It is the record that survives a lost context: trust it and `git log` over memory.
Plan: `docs/rust-port/PLAN.md`. Spec: `docs/rust-port/DESIGN.md`.

## Packages

States: `running` (an agent is porting it), `merged` (on `rust-rewrite`, whole suite green), `reviewed` (a second
agent checked it against the Node code and its findings are fixed or parked below).

| Package | State | Slot | Commits | Tests after merge | Notes |
|---|---|---|---|---|---|
| F0 | merged | - | 9956468..fe6015b | 96 | Foundation, by the lead |
| I0 | merged | - | 7957ca6 | 591 | Interfaces and fakes; `INTERFACES.md`. Every event shape checked against 152 events captured from the Node code |
| A1 | running | s2 | | | |
| A2 | merged | - | 74e0e4f | 728 | 106 of 109 cases; 3 wait for B1, G2, G3. `engine_env::ProviderEntry` to be built from A1 |
| B1 | running | s4 | | | |
| B2 | running | s5 | | | |
| C1 | merged | - | 9dd5372 | 213 | 32 of 32 cases |
| D1 | running | s7 | | | |
| E1 | merged | - | 55fa65f | 395 | 128 of 128 cases |
| V1 | merged | - | dbb96bb | 591 | 42 of 42 cases |

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

## Follow-ups owed by later packages

- A1: build `engine_env::ProviderEntry` from the registry; replace the copied values in `src/ai/engine_env/tests.rs`.
- A4: `routes::skills::unhandled_error` calls the `record_error` of self-heal.
- Z1: `canvas_middleware(app, signed_in, req)` gets the sign-in state from B1; a `tarsee whisper-models download
  <model> <folder>` command (`voice::whisper_models::run_download_command`); `server.rs` calls the `install(app)`
  of each implementing module.
- H1, H2, H3: channel constructors are `create_<name>_bot(app, config, opts)`; H2 implements
  `slack_stream::SlackClient`; H3 fills `email_parser::ThreadHeaders` and `email_threading::IncomingMail`.
- G3: `turn_notes::RouteLabels` for the route event; in Node an `error` event gains its `code` after the turn ends.
- Cleanup: the JavaScript-behaviour helpers that C1 (`lib::workspace_files::jstext`), E1 (`discord_format::js_text`)
  and A2 wrote for themselves move to `util::js`.
- Linux: no package has been compiled or run on Linux yet (the agents had Windows only).

## Deferred minor findings

None recorded.
