// Settings > "Hide secrets in tool output" (ui.redactSecrets) is an on/off switch, not a secret. Its key matched the
// vault's broad /secret/i pattern, so it was stored encrypted and GET /api/settings sent it back masked as "****".
// The page reads `value !== false`, so after a reload the switch showed on even when the owner had turned it off
// (the server itself still honoured the real false). Now the switch is never treated as a secret, and a row an older
// version saved encrypted reads back as the true/false it holds.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-redact-toggle-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
// A test-only encryption key, so secret values really are encrypted at rest here.
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "2".repeat(40);

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { AuditLog } = await import("../src/db/audit.js");
const { settingsRouter } = await import("../src/routes/settings.js");
const { isSecretKey, encrypt, isEncrypted } = await import("../src/lib/vault.js");

const db = initDb(path.join(tmp, "redact-toggle.db"));
const store = new SettingsStore(db, new AuditLog(db));
const raw = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
const shown = (key) => store.all().find((s) => s.key === key)?.value;

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the 'Hide secrets' switch (ui.redactSecrets) is a setting, not a secret", () => {
  it("isn't classed as a secret, while real secrets still are", () => {
    assert.equal(isSecretKey("ui.redactSecrets"), false);
    for (const key of ["captcha.api_key", "api.token", "voice.elevenlabs.apiKey", "ai.openai.apiKey", "channel.slack.secret"]) {
      assert.equal(isSecretKey(key), true, key);
    }
  });

  it("is saved as plain true/false and shown as it is", () => {
    store.set("ui.redactSecrets", false);
    assert.equal(isEncrypted(raw("ui.redactSecrets")), false);
    assert.equal(shown("ui.redactSecrets"), false);
    assert.equal(store.get("ui.redactSecrets"), false);
    store.set("ui.redactSecrets", true);
    assert.equal(shown("ui.redactSecrets"), true);
  });

  it("a row an older version saved encrypted reads back as the value it holds, not \"****\"", () => {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("ui.redactSecrets", encrypt(JSON.stringify(false)));
    assert.equal(isEncrypted(raw("ui.redactSecrets")), true);
    assert.equal(shown("ui.redactSecrets"), false);
    assert.equal(store.get("ui.redactSecrets"), false);
  });

  describe("through the routes the Settings page uses", () => {
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
    const page = async () => (await (await fetch(`${base}/api/settings`)).json()).settings.find((s) => s.key === "ui.redactSecrets")?.value;

    it("switched off, it reads back off after a reload; switched on, on", async () => {
      for (const value of [false, true, false]) {
        const res = await fetch(`${base}/api/settings/general`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "ui.redactSecrets", value }),
        });
        assert.equal(res.status, 200);
        assert.equal(await page(), value);
      }
    });
  });
});
