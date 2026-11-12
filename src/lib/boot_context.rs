//! Port of `src/lib/boot-context.js`: keeps a lightweight summary of recent activity across redeploys, so the AI knows
//! what was going on after a restart.

use std::fs;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};

use crate::app::App;
use crate::lib::workspace_files::jstext::{js_string, process_zone};
use crate::util::js::{ms_from_iso, now_iso, now_ms, truthy, utf16_truncate};

fn context_file(app: &App) -> PathBuf {
    app.config().workspace_dir.join(".boot-context.json")
}

/// Saves the current activity (called every 5 minutes and on a graceful shutdown): the three most recent
/// conversations with their last messages, and today's message count. A failure is logged, never raised.
pub fn save_boot_context(app: &App) {
    if let Err(err) = try_save(app) {
        log::warn!("[boot-context] Failed to save: {err}");
    }
}

fn try_save(app: &App) -> anyhow::Result<()> {
    let (recent, today_messages) = app.db().with(|conn| -> rusqlite::Result<_> {
        // The 3 most recent conversations with their last messages.
        let recent = crate::db::all(
            conn,
            "
      SELECT c.id, c.title, c.model, c.updated_at,
        (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY created_at DESC LIMIT 1) as last_user_msg,
        (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'assistant' ORDER BY created_at DESC LIMIT 1) as last_assistant_msg
      FROM conversations c
      ORDER BY c.updated_at DESC
      LIMIT 3
    ",
            [],
        )?;
        // Messages today.
        let count = crate::db::get(
            conn,
            "SELECT COUNT(*) as count FROM messages WHERE created_at >= date('now')",
            [],
        )?
        .and_then(|row| row.get("count").cloned())
        .filter(truthy)
        .unwrap_or(json!(0));
        Ok((recent, count))
    })?;

    let mut conversations = Vec::with_capacity(recent.len());
    for c in recent {
        let text_of = |key: &str| match c.get(key) {
            Some(Value::String(s)) => s.clone(),
            Some(v) if truthy(v) => js_string(Some(v)),
            _ => String::new(),
        };
        let last_user = text_of("last_user_msg");
        let mut last_assistant = text_of("last_assistant_msg");
        // Plain text out of a timeline message.
        if last_assistant.starts_with("{\"__timeline\":true")
            && let Ok(timeline) = serde_json::from_str::<Value>(&last_assistant)
        {
            last_assistant = match timeline.get("text") {
                Some(Value::String(text)) => text.clone(),
                Some(other) if truthy(other) => anyhow::bail!("lastAssistant.slice is not a function"),
                _ => String::new(),
            };
        }
        let mut entry = Map::new();
        entry.insert("title".into(), c.get("title").cloned().unwrap_or(Value::Null));
        entry.insert("model".into(), c.get("model").cloned().unwrap_or(Value::Null));
        entry.insert("updatedAt".into(), c.get("updated_at").cloned().unwrap_or(Value::Null));
        entry.insert("lastUserMessage".into(), Value::String(utf16_truncate(&last_user, 300)));
        entry.insert(
            "lastAssistantResponse".into(),
            Value::String(utf16_truncate(&last_assistant, 300)),
        );
        conversations.push(Value::Object(entry));
    }

    let context = json!({
        "savedAt": now_iso(),
        "todayMessages": today_messages,
        "recentConversations": conversations,
    });
    fs::write(context_file(app), serde_json::to_string_pretty(&context)?)?;
    Ok(())
}

/// The saved context as a short section for the system prompt (read on startup), or "" when there is none.
pub fn get_boot_context_summary(app: &App) -> String {
    boot_context_summary_at(app, now_ms())
}

