//! Port of `src/lib/automation-approval.js`: the owner's OK for HEARTBEAT.md and BOOT.md.
//!
//! Both files run the AI on their own: HEARTBEAT.md every 30 minutes (`lib/heartbeat.rs`), BOOT.md when Tarsee
//! restarts (`lib/boot_runner.rs`), and each run is paid for. The AI can write either file with its file tools in any
//! chat, so neither runs text the owner hasn't OK'd. The owner OKs a text by:
//!   - saving it in Settings > Automation's editor (the editor's autosave, then POST
//!     /api/automation-approval/approve with via "editor"), or
//!   - clicking Let it run (BOOT.md: Run at each restart) on the "Changed outside Settings" note, which OKs only the
//!     text the page showed (`routes/automation_approval.rs`).
//!
//! Both come only from the owner's signed-in dashboard: the API token can't OK anything.
//!
//! The first start of this version OKs what is already there, once ([`upgrade_approval`]), so an existing install
//! keeps running exactly as it did.
//!
//! Kept in the settings, per file (<key> is "heartbeat" or "boot"):
//!   <key>.approvedHash   text_hash() of the OK'd text
//!   <key>.approval       { by, at }: by is "editor" (saved in Settings), "button" (the note's button) or "upgrade"
//!   <key>.waiting        { hash, since }: a text that changed outside Settings and waits for the owner's OK
//! POST /api/settings/general refuses these keys ([`is_approval_key`]): only the routes above write them.

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::app::App;
use crate::db::settings::Settings;
use crate::lib::workspace_files::{
    WORKSPACE_FILE_MAX_BYTES, get_boot_context, get_heartbeat_context, read_workspace_file, truncate_content,
};
use crate::util::js::{now_iso, truthy};

/// The files that need the owner's OK, with their settings key.
pub const AUTOMATION_FILES: &[(&str, &str)] = &[("HEARTBEAT.md", "heartbeat"), ("BOOT.md", "boot")];

const APPROVAL_FIELDS: &[&str] = &["approvedHash", "approval", "waiting"];

/// Asked about a file that is neither HEARTBEAT.md nor BOOT.md.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Only HEARTBEAT.md and BOOT.md need the owner's OK")]
pub struct NotAnAutomationFile;

pub fn is_automation_file(name: &str) -> bool {
    AUTOMATION_FILES.iter().any(|(n, _)| *n == name)
}

/// Whether a settings key holds the owner's OK (or the note that one is waited for).
pub fn is_approval_key(key: &str) -> bool {
    AUTOMATION_FILES
        .iter()
        .any(|(_, k)| APPROVAL_FIELDS.iter().any(|f| key == format!("{k}.{f}")))
}

fn key_of(name: &str) -> Result<&'static str, NotAnAutomationFile> {
    AUTOMATION_FILES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, k)| *k)
        .ok_or(NotAnAutomationFile)
}

/// What the file would send to the AI now ("" when it holds nothing to do).
fn prompt_of(app: &App, name: &str) -> String {
    if name == "BOOT.md" {
        get_boot_context(app)
    } else {
        get_heartbeat_context(app)
    }
}

/// The text with its line endings made one kind, so a file saved on Windows matches the text the page showed.
pub fn normalize_text(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// What is stored for an OK'd text. Prefixed, so the settings store never reads it back as a number.
pub fn text_hash(text: &str) -> String {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(normalize_text(text).as_bytes()))
    )
}

fn is_present(value: Option<Value>) -> bool {
    value.is_some_and(|v| !v.is_null())
}

fn clear_waiting(store: &dyn Settings, key: &str) {
    if is_present(store.get(&format!("{key}.waiting"))) {
        store.delete(&format!("{key}.waiting"));
    }
}

/// Who OK'd a text, and when: `{ by, at }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Approval {
    pub by: String,
    pub at: String,
}

/// The owner's OK for `text`: what runs from now on, until the file changes.
pub fn approve_text(store: &dyn Settings, name: &str, text: &str, by: &str) -> anyhow::Result<Approval> {
    let key = key_of(name)?;
    let approval = Approval {
        by: by.to_string(),
        at: now_iso(),
    };
    store.set(&format!("{key}.approvedHash"), Value::String(text_hash(text)))?;
    store.set(&format!("{key}.approval"), json!(approval))?;
    clear_waiting(store, key);
    Ok(approval)
}

