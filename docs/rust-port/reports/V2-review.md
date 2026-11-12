# V2 review: Voice: Phonon, speech-to-text and the voice routes

Reviewed at `64fb45d` (V2 merged as `7205d05`, with V1's later fixes), in the worktree `s9`, against the Node code in
the main checkout. Nothing in the worktree was changed; the one scratch test was deleted.

## How it was checked

- **Routes, run both ways.** One list of 112 requests went through Express 5.2.1 and through `routes::voice::router()`
  via `testkit::http`, and the answers were diffed. Express was set up the way `server.js` sets it up: `trust proxy`,
  `express.json({ limit: "50mb" })`, the voice router, and `errorHandler`.
  - Both sides used the same stand-ins: a TTS engine that echoes the type and value of what it is given, a local
    transcriber that echoes the bytes it got, and with or without a settings store.
  - The requests cover every route, including malformed ones: no body, wrong or missing content type, a multipart
    body with no boundary, empty, unclosed, or garbage, a field missing, given twice, empty, sent as a field, or with
    `filename=""`, file names with `..` or an absolute path or ending in `nul.`, path parameters that are `..%2F`,
    `%00` or `%FF`, a trailing slash, and upper case.
  - **79 of 112 answers are identical** (status, body, `content-type`, `content-length`). Every success answer the
    browser reads is identical field for field. The 33 differences are the findings below, or deliberate
    differences in V2.md.
  - The harness is in the scratchpad: `cases.mjs`, `node_run.mjs`, `diff.mjs`, `node_out.json`, `rust_out.json` in
    `C:\Users\USER'S\AppData\Local\Temp\claude\23f9b6322d2888e9\044742b9-8d6f-4546-9664-40e3f73318f9\scratchpad\rt`.
- **`POST /phonon/install`, run both ways:** two installs that fail, and the answers compared.
- **Worker processes:**
  - Compared side by side with `phonon_worker.py` and `stt_worker.py`.
  - Run against the stand-ins and against a slow real-Python worker, in a copy of the tree.
  - Checked with `Get-Process`, before and after every test run, that no stand-in survives.
- **Installers, engine registry, doctor and clone handler:**
  - Node's `getSttStatus` was run in four states and compared field for field with Rust's serialization.
  - `getProvider`/`cleanKey` (`api_key`) were run with the same inputs on both sides.
  - The Phonon installer's status and pins were compared.
- **Tests:** every Node case counted from the files (including the generated ones). The whole suite was run.

## Critical

None.

- **Files:** no route or function reaches a file outside Tarsee's folders. Model names are checked against the
  catalog. Piper ids must be plain names. Clone names reach only the database. Uploaded file names are never used.
  Phonon voices come from the catalog. Archive and list names go through `safe_join`.
- **Processes:** none was left running after any test run (0 stand-ins before and after).
- **Answers:** every success answer the browser reads is identical.
- **Crashes:** no request made Rust panic. One Node bug Rust does not share: an unclosed multipart form makes busboy
  emit `'error'` on a file stream that has no listener, which is an uncaught exception that ends the Node process.
  Rust answers 500.

## Important

### I1. A Phonon request whose caller goes away gives every later line the wrong answer, and leaves WAV files in tmp

- **Node:** `src/voice/phonon-engine.js:274-296` (`synth`: a queued promise that always runs to the end) and
  `:372-383` (the `finally` that unlinks `tmpOut`).
- **Rust:** `src/voice/phonon_engine.rs:697-749` (`PhononWorker::synth`) and `:1107-1140` (`synthesize`).
- **What differs.** A JavaScript promise cannot be cancelled. A Rust future can: hyper drops the handler when the
  client disconnects (closing the call page, reloading, or a dropped connection).
  - If the drop happens while the worker is speaking that line, `st.pending` still holds the dropped request, and
    the queue lock is released.
  - The next request overwrites `pending` (`:721`). The worker's answer to the dropped line then settles the next
    request, which reads its own WAV before it is written: `ENOENT ... phonon-xxxx.wav`.
  - From then on every line gets the previous line's answer. They all fail, so Edge speaks instead and the fallback
    trips for 5 minutes. This lasts until an answer arrives with nothing pending.
  - The WAV of every line involved is left in the temp folder.
- **Confirmed by running both** with the same real-Python worker, which answers after 800 ms. A line was dropped
  after 200 ms, then three more were spoken.
  - Rust: "Second.", "Third." and "Fourth." all failed with ENOENT, and 4 `phonon-*.wav` files were left behind.
  - Node (with `child_process.spawn` rerouted to the same worker): all three were spoken, and no files were left.

### I2. A transcription whose caller goes away leaves the recording in tmp, and the worker never stops for idleness

- **Node:** `src/voice/stt-handler.js:239-253` (the `finally` that unlinks the recording) and `:155-156` (`_armIdle`
  after every task, settled or not).
- **Rust:** `src/voice/stt_handler.rs:658-671` (`remove_file` only on the normal path) and `:163-167` (`clear_idle`,
  then `arm_idle`, which is skipped when the future is dropped).
- **What differs:**
  - After a `/transcribe` or `/stt` client disconnects mid-transcription, the user's audio (`tarsee-stt-*.wav`)
    stays in the temp folder.
  - The idle timer was cleared and is never armed again. faster-whisper keeps its model in memory until the next
    transcription, instead of stopping after 10 idle minutes.
  - The answers themselves are not mispaired: requests carry an id.
- **Confirmed (Rust run):** a transcription with an 800 ms delay was dropped at 300 ms.
  - The recording was still in tmp, and the worker was still running 2 s after a 300 ms idle limit.
  - The control run without a drop stopped on time.
  - Node's behaviour was read from the source.

### I3. `POST /api/voice/phonon/install` answers before the run has reset its status

- **Node:** `src/voice/phonon-install.js:145-167`. `installPhonon` calls `runInstall`, whose synchronous start resets
  the status: `phase: "runtime"`, `bytesDone: 0`, `startedAt` now, `finishedAt` and `error` null. This happens before
  `routes/voice.js:234` answers with `getPhononInstallStatus()`.
- **Rust:**
  - The reset is at `src/voice/phonon_install.rs:340-348`, inside `run_install`. That function runs on the task
    spawned at `:295`.
  - `install_phonon` returns, and `routes/voice.rs:551` answers, before the task has run.
  - On a current-thread runtime this always happens; on a multi-thread runtime it is a race.
- **Confirmed by running both** with `TARSEE_PHONON_PYTHON` naming a missing Python, posting twice:

  | | Node, first and retry | Rust, first | Rust, retry |
  |---|---|---|---|
  | `phase` | `"runtime"` | `null` | the failed run's phase |
  | `startedAt` | now | `null` | the failed run's |
  | `finishedAt` | `null` | `null` | the failed run's, not null while "installing" |

  - The browser (`settings.js:2591`) renders the answer as it comes. The first click shows "Installing… 0%" instead
    of "Setting up the Python runtime… 0%".
  - A Retry after a failure in the model phase shows "Downloading the model… N%" with the old percent. The next poll,
    1.5 s later, jumps back to 0%.
- **Not tested:** no test checks this first answer. The porter did fix the same pattern for speech-to-text, in
  `stt_install::begin`.

### I4. Two `stt-routes` cases are not ported, and the reason given does not hold

- **Node:** `test/stt-routes.test.js:120-125` ("are behind sign-in and CSRF") and `:127-135` ("the owner's API token
  works too; a wrong one is a 401"). The transcribe case (`:194-208`) also sends a request with the owner's token.
- **Rust:**
  - `tests/it/stt_routes.rs` has neither of the two cases.
  - `post_transcribe_with_a_short_wav_answers_with_its_text_what_a_call_uses` (`:199-207`) sends its "API client"
    request with no token and no middleware. That half is the same request as the first half, so it is weaker than
    Node's.
- **Why the reason fails:**
  - V2.md says these cases need `requireAuth` and `csrfProtect` (package B1) "once the middleware is in". It is in.
  - B1 (`1649cf7`) is an ancestor of V2's base `49e6b08`, and `middleware::auth::require_auth`,
    `session_auth` and `middleware::security::csrf_protect` were there.
  - The Node test builds its own app with the middleware in front of the router (`function app(router)`). The port can
    do the same: `router().layer(from_fn_with_state(app, csrf_protect))...`, as `middleware/auth/tests.rs:985` does.
- **Effect:** nothing checks that the voice routes work behind the middleware the way they did in Node. That covers
  sign-in, the CSRF check and the token exemption the dashboard relies on.

### I5. Long blocking file work on the async runtime (DESIGN, porting rule 10)

- **Rust `src/routes/voice.rs:461`:** the async handler `piper_upload` calls `save_piper_voice`. That is a
  `std::fs::write` of the `.onnx` (up to 200 MB) and its `.json`, on a runtime worker thread.
- **Rust `src/voice/stt_install.rs:876` and `:893`:** `std::fs::remove_dir_all` of the faster-whisper venv (thousands
  of files, a few hundred MB), inside the async `install_faster_whisper`.
- **Rust `src/voice/phonon_install.rs:649` and `:691`:** `std::fs::remove_dir_all` of the ptts venv, inside the async
  install.
- **Node:** `voice.js:176`, `stt-install.js:320,325`, `phonon-install.js:332,353`. Node did the same work
  synchronously, but the rule is about not blocking the Rust runtime.
  - The two venv removals happen only when repairing a broken venv.
  - The upload happens on every Piper upload.
- **Confirmed** from the source.

## Minor

### M1. A multipart part is told apart as file or field differently from busboy

- **Node:** `node_modules/busboy/lib/types/multipart.js:316-337`. A part is a file when it has a non-empty `filename`
  or when its `Content-Type` is `application/octet-stream`. `filename=""` counts as no file name.
- **Rust:** `routes/voice.rs:410`. A part is a file when it has a `filename` parameter of any value.
- **Effect, confirmed with the harness:**
  - An `audio` (or `onnx`) part with `Content-Type: application/octet-stream` and no file name: Node accepts it
    (200, or 201 for Piper). Rust answers 400 "No audio file provided" / "Missing .onnx file (field: 'onnx')".
  - A part with `filename=""`: Node refuses it with 400, and Rust accepts it.
- The browser always sends a file name, so only hand-built API requests are affected.

### M2. The raw-audio routes take an `application/json` body as audio

- **Node:** the global `express.json()` (`server.js:144`) consumed such a body before the route read the stream
  (`voice.js:386`, `:446`, `:499`). The results:
  - `/stt` transcribed 0 bytes, or answered 400 for invalid JSON;
  - `/transcribe` answered 400 "Empty audio";
  - `/clone` (raw) answered 400 "Audio sample is required".
- **Rust:** `routes/voice.rs:748-757`, `:785-790` and `:873` read the JSON bytes as audio. The answer is 200, or
  201 and a voice profile saved for `/clone`.
- **Confirmed** with the harness ("stt raw json ct", "stt raw bad json ct", "tr raw json ct", "clone raw json ct").

### M3. `/tts-stream` speaks a `text` that is not a string

- **Node:** `voice.js:343` only checks `!text`, then hands the value to the engine.
  - The real engines' first string operation then throws: Phonon's `speechText`, then Edge in the fallback.
  - The answer is a 500, and Phonon gets one failure towards the fallback trip.
- **Rust:** `routes/voice.rs:686` turns it into text with `js_string_or_empty` and speaks "5", "true",
  "[object Object]" or "a,b".
- **Confirmed** with the echoing engine: Node handed it `number`, `boolean` and `object`; Rust handed it `string`.

### M4. Express 5's path matching: trailing slash and any case

- **What differs:** Express 5 matches `/tts/`, `/stt/` and `/TTS`. Axum answers 404.
- **Rust:** `routes/voice.rs:54-73`.
- **Confirmed** with the harness ("tts trailing slash", "tts upper case", "stt trailing slash").
- This affects the whole server and belongs to Z1. The browser always uses the exact paths.

### M5. A path parameter that does not decode answers in plain text

- **What differs:** for `DELETE /piper-voices/%FF` or `POST /stt/models/%FF/download`:
  - Express: 400 `{"error":"Failed to decode param '%FF'"}`.
  - Axum's `Path` rejection: 400 `text/plain` "Invalid URL: Invalid UTF-8 in `id`".
- **Rust:** `routes/voice.rs:61`, `:190-203`.
- **Confirmed** with the harness.

### M6. JSON answers say `application/json`, not `application/json; charset=utf-8`

- **What differs:** every JSON answer in the harness (axum's `Json` and `ApiError`) lacks the charset that Express
  sent.
- **The report is inaccurate:** V2.md (Differences, and Risks) calls the missing `ETag` "the one header difference a
  client could notice". This is a second one.
- This affects the whole server (Z1).

### M7. Form fields and urlencoded bodies have no size limit

- **Node:** busboy's default `fieldSize` (1 MB, `multipart.js:251-253` and `:489-505`) truncated every field.
- **Rust:**
  - `routes/voice.rs:411` reads a field whole with `field.text()`.
  - `:390` reads a urlencoded `/piper-upload` body whole (`read_body(.., usize::MAX)`).
  - The router turned off `DefaultBodyLimit`, so a signed-in client can make the server hold any amount in memory.
- **Confirmed** from the source.

### M8. The report says a NaN percent was ported as it is; it was not

- **Node:**
  - `stt-install.js:233`: a NaN percent stays NaN, which is `null` in the job JSON.
  - `phonon-install.js:101`: the same.
- **Rust:**
  - `stt_install.rs:603-608` skips a non-finite percent. `JobSnapshot.percent` is an `i64` and cannot be null.
  - `phonon_install.rs:200-205` gives 0.
- This needs a model or download of 0 bytes, so it cannot happen with the real catalogs. The error is in the
  report's bug list (`V2.md:160`).

### M9. `engine_registry::api_key` reads the environment even with no settings store

- **Node:** `voice.js:265` and `engine-registry.js:128` use `settingsStore?.getApiKey?.()`, which gives nothing
  with no store.
- **Rust:** `engine_registry.rs:238`. With no store it still reads `OPENAI_API_KEY` / `ELEVENLABS_API_KEY`:
  - `/status` says "key set" where Node said "no key";
  - ElevenLabs can be built from the environment alone.
- **When there is a store, the answers are the same as Node's.** Both ids give the same answer on both sides, which
  was checked by running `getProvider`/`cleanKey`.
- **Now on the branch:** A1's `db::settings::get_api_key` (`settings.rs:232`) and `util::js::trim` are on the branch,
  so the stand-in and `speech_text::js_trim` can be switched as the report planned.

### M10. Names from outside are not taken literally on Windows (DESIGN, "File names on Windows")

- **Where:** no V2 path goes through `util::node_path::to_namespaced`. That covers:
  - `phonon_install.rs:514-530`: names from the downloaded voice list, after `safe_join`;
  - the Piper id and voice name that the routes hand to V1's `delete_piper_voice` and `save_piper_voice`
    (`voice.rs:461`, `:482`).
- **Effect on this machine (Windows 11, build 26300): none.**
  - The Piper names always end in `.onnx`/`.onnx.json`.
  - Opened through the plain Win32 path, `nul.onnx`, `con.onnx.json`, `com1.onnx` and the like were ordinary files
    here (checked with a non-literal open). The harness's "nul" upload and delete gave the same answer as Node's.
  - A `safe_join` name with trailing dots resolves to its folder, and the download then fails.
- **Effect on older Windows:** a name with an extension is still a device there.

### M11. A Unix signal outside a short list is written "signal N"

- **Node:** `phonon-engine.js:219` and `stt-handler.js:92` name every signal.
- **Rust:** `phonon_engine.rs:466-483` maps 1, 2, 3, 4, 6, 8, 9, 11, 13, 14 and 15.
- **Effect:** a SIGBUS gives "Phonon worker died (code=null signal=signal 7)". A truncated model file that is
  memory-mapped can cause a SIGBUS.
- The code compiles as written.

### M12. The `[phonon:worker] stdin:` log line has Rust's OS error text

- **Node:** `phonon-engine.js:217` logs "write EPIPE".
- **Rust:** `phonon_engine.rs:724-726` logs "Broken pipe (os error 32)", or "The pipe is being closed. (os error 232)"
  on Windows.

### M13. An added STT test does not test what its name says

- **Rust:** `tests/it/stt_local.rs:304`,
  `a_worker_whose_python_cannot_load_faster_whisper_says_so_and_the_process_is_gone_with_the_app`.
- **What it does:** it runs the worker in mode "ok", transcribes successfully, and checks `is_running()` after
  `stop_stt_worker`.
- **What it never does:**
  - exercise `{ ready: false }` ("faster-whisper did not start: …", `stt_handler.rs:308-316`);
  - drop the app;
  - look at the OS process.
- Kill-on-drop is proven only by the Phonon tests.

## The porter's claims, checked

- **Confirmed: the deliberate differences are real, needed and confined.**
  - **`DELETE /piper-voices/:id` refuses non-plain ids** with 400 "Invalid voice id". Node deleted
    `<data>/outside.onnx` and `outside.onnx.json` through `..%2Foutside`, which was confirmed. Rust also refuses a
    `:` or `%00` anywhere, where Node answered `{ ok: true }`; both are harmless.
  - **`can_warm` by name:** in Node only `PhononTTSEngine` and `FallbackTTSEngine` have `warm`, and the wrapper is
    built only for Phonon.
  - **SIGKILL instead of SIGTERM loses nothing:** neither Python worker handles signals, starts child processes or
    holds lock files. The only file written is the Phonon WAV, which the engine removes on the normal path.
  - **Output of an old worker is ignored, and stderr is read to its end:** both are real and confined.
  - **Multipart error texts** differ only for malformed bodies. "Missing Content-Type", "Unsupported content type: …"
    and "Multipart: Boundary not found" match.
  - **The first STT job snapshot** matches Node.
- **Workers, the same as Node:**
  - Program, arguments, no working folder, and an environment built from `env.snapshot()` with `env_clear()`. Key
    for key it is the same as Node's `env` object; the only addition is `CREATE_NO_WINDOW`.
  - The line protocol, with JavaScript `trim`.
  - Request order (a fair queue).
  - Timeouts: 30 s synth, 120 s and 90 s boot, the STT request limit.
  - A restart on the next request, with no back-off, as in Node.
  - Kill on stop and on drop.
- **Installers, the same as Node:** URLs, revisions, sha256, `PTTS_VERSION` 0.4.2, `FASTER_WHISPER_VERSION` 1.2.1,
  the pip flags, the BUSY/409 texts, the lock, shared runs, the one boot attempt with its 5 s delay, the terminal
  entry, and the folders. Nothing is written outside `tts/phonon`, `STATE_DIR/python` or `DATA_DIR/whisper-models`.
- **The STT status JSON** matched Node field for field in four states.
- **Engine registry, the same as Node:** the choice of engine and its fallbacks, "the newest init wins", Phonon stopped
  only when switching away from it, and the fallback tripping after 3 failures for 5 minutes.
- **Doctor:** the output is byte for byte the same format. The "Tarsee", "Browser" and "SQLite" checks are reasonable
  stand-ins. The Unix memory code (MemAvailable, `sysctlbyname` + `_SC_PAGESIZE`) reads right for `libc`'s types.
- **Port rules:** no stateful `static`, no `std::env::var`, all HTTP through `Fetch`, no `unwrap` on outside data, and
  log and error texts as in Node. The exceptions are I5, M10 and M12.

## Completeness

**Exports:** every export of the eight Node files has its Rust counterpart, including:

- phonon-engine: `VOICES` … `PhononTTSEngine`, `stopPhononWorker`;
- stt-handler: `resetSTTModelCache`, `stopSttWorker`, `warmSTT`, `__setForTests`, `transcribeAudio`, `getSTTModels`;
- the routes: `voiceRouter`, `createSttRouter`;
- the installers, the registry, clone-handler and doctor, as V2.md says.

**Test cases, counted from the files:**

| Node file | Cases | Ported | Notes |
|---|---|---|---|
| `test/stt-install.test.js` | 13 (10 + a loop of 3) | 13 | same assertions |
| `test/stt-local.test.js` | 10 | 10 | same assertions; the idle case waits on the worker instead of sleeping |
| `test/stt-routes.test.js` | 8 | 6 | the two auth/CSRF/token cases are missing, with a reason that does not hold (I4) |
| `test/tts-phonon.test.js` | 40 | 40 | 18 registry, 8 text/voices, 10 installer, 3 runtime, 1 real worker (`#[ignore]`, as Node skipped it) |

The ported cases assert what Node asserted, with one exception: the token half of the transcribe case (I4). Each
would fail if the behaviour broke. I3 and I1/I2 got through because nothing tests a cancelled request or the first
install answer.

## Test run

`cargo test --no-fail-fast`:

| Run | Result |
|---|---|
| unit tests | 1504 passed |
| integration (`it`) | 99 passed, 3 ignored |
| the other test binary | 139 passed |
| doc tests | 21 ignored + 1 ignored |

- An earlier run had one failure outside V2, `codex_cli::kill_tree_stops_the_shim_and_the_program_it_started`. Three
  builds were running at the same time; the test passed on the rerun.
- Clippy was not run.
- No stand-in process survived any run.

COMPLETE: no
FAITHFUL: no
