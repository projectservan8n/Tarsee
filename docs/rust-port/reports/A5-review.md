# Review of A5: Codex options, events and the Local AI bridge

Reviewed at `d5772a9` on `rust-rewrite` (package merged at `2d96d1c`), against the Node code of the main checkout.
Every difference below was confirmed by running the Node code and the Rust code on the same input, unless it says
"side by side". The throwaway comparison test is deleted; the Node scripts are not part of the repository.

## What was compared

My own comparisons, not the porter's captures:

- **`buildCodexOptions`**: 6,000 random combinations of every `ctx` input `codex.js` passes (env with and without
  `TARSEE_COMPACT_WINDOW` in 10 spellings, the test seams in and out of `NODE_ENV=test`, vault keys, keys in quotes or
  with line breaks or BOMs, state folder or named home, padded workspaces, grants with and without url or token,
  six instruction texts up to 100 KB with and without saved memories, Local AI addresses and bridges, attribution,
  context and compact windows, account model lists, skills folder, turn mark, platform) over 11 provider spellings.
  3,849 built and 2,151 refused. The whole result was compared: `providerId`, `home`, `env`, the config serialized in
  its key order, `apiKey`, `threadOptions` in key order, `configArgs`, and for a refusal its class, code and words.
  **All equal.** `TARSEE_COMPACT_WINDOW=off` (and ` OFF `) gives `model_auto_compact_token_limit: 0` in Node when no
  `compactWindow` is passed, as the report says.
- **Codex events**: every fixture of `test/fixtures/codex/` replayed whole with 11 turn options and 8 endings (704
  runs), and 4,000 random sequences of 1 to 14 events (unknown types, missing and wrong-typed fields, ids that are
  numbers, objects, `null` or repeated, odd usage, retries, errors after output, non-object events, emoji and secrets
  in text and tool arguments, tool errors). Compared: every event, the end events and the state after. Also 2,018
  shell commands through `unwrapShellCommand` and 1,395 `classifyCodexFailure` calls. Nothing panicked; all equal
  except M4 and the differences the report lists (below). The fixtures' events are all typed (`TurnEvent::Other` only
  for odd ids or odd usage).
- **The bridge, end to end**: 2,000 random scenarios through the real Node server and the real Rust server, with the
  owner's server replaced on both sides (random Responses requests with namespace tools, odd tools, history items,
  lead messages, instructions and `tool_choice`; random upstream answers, SSE and JSON, status 200/201/302/400/429/500,
  cut at random byte positions, often one byte at a time). Compared: what went upstream (target, method, headers in
  order, body bytes) and what came back (status, `content-type`, `cache-control`, `retry-after`, body bytes). Equal
  except M1 (17 scenarios) and the integer-key order the report lists (6). Also: 120 streams with bad UTF-8 at every
  place and chunk size (equal), 54 raw HTTP requests for who may connect (M3 and the report's header-bytes difference),
  35 `open()` addresses and keys (equal), 5,000 `redactBridgeUrls` and 3,000 `flatName` inputs (equal), the bytes the
  real HTTP client puts on the wire, and an HTTP/2 preface (refused, as Node).
- **Linux**: the crate built in WSL Ubuntu; the package's 103 tests pass there, the bridge's connection-cutting tests
  included.

## Findings

### I1. An unreachable Local AI is always "(network error)" with the real HTTP client

- **Severity:** Important (the Node words are not kept; the test that pins them cannot see it)
- **Node:** `src/ai/local-bridge.js:344-351` (`reachWhy` reads `err.code`), used at line 428.
- **Rust:** `src/ai/local_bridge.rs:974-1009` (`reach_why` looks for words in the `FetchError` text), with
  `src/net/fetch.rs:260-274` (`error_from` keeps only the first `source()` of the reqwest error).
- **Input:** a turn opened on `http://127.0.0.1:<a closed port>/v1`, and one on `http://no-such-host.invalid/v1`, the
  bridge using `ReqwestFetch` (what `local_bridge(&app)` uses through `app.fetch()`).
- **Node:** `Can't reach your Local AI at http://127.0.0.1:…/v1 (connection refused).` and `… (the name isn't known).`
- **Rust:** `Can't reach your Local AI at … (network error).` for both. The `FetchError::Connect` the real client
  gives holds only `client error (Connect)`; the io error that says "refused" or the DNS failure is deeper in the
  chain, so none of `reach_why`'s words can match (refused and DNS were run; a reset or a connect time-out reaches
  `reach_why` the same way, read side by side).
