// The speech-to-text worker (src/voice/stt_worker.py) with a REAL Python, faster-whisper and PyAV: the parts the
// fake Python in stt-local.test.js can't stand in for. faster-whisper 1.2.1's own decoder calls PyAV's
// av.open(..., metadata_errors="ignore"), which newer PyAV (pip installs the newest) no longer takes, so every real
// recording failed while a blank array (the Docker build's old check) still worked. Runs only when these are set,
// skipped otherwise:
//   TARSEE_TEST_STT_PYTHON  a Python with faster-whisper (e.g. <state>/python/stt-venv/Scripts/python.exe)
//   TARSEE_TEST_STT_MODEL   a downloaded model folder (e.g. <state>/data/whisper-models/base.en)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PY = process.env.TARSEE_TEST_STT_PYTHON;
const MODEL = process.env.TARSEE_TEST_STT_MODEL;
const WORKER = fileURLToPath(new URL("../src/voice/stt_worker.py", import.meta.url));
const skip = PY && MODEL && fs.existsSync(PY) && fs.existsSync(MODEL) ? false : "set TARSEE_TEST_STT_PYTHON and TARSEE_TEST_STT_MODEL";

/** A mono 16-bit WAV: a second of a 440 Hz tone, then half a second of silence. */
function toneWav(file, rate = 16000) {
  const n = Math.round(rate * 1.5);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(i < rate ? Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)) : 0, 44 + i * 2);
  fs.writeFileSync(file, b);
}

/** Start the worker, send one request per audio file, and return its replies. */
function runWorker(files) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, ["-I", WORKER], { env: { ...process.env, HF_HUB_OFFLINE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    const lines = [];
    let buf = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`worker timed out; stderr: ${err.slice(-400)}`)); }, 120_000);
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (d) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        lines.push(msg);
        if (msg.ready === true) files.forEach((f, id) => child.stdin.write(JSON.stringify({ id, audio: f, model: MODEL, language: "en", threads: 2 }) + "\n"));
        if (msg.ready === false || lines.length === files.length + 1) { clearTimeout(timer); child.stdin.end(); child.kill(); resolve(lines); }
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

describe("the speech-to-text worker with a real Python, faster-whisper and PyAV", { skip }, () => {
  it("transcribes real recordings, a WAV and a WebM like the browser's, whatever PyAV version pip installed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-stt-real-"));
    const wav = path.join(dir, "tone.wav");
    toneWav(wav);
    const files = [wav];
    if (process.env.TARSEE_TEST_STT_SPEECH) files.push(process.env.TARSEE_TEST_STT_SPEECH);
    const [ready, ...replies] = await runWorker(files);
    assert.equal(ready.ready, true, JSON.stringify(ready));
    for (const r of replies) {
      assert.equal(r.error, undefined, `no decode error: ${r.error}`);
      assert.equal(typeof r.text, "string");
      assert.ok(r.duration > 1, `the audio's length was read: ${r.duration}`);
    }
    if (process.env.TARSEE_TEST_STT_SPEECH) assert.match(replies[1].text.toLowerCase(), /bank/, `the words were heard: "${replies[1].text}"`);
  });
});
