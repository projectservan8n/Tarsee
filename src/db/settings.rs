//! Port of `src/db/settings.js`: the key-value settings store. The store itself is not ported yet: work package S1
//! (docs/rust-port/PLAN.md). What is here already is the [`Settings`] trait, which everything below the store uses,
//! and the lookup of a provider's key ([`get_key_with_source`] and what it is made of), which the AI layer needs
//! before the store is ported.

use serde_json::Value;

use crate::ai::provider_registry::{ProviderKind, get_provider, strip_one_quote_each_side};
use crate::env::Env;
use crate::util::js;

/// The settings store, as the code that only reads and writes settings sees it.
///
/// The Node code handed the store itself around and called `store.get(key)` on it, and its tests often passed a
/// plain object with a `get` instead. This trait is that: [`SettingsStore`](self) (package S1) implements it over
/// the database, and `testkit::MemorySettings` implements it over a map. Take `&dyn Settings` wherever the Node
/// function took `store`, `settings` or `settingsStore` and used only these calls.
pub trait Settings: Send + Sync {
    /// The setting's value, or `None` when it is not set (the JS `null`). Stored JSON comes back parsed, a stored
    /// plain string as a string, and secrets decrypted.
    fn get(&self, key: &str) -> Option<Value>;

    /// Saves a value (`store.set(key, value)`). Secrets are encrypted at rest by the real store.
    fn set(&self, key: &str, value: Value) -> anyhow::Result<()>;

    /// Deletes a setting; true if there was one.
    fn delete(&self, key: &str) -> bool;

    /// Every setting whose key starts with `prefix`, ordered by key, values as [`get`](Self::get) gives them.
    fn get_by_prefix(&self, prefix: &str) -> Vec<(String, Value)>;

    /// The value when it is a string (not empty), else `None`: the common `store.get(key) || null` on a text setting.
    fn get_string(&self, key: &str) -> Option<String> {
        match self.get(key) {
            Some(Value::String(text)) if !text.is_empty() => Some(text),
            _ => None,
        }
    }
}

// --- Provider keys ---
//
// The key-lookup part of `src/db/settings.js`, ported with package A1 because the AI layer needs a provider's key
// before the store itself (package S1) is ported. In the JS these were methods of `SettingsStore` and helpers
// beside it; here they are functions that take the settings and the environment, and `SettingsStore` is built on
// top of them.

/// Whether a value holds nothing: missing, null, or a string of nothing but spaces. A secret with such a value is
/// no key at all, so it is deleted rather than saved (POST /api/settings/general, the boot fixup
/// removeEmptySecrets) and never shown as a saved one (all()). false and 0 are values.
pub fn is_empty_setting(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => js::trim(text).is_empty(),
        Some(_) => false,
    }
}

/// Whether a settings key is an AI's key slot (`ai.<id>.apiKey`, a storage id like claude-code included).
pub fn is_ai_key_slot(key: &str) -> bool {
    key.strip_prefix("ai.")
        .and_then(|rest| rest.strip_suffix(".apiKey"))
        .is_some_and(|id| !id.is_empty() && !id.contains('.') && get_provider(id).is_some())
}

/// A key as stored or as Railway hands it over: whitespace and one pair of wrapping quotes removed. "" is no key.
pub fn clean_key(value: &str) -> Option<String> {
    let key = js::trim(strip_one_quote_each_side(js::trim(value)));
    (!key.is_empty()).then(|| key.to_string())
}

/// Where a key is kept: its Settings slot and the environment variable it may come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyPlace {
    /// The setting the key is saved in (`ai.<storage id>.apiKey`).
    pub slot: String,
    /// The environment variable the key may come from; `None` for a provider that has none.
    pub env_name: Option<String>,
    /// True for a sign-in plan, which has no key at all.
    pub keyless: bool,
}

