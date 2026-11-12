# B2 review: safe paths, PDF text, brand icon and the files route

Reviewed at `2344f0e` (branch `rust-rewrite`; the package is `git diff a9bc6da 7094777`), against the Node files in the
main checkout, on Windows 11 with Node v22.18.0. `cargo test` passes before any scratch test was added: `1132 passed`
(lib), `57 passed`, `139 passed` (it), 0 failed.

Method. Every Node file was read next to its Rust file. Where behaviour was in doubt, both sides were run: the Node
module with `node` in the main checkout (with `TARSEE_STATE_DIR`, `TARSEE_WORKSPACE_DIR` and `TARSEE_DATA_DIR` pointed
at a scratch folder), the Rust through a throwaway `tests/it/zz_review_scratch.rs`. The outputs were compared by
script. The scratch test and its `mod` line are gone. The worktree is clean apart from this file.

What was compared:

- **`safePath` and the helpers.** 1,924 (input, root) pairs went through both `safePath` implementations, plus 381
  inputs each for `isSensitivePath`, `sanitizeFilename` and `looksSafeTarPath`. The 113 inputs mix Unix and Windows
  absolute paths, `..` in every position, doubled and mixed separators, `C:x`, `\\?\`, `\\.\`, UNC, trailing dots and
  spaces, `nul`/`con`, stream suffixes, case variants, NUL, U+2028, U+FEFF, U+0085 and 300- and 601-character names.
  There are 16 root spellings.
- **The files route.** 110 requests went to the real Express `filesRouter` and to `routes::files::router()`. Each
  request started from the same freshly built folder: a workspace, a sibling `ws-old`, and an `outside` folder. They
  ran under three spellings of `TARSEE_WORKSPACE_DIR`: plain, with a trailing `\`, and with `/`. Status, body,
  Content-Disposition and the whole folder tree afterwards were compared. Junctions leading out were checked separately.
- **The built-in PDF reader.**
  - 92 real PDFs: 1,482 pages. The producers are Microsoft Word 2019, Skia/PDF (Chrome, Edge and Google Docs),
    pdfTeX, pdflatex, arXiv/pikepdf, Canva, Figma, macOS Quartz, Adobe PDF Library/InDesign, and others whose metadata
    sits in compressed streams.
  - 1,104 damaged copies of them: 6 truncations and 6 runs of random byte overwrites each, made by the same generator
    on both sides and checked equal by hash.
  - 28 hand-made PDFs: object and xref streams, encryption, 5,003 pages, cyclic page trees, self-drawing and 9-deep
    forms, nesting, a 70 MB stream bomb, five 60 MB streams, an object-stream bomb, lying `/Length`, and ToUnicode maps
    for Arabic, Chinese, Devanagari, Thai, emoji pairs and lone surrogates. Also Differences with odd entries,
    incremental updates, inline images, every text operator, damaged trailers, `#` names, a late header,
    ASCIIHex/ASCII85 chains, LZW/DCT, and predictors with absurd sizes.
- **The PNG decoder.** 161 PNGs: 11 from Pillow, the rest made by hand, plus truncations and bit flips. They cover every
  colour type and depth, tRNS forms, split and empty IDATs, every bad CRC, a missing IEND, data after IEND, unknown
  critical chunks, a `0xFFFFFFFF` length, zlib trailing junk, truncation, a bad Adler-32, raw deflate, FDICT, a 50 MB
  bomb, one byte too many and one too few, bad filters, palette faults, every invalid colour type and depth, headers
  of 2049² and 2³¹×2³¹, and an interlaced file.
- **The icon sets.** Icon sets from 5 masters (64 to 2048 px), compared by decoded pixels.
- **Smaller helpers.** `isPrivateAddress` on 71 spellings; `decodeBase64` on 24 inputs; SVG sniffing; Node's UTF-8
  decoding against `from_utf8_lossy`.

## Findings

### C1. Windows: the file the route opens is not the file it checked (the whole workspace can be deleted)

**Critical.** `src/routes/files.js` 35, 71, 77, 104, 127, 150 to 160, 216 and `src/lib/safe-path.js` 43, 58 to 63,
against `src/routes/files.rs` 147, 202, 221, 265, 279, 302 to 311, 373, 381.

Both versions check the request's path as text: `safePath`, the `.db$` patterns of `isSensitivePath`, and
`ALLOWED_ROOTS.includes(resolved)`. Then they pass the same text to the file system. On Windows the two runtimes do
not hand it over the same way:

- **Node's `fs`** prefixes the path with `\\?\` (`path.toNamespacedPath`). Windows then takes every name literally:
  `ws\...` is a file named `...`, `a.txt.` is not `a.txt`, `nul` is a file called `nul`.
- **Rust's `std::fs`** passes a path shorter than about 248 characters unprefixed. Windows then applies its own path
  rules first:
  - trailing dots and spaces of the last name are dropped, so `ws\...`, `ws\. ` and `ws\.. ` become `ws` and
    `data.db.` becomes `data.db`;
  - `nul` is the null device.
  For longer paths Rust calls `GetFullPathNameW`, which applies the same rules.

So in Rust the object opened is not the one that passed the checks. Confirmed on the routes, Node's answer first:

| Request (workspace written normally) | Node | Rust |
|---|---|---|
| `POST /delete {"path":"..."}` (also `". "`, `".. "`) | 404 "Path not found", nothing removed | 200 `{ok:true}`, **the whole workspace is deleted** |
| `POST /delete {"path":"sub/..."}` | 404 | 200, folder `sub` and everything in it deleted |
| `GET /read?path=data.db.` (also `DATA.DB `) | 404 "File not found" | 200 with the database's bytes |
| `GET /download?path=a.txt.` | 404 | 200, the bytes of `a.txt` |
| `POST /write {"path":"a.txt.","content":"y"}` | writes a new file `a.txt.` | overwrites `a.txt` |
| `POST /delete {"path":"a.txt."}` | 404 | 200, `a.txt` deleted |
| `POST /write {"path":"nul"}` | writes a file `nul` | 200, nothing written (it went to the NUL device) |
| `GET /ls`, `/read`, `/download`, `POST /delete` on `nul` | 404 | 500 "Incorrect function. (os error 1)" |
| `POST /write {"path":"..."}`, `POST /mkdir {"path":"..."}` | creates `...` | 500 EPERM; mkdir is a no-op |
| `POST /rename` to `"...."` | 200, renamed | 500 EPERM |
| `POST /rename` from `"..."` | 500 ENOENT | 500 "The parameter is incorrect. (os error 87)" |

The first two rows are the folder guard (`Cannot delete root directory`) and the 404 being bypassed. The `data.db.`
row is a protected file served. These checks show that nothing outside the workspace becomes reachable:

- the path text has no `..` left after resolving, and Windows only trims the last name;
- `ls` of `...` stays 404 on both sides, because `FindFirstFileW` does not trim.

The same happens with all three root spellings, and only on Windows: Linux and macOS do not rewrite names. Rust and
Node agree on the `a.txt::$DATA` stream forms; see the Node bugs below.

`lib::pdf_text::locate` is not affected: it canonicalizes the path and checks the real path again.

### C2. A PDF whose predictor asks for an absurd row size kills the server (or fails the whole PDF)

**Critical.** `src/lib/pdf-text.js` 917 to 927 against `src/lib/pdf_text.rs` 2566 to 2578.

`predict` sizes a row buffer from `/Columns`, `/Colors` and `/BitsPerComponent`, as the JS did.

- **Node.** `Buffer.alloc(rowLen)` throws a RangeError for an impossible size. The reader catches it, and the page reads
  as "" (or the whole read fails with a message when it is an object stream).
- **Rust, very large sizes.** `let mut prev = vec![0u8; row_len]` is an allocation the allocator refuses. That is not a
  panic but an abort of the process.
- **Rust, even larger sizes.** `row_len` saturates to `usize::MAX`. `data.len() / (row_len + 1)` then overflows: a panic
  in debug builds, division by zero in release builds.

Confirmed with hand-made two-page PDFs, Flate content plus `/DecodeParms << /Predictor 12 /Columns N >>`:

| PDF | Node `builtinPdfText` | Rust `builtin_pdf_text` |
|---|---|---|
| `/Columns 1000000000000` | `["", "second page"]` in 26 ms | `memory allocation of 1000000000000 bytes failed`, process ends with 0xc0000409 |
| `/Colors 1e6 /BitsPerComponent 1e6 /Columns 1e6` | `[""]` | `memory allocation of 125000000000000000 bytes failed`, process ends |
| `/Columns 1e20` | `["", "second page"]` | panic "attempt to add with overflow" (pdf_text.rs:2576) |

When the call goes through `PdfReader::pdf_text`:

