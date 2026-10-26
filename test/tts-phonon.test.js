import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Remember where a real Phonon install would be before pointing everything at
// throwaway folders (config/env.js creates its directories on import).
const REAL_PHONON_DIR = process.env.TARSEE_PHONON_DIR
  || path.join(process.env.TARSEE_DATA_DIR || path.join(process.env.TARSEE_STATE_DIR || path.join(os.homedir(), ".tarsee"), "data"), "tts", "phonon");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-phonon-test-"));
process.env.TARSEE_STATE_DIR = TMP;
process.env.TARSEE_DATA_DIR = path.join(TMP, "data");
process.env.TARSEE_PHONON_DIR = path.join(TMP, "phonon-none");

const { initTTSEngine, getTTSEngine, FallbackTTSEngine, enginePreference, fallbackVoiceFor } = await import("../src/voice/engine-registry.js");
const { speakPesos, cleanSpeechText, phononSpeechText } = await import("../src/voice/speech-text.js");
const {
  PhononTTSEngine, phononInstalled, phononPaths, speedToDelta, clampSpeed, findVoice, DEFAULT_VOICE, SPEED_MAX, SPEED_MIN,
} = await import("../src/voice/phonon-engine.js");
const {
  installPhonon, downloadFile, acquireLock, autoInstallPhonon, getPhononInstallStatus, checkPhononInstall, hfUrl,
} = await import("../src/voice/phonon-install.js");

/** A settings store with just get/set, as initTTSEngine uses it. */
function store(values = {}) {
  const m = new Map(Object.entries(values));
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v) };
}

/** A fake engine that records what happens to it. */
function fakeEngine(name, { available = true, fail = null } = {}) {
  return {
    name,
    calls: [],
    speeds: [],
    stopped: 0,
    async isAvailable() { return available; },
    setSpeed(s) { this.speeds.push(s); },
    async synthesize(text, voiceId) {
      this.calls.push({ text, voiceId });
      if (fail) throw fail;
      return { audio: Buffer.from(`${name}:${text}`), contentType: "audio/wav" };
    },
    async listVoices() { return []; },
    stop() { this.stopped++; },
  };
}

/** Loaders for every engine, recording which were consulted and with which voice. */
function loaders(map) {
  const used = [];
  const out = {};
  for (const name of ["piper", "elevenlabs", "edge-tts", "phonon"]) {
    out[name] = async (_s, voice) => {
      used.push(name);
      if (!map[name]) return null;
      const e = map[name];
      e.builtWithVoice = voice;
      return e;
    };
  }
  return { loaders: out, used };
}

