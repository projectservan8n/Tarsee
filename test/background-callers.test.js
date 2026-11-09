// The unattended callers (lib/cron.js, lib/heartbeat.js, lib/boot-runner.js) on every AI. They hand their turn to the
// turn layer (ai/turn.js runTurn through lib/background-turn.js) and let it pick the AI: the default one, which
// activeProviderId names even when nothing was ever chosen in Settings (the Claude plan signed in through its Railway
// variable is ready). They used to ask the old settings.getActiveProvider(), which says "nothing" in that case, so a
// fresh Railway-only install skipped every heartbeat and failed every cron job with "No AI provider configured".
// Engines are scripted (test/fakes/fake-engine.js).
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-bg-callers-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
for (const name of ["TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_URL", "TARSEE_LOCAL_AI_KEY"]) {
  delete process.env[name];
}
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });
// The Claude plan, signed in through its Railway variable; nothing chosen in Settings.
process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-canary-claude-oauth-token";

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const { initLiveBus } = await import("../src/lib/live-bus.js");
const { registerEngine, configureTurns } = await import("../src/ai/turn.js");
const { createFakeEngine } = await import("./fakes/fake-engine.js");
const cron = await import("../src/lib/cron.js");
const heartbeat = await import("../src/lib/heartbeat.js");
const { runBootChecklist } = await import("../src/lib/boot-runner.js");
const { writeWorkspaceFile } = await import("../src/lib/workspace-files.js");
const { defaultAiReadiness } = await import("../src/lib/background-turn.js");
const { setCatalogModels } = await import("../src/ai/provider-registry.js");
const { forgetLocalModelsRead } = await import("../src/ai/provider-models.js");

const db = initDb(path.join(tmp, "tarsee.db"));
initLiveBus(db);
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);
const DEEPSEEK_KEY = "sk-testcanarydeepseek0000000000";

let engine;
let restore;
const answer = (text) => [{ type: "text", content: text }, { type: "done", stopReason: "end_turn" }];

before(() => {
  cron.initCron({ db, settingsStore: settings, convStore: convs });
  heartbeat.startHeartbeat({ db, settingsStore: settings, intervalMs: 24 * 60 * 60 * 1000 });
});
beforeEach(() => {
  for (const prefix of ["ai.", "session."]) for (const { key } of settings.getByPrefix(prefix)) settings.delete(key);
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
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("cron jobs", () => {
  it("run on the default AI with nothing chosen in Settings, and the reply is saved with the AI and model that ran", async () => {
    const conv = convs.create({ title: "web" }).id;
    settings.set("channel_conv.web:default", conv);
    const out = await cron.runCronJob({ id: "daily", prompt: "Check the weather" });
    assert.equal(out.error, undefined, JSON.stringify(out));
    assert.equal(engine.calls.length, 1, "the turn ran");
    assert.equal(engine.calls[0].target.provider, "claude");
    const saved = db.prepare("SELECT provider, model, content FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1").get(conv);
    assert.match(saved.content, /All good\./);
    assert.equal(saved.provider, "claude");
    assert.ok(saved.model, "the model that ran");
  });

  it("on another default AI: its background model, and the saved reply names that AI", async () => {
    settings.set("ai.activeProvider", "deepseek");
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    const conv = convs.create({ title: "web2" }).id;
    settings.set("channel_conv.web:other", conv);
    const out = await cron.runCronJob({ id: "ds", prompt: "hi", channel: "web:other" });
    assert.equal(out.error, undefined, JSON.stringify(out));
    assert.equal(engine.calls[0].target.provider, "deepseek");
    assert.equal(engine.calls[0].target.model, "deepseek-flash", "the cheap floor is DeepSeek's own background model");
    const saved = db.prepare("SELECT provider, model FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1").get(conv);
    assert.deepEqual({ ...saved }, { provider: "deepseek", model: "deepseek-flash" });
  });

  it("an AI that isn't set up fails the job with the turn layer's own words, never a second opinion of the cron's", async () => {
    settings.set("ai.activeProvider", "deepseek");
    const out = await cron.runCronJob({ id: "nokey", prompt: "hi" });
    assert.match(out.error, /DeepSeek/);
    assert.doesNotMatch(out.error, /No AI provider configured/);
    assert.equal(engine.calls.length, 0);
  });
});

describe("Local AI with only an address, after a restart (nothing has read its models yet)", () => {
  it("the heartbeat reads the server's models first and runs, instead of skipping as 'not set up'", async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "llama3.1:8b" }] }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      setCatalogModels("local-models", []);
      forgetLocalModelsRead();
      settings.set("ai.activeProvider", "local");
      settings.set("ai.local.baseUrl", `http://127.0.0.1:${server.address().port}/v1`);
      const readiness = await defaultAiReadiness(settings);
      assert.equal(readiness.ready, true, JSON.stringify(readiness));
      assert.deepEqual(requests, ["/v1/models"]);

      setCatalogModels("local-models", []);
      forgetLocalModelsRead();
      writeWorkspaceFile("HEARTBEAT.md", "# Heartbeat\n\n- Check the inbox and tell me about anything urgent.\n");
      const r = await heartbeat.runHeartbeat("test");
      assert.equal(r.skipped, false, JSON.stringify(r));
      assert.equal(engine.calls.at(-1).target.provider, "local");
      assert.equal(engine.calls.at(-1).target.model, "llama3.1:8b");
    } finally {
      setCatalogModels("local-models", []);
      forgetLocalModelsRead();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });
});

