// The engine-neutral turn layer (src/ai/turn.js, design 4.6): every channel's turn, on whichever AI the chat uses,
// goes through runTurn. It picks the provider, model and effort, refuses what can't run with a plain-language reason,
// resumes the chat's session or starts fresh with the recent conversation handed over, puts the turn on the live
// timeline, retries a session the engine couldn't resume, answers with the backup model when the AI can't, stops at
// the spend ceiling, and always ends with exactly one done. Engines are scripted here (test/fakes/fake-engine.js).
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import WebSocket from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-turn-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
for (const name of ["TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_URL", "TARSEE_LOCAL_AI_KEY"]) {
  delete process.env[name];
}
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });
// The Claude plan counts as signed in (provider-status.js reads the Railway variable), whatever this machine has.
process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-canary-claude-oauth-token";
const API_TOKEN = "test-canary-api-token-0000";
process.env.TARSEE_API_TOKEN = API_TOKEN;

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const live = await import("../src/lib/live-bus.js");
const { withConversationTurn, removeQueuedTurn } = await import("../src/lib/conversation-lock.js");
const turn = await import("../src/ai/turn.js");
const router = await import("../src/ai/router.js");
const { runBackgroundTurn } = await import("../src/lib/background-turn.js");
const { buildSystemPrompt, buildSystemPromptParts } = await import("../src/lib/build-system-prompt.js");
const { createFakeEngine } = await import("./fakes/fake-engine.js");
const { usageIndex } = await import("../src/lib/token-usage.js");

const { runTurn, stopTurns, registerEngine, configureTurns, QUEUED_NOTE, failureFlagKey } = turn;

const db = initDb(path.join(tmp, "tarsee.db"));
live.initLiveBus(db);
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);

const DEEPSEEK_KEY = "sk-testcanarydeepseek0000000000";
const OPENROUTER_KEY = "sk-or-v1-testcanaryopenrouter0000";
const OPENAI_KEY = "sk-proj-testcanaryopenai00000000000";

async function collect(gen) {
  const out = [];
  for await (const evt of gen) out.push(evt);
  return out;
}
const types = (events) => events.map((e) => e.type);
const doneOf = (events) => events.filter((e) => e.type === "done");
const textOf = (events) => events.filter((e) => e.type === "text").map((e) => e.content).join("");

function newChat(title = "chat") {
  return convs.create({ title }).id;
}
function ctxFor(conversationId) {
  return { db, settingsStore: settings, conversationId };
}
function say(conv, role, content, createdAt = null) {
  const m = convs.addMessage(conv, { role, content });
  if (createdAt) db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(createdAt, m.id);
  return m;
}
const user = (content) => ({ role: "user", content });
const ok = (text = "Done.") => [{ type: "text", content: text }, { type: "done", stopReason: "end_turn" }];
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

let restore = null;
const engines = {};
function useEngines({ claude = [ok()], codex = [ok()] } = {}) {
  engines.claude = createFakeEngine(claude);
  engines.codex = createFakeEngine(codex);
  registerEngine("claude-code", engines.claude);
  registerEngine("codex", engines.codex);
  return engines;
}

const SETTING_PREFIXES = ["ai.", "session."];
beforeEach(() => {
  for (const prefix of SETTING_PREFIXES) for (const { key } of settings.getByPrefix(prefix)) settings.delete(key);
  restore?.();
  restore = configureTurns({
    grantMcp: async () => ({ url: "http://127.0.0.1:1/mcp", token: "test-mcp-token", revoke() {} }),
    recordUsage: () => {},
  });
  useEngines();
});

after(() => {
  restore?.();
  registerEngine("claude-code", null);
  registerEngine("codex", null);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the router", () => {
  it("chatStream is runTurn: every option reaches the turn layer", () => {
    assert.equal(router.chatStream, runTurn);
  });
});

describe("a turn on the default AI", () => {
  it("route first, then the engine's events, exactly one done; the engine gets the target", async () => {
    useEngines({ claude: [[{ type: "session", id: "raw-1" }, { type: "text", content: "Hello" }, { type: "text", content: " there" },
      { type: "usage", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { type: "done", stopReason: "end_turn" }]] });
    const conv = newChat();
    let stored = null;
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(conv), sessionId: null, onSessionId: (h) => { stored = h; } }));
    assert.deepEqual(types(events), ["route", "text", "text", "usage", "done"]);
    const route = events[0];
    assert.equal(route.provider, "claude");
    assert.equal(route.engine, "claude-code");
    assert.ok(route.model, "a model is named");
    assert.ok(route.label, "and a label to show");
    assert.equal(textOf(events), "Hello there");
    assert.equal(doneOf(events)[0].stopReason, "end_turn");
    const call = engines.claude.calls[0];
    assert.equal(call.target.provider, "claude");
    assert.equal(call.target.providerId, "claude");
    assert.equal(call.target.engine, "claude-code");
    assert.equal(call.target.model, route.model);
    assert.equal(call.maxTurns, 50, "an interactive turn's ceiling");
    assert.equal(stored, "raw-1", "the Claude plan's session is stored bare, as every existing row");
  });

  it("the default provider comes from the registry: the setting, then TARSEE_AI_PROVIDER, then the Claude plan", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    process.env.TARSEE_AI_PROVIDER = "deepseek";
    try {
      const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
      assert.equal(events[0].provider, "deepseek");
      settings.set("ai.activeProvider", "claude-code");
      const again = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
      assert.equal(again[0].provider, "claude", "the stored claude-code is the Claude plan");
    } finally {
      delete process.env.TARSEE_AI_PROVIDER;
    }
  });

  it("thinking summaries: on for a turn from the dashboard, only where the model gives them", async () => {
    await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()), liveSource: "web" }));
    assert.equal(engines.claude.calls[0].thinkingSummaries, true);
    await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()), liveSource: "telegram" }));
    assert.equal(engines.claude.calls[1].thinkingSummaries, false);
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    await collect(runTurn({ provider: "deepseek", messages: [user("hi")], toolCtx: ctxFor(newChat()), liveSource: "web" }));
    assert.equal(engines.claude.calls[2].thinkingSummaries, false, "DeepSeek gives none");
  });

  it("the system prompt reaches the engine whole and in its two parts", async () => {
    await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()), systemPrompt: "SOUL" }));
    assert.equal(engines.claude.calls[0].systemPrompt, "SOUL");
    assert.deepEqual(engines.claude.calls[0].systemParts, { stable: "SOUL", volatile: "" });
    await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()), systemParts: { stable: "SOUL", volatile: "\n\n## Today's Log" } }));
    assert.equal(engines.claude.calls[1].systemPrompt, "SOUL\n\n## Today's Log");
  });
});

describe("the live timeline", () => {
  it("turn_start, the steps and turn_end, in order, carrying the provider; steps don't reach the caller", async () => {
    useEngines({ claude: [[
      { type: "session", id: "raw-live" },
      { type: "step", kind: "tool_start", id: "t1", name: "Bash", summary: "List files" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", id: "t1", ok: true, result: "a" },
      { type: "step", kind: "tool_end", id: "t1", ok: true },
      { type: "step", kind: "usage", input: 5, output: 1, cacheRead: 0, cacheWrite: 0, total: 6, calls: 1 },
      { type: "text", content: "Two files." },
      { type: "done", stopReason: "end_turn" },
    ]] });
    const conv = newChat();
    const events = await collect(runTurn({ messages: [user("ls")], toolCtx: ctxFor(conv), liveSource: "telegram" }));
    assert.ok(!events.some((e) => e.type === "step"));
    const timeline = live.eventsSince(conv, 0).filter((e) => e.type !== "message");
    assert.deepEqual(timeline.map((e) => e.type === "step" ? `step:${e.payload.kind}` : e.type),
      ["turn_start", "step:tool_start", "step:tool_end", "step:usage", "turn_end"]);
    const [start] = timeline;
    const end = timeline.at(-1);
    assert.equal(start.payload.provider, "claude");
    assert.equal(start.payload.engine, "claude-code");
    assert.ok(start.payload.label);
    assert.equal(start.payload.source, "telegram");
    assert.equal(start.payload.streaming, true, "the live view's Codex note is off for an engine that streams");
    assert.equal(end.payload.provider, "claude");
    assert.equal(end.payload.engine, "claude-code");
    assert.equal(end.payload.stopReason, "end_turn");
    assert.equal(end.payload.sessionId, "raw-live", "the raw id, as token-usage.js reads it");
    assert.ok(timeline.every((e) => e.turnId === start.turnId));
  });

  it("Stop from another source (the dashboard) stops a turn another channel started", async () => {
    useEngines({ claude: [[{ type: "text", content: "Working on it" }, { type: "wait" }]] });
    const conv = newChat();
    const run = collect(runTurn({ messages: [user("long job")], toolCtx: ctxFor(conv), liveSource: "discord" }));
    assert.ok(await until(() => engines.claude.calls.length === 1));
    assert.equal(stopTurns(conv), 1);
    const events = await run;
    assert.equal(doneOf(events).length, 1);
    assert.equal(doneOf(events)[0].stopReason, "aborted");
    assert.ok(!events.some((e) => e.type === "error"), "a stop is not a failure");
    assert.equal(textOf(events), "Working on it", "what it said before is kept");
    assert.equal(stopTurns(conv), 0, "nothing left running");
  });

  it("a turn kept off the timeline publishes nothing", async () => {
    const conv = newChat();
    await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(conv), liveDisabled: true }));
    assert.equal(live.eventsSince(conv, 0).filter((e) => e.type !== "message").length, 0);
  });
});

