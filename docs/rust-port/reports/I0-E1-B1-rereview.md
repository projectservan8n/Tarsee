# Re-review of the fixes for I0, E1 and B1

Checked at the merged code (`40e4ee7`). Node code was run from the main checkout. Throwaway tests (a scratch file under
`tests/it/`, deleted with its `mod` line afterwards) compared Rust with Node.

## I0: 5 of 5 addressed

1. **A command cannot tell whether its caller handed it the channel manager** (Important): ADDRESSED.
   `CommandContext` now has `channel_manager: Option<Arc<dyn ChannelApi>>` (`src/lib/command_api.rs`), and a test
   (`a_command_has_the_channel_manager_only_when_its_caller_handed_it_over`) shows `/status` with and without it while
   the app has a manager all along. `INTERFACES.md` says a command reads `ctx.channel_manager` and "never
   `channel_manager(app)`", and the `channel_manager` doc in `channels/api.rs` says the same. The table of callers
   was compared with the Node call sites (`grep processCommand(`, `buildSystemPromptParts(`, `runDiagnostics(`, and
   the argument lists read one by one): `processCommand` passes it only at `routes/chat.js:412`; the prompt gets it
   from `routes/chat.js`, `routes/external-api.js` and `channels/websocket.js` only (subagents, cron, heartbeat, boot,
   ACP, five channels do not); `runDiagnostics` gets it from `routes/health.js`, the debug route, the WebSocket console
   and `/doctor` through its context. All match. The `settingsStore` remark (debug console passes none) also matches
   (`routes/debug.js`, `websocket.js:635`).
2. **`I0.md` said `build-system-prompt.js` only passes the manager through** (Minor): ADDRESSED. Section corrected, and
   the table row for `build_system_prompt_parts` is right (see 1).
3. **`Usage::merge_into` made up zero counts** (Minor): ADDRESSED. Counts are `Option`, left out when absent, and
   `Usage::merge` is the spread (a later `Some` replaces, `None` keeps, `extra` merged). Unit tests cover it; the
   workspace compiles, so no other caller of the old field types was left. The partial route is documented as
   writing `""`/`null`/`false`.
4. **The fake engine's sleep test slept for real** (Minor): ADDRESSED. `#[tokio::test(start_paused = true)]`; it
   measures on the paused clock.
5. **`autoSummarize` claim** (Minor): ADDRESSED. `grep autoSummarize src docs` finds no remaining claim that
   `commands.js` reads it.

New breakage: none. `CommandContext` lost its serde derives; nothing in the tree serialises it (it compiles and the
tests pass).

## E1: 2 of 2 addressed, bug fixes sound: yes

1. **Turn notes trim with Rust's whitespace** (Minor): ADDRESSED. The three places use `util::js::trim`. I ran the
   Node functions on `"﻿bom﻿"` and `"x\u0085"` and the other cases of the finding: Node gives `bom`, keeps
   `\u0085`, `false`, `true`, `null`, `"\u0085"`, which is what the new Rust test asserts.
2. **`slack_error_code` does not read a wrapped error** (Minor): ADDRESSED. It walks `source()`. Throwaway test:
   bare error `Some("ratelimited")`; after `.context("while posting").context("outer")` still `Some("ratelimited")`;
   `Err(SlackApiError).context(..)` gives `stopped_by_user`; an error without one gives `None`.

Bug fixes (emoji at a cut, CRLF fences):
- **Same as Node without emoji and without CRLF.** 120 generated texts (30 of them plain: fences of both kinds,
  tables, quotes, long lines, CJK, limits 25 to 145). For the 30 plain ones `splitMessageFenceSafe`,
  `splitForSlack`, `openFence`, `closeFence` and `formatForDiscord` gave identical output to Node in every case.
  The same holds for the emoji texts where Node's own pieces were all within the limit and nothing was cut inside an
  emoji (except below).
