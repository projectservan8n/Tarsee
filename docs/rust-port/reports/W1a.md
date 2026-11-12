# W1a: a Rust harness for the browser files, and the port of their unit tests

A new integration test binary, `ui` (`tests/ui/`), runs the browser files of `src/public/` in a real headless
browser and checks the rest of them as text. Nothing under `src/public/` was changed.

## Files

| What | Where |
|---|---|
| The test binary | `tests/ui/main.rs`, declared in `Cargo.toml` as `[[test]] name = "ui"` next to `it` |
| Finding and starting the browser, the shared runtime | `tests/ui/support/browser.rs` |
| The test site (axum, loopback, port chosen by the system) | `tests/ui/support/site.rs` |
| A test's tab: the API tests use | `tests/ui/support/page.rs` |
| Reading the browser files and repository files | `tests/ui/support/files.rs` |
| Keeps the browser from outliving the tests | `testbin/browser_guard.rs` (new `tarsee-testbin` role `browser-guard`, one line in `testbin/main.rs`) |
| Ports of the Node tests | `tests/ui/<name>.rs`, one per Node file (`test/chat-core.test.js` is `chat_core.rs`) |
| Tests of the harness itself | `tests/ui/harness.rs` |

### How it works

- **One browser for the binary.** Found as asked: `TARSEE_CHROMIUM_PATH` (the one variable the binary reads from the
  real environment, said so in a comment), else Playwright's Chromium (newest revision, then its headless shell;
  `~/AppData/Local`, `~/.cache`, `~/Library/Caches`, and `/ms-playwright` in Playwright's Docker image), else the
  system's Chrome, Chromium or Edge on Windows, Linux and macOS. None found: every test that needs it **fails** with
  what to do (install Playwright's Chromium, install a browser, or set `TARSEE_CHROMIUM_PATH`) and the paths looked
  at. A program that is not a browser fails with its exit code and its last lines of output. The tests that read
  files as text still run.
- **chromiumoxide works**, so no client of my own: `Browser::connect` to the address the browser writes in its
  profile (`DevToolsActivePort`, with `--remote-debugging-port=0`). Its connection runs on a shared multi-thread
  runtime kept in a static; each test runs on its own `#[tokio::test]` runtime and talks to it through
  chromiumoxide's channels (runtime-independent; its timers are `futures_timer`). Three things in chromiumoxide
  needed care, all handled in `page.rs`: `new_page` can wait for ever (no limit once the target is set up), so every
  call into the browser has a 30 s limit of its own; an event reaches a listener a little after the answer to the
  next command, so `take_errors` and dropping a page make one round trip first; and input to a tab hidden behind
  another in its window waits for ever, so every tab has a window of its own with focus emulation on.
- **The browser never outlives the tests.** Statics are never dropped, so nothing in the test binary runs when it
  ends. The browser is started by `tarsee-testbin browser-guard`, whose stdin the test binary holds open: when the
  binary ends, however it ends (done, a panic, killed), the guard sees its stdin close, stops the browser and every
  process it started (`taskkill /T /F` on Windows; `TERM`, then `KILL` on Unix), and removes the run folder (profile
  and browser log, under `TARSEE_TEST_TMP`, so inside `target/`). `guard.lock` is removed last and held locked while
  the guard runs, so a folder whose guard was stopped half way is removed by the next run. Checked by hand on this
  machine: after a normal end and after the test binary was killed mid-run (twice), no browser process and no folder
  were left (a run with failing tests ends the process the same way as a passing one). Once, with the CPU at 100%, a
  profile folder outlived the guard's first removal deadline (15 s); it now tries for a minute, and anything still
  held then stays with its unlocked `guard.lock` for the next run to remove. Two test runs at once (each with its own
  browser and folder) were checked not to disturb each other.
- **The browser's command line:** headless; `--no-sandbox` (Playwright's default: the sandbox refused to start
  Playwright's Chromium from this machine's folder, and cannot start as root in a container); background throttling
  off; `--lang=en-US`; `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1`, so no page
  can reach the network (tested); `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` for the voice
  call tests to come (tested: `getUserMedia` gives a live fake track).
