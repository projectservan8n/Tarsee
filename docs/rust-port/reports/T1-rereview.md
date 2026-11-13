# T1 recheck: the fixes of round 1 (web terminal, Discord admin, Railway admin)

Rechecked: `rust-rewrite` at `8a3ff04`. The fix is `40c3723..bac416f`; the package's files have not changed since that
merge. Checked against `T1-review.md` (7 findings) and the section "Fix round 1" of `T1.md`.

How it was checked:

- **Windows 11 (this machine):** a throwaway integration test (deleted again) drove `terminal_upgrade` and
  `handle_terminal_connection` over real WebSockets and raw TCP. Every process it watched was held by a handle from
  the moment its id was known, and read back from `tasklist` as well. The Node handler (`terminal-handler.js`, `ws`
  8.22.0, node-pty 1.1.0, Node 22.18) ran behind a `ws` server from the main checkout with the same clients.
- **A scratch copy** of the merged source (`E:\tmp\tarsee-rs\scratch-recheck-T1\copy`) with three switches added to
  `terminal_handler.rs`: no `env_clear()`, `Job::holding` made to fail, a panic inside `handle_message_inner`.
  It shared the worktree's target folder; the worktree's library was rebuilt from its own sources before the final
  runs and the suite.
- **Linux (WSL2 Ubuntu, own copy and target folder, removed again):** the fix's Unix code had only been built on
  Windows. It builds; the 131 unit tests of the three files pass; the 13 terminal integration tests pass, 6 runs.
- **Whole suite, Windows, once at the end:** 1931 unit, 126 integration (5 ignored), 144 UI. No failure.

## The findings

1. **A connection reset before the first message leaves the shell running for ever: ADDRESSED.** The review's reproduction (three clients reset right after the upgrade, looked at 8 s later) with 13 more in the same run (one that just ends, one that sends input and resets unread, one that sends a close frame and resets, ten at once): no terminal counted, no `powershell.exe` or console host left under the test process, audit 16 × `connect`, `disconnect`, `exit`. The server's thread count stayed flat over 72 further sessions (18, 18, 15, 15, 15; handles 167 to 179). On Linux the fix's own reset tests pass.
2. **Closing a terminal on Windows can kill processes that are not the shell's: ADDRESSED.** `grep -rn "CreateToolhelp32Snapshot\|th32ParentProcessID" src` finds nothing and the `ToolHelp` feature is gone from `Cargo.toml`; the only two ways a process is ended are `TerminateJobObject` on the shell's job and `TerminateProcess` on the handle held, never an id. Run: a shell with a child on its console, a child in a hidden console, a hidden `cmd.exe` with its `ping`, and a `ping` whose parent `cmd.exe` had already exited, plus two unrelated `ping`s of the test's own (one started before the terminal, one while it was open); the session ended nine ways (the client's close frame, the connection ended, reset while idle, reset during output, the task dropped, the task panicking around the handler, a panic inside the handler, `exit`, `cleanup_all_terminals`). Every time all six of the shell's processes were gone (ended by the job, exit code 1; after `exit`, by the job's closing) and off `tasklist`, both unrelated processes were still running, no terminal was counted and the three audit lines were there.
3. **An empty PATHEXT entry makes the terminal unusable: ADDRESSED.** With the review's environment (`PATHEXT=.COM;.EXE;.BAT;.CMD;`, `Path` = system32, Windows, PowerShell's folder) the terminal connects and runs a command, as node-pty did with the same environment (both shells show `.COM;.EXE;.BAT;.CMD;.CPL`: PowerShell adds `.CPL` itself). Also with `;`, `.COM;;.EXE`, `;.EXE`, `EXE`, `x` and no PATHEXT. One case is left, see B below.
4. **A close the browser starts is never answered: ADDRESSED.** The client's close with (1000, "bye"), no code, (1001, ""), (4000, a reason) and (3000, ""): each answered with the same code and reason (none with none), the connection then ended cleanly, the shell was gone, audit `connect, disconnect, exit`. The Node handler behind `ws` answers the five the same way.
5. **A dropped connection logs an error line Node never logged: ADDRESSED.** A connection that ends or is reset (before `connected`, idle, during output, after half a frame) logs `WebSocket closed` and no error. The check did not become looser than Node's: an unmasked frame, text that is not UTF-8, a frame with RSV1 set and opcode 3, sent over a raw socket, each still log `[terminal] WebSocket error for ...`, the same four cases that log it in Node.
6. **Railway: names outside ASCII sort differently from Node's `localeCompare`: ADDRESSED for the Latin letters it named.** Through `list_projects` with a stubbed API: the review's 35 names come out in Node's order. The sign of 27,790 comparisons against `localeCompare` (Node 22, ICU 77.1): no difference in 3,000 ASCII pairs, 6,176 pairs of ordinary project and variable names, 1,500 of Latin-1 letters and 1,500 of Latin Extended Additional; 1 of 1,500 in Latin Extended A/B (that pair holds U+2C66, outside the ranges covered); in U+0250 to U+02FF none where both names hold only letters. What still differs is C below.
7. **No test notices if the shell inherits the server's real environment: ADDRESSED.** With `env_clear()` switched off, `a_shell_runs_commands_...` fails at `tests/it/terminal.rs:445` ("the shell sees CARGO_PKG_NAME from the server's real environment", left `"tarsee"`), on Windows and in the Linux copy; with it in place the test passes.

