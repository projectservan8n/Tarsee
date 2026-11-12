//! Port of `src/ai/agent-env.js`.
//!
//! The vault's keys in the agent's environment, so its scripts read a key by name (os.environ["OPENAI_API_KEY"],
//! process.env.RESEND_API_KEY) and it never pastes one into a command. A key pasted into a command lands in the
//! session's transcript, and Claude Code's own checks rightly refuse commands that carry credentials. Ported from
//! TarseeMacOS ("the point of the vault is that the agent can use any key it was given").
//!
//! It gives the agent nothing new: tarsee_get_key already returns any key. So when the owner has set get_key to
//! "always deny" in Settings > Tool Permissions, no key goes in either.
//!
//! Every key whose name is an environment variable name in capitals goes in, except:
//!   - names already set in Tarsee's own environment (those win)
//!   - Claude's settings and login (CLAUDE_*) and Anthropic API keys (ANTHROPIC_*), which would move the agent off
//!     the Claude subscription onto pay-per-use billing; Codex's (CODEX_*) and OPENAI_BASE_URL, which would change
//!     the Codex engine's login, home or host (ai/engine_env.rs strips them again before every turn)
//!   - Tarsee's own secrets (ENCRYPTION_KEY, SETUP_PASSWORD)
//!   - names that change how programs run rather than what they can reach: Tarsee's own settings (TARSEE_*), Node
//!     and the loader (NODE_*, LD_*, DYLD_*), npm's, Python's start-up and paths, the shell's, and the proxies
//!
//! A value over 32 KB, or one with a NUL in it, stays out too (tarsee_get_key still has it).
//! TARSEE_AGENT_ENV_KEYS: a comma-separated list of names to use instead of every key, or "off" for none.
//! Read from the vault at most once a minute for the default call (Tarsee's own environment); a call that passes
//! its own `env` (engine_env's base_env(), say) compares against that one, so it is never answered from, or stored
//! in, that cache. Denying get_key applies at once either way.
//!
//! Nothing here touches the real environment: the names are compared against the app's `Env` or the map the caller
//! passes, and the result is a map for the caller to give to the program it starts.

use std::collections::BTreeMap;
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use regex::Regex;

use crate::app::App;
use crate::lib::key_vault::{get_key, list_keys};
use crate::middleware::auth::Clock;
use crate::util::js::{trim, utf16_len};

/// Names that never go into the agent's environment, by how they start.
pub static AGENT_ENV_KEEP_OUT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(CLAUDE_|ANTHROPIC_|CODEX_|TARSEE_|NODE_|LD_|DYLD_|NPM_|PYTHON|GIT_|SSL_|BASH_)")
        .expect("the keep-out pattern")
});

const KEEP_OUT_NAMES: [&str; 19] = [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "ENV",
    "PWD",
    "TMPDIR",
    "LANG",
    "TERM",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "MAX_MCP_OUTPUT_TOKENS",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "OPENAI_BASE_URL",
    "ENCRYPTION_KEY",
    "SETUP_PASSWORD",
];

const VALUE_MAX_CHARS: usize = 32 * 1024;

/// A name that is an environment variable name in capitals.
static ENV_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9_]*$").expect("the environment name pattern"));

/// The answer of the last default call, and when it was made (the JS module-level `cached`).
struct AgentEnvCache {
    at: i64,
    value: Arc<BTreeMap<String, String>>,
}

type SharedCache = Mutex<AgentEnvCache>;

fn cache_of(app: &App) -> Arc<SharedCache> {
    app.get_or_init(|| {
        Mutex::new(AgentEnvCache {
            at: 0,
            value: Arc::new(BTreeMap::new()),
        })
    })
}

/// Reads one key's value by name: `Ok(None)` when there is no such key, `Err` when the vault cannot be read.
pub type GetKey<'a> = &'a dyn Fn(&str) -> anyhow::Result<Option<String>>;

/// Lists the names of the keys; `Err` when the vault cannot be read.
pub type ListKeys<'a> = &'a dyn Fn() -> anyhow::Result<Vec<String>>;

