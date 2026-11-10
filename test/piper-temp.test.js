import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import express from "express";

// As in edge-tts-temp.test.js: point the system temp folder at a throwaway one,
// so the test can see every file Piper leaves behind. os.tmpdir() reads these on
// each call (TEMP/TMP on Windows, TMPDIR elsewhere), and node --test runs this
// file in its own process. The fake Piper, its call log and the voices folder
// live in a second folder, so they never count as leftovers.
const REAL_TMP = os.tmpdir();
const TMP = fs.mkdtempSync(path.join(REAL_TMP, "tarsee-piper-test-"));
const WORK = fs.mkdtempSync(path.join(REAL_TMP, "tarsee-piper-work-"));
process.env.TMPDIR = TMP;
process.env.TEMP = TMP;
process.env.TMP = TMP;
process.env.TARSEE_DATA_DIR = path.join(WORK, "data");
process.env.TARSEE_STATE_DIR = path.join(WORK, "state");
process.env.TARSEE_WORKSPACE_DIR = path.join(WORK, "state", "workspace");

const VOICES = path.join(WORK, "data", "piper-voices");
const LOG = path.join(WORK, "calls.jsonl");
const ENDS = path.join(WORK, "ends.jsonl");
const FAKE = path.join(WORK, "fake-piper.mjs");

// A stand-in for the piper program: no model, no audio engine. It reads the text
// on its input, logs what it was asked and when it started, creates the output
// file (as the real one does before the audio is ready), then behaves as
// FAKE_PIPER_MODE says, or as "mode=<name> " at the start of the text says for
// that run alone. A run that writes its audio logs when it ended, too. "late"
// writes its audio 800 ms after it started, then runs until it is stopped.
fs.writeFileSync(FAKE, `
import fs from "node:fs";
const started = Date.now();
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const out = arg("--output_file");
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const text = Buffer.concat(chunks).toString("utf8");
const existedBefore = fs.existsSync(out);
fs.writeFileSync(out, Buffer.alloc(0));
fs.appendFileSync(process.env.FAKE_PIPER_LOG, JSON.stringify({
  pid: process.pid, out, model: arg("--model"), args, existedBefore, text, started,
}) + "\\n");
const mode = /^mode=(\\w+) /.exec(text)?.[1] || process.env.FAKE_PIPER_MODE || "ok";
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "fail") { process.stderr.write("Loading the voice...\\nUnable to load the voice model\\n"); process.exit(3); }
else if (mode === "empty") fs.writeFileSync(out, Buffer.alloc(10));
else if (mode === "none") fs.rmSync(out);
else if (mode === "late") {
  await new Promise((r) => setTimeout(r, 800));
  fs.writeFileSync(out, Buffer.alloc(400, 7));
  setInterval(() => {}, 1000);
}
else {
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_PIPER_DELAY_MS || 0)));
  fs.writeFileSync(out, Buffer.alloc(400, 7));
  fs.appendFileSync(process.env.FAKE_PIPER_ENDS, JSON.stringify({ pid: process.pid, ended: Date.now() }) + "\\n");
}
`);
process.env.FAKE_PIPER_LOG = LOG;
process.env.FAKE_PIPER_ENDS = ENDS;
const COMMAND = [process.execPath, FAKE];

fs.mkdirSync(VOICES, { recursive: true });
for (const id of ["alpha", "beta"]) {
  fs.writeFileSync(path.join(VOICES, `${id}.onnx`), Buffer.alloc(64, 1));
  fs.writeFileSync(path.join(VOICES, `${id}.onnx.json`), JSON.stringify({ dataset: id }));
}

const { PiperTTSEngine, deletePiperVoice, __setForTests, __leftoverSweepsDone } = await import("../src/voice/piper-engine.js");

const leftovers = () => fs.readdirSync(TMP);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MINUTE = 60_000;

/** Waits until check() is true, and fails, saying `what`, if it is not within `ms`. */
async function waitFor(check, ms, what) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`${what}: not within ${ms} ms`);
    await sleep(20);
  }
}

