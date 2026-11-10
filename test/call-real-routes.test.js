// A voice call in a real browser against the REAL server routes: POST /api/voice/transcribe and /tts-stream
// (src/routes/voice.js), POST /api/chat/send and /stop (src/routes/chat.js, through the turn layer), and /api/call
// (src/routes/voice-call.js), on a real SQLite settings store and the live timeline. Only what lies outside Tarsee is
// stood in for: the microphone (Playwright's fake one, playing a WAV made here), the speech-to-text engine
// (stt-handler.js's test seam, for faster-whisper), the voice (a scripted TTS engine), the AI (a scripted engine,
// test/fakes/fake-engine.js) and Telegram (a channel manager that records what it is asked to send).
// So it proves the call sends what the real routes take: a WAV the transcribe route reads, a "[call]" message the AI
// sees as a call, Stop reaching the running turn, the reply spoken through the TTS engine, and the hang-up's answer
// sent to Telegram through send_message.
// Runs on Playwright's Chromium, else an installed Chrome or Edge; skipped where there is none.
/* global document, Call -- the page.evaluate() bodies run in the browser */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-call-real-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
for (const name of ["TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_URL", "TARSEE_LOCAL_AI_KEY"]) {
  delete process.env[name];
}
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });
// The Claude plan counts as signed in (provider-status.js reads the Railway variable), whatever this machine has.
process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-canary-claude-oauth-token";

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const live = await import("../src/lib/live-bus.js");
const { registerEngine, configureTurns } = await import("../src/ai/turn.js");
const { createFakeEngine } = await import("./fakes/fake-engine.js");
const { setTTSEngine } = await import("../src/voice/engine-registry.js");
const { __setForTests: setStt } = await import("../src/voice/stt-handler.js");
const { chatRouter } = await import("../src/routes/chat.js");
const { voiceRouter } = await import("../src/routes/voice.js");
const { callRouter } = await import("../src/routes/voice-call.js");
const { CALL_CHANNEL_KEY, HANDOFF_SETTING } = await import("../src/lib/voice-call.js");

const PUBLIC = fileURLToPath(new URL("../src/public/", import.meta.url));

/** A 16-bit mono WAV: [{ s, voice }], voice being a pitch-gliding buzz at syllable pace. */
function wav(parts, rate = 16000) {
  const samples = [];
  let seed = 11;
  const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (const p of parts) {
    for (let i = 0; i < Math.round(p.s * rate); i++) {
      const t = i / rate;
      if (!p.voice) { samples.push(noise() * 0.002); continue; }
      const f0 = 140 + 30 * Math.sin(2 * Math.PI * 1.3 * t);
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
      samples.push(0.25 * v * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t)) + noise() * 0.02);
    }
  }
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), 44 + i * 2));
  return buf;
}
const MIC = path.join(tmp, "mic.wav");
fs.writeFileSync(MIC, wav([{ s: 0.8 }, { s: 1.0, voice: true }, { s: 2.4 }]));

