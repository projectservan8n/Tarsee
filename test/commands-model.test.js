// The chat commands that choose the AI (src/lib/commands.js), design 4.11 and Phase 4: /model takes a provider, a
// model, both, a provider-qualified ref, or a few letters of a model ("deepseek pro", "chatgpt", "flash"), lists the
// choices when a word fits more than one, and answers an AI that isn't ready with what to do about it; the old tier
// words ("haiku") work on every AI; /think and /effort only offer the levels the model has; /auto, /status and
// /version name the AI and model. Readiness comes from a fake status source: no real key is used.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-commands-model-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const { setCatalogModels, resolveModelFor, PROVIDERS } = await import("../src/ai/provider-registry.js");
const catalog = await import("../src/lib/model-catalog.js");
const { processCommand } = await import("../src/lib/commands.js");
const { matchModels, clampEffort, costTier, weekAverageFactor } = await import("../src/lib/model-picker.js");

const levels = () => ({ type: "effort", effort_options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, name: id })) });
const cm = (id, name, section, family) => ({ id, name, section, runtime: { family }, thinking: levels() });
const CLAUDE_CATALOG = {
  models: [
    cm("claude-opus-5-5", "Opus 5.5", "main", "opus"),
    cm("claude-sonnet-5-5", "Sonnet 5.5", "main", "sonnet"),
    cm("claude-haiku-5-5", "Haiku 5.5", "main", "haiku"),
    cm("claude-opus-4-6", "Opus 4.6", "overflow", "opus"),
  ],
};

const READY = { claude: "ready", anthropic: "needs-key", chatgpt: "ready", openai: "needs-key", openrouter: "ready", deepseek: "ready", local: "needs-setup" };
let STATES = { ...READY };
const statusFor = (id) => ({ state: STATES[id], detail: `${PROVIDERS[id].label} needs attention.`, fix: `Add it in Settings > AI (${id}).` });

let db, settings, convId;
const ai = { isShipped: () => true, statusFor, env: {}, listChatgptModels: async () => [] };
const run = async (text, extra = {}) => {
  const r = await processCommand(text, { settingsStore: settings, db, conversationId: convId, ai, ...extra });
  assert.equal(r.handled, true, `${text} is a command`);
  return String(r.response);
};

before(() => {
  db = initDb(path.join(tmp, "commands.db"));
  settings = new SettingsStore(db);
  convId = new ConversationStore(db).create({ title: "cmd" }).id;
  catalog.__setForTests({ catalogDirs: [path.join(tmp, "none")], cli: { bin: "/x", catalog: { issuedAt: 1, config: CLAUDE_CATALOG } } });
  setCatalogModels("chatgpt-models", [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["low", "medium", "high"], default: true },
  ]);
  setCatalogModels("openrouter", [
    { id: "deepseek/deepseek-chat:free", label: "DeepSeek: DeepSeek Chat (free)", vendor: "deepseek", free: true },
    { id: "qwen/qwen3-coder", label: "Qwen: Qwen3 Coder", vendor: "qwen", efforts: ["low", "medium", "high"] },
  ]);
  settings.set("ai.openrouter.verified", { "qwen/qwen3-coder": { engine: "codex", at: "2026-11-01T00:00:00Z", engineVersion: "0.167.0" } });
});

after(() => {
  catalog.__setForTests({ catalogDirs: null, cli: null });
  setCatalogModels("chatgpt-models", []);
  setCatalogModels("openrouter", []);
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  STATES = { ...READY };
  for (const k of ["ai.activeProvider", "ai.claude-code.model", "ai.deepseek.model", "ai.chatgpt.model", "ai.openai.model", "ai.openrouter.model", "ai.local.model", "ai.defaultEffort", "ai.autoRoute"]) settings.delete(k);
  for (const k of ["provider", "model", "effort"]) settings.delete(`session.${convId}.${k}`);
});

const active = () => settings.get("ai.activeProvider");

