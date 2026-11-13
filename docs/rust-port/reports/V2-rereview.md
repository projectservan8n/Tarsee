# V2 re-review: the fixes after the review of the voice routes

Checked at `8a3ff04` (the fix round is the range `dde64da..344c47a`), in the worktree `s9`, against the Node code in
the main checkout. No source file was changed; the scratch test (`tests/it/zz_review_scratch.rs`) and its `mod` line
were removed again.

**16 of 18 findings are addressed.** The two that are not (M4, M6) were left for package Z1, as DESIGN's rule 9 says.
Two small new differences came with the fix: the order of lines asked for at the same moment (N1), and an empty
array as `text` on `/tts-stream` (N2). Three older gaps in the fixed areas are still open. None of the five mixes up
answers or leaves a file or a process behind.

## How it was checked

- **Dropped requests:** a scratch test dropped requests at chosen events against the two worker stand-ins
  (`fake-phonon`, and the fake Python's `stt_worker.py`), then made three more requests each time.
- **Both routers:** the review's list of requests was run again through Express and through
  `routes::voice::router()`, with 93 more requests for the areas the fix touched (205 in all). 167 answers are
  identical. The 38 that differ are listed under "The 38 answers that differ".
- **Node's real engines** (`EdgeTTSEngine`, `PiperTTSEngine`, `PhononTTSEngine.speechText`) were run with a `text`
  that is not a string.
- **The installs:** `POST /phonon/install` was run twice against Node and against Rust, and the answers compared.
- **Not done:** the code from before the fix was not built, so "the problem is gone" means the review's own steps
  now give the right result. The fixer's statement that their tests fail with the tasks undone was not repeated.

## The findings

| Finding | Result | How it was checked |
|---|---|---|
| I1. A Phonon request whose caller goes away gives later lines the wrong answer and leaves WAVs | ADDRESSED | Dropped at six points, see "I1 and I2 in detail". The review's own steps (worker answers after 800 ms, line dropped at 200 ms, three more lines) now speak all three, with nothing left in tmp. |
| I2. A transcription whose caller goes away leaves the recording, and the worker never stops for idleness | ADDRESSED | Dropped at eleven points through four ways in, see below. The review's own steps (800 ms, dropped at 300 ms, idle limit 300 ms): the recording is removed and the worker stops. |
| I3. `POST /phonon/install` answers before the run has reset its status | ADDRESSED | First click and Retry both answer `phase: "runtime"`, `percent: 0`, a new `startedAt`, `finishedAt: null`, `error: null`: the same as Node, field for field. Also after a run that failed in the model phase, and in 60 rounds on a 4-thread runtime. The speech-to-text install and a model's download answer with the new job on a retry too (`phase: "python"`, `percent: 1`, as Node's first snapshot). |
| I4. Two `stt-routes` cases not ported | ADDRESSED | All 8 Node cases are there and send what Node sent. The same requests were sent through four weakened copies of the test's router: without `require_auth` 3 assertions fail, without `csrf_protect` 2, without `session_auth` 6, with none 5. With all three, none fails. |
| I5. Long blocking file work on the runtime | ADDRESSED | Read: the Piper upload, the model delete and the Piper delete run in `spawn_blocking`; the four venv removals use `remove_all_async`. A removal that fails now stops the install, as `fs.rmSync` threw in Node. |
| M1. File or field decided differently from busboy | ADDRESSED | The review's four requests and 16 more now answer as Node. One older gap remains (O1). |
| M2. The raw-audio routes take a JSON body as audio | ADDRESSED | `/stt`, `/transcribe` and `/clone` with valid, empty, array, string, number and broken JSON answer as Node (the broken-JSON text is serde's, as elsewhere). One older gap remains (O2). |
| M3. `/tts-stream` speaks a `text` that is not a string | ADDRESSED | Node's real engines: Phonon reads `5`, `true`, `["a","b"]`, `{}` as "5", "true", "a,b", "[object Object]"; Edge TTS and Piper throw "text.replace is not a function". The route does the same per engine. The fixer's correction of the review (Phonon speaks, it does not throw) is right. One value is handled wrongly, an empty array (N2). |
| M4. Trailing slash and any case | NOT ADDRESSED | Left for Z1 (DESIGN rule 9). `/tts/`, `/TTS`, `/stt/` are still 404. |
| M5. A path parameter that does not decode answers in plain text | ADDRESSED | `%FF`, `a%2`, `%`, `%zz`, `%+1`, `%C0%AF`, `%ED%A0%80`, `a%C3`, `%E0%A4%A` give Express's 400 and text; `a%20b`, `a+b`, a query string decode as Node. |
| M6. JSON answers lack `; charset=utf-8` | NOT ADDRESSED | Left for Z1 (DESIGN rule 9). The report now says so. |
| M7. Form fields and urlencoded bodies have no size limit | ADDRESSED | A `name` of 1 MB + 77 bytes is cut at 1,048,576 bytes on `/clone` and `/piper-upload`, the same length as Node's answer. A urlencoded upload is the same 400. |
| M8. The report said a NaN percent was ported; it was not | ADDRESSED | Read: the speech-to-text percent is `Option<i64>` and stays `null` after a NaN, as in Node. For Phonon the total is never 0, so there is no NaN to port. |
| M9. `api_key` reads the environment with no settings store | ADDRESSED | `/status` with and without a store answers as Node. Read: ElevenLabs and the paid Whisper API get a key only through a store. |
| M10. Names from outside not taken literally on Windows | ADDRESSED | Read: the Phonon voice files go through `to_namespaced`. The Piper half was fixed after this round, in V1's code (`piper_engine.rs:288`, `:308`). |
| M11. A Unix signal outside a short list is "signal N" | ADDRESSED | Read only. The table and its test are Unix code, which is not compiled on this machine. |
| M12. The stdin log line has Rust's OS error text | ADDRESSED | The test writes to a real process that has ended and gets "write EPIPE"; it passes here. |
| M13. An added STT test does not test what its name says | ADDRESSED | Read: replaced by one test of `{ ready: false }` and one that looks at the OS process after a stop and after the app is dropped. Both pass. |

## I1 and I2 in detail

**Phonon, through the engine** (worker answers after 200 ms). A line was dropped at each of these points, then three
more lines were spoken:

- after its first step;
- while the worker process was starting;
- once the worker had the request;
- while the answer was being read (the WAV was on disk; 10 of 10 drops landed there);
- while it waited behind another line;
- two lines dropped at once.

Every later line had its own audio. Every line, dropped or not, was spoken once, in the order asked. No worker was
started beyond the first and the one the test itself stopped for the second point, and tmp was empty at the end.

**Phonon, through `POST /tts` and `POST /tts-stream`**, with the engine alone and behind `FallbackTtsEngine`: the
same result, and the spare engine was never used (so no failure was counted).

**More ways through the same hole**, all with the right result:

- the worker crashes on the dropped line;
- the worker answers the dropped line with an error;
- a `POST /warm` whose client leaves (the worker still starts, once);
- the engine is stopped while a dropped line is being spoken (its WAV is removed).

**On a 4-thread runtime:** 240 lines at once, 80 of them dropped at different moments. No wrong answer, every line
spoken exactly once, one worker, no WAV left. The same with 150 recordings, 50 dropped.

**Speech-to-text**, through `transcribe_audio`, `POST /transcribe` (raw and multipart) and `POST /stt` (worker
answers after 150 ms). Dropped after the first step, once the recording was on disk, once the worker had it, behind
another recording, two at once, and after 120 to 190 ms (around the answer). 183 recordings were issued and 183
reached the worker, each once. Every later request had its own answer, tmp ended empty, and the worker stopped for
idleness.

**A worker that never answers:**

- Phonon: two dropped lines and one waited for. Each ended at its 30 s limit, one after the other (90 s). Three
  workers were started and all three processes were gone afterwards. The task count went back to where it began, and
  no file was left.
- Speech-to-text (400 ms limit): five dropped recordings left five files at first. All five were removed within
  2.4 s (through the function) and 3.7 s (through the route), and the next recording had its own answer.
- There is no cap on how many requests can wait, in Rust or in Node. Each waits its turn, then ends at its time
  limit; the recording of a queued transcription is on disk until then. This is what Node's promise chain did.

**Stopping the service with requests in flight** (one being worked on, two waiting, all three dropped):

- The one being worked on ends at the stop (the code fails it with "Phonon worker stopped" or "the speech-to-text
  worker was stopped"), and its WAV or recording is removed.
- The two that wait start a fresh worker and run, as Node's queue did. For Phonon (400 ms a line) all tasks had
  ended 1.2 s after the stop. With a worker that never answers, each of them would run to its own time limit.
- Every process that was started was gone afterwards, and no file was left. For Phonon this needed no second stop:
  Rust ends the worker started after the stop when the last waiting line is done. Node (read, not run) would keep it.

## New with the fix

### N1. Lines asked for at the same moment are no longer spoken in the order asked (minor)

- **Node:** `phonon-engine.js:274-296`. `synth()` adds the request to the queue before it returns, so the order
  spoken is the order asked.
- **Rust:** a request now reaches the queue only after several tasks have each been started and run:
  `routes/voice.rs:84` (`to_the_end`), `engine_registry.rs:498`, `phonon_engine.rs:1181` and `:729`. On a runtime
  with more than one thread, tasks started together can run in any order. The speech-to-text queue has the same
  shape (`stt_handler.rs:759` and `:165`).
- **Input:** six `synthesize` calls made at once by one caller, a worker that answers in 5 ms, 30 rounds, 4 threads.
- **What happened:**

  | Caller | Rounds spoken out of order |
  |---|---|
  | the test's main future | 4 of 30, and 7 of 30 in a second run |
  | a task of the runtime | 26 of 30 |
  | the one-thread runtime the suite uses | 0 of 30 |

  Separate `POST /tts-stream` requests, each in its own task, five per round:

  | Time between requests | Rounds out of arrival order |
  |---|---|
  | 0 µs | 23 and 24 of 25 |
  | 20 µs | 21 and 24 of 25 |
  | 100 µs | 1 and 6 of 25 |
  | 500 µs, 2 ms | 0 of 25 |

- **Effect:** every line still gets its own audio. The call page asks for all sentences of a reply at once
  (`call.js`, `say()`) and plays them in order. When a later sentence is synthesized first, the earlier one starts
  later by one synthesis.
- **Before the fix** (read, not run): the queue was entered in the caller's own future, so one caller's lines kept
  their order. Separate requests could already swap on a multi-thread runtime; the extra tasks make that more likely.
- No test sees it, because every test runs on one thread.

### N2. `{"text": []}` on `/tts-stream` counts as a Phonon failure, and three of them switch Phonon off (minor)

- **Input:** `POST /tts-stream` with the body `{"text": []}`, three times, with Phonon behind its spare engine (the
  normal set-up). Then `{"text": "Hello."}`.
- **Node** (run): each one throws "No speakable text after cleanup" with the code `EMPTY_TEXT`. The route answers 500.
  No failure is counted and the spare is not used.
- **Rust** (run, with a stand-in as the spare): each one is handed to the spare engine as an empty text, and its
  answer is the route's answer. Each counts as a Phonon failure. After the third, Phonon is skipped for 5 minutes:
  "Hello." was spoken by the spare, and the Phonon worker was never started.
- **Why:** `routes/voice.rs:808` turns `[]` into the empty text (as `String([])` does) and hands it on.
  `phonon_engine.rs:1124` then refuses an empty text with "Text is required", which has no `EMPTY_TEXT` code. In Node
  the array itself passed that first check (`![]` is false), and the cleanup step gave `EMPTY_TEXT`.
- **Before the fix:** the route answered 400 "Text is required" and no engine was called.
- Only a hand-built request from the signed-in owner can do this. The browser always sends a string.

## Still open in the fixed areas (not caused by the fix)

### O1. A part with `filename*=` is not a file

- **Input:** `POST /transcribe`, multipart, `Content-Disposition: form-data; name="audio"; filename*=utf-8''a.webm`.
- **Node:** 200, the audio is transcribed (busboy reads `filename*`).
- **Rust:** 400 "No audio file provided". `routes/voice.rs:491` only knows `filename=`.
- Browsers send `filename=`. Only hand-built requests are affected.

### O2. A JSON body with another charset on an audio route

- **Input:** `POST /stt` with `Content-Type: application/json; charset=latin1`, or `charset=utf-16`, body `{"a":1}`.
- **Node:** 415 `unsupported charset "LATIN1"`, and 400 for utf-16.
- **Rust:** 200, transcribing 0 bytes. `routes/voice.rs:383` (`raw_audio`) asks `routes/skills.rs:327`
  (`express_json_body`), which does not look at the charset.
- Only hand-built requests are affected.

### O3. Three installer tests still depend on real time

- **Where:** `tests/it/stt_install.rs:82` (`watch`) looks at the job every 5 ms of real time. Three cases assert on
  what those looks happened to see:
  - `:188`: the phases seen are exactly venv, packages, check, model, and a step names ctranslate2;
  - `:248`: a step names the Python download;
  - `:342`: more than two looks, one with a percent between 0 and 100.
- A phase that is shorter than the gap between two looks is missed, and the case fails. The comment at `:173` records
  that this already happened once (pip's lines were slowed to 25 ms for it).
- It is the Node test's shape (`test/stt-install.test.js:86`), ported as it was. The Rust stand-in is a native
  program, so its phases may be shorter than the Node stand-in's (not measured). All three passed here.
- **The rest is as the Fix round says:** no elapsed-time assertion is left in the package's tests. Every other
  sleep is inside a loop that waits for an event (a process gone, a job ended, a folder empty, a worker stopped)
  with an upper bound of 60 or 120 s.

## The 38 answers that differ

| Count | What | Why |
|---|---|---|
| 9 | `DELETE /piper-voices/<id>` with `..`, a separator, a drive or NUL | deliberate: Rust answers 400 "Invalid voice id" |
| 9 | malformed JSON (3) and malformed multipart bodies (6) | serde's and multer's texts, listed in V2.md |
| 9 | the echoing stand-in engine says `string` where Node's says `number` or `object` | the stand-in takes text only; not a route difference |
| 4 | `/tts-stream` with a number or `[]` for the stand-ins named "edge-tts" and "piper" | Rust answers the 500 the real engines give; Node's stand-in accepts anything |
| 3 | trailing slash and upper case | M4, left for Z1 |
| 2 | JSON with another charset | O2 |
| 1 | `filename*=` | O1 |
| 1 | the order of cloned voices made in the same second | depends on the clock, not on the fix |

The stand-in engines hide N2: it shows only with the real Phonon engine behind its spare, which was run apart.

## Test run

`cargo test --no-fail-fast`, once, after the scratch test was removed:

| Run | Result |
|---|---|
| unit tests | 1931 passed |
| integration (`it`) | 126 passed, 5 ignored |
| `ui` | 144 passed |
| doc tests | 22 + 1 ignored |

Nothing failed. No stand-in process was left running afterwards.

One more scratch case (N2) was run after that and removed again; the tree is the same as for the run above, and the
package's integration tests were run once more on it (34 passed).
