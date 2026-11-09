// The composer's model list for every AI (GET /api/models, src/routes/models.js) and a chat's own pick
// (PUT /api/models/picker), design 4.11: one group per AI that is switched on and ready, the default AI first; each
// model with its name, effort levels, context and whether it sees images; "Replies appear a message at a time" on the
// models Codex runs; OpenRouter in Recommended, Verified by you and All models, the last not pickable until verified;
// a pick saved as session.<conv>.provider/model/effort with the effort clamped to the levels the model has.
// No real key is used anywhere: the AIs' readiness comes from a fake status source.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-models-route-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const { setCatalogModels } = await import("../src/ai/provider-registry.js");
const catalog = await import("../src/lib/model-catalog.js");
const { createModelsRouter, createModelsHandlers } = await import("../src/routes/models.js");
const { MESSAGE_AT_A_TIME, VERIFY_FIRST } = await import("../src/lib/model-picker.js");

// Claude Code's catalog, as the CLI caches it (lib/model-catalog.js reads it).
const levels = (rec) => ({ type: "effort", effort_options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, name: id, ...(id === rec ? { badge: { message: "Recommended" } } : {}) })) });
const cm = (id, name, section, family) => ({ id, name, section, runtime: { family }, thinking: levels("medium") });
const CLAUDE_CATALOG = {
  models: [
    cm("claude-opus-5-5", "Opus 5.5", "main", "opus"),
    cm("claude-fable-5-1", "Fable 5.1", "main", "fable"),
    cm("claude-sonnet-5-5", "Sonnet 5.5", "main", "sonnet"),
    cm("claude-haiku-5-5", "Haiku 5.5", "main", "haiku"),
    cm("claude-opus-4-7", "Opus 4.7", "overflow", "opus"),
  ],
};

// OpenRouter's public list as lib/openrouter-catalog.js hands it to the registry (reasoning read as effort levels).
const OPENROUTER = [
  { id: "anthropic/claude-sonnet-5.5", label: "Anthropic: Claude Sonnet 5.5", vendor: "anthropic", context: 1_000_000, efforts: ["low", "medium", "high", "xhigh", "max"], vision: true, price: { in: 3, out: 15 } },
  { id: "deepseek/deepseek-chat:free", label: "DeepSeek: DeepSeek Chat (free)", vendor: "deepseek", context: 163_840, vision: false, price: { in: 0, out: 0 }, free: true },
  { id: "qwen/qwen3-coder", label: "Qwen: Qwen3 Coder", vendor: "qwen", context: 262_144, efforts: ["low", "medium", "high"], vision: false, price: { in: 0.2, out: 0.8 } },
  { id: "openai/gpt-6-luna", label: "OpenAI: GPT-6 Luna", vendor: "openai", context: 400_000, efforts: ["low", "medium", "high"], vision: true, price: { in: 0.25, out: 2 } },
];

/** Each AI's readiness, as providerStatus() reports it; tests change it. */
const STATES = { claude: "ready", anthropic: "needs-key", chatgpt: "ready", openai: "needs-key", openrouter: "ready", deepseek: "ready", local: "needs-setup" };
const statusFor = (id) => ({ state: STATES[id], detail: `${id} is ${STATES[id]}`, fix: `Fix ${id} in Settings > AI.` });

let chatgptList = [];
let chatgptAsked = 0;
const listChatgptModels = async () => { chatgptAsked++; return chatgptList; };

let db, settings, convs, server, base, convId;