describe("/model: choosing the AI and the model", () => {
  it("/model deepseek pro: DeepSeek, its Pro model", async () => {
    const out = await run("/model deepseek pro");
    assert.equal(active(), "deepseek");
    assert.equal(settings.get("ai.deepseek.model"), "deepseek-v4-pro");
    assert.match(out, /DeepSeek Pro/);
  });

  it("/model chatgpt: the ChatGPT plan, on the model its account lists as the default", async () => {
    const out = await run("/model chatgpt");
    assert.equal(active(), "chatgpt");
    assert.match(out, /ChatGPT plan/);
    assert.match(out, /GPT-6 Luna/);
    assert.match(out, /a message at a time/i, "Codex replies come whole");
  });

  it("after a restart, before anything read the ChatGPT account's models, /model reads them first", async () => {
    // The account's list lives only in memory: after a restart it is empty until something reads it. /model used to
    // answer from the empty list ("No model matches") until someone opened the picker.
    const LIST = [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["low", "medium", "high"], default: true },
    ];
    const asked = [];
    const restarted = { ...ai, listChatgptModels: async (opts) => { asked.push(opts); return LIST; } };
    try {
      for (const [text, check] of [
        ["/model luna", (out) => { assert.equal(active(), "chatgpt"); assert.equal(settings.get("ai.chatgpt.model"), "gpt-6-luna"); assert.match(out, /GPT-6 Luna/); }],
        ["/model chatgpt", (out) => { assert.equal(active(), "chatgpt"); assert.match(out, /GPT-6 Luna/, "the account's default model is named"); }],
        ["/model", (out) => assert.match(out, /\*\*ChatGPT plan\*\*[^\n]*GPT-6 Luna/, "the overview lists the account's models")],
      ]) {
        setCatalogModels("chatgpt-models", []);
        catalog.__setForTests({ chatgptListAt: 0 });
        settings.delete("ai.activeProvider");
        settings.delete("ai.chatgpt.model");
        asked.length = 0;
        const r = await processCommand(text, { settingsStore: settings, db, conversationId: convId, ai: restarted });
        assert.equal(asked.length, 1, `${text}: the account's list was read`);
        check(String(r.response));
      }
    } finally {
      setCatalogModels("chatgpt-models", LIST);
    }
  });

  it("a few letters of a model find it on whichever ready AI has it", async () => {
    await run("/model chatgpt");
    const out = await run("/model flash");
    assert.equal(active(), "deepseek");
    assert.equal(settings.get("ai.deepseek.model"), "deepseek-flash");
    assert.match(out, /DeepSeek Flash/);
  });

  it("a word that fits more than one model lists the choices and changes nothing", async () => {
    const out = await run("/model gpt");
    assert.equal(active(), null);
    assert.match(out, /`\/model chatgpt:gpt-6\.1-sol`/);
    assert.match(out, /`\/model chatgpt:gpt-6-luna`/);
    assert.doesNotMatch(out, /openai:/, "the OpenAI key isn't ready, so its models aren't offered");
  });

  it("an AI that isn't ready answers with what to do, and nothing changes", async () => {
    for (const text of ["/model anthropic", "/model anthropic:claude-opus-5-5", "/model local llama3"]) {
      const out = await run(text);
      assert.match(out, /Add it in Settings > AI/, text);
      assert.equal(active(), null, text);
    }
  });

  it("a model only an AI that isn't ready has says which AI and what to do", async () => {
    STATES.deepseek = "needs-key";
    const out = await run("/model flash");
    assert.match(out, /DeepSeek/);
    assert.match(out, /Add it in Settings > AI \(deepseek\)/);
    assert.equal(active(), null);
  });

  it("a provider-qualified ref: OpenRouter's verified models only, the others must be verified first", async () => {
    const no = await run("/model openrouter:deepseek/deepseek-chat:free");
    assert.match(no, /Verify it in Settings > AI first/);
    assert.equal(active(), null);
    await run("/model openrouter:qwen/qwen3-coder");
    assert.equal(active(), "openrouter");
    assert.equal(settings.get("ai.openrouter.model"), "qwen/qwen3-coder");
    await run("/model openrouter qwen3");
    assert.equal(settings.get("ai.openrouter.model"), "qwen/qwen3-coder");
  });

  it("the old tier words work on every AI", async () => {
    STATES.openai = "ready";
    STATES.local = "ready";
    settings.set("ai.local.model", "llama3.1:8b");
    const expected = { claude: "haiku", deepseek: "deepseek-flash", chatgpt: "gpt-6-luna", openai: "gpt-6-luna", openrouter: "~anthropic/claude-haiku-latest", local: "llama3.1:8b" };
    for (const [id, want] of Object.entries(expected)) {
      await run(`/model ${id}`);
      await run("/model haiku");
      const sid = PROVIDERS[id].storageId;
      assert.equal(normalize(active()), id, `${id} is still the AI`);
      assert.equal(settings.get(`ai.${sid}.model`), want, `haiku on ${id}`);
      assert.equal(resolveModelFor(id, "haiku", settings), want);
      if (id !== "claude" && id !== "openrouter") assert.doesNotMatch(want, /^claude-/);
    }
    await run("/model deepseek opus");
    assert.equal(settings.get("ai.deepseek.model"), "deepseek-v4-pro");
  });

  it("Claude as before: a family word, a pinned version, a few letters", async () => {
    await run("/model opus");
    assert.equal(settings.get("ai.claude-code.model"), "opus");
    await run("/model opus 4.6");
    assert.equal(settings.get("ai.claude-code.model"), "claude-opus-4-6");
    assert.equal(normalize(active()), "claude");
    const out = await run("/model claude-sonnet-5-5");
    assert.equal(settings.get("ai.claude-code.model"), "claude-sonnet-5-5");
    assert.match(out, /Sonnet 5\.5/);
  });

  it("/model on its own names the default AI and model, what is ready and what isn't", async () => {
    settings.set("ai.activeProvider", "deepseek");
    const out = await run("/model");
    assert.match(out, /Default AI.*DeepSeek.*DeepSeek Flash/);
    for (const label of ["Claude plan", "ChatGPT plan", "OpenRouter"]) assert.match(out, new RegExp(label));
    assert.match(out, /Anthropic API key.*Add it in Settings > AI \(anthropic\)/);
    assert.match(out, /`\/model deepseek pro`/);
  });

  it("in a chat with a model of its own, /model moves that chat too", async () => {
    settings.set(`session.${convId}.provider`, "claude");
    settings.set(`session.${convId}.model`, "claude-opus-5-5");
    const shown = await run("/model");
    assert.match(shown, /This chat.*Opus 5\.5/);
    await run("/model deepseek");
    assert.equal(settings.get(`session.${convId}.provider`), null);
    assert.equal(settings.get(`session.${convId}.model`), null);
  });
});

