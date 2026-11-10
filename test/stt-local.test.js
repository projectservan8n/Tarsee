// Local speech-to-text end to end (src/voice/stt-handler.js): a short WAV goes to the persistent faster-whisper worker
// (stt_worker.py's protocol, spoken here by a fake Python) running on the Python stt-install.js found, with a model
// folder on disk, and comes back as text. The worker stays warm between recordings, comes back after a crash, is
// stopped when it hangs, and when the chosen model isn't downloaded the closest one transcribes while the chosen one
// downloads. This is the API a call uses: transcribeAudio, and POST /api/voice/transcribe on top of it.
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePython } from "./fakes/fake-python.js";
import { fakeDownloadHost } from "./fakes/fake-download-host.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-stt-local-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
delete process.env.TARSEE_STT_PYTHON;
delete process.env.TARSEE_WHISPER_BUNDLED_DIR;

const runtime = await import("../src/voice/python-runtime.js");
const install = await import("../src/voice/stt-install.js");
const { transcribeAudio, warmSTT, stopSttWorker, __setForTests } = await import("../src/voice/stt-handler.js");
const { WHISPER_MODELS, MODEL_MARKER, modelFileUrl } = await import("../src/voice/whisper-models.js");
const { gitBlobSha1 } = await import("../src/voice/install-common.js");

const py = fakePython(path.join(tmp, "fake"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const MODELS = path.join(tmp, "data", "whisper-models");

// Small stand-ins for the models.
const FILES = {};
const CATALOG = {};
for (const [name, m] of Object.entries(WHISPER_MODELS)) {
  FILES[name] = { "config.json": Buffer.from("{}\n"), "model.bin": crypto.randomBytes(5_000), "tokenizer.json": Buffer.from("{}\n"), "vocabulary.txt": Buffer.from("a\n") };
  CATALOG[name] = { ...m, files: Object.entries(FILES[name]).map(([n, b]) => (n === "model.bin" ? { name: n, size: b.length, sha256: sha(b) } : { name: n, size: b.length, gitSha1: gitBlobSha1(b) })) };
}
function putModel(name) {
  const dir = path.join(MODELS, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, b] of Object.entries(FILES[name])) fs.writeFileSync(path.join(dir, n), b);
  fs.writeFileSync(path.join(dir, MODEL_MARKER), "{}");
}

/** A 16 kHz mono 16-bit WAV of `ms` milliseconds of a tone. */
function wav(ms = 500) {
  const n = Math.round(16 * ms);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36, "latin1"); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((i / 16000) * 2 * Math.PI * 440)), 44 + i * 2);
  return b;
}
const store = (values = {}) => ({ get: (k) => values[k] ?? null, getApiKey: () => null });
const workerStarts = () => py.calls().filter((c) => c.args?.some((a) => /stt_worker\.py$/.test(a))).length;
const workerRequests = () => py.calls().filter((c) => c.worker).map((c) => c.worker);

before(() => {
  runtime.__setForTests({ spawn: py.spawn, candidates: [{ cmd: "python3", args: [], source: "system", label: "python3" }] });
  install.__setForTests({ catalog: CATALOG });
});
after(() => {
  stopSttWorker();
  __setForTests();
  runtime.__setForTests();
  install.__setForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  stopSttWorker();
  __setForTests();
  fs.rmSync(MODELS, { recursive: true, force: true });
  py.set({ pythons: { python3: { version: "3.11.2", packages: { "faster-whisper": "1.2.1" } } }, worker: { mode: "ok" } });
  py.clearCalls();
  install.resetSttRuntime();
  install.__resetJobsForTests();
});

