# C1 review: workspace files, skills, memory, hooks and plugins

Reviewed at `a9bc6da` (branch `rust-rewrite`; the package is `git diff fe261ba 9dd5372`), against the Node files in the
main checkout. The whole suite passes on Windows: `cargo test` gives `677 passed` (lib), `51 passed` (it), 0 failed.

Method. Each Node file was read next to its Rust file. Where behaviour was in doubt, the Node function was run with
`node` and the Rust with a throwaway test or a small `rustc` program. One cross-check ran a whole workspace through both
versions: `AGENTS.md` at 13 KB of CRLF lines holding `é😀中` (cut, and the warning logged), SOUL/USER/TOOLS files made
of JS-only and Rust-only whitespace (U+FEFF, U+0085, U+2028, U+3000), HEARTBEAT and BOOT with comments and headings, a
3 KB MEMORY.md, and a CLAUDE.md mixing CRLF, LF and an owner-edited line. These outputs were identical character for
character, with the MEMORY.md path masked:

- `getBootstrapContext` with `heartbeatWaiting` false, true and null
- `getHeartbeatContext`, `getBootContext`, `hasBootstrapFile`, `parseIdentityFile`
- `upgradeDefaultWorkspaceFiles`, both the files it returned and the bytes it wrote

The 9 diagram fixtures were rebuilt with Node from `specs.json`: 0 differences. The scratch files are gone; the
worktree is clean apart from this file.

## Completeness

**Exports.** Every export of the 23 Node files has its Rust counterpart, checked file by file. The changes of shape are
the ones the report lists:

- `truncateContent` with a name became `truncate_content_named`.
- `CHECKPOINT_FILE_PATH` became `checkpoint_file_path(config)`.
- `AUTOMATION_FILES` became `&[(name, key)]`. That is enough: the Node callers only use `Object.keys` of it.
- JS defaults became explicit arguments.

Nothing is missing.

**Node tests, counted here:**

| Node test file | Cases | Where in Rust |
|---|---|---|
| `test/prompt-audit.test.js` | 9 | 7 in `lib::workspace_files`, 2 in `lib::skills_engine` |
| `test/workspace-defaults.test.js` | 23 as run | `lib::workspace_files` |

The 23 are 16 written cases plus 7 generated ones (one per `src/workspace-defaults/*.md`). The LF and CRLF pairs count
as 4. The generated cases are loops inside 3 Rust tests. Every case is ported with the same inputs and the same or
stronger assertions:

- The emoji case also counts the emoji kept.
- The truncation warning is compared whole.
- The fixtures in `tests/fixtures/workspace/` are identical to `test/fixtures/` once line endings are made LF.

**Files with no Node test.** Every one has Rust tests that check whole outputs (bodies, files, log lines, HTML). The gaps
are listed under "Tests" below.

## Findings

### Critical

**1. A skill name that is an absolute path leaves the skills folder. Node kept it inside.** Critical: data is lost on
input that Node handled harmlessly.
- Node: `src/lib/skills-engine.js:136-137,157`, `src/routes/skills.js:130,155`, all `path.join(dir, name)`.
- Rust: `src/lib/skills_engine.rs:209-210,236`, `src/routes/skills.rs:168,194`, all `PathBuf::join(name)`.
- What differs: `path.join` keeps the base. `PathBuf::join` replaces it when the name is absolute: on Windows that
  includes a name starting with `\` or a drive letter.
- Requests reached this way are `POST /api/skills/install`, `/uninstall` and `/setup`, `PUT /:name` and `DELETE /:name`.
  `POST /` checks the name first and is safe.
- `DELETE /api/skills/%2Fdata%2Ftarsee`:
  - Express and axum both decode the name to `/data/tarsee`.
  - Node looks up `<skills>/data/tarsee` and answers `404 {"error":"Skill not found"}`.
  - Rust runs `remove_dir_all("/data/tarsee")`, the whole Railway state folder.
- `POST /api/skills/install {"name":"/some/dir"}`:
  - Node answers `400 Skill "/some/dir" not found`.
  - Rust copies the folder onto itself. On Linux `fs::copy` opens the target with truncate, so every file becomes empty.
- Confirmed:
  - Node: `path.join("/w/skills","/etc")` gives `/w/skills/etc`.
  - Rust (`rustc` scratch): `PathBuf::from("C:/w/skills").join("/etc")` gives `"C:/etc"`.
  - The std documentation says "If path is absolute, it replaces the current path".
- The report's "looks like a bug" #1 (names are paths, `../` escapes) is true of Node. The absolute-path case is a new
  escape that the report does not list.

### Important

**2. `MemoryStore::consolidate` deletes memories that Node keeps when the 50-unit prefix ends inside an emoji.**
- Node: `src/db/memory.js:110`, `row.content.substring(0, 50).toLowerCase().trim()`.
- Rust: `src/db/memory.rs:197`, `String::from_utf16_lossy(&...take(50)...)`.
- What differs: Node keeps the half emoji, so 😀 (D83D...) and 🤖 (D83E...) give different prefixes. The lossy
  conversion turns any half into U+FFFD, so the two prefixes compare equal and the older row is deleted.
- Confirmed with two rows that share the first 49 units, then 😀 and 🤖:
  - Node: `consolidate removed: 0`.
  - Rust: the lossy prefixes compare equal (`lossy equal: true`), so one row is removed.
- It runs only when the owner asks for it (`routes/debug.js:341`). The rows are lost for good.

**3. `tarsee service install` on Windows passes `schtasks` a mangled `/TR`.**
- Node: `src/daemon/service.js:101-102`. `execSync` runs `cmd.exe /d /s /c "<command>"` verbatim.
- Rust: `src/daemon/service.rs:28-31` (`Command::new("cmd").args(["/d","/s","/c", command])`), with the command built at
  `:192-194`.
- What differs: std's Windows argument quoting turns each inner `"` into `\"`. cmd.exe does not undo that, so
  `schtasks` gets the task's command split and escaped wrongly. The install fails or makes a broken task.
