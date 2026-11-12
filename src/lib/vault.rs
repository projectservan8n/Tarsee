//! Port of `src/lib/vault.js`: encrypts the secrets Tarsee stores (API keys, bot tokens, mailbox passwords).
//!
//! AES-256-GCM with a 16-byte IV and a 16-byte tag; the key is PBKDF2-HMAC-SHA512 of `ENCRYPTION_KEY`. A stored
//! value is `enc:v1:<iv>:<authTag>:<ciphertext>`, each part base64. The Node version wrote that format and this one
//! reads and writes it byte for byte: a database or `vault.json` made by either opens under the other.
//!
//! The key comes from `app.config().encryption_key` and is derived once per `App`.

use std::sync::{LazyLock, OnceLock};

use aes_gcm::AesGcm;
use aes_gcm::aead::array::typenum::Unsigned;
use aes_gcm::aead::array::{Array, ArraySize};
use aes_gcm::aead::{Aead, Key, KeyInit, consts};
use aes_gcm::aes::Aes256;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use hmac::{Hmac, Mac};
use rand::Rng;
use regex::Regex;
use serde_json::{Map, Value};
use sha2::Sha512;

use crate::app::App;
use crate::util::js::{utf16_len, utf16_tail, utf16_truncate};

const IV_LENGTH: usize = 16;
const AUTH_TAG_LENGTH: usize = 16;
const KEY_LENGTH: usize = 32; // 256 bits
const ENCRYPTED_PREFIX: &str = "enc:v1:";

/// The fixed application salt (the salt is not secret; the key is). A fixed salt gives the same key on every
/// restart.
const KEY_SALT: &[u8] = b"tarsee-vault-v1";
/// PBKDF2 with a high iteration count for key stretching.
const KEY_ITERATIONS: u32 = 100_000;

/// The longest IV OpenSSL takes for AES-GCM, in bytes.
const IV_MAX_LENGTH: usize = 128;

/// Why a stored value could not be decrypted. The texts are the Node ones (they reach logs and tool answers).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VaultError {
    #[error("ENCRYPTION_KEY required to decrypt secrets. Set it in your environment.")]
    KeyRequired,
    #[error("Malformed encrypted value")]
    Malformed,
    #[error("Invalid initialization vector")]
    InvalidIv,
    #[error("Invalid authentication tag length: {0}")]
    InvalidAuthTagLength(usize),
    /// The key is not the one the value was encrypted with, or the value was changed.
    #[error("Unsupported state or unable to authenticate data")]
    Unauthentic,
}

/// The derived key of one `App` (the JS module-level `derivedKey`).
struct DerivedKey(OnceLock<[u8; KEY_LENGTH]>);

/// Derives a 256-bit key from `ENCRYPTION_KEY`, once. `None` when no encryption is configured.
fn get_key(app: &App) -> Option<[u8; KEY_LENGTH]> {
    let passphrase = app.config().encryption_key.as_deref()?;
    let holder = app.get_or_init(|| DerivedKey(OnceLock::new()));
    Some(*holder.0.get_or_init(|| derive_key(passphrase)))
}

fn derive_key(passphrase: &str) -> [u8; KEY_LENGTH] {
    let mut key = [0u8; KEY_LENGTH];
    pbkdf2_hmac_sha512(passphrase.as_bytes(), KEY_SALT, KEY_ITERATIONS, &mut key);
    key
}

/// PBKDF2 (RFC 8018) with HMAC-SHA512: `crypto.pbkdf2Sync(password, salt, iterations, out.len(), "sha512")`.
fn pbkdf2_hmac_sha512(password: &[u8], salt: &[u8], iterations: u32, out: &mut [u8]) {
    const HASH_LENGTH: usize = 64;
    // HMAC takes a key of any length, so this never fails.
    let prf = <Hmac<Sha512> as KeyInit>::new_from_slice(password).expect("HMAC takes a key of any length");
    for (index, chunk) in out.chunks_mut(HASH_LENGTH).enumerate() {
        let mut mac = prf.clone();
        mac.update(salt);
        mac.update(&(index as u32 + 1).to_be_bytes());
        let mut block = [0u8; HASH_LENGTH];
        block.copy_from_slice(&mac.finalize().into_bytes());
        let mut sum = block;
        for _ in 1..iterations {
            let mut mac = prf.clone();
            mac.update(&block);
            block.copy_from_slice(&mac.finalize().into_bytes());
            for (total, byte) in sum.iter_mut().zip(block.iter()) {
                *total ^= byte;
            }
        }
        chunk.copy_from_slice(&sum[..chunk.len()]);
    }
}

/// `Buffer.from(text, "base64")`: Node skips every character outside the alphabet (it takes the URL-safe one too),
/// stops at the first `=`, and drops a last incomplete group. Never fails.
fn node_base64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 3);
    let mut group = 0u32;
    let mut filled = 0u8;
    for byte in text.bytes() {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        group = (group << 6) | u32::from(sextet);
        filled += 1;
        if filled == 4 {
            out.extend_from_slice(&[(group >> 16) as u8, (group >> 8) as u8, group as u8]);
            group = 0;
            filled = 0;
        }
    }
    match filled {
        2 => out.push((group >> 4) as u8),
        3 => out.extend_from_slice(&[(group >> 10) as u8, (group >> 2) as u8]),
        _ => {}
    }
    out
}

