# Review of D1: Conversations, the live timeline and chat files

Reviewed at `2344f0e` on `rust-rewrite` (D1 merged as `1649cf7..48bb9ff`), against the Node files in the main
checkout. Whole suite before and after the review: every test passes (`cargo test`: 1132 unit, 57 + 139 in the
other binaries, 0 failed).

**Summary:** 0 Critical, 1 Important, 11 Minor.

- **Important:** a race in `conversation_lock.rs`. When a person stops a queued message at the moment the turn ahead
  of it ends, the dashboard sometimes shows "Failed: It could not start" instead of "Removed from the queue".
- **Minor:** the rest are rare, unreachable today, or cosmetic.
- **What held under testing:**
  - The lock: never two holders, arrival order kept, no lost or doubled waiter, no leak, no deadlock.
  - The live bus: sequence numbers and the order events are handed out.
  - The conversation store: on a few hundred rows of a Node-made database it returned the same JSON as Node, byte
    for byte.
  - Path safety of the chat files: no file outside the uploads folder can be reached.

## How this was checked

- **`conversation_lock.rs`.** I read it side by side with `conversation-lock.js` and ran three kinds of tests on a
  multi-thread runtime (8 workers), all in a scratch file that has since been deleted.
  - **Stress test:** 2,000 tasks across 6 conversations, run 6 times. Each turn was given a random fate:
    - it returns normally, or returns an error;
    - it panics (in a spawned task);
    - it is cancelled by a `tokio::select!` with a random 0–400 µs timeout, while waiting or while running;
    - its future is dropped before it is ever polled;
    - another task takes its line out of the queue (Stop) at a random moment;
    - a provider claims its line and publishes a `turn_start` and `turn_end` for it.

    A timeline listener also called `queue_depth` from inside every delivery. Each run was checked for:
    - never two turns inside one conversation at once;
    - the turns that ran did so in the order their calls arrived;
    - every turn that should run ran (no lost waiter), and everything finished within a 60 s limit (no deadlock or
      leak);
    - `queue_depth` was 0 afterwards and no Queued line was left;
    - every `turn_queued` had at most one `turn_end`;
    - no sequence number repeated.

    The checks passed on all 6 runs, apart from my own test bugs, which I fixed.
  - **Race test:** 3,000 rounds of a Stop racing the slot handoff. This is what found I1.
  - **Panicking listener:** a listener that panics while a turn queues. This is what found M1.
  - **Node:** the same kinds of cases run on Node to compare.
