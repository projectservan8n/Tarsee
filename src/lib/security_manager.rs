//! Port of `src/lib/security-manager.js`: advanced security manager for Tarsee.
//! Tool permissions, dangerous command detection, SSRF protection, rate limiting.
//!
//! The Node file kept the permissions, rate limits and channel blocks in module-level maps and handed out one
//! `SecurityManager`. Here the one manager of an `App` holds them: [`get_security_manager`].

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::app::App;
use crate::db::settings::Settings;
use crate::env::Env;
use crate::middleware::auth::{Clock, JS_WHITESPACE, js_number};
use crate::util::js::{number_to_string, truthy, utf16_len};

/// `/\b(rm\s+-rf|sudo|chmod\s+777|mkfs|dd\s+if|shutdown|reboot|kill\s+-9|iptables|passwd)\b/i`. JavaScript's `\b`
/// and `/i` look at ASCII only (`(?-u:\b)`, `(?i-u:...)`); its `\s` is spelled out.
static DANGEROUS_COMMANDS: LazyLock<Regex> = LazyLock::new(|| {
    let ws = JS_WHITESPACE;
    Regex::new(&format!(
        r"(?-u:\b)(?:(?i-u:rm){ws}+-(?i-u:rf)|(?i-u:sudo)|(?i-u:chmod){ws}+777|(?i-u:mkfs)|(?i-u:dd){ws}+(?i-u:if)|(?i-u:shutdown)|(?i-u:reboot)|(?i-u:kill){ws}+-9|(?i-u:iptables)|(?i-u:passwd))(?-u:\b)"
    ))
    .expect("the dangerous command pattern")
});

/// Hosts a tool must never be pointed at.
///
/// 169.254.0.0/16 is the addition that matters most in a cloud deployment: 169.254.169.254 is the instance
/// metadata endpoint on AWS, GCP and Azure, and on many setups it hands out credentials to anything that can make
/// an HTTP request from the box. An agent that fetches URLs found in an email or a web page is exactly such a
/// requester, so leaving it out made prompt injection a credential-theft path. The rest close the usual loopback
/// and RFC1918 holes.
static PRIVATE_IP_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i-u)^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.|localhost$|localhost\.|::1|\[::1\]|\[?fd[0-9a-f]{2}:|\[?fe80:)",
    )
    .expect("the private address pattern")
});

/// Default permissions
const DEFAULT_PERMISSIONS: [(&str, &str); 4] = [
    // runs, and every use is logged (a dangerous command is flagged as such in any mode but Deny)
    ("exec", "warn"),
    ("write_file", "always_allow"),
    ("browser", "always_allow"),
    ("web_fetch", "check_ssrf"),
];

/// The setting the permissions are saved under.
const TOOL_PERMISSIONS_KEY: &str = "security.toolPermissions";

/// What [`SecurityManager::check_tool_permission`] decides: `{ allowed, reason }` for a refusal,
/// `{ allowed, warning }` for a call that runs and is recorded, `{ allowed }` otherwise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolVerdict {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

impl ToolVerdict {
    fn allowed() -> Self {
        ToolVerdict {
            allowed: true,
            reason: None,
            warning: None,
        }
    }

    fn denied(reason: String) -> Self {
        ToolVerdict {
            allowed: false,
            reason: Some(reason),
            warning: None,
        }
    }

    fn warned(warning: String) -> Self {
        ToolVerdict {
            allowed: true,
            reason: None,
            warning: Some(warning),
        }
    }
}

/// What [`SecurityManager::validate_tool_input`] decides: `{ valid }`, with `reason` when it is not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolValidation {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ToolValidation {
    fn valid() -> Self {
        ToolValidation {
            valid: true,
            reason: None,
        }
    }

    fn invalid(reason: &str) -> Self {
        ToolValidation {
            valid: false,
            reason: Some(reason.to_string()),
        }
    }
}

/// `validateToolInput` threw: `write_file` was given a `filename` that is neither text nor a list (a number, true,
/// an object), and the JS called `.includes` on it. The caller treats it as the JS caller did its `catch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("input.filename.includes is not a function")]
pub struct FilenameNotText;

