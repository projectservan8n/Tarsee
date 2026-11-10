import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

// Point the system temp folder at a throwaway one, so the test can see every file
// Edge TTS leaves behind. os.tmpdir() reads these on each call (TEMP/TMP on
// Windows, TMPDIR elsewhere), and node --test runs this file in its own process.
const REAL_TMP = os.tmpdir();
const TMP = fs.mkdtempSync(path.join(REAL_TMP, "tarsee-edge-tts-test-"));
process.env.TMPDIR = TMP;
process.env.TEMP = TMP;
process.env.TMP = TMP;

const ENGINE_URL = new URL("../src/voice/edge-tts-engine.js", import.meta.url).href;
const { EdgeTTSEngine, __setForTests, __leftoverSweepsDone } = await import(ENGINE_URL);

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
 * With `closesItself`, a terminated socket calls its own close() a moment later, as ws does when it then reads a close
 * frame (or a bad frame) still waiting in the socket; each socket's `selfClosedAt` says when.
 */
function fakeSocket({ openAfterMs = 0, answer = "audio", bytes = 400, dropAfterMs = 20, onSpeechRequest = null, closesItself = false } = {}) {
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
    terminate() {
      this.terminated = true;
      if (closesItself) {
        setImmediate(() => {
          this.selfClosedAt = Date.now();
          this.close(1000);
        });
      }
    }
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
 * on that pool. fn gets the list of files opened so far (and, as its `times`, when each was opened).
 */
async function withSlowOpens(ms, fn) {
  const realOpen = fs.open;
  const opened = [];
  opened.times = [];
  fs.open = (file, ...rest) => {
    const cb = rest.pop();
    if (!String(file).startsWith(TMP)) return realOpen(file, ...rest, cb);
    setTimeout(() => realOpen(file, ...rest, (...args) => { opened.push(file); opened.times.push(Date.now()); cb(...args); }), ms);
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
 * With `lateFileMs` it fails at once and makes the file that much later (listed in
 * `late` once made), as a library whose file opens late would.
 */
function fakeEdge({ bytes = 400, fail = null, hang = false, delayMs = 0, lateFileMs = null } = {}) {
  const calls = [];
  const late = [];
  class FakeEdgeTTS {
    constructor(opts) { this.opts = opts; }
    async ttsPromise(text, audioPath) {
      calls.push({ text, audioPath, voice: this.opts.voice, timeout: this.opts.timeout, existedBefore: fs.existsSync(audioPath) });
      if (lateFileMs !== null) {
        setTimeout(() => { fs.writeFileSync(audioPath, Buffer.alloc(bytes, 7)); late.push(audioPath); }, lateFileMs);
        throw fail || new Error("Edge TTS failed");
      }
      // Like the real one: the file is opened before the audio comes in.
      fs.writeFileSync(audioPath, Buffer.alloc(0));
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (hang) return new Promise(() => {});
      if (fail) throw fail;
      fs.writeFileSync(audioPath, Buffer.alloc(bytes, 7));
    }
  }
  return { EdgeTTS: FakeEdgeTTS, calls, late };
}

const leftovers = () => fs.readdirSync(TMP);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until check() is true, and fails, saying `what`, if it is not within `ms`. */
async function waitFor(check, ms, what) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`${what}: not within ${ms} ms`);
    await sleep(20);
  }
}

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

const MINUTE = 60_000;

/** Makes `name` in the temp folder (a folder, with a file in it, when `folder`), last written `ageMs` ago. */
function plant(name, ageMs = 0, { folder = false } = {}) {
  const p = path.join(TMP, name);
  if (folder) {
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, "inside.mp3"), "x");
  } else {
    fs.writeFileSync(p, "x");
  }
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(p, t, t);
  return name;
}

const DAY = 24 * 60 * MINUTE;
const HOUR = 60 * MINUTE;

/**
 * Runs fn while counting how often the temp folder is listed, the longest wait handed to setTimeout, and Node's
 * warnings that a wait was too long for setTimeout (which then waits 1 ms instead). fn gets those counts.
 */