/// What [`approve_if_unchanged`] did: `{ ok: false }`, or `{ ok: true, changed }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ApproveOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed: Option<bool>,
}

/// The owner's OK for the text the page showed. Approves only when the file still holds that text (line endings
/// aside); otherwise nothing is OK'd and `{ ok: false }` comes back, for the page to show the new text. `changed`
/// says whether the OK'd text is another one than before (the editor's autosave OKs the same text again and again).
pub fn approve_if_unchanged(
    app: &App,
    store: &dyn Settings,
    name: &str,
    shown_text: &str,
    by: &str,
) -> anyhow::Result<ApproveOutcome> {
    let key = key_of(name)?;
    let current = read_workspace_file(app, name);
    if normalize_text(&current) != normalize_text(shown_text) {
        return Ok(ApproveOutcome {
            ok: false,
            changed: None,
        });
    }
    let changed = store.get(&format!("{key}.approvedHash")) != Some(Value::String(text_hash(&current)));
    approve_text(store, name, &current, by)?;
    Ok(ApproveOutcome {
        ok: true,
        changed: Some(changed),
    })
}

fn say(log: Option<&dyn Fn(&str)>, line: &str) {
    match log {
        Some(log) => log(line),
        None => log::info!("{line}"),
    }
}

/// The first start of this version: no OK is stored yet for `name`, so what is there now (written under an older
/// Tarsee, which ran it without asking) counts as OK'd, and that is noted (`{ by: "upgrade" }`). Runs once: after
/// it, an OK is always stored, so a change the AI makes later waits, through restarts too. Returns whether it ran.
/// `log` defaults to the log (`console.log`).
pub fn upgrade_approval(
    app: &App,
    store: &dyn Settings,
    name: &str,
    log: Option<&dyn Fn(&str)>,
) -> anyhow::Result<bool> {
    let key = key_of(name)?;
    if is_present(store.get(&format!("{key}.approvedHash"))) {
        return Ok(false);
    }
    let text = read_workspace_file(app, name);
    approve_text(store, name, &text, "upgrade")?;
    if !prompt_of(app, name).is_empty() {
        say(
            log,
            &format!(
                "[{key}] first start of this version: the {name} already here counts as OK'd by the owner, so it keeps running as before. From now on a change made outside Settings waits for the owner's OK."
            ),
        );
    }
    Ok(true)
}

/// Whether a file may run now: `{ run: true, prompt }` for text the owner has OK'd; otherwise `{ run: false,
/// reason }` with `empty: true` (nothing to do, as before) or `waiting: true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Gate {
    pub run: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub empty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Whether `name` may run now, and what it sends. A text that waits is noted in the settings (`<key>.waiting`) and
/// logged once a change, not at every check.
pub fn gate_automation(
    app: &App,
    store: &dyn Settings,
    name: &str,
    log: Option<&dyn Fn(&str)>,
) -> anyhow::Result<Gate> {
    let key = key_of(name)?;
    let text = read_workspace_file(app, name);
    let prompt = prompt_of(app, name);
    let no_run = |reason: String| Gate {
        run: false,
        prompt: None,
        empty: None,
        waiting: None,
        reason: Some(reason),
    };
    if prompt.is_empty() {
        clear_waiting(store, key);
        return Ok(Gate {
            empty: Some(true),
            ..no_run(format!("{name} is empty"))
        });
    }
    // The prompt comes from a second read of the file. Should a write land between the two, what would be sent
    // isn't the text checked below: nothing runs this time, and the next check sees the file as it is.
    if prompt != truncate_content(&text, WORKSPACE_FILE_MAX_BYTES) {
        return Ok(no_run(format!(
            "{name} changed while Tarsee was reading it: checked again next time"
        )));
    }
    let hash = text_hash(&text);
    if store.get(&format!("{key}.approvedHash")) == Some(Value::String(hash.clone())) {
        clear_waiting(store, key);
        return Ok(Gate {
            run: true,
            prompt: Some(prompt),
            empty: None,
            waiting: None,
            reason: None,
        });
    }
    let reason = format!("{name} changed outside Settings: waiting for the owner's OK");
    let waited_hash = store
        .get(&format!("{key}.waiting"))
        .and_then(|w| w.get("hash").cloned());
    if waited_hash != Some(Value::String(hash.clone())) {
        store.set(&format!("{key}.waiting"), json!({ "hash": hash, "since": now_iso() }))?;
        say(log, &format!("[{key}] {reason}"));
    }
    Ok(Gate {
        waiting: Some(true),
        ..no_run(reason)
    })
}

