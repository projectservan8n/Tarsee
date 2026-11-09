// Settings → AI and the setup wizard's "Choose your AI" in a real browser, against the REAL /api/ai (src/routes/ai.js):
// the real settings store (SQLite, keys encrypted at rest), the real provider status (src/ai/provider-status.js) and the
// real Test probes (src/ai/provider-probes.js). Only the outside world is stood in for:
//   - DeepSeek's balance answer, through the router's fetch (DeepSeek's host is a fixed constant, so no local server
//     can take its place); every request the router makes is recorded
//   - Codex's device-code sign-in and the signed-in account's model list (no ChatGPT account in a test)
//   - a Local AI that is a real HTTP server on 127.0.0.1, reached over the network like Ollama would be
//   - the rest of /api (auth, setup status, skills): a few lines below
// So it proves the pages send what the real routes take, that a key never comes back to the page, and that what the
// pages save is read back by the code that uses it (turn.js's backup model through model-ref.js, spend.js's cap).
// Runs on Playwright's Chromium, else an installed Chrome or Edge; skipped where there is none.
/* global document, window -- the page.evaluate() bodies run in the browser */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-ai-ui-real-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "0".repeat(40);
const CLEARED = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_KEY",
  "TARSEE_LOCAL_AI_URL", "TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_CLIENT_ID", "CLAUDE_CODE_HOME",
  "CODEX_HOME",
];
for (const name of CLEARED) delete process.env[name];

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { AuditLog } = await import("../src/db/audit.js");
const { createAiRouter } = await import("../src/routes/ai.js");
const { isEncrypted } = await import("../src/lib/vault.js");
const { setCatalogModels, keysOnly } = await import("../src/ai/provider-registry.js");
const { codexHomeFor } = await import("../src/ai/provider-status.js");
const { parseModelRef } = await import("../src/ai/model-ref.js");
const { spendCapUsd } = await import("../src/ai/spend.js");
const { resolveTarget } = await import("../src/ai/turn.js");

const PUBLIC = fileURLToPath(new URL("../src/public/", import.meta.url));
const DEEPSEEK_KEY = "sk-testcanaryDeepseekUi0000ry42";
const ANTHROPIC_SHAPED = "sk-ant-api03-test-canary-WrongBox00";

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

// --- The world outside Tarsee -------------------------------------------------------------------------------------

/** Every request the router made: where it went and with what Authorization. */
const net = [];
let localPort = 0;
const localHits = [];
const localAi = http.createServer((req, res) => {
  localHits.push(`${req.method} ${req.url}`);
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "qwen3:8b", object: "model" }] }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/responses") {
    // A current Ollama has the Responses API: Test's empty request names no model, so it is turned down.
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "model is required", type: "invalid_request_error" } }));
    return;
  }
  res.writeHead(404);
  res.end();
});

async function worldFetch(url, init = {}) {
  const u = String(url);
  const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  net.push({ url: u, auth: headers.authorization ?? null });
  if (u.startsWith(`http://127.0.0.1:${localPort}/`)) return fetch(url, init);
  if (u === "https://api.deepseek.com/user/balance") {
    return Response.json({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.20", granted_balance: "0.00", topped_up_balance: "4.20" }] });
  }
  throw new TypeError(`fetch failed: nothing answers ${u} in this test`);
}

const codexHome = codexHomeFor(tmp);
let chatgptLogin = { signedIn: false };
let pendingLogin = null;
function startDeviceLogin() {
  let settle;
  const done = new Promise((r) => { settle = r; });
  pendingLogin = {
    finish() {
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { note: "a test stand-in" } }));
      chatgptLogin = { signedIn: true, method: "chatgpt", email: "you@example.com", plan: "free" };
      settle({ ok: true });
    },
  };
  return Promise.resolve({
    url: "https://auth.openai.com/codex/device",
    code: "WXYZ-9876",
    expiresAt: Date.now() + 15 * 60 * 1000,
    done,
    cancel: () => settle({ ok: false, error: "cancelled" }),
  });
}
const listAccountModels = async () => [
  { id: "acct-model-a", label: "The account's own model", efforts: ["low", "medium"], default: true },
  { id: "acct-model-mini", label: "The account's small model", efforts: ["low"] },
];
async function logout() {
  fs.rmSync(path.join(codexHome, "auth.json"), { force: true });
  chatgptLogin = { signedIn: false };
  return { ok: true };
}

