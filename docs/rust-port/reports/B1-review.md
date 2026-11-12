# Review of B1: vault, sign-in and security middleware

Reviewed at `ad965b6` (B1 merged as `1649cf7`), against the Node files of the same tree. The Node code was run from
the main checkout (`node_modules`: Express 5.2.1, body-parser 2.4.0, cookie 0.7.2, proxy-addr 2.0.8, Node 22.18.0);
the Node files there are the worktree's byte for byte, line endings aside.

Scripts and their output are in the session scratchpad,
`C:\Users\USER'S\AppData\Local\Temp\claude\23f9b6322d2888e9\044742b9-8d6f-4546-9664-40e3f73318f9\scratchpad\b1review\`
(`vault-node.mjs`, `auth-node.mjs`, `node_*.json`, `rust_report_*.txt`). The Rust side was a throwaway
`tests/it/zz_review_scratch.rs`, deleted again, so the worktree is clean apart from this file.

## What was run, and what it showed

**Stored secrets, both ways.** `vault-node.mjs gen` encrypted, with the Node vault, 7 plaintexts (empty, one
letter, an ASCII key, non-ASCII with emoji, text holding `:` and `enc:v1:`, control characters with a NUL, 100 KB)
under 9 `ENCRYPTION_KEY`s: `k`; 305 characters, which is longer than a SHA-512 block; `clé 🔑 ключ 日本`;
`"  padded-key  "`; `"\uFEFFbom-key"`; `"nel-key\u0085"`; the porter's fixture key; unset; `"   "`. It also
recorded Node's `isSecretKey` on 46 keys, `maskSecret` on 11 values, `encryptSecretFields` and
`decryptSecretFields` on a nested setting, `redactSecretFields`, `encryptIfSecret` and `isEncryptionEnabled`. The
Rust test decrypted all of it and compared everything, then encrypted the same plaintexts.

`vault-node.mjs dec` then had Node decrypt three sets under each key: the Rust ciphertexts, Node's own, and those of
another key (a wrong key). It added 39 broken values made from a real one: cut short at four places, a flipped
character in the IV, the tag or the ciphertext, IVs of 0, 4, 12, 128, 129, 200 and 1000 bytes, tags of 0, 4, 12, 15,
17 and 32 bytes, base64 that is URL-safe, unpadded or spaced, `!!` inside it, `enc:v1:`, `enc:v1:abc`, `enc:v1:a:b:c`,
`enc:v1:a:b:c:d`, `ENC:V1:...`, `enc:v2:...`, a leading space, and non-ASCII. For each value it recorded the outcome
of `decrypt` and `decryptIfEncrypted` (the text, or the error message). Rust ran the same calls and compared:

```
node_dec_1 (k)            same 60, differ 0      node_dec_7 (fixture key)  same 60, differ 0
node_dec_2 (305 chars)    same 60, differ 0      node_dec_8 (no key)       same 60, differ 0
node_dec_3 (non-ASCII)    same 60, differ 0      node_dec_9 ("   ")        same 60, differ 0
node_dec_4 (padded)       same 60, differ 0
node_dec_5 (U+FEFF key)   same 40, differ 20     node_dec_6 (U+0085 key)   same 40, differ 20   -> finding 1
```

Apart from keys 5 and 6, every Node ciphertext decrypts in Rust and every Rust ciphertext decrypts in Node. Each
broken value fails with the same message on both sides. The corpora of `isSecretKey`, `encryptSecretFields` (by
shape), `decryptSecretFields`, `redactSecretFields`, `encryptIfSecret` and `isEncryptionEnabled` are identical. The
masks are identical except where a cut falls inside an emoji: Node gives `"abc\uD83D...hijk"`, Rust `"abc...hijk"`.
That is difference 4 of the report.

By source: the key derivation is PBKDF2-HMAC-SHA512 with salt `tarsee-vault-v1`, 100,000 iterations and 32 bytes,
derived once per App. Each value gets a random 16-byte IV (`rand::rng()`, ChaCha12 ThreadRng, a CSPRNG). The tag is
16 bytes and the base64 is padded. Every key comes from `app.config().encryption_key`; no code reads the real
environment.

**Sign-ins, both ways.** `auth-node.mjs make` ran the Node `initDb` and `initSessionStore` on a new state folder
that already held an unhashed id of an older version. Node hashed that id and then made two sign-ins with
`createSession`, one from an address and one with `undefined`, which Node stores as `ip` NULL. Rust opened a copy of
that state folder, ran its migrations and `SessionStore::init`, and gave:

```
restored 3
oldId:  live true cookie true ws true auth {"authenticated":true,"method":"session","sessionId":"<id>"}
withIp: live true cookie true ws true auth {"authenticated":true,"method":"session","sessionId":"<id>"}
noIp:   live true cookie true ws true auth {"authenticated":true,"method":"session","sessionId":"<id>"}
node api token accepted: true
```

Rust then made two sign-ins of its own. The rows are `sha256:<hex>` with an integer `created_at`, the same as Node's.
`auth-node.mjs read` ran Node on Rust's folder:
`[auth] session store ready — 5 session(s) restored from disk` and
`live/viaCookie/ws` true for both Rust sign-ins and both Node ones.

**Express `req.ip` (trust proxy 1) and the Rust `client_ip` through a real socket.** Rust ran an axum server with
`into_make_service_with_connect_info` and was sent raw HTTP/1.1 requests. Node ran an Express app. Both got the same
18 `X-Forwarded-For` cases: none; one hop; two and three hops (forged first hops); no spaces; spaces and tabs around
the hops; empty hops; `""`; `" , ,"`; two header lines; `unknown`; text that is not an address. All 18 gave the same
address. A forged first hop never changes the key; only the last hop counts.

**Login, lockout, CSRF, headers in Node.** Four wrong PINs behind `10.0.0.x, 203.0.113.50` each got 401
`{"error":"Invalid password"}`. The fifth attempt, with the right PIN, got 429
`{"error":"Locked out. Try again in 30s."}` and `Retry-After: 30`. A different last hop got 200 and
`tarsee_session=<64 hex>; Max-Age=34560000; Path=/; Expires=...; HttpOnly; SameSite=Strict`. CSRF: no token 403
`CSRF token missing`; good 200; short signature 500 `{"error":"Internal server error","detail":"Input buffers must
have the same byte length"}`; header sent twice 500; `bearer` in lower case 403. These are the statuses, bodies and
lines the Rust tests assert (`auth_routes.rs`, `security.rs`). The six security header values Node sent appear
verbatim in `security.rs`'s byte-for-byte test, which passes. The CSRF cookie Node signed verifies in Rust (`Ok(true)`).
A Rust-signed token passes Node's `csrfProtect` (`next`); the same token with its last digit changed gets 403.

**The Node bugs the report says were ported as they are** (it lists nine). These are really Node behaviour, checked
by running Node: (1) a short CSRF signature is a 500; (2) with no address, four failures are filed under `undefined`
and the fifth attempt still gets through (`["next"]`); (3) `validateToolInput("write_file", { filename: 5 | true |
{} })` throws `input.filename.includes is not a function`, and `tools.js:860-895` catches that around both checks;
(4) `http://[::ffff:127.0.0.1]/` gives hostname `[::ffff:7f00:1]` and `{"allowed":true}`, while `10.example.com` is
refused; (5) `résudo` and `pre-sudo-post` are flagged. Bugs (6) to (9) were checked against the source and are as
described.

**Suite.** `cargo test`: `1123 passed` (unit) and `57 passed` (integration), no failures.

## Findings

### 1. `ENCRYPTION_KEY` is trimmed with Rust's whitespace, not JavaScript's: Node's secrets cannot be read back

- **Severity:** Important. The cause is outside this package, in the foundation's `Env::trimmed`, but B1's vault
  inherits it.
- **Node:** `src/config/env.js:172` `process.env.ENCRYPTION_KEY?.trim() || null`. JavaScript's `trim` removes
  U+FEFF and keeps U+0085.
- **Rust:** `src/config/env.rs:105` `env.trimmed("ENCRYPTION_KEY")` → `src/env.rs:45-53` `value.trim()`. Rust's
  `trim` keeps U+FEFF and removes U+0085.
- **What differs:** a key that begins or ends with U+FEFF (a byte-order mark) gives Rust a different PBKDF2 input
  than it gave Node. So does a key that begins or ends with U+0085. A BOM is the likely case: for example
  `ENCRYPTION_KEY=$(cat key.txt)` on a file written by Windows PowerShell 5.1, whose UTF-8 output starts with one.
  After the upgrade every stored secret fails with "Unsupported state or unable to authenticate data". In settings,
  `decrypt_secret_fields` blanks each field, so channels and AI providers lose their tokens. `get_key` fails for
  every vault key.
- **The same cause elsewhere:** `SETUP_PASSWORD` (`env.js:143` / `env.rs:103`) is read the same way. A PIN set with a
  BOM signs in under Node and is refused under Rust, and each refusal counts toward the lockout. So are
  `TARSEE_API_TOKEN` (`env.js:148` / `env.rs:214`) and the `api.token` file (`env.js:153` / `env.rs:218`). The
  other `trimmed` settings are paths and names. The CSRF secret is not affected: it hashes the raw value in both
  versions.
- **How confirmed:** by running both, as above. Key 5 is `"\uFEFFbom-key"` and key 6 is `"nel-key\u0085"`. In
  `rust_report_1.txt` all 7 Node values fail in Rust, and so does the structured setting (all its secret fields come
  back `""`). In `node_dec_5`/`node_dec_6` all 7 Rust values fail in Node. For every other key, both directions
  match. A fix is to make `Env::trimmed` trim as JavaScript does. B1's `middleware::auth::js_trim` already does.

### 2. `AuditLog::log` panics on a closed database; Node caught and logged

- **Severity:** Minor. Node closes the database only after `server.close()` and exits straight away
  (`server.js:475-479`), so in practice this is not reached.
- **Node:** `src/db/audit.js:29-41`. The insert is in `try/catch` ("Audit logging should never crash the app").
- **Rust:** `src/db/audit.rs:81-102`. `self.db.with(...)` goes through `Db::with`, which
  `expect("the database is closed")`s (`src/db/mod.rs:76-81`), so the panic happens before the `Err` branch can
  log. `query` and `count` (`audit.rs:106`, `121`) do the same. `SessionStore` guards against this with
  `Db::is_open` (`auth.rs:502-504`); `AuditLog` does not.
- **How confirmed:** Node `new AuditLog(db); db.close(); log(...)` printed
  `[audit] failed to write log: The database connection is not open` and returned. In Rust, `AuditLog::init`,
  `t.db().close()`, then `audit.log(...)` inside `catch_unwind` reported `panicked: true`.

### 3. No test pins the `credential` alternative of the secret-field pattern

- **Severity:** Minor. This is a gap in the tests, not in the code: the pattern itself matches Node (my corpus had
  `"Credentials": "c"`, encrypted on both sides).
- **Node:** `src/lib/vault.js:151`. **Rust:** `src/lib/vault.rs:267-269`; tests `vault.rs:843-888`, `913-950`.
- **What differs:** in the tests, every string-valued field is also matched by another alternative (`token`,
  `password`, `secret`, `apikey`, `api_key`, `passphrase`). `credential` appears only with `null`, an array or an
  object as its value. Dropping `credential|` from the pattern would leave every test green, and a field such as
  `credentials: "<token>"` would then be stored in plain text. The report says every single-line break of the
  ported files makes a test fail; this one does not. Shown from the source: I did not change the file to prove it.
  One string-valued `credential` field in `encrypt_secret_fields_touches_only_credential_strings` closes the gap.

## Completeness

Every export of the nine Node files has its Rust counterpart, under the names the report gives. These are:
`vault.js` 11 exports; `key-vault.js` 6; `security-manager.js` the class and its 8 methods, plus
`getSecurityManager`; `security.js` 3; `auth.js` 17; `auth-routes.js` `authRouter`; `audit.js` `AuditLog` (`log`,
`query`, `count`); `loop-guard.js` `createLoopGuard`; `agent-env.js` 3.

Node test cases, counted from the test files: `vault.test.js` 13, `auth.test.js` 8, `auth-timers.test.js` 3,
`loop-guard.test.js` 4, `agent-vault-env.test.js` 4, `agent-vault-env-cache.test.js` 4. That is 36, and each one has
a Rust test with the same name in snake_case. The three that changed shape (null arguments; the captured
`setInterval` callbacks) are listed in the report, and the reasons hold. The Rust assertions are the Node ones or
stronger: the tamper test checks the exact message where Node accepted any of three words, and session destruction
is now checked rather than only run. In all, the package's files hold 146 tests.

The rules of the port hold, apart from finding 2:

- No global mutable state. The sessions, attempts, CSRF secret, derived key, security manager and agent-env cache
  are App services.
- No `std::env`.
- Every `expect` outside tests is on a regex literal, an HMAC key or an AES length that cannot fail, or on the
  test-only `Clock::advance`/`set`.
- Log lines and error texts keep the Node words.
- The Node comments are carried over.

The differences the report lists were checked against what I ran and the source, and none is weaker than Node. Two
were seen directly: `application/json` without `; charset=utf-8`, and the emoji in `mask_secret`.

COMPLETE: yes
FAITHFUL: no (finding 1. Its cause is in the foundation's `Env::trimmed`, not in B1's files. B1's own code has no
Critical or Important finding.)
