# Re-review of D1 after fix round 1: Conversations, the live timeline and chat files

Checked at `8a3ff04` on `rust-rewrite` (the merge of the fix branch), against the code before it (`2f14fc4`) and the
Node files in the main checkout. Windows 11.

**Result: 12 of 12 findings are addressed.** The fix brought in two new problems. Both are small, and no caller that is
merged today can reach either. Whole suite: 2,200 passed, 1 failed (a test of another package, which passes
when run alone), 5 ignored.

## How this was checked

- **One scratch test file, run on both versions of the Rust code:** the merged code, and an export of `2f14fc4` built
  beside it. So each finding was first seen to go wrong on the old code and then seen gone on the new. The file and its
  `mod` line were deleted afterwards.
- **The same inputs through Node.** A script ran the Node modules of the main checkout over one list of inputs, in one
  fixture folder (an uploads folder, a file outside it, a junction that leads out and one that stays in, a file whose
  name ends in a dot). The Rust code then ran over the same list in the same folder, and the two outputs were compared
  line by line. The list: 65 paths the page asks for, 19 paths given straight to `send_viewable` (Node's through
  Express 5 over HTTP), 21 paths the agent sends, 38 upload names, 18 download names, 67 values of the idle variable
  and 35 JSON texts.
- **The lock:** my own stress test on a runtime with 8 worker threads, described under I1.

## The findings

| | Finding | Verdict | How it was checked |
|---|---|---|---|
| I1 | A Stop racing the slot can end a removed line as "Failed: It could not start" | ADDRESSED | My stress test, below. Old code: 27 of 40,000 rounds ended a removed line as "It could not start". New code: 0 of 220,000. |
| M1 | A listener that panics breaks `publish` and the lock | ADDRESSED | A listener that panics on `turn_queued`. Old code: the panic came out of `publish` and out of `with_conversation_turn`, and one line stayed queued. New code: `publish` returns `None`, the event is written, the next publish is delivered, both turns run, no line is left queued, depth 0. |
| M2 | Store reads that swallow errors make the channels' get-or-create rebind a chat | ADDRESSED | Each read has a `try_` form. On a healthy database nine comparisons of `try_` against the plain name were equal. On a database without the tables every plain read said "nothing" and every `try_` read was an error. No merged code reads from the store, so nothing rebinds today; the rule for the channel packages is in the module notes. The old names: 113 lines of output on one database (list, get, messages, recent, count, search; handles that are live, expired, empty, with no time, with an unreadable time) were byte for byte the same before and after the fix. |
| M3 | Node told a turn begun right after the previous one finished that it was queued; Rust does not | ADDRESSED, by writing it down | The behaviour is unchanged on purpose. Run again: Node says `[["b",1]]`, Rust says nothing. It is now in the module notes, in the report as difference 16, and pinned by `a_turn_begun_right_after_the_one_before_it_finished_is_not_queued`. The two versions still differ here. |
| M4 | Whole floats are written as `1.0` | ADDRESSED | 35 JSON texts through `send_sse`, the gateway's `broadcast` and the indented form: each equal to `JSON.stringify`. Old code: 16 differed. `slim_message` and the live bus hand on their values with whole floats made whole. |
| M5 | `js_json` prints large and small numbers differently | ADDRESSED | Among the same 35: `1e20`, `0.000001`, `1e21`, `1e-7`, a 30-digit number, 2^53 + 1, the largest `u64` and the smallest `i64` are all written as Node writes them. |
| M6 | `idle_limit_ms` trims with Rust's `trim` | ADDRESSED | 67 values of the variable (a byte order mark, U+0085, hex, octal, binary, `Infinity`, `1e400`, `1_000`, full-width digits, U+180E, U+200B): each equal to Node. Old code: 15 differed. No `str::trim` is left in the package's twelve files. |
| M7 | `disposition_name` replaces a character where Node replaced a UTF-16 unit | ADDRESSED | 18 names: each equal to Node. Old code: 4 differed. |
| M8 | `record_chat_files` reads the clock once per row | ADDRESSED | 3,000 rows in one call: 649 different times on the old code, 1 on the new. |
| M9 | `send_viewable` has no `..` refusal of its own | ADDRESSED | 19 paths against Express: 18 equal (the other is a relative path, which Express refuses to take at all). Old code answered 200 with the file for `uploads\..\secret.txt`; new code answers 404. 35 more spellings are under "More ways through" below. |
| M10 | On Windows, `viewable_path` serves other spellings of a file | ADDRESSED | 65 spellings: 64 equal to Node. Old code: 14 differed. The one left is under "Seen on the way". |
| M11 | The five browser cases have no package that will port them | ADDRESSED | `tests/ui/chat_files.rs` read beside the Node cases at `test/chat-files.test.js:257-327`: the same inputs and assertions. They pass in the suite. |