describe("the prompt's two parts (design 4.6 g)", () => {
  // Today's log is the prompt's volatile part: on Codex it goes with the message, so a new line in it doesn't start
  // the thread over. A caller that joins the two parts into one string puts it in the thread's instructions instead.
  const LOG_LINE = "test-canary daily log line";
  const assertParts = (call, what) => {
    assert.equal(typeof call.systemParts?.stable, "string", what);
    assert.match(call.systemParts.volatile, new RegExp(LOG_LINE), `${what}: today's log is in the volatile part`);
    assert.doesNotMatch(call.systemParts.stable, new RegExp(LOG_LINE), `${what}: and not in the stable part`);
  };
  beforeEach(() => {
    writeWorkspaceFile(`memory/${new Date().toISOString().slice(0, 10)}.md`, `- ${LOG_LINE}\n`);
  });
  after(() => {
    writeWorkspaceFile(`memory/${new Date().toISOString().slice(0, 10)}.md`, "");
  });

  it("a cron job, the heartbeat and the boot checklist pass them apart", async () => {
    const conv = convs.create({ title: "parts" }).id;
    settings.set("channel_conv.web:parts", conv);
    const out = await cron.runCronJob({ id: "parts", prompt: "hi", channel: "web:parts" });
    assert.equal(out.error, undefined, JSON.stringify(out));
    assertParts(engine.calls.at(-1), "cron");

    writeWorkspaceFile("HEARTBEAT.md", "# Heartbeat\n\n- Check the inbox and tell me about anything urgent.\n");
    const r = await heartbeat.runHeartbeat("test");
    assert.equal(r.skipped, false, JSON.stringify(r));
    assertParts(engine.calls.at(-1), "heartbeat");

    writeWorkspaceFile("BOOT.md", "# Boot\n\n- Say hello on Telegram.\n");
    const boot = await runBootChecklist({ db, settingsStore: settings });
    assert.equal(boot.skipped, false, JSON.stringify(boot));
    assertParts(engine.calls.at(-1), "boot");
  });
});

describe("the heartbeat and the boot checklist", () => {
  it("run on the default AI with nothing chosen in Settings", async () => {
    writeWorkspaceFile("HEARTBEAT.md", "# Heartbeat\n\n- Check the inbox and tell me about anything urgent.\n");
    const r = await heartbeat.runHeartbeat("test");
    assert.equal(r.skipped, false, JSON.stringify(r));
    assert.equal(engine.calls.length, 1);
    assert.equal(engine.calls[0].target.provider, "claude");
  });

  it("are skipped quietly, naming the AI and what to fix, while the default AI isn't ready", async () => {
    writeWorkspaceFile("HEARTBEAT.md", "# Heartbeat\n\n- Check the inbox and tell me about anything urgent.\n");
    settings.set("ai.activeProvider", "deepseek");
    const r = await heartbeat.runHeartbeat("test");
    assert.equal(r.skipped, true);
    assert.match(r.reason, /DeepSeek/);
    assert.doesNotMatch(r.reason, /No AI provider configured/);

    writeWorkspaceFile("BOOT.md", "# Boot\n\n- Say hello on Telegram.\n");
    const boot = await runBootChecklist({ db, settingsStore: settings });
    assert.equal(boot.skipped, true);
    assert.match(boot.reason, /DeepSeek/);
    assert.equal(engine.calls.length, 0, "no turn was started");
  });
});