/// Where a key is kept: its Settings slot and the environment variable it may come from. The provider registry
/// names both for its providers (any spelling or alias: "claude-code" is the Claude plan), and a sign-in plan
/// (claude, chatgpt) is keyless, so a stray CLAUDE_API_KEY can't hand it one. Any other id (Voice's elevenlabs) is
/// `ai.<id>.apiKey` and `<ID>_API_KEY`.
pub fn key_place(provider_id: &str) -> KeyPlace {
    if let Some(p) = get_provider(provider_id) {
        return KeyPlace {
            slot: format!("ai.{}.apiKey", p.storage_id),
            env_name: p.env_key.map(String::from),
            keyless: p.kind == ProviderKind::Subscription,
        };
    }
    // Anything but A to Z and 0 to 9 becomes "_", once for each UTF-16 unit, as the JS replace counted them.
    let name: String = provider_id
        .to_uppercase()
        .chars()
        .flat_map(|c| {
            let keep = c.is_ascii_uppercase() || c.is_ascii_digit();
            std::iter::repeat_n(if keep { c } else { '_' }, if keep { 1 } else { c.len_utf16() })
        })
        .collect();
    KeyPlace {
        slot: format!("ai.{provider_id}.apiKey"),
        env_name: Some(format!("{name}_API_KEY")),
        keyless: false,
    }
}

/// The last 4 characters of a key, the only part that is ever shown or logged.
pub fn key_hint(key: &str) -> Option<String> {
    if key.is_empty() {
        return None;
    }
    Some(if js::utf16_len(key) >= 8 {
        format!("…{}", js::utf16_tail(key, 4))
    } else {
        "…".to_string()
    })
}

/// A provider's API key and where it came from.
#[derive(Clone, PartialEq, Eq, Default, serde::Serialize)]
pub struct KeyWithSource {
    pub key: Option<String>,
    /// "settings", or "env:<NAME>" for the environment variable it came from.
    pub source: Option<String>,
    /// The last 4 characters only ("…a1b2"), for display and logs.
    pub hint: Option<String>,
}

impl std::fmt::Debug for KeyWithSource {
    /// Never the key itself: a debug print must not put one in a log.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyWithSource")
            .field("key", &self.key.as_ref().map(|_| "[REDACTED]"))
            .field("source", &self.source)
            .field("hint", &self.hint)
            .finish()
    }
}

/// `String(value)` for what a settings slot holds: a key that looks like a number comes back from the store as
/// one.
fn stored_text(value: &Value) -> Option<String> {
    Some(match value {
        Value::Null => return None,
        Value::String(text) => text.clone(),
        Value::Number(n) => js::number_to_string(n.as_f64().unwrap_or(0.0)),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| stored_text(item).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    })
}

/// A provider's API key and where it came from. Encrypted Settings first (`ai.<id>.apiKey`), then the environment
/// (Railway): the provider's own variable (`<ID>_API_KEY`; Local AI's is TARSEE_LOCAL_AI_KEY). Sign-in plans
/// (claude, claude-code, chatgpt) have no key at all. Quotes and whitespace Railway sometimes adds are trimmed.
///
/// `provider_id` is e.g. "openrouter", "openai", "elevenlabs". The hint shows the last 4 characters only ("…a1b2"),
/// for display and logs.
pub fn get_key_with_source(settings: &dyn Settings, env: &Env, provider_id: &str) -> KeyWithSource {
    key_with_source(settings, env, provider_id, None)
}

/// [`get_key_with_source`] with the environment variable to read given (the JS `{ envName }` option): that name
/// and no other, or `None` for Settings only.
pub fn get_key_with_source_from(
    settings: &dyn Settings,
    env: &Env,
    provider_id: &str,
    env_name: Option<&str>,
) -> KeyWithSource {
    key_with_source(settings, env, provider_id, Some(env_name))
}