describe("local speech-to-text", () => {
  it("transcribes a short WAV, with the model folder and English for an English-only model; the worker stays warm", async () => {
    putModel("base.en");
    const out = await transcribeAudio(wav(), "en-US", { settingsStore: store() });
    assert.equal(out.transcript, "hello from a wav");
    assert.equal(out.provider, "faster-whisper (base.en)");
    assert.equal(out.language, "en");
    const [req] = workerRequests();
    assert.equal(req.model, path.join(MODELS, "base.en"), "a folder on disk, never a model name");
    assert.equal(req.language, "en");
    assert.match(req.audio, /\.wav$/);
    assert.equal(fs.existsSync(req.audio), false, "the recording's temporary file is removed");

    await transcribeAudio(wav(), "en", { settingsStore: store() });
    assert.equal(workerStarts(), 1, "one worker for both recordings");
  });

  it("a model for many languages finds the language itself", async () => {
    putModel("small");
    const out = await transcribeAudio(wav(), "en", { settingsStore: store({ "voice.stt_model": "small" }) });
    assert.equal(out.provider, "faster-whisper (small)");
    assert.equal(workerRequests()[0].language, null);
  });

  it("the chosen model not downloaded: the closest one on disk transcribes, and the chosen one downloads", async () => {
    putModel("base.en");
    const host = fakeDownloadHost(Object.fromEntries(Object.entries(FILES["small.en"]).map(([n, b]) => [modelFileUrl(CATALOG["small.en"], n), { body: b }])));
    const realFetch = globalThis.fetch;
    globalThis.fetch = host.fetch;
    try {
      const out = await transcribeAudio(wav(), "en", { settingsStore: store({ "voice.stt_model": "small.en" }) });
      assert.equal(out.provider, "faster-whisper (base.en)");
      while (install.sttJob()) await new Promise((r) => setTimeout(r, 10));
      assert.ok(host.hits[modelFileUrl(CATALOG["small.en"], "model.bin")] >= 1, "small.en was downloaded");
      const again = await transcribeAudio(wav(), "en", { settingsStore: store({ "voice.stt_model": "small.en" }) });
      assert.equal(again.provider, "faster-whisper (small.en)");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("no model on disk at all: a 503 that says one is downloading", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeDownloadHost({}).fetch;
    try {
      await assert.rejects(transcribeAudio(wav(), "en", { settingsStore: store() }), (err) => {
        assert.equal(err.status, 503);
        assert.equal(err.code, "stt-unavailable", "channels pass this message on");
        assert.match(err.message, /downloading base\.en/);
        return true;
      });
      while (install.sttJob()) await new Promise((r) => setTimeout(r, 10));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a model whose download just failed isn't downloaded again on every recording", async () => {
    const realFetch = globalThis.fetch;
    const host = fakeDownloadHost({});
    globalThis.fetch = host.fetch;
    try {
      await assert.rejects(transcribeAudio(wav(), "en", { settingsStore: store() }), /downloading base\.en/);
      while (install.sttJob()) await new Promise((r) => setTimeout(r, 10));
      const asked = host.requests.length;
      assert.ok(asked > 0);
      await assert.rejects(transcribeAudio(wav(), "en", { settingsStore: store() }), (err) => err.status === 503 && /Download one in Settings > Voice > Speech-to-text/.test(err.message));
      assert.equal(host.requests.length, asked, "not tried again straight away");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("faster-whisper not installed: a 501 that says where to install it", async () => {
    py.set({ pythons: { python3: { version: "3.11.2" } } });
    putModel("base.en");
    await assert.rejects(transcribeAudio(wav(), "en", { settingsStore: store() }), (err) => {
      assert.equal(err.status, 501);
      assert.match(err.message, /not installed/);
      assert.match(err.message, /Settings > Voice > Speech-to-text/);
      return true;
    });
  });

  it("a worker that crashes is started again for the next recording", async () => {
    putModel("base.en");
    py.set({ worker: { mode: "crash" } });
    await assert.rejects(transcribeAudio(wav(), "en", { settingsStore: store() }), (err) => err.code === "stt-failed" && err.status === 500);
    py.set({ worker: { mode: "ok" } });
    const out = await transcribeAudio(wav(), "en", { settingsStore: store() });
    assert.equal(out.transcript, "hello from a wav");
    assert.equal(workerStarts(), 2);
  });

  it("a worker that hangs is stopped after the time limit, and the next recording gets a fresh one", async () => {
    putModel("base.en");
    __setForTests({ timeoutMs: 400 });
    py.set({ worker: { mode: "hang" } });
    const t0 = Date.now();
    await assert.rejects(transcribeAudio(wav(), "en", { settingsStore: store() }), (err) => err.code === "stt-failed");
    assert.ok(Date.now() - t0 < 5_000);
    py.set({ worker: { mode: "ok" } });
    assert.equal((await transcribeAudio(wav(), "en", { settingsStore: store() })).transcript, "hello from a wav");
  });

  it("warmSTT loads the model ahead of the first recording (a call opening)", async () => {
    putModel("base.en");
    assert.deepEqual(await warmSTT(store()), { ok: true, model: "base.en" });
    assert.equal(workerStarts(), 1);
    await transcribeAudio(wav(), "en", { settingsStore: store() });
    assert.equal(workerStarts(), 1, "the warm worker answers");
    py.set({ pythons: { python3: { version: "3.11.2" } } });
    install.resetSttRuntime();
    const cold = await warmSTT(store());
    assert.equal(cold.ok, false);
    assert.match(cold.error, /not installed/);
  });

  it("an idle worker stops by itself to give its memory back", async () => {
    putModel("base.en");
    __setForTests({ idleMs: 100 });
    await transcribeAudio(wav(), "en", { settingsStore: store() });
    await new Promise((r) => setTimeout(r, 400));
    await transcribeAudio(wav(), "en", { settingsStore: store() });
    assert.equal(workerStarts(), 2, "stopped while idle, started again when needed");
  });
});