fn boot_context_summary_at(app: &App, now: i64) -> String {
    let Ok(raw) = fs::read_to_string(context_file(app)) else {
        return String::new();
    };
    let Ok(ctx) = serde_json::from_str::<Value>(&raw) else {
        return String::new();
    };
    let Some(conversations) = ctx
        .get("recentConversations")
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
    else {
        return String::new();
    };

    // An unreadable time is NaN in the JS, which prints as "NaN".
    let saved_at = ctx.get("savedAt").and_then(Value::as_str).and_then(ms_from_iso);
    let age_str = match saved_at {
        Some(saved) if now - saved < 3_600_000 => format!("{}min", js_round((now - saved) as f64 / 60_000.0)),
        Some(saved) => format!("{}h", js_round((now - saved) as f64 / 3_600_000.0)),
        None => "NaNh".to_string(),
    };

    let mut summary = format!("\n\n## Boot Context (server restarted {age_str} ago)");
    summary += &format!("\nMessages today: {}", js_string(ctx.get("todayMessages")));

    let zone = process_zone(app.env());
    for conv in conversations {
        let updated = utc_time_of(conv.get("updatedAt"));
        // Conversations older than 24h are left out.
        if let Some(at) = updated
            && now - at > 24 * 3_600_000
        {
            continue;
        }
        let time = match updated.and_then(DateTime::<Utc>::from_timestamp_millis) {
            Some(at) => at.with_timezone(&zone).format("%-I:%M:%S %p").to_string(),
            None => "Invalid Date".to_string(),
        };
        let model = conv
            .get("model")
            .filter(|m| truthy(m))
            .map(|m| js_string(Some(m)))
            .unwrap_or_else(|| "unknown".into());
        summary += &format!("\n\n**{}** ({model}, {time}):", js_string(conv.get("title")));
        if let Some(user) = conv.get("lastUserMessage").filter(|v| truthy(v)) {
            summary += &format!("\n- User: \"{}\"", utf16_truncate(&js_string(Some(user)), 150));
        }
        if let Some(reply) = conv.get("lastAssistantResponse").filter(|v| truthy(v)) {
            summary += &format!("\n- You replied: \"{}\"", utf16_truncate(&js_string(Some(reply)), 150));
        }
    }

    summary
}

/// `new Date(updatedAt + "Z")`: SQLite's UTC time ("2026-11-12 08:30:00") read as UTC. `None` is an invalid date.
fn utc_time_of(value: Option<&Value>) -> Option<i64> {
    let text = value?.as_str()?;
    // A time that already names its zone gets a second "Z", which no date parser accepts.
    if text.ends_with('Z') || text.contains('+') {
        return None;
    }
    ms_from_iso(text)
}