/// What a call may replace (the JS `{ names, get, list, env, now, denied }`). Everything left out is the live
/// thing: the vault, the app's environment, the time now, and get_key not denied.
#[derive(Default)]
pub struct AgentVaultEnvOptions<'a> {
    /// The key names to consider, instead of TARSEE_AGENT_ENV_KEYS or every key of the vault. For tests.
    pub names: Option<Vec<String>>,
    /// Reads a key's value, instead of the vault. For tests.
    pub get: Option<GetKey<'a>>,
    /// Lists the key names, instead of the vault. For tests.
    pub list: Option<ListKeys<'a>>,
    /// The environment the vault's names are compared against (default: the app's, the only one cached).
    pub env: Option<&'a BTreeMap<String, String>>,
    /// The time, in ms. For tests.
    pub now: Option<i64>,
    /// True when the owner has denied get_key.
    pub denied: Option<&'a dyn Fn() -> bool>,
}

/// `{ NAME: value }` for the agent's environment. The default call's answer is shared until the next read of the
/// vault, so two calls within the minute give the same `Arc`.
pub fn agent_vault_env(app: &App, options: AgentVaultEnvOptions<'_>) -> Arc<BTreeMap<String, String>> {
    let AgentVaultEnvOptions {
        names,
        get,
        list,
        env,
        now,
        denied,
    } = options;
    // Only the default call shares the cache: names, the vault and the environment are all the live ones.
    let cachable = names.is_none() && get.is_none() && env.is_none();
    // A variable of the environment the vault's names are compared against. The caller's own is a plain map (the
    // JS callers passed a copy of `process.env`, an ordinary object). The app's is asked through `Env`, where on
    // Windows a name matches whatever its case, as in `process.env` itself: a key named COMSPEC stays out when the
    // system has ComSpec.
    let env_value = |name: &str| -> Option<String> {
        match env {
            Some(env) => env.get(name).cloned(),
            None => app.env().get(name),
        }
    };
    let now = now.unwrap_or_else(|| Clock::of(app).now_ms());
    let blocked = denied.is_some_and(|denied| denied());
    let cache = cache_of(app);
    if cachable && !blocked {
        let cached = cache.lock();
        if now - cached.at < 60_000 {
            return cached.value.clone();
        }
    }

    let mut out = BTreeMap::new();
    let mut skipped: Vec<String> = Vec::new();
    let setting = env_value("TARSEE_AGENT_ENV_KEYS").unwrap_or_default();
    let setting = trim(&setting);
    if !blocked && setting.to_lowercase() != "off" {
        let wanted: Vec<String> = match names {
            Some(names) => names,
            None if !setting.is_empty() => setting.split(',').map(String::from).collect(),
            None => match list {
                Some(list) => list().unwrap_or_default(),
                None => list_keys(app).into_iter().map(|key| key.name).collect(),
            },
        };
        for raw in wanted {
            let name = trim(&raw);
            if !ENV_NAME.is_match(name)
                || AGENT_ENV_KEEP_OUT.is_match(name)
                || KEEP_OUT_NAMES.contains(&name)
                || env_value(name).is_some_and(|value| !value.is_empty())
            {
                continue;
            }
            let read = match get {
                Some(get) => get(name),
                None => get_key(app, name).map_err(anyhow::Error::from),
            };
            // An error is the vault being unavailable: the key stays out.
            let value = read
                .ok()
                .flatten()
                .map(|value| trim(&value).to_string())
                .filter(|value| !value.is_empty());
            let Some(value) = value else { continue };
            // Linux refuses a single environment string past about 128 KB, and then the agent could not start at
            // all; a value that big (a certificate bundle, a credentials file) is for tarsee_get_key. A NUL can't
            // be in one either.
            if utf16_len(&value) > VALUE_MAX_CHARS || value.contains('\0') {
                skipped.push(name.to_string());
                continue;
            }
            out.insert(name.to_string(), value);
        }
    }

    let out = Arc::new(out);
    if cachable {
        let mut cached = cache.lock();
        let names_of = |keys: &BTreeMap<String, String>| keys.keys().cloned().collect::<Vec<_>>().join(",");
        if names_of(&cached.value) != names_of(&out) {
            log::info!(
                "[claude-code] {} vault key(s) in the agent's environment{}{}",
                out.len(),
                if blocked {
                    " (none: get_key is denied in Tool Permissions)"
                } else {
                    ""
                },
                if skipped.is_empty() {
                    String::new()
                } else {
                    format!(" (too big or not text, left to tarsee_get_key: {})", skipped.join(", "))
                }
            );
        }
        // A denied answer isn't kept as fresh: allowing get_key again takes effect on the next turn.
        *cached = AgentEnvCache {
            at: if blocked { 0 } else { now },
            value: out.clone(),
        };
    }
    out
}