- the panic case is caught by `spawn_blocking` and returns `pages: []` with "it could not be read (task 1 panicked with
  message ...)", where Node read the other pages;
- the allocation case still ends the whole process.

How the reader is reached:

- Every PDF goes to this reader where pdftotext is missing (Windows and macOS installs).
- Elsewhere it gets PDFs pdftotext gave up on.
- PDFs reach it from `pdf_read` and from chat attachments (`ai/media`), so anyone who can send the bot a PDF can stop
  the server.

The unit test `ascii85_and_predictor_edge_cases` only tries a negative size.

### I1. `is_private_address` trims with Rust's `trim`

**Important** (a rule of the port). `src/lib/pdf-text.js` 283 against `src/lib/pdf_text.rs` 981.

`ip.trim()` is `str::trim`, not JavaScript's `trim`. Running both functions:

| Input | Node | Rust |
|---|---|---|
| `"\u0085" + "8.8.8.8"` | true | false |
| `"8.8.8.8" + "\u0085"` | true | false |
| `"﻿" + "8.8.8.8"` | false | true |

The other 68 spellings agree. Within this package the function only sees canonical addresses (URL hosts and lookup
results), so nothing is let through today. It is exported for other packages.

### M1. `resolve_path` is not `path.resolve` for relative or drive-less roots, or a bare UNC share

**Minor.** `src/lib/safe-path.js` 75 and 79 against `src/lib/safe_path.rs` 192 to 229. Confirmed by the 1,924-pair
comparison: every difference is in this list.

- **The root is relative (`ws`, `./ws`) or rooted without a drive (`\data\ws`).** Rust makes it absolute with
  `std::path::absolute`, which on Windows is `GetFullPathNameW` and applies the Win32 rules. Node only works on the text.
  - Rust allows `../ws./x` (it becomes `ws\x`) and turns `...`, `a/...`, `.. ` and ` ` into the root or parent text.
  - Rust refuses `E:x` (the per-drive current folder), `nul`, `NUL:` and `x\0y` as "outside".
  - Rust gives "Path is not accessible" for `x.db.` and `x.db `.
- **A bare share** `\\server\share` with root `\\server\share\ws`: Node answers "outside". Rust maps it onto the
  root, because `join_like_node` treats a UNC prefix with no root folder like `C:x`.
- **A UNC root written with `/`** (`//server/share/ws`): Rust keeps the prefix as written, so results read
  `//server/share\ws\...`. Rust refuses `\\server\share\ws\x`, which Node accepts.

None of these reaches outside the root, because what Rust checks is what Windows opens. With the usual absolute root
the two versions give the same answer for every input.

### M2. JSON bodies Node accepts are refused: a UTF-8 byte order mark, a lone surrogate

**Minor.** `src/server.js` 144 (`express.json`) against `src/routes/files.rs` 100 to 124.

- **A byte order mark.** `express.json` strips a leading BOM: `POST /write` with BOM plus `{"path":"bom.txt",...}` is
  200 in Node. Rust answers 400 `Unexpected token '﻿', ...`.
- **A lone surrogate.** `{"content":"\ud800"}` writes the file in Node (as EF BF BD). Rust answers 400 "unexpected end
  of hex escape", because serde_json refuses lone surrogates.

Both confirmed by running both. The browser UI does not send either.

### M3. Several `fs` error texts on Windows are not Node's

**Minor.** `src/lib/safe_path.rs` 311 to 335, seen through `routes/files.rs`. Confirmed on the routes.

| Case | Rust | Node |
|---|---|---|
| A name Windows rejects (`ERROR_INVALID_NAME`, e.g. renaming to `x:stream`) | `ENAMETOOLONG: name too long, rename ...` (from `ErrorKind::InvalidFilename`) | `ENOENT: no such file or directory, rename ...` |
| Writing to a folder's path (`sub/..`) | `EPERM: operation not permitted, open ...` | `EISDIR: illegal operation on a directory, open ...` |
| Renaming the root onto a non-empty sibling | `ENOTEMPTY` | `EPERM` |
| A NUL in the path | "strings passed to WinAPI cannot contain NULs" | "The argument 'path' must be a string, Uint8Array, or URL without null bytes. ..." |

The report's difference 2 covers kinds with no Node code. These are codes it maps wrongly.

### M4. pdftotext that writes more than 64 MB is not stopped until the time limit

