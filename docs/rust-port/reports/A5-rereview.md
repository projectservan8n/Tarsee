# A5 re-review (fix round 1)

Checked in the worktree at `8a3ff04` (contains the fix merge `0a15a7a`; the fix diff is `bac416f..0a15a7a`), against
the Node code of the main checkout at the same commit. No source file changed; the throwaway test
(`tests/it/zz_review_scratch.rs`) and its `mod` line are deleted. Every comparison below ran the Node code and the
Rust code on the same input; the Node scripts are in `E:\tmp\tarsee-rs\scratch-recheck-A5\`, not in the repository.

## The findings

1. **I1. An unreachable Local AI is always "(network error)" with the real HTTP client: ADDRESSED** for the two cases
   the review ran, with one hole still open (below). The Node bridge (its own `http.request`) and the Rust bridge
   (`tarsee::net::ReqwestFetch`) were pointed at the same owner's servers, three requests each (one for a
   time-out). Same 502 (status,
   `content-type`, body) for: a port nothing listens on, as `127.0.0.1`, `[::1]`, `localhost` and `https://`
   ("connection refused"); a name under `.invalid`, four spellings, http and https ("the name isn't known"); a server
   that resets the connection, at once or after reading the request ("the connection was reset"); a connect that
   times out, `10.255.255.1:81` and `192.0.2.1:81` ("it took too long to answer", after 14 s on both sides). No body
   held the turn's token, its id or the owner's key. Not the same: a server that hangs up without answering (hole 1).
2. **M1. A byte order mark at the start of an event stream: ADDRESSED.** 43 streams through the real Node server and
   the real Rust server, the owner's answer given in exact pieces on both sides: the mark whole, a byte at a time,
   cut 1+2 and 2+1, with empty pieces inside it, two and three marks, a mark only, half a mark then the end, a bad
   byte or a space or a line break before it, a mark in the middle, a UTF-16 mark, an emoji cut before and after it,
   CRLF frames, `[DONE]`, a comment, with and without tools to map back, an upper-case content type, and a JSON reply
   that starts with a mark. All 43 byte for byte the same. The review's two inputs give `event: response.failed` and a
   first frame with its `event:` line.
3. **M2. PowerShell's wrapper over a million characters: ADDRESSED.** `unwrapShellCommand` and `unwrap_shell_command`
   on 80,340 different commands of my own (27,505 of them unwrapped by Node): 196 hand-written (quoted and unquoted
   paths, a quote in every place, nested quotes, `-Command`, `-EncodedCommand`, `-enc`, `-e`, `-c`, `-CommandLine`,
   `-Command:`, upper and lower case, `ſ` and the Kelvin sign, every kind of JavaScript whitespace and three
   characters that are not (U+0085, U+180E, U+200B), spaces at the end), 25,000 built from pieces the pattern takes,
   30,000 from pieces it may or may not take, 30,000 random strings of its atoms. 0 differ. And 27 texts of 0.3 to
   4.5 MB built from the same recipe on both sides (the review's two, 700,000 options, 300,000 separators, 300,000
   false starts, 2,000,000 blanks, 2,000,000 quotes): all the same as Node, the slowest under half a second in a
   debug build. The `fancy_regex` is gone from the file.
4. **M3. Two requests Node's HTTP server refused: ADDRESSED** for the review's two requests, with one hole still open
   (below). 63 raw requests on a socket to both servers. Same: no `Host` in HTTP/1.1 is `400` (with a right token, a
   wrong one, none, another path, a body, a chunked body, an absolute target, after a good request on the same
   connection); `Host:` empty, blank, upper case or twice is served; HTTP/1.0 without `Host` is served; headers of
   16,383 counted bytes are served and of 16,384 refused with `431`, in one header, in sixty, in the query, in a
   header sent twice, in a POST with its body, in HTTP/1.0, and before the token is looked at; 17,000 and 20,000 are
   `431`. Nothing refused reached the owner's server; both answers carry `Connection: close` and no body.
