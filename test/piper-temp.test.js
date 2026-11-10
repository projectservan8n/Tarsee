import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const VOICES = path.join(WORK, "data", "piper-voices");
const LOG = path.join(WORK, "calls.jsonl");
const FAKE = path.join(WORK, "fake-piper.mjs");

// A stand-in for the piper program: no model, no audio engine. It reads the text
// on its input, logs what it was asked, creates the output file (as the real one
// does before the audio is ready), then behaves as FAKE_PIPER_MODE says.
fs.writeFileSync(FAKE, `
import fs from "node:fs";
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const out = arg("--output_file");
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const existedBefore = fs.existsSync(out);
fs.writeFileSync(out, Buffer.alloc(0));
fs.appendFileSync(process.env.FAKE_PIPER_LOG, JSON.stringify({
  pid: process.pid, out, model: arg("--model"), args, existedBefore,
  text: Buffer.concat(chunks).toString("utf8"),
}) + "\\n");
const mode = process.env.FAKE_PIPER_MODE || "ok";
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "fail") { process.stderr.write("Loading the voice...\\nUnable to load the voice model\\n"); process.exit(3); }
else if (mode === "empty") fs.writeFileSync(out, Buffer.alloc(10));
else if (mode === "none") fs.rmSync(out);
else {
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_PIPER_DELAY_MS || 0)));
  fs.writeFileSync(out, Buffer.alloc(400, 7));
}
`);
process.env.FAKE_PIPER_LOG = LOG;
const COMMAND = [process.execPath, FAKE];

fs.mkdirSync(VOICES, { recursive: true });
for (const id of ["alpha", "beta"]) {
  fs.writeFileSync(path.join(VOICES, `${id}.onnx`), Buffer.alloc(64, 1));
  fs.writeFileSync(path.join(VOICES, `${id}.onnx.json`), JSON.stringify({ dataset: id }));
}

const { PiperTTSEngine, deletePiperVoice, __setForTests } = await import("../src/voice/piper-engine.js");

const leftovers = () => fs.readdirSync(TMP);
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

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
    fs.rmSync(LOG, { force: true });
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
  it("deletes both files of a voice", () => {
    fs.writeFileSync(path.join(VOICES, "gamma.onnx"), "x");
    fs.writeFileSync(path.join(VOICES, "gamma.onnx.json"), "{}");
    deletePiperVoice("gamma");
    assert.equal(fs.existsSync(path.join(VOICES, "gamma.onnx")), false);
    assert.equal(fs.existsSync(path.join(VOICES, "gamma.onnx.json")), false);
  });

  it("refuses an id that leads out of the voices folder", () => {
    const outside = path.join(WORK, "data", "outside");
    fs.writeFileSync(`${outside}.onnx`, "x");
    fs.writeFileSync(`${outside}.onnx.json`, "{}");
    for (const id of ["../outside", "..\\outside", outside]) deletePiperVoice(id);
    assert.equal(fs.existsSync(`${outside}.onnx`), true, "a file outside the voices folder was deleted");
    assert.equal(fs.existsSync(`${outside}.onnx.json`), true, "a file outside the voices folder was deleted");
  });
});
