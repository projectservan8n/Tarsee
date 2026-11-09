// The model unattended work runs on (lib/background-turn.js resolveBackgroundModel, README "Background work"): the
// heartbeat.model, boot.model, cron.defaultModel and job.model settings (and a cron job's keyword tier) take a tier
// word (haiku/sonnet/opus), a model of the default AI, or a provider:model ref, on every AI. A name the default AI
// doesn't offer is logged and the cheap floor (the default AI's background model) runs instead: a typo never moves
// unattended work up to the interactive model. Engines are scripted (test/fakes/fake-engine.js).
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-bg-model-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
for (const name of ["TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_URL", "TARSEE_LOCAL_AI_KEY"]) {
  delete process.env[name];
}
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });
// The Claude plan, signed in through its Railway variable.
process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-canary-claude-oauth-token";

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const { initLiveBus } = await import("../src/lib/live-bus.js");
const { registerEngine, configureTurns } = await import("../src/ai/turn.js");
const { setCatalogModels } = await import("../src/ai/provider-registry.js");
const { tierOf } = await import("../src/config/constants.js");
const { createFakeEngine } = await import("./fakes/fake-engine.js");
const { resolveBackgroundModel } = await import("../src/lib/background-turn.js");
const cron = await import("../src/lib/cron.js");
const heartbeat = await import("../src/lib/heartbeat.js");
const { runBootChecklist } = await import("../src/lib/boot-runner.js");
const { writeWorkspaceFile } = await import("../src/lib/workspace-files.js");

const db = initDb(path.join(tmp, "tarsee.db"));
initLiveBus(db);
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);
const KEYS = { deepseek: "sk-testcanarydeepseek0000000000", openai: "sk-proj-testcanaryopenai00000000000" };

let engine;
let restore;
const answer = (text) => [{ type: "text", content: text }, { type: "done", stopReason: "end_turn" }];
const ran = () => engine.calls[0]?.target || null;

/** Capture console.warn while fn runs: the lines it wrote. */
async function warnings(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(" ")); };
  try { await fn(); } finally { console.warn = original; }
  return lines;
}

function useAi(id) {
  if (id === "claude") return;
  settings.set("ai.activeProvider", id);
  if (KEYS[id]) settings.set(`ai.${id}.apiKey`, KEYS[id]);
}

