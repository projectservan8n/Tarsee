/**
 * Edge TTS engine — Microsoft's free text-to-speech service.
 * No API key needed. No rate limits. Good quality.
 * Uses node-edge-tts package with retry logic.
 */

import { TTSEngine } from "./tts-interface.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const MAX_RETRIES = 3;
// Each attempt's limit fits its sentence: a base for connecting and a short
// sentence, and more for each character, since a longer one streams for longer.
// A short sentence that stalls fails fast, and no attempt waits more than 30 s.
const TTS_BASE_MS = 8_000;
const TTS_PER_CHAR_MS = 20;
const TTS_TIMEOUT = 30_000;
const RETRY_DELAY = 500; // times the attempt number

// Swapped only by tests: the EdgeTTS class (null loads node-edge-tts) and the
// waits (a time limit set here is used for every sentence, whatever its length).
let _EdgeTTS = null;
let _timeoutMs = null;
let _retryDelayMs = RETRY_DELAY;

/** Tests only: use a fake EdgeTTS class and shorter waits. No arguments puts the real ones back. */
export function __setForTests({ EdgeTTS, timeoutMs, retryDelayMs } = {}) {
  _EdgeTTS = EdgeTTS || null;
  _timeoutMs = timeoutMs ?? null;
  _retryDelayMs = retryDelayMs ?? RETRY_DELAY;
}

/**
 * What node-edge-tts leaves undone, which this sees to by wrapping the library's
 * connect step (a private method, so only when it is there):
 * - it never notices the connection dropping part-way through a reply, so only
 *   a timer would end the attempt;
 * - it never closes its WebSocket when an attempt fails or times out, and keeps
 *   that attempt's audio file open, with no way given to close it;
 * - a connection that opens after the attempt gave up would still create the
 *   audio file in the temp folder.
 * Returns `lost`, which rejects as soon as the connection closes or fails before
 * the whole reply has come, and end(failed): call it once the attempt is over.
 */
function trackConnection(tts) {
  let socket = null;
  let over = false;
  let complete = false; // the reply's end-of-turn message has come
  let drop;
  const lost = new Promise((_, reject) => { drop = reject; });
  lost.catch(() => {}); // nothing waits on it once the attempt is over
  const connect = typeof tts._connectWebSocket === "function" ? tts._connectWebSocket.bind(tts) : null;
  if (connect) {
    tts._connectWebSocket = async () => {
      const ws = await connect();
      if (over) {
        closeSocket(ws);
        throw new Error("Edge TTS connected after the attempt was over");
      }
      socket = ws;
      watch(ws);
      return ws;
    };
  }
  function watch(ws) {
    if (typeof ws.on !== "function") return;
    ws.on("message", (data, isBinary) => {
      if (!isBinary && String(data).includes("Path:turn.end")) complete = true;
    });
    ws.on("close", (code) => {
      if (!over && !complete) drop(new Error(`Edge TTS lost its connection part-way through the reply (close code ${code})`));
    });
    ws.on("error", (err) => {
      if (!over && !complete) drop(new Error(`Edge TTS connection failed: ${err?.message || err}`));
    });
  }
  const end = (failed) => {
    over = true;
    // A good attempt's connection, and its file, are closed by node-edge-tts itself.
    if (failed && socket) {
      closeSocket(socket);
      if (!complete) endReply(socket);
    }
    socket = null;
  };
  return { lost, end };
}

/** How long one attempt to speak `text` may take. */
function limitFor(text) {
  return _timeoutMs ?? Math.min(TTS_TIMEOUT, TTS_BASE_MS + text.length * TTS_PER_CHAR_MS);
}

/**
 * node-edge-tts closes the attempt's audio file (and stops its own timer) only
 * when the reply's end-of-turn message comes. For an attempt that failed before
 * it came, hand the library that message, so the file is closed now rather than
 * left open until Tarsee restarts.
 */
function endReply(ws) {
  try { ws.emit?.("message", Buffer.from("Path:turn.end\r\n\r\n"), false); } catch { /* nothing left to end */ }
}

function closeSocket(ws) {
  try {
    if (typeof ws.terminate === "function") ws.terminate();
    else ws.close?.();
  } catch { /* already closed */ }
}

export class EdgeTTSEngine extends TTSEngine {
  constructor(voice) {
    super();
    this.defaultVoice = voice || "en-US-AndrewMultilingualNeural";
  }

  get name() { return "edge-tts"; }

  async isAvailable() {
    try {
      // Light check — just import the module, don't generate audio
      await import("node-edge-tts");
      return true;
    } catch (err) {
      console.warn("[edge-tts] not available:", err.message);
      return false;
    }
  }

