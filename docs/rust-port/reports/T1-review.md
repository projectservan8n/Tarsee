# T1 review: web terminal, Discord admin, Railway admin

Reviewed: `rust-rewrite` at `40e4ee7` (package diff `0013700..40e4ee7`), against `src/websocket/terminal-handler.js`,
`src/lib/discord-admin.js`, `src/lib/railway-admin.js`, their caller (`src/channels/websocket.js`) and their tests.
Node behaviour was checked by running it (node-pty 1.1.0, `ws`, discord.js and the Node files of the main checkout),
not only by reading.

How it was checked:

- **Windows (this machine):** T1's unit tests and `tests/it/terminal.rs`, plus throwaway integration tests (deleted
  again) that drove `terminal_upgrade` over a real WebSocket. node-pty and the Node handler were run from Node with
  the same environments and clients.
- **Linux (WSL2 Ubuntu, own copy of `40e4ee7`, own target folder):** the whole crate built with
  `cargo test --no-run` without a warning. T1's 125 unit tests and the 6 terminal integration tests passed. Throwaway
  tests covered the `cfg(unix)` paths: SIGHUP, the SIGKILL after 3 s, jobs, a dropped connection, a slow reader, and
  a reset before `connected`.
- **Discord, differential:** the Node test's own `world()` fake (copied from `test/discord-admin.test.js`) against a
  copy of the porter's Rust `World` fake, with the same 76 calls. 31 of them succeed and 45 are refused. They cover
  every action and every refusal text, mentions, aliases, the Administrator rule, private and copied overwrites,
  near/before/after, the vault key rules and `reveal`. They include Discord codes 50013, 50001, 50035, 30007 and
  30013, a non-API error, and approval values `0`, `false`, `[]`, `{}` and NBSP+BOM. Compared:
  - the answer and the log lines;
  - every call made to the client, normalised: overwrites as bit fields, the overwrite `set` as flag name and value
    in order, parent, position, reason and avatar;
  - the vault afterwards.

  **76 of 76 identical.**
- **Railway, differential:** the Node tool and the Rust tool against the same stubbed GraphQL answers, 62 cases:
  - every action;
  - HTTP 401, 403, 404, 429, 500 and 502;
  - bodies `null`, `0`, `"hello"`, `[]` and `{"errors": []}`;
  - errors with no message, a non-string message, `errors` as an object, `Forbidden` at 200;
  - deleted and null projects, null environments, edges holding `null`, `0` or strings;
  - approval variants, every secret shape and near misses, values equal to a vault key's value (long and short),
    `from_key` in lower case, a vault that throws;
  - a token echoed back as is, JSON-escaped and URL-encoded.

  Compared the answer, the log lines and every request (URL, method, `Authorization`, operation, variables).
  **59 of 62 identical.** Two of the differences are finding 6 (sorting). The third is a value cut at 200 UTF-16
  units in the middle of an emoji: JavaScript keeps a lone surrogate there, which a Rust string cannot hold.
- **Whole suite:** see the end.

## Findings

### 1. A connection reset before the first message leaves the shell running for ever

- **Severity:** Critical
- **Node:** `src/websocket/terminal-handler.js:68` sends `connected`; `:118-136`: the socket's `close` event always
  fires, and kills the shell.
- **Rust:** `src/websocket/terminal_handler.rs:556-560`, `:601`, `:609-621`, `:660-671`.
- **What differs:**
  - `socket_open` starts as the result of sending `connected`.
  - If that send fails, the receive branch of the loop is disabled from the start (`if socket_open`, `:601`).
  - `socket_closed()` is only called from that branch, or after the loop under `if socket_open` (`:660`).
  - So nothing ever kills the shell. An interactive shell waiting for input never exits, and the task waits for it
    for ever.
  - What stays behind: the shell process, its three threads, the entry in `Terminals`
    (`get_active_terminal_count` keeps counting it), and no `terminal.disconnect` audit line.
  - The send fails whenever the client's connection was reset while the shell was starting: the client crashed or
    was killed, a network drop, a closed tab whose socket was aborted. It can also be done on purpose, after signing
    in, to pile up shells.
- **How confirmed:** three clients upgraded, then reset at once (`SO_LINGER` 0 and drop); checked 8 s later.
  - Rust on Windows: `terminals still counted = 3`, three `powershell.exe` children of the test process still
    running, audit `["terminal.connect" x3]`.
  - Rust on Linux: `terminals still counted = 3, shells still running = [863, 867, 871]`, audit the same.
  - Node on Windows, the real handler behind a `ws` server, a raw client doing the same (`resetAndDestroy()` after
    the 101): `terminals still counted = 0, shells still running = []`, audit `connect, disconnect` three times then
    three `exit`s.

