// The paid OpenAI Whisper API transcribes only when the owner chose it (Settings > Voice > STT Provider =
// "OpenAI Whisper API", setting voice.stt_provider = "whisper-api"). It used to be a silent last resort: any OpenAI
// key, including an OPENAI_API_KEY saved on the server for something else, turned on paid transcription whenever
// local faster-whisper was missing or failed. Local transcription is swapped for a stub (__setForTests) and fetch is
// replaced with a counter, so these tests never run Python and never reach the network.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-stt-opt-in-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { transcribeAudio, __setForTests } = await import("../src/voice/stt-handler.js");

const KEY = "sk-test-canary-stt-0000";
const AUDIO = Buffer.from("not really audio");

/** Every request made through fetch, and what the next one answers. */
const calls = [];
let answer;
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return answer();
  };
});

after(() => {
  globalThis.fetch = realFetch;
  __setForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  answer = () => ({ ok: true, status: 200, json: async () => ({ text: "from the paid api" }), text: async () => "" });
  __setForTests();
});

/** A settings store with the given voice.stt_provider and OpenAI key. */
function store({ provider, key = KEY } = {}) {
  const values = { "voice.stt_provider": provider };
  return { get: (k) => values[k] ?? null, getApiKey: (id) => (id === "openai" ? key : null) };
}

/** Local faster-whisper that is not installed. */
const notInstalled = { available: () => false, transcribe: async () => { throw new Error("local transcriber was called"); } };

describe("speech-to-text: the paid Whisper API is opt-in", () => {
  it("makes no paid call when an OpenAI key is only in the server's env and local is not installed", async () => {
    // The real settings store, with no STT provider chosen (so: local) and the key only in the environment.
    const db = initDb(path.join(tmp, "tarsee.db"));
    const settings = new SettingsStore(db);
    const before = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = KEY;
    __setForTests({ local: notInstalled });
    try {
      assert.equal(settings.getApiKey("openai"), KEY, "the env key is visible to the settings store");
      await assert.rejects(transcribeAudio(AUDIO, "en", { settingsStore: settings }), (err) => {
        assert.equal(err.status, 501);
        assert.match(err.message, /local/i);
        assert.match(err.message, /not installed/i);
        assert.match(err.message, /Whisper API/);
        assert.match(err.message, /Settings > Voice/);
        return true;
      });
      assert.equal(calls.length, 0, "the paid Whisper API was called without the owner choosing it");
    } finally {
      if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before;
      db.close();
    }
  });

  it("makes no paid call when the provider is local and local transcription fails", async () => {
    __setForTests({ local: { available: () => true, transcribe: async () => { throw new Error("ffmpeg exited 1"); } } });
    await assert.rejects(transcribeAudio(AUDIO, "en", { settingsStore: store({ provider: "local" }) }), (err) => {
      assert.match(err.message, /local/i);
      assert.match(err.message, /failed/i);
      assert.match(err.message, /Settings > Voice/);
      return true;
    });
    assert.equal(calls.length, 0, "the paid Whisper API was called as a fallback for a failed local transcription");
  });

  it("uses local transcription, and nothing paid, when local works", async () => {
    __setForTests({ local: { available: () => true, transcribe: async () => ({ transcript: "local words", language: "en", provider: "faster-whisper (base.en)" }) } });
    const out = await transcribeAudio(AUDIO, "en", { settingsStore: store({ provider: "local" }) });
    assert.equal(out.transcript, "local words");
    assert.equal(calls.length, 0);
  });

  it("uses the Whisper API when the owner chose it", async () => {
    __setForTests({ local: notInstalled });
    const out = await transcribeAudio(AUDIO, "en-US", { settingsStore: store({ provider: "whisper-api" }) });
    assert.equal(out.provider, "whisper-api");
    assert.equal(out.transcript, "from the paid api");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  });

  it("calls the chosen Whisper API once, not again as a last resort, when it fails and local is not installed", async () => {
    __setForTests({ local: notInstalled });
    answer = () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "upstream error" });
    await assert.rejects(transcribeAudio(AUDIO, "en", { settingsStore: store({ provider: "whisper-api" }) }), (err) => {
      assert.match(err.message, /Whisper API/);
      assert.match(err.message, /failed/i);
      return true;
    });
    assert.equal(calls.length, 1, "the paid API was retried");
  });

  it("falls back to free local transcription when the chosen Whisper API fails", async () => {
    __setForTests({ local: { available: () => true, transcribe: async () => ({ transcript: "local words", language: "en", provider: "faster-whisper (base.en)" }) } });
    answer = () => ({ ok: false, status: 429, json: async () => ({}), text: async () => "rate limited" });
    const out = await transcribeAudio(AUDIO, "en", { settingsStore: store({ provider: "whisper-api" }) });
    assert.equal(out.transcript, "local words");
    assert.equal(calls.length, 1);
  });

  it("says the key is missing when the Whisper API is chosen without one and local is not installed", async () => {
    __setForTests({ local: notInstalled });
    await assert.rejects(transcribeAudio(AUDIO, "en", { settingsStore: store({ provider: "whisper-api", key: null }) }), (err) => {
      assert.match(err.message, /Whisper API/);
      assert.match(err.message, /no OpenAI API key/i);
      assert.match(err.message, /Settings > Voice/);
      return true;
    });
    assert.equal(calls.length, 0);
  });
});