describe("the queued note", () => {
  it("goes on a prompt that waited, once, and never on a slash command", async () => {
    let open;
    const gate = new Promise((r) => { open = r; });
    useEngines({ claude: [async () => { await gate; return ok("first"); }, ok("next")] });
    const conv = newChat();
    const ask = (text) => withConversationTurn(conv, () => collect(runTurn({ messages: [user(text)], toolCtx: ctxFor(conv) })), { live: { source: "web", prompt: text } });
    const a = ask("first");
    const b = ask("and May?");
    const c = ask("/compact");
    assert.ok(await until(() => engines.claude.calls.length === 1));
    open();
    await Promise.all([a, b, c]);
    const prompts = engines.claude.calls.map((cl) => cl.prompt);
    assert.equal(prompts[0], "first");
    assert.equal(prompts[1], QUEUED_NOTE + "and May?");
    assert.equal(prompts[2], "/compact");
    assert.ok(engines.claude.calls.every((cl) => cl.queuedNote === false), "the engine is told not to add it again");
  });
});

describe("sessions and the handoff", () => {
  it("a foreign handle starts fresh with the recent conversation handed over, and the new id is stored tagged", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    const conv = newChat();
    settings.set(`session.${conv}.provider`, "deepseek");
    say(conv, "user", "Plan the offsite in March", "2020-01-01 09:00:00");
    say(conv, "assistant", "Sure: Lisbon, three days.", "2020-01-01 09:00:05");
    const prompt = say(conv, "user", "and the budget?");
    useEngines({ claude: [[{ type: "session", id: "ds-raw-2" }, ...ok("About 4k.")]] });
    let stored = null;
    const messages = convs.getRecentMessages(conv, 20).map((m) => ({ role: m.role, content: m.content }));
    assert.equal(messages.at(-1).content, prompt.content);
    await collect(runTurn({ messages, toolCtx: ctxFor(conv), sessionId: "raw-claude-1", onSessionId: (h) => { stored = h; } }));
    const call = engines.claude.calls[0];
    assert.equal(call.target.provider, "deepseek");
    assert.equal(call.sessionId, null, "the Claude plan's session is not DeepSeek's");
    assert.equal(call.sessionHandle, null);
    assert.match(call.prompt, /^<recent-conversation>/);
    assert.match(call.prompt, /Plan the offsite in March/);
    assert.match(call.prompt, /Lisbon, three days/);
    assert.ok(call.prompt.endsWith("and the budget?"), "the prompt itself comes last, once");
    assert.equal(call.prompt.match(/and the budget\?/g).length, 1);
    assert.equal(stored, "deepseek/cc/deepseek:ds-raw-2");

    // The next turn resumes it, with no handoff.
    await collect(runTurn({ messages: [user("thanks")], toolCtx: ctxFor(conv), sessionId: stored }));
    assert.equal(engines.claude.calls[1].sessionId, "ds-raw-2");
    assert.equal(engines.claude.calls[1].sessionHandle, stored);
    assert.equal(engines.claude.calls[1].prompt, "thanks");
  });

  it("the handoff is capped (ai.handoffChars) and leaves out what was cleared (session.<conv>.clearedAt)", async () => {
    const conv = newChat();
    say(conv, "user", "SECRET from before the reset", "2020-01-01 08:00:00");
    say(conv, "assistant", "noted", "2020-01-01 08:00:01");
    settings.set(`session.${conv}.clearedAt`, "2020-01-01T08:30:00.000Z");
    say(conv, "user", "after the reset " + "x".repeat(2000), "2020-01-01 09:00:00");
    say(conv, "assistant", "NEWEST answer", "2020-01-01 09:00:05");
    say(conv, "user", "go on");
    settings.set("ai.handoffChars", 400);
    await collect(runTurn({ messages: [user("go on")], toolCtx: ctxFor(conv), sessionId: null }));
    const p = engines.claude.calls[0].prompt;
    assert.doesNotMatch(p, /SECRET/);
    assert.match(p, /NEWEST answer/);
    const block = p.slice(0, p.indexOf("</recent-conversation>"));
    assert.ok(block.length < 400 + 250, `capped: ${block.length}`);
  });

  it("a Claude Code transcript over its cap starts fresh, with the handoff", async () => {
    restore();
    restore = configureTurns({ transcriptOverCap: (rawId, provider) => rawId === "raw-huge" && provider === "claude" });
    const conv = newChat();
    say(conv, "user", "the long project");
    say(conv, "assistant", "many steps later");
    await collect(runTurn({ messages: [user("next step")], toolCtx: ctxFor(conv), sessionId: "raw-huge" }));
    assert.equal(engines.claude.calls[0].sessionId, null);
    assert.match(engines.claude.calls[0].prompt, /^<recent-conversation>[\s\S]*many steps later[\s\S]*next step$/);
    await collect(runTurn({ messages: [user("and on")], toolCtx: ctxFor(conv), sessionId: "raw-small" }));
    assert.equal(engines.claude.calls[1].sessionId, "raw-small");
  });

  it("0 characters turns the handoff off; a chat with no history gets none", async () => {
    const conv = newChat();
    say(conv, "user", "earlier");
    say(conv, "assistant", "earlier answer");
    say(conv, "user", "now");
    settings.set("ai.handoffChars", 0);
    await collect(runTurn({ messages: [user("now")], toolCtx: ctxFor(conv) }));
    assert.equal(engines.claude.calls[0].prompt, "now");
    settings.delete("ai.handoffChars");
    const empty = newChat();
    say(empty, "user", "first ever");
    await collect(runTurn({ messages: [user("first ever")], toolCtx: ctxFor(empty) }));
    assert.equal(engines.claude.calls[1].prompt, "first ever");
  });

  it("without a conversation, the caller's own messages are the history", async () => {
    await collect(runTurn({ messages: [user("my name is Sam"), { role: "assistant", content: "Hi Sam" }, user("what's my name?")], toolCtx: { db, settingsStore: settings, conversationId: null } }));
    const p = engines.claude.calls[0].prompt;
    assert.match(p, /my name is Sam/);
    assert.ok(p.endsWith("what's my name?"));
  });

  it("no handoff in front of a slash command", async () => {
    const conv = newChat();
    say(conv, "user", "earlier");
    say(conv, "assistant", "answer");
    await collect(runTurn({ messages: [user("/compact")], toolCtx: ctxFor(conv) }));
    assert.equal(engines.claude.calls[0].prompt, "/compact");
  });

  it("content blocks: the handoff and note go in front of the words, the pictures stay", async () => {
    const conv = newChat();
    say(conv, "user", "earlier");
    say(conv, "assistant", "answer");
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("png").toString("base64") } };
    await collect(runTurn({ messages: [{ role: "user", content: [img, { type: "text", text: "what is this?" }] }], toolCtx: ctxFor(conv) }));
    const sent = engines.claude.calls[0].messages.at(-1).content;
    assert.equal(sent[0].type, "image");
    assert.match(sent[1].text, /^<recent-conversation>[\s\S]*what is this\?$/);
    assert.deepEqual(engines.claude.calls[0].media.map((b) => b.type), ["image"]);
  });
});