/// For tests: forget the cached keys (the JS `__resetAgentEnv`).
pub fn reset_agent_env(app: &App) {
    *cache_of(app).lock() = AgentEnvCache {
        at: 0,
        value: Arc::new(BTreeMap::new()),
    };
}

#[cfg(test)]
mod tests {
    //! Ports of `test/agent-vault-env.test.js` and `test/agent-vault-env-cache.test.js`.
    use super::*;
    use crate::lib::key_vault::set_key;
    use crate::testkit::{TestApp, test_app, test_app_with_env};

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    // --- the vault's keys in the agent's environment (test/agent-vault-env.test.js) ---
    // Every key named like an environment variable, except what would change Claude's login or billing, how
    // programs run, or what Tarsee already set; none at all when get_key is denied in Tool Permissions or
    // TARSEE_AGENT_ENV_KEYS is "off".

    fn vault() -> BTreeMap<String, String> {
        map(&[
            ("OPENAI_API_KEY", &format!("sk-{}", "test-1")),
            ("RESEND_API_KEY", " re_test_2 "),
            ("GITHUB_TOKEN", &format!("ghp_{}", "test")),
            ("ANTHROPIC_API_KEY", &format!("sk-ant-{}", "test")),
            ("CLAUDE_CODE_OAUTH_TOKEN", "oat-test"),
            ("TARSEE_TIMEZONE", "UTC"),
            ("NODE_OPTIONS", "--require /tmp/x.js"),
            ("PATH", "/evil"),
            ("HTTPS_PROXY", "http://evil"),
            ("LD_PRELOAD", "/evil.so"),
            ("PYTHONSTARTUP", "/evil.py"),
            ("BASH_ENV", "/evil.sh"),
            ("lower_case", "x"),
            ("NOT-A-NAME", "x"),
            ("EMPTY_ONE", "  "),
            ("ALREADY_SET", "vault"),
        ])
    }

    /// `agentVaultEnv({ get, list, env })` over the test vault above.
    fn from_test_vault(t: &TestApp, env: &BTreeMap<String, String>, denied: bool) -> BTreeMap<String, String> {
        let vault = vault();
        let get = |name: &str| Ok(vault.get(name).cloned());
        let list = || Ok(vault.keys().cloned().collect());
        let denied = || denied;
        (*agent_vault_env(
            t,
            AgentVaultEnvOptions {
                get: Some(&get),
                list: Some(&list),
                env: Some(env),
                denied: Some(&denied),
                ..Default::default()
            },
        ))
        .clone()
    }

    #[test]
    fn every_key_named_like_an_environment_variable_trimmed_the_rest_left_out() {
        let t = test_app();
        let env = from_test_vault(&t, &map(&[("ALREADY_SET", "tarsee")]), false);
        assert_eq!(
            env,
            map(&[
                ("OPENAI_API_KEY", &format!("sk-{}", "test-1")),
                ("RESEND_API_KEY", "re_test_2"),
                ("GITHUB_TOKEN", &format!("ghp_{}", "test")),
            ])
        );
    }

    #[test]
    fn tarsee_agent_env_keys_names_the_keys_instead_with_the_same_limits_off_gives_none() {
        let t = test_app();
        assert_eq!(
            from_test_vault(
                &t,
                &map(&[("TARSEE_AGENT_ENV_KEYS", " OPENAI_API_KEY , ANTHROPIC_API_KEY,MISSING")]),
                false
            ),
            map(&[("OPENAI_API_KEY", &format!("sk-{}", "test-1"))])
        );
        assert_eq!(
            from_test_vault(&t, &map(&[("TARSEE_AGENT_ENV_KEYS", "off")]), false),
            map(&[])
        );
        // "off" in any case, with spaces around it.
        assert_eq!(
            from_test_vault(&t, &map(&[("TARSEE_AGENT_ENV_KEYS", " OFF ")]), false),
            map(&[])
        );
    }

