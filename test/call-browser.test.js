// A voice call in a real browser (public/js/call.js): the dashboard served from src/public, driven with Playwright's
// Chromium and its fake microphone, which plays a WAV made here (a burst of speech-like sound, then quiet, over and
// over: every loop is one thing said). Speech-to-text (POST /api/voice/transcribe) and the voice (POST
// /api/voice/tts-stream) are fakes; the chat's turns (POST /api/chat/send) stream from this file's own server, as the
// real route does.
//   - the topbar's "Call <name>"; voice mode (its button and full-screen orb) is gone; the composer's mic stays
//   - something said becomes a turn in the call's chat, and its reply is spoken; a Codex AI's messages one at a time
//   - talking over the voice stops it (barge-in); "stop" stops the turn with the chat's Stop
//   - hanging up while it works asks for the handoff and says where the answer goes
//   - the call bar over the composer while the call window is put away: clock, what it's doing, Mute, Show, End
//   - no speech-to-text set up: the call says so, with the way to Settings > Voice; a blocked microphone says so too
//   - the deep ask; Settings > Voice > Calls; the welcome tour's tip; nothing scrolls sideways at phone width
// Runs on Playwright's own Chromium, else an installed Chrome or Edge; skipped where there is none.
/* global document, window, Call, Chat, Setup, Settings, Voice -- the page.evaluate() bodies run in the browser */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = fileURLToPath(new URL("../src/public/", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-call-browser-"));

// --- Sound: what the fake microphone hears, and what the fake voice says -----------------------------------------

/** A 16-bit mono WAV: [{ s: seconds, voice: true|false }]. Voice is a pitch-gliding buzz at syllable pace. */
function wav(parts, rate = 16000) {
  const samples = [];
  let seed = 7;
  const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (const p of parts) {
    const n = Math.round(p.s * rate);
    for (let i = 0; i < n; i++) {
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
// One thing said every 4.2 s: 0.8 s quiet, 1 s of speech, 2.4 s quiet.
const MIC = path.join(tmp, "mic.wav");
fs.writeFileSync(MIC, wav([{ s: 0.8 }, { s: 1.0, voice: true }, { s: 2.4 }]));
/** The fake voice: near-silence that lasts `s` seconds (nothing comes out of the speakers). */
const spoken = (s) => wav([{ s }], 8000);

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

// --- The chat's turns: streamed by this server, as routes/chat.js does -------------------------------------------

/** What POST /api/chat/send got, and the script the next one runs: (body, sse, ctl) => Promise. */
const turns = { sends: [], script: null, held: new Set() };
const sseOf = (res) => (type, data) => { if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
/** A reply on an AI that streams its words (Claude Code). */
const replyWith = (text) => async (body, ev) => {
  ev("conversation", { id: body.conversationId || "conv-call" });
  ev("model_selected", { model: "sonnet", provider: "claude", label: "Claude Sonnet", streaming: true });
  for (const part of text.match(/.{1,12}/gs)) { ev("text", { content: part }); await new Promise((r) => setTimeout(r, 15)); }
  ev("done", { conversationId: body.conversationId, stopReason: "end_turn" });
};
/** A turn that runs until Stop (POST /api/chat/stop) or the end of the test. */
const working = () => (body, ev) => new Promise((resolve) => {
  ev("conversation", { id: body.conversationId || "conv-call" });
  ev("model_selected", { model: "sonnet", provider: "claude", label: "Claude Sonnet", streaming: true });
  const end = () => { ev("done", { conversationId: body.conversationId, stopReason: "stopped" }); resolve(); };
  turns.held.add(end);
});
const stopHeld = () => { for (const end of [...turns.held]) { turns.held.delete(end); end(); } };

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".svg": "image/svg+xml" };
let server;
let origin;
before(async () => {
  if (!browser) return;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/chat/send" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      turns.sends.push(body);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const script = turns.script || replyWith("Done.");
      try { await script(body, sseOf(res), turns); } finally { res.end(); }
      return;
    }
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
  stopHeld();
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- A fake /api -------------------------------------------------------------------------------------------------

/**
 * transcripts: what each thing said is heard as, in order (a string, or { status, error } for a failure); "" after.
 * speak(text): how long the fake voice talks for it, in seconds. start: POST /api/call/start's answer (merged).
 * handoff: POST /api/call/handoff's answer. callSettings: GET /api/call/settings' answer.
 */
function fakeApi({ botName = "Atlas", transcripts = [], speak = () => 0.3, start = {}, handoff = { ok: false, channel: null, label: null, reason: "off" }, callSettings = { channel: null, choices: [] } } = {}) {
  const calls = [];
  const state = { transcripts: [...transcripts], tts: [], callSettings };
  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const p = url.pathname;
    if (p === "/api/chat/send") return route.fallback();
    let body = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ method, path: p, body });
    const json = (status, data) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

    if (p === "/api/auth/status") return json(200, { authenticated: true, needsPassword: true });
    if (p === "/api/auth/api-token") return json(200, { apiToken: null });
    if (p === "/api/settings/setup-status") return json(200, { needsSetup: false, needsPersonality: false, botName, provider: "claude-code", hasKey: true });
    if (p === "/api/settings" && method === "GET") return json(200, { settings: [{ key: "identity.name", value: botName }] });
    if (p === "/api/chat/channels") return json(200, { channels: [] });
    if (p === "/api/chat/models") {
      return json(200, {
        picker: { groups: [{ provider: "claude", label: "Claude plan", kind: "subscription", defaultModel: "sonnet", sections: [{ id: "main", label: null, entries: [{ id: "sonnet", name: "Sonnet 5.5", provider: "claude", ref: "claude:sonnet", alias: "sonnet", family: "sonnet", badges: [] }] }] }], unavailable: [] },
        defaults: { provider: "claude", model: "sonnet", ref: "claude:sonnet", effort: "medium" },
        models: [],
      });
    }
    if (p.startsWith("/api/chat/conversations/") && p.endsWith("/picker")) return json(200, { provider: null, model: null, effort: null });
    if (p.startsWith("/api/chat/conversations/")) return json(200, { id: p.split("/").pop(), title: `Calls with ${botName}`, messages: [], totalMessages: 0, leadFiles: [], recap: null, liveSeq: 0, activeTurn: null, deliveredClientIds: [] });
    if (p === "/api/chat/stop") { stopHeld(); return json(200, { ok: true, stopped: true }); }
    if (p === "/api/call/start") return json(200, { conversationId: "conv-call", title: `Calls with ${botName}`, created: false, botName, deep: null, handoff: null, ...start });
    if (p === "/api/call/handoff") return json(200, handoff);
    if (p === "/api/call/settings" && method === "GET") return json(200, state.callSettings);
    if (p === "/api/call/settings" && method === "PUT") {
      state.callSettings = { ...state.callSettings, channel: body?.channel || null };
      return json(200, { ok: true, ...state.callSettings });
    }
    if (p === "/api/voice/transcribe") {
      const next = state.transcripts.length ? state.transcripts.shift() : "";
      if (next?.abort) return route.abort("failed");   // no answer at all: the network
      if (next && typeof next === "object") return json(next.status, { error: next.error });
      return json(200, { text: next, language: "en", provider: "fake" });
    }
    if (p === "/api/voice/tts-stream") {
      const text = String(body?.text || "");
      state.tts.push(text);
      return route.fulfill({ status: 200, contentType: "audio/wav", body: spoken(speak(text)) });
    }
    return json(200, {});
  }
  return { calls, state, handle };
}

async function openPage({ width = 1280, height = 900, hasTouch = false, isMobile = false, ...opts } = {}) {
  turns.sends = [];
  turns.script = null;
  stopHeld();
  const api = fakeApi(opts);
  const context = await browser.newContext({ viewport: { width, height }, hasTouch, isMobile, serviceWorkers: "block", permissions: ["microphone"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route((url) => !url.href.startsWith(origin), (route) => route.abort());
  await page.route(`${origin}/api/**`, (route) => api.handle(route));
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`${origin}/`);
  await page.locator("#callBtn").waitFor();
  return { page, api, errors, context };
}

/** Press the call button and wait until it listens. */
async function startCall(page) {
  await page.locator("#callBtn").click();
  await page.locator("#callOverlay:not([hidden])").waitFor();
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
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const transcript = (page) => page.locator("#callTranscript .call-line").allInnerTexts();
const shot = async (page, name) => {
  if (process.env.AI_UI_SHOTS) await page.screenshot({ path: path.join(process.env.AI_UI_SHOTS, `${name}.png`), fullPage: true });
};

describe("a voice call in the browser", { skip }, () => {
  it("the topbar says Call <name>; voice mode's button and full-screen orb are gone; the composer's mic stays", async () => {
    const { page, errors, context } = await openPage();
    try {
      const btn = page.locator("#callBtn");
      await page.waitForFunction(() => document.getElementById("callBtn")?.getAttribute("aria-label") === "Call Atlas");
      assert.equal(await btn.getAttribute("title"), "Call Atlas");
      assert.ok(await btn.isVisible());
      for (const gone of ["#voiceModeBtn", "#voicePanel", "#voiceOrb", ".voice-orb", ".voice-orb-container", "#voiceWaveform"]) {
        assert.equal(await page.locator(gone).count(), 0, `${gone} is gone`);
      }
      assert.equal(await page.locator("#voiceInputBtn").count(), 1, "dictation in the composer stays");
      const left = await page.evaluate(() => ["open", "close", "speak", "startRecording", "setOrbState"].filter((k) => typeof Voice[k] === "function"));
      assert.deepEqual(left, [], "no voice mode left in the code");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("something said becomes a turn in the call's chat, and the reply is spoken", async () => {
    const { page, api, errors, context } = await openPage({ transcripts: ["what's on today"] });
    turns.script = replyWith("You have **two** meetings today.");
    try {
      await startCall(page);
      assert.equal(await page.locator("#callTitle").textContent(), "Call Atlas");
      assert.match(await page.locator("#callHint").textContent(), /talk over Atlas/i);
      assert.ok(await until(() => turns.sends.length === 1), "one turn");
      assert.equal(turns.sends[0].message, "[call] what's on today");
      assert.equal(turns.sends[0].conversationId, "conv-call");
      assert.equal(turns.sends[0].model, undefined, "the chat's own AI and model: no deep ask here");
      assert.ok(await until(() => api.state.tts.some((t) => /two meetings/.test(t))), `spoken: ${JSON.stringify(api.state.tts)}`);
      assert.match(api.state.tts[0], /here/i, "it says hello first");
      const said = api.state.tts.find((t) => /two meetings/.test(t));
      assert.equal(said, "You have two meetings today.", "spoken without the chat's formatting");
      assert.ok(await until(async () => (await transcript(page)).length >= 2));
      assert.deepEqual(await transcript(page), ["You: what's on today", "Atlas: You have two meetings today."]);
      assert.ok(await until(() => page.evaluate(() => Call.state === "listening")), "listening again after speaking");
      const calls = api.calls.map((c) => `${c.method} ${c.path}`);
      assert.ok(calls.includes("POST /api/call/start") && calls.includes("POST /api/voice/transcribe"));
      assert.deepEqual(errors, []);
    } finally {
      await page.evaluate(() => Call.end()).catch(() => {});
      await context.close();
    }
  });

  it("talking over the voice stops it (barge-in), and what was said still becomes a turn", async () => {
    // The hello lasts 6 s; something is said 0.8 s in.
    const { page, api, errors, context } = await openPage({ transcripts: ["sorry, one thing"], speak: (t) => (/here/i.test(t) ? 6 : 0.3) });
    try {
      await startCall(page);
      assert.ok(await until(() => page.evaluate(() => Call.state === "speaking"), 5000), "the hello is playing");
      const t0 = Date.now();
      assert.ok(await until(() => page.evaluate(() => Call.bargeIns > 0 && Call.audio.paused && Call.state !== "speaking"), 4000), "the voice stopped for the person");
      assert.ok(Date.now() - t0 < 5000, "well before the 6 s hello ended");
      assert.ok(await until(() => turns.sends.length === 1));
      assert.equal(turns.sends[0].message, "[call] sorry, one thing");
      assert.ok(api.state.tts.length >= 1);
      assert.deepEqual(errors, []);
    } finally {
      await page.evaluate(() => Call.end()).catch(() => {});
      await context.close();
    }
  });

  it("\"stop\" stops the turn with the chat's Stop, and the call listens again", async () => {
    const { page, api, errors, context } = await openPage({ transcripts: ["look up the weather", "stop"] });
    turns.script = working();
    try {
      await startCall(page);
      assert.ok(await until(() => turns.sends.length === 1), "the first thing said is a turn");
      assert.ok(await until(() => page.evaluate(() => Call.state === "thinking")), "working on it");
      assert.ok(await until(() => api.calls.some((c) => c.path === "/api/chat/stop"), 12000), "stop was said");
      assert.deepEqual(api.calls.find((c) => c.path === "/api/chat/stop").body, { conversationId: "conv-call" });
      assert.equal(turns.sends.length, 1, "\"stop\" is not sent to the AI");
      assert.ok(await until(() => page.evaluate(() => Call.state === "listening")));
      const lines = await transcript(page);
      assert.ok(lines.includes("You: stop"), JSON.stringify(lines));
      assert.ok(lines.includes("Atlas: (Stopped.)"), JSON.stringify(lines));
      assert.deepEqual(errors, []);
    } finally {
      await page.evaluate(() => Call.end()).catch(() => {});
      await context.close();
    }
  });

  it("hanging up while it works asks for the handoff and says where the answer goes; Off says it stays in the chat", async () => {
    let { page, api, errors, context } = await openPage({ transcripts: ["send me the report"], handoff: { ok: true, channel: "telegram", label: "Telegram" } });
    turns.script = working();
    try {
      await startCall(page);
      assert.ok(await until(() => turns.sends.length === 1));
      await page.locator("#callEnd").click();
      assert.ok(await until(() => api.calls.some((c) => c.path === "/api/call/handoff")), "the handoff was asked for");
      assert.deepEqual(api.calls.find((c) => c.path === "/api/call/handoff").body, { conversationId: "conv-call" });
      await page.waitForFunction(() => /Telegram/.test(document.getElementById("callStatus")?.textContent || ""));
      assert.match(await page.locator("#callStatus").textContent(), /^Call ended\. Atlas is still working and will send the answer to Telegram\.$/);
      assert.equal(await page.evaluate(() => Call.stream), null, "the microphone is let go");
      assert.equal(await page.evaluate(() => Call.state), "ended");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }

    ({ page, api, errors, context } = await openPage({ transcripts: ["send me the report"] }));
    turns.script = working();
    try {
      await startCall(page);
      assert.ok(await until(() => turns.sends.length === 1));
      await page.locator("#callEnd").click();
      await page.waitForFunction(() => /chat/.test(document.getElementById("callStatus")?.textContent || ""));
      assert.match(await page.locator("#callStatus").textContent(), /Atlas is still working.*answer will be in the call's chat/);
      assert.ok(await page.getByRole("button", { name: "Open the call's chat" }).isVisible());
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("hanging up with nothing running asks for no handoff", async () => {
    const { page, api, errors, context } = await openPage();
    try {
      await startCall(page);
      await page.locator("#callEnd").click();
      await page.waitForFunction(() => Call.state === "ended");
      assert.equal(await page.locator("#callStatus").textContent(), "Call ended.");
      assert.ok(!api.calls.some((c) => c.path === "/api/call/handoff"));
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("the call bar: the window put away, the bar over the composer has the clock, what it's doing, Mute, Show and End (and fits a phone)", async () => {
    const { page, errors, context } = await openPage({ width: 375, height: 800 });
    try {
      await startCall(page);
      assert.ok(await noSideScroll(page), "the call window fits a phone");
      await shot(page, "call-window-phone");
      await page.locator("#callMinimize").click();
      await page.locator("#callOverlay").waitFor({ state: "hidden" });
      const bar = page.locator("#callBar");
      await bar.waitFor({ state: "visible" });
      assert.equal(await bar.locator(".call-bar-title").textContent(), "Call with Atlas");
      assert.match(await bar.locator(".call-bar-clock").textContent(), /^\d+:\d\d$/);
      assert.ok(await until(async () => /Listening|speaking/.test(await bar.locator(".call-bar-now").textContent())));
      assert.ok(await noSideScroll(page), "the bar fits a phone");
      await shot(page, "call-bar-phone");
      assert.ok(await page.locator("#callBtn.on-call").isVisible(), "the topbar shows a call is on");

      await bar.locator('[data-call="mute"]').click();
      assert.equal(await bar.locator('[data-call="mute"]').textContent(), "Unmute");
      assert.equal(await bar.locator('[data-call="mute"]').getAttribute("aria-pressed"), "true");
      assert.equal(await page.evaluate(() => Call.muted && Call.stream.getAudioTracks().every((t) => !t.enabled)), true, "the microphone is off");
      assert.ok(await until(async () => (await bar.locator(".call-bar-now").textContent()) === "Muted" || (await page.evaluate(() => Call.state)) === "speaking"));
      await bar.locator('[data-call="mute"]').click();
      assert.equal(await page.evaluate(() => Call.muted), false);

      await bar.locator('[data-call="show"]').click();
      await page.locator("#callOverlay:not([hidden])").waitFor();
      assert.equal(await bar.isVisible(), false, "no bar while the window shows");
      await page.keyboard.press("Escape");
      await bar.waitFor({ state: "visible" });
      await bar.locator('[data-call="end"]').click();
      await page.waitForFunction(() => Call.state === "ended");
      assert.equal(await bar.isVisible(), false, "the call is over: no bar");
      assert.equal(await page.locator("#callBtn.on-call").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("the screen is kept on during a call, and let go after", async () => {
    const { page, context } = await openPage();
    try {
      await page.evaluate(() => {
        window.__locks = [];
        Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async (type) => { const l = { type, released: false, release: async () => { l.released = true; } }; window.__locks.push(l); return l; } } });
      });
      await startCall(page);
      assert.ok(await until(() => page.evaluate(() => window.__locks.length === 1 && window.__locks[0].type === "screen")));
      await page.evaluate(() => Call.end());
      assert.ok(await until(() => page.evaluate(() => window.__locks[0].released)));
    } finally {
      await context.close();
    }
  });

  it("no speech-to-text set up: the call says so plainly, with the way to Settings > Voice", async () => {
    const error = "Speech-to-text is unavailable: local transcription (faster-whisper) is not installed on this server. The paid OpenAI Whisper API is off; to use it instead, choose \"OpenAI Whisper API\" in Settings > Voice > Speech-to-Text.";
    const { page, errors, context } = await openPage({ transcripts: [{ status: 501, error }] });
    try {
      await startCall(page);
      const problem = page.locator("#callProblem");
      await problem.waitFor({ state: "visible", timeout: 10000 });
      assert.match(await problem.textContent(), /Speech-to-text isn't set up, so Atlas can't hear you/);
      assert.equal(await page.evaluate(() => Call.state), "ended", "the call ends: it can't hear anything");
      assert.equal(turns.sends.length, 0);
      assert.match(await page.locator("#callProblemDetail").textContent(), /faster-whisper\) is not installed/, "and the server's own reason");
      await page.getByRole("button", { name: "Open Settings → Voice" }).click();
      await page.locator('.settings-tab-panel[data-tab="voice"].active').waitFor();
      assert.equal(await page.locator("#callOverlay").isVisible(), false, "the window makes way for Settings");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("a microphone that is blocked is said plainly", async () => {
    const { page, context } = await openPage();
    try {
      await page.evaluate(() => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
      });
      await page.locator("#callBtn").click();
      await page.waitForFunction(() => /Microphone/.test(document.getElementById("callStatus")?.textContent || ""));
      assert.match(await page.locator("#callStatus").textContent(), /Microphone access was blocked\. Allow it for this site/);
      assert.equal(await page.locator("#callEnd").textContent(), "Close");
    } finally {
      await context.close();
    }
  });

  it("an AI that sends a message at a time (Codex): each is spoken when it arrives", async () => {
    const { page, api, errors, context } = await openPage({ transcripts: ["plan my day"] });
    let spokeFirstEarly = false;
    turns.script = async (body, ev) => {
      ev("conversation", { id: body.conversationId });
      ev("model_selected", { model: "gpt-6-luna", provider: "chatgpt", label: "GPT-6 Luna", streaming: false });
      ev("text", { content: "First, the gym." });
      spokeFirstEarly = await until(() => api.state.tts.includes("First, the gym."), 5000);
      ev("text", { content: "\n\nThen lunch with the team." });
      ev("done", { conversationId: body.conversationId, stopReason: "end_turn" });
    };
    try {
      await startCall(page);
      assert.ok(await until(() => api.state.tts.includes("Then lunch with the team."), 12000), JSON.stringify(api.state.tts));
      assert.ok(spokeFirstEarly, "the first message was spoken before the turn finished");
      assert.equal(api.state.tts.filter((t) => /gym/.test(t)).length, 1, "and not again at the end");
      assert.ok(await until(async () => (await transcript(page)).length >= 3));
      assert.deepEqual(await transcript(page), ["You: plan my day", "Atlas: First, the gym.", "Atlas: Then lunch with the team."]);
      assert.deepEqual(errors, []);
    } finally {
      await page.evaluate(() => Call.end()).catch(() => {});
      await context.close();
    }
  });

  it("the deep ask: \"think hard\" runs that turn on the call AI's top model, and the window says so", async () => {
    const { page, errors, context } = await openPage({ transcripts: ["think hard about my week"], start: { deep: { model: "top", label: "Claude Opus" } } });
    try {
      await startCall(page);
      assert.match(await page.locator("#callHint").textContent(), /"think hard".*Claude Opus/);
      assert.ok(await until(() => turns.sends.length === 1));
      assert.equal(turns.sends[0].model, "top");
      assert.deepEqual(errors, []);
    } finally {
      await page.evaluate(() => Call.end()).catch(() => {});
      await context.close();
    }
  });

  it("whisper's inventions on breath and room noise are not sent", async () => {
    const { page, errors, context } = await openPage({ transcripts: ["Thank you.", "[BLANK_AUDIO]", "what's next"] });
    try {
      await startCall(page);
      assert.ok(await until(() => turns.sends.length === 1, 16000));
      assert.equal(turns.sends[0].message, "[call] what's next");
      assert.deepEqual(errors, []);
    } finally {
      await page.evaluate(() => Call.end()).catch(() => {});
      await context.close();
    }
  });

  it("Settings > Voice > Calls: Send the answer to, Off by default, the connected channels, saved when chosen", async () => {
    const { page, api, errors, context } = await openPage({ width: 375, height: 800, callSettings: { channel: null, choices: [{ id: "telegram", label: "Telegram", connected: true }] } });
    try {
      await page.evaluate(() => Settings.open());
      await page.evaluate(() => Settings.switchTab("voice"));
      const select = page.locator("#callHandoffChannel");
      await page.waitForFunction(() => document.querySelectorAll("#callHandoffChannel option").length === 2);
      assert.deepEqual(await select.locator("option").allInnerTexts(), ["Off (it stays in the call's chat)", "Telegram"]);
      assert.equal(await select.inputValue(), "");
      await select.selectOption("telegram");
      assert.ok(await until(() => api.calls.some((c) => c.method === "PUT" && c.path === "/api/call/settings")));
      assert.deepEqual(api.calls.find((c) => c.method === "PUT" && c.path === "/api/call/settings").body, { channel: "telegram" });
      assert.ok(await noSideScroll(page));
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("a speech-to-text failure in the middle of a call is said with the server's reason; the call goes on", async () => {
    const reason = "Speech-to-text failed: local transcription (faster-whisper) could not transcribe this audio (the server log has the details).";
    const { page, errors, context } = await openPage({ transcripts: [{ status: 500, error: reason }, { status: 500, error: reason }] });
    try {
      await startCall(page);
      assert.ok(await until(async () => (await transcript(page)).some((l) => /Didn't catch that/.test(l)), 12000));
      await page.locator("#callProblem").waitFor({ state: "visible", timeout: 12000 });
      assert.match(await page.locator("#callProblemDetail").textContent(), /could not transcribe this audio/, "the second miss in a row says why");
      assert.ok(await page.getByRole("button", { name: "Open Settings → Voice" }).isVisible());
      assert.ok(await page.evaluate(() => Call.isOn()), "a miss doesn't end the call");
      assert.deepEqual(errors, []);
    } finally {
      await page.evaluate(() => Call.end()).catch(() => {});
      await context.close();
    }
  });

  it("the welcome tour's first tip points at the call button, in new words", async () => {
    const { page, context } = await openPage();
    try {
      await page.evaluate(() => Setup.showWelcomeTour());
      const tip = page.locator("#welcomeTip");
      await tip.waitFor();
      const text = await tip.textContent();
      assert.match(text, /Call Atlas/);
      assert.doesNotMatch(text, /voice mode|hold to talk/i);
      const { tipTop, btnBottom } = await page.evaluate(() => ({
        tipTop: document.querySelector("#welcomeTip > div").getBoundingClientRect().top,
        btnBottom: document.getElementById("callBtn").getBoundingClientRect().bottom,
      }));
      assert.ok(tipTop >= btnBottom, "under the call button");
    } finally {
      await context.close();
    }
  });
});

// The composer's microphone (js/voice.js): dictation. What was said goes into the message box at the caret, with what
// was typed kept, and is never sent by itself; a failure says why, with the way to fix it. The same helper
// (SpeechToText) explains a call's failures.
describe("dictation in the message box", { skip }, () => {
  /** Tap the mic, let it record a moment, tap again. */
  async function dictate(page, ms = 1200) {
    const mic = page.locator("#voiceInputBtn");
    await mic.click();
    await page.locator("#voiceInputBtn.voice-active").waitFor({ timeout: 5000 });
    await page.waitForTimeout(ms);
    await mic.click();
  }
  const posts = (api) => turns.sends.length + api.calls.filter((c) => c.path === "/api/chat/send").length;

  it("puts the words in the box at the caret, keeps what was typed, sends nothing, and the box has the focus", async () => {
    const { page, api, errors, context } = await openPage({ transcripts: ["at four"] });
    try {
      await page.evaluate(() => { window.__sends = 0; const send = Chat.send.bind(Chat); Chat.send = (...a) => { window.__sends++; return send(...a); }; });
      const box = page.locator("#messageInput");
      await box.fill("Meet Sam tomorrow");
      await box.evaluate((el) => el.setSelectionRange(8, 8));   // the caret after "Meet Sam"
      await dictate(page);
      await page.waitForFunction(() => /at four/.test(document.getElementById("messageInput").value));
      assert.equal(await box.inputValue(), "Meet Sam at four tomorrow");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "messageInput");
      assert.equal(await page.evaluate(() => document.getElementById("messageInput").selectionStart), "Meet Sam at four".length, "the caret after the words");
      assert.equal(await page.locator("#sendBtn").isDisabled(), false, "ready to send");
      await page.waitForTimeout(500);
      assert.equal(posts(api), 0, "nothing sent");
      assert.equal(await page.evaluate(() => window.__sends), 0, "Send is the owner's");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("a selection is kept, not replaced; an empty box gets just the words", async () => {
    const { page, errors, context } = await openPage({ transcripts: ["please", "hello there"] });
    try {
      const box = page.locator("#messageInput");
      await box.fill("Call me");
      await box.evaluate((el) => el.setSelectionRange(0, 4));   // "Call" chosen
      await dictate(page);
      await page.waitForFunction(() => /please/.test(document.getElementById("messageInput").value));
      assert.equal(await box.inputValue(), "Call please me", "added after the chosen words, which stay");
      await box.fill("");
      await dictate(page);
      await page.waitForFunction(() => document.getElementById("messageInput").value === "hello there");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("on a phone the box gets the focus without the keyboard popping up; a tap on the box brings it back", async () => {
    const { page, errors, context } = await openPage({ width: 390, height: 844, transcripts: ["buy milk"], hasTouch: true, isMobile: true });
    try {
      await dictate(page);
      await page.waitForFunction(() => document.getElementById("messageInput").value === "buy milk");
      const state = await page.evaluate(() => ({ focused: document.activeElement?.id, mode: document.getElementById("messageInput").getAttribute("inputmode") }));
      assert.deepEqual(state, { focused: "messageInput", mode: "none" }, "focused, with no keyboard");
      await page.locator("#messageInput").tap();
      assert.equal(await page.locator("#messageInput").getAttribute("inputmode"), null, "tapped: the keyboard may come");
      assert.ok(await noSideScroll(page));
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("no speech-to-text set up: the server's reason by the box, with Open Settings → Voice at speech-to-text; nothing sent", async () => {
    const reason = "Speech-to-text is unavailable: local transcription (faster-whisper) is not installed on this server. The paid OpenAI Whisper API is off; to use it instead, choose \"OpenAI Whisper API\" in Settings > Voice > Speech-to-Text.";
    const { page, api, errors, context } = await openPage({ width: 375, height: 800, transcripts: [{ status: 501, error: reason }] });
    try {
      await page.locator("#messageInput").fill("draft");
      await dictate(page);
      const note = page.locator("#micNote");
      await note.waitFor({ state: "visible", timeout: 8000 });
      assert.match(await note.textContent(), /Speech-to-text isn't set up/);
      assert.ok((await note.textContent()).includes(reason), "the server's own words, whole");
      assert.equal(await page.locator("#messageInput").inputValue(), "draft", "the box is as it was");
      assert.equal(posts(api), 0);
      assert.ok(await noSideScroll(page));
      await shot(page, "dictation-no-stt-phone");
      await note.getByRole("button", { name: "Open Settings → Voice" }).click();
      await page.locator('.settings-tab-panel[data-tab="voice"].active').waitFor();
      assert.ok(await until(() => page.evaluate(() => {
        const r = document.getElementById("settingsSTTProvider")?.closest(".settings-section")?.getBoundingClientRect();
        return !!r && r.top < window.innerHeight && r.bottom > 0;
      }), 3000), "at speech-to-text");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("the server couldn't transcribe it: its reason; no answer at all: a plain network message and Try again", async () => {
    const reason = "Speech-to-text failed: local transcription (faster-whisper) could not transcribe this audio (the server log has the details).";
    const { page, errors, context } = await openPage({ transcripts: [{ status: 500, error: reason }, { abort: true }, "good to go"] });
    try {
      const note = page.locator("#micNote");
      await dictate(page);
      await note.waitFor({ state: "visible", timeout: 8000 });
      assert.ok((await note.textContent()).includes(reason));
      assert.ok(await note.getByRole("button", { name: "Open Settings → Voice" }).isVisible());

      await dictate(page);
      await page.waitForFunction(() => /reach Tarsee/.test(document.getElementById("micNote")?.textContent || ""));
      assert.match(await note.textContent(), /Couldn't reach Tarsee.*Check the connection/);
      assert.equal(await note.getByRole("button", { name: "Open Settings → Voice" }).count(), 0, "not a setting to change");
      await note.getByRole("button", { name: "Try again" }).click();
      await page.waitForFunction(() => document.getElementById("messageInput").value === "good to go");
      assert.equal(await note.isVisible(), false, "the note goes once it worked");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("the note can be closed", async () => {
    const { page, context } = await openPage({ transcripts: [{ status: 501, error: "Speech-to-text is unavailable: nothing is installed." }] });
    try {
      await dictate(page);
      const note = page.locator("#micNote");
      await note.waitFor({ state: "visible", timeout: 8000 });
      await note.getByRole("button", { name: "Close" }).click();
      assert.equal(await note.isVisible(), false);
    } finally {
      await context.close();
    }
  });
});