before(() => {
  cron.initCron({ db, settingsStore: settings, convStore: convs });
  heartbeat.startHeartbeat({ db, settingsStore: settings, intervalMs: 24 * 60 * 60 * 1000 });
  writeWorkspaceFile("HEARTBEAT.md", "# Heartbeat\n\n- Check the inbox and tell me about anything urgent.\n");
  writeWorkspaceFile("BOOT.md", "# Boot\n\n- Say hello.\n");
});
beforeEach(() => {
  for (const prefix of ["ai.", "session.", "heartbeat.", "boot.", "cron."]) for (const { key } of settings.getByPrefix(prefix)) settings.delete(key);
  setCatalogModels("local-models", []);
  restore?.();
  restore = configureTurns({ recordUsage: () => {}, grantMcp: async () => ({ url: "http://127.0.0.1:1/mcp", token: "t", revoke() {} }) });
  engine = createFakeEngine([answer("All good.")]);
  registerEngine("claude-code", engine);
  registerEngine("codex", engine);
});
after(() => {
  heartbeat.stopHeartbeat();
  restore?.();
  registerEngine("claude-code", null);
  registerEngine("codex", null);
  setCatalogModels("local-models", []);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("heartbeat.model on every default AI", () => {
  const cases = [
    { ai: "claude", model: "sonnet", check: (t) => assert.equal(tierOf(t.model), "sonnet", t.model) },
    { ai: "claude", model: "opus", check: (t) => assert.equal(tierOf(t.model), "opus", t.model) },
    { ai: "openai", model: "gpt-6.1-sol", check: (t) => assert.equal(t.model, "gpt-6.1-sol") },
    { ai: "openai", model: "gpt-6-astra", check: (t) => assert.equal(t.model, "gpt-6-astra") },
    { ai: "deepseek", model: "deepseek-v4-pro", check: (t) => assert.equal(t.model, "deepseek-v4-pro") },
    { ai: "deepseek", model: "opus", check: (t) => assert.equal(t.model, "deepseek-v4-pro", "a tier word maps through the AI's own tiers") },
  ];
  for (const c of cases) {
    it(`${c.model} on ${c.ai} runs ${c.model}`, async () => {
      useAi(c.ai);
      settings.set("heartbeat.model", c.model);
      const r = await heartbeat.runHeartbeat("test");
      assert.equal(r.skipped, false, JSON.stringify(r));
      assert.equal(engine.calls.length, 1);
      assert.equal(ran().provider, c.ai);
      c.check(ran());
    });
  }

  it("a name the default AI doesn't offer runs the background model, and says so in the log", async () => {
    useAi("openai");
    settings.set("heartbeat.model", "not-a-model");
    const lines = await warnings(() => heartbeat.runHeartbeat("test"));
    assert.equal(ran().provider, "openai");
    assert.equal(ran().model, "gpt-6-luna", "the cheap floor, never the interactive model");
    assert.ok(lines.some((l) => /not-a-model/.test(l)), lines.join("\n"));
  });

  it("nothing set: the default AI's background model", async () => {
    useAi("openai");
    await heartbeat.runHeartbeat("test");
    assert.equal(ran().model, "gpt-6-luna");
  });
});

describe("boot.model, cron.defaultModel and job.model", () => {
  it("boot.model names a model of the default AI", async () => {
    useAi("deepseek");
    settings.set("boot.model", "deepseek-v4-pro");
    const boot = await runBootChecklist({ db, settingsStore: settings });
    assert.notEqual(boot.skipped, true, JSON.stringify(boot));
    assert.equal(ran().provider, "deepseek");
    assert.equal(ran().model, "deepseek-v4-pro");
  });

  it("cron.defaultModel and job.model name models of the default AI", async () => {
    useAi("openai");
    settings.set("cron.defaultModel", "gpt-6.1-sol");
    let out = await cron.runCronJob({ id: "d1", prompt: "Check the weather" });
    assert.equal(out.error, undefined, JSON.stringify(out));
    assert.equal(ran().model, "gpt-6.1-sol");
    engine.calls.length = 0;
    out = await cron.runCronJob({ id: "d2", prompt: "Check the weather", model: "gpt-6-astra" });
    assert.equal(out.error, undefined, JSON.stringify(out));
    assert.equal(ran().model, "gpt-6-astra", "the job's own model wins");
  });

  it("a cron job's keyword tier runs that tier on the default Claude plan", async () => {
    const out = await cron.runCronJob({ id: "deploy", prompt: "Deploy the site and open a PR" });
    assert.equal(out.error, undefined, JSON.stringify(out));
    assert.equal(ran().provider, "claude");
    assert.equal(tierOf(ran().model), "sonnet", ran().model);
  });

  it("job.model as a provider:model ref is kept as it is", async () => {
    useAi("deepseek");
    const out = await cron.runCronJob({ id: "ref", prompt: "hi", model: "deepseek:deepseek-v4-pro" });
    assert.equal(out.error, undefined, JSON.stringify(out));
    assert.equal(ran().model, "deepseek-v4-pro");
  });
});

describe("runBackgroundTurn with a bare model name", () => {
  it("a model that is also the AI's interactive default still runs, not the background model", async () => {
    // A caller that hands runBackgroundTurn a bare name (not a provider:model ref): the turn layer used to drop a
    // name equal to the default AI's interactive model (a chat picker that sends it means "no choice of its own"),
    // so the background model ran instead of the one asked for.
    useAi("deepseek");
    settings.set("ai.deepseek.model", "deepseek-v4-pro");
    const { runBackgroundTurn } = await import("../src/lib/background-turn.js");
    const out = await runBackgroundTurn({ label: "test", messages: [{ role: "user", content: "hi" }], systemPrompt: "x", toolCtx: { db, settingsStore: settings, conversationId: null }, model: "deepseek-v4-pro" });
    assert.equal(out.error, null, JSON.stringify(out));
    assert.equal(ran().provider, "deepseek");
    assert.equal(ran().model, "deepseek-v4-pro");
  });
});

describe("resolveBackgroundModel", () => {
  it("without a store: as before (Claude's names, refs, else the floor)", () => {
    assert.equal(resolveBackgroundModel(null), "haiku");
    assert.equal(resolveBackgroundModel("deepseek:deepseek-v4-pro"), "deepseek:deepseek-v4-pro");
    assert.equal(tierOf(resolveBackgroundModel("opus")), "opus");
  });

  it("the floor itself stays the floor, so the AI's own background model answers", () => {
    useAi("deepseek");
    assert.equal(resolveBackgroundModel(null, null, settings), "haiku");
    assert.equal(resolveBackgroundModel("haiku", null, settings), "haiku");
    assert.equal(resolveBackgroundModel("  ", null, settings), "haiku");
  });

  it("Local AI: the card's model and verified ones; one that needs Verify first is refused with a warning", async () => {
    useAi("local");
    settings.set("ai.local.baseUrl", "http://local-ai.test:11434/v1");
    settings.set("ai.local.model", "qwen3");
    settings.set("ai.local.verified", { llama3: { engine: "codex", at: "2026-11-09T00:00:00.000Z", efforts: [] } });
    setCatalogModels("local-models", [{ id: "qwen3" }, { id: "llama3" }, { id: "mistral" }]);
    assert.equal(resolveBackgroundModel("llama3", null, settings), "local:llama3");
    assert.equal(resolveBackgroundModel("qwen3", null, settings), "local:qwen3");
    let out;
    const lines = await warnings(() => { out = resolveBackgroundModel("mistral", null, settings); });
    assert.equal(out, "haiku");
    assert.ok(lines.some((l) => /mistral/.test(l) && /verif/i.test(l)), lines.join("\n"));
  });
});