    #[test]
    fn a_value_too_big_for_an_environment_string_or_with_a_nul_in_it_stays_out_the_agent_must_still_start() {
        let t = test_app();
        let big = map(&[
            ("HUGE_BUNDLE", &"x".repeat(140 * 1024)),
            ("NUL_ONE", "a\0b"),
            ("OK_ONE", "fine"),
            // Exactly 32 KB still goes in; one more does not. Counted in UTF-16 units, as the JS counted.
            ("AT_THE_LIMIT", &"y".repeat(32 * 1024)),
            ("OVER_BY_ONE", &"y".repeat(32 * 1024 + 1)),
            ("WIDE_OVER", &"🐒".repeat(16 * 1024 + 1)),
        ]);
        let get = |name: &str| Ok(big.get(name).cloned());
        let list = || Ok(big.keys().cloned().collect());
        let env = agent_vault_env(
            &t,
            AgentVaultEnvOptions {
                get: Some(&get),
                list: Some(&list),
                env: Some(&map(&[])),
                ..Default::default()
            },
        );
        assert_eq!(
            *env,
            map(&[("OK_ONE", "fine"), ("AT_THE_LIMIT", &"y".repeat(32 * 1024))])
        );
    }

    #[test]
    fn none_when_the_owner_denied_get_key_or_when_the_vault_cant_be_read() {
        let t = test_app();
        assert_eq!(from_test_vault(&t, &map(&[]), true), map(&[]));

        let vault = vault();
        let empty_env = map(&[]);
        let locked_get = |_: &str| -> anyhow::Result<Option<String>> { Err(anyhow::anyhow!("locked")) };
        let list = || Ok(vault.keys().cloned().collect());
        assert_eq!(
            *agent_vault_env(
                &t,
                AgentVaultEnvOptions {
                    get: Some(&locked_get),
                    list: Some(&list),
                    env: Some(&empty_env),
                    ..Default::default()
                }
            ),
            map(&[])
        );
        let get = |name: &str| Ok(vault.get(name).cloned());
        let locked_list = || -> anyhow::Result<Vec<String>> { Err(anyhow::anyhow!("locked")) };
        assert_eq!(
            *agent_vault_env(
                &t,
                AgentVaultEnvOptions {
                    get: Some(&get),
                    list: Some(&locked_list),
                    env: Some(&empty_env),
                    ..Default::default()
                }
            ),
            map(&[])
        );
    }

    #[test]
    fn names_given_by_the_caller_are_used_instead_of_the_list_and_the_setting() {
        let t = test_app();
        let vault = vault();
        let get = |name: &str| Ok(vault.get(name).cloned());
        let env = map(&[("TARSEE_AGENT_ENV_KEYS", "GITHUB_TOKEN")]);
        let given = agent_vault_env(
            &t,
            AgentVaultEnvOptions {
                names: Some(vec![
                    " RESEND_API_KEY ".into(),
                    "PATH".into(),
                    "RESEND_API_KEY".into(),
                    String::new(),
                ]),
                get: Some(&get),
                env: Some(&env),
                ..Default::default()
            },
        );
        assert_eq!(*given, map(&[("RESEND_API_KEY", "re_test_2")]));
        assert!(AGENT_ENV_KEEP_OUT.is_match("PYTHONPATH"));
        assert!(!AGENT_ENV_KEEP_OUT.is_match("MY_NODE_KEY"));
    }

    // --- agentVaultEnv's cache (test/agent-vault-env-cache.test.js) ---
    // agent_vault_env's one-minute cache holds the answer for the default call only: the live turn's call against
    // Tarsee's own environment. A call that passes its own `env` (engine_env's handoff) compares the vault against
    // a different environment, so it must neither read that cache nor write it; and the owner denying get_key in
    // Tool Permissions applies at once, cache or not.
    // Uses the real vault in a temporary data folder, with obvious fake keys.

    fn canary(which: &str) -> String {
        format!("sk-{}-{which}", "test-canary")
    }

    fn app_with_vault() -> TestApp {
        let t = test_app();
        set_key(&t, "TEST_SCRIPT_KEY", &canary("script"), None).unwrap();
        set_key(&t, "TEST_SHARED_KEY", &canary("shared"), None).unwrap();
        t
    }

    fn both() -> BTreeMap<String, String> {
        map(&[
            ("TEST_SCRIPT_KEY", &canary("script")),
            ("TEST_SHARED_KEY", &canary("shared")),
        ])
    }

