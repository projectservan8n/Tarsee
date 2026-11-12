//! A browser tab for one test, in a browser context of its own (its own cookies, storage, cache and permissions),
//! so tests run in parallel without seeing each other. Closed when dropped.
//!
//! Every page watches for errors: `console.error` (and failed `console.assert`), uncaught exceptions and unhandled
//! promise rejections, and the browser's own error lines (a script or picture that failed to load). Each step a test
//! takes first checks that none came since the last, and so does dropping the page: a test that expects errors takes
//! them with [`Page::take_errors`] (and can then assert on them).

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chromiumoxide::cdp::browser_protocol::browser::{
    BrowserContextId, PermissionDescriptor, PermissionSetting, SetPermissionParams,
};
use chromiumoxide::cdp::browser_protocol::dom::SetFileInputFilesParams;
use chromiumoxide::cdp::browser_protocol::emulation::{SetLocaleOverrideParams, SetTimezoneOverrideParams};
use chromiumoxide::cdp::browser_protocol::input::{DispatchKeyEventParams, DispatchKeyEventType, InsertTextParams};
use chromiumoxide::cdp::browser_protocol::log::{EventEntryAdded, LogEntryLevel};
use chromiumoxide::cdp::browser_protocol::network::CookieParam;
use chromiumoxide::cdp::browser_protocol::target::{CreateBrowserContextParams, CreateTargetParams};
use chromiumoxide::cdp::js_protocol::runtime::{
    ConsoleApiCalledType, EvaluateParams, EventConsoleApiCalled, EventExceptionThrown, ExceptionDetails, RemoteObject,
};
use chromiumoxide::listeners::EventStream;
use futures::{FutureExt, StreamExt};
use serde_json::Value;

use super::browser::{self, Shared, runtime};
use super::site::Site;

/// How long a wait ([`Page::wait_for`], and finding an element) may take by default.
pub const WAIT_LIMIT: Duration = Duration::from_secs(10);

/// How often a wait looks again.
const POLL_EVERY: Duration = Duration::from_millis(20);

/// One test's tab.
pub struct Page {
    cdp: chromiumoxide::Page,
    context: Option<BrowserContextId>,
    shared: &'static Shared,
    events: Mutex<Events>,
}

struct Events {
    console: EventStream<EventConsoleApiCalled>,
    exceptions: EventStream<EventExceptionThrown>,
    log: EventStream<EventEntryAdded>,
    errors: Vec<String>,
}

impl Page {
    /// A blank page on the shared site that loads `scripts` in order (file names in `src/public/js/`, or paths from
    /// the site's root), the way `index.html` loads them.
    pub async fn with_scripts(scripts: &[&str]) -> Page {
        Page::open(&Site::shared().scripts_page(scripts, "")).await
    }

    /// A new tab at `url`: a page of the shared site, of a test's own [`Site`], or of a running server. Returns once
    /// the page has loaded (its scripts have run).
    pub async fn open(url: &str) -> Page {
        let page = Page::blank().await;
        page.goto(url).await;
        page
    }

    /// A new tab showing nothing (`about:blank`), in a browser context of its own. Its clock reads in UTC and its
    /// language is American English, whatever the machine's, so what a page writes is the same everywhere; change
    /// either with [`Page::set_timezone`] or through [`Page::cdp`].
    pub async fn blank() -> Page {
        let shared = browser::shared().await;
        let context = shared
            .browser
            .create_browser_context(CreateBrowserContextParams::default())
            .await
            .unwrap_or_else(|e| panic!("the browser could not make a context for the test: {e}"));
        let mut target = CreateTargetParams::new("about:blank");
        target.browser_context_id = Some(context.clone());
        let cdp = match shared.browser.new_page(target).await {
            Ok(cdp) => cdp,
            Err(e) => {
                dispose(shared, context);
                panic!("the browser could not open a tab for the test: {e}");
            }
        };
        let console = cdp.event_listener::<EventConsoleApiCalled>().await;
        let exceptions = cdp.event_listener::<EventExceptionThrown>().await;
        let log = cdp.event_listener::<EventEntryAdded>().await;
        let (Ok(console), Ok(exceptions), Ok(log)) = (console, exceptions, log) else {
            dispose(shared, context);
            panic!("the browser could not report the tab's errors");
        };
        let page = Page {
            cdp,
            context: Some(context),
            shared,
            events: Mutex::new(Events {
                console,
                exceptions,
                log,
                errors: Vec::new(),
            }),
        };
        page.set_timezone("UTC").await;
        page.command(
            SetLocaleOverrideParams::builder().locale("en-US").build(),
            "set the language",
        )
        .await;
        page
    }