- **With emoji or CRLF.** 3000 random texts (half CRLF, half with 1 to 40 repeated emoji, balanced ``` fences with
  language tags, limits 20 to 119) through both splitters: 6000 results, 0 pieces over the limit (UTF-16 units), 0
  pieces ending inside an open fence, no character lost or duplicated (text without fence lines, whitespace and `\r`,
  compared as a whole). `split_for_slack` shares the code.
- One thing seen and judged fine: where an emoji sits on a fence line that is itself longer than the limit (a line
  such as `~~~` followed by 28 emoji, limit 55), the new Rust output differs from Node's (Node left the line whole,
  unsplit, over the limit; Rust cuts it). The cut-off tail is then content in the next piece, exactly as Node does
  for a long line without emoji. A pathological input, and consistent with the rest of the function.

New breakage: none found.

## B1: 3 of 3 addressed, bug fixes sound: yes

1. **`ENCRYPTION_KEY` trimmed with Rust's whitespace** (Important): ADDRESSED. Fixed in the foundation's
   `Env::trimmed` (uses `util::js::trim`), plus pinned tests in `vault.rs`. I encrypted with the Node vault under 8
   keys (`U+FEFF` and `U+0085` at the start, the end and both, with ordinary spaces, U+00A0, U+2028) and decrypted
   in Rust: all 16 values read. Then the reverse, Rust-encrypted and Node-decrypted: all 16 read.
2. **Audit log panics on a closed database** (Minor): ADDRESSED. `with_open` checks `Db::is_open` and returns an
   error; `log` logs `[audit] failed to write log: The database connection is not open` as Node does, and `query`
   and `count` return the error. The new test closes the database and asserts the log line and both errors.
3. **No test pins the `credential` alternative** (Minor): ADDRESSED. The new test
   `each_word_of_the_secret_field_pattern_is_needed_for_a_field_of_its_own` uses a string-valued field only one
   alternative matches (`credentials`, `accessToken`, ...). In a scratch copy of the pattern, removing each of the 7
   alternatives left exactly that test's field unmatched (and no other), so the test fails. The nine key patterns
   are pinned by exact index sets, and the `api[_-]?key` separators by existing tests (`my_api_key_thing`,
   `MY_API-KEY_NAME`).

Bug fixes:
- **CSRF signature of the wrong length is 403.** `verify` now uses `safe_compare` (length-checked, then constant
  time) and returns `bool`; the token's bytes are what is compared, as Node's `Buffer.from(token)`. Tokens of every
  odd shape in the tests answer 403 with no `[error]` log line. Nothing is looser: a token is accepted only when it
  equals the one signed for its timestamp, byte for byte (`1794495903789e0.` and `+1794495903789.` are refused, as
  before).
- **A private address inside an IPv6 one is refused.** Through `check_tool_permission` for `web_fetch` and `browser`:
  33 private spellings all refused (mapped dotted and hex, upper case, long form `0:0:0:0:0:ffff:...`, with port,
  with user info, `https`/`ws`, each private range and `169.254.169.254`, compatible `::a.b.c.d`, `::`, `::1`,
  `fd..`, `fe80..`), 13 public ones still allowed (`::ffff:8.8.8.8` and its hex form, `::ffff:172.32.0.1`,
  `172.15.x`, `11.x`, `192.169.x`, `169.253.x`, `::8.8.8.8`, real IPv6 such as `2001:4860:4860::8888`). Zone ids
  (`[fe80::1%25eth0]`) do not parse as URLs, so they are let through to fail, as in Node. Not covered by the fix
  and not required: NAT64 `64:ff9b::7f00:1`, 6to4 `2002:7f00:1::`, `::ffff:0:7f00:1` and `fc00::/8` pass, as `fc00` did
  in Node.
- **Login route reads `Content-Type`.** I ran 21 headers through Node's real `express.json()` (the
  `content-type` package); the answers (parsed, passed by, 415 with the charset in upper case) are the ones the
  Rust test table asserts, including the first-charset-wins, the unclosed quote, `charset=`, `;;` and `utf-16`
  (Node parses UTF-16 text; Rust answers 415, stricter, and is listed as a difference in the code). Not looser.
- **`agent_vault_env` looks names up in the `Env`.** For the app's own environment it is the live `Env` (so on
  Windows `ComSpec` blocks `COMSPEC`, as `process.env` does); a caller's plain map is still matched by exact name. A
  name found by more spellings can only keep more keys out, so it is stricter, not looser. The trim is the shared
  `util::js::trim`.

New breakage: none found.

## Tests

`cargo test`, run once with the scratch file removed: 1642 + 105 + 139 passed, 0 failed (3 + 21 + 1 ignored).