describe("TTS engine choice: Phonon is the default", () => {
  it("with voice.engine unset, Phonon is used, with Edge TTS behind it", async () => {
    const phonon = fakeEngine("phonon");
    const l = loaders({ phonon, "edge-tts": fakeEngine("edge-tts"), elevenlabs: fakeEngine("elevenlabs") });
    await initTTSEngine(store(), l);
    assert.equal(enginePreference(store()), "phonon");
    assert.equal(getTTSEngine().name, "phonon");
    assert.ok(getTTSEngine() instanceof FallbackTTSEngine);
    assert.deepEqual(l.used, ["phonon"], "Edge TTS is only built when it is needed");
  });

  it("an install with an ElevenLabs key that never saved an engine keeps ElevenLabs", async () => {
    const saved = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      assert.equal(enginePreference(store({ "voice.elevenlabs.apiKey": "sk_test" })), "elevenlabs");
      assert.equal(enginePreference(store({ "voice.elevenlabs.apiKey": "sk_test", "voice.engine": "phonon" })), "phonon", "a saved choice wins");
      process.env.ELEVENLABS_API_KEY = "sk_env";
      const withGetApiKey = { ...store(), getApiKey: (id) => (id === "elevenlabs" ? process.env.ELEVENLABS_API_KEY : null) };
      assert.equal(enginePreference(withGetApiKey), "elevenlabs", "a key in the environment counts too");
    } finally {
      if (saved === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = saved;
    }
  });

  it("Phonon not installed yet: Edge TTS speaks, with its own default voice", async () => {
    const edge = fakeEngine("edge-tts");
    const l = loaders({ phonon: fakeEngine("phonon", { available: false }), "edge-tts": edge, elevenlabs: fakeEngine("elevenlabs"), piper: fakeEngine("piper") });
    await initTTSEngine(store({ "voice.defaultVoiceId": "toby" }), l);
    assert.equal(getTTSEngine(), edge);
    assert.deepEqual(l.used, ["phonon", "edge-tts"]);
    assert.equal(edge.builtWithVoice, undefined, "a non-Edge voice id is not handed to Edge TTS");
  });

  it("Phonon not installed yet: Edge TTS keeps an Edge voice the user picked", async () => {
    const edge = fakeEngine("edge-tts");
    await initTTSEngine(store({ "voice.defaultVoiceId": "en-GB-SoniaNeural" }), loaders({ "edge-tts": edge }));
    assert.equal(edge.builtWithVoice, "en-GB-SoniaNeural");
  });

  it("never falls back to ElevenLabs (it costs money), even with Phonon and Edge both gone", async () => {
    const l = loaders({ elevenlabs: fakeEngine("elevenlabs") });
    await initTTSEngine(store(), l);
    assert.equal(getTTSEngine().name, "stub");
    assert.ok(!l.used.includes("elevenlabs"), `consulted: ${l.used.join(", ")}`);
  });

  it("an explicit engine choice is respected: Phonon is never built", async () => {
    for (const pick of ["edge-tts", "elevenlabs", "piper"]) {
      const picked = fakeEngine(pick);
      const l = loaders({ [pick]: picked, phonon: fakeEngine("phonon") });
      await initTTSEngine(store({ "voice.engine": pick, "voice.defaultVoiceId": "v1" }), l);
      assert.equal(getTTSEngine(), picked);
      assert.deepEqual(l.used, [pick]);
      assert.equal(picked.builtWithVoice, "v1");
    }
  });

  it("auto: Phonon first when installed, then the old order", async () => {
    let l = loaders({ phonon: fakeEngine("phonon"), piper: fakeEngine("piper") });
    await initTTSEngine(store({ "voice.engine": "auto" }), l);
    assert.equal(getTTSEngine().name, "phonon");

    const el = fakeEngine("elevenlabs");
    l = loaders({ phonon: fakeEngine("phonon", { available: false }), elevenlabs: el, "edge-tts": fakeEngine("edge-tts") });
    await initTTSEngine(store({ "voice.engine": "auto" }), l);
    assert.equal(getTTSEngine(), el);
    assert.deepEqual(l.used, ["phonon", "piper", "elevenlabs"]);
  });

  it("Phonon gets its own speed setting", async () => {
    const phonon = fakeEngine("phonon");
    await initTTSEngine(store({ "voice.phonon.speed": "1.1" }), loaders({ phonon }));
    assert.deepEqual(phonon.speeds, [1.1]);
  });

  it("switching from Phonon to another engine lets the Phonon worker go", async () => {
    const phonon = fakeEngine("phonon");
    const edge = fakeEngine("edge-tts");
    const s = store();
    await initTTSEngine(s, loaders({ phonon, "edge-tts": edge }));
    await initTTSEngine(s, loaders({ phonon, "edge-tts": edge })); // Phonon to Phonon: kept
    assert.equal(phonon.stopped, 0);
    s.set("voice.engine", "edge-tts");
    await initTTSEngine(s, loaders({ phonon, "edge-tts": edge }));
    assert.equal(getTTSEngine(), edge);
    assert.equal(phonon.stopped, 1);
  });

  it("the newest init wins when several overlap (a burst of settings saves)", async () => {
    let releaseSlow;
    const slow = new Promise((r) => { releaseSlow = r; });
    const old = fakeEngine("piper");
    const newer = fakeEngine("edge-tts");
    const first = initTTSEngine(store({ "voice.engine": "piper" }), {
      loaders: { piper: async () => { await slow; return old; } },
    });
    await initTTSEngine(store({ "voice.engine": "edge-tts" }), loaders({ "edge-tts": newer }));
    releaseSlow();
    await first;
    assert.equal(getTTSEngine(), newer);
  });
});