  async synthesize(text, voiceId) {
    if (!text) throw new Error("Text is required");

    // Strip emojis — Edge TTS reads them aloud as descriptions
    // The class deliberately includes the ZWJ and variation selectors as bare
    // members: we are deleting every codepoint of a sequence, not matching the
    // sequence as one grapheme, so splitting it apart is the desired result.
    text = text
      // eslint-disable-next-line no-misleading-character-class
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{200D}\u{20E3}\u{FE0F}]/gu, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!text) throw new Error("No speakable text after stripping emojis");

    // Strip markdown artifacts that sound bad when spoken
    text = text
      .replace(/```[\s\S]*?```/g, "")   // code blocks
      .replace(/`[^`]+`/g, "")           // inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → just text
      .replace(/[*_~#>]/g, "")           // markdown formatting
      .replace(/\n{2,}/g, ". ")          // paragraph breaks → pause
      .replace(/\n/g, " ")              // newlines → space
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!text) throw new Error("No speakable text after cleanup");

    const EdgeTTS = _EdgeTTS || (await import("node-edge-tts")).EdgeTTS;
    const voice = voiceId || this.defaultVoice;
    const limit = limitFor(text);

    // Retry loop — Edge TTS WebSocket can drop
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // The system temp folder (there is no /tmp on Windows), and a name of its
      // own for every attempt, so two sentences spoken at once never share a file.
      const tmpFile = path.join(os.tmpdir(), `tarsee-edge-tts-${crypto.randomUUID()}.mp3`);
      let timer;
      let tracked = null;
      let failed = true;
      try {
        // node-edge-tts gives up after its own timeout, 10 s unless told
        // otherwise, which would cut off a long reply before this engine's
        // limit. Give it the same limit.
        const t = new EdgeTTS({ voice, timeout: limit });
        tracked = trackConnection(t);
        await Promise.race([
          t.ttsPromise(text, tmpFile),
          // A connection that drops part-way ends the attempt at once, so the next one starts.
          tracked.lost,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`TTS timed out after ${limit / 1000} s (attempt ${attempt}/${MAX_RETRIES})`)), limit);
          }),
        ]);

        const audio = fs.readFileSync(tmpFile);
        if (audio.length < 100) throw new Error("Generated audio too small — likely empty");

        failed = false;
        return { audio, contentType: "audio/mpeg" };
      } catch (err) {
        // node-edge-tts rejects some failures with a bare string ("Timed out").
        lastError = err instanceof Error ? err : new Error(`Edge TTS failed: ${err}`);
        console.warn(`[edge-tts] attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`);
      } finally {
        clearTimeout(timer);
        tracked?.end(failed);
        try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
      }
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, _retryDelayMs * attempt));
    }

    throw lastError || new Error("Edge TTS failed after retries");
  }

  async listVoices() {
    return [
      // US English
      { id: "en-US-AndrewMultilingualNeural", name: "Andrew (US)", isClone: false },
      { id: "en-US-AvaMultilingualNeural", name: "Ava (US)", isClone: false },
      { id: "en-US-BrianMultilingualNeural", name: "Brian (US)", isClone: false },
      { id: "en-US-EmmaMultilingualNeural", name: "Emma (US)", isClone: false },
      { id: "en-US-ChristopherNeural", name: "Christopher (US)", isClone: false },
      { id: "en-US-JennyNeural", name: "Jenny (US)", isClone: false },
      { id: "en-US-GuyNeural", name: "Guy (US)", isClone: false },
      { id: "en-US-AriaNeural", name: "Aria (US)", isClone: false },
      { id: "en-US-DavisNeural", name: "Davis (US)", isClone: false },
      // UK English
      { id: "en-GB-SoniaNeural", name: "Sonia (UK)", isClone: false },
      { id: "en-GB-RyanNeural", name: "Ryan (UK)", isClone: false },
      { id: "en-GB-LibbyNeural", name: "Libby (UK)", isClone: false },
      // Australian
      { id: "en-AU-NatashaNeural", name: "Natasha (AU)", isClone: false },
      { id: "en-AU-WilliamNeural", name: "William (AU)", isClone: false },
      // Philippine
      { id: "en-PH-JamesNeural", name: "James (PH)", isClone: false },
      { id: "en-PH-RosaNeural", name: "Rosa (PH)", isClone: false },
      // Multilingual (multiple languages with same voice)
      { id: "en-US-AlloyMultilingualNeural", name: "Alloy (Multilingual)", isClone: false },
      { id: "en-US-NovaMultilingualNeural", name: "Nova (Multilingual)", isClone: false },
      { id: "en-US-ShimmerMultilingualNeural", name: "Shimmer (Multilingual)", isClone: false },
    ];
  }
}
