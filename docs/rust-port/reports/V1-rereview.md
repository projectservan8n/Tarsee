# V1 re-review (fix round 1, 64fb45d)

Checked in `s5` at 64fb45d. Throwaway test and archives removed afterwards (scratch test file and its `mod` line deleted).

1. NEL in a numeric header field (Critical): ADDRESSED. Built 5 archives with U+0085/U+FEFF/U+00A0 around the checksum
   field and U+0085 in the size field; Node and the Rust extractor gave the same refusal or acceptance for each, no
   panic, no leftover folder (outputs byte-identical, file listing included).
2. Pax record length 2^64 or more (Critical): ADDRESSED. Archives with lengths 99999999999999999999999, 2^64,
   2^63-1, 2^53+1: Rust extracts `python/evil` like Node, no panic (debug build), nothing left behind.
3. Model delete reports success when files stay (Important): ADDRESSED. Read `delete_whisper_model` (uses
   `remove_all`, passes on non-NotFound errors); its test holds `model.bin` open on Windows and passes.
4. Edge TTS handshake / permessage-deflate (Important): ADDRESSED as a deliberate protocol move. Handshake sends no
   extension (test asserts it); URL, token v2, config, SSML, 2-byte-header audio frames, close handling and timeouts
   are consistent between the engine and its 13 tests (read both). Not compared with 1.2.12 source (not in
   node_modules); live result is the author's claim.
5. Windows path normalisation (Important): ADDRESSED. Extracted `a`, `a.`, `b`, `b `, `nul`, `d/` + `d.`, `e/.. /f`,
   `g./h`, `com1`, `aux.txt`, `q/con`, `x/...` and a `lnk -> a/b:c` symlink with both extractors: identical results
   (8 files and 1 folder, each its own file; link refused the same way), and nothing outside the target folder.
6. `PATH` read case-sensitively (Minor): ADDRESSED. `Env::get` matches names in any case on Windows (src/env.rs:72);
   `python_command` uses `path_variable`; the new Windows test `a_program_is_found_on_a_path_spelled_in_any_case` passes.
7. Empty `Location` followed (Minor): ADDRESSED. Code filters the empty value; test shows 302 returned, 4 hits, not 6.
8. Negative size in pax/long-name header (Minor): ADDRESSED. Ran -1750 (x and L), -1, -777777 through Node: 0, 0,
   2, 2 files, the same numbers the Rust test asserts.
9. Bytes after the gzip member (Minor): ADDRESSED. Node: trailing text -> "incorrect header check", zeros and
   zeros+text -> extracted, empty -> "unexpected end of file"; the Rust test asserts exactly these.
10. SIGKILL on timeout (Minor): ADDRESSED. `terminate` sends SIGTERM on Unix (libc), used in `exec_file`, `run_python`,
    whisper; Unix path not compilable here, read only. Windows test passes.
11. Blocking file work on the async runtime (Minor): ADDRESSED. `remove_all_async` (spawn_blocking) and `tokio::fs::write`
    at the cited lines.
12. Rust `trim` outside the extractor (Minor): ADDRESSED. `last_lines`, `js_number` use `util::js::trim` /
    `js_number_text`; grep of src/voice finds no remaining Node-`trim` translation using Rust's `trim`.

## New breakage

None found in the fix diff.
- Callers of the functions that now return errors (`clean_downloads`, `remove_all`, `remove_file_force`, the
  extractor cleanup) all propagate with `?`; none ignores the new error.
- No test was weakened (the gzip-error assertion went from `starts_with` to `assert_eq`).
- `js_number_text` checked against JavaScript `Number()` for 22 inputs in its test; reads right.

Tests: `cargo test --no-fail-fast`: 1504 unit, 99 integration, 139 browser, all passed. One earlier run had
`codex_cli::a_codex_that_cant_start_is_an_error_value_never_a_crash` fail (process-kill timing, file not in the fix
diff); it passed alone and in the second full run.