describe("TTS fallback: Edge TTS speaks when Phonon fails", () => {
  let s;
  beforeEach(() => { s = store({ "voice.phonon.voice": "toby" }); });

  it("a failed Phonon sentence is spoken by Edge TTS, without Phonon's voice id", async () => {
    const phonon = fakeEngine("phonon", { fail: new Error("worker died") });
    const edge = fakeEngine("edge-tts");
    await initTTSEngine(s, loaders({ phonon, "edge-tts": edge }));
    const out = await getTTSEngine().synthesize("Hello there.", "toby");
    assert.equal(out.audio.toString(), "edge-tts:Hello there.");
    assert.equal(edge.calls[0].voiceId, undefined, "Edge would fail on the voice \"toby\"");
    assert.equal(getTTSEngine().name, "phonon", "still Phonon: it is tried again next time");
  });

  it("an Edge voice id is passed through to Edge TTS", async () => {
    const edge = fakeEngine("edge-tts");
    await initTTSEngine(s, loaders({ phonon: fakeEngine("phonon", { fail: new Error("x") }), "edge-tts": edge }));
    await getTTSEngine().synthesize("Hi", "en-US-AvaMultilingualNeural");
    assert.equal(edge.calls[0].voiceId, "en-US-AvaMultilingualNeural");
  });

  it("the fallback is built with the user's Edge voice only when it is one", async () => {
    for (const [saved, want] of [["en-PH-RosaNeural", "en-PH-RosaNeural"], ["toby", undefined], ["wNl2YBRc8v5uIcq6gOxd", undefined]]) {
      const edge = fakeEngine("edge-tts");
      await initTTSEngine(store({ "voice.defaultVoiceId": saved }), loaders({ phonon: fakeEngine("phonon", { fail: new Error("x") }), "edge-tts": edge }));
      await getTTSEngine().synthesize("Hi");
      assert.equal(edge.builtWithVoice, want, `voice.defaultVoiceId=${saved}`);
    }
  });

  it("after three failures in a row Phonon is skipped for a while, then tried again", async () => {
    const phonon = fakeEngine("phonon", { fail: new Error("stuck") });
    const edge = fakeEngine("edge-tts");
    await initTTSEngine(s, loaders({ phonon, "edge-tts": edge }));
    const tts = getTTSEngine();
    for (let i = 0; i < 5; i++) await tts.synthesize(`line ${i}`);
    assert.equal(phonon.calls.length, 3);
    assert.equal(edge.calls.length, 5);
    tts._skipUntil = Date.now() - 1; // the pause is over
    phonon.synthesize = async (text) => ({ audio: Buffer.from(`phonon:${text}`), contentType: "audio/wav" });
    const back = await tts.synthesize("back");
    assert.equal(back.audio.toString(), "phonon:back");
  });

  it("nothing to say is not a failure: no fallback", async () => {
    const phonon = fakeEngine("phonon", { fail: Object.assign(new Error("No speakable text after cleanup"), { code: "EMPTY_TEXT" }) });
    const edge = fakeEngine("edge-tts");
    await initTTSEngine(s, loaders({ phonon, "edge-tts": edge }));
    await assert.rejects(getTTSEngine().synthesize("```code```"), /No speakable text/);
    assert.equal(edge.calls.length, 0);
  });

  it("with Edge TTS missing too, the Phonon error comes through", async () => {
    await initTTSEngine(s, loaders({ phonon: fakeEngine("phonon", { fail: new Error("worker died") }) }));
    await assert.rejects(getTTSEngine().synthesize("Hello"), /worker died/);
  });

  it("fallbackVoiceFor only keeps Edge voice ids", () => {
    assert.equal(fallbackVoiceFor("edge-tts", "en-US-AndrewMultilingualNeural"), "en-US-AndrewMultilingualNeural");
    assert.equal(fallbackVoiceFor("edge-tts", "fil-PH-AngeloNeural"), "fil-PH-AngeloNeural");
    assert.equal(fallbackVoiceFor("edge-tts", "toby"), undefined);
    assert.equal(fallbackVoiceFor("edge-tts", "phonon:toby"), undefined);
    assert.equal(fallbackVoiceFor("edge-tts", undefined), undefined);
  });
});