/// Opens `ciphertext || tag` with an IV of `N` bytes.
fn open<N: ArraySize>(key: &[u8; KEY_LENGTH], iv: &[u8], sealed: &[u8]) -> Result<Vec<u8>, VaultError> {
    let cipher = AesGcm::<Aes256, N>::new(&Key::<AesGcm<Aes256, N>>::from(*key));
    let nonce = Array::<u8, N>::try_from(iv).map_err(|_| VaultError::InvalidIv)?;
    cipher.decrypt(&nonce, sealed).map_err(|_| VaultError::Unauthentic)
}

/// [`open`] for whatever length the IV has. Tarsee always writes 16 bytes, but Node decrypts a value made with any
/// IV from 1 to 128 bytes (another tool holding the same key may have used the usual 12), so this does too. The
/// cipher's IV length is part of its type, hence one arm per length.
macro_rules! open_by_iv_length {
    ($key:expr, $iv:expr, $sealed:expr; $($size:ident)*) => {
        match $iv.len() {
            $(length if length == <consts::$size as Unsigned>::USIZE => open::<consts::$size>($key, $iv, $sealed),)*
            _ => Err(VaultError::InvalidIv),
        }
    };
}

fn open_any(key: &[u8; KEY_LENGTH], iv: &[u8], sealed: &[u8]) -> Result<Vec<u8>, VaultError> {
    open_by_iv_length!(key, iv, sealed;
        U1 U2 U3 U4 U5 U6 U7 U8 U9 U10 U11 U12 U13 U14 U15 U16
        U17 U18 U19 U20 U21 U22 U23 U24 U25 U26 U27 U28 U29 U30 U31 U32
        U33 U34 U35 U36 U37 U38 U39 U40 U41 U42 U43 U44 U45 U46 U47 U48
        U49 U50 U51 U52 U53 U54 U55 U56 U57 U58 U59 U60 U61 U62 U63 U64
        U65 U66 U67 U68 U69 U70 U71 U72 U73 U74 U75 U76 U77 U78 U79 U80
        U81 U82 U83 U84 U85 U86 U87 U88 U89 U90 U91 U92 U93 U94 U95 U96
        U97 U98 U99 U100 U101 U102 U103 U104 U105 U106 U107 U108 U109 U110 U111 U112
        U113 U114 U115 U116 U117 U118 U119 U120 U121 U122 U123 U124 U125 U126 U127 U128
    )
}

/// Encrypt a plaintext string using AES-256-GCM.
/// Returns a prefixed string: `enc:v1:<iv>:<authTag>:<ciphertext>` (all base64). With no encryption key the
/// plaintext is returned as it is (stored in plain text).
pub fn encrypt(app: &App, plaintext: &str) -> String {
    let Some(key) = get_key(app) else {
        return plaintext.to_string(); // No encryption key: store plaintext
    };

    let mut iv = [0u8; IV_LENGTH];
    rand::rng().fill_bytes(&mut iv);
    let cipher = AesGcm::<Aes256, consts::U16>::new(&Key::<AesGcm<Aes256, consts::U16>>::from(key));
    let mut sealed = cipher
        .encrypt(&Array::from(iv), plaintext.as_bytes())
        .expect("a string in memory is far below the size AES-GCM can encrypt");
    let auth_tag = sealed.split_off(sealed.len() - AUTH_TAG_LENGTH);

    format!(
        "{ENCRYPTED_PREFIX}{}:{}:{}",
        BASE64.encode(iv),
        BASE64.encode(auth_tag),
        BASE64.encode(sealed)
    )
}

/// Decrypt a vault-encrypted string.
/// If the string doesn't have the encrypted prefix, returns it as-is (plaintext fallback).
pub fn decrypt(app: &App, value: &str) -> Result<String, VaultError> {
    if value.is_empty() || !value.starts_with(ENCRYPTED_PREFIX) {
        return Ok(value.to_string()); // Not encrypted: return as-is
    }

    let key = get_key(app).ok_or(VaultError::KeyRequired)?;

    let payload = &value[ENCRYPTED_PREFIX.len()..];
    let parts: Vec<&str> = payload.split(':').collect();
    let [iv, auth_tag, ciphertext] = parts.as_slice() else {
        return Err(VaultError::Malformed);
    };

    let iv = node_base64_decode(iv);
    let auth_tag = node_base64_decode(auth_tag);
    if iv.is_empty() || iv.len() > IV_MAX_LENGTH {
        return Err(VaultError::InvalidIv);
    }
    if auth_tag.len() != AUTH_TAG_LENGTH {
        return Err(VaultError::InvalidAuthTagLength(auth_tag.len()));
    }
    let mut sealed = node_base64_decode(ciphertext);
    sealed.extend_from_slice(&auth_tag);

    let decrypted = open_any(&key, &iv, &sealed)?;
    Ok(String::from_utf8_lossy(&decrypted).into_owned())
}

/// Check if a value is already encrypted. (The JS took any value and said no to all but strings; for a JSON value
/// ask `value.as_str().is_some_and(is_encrypted)`.)
pub fn is_encrypted(value: &str) -> bool {
    value.starts_with(ENCRYPTED_PREFIX)
}

/// Check if encryption is available (`ENCRYPTION_KEY` is set).
pub fn is_encryption_enabled(app: &App) -> bool {
    app.config().encryption_key.is_some()
}