    fn default_call(t: &TestApp) -> Arc<BTreeMap<String, String>> {
        agent_vault_env(t, AgentVaultEnvOptions::default())
    }

    #[test]
    fn the_default_call_reads_the_vault_and_caches_it() {
        let t = app_with_vault();
        let a = default_call(&t);
        assert_eq!(*a, both());
        assert!(
            Arc::ptr_eq(&default_call(&t), &a),
            "a second call within the minute is the cached answer"
        );
    }

    #[test]
    fn a_call_with_its_own_env_isnt_answered_from_the_default_calls_cache() {
        let t = app_with_vault();
        default_call(&t);
        // TEST_SHARED_KEY is set in this environment, so it must stay out (names already set win).
        let own_env = map(&[("TEST_SHARED_KEY", "set-by-the-host")]);
        let own = agent_vault_env(
            &t,
            AgentVaultEnvOptions {
                env: Some(&own_env),
                ..Default::default()
            },
        );
        assert_eq!(*own, map(&[("TEST_SCRIPT_KEY", &canary("script"))]));
    }

    #[test]
    fn a_call_with_its_own_env_doesnt_fill_the_cache_the_default_call_reads() {
        let t = app_with_vault();
        let own_env = map(&[("TEST_SHARED_KEY", "set-by-the-host")]);
        agent_vault_env(
            &t,
            AgentVaultEnvOptions {
                env: Some(&own_env),
                ..Default::default()
            },
        );
        assert_eq!(*default_call(&t), both());
    }

    #[test]
    fn denying_get_key_applies_at_once_even_with_a_cached_answer_and_allowing_it_again_doesnt_wait_a_minute() {
        let t = app_with_vault();
        default_call(&t);
        let calls = std::cell::Cell::new(0);
        let deny = || {
            calls.set(calls.get() + 1);
            true
        };
        let denied = agent_vault_env(
            &t,
            AgentVaultEnvOptions {
                denied: Some(&deny),
                ..Default::default()
            },
        );
        assert_eq!(*denied, map(&[]));
        assert_eq!(calls.get(), 1, "denied() is asked on every call");
        let allow = || false;
        let allowed = agent_vault_env(
            &t,
            AgentVaultEnvOptions {
                denied: Some(&allow),
                ..Default::default()
            },
        );
        assert_eq!(*allowed, both());
    }

    #[test]
    fn the_cache_lasts_a_minute_and_can_be_forgotten() {
        let t = app_with_vault();
        let clock = t.app.set(Clock::manual(1_794_000_000_000));
        let first = default_call(&t);
        set_key(&t, "TEST_LATER_KEY", &canary("later"), None).unwrap();

        clock.advance(59_999);
        assert!(Arc::ptr_eq(&default_call(&t), &first), "still the minute's answer");
        clock.advance(1);
        let second = default_call(&t);
        assert_eq!(second.len(), 3, "the vault is read again after a minute");
        assert_eq!(second.get("TEST_LATER_KEY"), Some(&canary("later")));

        // Forgotten: the next call reads the vault whatever the time.
        crate::lib::key_vault::delete_key(&t, "TEST_LATER_KEY").unwrap();
        assert_eq!(default_call(&t).len(), 3);
        reset_agent_env(&t);
        assert_eq!(*default_call(&t), both());

        // The time a caller passes is the one that counts.
        set_key(&t, "TEST_LATER_KEY", &canary("later"), None).unwrap();
        let at = |now: i64| {
            agent_vault_env(
                &t,
                AgentVaultEnvOptions {
                    now: Some(now),
                    ..Default::default()
                },
            )
            .len()
        };
        assert_eq!(at(clock.now_ms() + 59_999), 2);
        assert_eq!(at(clock.now_ms() + 60_000), 3);
    }

    #[test]
    fn the_default_call_compares_against_the_apps_own_environment() {
        let t = test_app_with_env([("TEST_SHARED_KEY", "set-by-the-host"), ("TARSEE_AGENT_ENV_KEYS", "")]);
        set_key(&t, "TEST_SCRIPT_KEY", &canary("script"), None).unwrap();
        set_key(&t, "TEST_SHARED_KEY", &canary("shared"), None).unwrap();
        assert_eq!(*default_call(&t), map(&[("TEST_SCRIPT_KEY", &canary("script"))]));
        // Nothing was put into the app's environment.
        assert_eq!(t.env().get("TEST_SCRIPT_KEY"), None);

        let off = test_app_with_env([("TARSEE_AGENT_ENV_KEYS", "off")]);
        set_key(&off, "TEST_SCRIPT_KEY", &canary("script"), None).unwrap();
        assert_eq!(*default_call(&off), map(&[]));
    }