- **`live_bus.rs`.** Six threads published while two listeners joined mid-stream: one read the database and then
  listened, the other listened and then read, de-duplicating by sequence number the way `public/js/live.js` does.
  - Live delivery was in sequence order.
  - The listen-then-read merge was complete and in order, with no gap and no duplicate. That merge is the order the
    Node WebSocket hub used: it adds the subscription, then sends the backlog.
  - `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so it is never reused, including after pruning or a restart. The
    insert and the place in the delivery queue are taken under one database lock.
- **`conversations.rs`.** Node's `initDb` built a database, written with Node's own `ConversationStore`, holding:
  - 300 conversations with emoji, Japanese, accented and 5,000-character titles, and empty or missing
    provider/model;
  - updated times shared in groups within the same second;
  - 485 messages with 120,000-character emoji text, timeline JSON, "[name]: " prefixes, token counts of 0 and null,
    and identical `created_at` values;
  - live and expired session handles.

  Copies of that file were then read by Node's store and by the Rust store (`Db::open`, which ran the Rust
  migrations over it without complaint), and their JSON compared:
  - `list` (default, all, page), `get` (20 ids, plus one missing id), `getMessages`, `getRecentMessages` (20 and 5)
    and `messageCount`;
  - `search` with 16 queries, including U+FEFF, U+0085, NBSP, quotes, `*`, `AND`, an empty query and spaces only;
  - `getSessionRecap`;
  - `getSessionHandle`, live and expired, and the row after the expired one was forgotten.

  **All 15 outputs were identical.** Ids are UUID v4 as in Node, and every timestamp comes from SQLite's
  `datetime('now')` or `now_ms()`, as before.
- **Two slices delegated to helpers.** Each ran both versions on shared inputs:
  - `chat_files.rs` and `sent_files.rs`: path safety, `send_viewable` against Express 5 `res.sendFile`, and the
    helpers.
  - `tool_steps.rs`, `message_tools.rs`, `handoff.rs`, `stream_utils.rs`, `gateway.rs`, `acp.rs`, `turn_watchdog.rs`:
    about 125 shared inputs.

  I re-read every finding they reported against both sources before writing it down here.

## Findings

### I1. A Stop racing the slot can end a removed line as "Failed: It could not start" — Important

- **Node:** `src/lib/conversation-lock.js:56-62` (`q.remove`), `:159-162`.
- **Rust:** `src/lib/conversation_lock.rs:151-166` (`QueuedTurn::remove`), `:241-250` (`QueuedLine::drop`),
  `:401-411`.

**What goes wrong.**
- **Node:** `q.remove()` sets `removed` and ends the line as `"removed"` in one step on one thread.
- **Rust, `remove()`:** sets `flags.removed` under the flags lock, lets go of it, and only then calls
  `self.end("removed")`, which takes the lock again to set `ended`.
- **Rust, the turn's own thread:** if the slot comes in between, the turn sets `flags.slot`, sees `removed`, and
  returns `Turn::QueueRemoved`. Dropping its `QueuedLine` then finds `slot == true` and `ended == false`, so it
  calls `end("error", {error: "It could not start"})`.
- **Result:** that `turn_end` is the one published, and `remove()`'s own `end("removed")` does nothing. The caller
  still gets `QueueRemoved` and `on_removed` still runs, but the timeline says the turn failed.
- **What the person sees:** `public/js/live.js:417-433` turns an `error` field into the "failed" state, and
  `chat-core.js` renders it as **"Failed — It could not start"** in the danger tone. The correct line is "Removed
  from the queue". A person who stops a queued message just as the reply ahead finishes sees a red failure.

**How confirmed.** A multi-thread test ran 3,000 rounds:
- Turn A waits at a barrier and turn B is queued with a live line.
- A std thread calls `remove_queued_turn(B)` at the same moment the barrier opens.
- Of the 2,839 rounds where `remove_queued_turn` returned `true`, **27** ended B's line with
  `{"stopReason":"error","error":"It could not start"}` instead of `{"stopReason":"removed"}`.
- In every round, B never ran and returned `QueueRemoved`.

### M1. A listener that panics breaks `publish` and the lock; Node caught a listener's throw — Minor

- **Node:** `src/lib/live-bus.js:173-187`.
- **Rust:** `src/lib/live_bus.rs:454-474` (`deliver`), `:476-496`; `src/lib/conversation_lock.rs:300-327`, `:360-368`.

**What differs.**
- **Node:** `publish` runs `emitter.emit` inside its `try`. A listener that throws is logged as
  `[live-bus] publish <type> failed: ...`, `publish` returns `null`, and the caller goes on.
- **Rust, `publish`:** a panicking listener unwinds through `deliver` and `publish` into the caller. This is despite
  the doc comment "Never fails". The events still in the outbox wait for the next publish.
- **Rust, the lock:** the panic comes out of `with_conversation_turn` at the moment the turn queues. That turn never
  runs. Its `turn_queued` row is already written, so its Queued line stays on the timeline until a restart. Its
  entry also stays in the lock's `waiting` map.

**How confirmed.** I ran the same listener-throws-on-`turn_queued` case on both versions:
- **Node:** logs `[live-bus] publish turn_queued failed: bug on turn_queued`, the turn runs (`b = b`), and no line is
  left queued.
- **Rust:** the call panics, and `queued_turn_list("pl")` still holds the line afterwards.

It needs a listener with a bug in it, so it is Minor.

### M2. Store reads that swallow errors make the channels' get-or-create rebind a chat — Minor

- **Node:** `src/db/conversations.js:91-93`. The callers are `channels/telegram.js:209`, `discord.js:273`,
  `email.js:269`, `whatsapp.js:369`, `slack.js:660,694` and `websocket.js:395`.
- **Rust:** `src/db/conversations.rs:258-267`, `:305-313`.

**What differs.**
- **Difference 3 of the report** says a failed read gives "not found" where Node threw. The report does not say what
  the callers then do.
- **The channel callers:** every one runs `if (!convId || !convStore.get(convId)) { create(...);
  settingsStore.set("channel_conv.<key>", newId) }`. With a read that fails but a write that succeeds, Rust creates a
  new conversation and points the chat at it for good: the old history is cut off from that chat.
- **Node:** the same failure made that one message fail.
- **The WebSocket channel:** answers "That conversation no longer exists" instead of an error.
- **`get_session_handle` and `get_messages`:** a failure starts a fresh session, or gives an empty history.

**How confirmed.** From the two sources side by side. I found no failure that hits a read and spares the write
(rusqlite's strict typing cannot trip on these columns' affinities), so I could not reproduce it.

**Why it matters now.** The report's Risk 4 asks the lead to choose. It should be settled before the channel
packages port these callers.

### M3. Node told a turn begun right after the previous one finished that it was queued; Rust does not — Minor

- **Node:** `src/lib/conversation-lock.js:147-152`, `:177-187`.
- **Rust:** `src/lib/conversation_lock.rs:214-234`, `:336-353`.

**What differs.**
- **Node:** the chain's cleanup (`tail.then`) is queued behind the caller's own continuation. So
  `await withConversationTurn(c, a); withConversationTurn(c, b, opts)` still finds `chains.get(c)`. B gets
  `onQueued(1)` and, with `opts.live`, a `turn_queued` line. The provider then claims that line.
- **Rust:** frees the slot when the turn's future completes, so B starts with no queue.

**How confirmed.** In Node, the sequential pair gives `[["b",1]]` from `onQueued` and `queueDepth` 1 right after. With
one timer tick between the two calls it gives `[]`.

No Node caller I found starts a turn as the immediate continuation of another turn in the same conversation; each
caller is its own message handler. The difference is real but not reachable today, and it is not in the report.

### M4. Whole floats are written as `1.0` in SSE frames, slim history and gateway broadcasts — Minor

- **Node:** `src/lib/stream-utils.js:11` (`JSON.stringify`).
- **Rust:** `src/lib/stream_utils.rs:85` (`serde_json::to_string`), plus the fields `slim_message` passes through and
  `GatewayManager::broadcast` (`Value::to_string`).

**What differs.** `{"a":1.0,"b":2.5}` gives `data: {"a":1,"b":2.5}` in Node and `data: {"a":1.0,"b":2.5}` in Rust.
The browser reads the same number. Difference 12 of the report says whole floats become integers "where this package
makes JSON text"; these three paths do not.

**How confirmed.** Both versions were run on the same input.

### M5. `js_json` prints large and small numbers differently from `JSON.stringify` — Minor

- **Node:** `src/lib/tool-steps.js:25`, `:38`.
- **Rust:** `src/lib/tool_steps.rs:786-806`.

**What differs.**

| Input | Node | Rust |
|---|---|---|
| `100000000000000000000` | `100000000000000000000` | `1e+20` |
| `0.000001` | `0.000001` | `1e-6` |

The fix is available: the foundation's `util::js::number_to_string` (added after D1) prints them as JavaScript does.
The text shows in a tool step's input preview.

**How confirmed.** Both versions were run on the same inputs.

### M6. `idle_limit_ms` trims with Rust's `trim`, and the report's difference 15 is incomplete — Minor

- **Node:** `src/lib/turn-watchdog.js:24` (`Number(env.TARSEE_CHANNEL_IDLE_ABORT_MS) || 20*60_000`).
- **Rust:** `src/lib/turn_watchdog.rs:42-47` (`value.trim().parse::<f64>()`).

**What differs.**

| Value of `TARSEE_CHANNEL_IDLE_ABORT_MS` | Node | Rust |
|---|---|---|
| `"\u{FEFF}5000"` | 5000 | 1,200,000 |
| `"\u{85}5000"` | 1,200,000 | 5000 |

This breaks DESIGN rule 8 ("`text.trim()` is `util::js::trim`"). Difference 15 names hex and `Infinity` but not this.

**How confirmed.** Both versions were run on the same values.

### M7. `disposition_name` replaces a character where Node replaced a UTF-16 unit — Minor

- **Node:** `src/lib/sent-files.js:177` (`replace(/[^\w.\- ()]/g, "_")` on UTF-16 units).
- **Rust:** `src/lib/sent_files.rs:638-644` (per `char`).

**What differs.**

| Path | Node | Rust |
|---|---|---|
| `…/chat-1-0-a🐒.txt` | `a__.txt` | `a_.txt` |
| `🐒-1-x` | `__-1-x` | `_-1-x` |

The download name differs.

**How confirmed.** Both versions were run on the same paths.

### M8. `record_chat_files` reads the clock once per row; Node read it once per call — Minor

- **Node:** `src/lib/chat-files.js:69` (default `at = Date.now()`), `:79`.
- **Rust:** `src/lib/chat_files.rs:245` (`opts.at...unwrap_or_else(now_ms)` inside the loop).

**What differs.** With no `at` given, Node gives every file of one upload the same `at`. Rust can give them different
values.

**How confirmed.** From the two sources side by side.

### M9. `send_viewable` has no `..` refusal of its own, where Express's `send` had one — Minor

- **Node:** `src/lib/sent-files.js:192` (`res.sendFile`, `send` 1.2.1).
- **Rust:** `src/lib/sent_files.rs:678-803`.

**What differs.** Called directly with `<uploads>\..\secret.txt`:
- Node answers 404 (`send` refuses `..` with 403, and the callback turns that into 404).
- Rust answers 200 and the file.

Through the route both answer 404, because `viewable_path` runs first. This is a second guard lost, not a way out
today. R1 must keep `viewable_path` in front of `send_viewable`.

**How confirmed.** Both versions were run on the same path.

### M10. On Windows, `viewable_path` serves other spellings of a file in the folder that Node refused or kept as written — Minor

- **Node:** `src/lib/sent-files.js:148`.
- **Rust:** `src/lib/sent_files.rs:508`.

**What differs.** Rust's `canonicalize` resolves more spellings than Node did:

| Spelling of a file inside uploads | Node | Rust |
|---|---|---|
| A differently-cased folder, a trailing dot or space, a `\\?\` or `\\.\` prefix | `null` (refused) | the real file |
| `CHAT-1~1.TXT`, `a.txt::$DATA` | the path as written | the real path |

So the content type and download name come from the real name. Nothing outside the folder is reached.

**How confirmed.** 17 path forms were run through both versions on Windows.

### M11. The five browser cases of `test/chat-files.test.js` have no package that will port them — Minor

- **Node:** `test/chat-files.test.js:257` (`core.splitNotes`), `:304`, `:313`, `:320`, `:327` (the viewer's rules,
  `public/js/file-viewer-core.js`).

**What differs.**
- **The report** defers these cases to "package WEB".
- **`PLAN.md`:** has a WEB section, but its list is empty. W1's list does not include `chat-files.test.js`.
- **`tests/ui` (W1a, merged after D1):** has none of them, although its harness now runs browser files.
- **Result:** they are accounted for in the report but tracked nowhere. They should be added to WEB's (or W1's) list
  in `PLAN.md`.

## The report's claims

**Differences 1–15:**

| # | Verdict |
|---|---|
| 1 | Real. Half an emoji is left out at every cap (checked at each cut). |
| 2 | Real (`parse_json_lossy`). |
| 3 | Real; see M2. |
| 4 | Real. |
| 5 | Real. |
| 6 | Real. |
| 7 | Real. |
| 8 | Real. |
| 9 | Real. |
| 10 | Real, and holds for every form Tarsee writes. |
| 11 | Real. Node actually threw a `TypeError` on a non-string text. |
| 12 | Too narrow; see M4. |
| 13 | Real. |
| 14 | Real. |
| 15 | Incomplete; see M6. |

- **The ones the Rust model forces:** 4–9 come from threads, and from futures that can be dropped.
- **Avoidable but harmless:** 10, and the hex and `Infinity` part of 15.

**Node bugs ported as they are:**
- **#1:** a turn awaiting a turn of its own conversation waits for ever, in both versions.
- **#2:** 404 for 412 and 416, confirmed against Express.
- **#3:** the same SQL.
- **#4:** confirmed. The expired handle sets `updated_at` in both (`after3` and `handle3` were identical in the
  comparison).
- **#5:** 0 is stored as NULL in both (identical `tokens_in` in the comparison).
- **#6–#8:** confirmed from the sources.

## Completeness

**Exports.** Every export of the twelve Node files has its Rust counterpart:

| Node file | Exports |
|---|---|
| `live-bus.js` | 17 of 17 |
| `conversation-lock.js` | 8 of 8 (plus `QueuedTurn::end`, which `routes/chat.js` calls as `currentQueuedTurn()?.end("aborted")`) |
| `conversations.js` | every method |
| `chat-files.js`, `sent-files.js` | 13 of 13 each |
| tool-steps, message-tools, handoff, stream-utils, gateway, acp, turn-watchdog | complete |

**Test cases, counted from the Node files:**

| Node test file | Cases | Ported | Not ported, with the reason |
|---|---|---|---|
| `test/conversation-lock.test.js` | 7 | 7 | |
| `test/live-bus.test.js` | 26 | 26 | |
| `test/handoff.test.js` | 14 | 14 | |
| `test/chat-files.test.js` | 21 | 6 whole + 6 in part | 4 need S3 (the reason holds); 5 browser cases (M11) |
| `test/db.test.js`, `ConversationStore` cases | 8 | 8 | |
| `test/conversation-settings-cleanup.test.js` | 4 | 3 | the daily sweep needs `lib/retention.rs` (S1) |

- In `live-bus.test.js` the 26 cases are 7 + 3 + 4 + 3 + 6 + 3.
- The ported assertions are as strong as Node's or stronger: whole JSON strings, internal maps checked empty, and
  extra concurrency cases. I found none weaker.

## The rules of the port

- No `static` holds state; `TURN_STORE` is a task-local, standing for `AsyncLocalStorage`.
- The environment is read through `app.env()`.
- No `unwrap`/`expect` outside tests in `live_bus.rs`, `conversation_lock.rs` or `conversations.rs`; in the other
  files they appear only on regex literals.
- The Node log texts are kept, and the "why" comments are carried over.
- No lock is held across a wait on another lock:
  - the lock module's state and flags locks are never held while publishing or touching the database;
  - the bus takes its turn and outbox locks inside the database lock, never the other way round.
- `get_or_init` is race-free, so two first callers share one `ConversationLocks`.
- Exceptions: M6 (`str::trim`). Synchronous file calls in `keep_*`, `note_*` and `tidy_*` mirror Node's sync calls,
  which the report's Risk 6 already notes.

COMPLETE: yes
FAITHFUL: no