**Minor.** `src/lib/pdf-text.js` 67 against `src/lib/pdf_text.rs` 385 to 414. Shown from the sources.

- **Node.** `execFile` kills the child as soon as stdout passes `maxBuffer`.
- **Rust.** `read_out` returns its error, but `tokio::join!(read_out, read_err)` waits for stderr. The child blocks on
  a full stdout pipe and keeps stderr open, so the join only ends at the timeout: 60 s by default. `kill_on_drop` then
  stops the child.

The result is the same (the built-in reader takes over), but up to 60 s later.

### M5. The 4 brand-icon route cases deferred to R4 are not in R4's list

**Minor.** `docs/rust-port/PLAN.md`, section R4.

The report defers "GET, POST and DELETE /api/settings/brand-icon" (4 cases of `test/brand-icon.test.js`) to R4, with a
good reason: they test `routes/settings.js`. But R4's "Tests to port" does not list `test/brand-icon.test.js`, and the
report's hand-off item 5 describes the route without naming the cases. They can be dropped without anyone noticing.

The other deferrals are picked up elsewhere:

- The 3 "TarseeBrand on the page" cases are ported by W1a (`reports/W1a.md`).
- The `pdf-read.test.js` cases are under S3.

### M6. Looking for pdftotext reads the real environment

**Minor** (rule; known). `src/lib/pdf_text.rs` 325.

`which::which_in` reads `PATHEXT` from the process environment on Windows. The report's risk 5 says so, but the rule
("no read of the real environment") is still broken.

Unlike libuv, which only tries `.com` and `.exe`, `which` would also find a `pdftotext.bat` or `.cmd`.

## The two Node bugs the report ported, confirmed

**1. Delete of the whole workspace.** Run on both sides with the real routers.