- Confirmed by running both with a stand-in program that prints its argv:
  - Rust argv: `["/TN","tarsee","/TR","\"\\\"C:\\Tools\\tarsee.exe\\\"","start\"","/RL","HIGHEST","/F"]`
  - Node argv: `["/TN","tarsee","/TR","\"C:\\Tools\\tarsee.exe\" start","/RL","HIGHEST","/F"]`
- The tests miss it: `the_real_system_runs_commands_through_the_shell` only runs `exit 0` and `exit 3`.
- Uninstall and `is_installed` contain no quotes and are not affected.

**4. Canvas files: the send module's dot-segment rule is applied to the last part only.**
- Node: `src/lib/canvas.js:167`, `res.sendFile(filePath)` with no `root`. Express 5.2.1 uses send 1.2.1, which splits
  the whole absolute path and answers 404 when any part longer than one character starts with `.` (`containsDotFile`).
  The error handler then sends `{"error":"Not Found"}`.
- Rust: `src/lib/canvas.rs:303-312` checks only `file_path.file_name()`.
- What differs:
  - `/canvas/c1/.git/config` and `/canvas/.hid/index.html` answer 200 with the file in Rust, 404 in Node.
  - When a folder above the canvas has a dot name, Node answers 404 for every canvas file and Rust serves them. The
    default local state folder `~/.tarsee` (`config/env.js:29`) is such a folder.
- Confirmed by running Node's middleware inside express:
  - Workspace under `.../.dotted/ws`: `/canvas/c1/`, `/canvas/c1/index.html`, `/canvas/c1/.git/config` and
    `/canvas/.hid/` all answered `404 {"error":"Not Found"}`.
  - Plain workspace path: the first two answered 200, the last two 404.
- It is Important rather than Critical because only the signed-in owner reaches `/canvas/`. Still, hidden files inside
  a canvas folder are now served where Node refused them.

**5. The skills routes do recursive copies and deletes on the async runtime (port rule 10).**
- Rust: `src/routes/skills.rs:54-97` (`/install`, `/uninstall`, `/setup` call `install_skill`/`uninstall_skill`: a
  recursive `fs::copy` or `fs::remove_dir_all`) and `:193-212` (`DELETE /:name`, `remove_dir_all`). These are plain
  `std::fs` calls inside `async fn` handlers, with no `spawn_blocking`.
- The shipped skills are small: 27 folders, 41 files, 340 KB. A custom skill folder is whatever the AI or the owner put
  there, and deleting it can take as long as its size. The rule asks for `spawn_blocking` for file work that can take
  long.

### Minor

**6. `uninstall_skill` fails on a skill entry that is a file.**
- Node: `skills-engine.js:158`, `fs.rmSync(dir, {recursive:true})`, which removes a file too.
- Rust: `skills_engine.rs:238`, `remove_dir_all`, which returns ENOTDIR (on Windows, "The directory name is invalid").
- `POST /api/skills/uninstall {"name":"loose.md"}` answers 200 in Node and 400 in Rust.
- Confirmed: in Node the file is gone afterwards ("exists after: false"); the Rust scratch program got the error.

