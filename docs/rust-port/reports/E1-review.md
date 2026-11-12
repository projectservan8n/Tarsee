# E1 review: message formatting for Discord, Slack and email

Reviewed on `rust-rewrite` at `a9bc6da` (the package was merged in `55fa65f`). The Node files were run from the main
checkout. Every comparison below ran the Node function and the Rust function on the same input. Nothing was taken from
the porter's report without checking it.

## Result

The port is faithful. I compared the Node and Rust code on about 50,000 values and 623 Slack stream scenarios (23
written by hand, 600 random). They differ only in the two places the report names, plus two small things listed under
Findings. Neither finding changes anything a person would normally see.

## What was checked, and how

### Completeness

- **Exports.** Every export of the ten Node files has a public Rust counterpart under the Rust form of its name:
  - `discord-format.js`: 12 exports.
  - `slack-format.js`: 10.
  - `slack-stream.js`: 2.
  - `email-parser.js`: 5.
  - `email-threading.js`: 3.
  - `tool-status.js`: 2.
  - `turn-notes.js`: 5.
  - `chat-target.js`: 3.
  - `reaction-parser.js` and `channel-errors.js`: 1 each.
- **Node test cases, counted from the test files.** Each one has a Rust test with the same name in snake_case:
  - `discord-format.test.js`: 51 (48 `test()` calls, plus one inside a loop of 3).
  - `email-parser.test.js`: 31 (22 are in `email_parser.rs`, 9 in `email_threading.rs`).
  - `slack-format.test.js`: 21.
  - `slack-stream.test.js`: 19.
  - `tool-status.test.js`: 6.
- **Assertions.** The ported tests assert at least what the Node tests did.
  - The `null`/`undefined` halves that were left out cannot be written against `&str`, as the report says.
  - "no lone surrogates on a hard cut" was replaced by a stronger check: every emoji arrives, and the pieces are pinned
    at [2001, 98] units.
- **Test count.** `cargo test --lib -- --list` lists 182 tests in the package's modules, as the report says.
- **The porter's "printed by the Node code" tables.** I fed all 321 entries back through today's Node code, including
  the nine stream scenarios compared call for call. All 321 match. The expected values really are Node's, so these
  tests fail if the Rust output changes.

### Same output, character for character

Inputs I wrote myself, run through Node (`node`, main checkout) and Rust (a throwaway test), with the results compared
as JSON:

| Function | Inputs | Same |
|---|---|---|
| `formatForDiscord` / `formatTablesForDiscord` (tables) | 36 + 36 | all |
| `formatForDiscord` (block quotes) | 25 | all |
| `stripInlineMd` | 34 | all |
| `displayWidth` | 36 | all |
| `splitMessageFenceSafe` (2000/4000 marks, emoji, CJK, Arabic, ZWJ, CRLF, U+2028, fences) | 26 | 24 (the other 2 are where Node crashes; see below) |
| `parseMdTables` / `toAsciiGrid` / `toLabeledLines` | 20 / 18 / 18 | all |
| `slackTextToPlain` | 28 | all |
| `mentionsUser`, `displayForSlack`, `splitForSlack`, `stripCommandSentinel` | 10, 10, 5, 5 | all |
| `slackEmojiName` (every key of the Node table, plus 19 others) | 78 | all |
| `openFence` + `closeFence` | 14 | all |
| `MarkerFilter` (push by push, then `end`) | 15 | all |
| `stripQuotedReply` | 29 | all |
| `hasMention` (including JavaScript's non-Unicode `i` folding: ſ, K, ß, ǅ, ﬀ, µ, ΐ) | 35 | all |
| `isReplyAll` | 25 | all |
| `threadKeyFromHeaders`, `htmlToText` | 11, 24 | all |
| `buildReplyHeaders`, `normalizeReplySubject`, `resolveRecipients` | 10, 17, 10 | all |
| `parseReactions` | 28 | all |
| `toolStatusLabel` + `toolDoneLabel` | 36 | all |
| turn notes (`turnErrorNote`, `idleNote`, `errorStillToSay`, `sttProblem`) | 24 | 18 (finding 1) |

Seeded random inputs, run the same way:

- Markdown fragments, with random tables mixed in.
- Fence and emoji lines for the splitter.
- Slack markup with marker pieces.
- Email bodies.
- Templates aimed at block quotes and at "@kw reply all".

Three rounds made 49,807 compared values, and all were the same. The random inputs did exercise the code paths that matter:

- 693 tables drawn as a grid and 231 drawn as lines.
- 869 empty quote lines.
- 449 multi-chunk splits.
- 90 true reply-alls.

Every regular expression in the Node files was read next to its Rust form:

- `js_text::translate` gives JavaScript's `\s` (with U+FEFF, without U+0085), `.` stopping at U+2028/U+2029, and ASCII
  `\d \w \b`.
- The `i` flag is written as `(?i-u:…)`.
- Replacements use `${1}` or `NoExpand`.
- The hand-written lookahead matchers (the `_italic_` pattern, the bot-mention placeholder, the quote marks) and the
  `hasMention`/`isReplyAll` matchers agree with Node in every input above.

### `slack-stream`

- I wrote 23 scenarios of my own. Every one gives an identical call list, field order included, plus the same
  callbacks and end state. They cover:
  - Refused calls at each point: a rate-limited `appendStream` mid code block, and `missing_scope` on a tool card.
  - `stopped_by_user` from a rollover `stopStream` and from the very first `startStream`.
  - `message_not_in_streaming_state` on the final stop (the tail is posted with its fence closed), and under a
    task-only append.
  - A refused rollover start while tools are running, and a failed `postMessage` and `update` in editing mode.
  - Ticks before, at and past the limit, in editing mode, and with no stream.
  - The task cap with text waiting, and the time limit checked in `finish`.
  - CRLF fences, and whitespace-only text.
- I also ran 600 random scenarios (random steps, limits and failure rules). 588 gave the same calls. In each of the
  other 12, the Node calls carry a lone surrogate, which is documented difference 1.
- The futures of `text`, `tool_start`, `tool_done`, `tick` and `finish` are `Send`, so H2 can spawn them.

### Rules of the port

- No state outside the instance. The only `static`s are regexes in `LazyLock`.
- No `std::env`.
- `unwrap`/`expect` appear only on regex literals.
- Log lines keep the Node text: `[slack] native streaming failed (…)`, `[slack] stopStream failed: …`,
  `[slack] chat.<method> failed: …`.
- The comments that explain why were carried over. I checked each one in `discord-format.js` and `slack-stream.js`,
  and spot-checked the rest.

### Tests

`cargo test`: 677 passed in the library, 51 in `tests/it`, 0 failed.

## Findings

### 1. Turn notes trim with Rust's whitespace set, not JavaScript's

- **Severity:** Minor.
- **Node:** `src/channels/turn-notes.js:21`, `:40`, `:49` (`.trim()`).
- **Rust:** `src/channels/turn_notes.rs:70`, `:104`, `:114` (`str::trim`).

These are the only places in the package that use Rust's `str::trim` rather than `js_text::trim`. Rust's trim treats
U+0085 as whitespace and U+FEFF as not; JavaScript's does the opposite. Confirmed by running both:

| Call | Node | Rust |
|---|---|---|
| `turnErrorNote({providerLabel:"Codex"}, "﻿bom﻿")` | `…problem: bom\n\n…` | `…problem: ﻿bom﻿\n\n…` |
| `turnErrorNote(_, "x\u0085")` | keeps `x\u0085` | `x` |
| `errorStillToSay("abc", "﻿b")` | `false` | `true` (an error note Node would not send) |
| `errorStillToSay("x", "\u0085")` | `true` | `false` |
| `sttProblem({code:"stt-unavailable", message:"﻿"})` | `null` | `Some("\u{FEFF}")` |
| `sttProblem({code:"stt-failed", message:"\u0085"})` | `"\u0085"` | `None` |

This only matters when an error message starts or ends with one of those two characters. The fix is to use
`js_text::trim` in these three places.

### 2. `slack_error_code` promises to read a wrapped error, and does not

- **Severity:** Minor.
- **Node:** `src/lib/slack-stream.js:21-23`.
- **Rust:** `src/lib/slack_stream.rs:70-74`. The report says the same at `E1.md:39-40`.

The doc says it reads a `SlackApiError` "(or one wrapped as the error's own source)". The report says it "also works
on an `anyhow::Error` holding one". The code only downcasts the top-level error, so a wrapped error gives `None`.
Confirmed by running:

- `slack_error_code(anyhow::Error::new(SlackApiError::platform("ratelimited")).as_ref())` gives `Some("ratelimited")`.
- `slack_error_code(anyhow::Error::new(SlackApiError::platform("ratelimited")).context("while posting").as_ref())`
  gives `None`.

What it does matches Node (`err?.data?.error` reads only the top level). What it promises does not. H2 or H4 code that
adds `.context(...)` before checking for `stopped_by_user` or `ratelimited` would silently miss the code. Either walk
`source()` or correct the doc and the report.

## The two documented differences: checked

1. **A cut never splits an emoji.**
   - In my comparisons, the Rust output differs from Node's only where Node's output holds a lone surrogate:
     - The native stream cut.
     - The editing cut.
     - The 600-unit clip in `turnErrorNote`, through `utf16_truncate`.
   - In native mode, the text across all messages is the same as Node's once Node's halves are joined.
   - The report says "Cuts that do not land inside a character are unchanged". That holds for each cut on its own.
     Later cuts in the same reply can still move by one unit, because the next message starts with the whole emoji
     (2 units) instead of a low surrogate (1 unit).
   - Random scenario 173 (`maxStreamChars` 20) shows this. After the emoji moved, a trailing "```js\n" no longer fit on
     the final stop. Rust appended "```js", rolled over, and sent "\n" in one more message.
   - This is a consequence of the documented difference, not a separate one, and Node's output there was not valid
     text. I report it only so the wording can be read with that in mind.
2. **The fence-safe splitter stops where Node looped.** Both of my inputs that reach a room of zero or less made
   Node throw `RangeError: Invalid array length` after about 10 s:
   - `"a\n```\n\n\n```\nb"` at 6, where Rust gives `["a","```\n`\n```","```\n`\n```","```\n`","b"]`.
   - `"x"` at 0, where Rust gives `["x"]`.

   From the source, a room of zero or less with a non-empty line always loops in Node (`slice(0, b)` / `slice(b)`
   with `b <= 0`). An empty line is dropped in both. Every other split input was identical, so the difference is
   confined to inputs where Node crashed.

## Notes for other packages (not findings against E1)

- **H2 (Slack):** the stream treats any error except `stopped_by_user` as a reason to edit messages for the rest of
  the reply.
  - In Node, `app.client` (`@slack/web-api` 8.3.0, `rejectRateLimitedCalls = false`,
    `retryConfig = tenRetriesInAboutThirtyMinutes`) waited out an HTTP 429 for its `Retry-After`, and retried network
    errors, before it threw (`node_modules/@slack/web-api/dist/WebClient.js:431-451`).
  - An H2 `SlackClient` that returns `ratelimited` at once would send replies to the editing fallback far more often
    than Node did.
  - The report's H2 handover does not mention this.

COMPLETE: yes
FAITHFUL: yes