/// Patterns that identify a settings key as containing a secret.
/// Any setting key matching these patterns will be auto-encrypted. `(?i-u:...)` is JavaScript's `/i` without the
/// `u` flag: only ASCII letters match each other.
static SECRET_KEY_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"\.apiKey$",                 // ai.anthropic.apiKey, ai.openai.apiKey, etc.
        r"\.token$",                  // channel.discord.token, etc.
        r"\.appToken$",               // channel.slack.appToken
        r"\.secret$",                 // any .secret suffix
        r"\.password$",               // any .password suffix
        r"\.key$",                    // generic .key suffix
        r"^encryption\.",             // encryption config keys
        r"(?i-u:api)[_-]?(?i-u:key)", // anything with "apikey" or "api_key"
        r"(?i-u:secret)",             // anything with "secret"
    ]
    .iter()
    .map(|pattern| Regex::new(pattern).expect("a secret key pattern"))
    .collect()
});

/// Settings whose names match a pattern above but hold no secret. `ui.redactSecrets` is the on/off switch for
/// hiding secrets in tool output: stored encrypted and shown as "****", the Settings page could never read it back
/// as off.
const NOT_SECRET_KEYS: &[&str] = &["ui.redactSecrets"];

/// Check if a settings key should be treated as a secret.
pub fn is_secret_key(key: &str) -> bool {
    if NOT_SECRET_KEYS.contains(&key) {
        return false;
    }
    SECRET_KEY_PATTERNS.iter().any(|pattern| pattern.is_match(key))
}

/// Field names that hold a credential inside a structured setting value.
///
/// The key-name patterns above only ever see the TOP-LEVEL settings key, and every channel stores its whole config
/// as one JSON object: `channel.telegram`, `channel.email`, `channel.whatsapp`. None of those key names match, so
/// the bot tokens, IMAP and SMTP passwords, and webhook secrets inside them were written to SQLite in plaintext, on
/// a product that logs "credential encryption: ENABLED" at boot and audits every write as "(encrypted)".
///
/// Matching on the FIELD name inside the object closes that gap.
static SECRET_FIELD_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u:token|password|secret|apikey|api_key|credential|passphrase)").expect("the secret field pattern")
});

/// `inner && typeof inner === "object"`: an array or an object.
fn is_structured(value: &Value) -> bool {
    value.is_array() || value.is_object()
}

/// Recursively encrypt credential-bearing fields inside a structured value.
///
/// Only string leaves whose own field name looks like a credential are touched, so the rest of the config stays
/// readable in the database and in backups. Already-encrypted values pass through, which keeps this idempotent
/// across the read-modify-write cycle the settings routes use.
pub fn encrypt_secret_fields(app: &App, value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| encrypt_secret_fields(app, item)).collect()),
        Value::Object(fields) => {
            let mut out = Map::with_capacity(fields.len());
            for (field, inner) in fields {
                let stored = match inner {
                    Value::String(text) if !text.is_empty() && SECRET_FIELD_PATTERN.is_match(field) => {
                        if is_encrypted(text) {
                            inner.clone()
                        } else {
                            Value::String(encrypt(app, text))
                        }
                    }
                    inner if is_structured(inner) => encrypt_secret_fields(app, inner),
                    inner => inner.clone(),
                };
                out.insert(field.clone(), stored);
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Recursively decrypt any encrypted string leaves in a structured value.
///
/// Deliberately keyed on the value's own prefix rather than the field name: a field renamed after it was written
/// must still decrypt, and a value that was stored before this existed is plaintext and passes straight through.
///
/// A field of an object that cannot be decrypted comes back empty. A string on its own, or one that is an item of
/// an array, has no field to blank: that failure is returned, as the Node version threw it.
pub fn decrypt_secret_fields(app: &App, value: &Value) -> Result<Value, VaultError> {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| decrypt_secret_fields(app, item))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(fields) => {
            let mut out = Map::with_capacity(fields.len());
            for (field, inner) in fields {
                let plain = match inner {
                    Value::String(text) if is_encrypted(text) => match decrypt(app, text) {
                        Ok(plain) => Value::String(plain),
                        Err(err) => {
                            // A rotated or missing ENCRYPTION_KEY must not take down every read of
                            // this setting. Surface the field as empty and say so once.
                            log::error!("[vault] could not decrypt field \"{field}\": {err}");
                            Value::String(String::new())
                        }
                    },
                    inner if is_structured(inner) => decrypt_secret_fields(app, inner)?,
                    inner => inner.clone(),
                };
                out.insert(field.clone(), plain);
            }
            Ok(Value::Object(out))
        }
        Value::String(text) if is_encrypted(text) => decrypt(app, text).map(Value::String),
        other => Ok(other.clone()),
    }
}

/// `has<Field>`: the field's name with its first UTF-16 unit in upper case, as
/// `field.charAt(0).toUpperCase() + field.slice(1)` gave it. A first character outside the basic plane is two
/// units, and half of one has no upper case, so it stays as it is.
fn has_marker(field: &str) -> String {
    let mut chars = field.chars();
    match chars.next() {
        Some(first) if first.len_utf16() == 1 => format!("has{}{}", first.to_uppercase(), chars.as_str()),
        _ => format!("has{field}"),
    }
}