describe("/think and /effort: the levels the model has", () => {
  it("DeepSeek has Low, High and Max: a missing level becomes the nearest below", async () => {
    settings.set("ai.activeProvider", "deepseek");
    const shown = await run("/think");
    assert.match(shown, /DeepSeek Flash/);
    assert.match(shown, /`\/think low`/);
    assert.match(shown, /`\/think max`/);
    assert.doesNotMatch(shown, /`\/think medium`/);
    assert.doesNotMatch(shown, /`\/think xhigh`/);
    const out = await run("/think medium");
    assert.equal(settings.get(`session.${convId}.effort`), "low");
    assert.match(out, /no Medium/);
    await run("/think xhigh");
    assert.equal(settings.get(`session.${convId}.effort`), "high");
  });

  it("the chat's own model decides; Claude has all five", async () => {
    settings.set("ai.activeProvider", "deepseek");
    settings.set(`session.${convId}.provider`, "claude");
    settings.set(`session.${convId}.model`, "claude-opus-5-5");
    assert.match(await run("/think"), /`\/think xhigh`/);
    await run("/think extra");
    assert.equal(settings.get(`session.${convId}.effort`), "xhigh");
  });

  it("with no chat, /think sets the default level", async () => {
    const r = await processCommand("/think high", { settingsStore: settings, db, conversationId: null, ai });
    assert.equal(settings.get("ai.defaultEffort"), "high");
    assert.match(r.response, /default/i);
    assert.match(String((await processCommand("/think", { settingsStore: settings, conversationId: null, ai })).response), /high \(the default\)/);
  });

  it("a model with no levels says so; unknown words are refused", async () => {
    settings.set("ai.activeProvider", "openrouter");
    settings.set("ai.openrouter.model", "qwen/qwen3-coder");
    assert.match(await run("/think high"), /no effort levels/i);
    assert.equal(settings.get(`session.${convId}.effort`), null);
    settings.set("ai.activeProvider", "claude-code");
    assert.match(await run("/think turbo"), /Unknown level/);
  });

  it("/effort opens the picker on the web and lists the levels anywhere else", async () => {
    assert.equal(await run("/effort", { platform: "web" }), "__OPEN_EFFORT_SLIDER__");
    assert.equal(await run("/effort"), "__OPEN_EFFORT_SLIDER__");
    assert.match(await run("/effort", { platform: "telegram" }), /`\/think low`/);
    await run("/effort high", { platform: "telegram" });
    assert.equal(settings.get(`session.${convId}.effort`), "high");
  });
});

