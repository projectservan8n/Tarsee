# A1 review: AI provider registry

Reviewed on `rust-rewrite` at 96f4ac4 (A1 merged as 92f9739). Node files are the ones in the same tree (identical to
the main checkout's).

## How it was checked

- **Run side by side.** A Node script called every export of the five files and the key lookup of
  `db/settings.js` (`SettingsStore.prototype.getKeyWithSource` on a plain store, with `process.env` set per case). A
  throwaway Rust test (since removed) made the same calls and compared the answers as JSON, key order included,
  numbers by value. **215,543 answers** were compared:
  - **Registry, 140,082 answers.** Twelve settings and catalog scenarios: empty; verified maps as objects and as JSON
    text; lenient catalog rows; OpenRouter defaults by Google, OpenAI, Anthropic, xAI and one not yet verified;
    Local AI with a claude-* model; hidden providers. 22 provider spellings and 90 model names went through every
    lookup that takes them, and the table itself was compared field by field (hosts, key patterns, wrong-slot
    patterns and messages, probes, hints, tiers, models, `AI_PROVIDERS`).
  - **Keys, 11,336 answers.** `getKeyWithSource` over 17 ids, 19 saved values, 7 environment values and `envName`
    undefined, null, "", a name and another provider's name. Also the slot, `isAiKeySlot` and `isEmptySetting`.
  - **Model refs, 89 answers.**
  - **Engine errors, 54,737 answers.** About 90 provider error texts × 11 provider ids × statuses × codes, plus
    `friendly` for every kind, `authMessage`, `statusFromMessage` and `localNoResponsesMessage`.
  - **Picker, 1,267 answers.** 672 whole `buildPicker` lists, over 7 catalogs (the Node test's, a newer one, one
    with no main section, an odd one) × 4 known-id lists × 3 alias sets × 4 default efforts. Also the clamp, rows,
    labels, prices, tiers, `familyOf`, `nameFromSlug`, `matchModels`, `jsLiteralToJson`, `literalEnd` and
    `catalogFromBuildText`.
  - **OpenRouter, 44 answers.** The fixture parsed at two dates; 22 odd rows; bodies that are not lists;
    `priceLabel`; search; the three picker sections with four verified maps and three queries; the cache a refresh
    writes.
- **Everything matched** except the findings below and the two differences the A1 report already lists (#4: a model
  id spelled like an `Object.prototype` member, "constructor"/"toString"; #5: a build `issued_at` like "Oct 23 2026").
- **Test cases were counted from the files.**
  - registry: 89, 80 ported;
  - engine-errors: 22, all ported;
  - model-ref: 14, all ported;
  - openrouter-catalog: 31, all ported;
  - model-picker: 25, 14 ported.
  - That is **181 cases, 161 ported, 20 unported**, as the report says.
- **Every reason for an unported case holds.** The 6 model-catalog cases and the 5 route, turn and command cases need
  A4, R1, G3, K1 and S1, which are still one-line stubs here. Of the 9 registry cases, the session-handle case needs
  A3, whose `session_handle.rs` is still a stub, and the other 8 test Node-only mechanisms.
- **Every export of the five files and the key lookup has its Rust counterpart.**
- **The suite was run once.** `cargo test` passed: 1376 unit tests, 139 integration tests and 58 in another binary,
  with 0 failures.

## Findings

### 1. An OpenRouter refresh stops when its last caller is dropped, and the next caller gets that stale failure

- **Severity:** Important.
- **Node:** `src/lib/openrouter-catalog.js:193-214`.
  - `_inflight` is a promise that runs to its end on its own, writes the cache and feeds the registry, whoever waits
    for it.
  - `stop()` (`:240`) only clears the interval.
- **Rust:** `src/lib/openrouter_catalog.rs:459-470`, `:528` and `:776-779`.
  - The fetch is a `Shared` future kept in `inflight`. It makes progress only while some caller awaits it.
  - `inflight` is cleared only when it finishes (`:528`).
  - `CatalogHandle::stop()` aborts the timer task (`:778`). A timer refresh running at that moment is dropped
    with it.
- **Input:**
  1. A forced refresh whose request hangs (timeout 300 ms). Its only caller is dropped after 50 ms, as axum drops a
     handler when the browser goes away (Node's caller is `routes/ai.js:609`, Settings > AI).
  2. One second later OpenRouter answers, and the refresh is asked for again.
- **Node:** the second refresh gives `source: "network"`, 1 model, from one new request.
- **Rust:** the second refresh gives `source: "none"`, error "Tarsee couldn't reach OpenRouter for its model list (it
  took too long to answer).", 0 models.
  - It is answered in 91 µs.
  - No new request is sent: the paused old one is resumed, and its timeout has already passed.
  - Only a third refresh fetches the list.
- **Two more effects of the same cause:**
  - A list the dropped request had already received is never applied or cached until someone resumes it.
  - When it is resumed, it writes the old caller's `fetchedAt`.
- **Not affected:** the boot refresh (`:807` spawns it).
- **What the port needs:** the in-flight fetch must run independently, for example spawned as a task whose result the
  callers share. Then a dropped caller or `stop()` cannot pause it.

### 2. A Claude model name with U+0085 at its edge resolves to another model

- **Severity:** Minor (the input is not realistic, but the answer is a different model).
- **Node:** `src/ai/provider-registry.js:805-816`, which calls `config/constants.js:79-82`. `resolveModelAlias` does
  `toLowerCase().trim()`, and JavaScript's `trim` keeps U+0085.
- **Rust:** `src/ai/provider_registry.rs:1766-1784`, which calls `src/config/constants.rs:118`. `resolve_model_alias`
  uses `str::trim`, which removes U+0085.
- **Input:** `resolveModelFor("claude" | "anthropic" | "claude-code", "opus\u0085")` and `"\u0085haiku"`.
- **Node:** `"sonnet"` (an unknown name falls back to the recommended model).
- **Rust:** `"opus"` / `"haiku"`.
- **About the A1 report:** it says ("Changes needed outside this package", item 3) that A1 calls these foundation
  helpers only with text it has already trimmed. That does not make them equivalent: `js_trim` leaves U+0085 in
  place, and the foundation's `str::trim` then removes it.
- **Where the fix goes:** `constants.rs` (`resolve_model_alias` and `tier_of` should use `util::js::trim`).

### 3. The cached OpenRouter list is not byte-identical: Rust writes `0.0` where Node writes `0`

- **Severity:** Minor.
- **Node:** `src/lib/openrouter-catalog.js:296-298` stores `{ fetchedAt, models }`, which the store writes with
  `JSON.stringify`.
- **Rust:** `src/lib/openrouter_catalog.rs:857-862` stores a `Value` whose prices are `f64`.
- **Input:** a refresh of the fixture at 2026-11-12. The text below is what the store would write with `serde_json`.
- **Node:** `"price":{"in":0,"out":0,"cacheRead":0,"cacheWrite":0}`, 13,042 bytes in all.
- **Rust:** `"price":{"in":0.0,"out":0.0,"cacheRead":0.0,"cacheWrite":0.0}`, 13,150 bytes in all.
- **What is the same:**
  - Structure, key order and every value are identical.
  - Rust reads Node's cache back whole: 36 rows of 36, equal, both as JSON text and as a parsed value.
  - Node's `JSON.parse` reads `0.0`.
- **What is not:** the stored text is identical only if S1 writes whole-valued floats as JavaScript does.

### 4. `priceHint` writes a price of 1e21 or more out in full

- **Severity:** Minor (no real price is that large).
- **Node:** `src/lib/model-picker.js:319`. From 1e21 up, `toFixed` gives the exponent form.
- **Rust:** `src/lib/model_picker.rs:1111` (`js_to_fixed`, documented "for a finite number below 1e21") and
  `usd` (`:859`).
- **Input:** `{ in: 1e-7, out: 1e21 }`.
- **Node:** `"$0.00 in · $1e+21 out per million tokens, est."`
- **Rust:** `"$0.00 in · $1000000000000000000000 out per million tokens, est."`

### 5. `Picker.fetched_at` is an `i64`, but Node's `fetchedAt` can be a fractional `mtimeMs`

- **Severity:** Minor.
- **Node:** `src/lib/model-catalog.js:147` falls back to `st.mtimeMs` (fractional on most filesystems) when the
  account's cache file has no `fetchedAt`, and passes it as `fetchedAt` (`:173`). `model-picker.js:187` sends it on
  in `picker.fetchedAt`.
- **Rust:** `src/lib/model_picker.rs:202` and `:388` (`fetched_at: Option<i64>`).
- **Input:** an account catalog file without `fetchedAt`, modified at 1731500000123.4567 ms.
- **Node:** sends `1731500000123.4567`.
- **Rust:** A4 can only hand over a whole number.
- **Impact:** nothing in `src/public/js` reads the field. The type is narrower than the value Node sends.

### 6. One picker assertion is looser than Node's

- **Severity:** Minor.
- **Node:** `test/model-picker.test.js:155`, `assert.equal(m[1].x, null)`. This fails if `x: void 0` is dropped
  (`undefined !== null`).
- **Rust:** `src/lib/model_picker/tests.rs:324`, `assert_eq!(m[1]["x"], Value::Null)`. Indexing a missing key gives
  `Null`, so this passes even if the key is dropped.
- **Impact:** small. `a_builds_literal_becomes_json_text` (`tests.rs:465`, `:475`) pins `void 0` → `null` in the text.
- **Fix:** `m[1].get("x") == Some(&Value::Null)`.

## Checked and found faithful

- **Table and hosts.**
  - Every base URL per engine, key pattern, wrong-slot pattern and message, env name, probe, hint, tier map,
    default model and context matches Node.
  - The `AI_PROVIDERS` JSON matches key for key.
  - No other Rust file holds a host constant.
- **Hidden Local AI.** `local_ai_hidden_here` reads `RAILWAY_PROJECT_ID`, then `TARSEE_LOCAL_AI_URL`, then
  `ai.local.baseUrl`, in Node's order and with Node's trimming (384 combinations). The registry reads no host for
  Local AI, as in Node; `engine_env::host_for` does that (A2).
- **Keys.** Three things match Node in every case run: `clean_key` (U+FEFF and U+0085, quotes), the wrong-slot checks
  with `(?i-u)`, and the `envName` cases (undefined, null and "").
  - Sign-in plans never take a key.
  - Unknown ids map to `<ID>_API_KEY`, with UTF-16 counting.
  - Numbers, arrays and objects stored in a slot become text as `String()` makes them.
  - No case read a variable Node would not read, and no case gave a key to another provider.
- **Engine errors.** Every classification and message matched, Kelvin sign and long s included.
- **Picker.** Every whole list matched Node byte for byte (the browser's `model-picker-core.js` reads these lists).
- **OpenRouter.** These matched Node: filtering, prices, `perMillion` rounding, retirement dates, reasoning levels,
  sections, row key order, search and sorting. Requests go through `app.fetch()`.
- **State.**
  - The runtime catalogs and hidden providers live in `ProviderRegistry::of(app)`, and the list in
    `OpenRouterCatalog::of(app)`, which feeds that same app's registry.
  - The package's statics are immutable tables.
  - Separate apps are tested separately (`each_app_has_a_registry_of_its_own`, `each_app_has_a_catalog_of_its_own`).
- **Port rules.** Checked by search:
  - no `std::env` read;
  - no `reqwest` client;
  - `expect` only on constant patterns and on a catalog name that cannot be wrong;
  - log lines and error texts keep Node's wording;
  - the Node comments are carried over.
- **Tests.** Spot checks of the registry and engine-error tests found Node's assertions ported at full strength. A
  separate read of all 31 OpenRouter cases and the 14 picker cases found only finding 6.

COMPLETE: yes
FAITHFUL: no