describe("which provider, model and effort", () => {
  it("a chat's own provider, model and effort apply on every channel; the default a channel passes is not a choice", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    const conv = newChat();
    settings.set(`session.${conv}.provider`, "deepseek");
    settings.set(`session.${conv}.model`, "deepseek-v4-pro");
    settings.set(`session.${conv}.effort`, "max");
    const events = await collect(runTurn({ provider: "claude-code", model: "sonnet", messages: [user("hi")], toolCtx: ctxFor(conv) }));
    assert.equal(events[0].provider, "deepseek");
    assert.equal(events[0].model, "deepseek-v4-pro");
    assert.equal(events[0].effort, "max");
    assert.equal(events[0].label, "DeepSeek Pro");
  });

  it("effort is clamped to what the model takes", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    const conv = newChat();
    settings.set(`session.${conv}.provider`, "deepseek");
    settings.set(`session.${conv}.effort`, "xhigh");
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(conv) }));
    assert.equal(events[0].effort, "high", "DeepSeek has low, high and max: xhigh steps down");
    const medium = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()), provider: "deepseek", effort: "medium" }));
    assert.equal(medium[0].effort, "low");
    const claude = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()), effort: "xhigh" }));
    assert.equal(claude[0].effort, "xhigh");
    const unset = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(unset[0].effort, "medium", "a chat with no effort of its own runs at Medium");
  });

  it("a ref names provider and model at once; a caller's own model is kept", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    const conv = newChat();
    settings.set(`session.${conv}.model`, "claude-opus-4-8");
    const ref = await collect(runTurn({ model: "deepseek:deepseek-flash", messages: [user("hi")], toolCtx: ctxFor(conv) }));
    assert.equal(ref[0].provider, "deepseek");
    assert.equal(ref[0].model, "deepseek-flash");
    const own = await collect(runTurn({ model: "haiku", messages: [user("hi")], toolCtx: ctxFor(conv) }));
    assert.equal(own[0].provider, "claude");
    assert.match(own[0].model, /haiku/, "a model chosen on purpose stays");
    const chats = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(conv) }));
    assert.equal(chats[0].model, "claude-opus-4-8", "the chat's own Claude pick (stored before providers existed)");
  });

  it("a chat's pick for an AI that isn't connected falls back to the default, not to an error", async () => {
    const conv = newChat();
    settings.set(`session.${conv}.provider`, "deepseek");
    settings.set(`session.${conv}.model`, "deepseek-v4-pro");
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(conv) }));
    assert.equal(events[0].provider, "claude");
    assert.doesNotMatch(events[0].model, /deepseek/, "its model belongs to DeepSeek, so it is not used");
  });

  it("a pick stored before providers existed (a bare Claude model) still runs once the Anthropic key is the default, which has the same models", async () => {
    settings.set("ai.anthropic.apiKey", "sk-ant-api03-test-canary-turn-legacy-0000");
    settings.set("ai.activeProvider", "anthropic");
    const conv = newChat();
    settings.set(`session.${conv}.model`, "haiku");
    settings.set(`session.${conv}.effort`, "low");
    const tier = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(conv) }));
    assert.equal(tier[0].provider, "anthropic");
    assert.match(tier[0].model, /haiku/, "the composer shows Haiku for this chat, so Haiku runs");
    assert.equal(tier[0].effort, "low");
    settings.set(`session.${conv}.model`, "claude-sonnet-4-6");
    const pinned = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(conv) }));
    assert.equal(pinned[0].model, "claude-sonnet-4-6");
    // An AI without Claude's models doesn't take it: its tier would be another model than the one picked.
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    settings.set("ai.activeProvider", "deepseek");
    settings.set(`session.${conv}.model`, "haiku");
    const other = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(conv) }));
    assert.equal(other[0].provider, "deepseek");
    assert.equal(other[0].model, (await turn.resolveTarget({}, settings)).target.model, "DeepSeek's default, not its haiku tier");
    // A pick made for the Claude plan on purpose (its provider stored) stays the plan's.
    settings.set("ai.activeProvider", "anthropic");
    settings.set(`session.${conv}.provider`, "claude");
    settings.set(`session.${conv}.model`, "haiku");
    const plan = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(conv) }));
    assert.equal(plan[0].provider, "claude", "the plan is signed in here, so the chat's own AI runs");
    assert.match(plan[0].model, /haiku/);
  });

  it("a claude-* or tier model on another provider maps through its tiers; background work uses the background model", async () => {
    settings.set("ai.activeProvider", "deepseek");
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    const opus = await collect(runTurn({ model: "claude-opus-4-8", messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(opus[0].model, "deepseek-v4-pro");
    const bg = await collect(runTurn({ background: true, messages: [user("check mail")], toolCtx: { db, settingsStore: settings, conversationId: null } }));
    assert.equal(bg[0].model, "deepseek-flash", "the haiku tier");
    assert.equal(engines.claude.calls[1].maxTurns, 12, "a background turn's ceiling");
    settings.set("ai.deepseek.backgroundModel", "deepseek-v4-pro");
    const own = await collect(runTurn({ background: true, messages: [user("check mail")], toolCtx: { db, settingsStore: settings, conversationId: null } }));
    assert.equal(own[0].model, "deepseek-v4-pro");
  });
});

describe("verification mode (verify-model.js's probe turns)", () => {
  it("runs an unverified model on the engine asked for, with its effort as given", async () => {
    settings.set("ai.openrouter.apiKey", OPENROUTER_KEY);
    const model = "openrouter:meta-llama/llama-4-maverick";
    const plain = await collect(runTurn({ model, messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(plain[1].subtype, "needs-verification", "outside verification it must be verified first");

    const events = await collect(runTurn({ verify: true, engine: "codex", effort: "max", model, messages: [user("hi")], toolCtx: { db, settingsStore: settings, conversationId: null } }));
    assert.equal(events[0].type, "route");
    assert.equal(events[0].engine, "codex");
    assert.equal(events[0].streaming, false, "Codex replies a message at a time");
    assert.equal(engines.codex.calls.length, 1);
    const target = engines.codex.calls[0].target;
    assert.equal(target.engine, "codex");
    assert.equal(target.homeKey, "cx");
    assert.equal(target.effort, "max", "the level is tried as given, not clamped to what is already known");
    assert.equal(target.caps.pdf, false);
    assert.equal(events.at(-1).stopReason, "end_turn");

    await collect(runTurn({ verify: true, engine: "claude-code", model, messages: [user("hi")], toolCtx: { db, settingsStore: settings, conversationId: null } }));
    assert.equal(engines.claude.calls.length, 1);
    assert.equal(engines.claude.calls[0].target.engine, "claude-code");
    assert.equal(engines.claude.calls[0].target.homeKey, "cc");
    assert.equal(engines.claude.calls[0].target.caps.streaming, true);
  });

  it("runs the very model being checked, even one the registry doesn't list (it would put its default in its place)", async () => {
    settings.set("ai.openai.apiKey", OPENAI_KEY);
    const bg = { db, settingsStore: settings, conversationId: null };
    const events = await collect(runTurn({ verify: true, engine: "codex", provider: "openai", model: "gpt-6.2-sol", messages: [user("hi")], toolCtx: bg }));
    assert.equal(events[0].model, "gpt-6.2-sol", "the route names the model checked");
    assert.equal(engines.codex.calls[0].target.model, "gpt-6.2-sol");
    assert.equal(engines.codex.calls[0].target.label, "gpt-6.2-sol");
    // Local AI: a model its server doesn't list (yet), not the card's model.
    settings.set("ai.local.baseUrl", "http://127.0.0.1:11434/v1");
    settings.set("ai.local.model", "qwen3:8b");
    await collect(runTurn({ verify: true, engine: "codex", provider: "local", model: "llama3.1:8b", messages: [user("hi")], toolCtx: bg }));
    assert.equal(engines.codex.calls[1].target.model, "llama3.1:8b");
    // A tier word still means the provider's own model for that tier; outside verification nothing changes.
    await collect(runTurn({ verify: true, engine: "codex", provider: "openai", model: "haiku", messages: [user("hi")], toolCtx: bg }));
    assert.equal(engines.codex.calls[2].target.model, "gpt-6-luna");
    await collect(runTurn({ provider: "openai", model: "gpt-6.2-sol", messages: [user("hi")], toolCtx: bg }));
    assert.equal(engines.codex.calls[3].target.model, "gpt-6.1-sol", "an unverified id outside the list runs the default, as before");
  });

  it("an engine the provider doesn't run on is not taken; outside verification the engine can't be chosen", async () => {
    settings.set("ai.openai.apiKey", OPENAI_KEY);
    await collect(runTurn({ verify: true, engine: "claude-code", provider: "openai", messages: [user("hi")], toolCtx: { db, settingsStore: settings, conversationId: null } }));
    assert.equal(engines.claude.calls.length, 0, "OpenAI runs on Codex only");
    assert.equal(engines.codex.calls.length, 1);
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    await collect(runTurn({ engine: "codex", provider: "deepseek", messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(engines.claude.calls.length, 1, "without verify: true the registry picks the engine");
  });

  it("no handoff, no retry and no backup: only the session carries context, and a failure is the probe's answer", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    settings.set("ai.backupModel", "claude:sonnet");
    const history = [user("earlier question"), { role: "assistant", content: "earlier answer" }, user("now")];
    useEngines({ claude: [ok("fine")] });
    await collect(runTurn({ verify: true, engine: "claude-code", provider: "deepseek", messages: history, toolCtx: { db, settingsStore: settings, conversationId: null } }));
    assert.doesNotMatch(engines.claude.calls[0].prompt, /recent-conversation/);

    useEngines({ claude: [[{ type: "error", message: "session not found", recoverable: true }, { type: "done", stopReason: "error" }], ok()] });
    let events = await collect(runTurn({ verify: true, engine: "claude-code", provider: "deepseek", sessionId: "deepseek/cc/deepseek:raw-1", messages: [user("hi")], toolCtx: { db, settingsStore: settings, conversationId: null } }));
    assert.equal(engines.claude.calls.length, 1, "no retry");
    assert.equal(events.at(-1).stopReason, "error");

    useEngines({ claude: [[{ type: "error", message: "credit", code: "billing" }, { type: "done", stopReason: "error" }], ok("backup")] });
    events = await collect(runTurn({ verify: true, engine: "claude-code", provider: "deepseek", messages: [user("hi")], toolCtx: { db, settingsStore: settings, conversationId: null } }));
    assert.equal(engines.claude.calls.length, 1, "no backup");
    assert.ok(!events.some((e) => e.type === "route" && e.backup));
  });

  it("the caller's working folder reaches the engine (verify runs in a scratch folder)", async () => {
    const cwd = path.join(tmp, "verify", "scratch");
    await collect(runTurn({ cwd, messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(engines.claude.calls[0].cwd, cwd);
    await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(engines.claude.calls[1].cwd, undefined, "no folder of its own: the engine's default (the workspace)");
  });
});

describe("refusals: one text, an error and a done, and the engine never starts", () => {
  const refused = (events, subtype) => {
    assert.deepEqual(types(events), ["text", "error", "done"]);
    assert.equal(events[1].subtype, subtype);
    assert.equal(events[2].stopReason, subtype);
    assert.equal(engines.claude.calls.length + engines.codex.calls.length, 0);
  };

  it("API keys only blocks a sign-in plan", async () => {
    settings.set("ai.keysOnly", true);
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    refused(events, "blocked-keys-only");
    assert.match(events[0].content, /API keys only/);
    assert.match(events[0].content, /Settings > AI/);
  });

  it("an AI that isn't ready says how to fix it", async () => {
    const events = await collect(runTurn({ provider: "deepseek", messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    refused(events, "not-ready");
    assert.match(events[0].content, /DeepSeek/);
    assert.match(events[0].content, /DEEPSEEK_API_KEY/);
    const local = await collect(runTurn({ provider: "local", messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(local[1].subtype, "not-ready");
    assert.match(local[0].content, /Local AI/);
  });

  it("a model that must be verified first", async () => {
    settings.set("ai.openrouter.apiKey", OPENROUTER_KEY);
    const events = await collect(runTurn({ model: "openrouter:meta-llama/llama-4-maverick", messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    refused(events, "needs-verification");
    assert.match(events[0].content, /hasn't been verified yet\. Verify it in Settings > AI first\./);
  });

  it("this month's spending cap, on a metered AI only", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    settings.set("ai.spendCap.monthlyUsd", "20");
    usageIndex(db);
    db.prepare("INSERT INTO usage_turns (turn_id, conversation_id, started_at, ended_at, provider, cost_usd) VALUES (?, ?, ?, ?, ?, ?)")
      .run("spent-turn", "spent-conv", Date.now() - 2000, Date.now() - 1000, "deepseek", 20.4);
    let events;
    let plan;
    try {
      events = await collect(runTurn({ provider: "deepseek", messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
      refused(events, "spend-cap");
      plan = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    } finally {
      db.prepare("DELETE FROM usage_turns WHERE turn_id = 'spent-turn'").run();
    }
    assert.match(events[0].content, /\$20/);
    assert.equal(doneOf(plan)[0].stopReason, "end_turn", "a plan has no per-message cost");
  });

  it("a provider Tarsee doesn't know", async () => {
    const events = await collect(runTurn({ provider: "nonsense", messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    refused(events, "not-ready");
  });

  it("a refusal shows on the live timeline as a turn that ended with that reason", async () => {
    const conv = newChat();
    settings.set("ai.keysOnly", true);
    await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(conv) }));
    const end = live.eventsSince(conv, 0).find((e) => e.type === "turn_end");
    assert.equal(end.payload.stopReason, "blocked-keys-only");
    assert.match(end.payload.error, /API keys only/);
  });
});

describe("exactly one done, and an error before every one that isn't a success", () => {
  it("an engine that forgets done gets one, with an error before it", async () => {
    useEngines({ claude: [[{ type: "text", content: "partial" }, { type: "text", content: " words" }]] });
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.deepEqual(types(events), ["route", "text", "text", "error", "done"]);
    assert.equal(events.at(-1).stopReason, "error");
  });

  it("auth-expired, max turns and the rest are preceded by an error, never two", async () => {
    for (const stopReason of ["auth-expired", "max_turns", "error"]) {
      useEngines({ claude: [[{ type: "done", stopReason }]] });
      const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
      assert.deepEqual(types(events).slice(-2), ["error", "done"], stopReason);
      assert.equal(events.at(-1).stopReason, stopReason);
    }
    useEngines({ claude: [[{ type: "error", message: "Boom" }, { type: "done", stopReason: "error" }]] });
    const one = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(one.filter((e) => e.type === "error").length, 1);
  });

  it("the engine's own auth text keeps its place before the error", async () => {
    useEngines({ claude: [[{ type: "text", content: "Claude's sign-in has expired." }, { type: "done", stopReason: "auth-expired" }]] });
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.deepEqual(types(events), ["route", "text", "error", "done"]);
    assert.equal(events[2].code, "auth");
  });

  it("anything after the engine's done is dropped", async () => {
    useEngines({ claude: [[...ok("one"), { type: "text", content: "ghost" }, { type: "done", stopReason: "end_turn" }]] });
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(doneOf(events).length, 1);
    assert.equal(textOf(events), "one");
  });

  it("a crashed engine gives its error and one done", async () => {
    useEngines({ claude: [[{ type: "throw", message: "spawn claude ENOENT" }]] });
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.deepEqual(types(events).slice(-2), ["error", "done"]);
    assert.match(events.at(-2).message, /ENOENT/);
  });

  it("a tool_use stopReason is rejected: engines run their own tool loop", async () => {
    useEngines({ claude: [[{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "done", stopReason: "tool_use" }]] });
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.deepEqual(types(events).slice(-2), ["error", "done"]);
    assert.equal(events.at(-1).stopReason, "error");
    assert.ok(!events.some((e) => e.type === "done" && e.stopReason === "tool_use"));
  });
});

describe("a session the engine couldn't resume", () => {
  it("a recoverable error before any output retries once, fresh, with the handoff", async () => {
    const conv = newChat();
    say(conv, "user", "earlier question");
    say(conv, "assistant", "earlier answer");
    say(conv, "user", "now");
    useEngines({ claude: [
      [{ type: "error", message: "API Error: previous_message_id must be the id from a prior message", recoverable: true }, { type: "done", stopReason: "error" }],
      [{ type: "session", id: "raw-new" }, ...ok("Fresh answer.")],
    ] });
    let stored = null;
    const events = await collect(runTurn({ messages: [user("now")], toolCtx: ctxFor(conv), sessionId: "raw-old", onSessionId: (h) => { stored = h; } }));
    assert.equal(engines.claude.calls.length, 2);
    assert.equal(engines.claude.calls[0].sessionId, "raw-old");
    assert.equal(engines.claude.calls[1].sessionId, null);
    assert.match(engines.claude.calls[1].prompt, /^<recent-conversation>[\s\S]*earlier answer/);
    assert.deepEqual(types(events), ["route", "text", "done"]);
    assert.equal(events.at(-1).stopReason, "end_turn");
    assert.equal(stored, "raw-new");
  });

  it("only once: a second recoverable error passes through, without the flag", async () => {
    const bad = [{ type: "error", message: "session not found", recoverable: true }, { type: "done", stopReason: "error" }];
    useEngines({ claude: [bad, bad, ok()] });
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()), sessionId: "raw-old" }));
    assert.equal(engines.claude.calls.length, 2);
    const err = events.find((e) => e.type === "error");
    assert.ok(err);
    assert.ok(!err.recoverable, "channels never retry it again");
    assert.equal(events.at(-1).stopReason, "error");
  });

  it("after output it passes through, without the flag", async () => {
    useEngines({ claude: [[{ type: "text", content: "Half " }, { type: "text", content: "an answer" }, { type: "error", message: "session expired", recoverable: true }, { type: "done", stopReason: "error" }]] });
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()), sessionId: "raw-old" }));
    assert.equal(engines.claude.calls.length, 1);
    assert.deepEqual(types(events), ["route", "text", "text", "error", "done"]);
    assert.ok(!events[3].recoverable);
  });
});

describe("the backup model (opt-in)", () => {
  it("answers when the AI fails on billing before any output, with one italic line naming it", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    settings.set("ai.backupModel", "deepseek:deepseek-flash");
    useEngines({ claude: [
      [{ type: "error", message: "Your credit balance is too low.", code: "billing" }, { type: "done", stopReason: "error" }],
      [{ type: "session", id: "ds-backup" }, ...ok("Here's the answer.")],
    ] });
    const conv = newChat();
    let stored = null;
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(conv), onSessionId: (h) => { stored = h; } }));
    assert.equal(engines.claude.calls.length, 2);
    assert.equal(engines.claude.calls[1].target.provider, "deepseek");
    assert.equal(engines.claude.calls[1].target.model, "deepseek-flash");
    const routes = events.filter((e) => e.type === "route");
    assert.deepEqual(routes.map((r) => [r.provider, !!r.backup]), [["claude", false], ["deepseek", true]]);
    const text = textOf(events);
    assert.match(text.split("\n")[0], /^_.*DeepSeek Flash.*_$/, "the reply starts with one italic line naming the model");
    assert.match(text, /Here's the answer\./);
    assert.ok(!events.some((e) => e.type === "error"), "the failure was answered");
    assert.equal(events.at(-1).stopReason, "end_turn");
    assert.equal(stored, "deepseek/cc/deepseek:ds-backup");
    const status = live.eventsSince(conv, 0).find((e) => e.type === "step" && e.payload.kind === "status");
    assert.match(status.payload.text, /Claude plan unavailable \(out of credit\); answering with DeepSeek Flash/);
    // The live view's working line names the AI answering now, not the one that failed.
    const route = live.eventsSince(conv, 0).find((e) => e.type === "step" && e.payload.kind === "route");
    assert.ok(route, "the backup taking over is on the live timeline");
    assert.equal(route.payload.label, "DeepSeek Flash");
    assert.equal(route.payload.provider, "deepseek");
    assert.equal(route.payload.streaming, true, "DeepSeek runs on Claude Code, which streams");
    assert.equal(settings.get(failureFlagKey("claude")).state, "out-of-credit");
  });

  it("not without the setting, not after output, not for a stop", async () => {
    const billing = [{ type: "error", message: "credit", code: "billing" }, { type: "done", stopReason: "error" }];
    useEngines({ claude: [billing, ok("backup")] });
    let events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(engines.claude.calls.length, 1, "no backup set");
    assert.equal(events.at(-1).stopReason, "error");

    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    settings.set("ai.backupModel", "deepseek:deepseek-flash");
    useEngines({ claude: [[{ type: "text", content: "Partly " }, { type: "text", content: "done" }, ...billing], ok("backup")] });
    events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(engines.claude.calls.length, 1, "it had answered already");

    useEngines({ claude: [[{ type: "error", message: "busy", code: "rate" }, { type: "done", stopReason: "aborted" }], ok("backup")] });
    events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(engines.claude.calls.length, 1, "a stop is never answered by the backup");
  });

  it("a backup that isn't ready, or blocked by API keys only, is skipped", async () => {
    settings.set("ai.backupModel", "deepseek:deepseek-flash");
    const billing = [{ type: "error", message: "credit", code: "billing" }, { type: "done", stopReason: "error" }];
    useEngines({ claude: [billing, ok("backup")] });
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(engines.claude.calls.length, 1, "DeepSeek has no key");
    assert.equal(events.at(-1).stopReason, "error");
  });
});

describe("the spend ceiling on an AI without one of its own", () => {
  it("trips on the live usage, stops the engine and says so", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    let signal = null;
    useEngines({ claude: [(opts) => { signal = opts.signal; return [
      { type: "text", content: "Working" }, { type: "text", content: "…" },
      { type: "step", kind: "usage", input: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000, total: 1_000_000, calls: 1 },
      { type: "wait" },
    ]; }] });
    // (Bounded, so a guard that never trips fails this test instead of waiting forever.)
    const bound = new AbortController();
    const timer = setTimeout(() => bound.abort(), 3000);
    let events;
    try {
      events = await collect(runTurn({ provider: "deepseek", messages: [user("go")], toolCtx: ctxFor(newChat()), maxBudgetUsd: 0.05, signal: bound.signal }));
    } finally {
      clearTimeout(timer);
    }
    assert.equal(engines.claude.calls[0].maxBudgetUsd, undefined, "DeepSeek's engine is not trusted with the ceiling");
    assert.deepEqual(types(events).slice(-2), ["error", "done"]);
    assert.equal(events.at(-2).subtype, "error_max_budget_usd");
    assert.match(events.at(-2).message, /spending limit of \$0\.05/);
    assert.equal(events.at(-1).stopReason, "error_max_budget_usd");
    assert.ok(signal.aborted, "the engine was stopped");
    assert.equal(bound.signal.aborted, false, "by the guard, at once, not by the test's own bound");
  });

  it("an engine with a ceiling of its own gets it, and no guard runs", async () => {
    useEngines({ claude: [[{ type: "step", kind: "usage", input: 0, cacheRead: 0, cacheWrite: 0, output: 9_000_000, total: 9_000_000 }, ...ok()]] });
    const events = await collect(runTurn({ messages: [user("go")], toolCtx: ctxFor(newChat()), maxBudgetUsd: 0.05 }));
    assert.equal(engines.claude.calls[0].maxBudgetUsd, 0.05);
    assert.equal(events.at(-1).stopReason, "end_turn");
  });

  it("background work has a ceiling even when its caller names none (the $0.50 background one)", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    useEngines({ claude: [[{ type: "step", kind: "usage", input: 0, cacheRead: 0, cacheWrite: 0, output: 9_000_000, total: 9_000_000 }, { type: "wait" }], ok()] });
    const bg = { db, settingsStore: settings, conversationId: null };
    // (Bounded, so a guard that never trips fails this test instead of waiting forever.)
    const bound = new AbortController();
    const timer = setTimeout(() => bound.abort(), 3000);
    let events;
    try {
      events = await collect(runTurn({ provider: "deepseek", background: true, messages: [user("check")], toolCtx: bg, signal: bound.signal }));
    } finally {
      clearTimeout(timer);
    }
    assert.equal(events.at(-1).stopReason, "error_max_budget_usd");
    assert.match(events.at(-2).message, /spending limit of \$0\.50/);
    assert.equal(bound.signal.aborted, false, "the guard stopped it, at once");
    // An engine that keeps a ceiling of its own is handed the background one.
    await collect(runTurn({ background: true, messages: [user("check")], toolCtx: bg }));
    assert.equal(engines.claude.calls[1].maxBudgetUsd, 0.5);
  });

  it("a cost the provider reports wins over the price table, and rides on turn_end", async () => {
    settings.set("ai.openrouter.apiKey", OPENROUTER_KEY);
    const conv = newChat();
    useEngines({ claude: [[{ type: "usage", usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, costUsd: 0.0123 }, ...ok()]] });
    await collect(runTurn({ provider: "openrouter", messages: [user("go")], toolCtx: ctxFor(conv) }));
    const end = live.eventsSince(conv, 0).find((e) => e.type === "turn_end");
    assert.equal(end.payload.costUsd, 0.0123);
    assert.equal(end.payload.provider, "openrouter");
    assert.equal(end.payload.costExact, undefined, "the engine didn't say it was the provider's own figure");

    // The engine says the figure is the provider's own (OpenRouter's usage.cost): the Usage page labels it exact.
    const conv2 = newChat();
    useEngines({ claude: [[{ type: "usage", usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, costUsd: 0.0042, costExact: true }, ...ok()]] });
    await collect(runTurn({ provider: "openrouter", messages: [user("go")], toolCtx: ctxFor(conv2) }));
    const end2 = live.eventsSince(conv2, 0).find((e) => e.type === "turn_end");
    assert.equal(end2.payload.costUsd, 0.0042);
    assert.equal(end2.payload.costExact, true);
  });
});

describe("failure flags (ai.<id>.status)", () => {
  it("a sign-in failure sets the flag, a success clears it", async () => {
    useEngines({ claude: [[{ type: "done", stopReason: "auth-expired" }], ok()] });
    await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    const flag = settings.get(failureFlagKey("claude"));
    assert.equal(flag.state, "sign-in-expired");
    assert.ok(flag.at);
    await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(settings.get(failureFlagKey("claude")), null);
    assert.equal(failureFlagKey("claude-code"), "ai.claude.status");
  });

  it("a success clears the flag under either name (ai.claude.status, and the plan's stored ai.claude-code.status)", async () => {
    const at = new Date().toISOString();
    settings.set("ai.claude-code.status", { state: "sign-in-expired", at });
    settings.set("ai.claude.status", { state: "sign-in-expired", at });
    const events = await collect(runTurn({ messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(events.at(-1).stopReason, "end_turn", "a flag never stops a turn: the owner may have fixed it");
    assert.equal(settings.get("ai.claude-code.status"), null);
    assert.equal(settings.get("ai.claude.status"), null);
  });

  it("a rejected key and an empty balance", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    useEngines({ claude: [[{ type: "error", message: "401", code: "auth" }, { type: "done", stopReason: "auth-expired" }], [{ type: "error", message: "402", code: "billing" }, { type: "done", stopReason: "error" }]] });
    await collect(runTurn({ provider: "deepseek", messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(settings.get(failureFlagKey("deepseek")).state, "auth", "read by provider-status.js as a rejected key");
    await collect(runTurn({ provider: "deepseek", messages: [user("hi")], toolCtx: ctxFor(newChat()) }));
    assert.equal(settings.get(failureFlagKey("deepseek")).state, "out-of-credit");
  });
});

describe("Codex turns", () => {
  it("get the MCP grant, which is revoked when the turn ends; their usage is recorded directly", async () => {
    settings.set("ai.openai.apiKey", OPENAI_KEY);
    const revoked = [];
    const rows = [];
    restore();
    restore = configureTurns({
      grantMcp: async (ctx) => ({ url: "http://127.0.0.1:9/mcp", token: `tok-${ctx.turnId}`, revoke() { revoked.push(ctx.turnId); } }),
      recordUsage: (row) => rows.push(row),
    });
    useEngines({ codex: [[{ type: "session", id: "thread-1" }, { type: "usage", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } }, ...ok("Hi from Codex")]] });
    const conv = newChat();
    let stored = null;
    const events = await collect(runTurn({ provider: "openai", messages: [user("hi")], toolCtx: ctxFor(conv), onSessionId: (h) => { stored = h; } }));
    assert.equal(events[0].engine, "codex");
    const call = engines.codex.calls[0];
    assert.equal(call.mcpGrant.url, "http://127.0.0.1:9/mcp");
    assert.match(call.mcpGrant.token, /^tok-/);
    assert.equal(revoked.length, 1);
    assert.equal(stored, "openai/cx/openai:thread-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, "openai");
    assert.equal(rows[0].engine, "codex");
    assert.equal(rows[0].sessionId, "thread-1");
    assert.equal(rows[0].input, 100);
    assert.equal(rows[0].cacheRead, 50);
    assert.equal(rows[0].output, 20);
    assert.equal(rows[0].conversationId, conv);
    assert.ok(rows[0].id.startsWith("codex:thread-1:"));
  });

  it("the grant names the turn's AI, and a turn with no chat of its own (a subagent, ACP) is still recorded, so this month's spend counts it", async () => {
    settings.set("ai.openai.apiKey", OPENAI_KEY);
    const granted = [];
    restore();
    // The real usage index (token-usage.js recordDirect), not a stand-in.
    restore = configureTurns({ grantMcp: async (ctx) => { granted.push(ctx); return { url: "http://127.0.0.1:9/mcp", token: "t", revoke() {} }; } });
    usageIndex(db);
    useEngines({ codex: [[{ type: "session", id: "thread-no-chat" }, { type: "usage", usage: { input_tokens: 4000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, ...ok("Counted.")]] });
    const events = await collect(runTurn({ provider: "openai", messages: [user("count the files")], toolCtx: { db, settingsStore: settings, conversationId: null }, liveDisabled: true }));
    assert.equal(events.at(-1).stopReason, "end_turn");
    assert.equal(granted[0].provider, "openai");
    const row = () => db.prepare("SELECT provider, engine, conversation_id AS conv, cost_usd AS cost FROM usage_calls WHERE session_id = ?").get("thread-no-chat");
    assert.ok(await until(() => !!row()), "the turn's usage is in the index");
    assert.equal(row().provider, "openai");
    assert.equal(row().engine, "codex");
    assert.ok(row().conv, "filed under a conversation of its own");
    assert.ok(row().cost > 0, "priced from the table, so the monthly cap sees it");
  });

  it("the grant is revoked even when the turn is stopped", async () => {
    settings.set("ai.openai.apiKey", OPENAI_KEY);
    const revoked = [];
    restore();
    restore = configureTurns({ grantMcp: async () => ({ url: "http://127.0.0.1:9/mcp", token: "t", revoke() { revoked.push(1); } }), recordUsage: () => {} });
    useEngines({ codex: [[{ type: "wait" }]] });
    const conv = newChat();
    const run = collect(runTurn({ provider: "openai", messages: [user("hi")], toolCtx: ctxFor(conv) }));
    assert.ok(await until(() => engines.codex.calls.length === 1));
    stopTurns(conv);
    await run;
    assert.equal(revoked.length, 1);
  });
});

describe("background turns (lib/background-turn.js)", () => {
  it("auth-expired, a refusal, the spend cap and the budget stop are failures, not blank successes", async () => {
    const bgCtx = { db, settingsStore: settings, conversationId: null };
    useEngines({ claude: [[{ type: "text", content: "Claude's sign-in has expired." }, { type: "done", stopReason: "auth-expired" }]] });
    let r = await runBackgroundTurn({ label: "cron:test", messages: [user("check")], systemPrompt: "", toolCtx: bgCtx });
    assert.ok(r.error, "auth-expired failed the job");
    assert.equal(r.stopReason, "auth-expired");

    settings.set("ai.keysOnly", true);
    r = await runBackgroundTurn({ label: "cron:test", messages: [user("check")], systemPrompt: "", toolCtx: bgCtx });
    assert.match(r.error, /API keys only/);
    settings.delete("ai.keysOnly");

    settings.set("ai.activeProvider", "deepseek");
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    restore();
    restore = configureTurns({ monthlyCap: async () => ({ ok: false, capUsd: 5 }) });
    r = await runBackgroundTurn({ label: "cron:test", messages: [user("check")], systemPrompt: "", toolCtx: bgCtx });
    assert.equal(r.stopReason, "spend-cap");
    assert.ok(r.error);
    restore();
    restore = configureTurns({});

    useEngines({ claude: [[{ type: "step", kind: "usage", input: 0, output: 9_000_000, cacheRead: 0, cacheWrite: 0, total: 9_000_000 }, { type: "wait" }]] });
    r = await runBackgroundTurn({ label: "cron:test", messages: [user("check")], systemPrompt: "", toolCtx: bgCtx, maxBudgetUsd: 0.5 });
    assert.equal(r.stopReason, "error_max_budget_usd");
    assert.match(r.error, /spending limit/);
  });

  it("a job that is stopped part-way is a failure, and its partial words are not posted as its result", async () => {
    useEngines({ claude: [[{ type: "text", content: "Half an ans" }, { type: "wait" }]] });
    const stop = new AbortController();
    const job = runBackgroundTurn({ label: "cron:test", messages: [user("check")], systemPrompt: "", toolCtx: { db, settingsStore: settings, conversationId: null }, signal: stop.signal });
    assert.ok(await until(() => engines.claude.calls.length === 1));
    await new Promise((r) => setTimeout(r, 50));
    stop.abort();
    const r = await job;
    assert.equal(r.stopReason, "aborted");
    assert.equal(r.error, "Stopped before it finished");
  });

  it("a finished job reports the model that ran, and a background turn picks the background model", async () => {
    settings.set("ai.activeProvider", "deepseek");
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    useEngines({ claude: [ok("All quiet.")] });
    const { resolveBackgroundModel } = await import("../src/lib/background-turn.js");
    const r = await runBackgroundTurn({ label: "heartbeat", messages: [user("check")], systemPrompt: "", toolCtx: { db, settingsStore: settings, conversationId: null }, model: resolveBackgroundModel(null) });
    assert.equal(r.error, null);
    assert.equal(r.text, "All quiet.");
    assert.equal(r.model, "deepseek-flash");
    assert.equal(r.provider, "deepseek");
  });
});

describe("the web chat route (routes/chat.js) through the router", () => {
  let server;
  let base;
  before(async () => {
    const { chatRouter } = await import("../src/routes/chat.js");
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    app.set("db", db);
    app.use("/api/chat", chatRouter);
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api/chat`;
  });
  after(() => {
    server?.closeAllConnections?.();
    server?.close();
  });

  const sse = (raw) => raw.split("\n\n").filter(Boolean).map((chunk) => {
    const ev = /^event: (.+)$/m.exec(chunk)?.[1];
    const data = /^data: (.+)$/m.exec(chunk)?.[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });

  it("streams SSE as before and persists the reply, with the provider and model that ran", async () => {
    useEngines({ claude: [[
      { type: "session", id: "web-raw-1" },
      { type: "text", content: "Hello " },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", id: "t1", ok: true, result: "a\nb" },
      { type: "text", content: "world" },
      { type: "usage", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { type: "done", stopReason: "end_turn" },
    ]] });
    const conv = newChat("web");
    const res = await fetch(`${base}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conv, message: "say hello" }) });
    assert.equal(res.status, 200);
    const events = sse(await res.text());
    const names = events.map((e) => e.event);
    assert.equal(names[0], "conversation");
    assert.ok(names.includes("model_selected"));
    assert.deepEqual(events.filter((e) => e.event === "text").map((e) => e.data.content), ["Hello ", "world"]);
    assert.ok(names.includes("tool_call") && names.includes("tool_result"));
    const done = events.find((e) => e.event === "done");
    assert.equal(done.data.conversationId, conv);
    assert.ok(done.data.contextTokens > 0);
    assert.equal(done.data.model, events.find((e) => e.event === "model_selected").data.model);
    const saved = convs.getMessages(conv).filter((m) => m.role === "assistant");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].provider, "claude");
    assert.equal(saved[0].model, done.data.model);
    assert.match(saved[0].content, /"__timeline":true/);
    assert.equal(JSON.parse(saved[0].content).text, "Hello world");
    assert.equal(convs.getClaudeSessionId(conv), "web-raw-1");
    assert.equal(engines.claude.calls[0].thinkingSummaries, true, "a dashboard turn asks for thinking summaries");
  });

  it("a refusal still streams, and is the reply", async () => {
    settings.set("ai.keysOnly", true);
    const conv = newChat("web");
    const res = await fetch(`${base}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conv, message: "hi" }) });
    assert.equal(res.status, 200);
    const events = sse(await res.text());
    assert.match(events.find((e) => e.event === "error").data.message, /API keys only/);
    assert.ok(events.some((e) => e.event === "done"));
    assert.equal(engines.claude.calls.length, 0);
  });

  it("Stop reaches a turn another channel started (stopTurns from turn.js)", async () => {
    useEngines({ claude: [[{ type: "wait" }]] });
    const conv = newChat("telegram");
    const run = collect(runTurn({ messages: [user("long")], toolCtx: ctxFor(conv), liveSource: "telegram" }));
    assert.ok(await until(() => engines.claude.calls.length === 1));
    let res;
    try {
      res = await (await fetch(`${base}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conv }) })).json();
    } finally {
      stopTurns(conv);   // (so a failure here can't leave the turn running)
    }
    assert.equal(res.stopped, true);
    assert.equal((await run).at(-1).stopReason, "aborted");
  });

  it("reset-session clears the handle and records when, so the handoff skips what came before", async () => {
    const conv = newChat("web");
    convs.setClaudeSessionId(conv, "deepseek/cc/deepseek:abc");
    const before = Date.now();
    const r = await fetch(`${base}/conversations/${conv}/reset-session`, { method: "POST" });
    assert.equal(r.status, 200);
    assert.equal(convs.getClaudeSessionId(conv), null);
    assert.ok(Date.parse(settings.get(`session.${conv}.clearedAt`)) >= before - 1000);
  });

  it("the composer's picker (GET /models, GET|PUT /conversations/:id/picker) covers every ready AI, and a chat's pick runs its turns", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    const list = await (await fetch(`${base}/models`)).json();
    assert.ok(Array.isArray(list.groups), `one group per ready AI: ${Object.keys(list)}`);
    assert.ok(list.groups.some((g) => g.provider === "deepseek"), "DeepSeek has a key, so it is listed");
    assert.ok(Array.isArray(list.models), "Tarsee's Claude table for Settings is still there");
    const conv = newChat("web");
    const put = await fetch(`${base}/conversations/${conv}/picker`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek:deepseek-v4-pro", effort: "high" }) });
    const putBody = await put.json();
    assert.equal(put.status, 200, JSON.stringify(putBody));
    assert.equal(settings.get(`session.${conv}.provider`), "deepseek");
    const pick = await (await fetch(`${base}/conversations/${conv}/picker`)).json();
    assert.equal(pick.provider, "deepseek");
    assert.equal(pick.modelId, "deepseek-v4-pro");
    assert.equal((await fetch(`${base}/conversations/nope/picker`)).status, 404);
    useEngines({ claude: [ok("From Pro.")] });
    const res = await fetch(`${base}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conv, message: "hello" }) });
    const picked = sse(await res.text()).find((e) => e.event === "model_selected").data;
    assert.equal(picked.provider, "deepseek");
    assert.equal(picked.model, "deepseek-v4-pro");
    assert.equal(engines.claude.calls[0].target.effort, "high");
  });

  it("auto-routing picks a tier the chat's AI maps", async () => {
    settings.set("ai.autoRoute", true);
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    settings.set("ai.activeProvider", "deepseek");
    const conv = newChat("web");
    const res = await fetch(`${base}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conv, message: "please debug and refactor this module" }) });
    const events = sse(await res.text());
    const picked = events.find((e) => e.event === "model_selected").data;
    assert.equal(picked.provider, "deepseek");
    assert.equal(picked.model, "deepseek-v4-pro", "opus work goes to DeepSeek's top tier, never a claude-* id");
  });
});

describe("the dashboard's WebSocket chat (channels/websocket.js) through the router", () => {
  let server;
  let port;
  before(async () => {
    const { setupWebSocket } = await import("../src/channels/websocket.js");
    server = http.createServer();
    setupWebSocket(server, db, { get: () => null });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => {
    server?.closeAllConnections?.();
    server?.close();
  });

  async function chatOverSocket(payload) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${API_TOKEN}`);
    const got = [];
    ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
    try {
      await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
      assert.ok(await until(() => got.some((m) => m.type === "auth_ok")));
      ws.send(JSON.stringify({ type: "chat", ...payload }));
      assert.ok(await until(() => got.some((m) => m.type === "done" || m.type === "command")), JSON.stringify(got));
      return got;
    } finally {
      ws.terminate();
    }
  }

  it("streams the reply on the chat's AI and stores it with the provider, model and tagged session", async () => {
    settings.set("ai.activeProvider", "deepseek");
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    useEngines({ claude: [[{ type: "session", id: "ws-raw-1" }, { type: "text", content: "Hi " }, { type: "text", content: "there" }, { type: "done", stopReason: "end_turn" }]] });
    const conv = newChat("web");
    const got = await chatOverSocket({ conversationId: conv, message: "hello" });
    assert.equal(got.find((m) => m.type === "model_selected").provider, "deepseek");
    assert.equal(got.filter((m) => m.type === "text").map((m) => m.content).join(""), "Hi there");
    const saved = convs.getMessages(conv).filter((m) => m.role === "assistant");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].provider, "deepseek");
    assert.equal(saved[0].model, "deepseek-flash");
    assert.equal(convs.getClaudeSessionId(conv), "deepseek/cc/deepseek:ws-raw-1");
    assert.equal(engines.claude.calls[0].liveSource, "web");
  });

  it("an AI that isn't set up answers with what to fix, not a bare error", async () => {
    settings.set("ai.activeProvider", "deepseek");
    const conv = newChat("web");
    const got = await chatOverSocket({ conversationId: conv, message: "hello" });
    assert.match(got.find((m) => m.type === "error").message, /DEEPSEEK_API_KEY/);
    assert.equal(engines.claude.calls.length, 0);
  });

  it("voice mode asks for no thinking summaries, and the turn knows the message it answers", async () => {
    const conv = newChat("web");
    await chatOverSocket({ conversationId: conv, message: "[voice] what time is it" });
    assert.equal(engines.claude.calls[0].thinkingSummaries, false, "a spoken reply is waited for");
    const asked = convs.getMessages(conv).find((m) => m.role === "user");
    assert.equal(engines.claude.calls[0].toolCtx.messageId, asked.id);
  });

  it("a message taken out of the queue (the Stop on its Queued line) ends at once and never runs", async () => {
    const conv = newChat("web");
    let release;
    const busy = withConversationTurn(conv, () => new Promise((r) => { release = r; }));   // another channel's turn
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${API_TOKEN}`);
    const got = [];
    ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
    try {
      await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
      assert.ok(await until(() => got.some((m) => m.type === "auth_ok")));
      ws.send(JSON.stringify({ type: "chat", conversationId: conv, message: "and May?" }));
      let queued = null;
      assert.ok(await until(() => { queued = live.eventsSince(conv, 0).find((e) => e.type === "turn_queued"); return !!queued; }), "shown as queued");
      assert.equal(removeQueuedTurn(queued.turnId, conv), true);
      assert.ok(await until(() => got.some((m) => m.type === "done")), JSON.stringify(got));
      assert.equal(got.find((m) => m.type === "done").stopReason, "stopped");
    } finally {
      release?.();
      await busy;
      ws.terminate();
    }
    assert.equal(engines.claude.calls.length, 0, "the removed message never reached the AI");
  });
});