/** Makes `name` in the temp folder (a folder, with a file in it, when `folder`), last written `ageMs` ago. */
function plant(name, ageMs = 0, { folder = false } = {}) {
  const p = path.join(TMP, name);
  if (folder) {
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, "inside.wav"), "x");
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
 * As in edge-tts-temp.test.js: runs fn while counting how often the temp folder is listed, the longest wait handed to
 * setTimeout, and Node's warnings that a wait was too long for setTimeout (which then waits 1 ms instead).
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

const isRunning = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const calls = () => lines(LOG).map((l) => JSON.parse(l));
const ends = () => new Map(lines(ENDS).map((l) => JSON.parse(l)).map((e) => [e.pid, e.ended]));

/**
 * What Node's spawn hands back when there are no file handles left (EMFILE or
 * ENFILE): a child with no input or output streams, whose "error" event comes on
 * the next tick, followed by "close".
 */
function spawnWithNoHandlesLeft(bin) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => false;
  process.nextTick(() => {
    child.exitCode = -24;
    child.emit("error", Object.assign(new Error(`spawn ${bin} EMFILE`), { code: "EMFILE", errno: -24, syscall: `spawn ${bin}` }));
    child.emit("close", -24, null);
  });
  return child;
}

/**
 * Node's own spawn, except that the child's "close" (all of its output closed)
 * comes `ms` after its "exit". That is what happens on Linux when a process
 * Piper started still holds Piper's error output open after Piper has gone.
 * (On Windows such a process does not keep the pipe open, so it is staged here.)
 */
const spawnHeldOpen = (ms) => (...args) => {
  const child = spawn(...args);
  const emit = child.emit.bind(child);
  child.emit = (event, ...rest) => {
    if (event !== "close") return emit(event, ...rest);
    setTimeout(() => emit(event, ...rest), ms).unref();
    return true;
  };
  return child;
};

/**
 * Node's own spawn, except that a kill reaches the child `ms` late: a Piper that
 * takes a while to go once it is stopped, as a busy or swapped-out machine can.
 */
const spawnSlowToDie = (ms) => (...args) => {
  const child = spawn(...args);
  const kill = child.kill.bind(child);
  child.kill = (signal) => {
    setTimeout(() => kill(signal), ms);
    return true;
  };
  return child;
};

/** Every file Piper was given sat in the temp folder and is gone, and nothing else was left there. */
function assertTidy() {
  const all = calls();
  assert.ok(all.length > 0, "Piper was never run");
  for (const { out } of all) {
    assert.equal(path.dirname(out), os.tmpdir(), `audio went to ${out}`);
    assert.equal(fs.existsSync(out), false, `${out} was left behind`);
  }
  assert.deepEqual(leftovers(), []);
}

after(() => {
  __setForTests();
  for (const dir of [TMP, WORK]) fs.rmSync(dir, { force: true, recursive: true });
});

