// The AI pages in a real browser (design Phase 5, "headless UI smoke"): the dashboard served from src/public, every
// /api call answered by a small fake of src/routes/ai.js kept in this file, driven with Playwright's Chromium.
//   - the setup wizard: who talks to it, the three choices, a DeepSeek key tested and saved, keys-only saved as ticked,
//     the chosen AI made the default; ChatGPT's sign-in code shown, then Ready by itself
//   - Settings → AI: the chips, a card per provider, Test with a balance; the header chip; the tool list
//   - nothing scrolls sideways at phone width
// Runs on Playwright's own Chromium, else an installed Chrome or Edge; skipped where there is none
// (npx playwright install chromium).
/* global document, window, getComputedStyle, Settings, Chat, Live -- the page.evaluate() bodies run in the browser */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSecretKey, maskSecret } from "../src/lib/vault.js";

const PUBLIC = fileURLToPath(new URL("../src/public/", import.meta.url));
const FAKE_KEY = "sk-test-canary-0000000000000000ry42";

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

// --- The dashboard's files ---------------------------------------------------------------------------------------

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".svg": "image/svg+xml" };
let server;
let origin;
before(async () => {
  if (!browser) return;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const rel = url.pathname === "/" || url.pathname.startsWith("/chat") ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
});

// --- A fake /api -------------------------------------------------------------------------------------------------

function card(id, label, kind, over = {}) {
  return { id, storageId: id === "claude" ? "claude-code" : id, label, kind, shipped: true, active: false, state: "needs-key", ready: false, detail: `No ${label} key yet.`, fix: "Paste one in Settings > AI.", keySource: null, keyHint: null, keySourceText: null, account: null, balance: null, envKey: null, model: null, notes: [], settings: null, ...over };
}

const GUARD_FILE = "/data/tarsee/workspace/.claude/settings.json";

/**
 * ready: provider ids that start Ready. env: provider id → the Railway variable its key comes from (Ready too).
 * settings: GET /api/settings' rows from the start (what the page reads as it loads).
 * The rest of what a test changes is on the returned state: costNote, notes (GET /api/ai/models' note), loginFail
 * (POST /api/ai/chatgpt/login's answer: { status, body }), pollFail (the poll's), settings (GET /api/settings),
 * audit (GET /api/admin/audit's entries).
 */
