// The AI pages in a real browser (design Phase 5, "headless UI smoke"): the dashboard served from src/public, every
// /api call answered by a small fake of src/routes/ai.js kept in this file, driven with Playwright's Chromium.
//   - the setup wizard: who talks to it, the three choices, a DeepSeek key tested and saved, keys-only saved as ticked,
//     the chosen AI made the default; ChatGPT's sign-in code shown, then Ready by itself
//   - Settings → AI: the chips, a card per provider, Test with a balance; the header chip; the tool list
//   - nothing scrolls sideways at phone width
// Runs on Playwright's own Chromium, else an installed Chrome or Edge; skipped where there is none
// (npx playwright install chromium).
/* global document, window, getComputedStyle, Settings, Chat -- the page.evaluate() bodies run in the browser */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * The rest of what a test changes is on the returned state: costNote, notes (GET /api/ai/models' note), loginFail
 * (POST /api/ai/chatgpt/login's answer: { status, body }), pollFail (the poll's), settings (GET /api/settings).
 */
function fakeApi({ needsSetup = true, active = "claude", onlyClaude = false, guard = false, ready: readyIds = [], env = {} } = {}) {
  const calls = [];
  const state = {
    guard,
    keysOnly: false,
    active,
    loginPolls: 0,
    loginFail: null,
    pollFail: null,
    notes: {},
    settings: [{ key: "ai.backupModel", value: "" }],
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
      state.settings = [...state.settings.filter((s) => s.key !== body.key), { key: body.key, value: body.value }];
      return json(200, { ok: true });
    }
    if (p === "/api/skills") return json(200, { skills: [{ name: "weather", description: "Weather" }] });
    if (p === "/api/ai/providers") return json(200, providers());
    if (p === "/api/chat/models") return json(200, chatModels());
    if (p.startsWith("/api/ai/models/")) return json(200, { provider: id, models: MODELS[id] || [], defaultModel: state.cards[id]?.model, note: state.notes[id] ?? null });
    if (p.startsWith("/api/ai/verify/") && method === "POST") {
      const m = (MODELS[id] || []).find((x) => x.id === body?.model);
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