- **Isolation and speed.** `Page::open(url)` and `Page::blank()` give a browser context of the test's own (cookies,
  storage, cache, permissions), disposed when the page is dropped. A new context costs the browser a new process,
  about 0.1 s, and the browser makes them one at a time (measured: 8 at once took 0.9 s). The tests of the browser
  files only need a fresh page, so `Page::with_scripts` takes a tab from a pool in one shared context: between tests
  a tab's page is left (its scripts, timers and workers end), its site's localStorage and sessionStorage are cleared,
  and its clock is set back to UTC. That took the suite from 24 s to under 8 s on a quiet machine. Pooled pages share
  that context's cookies and permissions; the doc comment says a test that sets either uses `Page::open`.
- **Determinism.** Every tab's clock is UTC and its language en-US (`Emulation.setTimezoneOverride`,
  `setLocaleOverride`), whatever the machine's. No fixed sleeps: `wait_for` polls a JavaScript predicate every
  20 ms for at most 10 s and says what it waited for; element steps wait for their element.
- **Errors.** Every page collects `console.error`/`console.assert`, uncaught exceptions, unhandled rejections and the
  browser's own error lines (a 404 script). Each step checks first that none came since the last, and dropping the
  page checks once more after a round trip: an error fails the test with the page's own words. A test that expects
  errors says so (`allow_errors()`) before the step that brings them, then takes them (`take_errors().await`) and
  asserts on them. (An error that comes on its own time, like a refused request's answer, can reach the next step's
  check before the test takes it: the brand-icon 401 case failed once that way under load until it said so first.)

## Tests

| Node file | Cases | Ported | Not ported yet, and why |
|---|---|---|---|
| `test/chat-core.test.js` | 35 | 35 | |
| `test/usage-core.test.js` | 12 | 12 | |
| `test/channel-guides-core.test.js` | 7 | 7 | |
| `test/dialogs.test.js` | 21 | 21 | |
| `test/provider-guides-core.test.js` | 21 | 20 (2 in part) | see below: A1 (registry), R2 (`routes/ai.js`) |
| `test/model-picker-core.test.js` | 27 | 3 (1 in part) | 24 need the server's lists: packages A1 and A4, see below |
| `test/ai-settings-ui.test.js` | 9 | 9 | (no browser: files read as text) |
| `test/no-native-dialogs.test.js` | 6 | 6 | (no browser: the scanner ported to Rust) |
| `test/brand-icon.test.js`, "TarseeBrand on the page" | 3 | 3 | the rest of that file is the server's (B2) |
| **Total** | **141** | **116** | 25 cases wait for A1/A4; 3 ported cases have one assertion each waiting |

Plus 23 tests of the harness itself (`tests/ui/harness.rs`). Whole suite: 235 passed, 0 failed.

**To finish after package A1** (the provider registry, `src/ai/provider_registry.rs`; and `buildPicker`,
`src/lib/model_picker.rs`):

- provider-guides: "each kind matches the registry's: a plan sign-in, an API key, or a server you run" (not ported);
  in "every provider the registry knows, plans first, …" the second assertion (sorted ids equal `PROVIDER_IDS`).
- model-picker, cases on `PICKER` (built by `buildPicker` from a catalog in the test): "a family's word is its newest;
  an id is itself; a date or [1m] makes no difference", "the check goes on the chat's model, whether it was saved as
  the word or the id", "a pick saves the model's exact id, the newest and an older one alike", "nothing of the chat's
  own: the defaults, Sonnet at Medium", "the chat's own model and level, Extra for xhigh", "a level the model does not
  have becomes the nearest one below; no levels, no level", "the five levels Claude Code shows, Medium Recommended
  only where the CLI says so", "1 to 4 pick the models on top while the menu is open; other keys do not", "the
  Claude-only list knows no other AI: a bare model is the chat's own, as always"; and in "a model the list does not
  have is named from its id" the assertion `modelName(PICKER, "claude-opus-6")` (the other two are ported).

