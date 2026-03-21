import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initDb } from "../src/db/sqlite.js";
import { ConversationStore } from "../src/db/conversations.js";
import { SettingsStore } from "../src/db/settings.js";

const TEST_DB = path.join("/tmp", `opusclaw-test-${Date.now()}.db`);

let db, convStore, settingsStore;

before(() => {
  db = initDb(TEST_DB);
  convStore = new ConversationStore(db);
  settingsStore = new SettingsStore(db);
});

after(() => {
  db.close();
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.unlinkSync(TEST_DB + "-wal"); } catch {}
  try { fs.unlinkSync(TEST_DB + "-shm"); } catch {}
});

describe("ConversationStore", () => {
  it("creates a conversation", () => {
    const conv = convStore.create({ title: "Test conversation" });
    assert.ok(conv.id);
    assert.equal(conv.title, "Test conversation");
  });

  it("lists conversations", () => {
    const list = convStore.list();
    assert.ok(list.length >= 1);
  });

  it("gets a conversation by id", () => {
    const conv = convStore.create({ title: "Get test" });
    const found = convStore.get(conv.id);
    assert.equal(found.title, "Get test");
  });

  it("deletes a conversation", () => {
    const conv = convStore.create({ title: "Delete test" });
    assert.ok(convStore.delete(conv.id));
    assert.equal(convStore.get(conv.id), null);
  });

  it("adds and retrieves messages", () => {
    const conv = convStore.create({ title: "Message test" });
    convStore.addMessage(conv.id, { role: "user", content: "Hello!" });
    convStore.addMessage(conv.id, { role: "assistant", content: "Hi there!" });

    const messages = convStore.getMessages(conv.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
  });

  it("returns message count", () => {
    const conv = convStore.create({ title: "Count test" });
    assert.equal(convStore.messageCount(conv.id), 0);
    convStore.addMessage(conv.id, { role: "user", content: "Hello" });
    assert.equal(convStore.messageCount(conv.id), 1);
  });

  it("cascades delete to messages", () => {
    const conv = convStore.create({ title: "Cascade test" });
    convStore.addMessage(conv.id, { role: "user", content: "Hello" });
    convStore.delete(conv.id);
    assert.equal(convStore.getMessages(conv.id).length, 0);
  });
});

describe("SettingsStore", () => {
  it("sets and gets a string value", () => {
    settingsStore.set("test.key", "hello");
    assert.equal(settingsStore.get("test.key"), "hello");
  });

  it("sets and gets an object value", () => {
    settingsStore.set("test.obj", { foo: "bar", num: 42 });
    const val = settingsStore.get("test.obj");
    assert.equal(val.foo, "bar");
    assert.equal(val.num, 42);
  });

  it("returns null for missing keys", () => {
    assert.equal(settingsStore.get("nonexistent"), null);
  });

  it("deletes a value", () => {
    settingsStore.set("test.delete", "value");
    assert.ok(settingsStore.delete("test.delete"));
    assert.equal(settingsStore.get("test.delete"), null);
  });

  it("lists all settings", () => {
    settingsStore.set("list.a", "1");
    settingsStore.set("list.b", "2");
    const all = settingsStore.all();
    assert.ok(all.length >= 2);
  });

  it("gets settings by prefix", () => {
    settingsStore.set("prefix.one", "a");
    settingsStore.set("prefix.two", "b");
    settingsStore.set("other.key", "c");
    const prefixed = settingsStore.getByPrefix("prefix.");
    assert.equal(prefixed.length, 2);
  });

  it("manages active provider", () => {
    settingsStore.setActiveProvider("anthropic", {
      model: "claude-sonnet-4-5-20250929",
      apiKey: "sk-test-123",
    });

    const active = settingsStore.getActiveProvider();
    assert.equal(active.provider, "anthropic");
    assert.equal(active.model, "claude-sonnet-4-5-20250929");
    assert.equal(active.apiKey, "sk-test-123");
  });
});
