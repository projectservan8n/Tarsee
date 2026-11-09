// The captcha solver's key (Settings > Security) end to end, through the REAL routes/settings.js and db/settings.js on
// a real database with keys encrypted at rest; nothing is stood in for between the page and the settings table.
//   - Save stores the key encrypted, and GET /api/settings shows it only masked.
//   - Remove posts an empty value for it, and that is a removal: the row is deleted and audited as credential.delete,
//     so after a reload the page says no key is saved and shows no Remove button.
//   - An empty secret is never shown as a saved key, including a row an older build left behind (its Save posted the
//     box even when it was empty), and the boot fixup (removeEmptySecrets) deletes such rows.
//   - In a real browser (Playwright's Chromium, else an installed Chrome or Edge; skipped where there is none): Save,
//     reload, Remove, reload.
/* global document, Settings -- the page.evaluate() bodies run in the browser */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-captcha-key-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "0".repeat(40);
for (const name of ["CAPTCHA_API_KEY", "TARSEE_KEYS_ONLY", "TARSEE_AI_PROVIDER", "CLAUDE_CODE_OAUTH_TOKEN"]) delete process.env[name];

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { settingsRouter } = await import("../src/routes/settings.js");
const { createAiRouter } = await import("../src/routes/ai.js");
const { isEncrypted, encrypt } = await import("../src/lib/vault.js");

const PUBLIC = fileURLToPath(new URL("../src/public/", import.meta.url));
const CAPTCHA_KEY = "test-canary-captcha-" + "0".repeat(8) + "k3y9";

const db = initDb(path.join(tmp, "tarsee.db"));
const store = new SettingsStore(db);
const raw = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
const audits = (target) => db.prepare("SELECT action, actor FROM audit_log WHERE target = ? ORDER BY id").all(target);
const emptyClaudeHome = fs.mkdtempSync(path.join(tmp, "claude-empty-"));

let browser = null;
try {
  const { chromium } = await import("playwright");
  for (const opts of [{}, { channel: "chrome" }, { channel: "msedge" }]) {
    try { browser = await chromium.launch(opts); break; } catch { /* the next one */ }
  }
} catch {
  browser = null;
}
const skip = browser ? false : "no Chromium, Chrome or Edge for Playwright";

let server;
let origin;
before(async () => {
  const app = express();
  app.use(express.json());
  app.set("db", db);
  app.set("settingsStore", store);
  app.get("/api/auth/status", (_req, res) => res.json({ authenticated: true, needsPassword: true }));
  app.get("/api/auth/api-token", (_req, res) => res.json({ apiToken: null }));
  // The real routes for everything the Security tab and the header use.
  app.use("/api/settings", settingsRouter);
  app.use("/api/ai", createAiRouter({
    stateDir: tmp,
    claudeHomes: () => [emptyClaudeHome],
    loginStatus: async () => ({ signedIn: false }),
    listAccountModels: async () => [],
    fetch: async (url) => { throw new TypeError(`fetch failed: nothing answers ${url} in this test`); },
  }));
  app.get("/api/skills", (_req, res) => res.json({ skills: [] }));
  app.get("/api/admin/tool-registry", (_req, res) => res.json([]));
  app.use("/api", (_req, res) => res.json({}));
  app.use(express.static(PUBLIC));
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise((r) => (server ? server.close(r) : r()));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  db.prepare("DELETE FROM settings").run();
  db.prepare("DELETE FROM audit_log").run();
  // Set up, so the dashboard opens rather than the setup wizard (GET /api/settings/setup-status, the real one).
  store.set("ai.activeProvider", "deepseek");
  store.set("identity.name", "Tarsee");
});