struct RateLimit {
    /// When each call of the last minute was made.
    calls: Vec<i64>,
    max_per_minute: u32,
}

pub struct SecurityManager {
    /// toolName -> mode, in the order they were set. A mode is whatever was saved: text in practice
    /// ("always_allow", "always_deny", "warn", "check_ssrf"), but the admin route stores what it is sent.
    tool_permissions: Mutex<Map<String, Value>>,
    /// toolName -> { calls: [], maxPerMinute }
    tool_rate_limits: Mutex<HashMap<String, RateLimit>>,
    /// channel -> Set of blocked tools
    channel_permissions: Mutex<HashMap<String, HashSet<String>>>,
    clock: Arc<Clock>,
}

/// `String(value)` for a JSON value.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_to_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        // An array prints its items joined by commas, null as nothing.
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `Object.entries(value)`: an object's fields, a list's items by index, a text's characters by index; nothing for
/// anything else.
fn object_entries(value: &Value) -> Vec<(String, Value)> {
    match value {
        Value::Object(fields) => fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| (index.to_string(), item.clone()))
            .collect(),
        Value::String(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(index, unit)| (index.to_string(), Value::String(String::from_utf16_lossy(&[unit]))))
            .collect(),
        _ => Vec::new(),
    }
}

/// A field of the tool's input, when it is there and truthy (`input.command` in an `if`).
fn truthy_field<'a>(input: &'a Value, field: &str) -> Option<&'a Value> {
    input.get(field).filter(|value| truthy(value))
}

/// `new URL(text).hostname`: `None` when the text is no URL, empty when the URL has no host. An IPv6 address comes
/// in its brackets.
fn url_hostname(text: &str) -> Option<String> {
    let parsed = url::Url::parse(text).ok()?;
    Some(parsed.host_str().unwrap_or("").to_string())
}

impl SecurityManager {
    /// A manager with the permissions saved in the settings. Use [`get_security_manager`] for the app's one.
    pub fn new(app: &App, settings: &dyn Settings) -> SecurityManager {
        let mut tool_permissions = Map::new();
        // Load saved permissions
        if let Some(saved) = settings.get(TOOL_PERMISSIONS_KEY).filter(truthy) {
            for (tool_name, mode) in object_entries(&saved) {
                tool_permissions.insert(tool_name, mode);
            }
        }
        SecurityManager {
            tool_permissions: Mutex::new(tool_permissions),
            tool_rate_limits: Mutex::new(HashMap::new()),
            channel_permissions: Mutex::new(HashMap::new()),
            clock: Clock::of(app),
        }
    }

    /// Sets a tool's mode and saves all of them to the settings (best effort).
    pub fn set_tool_permission(&self, settings: &dyn Settings, tool_name: &str, mode: impl Into<Value>) {
        let all = {
            let mut tool_permissions = self.tool_permissions.lock();
            tool_permissions.insert(tool_name.to_string(), mode.into());
            tool_permissions.clone()
        };
        // best effort
        let _ = settings.set(TOOL_PERMISSIONS_KEY, Value::Object(all));
    }

    /// The tool's mode: the one set for it, else its default, else "always_allow".
    pub fn get_tool_permission(&self, tool_name: &str) -> Value {
        if let Some(mode) = self.tool_permissions.lock().get(tool_name).filter(|mode| truthy(mode)) {
            return mode.clone();
        }
        let default = DEFAULT_PERMISSIONS
            .iter()
            .find(|(name, _)| *name == tool_name)
            .map_or("always_allow", |(_, mode)| mode);
        Value::String(default.to_string())
    }