/// `Math.round`.
fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::test_app_with_env;

    fn add_conversation(app: &App, id: &str, title: &str, model: Option<&str>, updated: &str) {
        app.db()
            .with(|c| {
                c.execute(
                    "INSERT INTO conversations (id, title, model, updated_at) VALUES (?, ?, ?, ?)",
                    rusqlite::params![id, title, model, updated],
                )
            })
            .unwrap();
    }

    fn add_message(app: &App, conv: &str, role: &str, content: &str, at: &str) {
        app.db()
            .with(|c| {
                c.execute(
                    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                    rusqlite::params![uuid::Uuid::new_v4().to_string(), conv, role, content, at],
                )
            })
            .unwrap();
    }

    #[test]
    fn the_three_newest_conversations_are_saved_with_their_last_messages() {
        let t = test_app_with_env([("TZ", "UTC")]);
        let today = Utc::now().format("%Y-%m-%d").to_string();
        add_conversation(&t, "a", "Oldest", Some("sonnet"), "2026-01-01 00:00:00");
        add_conversation(&t, "b", "Middle", None, "2026-01-02 00:00:00");
        add_conversation(&t, "c", "Newer", Some("opus"), "2026-01-03 00:00:00");
        add_conversation(&t, "d", "Newest", Some("haiku"), "2026-01-04 00:00:00");
        add_message(&t, "d", "user", "first question", "2026-01-04 00:00:00");
        add_message(&t, "d", "user", &"é".repeat(400), "2026-01-04 00:00:01");
        let timeline = json!({"__timeline": true, "text": "the answer", "steps": []}).to_string();
        add_message(&t, "d", "assistant", &timeline, &format!("{today} 00:00:02"));
        add_message(&t, "c", "assistant", "plain reply", &format!("{today} 00:00:03"));

        save_boot_context(&t);
        let saved: Value = serde_json::from_str(&fs::read_to_string(context_file(&t)).unwrap()).unwrap();
        assert_eq!(saved["todayMessages"], 2);
        assert!(saved["savedAt"].as_str().unwrap().ends_with('Z'));
        assert_eq!(
            saved["recentConversations"],
            json!([
                {"title": "Newest", "model": "haiku", "updatedAt": "2026-01-04 00:00:00",
                 "lastUserMessage": "é".repeat(300), "lastAssistantResponse": "the answer"},
                {"title": "Newer", "model": "opus", "updatedAt": "2026-01-03 00:00:00",
                 "lastUserMessage": "", "lastAssistantResponse": "plain reply"},
                {"title": "Middle", "model": null, "updatedAt": "2026-01-02 00:00:00",
                 "lastUserMessage": "", "lastAssistantResponse": ""},
            ])
        );
        // Written as JSON.stringify(context, null, 2) wrote it.
        assert!(
            fs::read_to_string(context_file(&t))
                .unwrap()
                .starts_with("{\n  \"savedAt\": ")
        );
    }

    #[test]
    fn the_summary_names_recent_conversations_and_skips_old_ones() {
        let t = test_app_with_env([("TZ", "Asia/Manila")]);
        let now = ms_from_iso("2026-11-12T10:00:00.000Z").unwrap();
        assert_eq!(boot_context_summary_at(&t, now), "", "nothing saved yet");
        let ctx = json!({
            "savedAt": "2026-11-12T09:35:00.000Z",
            "todayMessages": 7,
            "recentConversations": [
                {"title": "Invoices", "model": "opus", "updatedAt": "2026-11-12 09:30:05",
                 "lastUserMessage": format!("{}tail", "x".repeat(150)), "lastAssistantResponse": "Done."},
                {"title": "Quiet", "model": null, "updatedAt": "2026-11-12 01:00:00",
                 "lastUserMessage": "", "lastAssistantResponse": ""},
                {"title": "Last week", "model": "haiku", "updatedAt": "2026-11-05 09:00:00",
                 "lastUserMessage": "old", "lastAssistantResponse": "old"},
            ]
        });
        fs::write(context_file(&t), ctx.to_string()).unwrap();
        assert_eq!(
            boot_context_summary_at(&t, now),
            format!(
                "\n\n## Boot Context (server restarted 25min ago)\nMessages today: 7\n\n**Invoices** (opus, 5:30:05 PM):\n- User: \"{}\"\n- You replied: \"Done.\"\n\n**Quiet** (unknown, 9:00:00 AM):",
                "x".repeat(150)
            )
        );
        let later = ms_from_iso("2026-11-12T12:05:00.000Z").unwrap();
        assert!(boot_context_summary_at(&t, later).starts_with("\n\n## Boot Context (server restarted 3h ago)"));
    }

    #[test]
    fn an_empty_or_broken_context_says_nothing() {
        let t = test_app_with_env([("TZ", "UTC")]);
        fs::write(context_file(&t), "{\"recentConversations\": []}").unwrap();
        assert_eq!(get_boot_context_summary(&t), "");
        fs::write(context_file(&t), "not json").unwrap();
        assert_eq!(get_boot_context_summary(&t), "");
        fs::write(
            context_file(&t),
            json!({"recentConversations": [{"title": "T", "updatedAt": null}]}).to_string(),
        )
        .unwrap();
        assert_eq!(
            get_boot_context_summary(&t),
            "\n\n## Boot Context (server restarted NaNh ago)\nMessages today: undefined\n\n**T** (unknown, Invalid Date):"
        );
    }
}