/// `env_name`: `None` reads the provider's own variable, `Some(None)` no variable, `Some(Some(name))` that one.
fn key_with_source(
    settings: &dyn Settings,
    env: &Env,
    provider_id: &str,
    env_name: Option<Option<&str>>,
) -> KeyWithSource {
    let none = KeyWithSource::default();
    if provider_id.is_empty() {
        return none;
    }
    let place = key_place(provider_id);
    // A sign-in plan has no key, saved or in the environment (its slot only ever held the old wizard's
    // placeholder).
    if place.keyless {
        return none;
    }

    let saved = settings
        .get(&place.slot)
        .and_then(|value| stored_text(&value))
        .and_then(|text| clean_key(&text));
    if let Some(saved) = saved {
        return KeyWithSource {
            hint: key_hint(&saved),
            key: Some(saved),
            source: Some("settings".to_string()),
        };
    }

    let name = match env_name {
        None => place.env_name,
        Some(name) => name.map(String::from),
    };
    let Some(name) = name.filter(|name| !name.is_empty()) else {
        return none;
    };
    if let Some(from_env) = env.get(&name).and_then(|value| clean_key(&value)) {
        return KeyWithSource {
            hint: key_hint(&from_env),
            key: Some(from_env),
            source: Some(format!("env:{name}")),
        };
    }
    none
}

/// Get an API key for a provider: Settings first, env second. Works for any provider: openai, gemini, anthropic,
/// elevenlabs, etc.
pub fn get_api_key(settings: &dyn Settings, env: &Env, provider_id: &str) -> Option<String> {
    get_key_with_source(settings, env, provider_id).key
}

#[cfg(test)]
mod tests {
    //! Port of the cases of `test/settings-keys.test.js` that exercise only the key lookup
    //! ("getKeyWithSource: where a provider's key comes from"), over a store that lives in memory. The cases that
    //! need the store itself (encryption at rest, the audit log, the boot fixups, the active provider) come with
    //! package S1.
    //!
    //! Every key here is an obvious fake, put together from parts.
    use serde_json::json;

    use super::*;
    use crate::ai::provider_registry::PROVIDERS;
    use crate::testkit::MemorySettings;

    fn fake(parts: &[&str]) -> String {
        parts.concat()
    }

    /// The environment variables a provider key could arrive in (Railway), each given a fake key.
    fn env_canaries() -> Vec<(&'static str, String)> {
        vec![
            ("OPENROUTER_API_KEY", fake(&["sk-or-", "v1-test-canary-Envr0uter9Q"])),
            ("OPENAI_API_KEY", fake(&["sk-", "test-canary-EnvOpenai7Wx"])),
            ("DEEPSEEK_API_KEY", fake(&["sk-", "test-canary-EnvDeepseek3Kp"])),
            ("ANTHROPIC_API_KEY", fake(&["sk-ant-", "api03-test-canary-EnvAnth5Rz"])),
            ("TARSEE_LOCAL_AI_KEY", fake(&["test-", "canary-EnvLocal8Mn"])),
        ]
    }

    fn canary(name: &str) -> String {
        env_canaries()
            .into_iter()
            .find(|(n, _)| *n == name)
            .map(|(_, key)| key)
            .unwrap()
    }

    fn found(key: &str, source: &str, hint: &str) -> KeyWithSource {
        KeyWithSource {
            key: Some(key.to_string()),
            source: Some(source.to_string()),
            hint: Some(hint.to_string()),
        }
    }

    #[test]
    fn encrypted_settings_first_then_the_environment_quotes_and_whitespace_are_trimmed() {
        // That the saved key is encrypted at rest is the store's own business (package S1).
        let store = MemorySettings::new();
        let saved = fake(&["sk-or-", "v1-test-canary-Saved6Hj2"]);
        store
            .set("ai.openrouter.apiKey", json!(format!("  \"{saved}\"\n")))
            .unwrap();
        let env = Env::from_pairs([("OPENROUTER_API_KEY", canary("OPENROUTER_API_KEY"))]);
        assert_eq!(
            get_key_with_source(&store, &env, "openrouter"),
            found(&saved, "settings", "…6Hj2")
        );
        store.delete("ai.openrouter.apiKey");
        assert_eq!(
            get_key_with_source(&store, &env, "openrouter"),
            found(&canary("OPENROUTER_API_KEY"), "env:OPENROUTER_API_KEY", "…er9Q")
        );
    }

