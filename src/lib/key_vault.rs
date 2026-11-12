//! Port of `src/lib/key-vault.js`: Key Vault for Tarsee.
//!
//! Encrypted JSON file storing API keys, tokens, and secrets that the bot can access at runtime. Keys are encrypted
//! at rest using the same `ENCRYPTION_KEY` as the settings database.
//!
//! Storage: `<data dir>/vault.json` (encrypted values), e.g. `/data/tarsee/data/vault.json`. The file is the one the
//! Node version wrote: `{ "NAME": { "value", "description", "createdAt", "updatedAt" } }`, two-space indented.
//!
//! Usage: User tells the bot "save my Google Places key as GOOGLE_PLACES" and the bot calls set_key. Later, any
//! tool or subagent can call get_key to retrieve it.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::vault::{VaultError, decrypt, encrypt, is_encrypted, is_encryption_enabled, mask_secret};
use crate::app::App;
use crate::config::env::write_private_file;
use crate::util::js::{now_iso, truthy};

/// Where the vault is kept (the JS `VAULT_FILE`).
pub fn vault_file(app: &App) -> PathBuf {
    app.config().data_dir.join("vault.json")
}

/// What [`set_key`] answers: the key's name, its description and its value masked for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SetKeyResult {
    pub name: String,
    pub description: String,
    pub masked: String,
}

/// One key as [`list_keys`] shows it: never its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub name: String,
    pub description: String,
    pub masked: String,
    /// Absent for an entry written by hand without dates.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// Load the vault from disk: `{ keyName: { value, description, createdAt, updatedAt } }`. A file that is missing,
/// unreadable or not a JSON object is an empty vault.
fn load_vault(app: &App) -> Map<String, Value> {
    let Ok(raw) = fs::read_to_string(vault_file(app)) else {
        return Map::new();
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(vault)) => vault,
        _ => Map::new(),
    }
}

/// Save the vault to disk.
fn save_vault(app: &App, vault: &Map<String, Value>) -> anyhow::Result<()> {
    let path = vault_file(app);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    write_private_file(&path, &serde_json::to_string_pretty(vault)?)?;
    Ok(())
}

/// A text field of an entry, when the entry has one that is not empty.
fn text_field(entry: Option<&Value>, field: &str) -> Option<String> {
    entry?
        .get(field)?
        .as_str()
        .filter(|text| !text.is_empty())
        .map(String::from)
}

/// Set a key in the vault. Value is encrypted at rest.
///
/// - `name`: key name (e.g., "GOOGLE_PLACES_KEY")
/// - `value`: the secret value
/// - `description`: what this key is for; without one, the description the key already had is kept
pub fn set_key(app: &App, name: &str, value: &str, description: Option<&str>) -> anyhow::Result<SetKeyResult> {
    let mut vault = load_vault(app);
    let now = now_iso();
    let existing = vault.get(name);

    let description = description
        .filter(|text| !text.is_empty())
        .map(String::from)
        .or_else(|| text_field(existing, "description"))
        .unwrap_or_default();
    let created_at = text_field(existing, "createdAt").unwrap_or_else(|| now.clone());
    let stored = if is_encryption_enabled(app) {
        encrypt(app, value)
    } else {
        value.to_string()
    };

    vault.insert(
        name.to_string(),
        json!({
            "value": stored,
            "description": description,
            "createdAt": created_at,
            "updatedAt": now,
        }),
    );

    save_vault(app, &vault)?;
    log::info!("[vault] key set: {name}");
    Ok(SetKeyResult {
        name: name.to_string(),
        description,
        masked: mask_secret(value),
    })
}

/// Get a key from the vault. Value is decrypted. `None` if not found.
pub fn get_key(app: &App, name: &str) -> Result<Option<String>, VaultError> {
    let vault = load_vault(app);
    let Some(entry) = vault.get(name).filter(|entry| truthy(entry)) else {
        return Ok(None);
    };

    match entry.get("value").and_then(Value::as_str) {
        Some(value) if is_encrypted(value) => decrypt(app, value).map(Some),
        Some(value) => Ok(Some(value.to_string())),
        None => Ok(None),
    }
}

/// Delete a key from the vault. False when there was none.
pub fn delete_key(app: &App, name: &str) -> anyhow::Result<bool> {
    let mut vault = load_vault(app);
    if !vault.get(name).is_some_and(truthy) {
        return Ok(false);
    }
    // The other keys keep their order in the file, as with the JS `delete`.
    vault.shift_remove(name);
    save_vault(app, &vault)?;
    log::info!("[vault] key deleted: {name}");
    Ok(true)
}

