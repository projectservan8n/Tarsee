/**
 * Piper TTS engine — ultra-fast local text-to-speech.
 * Sub-500ms latency, runs on CPU, no API key, no internet needed.
 * Uses ONNX voice models (.onnx + .onnx.json pairs).
 * Models stored on volume at /data/tarsee/piper-voices/
 */

import { TTSEngine } from "./tts-interface.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const VOICES_DIR = path.join(process.env.TARSEE_DATA_DIR || process.env.TARSEE_STATE_DIR || "/data/tarsee", "piper-voices");
const PIPER_TIMEOUT = 15_000;

// Swapped only by tests: the program run as Piper (its first entry; the rest go
// before Piper's own arguments) and the time limit.
let _command = null;
let _timeoutMs = PIPER_TIMEOUT;

/** Tests only: run another program as Piper, with a shorter limit. No arguments puts the real ones back. */
export function __setForTests({ command, timeoutMs } = {}) {
  _command = command?.length ? command : null;
  _timeoutMs = timeoutMs ?? PIPER_TIMEOUT;
}

/**
 * The piper program on the PATH, or null. It is looked up here rather than with
 * `which`, which Windows does not have. On Windows only piper.exe counts: a
 * .cmd or .bat cannot be started without a shell.
 */
function findPiper() {
  const name = process.platform === "win32" ? "piper.exe" : "piper";
  for (const entry of (process.env.PATH || "").split(path.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch { /* not here */ }
  }
  return null;
}

/** The program to run as Piper, and any arguments that go before Piper's own, or null when there is none. */
function piperProgram() {
  if (_command) return { bin: _command[0], args: _command.slice(1) };
  const bin = findPiper();
  return bin ? { bin, args: [] } : null;
}

/**
 * Runs Piper with the text on its input and waits for it to finish, without
 * blocking the server: a long sentence can take seconds, and a voice call has
 * to keep going meanwhile. A Piper that runs past the limit is stopped, and this
 * waits until it is gone, so the file it was writing can be deleted.
 */
function runPiper({ bin, args }, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    } catch (err) {
      reject(new Error(`Piper could not run: ${err.message}`));
      return;
    }
    let stderr = "";
    let timedOut = false;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const tooLong = () => new Error(`Piper took longer than ${timeoutMs / 1000} s and was stopped`);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    // Piper can quit before it has read all the text; its exit code says why.
    child.stdin.on("error", () => {});
    child.on("error", (err) => finish(new Error(`Piper could not run: ${err.message}`)));
    child.on("exit", () => { if (timedOut) finish(tooLong()); });
    child.on("close", (code, signal) => {
      if (timedOut) return finish(tooLong());
      if (code === 0) return finish();
      const said = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
      const how = code === null ? `stopped by ${signal}` : `exit code ${code}`;
      finish(new Error(`Piper failed (${how})${said ? `: ${said}` : ""}`));
    });
    child.stdin.end(input);
  });
}

export class PiperTTSEngine extends TTSEngine {
  constructor(defaultVoice) {
    super();
    fs.mkdirSync(VOICES_DIR, { recursive: true });
    this._defaultVoice = defaultVoice || null;
  }

  get name() { return "piper"; }

  async isAvailable() {
    if (!piperProgram()) return false;
    // Check if at least one voice model exists
    return this._scanVoices().length > 0;
  }

  /**
   * Scan the voices directory for .onnx model files.
   * Each voice needs a .onnx and matching .onnx.json config file.
   */
  _scanVoices() {
    try {
      const files = fs.readdirSync(VOICES_DIR);
      const onnxFiles = files.filter(f => f.endsWith(".onnx") && !f.endsWith(".onnx.json"));
      return onnxFiles
        .filter(f => {
          // Must have matching .onnx.json config
          const jsonFile = f + ".json";
          return files.includes(jsonFile);
        })
        .map(f => {
          const id = f.replace(".onnx", "");
          // Try to extract a friendly name from the .onnx.json
          let friendlyName = id;
          try {
            const config = JSON.parse(fs.readFileSync(path.join(VOICES_DIR, f + ".json"), "utf8"));
            if (config.dataset) friendlyName = config.dataset;
            else if (config.language?.name_english) friendlyName = `${id} (${config.language.name_english})`;
          } catch { /* use filename */ }
          return { id, file: f, name: friendlyName };
        });
    } catch { return []; }
  }

  async synthesize(text, voiceId) {
    if (!text) throw new Error("Text is required");

    // Strip emojis and markdown
    // As in edge-tts-engine.js: the ZWJ and variation selectors are bare
    // members on purpose, because this deletes every codepoint of a sequence
    // rather than matching the sequence as a single grapheme.
    text = text
      // eslint-disable-next-line no-misleading-character-class
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{200D}\u{20E3}\u{FE0F}]/gu, "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]+`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~#>]/g, "")
      .replace(/\n{2,}/g, ". ")
      .replace(/\n/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!text) throw new Error("No speakable text after cleanup");