let browser = null;
try {
  const { chromium } = await import("playwright");
  const args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${MIC}`, "--autoplay-policy=no-user-gesture-required"];
  for (const opts of [{}, { channel: "chrome" }, { channel: "msedge" }]) {
    try { browser = await chromium.launch({ ...opts, args }); break; } catch { /* the next one */ }
  }
} catch {
  browser = null;
}
const skip = browser ? false : "no Chromium, Chrome or Edge for Playwright";

// --- The world outside Tarsee ---------------------------------------------------------------------------------------

const db = initDb(path.join(tmp, "tarsee.db"));
live.initLiveBus(db);
const store = new SettingsStore(db);
const convs = new ConversationStore(db);

/** What faster-whisper heard (one per thing said, then ""), and every WAV it was handed. */
const stt = { heard: [], wavs: [] };
/** The voice: every text it was asked to say. */
const voice = {
  said: [],
  name: "fake-voice",
  async isAvailable() { return true; },
  async listVoices() { return []; },
  async synthesize(text) { this.said.push(text); return { audio: wav([{ s: 0.3 }], 8000), contentType: "audio/wav" }; },
};
/** Telegram, connected, recording what it is asked to send. */
const telegram = {
  sent: [],
  getStatus: () => ({ telegram: { status: "running" }, discord: { status: "stopped" } }),
  async sendMessage(type, chatId, message) { this.sent.push({ type, chatId, message }); },
};

let server;
let origin;
let engine;
let restoreTurns;
before(async () => {
  if (!browser) return;
  restoreTurns = configureTurns({ recordUsage: () => {} });
  setTTSEngine(voice);
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.set("db", db);
  app.set("settingsStore", store);
  app.set("channelManager", telegram);
  app.get("/api/auth/status", (_req, res) => res.json({ authenticated: true, needsPassword: true }));
  app.get("/api/auth/api-token", (_req, res) => res.json({ apiToken: null }));
  app.get("/api/settings/setup-status", (_req, res) => res.json({ needsSetup: false, needsPersonality: false, botName: store.get("identity.name") || "Tarsee", provider: "claude-code", hasKey: true }));
  app.get("/api/settings", (_req, res) => res.json({ settings: [] }));
  app.use("/api/chat", chatRouter);
  app.use("/api/voice", voiceRouter);
  app.use("/api/call", callRouter);
  app.use("/api", (_req, res) => res.json({}));
  app.use(express.static(PUBLIC));
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  restoreTurns?.();
  registerEngine("claude-code", null);
  setStt();
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise((r) => (server ? server.close(r) : r()));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const prefix of ["call.", "identity.", "channel_conv.", "ai.", "session."]) for (const { key } of store.getByPrefix(prefix)) store.delete(key);
  store.set("identity.name", "Atlas");
  stt.heard = [];
  stt.wavs = [];
  voice.said = [];
  telegram.sent = [];
  setStt({ local: { available: () => true, transcribe: async (audio) => { stt.wavs.push(audio); return { transcript: stt.heard.length ? stt.heard.shift() : "", language: "en", provider: "fake faster-whisper" }; } } });
});

async function openPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block", permissions: ["microphone"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route((url) => !url.href.startsWith(origin), (route) => route.abort());
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => document.getElementById("callBtn")?.getAttribute("aria-label") === "Call Atlas");
  return { page, errors, context };
}
async function startCall(page) {
  await page.locator("#callBtn").click();
  await page.waitForFunction(() => ["listening", "speaking", "thinking"].includes(Call.state), null, { timeout: 10000 });
}
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

describe("a voice call against the real routes", { skip }, () => {
  it("something said: a WAV the transcribe route reads, a turn the AI knows is a call, the reply spoken by the TTS engine", async () => {
    stt.heard = ["what's on today"];
    engine = createFakeEngine([[{ type: "text", content: "You have **two** meetings, at 10 & 2." }, { type: "done", stopReason: "end_turn" }]]);
    registerEngine("claude-code", engine);
    const { page, errors, context } = await openPage();
    try {
      await startCall(page);
      assert.ok(await until(() => engine.calls.length === 1), "the AI got the turn");
      const wavIn = stt.wavs[0];
      assert.equal(wavIn.subarray(0, 4).toString(), "RIFF", "a WAV");
      assert.equal(wavIn.readUInt32LE(24), 16000, "16 kHz, as whisper takes it");
      assert.equal(wavIn.readUInt16LE(22), 1, "mono");
      assert.ok(wavIn.length > 44 + 16000, "about a second or more of sound");

      const ran = engine.calls[0];
      assert.match(ran.prompt, /^what's on today\n\n\(On a voice call: /);
      assert.match(ran.systemParts.volatile, /\[LIVE CALL\]/);
      assert.equal(ran.thinkingSummaries, false);
      const conv = store.get(`channel_conv.${CALL_CHANNEL_KEY}`);
      assert.equal(convs.get(conv).title, "Calls with Atlas");
      assert.deepEqual(convs.getMessages(conv).filter((m) => m.role === "user").map((m) => m.content), ["what's on today"]);

      assert.ok(await until(() => voice.said.some((t) => /meetings/.test(t))), JSON.stringify(voice.said));
      assert.match(voice.said[0], /here/i, "the hello");
      assert.equal(voice.said.find((t) => /meetings/.test(t)), "You have two meetings, at 10 and 2.");
      assert.deepEqual(errors, []);
    } finally {
      await page.evaluate(() => Call.end()).catch(() => {});
      await context.close();
    }
  });

  it("\"stop\" stops the AI's running turn; hanging up while the next one works sends its answer to Telegram", async () => {
    store.set(HANDOFF_SETTING, "telegram");
    store.set("channel_conv.telegram:4242", convs.create({ title: "Telegram chat" }).id);
    stt.heard = ["check the invoices", "stop", "and the weather"];
    let stoppedTurn = null;
    engine = createFakeEngine([
      async (opts) => { stoppedTurn = opts.signal; return [{ type: "wait" }]; },
      [{ type: "sleep", ms: 2500 }, { type: "text", content: "Sunny all day." }, { type: "done", stopReason: "end_turn" }],
    ]);
    registerEngine("claude-code", engine);
    const { page, errors, context } = await openPage();
    try {
      await startCall(page);
      assert.ok(await until(() => engine.calls.length === 1), "the first turn runs");
      assert.ok(await until(() => stoppedTurn?.aborted === true, 12000), "\"stop\" stopped it");
      assert.ok(await until(() => engine.calls.length === 2, 12000), "the next thing said is a turn");
      await page.locator("#callEnd").click();
      await page.waitForFunction(() => /Telegram/.test(document.getElementById("callStatus")?.textContent || ""));
      assert.ok(await until(() => telegram.sent.length === 1, 8000), "the answer went to Telegram");
      assert.deepEqual(telegram.sent[0], { type: "telegram", chatId: "4242", message: "From our call:\n\nSunny all day." });
      const conv = store.get(`channel_conv.${CALL_CHANNEL_KEY}`);
      assert.deepEqual(convs.getMessages(conv).filter((m) => m.role === "user").map((m) => m.content), ["check the invoices", "and the weather"], "\"stop\" is no message");
      assert.ok(!voice.said.some((t) => /Sunny/.test(t)), "hung up: not spoken");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("no speech-to-text on the server: the real route's answer becomes the plain message and the way to Settings > Voice", async () => {
    setStt({ local: { available: () => false } });
    engine = createFakeEngine();
    registerEngine("claude-code", engine);
    const { page, errors, context } = await openPage();
    try {
      await startCall(page);
      await page.locator("#callProblem").waitFor({ state: "visible", timeout: 10000 });
      assert.match(await page.locator("#callProblemText").textContent(), /Speech-to-text isn't set up, so Atlas can't hear you/);
      assert.match(await page.locator("#callProblemDetail").textContent(), /faster-whisper/);
      assert.ok(await page.getByRole("button", { name: "Open Settings → Voice" }).isVisible());
      assert.equal(engine.calls.length, 0, "nothing reached the AI");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
