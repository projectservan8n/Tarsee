# Tarsee in Rust: status ledger

The lead keeps this file. It is the record that survives a lost context: trust it and `git log` over memory.
Plan: `docs/rust-port/PLAN.md`. Spec: `docs/rust-port/DESIGN.md`.

## Packages

States: `running` (an agent is porting it), `merged` (on `rust-rewrite`, whole suite green), `reviewed` (a second
agent checked it against the Node code and its findings are fixed or parked below).

| Package | State | Slot | Commits | Tests after merge | Notes |
|---|---|---|---|---|---|
| F0 | merged | - | 9956468 | 96 | Foundation, by the lead |

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

None recorded.

## Deferred minor findings

None recorded.
