// An older Voice tab filled its OpenAI key box from GET /api/settings, which shows a key masked ("sk-p...wxyz"), and
// its Save posted the box back through POST /api/settings/general to voice.openai_api_key and ai.openai.apiKey. So
// opening Voice and clicking Save replaced the owner's real key with its masked display, and the OpenAI card (and a
// Railway OPENAI_API_KEY, which a saved key hides) stopped working. Now:
//  - POST /api/settings/general refuses an AI key (Settings > AI saves them, through PUT /api/ai/keys/<id>, with its
//    checks) and voice.openai_api_key;
//  - a boot fixup deletes a display mask from every AI key slot, and the voice.openai_api_key row nothing reads.
// Every key here is an obvious fake.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-key-leftovers-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
// A test-only encryption key, so values really are encrypted at rest here.
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "1".repeat(40);

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { AuditLog } = await import("../src/db/audit.js");
const { settingsRouter } = await import("../src/routes/settings.js");

let dbn = 0;
const opened = [];
function fresh() {
  const db = initDb(path.join(tmp, `leftovers-${++dbn}.db`));
  opened.push(db);
  const store = new SettingsStore(db, new AuditLog(db));
  const raw = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
  const audits = () => db.prepare("SELECT action, target, actor FROM audit_log ORDER BY id").all();
  return { db, store, raw, audits };
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

describe("POST /api/settings/general takes no AI key", () => {
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
  const post = (key, value) => fetch(`${base}/api/settings/general`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }),
  });

  it("refuses every AI's key slot (storage ids too) and the old voice key, saving nothing", async () => {
    for (const key of ["ai.openai.apiKey", "ai.anthropic.apiKey", "ai.openrouter.apiKey", "ai.deepseek.apiKey", "ai.local.apiKey", "ai.claude-code.apiKey", "voice.openai_api_key"]) {
      const res = await post(key, "sk-p...wxyz");
      assert.equal(res.status, 400, key);
      assert.equal((await res.json()).error, "Save AI keys in Settings > AI.");
      assert.equal(raw(key), null, `${key} was saved`);
    }
  });

  it("other settings, and keys that aren't an AI's, are saved as before", async () => {
    for (const [key, value] of [["voice.stt_provider", "openai"], ["voice.elevenlabs.apiKey", "test-canary-elevenlabs-0001"], ["ai.backupModel", "deepseek:deepseek-flash"]]) {
      const res = await post(key, value);
      assert.equal(res.status, 200, key);
      assert.equal(store.get(key), value);
    }
  });
});

describe("boot fixup: what the old Voice tab left in the key slots", () => {
  it("deletes a masked display from any AI key slot and the voice key nothing reads; audited; running again changes nothing", () => {
    const { store, raw, audits } = fresh();
    store.set("ai.openai.apiKey", "sk-p...wxyz");
    store.set("voice.openai_api_key", "sk-p...wxyz");
    store.set("ai.deepseek.apiKey", "****");
    store.set("ai.openrouter.apiKey", "***wxyz");
    const result = quiet(() => store.removeVoiceKeyLeftovers());
    assert.deepEqual(result.removed.sort(), ["ai.deepseek.apiKey", "ai.openai.apiKey", "ai.openrouter.apiKey", "voice.openai_api_key"]);
    for (const key of result.removed) {
      assert.equal(raw(key), null, key);
      assert.ok(audits().some((r) => r.action === "credential.delete" && r.target === key), `${key}: no audit row`);
    }
    const rows = audits().length;
    assert.deepEqual(quiet(() => store.removeVoiceKeyLeftovers()), { removed: [] });
    assert.equal(audits().length, rows);
  });

  it("a Railway OPENAI_API_KEY applies again once the mask is gone", () => {
    const { store } = fresh();
    store.set("ai.openai.apiKey", "sk-p...wxyz");
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-canary-railway-openai-0001";
    try {
      assert.equal(store.getKeyWithSource("openai").source, "settings", "precondition: the mask hides the variable");
      quiet(() => store.removeVoiceKeyLeftovers());
      assert.equal(store.getKeyWithSource("openai").source, "env:OPENAI_API_KEY");
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
    }
  });

  it("a real key, another setting, or a value it can't decrypt is left alone", () => {
    const { db, store, raw } = fresh();
    store.set("ai.openai.apiKey", "sk-proj-test-canary-real-key-0001");
    store.set("ai.anthropic.apiKey", "sk-ant-api03-test-canary-real-0002");
    store.set("voice.elevenlabs.apiKey", "****");
    store.set("captcha.api_key", "abcd...wxyz");
    const unreadable = "enc:v1:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAA==:AAAA";
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("ai.deepseek.apiKey", unreadable);
    const warn = console.warn;
    console.warn = () => {};
    let result;
    try { result = quiet(() => store.removeVoiceKeyLeftovers()); } finally { console.warn = warn; }
    assert.deepEqual(result, { removed: [] });
    assert.equal(store.get("ai.openai.apiKey"), "sk-proj-test-canary-real-key-0001");
    assert.equal(store.get("ai.anthropic.apiKey"), "sk-ant-api03-test-canary-real-0002");
    assert.equal(store.get("voice.elevenlabs.apiKey"), "****");
    assert.equal(store.get("captcha.api_key"), "abcd...wxyz");
    assert.equal(raw("ai.deepseek.apiKey"), unreadable);
  });

  it("the server runs it at boot", () => {
    const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
    assert.match(server, /removeVoiceKeyLeftovers\(\)/);
  });
});