**To finish after packages A1 and A4** (`getModelGroups`, `src/lib/model_catalog.rs`, over the registry's
`setCatalogModels`): "the groups the server sent, the default AI first", "a ref finds its model on its AI; a bare model
looks on the default AI first", "a pick saves the model's ref, its AI included; the check goes on that AI's row only",
"the button: the chat's AI and model, its level clamped to the ones the model has", "a chat whose AI is gone: a
warning, and the default shown", "search finds models on every AI by name, id or AI, pickable ones first", "badges,
the note on Codex models and on rows that need verifying", "the model a turn ran on (its route): the list's name for
it, else the name the turn gave", "number keys count the pickable rows on top, across the AIs", "the Claude plan is the
default: the chat's own model and level, as before", "an Anthropic key is the default (the plan not signed in): the same
model, on the key", "another AI is the default: its default model runs, and the button says why", "a pick that names
its AI is the chat's own, whatever the default", "a chat whose AI is gone runs the default model at its own level, and
the button says so", "the plan warns about its weekly allowance; an API key, billed per use, has none to warn about".
The way to port them: build the list with the Rust function, `serde_json::to_value` it, and pass it to the page
(`page.call("ModelPickerCore.entryFor", json!([list, "opus"]))`).

**To finish after package R2:** in "every key provider's guide and card, and the docs, say a command the agent runs can
still read the key", the two assertions on `src/routes/ai.js` (its `notesFor` says it; it promises nothing more) are to
be made on `src/routes/ai.rs`. The guides' and `docs/providers.md`'s assertions are ported.

Every ported test passed on its first run, so I broke the browser files once (in the worktree, never committed:
a label in each `*-core.js`, `SETTLE_MS` and a default title in `dialogs.js`, `Home` and `pickChange` in
`model-picker-core.js`, the event name in `brand-icon.js`, an id in `index.html`, an `alert(` in `usage.js`): 19
tests failed, at least one in every ported file, each with a message naming what broke; `git checkout src/public`
restored them. The harness's own error detection is shown failing by its `should_panic` tests.

## Differences from the Node tests

Where a Node test faked the browser by hand, the real browser stands in, with the same inputs and assertions:

- **dialogs, "with no page to ask on …":** "no page" is a dedicated worker (no window, no document: the same branch the
  Node test reached) and, in addition, a page whose body was removed (the `!document.body` branch).
- **dialogs, "back to what had it …":** the nodes are real buttons, on the page or not (`isConnected`), with the same
  `byId` and `back` arguments; which one `focusBack` returned is compared by a name each carries.
- **dialogs, "one at a time":** each scenario runs in the page and returns what it saw at each point; the assertions
  are in Rust.
- **brand-icon page:** the stand-in page is served by a site of the test's own whose GET /api/settings/brand-icon
  answers as the case says (and counts the requests, as the Node fake `fetch` did). The Node page was at
  `https://app.example` with a picture at `https://app.example/icon-32.png?v=old`; here the page's own origin stands
  where `https://app.example` stood. In the 401 case the browser itself logs the refused request; the test takes that
  one error.
- **`undefined`:** values come back as JSON, so `undefined` reads as `null`; where a Node case asserted `null` or
  `undefined` strictly, the test asks the page (`is_null`, `is_undefined`, `typeof`). Negative zero comes back as
  `-0.0`, unequal to `0`, as in Node's strict assertions.
- **no-native-dialogs:** positions are byte offsets instead of UTF-16 units (a blanked character becomes as many
  spaces as it has bytes), so lines and comparisons are the same; JavaScript's `\s` and ASCII `\w`/`\b` are kept
  (`js_space`, `[A-Za-z0-9_$]`, and an ASCII lookbehind where fancy-regex has no `(?-u:\b)`).

## Looks like a bug in the Node code

- `test/no-native-dialogs.test.js`, `htmlCode`: the `javascript:` link regex is case-insensitive, but the offset is
  found with `a[0].indexOf("javascript:")`, which is -1 for `JAVASCRIPT:`, so such a link's code is copied to 10
  characters after the start of the attribute's match instead of just after `JAVASCRIPT:`. Ported as it is (it only
  affects where the guard keeps that link's code).

## Dependencies added

None. The harness uses `chromiumoxide`, `axum`, `tower-http` (`ServeDir`), `tokio`, `futures`, `regex`,
`fancy-regex`, `chrono`, `tempfile` and `serde_json`, all already there.

## Changes outside this package

- `Cargo.toml`: the `[[test]] name = "ui"` entry.
- `testbin/browser_guard.rs` and its line in `testbin/main.rs` (a new role, as PLAN.md allows). It is a helper rather
  than a stand-in for a program Tarsee starts; `testbin/main.rs`'s header still says "stand-ins", which the lead may
  want to widen.

## Risks, and what to look at first