before(async () => {
  db = initDb(path.join(tmp, "models.db"));
  settings = new SettingsStore(db);
  convs = new ConversationStore(db);
  convId = convs.create({ title: "picker" }).id;
  catalog.__setForTests({ catalogDirs: [path.join(tmp, "none")], cli: { bin: "/x", catalog: { issuedAt: 1, config: CLAUDE_CATALOG } } });
  setCatalogModels("openrouter", OPENROUTER);
  settings.set("ai.openrouter.verified", { "qwen/qwen3-coder": { engine: "codex", at: "2026-11-01T00:00:00Z", engineVersion: "0.167.0", efforts: ["low", "high"] } });
  const app = express();
  app.set("db", db);
  app.use(express.json());
  const deps = { isShipped: () => true, statusFor, env: {}, listChatgptModels };
  app.use("/api/models", createModelsRouter(deps));
  // The old addresses, pointed at the same handlers (the integrator mounts them in routes/chat.js).
  const h = createModelsHandlers(deps);
  app.get("/api/chat/models", h.list);
  app.get("/api/chat/conversations/:id/picker", h.getPick);
  app.put("/api/chat/conversations/:id/picker", h.putPick);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  catalog.__setForTests({ catalogDirs: null, cli: null });
  setCatalogModels("openrouter", []);
  setCatalogModels("chatgpt-models", []);
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const getJson = async (p) => (await fetch(`${base}${p}`)).json();
const put = (body, p = "/api/models/picker") => fetch(`${base}${p}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const group = (list, id) => list.groups.find((g) => g.provider === id);
const entries = (g) => g.sections.flatMap((s) => s.entries);
const section = (g, id) => g.sections.find((s) => s.id === id);

describe("GET /api/models: one group per ready AI", () => {
  it("only AIs that are switched on and ready, the default first; the others say what to do", async () => {
    const list = await getJson("/api/models");
    assert.deepEqual(list.groups.map((g) => g.provider), ["claude", "chatgpt", "openrouter", "deepseek"]);
    assert.equal(list.groups[0].default, true);
    assert.deepEqual(list.unavailable.map((u) => u.provider), ["anthropic", "openai", "local"]);
    assert.equal(list.unavailable[0].fix, "Fix anthropic in Settings > AI.");
    assert.equal(list.unavailable[0].label, "Anthropic API key");
    assert.deepEqual(list.defaults, { provider: "claude", model: "sonnet", effort: "medium", ref: "claude:sonnet" });

    settings.set("ai.activeProvider", "deepseek");
    try {
      const again = await getJson("/api/models");
      assert.deepEqual(again.groups.map((g) => g.provider), ["deepseek", "claude", "chatgpt", "openrouter"]);
      assert.equal(again.defaults.provider, "deepseek");
      assert.equal(again.defaults.model, "deepseek-flash");
    } finally { settings.delete("ai.activeProvider"); }
  });

  it("Railway variables only: TARSEE_AI_PROVIDER and TARSEE_AI_MODEL are the defaults, a ref for another AI is not", async () => {
    const defaultsWith = async (env) => {
      const app = express();
      app.set("db", db);
      app.use("/api/models", createModelsRouter({ isShipped: () => true, statusFor, env }));
      const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
      try { return (await (await fetch(`http://127.0.0.1:${s.address().port}/api/models`)).json()).defaults; } finally { s.close(); }
    };
    assert.deepEqual(await defaultsWith({ TARSEE_AI_PROVIDER: "deepseek", TARSEE_AI_MODEL: "deepseek-v4-pro" }),
      { provider: "deepseek", model: "deepseek-v4-pro", effort: "medium", ref: "deepseek:deepseek-v4-pro" });
    assert.equal((await defaultsWith({ TARSEE_AI_PROVIDER: "deepseek", TARSEE_AI_MODEL: "deepseek:deepseek-v4-pro" })).model, "deepseek-v4-pro");
    assert.equal((await defaultsWith({ TARSEE_AI_PROVIDER: "deepseek", TARSEE_AI_MODEL: "chatgpt:gpt-6-luna" })).model, "deepseek-flash");
    assert.equal((await defaultsWith({ TARSEE_AI_MODEL: "opus" })).model, "opus", "the Claude plan, the default with no provider named");
  });

  it("an AI that is not switched on in this version is never listed", async () => {
    const app = express();
    app.set("db", db);
    app.use("/api/models", createModelsRouter({ isShipped: (id) => id === "claude", statusFor, env: {} }));
    const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
    try {
      const list = await (await fetch(`http://127.0.0.1:${s.address().port}/api/models`)).json();
      assert.deepEqual(list.groups.map((g) => g.provider), ["claude"]);
      assert.deepEqual(list.unavailable, []);
    } finally { s.close(); }
  });

  it("readiness: the registry's own status by default, or a source put in its place", async () => {
    const serve = async (deps, fn) => {
      const app = express();
      app.set("db", db);
      app.use("/api/models", createModelsRouter(deps));
      const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
      try { return await fn(`http://127.0.0.1:${s.address().port}/api/models`); } finally { s.close(); }
    };
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      // No status source given: ai/provider-status.js answers. DeepSeek has no key anywhere.
      await serve({ isShipped: (id) => id === "claude" || id === "deepseek", env: {} }, async (url) => {
        const list = await (await fetch(url)).json();
        const ds = list.unavailable.find((u) => u.provider === "deepseek");
        assert.equal(ds?.state, "needs-key");
        assert.ok(ds.fix, "with what to do about it");
        assert.ok(!list.groups.some((g) => g.provider === "deepseek"));
      });
      catalog.setProviderStatusSource((id) => ({ state: id === "deepseek" ? "ready" : "needs-sign-in", fix: "Sign in." }));
      await serve({ isShipped: (id) => id === "claude" || id === "deepseek", env: {} }, async (url) => {
        const list = await (await fetch(url)).json();
        assert.deepEqual(list.groups.map((g) => g.provider), ["deepseek"]);
        assert.equal(list.unavailable[0].fix, "Sign in.");
      });
    } finally {
      catalog.setProviderStatusSource(null);
      if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
    }
  });

  it("every model has its name, levels, context and whether it sees images", async () => {
    const ds = group(await getJson("/api/models"), "deepseek");
    const [flash, pro] = entries(ds);
    assert.equal(flash.name, "DeepSeek Flash");
    assert.equal(flash.ref, "deepseek:deepseek-flash");
    assert.deepEqual(flash.efforts.map((e) => e.id), ["low", "high", "max"]);
    assert.equal(flash.context, 1_000_000);
    assert.equal(flash.contextLabel, "1M");
    assert.equal(flash.vision, true);
    assert.equal(pro.name, "DeepSeek Pro");
    assert.equal(pro.vision, false, "DeepSeek Pro can't see images");
    assert.equal(flash.streaming, true, "DeepSeek runs on Claude Code: word by word");
    assert.equal(flash.note, null);
    assert.equal(flash.selectable, true);
  });

  it("the badges: Plan on the plans, an estimated cost tier on metered models, Free where it is free", async () => {
    const list = await getJson("/api/models");
    const texts = (e) => e.badges.map((b) => b.text);
    assert.ok(texts(entries(group(list, "claude"))[0]).includes("Plan"));
    const [flash, pro] = entries(group(list, "deepseek"));
    assert.deepEqual(texts(flash), ["$"]);
    assert.deepEqual(texts(pro), ["$$"]);
    assert.match(flash.badges[0].title, /est\./);
    assert.match(flash.priceHint, /^\$0\.30 in · \$1\.20 out per million tokens, est\. Half price outside peak hours\.$/);
    const free = entries(group(list, "openrouter")).find((e) => e.id === "deepseek/deepseek-chat:free");
    assert.ok(texts(free).includes("Free"));
  });

  it("the Claude plan is Claude Code's own list, and the old shape is still there for the Settings page", async () => {
    const list = await getJson("/api/models");
    const cl = group(list, "claude");
    assert.deepEqual(section(cl, "main").entries.map((e) => e.name), ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
    assert.deepEqual(section(cl, "more").entries.map((e) => e.name), ["Opus 4.7"]);
    assert.equal(section(cl, "more").collapsed, true);
    assert.equal(section(cl, "main").entries[0].ref, "claude:claude-opus-5-5");
    assert.equal(section(cl, "main").entries[3].contextLabel, "1M");
    assert.ok(Array.isArray(list.models) && list.models.length > 0, "the Claude table for Settings");
    assert.deepEqual(list.picker.main.map((e) => e.name), ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
    assert.deepEqual(list.picker.groups.map((g) => g.provider), list.groups.map((g) => g.provider));
    const old = await getJson("/api/chat/models");
    assert.deepEqual(old.picker.main.map((e) => e.name), list.picker.main.map((e) => e.name));
  });
});

