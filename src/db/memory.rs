//! Port of `src/db/memory.js`: the persistent memory store for the bot's identity and learned preferences. Memories
//! survive across conversations and restarts, and are synced to MEMORY.md on the workspace volume.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::app::App;
use crate::db::Row;
use crate::lib::workspace_files::jstext::{js_collapse_spaces, js_key_order, js_split_spaces, js_trim};
use crate::lib::workspace_files::{append_workspace_file, read_workspace_file, write_workspace_file};
use crate::util::js::utf16_len;

/// One row of `bot_memory`, as `SELECT *` gave it (and, from `search`, with its score).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Memory {
    pub id: String,
    pub category: String,
    pub content: String,
    pub source_conversation_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// How many of the query's words it holds (`search` only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<usize>,
}

/// What `add` returns: `{ id, category, content }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NewMemory {
    pub id: String,
    pub category: String,
    pub content: String,
}

/// `getStats()`: `{ total, byCategory, oldestDate, newestDate }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub total: i64,
    pub by_category: Map<String, Value>,
    pub oldest_date: Option<String>,
    pub newest_date: Option<String>,
}

/// How much of one memory goes into the system prompt.
pub const MEMORY_PROMPT_MAX_CHARS: usize = 300;

fn text_of(row: &Row, column: &str) -> String {
    match row.get(column) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn memory_of(row: &Row) -> Memory {
    Memory {
        id: text_of(row, "id"),
        category: text_of(row, "category"),
        content: text_of(row, "content"),
        source_conversation_id: match row.get("source_conversation_id") {
            Some(Value::Null) | None => None,
            Some(_) => Some(text_of(row, "source_conversation_id")),
        },
        created_at: text_of(row, "created_at"),
        updated_at: text_of(row, "updated_at"),
        score: None,
    }
}

/// The memory store, over the app's database and workspace.
#[derive(Clone)]
pub struct MemoryStore {
    app: App,
}

impl MemoryStore {
    pub fn new(app: &App) -> Self {
        MemoryStore { app: app.clone() }
    }

    fn rows(&self, sql: &str, params: impl rusqlite::Params) -> rusqlite::Result<Vec<Memory>> {
        self.app
            .db()
            .with(|conn| crate::db::all(conn, sql, params))
            .map(|rows| rows.iter().map(memory_of).collect())
    }

    /// Saves a memory (default category "preference").
    pub fn add(&self, content: &str, category: &str, conversation_id: Option<&str>) -> rusqlite::Result<NewMemory> {
        let id = uuid::Uuid::new_v4().to_string();
        self.app.db().with(|conn| {
            crate::db::run(
                conn,
                "INSERT INTO bot_memory (id, category, content, source_conversation_id) VALUES (?, ?, ?, ?)",
                rusqlite::params![id, category, content, conversation_id],
            )
        })?;
        Ok(NewMemory {
            id,
            category: category.to_string(),
            content: content.to_string(),
        })
    }

    pub fn get(&self, id: &str) -> rusqlite::Result<Option<Memory>> {
        Ok(self
            .rows("SELECT * FROM bot_memory WHERE id = ?", [id])?
            .into_iter()
            .next())
    }

    /// Changes a memory's text; false when there is none with that id.
    pub fn update(&self, id: &str, content: &str) -> rusqlite::Result<bool> {
        let done = self.app.db().with(|conn| {
            crate::db::run(
                conn,
                "UPDATE bot_memory SET content = ?, updated_at = datetime('now') WHERE id = ?",
                [content, id],
            )
        })?;
        Ok(done.changes > 0)
    }

    /// The most recently changed memories (default 50), of one category when given.
    pub fn list(&self, limit: i64, category: Option<&str>) -> rusqlite::Result<Vec<Memory>> {
        match category.filter(|c| !c.is_empty()) {
            Some(category) => self.rows(
                "SELECT * FROM bot_memory WHERE category = ? ORDER BY updated_at DESC LIMIT ?",
                rusqlite::params![category, limit],
            ),
            None => self.rows("SELECT * FROM bot_memory ORDER BY updated_at DESC LIMIT ?", [limit]),
        }
    }

    /// The memories holding any of the query's words, most matching words first, then most recent (default 20).
    pub fn search(&self, query: &str, limit: usize) -> rusqlite::Result<Vec<Memory>> {
        let lower = query.to_lowercase();
        let words: Vec<&str> = js_split_spaces(&lower).into_iter().filter(|w| !w.is_empty()).collect();
        if words.is_empty() {
            return Ok(Vec::new());
        }

        // Any row matching at least one word.
        let conditions = vec!["LOWER(content) LIKE ?"; words.len()].join(" OR ");
        let params: Vec<String> = words.iter().map(|w| format!("%{w}%")).collect();
        let rows = self.rows(
            &format!("SELECT * FROM bot_memory WHERE {conditions} ORDER BY updated_at DESC"),
            rusqlite::params_from_iter(params),
        )?;

        // Score each row by how many query words it matches.
        let mut scored: Vec<Memory> = rows
            .into_iter()
            .map(|mut row| {
                let content = row.content.to_lowercase();
                row.score = Some(words.iter().filter(|w| content.contains(**w)).count());
                row
            })
            .collect();
        // By score, then by recency; a stable sort keeps the query's order for ties.
        scored.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| b.updated_at.cmp(&a.updated_at)));
        scored.truncate(limit);
        Ok(scored)
    }

    /// Deletes a memory; false when there is none with that id.
    pub fn delete(&self, id: &str) -> rusqlite::Result<bool> {
        let done = self
            .app
            .db()
            .with(|conn| crate::db::run(conn, "DELETE FROM bot_memory WHERE id = ?", [id]))?;
        Ok(done.changes > 0)
    }

    pub fn count(&self) -> rusqlite::Result<i64> {
        self.app
            .db()
            .with(|conn| conn.query_row("SELECT COUNT(*) as count FROM bot_memory", [], |r| r.get(0)))
    }

    /// The most recent memories of one category (default 10).
    pub fn get_recent_by_category(&self, category: &str, limit: i64) -> rusqlite::Result<Vec<Memory>> {
        self.rows(
            "SELECT * FROM bot_memory WHERE category = ? ORDER BY updated_at DESC LIMIT ?",
            rusqlite::params![category, limit],
        )
    }

    /// Merges near-duplicate memories (the same first 50 characters, whatever their case): the most recent stays,
    /// the older ones are deleted. Returns how many were removed.
    pub fn consolidate(&self) -> rusqlite::Result<usize> {
        let all = self.rows("SELECT * FROM bot_memory ORDER BY updated_at DESC", [])?;
        let mut seen = std::collections::HashSet::new();
        let mut to_delete = Vec::new();
        for row in all {
            let start = String::from_utf16_lossy(&row.content.encode_utf16().take(50).collect::<Vec<_>>());
            let prefix = js_trim(&start.to_lowercase()).to_string();
            // The list is newest first, so a prefix seen already marks an older row.
            if !seen.insert(prefix) {
                to_delete.push(row.id);
            }
        }
        if !to_delete.is_empty() {
            self.app.db().transaction(|conn| -> rusqlite::Result<()> {
                for id in &to_delete {
                    crate::db::run(conn, "DELETE FROM bot_memory WHERE id = ?", [id])?;
                }
                Ok(())
            })?;
        }
        Ok(to_delete.len())
    }

    /// The total, the count by category (largest first), and the oldest and newest dates.
    pub fn get_stats(&self) -> rusqlite::Result<MemoryStats> {
        let total = self.count()?;
        self.app.db().with(|conn| {
            let rows = crate::db::all(
                conn,
                "SELECT category, COUNT(*) as count FROM bot_memory GROUP BY category ORDER BY count DESC",
                [],
            )?;
            let mut counts = Map::new();
            for row in rows {
                counts.insert(
                    text_of(&row, "category"),
                    row.get("count").cloned().unwrap_or(Value::Null),
                );
            }
            // Object.fromEntries: a category named like a number comes first, as in any JavaScript object.
            let by_category: Map<String, Value> = js_key_order(&counts)
                .into_iter()
                .map(|k| (k.clone(), counts[k].clone()))
                .collect();
            let date = |sql: &str| -> rusqlite::Result<Option<String>> {
                Ok(crate::db::get(conn, sql, [])?
                    .map(|row| text_of(&row, "created_at"))
                    .filter(|d| !d.is_empty()))
            };
            Ok(MemoryStats {
                total,
                by_category,
                oldest_date: date("SELECT created_at FROM bot_memory ORDER BY created_at ASC LIMIT 1")?,
                newest_date: date("SELECT created_at FROM bot_memory ORDER BY created_at DESC LIMIT 1")?,
            })
        })
    }

    /// The memories as a section of the system prompt (default 20 of them, each cut to 300 characters), or "" when
    /// there are none. These add to MEMORY.md, which is the primary source.
    pub fn get_context_string(&self, limit: i64, max_chars: usize) -> rusqlite::Result<String> {
        let memories = self.list(limit, None)?;
        if memories.is_empty() {
            return Ok(String::new());
        }
        // Each memory is a one-line reminder here, not the whole note: a row can hold a full write-up (10 rows were
        // once 14KB of a 50KB prompt, about 3.5k tokens re-read on every model call). The full text stays in the
        // table and is found by searching memory.
        let lines: Vec<String> = memories
            .iter()
            .map(|m| format!("- [{}] {}", m.category, clip_memory(&m.content, max_chars)))
            .collect();
        Ok(format!(
            "\n\nAdditional quick memories (shortened; search memory for the full note):\n{}",
            lines.join("\n")
        ))
    }

    /// Saves a memory and also appends it to MEMORY.md (best effort).
    pub fn add_and_sync(
        &self,
        content: &str,
        category: &str,
        conversation_id: Option<&str>,
    ) -> rusqlite::Result<NewMemory> {
        let result = self.add(content, category, conversation_id)?;
        let _ = append_workspace_file(&self.app, "MEMORY.md", &format!("\n- [{category}] {content}"));
        Ok(result)
    }

    /// One-time migration: writes the stored memories into MEMORY.md while it is still the default template.
    pub fn sync_to_memory_file(&self) {
        let synced = (|| -> anyhow::Result<()> {
            let existing = read_workspace_file(&self.app, "MEMORY.md");
            let memories = self.list(100, None)?;
            if memories.is_empty() {
                return Ok(());
            }
            // Only while MEMORY.md is still the default template.
            if existing.contains("<!-- Curated memories are stored here -->") && !existing.contains("- [") {
                let lines: Vec<String> = memories
                    .iter()
                    .map(|m| format!("- [{}] {}", m.category, m.content))
                    .collect();
                write_workspace_file(
                    &self.app,
                    "MEMORY.md",
                    &format!("# Long-Term Memory\n\n{}\n", lines.join("\n")),
                )?;
                log::info!("[memory] Migrated {} DB memories to MEMORY.md", memories.len());
            }
            Ok(())
        })();
        if let Err(err) = synced {
            log::warn!("[memory] syncToMemoryFile error: {err}");
        }
    }
}