    #[test]
    fn a_key_the_vault_cannot_decrypt_stays_out() {
        let t = test_app_with_env([("ENCRYPTION_KEY", "agent-env-test-key-not-a-secret")]);
        set_key(&t, "GOOD_KEY", "good-value", None).unwrap();
        std::fs::write(
            crate::lib::key_vault::vault_file(&t),
            r#"{"GOOD_KEY":{"value":"good-value"},"BROKEN_KEY":{"value":"enc:v1:bad"}}"#,
        )
        .unwrap();
        assert_eq!(*default_call(&t), map(&[("GOOD_KEY", "good-value")]));
    }

    /// An app whose environment matches names whatever their case (Windows) or only in their own case (elsewhere),
    /// on whichever system the test runs.
    fn app_with_names(ignore_case: bool, pairs: &[(&str, &str)]) -> (App, tempfile::TempDir) {
        let dir = crate::testkit::tmp_dir();
        let env = crate::env::Env::new().with_case_insensitive_names(ignore_case);
        env.set("TARSEE_STATE_DIR", dir.path().to_string_lossy().to_string());
        for (name, value) in pairs {
            env.set(*name, *value);
        }
        let config = crate::config::Config::load(&env);
        let db = crate::db::Db::open(&config.db_path).unwrap();
        let app = App::with_fetch(config, env, db, crate::testkit::FakeFetch::new());
        (app, dir)
    }

    #[test]
    fn on_windows_a_name_the_system_set_in_another_case_still_wins() {
        let set_by_the_host = [("Test_Shared_Key", "set-by-the-host")];
        // Windows: `process.env.TEST_SHARED_KEY` finds Test_Shared_Key, so the vault's key stays out.
        let (windows, _windows_dir) = app_with_names(true, &set_by_the_host);
        set_key(&windows, "TEST_SCRIPT_KEY", &canary("script"), None).unwrap();
        set_key(&windows, "TEST_SHARED_KEY", &canary("shared"), None).unwrap();
        assert_eq!(
            *agent_vault_env(&windows, AgentVaultEnvOptions::default()),
            map(&[("TEST_SCRIPT_KEY", &canary("script"))])
        );
        // A caller's own environment is a plain map there too: only the name as written counts.
        let own_env = map(&[("Test_Shared_Key", "set-by-the-host")]);
        let own = agent_vault_env(
            &windows,
            AgentVaultEnvOptions {
                env: Some(&own_env),
                ..Default::default()
            },
        );
        assert_eq!(*own, both());

        // Elsewhere the two names are two variables, and the key goes in.
        let (elsewhere, _elsewhere_dir) = app_with_names(false, &set_by_the_host);
        set_key(&elsewhere, "TEST_SCRIPT_KEY", &canary("script"), None).unwrap();
        set_key(&elsewhere, "TEST_SHARED_KEY", &canary("shared"), None).unwrap();
        assert_eq!(*agent_vault_env(&elsewhere, AgentVaultEnvOptions::default()), both());

        // The setting is found the same way: "off" under a name in another case switches it off on Windows only.
        let off = [("Tarsee_Agent_Env_Keys", "off")];
        let (windows_off, _windows_off_dir) = app_with_names(true, &off);
        set_key(&windows_off, "TEST_SCRIPT_KEY", &canary("script"), None).unwrap();
        assert_eq!(
            *agent_vault_env(&windows_off, AgentVaultEnvOptions::default()),
            map(&[])
        );
        let (elsewhere_off, _elsewhere_off_dir) = app_with_names(false, &off);
        set_key(&elsewhere_off, "TEST_SCRIPT_KEY", &canary("script"), None).unwrap();
        assert_eq!(
            *agent_vault_env(&elsewhere_off, AgentVaultEnvOptions::default()),
            map(&[("TEST_SCRIPT_KEY", &canary("script"))])
        );
        for app in [windows, elsewhere, windows_off, elsewhere_off] {
            // Closed before its folder is removed (Windows cannot delete an open file).
            app.db().close();
        }
    }
}
