// A provider's host is a code constant (design 4.5 R3), so nothing stores one per provider any more: not
// setActiveProvider, not POST /api/settings/provider, and getActiveProvider hands none out. Local AI is the one host the
// owner sets, in its own ai.local.baseUrl, read by its own code. The boot fixup deletes any ai.<id>.baseUrl row left
// by older versions (other than Local AI's), so no later code can pick a stale one up.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-provider-base-url-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { settingsRouter } = await import("../src/routes/settings.js");

let dbn = 0;
const opened = [];
function fresh() {
  const db = initDb(path.join(tmp, `base-url-${++dbn}.db`));
  opened.push(db);
  const store = new SettingsStore(db);
  const raw = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
  const putRaw = (key, value) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
  return { db, store, raw, putRaw };
}

const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
};

after(() => {
  for (const db of opened) db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("no per-provider base URL is stored or handed out", () => {
  it("setActiveProvider ignores a baseUrl", () => {
    const { store, raw } = fresh();
    store.setActiveProvider("claude-code", { model: "sonnet", baseUrl: "http://canary.invalid" });
    assert.equal(raw("ai.claude-code.baseUrl"), null);
    assert.equal(store.get("ai.activeProvider"), "claude-code");
  });

  it("getActiveProvider has no baseUrl, even with an old row in the database", () => {
    const { store, putRaw } = fresh();
    store.setActiveProvider("claude-code");
    putRaw("ai.claude-code.baseUrl", "http://canary.invalid");
    const active = store.getActiveProvider();
    assert.equal(active.provider, "claude-code");
    assert.ok(!("baseUrl" in active), JSON.stringify(active));
  });
});

describe("boot fixup: old per-provider base URLs", () => {
  it("deletes every ai.<id>.baseUrl row but Local AI's, leaves everything else, and is idempotent", () => {
    const { store, raw, putRaw } = fresh();
    for (const id of ["claude-code", "claude", "anthropic", "openai", "openrouter", "deepseek", "chatgpt", "gemini"]) {
      putRaw(`ai.${id}.baseUrl`, "http://canary.invalid");
    }
    putRaw("ai.local.baseUrl", "http://192.168.1.20:11434/v1");
    putRaw("ai.openrouter.appTitle", "Tarsee");
    putRaw("channel.whatsapp", JSON.stringify({ baseUrl: "https://gate.whapi.cloud" }));
    putRaw("ai.openrouter.baseUrlNote", "kept");
    const first = quiet(() => store.removeProviderBaseUrls());
    assert.equal(first.removed, 8);
    for (const id of ["claude-code", "claude", "anthropic", "openai", "openrouter", "deepseek", "chatgpt", "gemini"]) {
      assert.equal(raw(`ai.${id}.baseUrl`), null, id);
    }
    assert.equal(raw("ai.local.baseUrl"), "http://192.168.1.20:11434/v1");
    assert.equal(raw("ai.openrouter.appTitle"), "Tarsee");
    assert.equal(raw("ai.openrouter.baseUrlNote"), "kept");
    assert.ok(raw("channel.whatsapp"));
    assert.deepEqual(quiet(() => store.removeProviderBaseUrls()), { removed: 0 });
  });
});

describe("POST /api/settings/provider", () => {
  const { db, store, raw } = fresh();
  let server;
  let base;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.set("db", db);
    app.use("/api/settings", settingsRouter);
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server?.close());
  const post = (body) => fetch(`${base}/api/settings/provider`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  it("refuses a base URL, saving nothing", async () => {
    const res = await post({ provider: "claude-code", model: "opus", baseUrl: "http://canary.invalid" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /base URL/i);
    assert.equal(raw("ai.claude-code.baseUrl"), null);
    assert.equal(raw("ai.claude-code.model"), null, "nothing of a refused request is saved");
  });

  it("still saves the provider and model as the Settings page sends them", async () => {
    const res = await post({ provider: "claude-code", model: "sonnet" });
    assert.equal(res.status, 200);
    assert.equal(store.get("ai.activeProvider"), "claude-code");
    assert.equal(store.get("ai.claude-code.model"), "sonnet");
  });
});