    #[test]
    fn an_environment_value_wrapped_in_quotes_and_spaces_as_railway_sometimes_stores_it_is_trimmed() {
        let store = MemorySettings::new();
        let key = fake(&["sk-", "test-canary-Quoted5Tb1"]);
        let env = Env::from_pairs([("OPENAI_API_KEY", format!(" '{key}' \n"))]);
        assert_eq!(
            get_key_with_source(&store, &env, "openai"),
            found(&key, "env:OPENAI_API_KEY", "…5Tb1")
        );
        assert_eq!(
            get_api_key(&store, &env, "openai").as_deref(),
            Some(key.as_str()),
            "getApiKey (voice) no longer matches"
        );
    }

    #[test]
    fn no_key_anywhere_key_source_and_hint_are_null() {
        let store = MemorySettings::new();
        let env = Env::new();
        assert_eq!(get_key_with_source(&store, &env, "deepseek"), KeyWithSource::default());
        // The JS took null here; no provider at all is the empty id.
        assert_eq!(get_key_with_source(&store, &env, ""), KeyWithSource::default());
        assert_eq!(get_api_key(&store, &env, "deepseek"), None);
        assert_eq!(
            serde_json::to_string(&KeyWithSource::default()).unwrap(),
            r#"{"key":null,"source":null,"hint":null}"#
        );
    }

    #[test]
    fn a_blank_saved_value_does_not_hide_the_environments_key() {
        let store = MemorySettings::from_pairs([("ai.deepseek.apiKey", json!("   "))]);
        let env = Env::from_pairs([("DEEPSEEK_API_KEY", canary("DEEPSEEK_API_KEY"))]);
        assert_eq!(
            get_key_with_source(&store, &env, "deepseek").source.as_deref(),
            Some("env:DEEPSEEK_API_KEY")
        );
    }

    #[test]
    fn each_provider_reads_its_own_variable_local_ais_is_tarsee_local_ai_key() {
        let store = MemorySettings::new();
        let env = Env::from_pairs(env_canaries());
        let source = |id: &str| get_key_with_source(&store, &env, id).source;
        assert_eq!(source("anthropic").as_deref(), Some("env:ANTHROPIC_API_KEY"));
        assert_eq!(source("deepseek").as_deref(), Some("env:DEEPSEEK_API_KEY"));
        assert_eq!(source("openai").as_deref(), Some("env:OPENAI_API_KEY"));
        assert_eq!(source("openrouter").as_deref(), Some("env:OPENROUTER_API_KEY"));
        assert_eq!(
            get_key_with_source(&store, &env, "local"),
            found(&canary("TARSEE_LOCAL_AI_KEY"), "env:TARSEE_LOCAL_AI_KEY", "…l8Mn")
        );
        assert_eq!(
            get_key_with_source_from(&store, &env, "local", Some("SOME_OTHER_NAME")).source,
            None,
            "an explicit env name is the only one read"
        );
        // Named explicitly, any variable can be the one; no name at all is Settings only.
        assert_eq!(
            get_key_with_source_from(&store, &env, "local", Some("OPENAI_API_KEY"))
                .source
                .as_deref(),
            Some("env:OPENAI_API_KEY")
        );
        assert_eq!(
            get_key_with_source_from(&store, &env, "openai", None),
            KeyWithSource::default()
        );
    }

    #[test]
    fn the_plan_providers_take_no_key_from_the_environment() {
        let store = MemorySettings::from_pairs([("ai.claude-code.apiKey", json!("subscription"))]);
        let env = Env::from_pairs(env_canaries());
        env.set("CLAUDE_API_KEY", fake(&["sk-", "test-canary-Stray1Cl"]));
        env.set("CHATGPT_API_KEY", fake(&["sk-", "test-canary-Stray2Cg"]));
        for id in ["claude-code", "claude", "chatgpt"] {
            assert_eq!(get_key_with_source(&store, &env, id), KeyWithSource::default(), "{id}");
        }
    }