describe("/clear on any AI", () => {
  it("drops the session handle and records when, so a handoff to a fresh session never brings the cleared messages back", async () => {
    const conv = new ConversationStore(db).create({ title: "to clear" }).id;
    // One message, so the answer carries its count note (the words that once said "claude session reset").
    new ConversationStore(db).addMessage(conv, { role: "user", content: "hi" });
    db.prepare("UPDATE conversations SET claude_session_id = ? WHERE id = ?").run("deepseek/cc/deepseek:raw-1", conv);
    const before = Date.now();
    const out = await run("/clear", { conversationId: conv, autoSummarize: false });
    assert.match(out, /Conversation cleared/);
    assert.match(out, /\(1 messages deleted, session reset\)/);
    assert.doesNotMatch(out, /claude/i, "the words name no engine");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(conv).n, 0);
    assert.equal(db.prepare("SELECT claude_session_id AS s FROM conversations WHERE id = ?").get(conv).s, null);
    const at = Date.parse(settings.get(`session.${conv}.clearedAt`));
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, "clearedAt is now");
  });

  it("records clearedAt even when the caller passes no settings store", async () => {
    const conv = new ConversationStore(db).create({ title: "no store" }).id;
    const before = Date.now();
    const r = await processCommand("/clear", { db, conversationId: conv, autoSummarize: false });
    assert.equal(r.handled, true);
    const at = Date.parse(settings.get(`session.${conv}.clearedAt`));
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, "clearedAt is now");
  });
});

describe("/auto, /status and /version name the AI and the model", () => {
  it("/auto on says what it picks on the default AI", async () => {
    settings.set("ai.activeProvider", "deepseek");
    const out = await run("/auto on");
    assert.equal(settings.get("ai.autoRoute"), true);
    assert.match(out, /DeepSeek Flash/);
    assert.match(out, /DeepSeek Pro/);
    assert.match(await run("/auto off"), /disabled/);
  });

  it("/status shows the AI, the model and the engines", async () => {
    settings.set("ai.activeProvider", "deepseek");
    const out = await run("/status");
    assert.match(out, /DeepSeek · DeepSeek Flash/);
    assert.match(out, /Claude Code \d+\.\d+\.\d+/);
    assert.match(out, /Codex \d+\.\d+\.\d+/);
  });

  it("/version shows Tarsee, the AI and both engines", async () => {
    settings.set("ai.activeProvider", "chatgpt");
    const out = await run("/version");
    assert.match(out, /\*\*Tarsee\*\* v\d+\.\d+\.\d+/);
    assert.match(out, /ChatGPT plan · GPT-6 Luna/);
    assert.match(out, /Claude Code \d+\.\d+\.\d+/);
    assert.match(out, /Codex \d+\.\d+\.\d+/);
    assert.match(out, /Node/);
  });
});

describe("the matching and clamping rules", () => {
  const C = [
    { provider: "chatgpt", id: "gpt-6-luna", name: "GPT-6 Luna", selectable: true },
    { provider: "openai", id: "gpt-6-luna", name: "GPT-6 Luna", selectable: true },
    { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash", selectable: true },
    { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek Pro", selectable: true },
  ];
  it("one model found on two AIs goes to the default AI; otherwise both are listed", () => {
    assert.deepEqual(matchModels(C, "luna", { preferProvider: "openai" }).matches.map((m) => m.provider), ["openai"]);
    assert.equal(matchModels(C, "luna", { preferProvider: "deepseek" }).matches.length, 2);
    assert.deepEqual(matchModels(C, "pro").matches.map((m) => m.id), ["deepseek-v4-pro"]);
    assert.deepEqual(matchModels(C, "DeepSeek Flash").matches.map((m) => m.id), ["deepseek-flash"]);
    assert.equal(matchModels(C, "zzz").matches.length, 0);
  });
  it("a level the model lacks: the nearest below, else its lowest; none when it has none", () => {
    assert.equal(clampEffort(["low", "high", "max"], "medium"), "low");
    assert.equal(clampEffort(["low", "high", "max"], "xhigh"), "high");
    assert.equal(clampEffort(["high", "max"], "low"), "high");
    assert.equal(clampEffort([], "high"), null);
    assert.equal(clampEffort(["low", "medium"], null), "medium", "nothing asked: the default, Medium");
  });
  it("a cost tier for a model with peak hours goes by its week-average price (DeepSeek: 35 peak hours, half price the rest)", () => {
    const peak = { days: [1, 2, 3, 4, 5], hoursUtc: [[1, 4], [6, 10]], offPeakFactor: 0.5 };
    assert.equal(weekAverageFactor(null), 1);
    assert.equal(weekAverageFactor(peak), 35 / 168 + (1 - 35 / 168) * 0.5);
    assert.equal(costTier({ in: 0.3, out: 1.2 }), "$$", "at the peak rate all week it would be $$");
    assert.equal(costTier({ in: 0.3, out: 1.2, peak }), "$");
    assert.equal(costTier({ in: 1.32, out: 3.96, peak }), "$$");
  });
});

function normalize(id) {
  return id === "claude-code" ? "claude" : id;
}