- The report's difference 3 says these cases are named "as Node did"; the test
  `an_owners_server_that_isnt_there_is_a_502_that_names_the_owners_address_never_the_bridges_token`
  (`local_bridge/tests.rs:752`) and `why_the_owners_server_could_not_be_reached_in_short_words` (line 1324) feed a
  made-up message ("tcp connect error: Connection refused (os error 111)") that the real client never produces. The
  Node test reached a real closed port.
- Who sees it: the 502 body goes to Codex and into its error text and logs. Tarsee's own words for the person do not
  quote it (checked in Node: `classifyCodexFailure` gives the "Can't reach your Local AI" hint for both texts, and the
  retry lines say "answered 502 Bad Gateway"), so the browser shows the same thing.

### M1. A UTF-8 byte order mark at the start of an event stream is not taken off

- **Severity:** Minor
- **Node:** `src/ai/local-bridge.js:445-450`: `new TextDecoder()` drops a BOM at the very start of the stream.
- **Rust:** `src/ai/local_bridge.rs:835-877` (`Utf8Decoder`), used at line 1692: the BOM stays.
- **Input:** an owner's server answering `text/event-stream` whose body starts with `EF BB BF`.
- **Node:** the BOM is gone; frames are read and rewritten normally.
- **Rust:** the BOM is passed on, and the first frame's first line no longer starts with `event:` or `data:`. With
  `\uFEFFdata: {"error":"out of memory"}`, Node answers `event: response.failed` with the server's words; Rust passes
  the raw frame (BOM included), so Codex never gets the failure. With a first frame that needs its namespace back, Rust
  writes it without its `event:` line. No known Local AI server sends a BOM.

### M2. A PowerShell wrapper over about a million characters is not taken off when its path is not quoted

- **Severity:** Minor
- **Node:** `src/ai/providers/codex-events.js:124-131`.
- **Rust:** `src/ai/providers/codex_events.rs:131-139` and `416-428`: the `fancy_regex` hits its default backtrack
  limit (1,000,000), the `Err` is read as "no match", and the command is shown with its wrapper.
- **Input:** `pwsh -Command Get-Content x/y; aaaa…` with 2,000,000 `a` (also a 2,000,000-character unquoted path
  before `pwsh.exe`).
- **Node:** the script alone, in 11 ms. **Rust:** the whole wrapper. At 600,000 characters both agree, and Codex's
  real wrapper (the quoted `"C:\…\powershell.exe" -Command …`) is still unwrapped at 2,000,000.

### M3. Two requests Node's HTTP server refused are served