### I1: the stress test

Each round is a new conversation: a turn ahead, a queued turn with a line and an `on_removed`, and a plain turn behind
it. The turn ahead and two other threads spin on one flag. When it goes up, the turn ahead ends (which hands the slot
over), one thread makes the Stop a few spins later, and in every third round the other thread drops the queued turn's
future at a random moment in the same window. The number of spins follows the last round, so the Stops land on both
sides of the hand-over. Each round checks: what the Stop answered; what the turn returned; whether it ran; whether its
caller had been told and its line had ended at the moment it returned; that the line has exactly one `turn_end`; that
the turn behind began only after that line ended (0 rounds broke this where the future was not dropped; the dropped
ones are under "Seen on the way"); that no two turns were inside at once; that the queue is empty.

| Code | Rounds | Stop in time / too late | Line ended "It could not start" | Back before `on_removed` | Back before its line ended | Two inside at once |
|---|---|---|---|---|---|---|
| Before the fix | 40,000 (9,917 dropped) | 19,876 / 20,124 | **27** | 13,864 | 10,953 | 0 |
| After the fix | 120,000 (33,148 dropped) | 59,461 / 60,539 | 0 | 0 | 0 | 0 |
| After the fix, no drops | 100,000 | 50,031 / 49,969 | 0 | 0 | 0 | 0 |

A second test ran 28,800 turns in 16 conversations at a time, each with a random fate (runs, fails, dropped while
waiting or running, stopped, stopped and dropped, never polled): never two turns inside one conversation, the turns
that ran did so in arrival order, none was lost, every line ended once and as what happened, and every turn a Stop took
out ended "removed", never ran and had `on_removed` called once.

**What the new wait costs.**
- **A Stop that does not finish holds the removed turn and its conversation.** With an `on_removed` that does not
  return, 1.5 seconds after the turn ahead had ended the removed turn was not back, the turn behind it had not begun
  and the queue's depth was still 2. On the old code both had gone on. A timeline listener that blocks on the removed
  line's `turn_end` does the same. This is the report's "What callers should know" point 1, and it is no worse than
  Node, where such a callback stopped the whole server. R1 must keep `on_removed` to what cannot block.
- **Nothing else holds it.** The Stop is synchronous and waits for nothing of the turn's: one row written, the
  listeners, `on_removed`. A panic in any of them still lets the turn go (the flag is set as the Stop unwinds). Dropping
  the removed turn's future while its Stop is held passes the slot on at once.
- **Two turns never held one conversation's lock**, in any of the runs above.

### More ways through the holes the fix closed

All on the new code, in a test app's workspace with a file `secret.txt` beside the uploads folder.