// --- Tarsee: the real /api/ai, the dashboard's files, and a stand-in for the rest of /api -------------------------

const db = initDb(path.join(tmp, "tarsee.db"));
const store = new SettingsStore(db, new AuditLog(db));
const raw = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
const emptyClaudeHome = fs.mkdtempSync(path.join(tmp, "claude-empty-"));
const world = { needsSetup: true };
/** Every /api answer the page got: "METHOD /path body". */
const answers = [];

let server;
let origin;
function makeApp() {
  const app = express();
  app.use(express.json());
  app.set("db", db);
  app.set("settingsStore", store);
  app.use("/api", (req, res, next) => {
    const send = res.send.bind(res);
    res.send = (body) => {
      answers.push(`${req.method} ${req.originalUrl} ${Buffer.isBuffer(body) ? body.toString("utf8") : typeof body === "string" ? body : JSON.stringify(body)}`);
      return send(body);
    };
    next();
  });
  app.use("/api/ai", createAiRouter({
    fetch: worldFetch,
    stateDir: tmp,
    claudeHomes: () => [emptyClaudeHome],
    loginStatus: async () => chatgptLogin,
    startDeviceLogin,
    logout,
    listAccountModels,
    rateLimits: { test: { max: 1000 }, verify: { max: 1000 }, login: { max: 1000 } },
  }));
  app.get("/api/auth/status", (_req, res) => res.json({ authenticated: true, needsPassword: true }));
  app.get("/api/auth/api-token", (_req, res) => res.json({ apiToken: null }));
  app.get("/api/settings/setup-status", (_req, res) => res.json({ needsSetup: world.needsSetup, needsPersonality: false, botName: "Tarsee" }));
  // As routes/settings.js GET / does: every setting, a key shown as its last 4 characters.
  app.get("/api/settings", (_req, res) => res.json({
    settings: store.all().map((s) => (s.key.endsWith(".apiKey") && typeof s.value === "string" && s.value.length > 4 ? { ...s, value: "***" + s.value.slice(-4) } : s)),
  }));
  // As routes/settings.js POST /general does: the key and value, as sent.
  app.post("/api/settings/general", (req, res) => { store.set(req.body.key, req.body.value); res.json({ ok: true }); });
  app.get("/api/skills", (_req, res) => res.json({ skills: [] }));
  app.get("/api/admin/tool-registry", (_req, res) => res.json([]));
  app.use("/api", (_req, res) => res.json({}));
  app.use(express.static(PUBLIC));
  return app;
}

