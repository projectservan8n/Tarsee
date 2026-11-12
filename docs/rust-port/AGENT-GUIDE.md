# Porting a package: the working guide

You are porting one package of Tarsee from Node.js to Rust. Your dispatch message names the package, your worktree
and your branch. This guide is how the work is done; `DESIGN.md` is what the result must look like; your section of
`PLAN.md` lists your files and tests.

## Before you write anything

Read, in this order:

1. `docs/rust-port/DESIGN.md`, all of it.
2. Your package's section in `docs/rust-port/PLAN.md`.
3. The foundation: `src/app.rs`, `src/env.rs`, `src/error.rs`, `src/db/mod.rs`, `src/db/settings.rs`,
   `src/net/fetch.rs`, `src/util/js.rs`, `src/testkit/` (all files), `testbin/main.rs`, `tests/it/support.rs`. They
   are short. Then skim `src/lib/redact.rs` and `src/config/env.rs` to see what a finished port looks like.
4. Every Node file in your package, whole, and every Node test file listed for it, whole. Then the Rust files of
   the packages you depend on (already merged into your worktree), for the names you will call.

## Where you work

- Only inside your worktree, on your branch. Commit there. **Never push, never switch branches, never touch another
  worktree.**
- The main checkout (its path is in your dispatch message) is **read-only** for you. It has `node_modules`, so you
  can run the Node code there to see what it really does. That is the fastest way to settle a doubt about behaviour:

  ```bash
  cd "<main checkout>" && node -e "import('./src/lib/slack-format.js').then(m => console.log(JSON.stringify(m.toSlackMrkdwn('**hi** _there_'))))"
  cd "<main checkout>" && node --test test/slack-format.test.js
  ```

  Compare outputs with your Rust for the awkward inputs (empty, non-ASCII, very long, malformed). Do not write
  files there.
- Files you may change: your package's Rust files (the stubs that name your package), and the shared files listed
  at the end of "How the work is run" in `PLAN.md`. Never change a Node file, anything under `src/public/`, the
  foundation, or another package's module. If one of those needs a change, describe it in your report.
- You do the work yourself. Do not start subagents, and do not ask for a review: one follows your report.

## How to work

1. Go through your files in dependency order (a file before the files that import it).
2. For each file: write the Rust, port the tests that cover it, run them
   (`cargo test --lib <module::path>` or `cargo test --test it <name>`), fix, then go on. Compile often; do not write
   a thousand lines before the first build.
3. Commit after each file or two (`git add -A && git commit -m "..."`), so nothing is lost if you are interrupted.
   Write commit messages as plain sentences about what now works.
4. When a ported test passes on its first run, break the code once to see the test fail, then restore it.
5. A function the Node file exports that nothing in your package tests still gets ported, and gets at least one
   test.

## Before you say you are done

Run all of these in your worktree and read the output:

```bash
cargo fmt
cargo clippy --all-targets 2>&1 | grep -E "^(warning|error)" | sort | uniq -c   # must print nothing
cargo test 2>&1 | grep -E "^test result|FAILED|panicked"                         # every line "ok", nothing failed
grep -rn "Not ported yet: work package <YOUR PACKAGE>" src/                      # must print nothing
grep -rnE "std::env::(var|vars|set_var|remove_var)" src/ --include=*.rs | grep -v -E "src/(main|env)\.rs|src/testkit/mod\.rs"   # must print nothing
```

Then write your report to `docs/rust-port/reports/<PACKAGE>.md` and commit it with the code:

- **Files:** each Node file and the Rust file it became; any exported name whose Rust name or shape is not the
  obvious translation, and why.
- **Tests:** one row per Node test file: cases in the file, cases ported, and each case not ported with its reason
  (needs package X; tests a Node-only mechanism; ...).
- **Differences from the Node behaviour:** there should be none. List any you could not avoid, however small.
- **Looks like a bug in the Node code:** what and where. You ported it as it is.
- **Dependencies added** to `Cargo.toml`, and why each.
- **Changes needed outside this package:** foundation gaps, another package's API you had to assume.
- **Risks:** what you are least sure of, and what a reviewer should look at first.

## Your final message

Short, because the report file carries the detail:

```
STATUS: DONE | DONE_WITH_CONCERNS | BLOCKED
BRANCH: port/<package> at <commit>
TESTS: <n> passed, 0 failed (whole suite)
CASES: <ported>/<total> Node test cases ported
CONCERNS: up to five one-line points, or "none"
```

`BLOCKED` is for when you cannot finish without something only the lead can give. Say exactly what. Everything that
does not depend on it must be finished and committed first.