describe("GET /api/models: ChatGPT and OpenRouter", () => {
  it("ChatGPT lists only what the signed-in account can use, and says replies come a message at a time", async () => {
    chatgptList = [{ id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["low", "medium", "high"], default: true }];
    catalog.__setForTests({ chatgptListAt: 0 });
    const list = await getJson("/api/models");
    const cg = group(list, "chatgpt");
    assert.ok(chatgptAsked > 0, "the account's list was asked for");
    assert.deepEqual(entries(cg).map((e) => e.id), ["gpt-6-luna"]);
    const luna = entries(cg)[0];
    assert.equal(luna.streaming, false);
    assert.equal(luna.note?.text, MESSAGE_AT_A_TIME);
    assert.ok(luna.badges.some((b) => b.text === "Plan"));
    assert.deepEqual(luna.efforts.map((e) => e.id), ["low", "medium", "high"]);
    setCatalogModels("chatgpt-models", []);
  });

  it("with no list from the account, ChatGPT offers its own default and names no model", async () => {
    chatgptList = [];
    catalog.__setForTests({ chatgptListAt: 0 });
    const cg = group(await getJson("/api/models"), "chatgpt");
    const only = entries(cg);
    assert.equal(only.length, 1);
    assert.equal(only[0].id, "");
    assert.equal(only[0].ref, "chatgpt:");
    assert.match(only[0].name, /ChatGPT's default/);
    assert.equal(only[0].selectable, true);
  });

  it("OpenRouter: Recommended, Verified by you, All models; the rest can't be picked until verified", async () => {
    const or = group(await getJson("/api/models"), "openrouter");
    assert.deepEqual(or.sections.map((s) => s.label), ["Recommended", "Verified by you", "All models"]);
    assert.equal(or.searchable, true);
    const rec = section(or, "recommended").entries;
    assert.ok(rec.some((e) => e.id === "~anthropic/claude-sonnet-latest" && e.name === "Claude Sonnet (latest)"));
    assert.ok(rec.every((e) => e.selectable));
    const mine = section(or, "verified").entries;
    assert.deepEqual(mine.map((e) => e.id), ["qwen/qwen3-coder"]);
    assert.equal(mine[0].selectable, true);
    assert.deepEqual(mine[0].efforts.map((e) => e.id), ["low", "high"], "the levels that worked when it was verified");
    assert.equal(mine[0].note?.text, MESSAGE_AT_A_TIME, "verified on Codex");
    assert.ok(mine[0].badges.some((b) => b.text === "Verified"));
    const all = section(or, "all");
    assert.equal(all.collapsed, true);
    assert.deepEqual(all.entries.map((e) => e.id), ["anthropic/claude-sonnet-5.5", "deepseek/deepseek-chat:free", "openai/gpt-6-luna"]);
    // One rule with the turn layer (the registry's engineFor): Anthropic's models run on Claude Code and OpenAI's on
    // Codex through OpenRouter's own endpoints for them; any other maker's must be verified first.
    const [claudeRow, other, openaiRow] = all.entries;
    assert.equal(other.selectable, false, `${other.id} is not pickable before it is verified`);
    assert.equal(other.verify, true);
    assert.equal(other.note?.text, VERIFY_FIRST);
    for (const e of [claudeRow, openaiRow]) {
      assert.equal(e.selectable, true, `${e.id} runs on its maker's engine without a check`);
      assert.ok(!e.verify, e.id);
      assert.notEqual(e.note?.text, VERIFY_FIRST, e.id);
    }
    assert.equal(openaiRow.note?.text, MESSAGE_AT_A_TIME, "OpenAI's models run on Codex");
    assert.deepEqual(all.entries[0].efforts.map((e) => e.id), ["low", "medium", "high", "xhigh", "max"], "reasoning shown as levels");
    assert.deepEqual(all.entries[1].efforts, []);
  });
});

describe("GET /api/models: the OpenAI key", () => {
  it("the table's models the key can use, the owner's verified ids, and the key's other chat models under All models (Verify first)", async () => {
    STATES.openai = "ready";
    setCatalogModels("openai-models", ["gpt-6.1-sol", "gpt-6-luna", "gpt-7-mini", "o9-pro", "gpt-7-nano", "gpt-7-realtime", "gpt-7-image", "text-embedding-4", "gpt-7-transcribe", "dall-e-4"].map((id) => ({ id })));
    settings.set("ai.openai.verified", { "gpt-7-mini": { engine: "codex", at: "2026-11-08T00:00:00Z", engineVersion: "0.167.0", efforts: ["low", "medium"] } });
    try {
      const oa = group(await getJson("/api/models"), "openai");
      const main = section(oa, "main").entries;
      assert.deepEqual(main.map((e) => e.id), ["gpt-6.1-sol", "gpt-6-luna", "gpt-7-mini"]);
      assert.ok(main.every((e) => e.selectable));
      const mine = main.at(-1);
      assert.ok(mine.badges.some((b) => b.text === "Verified"));
      assert.deepEqual(mine.efforts.map((e) => e.id), ["low", "medium"], "the levels that worked when it was verified");
      const all = section(oa, "all");
      assert.equal(all.collapsed, true);
      assert.deepEqual(all.entries.map((e) => e.id), ["gpt-7-nano", "o9-pro"], "only chat models: no audio, realtime, image, search, embedding or transcription model");
      assert.ok(all.entries.every((e) => !e.selectable && e.verify && e.note?.text === VERIFY_FIRST));

      // /model and the background jobs take the verified one, and send the others to Verify.
      assert.deepEqual(catalog.checkModel("openai", "gpt-7-mini", settings), { ok: true, model: "gpt-7-mini" });
      const nano = catalog.checkModel("openai", "gpt-7-nano", settings);
      assert.equal(nano.ok, false);
      assert.equal(nano.verify, true);
      assert.ok(catalog.modelChoices("openai", settings).some((c) => c.id === "gpt-7-mini" && c.selectable));
    } finally {
      STATES.openai = "needs-key";
      setCatalogModels("openai-models", []);
      settings.delete("ai.openai.verified");
    }
  });
});

describe("PUT /api/models/picker: a chat's own AI, model and effort", () => {
  const stored = () => ({
    provider: settings.get(`session.${convId}.provider`),
    model: settings.get(`session.${convId}.model`),
    effort: settings.get(`session.${convId}.effort`),
  });

  it("saves the provider, the model and the effort, the effort clamped to the levels the model has", async () => {
    const r = await put({ conversationId: convId, provider: "deepseek", model: "deepseek-v4-pro", effort: "medium" });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(stored(), { provider: "deepseek", model: "deepseek-v4-pro", effort: "low" });
    assert.equal(body.provider, "deepseek");
    assert.equal(body.model, "deepseek:deepseek-v4-pro");
    assert.equal(body.modelId, "deepseek-v4-pro");
    assert.equal(body.effort, "low");
    assert.equal(body.warning, null);

    await put({ conversationId: convId, effort: "xhigh" });
    assert.equal(stored().effort, "high", "DeepSeek has no Extra: the nearest below");
  });

  it("a model ref names its provider; a model change keeps the effort when the new model has it", async () => {
    await put({ conversationId: convId, model: "claude:claude-opus-5-5" });
    assert.deepEqual(stored(), { provider: "claude", model: "claude-opus-5-5", effort: "high" });
    await put({ conversationId: convId, model: "deepseek:deepseek-flash" });
    assert.deepEqual(stored(), { provider: "deepseek", model: "deepseek-flash", effort: "high" });
    assert.equal((await put({ conversationId: convId, provider: "claude", model: "deepseek:deepseek-flash" })).status, 400, "two different AIs");
  });

  it("OpenRouter: a verified model can be picked, an unverified one is refused with what to do", async () => {
    const bad = await put({ conversationId: convId, provider: "openrouter", model: "deepseek/deepseek-chat:free" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Verify it in Settings > AI first/);
    const ok = await put({ conversationId: convId, provider: "openrouter", model: "qwen/qwen3-coder", effort: "medium" });
    assert.equal(ok.status, 200);
    assert.deepEqual(stored(), { provider: "openrouter", model: "qwen/qwen3-coder", effort: "low" });
    assert.equal((await put({ conversationId: convId, provider: "openrouter", model: "~anthropic/claude-opus-latest" })).status, 200);
  });

  it("an AI that isn't ready, unknown or not switched on is refused; so are unknown models and levels", async () => {
    const before = stored();
    const notReady = await put({ conversationId: convId, provider: "anthropic", model: "claude-opus-5-5" });
    assert.equal(notReady.status, 409);
    const nb = await notReady.json();
    assert.equal(nb.fix, "Fix anthropic in Settings > AI.");
    assert.match(nb.error, /Anthropic API key/);
    assert.equal((await put({ conversationId: convId, provider: "nope" })).status, 400);
    assert.equal((await put({ conversationId: convId, provider: "claude", model: "gpt-5" })).status, 400);
    assert.equal((await put({ conversationId: convId, provider: "deepseek", model: "deepseek-ultra" })).status, 400);
    assert.equal((await put({ conversationId: convId, effort: "turbo" })).status, 400);
    assert.equal((await put({ conversationId: "nope", provider: "claude" })).status, 404);
    assert.equal((await put({ provider: "claude" })).status, 400, "which chat?");
    assert.deepEqual(stored(), before, "nothing was changed");

    const app = express();
    app.set("db", db);
    app.use(express.json());
    app.use("/api/models", createModelsRouter({ isShipped: (id) => id === "claude", statusFor, env: {} }));
    const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
    try {
      const off = await fetch(`http://127.0.0.1:${s.address().port}/api/models/picker`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: convId, provider: "deepseek" }) });
      assert.equal(off.status, 400);
    } finally { s.close(); }
  });

  it("ChatGPT with no model list: the provider alone, Codex picks the model", async () => {
    setCatalogModels("chatgpt-models", []);
    const r = await put({ conversationId: convId, provider: "chatgpt", model: null });
    assert.equal(r.status, 200);
    assert.equal(stored().provider, "chatgpt");
    assert.equal(stored().model, null);
    assert.equal((await r.json()).model, "chatgpt:");
  });

  it("null goes back to the default; a bare model (the old picker) finds its AI, a tier word works on any AI", async () => {
    await put({ conversationId: convId, provider: null, model: null, effort: null });
    assert.deepEqual(stored(), { provider: null, model: null, effort: null });
    await put({ conversationId: convId, model: "claude-opus-4-7" });
    assert.deepEqual(stored(), { provider: "claude", model: "claude-opus-4-7", effort: null });
    settings.set("ai.activeProvider", "deepseek");
    try {
      await put({ conversationId: convId, provider: null, model: null });
      await put({ conversationId: convId, model: "opus" });
      assert.deepEqual(stored(), { provider: "deepseek", model: "deepseek-v4-pro", effort: null }, "opus on DeepSeek is its top model");
    } finally { settings.delete("ai.activeProvider"); }
  });

  it("GET says which AI the chat is on, and warns when that AI is no longer connected", async () => {
    await put({ conversationId: convId, provider: "deepseek", model: "deepseek-flash", effort: "high" });
    const ok = await getJson(`/api/models/picker?conversationId=${convId}`);
    assert.equal(ok.provider, "deepseek");
    assert.equal(ok.model, "deepseek:deepseek-flash");
    assert.equal(ok.effort, "high");
    assert.equal(ok.warning, null);
    assert.equal(ok.defaults.provider, "claude");
    STATES.deepseek = "needs-key";
    try {
      const warned = await getJson(`/api/models/picker?conversationId=${convId}`);
      assert.equal(warned.warning, "DeepSeek not connected, using default");
      STATES.deepseek = "blocked-keys-only";
      assert.equal((await getJson(`/api/models/picker?conversationId=${convId}`)).warning, "DeepSeek is off (API keys only), using default");
    } finally { STATES.deepseek = "ready"; }
    assert.equal((await fetch(`${base}/api/models/picker?conversationId=nope`)).status, 404);
  });

  it("the old chat addresses run the same handlers", async () => {
    const r = await put({ model: "claude:claude-sonnet-5-5", effort: "max" }, `/api/chat/conversations/${convId}/picker`);
    assert.equal(r.status, 200);
    assert.deepEqual(stored(), { provider: "claude", model: "claude-sonnet-5-5", effort: "max" });
    const pick = await getJson(`/api/chat/conversations/${convId}/picker`);
    assert.equal(pick.model, "claude:claude-sonnet-5-5");
    assert.equal((await fetch(`${base}/api/chat/conversations/nope/picker`)).status, 404);
  });
});