- **The page asks for a file** (`viewable_path`, then `send_viewable` on the same text): 35 spellings that point out
  of the folder. `..` with either slash; `.. ` and `..  ` with trailing spaces; `...`; `uploads.` and `uploads `;
  `uploads\C:\..\..\secret.txt`; the whole workspace path, a bare drive and a drive-relative path in the middle;
  `\\?\` and `\\.\` in front; `\\?\GLOBALROOT\Device\Null`; `::$DATA`; `nul`, `con`, `aux.txt`; another case; a
  trailing dot. `viewable_path` gave `None` for every one. `send_viewable` answered 404 for every one that has a `..`
  in it or names no file as written. It answered 200 only for the four that name the outside file plainly, with no
  `..` (the path itself, with `\\?\` or `\\.\` in front, and with `::$DATA` behind). Node's answers 200 for the plain
  path too: neither has a folder check of its own, so R1 still has to put `viewable_path` in front.
- **An upload called anything at all** (`keep_uploaded_files`): `C:\Windows\win.ini`, `/etc/passwd`,
  `\\server\share\x.txt`, `..`, `a.`, `b `, `...`, `nul`, `con`, `a:b.txt`, an empty name, `..\..\up.txt`, `C:`,
  `C:evil.txt`, `x\C:\y`, `COM1.txt`, a NUL, `sub/../../z`. Each was kept as one plain file inside the uploads folder,
  and nothing new appeared in the workspace or the state folder. (The 38 names of the Node comparison were each kept
  under the name Node kept them under.)
- **Tidying** (`tidy_kept_files`): it removed the old copies, the ones named `chat-…-old.` and `chat-…-x ` among them
  (the old code left those two), and left an old copy with the same kind of name outside the folder alone.
- **Whether a copy is gone** (`file_view`): asked of the name as written. A trailing dot, a trailing space, `nul`, `...`
  and a drive in the middle are all "gone".
- **The `_async` twins:** each gave what the plain name gave (uploads, a sent file, a missing file, tidying,
  `note_sent_file`, `note_media_blocks`). A 64 MB upload whose caller was dropped after one microsecond was on disk in
  full afterwards.

## New breakage

### B1. On Windows, a sent path with a drive in the middle keeps a different file — low

- **Where:** `src/lib/sent_files.rs:208` (`let base = current.join(name);`) and `:218-221` (`next.push(rest)`), in the
  new `real_path`.
- **Input:** `keep_sent_file("<workspace>\C:\Windows\System32\drivers\etc\hosts", uploads, now)`. Also with
  `<uploads>\c:\…`, with forward slashes after the drive, and with `<workspace>\C:Windows\win.ini`.
- **What happened:** it returned `Ok`, and `uploads\sent-<now>-hosts` held the 630 bytes of the real
  `C:\Windows\System32\drivers\etc\hosts`. `viewable_path` then lets the page open that copy.
- **Node:** `fs.realpathSync` throws (there is no such file), and `noteSentFile` keeps nothing.
- **Before the fix:** refused, as in Node.
- **Why:** `PathBuf::join` and `push` throw away everything before a piece that starts with a drive letter and a
  colon. So the walk goes on from `C:` (the current folder of drive C), and each name after it is looked up there, not
  literally. This is the case DESIGN names under "Joining paths", and the one `4856b47` fixed in `normalize`.
- **What it does not reach:** `viewable_path` refuses every such spelling (the result is compared with the folder as
  text), so the page cannot use it to read outside the folder. Nothing merged calls `keep_sent_file` or
  `note_sent_file` yet. The Node `send_file` tool takes any absolute path and looks the file up itself first, so a port
  that does the same (literally) never gets here. It is a function that answers for a file other than the one named,
  where Node and the old code said "not found".

### B2. An `f32` goes through the new JSON writer as a longer number — low, no caller today

- **Where:** `src/lib/tool_steps.rs:837-839` (`write_f32`), used by `send_sse`, `js_json` and the gateway.
- **Input:** `send_sse(&sse, "n", &Reading { a: 0.1_f32, b: 33.3_f32 })`.
- **What happened:** `data: {"a":0.10000000149011612,"b":33.29999923706055}`.
- **Before the fix:** `{"a":0.1,"b":33.3}`, which is also what `JSON.stringify` writes for the numbers 0.1 and 33.3.
- **Why:** the `f32` is widened to an `f64` before it is written.
- The test `a_frame_has_its_numbers_as_javascript_writes_them` has an `f32` field, but its value is 1.5, which is exact
  in both widths, so it passes either way. No type this crate serialises through these functions has an `f32` today.

## Seen on the way, not from the fix

- **A drive-relative path.** `viewable_path("E:..\scratch\…\uploads\a.txt", …)` for a file that is inside the folder:
  Node serves it, Rust refuses it, before and after the fix. The page only ever sends back the full paths the server
  gave it.
- **A queued turn whose future is dropped at the moment the turn ahead ends.** The turn behind it can begin before the
  dropped turn's line has its `turn_end` on the timeline: 12,521 of the 33,148 dropped rounds after the fix. The old
  code's rounds showed it too. The line still ends once and as "removed". For a turn that was only dropped it comes
  from the order the future lets go of things (`src/lib/conversation_lock.rs:436-440`: the wake-up is dropped before
  the line). For one that was also stopped, the wait the fix added ends with the future. Node has no such case.
- **`[conv-lock] on_removed panicked; the turn goes on`** is a log line Node did not have (it caught and said nothing).

## The suite

`cargo test --no-fail-fast`, once, after the scratch file was deleted:

| Binary | Passed | Failed | Ignored |
|---|---|---|---|
| unit tests (`src/lib.rs`) | 1,931 | 0 | 0 |
| `tests/it` | 125 | 1 | 5 |
| `tests/ui` (the browser) | 144 | 0 | 0 |

- **The one failure:** `stt_local::a_warm_up_whose_caller_goes_away_leaves_no_file`, at `tests/it/fake_python.rs:111`
  (`EOF while parsing a string`: it read the stand-in program's log while a line of it was still being written). It
  starts a real program, it is not this package's, and nothing in the fix touches it. Run alone it passed 5 times out
  of 5.
- This package's tests all passed, the fixer's stress test and the five browser cases of `tests/ui/chat_files.rs`
  among them.
- The old code was built into the worktree's own `target` folder (nothing was cleaned). The suite then rebuilt the
  worktree's tests, so the folder holds the merged code's build again.