describe("Phonon text: pesos and cleanup", () => {
  it("₱ and PHP amounts are written out so Phonon reads them", () => {
    assert.equal(speakPesos("The invoice is ₱12,500, plus ₱3,750."), "The invoice is 12,500 pesos, plus 3,750 pesos.");
    assert.equal(speakPesos("PHP 2,500 and Php1.5M and ₱ 300k"), "2,500 pesos and 1.5 million pesos and 300 thousand pesos");
    assert.equal(speakPesos("₱12,500 pesos lang"), "12,500 pesos lang");
    assert.equal(speakPesos("₱1,250,000.50."), "1,250,000.50 pesos.");
    assert.equal(speakPesos("₱5 each"), "5 pesos each");
  });

  it("PHP the programming language is left alone", () => {
    assert.equal(speakPesos("Upgrade to PHP 8.3 first"), "Upgrade to PHP 8.3 first");
    assert.equal(speakPesos("runs on PHP 7"), "runs on PHP 7");
    assert.equal(speakPesos("PHP 5.6.40 is old"), "PHP 5.6.40 is old");
    assert.equal(speakPesos("PHP 8 pesos"), "8 pesos", "with the word pesos it is money");
    assert.equal(speakPesos("PHP 500"), "500 pesos");
  });

  it("a bare P is money only when the barePeso option is on", () => {
    assert.equal(speakPesos("P2,500 or P99.50"), "P2,500 or P99.50");
    assert.equal(speakPesos("P2,500 or P99.50", { barePeso: true }), "2,500 pesos or 99.50 pesos");
    assert.equal(speakPesos("a P1 bug, P2 and MP3", { barePeso: true }), "a P1 bug, P2 and MP3");
    assert.equal(phononSpeechText("Total: P1,200", { barePeso: true }), "Total: 1,200 pesos");
    assert.equal(phononSpeechText("Total: P1,200"), "Total: P1,200");
  });

  it("the cleanup drops emoji, code and markdown", () => {
    assert.equal(cleanSpeechText("**Hi** \u{1F600} `code` [link](http://x)\n\nnext\nline"), "Hi link. next line");
    assert.equal(phononSpeechText("**Paid** ₱500 \u{1F44D}\u{FE0F}"), "Paid 500 pesos");
    assert.equal(cleanSpeechText("```js\nx()\n```"), "");
  });

  it("the engine reads the barePeso option it was built with (off by default)", () => {
    assert.equal(new PhononTTSEngine("toby").speechText("P2,500 and ₱300"), "P2,500 and 300 pesos");
    assert.equal(new PhononTTSEngine("toby", { barePeso: true }).speechText("P2,500 and ₱300"), "2,500 pesos and 300 pesos");
  });
});

describe("Phonon voices and speed", () => {
  it("speed maps to the model's duration condition, inside the range it holds", () => {
    assert.equal(speedToDelta(1.0), 0);
    assert.ok(speedToDelta(1.1) < 0 && speedToDelta(1.25) < speedToDelta(1.1), "faster is a more negative delta");
    assert.ok(speedToDelta(0.9) > 0);
    assert.equal(speedToDelta(3), speedToDelta(SPEED_MAX));
    assert.equal(speedToDelta(0.1), speedToDelta(SPEED_MIN));
    assert.equal(clampSpeed("1.3"), SPEED_MAX);
    assert.equal(clampSpeed("nonsense"), 1.0);
  });

  it("voices: names, ids and other engines' ids", () => {
    assert.equal(DEFAULT_VOICE, "toby");
    assert.equal(findVoice("Toby").id, "toby");
    assert.equal(findVoice("phonon:teddy").id, "teddy");
    assert.equal(findVoice("en-US-AndrewMultilingualNeural"), null);
    assert.equal(new PhononTTSEngine("en-US-AndrewMultilingualNeural").defaultVoice, DEFAULT_VOICE);
    assert.equal(new PhononTTSEngine("Harper").defaultVoice, "harper");
  });

  it("an empty install folder is not available (so Edge TTS takes over)", async () => {
    assert.equal(phononInstalled(), false);
    assert.equal(await new PhononTTSEngine().isAvailable(), false);
  });
});