    /// The chromiumoxide page under this one, for whatever this API does not cover (any DevTools Protocol command:
    /// `page.cdp().execute(params)`).
    pub fn cdp(&self) -> &chromiumoxide::Page {
        &self.cdp
    }

    /// Goes to `url` in this tab and waits until it has loaded.
    pub async fn goto(&self, url: &str) {
        self.check_errors();
        if let Err(e) = self.cdp.goto(url).await {
            panic!("could not open {url}: {e}");
        }
        self.wait_for("document.readyState === 'complete'", &format!("{url} to load"))
            .await;
    }

    /// The page's address now.
    pub async fn url(&self) -> String {
        self.eval("location.href")
            .await
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    /// The page's clock reads in `zone` (an IANA name such as `Asia/Manila`).
    pub async fn set_timezone(&self, zone: &str) {
        self.command(SetTimezoneOverrideParams::new(zone), "set the timezone")
            .await;
    }

    // ---------------------------------------------------------------- running JavaScript

    /// Runs a JavaScript expression in the page and gives its value as JSON (a promise is awaited first). `undefined`
    /// comes back as `null`: ask for `typeof x` to tell them apart. Panics if it throws, with what it threw.
    pub async fn eval(&self, expression: &str) -> Value {
        match self.try_eval(expression).await {
            Ok(value) => value,
            Err(thrown) => panic!("the page threw: {thrown}\n  running: {expression}"),
        }
    }

    /// [`Page::eval`], with what it threw (as the page describes it, stack included) as the error.
    pub async fn try_eval(&self, expression: &str) -> Result<Value, String> {
        self.check_errors();
        self.evaluate(expression).await
    }

    /// Calls the page's function at `path` (`ChatCore.chatName`) with `args` (a JSON array: each element one
    /// argument), as a method of what it is on, and gives what it returns (awaited if it is a promise).
    pub async fn call(&self, path: &str, args: Value) -> Value {
        self.eval(&format!("{path}(...{})", js_args(&args))).await
    }

    /// Calls a function written in JavaScript (`"(rows, now) => ChatCore.groupChats(rows, { now })"`) with `args`
    /// (a JSON array), for an argument JSON cannot carry (a `Set`, a function, `undefined`).
    pub async fn apply(&self, function: &str, args: Value) -> Value {
        self.eval(&format!("({function})(...{})", js_args(&args))).await
    }

    /// Whether the expression's value is exactly `null` (`eval` gives `null` for `undefined` too).
    pub async fn is_null(&self, expression: &str) -> bool {
        self.eval(&format!("({expression}) === null")).await == true
    }

    /// Whether the expression's value is `undefined` (`eval` gives `null` for it).
    pub async fn is_undefined(&self, expression: &str) -> bool {
        self.eval(&format!("({expression}) === undefined")).await == true
    }

    /// Waits until `predicate` (a JavaScript expression) is truthy, and gives its value. Looks again every 20 ms,
    /// for at most [`WAIT_LIMIT`]; `what` says what was being waited for if the time runs out.
    pub async fn wait_for(&self, predicate: &str, what: &str) -> Value {
        self.wait_for_within(predicate, WAIT_LIMIT, what).await
    }

    /// [`Page::wait_for`] with a time limit of its own.
    pub async fn wait_for_within(&self, predicate: &str, limit: Duration, what: &str) -> Value {
        self.check_errors();
        let deadline = Instant::now() + limit;
        loop {
            // (Asked anew each time, so a wait goes on across a navigation.)
            let last = match self.evaluate(predicate).await {
                Ok(value) if truthy(&value) => return value,
                Ok(value) => format!("it was {value}"),
                Err(thrown) => format!("it threw {thrown}"),
            };
            if Instant::now() >= deadline {
                panic!(
                    "timed out after {:.1}s waiting for {what}\n  predicate: {predicate}\n  last time: {last}",
                    limit.as_secs_f64()
                );
            }
            tokio::time::sleep(POLL_EVERY).await;
        }
    }

    // ---------------------------------------------------------------- elements

    /// Waits for an element matching `selector` (a CSS selector) to be on the page.
    pub async fn wait_for_element(&self, selector: &str) {
        let probe = format!("document.querySelector({}) !== null", js_string(selector));
        self.wait_for(&probe, &format!("an element matching {selector}")).await;
    }

    /// Whether an element matches `selector` now (no waiting).
    pub async fn exists(&self, selector: &str) -> bool {
        self.eval(&format!("document.querySelector({}) !== null", js_string(selector)))
            .await
            .as_bool()
            .unwrap_or(false)
    }

    /// The text of the first element matching `selector`, as a person sees it (`innerText`), once there is one.
    pub async fn text(&self, selector: &str) -> String {
        self.wait_for_element(selector).await;
        let value = self
            .eval(&format!("document.querySelector({}).innerText", js_string(selector)))
            .await;
        value.as_str().unwrap_or_default().to_string()
    }

    /// An attribute of the first element matching `selector`, once there is one (`None` when it has no such
    /// attribute).
    pub async fn attr(&self, selector: &str, name: &str) -> Option<String> {
        self.wait_for_element(selector).await;
        let value = self
            .eval(&format!(
                "document.querySelector({}).getAttribute({})",
                js_string(selector),
                js_string(name)
            ))
            .await;
        value.as_str().map(str::to_string)
    }

    /// Clicks the first element matching `selector` as a person does (the mouse pressed and let go at its middle,
    /// scrolled into view first), once there is one.
    pub async fn click(&self, selector: &str) {
        self.wait_for_element(selector).await;
        let element = self
            .cdp
            .find_element(selector)
            .await
            .unwrap_or_else(|e| panic!("could not find {selector} to click it: {e}"));
        if let Err(e) = element.click().await {
            panic!("could not click {selector}: {e}");
        }
    }

    /// Puts the focus in the first element matching `selector` and types `text` into it (as an input method does:
    /// the page hears `beforeinput` and `input`, not a key per letter; [`Page::press`] sends keys).
    pub async fn type_text(&self, selector: &str, text: &str) {
        self.wait_for_element(selector).await;
        self.eval(&format!("document.querySelector({}).focus()", js_string(selector)))
            .await;
        self.command(InsertTextParams::new(text), "type").await;
    }

    /// Presses a key on whatever has the focus: `"Enter"`, `"Escape"`, `"Tab"`, `"a"`, or with modifiers held,
    /// `"Shift+Tab"`, `"Control+a"` (the names of the key's `key` value on a US keyboard).
    pub async fn press(&self, keys: &str) {
        self.check_errors();
        let mut parts: Vec<&str> = keys.split('+').collect();
        // ("+" itself, or a combination ending in it.)
        let key = if keys.ends_with("++") || keys == "+" {
            parts.retain(|p| !p.is_empty());
            "+"
        } else {
            parts.pop().unwrap_or_default()
        };
        let mut modifiers = 0;
        for held in parts {
            modifiers |= match held {
                "Alt" => 1,
                "Control" | "Ctrl" => 2,
                "Meta" => 4,
                "Shift" => 8,
                other => panic!("no such modifier: {other} (in {keys})"),
            };
        }
        let def = chromiumoxide::keys::get_key_definition(key).unwrap_or_else(|| panic!("no such key: {key}"));
        let mut base = DispatchKeyEventParams::builder()
            .key(def.key)
            .code(def.code)
            .windows_virtual_key_code(def.key_code)
            .native_virtual_key_code(def.key_code)
            .modifiers(modifiers);
        // (As Puppeteer does: a key that writes something sends its text with the key going down.)
        let text = def.text.or((def.key.chars().count() == 1).then_some(def.key));
        let down = match text {
            Some(text) if modifiers & !8 == 0 => {
                base = base.text(text);
                DispatchKeyEventType::KeyDown
            }
            _ => DispatchKeyEventType::RawKeyDown,
        };
        let press = base.clone().r#type(down).build().expect("a key press");
        let release = base.r#type(DispatchKeyEventType::KeyUp).build().expect("a key release");
        self.command(press, "press a key").await;
        self.command(release, "let go of a key").await;
    }

    /// Chooses `files` in the file input matching `selector`, as a person picking them in the file dialog does.
    pub async fn set_files(&self, selector: &str, files: &[&Path]) {
        self.wait_for_element(selector).await;
        let element = self
            .cdp
            .find_element(selector)
            .await
            .unwrap_or_else(|e| panic!("could not find {selector}: {e}"));
        let paths = files
            .iter()
            .map(|f| f.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        let mut params = SetFileInputFilesParams::new(paths);
        params.backend_node_id = Some(element.backend_node_id);
        self.command(params, "choose files").await;
        // The page hears about it as it would from the dialog.
        self.eval(&format!(
            "document.querySelector({}).dispatchEvent(new Event('change', {{ bubbles: true }}))",
            js_string(selector)
        ))
        .await;
    }

    // ---------------------------------------------------------------- cookies and permissions

    /// The value of the cookie `name` that the page's address would be sent, if there is one.
    pub async fn cookie(&self, name: &str) -> Option<String> {
        self.check_errors();
        let cookies = self
            .cdp
            .get_cookies()
            .await
            .unwrap_or_else(|e| panic!("could not read the cookies: {e}"));
        cookies.into_iter().find(|c| c.name == name).map(|c| c.value)
    }

    /// Sets a cookie for the page's address (as a server's `Set-Cookie` would; `http_only` as the server sets it).
    pub async fn set_cookie(&self, name: &str, value: &str, http_only: bool) {
        self.check_errors();
        let mut cookie = CookieParam::new(name, value);
        cookie.url = Some(self.url().await);
        cookie.http_only = Some(http_only);
        if let Err(e) = self.cdp.set_cookie(cookie).await {
            panic!("could not set the cookie {name}: {e}");
        }
    }

    /// Allows the page's site the permissions named (as the Permissions API names them: `"microphone"`, `"camera"`,
    /// `"notifications"`), without asking. With the browser's fake devices, a microphone the page asks for then gives
    /// a steady tone.
    pub async fn grant(&self, permissions: &[&str]) {
        let origin = self.eval("location.origin").await;
        let origin = origin.as_str().unwrap_or_default().to_string();
        for name in permissions {
            let mut params = SetPermissionParams::new(PermissionDescriptor::new(*name), PermissionSetting::Granted);
            params.origin = Some(origin.clone());
            params.browser_context_id = self.context.clone();
            if let Err(e) = self.shared.browser.execute(params).await {
                panic!("could not allow {name} for {origin}: {e}");
            }
        }
    }

    // ---------------------------------------------------------------- errors

    /// The errors the page reported since they were last looked at, as text, and forgets them: what a test that
    /// expects an error calls (then asserts on what it got).
    pub fn take_errors(&self) -> Vec<String> {
        let mut events = self.events.lock().unwrap_or_else(|e| e.into_inner());
        events.drain();
        std::mem::take(&mut events.errors)
    }

    /// Fails the test if the page reported an error the test did not take.
    pub fn check_errors(&self) {
        let errors = self.take_errors();
        if !errors.is_empty() {
            panic!(
                "the page reported {} error(s) (a test that expects them takes them with take_errors()):\n  - {}",
                errors.len(),
                errors.join("\n  - ")
            );
        }
    }

    /// Closes the tab, once every error the page reported before now has been looked at (dropping the page does
    /// the same without that last look).
    pub async fn close(self) {
        // A round trip: what the page reported before it is in by now.
        let _ = self.evaluate("0").await;
        self.check_errors();
    }

    // ---------------------------------------------------------------- the protocol

    async fn evaluate(&self, expression: &str) -> Result<Value, String> {
        let params = EvaluateParams::builder()
            .expression(expression)
            .await_promise(true)
            .return_by_value(true)
            .user_gesture(true)
            .build()
            .map_err(|e| format!("bad evaluation: {e}"))?;
        let answer = self
            .cdp
            .execute(params)
            .await
            .map_err(|e| format!("the browser did not run it: {e}"))?;
        if let Some(details) = &answer.result.exception_details {
            return Err(exception_text(details));
        }
        value_of(&answer.result.result)
    }

    async fn command<C: chromiumoxide::types::Command>(&self, command: C, what: &str) {
        if let Err(e) = self.cdp.execute(command).await {
            panic!("could not {what}: {e}");
        }
    }
}

impl Drop for Page {
    fn drop(&mut self) {
        if let Some(context) = self.context.take() {
            dispose(self.shared, context);
        }
        if !std::thread::panicking() {
            self.check_errors();
        }
    }
}

impl Events {
    /// Takes what the browser has reported so far (without waiting) and keeps the errors.
    fn drain(&mut self) {
        while let Some(Some(event)) = self.console.next().now_or_never() {
            if matches!(event.r#type, ConsoleApiCalledType::Error | ConsoleApiCalledType::Assert) {
                let words: Vec<String> = event.args.iter().map(object_text).collect();
                self.errors
                    .push(format!("console.{}: {}", event.r#type.as_ref(), words.join(" ")));
            }
        }
        while let Some(Some(event)) = self.exceptions.next().now_or_never() {
            self.errors
                .push(format!("uncaught: {}", exception_text(&event.exception_details)));
        }
        while let Some(Some(event)) = self.log.next().now_or_never() {
            if event.entry.level == LogEntryLevel::Error {
                let at = event
                    .entry
                    .url
                    .as_deref()
                    .map(|u| format!(" ({u})"))
                    .unwrap_or_default();
                self.errors
                    .push(format!("{}: {}{at}", event.entry.source.as_ref(), event.entry.text));
            }
        }
    }
}

/// Closes a test's browser context (and its tab) on the shared runtime: a test's own runtime may be ending.
fn dispose(shared: &'static Shared, context: BrowserContextId) {
    runtime().spawn(async move {
        let _ = shared.browser.dispose_browser_context(context).await;
    });
}

/// `args` (a JSON array) as JavaScript that spreads into a call: the JSON is handed over as a string and parsed in
/// the page, so nothing in it is ever read as code.
fn js_args(args: &Value) -> String {
    assert!(
        args.is_array(),
        "the arguments are a JSON array, one element per argument: {args}"
    );
    format!("JSON.parse({})", js_string(&args.to_string()))
}

/// `text` as a JavaScript string literal (a JSON string is one).
pub fn js_string(text: &str) -> String {
    Value::String(text.to_string()).to_string()
}

/// JavaScript's truthiness, for a value that came back as JSON.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A value the page returned, as JSON. Negative zero stays negative zero (as Node's assertions tell it from zero);
/// NaN, the infinities and big integers have no JSON form, so asking for one fails.
fn value_of(object: &RemoteObject) -> Result<Value, String> {
    if let Some(odd) = &object.unserializable_value {
        return match odd.inner().as_str() {
            "-0" => Ok(serde_json::json!(-0.0)),
            other => Err(format!(
                "the result is {other}, which JSON cannot carry: turn it into a string in the expression"
            )),
        };
    }
    Ok(object.value.clone().unwrap_or(Value::Null))
}

/// What a value the page logged reads as.
fn object_text(object: &RemoteObject) -> String {
    match &object.value {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => object
            .unserializable_value
            .as_ref()
            .map(|u| u.inner().clone())
            .or_else(|| object.description.clone())
            .unwrap_or_else(|| object.r#type.as_ref().to_string()),
    }
}

/// What a thrown exception says, with where it was thrown when it came from a file.
fn exception_text(details: &ExceptionDetails) -> String {
    let thrown = details
        .exception
        .as_ref()
        .and_then(|e| {
            e.description
                .clone()
                .or_else(|| e.value.as_ref().map(|v| v.to_string()))
        })
        .unwrap_or_else(|| details.text.clone());
    match details.url.as_deref() {
        Some(url) if !url.is_empty() => format!(
            "{thrown} ({url}:{}:{})",
            details.line_number + 1,
            details.column_number + 1
        ),
        _ => thrown,
    }
}
