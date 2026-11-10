// A chat's own settings (session.<id>.provider, .model, .effort, .clearedAt and .instrHash) go when the chat goes:
// when it is deleted (db/conversations.js ConversationStore.delete, which the retention sweep's 14-day prune uses
// too), and in the daily sweep for rows an older version left behind (lib/retention.js cleanupOrphanedReferences).
// Nothing reads them once the chat is gone, and GET /api/settings sends every row, so they must not pile up.
// Settings that only start with "session." (session.reset.*) are never touched.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-conv-settings-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const { initLiveBus } = await import("../src/lib/live-bus.js");
const { cleanupOrphanedReferences } = await import("../src/lib/retention.js");

const db = initDb(path.join(tmp, "tarsee.db"));
initLiveBus(db);
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const FIELDS = ["provider", "model", "effort", "clearedAt", "instrHash"];
function chatWithSettings() {
  const conv = convs.create({ title: "A chat" });
  for (const f of FIELDS) settings.set(`session.${conv.id}.${f}`, `${f}-value`);
  return conv.id;
}
const chatKeys = (id) => settings.getByPrefix(`session.${id}.`).map((r) => r.key).sort();

describe("a chat's own settings when the chat goes", () => {
  it("deleting a chat removes its session.<id>.* rows, and only its own", () => {
    settings.set("session.reset.mode", "idle");
    settings.set("session.reset.idleMinutes", "90");
    const gone = chatWithSettings();
    const kept = chatWithSettings();
    assert.equal(chatKeys(gone).length, FIELDS.length);

    assert.equal(convs.delete(gone), true);
    assert.deepEqual(chatKeys(gone), [], "the deleted chat's settings are gone");
    assert.equal(chatKeys(kept).length, FIELDS.length, "another chat's settings stay");
    assert.equal(settings.get("session.reset.mode"), "idle");
    assert.equal(settings.get("session.reset.idleMinutes"), 90);
  });

  it("a chat that isn't there removes nothing", () => {
    const kept = chatWithSettings();
    assert.equal(convs.delete("no-such-chat"), false);
    assert.equal(chatKeys(kept).length, FIELDS.length);
  });

  it("a database with no settings table still deletes the chat", () => {
    const bare = new Database(":memory:");
    try {
      bare.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, provider TEXT, model TEXT, system_prompt TEXT, claude_session_id TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))");
      bare.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, provider TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, created_at TEXT DEFAULT (datetime('now')))");
      bare.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(content)");
      const store = new ConversationStore(bare);
      const conv = store.create({ title: "Bare" });
      assert.equal(store.delete(conv.id), true);
      assert.equal(store.get(conv.id), null);
    } finally {
      bare.close();
    }
  });

  it("the daily sweep removes rows an older version left behind, and counts them", () => {
    settings.set("session.reset.mode", "daily");
    const live = chatWithSettings();
    const dead = chatWithSettings();
    // As before this fix: the chat's row went, its settings stayed.
    db.prepare("DELETE FROM conversations WHERE id = ?").run(dead);
    assert.equal(chatKeys(dead).length, FIELDS.length);

    const result = cleanupOrphanedReferences(db);
    assert.equal(result.settings, FIELDS.length);
    assert.deepEqual(chatKeys(dead), []);
    assert.equal(chatKeys(live).length, FIELDS.length, "a live chat's settings stay");
    assert.equal(settings.get("session.reset.mode"), "daily", "session.reset.* is never a chat's");
    assert.equal(cleanupOrphanedReferences(db).settings, 0, "nothing more the second time");
  });
});