    #[test]
    fn the_registry_names_each_providers_variable_and_slot_whatever_the_ids_spelling_or_alias() {
        let store = MemorySettings::new();
        let env = Env::from_pairs(env_canaries());
        // Variables a key must never come from: a plan's or Local AI's id with _API_KEY on the end.
        for (name, key) in [
            ("CLAUDE_API_KEY", ["sk-", "test-canary-Stray1Cl"]),
            ("CLAUDE_CODE_API_KEY", ["sk-", "test-canary-Stray3Cc"]),
            ("CHATGPT_API_KEY", ["sk-", "test-canary-Stray2Cg"]),
            ("LOCAL_API_KEY", ["sk-", "test-canary-Stray4Lo"]),
        ] {
            env.set(name, fake(&key));
        }
        for p in PROVIDERS.iter() {
            for spelling in [
                p.id.to_string(),
                p.storage_id.to_string(),
                p.id.to_uppercase(),
                p.storage_id.to_uppercase(),
            ] {
                let got = get_key_with_source(&store, &env, &spelling);
                match p.env_key.filter(|_| p.kind != ProviderKind::Subscription) {
                    None => assert_eq!(got, KeyWithSource::default(), "{spelling} is a sign-in plan"),
                    Some(name) => assert_eq!(got.source, Some(format!("env:{name}")), "{spelling} reads {name}"),
                }
            }
        }
        // A saved key is found, and cleared, in the provider's own slot whatever the spelling.
        let saved = fake(&["sk-or-", "v1-test-canary-Slot7Kq2"]);
        store.set("ai.openrouter.apiKey", json!(saved)).unwrap();
        assert_eq!(
            get_key_with_source(&store, &env, "OpenRouter"),
            found(&saved, "settings", "…7Kq2")
        );
        // The store's clearKey (package S1) deletes this very slot.
        assert!(store.delete(&key_place("OPENROUTER").slot));
        assert_eq!(
            get_key_with_source(&store, &env, "openrouter").source.as_deref(),
            Some("env:OPENROUTER_API_KEY")
        );
        // A key the registry doesn't know (Voice's ElevenLabs) is still <ID>_API_KEY.
        let env = Env::from_pairs([("ELEVENLABS_API_KEY", fake(&["sk-", "test-canary-Eleven5Lb"]))]);
        assert_eq!(
            get_key_with_source(&store, &env, "elevenlabs").source.as_deref(),
            Some("env:ELEVENLABS_API_KEY")
        );
    }

    #[test]
    fn the_hint_never_shows_more_than_the_last_4_characters() {
        let store = MemorySettings::new();
        let env = Env::new();
        store.set("ai.openai.apiKey", json!("abc123")).unwrap();
        assert_eq!(get_key_with_source(&store, &env, "openai").hint.as_deref(), Some("…"));
        store
            .set("ai.openai.apiKey", json!(fake(&["sk-", "test-canary-Hint0Ab9"])))
            .unwrap();
        assert_eq!(
            get_key_with_source(&store, &env, "openai").hint.as_deref(),
            Some("…0Ab9")
        );
    }

    // --- What the JS suite reached only through the store ---

    #[test]
    fn a_key_that_reads_as_a_number_comes_back_from_the_store_as_one_and_is_still_the_key() {
        // The store hands back parsed JSON: an all-digit key shorter than 15 digits arrives as a number.
        let store = MemorySettings::from_pairs([("ai.elevenlabs.apiKey", json!(12345678))]);
        assert_eq!(
            get_key_with_source(&store, &Env::new(), "elevenlabs"),
            found("12345678", "settings", "…5678")
        );
        let store = MemorySettings::from_pairs([("ai.elevenlabs.apiKey", json!(null))]);
        assert_eq!(
            get_key_with_source(&store, &Env::new(), "elevenlabs"),
            KeyWithSource::default()
        );
    }