async function call(method, p, body) {
  const res = await fetch(`${origin}/api/settings${p}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  assert.ok(!text.includes(CAPTCHA_KEY), `${method} ${p} answered with the key: ${text}`);
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const shown = async (key) => (await call("GET", "")).body.settings.find((s) => s.key === key) ?? null;
const save = (key, value) => call("POST", "/general", { key, value });

describe("the captcha key through the real settings routes", () => {
  it("Save stores it encrypted and shows it only masked; Remove deletes the row and audits a delete", async () => {
    assert.equal((await save("captcha.api_key", CAPTCHA_KEY)).status, 200);
    assert.ok(isEncrypted(raw("captcha.api_key")), "stored encrypted");
    assert.equal((await shown("captcha.api_key")).value, `${CAPTCHA_KEY.slice(0, 4)}...${CAPTCHA_KEY.slice(-4)}`);

    // What the Remove button sends.
    const r = await save("captcha.api_key", "");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, removed: true });
    assert.equal(raw("captcha.api_key"), null, "the row is gone, not an encrypted empty string");
    assert.equal(await shown("captcha.api_key"), null, "GET /api/settings has no captcha key to show");
    assert.equal(store.get("captcha.api_key"), null);
    assert.deepEqual(audits("captcha.api_key"), [
      { action: "credential.write", actor: "user" },
      { action: "credential.delete", actor: "user" },
    ]);

    // Pressed again: nothing to remove, nothing written or audited.
    assert.deepEqual((await save("captcha.api_key", "")).body, { ok: true, removed: false });
    assert.equal(raw("captcha.api_key"), null);
    assert.equal(audits("captcha.api_key").length, 2);
  });

  it("null, a missing value or only spaces are a removal too; a setting that isn't a secret is still saved empty", async () => {
    for (const body of [{ value: null }, {}, { value: "   " }]) {
      await save("captcha.api_key", CAPTCHA_KEY);
      const r = await call("POST", "/general", { key: "captcha.api_key", ...body });
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.equal(r.body.removed, true, JSON.stringify(body));
      assert.equal(raw("captcha.api_key"), null, JSON.stringify(body));
    }
    assert.equal((await save("captcha.service", "")).status, 200);
    assert.equal(raw("captcha.service"), "", "an ordinary setting keeps its empty value");
  });

  it("an empty secret an older build left behind reads as no key; a short real key still reads as saved", async () => {
    store.set("captcha.api_key", "");                                    // the old Save with the box empty: encrypted ""
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("search.brave_api_key", "");   // saved before ENCRYPTION_KEY
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("voice.elevenlabs.apiKey", encrypt("null"));
    store.set("webhook.secret", "short1");
    assert.ok(isEncrypted(raw("captcha.api_key")));
    for (const key of ["captcha.api_key", "search.brave_api_key", "voice.elevenlabs.apiKey"]) {
      assert.equal((await shown(key)).value, "", `${key}: an empty secret is no saved key`);
    }
    assert.equal((await shown("webhook.secret")).value, "****", "a real key too short to show the ends of is still a saved key");
  });

  it("the boot fixup deletes those empty rows (audited), and leaves real keys, other settings and what it can't read", () => {
    store.set("captcha.api_key", "");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("search.brave_api_key", "  ");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("voice.elevenlabs.apiKey", encrypt("null"));
    store.set("webhook.secret", "short1");
    store.set("ai.deepseek.apiKey", "sk-test-" + "0".repeat(24));
    store.set("ui.redactSecrets", false);
    store.set("captcha.service", "");
    const unreadable = "enc:v1:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAA==:AAAA";
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("ai.openrouter.apiKey", unreadable);
    db.prepare("DELETE FROM audit_log").run();

    const warn = console.warn;
    const log = console.log;
    console.warn = () => {};
    console.log = () => {};
    let result;
    let again;
    try {
      result = store.removeEmptySecrets();
      again = store.removeEmptySecrets();
    } finally {
      console.warn = warn;
      console.log = log;
    }
    assert.deepEqual(result.removed.sort(), ["captcha.api_key", "search.brave_api_key", "voice.elevenlabs.apiKey"]);
    for (const key of result.removed) {
      assert.equal(raw(key), null, key);
      assert.deepEqual(audits(key), [{ action: "credential.delete", actor: "system" }], key);
    }
    assert.equal(store.get("webhook.secret"), "short1");
    assert.equal(store.get("ai.deepseek.apiKey"), "sk-test-" + "0".repeat(24));
    assert.equal(store.get("ui.redactSecrets"), false, "false isn't empty");
    assert.equal(raw("captcha.service"), "", "not a secret: left as it is");
    assert.equal(raw("ai.openrouter.apiKey"), unreadable, "a value it can't decrypt is left where it is");
    assert.deepEqual(again, { removed: [] }, "idempotent");
  });
});

// --- In a real browser -------------------------------------------------------------------------------------------


async function openPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route((url) => !url.href.startsWith(origin), (route) => route.abort());
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`${origin}/`);
  return { page, errors, context };
}

/** Settings > Security, once the page has read GET /api/settings (the captcha service it shows comes from there). */
async function openSecurity(page, service) {
  await page.locator("#aiHeaderChip:not([hidden])").waitFor();
  await page.evaluate(() => Settings.open());
  await page.locator('.settings-tab[data-tab="security"]').click();
  await page.waitForFunction((s) => document.getElementById("captchaService")?.value === s, service);
}

describe("Settings > Security in a real browser, against the real settings routes", { skip }, () => {
  it("Save, reload: the key is saved; Remove, reload: no key is saved and there is nothing to remove", async () => {
    const { page, errors, context } = await openPage();
    try {
      await openSecurity(page, "2captcha");
      assert.equal(await page.locator("#captchaKeyStatus").isHidden(), true, "no key yet");
      await page.locator("#captchaService").selectOption("capsolver");
      await page.locator("#captchaApiKey").fill(CAPTCHA_KEY);
      await page.locator("#saveCaptchaBtn").click();
      await page.getByText("Captcha settings saved").waitFor();
      assert.ok(isEncrypted(raw("captcha.api_key")), "the real route stored it encrypted");

      await page.reload();
      await openSecurity(page, "capsolver");
      await page.locator("#captchaKeyStatus", { hasText: `A key is saved …${CAPTCHA_KEY.slice(-4)}` }).waitFor();
      assert.equal(await page.locator("#captchaApiKey").inputValue(), "", "the saved key is never put back in the box");
      assert.equal(await page.locator("#removeCaptchaKeyBtn").isVisible(), true);
      assert.ok(!(await page.content()).includes(CAPTCHA_KEY), "the key is never on the page");

      await page.locator("#removeCaptchaKeyBtn").click();
      await page.getByText("Captcha key removed").waitFor();
      assert.equal(raw("captcha.api_key"), null, "the row is gone");

      await page.reload();
      await openSecurity(page, "capsolver");
      assert.equal(await page.locator("#captchaKeyStatus").isHidden(), true, "after a reload no key is said to be saved");
      assert.equal(await page.locator("#removeCaptchaKeyBtn").isHidden(), true, "and there is no Remove to press");
      assert.equal(await page.locator("#captchaApiKey").getAttribute("placeholder"), "Your API key");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("a row an older build left behind (its Save posted the empty box) shows as no key", async () => {
    store.set("captcha.service", "capsolver");
    store.set("captcha.api_key", "");
    const { page, errors, context } = await openPage();
    try {
      await openSecurity(page, "capsolver");
      assert.equal(await page.locator("#captchaKeyStatus").isHidden(), true);
      assert.equal(await page.locator("#removeCaptchaKeyBtn").isHidden(), true);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