**7. Memory search with a negative `?limit=` returns nothing.**
- Node: `memory.js:78` with `routes/memory.js:57`. `scored.slice(0, -1)` drops the last result: `search("tea", -1)`
  returned 2 of 3.
- Rust: `routes/memory.rs:101`. `usize::try_from(-1).unwrap_or(0)` gives `[]`.
- The report's bug #8 holds only for the list route.

**8. Values that are not text in the memory routes.**
- Node: `routes/memory.js:31,52-58`. Rust: `routes/memory.rs:71-78,96`.
- For `category` (and likewise `conversationId`), better-sqlite3 refused these in Node, which answered 500. Rust stores
  the value's text and answers 201:

  | Sent | Node 500 message | Rust stores |
  |---|---|---|
  | `true` | `SQLite3 can only bind numbers, strings, bigints, buffers, and null` | `"true"` |
  | `{"a":1}` | `Too few parameter values were provided` | `"[object Object]"` |
  | an array of 2 or more | too many parameter values | `"1,2"` |

- A repeated `?q=a&q=b` was a Node 500 (`toLowerCase` is not a function); Rust searches for `"a,b"`.
- Report difference 9 covers only a number and a repeated `category`.

**9. Frontmatter key order in `GET /api/skills/:name`.**
- Node: `skills-engine.js:34-42`. Rust: `skills_engine.rs:111-126`.
- For frontmatter `name: a`, `2: two`, `1: one`, `__proto__: x`, `description: d`:
  - Node answers `{"1":"one","2":"two","name":"a","description":"d"}`: number-like keys first, `__proto__` dropped.
  - Rust keeps insertion order and keeps `__proto__`.
- `get_stats` already uses `js_key_order` for the same reason; this path does not.

**10. A wrong method on a known path answers 405.**
- Rust: `routes/memory.rs:27`, `routes/skills.rs:33`.
- `GET /api/memory/<id>`: Express fell through to the single-page app (200 `index.html`).
- `POST /api/skills/<name>`: Express answered 404 `Cannot POST`.
- Z1 may prefer to handle this with a fallback.

**11. The log line of an unhandled 500 lost the error name and stack.**
- Node: `middleware/error-handler.js` logs `[error] ` plus `err.stack`, e.g. `TypeError: Cannot destructure ...` followed
  by the stack.
- Rust: `routes/skills.rs:269` logs `[error] Cannot destructure ...`.

**12. Diagram legend: a kind that is an inherited property name and has no label prints `undefined`.**
- Node: `diagram-renderer.js:105`, `esc(l.label || s.label)`, where `s` is e.g. `Object.prototype.toString`, so the
  result is `esc(undefined)`, which is `""`.
- Rust: `diagram_renderer.rs:34-39,382` sets `INHERITED.label = "undefined"`.
- Confirmed: Node renders `legend:[{kind:"toString"}]` (and `__proto__`, and `constructor` with label `""`) as
  `<div class="pill" ...></div>` with nothing between the tags; Rust puts `undefined` there.

**13. Canvas 304 answers.**
- Rust: `canvas.rs:479-486` builds a bare 304 carrying the ETag only, and never reads the request's `Cache-Control`.
- Node (send) sets `Accept-Ranges`, `Cache-Control: public, max-age=0`, `Last-Modified` and `ETag` before its freshness
  check. A request with `Cache-Control: no-cache` gets 200 and the body.
- Confirmed with `http.get` against both: Node's 304 carries all four headers, and `no-cache` gives 200 in Node and 304
  in Rust.

**14. A folder under `/canvas/` goes to the next handler without the canvas isolation headers.**
- Node: `canvas.js:131` sets the CSP, COOP, CORP and nosniff headers before `sendFile`, and they stay on the SPA
  fallback's answer.
- Rust: `canvas.rs:297-300` returns `Err(req)`; the headers are added only to `Ok` answers (`:260-265`).

**15. The gallery sorts by nanoseconds.**
- Node: `canvas.js:143`, `b.modified - a.modified` on Dates, in milliseconds.
- Rust: `canvas.rs:335`, `Reverse(SystemTime)`.
- Two canvases changed within the same millisecond are listed in another order.

**16. A UNC workspace path breaks canvas serving.**
- Rust: `canvas.rs:409-430`. `split_root` knows only drive letters, so `\\server\share\ws\canvas` becomes
  `\server\share\...` and every canvas answers "Canvas not found".