    #[test]
    fn a_key_place_is_the_providers_slot_and_variable_or_the_ids_own() {
        assert_eq!(
            key_place("claude"),
            KeyPlace {
                slot: "ai.claude-code.apiKey".to_string(),
                env_name: None,
                keyless: true
            }
        );
        assert_eq!(key_place(" Claude-Code ").slot, "ai.claude-code.apiKey");
        assert_eq!(
            key_place("local"),
            KeyPlace {
                slot: "ai.local.apiKey".to_string(),
                env_name: Some("TARSEE_LOCAL_AI_KEY".to_string()),
                keyless: false
            }
        );
        assert_eq!(
            key_place("my-voice.v2"),
            KeyPlace {
                slot: "ai.my-voice.v2.apiKey".to_string(),
                env_name: Some("MY_VOICE_V2_API_KEY".to_string()),
                keyless: false
            }
        );
        // Each UTF-16 unit that is not A to Z or 0 to 9 is one "_": two for a character outside the basic plane.
        assert_eq!(key_place("é🐒x").env_name.as_deref(), Some("___X_API_KEY"));
    }

    #[test]
    fn a_key_is_cleaned_of_space_and_one_pair_of_quotes_and_hinted_by_its_last_four() {
        assert_eq!(clean_key("  abc  ").as_deref(), Some("abc"));
        assert_eq!(clean_key("\" abc \"").as_deref(), Some("abc"));
        assert_eq!(clean_key("'abc\"").as_deref(), Some("abc"));
        assert_eq!(clean_key("\"\"abc\"\"").as_deref(), Some("\"abc\""));
        assert_eq!(clean_key(""), None);
        assert_eq!(clean_key("  \n"), None);
        assert_eq!(clean_key("\"\""), None);
        assert_eq!(clean_key("' '"), None);
        // A byte order mark is space to JavaScript, in front of a key and inside its quotes.
        assert_eq!(clean_key("\u{FEFF}\"\u{FEFF}abc\"").as_deref(), Some("abc"));
        assert!(is_empty_setting(Some(&json!("\u{FEFF}\u{A0}"))));
        assert_eq!(key_hint(""), None);
        assert_eq!(key_hint("1234567").as_deref(), Some("…"));
        assert_eq!(key_hint("12345678").as_deref(), Some("…5678"));
        // Counted as JavaScript counts: the tarsier is two units, so this key is 8 long and its last 4 are "x🐒y".
        assert_eq!(key_hint("abcdx🐒y").as_deref(), Some("…x🐒y"));
    }

    #[test]
    fn an_ai_key_slot_is_a_known_providers_api_key_setting() {
        for slot in [
            "ai.openai.apiKey",
            "ai.claude-code.apiKey",
            "ai.claude.apiKey",
            "ai.local.apiKey",
            "ai.OpenRouter.apiKey",
        ] {
            assert!(is_ai_key_slot(slot), "{slot}");
        }
        for not in [
            "ai.elevenlabs.apiKey",
            "ai.openai.model",
            "ai.openai.apiKey.old",
            "ai..apiKey",
            "ai.openai.x.apiKey",
            "voice.openai_api_key",
            "xai.openai.apiKey",
            "ai.openai.apikey",
            "",
        ] {
            assert!(!is_ai_key_slot(not), "{not}");
        }
    }

    #[test]
    fn an_empty_setting_is_missing_null_or_blank_text_and_nothing_else() {
        assert!(is_empty_setting(None));
        for empty in [json!(null), json!(""), json!("  \n\t")] {
            assert!(is_empty_setting(Some(&empty)), "{empty}");
        }
        for value in [json!(false), json!(0), json!("x"), json!([]), json!({})] {
            assert!(!is_empty_setting(Some(&value)), "{value}");
        }
    }

    #[test]
    fn a_debug_print_of_a_found_key_never_holds_the_key() {
        let key = fake(&["sk-", "test-canary-Debug4Zq8"]);
        let shown = format!("{:?}", found(&key, "settings", "…4Zq8"));
        assert!(!shown.contains(&key) && !shown.contains("canary"), "{shown}");
        assert!(shown.contains("…4Zq8") && shown.contains("settings"));
    }
}