    /// Whether the tool may run with this input, for this channel (`None` for none).
    pub fn check_tool_permission(&self, tool_name: &str, input: &Value, channel: Option<&str>) -> ToolVerdict {
        // Check channel-level blocks
        if let Some(channel) = channel.filter(|channel| !channel.is_empty())
            && self
                .channel_permissions
                .lock()
                .get(channel)
                .is_some_and(|blocked| blocked.contains(tool_name))
        {
            return ToolVerdict::denied(format!("Tool '{tool_name}' is blocked for {channel} channel"));
        }

        let perm = self.get_tool_permission(tool_name);
        if perm == "always_deny" {
            return ToolVerdict::denied(format!("Tool '{tool_name}' is denied by policy"));
        }

        // Rate limiting
        if let Some(rate_limit) = self.tool_rate_limits.lock().get_mut(tool_name) {
            let now = self.clock.now_ms();
            rate_limit.calls.retain(|at| now - at < 60_000);
            if rate_limit.calls.len() >= rate_limit.max_per_minute as usize {
                return ToolVerdict::denied(format!(
                    "Rate limit exceeded for '{tool_name}' ({}/min)",
                    rate_limit.max_per_minute
                ));
            }
            rate_limit.calls.push(now);
        }

        // Specific checks
        if tool_name == "exec"
            && let Some(command) = truthy_field(input, "command")
        {
            let command = js_string(command);
            if DANGEROUS_COMMANDS.is_match(&command) {
                return ToolVerdict::warned(format!("Potentially dangerous command: {command}"));
            }
        }

        if tool_name == "web_fetch"
            && let Some(url) = truthy_field(input, "url")
            // An invalid URL is let through, to fail naturally.
            && let Some(hostname) = url_hostname(&js_string(url))
            && PRIVATE_IP_REGEX.is_match(&hostname)
        {
            return ToolVerdict::denied(format!("SSRF protection: blocked request to private IP {hostname}"));
        }

        if tool_name == "browser"
            && let Some(url) = truthy_field(input, "url")
            && let Some(hostname) = url_hostname(&js_string(url))
            && PRIVATE_IP_REGEX.is_match(&hostname)
        {
            return ToolVerdict::denied("Browser navigation to private IP blocked".to_string());
        }

        // Warn: the call runs, and every use is recorded (tools.rs check_tool_policy writes it to the Console and
        // the Audit Log as tool.warning). Only the tool's name goes in the record: inputs such as set_key's value
        // can be secrets. The checks above come first, so a denial or exec's dangerous-command warning still wins.
        if perm == "warn" {
            return ToolVerdict::warned(format!("Used {tool_name} (Tool Permissions: Warn)"));
        }

        ToolVerdict::allowed()
    }

    pub fn set_rate_limit(&self, tool_name: &str, max_per_minute: u32) {
        self.tool_rate_limits.lock().insert(
            tool_name.to_string(),
            RateLimit {
                calls: Vec::new(),
                max_per_minute,
            },
        );
    }

    pub fn set_channel_block(&self, channel: &str, tool_name: &str) {
        self.channel_permissions
            .lock()
            .entry(channel.to_string())
            .or_default()
            .insert(tool_name.to_string());
    }

    /// Basic input validation.
    pub fn validate_tool_input(&self, tool_name: &str, input: &Value) -> Result<ToolValidation, FilenameNotText> {
        if tool_name == "write_file"
            && let Some(filename) = truthy_field(input, "filename")
        {
            let traversal = match filename {
                Value::String(text) => text.contains(".."),
                // A list "includes" an item that is exactly "..".
                Value::Array(items) => items.iter().any(|item| item == ".."),
                _ => return Err(FilenameNotText),
            };
            if traversal {
                return Ok(ToolValidation::invalid("Path traversal detected"));
            }
        }
        if tool_name == "exec"
            && let Some(command) = truthy_field(input, "command")
        {
            // `command.length`: UTF-16 units of a text, items of a list, the `length` field of an object.
            let length = match command {
                Value::String(text) => utf16_len(text) as f64,
                Value::Array(items) => items.len() as f64,
                Value::Object(fields) => match fields.get("length") {
                    Some(Value::Number(length)) => length.as_f64().unwrap_or(f64::NAN),
                    Some(Value::String(length)) => js_number(length),
                    _ => f64::NAN,
                },
                _ => f64::NAN,
            };
            if length > 10_000.0 {
                return Ok(ToolValidation::invalid("Command too long"));
            }
        }
        Ok(ToolValidation::valid())
    }