- The comment at `:390` says the UNC root is kept, which it is not.
- Node's `path.win32.join` keeps the root.
- Confirmed by reading the code; it matters only with a UNC `TARSEE_WORKSPACE_DIR`.

**17. `CanvasServer::serve`, `get` and `delete` with an absolute id leave the canvas folder.**
- Node: `canvas.js:18,59`, `path.join`. Rust: `canvas.rs:92,153,160`, `PathBuf::join`.
- Not reachable today: `tools.js:1631,1658` reduce ids to `[a-z0-9-]`.

**18. Interactive chat prints non-text `content`.**
- Node: `interactive.js:35`, `process.stdout.write(data.content)`, throws for a number or object; the surrounding
  `try` skips the event.
- Rust: `interactive.rs:81-82` prints `"123"` or `"[object Object]"`.

**19. Agent registry: an agent whose `id` is not text.**
- Node: `agent-registry.js:86`. `path.join(baseDir, agent.id)` is outside the `try`, so `initAgentRegistry` throws at
  boot.
- Rust: `agent_registry.rs:103-106` skips that agent.
- Confirmed: in Node, `[{id:5,...}]` stored gives `The "path" argument must be of type string. Received type number
  (5)`.
- Not in the report's list of differences.

**20. `upsertAgent` without a store: the Rust test asserts the opposite of Node.**
- Node: `agent-registry.js:119,146-151`. `getAgents()` returns `DEFAULT_AGENTS` itself, so `push` changes it in place.
- Rust: `agent_registry.rs:184-204` builds fresh defaults each time, and the test at `:290-292` asserts the count stays 4.
- Confirmed in Node: `upsertAgent({id:"x"})`, then `getAgents()`, gives `coder,researcher,writer,quick,x`.
- No Node caller does this without a store.

**21. `session-memory` compares a text `messageCount` differently from JavaScript `>`.**
- Node: `session-memory.js:6`. Rust: `session_memory.rs:18` (`parse::<f64>()`).

  | `messageCount` | Rust | Node |
  |---|---|---|
  | `"inf"`, `"infinity"` | counts (true) | false |
  | `"0x10"` | false | true |