/// One memory as a single line of at most `max` characters (UTF-16 units, as the JS counted).
pub fn clip_memory(text: &str, max: usize) -> String {
    let collapsed = js_collapse_spaces(text, " ");
    let flat = js_trim(&collapsed);
    if utf16_len(flat) <= max {
        return flat.to_string();
    }
    let units: Vec<u16> = flat.encode_utf16().collect();
    let cut = &units[..max];
    let kept = match cut.iter().rposition(|&u| u == u16::from(b' ')) {
        Some(sp) if sp as f64 > max as f64 * 0.7 => &cut[..sp],
        _ => cut,
    };
    format!("{}…", String::from_utf16_lossy(kept))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{CapturedLogs, TestApp, test_app};
    use serde_json::json;

    fn store() -> (TestApp, MemoryStore) {
        let t = test_app();
        let store = MemoryStore::new(&t);
        (t, store)
    }

    fn set_updated(t: &TestApp, id: &str, at: &str) {
        t.db()
            .with(|c| {
                c.execute(
                    "UPDATE bot_memory SET updated_at = ?, created_at = ? WHERE id = ?",
                    [at, at, id],
                )
            })
            .unwrap();
    }

    #[test]
    fn memories_are_added_read_changed_listed_and_deleted() {
        let (t, store) = store();
        let a = store.add("Prefers Telegram.", "preference", None).unwrap();
        assert_eq!(a.category, "preference");
        let b = store.add("Works at a bakery", "fact", Some("conv-1")).unwrap();
        set_updated(&t, &a.id, "2026-01-01 00:00:00");
        set_updated(&t, &b.id, "2026-01-02 00:00:00");
        let got = store.get(&b.id).unwrap().unwrap();
        assert_eq!(got.source_conversation_id.as_deref(), Some("conv-1"));
        assert_eq!(
            serde_json::to_value(&got)
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            [
                "id",
                "category",
                "content",
                "source_conversation_id",
                "created_at",
                "updated_at"
            ]
        );
        assert_eq!(store.get("nope").unwrap(), None);
        assert_eq!(
            store
                .list(50, None)
                .unwrap()
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            [b.id.as_str(), a.id.as_str()]
        );
        assert_eq!(store.list(1, None).unwrap().len(), 1);
        assert_eq!(store.list(50, Some("fact")).unwrap().len(), 1);
        assert_eq!(store.get_recent_by_category("preference", 10).unwrap()[0].id, a.id);
        assert_eq!(store.count().unwrap(), 2);
        assert!(store.update(&a.id, "Prefers WhatsApp.").unwrap());
        assert!(!store.update("nope", "x").unwrap());
        assert_eq!(
            store.list(50, None).unwrap()[0].content,
            "Prefers WhatsApp.",
            "updated is newest"
        );
        assert!(store.delete(&a.id).unwrap());
        assert!(!store.delete(&a.id).unwrap());
        assert_eq!(store.count().unwrap(), 1);
    }

    #[test]
    fn search_ranks_by_matching_words_then_recency() {
        let (t, store) = store();
        let one = store.add("The owner likes green tea", "preference", None).unwrap();
        let both = store.add("Green tea, never coffee", "preference", None).unwrap();
        let newer = store.add("Tea in the afternoon", "preference", None).unwrap();
        store.add("Unrelated", "fact", None).unwrap();
        set_updated(&t, &one.id, "2026-01-01 00:00:00");
        set_updated(&t, &both.id, "2026-01-02 00:00:00");
        set_updated(&t, &newer.id, "2026-01-03 00:00:00");
        let found = store.search("  GREEN  tea ", 20).unwrap();
        assert_eq!(
            found
                .iter()
                .map(|m| (m.content.as_str(), m.score.unwrap()))
                .collect::<Vec<_>>(),
            [
                ("Green tea, never coffee", 2),
                ("The owner likes green tea", 2),
                ("Tea in the afternoon", 1)
            ]
        );
        assert_eq!(serde_json::to_value(&found[0]).unwrap()["score"], 2);
        assert_eq!(store.search("tea", 1).unwrap().len(), 1);
        assert!(store.search("   ", 20).unwrap().is_empty());
    }

    #[test]
    fn consolidate_keeps_the_newest_of_each_near_duplicate() {
        let (t, store) = store();
        let base = "The owner's main project is a bakery website built with ";
        let old = store.add(&format!("{base}PHP"), "fact", None).unwrap();
        let new = store
            .add(&format!("{}rust", base.to_uppercase()), "fact", None)
            .unwrap();
        let other = store.add("Something else", "fact", None).unwrap();
        set_updated(&t, &old.id, "2026-01-01 00:00:00");
        set_updated(&t, &new.id, "2026-01-02 00:00:00");
        set_updated(&t, &other.id, "2026-01-03 00:00:00");
        assert_eq!(store.consolidate().unwrap(), 1);
        assert!(store.get(&old.id).unwrap().is_none());
        assert!(store.get(&new.id).unwrap().is_some());
        assert_eq!(store.consolidate().unwrap(), 0);
    }

    #[test]
    fn stats_count_by_category_largest_first() {
        let (t, store) = store();
        assert_eq!(
            serde_json::to_value(store.get_stats().unwrap()).unwrap(),
            json!({"total": 0, "byCategory": {}, "oldestDate": null, "newestDate": null})
        );
        let a = store.add("a", "fact", None).unwrap();
        store.add("b", "learned", None).unwrap();
        let c = store.add("c", "learned", None).unwrap();
        set_updated(&t, &a.id, "2025-05-05 00:00:00");
        set_updated(&t, &c.id, "2027-01-01 00:00:00");
        assert_eq!(
            serde_json::to_value(store.get_stats().unwrap()).unwrap(),
            json!({"total": 3, "byCategory": {"learned": 2, "fact": 1},
                   "oldestDate": "2025-05-05 00:00:00", "newestDate": "2027-01-01 00:00:00"})
        );
    }

    #[test]
    fn the_prompt_section_holds_one_short_line_a_memory() {
        let (_t, store) = store();
        assert_eq!(store.get_context_string(20, MEMORY_PROMPT_MAX_CHARS).unwrap(), "");
        store
            .add(&format!("A long\n\nnote {}", "word ".repeat(100)), "learned", None)
            .unwrap();
        let section = store.get_context_string(20, MEMORY_PROMPT_MAX_CHARS).unwrap();
        assert!(section.starts_with(
            "\n\nAdditional quick memories (shortened; search memory for the full note):\n- [learned] A long note word word"
        ));
        assert!(section.ends_with('…'));
        assert_eq!(section.lines().count(), 4, "the memory is one line");
    }

    #[test]
    fn a_memory_is_clipped_to_one_line_at_a_word() {
        // The cases of test/token-diet.test.js (package G3), here too.
        assert_eq!(
            clip_memory("Prefers Telegram.", MEMORY_PROMPT_MAX_CHARS),
            "Prefers Telegram."
        );
        let note = format!("Line one\n\n{}", "detail ".repeat(80));
        let out = clip_memory(&note, MEMORY_PROMPT_MAX_CHARS);
        assert!(utf16_len(&out) <= MEMORY_PROMPT_MAX_CHARS + 1 && out.ends_with('…') && !out.contains('\n'));
        assert_eq!(clip_memory("abcdefghij klm", 12), "abcdefghij…");
        assert_eq!(clip_memory("abcdefghijklmnop", 12), "abcdefghijkl…");
        assert_eq!(clip_memory("", 12), "");
    }

    #[test]
    fn add_and_sync_also_writes_memory_md_and_the_template_is_migrated_once() {
        let (t, store) = store();
        let path = t.config().workspace_dir.join("MEMORY.md");
        store.add("Old fact", "fact", None).unwrap();
        let logs = CapturedLogs::start();
        store.sync_to_memory_file();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "# Long-Term Memory\n\n- [fact] Old fact\n"
        );
        assert_eq!(logs.infos(), ["[memory] Migrated 1 DB memories to MEMORY.md"]);
        store.add_and_sync("New fact", "learned", None).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "# Long-Term Memory\n\n- [fact] Old fact\n\n- [learned] New fact"
        );
        store.sync_to_memory_file();
        assert_eq!(logs.infos().len(), 1, "no longer the template");
    }
}