// ── Installer, with a fake Hugging Face ─────────────────────────────────

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** A fake fetch serving `files` ({ url: Buffer|string }), counting requests per URL. */
function fakeHub(files) {
  const hits = {};
  const fetch = async (url) => {
    hits[url] = (hits[url] || 0) + 1;
    const body = files[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return new Response(buf, { status: 200, headers: { "content-length": String(buf.length) } });
  };
  return { fetch, hits };
}

const MODEL = {
  repo: "test/model",
  revision: "rev1",
  files: [
    { name: "config.json" },
    { name: "model.q8.gguf", sha256: sha(Buffer.from("weights")) },
  ],
};
const VOICES = { repo: "test/voices", revision: "rev2", language: "en", locales: ["en-us", "en-gb"] };
const VOICE_LIST = [
  { name: "Toby", filename: "voices/toby.safetensors", language: "en", locale: "en-gb" },
  { name: "Zoey", filename: "voices/zoey.safetensors", language: "en", locale: "en-us" },
  { name: "Remy", filename: "voices/remy.safetensors", language: "fr", locale: "fr-fr" },
].map((v) => JSON.stringify(v)).join("\n");

function hubFiles(overrides = {}) {
  return {
    [hfUrl(MODEL.repo, MODEL.revision, "config.json")]: "{}",
    [hfUrl(MODEL.repo, MODEL.revision, "model.q8.gguf")]: "weights",
    [hfUrl(VOICES.repo, VOICES.revision, "voices.jsonl")]: VOICE_LIST,
    [hfUrl(VOICES.repo, VOICES.revision, "voices/toby.safetensors")]: "toby",
    [hfUrl(VOICES.repo, VOICES.revision, "voices/zoey.safetensors")]: "zoey",
    [hfUrl(VOICES.repo, VOICES.revision, "README.md")]: "# voices",
    ...overrides,
  };
}

describe("Phonon installer", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(TMP, "phonon-"));
    process.env.TARSEE_PHONON_DIR = dir;
  });
  afterEach(() => {
    process.env.TARSEE_PHONON_DIR = path.join(TMP, "phonon-none");
  });

  const fakeRuntime = { ensureRuntime: async () => {}, smokeTest: async () => "ok", log: () => {}, retryDelayMs: 1 };

  it("downloadFile keeps a file whose sha256 matches and rejects one that does not", async () => {
    const good = Buffer.from("weights");
    const { fetch } = fakeHub({ "https://x/good": good, "https://x/bad": "tampered" });
    const dest = path.join(dir, "m", "model.bin");
    assert.equal(await downloadFile({ url: "https://x/good", dest, sha256: sha(good), fetchImpl: fetch }), sha(good));
    assert.equal(fs.readFileSync(dest, "utf8"), "weights");

    const bad = path.join(dir, "m", "other.bin");
    await assert.rejects(
      downloadFile({ url: "https://x/bad", dest: bad, sha256: sha(good), fetchImpl: fetch, retryDelayMs: 1 }),
      (err) => err.code === "HASH_MISMATCH",
    );
    assert.equal(fs.existsSync(bad), false, "nothing is renamed into place");
    assert.equal(fs.existsSync(`${bad}.part`), false, "the partial file is removed");
  });

  it("downloadFile does not fetch a file that is already there and verified", async () => {
    const { fetch, hits } = fakeHub({ "https://x/f": "weights" });
    const dest = path.join(dir, "f.bin");
    fs.writeFileSync(dest, "weights");
    assert.equal(await downloadFile({ url: "https://x/f", dest, sha256: sha(Buffer.from("weights")), fetchImpl: fetch }), "kept");
    assert.equal(hits["https://x/f"], undefined);
    fs.writeFileSync(dest, "corrupt");
    await downloadFile({ url: "https://x/f", dest, sha256: sha(Buffer.from("weights")), fetchImpl: fetch });
    assert.equal(fs.readFileSync(dest, "utf8"), "weights", "a file that fails its hash is downloaded again");
  });

  it("installs the model and only the English voices, then marks it installed", async () => {
    const { fetch } = fakeHub(hubFiles());
    const done = [];
    const status = await installPhonon({ ...fakeRuntime, fetch, model: MODEL, voices: VOICES, onInstalled: () => done.push(1) });
    assert.equal(status.state, "installed");
    assert.equal(status.percent, 100);
    assert.deepEqual(done, [1], "the engine is re-initialised once");
    const p = phononPaths();
    assert.equal(phononInstalled(p), true);
    assert.ok(fs.existsSync(p.marker));
    assert.equal(fs.readFileSync(path.join(p.model, "model.q8.gguf"), "utf8"), "weights");
    const catalog = fs.readFileSync(path.join(p.catalog, "voices.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).name);
    assert.deepEqual(catalog, ["Toby", "Zoey"]);
    assert.ok(fs.existsSync(path.join(p.catalog, "voices", "toby.safetensors")));
    assert.ok(!fs.existsSync(path.join(p.catalog, "voices", "remy.safetensors")));
    assert.ok(!fs.existsSync(path.join(dir, ".install.lock")), "the lock is released");
  });

  it("a tampered model fails the install (status failed, no marker), and a retry works", async () => {
    const bad = fakeHub(hubFiles({ [hfUrl(MODEL.repo, MODEL.revision, "model.q8.gguf")]: "tampered" }));
    await assert.rejects(installPhonon({ ...fakeRuntime, fetch: bad.fetch, model: MODEL, voices: VOICES }), /sha256/);
    const st = getPhononInstallStatus();
    assert.equal(st.state, "failed");
    assert.match(st.error, /sha256/);
    assert.ok(!fs.existsSync(phononPaths().marker));
    assert.ok(!fs.existsSync(path.join(dir, ".install.lock")), "the lock is released after a failure");

    const good = fakeHub(hubFiles());
    await installPhonon({ ...fakeRuntime, fetch: good.fetch, model: MODEL, voices: VOICES });
    assert.ok(fs.existsSync(phononPaths().marker));
    assert.equal(good.hits[hfUrl(MODEL.repo, MODEL.revision, "config.json")], undefined, "files already in place are kept");
  });

  it("a model that does not load is not marked installed; its unverified files are dropped for the retry", async () => {
    const { fetch } = fakeHub(hubFiles());
    const smokeTest = async () => { throw new Error("the downloaded model did not load: bad config"); };
    await assert.rejects(installPhonon({ ...fakeRuntime, smokeTest, fetch, model: MODEL, voices: VOICES }), /did not load/);
    const p = phononPaths();
    assert.ok(!fs.existsSync(p.marker));
    assert.equal(phononInstalled(p), false);
    assert.ok(!fs.existsSync(path.join(p.model, "config.json")), "no published hash: fetched again next time");
    assert.ok(fs.existsSync(path.join(p.model, "model.q8.gguf")), "verified weights are kept");
  });

  it("files on disk with no usable Python runtime read as failed, so Retry can repair it", async () => {
    const { fetch } = fakeHub(hubFiles());
    await installPhonon({ ...fakeRuntime, fetch, model: MODEL, voices: VOICES });
    const prev = process.env.TARSEE_PHONON_PYTHON;
    process.env.TARSEE_PHONON_PYTHON = path.join(dir, "no-such-python");
    try {
      assert.equal(getPhononInstallStatus().state, "installed", "the files are all there");
      const st = await checkPhononInstall();
      assert.equal(st.state, "failed");
      assert.match(st.error, /cannot import ptts/);
      assert.equal(await new PhononTTSEngine().isAvailable(), false, "so Edge TTS speaks");
    } finally {
      if (prev === undefined) delete process.env.TARSEE_PHONON_PYTHON; else process.env.TARSEE_PHONON_PYTHON = prev;
    }
  });

  it("concurrent installs share one run", async () => {
    const { fetch, hits } = fakeHub(hubFiles());
    const a = installPhonon({ ...fakeRuntime, fetch, model: MODEL, voices: VOICES });
    const b = installPhonon({ ...fakeRuntime, fetch, model: MODEL, voices: VOICES });
    assert.equal(a, b);
    assert.equal(getPhononInstallStatus().state, "installing");
    await a;
    assert.equal(hits[hfUrl(MODEL.repo, MODEL.revision, "model.q8.gguf")], 1);
  });

  it("the lock keeps a second installer out, and a stale lock is taken over", async () => {
    const release = acquireLock(dir);
    assert.throws(() => acquireLock(dir), (err) => err.code === "LOCKED");
    release();
    acquireLock(dir)();

    // Left by a process that is gone.
    fs.writeFileSync(path.join(dir, ".install.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: new Date().toISOString() }));
    acquireLock(dir)();
    // Left by an earlier container that had this same pid.
    fs.writeFileSync(path.join(dir, ".install.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    acquireLock(dir)();

    // Held by a live process (the parent of this test): the install fails with LOCKED.
    fs.writeFileSync(path.join(dir, ".install.lock"), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
    const { fetch } = fakeHub(hubFiles());
    await assert.rejects(installPhonon({ ...fakeRuntime, fetch, model: MODEL, voices: VOICES }), (err) => err.code === "LOCKED");
    assert.ok(fs.existsSync(path.join(dir, ".install.lock")), "someone else's lock is left alone");
  });

  it("a voice list naming a path outside the catalog is refused", async () => {
    const evil = JSON.stringify({ name: "Evil", filename: "../../escape.sh", language: "en", locale: "en-us" });
    const { fetch } = fakeHub(hubFiles({ [hfUrl(VOICES.repo, VOICES.revision, "voices.jsonl")]: evil }));
    await assert.rejects(installPhonon({ ...fakeRuntime, fetch, model: MODEL, voices: VOICES }), /unsafe file/);
    assert.ok(!fs.existsSync(path.join(dir, "..", "escape.sh")));
  });

  it("the background install on boot: only for Phonon, only when missing, once, and can be turned off", async () => {
    const calls = [];
    const install = async (o) => { calls.push(o); };
    const prev = process.env.TARSEE_PHONON_AUTO_INSTALL;
    try {
      process.env.TARSEE_PHONON_AUTO_INSTALL = "0";
      assert.equal(autoInstallPhonon(store(), { install, delayMs: 0 }), false);
      delete process.env.TARSEE_PHONON_AUTO_INSTALL;
      assert.equal(autoInstallPhonon(store({ "voice.engine": "edge-tts" }), { install, delayMs: 0 }), false);
      assert.equal(autoInstallPhonon(store({ "voice.engine": "auto" }), { install, delayMs: 0 }), false);
      const onInstalled = () => {};
      assert.equal(autoInstallPhonon(store(), { install, delayMs: 0, onInstalled }), true);
      assert.equal(autoInstallPhonon(store({ "voice.engine": "phonon" }), { install, delayMs: 0 }), false, "one attempt per boot");
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].onInstalled, onInstalled);
    } finally {
      if (prev === undefined) delete process.env.TARSEE_PHONON_AUTO_INSTALL; else process.env.TARSEE_PHONON_AUTO_INSTALL = prev;
    }
  });
});

// ── The real worker, where Phonon is installed ──────────────────────────

const realInstalled = (() => {
  const prev = process.env.TARSEE_PHONON_DIR;
  process.env.TARSEE_PHONON_DIR = REAL_PHONON_DIR;
  try { return phononInstalled(); } finally { process.env.TARSEE_PHONON_DIR = prev; }
})();

describe("Phonon worker (real)", { skip: !realInstalled && "Phonon is not installed on this machine" }, () => {
  it("speaks a line through the real worker and stops cleanly", async () => {
    const prev = process.env.TARSEE_PHONON_DIR;
    process.env.TARSEE_PHONON_DIR = REAL_PHONON_DIR;
    const tts = new PhononTTSEngine("toby");
    try {
      assert.equal(await tts.isAvailable(), true);
      const { audio, contentType } = await tts.synthesize("On it. That is ₱2,500.", "en-US-AndrewMultilingualNeural");
      assert.equal(contentType, "audio/wav");
      assert.equal(audio.subarray(0, 4).toString(), "RIFF");
      assert.ok(audio.length > 24000, `a second or more of 24 kHz audio (${audio.length} bytes)`);
    } finally {
      tts.stop();
      process.env.TARSEE_PHONON_DIR = prev;
    }
  });
});