No test was weakened: the test client stopped answering `ESC[6n` because the server now answers it, and a check that the question never reaches the browser was added. Nothing else calls the changed functions (nothing mounts the terminal yet).

## New breakage

**A. Without a job object, every close logs an error although the shell was ended.** Minor.

- Input: the scratch copy with `Job::holding` returning an error (the only change), then any of the ways of ending a
  session above.
- What happened, as documented: the warning `[terminal] Could not put the shell in a job object (...): closing the
  terminal will end the shell alone`; the shell ended through its handle (exit code 1); the child on its console
  ended with the console; the child in a hidden console, the hidden `cmd.exe`, its `ping` and the orphaned `ping`
  stayed running (as with Node, whose handler also left a hidden-console `ping` running); the unrelated processes
  were untouched; no terminal counted; the audit lines complete.
- What is wrong: each close also logs, at error level, `[terminal] Error killing PTY: The operation completed
  successfully. (os error 0)` (twice `The handle is invalid. (os error 6)`).
- Where: `src/websocket/terminal_handler.rs:347-351` (`kill_child`), called at `:382`. portable-pty 0.9.0
  `src/win/mod.rs:72-78` returns `Err` when `TerminateProcess` succeeds. Before the fix `kill_child` ran after the
  shell had already been terminated, so the inverted answer read as success.

## Holes still open

**B. The shell in no PATH folder and an empty PATHEXT entry: the browser is shown the panic's own text.** Minor
(Node could not start a terminal there either).

- Input: `Path` = an empty folder, `PATHEXT=.COM;.EXE;` (or `;`).
- What happened: `{"type":"error","message":"Failed to spawn shell: start byte index 1 is out of bounds of ``"}` and
  close 1011. The "task N panicked" wrapper is gone, but the text is still portable-pty's panic message, and the
  panic with its source location is printed on the server's stderr. Node: `Failed to spawn shell: File not found: `.
  Without an empty entry the answer is portable-pty's `CreateProcessW ... failed: The system cannot find the file
  specified.`
- Where: `src/websocket/terminal_handler.rs:129` (the bare name goes to portable-pty, which then reads PATHEXT) and
  `:413`.

**C. Railway: signs and emoji outside ASCII still sort after every letter.** Minor, and not new: the code before the
fix did the same. `T1.md` difference 7 names only "other scripts".

- Input: projects `alpha`, `zeta`, `🚀 rocket`, `© acme`, `– dash`, `€ shop`.
- What happened: Node lists `– dash`, `© acme`, `🚀 rocket`, `€ shop`, `alpha`, `zeta`; Rust lists `alpha`, `zeta`,
  `© acme`, `– dash`, `€ shop`, `🚀 rocket`. ICU puts punctuation and symbols before digits and letters.
- How much: 711 of 1,500 pairs with a Latin-1 sign (U+00A0 to U+00BF, `×`, `÷`), 656 of 1,500 with general
  punctuation, currency or emoji, 627 of 1,711 among realistic names with a sign, an emoji or another script. The
  modifier signs U+02C2 to U+02FF behave the same (257 of 1,500).
- Smaller, same place: Latin letters outside the two ranges covered (full width, U+2C60, U+A720, `ﬁ`): 406 of 1,500.
  An accent typed as a separate mark: `İstanbul` against `I` + U+0307 `stanbul` is equal in Node and not here; the
  marks U+0340 to U+036F that are not in the table are ignored. Other scripts: 11 of 1,500 (`Ё`, kana).
- Where: `src/lib/railway_admin/collation.rs:71-75`.

## For the record, not defects

- A program the shell started in a console of its own is ended with the session, also after a plain `exit`. Node left
  it running (seen with the Node handler). `T1.md` records this as difference 3.
- A shell ended by a close reports exit code 1, as before the fix. Node on this machine reported -1073741510 every
  time (the console is closed before node-pty's helper lists its processes).