- Nothing emits `session:end` today (report bug #3).

**22. The service commands' stderr is no longer shown when they succeed.**
- Node: `service.js:64,65,74,90`. `execSync` without `stdio` passes stderr to the terminal; systemd's "Created symlink
  ..." is an example.
- Rust: `service.rs:29-38` captures stderr and shows it only inside the error of a failed command.

**23. `docs/hooks.md` says "one line of JSON on stdin", but no newline is written.**
- Docs: `docs/hooks.md:49`. Code: `hook_loader.rs:153-158` (`serde_json::to_vec`, no `\n`).
- A shell hook using `read -r line` gets exit status 1 and misses the event: `printf '{...}' | { read -r x; echo $?; }`
  prints `1`.

**24. Workspace paths shown to the model are not normalised as `path.join` normalised them.**
- Node: `workspace-files.js:193` (also `checkpoint.js:28`, which goes into `/checkpoint`'s playbook and the
  `[checkpoint]` log line).
- Rust: `workspace_files.rs:239`, `checkpoint.rs:30`. `config/env.rs:52-55` keeps `TARSEE_WORKSPACE_DIR` as given.
- Confirmed with `TARSEE_WORKSPACE_DIR=C:/.../ws//`:
  - Node: ``memory is in `C:\...\ws3\MEMORY.md` ``
  - Rust: ``memory is in `C:/.../ws//MEMORY.md` ``
- The same happens on Linux for a value with `//`, `/./` or `..`. A plain path is unaffected, including the default and
  Railway's.

**25. Dates and times in the default locale are fixed to US English.**
- Node:
  - `canvas.js:152`, `c.modified.toLocaleDateString()` (the gallery).
  - `boot-context.js:80`, `toLocaleTimeString()`.
- Rust: `canvas.rs:353` (`%-m/%-d/%Y`) and `boot_context.rs:134` (`%-I:%M:%S %p`).
- What differs: Node on Linux follows `LANG`/`LC_ALL`. In WSL, `LANG=en_GB.UTF-8` gave `12/11/2026`, and
  `LANG=de_DE.UTF-8` gave `17:30:05` where Rust gives `11/12/2026` and `5:30:05 PM`.
- With no `LANG`, as in the Docker image, Node gives the US form too.
- `getBootContextSummary` has no caller in Node, so only the gallery is visible. The report's risk 2 covers the time
  zone, not the locale.

**26. `daemon/pid.rs` starts programs that inherit the real environment (port rule 8).**
- Rust: `pid.rs:43-60`. `/bin/sh -c "kill -0 <pid>"` and `tasklist` run without `env_clear()`.
- Node spawned nothing here (`process.kill(pid, 0)`). This is harmless; only the rule is broken.

**27. The program-hook timeout test does not check that the program was stopped.**
- `tests/it/hooks.rs::a_program_that_runs_too_long_is_stopped` asserts only that `emit` returns "Hook timeout" within
  10 s. It passes without `kill_on_drop(true)`.

## Tests

- **Ported Node cases:** same inputs and assertions or stronger. With a Windows checkout's CRLF defaults, the LF
  normalisation on both sides keeps the comparisons meaningful. The CRLF cases test the endings on their own.
- **Route tests** compare whole bodies.
- **Weak spots:**
  - The 500 test for a missing body checks `error` only, never `detail`.
  - The scan-order test can catch an unsorted listing only on Linux; Windows returns names sorted.
  - Nothing tests the quoting in `RealSystem::run` (finding 3) or the kill on timeout (finding 27).
  - Findings 1, 2, 4, 6, 7 and 12 have no test.
- **`clipMemory` from `test/token-diet.test.js`:** run with another input (`"Line one\n\n" + "detail "×80` instead of
  the meeting-notes text). The assertions are the same.

## Report claims that do not hold

- **Difference 7** ("the send module percent-decoded the path after the existence check... only matters for a folder
  whose name holds `%xx`") is wrong. Express's `sendFile` passes the path through `encodeURI` first, so send's decode
  undoes it. Node served the folder `a%20b` for `/canvas/a%20b/` (200), and Rust does the same: there is no
  difference. The real canvas differences (findings 4 and 13–15) are not listed.
- **Difference 10** (agent registry) leaves out findings 19 and 20.
- **Difference 9** and **bug #8**: see findings 7 and 8.
- **Bug #1**: see finding 1.
- **"The token-diet cases for `clipMemory` are also run here"**: they run with another input (see Tests).
- **Not listed anywhere:** the Windows quoting regression (3), the consolidate change (2), the hidden stderr (22).

## Checked and the same

**Workspace files** (one cross-run against Node):
- `truncateContent`: byte-based head and tail, whole characters only, and the warn-once key in UTF-16 units.
- JS `trim` and `\s` sets.
- The IDENTITY regex, including labels that run across lines and CRLF.
- The `^#.*$` line stripping, with U+2028 as a line end.
- `swapWholeLines` on CRLF, LF and mixed files.
- The daily log: header, UTC day, local `HH:MM:SS`. Node 22 prints `00:05:09` at midnight, as Rust does.

**Checkpoint:** the stamp format, the log texts, newest-first stable sort, `.md` filter.

**Boot context:**
- The file is `JSON.stringify(...,null,2)`-shaped.
- `|| 0` and `|| ""` are handled.
- Timeline text is extracted.
- The age rounds the same way, including negative ages.
- `NaNh` and `Invalid Date` appear where Node printed them.

**Skills:**
- The frontmatter regex and the heading fallback (including Greek final sigma).
- The prompt section text and scan order.
- Status codes and bodies of every route.
- body-parser 2's empty-body and strict-mode rules.
- `ERR_INVALID_ARG_TYPE` texts.

**Memory:**
- parseInt limits, row key order with `score` last, `byCategory` order.
- The MEMORY.md append and migration texts.
- The extractor regex and log texts.
- The learning hint.

**Diagrams:**
- All 9 fixtures, rebuilt with Node.
- Error messages for a null node, edge or legend entry, and for a string legend.
- Coordinates given as text.
- Huge or odd numeric ids.

**Canvas:**
- The escaping, `encodeURIComponent`, the CSP text, the sign-in page and the gallery HTML.
- KB rounding, the weak ETag format, and the 403 on `..`.

**Hooks:**
- Order, results, logs and timeout.
- The three built-in hooks' file lines.
- Program hooks get `env_clear()` and then the app's `Env`.

**Automation approval:** hashes match Node (`00d94d69…`, `b099fd1d…`), and so do setting keys and JSON key order.

**Service:** the systemd unit and the plist match Node's templates, apart from the documented `tarsee start`.

**Port rules:** no `std::env::var`, no stateful `static`, no `unwrap`/`expect` on run-time failures outside tests in
the package's files. The Node comments that explain why were carried over.

COMPLETE: yes
FAITHFUL: no