5. **M4. Usage counts written as "Infinity": ADDRESSED.** 4,016 usage objects (16 hand-written, 4,000 random over
   about 40 kinds of value in each of the five counts, 40% with a baseline) through `mapCodexEvent` and `usageEvents` on both
   sides: events, state totals and the step's total the same in all of them, 628 of them with a `null` input count.
   (74 differ only in how a total over 2^53 is written, `9007199254741092.0`; that is `js_num`, not in the fix diff.)

## The lead's three tasks

- **`TARSEE_COMPACT_WINDOW=off` leaves the limit out: done, and every other value gives Node's number.** 5,247 calls
  of `buildCodexOptions` on both sides: 107 values of the setting (unset, empty, 13 spellings of "off", `offk`, `of`,
  `0ff`, `off` with U+0085 or U+200B, full-width `ＯＦＦ`, `false`, `none`, `0`, `-1`, `150k`, `150K`, the Kelvin sign,
  `1.5k`, `1e5`, hexadecimal, `Infinity`, `NaN`, Arabic and full-width digits, values at each limit and half way
  between two whole numbers) with 16 context windows, 10 windows named in the call and 5 providers. Compared: the
  limit, the config's keys in order, and every `--config` argument but the instructions'. 0 differ. The 416 calls
  Node's own rule reads as "off" (with no window named in the call) have no `model_auto_compact_token_limit` key and
  no argument, where Node wrote 0; a window named in the call still sets it. (In 101 calls the limit is not a finite number, a context of
  Infinity with a window of Infinity: `config_args` refuses the null where Node wrote `=Infinity`. Not in the fix
  diff, and no context window is infinite.) Nothing else reads the key.
- **One grant type whose `Debug` never shows the token: done.** `{:?}` prints
  `McpGrant { url: "http://127.0.0.1:45678/mcp", .. }` and `{:#?}` the same over four lines; inside an `Option`, a
  `Vec` and `EngineOptions` (which derives `Debug`) the same. `CodexOptions`' `Debug` shows neither the token nor the
  key, and the token is in no `--config` argument, only in the child's `TARSEE_MCP_TOKEN`. Searched
  `src/ai/engine.rs`, `mcp_http.rs`, `local_bridge.rs`, `providers/codex_options.rs` and `codex_events.rs` for a
  token or key in a `format!`, a log line or an error text: none (`mcp_http.rs`'s log lines are fixed words, a
  server's or a body's read error, a panic's text and a file error; `Grant`, `Turn` and `CodexContext` have no
  `Debug`; the 502's reason is one of a fixed list of words and codes, never the error's own text).
  `codex_options::McpGrant` is gone and nothing else used it.
- **`engine_entry` stays where it is:** as the report says.

## Holes still open

1. **I1: an owner's server that hangs up without answering is still "(network error)", or a bare "ECONNABORTED".**
   - Input: a turn opened on a server that takes the connection and ends it with no answer, the bridge on
     `ReqwestFetch`. Eight ways, 30 requests each on both sides; the two resets are the same (finding 1), the other
     six differ. The two "as soon as it has it" ways were run 2,800 more times on the Rust side.
   - Node: `Can't reach your Local AI at … (the connection was reset).` every time, for all eight (its
     `http.request` reports `socket hang up`, code `ECONNRESET`).
   - Rust, a server that reads the request and then closes or ends the connection, or sends half a header and
     closes: `(network error)` every time.
   - Rust, a server that ends the connection as soon as it has it (`socket.end()`): `(network error)` every time
     (2,800 of 2,800).
   - Rust, a server that closes it as soon as it has it (`socket.destroy()`): it depends on which side is quicker.
     Of 2,800: 1,841 `(the connection was reset)`, 899 `(ECONNABORTED)`, 60 `(network error)`.
   - Why: hyper reports a connection that ends before an answer as "connection closed before message completed",
     which holds no `io::Error`, so `connect_failure_text` (`src/net/fetch.rs:304`, the last arm at line 355) passes
     that text on with no code and `reach_why` (`src/ai/local_bridge.rs:984`) has nothing to read. On Windows the
     same hang-up can also arrive as `ConnectionAborted`, written "connect ECONNABORTED 127.0.0.1:<port>" (lines 343
     and 353), which `reach_why` shows as the code. Node calls both `ECONNRESET`.
   - Who sees it: as in I1, Codex's error text and logs. A server that stops or restarts with a request in hand
     closes its connections this way (the request was read, so the close is a plain end, not a reset).
   - The fixer's tests cover a refused connection and an unknown name with the real client; the reset is only fed to
     `reach_why` as text ("read ECONNRESET").
   - Listed in the report as a difference, and confirmed: an `https://` address that reaches a plain HTTP server is
     "EPROTO" in Node and "network error" here; a reply that is not HTTP is "HPE_INVALID_CONSTANT" in Node and
     "network error" here.