/// List all keys (names + descriptions only, no values).
pub fn list_keys(app: &App) -> Vec<KeyInfo> {
    load_vault(app)
        .iter()
        .map(|(name, entry)| {
            let raw_value = match entry.get("value").and_then(Value::as_str) {
                Some(value) if is_encrypted(value) => decrypt(app, value).unwrap_or_default(),
                Some(value) => value.to_string(),
                None => String::new(),
            };
            KeyInfo {
                name: name.clone(),
                description: text_field(Some(entry), "description").unwrap_or_default(),
                masked: mask_secret(raw_value.as_str()),
                created_at: text_field(Some(entry), "createdAt"),
                updated_at: text_field(Some(entry), "updatedAt"),
            }
        })
        .collect()
}

/// Check if a key exists.
pub fn has_key(app: &App, name: &str) -> bool {
    load_vault(app).get(name).is_some_and(truthy)
}

/// Get all keys as name and value, in the file's order (for use in tool execution context). A value that cannot be
/// decrypted is `None`.
/// CAREFUL: Returns decrypted values.
pub fn get_all_keys_decrypted(app: &App) -> Vec<(String, Option<String>)> {
    load_vault(app)
        .iter()
        .map(|(name, entry)| {
            let value = match entry.get("value").and_then(Value::as_str) {
                Some(value) if is_encrypted(value) => decrypt(app, value).ok(),
                Some(value) => Some(value.to_string()),
                None => None,
            };
            (name.clone(), value)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{TestApp, test_app, test_app_with_env};

    /// The key the Node fixture below was made with.
    const FIXTURE_KEY: &str = "tarsee-port-fixture-key-not-a-secret";

    fn encrypted_app() -> TestApp {
        test_app_with_env([("ENCRYPTION_KEY", FIXTURE_KEY)])
    }

    fn fake_key(suffix: &str) -> String {
        format!("sk-{}-{suffix}", "test-not-a-real-key")
    }

    /// The file's text with what changes from run to run replaced.
    fn stable(text: &str) -> String {
        let text = regex::Regex::new(r#"enc:v1:[^"]+"#).unwrap().replace_all(text, "<enc>");
        regex::Regex::new(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z")
            .unwrap()
            .replace_all(&text, "<iso>")
            .into_owned()
    }

    #[test]
    fn reads_a_vault_file_the_node_version_wrote() {
        let t = encrypted_app();
        // vault.json exactly as src/lib/key-vault.js wrote it after setKey("OPENAI_API_KEY", ..., "for scripts") and
        // setKey("ünï ✓", "välue ✓ 🐒", "désc") with the fixture key.
        let file = "{\n  \"OPENAI_API_KEY\": {\n    \"value\": \"enc:v1:UqJkx7VYwqM3q73vysZ1YA==:VV5SAUsLGUGuGPIEnU5DFA==:qQj/GaoBun+3aH6H9/MlRUvRzTlBkM8opJg=\",\n    \"description\": \"for scripts\",\n    \"createdAt\": \"2026-11-12T15:05:03.786Z\",\n    \"updatedAt\": \"2026-11-12T15:05:03.786Z\"\n  },\n  \"ünï ✓\": {\n    \"value\": \"enc:v1:IOGYuGjRjK0nZYbMgzHOBg==:CAduK+yU6qpUzneFyg2joA==:hBMy73PVNT5OULM+v9r6\",\n    \"description\": \"désc\",\n    \"createdAt\": \"2026-11-12T15:05:03.788Z\",\n    \"updatedAt\": \"2026-11-12T15:05:03.788Z\"\n  }\n}";
        fs::write(vault_file(&t), file).unwrap();

        assert_eq!(get_key(&t, "OPENAI_API_KEY").unwrap(), Some(fake_key("000")));
        assert_eq!(get_key(&t, "ünï ✓").unwrap().as_deref(), Some("välue ✓ 🐒"));
        assert_eq!(
            list_keys(&t),
            vec![
                KeyInfo {
                    name: "OPENAI_API_KEY".into(),
                    description: "for scripts".into(),
                    masked: "sk-t...-000".into(),
                    created_at: Some("2026-11-12T15:05:03.786Z".into()),
                    updated_at: Some("2026-11-12T15:05:03.786Z".into()),
                },
                KeyInfo {
                    name: "ünï ✓".into(),
                    description: "désc".into(),
                    masked: "****".into(),
                    created_at: Some("2026-11-12T15:05:03.788Z".into()),
                    updated_at: Some("2026-11-12T15:05:03.788Z".into()),
                },
            ]
        );

        // Changing one key rewrites the file in the same form and leaves the other entry as Node wrote it.
        set_key(&t, "OPENAI_API_KEY", &fake_key("111"), None).unwrap();
        let rewritten = fs::read_to_string(vault_file(&t)).unwrap();
        let old_tail = &file[file.find("  \"ünï ✓\"").unwrap()..];
        assert!(rewritten.ends_with(old_tail), "{rewritten}");
        assert!(rewritten.contains("\"createdAt\": \"2026-11-12T15:05:03.786Z\""));
        assert_eq!(stable(&rewritten), stable(file));
    }

    #[test]
    fn set_get_list_and_delete_work_as_in_node() {
        let t = encrypted_app();
        assert_eq!(list_keys(&t), vec![]);
        assert_eq!(get_key(&t, "MISSING").unwrap(), None);

        // What setKey returned in Node for the same calls.
        let first = set_key(&t, "OPENAI_API_KEY", &fake_key("000"), Some("for scripts")).unwrap();
        assert_eq!(
            first,
            SetKeyResult {
                name: "OPENAI_API_KEY".into(),
                description: "for scripts".into(),
                masked: "sk-t...-000".into()
            }
        );
        let plain = set_key(&t, "PLAIN_ONE", "short", None).unwrap();
        assert_eq!((plain.description.as_str(), plain.masked.as_str()), ("", "****"));
        // No description this time: the one it had is kept, and so is the place in the file.
        let again = set_key(&t, "OPENAI_API_KEY", &fake_key("111"), Some("")).unwrap();
        assert_eq!(
            (again.description.as_str(), again.masked.as_str()),
            ("for scripts", "sk-t...-111")
        );
        set_key(&t, "ünï ✓", "välue ✓ 🐒", Some("désc")).unwrap();

        let file = fs::read_to_string(vault_file(&t)).unwrap();
        assert_eq!(
            stable(&file),
            "{\n  \"OPENAI_API_KEY\": {\n    \"value\": \"<enc>\",\n    \"description\": \"for scripts\",\n    \"createdAt\": \"<iso>\",\n    \"updatedAt\": \"<iso>\"\n  },\n  \"PLAIN_ONE\": {\n    \"value\": \"<enc>\",\n    \"description\": \"\",\n    \"createdAt\": \"<iso>\",\n    \"updatedAt\": \"<iso>\"\n  },\n  \"ünï ✓\": {\n    \"value\": \"<enc>\",\n    \"description\": \"désc\",\n    \"createdAt\": \"<iso>\",\n    \"updatedAt\": \"<iso>\"\n  }\n}"
        );
        assert!(!file.contains("test-not-a-real-key"), "values are encrypted at rest");

        assert_eq!(get_key(&t, "OPENAI_API_KEY").unwrap(), Some(fake_key("111")));
        assert_eq!(get_key(&t, "PLAIN_ONE").unwrap().as_deref(), Some("short"));
        assert!(has_key(&t, "OPENAI_API_KEY"));
        assert!(!has_key(&t, "MISSING"));
        let listed = list_keys(&t);
        assert_eq!(
            listed.iter().map(|k| k.name.as_str()).collect::<Vec<_>>(),
            ["OPENAI_API_KEY", "PLAIN_ONE", "ünï ✓"]
        );
        assert_eq!(listed[0].created_at.as_ref().map(String::len), Some(24));
        assert_eq!(
            get_all_keys_decrypted(&t),
            vec![
                ("OPENAI_API_KEY".to_string(), Some(fake_key("111"))),
                ("PLAIN_ONE".to_string(), Some("short".to_string())),
                ("ünï ✓".to_string(), Some("välue ✓ 🐒".to_string())),
            ]
        );

        // Deleting one from the middle leaves the others in their order.
        set_key(&t, "LAST_ONE", "value", None).unwrap();
        assert!(delete_key(&t, "PLAIN_ONE").unwrap());
        assert!(!delete_key(&t, "PLAIN_ONE").unwrap());
        assert_eq!(
            list_keys(&t).iter().map(|k| k.name.as_str()).collect::<Vec<_>>(),
            ["OPENAI_API_KEY", "ünï ✓", "LAST_ONE"]
        );
    }

    #[test]
    fn the_listing_serialises_with_the_node_field_names() {
        let t = encrypted_app();
        set_key(&t, "A_KEY", "value-0123456789", Some("d")).unwrap();
        let listed = serde_json::to_value(list_keys(&t)).unwrap();
        assert_eq!(
            listed[0].as_object().unwrap().keys().collect::<Vec<_>>(),
            ["name", "description", "masked", "createdAt", "updatedAt"]
        );
        fs::write(vault_file(&t), r#"{"BARE": {"value": "x"}}"#).unwrap();
        assert_eq!(
            serde_json::to_value(list_keys(&t)).unwrap(),
            json!([{ "name": "BARE", "description": "", "masked": "****" }])
        );
    }

    #[test]
    fn without_an_encryption_key_values_are_stored_as_they_are() {
        let t = test_app();
        set_key(&t, "A_KEY", "plain-value-0123456789", None).unwrap();
        let file = fs::read_to_string(vault_file(&t)).unwrap();
        assert!(file.contains("\"value\": \"plain-value-0123456789\""), "{file}");
        assert_eq!(get_key(&t, "A_KEY").unwrap().as_deref(), Some("plain-value-0123456789"));
    }

    #[test]
    fn a_hand_made_file_is_read_the_way_node_read_it() {
        let t = encrypted_app();
        // A plaintext value, a broken encrypted one, an entry with no dates.
        fs::write(
            vault_file(&t),
            r#"{"PLAIN":{"value":"plain-value-0123456789"},"BROKEN":{"value":"enc:v1:bad","description":"d"},"EMPTYDESC":{"value":"x","description":""}}"#,
        )
        .unwrap();
        let listed = list_keys(&t);
        assert_eq!(
            listed
                .iter()
                .map(|k| (k.name.as_str(), k.description.as_str(), k.masked.as_str()))
                .collect::<Vec<_>>(),
            [
                ("PLAIN", "", "plai...6789"),
                ("BROKEN", "d", "****"),
                ("EMPTYDESC", "", "****")
            ]
        );
        assert!(listed.iter().all(|k| k.created_at.is_none() && k.updated_at.is_none()));
        assert_eq!(
            get_all_keys_decrypted(&t),
            vec![
                ("PLAIN".to_string(), Some("plain-value-0123456789".to_string())),
                ("BROKEN".to_string(), None),
                ("EMPTYDESC".to_string(), Some("x".to_string())),
            ]
        );
        assert_eq!(get_key(&t, "PLAIN").unwrap().as_deref(), Some("plain-value-0123456789"));
        assert_eq!(
            get_key(&t, "BROKEN").unwrap_err().to_string(),
            "Malformed encrypted value"
        );

        // Setting the broken one keeps its description and gives it dates; the others stay as they were.
        let set = set_key(&t, "BROKEN", "new-value-0123456789", None).unwrap();
        assert_eq!((set.description.as_str(), set.masked.as_str()), ("d", "new-...6789"));
        assert_eq!(
            stable(&fs::read_to_string(vault_file(&t)).unwrap()),
            "{\n  \"PLAIN\": {\n    \"value\": \"plain-value-0123456789\"\n  },\n  \"BROKEN\": {\n    \"value\": \"<enc>\",\n    \"description\": \"d\",\n    \"createdAt\": \"<iso>\",\n    \"updatedAt\": \"<iso>\"\n  },\n  \"EMPTYDESC\": {\n    \"value\": \"x\",\n    \"description\": \"\"\n  }\n}"
        );
    }

    #[test]
    fn a_file_that_is_not_json_is_an_empty_vault() {
        let t = test_app();
        fs::write(vault_file(&t), "not json").unwrap();
        assert_eq!(list_keys(&t), vec![]);
        assert_eq!(get_key(&t, "X").unwrap(), None);
        assert!(!has_key(&t, "X"));
        assert!(!delete_key(&t, "X").unwrap());
        assert_eq!(get_all_keys_decrypted(&t), vec![]);
        // And the next key written replaces it.
        set_key(&t, "X", "value", None).unwrap();
        assert_eq!(get_key(&t, "X").unwrap().as_deref(), Some("value"));
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let t = test_app();
        set_key(&t, "X", "value", None).unwrap();
        let mode = fs::metadata(vault_file(&t)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
