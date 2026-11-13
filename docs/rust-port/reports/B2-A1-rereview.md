# B2 and A1: re-review of the fix round

Checked on the merged worktree (`a1ce610` for B2, `d5772a9` for A1) with throwaway tests that are now removed.

## B2 (safe paths, files route, PDF reader, brand icon): 14 of 14 addressed

| Finding | Verdict | How checked |
|---|---|---|
| C1 Windows opens another file than the one checked | ADDRESSED | Attack run: 87 paths x 7 routes (ls, read, download, write, mkdir, delete, rename) plus 14 rename sources x 46 new names, disk compared before and after each request (everything outside the workspace, protected `data.db` files, the workspace root). `...`, `. `, `.. `, `a.txt.`, `a.txt `, `DATA.DB.`, `nul`, `con`, `com1`, `aux.txt`, `NUL.txt`, `sub/...`: read, download, delete answer 404 and change nothing; write and mkdir make a file or folder of that literal name and `a.txt`/`data.db` are untouched. Nothing outside the workspace changed in any request; the root always existed afterwards. |
| C2 Absurd predictor sizes kill the process | ADDRESSED | `/Columns`, `/Colors`, `/BitsPerComponent`, `/Predictor` each as 20 values (0, -1, -0, 1e12, 1e20, 2^64, 4294967296, 0.5, `(x)`, `/abc`, `[1 2]`, `<<>>`, null, true, 1e400, -1e400): no panic, and the second page still reads ("second page") every time. Also `/Length`, `/N`, `/First`, `/DL`, `/Length1` set absurd on page 1: no panic, page 2 read. Then every numeric key (Columns, Colors, BitsPerComponent, Predictor, Length, N, First, Count, Size, W, Index, Prev, Kids, Root, Pages, ...) in 6 PDFs from `make_pdf` (Flate+predictor, object stream+predictor, object stream, CID font, form XObject, ASCII85) replaced one at a time by the same 20 values: no panic, none over 2 s. |
| I1 `is_private_address` trims like Rust | ADDRESSED | Code reads `js_trim`; U+0085 + `8.8.8.8` private, BOM + `8.8.8.8` not (unit test passes, and the diff is the one line). |
| M1 `resolve_path` is not `path.resolve` | ADDRESSED | 160 inputs (80 spellings, each with `/` and `\`) through Node's `safePath` and the Rust `safe_path`, root `E:\tmp\ws-cmp\workspace`: identical on all but the intended colon cases (see Node bug 3). |
| M2 BOM and lone surrogate bodies refused | ADDRESSED | BOM + JSON: 200; `"a\ud800b"` writes `61 EF BF BD 62`; latin1 charset 415; empty body, BOM-only body, non-JSON type: empty body (400 "Path required"); `5`: 400. |
| M3 `fs` error texts | ADDRESSED | Seen on the routes: writing to a folder path, `rename` onto a folder (EPERM), `rename "..."` (ENOENT) read as Node's. Ordinary-request comparison with Node below is identical, including the ENOENT rename text. |
| M4 pdftotext flood not stopped | ADDRESSED | Read the new `select!` loop: both pipes read together, `start_kill` the moment either passes `maxBuffer`. The integration test for it ran in the full suite. |
| M5 brand-icon route cases not in R4's list | ADDRESSED (in the report only) | `B2.md` now has "For package R4" naming the four cases and their values. `docs/rust-port/PLAN.md` (R4, "Tests to port") was not changed and still does not list `test/brand-icon.test.js`; see the minor note below. |
| M6 `which` reads the real environment | ADDRESSED | `find_program` takes `PATH` from the app `Env`, tries `.com`/`.exe` only, as libuv; `which` no longer used by the package (diff). |
| Node bug 1 (delete of the workspace) | ADDRESSED | `delete` of `.`, `./`, `x/..`, `sub/..`, the absolute path, with `/`, `\`, doubled and trailing separators, `\.`, `\..\workspace`, `/./`: 400 "Cannot delete root directory" (or "outside" for `..`, `/`, `\`, `//?/` forms and different upper/lower case of the drive path). Root exists after every one. `...`, `. `, `.. ` are 404. |
| Node bug 2 (rename out of the workspace) | ADDRESSED | `rename` from a file or folder to `../outside-r.txt`, `..\x`, `../workspace-old/r.txt`, `..`, `../..`, `sub/..`, `.`, `/`, `\`, an absolute workspace path, an absolute outside path, `C:\x`, `C:x`, `\\server\share\x`, `\\?\C:\x`, a name onto `data.db`/`DATA.DB`/`x.db::$DATA`/`vault.json`/`auth.json`/`.codex/x`: refused (400) or sanitised to a name inside the workspace (`..\x` becomes `.._x`); nothing outside changed. Root as the source (`.`, empty, `/`, absolute, `x/..`, `./`): always 400, root untouched. Root renamed into itself (`.` to `workspace/zz`, `WORKSPACE/zz`): the OS refuses (EINVAL/EPERM), nothing changed. |
| Node bug 3 (`name.db::$DATA` streams) | ADDRESSED | `data.db::$DATA`, `name.db:stream`, `a.txt::$DATA`, `:x`, `sub/x:y` refused with "Path is not accessible" on every route; in `safe_path` only these differ from Node. |
| Node bug 4 (IPv4 in IPv6) | ADDRESSED for mapped addresses; see open hole 1 | 17 mapped spellings (`::ffff:a.b.c.d`, `::FFFF:0A00:0001`, `0:0:0:0:0:ffff:...`, fully padded, with port) all judged by the IPv4 rule (10/8, 192.168/16, 172.16/12, 169.254.169.254, 100.64/10, 0.0.0.0, 127.0.0.2 refused; 127.0.0.1 allowed by design). |
| Node bug 5 (pdftotext got another file) | ADDRESSED | `names_itself` hands a copy over when Windows would rewrite the name; a `pdf_read` of `a.pdf.` reads its own file (unit and integration tests pass). |

Ordinary requests against the Node router: 25 requests in sequence (ls of the workspace and a folder, mkdir, write with accents, read, rename with a space in the new name, download of a missing name, delete, missing content, rename with `/` in the new name, `../` in the new name, ls outside, read of a folder, ls of a file, write to `data.db`, delete folder, delete root, mkdir without path, rename to a name with a quote, URL-encoded `.` and `é`): status and body identical (only the root listing differs by the files Node's config creates on first load, which the Rust side also lists).

### Holes still open (B2)

1. **minor** `src/lib/url_safety.rs` `ipv4_mapped` (about line 240): only `::ffff:a.b.c.d` is judged. Other spellings of IPv4 inside IPv6 pass as safe: `http://[::10.0.0.1]/`, `[::a00:1]`, `[64:ff9b::10.0.0.1]`, `[2002:a00:1::]`, `[::ffff:0:10.0.0.1]`. `is_private_address` (the download guard) refuses all but the last one. The check stays a reputation warning, and IPv6 literals pass in Node too, so this is the same as Node; but the report text "IPv4 written as IPv6 got through" is closed only for the mapped form.
2. **minor** `rename` of a folder onto an existing file inside the workspace (`{"path":"sub","newName":"a.txt"}`) on Windows replaces the file with the folder and answers 200. Node's MoveFileExW refuses a folder over a file. Inside the workspace only; not introduced by the fix (the fix added the folder-target check only). `src/routes/files.rs` rename, after the `metadata(&to).is_dir()` check.
3. **minor** `docs/rust-port/PLAN.md` R4 "Tests to port" still lacks `test/brand-icon.test.js` (M5).
4. Not new, same in Node: no root guard in `rename` when the source is the root (it is stopped by the new target check and by the OS). Short (8.3) names are off on this volume, so I could not try `ENCRYP~1`; the denied-name list would not see one on a volume that has them.

### New breakage from the B2 fix diff

None found. No test was weakened: the removed assertions are the old `resolve_path`/`join_path` text cases, replaced by the 468+468 Node-answer pairs.

## A1 (provider registry): 6 of 6 addressed

| Finding | Verdict | How checked |
|---|---|---|
| 1 Refresh stops when its last caller is dropped | ADDRESSED | Own stub fetch (answer after 500 ms, counts started/finished), paused clock. (a) Caller dropped at 50 ms: request finishes, 36 models in use, cache saved, next caller gets `Cache` with exactly 1 request sent; a forced one after asks again (2). (b) Caller dropped, second caller joins at 50 ms: gets `Network`, still 1 request. (c) Two refreshes at once: 1 request, both `Network`. (d) `stop()` at 150 ms during a 300 ms refresh: started 1, finished 1 after 5 s, models in use, cache saved, no further request, no panic. (e) Success, then a 500 answer: `Stale` with the 36 old models and the error, the list stays; the next forced refresh starts afresh (`Network`, 3 requests in all). (f) Timer, 100 ms interval, 10 s answers, 40 s: 4 requests started, 3 finished, never two at once (ticks join the one in flight, as the JS interval did). |
| 2 U+0085 at the edge of a Claude model name | ADDRESSED | `resolve_model_for` for claude, anthropic, claude-code, deepseek, chatgpt with `opus\u0085`, `\u0085haiku`, BOM variants, NBSP, padded: 40 answers identical to Node's (null for chatgpt = None). |
| 3 Cached list not byte-identical | ADDRESSED | Rust refresh of the fixture at 2026-11-09T12:00:00Z: stored text compared with Node's `JSON.stringify({fetchedAt, models})` from `parseOpenRouterModels`: `cmp` identical, 13,042 bytes. |
| 4 `priceHint` 1e21 and above | ADDRESSED | 11 price pairs (1e-7/1e21, 1e21, 1.5e21, 9.99e20, 1.2345678901234568e20, 1e300, 1e22, 0/0, small ones): identical to Node's `priceHint`. |
| 5 `fetched_at` fraction | ADDRESSED | `Picker` serialised: 1731500000123.4567 gives `1731500000123.4568`, 1731500000123.0 gives `1731500000123`, 0.5, 1e21 gives `1e+21`, -0 gives `0`, None gives null: same as `JSON.stringify`. |
| 6 Looser picker assertion | ADDRESSED | The assertion is now `m[1].get("x") == Some(&Null)` (diff). |

### New breakage from the A1 fix diff

None found. The `Picker` type changed (`Eq` dropped, `f64`); no other caller in the tree. The removed `js_trim`/`is_js_space` were all replaced by `util::js` in the diff. The timer test that used wall-clock time was replaced by paused-clock tests that assert the same facts. One note, not a defect: `refresh_open_router_catalog` now needs a tokio runtime (it spawns), as its doc says.

## Suite

`cargo test --no-fail-fast`: 1769 unit, 108 integration (3 ignored), 139 browser tests pass. The first full run had one failure, `voice::whisper_converts_with_ffmpeg_then_transcribes_and_cleans_up` (starts a real program; machine busy); it passed alone and in the rerun.