function fakeApi({ needsSetup = true, active = "claude", onlyClaude = false, guard = false, ready: readyIds = [], env = {}, settings = null } = {}) {
  const calls = [];
  const state = {
    guard,
    keysOnly: false,
    active,
    loginPolls: 0,
    loginFail: null,
    pollFail: null,
    notes: {},
    settings: settings || [{ key: "ai.backupModel", value: "" }],
    audit: [],
    cards: {
      claude: card("claude", "Claude plan", "subscription", { state: "needs-sign-in", detail: "Nobody has signed in to the Claude plan yet.", fix: "Run claude auth login in the Terminal.", model: "sonnet" }),
      chatgpt: card("chatgpt", "ChatGPT plan", "subscription", { state: "needs-sign-in", detail: "Nobody has signed in to ChatGPT yet.", fix: "Sign in in Settings > AI." }),
      anthropic: card("anthropic", "Anthropic API key", "key", { envKey: "ANTHROPIC_API_KEY", model: "sonnet" }),
      openai: card("openai", "OpenAI API key", "key", { envKey: "OPENAI_API_KEY", model: "gpt-6.1-sol", shipped: false }),
      openrouter: card("openrouter", "OpenRouter", "key", { envKey: "OPENROUTER_API_KEY", model: "~anthropic/claude-sonnet-latest" }),
      deepseek: card("deepseek", "DeepSeek", "key", { envKey: "DEEPSEEK_API_KEY", model: "deepseek-flash", notes: ["The cheapest per token; a small top-up is enough."] }),
      local: card("local", "Local AI", "local", { state: "needs-setup", detail: "Local AI has no server address yet.", fix: "Add your server's address.", settings: { baseUrl: null, context: 128000 } }),
    },
  };
  if (onlyClaude) for (const c of Object.values(state.cards)) if (c.id !== "claude") c.shipped = false;
  const ready = (c, over = {}) => Object.assign(c, { state: "ready", ready: true, detail: "Ready.", fix: null, ...over });
  for (const id of readyIds) ready(state.cards[id], state.cards[id].kind === "subscription" ? { keySource: "sign-in" } : {});
  for (const [id, name] of Object.entries(env)) ready(state.cards[id], { keySource: `env:${name}`, keyHint: "…ab12", keySourceText: `Railway variable ${name}` });
  const providers = () => {
    const list = Object.values(state.cards).map((c) => {
      const blocked = state.keysOnly && c.kind === "subscription";
      return blocked ? { ...c, state: "blocked-keys-only", ready: false, active: c.id === state.active } : { ...c, active: c.id === state.active };
    });
    const a = list.find((c) => c.id === state.active);
    return {
      active: { provider: a.id, label: a.label, model: a.model, engine: "claude-code", chosenBy: "settings", state: a.state, ready: a.ready, detail: a.detail, fix: a.fix, streaming: true },
      keysOnly: { on: state.keysOnly, locked: false },
      providers: list,
      spend: { monthUsd: 1.25, costNote: state.costNote ?? "est", capUsd: state.cap ?? null, timeZone: "UTC" },
      banners: [
        { id: "keys-not-encrypted", level: "warning", message: "Your saved AI keys aren't encrypted. Set ENCRYPTION_KEY as a Railway variable, then save the keys again." },
        ...(state.guard ? [{
          id: "settings-guard-1",
          level: "error",
          message: `${GUARD_FILE} has settings that could send an AI key or its requests somewhere else (env.ANTHROPIC_BASE_URL), so Tarsee won't run Claude plan and DeepSeek turns until they're removed.`,
          action: { label: "Remove these entries", kind: "settings-guard", file: GUARD_FILE },
        }] : []),
      ],
    };
  };
  const MODELS = {
    deepseek: [{ id: "deepseek-flash", label: "DeepSeek Flash", needsVerification: false }, { id: "deepseek-v4-pro", label: "DeepSeek Pro", needsVerification: false }],
    claude: [{ id: "sonnet", label: "Sonnet", needsVerification: false }],
    anthropic: [{ id: "sonnet", label: "Sonnet", needsVerification: false }],
    openrouter: [
      { id: "~anthropic/claude-sonnet-latest", label: "Anthropic: Claude Sonnet (latest)", needsVerification: false },
      { id: "qwen/qwen3-coder:free", label: "Qwen: Qwen3 Coder (free)", free: true, needsVerification: true, price: { in: 0, out: 0 }, verifyCost: "Free" },
    ],
    chatgpt: [{ id: "acct-model-a", label: "The account's model", needsVerification: false }],
  };
  const NAMES = { sonnet: "Sonnet 5.5", haiku: "Haiku 4.5" };
  // The composer's list (GET /api/chat/models, routes/models.js): a group per ready AI, the default AI first.
  const chatModels = () => {
    const list = Object.values(state.cards).filter((c) => c.shipped && c.ready && !(state.keysOnly && c.kind === "subscription"));
    list.sort((a, b) => (b.id === state.active) - (a.id === state.active));
    const groups = list.map((c) => ({
      provider: c.id, label: c.label, defaultModel: c.model,
      sections: [{ id: "main", label: null, entries: (MODELS[c.id] || []).filter((m) => !m.needsVerification && m.inMenu !== false).map((m) => ({
        id: m.id, name: NAMES[m.id] || m.label, provider: c.id, ref: `${c.id}:${m.id}`, ...(NAMES[m.id] ? { alias: m.id, family: m.id } : {}),
      })) }],
    }));
    const unavailable = Object.values(state.cards).filter((c) => c.shipped && !list.includes(c)).map((c) => ({ provider: c.id, label: c.label, state: c.state }));
    const a = state.cards[state.active];
    return { picker: { groups, unavailable }, defaults: { provider: a.id, model: a.model, ref: `${a.id}:${a.model || ""}`, effort: "medium" }, models: [] };
  };

  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ method, path: url.pathname, body });
    const json = (status, data) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    const p = url.pathname;
    const id = p.split("/").pop();

    if (p === "/api/auth/status") return json(200, { authenticated: true, needsPassword: true });
    if (p === "/api/auth/api-token") return json(200, { apiToken: null });
    if (p === "/api/settings/setup-status") return json(200, { needsSetup, needsPersonality: false, botName: "Tarsee", provider: needsSetup ? null : "claude-code", hasKey: !needsSetup });
    if (p === "/api/settings" && method === "GET") return json(200, { settings: state.settings });
    if (p === "/api/settings/general" && method === "POST") {
      // As routes/settings.js and db/settings.js do: a secret sent empty is deleted, and a secret is read back only as
      // its masked display (vault.js maskSecret). test/settings-captcha-key.test.js runs the real routes.
      const others = state.settings.filter((s) => s.key !== body.key);
      if (isSecretKey(body.key) && (body.value == null || (typeof body.value === "string" && !body.value.trim()))) {
        const removed = others.length < state.settings.length;
        state.settings = others;
        return json(200, { ok: true, removed });
      }
      state.settings = [...others, { key: body.key, value: isSecretKey(body.key) && typeof body.value === "string" ? maskSecret(body.value) : body.value }];
      return json(200, { ok: true });
    }
    if (p === "/api/skills") return json(200, { skills: [{ name: "weather", description: "Weather" }] });
    if (p === "/api/ai/providers") return json(200, providers());
    if (p === "/api/chat/models") return json(200, chatModels());
    if (p.startsWith("/api/ai/models/")) return json(200, { provider: id, models: MODELS[id] || [], defaultModel: state.cards[id]?.model, note: state.notes[id] ?? null });
    if (p.startsWith("/api/ai/verify/") && method === "POST") {
      let m = (MODELS[id] || []).find((x) => x.id === body?.model);
      // The OpenAI key: a model id its list lacks is checked as it is, and joins the card's list once it passes
      // (routes/ai.js GET /models/openai lists the owner's verified ids).
      if (!m && id === "openai" && body?.model) {
        m = { id: body.model, label: body.model };
        (MODELS.openai ||= []).push(m);
      }
      if (!m) return json(400, { error: "Say which model to verify." });
      Object.assign(m, { verified: true, needsVerification: false, inMenu: true });
      return json(200, { ok: true, engine: "codex", efforts: [], checks: { reply: true, tool: true }, error: null, message: `${m.id} passed. You can choose it now.` });
    }
    if (p.startsWith("/api/ai/providers/") && method === "PUT") {
      const c = state.cards[id];
      if ("model" in body) c.model = body.model;
      if (id === "local" && "baseUrl" in body) {
        c.settings = { ...c.settings, baseUrl: body.baseUrl };
        Object.assign(c, { detail: `Local AI at ${body.baseUrl} has no model chosen yet.`, fix: "Press Test." });
      }
      return json(200, { ok: true, card: c });
    }
    if (p === "/api/ai/test/local") {
      // The routes' rows (GET /api/ai/models/local): every model is on the card; only the chosen one is in a chat's menu.
      MODELS.local = [
        { id: "qwen3:8b", label: "qwen3:8b", needsVerification: false, inMenu: true, verifyCost: "Free" },
        { id: "llama3.1:8b", label: "llama3.1:8b", needsVerification: false, inMenu: false, verifyCost: "Free" },
      ];
      ready(state.cards.local, { model: "qwen3:8b", detail: `Using your Local AI at ${state.cards.local.settings.baseUrl}.` });
      return json(200, { ok: true, state: "ready", message: "Reached your Local AI · 2 models", models: ["qwen3:8b", "llama3.1:8b"] });
    }
    if (p.startsWith("/api/ai/test/")) {
      if (id === "deepseek") {
        const key = body?.apiKey;
        if (key && key !== FAKE_KEY) return json(400, { error: "This is an Anthropic key. Paste it in the Anthropic API key card." });
        return json(200, { ok: true, state: "ready", message: "Key works · Balance $4.20", balance: { text: "Balance $4.20" } });
      }
      const c = state.cards[id];
      return json(200, { ok: c.ready, state: c.state, message: c.ready ? "Signed in." : `${c.detail} ${c.fix}` });
    }
    if (p.startsWith("/api/ai/keys/") && method === "PUT") {
      if (body?.apiKey !== FAKE_KEY) return json(400, { error: "That isn't a DeepSeek key." });
      ready(state.cards[id], { keySource: "settings", keyHint: "…ry42", keySourceText: "Saved in Tarsee (encrypted)", balance: { text: "Balance $4.20" } });
      return json(200, { ok: true, id, keySource: "settings", keyHint: "…ry42", encrypted: true });
    }
    if (p === "/api/ai/active" && method === "PUT") {
      const c = state.cards[body.provider];
      if (!c?.ready) return json(409, { error: `${c?.label} isn't ready`, fix: "Fix it first." });
      state.active = body.provider;
      if (body.model) c.model = body.model;
      return json(200, { ok: true, provider: body.provider, model: c.model });
    }
    if (p === "/api/ai/settings-guard/fix" && method === "POST") {
      if (!state.guard || body?.file !== GUARD_FILE) return json(404, { error: "That file has nothing Tarsee needs to remove." });
      state.guard = false;
      return json(200, { ok: true, file: GUARD_FILE, removed: ["env.ANTHROPIC_BASE_URL"], setAside: null });
    }
    if (p === "/api/ai/keys-only" && method === "PUT") {
      state.keysOnly = !!body.on;
      return json(200, { ok: true, keysOnly: { on: state.keysOnly, locked: false }, activeBlocked: false, message: null });
    }
    if (p === "/api/ai/chatgpt/login") {
      const waiting = { state: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-1234", expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() };
      if (method === "POST" && state.loginFail) return json(state.loginFail.status, state.loginFail.body);
      if (method === "POST") { state.loginPolls = 0; return json(200, waiting); }
      if (method === "DELETE") return json(200, { ok: true, state: "idle" });
      state.loginPolls++;
      if (state.pollFail) return json(200, state.pollFail);
      if (state.loginPolls < 2) return json(200, waiting);
      ready(state.cards.chatgpt, { keySource: "sign-in", account: "you@example.com (Free)", model: null });
      return json(200, { state: "done", account: "you@example.com (Free)" });
    }
    if (p === "/api/ai/chatgpt/logout" && method === "POST") {
      // The server's sign-out ends a sign-in that is waiting: its poll answers idle from then on.
      state.pollFail = { state: "idle" };
      Object.assign(state.cards.chatgpt, { state: "needs-sign-in", ready: false, keySource: null, account: null, detail: "Nobody has signed in to ChatGPT yet." });
      return json(200, { ok: true });
    }
    if (p === "/api/admin/audit") return json(200, { entries: state.audit });
    if (p === "/api/admin/tool-registry") {
      return json(200, [
        { name: "web_fetch", label: "Open a web address", description: "Fetches a page.", group: "Web", policyCovered: true, mcpName: "tarsee_web_fetch", mode: "check_ssrf" },
        { name: "pdf_read", label: "Read a PDF", description: "Reads a PDF.", group: "Documents and visuals", policyCovered: true, mcpName: "tarsee_pdf_read", mode: "always_allow" },
        { name: "Bash", label: "Run commands in a shell", description: "Built into the AI itself.", group: "Built into the AI", policyCovered: false, mcpName: null, mode: null },
      ]);
    }
    if (p === "/api/admin/context-health") {
      const row = (id, title, provider, providerLabel, engine, transcriptMB) => ({
        id, title, provider, providerLabel, engine, sessionId: `${id}-raw`, messages: 12, transcriptMB, willResetNextTurn: false,
        contextTokens: 42000, contextWindow: 180000, contextPct: 23, status: "ok", measured: true,
      });
      return json(200, {
        sessionCapMB: 8,
        provider: null,
        conversations: [
          row("c1", "Trip plans", "claude", "Claude plan", "claude-code", 1.2),
          row("c2", "Invoices", "deepseek", "DeepSeek", "claude-code", 0.4),
          row("c3", "Code review", "openai", "OpenAI API key", "codex", null),
        ],
      });
    }
    if (p.startsWith("/api/chat/channels")) return json(200, { channels: [] });
    return json(200, {});
  }
  return { calls, state, handle, MODELS };
}

async function openPage({ width = 1280, height = 900, ...opts } = {}) {
  // $AI_UI_WIDTH draws every page at another width (with $AI_UI_SHOTS, to look at it).
  if (Number(process.env.AI_UI_WIDTH) > 0) width = Number(process.env.AI_UI_WIDTH);
  const api = fakeApi(opts);
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  // Nothing leaves the machine: fonts and CDN scripts are refused, /api goes to the fake.
  await page.route((url) => !url.href.startsWith(origin), (route) => route.abort());
  await page.route(`${origin}/api/**`, (route) => api.handle(route));
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`${origin}/`);
  return { page, api, errors, context };
}

/** A screenshot into $AI_UI_SHOTS (a folder), when it is set: for looking at the pages by eye. */
const shot = async (page, name) => {
  if (process.env.AI_UI_SHOTS) await page.screenshot({ path: path.join(process.env.AI_UI_SHOTS, `${name}.png`), fullPage: true });
};
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/**
 * Answer the question on screen (js/dialogs.js) with the button called `name`. A press in its first 400 ms is taken
 * as the end of the click that opened it, not an answer (its SETTLE_MS), so wait that out first, as a person would.
 */
async function answerDialog(page, name) {
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  await page.waitForTimeout(450);
  await dialog.getByRole("button", { name }).click();
}