/// Redact credential-bearing fields for display, replacing each with a boolean `has<Field>` marker so a UI can
/// still show "password is set" without ever receiving it.
pub fn redact_secret_fields(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(redact_secret_fields).collect()),
        Value::Object(fields) => {
            let mut out = Map::with_capacity(fields.len());
            for (field, inner) in fields {
                match inner {
                    Value::String(text) if SECRET_FIELD_PATTERN.is_match(field) => {
                        out.insert(has_marker(field), Value::Bool(!text.is_empty()));
                    }
                    inner if is_structured(inner) => {
                        out.insert(field.clone(), redact_secret_fields(inner));
                    }
                    inner => {
                        out.insert(field.clone(), inner.clone());
                    }
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Encrypt a value if the key indicates it's a secret.
pub fn encrypt_if_secret(app: &App, key: &str, value: &str) -> String {
    if is_encrypted(value) {
        return value.to_string(); // Already encrypted
    }
    if !is_secret_key(key) {
        return value.to_string(); // Not a secret key
    }
    encrypt(app, value)
}

/// Decrypt a value if it's encrypted.
pub fn decrypt_if_encrypted(app: &App, value: &str) -> Result<String, VaultError> {
    if !is_encrypted(value) {
        return Ok(value.to_string());
    }
    decrypt(app, value)
}

/// Mask a secret for display (show first 4 and last 4 chars). Lengths are counted as JavaScript counts them, in
/// UTF-16 units. `None` is the JS `null`.
pub fn mask_secret<'a>(value: impl Into<Option<&'a str>>) -> String {
    match value.into() {
        Some(value) if utf16_len(value) >= 12 => {
            format!("{}...{}", utf16_truncate(value, 4), utf16_tail(value, 4))
        }
        _ => "****".to_string(),
    }
}

#[cfg(test)]
mod tests {
    //! Port of `test/vault.test.js`, and the proof that what the Node vault encrypted is read here.
    use super::*;
    use crate::testkit::{TestApp, test_app, test_app_with_env};
    use serde_json::json;

    /// The key the Node fixtures below were made with (given to Node with spaces around it, which the
    /// configuration trims in both versions).
    const FIXTURE_KEY: &str = "tarsee-port-fixture-key-not-a-secret";

    fn app() -> TestApp {
        // Set ENCRYPTION_KEY before using the vault
        test_app_with_env([("ENCRYPTION_KEY", "test-key-for-unit-tests-only-32chars!")])
    }

    fn fixture_app() -> TestApp {
        test_app_with_env([("ENCRYPTION_KEY", format!("  {FIXTURE_KEY}  "))])
    }

    // --- vault encryption ---

    #[test]
    fn encrypts_and_decrypts_a_string() {
        let t = app();
        let plaintext = format!("sk-ant-{}", "api03-abc123xyz");
        let encrypted = encrypt(&t, &plaintext);
        assert!(encrypted.starts_with("enc:v1:"), "Should have encrypted prefix");
        assert_ne!(encrypted, plaintext, "Encrypted should differ from plaintext");

        let decrypted = decrypt(&t, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext, "Decrypted should match original");
    }

    #[test]
    fn produces_different_ciphertexts_for_same_input_random_iv() {
        let t = app();
        let plaintext = "my-secret-key";
        let enc1 = encrypt(&t, plaintext);
        let enc2 = encrypt(&t, plaintext);
        assert_ne!(enc1, enc2, "Each encryption should use a unique IV");

        // But both decrypt to the same value
        assert_eq!(decrypt(&t, &enc1).unwrap(), plaintext);
        assert_eq!(decrypt(&t, &enc2).unwrap(), plaintext);
    }

    #[test]
    fn returns_plaintext_unchanged_if_not_encrypted() {
        let t = app();
        assert_eq!(decrypt(&t, "hello world").unwrap(), "hello world");
        assert_eq!(decrypt(&t, "").unwrap(), "");
        // The JS `decrypt(null)` gave null back: a JSON null passes through the JSON form untouched.
        assert_eq!(decrypt_secret_fields(&t, &Value::Null).unwrap(), Value::Null);
    }

    #[test]
    fn detects_encrypted_values() {
        let t = app();
        let encrypted = encrypt(&t, "test");
        assert!(is_encrypted(&encrypted));
        assert!(!is_encrypted("not encrypted"));
        assert!(!is_encrypted(""));
        // The JS also took null (not encrypted): here only a string can be asked about.
        // As Node: the prefix alone counts, a cut or padded one does not.
        assert!(is_encrypted("enc:v1:"));
        assert!(!is_encrypted("enc:v1"));
        assert!(!is_encrypted(" enc:v1:x"));
    }

    #[test]
    fn rejects_tampered_ciphertext() {
        let t = app();
        let encrypted = encrypt(&t, "secret-value");
        // Tamper with the ciphertext
        let tampered = format!("{}XX", &encrypted[..encrypted.len() - 2]);
        let err = decrypt(&t, &tampered).unwrap_err();
        assert_eq!(err.to_string(), "Unsupported state or unable to authenticate data");
    }

    // --- isSecretKey ---

    #[test]
    fn identifies_api_key_patterns() {
        assert!(is_secret_key("ai.anthropic.apiKey"));
        assert!(is_secret_key("ai.openai.apiKey"));
        assert!(is_secret_key("channel.discord.token"));
        assert!(is_secret_key("channel.slack.appToken"));
        assert!(is_secret_key("some.secret"));
        assert!(is_secret_key("some.password"));
    }

    #[test]
    fn rejects_non_secret_keys() {
        assert!(!is_secret_key("ai.activeProvider"));
        assert!(!is_secret_key("ai.anthropic.model"));
        assert!(!is_secret_key("voice.engine"));
    }

    #[test]
    fn secret_keys_are_told_apart_exactly_as_node_tells_them() {
        // What `isSecretKey` answered in Node for each of these.
        for (key, expected) in [
            ("x.key", true),
            ("encryption.foo", true),
            ("my_api_key_thing", true),
            ("API-KEY", true),
            ("apikey", true),
            ("ApiKey.model", true),
            ("SECRETARY", true),
            ("ui.redactSecrets", false),
            ("ui.redactsecrets", true),
            ("token", false),
            ("x.tokens", false),
            ("x.Token", false),
            ("x.keys", false),
            ("channel.telegram", false),
            ("x.apiKeyName", true),
            // JavaScript's /i without /u folds ASCII letters only: the Kelvin sign is not a k, the long s not an s.
            ("x.api\u{212A}ey", false),
            ("x.\u{17F}ecret", false),
        ] {
            assert_eq!(is_secret_key(key), expected, "{key}");
        }
    }

    // --- encryptIfSecret ---

    #[test]
    fn encrypts_values_for_secret_keys() {
        let t = app();
        let result = encrypt_if_secret(&t, "ai.openai.apiKey", "sk-abc123");
        assert!(is_encrypted(&result));
        assert_eq!(decrypt(&t, &result).unwrap(), "sk-abc123");
    }

    #[test]
    fn leaves_non_secret_values_as_plaintext() {
        let t = app();
        let result = encrypt_if_secret(&t, "ai.activeProvider", "anthropic");
        assert_eq!(result, "anthropic");
        assert!(!is_encrypted(&result));
    }

    #[test]
    fn does_not_double_encrypt() {
        let t = app();
        let first = encrypt_if_secret(&t, "ai.openai.apiKey", "sk-abc123");
        let second = encrypt_if_secret(&t, "ai.openai.apiKey", &first);
        assert_eq!(first, second, "Should not encrypt already-encrypted value");
    }

    #[test]
    fn an_empty_secret_is_encrypted_too_and_the_not_secret_switch_is_left_alone() {
        let t = app();
        assert!(is_encrypted(&encrypt_if_secret(&t, "x.apiKey", "")));
        assert_eq!(encrypt_if_secret(&t, "ui.redactSecrets", "true"), "true");
    }

    // --- maskSecret ---

    #[test]
    fn masks_long_secrets() {
        assert_eq!(
            mask_secret(format!("sk-ant-{}", "api03-abcdefghij").as_str()),
            "sk-a...ghij"
        );
    }

    #[test]
    fn masks_short_secrets() {
        assert_eq!(mask_secret("short"), "****");
    }

    #[test]
    fn handles_empty_null() {
        assert_eq!(mask_secret(""), "****");
        assert_eq!(mask_secret(None), "****");
    }

    #[test]
    fn masking_counts_utf16_units_as_javascript_does() {
        assert_eq!(mask_secret("elevenchars"), "****");
        assert_eq!(mask_secret("twelve_chars"), "twel...hars");
        assert_eq!(mask_secret("ééééééééééééé"), "éééé...éééé");
        assert_eq!(mask_secret("🐒🐒🐒🐒🐒🐒"), "🐒🐒...🐒🐒");
        assert_eq!(mask_secret("ab🐒cdefghi🐒jk"), "ab🐒...🐒jk");
        assert_eq!(mask_secret(Some("twelve_chars")), "twel...hars");
    }

    // --- What the Node vault wrote ---

    #[test]
    fn the_key_is_derived_as_node_derives_it() {
        // crypto.pbkdf2Sync(FIXTURE_KEY, "tarsee-vault-v1", 100_000, 32, "sha512")
        assert_eq!(
            hex::encode(derive_key(FIXTURE_KEY)),
            "f5fee1c39bcda9c79306d5bbf6099a8f3d9945d3e1a87619d75014997e1a0b89"
        );
    }

    #[test]
    fn pbkdf2_matches_nodes_for_other_lengths_and_inputs() {
        let derive = |password: &str, salt: &str, iterations: u32, length: usize| {
            let mut out = vec![0u8; length];
            pbkdf2_hmac_sha512(password.as_bytes(), salt.as_bytes(), iterations, &mut out);
            hex::encode(out)
        };
        assert_eq!(
            derive("password", "salt", 1, 64),
            "867f70cf1ade02cff3752599a3a53dc4af34c7a669815ae5d513554e1c8cf252c02d470a285a0501bad999bfe943c08f050235d7d68b1da55e63f73b60a57fce"
        );
        assert_eq!(
            derive("password", "salt", 2, 32),
            "e1d9c16aa681708a45f5c7c4e215ceb66e011a2e9f0040713f18aefdb866d53c"
        );
        // A key longer than SHA-512's block (HMAC hashes it first), and one that is not ASCII.
        assert_eq!(
            derive(&"k".repeat(200), "tarsee-vault-v1", 100, 32),
            "af50c1856063c972e81ef99f94b5e6cc542e93c81de0a631af2ee04a7d9b82a9"
        );
        assert_eq!(
            derive("clé 🔑", "tarsee-vault-v1", 100, 32),
            "6f78fd5196915afc6b977b31d6292b465829eb6a16ed41807facc05a9f03db4b"
        );
    }

    #[test]
    fn decrypts_what_the_node_vault_encrypted() {
        let t = fixture_app();
        // Each ciphertext is what `encrypt()` of src/lib/vault.js printed for the plaintext beside it.
        let cases: [(&str, String); 5] = [
            (
                "enc:v1:VuJSwvJehyXRYYIDGNgYCw==:AocPILDaIeswRxZ/s0SwaQ==:xa6XgBlOJrdFMeKB4aDlx76w+IyA0eI4oKePZPQP8TMn",
                format!("sk-{}", "test-not-a-real-key-0123456789"),
            ),
            (
                "enc:v1:hWclxDWQ+L34fD6DaNEJUw==:brthOX44zdWoz8gSMrLu8Q==:Ngxa/5IKZldAcAo41WB/nvytdZ/oyWwKhPuixzsicXqUqBxq",
                "pässwörd ✓ 日本語 🐒 señor".to_string(),
            ),
            (
                "enc:v1:kI3LxiiglBkj2jrBwrZPRg==:znJl7aPBZEBE/EoNS1mtyQ==:",
                String::new(),
            ),
            (
                "enc:v1:fM1dr4TK5pmsAG+xP6x/BQ==:SWpQd2x2Mo0Y7Re1XAdlAA==:+CvGAK53BhTlVViyO1+yE/yDgU7YHtzi",
                "a:b:c enc:v1: not really".to_string(),
            ),
            (
                "enc:v1:XO6vw8wflrROy8zL+oygZg==:xe+afF6w2Y8TVojwZv1CNg==:ieAzNdE1jT+loSJQNZJGiMl3gxXM1NVnaJGL28NbkF1du4nfHLJZryCeUUAHCv7gXXwS+A9YvZkUFEogs3pX0AxX/Gy1GZ0CDvbrAzVDDYICCQH5S1z0hiCQwkg0ZK/TBu93vq1+Yrm0Ah2Tv7aS5WC56pvgmlAnzFNWxrH047mEBXrCSqNwu4b+BUA/Dupge+3ieT+REsriwafF/6TsUXCFgUwqrLSAh9vZ4XNO7tGQSskN5juGOBPWQ1PGh1fRj7tI7S74YOkg6Uri8f4uQafNgTYNjmZNNlc12HoeZ6RDj6NzU2CqDIGyFHH6FSiEwi5n3cJOyDRmBVePJZEO2ppe+eqKoSgold/bzV0UieCCPLSU+vrEwbGdWcjCGde91rMZRgx1qPdnuIEyIUvHXdilTvg5UrEusXlbgg3P6fZ8rgB5FIDMf8xkZzauu9QOnIh2n5nb9FrCSmI0N1A2Yb9g4mSMK6K9diNm58g5pOtM95nm+tnrPOfAfNZ+lurmBruXvSNoytZ2dWHg3YrTLsFlSDnDrF8rzTMD6bzY2/rBK6upCo072KzRg24AfnWZKt4vyNpijxqL0rErRSEcVxZ2qE/92BfsL3l68gpBzfb424k4WowyY0rvSJXUIixAKUdkZLWgDfMn4Mbw8aqQnJxr3WJN8lmKbpVCHZsY65h0INZ3qe32jbShvhMHkJFFfchterFLyVUjzw/Y5NF881vwnlR8i7TM13Sqb/PEIb1/ZeAr/lTDzrWnN77JMszae8xWBPR1Y+h2LN5ikc8v6lNj6WSg9MF9ok0CKpSfPoPuXaDX4lkVswDAUw2ZgPogPIjsd0RREmkt39Ei7AcQYA==",
                "0123456789abcdef".repeat(40),
            ),
        ];
        for (ciphertext, plaintext) in cases {
            assert_eq!(decrypt(&t, ciphertext).unwrap(), plaintext, "{ciphertext}");
            assert_eq!(decrypt_if_encrypted(&t, ciphertext).unwrap(), plaintext);
        }
    }

    #[test]
    fn decrypts_the_fields_the_node_vault_encrypted_inside_a_setting() {
        let t = fixture_app();
        // encryptSecretFields({ botToken, nested: { password, host }, list: [{ apiKey }], n }) in Node.
        let stored = json!({
            "botToken": "enc:v1:iBxbB/qoZeouv3hxax377w==:1P4BirThdwGKfKoOAVQqOA==:LXuOGfCqbw==",
            "nested": {
                "password": "enc:v1:ahEBGuO/5KWTFhHBN96M1A==:p+QFWrfPMzQpPiX/DkgPDA==:DV8XoVWo8Q==",
                "host": "imap.example.test"
            },
            "list": [{ "apiKey": "enc:v1:UprnBSvh4WJFf03gz24Lrw==:8qRjUSKem7I0fY8Y+44d+g==:dg==" }],
            "n": 1
        });
        assert_eq!(
            decrypt_secret_fields(&t, &stored).unwrap(),
            json!({
                "botToken": "123:abc",
                "nested": { "password": "hunter2", "host": "imap.example.test" },
                "list": [{ "apiKey": "k" }],
                "n": 1
            })
        );
        // Encrypting again leaves what is already encrypted exactly as Node wrote it.
        assert_eq!(encrypt_secret_fields(&t, &stored), stored);
    }

    #[test]
    fn writes_the_format_node_writes() {
        let t = fixture_app();
        for plaintext in ["", "x", "sixteen bytes!!!", "pässwörd ✓ 🐒", &"long ".repeat(500)] {
            let encrypted = encrypt(&t, plaintext);
            let parts: Vec<&str> = encrypted.strip_prefix("enc:v1:").unwrap().split(':').collect();
            assert_eq!(parts.len(), 3);
            // Standard base64 with padding: a 16-byte IV and a 16-byte tag are 24 characters each.
            assert_eq!(BASE64.decode(parts[0]).unwrap().len(), 16);
            assert_eq!(parts[0].len(), 24);
            assert_eq!(BASE64.decode(parts[1]).unwrap().len(), 16);
            assert_eq!(BASE64.decode(parts[2]).unwrap().len(), plaintext.len());
            assert_eq!(decrypt(&t, &encrypted).unwrap(), plaintext);
        }
    }

    #[test]
    fn without_a_key_values_are_stored_as_they_are_and_an_encrypted_one_cannot_be_read() {
        let t = test_app();
        assert!(!is_encryption_enabled(&t));
        assert!(is_encryption_enabled(&app()));
        assert_eq!(encrypt(&t, "plain"), "plain");
        assert_eq!(encrypt_if_secret(&t, "x.apiKey", "plain"), "plain");
        assert_eq!(decrypt(&t, "plain").unwrap(), "plain");
        let err = decrypt(&t, "enc:v1:a:b:c").unwrap_err();
        assert_eq!(
            err.to_string(),
            "ENCRYPTION_KEY required to decrypt secrets. Set it in your environment."
        );
    }

    #[test]
    fn another_key_cannot_read_a_value() {
        let encrypted = encrypt(&app(), "secret-value");
        assert_eq!(decrypt(&fixture_app(), &encrypted), Err(VaultError::Unauthentic));
    }

    #[test]
    fn broken_values_fail_with_the_node_messages() {
        let t = app();
        let good = encrypt(&t, "secret-value");
        let parts: Vec<&str> = good.split(':').collect();
        let (iv, tag, ct) = (parts[2], parts[3], parts[4]);
        let b64 = |length: usize| BASE64.encode(vec![7u8; length]);
        let message = |value: String| decrypt(&t, &value).unwrap_err().to_string();
        let unauthentic = "Unsupported state or unable to authenticate data";

        assert_eq!(message(format!("enc:v1:{iv}:{}:{ct}", b64(16))), unauthentic);
        assert_eq!(message(format!("enc:v1:{}:{tag}:{ct}", b64(16))), unauthentic);
        assert_eq!(message(format!("enc:v1:{iv}:{tag}")), "Malformed encrypted value");
        assert_eq!(
            message(format!("enc:v1:{iv}:{tag}:{ct}:x")),
            "Malformed encrypted value"
        );
        assert_eq!(message("enc:v1:".to_string()), "Malformed encrypted value");
        assert_eq!(message(format!("enc:v1::{tag}:{ct}")), "Invalid initialization vector");
        assert_eq!(
            message(format!("enc:v1:{}:{tag}:{ct}", b64(129))),
            "Invalid initialization vector"
        );
        for length in [1, 12, 15, 128] {
            assert_eq!(
                message(format!("enc:v1:{}:{tag}:{ct}", b64(length))),
                unauthentic,
                "{length}"
            );
        }
        assert_eq!(
            message(format!("enc:v1:{iv}::{ct}")),
            "Invalid authentication tag length: 0"
        );
        assert_eq!(
            message(format!("enc:v1:{iv}:{}:{ct}", b64(12))),
            "Invalid authentication tag length: 12"
        );
        assert_eq!(
            message(format!("enc:v1:{iv}:{}:{ct}", b64(17))),
            "Invalid authentication tag length: 17"
        );
        // A bad IV is reported before a bad tag, as Node made the cipher before it set the tag.
        assert_eq!(
            message(format!("enc:v1::{}:{ct}", b64(12))),
            "Invalid initialization vector"
        );
        assert_eq!(message(format!("enc:v1:{iv}:{tag}:!!!not base64!!!")), unauthentic);
        assert_eq!(message(format!("enc:v1:{iv}:{tag}:")), unauthentic);
    }

    #[test]
    fn base64_is_read_as_leniently_as_node_reads_it() {
        // Buffer.from(text, "base64").toString("hex") in Node.
        for (text, expected) in [
            ("QUJD", "414243"),
            ("QUJ", "4142"),
            ("QU", "41"),
            ("Q", ""),
            ("QUJD\n", "414243"),
            ("QU JD", "414243"),
            ("QUJD====", "414243"),
            ("QU=JD", "41"),
            ("Q!U@J#D", "414243"),
            ("-_-_", "fbffbf"),
            ("+/+/", "fbffbf"),
            ("QUJDRA", "41424344"),
            ("QUJDRA=", "41424344"),
            ("QUJDRA==", "41424344"),
            ("=QUJD", ""),
            ("é", ""),
        ] {
            assert_eq!(hex::encode(node_base64_decode(text)), expected, "{text:?}");
        }

        // So a value that picked up spaces or lost its padding, or was made URL-safe, still decrypts.
        let t = app();
        let good = encrypt(&t, "secret-value");
        let parts: Vec<&str> = good.split(':').collect();
        let (iv, tag, ct) = (parts[2], parts[3], parts[4]);
        let spaced = format!("enc:v1:{} {}:{tag}:{}\n{}", &iv[..5], &iv[5..], &ct[..3], &ct[3..]);
        assert_eq!(decrypt(&t, &spaced).unwrap(), "secret-value");
        assert_eq!(
            decrypt(&t, &good.replace('+', "-").replace('/', "_")).unwrap(),
            "secret-value"
        );
        assert_eq!(decrypt(&t, &good.replace('=', "")).unwrap(), "secret-value");
    }

    #[test]
    fn a_value_made_with_another_iv_length_decrypts_as_it_did_in_node() {
        // Made with Node's crypto from the fixture key (aes-256-gcm, a 16-byte tag) with IVs of 12, 1 and 128
        // bytes. The Node vault decrypts all three, so this one must.
        let t = fixture_app();
        for (value, plaintext) in [
            ("enc:v1:ludsq9/A32oOGWyP:0FYf304rsq4bQCAm1d6Zcg==:xrNwu2nG", "twelve"),
            ("enc:v1:EQ==:2Mv0EQgtYG5MoRYT6wyoUQ==:frNn", "one"),
            (
                "enc:v1:9DGishnhJ41gCWnJodji/UN9estnFWXsb2A1WuC+A/fb+mOModV3xmmPGJZItsdteamYLjyYBaTEWBguhRRTKm8oD/K0QsPPsOZxFrY3VZBHxWTTAtT9zU7GTYOXV9WSAbGm1vDKn7YkeAq3GoWm5gu2I+k/ADKBwxhdSNpTYqE=:/ZCCitl+1mhFXMmbESBe5A==:OAKfnQzQhxCvEONYnEUgmHv/RAw=",
                "hundred twenty-eight",
            ),
        ] {
            assert_eq!(decrypt(&t, value).unwrap(), plaintext, "{value}");
        }
    }

    // --- Structured values ---

    #[test]
    fn encrypt_secret_fields_touches_only_credential_strings() {
        let t = app();
        let structured = json!({
            "botToken": "123:abc",
            "empty_password": "",
            "password": "hunter2",
            "PASSPHRASE": "p",
            "nested": { "clientSecret": "s", "host": "h", "deeper": [{ "api_key": "k", "n": 1, "t": true, "z": null }] },
            "tokenCount": 5,
            "credential": null,
            "secretObj": { "inner": "x" },
            "list": ["a", "enc-no"],
            "apikey": "A"
        });
        let encrypted = encrypt_secret_fields(&t, &structured);
        let shape = |value: &Value| {
            let text = value.to_string();
            Regex::new(r#""enc:v1:[^"]+""#)
                .unwrap()
                .replace_all(&text, "\"<enc>\"")
                .into_owned()
        };
        // The shape Node's encryptSecretFields gave for the same value.
        assert_eq!(
            shape(&encrypted),
            json!({
                "botToken": "<enc>",
                "empty_password": "",
                "password": "<enc>",
                "PASSPHRASE": "<enc>",
                "nested": { "clientSecret": "<enc>", "host": "h", "deeper": [{ "api_key": "<enc>", "n": 1, "t": true, "z": null }] },
                "tokenCount": 5,
                "credential": null,
                "secretObj": { "inner": "x" },
                "list": ["a", "enc-no"],
                "apikey": "<enc>"
            })
            .to_string()
        );
        assert_eq!(decrypt_secret_fields(&t, &encrypted).unwrap(), structured);
        assert_eq!(encrypt_secret_fields(&t, &encrypted), encrypted, "idempotent");

        for scalar in [json!("str"), json!(5), json!(null), json!([{ "token": "" }, "x"])] {
            assert_eq!(encrypt_secret_fields(&t, &scalar), scalar);
        }
    }

    #[test]
    fn a_field_that_cannot_be_decrypted_comes_back_empty_but_a_bare_string_fails() {
        let t = app();
        let broken = json!({ "token": "enc:v1:bad", "keep": "x", "n": [1, { "p": "enc:v1:a:b:c:d" }] });
        assert_eq!(
            decrypt_secret_fields(&t, &broken).unwrap(),
            json!({ "token": "", "keep": "x", "n": [1, { "p": "" }] })
        );
        assert_eq!(
            decrypt_secret_fields(&t, &json!("enc:v1:bad")),
            Err(VaultError::Malformed)
        );
        assert_eq!(
            decrypt_secret_fields(&t, &json!(["enc:v1:bad"])),
            Err(VaultError::Malformed)
        );
        assert_eq!(decrypt_if_encrypted(&t, "enc:v1:bad"), Err(VaultError::Malformed));
        for plain in [json!("plain"), json!(7), json!(null), json!(false)] {
            assert_eq!(decrypt_secret_fields(&t, &plain).unwrap(), plain);
        }
        assert_eq!(decrypt_if_encrypted(&t, "plain").unwrap(), "plain");
    }

    #[test]
    fn redact_secret_fields_replaces_each_credential_with_a_has_marker() {
        let value = json!({
            "botToken": "123",
            "password": "",
            "apiKey": "k",
            "token": "t",
            "1secret": "s",
            "éPassword": "x",
            "host": "h",
            "nested": { "smtpPassword": "pw", "port": 25, "credentials": ["a"], "credentialObj": { "user": "u", "pass": "p" } },
            "list": [{ "secret": "s" }, 5, "str"],
            "tokenCount": 5,
            "nullToken": null
        });
        // What Node's redactSecretFields gave, key order included.
        let expected = json!({
            "hasBotToken": true,
            "hasPassword": false,
            "hasApiKey": true,
            "hasToken": true,
            "has1secret": true,
            "hasÉPassword": true,
            "host": "h",
            "nested": { "hasSmtpPassword": true, "port": 25, "credentials": ["a"], "credentialObj": { "user": "u", "pass": "p" } },
            "list": [{ "hasSecret": true }, 5, "str"],
            "tokenCount": 5,
            "nullToken": null
        });
        assert_eq!(redact_secret_fields(&value).to_string(), expected.to_string());
        for scalar in [json!("s"), json!(null), json!(3)] {
            assert_eq!(redact_secret_fields(&scalar), scalar);
        }
        // A first character of two UTF-16 units has no upper case of its own in JavaScript.
        assert_eq!(has_marker("𐐨token"), "has𐐨token");
        assert_eq!(has_marker("ßsecret"), "hasSSsecret");
        assert_eq!(has_marker(""), "has");
    }
}