### 2. Closing a terminal on Windows can kill processes that are not the shell's (stale parent ids)

- **Severity:** Critical
- **Node:** `src/websocket/terminal-handler.js:124` `ptyProcess.kill()`. node-pty 1.1.0 `lib/windowsPtyAgent.js:133-156`
  ends exactly the processes attached to the shell's console (`GetConsoleProcessList`, through
  `conpty_console_list_agent`), then closes the console.
- **Rust:** `src/websocket/terminal_handler.rs:269-275` and `kill_process_tree`, `:285-331`.
- **What differs:**
  - `kill_process_tree` takes one Toolhelp snapshot and counts as a descendant every process whose
    `th32ParentProcessID` equals a pid already in the tree. It then calls `TerminateProcess` on all of them.
  - Windows does not clear a process's recorded parent id when the parent exits, and it reuses process ids.
  - So when the shell, or anything still running under it, has been given an id that an unrelated live process
    recorded as its long-dead parent, that process and its whole subtree count as the shell's children. They are
    terminated when the browser disconnects or `cleanup_all_terminals` runs.
  - Nothing checks creation times or uses a job object. Node's console list cannot pick up a stranger this way.
- **How confirmed:**
  - On this machine, now: 20 live processes carry a parent id that no running process holds, free for reuse. Among
    them are `explorer.exe`, `winlogon.exe`, `csrss.exe`, Discord, Telegram, RustDesk and GitHub Desktop.
  - Two carry a parent id that a newer, unrelated process already holds: `csrss.exe` 1052 and `wininit.exe` 1144 list
    parent 972, which is now a `svchost.exe` started after them.
  - The handler's walk, copied as is and run dry (without `TerminateProcess`) against the live snapshot, gives:
    `kill_process_tree(972 svchost.exe) would terminate 187 processes, among them csrss.exe (1052), wininit.exe
    (1144), services.exe (1232), lsass.exe (1304)`.
  - The last step, the shell or a running child getting such an id, is chance. It was not forced end to end: 400
    spawns did not reuse one chosen id. But the walk has no guard against it.
  - What it costs when it happens: the user's desktop (explorer and everything under it), other apps, or, if the
    server's own launcher has exited, the Tarsee server itself.
- **The brief's question:** a process that only shares an ancestor with the shell (a sibling, the server, the
  server's parent) is not reached while ids are not reused, because the walk only goes down. A process whose recorded
  parent id has been reused is reached, and on a desktop such processes are common.

### 3. An empty PATHEXT entry makes the terminal unusable (a panic inside portable-pty)

- **Severity:** Important
- **Node:** `src/websocket/terminal-handler.js:47` `pty.spawn("powershell.exe", ...)`. node-pty passes the command
  line to `CreateProcessW`, which does its own search and never reads PATHEXT.
- **Rust:** `src/websocket/terminal_handler.rs:351-358` (`CommandBuilder::new(shell())`, `spawn_command`). The panic
  is in portable-pty 0.9.0 `src/cmdbuilder.rs:598` (`&ext[1..]` on an empty PATHEXT entry). `spawn_blocking` catches
  it and `:544` reports it.
- **What differs:**
  - portable-pty looks `powershell.exe` up itself. For every PATH folder that does not hold it, it tries each
    PATHEXT entry.
  - An empty entry panics. That is a trailing or doubled `;`, which installers do leave.
  - The browser gets `{"type":"error","message":"Failed to spawn shell: task 32 panicked with message \"start byte
    index 1 is out of bounds of ``\""}` and a 1011 close, every time. The panic message also goes to stderr.
  - With the same environment, Node's terminal starts and runs commands.