describe("the AI pages in a browser", { skip }, () => {
  it("the wizard: other people, an API key tested and saved, keys-only saved, the AI made the default", async () => {
    const { page, api, errors, context } = await openPage({ width: 375, height: 800 });
    try {
      await page.getByText("Choose your AI").waitFor();
      assert.ok(await page.getByRole("button", { name: /My Claude plan/ }).isVisible());
      assert.ok(await page.getByRole("button", { name: /My ChatGPT plan/ }).isVisible());
      assert.ok(await page.getByRole("button", { name: /My own API key/ }).isVisible());
      assert.ok(await noSideScroll(page), "no sideways scroll at phone width");
      await shot(page, "wizard-start-phone");

      await page.getByLabel("Other people too (a team, customers)").check();
      assert.equal(await page.locator("#setupKeysOnly").isChecked(), true, "shared use pre-ticks keys-only, where it can be seen");
      assert.equal(await page.getByRole("button", { name: /My Claude plan/ }).isDisabled(), true, "plans are off while keys-only is ticked");

      await page.getByRole("button", { name: /My own API key/ }).click();
      await page.locator('[data-setup="provider"][data-provider="deepseek"]').click();
      await page.getByText("How to set up DeepSeek").waitFor();
      assert.equal(await page.locator("#setupAiNext").isDisabled(), true, "Next waits for a ready AI");
      await page.locator("#setupKey").fill(FAKE_KEY);
      await page.getByRole("button", { name: "Test and save" }).click();
      await page.getByText(/Key works · Balance \$4\.20/).first().waitFor();
      await page.locator("#setupAiNext:not([disabled])").waitFor();
      assert.ok(await noSideScroll(page));
      // The page itself never scrolls, so a card taller than a phone must scroll inside the wizard, from its top.
      const scroll = await page.evaluate(() => {
        const w = document.getElementById("setupWizard");
        const card = w.querySelector(".setup-card").getBoundingClientRect();
        return {
          cardTaller: card.height > window.innerHeight,
          wizardFits: w.getBoundingClientRect().height <= window.innerHeight + 1,
          scrolls: w.scrollHeight <= w.clientHeight || ["auto", "scroll"].includes(getComputedStyle(w).overflowY),
          cardTop: card.top + w.scrollTop,
        };
      });
      assert.ok(scroll.cardTaller, "the step is taller than the phone");
      assert.ok(scroll.wizardFits && scroll.scrolls, "so the wizard fits the screen and scrolls inside it (Next can be reached)");
      assert.ok(scroll.cardTop >= 0, "from the card's top");
      await shot(page, "wizard-deepseek-phone");

      await page.locator("#setupAiNext").click();
      await page.getByText("Choose Your Skills").waitFor();
      const saved = api.calls.filter((c) => c.method !== "GET" && c.path.startsWith("/api/ai/"));
      assert.deepEqual(saved.map((c) => `${c.method} ${c.path}`), ["POST /api/ai/test/deepseek", "PUT /api/ai/keys/deepseek", "PUT /api/ai/keys-only", "PUT /api/ai/active"]);
      assert.deepEqual(saved[2].body, { on: true });
      assert.deepEqual(saved[3].body, { provider: "deepseek", model: "deepseek-flash" });
      assert.ok(!api.calls.some((c) => JSON.stringify(c.body || {}).includes("subscription")), "no placeholder key");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("the wizard: ChatGPT shows the link and the code, then turns Ready by itself", async () => {
    const { page, errors, context } = await openPage();
    try {
      await page.getByRole("button", { name: /My ChatGPT plan/ }).click();
      await page.getByText("How to set up ChatGPT plan").waitFor();
      await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
      await page.getByText("ABCD-1234").waitFor();
      await shot(page, "wizard-chatgpt-code");
      assert.ok(await page.locator('a[href="https://auth.openai.com/codex/device"][target="_blank"][rel="noopener noreferrer"]').isVisible());
      await page.getByText(/Ready, signed in as you@example\.com \(Free\)/).waitFor({ timeout: 15000 });
      await page.locator("#setupAiNext:not([disabled])").waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("the wizard with only the Claude plan switched on: no keys-only dead end, the plan can be chosen", async () => {
    const { page, errors, context } = await openPage({ onlyClaude: true, width: 375, height: 800 });
    try {
      await page.getByText("Choose your AI").waitFor();
      assert.equal(await page.getByRole("button", { name: /My own API key/ }).count(), 0, "no API-key AI in this version");
      assert.ok(await page.getByRole("button", { name: /My ChatGPT plan/ }).count() === 0);
      // "Other people too" would tick "Only use API keys" and switch off the only AI there is: not offered.
      assert.equal(await page.locator(".setup-ai-who").isVisible(), false, "the who-question is not asked");
      assert.equal(await page.locator("#setupKeysOnly").isVisible(), false, "no keys-only box with no key to use");
      const plan = page.getByRole("button", { name: /My Claude plan/ });
      assert.equal(await plan.isDisabled(), false);
      await plan.click();
      await page.getByText("How to set up Claude plan").waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Settings → AI with only the Claude plan switched on: its card alone, and no keys-only switch to silence it", async () => {
    const { page, errors, context } = await openPage({ needsSetup: false, onlyClaude: true });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      await page.locator("#aiChips .ai-chip").first().waitFor();
      assert.equal((await page.locator("#aiChips .ai-chip").allInnerTexts()).length, 1);
      assert.ok(await page.locator("#claudeAiCard").isVisible());
      assert.ok(await page.locator("#deepseekAiCard").isHidden());
      assert.equal(await page.locator("#aiKeysOnly").isVisible(), false, "no API-key AI to fall back on, so the switch isn't offered");
      assert.equal(await page.locator("#aiKeysOnlyNote").isVisible(), false);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Token Health names each chat's AI and filters by it; Codex chats have no transcript to size", async () => {
    const { page, errors, context } = await openPage({ needsSetup: false });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      await page.locator('.settings-tab-panel[data-tab="ai"].active').waitFor();
      await page.locator('.settings-tab[data-tab="health"]').click();
      await page.locator("#contextHealthContent table").waitFor();
      const head = await page.locator("#contextHealthContent thead").textContent();
      assert.match(head, /AI/);
      const rows = await page.locator("#contextHealthContent tbody tr").allInnerTexts();
      assert.equal(rows.length, 3);
      assert.match(rows[1], /Invoices[\s\S]*DeepSeek/);
      assert.match(rows[2], /Code review[\s\S]*OpenAI API key[\s\S]*no transcript/);
      await page.locator("#contextHealthProvider").selectOption("deepseek");
      await page.locator("#contextHealthContent tbody tr", { hasText: "Trip plans" }).waitFor({ state: "detached" });
      assert.deepEqual((await page.locator("#contextHealthContent tbody tr").allInnerTexts()).map((t) => t.split("\t")[0].trim()), ["Invoices"]);
      await page.locator("#contextHealthProvider").selectOption("");
      await page.locator("#contextHealthContent tbody tr", { hasText: "Trip plans" }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Settings → AI: a settings file the guards refuse, named with its entries and AIs, fixed in one click after asking", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false, guard: true });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      const banner = page.locator("#aiBanners .ai-banner", { hasText: "settings.json" });
      await banner.waitFor();
      assert.match(await banner.textContent(), /env\.ANTHROPIC_BASE_URL[\s\S]*Claude plan and DeepSeek/);
      await banner.getByRole("button", { name: "Remove these entries" }).click();
      const ask = page.getByRole("alertdialog");
      await ask.waitFor();
      assert.match(await ask.textContent(), /settings\.json/);
      assert.ok(!api.calls.some((c) => c.path === "/api/ai/settings-guard/fix"), "nothing changes before the answer");
      await answerDialog(page, "Remove");
      await banner.waitFor({ state: "detached" });
      assert.deepEqual(api.calls.find((c) => c.path === "/api/ai/settings-guard/fix").body, { file: GUARD_FILE });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("the model picker's \"Settings > AI\" link (Settings.focusAI) opens the AI tab, at a provider's card when it names one", async () => {
    const { page, errors, context } = await openPage({ needsSetup: false });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").waitFor();
      // What js/model-picker.js does: Settings.open(), then Settings.focusAI() when it exists.
      await page.evaluate(() => Settings.open().then(() => Settings.focusAI()));
      await page.locator('.settings-tab-panel[data-tab="ai"].active').waitFor();
      await page.locator('.settings-tab[data-tab="security"]').click();
      await page.evaluate(() => Settings.focusAI("deepseek"));
      await page.locator('.settings-tab-panel[data-tab="ai"].active').waitFor();
      await page.locator("#deepseekAiCard:not([hidden]) details.ai-guide[open]").waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Settings → AI: the header chip, the chips, a card per provider, Test with a balance; the tool list", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false, width: 390, height: 844 });
    try {
      // The default AI (the Claude plan, not signed in): a red dot, and a banner saying what to do.
      await page.locator("#aiHeaderChip:not([hidden])").waitFor();
      assert.equal(await page.locator("#aiHeaderChip .channel-dot").getAttribute("data-tone"), "bad");
      await page.locator("#aiAttention:not([hidden])").waitFor();
      assert.match(await page.locator("#aiAttention").innerText(), /Claude plan can't answer right now/);

      await page.locator("#aiHeaderChip").click();
      await page.locator('.settings-tab-panel[data-tab="ai"].active').waitFor();
      await page.locator("#aiChips .ai-chip").first().waitFor();
      await shot(page, "settings-ai-top");
      const chips = await page.locator("#aiChips .ai-chip").allInnerTexts();
      assert.equal(chips.length, 6, "one chip per provider this version switches on");
      assert.ok(await page.locator("#openaiAiCard").isHidden(), "a provider not switched on has no card");
      assert.match(await page.locator("#aiBanners").innerText(), /aren't encrypted/);
      assert.match(await page.locator("#deepseekAiStatus").innerText(), /No DeepSeek key yet/);
      assert.equal(await page.locator('#deepseekAiCard details.ai-guide').getAttribute("open"), "", "a card that isn't ready shows its steps");

      await page.locator("#aiKey-deepseek").fill(FAKE_KEY);
      await page.locator('#deepseekAiCard [data-ai-action="save-key"]').click();
      await page.locator("#deepseekAiStatus", { hasText: "Ready, using DeepSeek Flash · Balance $4.20" }).waitFor();
      assert.match(await page.locator('#deepseekAiCard [data-ai-test]').innerText(), /Key works · Balance \$4\.20/);
      assert.match(await page.locator("#deepseekAiCard .ai-keysource").innerText(), /Saved in Tarsee \(encrypted\) …ry42/);
      assert.ok(!(await page.content()).includes(FAKE_KEY), "the key is never on the page after saving");

      await page.locator('#deepseekAiCard [data-ai-action="use"]').click();
      await page.locator("#aiDefaultNow", { hasText: "DeepSeek, using DeepSeek Flash" }).waitFor();
      assert.deepEqual(api.calls.find((c) => c.path === "/api/ai/active").body, { provider: "deepseek", model: "deepseek-flash" });
      await page.locator("#aiAttention[hidden]").waitFor({ state: "attached" });
      assert.ok(await noSideScroll(page), "no sideways scroll at phone width");
      await shot(page, "settings-ai-phone");

      await page.locator('.settings-tab[data-tab="security"]').click();
      await page.locator(".tool-perm-row").first().waitFor();
      const rows = await page.locator(".tool-perm-row").allInnerTexts();
      assert.equal(rows.length, 3);
      assert.match(rows.join("\n"), /Run commands in a shell[\s\S]*Always on/);
      await shot(page, "settings-tools-phone");
      assert.equal(await page.locator('.tool-perm-select[data-tool="web_fetch"]').inputValue(), "check_ssrf", "a mode outside Allow/Warn/Deny is kept, in words");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Settings → AI: keys-only asks first, the backup and cap save, OpenRouter's Verify, Local AI's address", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      await page.locator("#aiChips .ai-chip").first().waitFor();

      // "Only use API keys" with a plan as the default: asked first, then saved, and the plan's card says it's off.
      await page.locator("#aiKeysOnly").check();
      await answerDialog(page, "Switch it on");
      await page.locator("#claudeAiStatus", { hasText: "Only use API keys" }).waitFor();
      assert.deepEqual(api.calls.find((c) => c.path === "/api/ai/keys-only").body, { on: true });

      // OpenRouter: a model that needs verifying, verified, then choosable.
      await page.locator("#openrouterAiCard .ai-or > summary").click();
      await page.locator('#openrouterAiCard [data-ai-or-search]').fill("qwen");
      await page.locator('#openrouterAiCard .ai-or-row', { hasText: "Qwen3 Coder" }).waitFor();
      // (textContent: the group titles and badges are drawn in capitals by CSS, which innerText would report)
      assert.match(await page.locator("#openrouterAiCard .ai-or-list").textContent(), /Verify to use \(1\)[\s\S]*Free/);
      // (Verify ends by reading every card again, settings last, and drawing them: wait for that, so what's checked
      // is the list after the cards are drawn again, still open, not the moment before.)
      const redrawn = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/settings" && r.request().method() === "GET");
      await page.locator('#openrouterAiCard [data-ai-action="verify"][data-model="qwen/qwen3-coder:free"]').click();
      // Verify spends a little on the owner's key, so it says what it costs and asks first (design 4.11).
      const ask = page.getByRole("alertdialog");
      await ask.waitFor();
      assert.match(await ask.textContent(), /Verify Qwen: Qwen3 Coder \(free\)\?[\s\S]*Cost: Free/);
      assert.ok(!api.calls.some((c) => c.path === "/api/ai/verify/openrouter"), "nothing runs before the answer");
      await answerDialog(page, "Verify");
      await page.locator("#openrouterAiCard [data-ai-test]", { hasText: "passed. You can choose it now." }).waitFor();
      await redrawn;
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
      assert.equal(await page.locator("#openrouterAiCard details.ai-or").getAttribute("open"), "", "the list someone opened stays open when the card is drawn again");
      assert.equal(await page.locator("#openrouterAiCard [data-ai-or-search]").inputValue(), "qwen", "with their search");
      await page.locator('#openrouterAiCard [data-ai-action="choose"][data-model="qwen/qwen3-coder:free"]').waitFor();
      assert.deepEqual(api.calls.find((c) => c.path === "/api/ai/verify/openrouter").body, { model: "qwen/qwen3-coder:free" });

      // Local AI: the Ollama preset, Save, then Test lists the model and the card is ready.
      await page.locator('#localAiCard [data-ai-action="preset"]', { hasText: "Ollama" }).click();
      assert.equal(await page.locator("#aiLocalUrl").inputValue(), "http://localhost:11434/v1");
      await page.locator('#localAiCard [data-ai-action="save-local"]').click();
      await page.locator("#localAiStatus", { hasText: "Ready, using qwen3:8b" }).waitFor();
      assert.equal(api.calls.find((c) => c.path === "/api/ai/providers/local").body.baseUrl, "http://localhost:11434/v1");

      // Every model the server has gets its own row: the card's chosen one is in a chat's model menu, another one is
      // verified on its own row, so verifying it never changes the card's model.
      const localRow = (name) => page.locator("#localAiCard [data-ai-local-row]", { hasText: name });
      await localRow("llama3.1:8b").waitFor();
      assert.match(await localRow("llama3.1:8b").textContent(), /Verify to use it in a chat/);
      assert.match(await localRow("qwen3:8b").textContent(), /In a chat's model menu/);
      assert.equal(await page.locator('#localAiCard .ai-inline [data-ai-action="verify"]').count(), 0, "no Verify tied to the model list");
      await localRow("llama3.1:8b").locator('[data-ai-action="verify"]').click();
      assert.match(await page.getByRole("alertdialog").textContent(), /Verify llama3\.1:8b\?[\s\S]*Cost: Free/);
      await answerDialog(page, "Verify");
      await page.locator("#localAiCard [data-ai-test]", { hasText: "llama3.1:8b passed" }).waitFor();
      assert.deepEqual(api.calls.find((c) => c.path === "/api/ai/verify/local").body, { model: "llama3.1:8b" });
      assert.ok(!api.calls.some((c) => c.path === "/api/ai/providers/local" && c.body && "model" in c.body), "verifying didn't change the card's model");
      await localRow("llama3.1:8b").filter({ hasText: "Verified" }).filter({ hasText: "In a chat's model menu" }).waitFor();
      assert.equal(await localRow("llama3.1:8b").locator('[data-ai-action="verify"]').textContent(), "Verify again");

      // The backup model (a ready AI) and the monthly cap, saved as settings.
      await page.locator("#aiBackupModel").selectOption("local:qwen3:8b");
      await page.locator("#aiMonthlyCap").fill("20");
      await page.locator("#aiSaveExtrasBtn").click();
      await page.getByText("Saved: backup on, cap $20 a month").waitFor();
      assert.equal(await page.locator("#aiMonthSpend").textContent(), "Spent so far this month: $1.25 (est.).", "this month's spend beside the cap");
      const general = api.calls.filter((c) => c.path === "/api/settings/general").map((c) => c.body);
      assert.deepEqual(general, [{ key: "ai.backupModel", value: "local:qwen3:8b" }, { key: "ai.spendCap.monthlyUsd", value: "20" }]);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});

describe("the AI cards drawn again (a read of the AIs comes in) while someone is using them", { skip }, () => {
  // Opening Settings reads the AIs more than once, and every read draws the cards again. A card drawn again while
  // someone is in it must not take their place away: a paste right after clicking into the key box has to land there.
  it("a card that hasn't changed isn't rebuilt: the box and the buttons are the same ones, still focused", async () => {
    const { page, errors, context } = await openPage({ needsSetup: false, ready: ["claude"] });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      const box = page.locator("#aiKey-deepseek");
      await box.click();
      const before = await page.evaluate(() => {
        window.__keyBox = document.getElementById("aiKey-deepseek");
        window.__saveBtn = document.querySelector('#deepseekAiCard [data-ai-action="save-key"]');
        return document.activeElement === window.__keyBox;
      });
      assert.equal(before, true);
      await page.evaluate(() => Settings.loadAi());
      const after = await page.evaluate(() => ({
        sameBox: document.getElementById("aiKey-deepseek") === window.__keyBox,
        sameButton: document.querySelector('#deepseekAiCard [data-ai-action="save-key"]') === window.__saveBtn,
        focused: document.activeElement?.id || null,
      }));
      assert.deepEqual(after, { sameBox: true, sameButton: true, focused: "aiKey-deepseek" });
      await page.keyboard.insertText(FAKE_KEY);
      assert.equal(await box.inputValue(), FAKE_KEY, "the paste landed in the key box");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("a card drawn again while its Model list has the focus (its label was clicked) still lists its models", async () => {
    const { page, errors, context } = await openPage({ needsSetup: false, ready: ["deepseek"] });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      for (const id of ["aiModel-deepseek", "aiBgModel-deepseek"]) {
        await page.waitForFunction((sel) => document.querySelectorAll(`${sel} option`).length >= 2, `#${id}`);
        const before = await page.locator(`#${id} option`).count();
        assert.ok(before >= 2, `${id} lists the models to begin with`);
        // Clicking the label focuses the list itself (custom-select.js keeps it focusable, out of sight).
        await page.locator(`label[for="${id}"]`).click();
        assert.equal(await page.evaluate(() => document.activeElement?.id), id);
        // The card changes (a line from Test, say) and is built again while the list has the focus.
        await page.evaluate(() => { Settings._aiSetTest("deepseek", { text: `A line at ${Date.now()}`, tone: "bad" }); return Settings.loadAi(); });
        await page.evaluate(() => new Promise((r) => setTimeout(r, 100))); // custom-select.js builds a new list on the next frame
        assert.equal(await page.locator(`#${id} option`).count(), before, `${id} still lists every model`);
        const shown = await page.locator(`#${id}`).evaluate((sel) => sel.closest(".cs-wrap")?.querySelector(".cs-trigger-label")?.textContent?.trim());
        assert.ok(shown, `${id} shows the model chosen`);
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("focus goes back to the very button it was on, not to the first of its kind (a preset, a model's Choose)", async () => {
    const { page, errors, context } = await openPage({ needsSetup: false });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      const presets = page.locator('#localAiCard [data-ai-action="preset"]');
      await presets.nth(1).waitFor();
      assert.ok((await presets.count()) >= 2, "Local AI offers more than one preset");
      const second = await presets.nth(1).getAttribute("data-url");
      await presets.nth(1).focus();
      await page.evaluate(() => { Settings._aiSetTest("local", { text: `A line at ${Date.now()}`, tone: "bad" }); return Settings.loadAi(); });
      const now = await page.evaluate(() => ({ action: document.activeElement?.dataset?.aiAction || null, url: document.activeElement?.dataset?.url || null }));
      assert.deepEqual(now, { action: "preset", url: second }, "the same preset has the focus, so Enter fills in the address chosen");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("a model's button in OpenRouter's list keeps the focus when the list comes in again, changed or not", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false, ready: ["openrouter"] });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      await page.locator("#openrouterAiCard details.ai-or > summary").click();
      const verify = page.locator('#openrouterAiCard [data-ai-or-list] [data-ai-action="verify"][data-model="qwen/qwen3-coder:free"]');
      await verify.waitFor();
      await verify.focus();
      const focused = () => page.evaluate(() => ({ action: document.activeElement?.dataset?.aiAction || null, model: document.activeElement?.dataset?.model || null }));
      const want = { action: "verify", model: "qwen/qwen3-coder:free" };
      // The same list read again: nothing is drawn again (the very same button, the list untouched), the focus stays.
      await page.evaluate(() => {
        window.__btn = document.activeElement;
        window.__muts = 0;
        new window.MutationObserver((r) => { window.__muts += r.length; }).observe(document.querySelector("#openrouterAiCard [data-ai-or-list]"), { childList: true, subtree: true });
      });
      await page.evaluate(() => Settings.loadAiModels("openrouter", { force: true }));
      assert.deepEqual(await page.evaluate(() => ({ same: document.activeElement === window.__btn, muts: window.__muts })), { same: true, muts: 0 });
      assert.deepEqual(await focused(), want);
      // A list that changed (a model added): drawn again, the focus goes back to the same model's button.
      api.MODELS.openrouter.unshift({ id: "x-ai/newer", label: "xAI: Newer", needsVerification: false });
      await page.evaluate(() => Settings.loadAiModels("openrouter", { force: true }));
      await page.locator('#openrouterAiCard [data-model="x-ai/newer"]').waitFor();
      assert.deepEqual(await focused(), want, "Enter then verifies the model it was on, not another");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("a model's Verify in Local AI's list keeps the focus when the list comes in again, changed or not", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false, ready: ["local"] });
    try {
      api.state.cards.local.settings = { baseUrl: "http://localhost:11434/v1", context: 128000 };
      api.MODELS.local = [
        { id: "qwen3:8b", label: "qwen3:8b", needsVerification: false, inMenu: true },
        { id: "llama3.1:8b", label: "llama3.1:8b", needsVerification: false, inMenu: false },
      ];
      await page.locator("#aiHeaderChip:not([hidden])").click();
      const verify = page.locator('#localAiCard [data-ai-local-list] [data-ai-action="verify"][data-model="llama3.1:8b"]');
      await verify.waitFor();
      await verify.focus();
      await page.evaluate(() => {
        window.__btn = document.activeElement;
        window.__muts = 0;
        new window.MutationObserver((r) => { window.__muts += r.length; }).observe(document.querySelector("#localAiCard [data-ai-local-list]"), { childList: true, subtree: true });
      });
      await page.evaluate(() => Settings.loadAiModels("local", { force: true }));
      assert.deepEqual(await page.evaluate(() => ({ same: document.activeElement === window.__btn, muts: window.__muts })), { same: true, muts: 0 }, "an unchanged list isn't drawn again");
      api.MODELS.local.push({ id: "mistral:7b", label: "mistral:7b", needsVerification: false, inMenu: false });
      await page.evaluate(() => Settings.loadAiModels("local", { force: true }));
      await page.locator('#localAiCard [data-model="mistral:7b"]').waitFor();
      const now = await page.evaluate(() => ({ action: document.activeElement?.dataset?.aiAction || null, model: document.activeElement?.dataset?.model || null }));
      assert.deepEqual(now, { action: "verify", model: "llama3.1:8b" }, "a changed list gives the focus back to the same model's Verify");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("a Copy chip clicked twice goes back to Copy on its own: nothing has to draw the card again", async () => {
    const { page, errors, context } = await openPage({ needsSetup: false });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } }));
      const chip = page.locator("#claudeAiCard [data-copy]").first();
      const label = chip.locator(".setup-copy-label");
      await chip.click();
      await page.waitForTimeout(300);
      await chip.click();
      assert.equal(await label.textContent(), "Copied");
      await page.waitForTimeout(1900);
      assert.equal(await label.textContent(), "Copy");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("a card that changed is drawn again with the box someone is typing in still focused, the text and the caret kept", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false, ready: ["claude"] });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      const box = page.locator("#aiKey-deepseek");
      await box.click();
      await page.keyboard.insertText("sk-test-half");
      await page.evaluate(() => { const b = document.getElementById("aiKey-deepseek"); b.setSelectionRange(3, 3); });
      // The card changes under them (its notes, say, from a read of the AIs): it has to be built again.
      api.state.cards.deepseek.notes = ["A note that came in while you typed."];
      await page.evaluate(() => Settings.loadAi());
      await page.locator("#deepseekAiCard", { hasText: "A note that came in while you typed." }).waitFor();
      const after = await page.evaluate(() => {
        const b = document.getElementById("aiKey-deepseek");
        return { focused: document.activeElement === b, value: b.value, caret: [b.selectionStart, b.selectionEnd] };
      });
      assert.deepEqual(after, { focused: true, value: "sk-test-half", caret: [3, 3] });
      await page.keyboard.press("End");
      await page.keyboard.insertText("-rest");
      assert.equal(await box.inputValue(), "sk-test-half-rest", "what is typed next goes on in the same box");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});

describe("the AI pages in a browser: what a change reaches", { skip }, () => {
  const sessionModel = (page) => page.locator("#sessionModel").textContent();
  const menuGroups = (page) => page.locator("#modelPickerMenu .mp-group[aria-label]").evaluateAll((gs) => gs.map((g) => g.getAttribute("aria-label")));

  it("Settings → AI reaches the composer: a key saved adds its models to the list, a new default changes the model button", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false, ready: ["claude"] });
    try {
      await page.locator("#sessionModel", { hasText: "Sonnet 5.5" }).waitFor();
      // A turn ran on another model (auto-routing): the button names it, as the server's model_selected has it do.
      await page.evaluate(() => { Chat._turnModel = { model: "haiku", provider: "claude", label: "Haiku 4.5" }; Chat._paintPicker(); });
      assert.equal(await sessionModel(page), "Haiku 4.5");

      // A DeepSeek key saved and tested, then Settings closed: DeepSeek's models are in the list now, not in five
      // minutes. The default is the same, so the last turn's model stays on the button.
      await page.locator("#aiHeaderChip:not([hidden])").click();
      await page.locator("#aiKey-deepseek").fill(FAKE_KEY);
      await page.locator('#deepseekAiCard [data-ai-action="save-key"]').click();
      await page.locator("#deepseekAiStatus", { hasText: "Ready" }).waitFor();
      await page.evaluate(() => Settings.close());
      await page.locator("#modelPickerBtn").click();
      await page.locator('#modelPickerMenu .mp-group[aria-label="DeepSeek"]').waitFor({ timeout: 5000 });
      assert.deepEqual(await menuGroups(page), ["Claude plan", "DeepSeek"]);
      assert.equal(await sessionModel(page), "Haiku 4.5", "the default didn't change, so the last turn's model is still what runs");
      await page.keyboard.press("Escape");

      // Use this AI on DeepSeek: once Settings closes the button names the new default's model, and its group is first.
      await page.locator("#aiHeaderChip").click();
      await page.locator('#deepseekAiCard [data-ai-action="use"]').click();
      await page.locator("#aiDefaultNow", { hasText: "DeepSeek, using DeepSeek Flash" }).waitFor();
      await page.evaluate(() => Settings.close());
      await page.locator("#sessionModel", { hasText: "DeepSeek Flash" }).waitFor({ timeout: 5000 });
      await page.locator("#modelPickerBtn").click();
      await page.locator('#modelPickerMenu .mp-group[aria-label="DeepSeek"]').waitFor();
      assert.deepEqual(await menuGroups(page), ["DeepSeek", "Claude plan"]);
      await page.keyboard.press("Escape");

      // The default changed somewhere else (another device): the next read of the AIs (the header's) brings it here.
      await page.evaluate(() => { Chat._turnModel = { model: "deepseek-v4-pro", provider: "deepseek", label: "DeepSeek Pro" }; Chat._paintPicker(); });
      api.state.active = "claude";
      await page.evaluate(() => Settings.refreshAiHeader());
      await page.locator("#sessionModel", { hasText: "Sonnet 5.5" }).waitFor({ timeout: 5000 });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Settings → AI: a backup model and a cap not saved yet stay as chosen when the cards are drawn again, and save so", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false, ready: ["deepseek", "anthropic"] });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      const sel = page.locator("#aiBackupModel");
      const cap = page.locator("#aiMonthlyCap");
      await page.locator('#aiBackupModel option[value="deepseek:deepseek-flash"]').waitFor({ state: "attached" });
      assert.equal(await sel.inputValue(), "", "Off, as saved");
      await sel.selectOption("deepseek:deepseek-flash");
      await cap.fill("20");
      // Test on another card draws every card again, and its model list once more when that comes in.
      const modelsIn = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/ai/models/anthropic");
      await page.locator('#anthropicAiCard [data-ai-action="test"]').click();
      await page.locator("#anthropicAiCard [data-ai-test]", { hasText: "Signed in." }).waitFor();
      await modelsIn;
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
      assert.equal(await sel.inputValue(), "deepseek:deepseek-flash", "the backup chosen stays chosen");
      assert.ok((await sel.locator("option").count()) >= 3, "in the list drawn again around it");
      assert.equal(await cap.inputValue(), "20", "and the cap typed stays");

      await page.locator("#aiSaveExtrasBtn").click();
      await page.getByText("Saved: backup on, cap $20 a month").waitFor();
      const general = api.calls.filter((c) => c.path === "/api/settings/general").map((c) => c.body);
      assert.deepEqual(general, [{ key: "ai.backupModel", value: "deepseek:deepseek-flash" }, { key: "ai.spendCap.monthlyUsd", value: "20" }]);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
      assert.equal(await sel.inputValue(), "deepseek:deepseek-flash", "drawn again: what was saved");
      assert.equal(await cap.inputValue(), "20");

      // Saved, the two fields follow what is saved (changed on another device, say).
      api.state.settings = [{ key: "ai.backupModel", value: "anthropic:sonnet" }, { key: "ai.spendCap.monthlyUsd", value: "35" }];
      await page.evaluate(() => Settings.loadAi());
      assert.equal(await sel.inputValue(), "anthropic:sonnet");
      assert.equal(await cap.inputValue(), "35");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("ChatGPT sign-in that fails: the switch in step 1 is named only when it can be the reason", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      const box = page.locator("#chatgptAiCard [data-ai-device]");
      const STEP1 = /"Enable device code sign-in for Codex" is switched on in ChatGPT \(step 1\)/;
      const attempt = async (text) => {
        await page.locator('#chatgptAiCard [data-ai-action="chatgpt-login"]').click();
        await box.getByText(text).waitFor({ timeout: 10000 });
        return box.innerText();
      };

      api.state.loginFail = { status: 502, body: { error: "ChatGPT sign-in couldn't start: Couldn't reach OpenAI to start the sign-in. Check this server's internet connection and try again.", code: "network" } };
      assert.doesNotMatch(await attempt(/Couldn't reach OpenAI/), STEP1, "a network failure is not about the switch");
      api.state.loginFail = { status: 502, body: { error: "ChatGPT sign-in couldn't start: Codex isn't installed on this server.", code: "codex-missing" } };
      assert.doesNotMatch(await attempt(/Codex isn't installed/), STEP1);
      api.state.loginFail = { status: 429, body: { error: "Too many tries. Wait 40 seconds." } };
      assert.doesNotMatch(await attempt(/Too many tries/), STEP1);
      api.state.loginFail = { status: 502, body: { error: "ChatGPT sign-in couldn't start: In ChatGPT, open Settings → Security and, under App security, turn on \"Enable device code sign-in for Codex\"", code: "device-code-disabled" } };
      assert.match(await attempt(/Settings → Security/), STEP1, "the switch is off: step 1 says where it is");
      api.state.loginFail = { status: 502, body: { error: "ChatGPT sign-in couldn't start: Codex couldn't sign in: request refused", code: "failed" } };
      assert.match(await attempt(/request refused/), STEP1, "a cause not known: the switch is worth a look");

      // Failed after the code was shown: Codex finished but no sign-in came of it, which the switch can't cause
      // (no code would have been shown), and a poll whose code is still the one shown is no reason at all.
      api.state.loginFail = null;
      api.state.pollFail = { state: "failed", error: "Codex finished, but Tarsee couldn't confirm the sign-in. Try again.", code: "not-confirmed" };
      assert.doesNotMatch(await attempt(/couldn't confirm/), STEP1);
      api.state.pollFail = { state: "failed", error: "The sign-in stopped.", code: "ABCD-1234" };
      assert.doesNotMatch(await attempt(/The sign-in stopped/), STEP1);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Settings → AI: this month's spend says (est.) only while some of it is an estimate", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      await page.locator("#aiMonthSpend:not([hidden])").waitFor();
      assert.equal(await page.locator("#aiMonthSpend").textContent(), "Spent so far this month: $1.25 (est.).");
      api.state.costNote = "exact";
      api.state.cap = 20;
      await page.evaluate(() => Settings.loadAi());
      assert.equal(await page.locator("#aiMonthSpend").textContent(), "Spent so far this month: $1.25 of your $20 cap.", "every cost the providers' own");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("DeepSeek's own list: a model it doesn't list for this key is marked, and why is said, in Settings and the wizard", async () => {
    const NOTE = "DeepSeek doesn't list DeepSeek Pro for this key right now.";
    const prepare = (api) => {
      api.MODELS.deepseek[0].confirmed = true;
      api.MODELS.deepseek[1].confirmed = false;
      api.state.notes.deepseek = NOTE;
    };
    let { page, api, errors, context } = await openPage({ needsSetup: false, ready: ["deepseek"] });
    try {
      prepare(api);
      await page.locator("#aiHeaderChip:not([hidden])").click();
      await page.locator("#aiModelNote-deepseek:not([hidden])").waitFor();
      assert.equal(await page.locator("#aiModelNote-deepseek").textContent(), NOTE);
      const opts = await page.locator("#aiModel-deepseek option").allTextContents();
      assert.deepEqual(opts, ["DeepSeek Flash", "DeepSeek Pro · Not listed for this key"]);
      assert.ok(await page.locator("#anthropicAiCard [id^=aiModelNote-]").isHidden(), "no note, nothing shown");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }

    ({ page, api, errors, context } = await openPage({ ready: ["deepseek"] }));
    try {
      prepare(api);
      await page.getByRole("button", { name: /My own API key/ }).click();
      await page.locator('[data-setup="provider"][data-provider="deepseek"]').click();
      await page.locator("#setupAiModel option", { hasText: "Not listed" }).waitFor({ state: "attached" });
      assert.deepEqual(await page.locator("#setupAiModel option").allTextContents(), ["DeepSeek Flash", "DeepSeek Pro · Not listed for this key"]);
      assert.match(await page.locator("#setupAiPanel").innerText(), new RegExp(NOTE.replace(/[.]/g, "\\.")));
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("the wizard: a key from a Railway variable can be tested as it is, without pasting it again", async () => {
    const { page, api, errors, context } = await openPage({ env: { deepseek: "DEEPSEEK_API_KEY" } });
    try {
      await page.locator('[data-setup="use-env"][data-provider="deepseek"]').click();
      await page.locator("#setupAiPanel .ai-keysource", { hasText: "Railway variable DEEPSEEK_API_KEY" }).waitFor();
      const test = page.locator('#setupAiPanel [data-setup="test"]');
      assert.equal((await test.innerText()).trim(), "Test");
      await test.click();
      await page.locator("#setupAiPanel .ai-test-result", { hasText: "Key works · Balance $4.20" }).waitFor();
      assert.deepEqual(api.calls.filter((c) => c.path === "/api/ai/test/deepseek").map((c) => c.body), [{}], "the key it has is tested: nothing is pasted or sent");
      assert.ok(!api.calls.some((c) => c.path.startsWith("/api/ai/keys/")), "and nothing is saved");

      // An AI with no key yet: Test and save, which needs the key pasted, is its only Test.
      await page.locator('[data-setup="provider"][data-provider="anthropic"]').click();
      await page.locator("#setupAiPanel details.ai-guide[data-ai-guide=\"anthropic\"]").waitFor();
      assert.equal(await page.locator('#setupAiPanel [data-setup="test"]').count(), 0);
      assert.equal(await page.locator('#setupAiPanel [data-setup="test-save"]').count(), 1);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("the wizard: each AI's steps name only buttons the wizard shows", async () => {
    const { page, errors, context } = await openPage();
    try {
      const WORDS = /click (?:the )?(Save key|Save and test|Test and save|Test|Save|Use this AI|Verify|Next|Check|Sign in with ChatGPT|Open the Terminal)\b/g;
      const check = async (id) => {
        const guide = await page.locator(`#setupAiPanel details.ai-guide[data-ai-guide="${id}"]`).innerText();
        const buttons = (await page.locator("#setupAiPanel button, #setupAiPanel a.btn, #setupAiNext").allInnerTexts()).map((b) => b.trim());
        const named = [...new Set([...guide.matchAll(WORDS)].map((m) => m[1]))];
        assert.ok(named.length >= 1, `${id}: its steps name a button`);
        const missing = named.filter((n) => !buttons.some((b) => b === n || b === `${n} ↗` || (n === "Next" && b.startsWith("Next: "))));
        assert.deepEqual(missing, [], `${id}: steps name ${JSON.stringify(named)}; the wizard shows ${JSON.stringify(buttons)}`);
      };
      for (const id of ["claude", "chatgpt"]) {
        await page.locator(`[data-setup="choice"][data-choice="${id}"]`).click();
        await check(id);
      }
      await page.getByRole("button", { name: /My own API key/ }).click();
      for (const id of ["anthropic", "openrouter", "deepseek", "local"]) {
        await page.locator(`[data-setup="provider"][data-provider="${id}"]`).click();
        await check(id);
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});

describe("the pages in a browser: what they show and save", { skip }, () => {
  const STOPPED = /The sign-in stopped/;

  it("ChatGPT sign-in that Tarsee no longer follows (a restart, another window): the card says so and how to start again", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").click();
      // After a restart the server has no sign-in at all: its poll answers idle.
      api.state.pollFail = { state: "idle" };
      await page.locator('#chatgptAiCard [data-ai-action="chatgpt-login"]').click();
      const box = page.locator("#chatgptAiCard [data-ai-device]");
      await box.getByText("ABCD-1234").waitFor();
      await box.getByText(STOPPED).waitFor({ timeout: 10000 });
      assert.equal(await box.isHidden(), false, "the box stays, with the reason");
      const text = await box.innerText();
      assert.match(text, /Click Sign in with ChatGPT for a new code/);
      assert.doesNotMatch(text, /ABCD-1234/, "the old code is gone");
      assert.doesNotMatch(text, /step 1/, "not about the device code switch");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("ChatGPT: Sign out while a sign-in waits ends it quietly, with no \"stopped\" message after", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false });
    try {
      // Signed in, but not ready (a failed check): the card offers both Sign in and Sign out.
      Object.assign(api.state.cards.chatgpt, { state: "error", keySource: "sign-in", detail: "ChatGPT didn't answer the last check." });
      await page.locator("#aiHeaderChip:not([hidden])").click();
      const waiting = { state: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-1234", expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() };
      api.state.pollFail = waiting;
      await page.locator('#chatgptAiCard [data-ai-action="chatgpt-login"]').click();
      const box = page.locator("#chatgptAiCard [data-ai-device]");
      await box.getByText("ABCD-1234").waitFor();
      await page.locator('#chatgptAiCard [data-ai-action="chatgpt-logout"]').click();
      await answerDialog(page, "Sign out");
      await page.getByText("Signed out of ChatGPT").waitFor();
      // Longer than a poll: had it gone on, its idle answer would show now.
      await page.waitForTimeout(4000);
      assert.equal(await page.locator("#chatgptAiCard").getByText(STOPPED).count(), 0);
      assert.equal(await page.locator("#chatgptAiCard [data-ai-device]").isHidden(), true);
      const out = api.calls.findIndex((c) => c.path === "/api/ai/chatgpt/logout");
      assert.deepEqual(api.calls.slice(out).filter((c) => c.path === "/api/ai/chatgpt/login"), [], "and it isn't asked about again");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Settings → Audit: every entry is shown as the text it is, never as page markup", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false });
    try {
      const detail = `model <img src=x onerror="window.__auditRan=1"> "quoted" & <b>bold</b>`;
      const ip = `<img src=y onerror="window.__auditRan=2">`;
      api.state.audit = [
        { id: 2, created_at: "2026-11-09 08:01:00", action: "settings.write <b>x</b>", target: `ai.active "<b>y</b>"`, detail, ip: "127.0.0.1" },
        { id: 1, created_at: "2026-11-09 08:00:00", action: "auth.login_failed", target: null, detail: null, ip },
      ];
      await page.locator("#aiHeaderChip:not([hidden])").waitFor();
      await page.evaluate(() => Settings.open());
      await page.locator('.settings-tab[data-tab="audit"]').click();
      const rows = page.locator("#auditLogEntries .audit-entry");
      await rows.nth(1).waitFor();
      await page.waitForTimeout(200);
      assert.equal(await page.locator("#auditLogEntries img, #auditLogEntries b").count(), 0, "no element made from an entry");
      assert.equal(await page.evaluate(() => window.__auditRan ?? null), null, "nothing in an entry ran");
      const first = rows.nth(0);
      assert.equal(await first.locator(".audit-entry-action").textContent(), `settings.write <b>x</b> → ai.active "<b>y</b>"`);
      assert.equal(await first.locator(".audit-entry-detail").textContent(), detail);
      assert.equal(await first.locator(".audit-entry-detail").getAttribute("title"), detail, "the whole detail on hover, quotes and all");
      assert.match(await first.locator(".audit-entry-action").getAttribute("class"), /\bsetting\b/);
      const second = rows.nth(1);
      assert.equal(await second.locator(".audit-entry-detail").textContent(), ip, "no detail: the address it came from, as text");
      assert.match(await second.locator(".audit-entry-action").getAttribute("class"), /\bauth\b/);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Settings → Voice: the OpenAI key is the one Settings → AI keeps; Save never writes its masked display back", async () => {
    // GET /api/settings sends a saved key as its masked display, the way main's Voice page saved one.
    const { page, api, errors, context } = await openPage({
      needsSetup: false,
      settings: [
        { key: "ai.backupModel", value: "" },
        { key: "voice.stt_provider", value: "whisper-api" },
        { key: "voice.openai_api_key", value: "sk-p...wxyz" },
      ],
    });
    try {
      Object.assign(api.state.cards.openai, { shipped: true, state: "ready", ready: true, detail: "Ready.", fix: null, keySource: "settings", keyHint: "…wxyz", keySourceText: "Saved in Tarsee (encrypted)" });
      await page.locator("#aiHeaderChip:not([hidden])").waitFor();
      await page.evaluate(() => Settings.open());
      await page.locator('.settings-tab[data-tab="voice"]').click();
      const keyBox = page.locator("#settingsOpenaiKey");
      await page.waitForFunction(() => document.getElementById("settingsSTTProvider")?.value === "whisper-api");
      await page.waitForTimeout(300);
      assert.equal(await keyBox.inputValue(), "", "a saved key is never put back in the box");
      await page.locator("#openaiKeyStatus", { hasText: "…wxyz" }).waitFor();
      assert.match(await page.locator("#openaiKeyStatus").textContent(), /Settings > AI/);
      await page.locator("#openaiKeyGroup").scrollIntoViewIfNeeded();
      await shot(page, "voice-openai-key");

      // Save with the box left empty: the provider and model only; the key is left as it is.
      await page.locator("#saveSTTBtn").click();
      await page.getByText(/STT: whisper-api/).waitFor();
      const keyWrites = () => api.calls.filter((c) => (c.path === "/api/settings/general" && /api_key|apiKey/i.test(String(c.body?.key))) || c.path.startsWith("/api/ai/keys/"));
      assert.deepEqual(keyWrites(), [], "no key written");
      assert.deepEqual(api.calls.filter((c) => c.path === "/api/settings/general").map((c) => c.body), [{ key: "voice.stt_provider", value: "whisper-api" }]);

      // A key pasted here goes through Settings → AI's own route (its checks), and leaves the box empty.
      await keyBox.fill(FAKE_KEY);
      await page.locator("#saveSTTBtn").click();
      await page.waitForFunction(() => document.getElementById("settingsOpenaiKey").value === "");
      assert.deepEqual(keyWrites().map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body)}`), [`PUT /api/ai/keys/openai ${JSON.stringify({ apiKey: FAKE_KEY })}`]);
      assert.ok(!(await page.content()).includes(FAKE_KEY), "the key is never on the page after saving");
      await page.locator("#openaiKeyStatus", { hasText: "…ry42" }).waitFor();

      // One the route refuses: what it said, and the box keeps what was pasted so it can be fixed.
      await keyBox.fill("not-a-key");
      await page.locator("#saveSTTBtn").click();
      await page.getByText("That isn't a DeepSeek key.").waitFor();
      assert.equal(await keyBox.inputValue(), "not-a-key");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Settings → AI → OpenAI: a model id the list lacks is verified from the card, and can then be chosen", async () => {
    const { page, api, errors, context } = await openPage({ needsSetup: false });
    try {
      Object.assign(api.state.cards.openai, { shipped: true, state: "ready", ready: true, detail: "Ready.", fix: null, keySource: "settings", keyHint: "…wxyz", keySourceText: "Saved in Tarsee (encrypted)", model: "gpt-6.1-sol" });
      await page.locator("#aiHeaderChip:not([hidden])").waitFor();
      await page.locator("#aiHeaderChip").click();
      await page.locator('.settings-tab-panel[data-tab="ai"].active').waitFor();
      const openai = page.locator("#openaiAiCard");
      await openai.locator("details.ai-custom-model > summary").click();
      const box = openai.locator("[data-ai-custom-model]");
      await box.waitFor();

      // Nothing typed: it says so, and nothing runs.
      await openai.locator('[data-ai-action="verify-custom"]').click();
      await openai.locator("[data-ai-test]", { hasText: "Type a model id first." }).waitFor();
      assert.ok(!api.calls.some((c) => c.path === "/api/ai/verify/openai"));

      // An id: Verify asks first (it spends a little on the key), then runs on that exact id.
      await box.fill("gpt-7-mini");
      await openai.locator('[data-ai-action="verify-custom"]').click();
      await answerDialog(page, "Verify");
      await openai.locator("[data-ai-test]", { hasText: "passed. You can choose it now." }).waitFor();
      assert.deepEqual(api.calls.find((c) => c.path === "/api/ai/verify/openai").body, { model: "gpt-7-mini" });
      await page.locator('#aiModel-openai option[value="gpt-7-mini"]').waitFor({ state: "attached" });
      await page.locator("#aiModel-openai").selectOption("gpt-7-mini");
      await page.waitForFunction(() => document.getElementById("openaiAiStatus")?.textContent.includes("gpt-7-mini"));
      assert.deepEqual(api.calls.filter((c) => c.path === "/api/ai/providers/openai").map((c) => c.body), [{ model: "gpt-7-mini" }]);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Settings → Security: the captcha key is never put back in its box, so Save can't write its masked display over it", async () => {
    const CAPTCHA_KEY = "test-canary-captcha-key-0001";
    const { page, api, errors, context } = await openPage({
      needsSetup: false,
      settings: [
        { key: "ai.backupModel", value: "" },
        { key: "captcha.service", value: "capsolver" },
        { key: "captcha.api_key", value: "abcd...wxyz" },
      ],
    });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").waitFor();
      await page.evaluate(() => Settings.open());
      await page.locator('.settings-tab[data-tab="security"]').click();
      const box = page.locator("#captchaApiKey");
      await page.waitForFunction(() => document.getElementById("captchaService")?.value === "capsolver");
      await page.locator("#captchaKeyStatus", { hasText: "…wxyz" }).waitFor();
      assert.equal(await box.inputValue(), "", "a saved key is never put back in the box");
      const keyWrites = () => api.calls.filter((c) => c.path === "/api/settings/general" && c.body?.key === "captcha.api_key");

      // Save with the box left empty: the service only; the key stays as it is.
      await page.locator("#saveCaptchaBtn").click();
      await page.getByText("Captcha settings saved").waitFor();
      assert.deepEqual(keyWrites(), [], "no key written");
      assert.deepEqual(api.calls.filter((c) => c.path === "/api/settings/general").map((c) => c.body), [{ key: "captcha.service", value: "capsolver" }]);

      // A key typed in is saved, and the box is emptied again.
      await box.fill(CAPTCHA_KEY);
      await page.locator("#saveCaptchaBtn").click();
      await page.waitForFunction(() => document.getElementById("captchaApiKey").value === "");
      assert.deepEqual(keyWrites().map((c) => c.body.value), [CAPTCHA_KEY]);
      assert.match(await page.locator("#captchaKeyStatus").textContent(), /…0001/);
      assert.ok(!(await page.content()).includes(CAPTCHA_KEY), "the key is never on the page after saving");

      // What GET /api/settings sends back after a reload: still a saved key, shown only by its last 4.
      const reopenSecurity = async () => {
        await page.reload();
        await page.locator("#aiHeaderChip:not([hidden])").waitFor();
        await page.evaluate(() => Settings.open());
        await page.locator('.settings-tab[data-tab="security"]').click();
        await page.waitForFunction(() => document.getElementById("captchaService")?.value === "capsolver");
      };
      await reopenSecurity();
      await page.locator("#captchaKeyStatus", { hasText: "…0001" }).waitFor();
      assert.equal(await box.inputValue(), "");

      // Remove: the saved key goes, and after a reload the page still says no key is saved.
      await page.locator("#removeCaptchaKeyBtn").click();
      await page.locator("#captchaKeyStatus").waitFor({ state: "hidden" });
      assert.deepEqual(keyWrites().map((c) => c.body.value), [CAPTCHA_KEY, ""]);
      assert.equal(await page.locator("#removeCaptchaKeyBtn").isVisible(), false);
      await reopenSecurity();
      assert.equal(await page.locator("#captchaKeyStatus").isHidden(), true, "no key is said to be saved after a reload");
      assert.equal(await page.locator("#removeCaptchaKeyBtn").isHidden(), true);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("the working line names the AI that answers; on a Codex model it says the reply comes when each step finishes", async () => {
    const { page, errors, context } = await openPage({ needsSetup: false });
    try {
      await page.locator("#aiHeaderChip:not([hidden])").waitFor();
      const turnOf = (id) => page.locator(`[data-turn-id="${id}"] .steps`);
      const detail = (id) => turnOf(id).locator(".steps-detail").textContent();
      const hint = (id) => turnOf(id).locator(".steps-hint");
      const HINT = "This AI sends its reply when each step finishes; tools still appear as they start.";

      await page.evaluate(() => Live.onTurnStart({ turnId: "t-codex", createdAt: Date.now(), payload: { source: "web", provider: "openai", engine: "codex", label: "GPT-5.4 Mini" } }));
      assert.equal(await detail("t-codex"), "Thinking with GPT-5.4 Mini");
      assert.equal(await hint("t-codex").isVisible(), true, "seen without opening the steps");
      assert.equal(await hint("t-codex").textContent(), HINT);
      await turnOf("t-codex").scrollIntoViewIfNeeded();
      await shot(page, "working-line-codex");
      await page.evaluate(() => Live.onStep({ turnId: "t-codex", createdAt: Date.now(), payload: { kind: "tool_start", id: "a1", name: "Bash", summary: "ls" } }));
      assert.match(await detail("t-codex"), /^1 step · /);
      await page.evaluate(() => Live.onStep({ turnId: "t-codex", createdAt: Date.now(), payload: { kind: "tool_end", id: "a1", ok: true } }));
      assert.equal(await detail("t-codex"), "1 step · Thinking with GPT-5.4 Mini");
      // The backup answered: the line names it from then on.
      await page.evaluate(() => Live.onStep({ turnId: "t-codex", createdAt: Date.now(), payload: { kind: "route", label: "DeepSeek Flash", streaming: true } }));
      assert.equal(await detail("t-codex"), "1 step · Thinking with DeepSeek Flash");
      assert.equal(await hint("t-codex").isVisible(), false, "the backup sends its words as they come");
      assert.equal(await turnOf("t-codex").locator(".step").count(), 1, "the route is no step");
      await page.evaluate(() => Live.onTurnEnd({ turnId: "t-codex", createdAt: Date.now(), payload: { stopReason: "end_turn" } }));
      assert.equal(await hint("t-codex").isVisible(), false, "done: no note");

      // Claude Code sends words as they come: the AI's name, no note.
      await page.evaluate(() => Live.onTurnStart({ turnId: "t-cc", createdAt: Date.now(), payload: { source: "web", provider: "deepseek", engine: "claude-code", label: "DeepSeek Flash", streaming: true } }));
      assert.equal(await detail("t-cc"), "Thinking with DeepSeek Flash");
      assert.equal(await hint("t-cc").isVisible(), false);
      await page.evaluate(() => Live.onTurnEnd({ turnId: "t-cc", createdAt: Date.now(), payload: { stopReason: "end_turn" } }));

      // Queued behind another turn, then begun: the AI is named once it begins.
      await page.evaluate(() => Live.onTurnQueued({ turnId: "t-q", createdAt: Date.now(), payload: { source: "web" } }));
      assert.equal(await detail("t-q"), "after the reply above");
      assert.equal(await hint("t-q").isVisible(), false);
      await page.evaluate(() => Live.onTurnStart({ turnId: "t-q", createdAt: Date.now(), payload: { source: "web", provider: "chatgpt", engine: "codex", label: "GPT-6 Luna" } }));
      assert.equal(await detail("t-q"), "Thinking with GPT-6 Luna");
      assert.equal(await hint("t-q").isVisible(), true);

      // A turn that names no AI (an older server): "Thinking", as before.
      await page.evaluate(() => Live.onTurnStart({ turnId: "t-old", createdAt: Date.now(), payload: { source: "web" } }));
      assert.equal(await detail("t-old"), "Thinking");
      assert.equal(await hint("t-old").isVisible(), false);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