async function watchSweeps(fn) {
  const seen = { listings: 0, longestWait: 0, overflows: 0 };
  const realReaddir = fs.promises.readdir;
  const realSetTimeout = globalThis.setTimeout;
  const onWarning = (w) => { if (w.name === "TimeoutOverflowWarning") seen.overflows++; };
  fs.promises.readdir = (dir, ...rest) => {
    if (path.resolve(String(dir)) === path.resolve(TMP)) seen.listings++;
    return realReaddir(dir, ...rest);
  };
  globalThis.setTimeout = (cb, ms, ...rest) => {
    seen.longestWait = Math.max(seen.longestWait, Number(ms) || 0);
    return realSetTimeout(cb, ms, ...rest);
  };
  process.on("warning", onWarning);
  try {
    return await fn(seen);
  } finally {
    fs.promises.readdir = realReaddir;
    globalThis.setTimeout = realSetTimeout;
    process.off("warning", onWarning);
  }
}

/**
 * Runs fn while the temp folder's file `name` cannot be removed (EPERM, as when another user's file sits in a shared
 * /tmp), and while console.warn's lines are kept. fn gets the times each removal was tried, and the warnings.
 */
async function withStuckFile(name, fn) {
  const realUnlink = fs.promises.unlink;
  const realWarn = console.warn;
  const tries = [];
  const warnings = [];
  fs.promises.unlink = (file, ...rest) => {
    if (path.basename(String(file)) !== name) return realUnlink(file, ...rest);
    tries.push(Date.now());
    return Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, unlink '${file}'`), { code: "EPERM" }));
  };
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    return await fn(tries, warnings);
  } finally {
    fs.promises.unlink = realUnlink;
    console.warn = realWarn;
  }
}

describe("Edge TTS leaves no file behind, however late node-edge-tts makes it", () => {
  before(() => { assert.equal(os.tmpdir(), TMP, "the test could not move the temp folder"); });
  beforeEach(() => {
    for (const f of leftovers()) fs.rmSync(path.join(TMP, f), { force: true, recursive: true });
  });
  after(() => {
    __setForTests();
    ws.WebSocket = RealWebSocket;
  });

  // The reviewer's timing. node-edge-tts's own timer has the attempt's limit too, so it gives up on the attempt, and
  // settles its promise, while the open of the attempt's file still waits for a thread. The file was made afterwards,
  // once the attempt had cleaned up, and stayed.
  it("removes the file of an attempt node-edge-tts gave up on while the file's open was still waiting (open 800 ms, limit 300 ms, no reply)", async () => {
    const sock = fakeSocket({ answer: "never" });
    __setForTests({ retryDelayMs: 0, timeoutMs: 300 });
    await withSlowOpens(800, async (opened) => {
      await assert.rejects(withSocket(sock, () => new EdgeTTSEngine().synthesize("Hello.")), /timed out/);
      assert.equal(sock.sockets.length, 3);
      assert.deepEqual(leftovers(), [], "a file was left as the attempts gave up");
      await waitFor(() => opened.length === 3, 4000, "every attempt's file was opened");
      await sleep(1500);
    });
    assert.deepEqual(leftovers(), [], "a file opened after node-edge-tts gave up was left behind");
  });

  it("...and however late the open is: once node-edge-tts has finished the file, even after the watch for it has ended", async () => {
    // No looking for the file at all (watchMs 0): what removes it is node-edge-tts closing its connection once it has
    // finished the file, which it does however long the open waited.
    const sock = fakeSocket({ answer: "never" });
    __setForTests({ retryDelayMs: 0, timeoutMs: 100, watchMs: 0 });
    await withSlowOpens(600, async (opened) => {
      await assert.rejects(withSocket(sock, () => new EdgeTTSEngine().synthesize("Hello.")), /timed out/);
      assert.equal(sock.sockets.length, 3);
      assert.ok(opened.length < 3, "the attempts waited for the opens; the watch was meant to be off");
      await waitFor(() => opened.length === 3, 4000, "every attempt's file was opened");
      await sleep(200);
    });
    assert.deepEqual(leftovers(), [], "a file opened after its watch had ended was left behind");
  });

  it("removes a file that appears after its attempt failed, even when the library's connection cannot be watched", async () => {
    const fake = fakeEdge({ fail: new Error("socket dropped"), lateFileMs: 300 });
    __setForTests({ EdgeTTS: fake.EdgeTTS, retryDelayMs: 0 });
    await assert.rejects(new EdgeTTSEngine().synthesize("Hello."), /socket dropped/);
    assert.equal(fake.calls.length, 3);
    await waitFor(() => fake.late.length === 3, 3000, "every attempt's late file was made");
    await sleep(1500);
    assertTidy(fake);
  });

  it("sweeps Tarsee's own old Edge TTS files from the temp folder when the engine starts, and nothing else", async () => {
    // A name the engine really made, so the sweep is checked against the engine's own naming.
    const fake = fakeEdge();
    __setForTests({ EdgeTTS: fake.EdgeTTS });
    await new EdgeTTSEngine().synthesize("Hello.");
    await __leftoverSweepsDone();
    const id = () => crypto.randomUUID();
    plant(path.basename(fake.calls[0].audioPath), 10 * MINUTE);
    plant(`tarsee-edge-tts-${id()}.mp3`, 60 * MINUTE);
    plant(`tarsee-edge-tts-${id()}.mp3`, 6 * MINUTE);
    const folder = plant(`tarsee-edge-tts-${id()}.mp3`, 10 * MINUTE, { folder: true }); // not a file
    const kept = [
      folder,
      plant(`tarsee-edge-tts-${id()}.mp3`), // fresh: an attempt may be writing it right now
      plant(`tarsee-edge-tts-${id()}.mp3`, 2 * MINUTE),
      plant(`tarsee-edge-tts-${id().toUpperCase()}.mp3`, 10 * MINUTE),
      plant(`tarsee-edge-tts-${id()}.mp3.part`, 10 * MINUTE),
      plant(`tarsee-edge-tts-${id()}.wav`, 10 * MINUTE),
      plant(`tarsee-edge-tts-${id()}`, 10 * MINUTE),
      plant(`my-tarsee-edge-tts-${id()}.mp3`, 10 * MINUTE),
      plant(`tarsee-edge-tts-x${id()}.mp3`, 10 * MINUTE),
      plant("tarsee-edge-tts-00000000-0000-0000-0000-000000000000.mp3", 10 * MINUTE),
      plant("tarsee-edge-tts-backup.mp3", 10 * MINUTE),
      plant(`tarsee-piper-${id()}.wav`, 10 * MINUTE),
      plant("notes.txt", 10 * MINUTE),
    ];
    // A link named like Tarsee's files is not one Tarsee made (where the system lets the test make one).
    const link = `tarsee-edge-tts-${id()}.mp3`;
    try {
      fs.symlinkSync(path.join(TMP, "notes.txt"), path.join(TMP, link));
      const t = (Date.now() - 10 * MINUTE) / 1000;
      fs.lutimesSync(path.join(TMP, link), t, t);
      kept.push(link);
    } catch { /* no links here */ }
    __setForTests({ EdgeTTS: fake.EdgeTTS }); // as if Tarsee had just started
    new EdgeTTSEngine();
    await __leftoverSweepsDone();
    assert.deepEqual(leftovers().sort(), kept.sort());
    assert.equal(fs.existsSync(path.join(TMP, folder, "inside.mp3")), true, "a folder's contents were touched");
  });

  it("looks again once a leftover it found too fresh is old enough, and removes it then", async () => {
    __setForTests({ leftoverAgeMs: 400 });
    const name = plant(`tarsee-edge-tts-${crypto.randomUUID()}.mp3`);
    new EdgeTTSEngine();
    await __leftoverSweepsDone();
    assert.deepEqual(leftovers(), [name], "a fresh file was removed");
    await waitFor(() => leftovers().length === 0, 3000, "the leftover was removed once it was old enough");
  });

  it("sweeps again after a failed try, at most once in a while", async () => {
    const fake = fakeEdge({ fail: new Error("socket dropped") });
    __setForTests({ EdgeTTS: fake.EdgeTTS, retryDelayMs: 0, sweepGapMs: 600 });
    new EdgeTTSEngine();
    await __leftoverSweepsDone(); // the start sweep, with nothing to remove
    const first = plant(`tarsee-edge-tts-${crypto.randomUUID()}.mp3`, 10 * MINUTE);
    await sleep(700);
    await __leftoverSweepsDone();
    assert.deepEqual(leftovers(), [first], "the temp folder was swept with nothing failing");
    await assert.rejects(new EdgeTTSEngine().synthesize("Hello."), /socket dropped/);
    await __leftoverSweepsDone();
    assert.deepEqual(leftovers(), [], "a failed try did not sweep the temp folder");
    // Another failure straight after: its sweep waits until the gap has passed.
    const second = plant(`tarsee-edge-tts-${crypto.randomUUID()}.mp3`, 10 * MINUTE);
    await assert.rejects(new EdgeTTSEngine().synthesize("Hello."), /socket dropped/);
    await __leftoverSweepsDone();
    assert.deepEqual(leftovers(), [second], "the temp folder was swept again straight away");
    await waitFor(() => leftovers().length === 0, 3000, "the second sweep came once the gap had passed");
  });

  // ws calls its own close() when it reads a close frame (or a bad frame) still waiting in a socket the engine has
  // stopped. That says nothing about the file: taken as node-edge-tts's "the file is done", it ended the watch before
  // the file had been made, and the file stayed.
  for (const [what, watchMs] of [["while it watches for the file", undefined], ["with no watch for the file at all", 0]]) {
    it(`is not fooled when a stopped connection closes itself before node-edge-tts has made the file, ${what}`, async () => {
      const sock = fakeSocket({ answer: "never", closesItself: true });
      __setForTests({ retryDelayMs: 0, timeoutMs: 100, watchMs });
      await withSlowOpens(400, async (opened) => {
        await assert.rejects(withSocket(sock, () => new EdgeTTSEngine().synthesize("Hello.")), /timed out/);
        assert.equal(sock.sockets.length, 3);
        await waitFor(() => opened.length === 3, 5000, "every attempt's file was opened");
        sock.sockets.forEach((s, i) => {
          assert.ok(s.selfClosedAt, `connection ${i + 1} never closed itself`);
          assert.ok(s.selfClosedAt < opened.times[i], `connection ${i + 1} closed itself after its file was made`);
        });
        await sleep(300);
      });
      assert.deepEqual(leftovers(), [], "a file made after its connection closed itself was left behind");
    });
  }

  // A clock that was more than about 25 days ahead when a file was left, and was then put right (or anyone with a
  // shared /tmp and `touch -d`). The next look was set for when the file would be old, and setTimeout cannot wait that
  // long: it waited 1 ms instead, so the sweep ran again and again for as long as the server ran.
  it("is not sent round and round by a leftover dated far in the future, and leaves it for now", async () => {
    __setForTests();
    const name = plant(`tarsee-edge-tts-${crypto.randomUUID()}.mp3`, -60 * DAY);
    await watchSweeps(async (seen) => {
      new EdgeTTSEngine();
      await sleep(1000);
      await __leftoverSweepsDone();
      assert.equal(seen.overflows, 0, "a wait was too long for setTimeout");
      assert.equal(seen.listings, 1, `the temp folder was listed ${seen.listings} times in a second`);
      assert.ok(seen.longestWait <= HOUR, `a sweep waits ${seen.longestWait} ms`);
    });
    // Not removed at once: a Tarsee whose clock is ahead may be writing it right now.
    assert.deepEqual(leftovers(), [name]);
  });

  it("removes a leftover dated in the future once nothing has written to it for the usual time since it was seen", async () => {
    __setForTests({ leftoverAgeMs: 400 });
    const name = plant(`tarsee-edge-tts-${crypto.randomUUID()}.mp3`, -60 * DAY);
    const t = Date.now();
    new EdgeTTSEngine();
    await __leftoverSweepsDone();
    assert.deepEqual(leftovers(), [name], "a file dated in the future was removed at once");
    await waitFor(() => leftovers().length === 0, 3000, "the leftover dated in the future was removed");
    assert.ok(Date.now() - t >= 400, "it was removed before the usual time had passed");
  });

  it("never sets a sweep to wait more than an hour, however long it is waiting for", async () => {
    __setForTests({ leftoverAgeMs: 30 * DAY });
    const name = plant(`tarsee-edge-tts-${crypto.randomUUID()}.mp3`);
    await watchSweeps(async (seen) => {
      new EdgeTTSEngine();
      await sleep(1000);
      await __leftoverSweepsDone();
      assert.equal(seen.overflows, 0, "a wait was too long for setTimeout");
      assert.equal(seen.listings, 1, `the temp folder was listed ${seen.listings} times in a second`);
      assert.ok(seen.longestWait <= HOUR, `a sweep waits ${seen.longestWait} ms`);
    });
    assert.deepEqual(leftovers(), [name]);
  });

  // Another user's old file in a shared /tmp cannot be removed (EPERM: /tmp has the sticky bit). It was tried every
  // minute for as long as the process ran, without a word.
  it("tries a leftover it cannot remove a few times, further apart each time, then leaves it and says so once", async () => {
    const fake = fakeEdge({ fail: new Error("socket dropped") });
    __setForTests({ EdgeTTS: fake.EdgeTTS, retryDelayMs: 0, sweepGapMs: 0, removeRetryMs: 20 });
    const stuck = plant(`tarsee-edge-tts-${crypto.randomUUID()}.mp3`, 10 * MINUTE);
    await withStuckFile(stuck, async (tries, warnings) => {
      new EdgeTTSEngine();
      await waitFor(() => tries.length >= 5, 3000, "five tries");
      await sleep(600);
      await __leftoverSweepsDone();
      assert.equal(tries.length, 5, `it was tried ${tries.length} times`);
      for (let i = 1; i < tries.length; i++) {
        const gap = tries[i] - tries[i - 1];
        assert.ok(gap >= 20 * 2 ** (i - 1) - 5, `try ${i + 1} came ${gap} ms after the one before`);
      }
      const said = warnings.filter((w) => w.includes("[edge-tts]"));
      assert.equal(said.length, 1, `it said so ${said.length} times: ${said.join(" | ")}`);
      assert.match(said[0], /could not remove/);
      assert.ok(said[0].includes(stuck), `the warning does not name the file: ${said[0]}`);
      assert.match(said[0], /EPERM/);
      // Sweeps after failed tries leave it alone too, and still remove what they can.
      const other = plant(`tarsee-edge-tts-${crypto.randomUUID()}.mp3`, 10 * MINUTE);
      await assert.rejects(new EdgeTTSEngine().synthesize("Hello."), /socket dropped/);
      await __leftoverSweepsDone();
      assert.equal(fs.existsSync(path.join(TMP, other)), false, "a sweep after a failed try did not run");
      assert.equal(tries.length, 5, `it was tried ${tries.length} times`);
      assert.equal(warnings.filter((w) => w.includes("could not remove")).length, 1);
    });
    assert.deepEqual(leftovers(), [stuck]);
  });

  it("never keeps the process running to watch for a file or to sweep later", async () => {
    // In a process of its own: a fresh leftover, which the start sweep leaves and looks at again later, and three
    // failed attempts. The first one's file appears after it failed; the others' never do, so they are still being
    // watched for when the process has nothing else to do.
    const dir = fs.mkdtempSync(path.join(REAL_TMP, "tarsee-edge-tts-exit-test-"));
    const script = `
      import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";
      import crypto from "node:crypto";
      const { EdgeTTSEngine, __setForTests } = await import(${JSON.stringify(ENGINE_URL)});
      fs.writeFileSync(path.join(os.tmpdir(), "tarsee-edge-tts-" + crypto.randomUUID() + ".mp3"), "x");
      let n = 0;
      const made = [];
      class Fails {
        async ttsPromise(text, file) {
          if (++n === 1) setTimeout(() => { fs.writeFileSync(file, "x"); made.push(file); }, 200);
          throw new Error("no network");
        }
      }
      __setForTests({ EdgeTTS: Fails, retryDelayMs: 0 });
      await new EdgeTTSEngine().synthesize("Hello.").catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
      console.log(JSON.stringify({ made: made.length, left: made.filter((f) => fs.existsSync(f)).length }));
    `;
    const t = Date.now();
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const killer = setTimeout(() => child.kill(), 30_000);
    const code = await new Promise((r) => child.on("close", r));
    clearTimeout(killer);
    const took = Date.now() - t;
    try {
      assert.equal(code, 0, `the process failed: ${err}`);
      assert.ok(took < 10_000, `the process stayed up ${took} ms after its work was done`);
      assert.deepEqual(JSON.parse(out.trim().split("\n").pop()), { made: 1, left: 0 });
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });
});
