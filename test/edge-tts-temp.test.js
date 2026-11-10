import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

// Point the system temp folder at a throwaway one, so the test can see every file
// Edge TTS leaves behind. os.tmpdir() reads these on each call (TEMP/TMP on
// Windows, TMPDIR elsewhere), and node --test runs this file in its own process.
const REAL_TMP = os.tmpdir();
const TMP = fs.mkdtempSync(path.join(REAL_TMP, "tarsee-edge-tts-test-"));
process.env.TMPDIR = TMP;
process.env.TEMP = TMP;
process.env.TMP = TMP;

const { EdgeTTSEngine, __setForTests } = await import("../src/voice/edge-tts-engine.js");

// The real node-edge-tts, and the ws module it opens its connection with. A test
// swaps ws's WebSocket for a fake one, so the real library runs with no network.
const require = createRequire(import.meta.url);
const { EdgeTTS: RealEdgeTTS } = require("node-edge-tts");
const ws = createRequire(require.resolve("node-edge-tts"))("ws");
const RealWebSocket = ws.WebSocket;

/**
 * A stand-in for the WebSocket node-edge-tts opens to Microsoft. It opens after
 * `openAfterMs`, then answers the speech request with `bytes` of audio and the
 * end-of-turn message. Or, as `answer` says: "never" never answers; "drop" sends
 * some audio and then loses the connection `dropAfterMs` later (0: at once), as
 * ws reports it (close code 1006); "end-then-close" sends the whole reply and
 * then the server closes at once. `onSpeechRequest` runs as the request comes.
 */
function fakeSocket({ openAfterMs = 0, answer = "audio", bytes = 400, dropAfterMs = 20, onSpeechRequest = null } = {}) {
  const sockets = [];
  class FakeWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.closed = false;
      this.terminated = false;
      sockets.push(this);
      setTimeout(() => this.emit("open"), openAfterMs);
    }
    send(msg) {
      if (!String(msg).includes("Path:ssml") || answer === "never") return;
      onSpeechRequest?.();
      setImmediate(() => {
        if (this.terminated) return;
        this.emit("message", Buffer.concat([Buffer.from("X-RequestId:1\r\nPath:audio\r\n"), Buffer.alloc(bytes, 7)]), true);
        if (answer === "drop") {
          const drop = () => this.emit("close", 1006, Buffer.alloc(0));
          if (dropAfterMs > 0) setTimeout(drop, dropAfterMs);
          else drop();
          return;
        }
        this.emit("message", Buffer.from("X-RequestId:1\r\nPath:turn.end\r\n\r\n{}"), false);
        if (answer === "end-then-close") this.emit("close", 1000, Buffer.alloc(0));
      });
    }
    close() { this.closed = true; }
    terminate() { this.terminated = true; }
  }
  return { FakeWebSocket, sockets };
}

/** Runs fn with node-edge-tts opening `sock`'s fake WebSocket, and puts the real one back afterwards. */
async function withSocket(sock, fn) {
  ws.WebSocket = sock.FakeWebSocket;
  try { return await fn(); } finally { ws.WebSocket = RealWebSocket; }
}

/**
 * Runs fn while every file in the temp folder opens `ms` late, as it does when
 * Node's thread pool is busy: fs.createWriteStream opens its file with fs.open,
 * on that pool. fn gets the list of files opened so far.
 */
async function withSlowOpens(ms, fn) {
  const realOpen = fs.open;
  const opened = [];
  fs.open = (file, ...rest) => {
    const cb = rest.pop();
    if (!String(file).startsWith(TMP)) return realOpen(file, ...rest, cb);
    setTimeout(() => realOpen(file, ...rest, (...args) => { opened.push(file); cb(...args); }), ms);
  };
  try { return await fn(opened); } finally { fs.open = realOpen; }
}

/** Keeps every thread of Node's pool busy for a while (about 100 ms each on a fast machine). */
function busyThreadPool() {
  const threads = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  for (let i = 0; i < threads; i++) crypto.pbkdf2(Buffer.alloc(8), Buffer.alloc(8), 250_000, 32, "sha256", () => {});
}

/**
 * A stand-in for node-edge-tts's EdgeTTS class: no network. It records every file
 * it was asked to write and writes `bytes` of fake audio there, or fails as told.
 */