describe("the external API, ACP and subagents through the router", () => {
  let server;
  let base;
  before(async () => {
    const { externalApiRouter } = await import("../src/routes/external-api.js");
    const { acpRouter } = await import("../src/routes/acp.js");
    const app = express();
    app.use(express.json());
    app.set("db", db);
    app.use("/api/v1", externalApiRouter);
    app.use("/api/acp", acpRouter);
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api`;
  });
  after(() => {
    server?.closeAllConnections?.();
    server?.close();
  });
  const post = (url, body) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("the external API takes an optional provider and a model ref", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    useEngines({ claude: [ok("From DeepSeek."), ok("From Pro."), ok("From Claude.")] });
    let r = await post("/v1/message", { message: "hi", provider: "deepseek" });
    assert.equal(r.status, 200);
    let body = await r.json();
    assert.equal(body.response, "From DeepSeek.");
    assert.equal(body.provider, "deepseek");
    assert.equal(engines.claude.calls[0].target.provider, "deepseek");
    r = await post("/v1/message", { message: "hi", model: "deepseek:deepseek-v4-pro" });
    body = await r.json();
    assert.equal(body.model, "deepseek-v4-pro");
    r = await post("/v1/message", { message: "hi" });
    body = await r.json();
    assert.equal(body.provider, "claude", "no choice: the default AI");
    const saved = convs.getMessages(body.conversationId).filter((m) => m.role === "assistant");
    assert.equal(saved[0].provider, "claude");
  });

  it("the external API refuses an AI it can't use, and says when the AI couldn't answer", async () => {
    assert.equal((await post("/v1/message", { message: "hi", provider: "nope" })).status, 400);
    assert.equal((await post("/v1/message", { message: "hi", provider: "openai", model: "deepseek:deepseek-flash" })).status, 400);
    assert.equal((await post("/v1/message", { message: "hi", conversationId: "missing" })).status, 404);
    const r = await post("/v1/message", { message: "hi", provider: "deepseek" });
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.equal(body.stopReason, "not-ready");
    assert.match(body.error, /DEEPSEEK_API_KEY/);
  });

  it("an ACP session runs on the default AI and resumes its own session", async () => {
    settings.set("ai.activeProvider", "deepseek");
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    useEngines({ claude: [[{ type: "session", id: "acp-raw" }, ...ok("First.")], ok("Second.")] });
    const session = await (await post("/acp/session", { identity: { clientName: "test-ide" } })).json();
    let r = await post(`/acp/session/${session.id}/turn`, { message: "hello" });
    assert.equal(r.status, 200);
    let body = await r.json();
    assert.equal(body.response, "First.");
    assert.equal(body.provider, "deepseek");
    r = await post(`/acp/session/${session.id}/turn`, { message: "again" });
    body = await r.json();
    assert.equal(body.response, "Second.");
    assert.equal(engines.claude.calls.length, 2, "one engine turn per ACP turn: the engine runs its own tools");
    assert.equal(engines.claude.calls[1].sessionId, "acp-raw");
  });

  it("an ACP turn the AI can't take ends without a result", async () => {
    settings.set("ai.activeProvider", "deepseek");
    const session = await (await post("/acp/session", {})).json();
    const r = await post(`/acp/session/${session.id}/turn`, { message: "hello" });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /DEEPSEEK_API_KEY/);
  });

  it("a turn that goes quiet is given up: the external API answers 504 and the chat takes the next message", async () => {
    process.env.TARSEE_CHANNEL_IDLE_ABORT_MS = "150";
    try {
      settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
      useEngines({ claude: [[{ type: "wait" }], ok("Back again.")] });
      let r = await post("/v1/message", { message: "hi", provider: "deepseek" });
      assert.equal(r.status, 504);
      const body = await r.json();
      assert.match(body.error, /^DeepSeek Flash stopped responding \(1 min idle\)\. Try again/);
      assert.ok(body.conversationId);
      assert.ok(engines.claude.calls[0].signal.aborted, "the engine was stopped");
      r = await post("/v1/message", { message: "again", provider: "deepseek", conversationId: body.conversationId });
      assert.equal(r.status, 200, "the conversation's lock was let go");
      assert.equal((await r.json()).response, "Back again.");
    } finally {
      delete process.env.TARSEE_CHANNEL_IDLE_ABORT_MS;
    }
  });

  /** Send a request, and go away (the socket closed, no answer read) once `when()` holds. */
  const leave = (url, body, when) => new Promise((resolve) => {
    const req = http.request(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" } });
    req.on("error", () => resolve());
    req.end(JSON.stringify(body));
    until(when).then(() => { req.destroy(); resolve(); });
  });
  const reply = (conv) => convs.getMessages(conv).find((m) => m.role === "assistant") || null;

  it("a client that leaves the external API: the turn runs on and its whole reply is saved in the conversation", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    const conv = newChat("api");
    useEngines({ claude: [[{ type: "text", content: "Part one." }, { type: "sleep", ms: 300 }, { type: "text", content: " Part two." }, { type: "done", stopReason: "end_turn" }]] });
    await leave("/v1/message", { message: "a long job", provider: "deepseek", conversationId: conv }, () => engines.claude.calls.length === 1);
    assert.ok(await until(() => reply(conv)), "the reply was saved");
    assert.equal(reply(conv).content, "Part one. Part two.", "the whole reply, not what had come before the client left");
    assert.equal(reply(conv).provider, "deepseek");
    assert.equal(engines.claude.calls[0].signal.aborted, false, "the engine was not stopped");
  });

  it("a message queued behind another turn isn't given up for the time it waits: its idle clock starts with its turn", async () => {
    process.env.TARSEE_CHANNEL_IDLE_ABORT_MS = "150";
    try {
      settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
      useEngines({ claude: [ok("Your turn now.")] });
      const conv = newChat("api");
      let release;
      const busy = withConversationTurn(conv, () => new Promise((r) => { release = r; }));
      const pending = post("/v1/message", { message: "queued", provider: "deepseek", conversationId: conv });
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(engines.claude.calls.length, 0, "it waits for the turn ahead of it");
      release();
      await busy;
      const r = await pending;
      assert.equal(r.status, 200);
      assert.equal((await r.json()).response, "Your turn now.");
      assert.equal(engines.claude.calls[0].signal.aborted, false);
    } finally {
      delete process.env.TARSEE_CHANNEL_IDLE_ABORT_MS;
    }
  });

  it("a message whose client left while it waited in the queue still runs when its turn comes, and its reply is saved", async () => {
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    useEngines({ claude: [ok("Answered anyway.")] });
    const conv = newChat("api");
    let release;
    const busy = withConversationTurn(conv, () => new Promise((r) => { release = r; }));
    await leave("/v1/message", { message: "queued", provider: "deepseek", conversationId: conv }, () => live.eventsSince(conv, 0).some((e) => e.type === "turn_queued"));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(engines.claude.calls.length, 0, "still waiting");
    release();
    await busy;
    assert.ok(await until(() => reply(conv)), "the reply was saved");
    assert.equal(engines.claude.calls.length, 1, "the engine ran it");
    assert.equal(engines.claude.calls[0].prompt, QUEUED_NOTE + "queued", "as a queued message (turn.js's note)");
    assert.equal(reply(conv).content, "Answered anyway.");
  });

  it("a client that leaves an ACP turn stops it: the session lives in memory and nothing else can reach the turn", async () => {
    settings.set("ai.activeProvider", "deepseek");
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    useEngines({ claude: [[{ type: "wait" }]] });
    const session = await (await post("/acp/session", {})).json();
    await leave(`/acp/session/${session.id}/turn`, { message: "a long job" }, () => engines.claude.calls.length === 1);
    assert.ok(await until(() => engines.claude.calls[0].signal.aborted), "the ACP turn was stopped");
  });

  it("an ACP turn that goes quiet is given up with 504", async () => {
    process.env.TARSEE_CHANNEL_IDLE_ABORT_MS = "150";
    try {
      settings.set("ai.activeProvider", "deepseek");
      settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
      useEngines({ claude: [[{ type: "wait" }]] });
      const session = await (await post("/acp/session", {})).json();
      const r = await post(`/acp/session/${session.id}/turn`, { message: "hello" });
      assert.equal(r.status, 504);
      const body = await r.json();
      assert.match(body.error, /^DeepSeek Flash stopped responding \(1 min idle\)/);
      assert.equal(body.session.turnCount, 1);
    } finally {
      delete process.env.TARSEE_CHANNEL_IDLE_ABORT_MS;
    }
  });

  it("a subagent runs on the default AI and records the model that ran", async () => {
    const { spawnAgent, getAgentResult, onAgentEvent } = await import("../src/lib/subagents.js");
    settings.set("ai.activeProvider", "deepseek");
    settings.set("ai.deepseek.apiKey", DEEPSEEK_KEY);
    useEngines({ claude: [[{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }, { type: "tool_result", id: "t1", ok: true, result: "a" }, ...ok("Found one file.")]] });
    const finished = new Promise((r) => { const off = onAgentEvent((evt, data) => { if (evt === "completed") { off(); r(data); } }); });
    const { taskId } = spawnAgent({ task: "count the files", name: "counter", settingsStore: settings, db });
    const done = await finished;
    assert.equal(done.status, "completed");
    const result = getAgentResult(taskId);
    assert.equal(result.result, "Found one file.");
    assert.equal(result.model, "deepseek-flash");
    assert.equal(result.toolsUsed, 1);
    assert.equal(engines.claude.calls[0].target.provider, "deepseek");
    assert.equal(engines.claude.calls[0].liveDisabled, undefined, "the engine is not asked about the timeline");
    assert.equal(engines.claude.calls[0].liveSource, "agent", "its usage rows read agent:<turn>, not turn:<turn>");
  });

  it("a subagent whose AI can't answer fails with the reason", async () => {
    const { spawnAgent, onAgentEvent } = await import("../src/lib/subagents.js");
    settings.set("ai.keysOnly", true);
    const finished = new Promise((r) => { const off = onAgentEvent((evt, data) => { if (evt === "completed") { off(); r(data); } }); });
    spawnAgent({ task: "count the files", name: "counter", settingsStore: settings, db });
    const done = await finished;
    assert.equal(done.status, "failed");
    assert.match(done.error, /API keys only/);
  });
});

describe("the system prompt in two parts (lib/build-system-prompt.js)", () => {
  it("stable + volatile is the whole prompt; the day's log and the learning nudges are volatile", () => {
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(tmp, "workspace", "memory", `${today}.md`), "- met the dentist\n");
    const conv = newChat();
    const args = { settingsStore: settings, db, conversationId: conv, messageCount: 5, conversationPrompt: "Be brief.", channelHint: "On Telegram." };
    const parts = buildSystemPromptParts(args);
    assert.equal(typeof parts.stable, "string");
    assert.equal(typeof parts.volatile, "string");
    assert.equal(buildSystemPrompt(args), parts.stable + parts.volatile);
    assert.match(parts.volatile, /met the dentist/);
    assert.doesNotMatch(parts.stable, /met the dentist/);
    assert.match(parts.stable, /Be brief\./);
    assert.match(parts.stable, /On Telegram\./);
  });

  it("the two parts together stay inside the 50KB budget, counted in bytes, the stable part first", () => {
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(tmp, "workspace", "memory", `${today}.md`), "- met the dentist\n");
    const huge = "é".repeat(40_000);   // 80,000 bytes in UTF-8
    const parts = buildSystemPromptParts({ settingsStore: settings, db, conversationId: newChat(), messageCount: 5, conversationPrompt: huge, channelHint: "" });
    assert.ok(Buffer.byteLength(parts.stable + parts.volatile, "utf8") <= 50 * 1024, `${Buffer.byteLength(parts.stable + parts.volatile, "utf8")} bytes`);
    assert.ok(Buffer.byteLength(parts.stable, "utf8") >= 50 * 1024 - 3, "the stable part fills the budget first");
    assert.doesNotMatch(parts.volatile, /met the dentist/, "no room is left for the day's log");
    assert.ok(parts.stable.endsWith("é"), "cut after a whole character, never through one");
    assert.doesNotMatch(parts.stable, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|�/, "no character cut in half");
    const small = buildSystemPromptParts({ settingsStore: settings, db, conversationId: newChat(), messageCount: 5, conversationPrompt: "Be brief.", channelHint: "" });
    assert.match(small.volatile, /met the dentist/, "with room, the volatile part is whole");
  });
});