- With `TARSEE_WORKSPACE_DIR` ending in `\`, or written with `/`, `POST /api/files/delete` deletes the whole workspace
  in Node, and the same in Rust. The paths used were `"."`, `"./."`, `"sub/.."`, the root itself, the root with a
  trailing `\` and with `/`, and `root\.`.
- With the plain spelling both answer "Cannot delete root directory".

The configuration now normalises its folders (`src/config/env.rs` 56 to 66), but that changes nothing here.
`routes/files.rs` `allowed_roots` (63 to 69) deliberately reads `TARSEE_WORKSPACE_DIR` again as it was written, to
match Node's text comparison. So this bug is still reachable exactly as in Node. When the variable is not set, the
root is built normalised on both sides and the bug is not reachable.

On Windows, C1 adds a Rust-only way to the same result with any spelling of the root: `"..."`, `". "` or `".. "`.

**2. Rename with a prefix check and `/` kept in the new name.** Confirmed on both sides with the plain root:

- `{"path":".","newName":"ws-old2"}` renames the whole workspace to the sibling `ws-old2`, outside the workspace;
- `{"path":"sub/b.txt","newName":"../../ws-oldfile.txt"}` moves the file out of the workspace into its parent folder.

Both work in Node and in Rust. Still reachable in Rust, identically.

**Not in the report: a third Node bug.** The `.db`, `.db-wal` and `.db-shm` patterns of `isSensitivePath` are matched
against the raw path, not per name.

- An NTFS stream suffix defeats them: `GET /read?path=a.txt::$DATA` reads `a.txt` in both versions, so `data.db::$DATA`
  reads a protected database in Node as well.
- Rust ports this as it is. C1 adds the trailing-dot and trailing-space spellings on top.

**Also the same in both.** A junction inside the workspace that leads out is followed by `ls` and `read`, because the
check is only on the text. Deleting the junction removes the link only, and the target's files stay.

## fetch_pdf: does a download connect only to checked addresses?

Yes. `download` builds its client (pdf_text.rs 1302 to 1310), and each call keeps the guarantee:

- **`.dns_resolver(PinnedResolver)`.** Every host name goes through the given `Lookup`, which is `GuardedLookup` over
  `lookup_host` by default. The client connects to exactly the addresses that came back, and the guard checks all of
  them (any private one refuses the name).
- **IP literals.** hyper does not resolve them. `fetch_pdf` checks them itself before each hop (1235 to 1242), on the
  canonical host the URL parser wrote. Decimal, octal and hex IPv4 become dotted; `::ffff:127.0.0.1` becomes
  `::ffff:7f00:1`, which is private.
- **`.redirect(Policy::none())`.** Redirects are followed by hand, at most `max_redirects`. Each hop is parsed,
  scheme-checked and literal-checked again, and its name goes through the same resolver.
- **`.no_proxy()`.** In reqwest 0.13.5 this clears the proxy list and sets `auto_sys_proxy = false`, so neither proxy
  variables nor Windows' system proxy can make a proxy resolve the name.
- **`.no_gzip()`.** reqwest is built without brotli, deflate or zstd, so no `Accept-Encoding` is sent and bodies are
  counted as received, as `http.get` did.

`check_url_safety` is a reputation check only, as in Node (report bug 3): it lets 127.0.0.1 and names through, and
`pdf_read` relies on `fetch_pdf` for the network guard. Its other rules gave the same answers as Node on the forms
tried: refused schemes, raw IPv4 except 127.0.0.1, TLDs, patterns, long labels, punycode, and IPv6 literals.

## Completeness

**Exports.** Every export of the five Node files has its Rust counterpart:

- `safe-path.js`: 4 of 4.
- `url-safety.js`: 1 of 1.
- `pdf-text.js`: 14 of 14, including `__setPdftotextForTests` as `set_pdftotext`/`forget_pdftotext` and `guardedLookup`
  as `GuardedLookup` and `guarded_lookup`.
- `brand-icon.js`: 31 of 31.
- `files.js`: `filesRouter` is `router()`.

**Tests, counted here:**

| Node file | Cases | Ported | Not ported, reason |
|---|---|---|---|
| `test/safe-path.test.js` | 15 | 15 | none. The `null` inputs cannot reach a `&str`; the empty-string branch is tested. |
| `test/brand-icon.test.js` | 54 (39 written, plus 15 from the colour-type loop) | 47 | 4 route cases (R4: see M5); 3 page cases (ported in W1a) |
| `test/pdf-read.test.js` (S3's) | 32 | 27 | 2 need `lib/tools` (S3), 3 need the MCP server (S4) |

The 27 pdf-read cases split as 11 + 3 + 2 + 6 + 5. Of those 27, 2 are in `tests/it/pdf_text.rs` and need a real
pdftotext; they ran here. The assertions are the Node ones or stronger: exact messages where Node used a regex, plus
`ECONNREFUSED`, a redirect loop and folder cases. I found no test that passes with its code broken.

## Checked and the same

- **The built-in PDF reader.**
  - All 92 real PDFs: 1,482 pages, identical character for character.
  - All 1,104 damaged copies: 15,016 pages and every error text identical.
  - 25 of the 28 hand-made PDFs are identical: the limits (5,000 pages, 64 MB a stream, 256 MB in all, "it holds too
    much to decode"), encryption, cycles, form depth, every script through ToUnicode, and so on. The other 3 are C2.
  - A lone surrogate becomes U+FFFD, as the report says.
  - Rust's debug build took about 2 to 3 times as long, off the async threads.
- **The PNG decoder.** All 161 PNGs give the same outcome: the same picture by SHA-256 of its RGBA, or the same refusal
  word for word. The header reading and the type sniffing match too. No panic, and no allocation before the size
  checks: a 2³¹×2³¹ header and a 50 MB IDAT bomb are refused cheaply on both sides.
- **The icon sets.** Pixel-identical for all 5 masters, the edge background colour included.
- **The smaller helpers.**
  - `decodeBase64`: 24 forms (data: prefixes, padding, a lone character, U+00A0, U+FEFF, U+2028, U+0085).
  - SVG sniffing: 8 forms.
  - The read route's UTF-8 decoding: 11 broken sequences, the same U+FFFD count.
- **The files route, apart from C1 and M2 to M3.** Every other request answered the same with all three root spellings,
  and left the same files. The checked cases:
  - absolute paths inside and outside;
  - `\\?\`, `C:..`;
  - case variants;
  - `.codex` and `.CODEX.`;
  - protected names (`data.db` itself);
  - array `path`, numeric and array `newName`;
  - `%FF` in the query;
  - long and accented names;
  - Content-Disposition.
- **Rules.**
  - No global mutable state: `PdfReader` and `BrandIcon` live in the `App`, and regexes are in `LazyLock`.
  - The heavy work runs off the async threads: the PDF reader and the icon set in `spawn_blocking`, `ls` in
    `spawn_blocking`, the other routes through `tokio::fs`.
  - Every other `trim` on outside text uses JavaScript's set.

COMPLETE: yes
FAITHFUL: no