/// One file as Settings > Automation shows it. `waiting` means it holds something to do that the owner hasn't
/// OK'd.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationStatus {
    pub name: String,
    pub text: String,
    pub empty: bool,
    pub approved: bool,
    pub waiting: bool,
    /// `{ by, at }`, or null.
    pub approval: Value,
    /// When the waiting text was first seen, or null.
    pub waiting_since: Value,
}

pub fn automation_status(app: &App, store: &dyn Settings, name: &str) -> anyhow::Result<AutomationStatus> {
    let key = key_of(name)?;
    let text = read_workspace_file(app, name);
    let empty = prompt_of(app, name).is_empty();
    let hash = text_hash(&text);
    let approved = store.get(&format!("{key}.approvedHash")) == Some(Value::String(hash.clone()));
    let approval = match store.get(&format!("{key}.approval")) {
        Some(v @ (Value::Object(_) | Value::Array(_))) => v,
        _ => Value::Null,
    };
    let waiting = store.get(&format!("{key}.waiting"));
    let waiting_since = match &waiting {
        Some(w) if !empty && !approved && w.get("hash") == Some(&Value::String(hash)) => {
            w.get("since").filter(|s| truthy(s)).cloned().unwrap_or(Value::Null)
        }
        _ => Value::Null,
    };
    Ok(AutomationStatus {
        name: name.to_string(),
        text,
        empty,
        approved,
        waiting: !empty && !approved,
        approval,
        waiting_since,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::workspace_files::write_workspace_file;
    use crate::testkit::{MemorySettings, test_app};
    use std::cell::RefCell;

    const TASK: &str = "# Heartbeat\n\n- Check the inbox and summarise it.\n";

    #[test]
    fn the_files_and_keys_are_known() {
        assert!(is_automation_file("HEARTBEAT.md") && is_automation_file("BOOT.md"));
        assert!(!is_automation_file("SOUL.md"));
        for key in [
            "heartbeat.approvedHash",
            "heartbeat.approval",
            "heartbeat.waiting",
            "boot.approvedHash",
            "boot.approval",
            "boot.waiting",
        ] {
            assert!(is_approval_key(key), "{key}");
        }
        assert!(!is_approval_key("heartbeat.enabled"));
        assert!(!is_approval_key("heartbeat.approvedHashX"));
        let store = MemorySettings::new();
        assert_eq!(
            approve_text(&store, "SOUL.md", "x", "editor").unwrap_err().to_string(),
            "Only HEARTBEAT.md and BOOT.md need the owner's OK"
        );
    }

    #[test]
    fn a_hash_ignores_line_endings() {
        assert_eq!(text_hash("a\r\nb\rc"), text_hash("a\nb\nc"));
        assert_eq!(
            text_hash(""),
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(normalize_text("a\r\n\r\rb"), "a\n\n\nb");
        // Checked against Node.
        assert_eq!(
            text_hash("# Heartbeat\r\n\r\n- Check the inbox and summarise it.\n"),
            "sha256:00d94d696f3722006335a5352be405d582fa2537a64c570ab6aeb8099a74b846"
        );
        assert_eq!(
            text_hash("é🐒\r"),
            "sha256:b099fd1d55caefba0dda1f0fbe06aa5084cc1efc3b2ac0b999929bb24e8b8dbf"
        );
    }

    #[test]
    fn text_waits_for_the_owners_ok_then_runs() {
        let t = test_app();
        let store = MemorySettings::new();
        let logged = RefCell::new(Vec::<String>::new());
        let log = |line: &str| logged.borrow_mut().push(line.to_string());

        // The default file holds nothing to do.
        let gate = gate_automation(&t, &store, "HEARTBEAT.md", Some(&log)).unwrap();
        assert_eq!(
            serde_json::to_value(&gate).unwrap(),
            json!({"run": false, "empty": true, "reason": "HEARTBEAT.md is empty"})
        );

        write_workspace_file(&t, "HEARTBEAT.md", TASK).unwrap();
        let gate = gate_automation(&t, &store, "HEARTBEAT.md", Some(&log)).unwrap();
        assert_eq!(
            serde_json::to_value(&gate).unwrap(),
            json!({"run": false, "waiting": true, "reason": "HEARTBEAT.md changed outside Settings: waiting for the owner's OK"})
        );
        gate_automation(&t, &store, "HEARTBEAT.md", Some(&log)).unwrap();
        assert_eq!(
            *logged.borrow(),
            ["[heartbeat] HEARTBEAT.md changed outside Settings: waiting for the owner's OK"],
            "logged once a change, not at every check"
        );
        let waiting = store.get("heartbeat.waiting").unwrap();
        assert_eq!(waiting["hash"], text_hash(TASK));

        let status = automation_status(&t, &store, "HEARTBEAT.md").unwrap();
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({"name": "HEARTBEAT.md", "text": TASK, "empty": false, "approved": false, "waiting": true,
                   "approval": null, "waitingSince": waiting["since"]})
        );

        // The page showed an older text: nothing is OK'd.
        let stale = approve_if_unchanged(&t, &store, "HEARTBEAT.md", "# Heartbeat\n", "button").unwrap();
        assert_eq!(serde_json::to_value(stale).unwrap(), json!({"ok": false}));
        let ok = approve_if_unchanged(&t, &store, "HEARTBEAT.md", &TASK.replace('\n', "\r\n"), "button").unwrap();
        assert_eq!(serde_json::to_value(ok).unwrap(), json!({"ok": true, "changed": true}));
        assert_eq!(store.get("heartbeat.waiting"), None, "no longer waiting");
        let again = approve_if_unchanged(&t, &store, "HEARTBEAT.md", TASK, "editor").unwrap();
        assert_eq!(again.changed, Some(false));

        let gate = gate_automation(&t, &store, "HEARTBEAT.md", Some(&log)).unwrap();
        assert_eq!(
            serde_json::to_value(&gate).unwrap(),
            json!({"run": true, "prompt": TASK})
        );
        let status = automation_status(&t, &store, "HEARTBEAT.md").unwrap();
        assert!(status.approved && !status.waiting);
        assert_eq!(status.approval["by"], "editor");
        assert_eq!(status.waiting_since, Value::Null);
    }

    #[test]
    fn the_first_start_oks_what_is_there_once() {
        let t = test_app();
        let store = MemorySettings::new();
        let logged = RefCell::new(Vec::<String>::new());
        let log = |line: &str| logged.borrow_mut().push(line.to_string());
        write_workspace_file(&t, "BOOT.md", "# Boot\n\n- Say good morning on Telegram.\n").unwrap();
        assert!(upgrade_approval(&t, &store, "BOOT.md", Some(&log)).unwrap());
        assert_eq!(
            *logged.borrow(),
            [
                "[boot] first start of this version: the BOOT.md already here counts as OK'd by the owner, so it keeps running as before. From now on a change made outside Settings waits for the owner's OK."
            ]
        );
        assert_eq!(store.get("boot.approval").unwrap()["by"], "upgrade");
        assert!(!upgrade_approval(&t, &store, "BOOT.md", Some(&log)).unwrap(), "once");
        assert!(gate_automation(&t, &store, "BOOT.md", Some(&log)).unwrap().run);

        // An empty heartbeat is OK'd quietly.
        let quiet = RefCell::new(0);
        let count = |_: &str| *quiet.borrow_mut() += 1;
        assert!(upgrade_approval(&t, &store, "HEARTBEAT.md", Some(&count)).unwrap());
        assert_eq!(*quiet.borrow(), 0);
    }

    #[test]
    fn an_odd_stored_approval_shows_as_none() {
        let t = test_app();
        let store = MemorySettings::from_pairs([("boot.approval", json!("yes"))]);
        assert_eq!(automation_status(&t, &store, "BOOT.md").unwrap().approval, Value::Null);
        assert!(automation_status(&t, &store, "BOOT.md").unwrap().empty);
    }
}