function fakeEdge({ bytes = 400, fail = null, hang = false, delayMs = 0 } = {}) {
  const calls = [];
  class FakeEdgeTTS {
    constructor(opts) { this.opts = opts; }
    async ttsPromise(text, audioPath) {
      calls.push({ text, audioPath, voice: this.opts.voice, timeout: this.opts.timeout, existedBefore: fs.existsSync(audioPath) });
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

after(() => { fs.rmSync(TMP, { force: true, recursive: true }); });

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
    ws.WebSocket = RealWebSocket;
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

describe("Edge TTS gives node-edge-tts the engine's own time limit", () => {
  beforeEach(() => {
    for (const f of leftovers()) fs.rmSync(path.join(TMP, f), { force: true, recursive: true });
  });
  after(() => {
    __setForTests();
    ws.WebSocket = RealWebSocket;
  });

  it("fits each attempt's limit to the sentence: a short one fails fast, a long one gets longer, never past 30 s", async () => {
    const fake = fakeEdge();
    __setForTests({ EdgeTTS: fake.EdgeTTS });
    const engine = new EdgeTTSEngine();
    await engine.synthesize("Hi.");
    await engine.synthesize("word ".repeat(36).trim()); // about 180 characters: one piece of a call's answer
    await engine.synthesize("word ".repeat(1000).trim()); // the most the speech route takes
    const [short, piece, long] = fake.calls.map((c) => c.timeout);
    assert.ok(short <= 10_000, `a short sentence is given ${short} ms`);
    assert.ok(piece > short && piece < 30_000, `a 180-character piece is given ${piece} ms`);
    assert.equal(long, 30_000);
    // A limit a test sets is used as it is.
    __setForTests({ EdgeTTS: fake.EdgeTTS, timeoutMs: 1234 });
    await engine.synthesize("Hello again.");
    assert.equal(fake.calls.at(-1).timeout, 1234);
  });

  it("the real node-edge-tts keeps the engine's limit instead of its own 10 s, and its audio comes back whole", async () => {
    const made = [];
    class Recording extends RealEdgeTTS {
      constructor(opts) { super(opts); made.push(this); }
    }
    const text = "word ".repeat(200).trim();
    const fake = fakeEdge();
    __setForTests({ EdgeTTS: fake.EdgeTTS });
    await new EdgeTTSEngine().synthesize(text);
    const sock = fakeSocket();
    __setForTests({ EdgeTTS: Recording });
    const out = await withSocket(sock, () => new EdgeTTSEngine().synthesize(text));
    assert.equal(made.length, 1);
    assert.ok(made[0].timeout > 10_000, `node-edge-tts was given ${made[0].timeout} ms`);
    assert.equal(made[0].timeout, fake.calls[0].timeout);
    assert.equal(out.contentType, "audio/mpeg");
    assert.deepEqual(out.audio, Buffer.alloc(400, 7));
    // A good attempt leaves the connection to node-edge-tts, which closes it itself.
    assert.equal(sock.sockets.length, 1);
    assert.equal(sock.sockets[0].closed, true);
    assert.equal(sock.sockets[0].terminated, false);
    assert.deepEqual(leftovers(), []);
  });

  it("closes the connection of every attempt that timed out", async () => {
    const sock = fakeSocket({ answer: "never" });
    __setForTests({ retryDelayMs: 0, timeoutMs: 50 });
    await assert.rejects(withSocket(sock, () => new EdgeTTSEngine().synthesize("Hello.")), /timed out/);
    assert.equal(sock.sockets.length, 3);
    for (const s of sock.sockets) assert.equal(s.terminated, true, "a timed-out attempt left its connection open");
    assert.deepEqual(leftovers(), []);
  });

  it("gives up on an attempt at once when its connection drops part-way, and tries again", async () => {
    const sock = fakeSocket({ answer: "drop" });
    __setForTests({ retryDelayMs: 0, timeoutMs: 2000 });
    const t = Date.now();
    await assert.rejects(withSocket(sock, () => new EdgeTTSEngine().synthesize("Hello.")), /lost its connection/);
    const took = Date.now() - t;
    assert.equal(sock.sockets.length, 3);
    assert.ok(took < 1500, `three dropped attempts took ${took} ms, as if each waited for its limit`);
    for (const s of sock.sockets) assert.equal(s.terminated, true, "a dropped attempt left its connection open");
    assert.deepEqual(leftovers(), []);
  });

  // node-edge-tts opens its audio file a moment after it sends the speech request. A connection that drops before
  // then ended the attempt before the file existed: the removal found nothing, then the file was made, with the audio
  // that had come, and stayed in the temp folder.
  it("removes the file of an attempt whose connection drops before node-edge-tts has opened it", async () => {
    const sock = fakeSocket({ answer: "drop", dropAfterMs: 0 });
    __setForTests({ retryDelayMs: 0, timeoutMs: 2000 });
    await withSlowOpens(150, async (opened) => {
      await assert.rejects(withSocket(sock, () => new EdgeTTSEngine().synthesize("Hello.")), /lost its connection/);
      assert.equal(sock.sockets.length, 3);
      assert.deepEqual(leftovers(), [], "a file was left as the attempts gave up");
      await new Promise((r) => setTimeout(r, 400)); // every late open is done by now
      assert.equal(opened.length, 3, "each attempt's file was opened, after its connection dropped");
    });
    assert.deepEqual(leftovers(), [], "a file opened after its attempt gave up was left behind");
  });

  it("...and when Node's thread pool is busy as the connection drops just after the speech request", async () => {
    // The timing the reviewer found it with: every pool thread busy, and the drop 20 ms after the request.
    const sock = fakeSocket({ answer: "drop", dropAfterMs: 20, onSpeechRequest: busyThreadPool });
    __setForTests({ retryDelayMs: 0, timeoutMs: 2000 });
    await assert.rejects(withSocket(sock, () => new EdgeTTSEngine().synthesize("Hello.")), /lost its connection/);
    assert.equal(sock.sockets.length, 3);
    assert.deepEqual(leftovers(), [], "a file was left as the attempts gave up");
    await new Promise((r) => setTimeout(r, 1000)); // the pool is free again
    assert.deepEqual(leftovers(), [], "a file opened after its attempt gave up was left behind");
  });

  it("speaks when the connection closes just after the whole reply has come", async () => {
    const sock = fakeSocket({ answer: "end-then-close" });
    __setForTests({ retryDelayMs: 0, timeoutMs: 2000 });
    const out = await withSocket(sock, () => new EdgeTTSEngine().synthesize("Hello."));
    assert.deepEqual(out.audio, Buffer.alloc(400, 7));
    assert.equal(sock.sockets.length, 1);
    assert.deepEqual(leftovers(), []);
  });

  it("has node-edge-tts close the audio file of an attempt that failed part-way", async () => {
    // node-edge-tts opens its file with fs.createWriteStream and keeps it to itself.
    const streams = [];
    const realCreate = fs.createWriteStream;
    fs.createWriteStream = (...args) => { const st = realCreate(...args); streams.push(st); return st; };
    try {
      const sock = fakeSocket({ answer: "drop" });
      __setForTests({ retryDelayMs: 0, timeoutMs: 2000 });
      await assert.rejects(withSocket(sock, () => new EdgeTTSEngine().synthesize("Hello.")), /lost its connection/);
      const hung = fakeSocket({ answer: "never" });
      __setForTests({ retryDelayMs: 0, timeoutMs: 50 });
      await assert.rejects(withSocket(hung, () => new EdgeTTSEngine().synthesize("Hello.")), /timed out/);
    } finally {
      fs.createWriteStream = realCreate;
    }
    assert.equal(streams.length, 6);
    await new Promise((r) => setTimeout(r, 100));
    for (const st of streams) assert.equal(st.closed, true, `${st.path} was left open`);
    assert.deepEqual(leftovers(), []);
  });

  it("closes a connection that opens after its attempt gave up, before any audio file is made", async () => {
    const sock = fakeSocket({ openAfterMs: 120 });
    __setForTests({ retryDelayMs: 0, timeoutMs: 30 });
    await assert.rejects(withSocket(sock, () => new EdgeTTSEngine().synthesize("Hello.")), /timed out/);
    assert.equal(sock.sockets.length, 3);
    // Every attempt gave up before its connection opened. Wait until they all have.
    await new Promise((r) => setTimeout(r, 300));
    for (const s of sock.sockets) assert.equal(s.terminated, true, "a late connection was left open");
    assert.deepEqual(leftovers(), [], "a late connection still wrote an audio file");
  });
});
