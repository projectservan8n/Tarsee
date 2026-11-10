// Settings > Voice > Speech-to-text over HTTP (src/routes/voice.js, mounted as server.js mounts it: requireAuth and
// CSRF in front): the status, Install faster-whisper, a model's Download and Delete, and transcribing a short WAV
// (the call's API). The installer's routes are the owner's only (signed in, or the owner's API token, which the
// dashboard itself sends), rate-limited, and one job at a time. A fake Python and a fake download host stand in.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { fakePython } from "./fakes/fake-python.js";
import { fakeDownloadHost } from "./fakes/fake-download-host.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-stt-routes-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
delete process.env.TARSEE_STT_PYTHON;
delete process.env.TARSEE_WHISPER_BUNDLED_DIR;

const config = (await import("../src/config/env.js")).default;
const { sessionAuth, requireAuth, createSession } = await import("../src/middleware/auth.js");
const { csrfProtect, generateCsrfCookie } = await import("../src/middleware/security.js");
const { voiceRouter, createSttRouter } = await import("../src/routes/voice.js");
const runtime = await import("../src/voice/python-runtime.js");
const install = await import("../src/voice/stt-install.js");
const { stopSttWorker } = await import("../src/voice/stt-handler.js");
const { WHISPER_MODELS, MODEL_MARKER, modelFileUrl } = await import("../src/voice/whisper-models.js");
const { gitBlobSha1 } = await import("../src/voice/install-common.js");