- **Severity:** Minor (not an access-control difference: both still need the turn's path and token)
- **Node:** `src/ai/local-bridge.js:388` (`http.createServer` defaults: `requireHostHeader`, 16 KiB of headers).
- **Rust:** `src/ai/local_bridge.rs:1208-1238` (`axum::serve` with hyper's defaults).
- **Input:** a valid turn request in HTTP/1.1 without a `Host` header; one with a 20 KB header.
- **Node:** `400` and `431`, nothing sent upstream. **Rust:** `200`, passed to the owner's server. Without the token
  both are refused on both sides; Codex always sends `Host` and small headers.

### M4. Usage counts written as the text "Infinity" give 0 input tokens instead of null

- **Severity:** Minor
- **Node:** `src/ai/providers/codex-events.js:107-114` (`Math.max(0, NaN)` is `NaN`, written as `null`).
- **Rust:** `src/ai/providers/codex_events.rs:238-246` (`f64::max` returns the other operand for `NaN`).
- **Input:** `{"type":"turn.completed","usage":{"input_tokens":"Infinity","cached_input_tokens":"Infinity"}}`.
- **Node:** `usage.input_tokens: null`, step `input: null`. **Rust:** `0`. Codex sends numbers.

## The differences the report lists

All confirmed; none changes what Codex, the owner's server or a person sees, except where noted.

1. Idle keep-alive connections stay open: Codex's client manages its own pool; nothing waits on it.
2. Header bytes as UTF-8: confirmed (`X-Latin: café` in Latin-1 arrives upstream as `caf\uFFFD`). Codex sends ASCII.
3. Network failure words: wider than stated; see I1.
4. JSON `serde_json` refuses, and integer-like keys: confirmed (a body with `"0":1` keeps the key in place; Node moves
   it first). Invisible to a JSON reader.
5. `reqwest`'s own headers: on the wire, `accept: */*` is added when Codex sent none; one `content-length`; a GET with
   a body sends its `content-length` without the body, as Node did.
6. Dropping a `BridgeTurn` releases it: checked (turns go to 0 on drop). G2 must hold it for the whole turn.
7. An emoji cut in half at a text limit: confirmed in 41 event runs; with the half removed, the events are equal.
8. A patch change that is `null`: Node throws `TypeError: Cannot read properties of null (reading 'kind')` out of the
   mapping; Rust maps an `Edit` of "". Codex never sends one.
9. Key order of typed events: confirmed. `error` events are written `type, message, subtype, recoverable, code`
   (Node: `type, message, code, subtype, recoverable`, or `type, code, recoverable, message` / `type, subtype, code,
   recoverable, message`), and the `usage` object in `turn_types.rs`' order. Same keys and values.
10. `TARSEE_COMPACT_WINDOW` from the given environment only: callers pass the server's environment.

The Node bug ported as it is (`TARSEE_COMPACT_WINDOW=off` gives a compact limit of 0) is what Node does.

## The bridge's lifetime and connections

- **Codex hangs up while the bridge waits for the owner's headers:** checked with a raw socket: the request to the
  owner's server is dropped at once (hyper sees the end of the connection mid-message and drops the handler), and the
  same turn serves the next request. Not covered by the package's tests (theirs cover a hang-up mid-stream).
- **Mid-stream hang-up, release, close:** the reply stream owns the owner's body stream, so it ends with it; each
  request's child token is dropped with it; the only tasks are the server (ends on `stop`) and `drain` (ends with the
  body). A request released while its body is still arriving goes on, as in Node.
- **`BridgeListener` / `CuttableStream` on Unix:** built and run on Linux (above). No platform-specific code; every
  read, write and flush polls the cancellation future first, so a cut wakes an idle connection; hyper drives an
  HTTP/1 connection from one task, so the single stored waker is enough; `poll_shutdown` is not gated, so the close
  completes. It compiles and is right.

## Completeness

- Exports: all 12 of `local-bridge.js`, 7 of `codex-options.js` and 8 of `codex-events.js` have their Rust
  counterparts (`localBridge()` is `local_bridge(&app)`).
- Tests: 22 + 23 + 21 = 66 Node cases; all 66 are in the Rust files under the same names, with the same assertions or
  stronger. The one assertion not written (`capInstructions("a\uD800b", 1000)`) is accounted for in the report.

## Rules of the port

No state in statics (regexes only); no read of the environment (`current_platform` is the compile-time OS); every
outgoing request through `Fetch`; nothing blocking; no `unwrap`/`expect` on outside data (only on regex literals),
indexing and arithmetic guarded; JavaScript's `trim` where Node trimmed; error words kept except I1.

## Tests

The whole suite (`cargo test`, after the throwaway test was removed): 1,769 + 108 + 139 passed, 0 failed (3 + 21 + 1
ignored, as before). The package's 103 tests also pass on Linux. They assert what the Node tests asserted; the one
that passes for the wrong reason is the 502 test (I1), which uses an error text the real client never gives.

Findings: 0 critical, 1 important (I1), 4 minor (M1 to M4).

COMPLETE: yes
FAITHFUL: no
