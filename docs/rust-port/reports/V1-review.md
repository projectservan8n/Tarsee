# V1 review: Voice, engines and installers (lower half)

Reviewed at `rust-rewrite` (a9bc6da), package diff `7957ca6..dbb96bb`. Each Node file was read next to its Rust
file. Where a difference could be run, the same input went through both: archives built with
`test/fakes/tar.js` and extracted by `tar-extract.js` and by `extract_tar_gz_blocking`, node-edge-tts 1.2.10 run
against a local `ws` server next to the Rust message builders and the Rust handshake on a raw socket, and the
model delete run with a file held open. `cargo test` passes (677 unit, 51 integration, 0 failures).

## Severity

Severity follows the brief. One exception: where Node's behaviour is an accident of its own arithmetic or of stream
timing on a malformed archive, the difference is Minor, and the finding says so.

## What was checked and matches

- **Completeness.** Every export of the 11 Node files has a Rust counterpart (`__setForTests` is `set_for_tests`;
  the Docker-build entry point of `whisper-models.js` is `run_download_command`). All 42 Node test cases are
  ported (installer-downloads 18, python-runtime 16, whisper-models 8). I counted them myself. None is weaker than
  the Node assertion. Several are stronger.
- **Edge TTS protocol.** These are byte-for-byte the same as node-edge-tts: the URL and its query, the
  `Sec-MS-GEC` token (checked at five clock values against `drm.js`), the `speech.config` message, and the SSML
  message (escaping, the unescaped voice, `xml:lang="zh-CN"`, prosody `default`, indentation). The SSML was
  compared for a plain ASCII text and for one with non-BMP characters and `]]>`. Audio is taken after
  `Path:audio\r\n`, with the from-byte-11 quirk kept. `Path:turn.end` ends the turn. The 10 s turn limit, the 30 s
  attempt limit, and the retry delays match. The text cleanup gave the same output as the Node regex chain on 5
  tricky inputs.
- **Downloads.** Size, Content-Length and both hashes are checked before the rename. A failed attempt removes
  `.part` and takes its bytes back off the progress. 404 and HOST_REFUSED are not retried. The stall message is the
  same.
- **Install lock.** The `wx` create, the 10 s rule for an unreadable file, "ours but not held", the 2 h limit, and
  `kill(pid,0)` with EPERM counted as alive all match. The Windows `OpenProcess`/`GetExitCodeProcess` check gives
  libuv's answers.
- **Programs started.** Arguments, working folder and output limits match. The environment is always cleared and
  rebuilt from the app's `Env`. Every run has a time limit.
- **`#[cfg(unix)]` code.** I read it line by line and found no compile or logic error: `symlink`, `create_file`
  with `mode`, `set_permissions`, `libc::kill` with `EPERM`, and `ExitStatusExt::signal`. The two-symlink chain
  test will give "links that lead outside its folder: a/l" on Linux, which the test accepts.
- **Names differing only by case.** Both versions behave the same: both NTFS lookups are case-insensitive.
- **Oversized entries.** Neither version has a size limit. Both buffer pax and long-name records whole.

## Findings

### 1. A tar header checksum that Node refuses is accepted (numeric fields use Rust's `trim`)