const py = fakePython(path.join(tmp, "fake"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const FILES = {};
const CATALOG = {};
for (const [name, m] of Object.entries(WHISPER_MODELS)) {
  FILES[name] = { "config.json": Buffer.from("{}\n"), "model.bin": crypto.randomBytes(8_000), "tokenizer.json": Buffer.from("{}\n"), "vocabulary.txt": Buffer.from("a\n") };
  CATALOG[name] = { ...m, files: Object.entries(FILES[name]).map(([n, b]) => (n === "model.bin" ? { name: n, size: b.length, sha256: sha(b) } : { name: n, size: b.length, gitSha1: gitBlobSha1(b) })) };
}
const hub = () => fakeDownloadHost(Object.fromEntries(Object.entries(FILES).flatMap(([name, files]) => Object.entries(files).map(([n, b]) => [modelFileUrl(CATALOG[name], n), { body: b, chunk: 1_000, delayMs: 2 }]))));

const settings = new Map();
const store = { get: (k) => settings.get(k) ?? null, set: (k, v) => settings.set(k, v), getApiKey: () => null };

let server;
let base;
let csrf;
const session = createSession("127.0.0.1");
const realFetch = globalThis.fetch;

function app(router, mount = "/api/voice") {
  const a = express();
  a.set("trust proxy", 1);
  a.set("settingsStore", store);
  a.use(express.json());
  a.use(sessionAuth);
  a.get("/", generateCsrfCookie, (_req, res) => res.send("ok"));
  a.use(mount, requireAuth, csrfProtect, router);
  return a;
}
async function listen(a) {
  const s = await new Promise((r) => { const x = a.listen(0, "127.0.0.1", () => r(x)); });
  return { s, url: `http://127.0.0.1:${s.address().port}` };
}

before(async () => {
  runtime.__setForTests({ spawn: py.spawn, candidates: [{ cmd: "python3", args: [], source: "system", label: "python3" }] });
  install.__setForTests({ catalog: CATALOG });
  ({ s: server, url: base } = await listen(app(voiceRouter)));
  const r = await realFetch(`${base}/`);
  csrf = /tarsee_csrf=([^;]+)/.exec(r.headers.get("set-cookie"))[1];
});
after(async () => {
  globalThis.fetch = realFetch;
  stopSttWorker();
  runtime.__setForTests();
  install.__setForTests();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  stopSttWorker();
  fs.rmSync(path.join(tmp, "python"), { recursive: true, force: true });
  fs.rmSync(path.join(tmp, "data", "whisper-models"), { recursive: true, force: true });
  py.set({ pythons: { python3: { version: "3.11.4" } }, pip: { mode: "ok", delayMs: 1 }, worker: { mode: "ok" } });
  settings.clear();
  install.resetSttRuntime();
  install.__resetJobsForTests();
  globalThis.fetch = hub().fetch;
});

/** A request as the signed-in owner's browser makes it (session cookie + CSRF token), or as given. */
function call(method, p, { body, headers = {}, as = "owner", url = base } = {}) {
  const h = { ...headers };
  if (as === "owner") { h.Cookie = `tarsee_session=${session}`; h["X-CSRF-Token"] = csrf; }
  if (as === "token") h.Authorization = `Bearer ${config.API_TOKEN}`;
  if (as === "no-csrf") h.Cookie = `tarsee_session=${session}`;
  if (body !== undefined && !Buffer.isBuffer(body)) { h["Content-Type"] = "application/json"; body = JSON.stringify(body); }
  return realFetch(`${url}${p}`, { method, headers: h, body });
}
const json = async (r) => ({ status: r.status, body: await r.json() });
async function untilIdle() {
  for (let i = 0; i < 500; i++) {
    const { body } = await json(await call("GET", "/api/voice/stt"));
    if (!body.job) return body;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the job never finished");
}
function wav() {
  const n = 8000;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36, "latin1"); b.writeUInt32LE(n * 2, 40);
  return b;
}

describe("speech-to-text routes", () => {
  it("are behind sign-in and CSRF, like the other Settings routes", async () => {
    assert.equal((await call("GET", "/api/voice/stt", { as: "nobody" })).status, 401);
    assert.equal((await call("POST", "/api/voice/stt/install", { as: "nobody" })).status, 401);
    assert.equal((await call("POST", "/api/voice/stt/install", { as: "no-csrf" })).status, 403);
    assert.equal((await call("DELETE", "/api/voice/stt/models/base.en", { as: "no-csrf" })).status, 403);
  });

  it("the owner's API token works too (the dashboard itself sends it); a wrong one is a 401", async () => {
    assert.equal((await call("GET", "/api/voice/stt", { as: "token" })).status, 200);
    const r = await json(await call("POST", "/api/voice/stt/models/tiny/download", { as: "token" }));
    assert.equal(r.status, 202);
    await untilIdle();
    const wrong = await realFetch(`${base}/api/voice/stt/install`, { method: "POST", headers: { Authorization: "Bearer not-the-token" } });
    assert.equal(wrong.status, 401);
    assert.equal(install.sttJob(), null, "nothing started");
  });

  it("Install: 202 with the job, progress in the status, then ready; a second job meanwhile is a 409", async () => {
    let r = await json(await call("GET", "/api/voice/stt?refresh=1"));
    assert.equal(r.body.runtime.state, "not-installed");
    assert.equal(r.body.runtime.canInstall, true);

    r = await json(await call("POST", "/api/voice/stt/install"));
    assert.equal(r.status, 202);
    assert.equal(r.body.job.kind, "install");
    const busy = await json(await call("POST", "/api/voice/stt/models/tiny/download"));
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /installing faster-whisper/);
    const during = await json(await call("GET", "/api/voice/stt"));
    assert.equal(during.body.runtime.state, "installing");

    const done = await untilIdle();
    assert.equal(done.runtime.state, "ready", done.runtime.summary);
    assert.equal(done.models.find((m) => m.name === "base.en").state, "downloaded");
  });

  it("a failed install says why in the status, and Try again works", async () => {
    py.set({ pip: { mode: "no-wheel", delayMs: 1 } });
    await call("POST", "/api/voice/stt/install");
    let s = await untilIdle();
    assert.equal(s.runtime.state, "failed");
    assert.match(s.runtime.error, /no ready-made build of ctranslate2/);
    py.set({ pip: { mode: "ok", delayMs: 1 } });
    assert.equal((await call("POST", "/api/voice/stt/install")).status, 202);
    s = await untilIdle();
    assert.equal(s.runtime.state, "ready");
  });

  it("a model's Download and Delete; an unknown model is a 400", async () => {
    let r = await json(await call("POST", "/api/voice/stt/models/small/download"));
    assert.equal(r.status, 202);
    assert.equal(r.body.job.model, "small");
    let s = await untilIdle();
    assert.equal(s.models.find((m) => m.name === "small").state, "downloaded");
    r = await json(await call("DELETE", "/api/voice/stt/models/small"));
    assert.equal(r.status, 200);
    assert.equal(r.body.removed.length, 1);
    s = (await json(await call("GET", "/api/voice/stt"))).body;
    assert.equal(s.models.find((m) => m.name === "small").state, "missing");
    assert.equal((await call("POST", "/api/voice/stt/models/..%2F..%2Fetc/download")).status, 400);
    assert.equal((await call("DELETE", "/api/voice/stt/models/large-v3")).status, 400);
  });

  it("choosing a model that isn't downloaded starts its download", async () => {
    const r = await json(await call("POST", "/api/voice/stt-model", { body: { model: "tiny.en" } }));
    assert.equal(r.status, 200);
    assert.equal(r.body.downloading, true);
    assert.equal(settings.get("voice.stt_model"), "tiny.en");
    const s = await untilIdle();
    assert.equal(s.current, "tiny.en");
    assert.equal(s.models.find((m) => m.name === "tiny.en").state, "downloaded");
    assert.equal((await call("POST", "/api/voice/stt-model", { body: { model: "huge" } })).status, 400);
  });

  it("POST /api/voice/transcribe with a short WAV answers with its text (what a call uses)", async () => {
    py.set({ pythons: { python3: { version: "3.11.2", packages: { "faster-whisper": "1.2.1" } } } });
    install.resetSttRuntime();
    const dir = path.join(tmp, "data", "whisper-models", "base.en");
    fs.mkdirSync(dir, { recursive: true });
    for (const [n, b] of Object.entries(FILES["base.en"])) fs.writeFileSync(path.join(dir, n), b);
    fs.writeFileSync(path.join(dir, MODEL_MARKER), "{}");
    const warm = await json(await call("POST", "/api/voice/stt/warm"));
    assert.deepEqual(warm.body, { ok: true, model: "base.en" });
    const r = await json(await call("POST", "/api/voice/transcribe", { body: wav(), headers: { "Content-Type": "audio/wav", "X-Language": "en" } }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { text: "hello from a wav", language: "en", provider: "faster-whisper (base.en)" });
    const token = await json(await call("POST", "/api/voice/transcribe", { as: "token", body: wav(), headers: { "Content-Type": "audio/wav" } }));
    assert.equal(token.status, 200, "an API client can transcribe");
  });

  it("starting jobs is rate-limited", async () => {
    const { s, url } = await listen(app(createSttRouter({ limits: { max: 2, windowMs: 60_000 } }), "/api/voice/stt"));
    try {
      const a = await call("DELETE", "/api/voice/stt/models/tiny", { url });
      const b = await call("DELETE", "/api/voice/stt/models/tiny", { url });
      const c = await json(await call("DELETE", "/api/voice/stt/models/tiny", { url }));
      assert.deepEqual([a.status, b.status, c.status], [200, 200, 429]);
      assert.match(c.body.error, /Wait \d+ seconds/);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });
});