- **How confirmed:** both sides with `PATHEXT=.COM;.EXE;.BAT;.CMD;` and
  `Path=%SystemRoot%\system32;%SystemRoot%;%SystemRoot%\System32\WindowsPowerShell\v1.0\` (the usual order).
  - Rust, a test server through `terminal_upgrade`: the message above.
  - Node, `pty.spawn("powershell.exe", ...)` with node-pty 1.1.0: `SPAWNED ... and ran a command`.

### 4. A close the browser starts is never answered

- **Severity:** Minor
- **Node:** `ws` answers a close frame at once with its own, then ends the connection. The handler's `close` event
  follows (`terminal-handler.js:118`).
- **Rust:** `src/websocket/terminal_handler.rs:609-612`. On `Message::Close` the loop stops reading the socket
  (`socket_open = false`) and never writes to it again. tungstenite sends its queued close reply only on a later read
  or write, so the socket is dropped without one.
- **What differs:** the client sees an abnormal end (in a browser: code 1006, `wasClean: false`) instead of a clean
  close. `terminal.js` never closes the socket itself, so the page does not show it. Other clients, such as one using
  the API token, do.
- **How confirmed:** a client sent `Close(1000, "bye")` after the shell's first output. 26 ms later it got
  `WebSocket protocol error: Connection reset without closing handshake`.

### 5. A dropped connection logs an error line Node never logged

- **Severity:** Minor
- **Node:** `terminal-handler.js:139-141` logs only on the socket's `error` event. `ws` does not emit `error` when the
  TCP connection is reset or ends without a close frame; it just closes.
- **Rust:** `src/websocket/terminal_handler.rs:613-614`.
- **What differs:** every connection that goes away without a close frame (a network drop, a killed client) adds
  `[terminal] WebSocket error for term-...: WebSocket protocol error: Connection reset without closing handshake` at
  error level, before the usual `WebSocket closed` line.
- **How confirmed:** three dropped connections on Windows with the log captured. Each produced that line.

### 6. Railway: names outside ASCII sort differently from Node's `localeCompare`, more widely than the report says

- **Severity:** Minor
- **Node:** `src/lib/railway-admin.js:285`, `:313-314` (`localeCompare`, ICU root collation).
- **Rust:** `src/lib/railway_admin.rs:1161-1237` (`locale_compare`), used at `:846`, `:925`, `:927`.
- **What differs:**
  - The report (difference 7) says the order is exact for ASCII and the accented Latin-1 letters, and approximate
    for "other scripts".
  - But the 27-letter table leaves out Latin letters that ICU sorts with their base letter or as an expansion. These
    are `Æ`, `Ø`, `Ð` and `Þ` in Latin-1, and every Latin Extended letter: `ĉ`, and with it Polish, Czech, Turkish
    and Romanian names (`Ł`, `Š`, `Ş`, `Ă` ...).
  - All of them sort after `z`.
- **How confirmed:** the same 35 project names (and the same 35 variable names) listed by both tools.
  - Node: `aether, Æther, alpha, ... capelo, ĉapelo, co-op, coop, Ðe, emile, ... ost, Øst, ... zeta, þorn, Ωmega, 日本`.
  - Rust: `aether, alpha, ... capelo, co-op, coop, emile, ... ost, ... zeta, Æther, Ðe, Øst, þorn, ĉapelo, Ωmega, 日本`.

### 7. No test notices if the shell inherits the server's real environment

- **Severity:** Minor (a missing test for a risk Rust has and Node did not; the code itself is right)
- **Rust:** `src/websocket/terminal_handler.rs:352-356` (`command.env_clear()` before the app's variables). The
  tests: `tests/it/terminal.rs:301-311`, and the unit test
  `the_shell_gets_the_servers_environment_with_term_and_colorterm`.
- **What differs:**
  - portable-pty's `CommandBuilder::new` starts from the real process environment. `env_clear()` is what keeps the
    shell to the app's `Env` (DESIGN, porting rule 8, last item).
  - The tests check that `TERM` and `COLORTERM` reach the shell, and what `shell_env` returns.
  - Nothing checks that a variable set only in the real environment is absent from the shell.
- **How confirmed:** in the Linux copy, `env_clear()` was removed and a variable was set only in the real
  environment. All 9 terminal unit tests that run on Linux and all 6 terminal integration tests still passed. The
  line was restored afterwards.

## Checked and found faithful

- **The terminal's checks.**
  - Node's handler checks nothing except whether `node-pty` loaded (`terminal-handler.js:21-25`).
  - Auth belongs to the caller (`channels/websocket.js:86-99`): the session cookie, else a `?token=` API token, else
    a raw 401 and the socket destroyed.
  - The Rust handler likewise checks nothing, and says so (`terminal_handler.rs:5-6`, `:498`).
  - Nothing in the merged code mounts `terminal_upgrade` yet. That is package Z1's job, and the report spells out the
    check Z1 must keep. So no shell is reachable today.
- **Shell, arguments, folder, environment.**
  - `powershell.exe` or `bash`, with no arguments, started in the configured workspace.
  - The app's `Env` snapshot plus `TERM` and `COLORTERM` (and `PWD` on Unix, as node-pty set it). On Windows a name
    matches whatever its case.
  - On Unix portable-pty also adds `SHELL` when the environment has none (report, difference 2).
  - The Windows console's opening output matches node-pty's (`?9001h`, `?1004h`) apart from the cursor-position
    request and the missing screen clear (report, difference 1).
- **Protocol.**
  - Server to browser: `connected`; `data`; `exit` (no `signal` key on Windows; on Unix `signal` is 0 or the signal
    number); `pong`; `error` with a 1011 close "PTY spawn failed"; a 1000 close "Terminal process exited".
  - Browser to server: input; resize, with node-pty's validation and messages; ping.
  - Unreadable JSON, `null`, numbers, unknown types and binary frames are logged and ignored.
  - A 65 MiB message passes. Over 100 MiB the client gets close 1009 with an empty reason, as from `ws`.
  - Messages sent before the shell is up are read once it is.
  - Output is bounded (64 chunks, sends awaited). A slow reader on Linux still got all 16.9 MB of
    `seq 1 2000000; echo END-OF-OUTPUT; exit`, end marker included.
  - Input is unbounded on both sides.
- **Cleanup when the socket goes away cleanly or drops** (but see findings 1 and 2).
  - Windows, a dropped connection with no close frame: the shell ended, and so did a `-NoNewWindow` child, a
    `-WindowStyle Hidden` child, and an orphan attached to the console whose parent `cmd` had exited. No spurious
    "Error killing PTY" line.
  - Linux, a dropped connection: the shell and its `&` job ended.
  - Linux, a shell that ignores SIGHUP (`trap '' HUP`): SIGKILLed after 3.03 s, audit `{"exitCode":0,"signal":9}`.
    node-pty left such a shell running.
  - A `(sleep &)` orphan of a subshell survives, as it did under Node.
  - Exit codes and close frames match Node.
- **`cfg(unix)` code.** It compiles without warnings and runs on Linux:
  - `libc::kill(pid, SIGHUP)`;
  - `kill(-pid, SIGKILL)` after `Ended::wait`, falling back to `kill(pid, ...)`. portable-pty makes the shell a
    session and group leader with `setsid`, so `-pid` is its group;
  - the signal number, read through the downcast to `std::process::Child` (portable-pty's Unix child is exactly that
    type);
  - `PWD`, and `input_bytes` for lists of numbers.
- **Discord.**
  - Permission bits equal discord.js's `PermissionFlagsBits`: 53 names, 52 bits, same order.
  - The three writes, and only they, need `approved_by`. Every refusal text matches.
  - Aliases, and private, copied and synced overwrites.
  - The vault key is `DISCORD_WEBHOOK_<CHANNEL>` or `save_as_key`, replaced only with `overwrite_key`.
  - The full URL appears only with `reveal`, and never in a log line.
  - See the differential above.
- **Railway.**
  - The six documents byte for byte, with their variables; `POST` to `API_URL` with `Bearer`.
  - The token comes from the vault, else the environment, trimmed the JavaScript way.
  - The token is scrubbed from answers, errors and log lines, as is, JSON-escaped and URL-encoded.
  - `set_variable` and `redeploy` need `approved_by`; `from_key` against `value`; every error text matches.
  - See the differential above.
- **Completeness.**
  - Every export of the three Node files has its counterpart: terminal 3 (plus `terminal_upgrade`,
    `terminal_client_ip`, `shell`, `working_folder`, `shell_env`), Discord 7, Railway 7.
  - Node cases counted: `discord-admin.test.js` 52 (50 `it`, one of them in a loop of 3); `railway-admin.test.js` 55
    (48 `it`, one in a loop of 2, one in a loop of 7).
  - Rust: 49 ported + 7 added, and 53 ported + 6 added, with names matching one to one.
  - The 5 cases not ported need `lib/tools.rs` (S3) or the MCP server (S4). Both are still one-line stubs on the
    branch, so the reason holds.
- **Rules of the port.**
  - No global state: `Terminals` is an app service.
  - No read of the real environment: the shell's environment is the app's, and `std::env::current_dir()` stands only
    for Node's `process.cwd()`.
  - HTTP only through `Fetch`.
  - Pseudo-terminal calls on their own threads or in `spawn_blocking`.
  - No `unwrap` or `expect` on outside input; only on regex literals.
  - JavaScript trim and UTF-16 lengths wherever Node used them. Log and error texts as in Node, apart from finding 5.
- **Tests.** The ported assertions are the Node ones or stronger; several compare whole answers checked against
  Node. The differentials found nothing in the Discord and Railway tools that the tests had missed, apart from
  finding 6. The terminal tests have the gap in finding 7, and none covers findings 1 to 4.

## Whole suite

Windows, `cargo test` at `40e4ee7` with no scratch files:

- unit tests: 1642 passed;
- `tests/it`: 105 passed, 3 ignored;
- `tests/ui`: 139 passed;
- doc tests: 0 run (22 ignored).

On the first full run, `voice::a_program_that_runs_too_long_is_stopped_in_node_s_words` (not T1's; a test with a time
limit) failed once under load. It passed alone, and in the second full run (`--no-fail-fast`), whose numbers are
above. Linux: T1's tests only, all passing, as above.

COMPLETE: yes
FAITHFUL: no