- **Severity:** Critical (by the brief: a check weaker than Node's). Real exposure is low. Nothing is written
  outside the folder, and the Python archive is sha256-pinned.
- **Node:** `src/voice/tar-extract.js:34` (`cstr(...).trim()` then `parseInt`) and `:47`.
- **Rust:** `src/voice/tar_extract.rs:87-89` (`let s = s.trim();`) and `:93-103`.
- **What differs:** Rust's `str::trim` strips Unicode White_Space, which includes U+0085 (NEL). JavaScript's
  `trim()` does not strip U+0085, and `parseInt` does not skip it. A numeric field reading `" \u{85}10643"` is
  NaN in Node, so the checksum fails. In Rust it parses to 4515, so the checksum passes. The same parse is used for
  the size and mode fields, so a damaged header's size and mode also differ. The module's own doc says "numbers
  are read the way the JavaScript read them". `speech_text::js_trim` is the JavaScript `trim`.
- **Confirmed:** I built the same archive for both. Its checksum field is the bytes `20 C2 85` followed by the
  octal sum. Node gave "the archive is damaged (a header's checksum is wrong)" (BAD_ARCHIVE). Rust extracted
  `nel.txt` and returned `{files: 1}`.

### 2. A pax record length of 2^64 or more overflows: a panic in debug builds, a dropped `path` in release builds

- **Severity:** Critical (by the brief: a crash on input Node handled, and a different result in release). Real
  exposure is low, for the same reasons as finding 1.
- **Node:** `src/voice/tar-extract.js:51-65`. `subarray` clamps, so the record's value runs to the end of the data.
- **Rust:** `src/voice/tar_extract.rs:112-128`: `len as usize` saturates, then `(i + len)` and `i += len` overflow.
  The cleanup at `:510-521` does not run when the code panics.
- **What differs:** I extracted an archive whose pax data is `6 a=b\n99999999999999999999999 path=python/evil`,
  followed by a file `python/orig`:
  - Node extracts `evil`.
  - A Rust debug build (tests, `cargo run`) panics with "attempt to add with overflow". The panic skips the
    cleanup, so the half-made folder is left behind. Through `extract_tar_gz`, the panic arrives as a JoinError
    message.
  - A Rust release build wraps around, drops the `path` record, and so extracts `orig`.
- **Confirmed:** I ran the archive through both extractors. The debug panic happened and the destination folder
  was still there afterwards. I built a verbatim copy of `parse_pax` with `rustc -O`: it returns `{"a": "b"}`
  without `path`. The same copy without `-O` panics at the same addition.

### 3. Deleting a speech model reports success when the files could not be removed

- **Severity:** Important.
- **Node:** `src/voice/whisper-models.js:173,176`. `fs.rmSync(..., { force: true })` only ignores ENOENT, so any
  other failure throws. `stt-install.js:425` passes the throw on to the route.
- **Rust:** `src/voice/whisper_models.rs:423-432`. `let _ = std::fs::remove_dir_all(...)`, and the folder is still
  added to `removed`.
- **What differs:** On Windows, a model the running speech-to-text worker has open cannot be deleted. Node answers
  with an error. Rust returns `Ok({removed: [<folder>]})` while the folder and `model.bin` are still on disk, so
  Settings says the model was deleted.
- **Confirmed:** I held `model.bin` open without delete sharing. Node threw `EBUSY: resource busy or locked`. Rust
  returned `Ok(["...\\tiny.en"])` while `folder_exists=true` and `model.bin` was left.

### 4. The Edge TTS handshake does not offer `permessage-deflate`, which node-edge-tts (`ws`) always offered

- **Severity:** Important (by the brief: a protocol difference from node-edge-tts). The porter disclosed it. It
  cannot be tested without the real service.
- **Node:** `node_modules/node-edge-tts/dist/edge-tts.js:34-45`, and `node_modules/ws/lib/websocket.js:690,783-790`
  (`perMessageDeflate: true` by default).
- **Rust:** `src/voice/edge_tts_engine.rs:232-253`.
- **What differs:** The captured `ws` request sends
  `Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits`. The Rust request does not. Every other
  header has the same value. The Rust request also writes the header names in lower case (except `Origin`) and in
  another order. That is legal HTTP, but it is not what the library sent.
- **Confirmed:** I captured both requests on local sockets: the `ws` one through a `WebSocketServer`, and the Rust
  one from the raw bytes the engine wrote.

### 5. On Windows, archive names are put through Win32 path normalisation, which Node's namespaced paths avoided

- **Severity:** Important. This is a different result on Windows. Nothing escapes the folder: I tried `.. `, `...`
  and `a.` as both final and middle path segments, in file, folder, hard-link and symlink entries.
- **Node:** `src/voice/tar-extract.js:94-106`. Node's `fs` opens `\\?\`-prefixed paths, so names are written
  exactly as they are in the archive.
- **Rust:** `src/voice/tar_extract.rs:540-569`. `std::fs` passes short paths through Win32 normalisation. Also
  `:174-186`: `PathBuf::push` takes a segment such as `b:c` as a drive.
- **What differs, all confirmed by extracting the same archives with both:**
  - `a.` with `a`, and `b ` with `b`: Node writes two files. Rust writes one, the second entry overwrites the
    first, and the count still says 2.
  - A folder `d` then a file `d.`: Node extracts both. Rust refuses with "names d. as both a file and a folder".
  - `nul`: Node writes a file named `nul`. Rust fails with a plain "Access is denied. (os error 5)", without the
    BAD_ARCHIVE code.
  - A symlink to `a/b:c`: Rust refuses with "a link that points outside its folder". Node accepts it as inside.
    Without the right to make links, Node then refuses with "a link this computer can't make".

### 6. `find_program` reads `PATH` case-sensitively, so on Windows (`Path`) no program is found

- **Severity:** Minor. There is no visible regression today: Node's Piper check never worked on Windows, and
  `whisper-engine.js` is imported by nothing. But these helpers are meant for V2.
- **Node:** `src/voice/whisper-engine.js:25,61` and `piper-engine.js:110`. `execFileSync` uses `process.env`, and
  libuv finds `Path` whatever its case.
- **Rust:** `src/voice/tts_interface.rs:223`: `which::which_in(name, env.get("PATH"), cwd)`. `Env` is a
  case-sensitive map. `python_runtime.rs:389` has the same lookup, but it falls back to std, which does find
  `Path`, so `run_python` works.
- **What differs:** On Windows the variable is named `Path`. So `find_program`, `program_command` and `exec_file`
  report every program as missing ("spawnSync ffmpeg ENOENT"). The report's claim that Piper now works on Windows
  when installed does not hold on a normal Windows environment.
- **Confirmed:** `find_program(Env{Path: <real>}, "node")` returned `None`. With `PATH` it returned
  `Some(...node.exe)`. Node's `execFileSync("node", ..., { env: { Path } })` ran.

### 7. A redirect with an empty `Location` is followed instead of returned

- **Severity:** Minor.
- **Node:** `src/voice/install-common.js:64-65`. `""` is falsy, so the 3xx response is returned.
- **Rust:** `src/voice/install_common.rs:212-219`. `Some("")` is joined onto the same URL.
- **What differs:** Node makes 1 request and `downloadFile` says "huggingface.co answered HTTP 302 for x". Rust
  makes 6 requests to the same URL and says "too many redirects from huggingface.co".
- **Confirmed:** I ran both against a 302 with `location: ""`.

### 8. A negative size in a pax or long-name header is read differently

- **Severity:** Minor. Node's result here is an accident of `subarray` with negative indexes.
- **Node:** `src/voice/tar-extract.js:200,225-228`. `take(-512)` keeps only the last 512 bytes of the buffer.
- **Rust:** `src/voice/tar_extract.rs:275-284,351-358`. `padded as usize` saturates to 0.
- **What differs:** For an `x` header with size `-1750` (octal), followed by two files, Node extracts nothing
  (`{files: 0}`) and Rust extracts both.
- **Confirmed:** I extracted the same archive with both.

### 9. Bytes after the gzip member: Node refuses (on a small archive), Rust extracts

- **Severity:** Minor. Node's refusal depends on whether zlib's error arrives before the two zero blocks are read.
- **Node:** `src/voice/tar-extract.js:183-199,164`.
- **Rust:** `src/voice/tar_extract.rs:335-340`. Reading stops at the two zero blocks, so the decoder never reaches
  the trailing bytes.
- **What differs:** For a small archive with trailing text, Node gave "the archive could not be read (incorrect
  header check)". Rust extracted the archive.