1. **Only run on Windows here.** The Linux and macOS paths (browser locations, the guard's `kill -TERM`/`KILL`,
   Playwright's folder names) are written but not run. CI on Linux needs a browser: Playwright's Chromium
   (`npx playwright install --with-deps chromium`) or a distribution's `chromium`, else every browser test fails
   with the instructions.
2. **Speed depends on the machine.** `cargo test --test ui` (139 tests) took 14 to 20 s in the final runs (three in a
   row, then ten in a row, all passing) while the other agents' builds held this machine's CPU at 100% throughout; at a
   quieter moment, before tabs had windows of their own, it took 6 to 8 s. A flaky test found on the way (the brand-icon
   401 case, once in about fifteen runs under load) is fixed; nothing failed in the ten runs after.
3. **The tab pool** shares one context's cookies and permissions between concurrent `with_scripts` tests (storage is
   cleared between tests, not isolated during them). Fine for the browser files' unit tests; end-to-end tests must use
   `Page::open`.
4. **chromiumoxide 0.9.1** behaves in ways the harness works around (above). A newer release may change them; the
   harness tests (`tests/ui/harness.rs`) are what would catch it.
5. `--no-sandbox`: the pages are this repository's files and the network is closed, as with Playwright's default.

## For the end-to-end tests to come

The API was shaped for them: `Page::open(url)` takes any address (a running Rust server on loopback included: start
it on a port of its own and open its base URL); `cookie`/`set_cookie` (HttpOnly too); `set_files` for uploads;
`grant(&["microphone"])` with the browser's fake microphone; `click` and `press` send real input events (trusted,
with modifiers: `"Shift+Tab"`); `type_text` inserts text as an input method does; `Site::start(router)` serves
stand-in routes in front of the browser files; `cdp()` reaches any DevTools Protocol command the API lacks;
`allow_errors()` for a page expected to complain. The fake microphone gives a steady tone; a test that needs a
particular recording would need `--use-file-for-fake-audio-capture`, which is browser-wide (one browser per binary),
so it would go in its own test binary or become the default file.

## How to write a UI test

A test of a browser file goes in `tests/ui/<file>.rs` (and a `mod` line in `tests/ui/main.rs`). Open a page that
loads the file, call its functions with JSON arguments, and assert in Rust:

```rust
use serde_json::json;

use crate::support::{Page, Site};

#[tokio::test]
async fn the_tabs_title() {
    // A blank page of the test site that loads src/public/js/chat-core.js (a pooled tab: fast).
    let page = Page::with_scripts(&["chat-core.js"]).await;

    // A function on the page, called with JSON arguments; what it returns comes back as serde_json::Value.
    assert_eq!(page.call("ChatCore.pageTitle", json!(["#ask-agent", "Tarsee"])).await, "#ask-agent · Tarsee");

    // An argument JSON cannot carry (a Set, undefined, a function): write the call in JavaScript.
    let groups = page
        .apply("(now) => ChatCore.groupChats([], { now, working: new Set() })", json!([1_700_000_000_000i64]))
        .await;
    assert_eq!(groups[0]["id"], "web");

    // Any expression; a promise is awaited. `undefined` reads as null: ask the page when it matters.
    assert!(page.is_undefined("window.notThere").await);
}

#[tokio::test]
async fn a_page_with_markup_and_a_server_route() {
    // Routes of the test's own, in front of the browser files, on a site (an origin) of its own.
    let site = Site::start(axum::Router::new().route(
        "/api/thing",
        axum::routing::get(|| async { axum::Json(json!({ "ok": true })) }),
    ));
    // A page of its own (its own browser context: cookies, storage, permissions), closed when dropped.
    let page = Page::open(&site.page(r#"<button id="go">Go</button><p id="out"></p>
        <script>document.getElementById("go").onclick = async () => {
          document.getElementById("out").textContent = JSON.stringify(await (await fetch("/api/thing")).json());
        };</script>"#))
        .await;
    page.click("#go").await;                                   // a real click; waits for the element
    page.wait_for("document.getElementById('out').textContent", "the answer").await;   // polls, 10 s at most
    assert_eq!(page.text("#out").await, r#"{"ok":true}"#);
    // Any console.error, uncaught exception or failed load would have failed the test by now.
}
```

A test that reads files without a browser is a plain `#[test]` using `support::files::read_public("index.html")`
or `read_repo("docs/providers.md")`.
