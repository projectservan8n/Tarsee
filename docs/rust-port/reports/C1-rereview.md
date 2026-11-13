# C1 re-review (fix round 1, merged at 2f14fc4)

Checked on Windows in a worktree at 8a3ff04 (the package's files are the same as at 2f14fc4), against the Node code
run from the main checkout (express 5.2.1, better-sqlite3). The throwaway test and its `mod` line are deleted; the
worktree is clean apart from this file. Scripts and sandboxes were kept outside the repository.

Result: 25 of 27 findings are addressed. Two were left on purpose and are still as the review described them (10, 25).
One hole is still open in one configuration, and the fix for finding 6 broke one case; both are below.

## The findings

1. An absolute skill name leaves the skills folder (Critical): ADDRESSED.
   - 144 names through each of the 7 skill requests, and 34 paths sent as written: 1,110 requests to the Rust router.
     The whole sandbox was compared before and after each one.
   - The names: absolute in Windows, Unix, UNC and `\\?\` forms; drive-relative; `..` in every position; mixed
     separators; `a.`, `a `, `...`, `nul`, `con`; stream names; a drive in the middle; percent-encoded once and twice;
     NUL and odd Unicode.
   - Nothing outside the skills folder changed, and the shipped skills were untouched.
   - Node's router, run on the 110 names its own `path.join` keeps inside the folder, gave the same status, body and
     disk change in 790 of 842 requests.
   - The 52 that differ are of two kinds. A name with a separator that Node followed to another entry inside the
     folder (`a/`, `/a`, `mine/sub`) is now "not found", which is the rule the report states. The rest are answers
     the router does not own: bad percent-encoding, a trailing slash, an unmatched path, 405.
2. `consolidate` deletes memories when the prefix ends inside an emoji: ADDRESSED. 50 memories through both stores:
   the cut inside an emoji with the same and with a different first half, a whole emoji at the cut, final sigma, `İ`,
   U+FEFF and U+0085 at the end, astral letters in both cases. Both removed the same 21 and kept the same 29.
3. `tarsee service install` mangles `schtasks`'s `/TR`: ADDRESSED. The installer's command line for 4 program paths
   (spaces, parentheses, `&`, `%`, `^`) was run through `RealSystem::run` and through Node's `execSync`, with
   `schtasks` replaced by a stand-in. Both gave the same arguments and the same raw text, for example
   `/Create /SC ONLOGON /TN tarsee /TR "\"C:\Program Files\Tarsee\tarsee.exe\" start" /RL HIGHEST /F`, where the
   `/TR` value arrives as `"C:\Program Files\Tarsee\tarsee.exe" start`. The path with `&` fails the same way in both.
4. Canvas dot-segment rule on the last part only: ADDRESSED. 146 requests against the same canvas folder in both
   versions, for 4 workspaces (plain, under a dotted folder, UNC, with `..` and doubled separators). `.git/config`,
   `.env`, `.hid/` and every file under the dotted folder answer `404 {"error":"Not Found"}` in both.
5. Recursive copies and deletes on the async runtime: ADDRESSED. The work is in `spawn_blocking`. Requests were dropped
   half way without the test seam: an install of 3,001 files left at 41 copied finished whole and identical; an
   uninstall, a delete and a setup of several skills left part way finished; a create and an update left at their
   first poll finished; 20 creates left at once all finished. The skills cache showed each change.
6. Uninstalling a skill that is a file: ADDRESSED (`loose.md`: 200 and gone, for uninstall and delete, as in Node). The
   new `remove_entry` broke the removal of a linked folder: see "New breakage".
7. Memory search with a negative limit: ADDRESSED. `limit=-1`, `-2`, `-100` give Node's results.
8. Values that are not text in the memory routes: ADDRESSED. 78 requests to both routers in the same order (26 bodies
   with numbers, booleans, objects, arrays, nested arrays; repeated `q`, `category`, `limit`): every status and body
   the same, and the same `[error]` lines.
9. Frontmatter key order: ADDRESSED. `GET /ordered` answers `{"1","2","10","name","description","01"}` without
   `__proto__` in both; `parseIdentityFile` gives the same object for the test's input.
10. A wrong method on a known path answers 405: NOT ADDRESSED. Left for Z1, as the report says. `DELETE /` on the
    skills router is still 405 where Express answered 404.
11. The `[error]` line lost the error name: ADDRESSED. The lines for the 500s of both routers equal the first line of
    Node's. One leftover: for a path that is not text Node's line is `TypeError [ERR_INVALID_ARG_TYPE]: The "path"
    argument ...` and Rust's is `TypeError: The "path" argument ...`.
12. Legend of an inherited kind prints `undefined`: ADDRESSED. 14 more specs (`toString`, `__proto__`, `constructor`,
    labels `""`, `0`, `null`, kinds that are not text) give the same HTML in both; the 10 fixtures equal Node's output.
13. Canvas 304 answers: ADDRESSED. 36 sets of conditional and range headers (If-None-Match, If-Modified-Since,
    `no-cache`, If-Match, If-Unmodified-Since, Range, If-Range) give Node's status, headers and body. One leftover: a
    304 here carries `content-length: 0` (axum adds it); Node's carried none.
14. A folder under `/canvas/` goes on without the isolation headers: ADDRESSED. `/canvas/c1/sub` reaches the next
    handler with the four headers in both.
15. The gallery sorts by nanoseconds: ADDRESSED. Two canvases 0.2 ms apart inside one millisecond are listed in Node's
    order; the whole gallery page is identical.
16. A UNC workspace breaks canvas serving: ADDRESSED. With the workspace on `\\localhost\<share>\...` the 146 answers
    match Node's as for a plain workspace.
17. `CanvasServer` with an absolute id: ADDRESSED. The 144 names and `""` through `serve`, `get` and `delete`: nothing
    outside the canvas folder changed, nothing outside it was read.
18. Interactive chat prints non-text content: ADDRESSED. 15 events through `run` and through the Node loop with the
    real `process.stdout.write`: both print `ABCEé😀`.
19. An agent whose id is not text: ADDRESSED. Same message as Node (`Received type number (5)`, `Received undefined`),
    the agent before it has its folder, the one after has none.
20. `upsertAgent` without a store: ADDRESSED. The same 13 steps in both (upsert, rename, remove, a store with a bad
    id, an empty stored list) give the same lists.
21. `session-memory` compares a text count differently: ADDRESSED. 66 texts give Node's `Number(text)` and `> 5`; the
    hook writes the same daily-log line for 24 counts.
22. The service commands' stderr is hidden: ADDRESSED. The commands that show it are the ones `service.js` ran without
    `stdio`. `execSync` both shows the stderr and puts it in the error, as `RealSystem::run` does now.
23. `docs/hooks.md` says one line of JSON, no line end written: ADDRESSED. `hook_loader.rs:154-155` adds it; the
    integration test reads it.
24. Workspace paths are not normalised: ADDRESSED. 7 spellings of `TARSEE_WORKSPACE_DIR` (doubled and trailing
    separators, `.` and `..`, forward slashes, UNC, a lower-case drive) give Node's memory pointer and checkpoint path.
25. Dates in the default locale are US English: NOT ADDRESSED. Left as it is, as the report says.
26. `pid.rs` starts programs with the real environment: ADDRESSED. Both checks are `env_clear()` plus the `Env`.
27. The timeout test does not check the program was stopped: ADDRESSED. The test waits for the program to be gone and
    fails if `<pid file>.done` exists, which a program that ran its 4 seconds would have written.

## Hole still open

**With a state folder that is not absolute, the names Windows rewrites reach another entry.**

- Where: `src/util/node_path.rs:73`. `to_namespaced` returns a path that is not absolute as it is. `Config::load`
  (`src/config/env.rs:56-61`) keeps a relative `TARSEE_STATE_DIR` or `TARSEE_WORKSPACE_DIR` relative, and Rust does not
  count `\data\tarsee` (no drive) as absolute. Node's `fs` resolved every path against the working folder before
  making it literal.
- Reached from: `routes/skills.rs:297,310`, `lib/skills_engine.rs:235,273,284`, `lib/canvas.rs:112,176,187,360`,
  `lib/workspace_files.rs:71`, `lib/agent_registry.rs:126`.
- Confirmed with `TARSEE_STATE_DIR=..\<sandbox>\state` and with `\<path without a drive>\state`:

  | Request | Rust | Node, same folder |
  |---|---|---|
  | `DELETE /api/skills/...` (also `....`, `.%20`, `..%20`) | 200, the whole skills folder is removed | 404 |
  | `POST /api/skills/uninstall {"name":"..."}` | 200, the whole skills folder is removed | 200, nothing removed |
  | `DELETE /api/skills/a.` (also `a%20`, `a...`) | 200, the skill `a` is removed | 404 |
  | `PUT /api/skills/a.` | 200, `a/SKILL.md` is overwritten | 404 |
  | `GET /canvas/c1./`, `/canvas/c1/index.html.` | 200 with the file | 404 |

- Also: `CanvasServer::delete("...")` removes the canvas folder and `serve("c1.")` overwrites `c1/index.html` (the
  tools reduce ids first, so no request reaches these); `write_workspace_file("SOUL.md.")` writes `SOUL.md`.
- Nothing outside the skills, canvas and workspace folders changed in this configuration either: `.. ` comes to the
  folder itself, not its parent.
- With an absolute folder (plain, forward slashes, UNC, `\\?\`, `..` inside) all of these are "not found", as in Node.
- Making the configured folders absolute when the configuration is loaded would close it for every package.

## New breakage

**A skill or canvas that is a link to a folder can no longer be removed on Windows.**

- Where: `src/lib/skills_engine.rs:288-293` (`remove_entry`, used by uninstall and by `DELETE /:name`) and
  `src/lib/canvas.rs:188-193` (`CanvasServer::delete`).
- What changed: `symlink_metadata().is_dir()` is false for a junction or a folder link, so the code calls
  `remove_file`, which Windows refuses. Before the fix both paths ended in `remove_dir_all` for such a link, which
  removes the link and leaves what it points to (checked with a small program: `remove_file` gives "Access is
  denied", `remove_dir_all` removes the link, the target stays whole).
- Input: a junction `workspace/skills/linkj` to a folder elsewhere, then `POST /api/skills/uninstall
  {"name":"linkj"}` or `DELETE /api/skills/linkj`.
- Rust: 400 (uninstall) and 500 (delete), `EPERM: operation not permitted, rm '...\skills\linkj'`; the link stays.
  `CanvasServer::delete` returns false.
- Node: 200 and the link is gone; the folder it pointed to is whole in both versions.
- Unix is not affected by reading (`remove_file` removes a link there); not run.

Nothing else was found in the fix diff:
- Callers of the changed functions were all updated (the crate builds; `get_agent_workspace`, `is_running`, `search`
  and `uninstall_skill` have no caller left with the old shape).
- No test was weakened. The assertions that changed follow a listed Node bug fix (the blank line a kept body gained)
  or the review's own findings (20, 27).
- Ordinary inputs: 65 requests to the skills router in one sequence (create, update with kept and new fields, CRLF
  files, install, uninstall, setup, names that are not text) give Node's status and body in 64. The one that differs,
  and the files on disk, differ only by the blank line the Node code added at each update (listed as fixed).

## Seen, and the same as Node

- A stream name reaches the entry it belongs to: `DELETE /api/skills/mine::$INDEX_ALLOCATION` removes `mine`,
  `GET /canvas/c1/index.html::$DATA` sends the file. All inside the folder, and Node does the same.
- `DELETE /api/skills/MINE` removes `mine` on a file system that ignores case, in both.
- Not from this fix: an uninstall and an install of the same skill sent at once ran together, and the uninstall
  answered `400 ENOTEMPTY`. Node ran one request after the other.

## The suite

`cargo test --no-fail-fast`, once, with the scratch test removed: 1931 unit, 126 integration (5 ignored), 144 browser,
0 failed.