    // Resolve voice model path
    const voices = this._scanVoices();
    let modelPath;

    if (voiceId) {
      const voice = voices.find(v => v.id === voiceId);
      if (voice) modelPath = path.join(VOICES_DIR, voice.file);
    }

    if (!modelPath && this._defaultVoice) {
      const voice = voices.find(v => v.id === this._defaultVoice);
      if (voice) modelPath = path.join(VOICES_DIR, voice.file);
    }

    if (!modelPath && voices.length > 0) {
      modelPath = path.join(VOICES_DIR, voices[0].file);
    }

    if (!modelPath) throw new Error("No Piper voice models found. Upload .onnx + .onnx.json files in Settings > Voice.");

    const program = piperProgram();
    if (!program) throw new Error("Piper is not installed: there is no piper program on the PATH.");

    // The system temp folder (there is no /tmp on Windows), and a name of its
    // own for every sentence, so two sentences spoken at once never share a file.
    const tmpOut = path.join(os.tmpdir(), `tarsee-piper-${crypto.randomUUID()}.wav`);

    try {
      // Pipe text to piper via stdin, output to wav file
      // --sentence_silence adds natural pauses between sentences
      await runPiper({
        bin: program.bin,
        args: [...program.args, "--model", modelPath, "--output_file", tmpOut, "--sentence_silence", "0.3"],
      }, text, _timeoutMs);

      let audio;
      try {
        audio = await fs.promises.readFile(tmpOut);
      } catch (err) {
        if (err.code === "ENOENT") throw new Error("Piper finished but wrote no audio");
        throw err;
      }
      if (audio.length < 100) throw new Error("Piper generated empty audio");

      return { audio, contentType: "audio/wav" };
    } finally {
      try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
    }
  }

  async listVoices() {
    return this._scanVoices().map(v => ({
      id: v.id,
      name: v.name,
      isClone: false,
    }));
  }

  /**
   * "Cloning" for Piper = uploading a custom .onnx model.
   * Not actual voice cloning — just model file upload.
   */
  async cloneVoice(_audioSample, _name) {
    throw Object.assign(
      new Error("Piper doesn't support voice cloning from audio. Upload .onnx + .onnx.json model files instead via Settings > Voice."),
      { status: 400 }
    );
  }
}

/**
 * Save an uploaded Piper voice model (.onnx + .onnx.json pair).
 * @param {Buffer} onnxBuffer - The .onnx model file
 * @param {Buffer} jsonBuffer - The .onnx.json config file
 * @param {string} name - Voice name (used as filename)
 * @returns {{ id: string, name: string }}
 */
export function savePiperVoice(onnxBuffer, jsonBuffer, name) {
  fs.mkdirSync(VOICES_DIR, { recursive: true });

  // Sanitize name for filesystem
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 50);
  const onnxPath = path.join(VOICES_DIR, `${safeName}.onnx`);
  const jsonPath = path.join(VOICES_DIR, `${safeName}.onnx.json`);

  fs.writeFileSync(onnxPath, onnxBuffer);
  fs.writeFileSync(jsonPath, jsonBuffer);

  console.log(`[piper] Saved voice: ${safeName} (${Math.round(onnxBuffer.length / 1024 / 1024)}MB)`);
  return { id: safeName, name };
}

/**
 * Delete a Piper voice model. Returns false, and deletes nothing, for an id that
 * is not a plain name.
 */
export function deletePiperVoice(voiceId) {
  // The id comes from a request's address. Only a plain name counts (no folder
  // separator, and no drive colon on Windows), so an id such as "../x" can never
  // reach a file outside the voices folder.
  const id = String(voiceId ?? "");
  if (!id || /[\\/:\0]/.test(id)) return false;
  const onnxPath = path.join(VOICES_DIR, `${id}.onnx`);
  const jsonPath = path.join(VOICES_DIR, `${id}.onnx.json`);
  try { fs.unlinkSync(onnxPath); } catch {}
  try { fs.unlinkSync(jsonPath); } catch {}
  return true;
}

/**
 * List all Piper voices on disk.
 */
export function listPiperVoices() {
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  try {
    const files = fs.readdirSync(VOICES_DIR);
    return files
      .filter(f => f.endsWith(".onnx") && !f.endsWith(".onnx.json"))
      .filter(f => files.includes(f + ".json"))
      .map(f => {
        const id = f.replace(".onnx", "");
        const stat = fs.statSync(path.join(VOICES_DIR, f));
        return { id, sizeMB: Math.round(stat.size / 1024 / 1024), file: f };
      });
  } catch { return []; }
}