    /// The environment without the variables whose names say they hold a secret of the host.
    pub fn sanitize_env(&self, env: &Env) -> BTreeMap<String, String> {
        const BLOCKED: [&str; 4] = ["AWS_SECRET", "ENCRYPTION_KEY", "DATABASE_URL", "SETUP_PASSWORD"];
        env.snapshot()
            .into_iter()
            .filter(|(name, _)| {
                let upper = name.to_uppercase();
                !BLOCKED.iter().any(|blocked| upper.contains(blocked))
            })
            .collect()
    }

    /// Every mode that was set, by tool name, in the order they were set.
    pub fn list_permissions(&self) -> Map<String, Value> {
        self.tool_permissions.lock().clone()
    }
}

/// The app's security manager, made on first use with the permissions saved in `settings`.
pub fn get_security_manager(app: &App, settings: &dyn Settings) -> Arc<SecurityManager> {
    app.get_or_init(|| SecurityManager::new(app, settings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{MemorySettings, TestApp, test_app};
    use serde_json::json;

    fn saved() -> MemorySettings {
        MemorySettings::from_pairs([(TOOL_PERMISSIONS_KEY, json!({ "exec": "always_deny", "custom": "warn" }))])
    }

    /// A manager with nothing saved.
    fn manager(t: &TestApp) -> Arc<SecurityManager> {
        get_security_manager(t, &MemorySettings::new())
    }

    fn verdict(value: Value) -> ToolVerdict {
        ToolVerdict {
            allowed: value["allowed"].as_bool().unwrap(),
            reason: value.get("reason").and_then(Value::as_str).map(String::from),
            warning: value.get("warning").and_then(Value::as_str).map(String::from),
        }
    }

    #[test]
    fn saved_permissions_are_loaded_and_the_rest_have_their_defaults() {
        let t = test_app();
        let settings = saved();
        let sm = get_security_manager(&t, &settings);
        // What Node's manager answered with the same settings.
        assert_eq!(
            Value::Object(sm.list_permissions()),
            json!({ "exec": "always_deny", "custom": "warn" })
        );
        for (tool, mode) in [
            ("exec", "always_deny"),
            ("custom", "warn"),
            ("write_file", "always_allow"),
            ("browser", "always_allow"),
            ("web_fetch", "check_ssrf"),
            ("anything", "always_allow"),
        ] {
            assert_eq!(sm.get_tool_permission(tool), mode, "{tool}");
        }
        assert_eq!(
            sm.check_tool_permission("exec", &json!({ "command": "ls" }), None),
            verdict(json!({ "allowed": false, "reason": "Tool 'exec' is denied by policy" }))
        );
    }

    #[test]
    fn a_permission_that_is_set_is_saved_with_all_the_others() {
        let t = test_app();
        let settings = saved();
        let sm = get_security_manager(&t, &settings);
        sm.set_tool_permission(&settings, "exec", "warn");
        assert_eq!(
            settings.get(TOOL_PERMISSIONS_KEY),
            Some(json!({ "exec": "warn", "custom": "warn" }))
        );
        sm.set_tool_permission(&settings, "web_fetch", "warn");
        sm.set_tool_permission(&settings, "read_file", "always_deny");
        assert_eq!(
            Value::Object(sm.list_permissions()).to_string(),
            r#"{"exec":"warn","custom":"warn","web_fetch":"warn","read_file":"always_deny"}"#
        );
        assert_eq!(
            settings.get(TOOL_PERMISSIONS_KEY),
            Some(Value::Object(sm.list_permissions()))
        );
        // The admin route stores whatever mode it is sent; a mode that is no text allows.
        sm.set_tool_permission(&settings, "odd", 5);
        sm.set_tool_permission(&settings, "obj", json!({ "a": 1 }));
        assert_eq!(sm.get_tool_permission("odd"), 5);
        assert_eq!(sm.get_tool_permission("obj"), json!({ "a": 1 }));
        assert_eq!(
            sm.check_tool_permission("odd", &json!({}), None),
            verdict(json!({ "allowed": true }))
        );
        // A falsy mode is no mode: the default answers.
        sm.set_tool_permission(&settings, "exec", "");
        assert_eq!(sm.get_tool_permission("exec"), "warn");
    }

    #[test]
    fn the_app_has_one_manager_and_each_app_its_own() {
        let t = test_app();
        let settings = saved();
        let first = get_security_manager(&t, &settings);
        // Asked for again, with other settings: the same manager, as the JS kept its first instance.
        let second = get_security_manager(&t, &MemorySettings::new());
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(second.get_tool_permission("exec"), "always_deny");

        let other = test_app();
        assert_eq!(manager(&other).get_tool_permission("exec"), "warn");
    }

    #[test]
    fn saved_permissions_of_another_shape_load_as_object_entries_gave_them() {
        let t = test_app();
        let load = |saved: Value| {
            let settings = MemorySettings::from_pairs([(TOOL_PERMISSIONS_KEY, saved)]);
            Value::Object(SecurityManager::new(&t, &settings).list_permissions())
        };
        assert_eq!(load(json!(["a", "b"])), json!({ "0": "a", "1": "b" }));
        assert_eq!(load(json!("ab")), json!({ "0": "a", "1": "b" }));
        for nothing in [json!(5), json!(true), json!(null), json!(""), json!(0)] {
            assert_eq!(load(nothing), json!({}));
        }
        assert_eq!(
            Value::Object(SecurityManager::new(&t, &MemorySettings::new()).list_permissions()),
            json!({})
        );
    }

    #[test]
    fn dangerous_commands_are_flagged_as_node_flagged_them() {
        let t = test_app();
        let sm = manager(&t);
        let used = "Used exec (Tool Permissions: Warn)".to_string();
        // exec is "warn" by default. Whether Node's manager called each command dangerous.
        for (command, dangerous) in [
            ("ls -la", false),
            ("rm -rf /", true),
            ("RM  -RF x", true),
            ("sudo apt", true),
            ("xsudo", false),
            ("sudox", false),
            ("chmod 777 f", true),
            ("chmod  777", true),
            ("chmod 7777", false),
            ("mkfs.ext4", true),
            ("dd if=/dev/zero", true),
            ("dd  if=x", true),
            ("shutdown now", true),
            ("reboot", true),
            ("kill -9 1", true),
            ("kill  -9", true),
            ("iptables -F", true),
            ("passwd", true),
            ("my_passwd", false),
            ("rm\t-rf", true),
            ("rm\u{a0}-rf x", true),
            ("rm -rfx", false),
            ("echo \u{17f}udo", false),
            ("\u{17f}udo", false),
            ("KILL -9", true),
            ("pre-sudo-post", true),
            ("résudo", true),
            ("sudoé", true),
        ] {
            let expected = if dangerous {
                format!("Potentially dangerous command: {command}")
            } else {
                used.clone()
            };
            assert_eq!(
                sm.check_tool_permission("exec", &json!({ "command": command }), None),
                ToolVerdict::warned(expected),
                "{command:?}"
            );
        }
        // A command that is not text is read as JavaScript would print it.
        assert_eq!(
            sm.check_tool_permission("exec", &json!({ "command": ["sudo", "x"] }), None),
            ToolVerdict::warned("Potentially dangerous command: sudo,x".to_string())
        );
        for harmless in [
            json!({ "command": 5 }),
            json!({ "command": "" }),
            json!({}),
            json!(null),
            json!({ "command": { "a": 1 } }),
        ] {
            assert_eq!(
                sm.check_tool_permission("exec", &harmless, None),
                ToolVerdict::warned(used.clone()),
                "{harmless}"
            );
        }
        // Only exec is looked at for commands.
        assert_eq!(
            sm.check_tool_permission("other", &json!({ "command": "sudo x" }), None),
            ToolVerdict::allowed()
        );
    }

    #[test]
    fn private_addresses_are_refused_as_node_refused_them() {
        let t = test_app();
        let sm = manager(&t);
        // What `new URL(url).hostname` was in Node (None: not a URL), and whether web_fetch was refused.
        for (url, hostname, blocked) in [
            ("http://127.0.0.1/", Some("127.0.0.1"), true),
            ("http://127.1/", Some("127.0.0.1"), true),
            ("http://2130706433/", Some("127.0.0.1"), true),
            ("http://0x7f.1/", Some("127.0.0.1"), true),
            ("http://10.0.0.5:8080/x", Some("10.0.0.5"), true),
            ("http://172.16.0.1/", Some("172.16.0.1"), true),
            ("http://172.15.0.1/", Some("172.15.0.1"), false),
            ("http://172.31.255.255/", Some("172.31.255.255"), true),
            ("http://172.32.0.1/", Some("172.32.0.1"), false),
            ("http://192.168.1.1/", Some("192.168.1.1"), true),
            (
                "http://169.254.169.254/latest/meta-data/",
                Some("169.254.169.254"),
                true,
            ),
            ("http://0.0.0.0/", Some("0.0.0.0"), true),
            ("http://localhost/", Some("localhost"), true),
            ("http://LOCALHOST:3000/", Some("localhost"), true),
            ("http://localhost.localdomain/", Some("localhost.localdomain"), true),
            ("http://localhostx/", Some("localhostx"), false),
            ("http://notlocalhost/", Some("notlocalhost"), false),
            ("http://[::1]/", Some("[::1]"), true),
            ("http://[::1]:8080/", Some("[::1]"), true),
            ("http://[fd12:3456::1]/", Some("[fd12:3456::1]"), true),
            ("http://[fe80::1]/", Some("[fe80::1]"), true),
            ("http://[FE80::1]/", Some("[fe80::1]"), true),
            ("http://[2001:db8::1]/", Some("[2001:db8::1]"), false),
            ("https://example.com/", Some("example.com"), false),
            ("http://127.example.com/", Some("127.example.com"), true),
            ("http://10.example.com/", Some("10.example.com"), true),
            ("http://fd00.example.com/", Some("fd00.example.com"), false),
            ("http://fe80.example.com/", Some("fe80.example.com"), false),
            ("http://fd12:x@example.com/", Some("example.com"), false),
            ("not a url", None, false),
            ("file:///etc/passwd", Some(""), false),
            ("localhost:3000", Some(""), false),
            ("http://user:pw@127.0.0.1/", Some("127.0.0.1"), true),
            ("http://127.0.0.1.nip.io/", Some("127.0.0.1.nip.io"), true),
            ("HTTP://EXAMPLE.COM", Some("example.com"), false),
            ("http://[::ffff:127.0.0.1]/", Some("[::ffff:7f00:1]"), false),
            ("http://0/", Some("0.0.0.0"), true),
            ("http://0x0.0/", Some("0.0.0.0"), true),
            ("ftp://10.1.2.3/", Some("10.1.2.3"), true),
            ("foo://10.1.2.3/", Some("10.1.2.3"), true),
            ("foo://LOCALHOST/", Some("LOCALHOST"), true),
            ("http://1.1.1.1/", Some("1.1.1.1"), false),
            ("http://0177.0.0.1/", Some("127.0.0.1"), true),
            ("http://ⓛocalhost/", Some("localhost"), true),
            ("http://localhost。/", Some("localhost."), true),
        ] {
            assert_eq!(url_hostname(url).as_deref(), hostname, "{url}");
            let expected = if blocked {
                ToolVerdict::denied(format!(
                    "SSRF protection: blocked request to private IP {}",
                    hostname.unwrap()
                ))
            } else {
                ToolVerdict::allowed()
            };
            assert_eq!(
                sm.check_tool_permission("web_fetch", &json!({ "url": url }), None),
                expected,
                "{url}"
            );
        }

        assert_eq!(
            sm.check_tool_permission("browser", &json!({ "url": "http://127.0.0.1/" }), None),
            ToolVerdict::denied("Browser navigation to private IP blocked".to_string())
        );
        assert_eq!(
            sm.check_tool_permission("browser", &json!({ "url": "https://example.com/" }), None),
            ToolVerdict::allowed()
        );
        assert_eq!(
            sm.check_tool_permission("browser", &json!({ "url": "nope" }), None),
            ToolVerdict::allowed()
        );
        // Other tools' URLs are not looked at.
        assert_eq!(
            sm.check_tool_permission("read_file", &json!({ "url": "http://127.0.0.1/" }), None),
            ToolVerdict::allowed()
        );
    }

    #[test]
    fn warn_records_every_use_but_a_refusal_or_a_dangerous_command_comes_first() {
        let t = test_app();
        let settings = MemorySettings::new();
        let sm = get_security_manager(&t, &settings);
        sm.set_tool_permission(&settings, "web_fetch", "warn");
        // Node's answers.
        assert_eq!(
            sm.check_tool_permission("web_fetch", &json!({ "url": "https://example.com/" }), None),
            verdict(json!({ "allowed": true, "warning": "Used web_fetch (Tool Permissions: Warn)" }))
        );
        assert_eq!(
            sm.check_tool_permission("web_fetch", &json!({ "url": "http://10.0.0.1/" }), None),
            verdict(json!({ "allowed": false, "reason": "SSRF protection: blocked request to private IP 10.0.0.1" }))
        );
        assert_eq!(
            sm.check_tool_permission("exec", &json!({ "command": "sudo x" }), None),
            verdict(json!({ "allowed": true, "warning": "Potentially dangerous command: sudo x" }))
        );
        assert_eq!(
            sm.check_tool_permission("exec", &json!({ "command": "ls" }), None),
            verdict(json!({ "allowed": true, "warning": "Used exec (Tool Permissions: Warn)" }))
        );
    }

    #[test]
    fn a_tool_can_be_blocked_for_one_channel() {
        let t = test_app();
        let sm = manager(&t);
        sm.set_channel_block("telegram", "exec");
        assert_eq!(
            sm.check_tool_permission("exec", &json!({ "command": "ls" }), Some("telegram")),
            verdict(json!({ "allowed": false, "reason": "Tool 'exec' is blocked for telegram channel" }))
        );
        assert_eq!(
            sm.check_tool_permission("exec", &json!({ "command": "ls" }), Some("discord")),
            verdict(json!({ "allowed": true, "warning": "Used exec (Tool Permissions: Warn)" }))
        );
        assert_eq!(
            sm.check_tool_permission("read_file", &json!({}), Some("telegram")),
            verdict(json!({ "allowed": true }))
        );
        assert!(sm.check_tool_permission("exec", &json!({}), None).allowed);
        assert!(sm.check_tool_permission("exec", &json!({}), Some("")).allowed);
    }

    #[test]
    fn a_tool_can_be_limited_to_so_many_calls_a_minute() {
        let t = test_app();
        let clock = t.app.set(Clock::manual(1_000_000));
        let settings = MemorySettings::new();
        let sm = get_security_manager(&t, &settings);
        sm.set_rate_limit("read_file", 2);
        let call = || sm.check_tool_permission("read_file", &Value::Null, None);
        // Node: allowed, allowed, then refused.
        assert_eq!(call(), verdict(json!({ "allowed": true })));
        clock.advance(20_000);
        assert_eq!(call(), verdict(json!({ "allowed": true })));
        let over = verdict(json!({ "allowed": false, "reason": "Rate limit exceeded for 'read_file' (2/min)" }));
        assert_eq!(call(), over);
        // A refused call is not counted. A minute after the first call there is room for one more.
        clock.advance(39_999);
        assert_eq!(call(), over);
        clock.advance(1);
        assert_eq!(call(), verdict(json!({ "allowed": true })));
        assert_eq!(call(), over);

        // A denied tool is refused before it is counted.
        sm.set_tool_permission(&settings, "read_file", "always_deny");
        assert_eq!(
            call(),
            verdict(json!({ "allowed": false, "reason": "Tool 'read_file' is denied by policy" }))
        );
    }

    #[test]
    fn inputs_are_validated_as_node_validated_them() {
        let t = test_app();
        let sm = manager(&t);
        let invalid = |reason: &str| Ok(ToolValidation::invalid(reason));
        let valid = || Ok(ToolValidation::valid());
        let check = |tool: &str, input: Value| sm.validate_tool_input(tool, &input);

        assert_eq!(
            check("write_file", json!({ "filename": "a/../b" })),
            invalid("Path traversal detected")
        );
        assert_eq!(check("write_file", json!({ "filename": "a.md" })), valid());
        assert_eq!(check("write_file", json!({})), valid());
        assert_eq!(
            check("exec", json!({ "command": "x".repeat(10_001) })),
            invalid("Command too long")
        );
        assert_eq!(check("exec", json!({ "command": "x".repeat(10_000) })), valid());
        assert_eq!(
            check("other", json!({ "filename": "..", "command": "x".repeat(20_000) })),
            valid()
        );
        // What the JS did with a filename that is not text: a list is searched for "..", anything else threw.
        assert_eq!(check("write_file", json!({ "filename": 5 })), Err(FilenameNotText));
        assert_eq!(
            check("write_file", json!({ "filename": ["..", "a"] })),
            invalid("Path traversal detected")
        );
        assert_eq!(check("write_file", json!({ "filename": ["a..b"] })), valid());
        assert_eq!(
            check("write_file", json!({ "filename": { "a": 1 } })),
            Err(FilenameNotText)
        );
        assert_eq!(check("write_file", json!({ "filename": true })), Err(FilenameNotText));
        assert_eq!(FilenameNotText.to_string(), "input.filename.includes is not a function");
        // And with a command that is not text: its `length`, whatever that is.
        assert_eq!(
            check("exec", json!({ "command": vec!["a"; 10_001] })),
            invalid("Command too long")
        );
        assert_eq!(check("exec", json!({ "command": 123_456 })), valid());
        assert_eq!(
            check("exec", json!({ "command": { "length": 10_001 } })),
            invalid("Command too long")
        );
        // Length is counted in UTF-16 units: 5001 of these are 10002.
        assert_eq!(
            check("exec", json!({ "command": "🐒".repeat(5001) })),
            invalid("Command too long")
        );
        assert_eq!(check("exec", json!({ "command": "🐒".repeat(5000) })), valid());

        assert_eq!(
            serde_json::to_string(&ToolValidation::invalid("Command too long")).unwrap(),
            r#"{"valid":false,"reason":"Command too long"}"#
        );
        assert_eq!(
            serde_json::to_string(&ToolValidation::valid()).unwrap(),
            r#"{"valid":true}"#
        );
    }

    #[test]
    fn verdicts_serialise_as_the_js_objects() {
        assert_eq!(
            serde_json::to_string(&ToolVerdict::allowed()).unwrap(),
            r#"{"allowed":true}"#
        );
        assert_eq!(
            serde_json::to_string(&ToolVerdict::denied("no".into())).unwrap(),
            r#"{"allowed":false,"reason":"no"}"#
        );
        assert_eq!(
            serde_json::to_string(&ToolVerdict::warned("careful".into())).unwrap(),
            r#"{"allowed":true,"warning":"careful"}"#
        );
    }

    #[test]
    fn sanitize_env_leaves_out_the_hosts_secrets() {
        let t = test_app();
        let sm = manager(&t);
        let env = Env::from_pairs([
            ("MY_AWS_SECRET_KEY", "a"),
            ("aws_secret_lower", "b"),
            ("KEEP_ME", "c"),
            ("X_DATABASE_URL_2", "d"),
            ("ENCRYPTION_KEY", "e"),
            ("SETUP_PASSWORD", "f"),
            ("PATH", "/usr/bin"),
        ]);
        // What Node's sanitizeEnv kept of the same variables.
        assert_eq!(
            sm.sanitize_env(&env),
            BTreeMap::from([
                ("KEEP_ME".to_string(), "c".to_string()),
                ("PATH".to_string(), "/usr/bin".to_string())
            ])
        );
        assert_eq!(env.len(), 7, "the environment itself is untouched");
    }

    #[test]
    fn values_print_as_javascript_prints_them() {
        assert_eq!(js_string(&json!("text")), "text");
        assert_eq!(js_string(&json!(5)), "5");
        assert_eq!(js_string(&json!(1.5)), "1.5");
        assert_eq!(js_string(&json!(true)), "true");
        assert_eq!(js_string(&json!(null)), "null");
        assert_eq!(js_string(&json!(["a", null, ["b", 2]])), "a,,b,2");
        assert_eq!(js_string(&json!({ "a": 1 })), "[object Object]");
    }
}