describe("Piper keeps its audio in the system temp folder", () => {
  before(() => { assert.equal(os.tmpdir(), TMP, "the test could not move the temp folder"); });
  beforeEach(() => {
    for (const f of leftovers()) fs.rmSync(path.join(TMP, f), { force: true, recursive: true });
    for (const f of [LOG, ENDS]) fs.rmSync(f, { force: true });
    delete process.env.FAKE_PIPER_MODE;
    delete process.env.FAKE_PIPER_DELAY_MS;
    __setForTests({ command: COMMAND });
  });

  it("writes the audio under os.tmpdir(), not a fixed /tmp, and deletes it afterwards", async () => {
    const out = await new PiperTTSEngine("alpha").synthesize("Hello there.");
    assert.equal(out.contentType, "audio/wav");
    assert.deepEqual(out.audio, Buffer.alloc(400, 7));
    const all = calls();
    assert.equal(all.length, 1);
    const file = all[0].out;
    assert.equal(path.dirname(file), os.tmpdir(), `audio went to ${file}`);
    assert.ok(path.isAbsolute(file));
    assert.match(path.basename(file), /\.wav$/);
    assert.equal(all[0].existedBefore, false);
    assertTidy();
  });

  it("passes the cleaned text and the chosen voice's model through", async () => {
    await new PiperTTSEngine("beta").synthesize("**Good** morning.");
    await new PiperTTSEngine("beta").synthesize("Good evening.", "alpha");
    assert.deepEqual(calls().map((c) => [c.text, c.model]), [
      ["Good morning.", path.join(VOICES, "beta.onnx")],
      ["Good evening.", path.join(VOICES, "alpha.onnx")],
    ]);
    assertTidy();
  });

  it("gives sentences spoken at once their own files, and the server keeps running while Piper works", async () => {
    process.env.FAKE_PIPER_DELAY_MS = "300";
    let ticks = 0;
    const ticker = setInterval(() => { ticks++; }, 10);
    const engine = new PiperTTSEngine("alpha");
    try {
      const results = await Promise.all([
        engine.synthesize("First sentence."),
        engine.synthesize("Second sentence."),
        engine.synthesize("Third sentence."),
      ]);
      for (const r of results) assert.equal(r.audio.length, 400);
    } finally {
      clearInterval(ticker);
    }
    assert.ok(ticks >= 5, `the server stood still while Piper ran (${ticks} ticks)`);
    const files = calls().map((c) => c.out);
    assert.equal(new Set(files).size, 3, `files clashed: ${files.join(", ")}`);
    assertTidy();
  });

  it("runs one Piper at a time, in the order the sentences were asked for, and each one's limit starts when it starts", async () => {
    // A call asks for every sentence of an answer at once. Each run here takes
    // well under the limit, and all four together well over it.
    process.env.FAKE_PIPER_DELAY_MS = "600";
    __setForTests({ command: COMMAND, timeoutMs: 2000 });
    const engine = new PiperTTSEngine("alpha");
    const texts = ["One.", "Two.", "Three.", "Four."];
    const results = await Promise.all(texts.map((t) => engine.synthesize(t)));
    for (const r of results) assert.equal(r.audio.length, 400);
    const runs = calls().sort((x, y) => x.started - y.started);
    const ended = ends();
    for (let i = 1; i < runs.length; i++) {
      assert.ok(runs[i].started >= ended.get(runs[i - 1].pid), `"${runs[i].text}" started while "${runs[i - 1].text}" was still running`);
    }
    assert.deepEqual(runs.map((c) => c.text), texts);
    assertTidy();
  });

  it("lets the next Piper run once one is stopped or fails", async () => {
    __setForTests({ command: COMMAND, timeoutMs: 1500 });
    const engine = new PiperTTSEngine("alpha");
    const [hung, second, failed, fourth] = await Promise.allSettled([
      engine.synthesize("mode=hang One."),
      engine.synthesize("Two."),
      engine.synthesize("mode=fail Three."),
      engine.synthesize("Four."),
    ]);
    assert.match(String(hung.reason?.message), /took longer than 1.5 s/);
    assert.equal(second.value?.audio.length, 400);
    assert.match(String(failed.reason?.message), /exit code 3/);
    assert.equal(fourth.value?.audio.length, 400);
    assert.equal(calls().length, 4);
    assertTidy();
  });

  it("says Piper could not run, and keeps the server up, when no file handles are left to start it", async () => {
    __setForTests({ command: COMMAND, spawn: spawnWithNoHandlesLeft });
    await assert.rejects(new PiperTTSEngine("alpha").synthesize("Hello."), /Piper could not run: spawn .* EMFILE/);
    assert.deepEqual(leftovers(), []);
    // Its turn is free again.
    __setForTests({ command: COMMAND });
    assert.equal((await new PiperTTSEngine("alpha").synthesize("Hello again.")).audio.length, 400);
    assertTidy();
  });

  it("answers as soon as Piper has gone, even while a process it started still holds its error output open", async () => {
    __setForTests({ command: COMMAND, timeoutMs: 1500, spawn: spawnHeldOpen(3000) });
    const engine = new PiperTTSEngine("alpha");
    let t = Date.now();
    const out = await engine.synthesize("Hello.");
    assert.deepEqual(out.audio, Buffer.alloc(400, 7));
    assert.ok(Date.now() - t < 1500, `a Piper that worked took ${Date.now() - t} ms to answer`);
    // A Piper that failed is reported as failed, with what it said, not as too slow.
    t = Date.now();
    await assert.rejects(engine.synthesize("mode=fail Hello."), /exit code 3.*Unable to load the voice model/);
    assert.ok(Date.now() - t < 1500, `a Piper that failed took ${Date.now() - t} ms to answer`);
    assertTidy();
  });

  it("deletes the file when Piper fails, and passes on what Piper said", async () => {
    process.env.FAKE_PIPER_MODE = "fail";
    await assert.rejects(new PiperTTSEngine("alpha").synthesize("Hello."), /exit code 3.*Unable to load the voice model/);
    assertTidy();
  });

  it("deletes the file when the audio comes back empty", async () => {
    process.env.FAKE_PIPER_MODE = "empty";
    await assert.rejects(new PiperTTSEngine("alpha").synthesize("Hello."), /empty audio/);
    assertTidy();
  });

  it("says so in plain words when Piper finished but wrote no audio", async () => {
    process.env.FAKE_PIPER_MODE = "none";
    await assert.rejects(new PiperTTSEngine("alpha").synthesize("Hello."), /wrote no audio/);
    assertTidy();
  });

  it("stops a Piper that runs past the limit, waits for it to be gone, and deletes its file", async () => {
    process.env.FAKE_PIPER_MODE = "hang";
    // Long enough for the fake to start and create its file even on a slow machine.
    __setForTests({ command: COMMAND, timeoutMs: 3000 });
    await assert.rejects(new PiperTTSEngine("alpha").synthesize("Hello."), /took longer than 3 s/);
    const [call] = calls();
    assert.ok(call, "the fake Piper did not start within the limit");
    assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" }, "the stopped Piper is still running");
    assertTidy();
  });

  it("removes the file of a stopped Piper that went on writing it after the engine stopped waiting for it", async () => {
    // The engine waits a while for a stopped Piper to be gone, then gives the next sentence its turn. A Piper still
    // there after that could write its file once the engine had removed it (or, on Windows, hold it open so that it
    // could not be removed), and the file stayed.
    __setForTests({ command: COMMAND, timeoutMs: 300, killWaitMs: 200, spawn: spawnSlowToDie(2500) });
    await assert.rejects(new PiperTTSEngine("alpha").synthesize("mode=late Hello."), /took longer than 0.3 s/);
    await waitFor(() => calls().length === 1, 2500, "the fake Piper started");
    const [{ pid, out }] = calls();
    await waitFor(() => fs.existsSync(out), 2500, "the stopped Piper wrote its file after the engine had given up on it");
    await waitFor(() => !isRunning(pid), 5000, "the stopped Piper went");
    await sleep(300);
    assertTidy();
  });

  it("sweeps Tarsee's own old Piper files from the temp folder when the engine starts, and nothing else", async () => {
    // A name the engine really made, so the sweep is checked against the engine's own naming.
    await new PiperTTSEngine("alpha").synthesize("Hello.");
    await __leftoverSweepsDone();
    const id = () => crypto.randomUUID();
    plant(path.basename(calls()[0].out), 10 * MINUTE);
    plant(`tarsee-piper-${id()}.wav`, 60 * MINUTE);
    const folder = plant(`tarsee-piper-${id()}.wav`, 10 * MINUTE, { folder: true }); // not a file
    const kept = [
      folder,
      plant(`tarsee-piper-${id()}.wav`), // fresh: a Piper may be writing it right now
      plant(`tarsee-piper-${id()}.wav`, 2 * MINUTE),
      plant(`tarsee-piper-${id()}.wav.tmp`, 10 * MINUTE),
      plant(`tarsee-piper-${id()}.mp3`, 10 * MINUTE),
      plant(`tarsee-piper-${id().toUpperCase()}.wav`, 10 * MINUTE),
      plant(`backup-tarsee-piper-${id()}.wav`, 10 * MINUTE),
      plant(`tarsee-edge-tts-${id()}.mp3`, 10 * MINUTE),
      plant(`phonon-${id()}.wav`, 10 * MINUTE),
      plant("tarsee-piper-voice.wav", 10 * MINUTE),
    ];
    __setForTests({ command: COMMAND }); // as if Tarsee had just started
    new PiperTTSEngine("alpha");
    await __leftoverSweepsDone();
    assert.deepEqual(leftovers().sort(), kept.sort());
    assert.equal(fs.existsSync(path.join(TMP, folder, "inside.wav")), true, "a folder's contents were touched");
  });

  it("sweeps again after a sentence fails", async () => {
    __setForTests({ command: COMMAND, sweepGapMs: 0 });
    new PiperTTSEngine("alpha");
    await __leftoverSweepsDone(); // the start sweep, with nothing to remove
    const old = plant(`tarsee-piper-${crypto.randomUUID()}.wav`, 10 * MINUTE);
    await sleep(100);
    await __leftoverSweepsDone();
    assert.deepEqual(leftovers(), [old], "the temp folder was swept with nothing failing");
    await assert.rejects(new PiperTTSEngine("alpha").synthesize("mode=fail Hello."), /exit code 3/);
    await __leftoverSweepsDone();
    assertTidy();
  });

  // As for Edge TTS: a file dated more than about 25 days ahead set the next look further off than setTimeout can
  // wait, so it waited 1 ms instead, and the sweep ran again and again for as long as the server ran.
  it("is not sent round and round by a leftover dated far in the future, and removes it once it has sat for the usual time", async () => {
    const name = plant(`tarsee-piper-${crypto.randomUUID()}.wav`, -60 * DAY);
    await watchSweeps(async (seen) => {
      new PiperTTSEngine("alpha");
      await sleep(1000);
      await __leftoverSweepsDone();
      assert.equal(seen.overflows, 0, "a wait was too long for setTimeout");
      assert.equal(seen.listings, 1, `the temp folder was listed ${seen.listings} times in a second`);
      assert.ok(seen.longestWait <= HOUR, `a sweep waits ${seen.longestWait} ms`);
    });
    assert.deepEqual(leftovers(), [name], "a file dated in the future was removed at once");
    __setForTests({ command: COMMAND, leftoverAgeMs: 300 });
    new PiperTTSEngine("alpha");
    await __leftoverSweepsDone();
    assert.deepEqual(leftovers(), [name], "a file dated in the future was removed at once");
    await waitFor(() => leftovers().length === 0, 3000, "the leftover dated in the future was removed");
  });

  it("gives up on a leftover it cannot remove after a few tries, and says so once", async () => {
    __setForTests({ command: COMMAND, removeRetryMs: 10 });
    const stuck = plant(`tarsee-piper-${crypto.randomUUID()}.wav`, 10 * MINUTE);
    const realUnlink = fs.promises.unlink;
    const realWarn = console.warn;
    let tries = 0;
    const warnings = [];
    fs.promises.unlink = (file, ...rest) => {
      if (path.basename(String(file)) !== stuck) return realUnlink(file, ...rest);
      tries++;
      return Promise.reject(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }));
    };
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    try {
      new PiperTTSEngine("alpha");
      await waitFor(() => tries >= 5, 3000, "five tries");
      await sleep(400);
      await __leftoverSweepsDone();
    } finally {
      fs.promises.unlink = realUnlink;
      console.warn = realWarn;
    }
    assert.equal(tries, 5, `it was tried ${tries} times`);
    const said = warnings.filter((w) => w.includes("[piper]") && w.includes("could not remove"));
    assert.equal(said.length, 1, `it said so ${said.length} times`);
    assert.ok(said[0].includes(stuck));
    assert.deepEqual(leftovers(), [stuck]);
  });

  it("says so when the piper program cannot be started, and leaves nothing behind", async () => {
    __setForTests({ command: [path.join(WORK, "no-such-piper")] });
    await assert.rejects(new PiperTTSEngine("alpha").synthesize("Hello."), /Piper could not run/);
    assert.deepEqual(leftovers(), []);
  });

  it("never names a fixed Unix temp folder in the source", () => {
    const src = fs.readFileSync(new URL("../src/voice/piper-engine.js", import.meta.url), "utf8");
    assert.doesNotMatch(src, /["'`]\/tmp\//);
  });
});

