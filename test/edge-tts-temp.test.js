import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the system temp folder at a throwaway one, so the test can see every file
// Edge TTS leaves behind. os.tmpdir() reads these on each call (TEMP/TMP on
// Windows, TMPDIR elsewhere), and node --test runs this file in its own process.
const REAL_TMP = os.tmpdir();
const TMP = fs.mkdtempSync(path.join(REAL_TMP, "tarsee-edge-tts-test-"));
process.env.TMPDIR = TMP;
process.env.TEMP = TMP;
process.env.TMP = TMP;

const { EdgeTTSEngine, __setForTests } = await import("../src/voice/edge-tts-engine.js");

/**
 * A stand-in for node-edge-tts's EdgeTTS class: no network. It records every file
 * it was asked to write and writes `bytes` of fake audio there, or fails as told.
 */
function fakeEdge({ bytes = 400, fail = null, hang = false, delayMs = 0 } = {}) {
  const calls = [];
  class FakeEdgeTTS {
    constructor(opts) { this.opts = opts; }
    async ttsPromise(text, audioPath) {
      calls.push({ text, audioPath, voice: this.opts.voice, existedBefore: fs.existsSync(audioPath) });
      // Like the real one: the file is opened before the audio comes in.
      fs.writeFileSync(audioPath, Buffer.alloc(0));
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (hang) return new Promise(() => {});
      if (fail) throw fail;
      fs.writeFileSync(audioPath, Buffer.alloc(bytes, 7));
    }
  }
  return { EdgeTTS: FakeEdgeTTS, calls };
}

const leftovers = () => fs.readdirSync(TMP);

/** Every file the fake was given sat in the temp folder and is gone, and nothing else was left there. */
function assertTidy(fake) {
  assert.ok(fake.calls.length > 0, "Edge TTS was never asked for audio");
  for (const { audioPath } of fake.calls) {
    assert.equal(path.dirname(audioPath), os.tmpdir(), `audio went to ${audioPath}`);
    assert.equal(fs.existsSync(audioPath), false, `${audioPath} was left behind`);
  }
  assert.deepEqual(leftovers(), []);
}

describe("Edge TTS keeps its audio in the system temp folder", () => {
  before(() => { assert.equal(os.tmpdir(), TMP, "the test could not move the temp folder"); });
  beforeEach(() => {
    for (const f of leftovers()) fs.rmSync(path.join(TMP, f), { force: true, recursive: true });
  });
  after(() => {
    __setForTests();
    fs.rmSync(TMP, { force: true, recursive: true });
  });

  it("writes the audio under os.tmpdir(), not a fixed /tmp, and deletes it afterwards", async () => {
    const fake = fakeEdge();
    __setForTests({ EdgeTTS: fake.EdgeTTS });
    const out = await new EdgeTTSEngine().synthesize("Hello there.");
    assert.equal(out.contentType, "audio/mpeg");
    assert.equal(out.audio.length, 400);
    assert.equal(fake.calls.length, 1);
    const file = fake.calls[0].audioPath;
    assert.equal(path.dirname(file), os.tmpdir(), `audio went to ${file}`);
    assert.ok(path.isAbsolute(file));
    assert.match(path.basename(file), /\.mp3$/);
    assert.equal(fake.calls[0].existedBefore, false);
    assert.equal(fs.existsSync(file), false, "the temp audio file was left behind");
    assertTidy(fake);
  });

  it("passes the text and the chosen voice through", async () => {
    const fake = fakeEdge();
    __setForTests({ EdgeTTS: fake.EdgeTTS });
    await new EdgeTTSEngine("en-GB-SoniaNeural").synthesize("**Good** morning.");
    await new EdgeTTSEngine("en-GB-SoniaNeural").synthesize("Good evening.", "en-AU-WilliamNeural");
    assert.deepEqual(fake.calls.map((c) => [c.text, c.voice]), [
      ["Good morning.", "en-GB-SoniaNeural"],
      ["Good evening.", "en-AU-WilliamNeural"],
    ]);
  });

  it("gives two sentences spoken at once their own files", async () => {
    const fake = fakeEdge({ delayMs: 20 });
    __setForTests({ EdgeTTS: fake.EdgeTTS });
    const engine = new EdgeTTSEngine();
    const results = await Promise.all([
      engine.synthesize("First sentence."),
      engine.synthesize("Second sentence."),
      engine.synthesize("Third sentence."),
    ]);
    assert.equal(results.length, 3);
    const files = fake.calls.map((c) => c.audioPath);
    assert.equal(new Set(files).size, 3, `files clashed: ${files.join(", ")}`);
    for (const f of files) assert.equal(path.dirname(f), os.tmpdir());
    assertTidy(fake);
  });

  it("deletes every attempt's file when Edge TTS keeps failing, and says why", async () => {
    const fake = fakeEdge({ fail: new Error("socket dropped") });
    __setForTests({ EdgeTTS: fake.EdgeTTS, retryDelayMs: 0 });
    await assert.rejects(new EdgeTTSEngine().synthesize("Hello."), /socket dropped/);
    assert.equal(fake.calls.length, 3);
    assert.equal(new Set(fake.calls.map((c) => c.audioPath)).size, 3);
    assertTidy(fake);
  });

  it("deletes the file when the audio comes back empty", async () => {
    const fake = fakeEdge({ bytes: 10 });
    __setForTests({ EdgeTTS: fake.EdgeTTS, retryDelayMs: 0 });
    await assert.rejects(new EdgeTTSEngine().synthesize("Hello."), /too small/);
    assertTidy(fake);
  });

  it("deletes the file when an attempt times out", async () => {
    const fake = fakeEdge({ hang: true });
    __setForTests({ EdgeTTS: fake.EdgeTTS, retryDelayMs: 0, timeoutMs: 30 });
    await assert.rejects(new EdgeTTSEngine().synthesize("Hello."), /timed out/);
    assert.equal(fake.calls.length, 3);
    assertTidy(fake);
  });

  it("turns Edge TTS's bare-string failures into a readable error", async () => {
    const fake = fakeEdge({ fail: "Timed out" });
    __setForTests({ EdgeTTS: fake.EdgeTTS, retryDelayMs: 0 });
    const err = await new EdgeTTSEngine().synthesize("Hello.").catch((e) => e);
    assert.ok(err instanceof Error, `got ${typeof err}: ${err}`);
    assert.match(err.message, /Timed out/);
    assertTidy(fake);
  });

  it("never names a fixed Unix temp folder in the source", () => {
    const src = fs.readFileSync(new URL("../src/voice/edge-tts-engine.js", import.meta.url), "utf8");
    assert.doesNotMatch(src, /["'`]\/tmp\//);
  });
});