before(async () => {
  if (!browser) return;
  await new Promise((r) => localAi.listen(0, "127.0.0.1", r));
  localPort = localAi.address().port;
  server = await new Promise((r) => { const s = makeApp().listen(0, "127.0.0.1", () => r(s)); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
  await new Promise((r) => (localAi.listening ? localAi.close(r) : r()));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function reset() {
  db.prepare("DELETE FROM settings").run();
  fs.rmSync(path.join(codexHome, "auth.json"), { force: true });
  chatgptLogin = { signedIn: false };
  pendingLogin = null;
  net.length = 0;
  localHits.length = 0;
  answers.length = 0;
  setCatalogModels("chatgpt-models", []);
  setCatalogModels("local-models", []);
  setCatalogModels("openai-models", []);
}

async function openPage({ width = 1280, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route((url) => !url.href.startsWith(origin), (route) => route.abort());
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`${origin}/`);
  return { page, errors, context };
}

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** Answer the question on screen with the button called `name`, after js/dialogs.js's 400 ms settle (SETTLE_MS). */
async function answerDialog(page, name) {
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  await page.waitForTimeout(450);
  await dialog.getByRole("button", { name }).click();
}

describe("the AI pages against the real /api/ai", { skip }, () => {
  beforeEach(reset);

  it("the wizard: a key in the wrong box goes nowhere; DeepSeek's is tested, saved encrypted, and made the default with keys-only", async () => {
    world.needsSetup = true;
    const { page, errors, context } = await openPage({ width: 375, height: 800 });
    try {
      await page.getByText("Choose your AI").waitFor();
      await page.getByLabel("Other people too (a team, customers)").check();
      assert.equal(await page.locator("#setupKeysOnly").isChecked(), true, "shared use pre-ticks keys-only, where it can be seen");
      await page.getByRole("button", { name: /My own API key/ }).click();
      await page.locator('[data-setup="provider"][data-provider="deepseek"]').click();
      await page.getByText("How to set up DeepSeek").waitFor();

      // An Anthropic key in DeepSeek's box: the real route turns it down by its shape, before any request is made.
      await page.locator("#setupKey").fill(ANTHROPIC_SHAPED);
      await page.getByRole("button", { name: "Test and save" }).click();
      const wrong = page.locator('#setupAiPanel .ai-test-result[data-tone="bad"]');
      await wrong.waitFor();
      assert.match(await wrong.innerText(), /Anthropic/);
      assert.equal(raw("ai.deepseek.apiKey"), null, "nothing saved");
      assert.deepEqual(net, [], "the key in the wrong box was sent nowhere");

      await page.locator("#setupKey").fill(DEEPSEEK_KEY);
      await page.getByRole("button", { name: "Test and save" }).click();
      await page.getByText(/Key works · Balance \$4\.20/).first().waitFor();
      await page.locator("#setupAiNext:not([disabled])").waitFor();
      assert.ok(await noSideScroll(page), "no sideways scroll at phone width");
      await page.locator("#setupAiNext").click();
      await page.getByText("Choose Your Skills").waitFor();

      // What the real routes stored.
      assert.equal(store.get("ai.activeProvider"), "deepseek");
      assert.equal(store.get("ai.deepseek.model"), "deepseek-flash");
      assert.equal(keysOnly(store, { env: {} }), true, "keys-only saved, as it was ticked");
      const stored = raw("ai.deepseek.apiKey");
      assert.ok(isEncrypted(stored) && !stored.includes(DEEPSEEK_KEY), "the key is encrypted at rest");
      assert.equal(store.getKeyWithSource("deepseek").key, DEEPSEEK_KEY);
      // Where the key went: only DeepSeek's own host. What came back to the page: never the key.
      assert.ok(net.length > 0);
      for (const call of net) {
        assert.equal(new URL(call.url).host, "api.deepseek.com", call.url);
        assert.equal(call.auth, `Bearer ${DEEPSEEK_KEY}`);
      }
      for (const a of answers) assert.ok(!a.includes(DEEPSEEK_KEY.slice(0, -4)), `the page was sent the key: ${a.slice(0, 200)}`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Settings → AI: ChatGPT's code shown, Ready by itself with the account's own models, made the default, then signed out", async () => {
    world.needsSetup = false;
    const { page, errors, context } = await openPage({ width: 390, height: 844 });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      await page.locator("#chatgptAiCard:not([hidden])").waitFor();
      assert.match(await page.locator("#chatgptAiStatus").innerText(), /Nobody has signed in to ChatGPT yet/);
      assert.equal(await page.locator("#chatgptAiCard details.ai-guide").getAttribute("open"), "", "its steps are unfolded until it's ready");

      await page.locator('#chatgptAiCard [data-ai-action="chatgpt-login"]').click();
      await page.getByText("WXYZ-9876").waitFor();
      assert.ok(await page.locator('#chatgptAiCard a[href="https://auth.openai.com/codex/device"][target="_blank"][rel="noopener noreferrer"]').isVisible());
      assert.ok(await noSideScroll(page), "the code fits a phone");

      pendingLogin.finish();   // the person typed the code at OpenAI
      await page.locator("#chatgptAiStatus", { hasText: "Ready, signed in as you@example.com (Free)" }).waitFor({ timeout: 15000 });
      await page.locator('#aiModel-chatgpt option[value="acct-model-a"]').waitFor({ state: "attached" });
      assert.equal(raw("ai.chatgpt.model"), null, "no ChatGPT model is chosen for the account");

      await page.locator("#aiModel-chatgpt").selectOption("acct-model-a");
      await page.locator('#chatgptAiCard [data-ai-action="use"]').click();
      await page.locator("#aiDefaultNow", { hasText: "ChatGPT plan, using The account's own model" }).waitFor();
      assert.equal(store.get("ai.activeProvider"), "chatgpt");
      assert.equal(store.get("ai.chatgpt.model"), "acct-model-a");
      assert.equal(await page.locator("#aiHeaderChip .channel-dot").getAttribute("data-tone"), "ok");

      // Background jobs (scheduled tasks, summaries): the account's smaller model, as turn.js then picks it.
      assert.equal(await page.locator("#aiBgModel-chatgpt").inputValue(), "", "the cheapest by default");
      await page.locator("#aiBgModel-chatgpt").selectOption("acct-model-mini");
      await page.locator("#chatgptAiCard [data-ai-test]", { hasText: "Background jobs now use The account's small model" }).waitFor();
      assert.equal(store.get("ai.chatgpt.backgroundModel"), "acct-model-mini");
      assert.equal((await resolveTarget({ background: true }, store)).target.model, "acct-model-mini", "a background turn runs on it");
      assert.equal((await resolveTarget({}, store)).target.model, "acct-model-a", "chats keep the default model");
      assert.equal(await page.locator("#aiBgModel-chatgpt").inputValue(), "acct-model-mini", "the card shows the choice after it redraws");
      await page.locator("#aiBgModel-chatgpt").selectOption("");
      await page.locator("#chatgptAiCard [data-ai-test]", { hasText: "Background jobs now use the cheapest model" }).waitFor();
      assert.equal(store.get("ai.chatgpt.backgroundModel"), null, "back to the cheapest: the setting is cleared");

      await page.locator('#chatgptAiCard [data-ai-action="chatgpt-logout"]').click();
      await answerDialog(page, "Sign out");
      await page.locator("#chatgptAiStatus", { hasText: "Nobody has signed in to ChatGPT yet" }).waitFor();
      assert.equal(fs.existsSync(path.join(codexHome, "auth.json")), false, "the sign-in file is gone");
      await page.locator("#aiAttention:not([hidden])").waitFor();
      assert.match(await page.locator("#aiAttention").innerText(), /ChatGPT plan can't answer right now/);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Settings → AI: a Local AI on the network, then the backup model and the monthly cap, read back by the code that uses them", async () => {
    world.needsSetup = false;
    const { page, errors, context } = await openPage();
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      await page.locator("#localAiCard:not([hidden])").waitFor();
      const url = `http://127.0.0.1:${localPort}/v1`;
      await page.locator("#aiLocalUrl").fill(url);
      await page.locator('#localAiCard [data-ai-action="save-local"]').click();
      await page.locator("#localAiStatus", { hasText: "Ready, using qwen3:8b" }).waitFor();
      assert.equal(store.get("ai.local.baseUrl"), url);
      assert.ok(localHits.includes("GET /v1/models"), "Test asked the server itself for its models");

      await page.locator('#aiBackupModel option[value="local:qwen3:8b"]').waitFor({ state: "attached" });
      await page.locator("#aiBackupModel").selectOption("local:qwen3:8b");
      await page.locator("#aiMonthlyCap").fill("20");
      await page.locator("#aiSaveExtrasBtn").click();
      await page.getByText("Saved: backup on, cap $20 a month").waitFor();
      assert.deepEqual(parseModelRef(store.get("ai.backupModel")), { provider: "local", model: "qwen3:8b" }, "turn.js reads the backup as Local AI's qwen3:8b");
      assert.equal(spendCapUsd(store), 20, "spend.js reads a $20 cap");

      // Both off again: empty means off to the code that reads them.
      await page.locator("#aiBackupModel").selectOption("");
      await page.locator("#aiMonthlyCap").fill("");
      await page.locator("#aiSaveExtrasBtn").click();
      await page.getByText("Saved: backup off, no monthly cap").waitFor();
      assert.equal(parseModelRef(store.get("ai.backupModel")).model, null);
      assert.equal(spendCapUsd(store), null);

      await page.locator('#localAiCard [data-ai-action="use"]').click();
      await page.locator("#aiDefaultNow", { hasText: "Local AI, using qwen3:8b" }).waitFor();
      assert.equal(store.get("ai.activeProvider"), "local");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