describe("Piper is found on the PATH on every system", () => {
  const savedPath = process.env.PATH;
  before(() => { __setForTests(); });
  after(() => { process.env.PATH = savedPath; });

  it("finds a piper program on the PATH, with no `which` command needed (Windows has none)", async () => {
    const bin = path.join(WORK, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const exe = path.join(bin, process.platform === "win32" ? "piper.exe" : "piper");
    fs.writeFileSync(exe, "");
    fs.chmodSync(exe, 0o755);
    process.env.PATH = bin;
    assert.equal(await new PiperTTSEngine().isAvailable(), true);
  });

  it("is not available when no piper is on the PATH", async () => {
    const empty = path.join(WORK, "empty-bin");
    fs.mkdirSync(empty, { recursive: true });
    process.env.PATH = empty;
    assert.equal(await new PiperTTSEngine().isAvailable(), false);
  });
});

describe("Deleting a Piper voice stays inside the voices folder", () => {
  const outside = path.join(WORK, "data", "outside");
  const refused = ["../outside", "..\\outside", outside];
  let server;
  let base;
  before(async () => {
    const { voiceRouter } = await import("../src/routes/voice.js");
    const app = express();
    app.use("/api/voice", voiceRouter);
    server = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
    base = `http://127.0.0.1:${server.address().port}/api/voice/piper-voices`;
  });
  after(() => new Promise((r) => server.close(r)));
  beforeEach(() => {
    fs.writeFileSync(`${outside}.onnx`, "x");
    fs.writeFileSync(`${outside}.onnx.json`, "{}");
  });
  const outsideIsThere = () => {
    assert.equal(fs.existsSync(`${outside}.onnx`), true, "a file outside the voices folder was deleted");
    assert.equal(fs.existsSync(`${outside}.onnx.json`), true, "a file outside the voices folder was deleted");
  };

  it("deletes both files of a voice", () => {
    fs.writeFileSync(path.join(VOICES, "gamma.onnx"), "x");
    fs.writeFileSync(path.join(VOICES, "gamma.onnx.json"), "{}");
    assert.equal(deletePiperVoice("gamma"), true);
    assert.equal(fs.existsSync(path.join(VOICES, "gamma.onnx")), false);
    assert.equal(fs.existsSync(path.join(VOICES, "gamma.onnx.json")), false);
  });

  it("refuses an id that leads out of the voices folder", () => {
    for (const id of refused) assert.equal(deletePiperVoice(id), false, `"${id}" was not refused`);
    outsideIsThere();
  });

  it("answers ok over HTTP when a voice is deleted", async () => {
    fs.writeFileSync(path.join(VOICES, "delta.onnx"), "x");
    fs.writeFileSync(path.join(VOICES, "delta.onnx.json"), "{}");
    const r = await fetch(`${base}/delta`, { method: "DELETE" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(fs.existsSync(path.join(VOICES, "delta.onnx")), false);
    assert.equal(fs.existsSync(path.join(VOICES, "delta.onnx.json")), false);
  });

  it("answers 400 over HTTP, with the reason in plain words, when the name is refused", async () => {
    for (const id of refused) {
      const r = await fetch(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
      assert.equal(r.status, 400, `"${id}" answered ${r.status}`);
      const body = await r.json();
      assert.equal(body.ok, undefined);
      assert.match(String(body.error), /not the name of a Piper voice/);
    }
    outsideIsThere();
  });
});