2. **M3: blanks after a header's value are not counted, so 20 KB of them is still served.**
   - Input: a valid turn request with `X-Pad: p` followed by 20,000 spaces (or tabs, or 60,000 spaces), or sixty
     headers each with 400 spaces after its value. At the limit: 16,383 counted bytes and one space after a value
     (after the `Authorization` or `Host` value too).
   - Node: `431`, nothing sent to the owner's server. Its parser counts the blanks after a value (not the ones
     before it: 20,000 before the value are served on both sides).
   - Rust: `200`, passed to the owner's server (with the value trimmed). hyper has taken the blanks off before
     `header_bytes` counts (`src/ai/local_bridge.rs:1414`, used at line 1492).
   - Minor, as M3 was: the turn's path and token are still needed, and Codex sends no such header.

## New breakage

None found in the fix diff.

- Callers: `reach_why`, `Utf8Decoder` (the bridge's own; the web terminal has another), `header_bytes`,
  `powershell_command` and `tarsee_usage` each have one caller, in the same file. `McpGrant` is used by
  `engine.rs`, `mcp_http.rs` and `codex_options.rs`, all updated; it still has `Clone`, `PartialEq`, `Serialize`
  and `Deserialize`.
- Ordinary behaviour: a plain GET, a POST with a JSON body, HTTP/1.0 with a `Host`, an absolute target, a second
  request on a kept connection, and event streams with no mark are the same as Node in the runs above; so are
  ordinary shell wrappers (`bash -lc`, `sh -c`), ordinary usage counts and the default compact window.
- Tests: none weakened. The 502 test now uses the real client on a port just freed; the `.invalid` test asks the
  system's resolver for a name that never resolves (the foundation's own test does the same). The Node comparison of
  the options changes only its "compact off" case, and first checks that Node's value there was 0.
- The other differences among the 63 raw requests are not from this fix (hyper's own behaviour, there before it),
  and in none of them does a request Node refused reach the owner's server: a request with more than 100 headers is
  `431` here and served by Node (101 and 150 tried); headers over the limit that never end get `431` from Node at
  once and no answer here until they end; a chunk extension of 20,000 bytes is `413` in Node and `400` here; a single
  header of 70,000 bytes is `431` here, and Node closed the connection before its answer could be read; after a
  request with no `Host`, Node went on to run a second request sent on the same connection (and reached the owner's
  server for it), here the connection is closed.
- Seen once and not again: in one run of 30 requests against the server that ends the connection at once, one request
  to the Rust bridge got no answer in 75 s, while another build was using the machine. 2,800 more runs through the
  bridge and 300 with the client alone all answered at once.

## The suite

`cargo test --no-fail-fast`, once, after the throwaway test was removed: 1,930 + 126 + 144 passed, 1 failed (5 + 22 +
1 ignored). The one failure is not in this package: `routes::skills::tests::work_a_request_started_finishes_when_the_browser_leaves`
(`src/routes/skills.rs:410`, its 10-second wait ran out while the whole suite was running). Run alone it passed, four
times of four. The package's own tests pass: `ai::local_bridge` 46, `ai::providers::codex_events` 32,
`ai::providers::codex_options` 31, `ai::mcp_http` 34.

Findings: 5 of 5 ADDRESSED. Holes still open: 2 (I1's hang-up, M3's blanks after a value). New breakage: none.
