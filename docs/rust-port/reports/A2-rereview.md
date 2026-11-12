# A2 re-review (fix round 1)

Checked at the worktree HEAD (contains `82edd82`). No source file changed; the scratch test was deleted.

1. Login-key check fails open on JSON that serde refuses: ADDRESSED. 4,123 texts (about 120 hand-made, the rest 4,000
   seeded mutations of three base documents) went through Node's `homeIsolationRefusal` and `settingsFileGuard` and the
   Rust ones with the same fake reader. The hand-made set covered lone and paired surrogates, escaped key names,
   `1e400`, `-0`, `1E5`, leading zeros, `1.`, `.5`, 10,000-deep arrays and objects (and 9,999 closers), duplicate keys
   both ways (and a duplicate spelt with an escape), BOMs, trailing commas, comments, control characters in strings,
   all whitespace forms (`\f`, `\v`, NBSP, U+2028), empty, `null`, arrays, torn files, `__proto__`, NaN, single quotes.
   Result: 4,121 identical (login refusal and settings result); Node refused 820 of them. Zero cases where Rust lets a
   turn run that Node refuses. The 2 differences are the author's deliberate ones: a torn (non-JSON) file whose key name
   is written with `A`, which Node let through and Rust refuses. No stack overflow at 10,000 or 100,000 levels (the
   reader is a loop).
   The stricter case can only trigger on a file that is not valid JSON and contains text shaped `"primaryApiKey": "<non-blank>`
   (after unescaping). Valid files never reach the text search. The CLI writes valid JSON, so ordinary use is unaffected.
2. Two Linux integration tests (env value over 128 KiB): ADDRESSED. The stand-in now repeats a 10-byte text (30,000 times
   = 300,000 bytes; 20,000 times = 200,000 bytes); the assertions are unchanged from before (the diff only touches the
   input and adds `.unwrap()`): one truncation note, length bound, exit 0, program runs to its end. `output_past_the_cap...`
   passes here. I did not run Linux/WSL.
3. `home_for` reads the real home: ADDRESSED (with a note). `home_for` takes `&Env`; `os_homedir` is deleted. Both
   call sites pass the caller's env (`claude_env_for`: `env = &opts.env`; `codex_env_for`: `&opts.env`); every test call
   passes either `Env::new()` on purpose or an env with the variable under test. No empty `Env` hides the issue in
   production code. Note: `config::env::home_dir(env)` still falls back to `std::env::home_dir()` when the given env
   has no HOME/USERPROFILE. That is the foundation helper's design (outside this diff), and with the server's own `Env`
   it is the same value.
4. Trailing lone CR in config.toml: ADDRESSED. `toml_lines` strips a CR only when a line feed follows, as
   `split(/\r?\n/)`; read the code and its test (`[tui]\r`, `# c\r`, `\r\r\n` forms, strip_codex_config).
5. Settings guard and numbers beyond f64: ADDRESSED. Covered by the differential run above (`{"a":1e309}`,
   `{"a":-1e400}`, `{"env":{"ANTHROPIC_X":1e999}}` identical to Node).
6. Spawn failures on Windows worded differently: ADDRESSED. `run_cmd` returns `Result<CmdResult, SpawnError>`; only
   ENOENT, EACCES, EAGAIN, EMFILE, ENFILE become code 127; others are `spawn EPERM`. A folder on Windows maps to ENOENT.
   `run_codex` gives spawn-failed "Codex couldn't start (EPERM)." and codex-missing only for ENOENT/EACCES. Checked in the
   code and its unit tests, which pass. I did not re-create the icacls-denied exe.
7. Registry copy missing models: ADDRESSED. Claude and anthropic copies list the same 13 ids, in the same order, as
   `PROVIDERS.claude.models` and `PROVIDERS.anthropic.models` read from the Node registry.
8. `(?i)` folds Unicode: ADDRESSED. The copy's wrong-slot patterns use `(?i-u)`; read, and its test passes.
9. Numbers >= 1e21: ADDRESSED. The foundation's `number_to_string` is used; the two new tests ("1e+21", "2e+21", "1e+22")
   pass.
10. Opt-in tests read the real environment: ADDRESSED. Both are `#[ignore]`d with a reason and read their path with
    `option_env!` at build time; run without it they panic (no silent pass).
11. Non-UTF-8 rollout name: ADDRESSED. The sweep joins the lossy name, as Node did. The test is `#[cfg(unix)]`, so I read
    it but did not run it.

## New breakage

None in the fix diff. Callers of `run_cmd` (only tests and the new unit tests) were updated for the `Result`;
`home_for` has only the two production call sites, both updated.

Test run (`cargo test`): unit tests 1504 passed, 0 failed. The integration binary `it` has timing-dependent tests that
fail at random under load when the whole suite runs in parallel: across four full runs the failures were different
each time (`codex_cli::a_codex_that_cant_start...`, `kill_tree_stops_the_shim...`, `stt_local::a_worker_that_hangs...`,
`run_cmd::a_command_past_its_timeout...`, `codex_cli::a_command_past_its_time_limit...`, `hooks::a_program_hook...`), and
the A2 ones pass when run alone (`codex_cli::` 7 passed, `run_cmd::` 3 passed). `kill_tree` and the timeout code are
not in the fix diff. Not caused by this fix; the author reported a similar one.