- **Confirmed:** I extracted the same archive with both.

### 10. A program that runs out of time is killed with SIGKILL, where Node sent SIGTERM

- **Severity:** Minor.
- **Node:** `python-runtime.js:162` and `whisper-engine.js:103` use `child.kill()`. `piper-engine.js:110` and
  `whisper-engine.js:61` use `execFileSync` with its default `killSignal` of SIGTERM.
- **Rust:** `python_runtime.rs:640`, `tts_interface.rs:298` and `whisper_engine.rs:167` use tokio's
  `start_kill()`, which sends SIGKILL on Unix.
- **What differs:** pip or Python get no chance to clean up. The messages are the same.
- **Confirmed:** from the two sources.

### 11. Long file work on the async runtime (DESIGN rule 10)

- **Severity:** Minor.
- **Rust:**
  - `python_runtime.rs:1131,1139,1145,1155`: `std::fs::remove_dir_all` of a whole CPython tree (thousands of
    files) inside an async function.
  - `whisper_engine.rs:219-220`: `std::fs::write` of a whole ggml model.
- **What differs:** Node did the same synchronously. The rules ask for `spawn_blocking` or `tokio::fs` here.
- **Confirmed:** from the source.

### 12. Rust `trim` where JavaScript `trim` was, outside the extractor

- **Severity:** Minor.
- **Node:** `python-runtime.js:140`.
- **Rust:** `python_runtime.rs:423` (`last_lines`) and `:775` (`js_number`).
- **What differs:** U+0085 is trimmed and U+FEFF is not, which is the opposite of Node. This can change a failure
  message's last lines in rare cases. It is the same translation trap as finding 1.
- **Confirmed:** from the two sources and the `trim` check under finding 1.

## Notes on the report

- "Piper now available on Windows when installed" is not true on a default Windows environment (finding 6).
- "tokio's `test-util` feature is off" is out of date. `Cargo.toml` now has it in `[dev-dependencies]`.
- The rest of what the report lists under "Differences from the Node behaviour" and "Looks like a bug in the Node
  code" is accurate as far as I checked.

COMPLETE: yes
FAITHFUL: no
