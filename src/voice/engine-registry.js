import { StubTTSEngine } from "./tts-stub.js";
import { TTSEngine } from "./tts-interface.js";

let currentEngine = new StubTTSEngine();

export function getTTSEngine() {
  return currentEngine;
}

export function setTTSEngine(engine) {
  currentEngine = engine;
}

/** The engine used when voice.engine has never been set. */
export const DEFAULT_ENGINE = "phonon";

/** The engine the user asked for: voice.engine, or Phonon when it is unset. */
export function enginePreference(settingsStore) {
  const v = settingsStore?.get("voice.engine");
  return typeof v === "string" && v.trim() ? v.trim() : DEFAULT_ENGINE;
}

/** "Auto" tries these in order. Phonon is only available once it is installed. */
const AUTO_ORDER = ["phonon", "piper", "elevenlabs", "edge-tts"];

// When the engine the user picked cannot start, this one is tried before the
// auto order. Edge TTS is free and always there; ElevenLabs is never reached
// this way because it costs money.
const PREFERRED_FALLBACK = { phonon: "edge-tts" };

// What is tried after the picked engine and its preferred fallback both fail.
// Phonon (the default) never falls through to ElevenLabs.
const AFTER_FALLBACK = { phonon: ["piper"] };

/** Edge TTS voice ids look like "en-US-AndrewMultilingualNeural" or "fil-PH-AngeloNeural". */
const EDGE_VOICE = /^[a-z]{2,3}-[A-Z]{2}(?:-[A-Za-z]+)?-\w+Neural$/;

/**
 * A voice id the fallback engine can use, or undefined for its own default.
 * The id given to Phonon (a Phonon voice like "toby") would make Edge TTS fail.
 */
export function fallbackVoiceFor(engineName, voiceId) {
  if (!voiceId) return undefined;
  if (engineName === "edge-tts") return EDGE_VOICE.test(voiceId) ? voiceId : undefined;
  return undefined;
}

/** Phonon's speaking rate (voice.phonon.speed, 0.85 to 1.25). The other engines have no speed setting. */
function applyVoiceSpeed(settingsStore, engine) {
  if (engine?.name !== "phonon" || typeof engine.setSpeed !== "function") return;
  const sp = Number(settingsStore?.get("voice.phonon.speed"));
  if (Number.isFinite(sp) && sp > 0) {
    engine.setSpeed(sp);
    console.log(`[voice] phonon speaking rate set to ${sp}x`);
  }
}

let initSeq = 0;

/**
 * Initialize the TTS engine from settings. Called at boot and again whenever a
 * voice.* setting changes.
 *
 * voice.engine unset or "phonon": Phonon (the default), with Edge TTS speaking
 * whenever Phonon is not installed yet or fails. Another named engine: that
 * engine, then the auto order. "auto": Phonon when installed, then Piper,
 * ElevenLabs, Edge TTS. Nothing available: the stub (voice disabled).
 *
 * opts.loaders replaces how named engines are built (tests):
 * { name: async (settingsStore, voice) => engine }.
 */
export async function initTTSEngine(settingsStore, opts = {}) {
  const seq = ++initSeq;
  const enginePref = enginePreference(settingsStore);
  const defaultVoice = settingsStore?.get("voice.defaultVoiceId") || undefined;

  const choose = (engine) => {
    // Settings saves come in bursts (voice, speed, engine), each starting an
    // init. Only the newest one may set the engine, so an older init finishing
    // late cannot undo a newer choice.
    if (seq !== initSeq) return;
    const previous = currentEngine;
    currentEngine = engine;
    applyVoiceSpeed(settingsStore, engine);
    if (previous?.name === "phonon" && engine?.name !== "phonon") {
      // Switched away from Phonon: let its warm worker go.
      try { previous.stop?.(); } catch { /* ignore */ }
    }
  };

  let rest = AUTO_ORDER;
  if (enginePref !== "auto") {
    const engine = await tryEngine(enginePref, settingsStore, defaultVoice, opts.loaders);
    if (engine) return choose(engine);
    const next = PREFERRED_FALLBACK[enginePref];
    if (next) {
      const fb = await tryEngine(next, settingsStore, fallbackVoiceFor(next, defaultVoice), opts.loaders);
      if (fb) {
        console.warn(`[voice] ${enginePref} is not available yet, ${next} speaks instead`);
        return choose(fb);
      }
    }
    console.warn(`[voice] Preferred engine "${enginePref}" unavailable, falling back`);
    rest = (AFTER_FALLBACK[enginePref] || AUTO_ORDER).filter((n) => n !== enginePref && n !== next);
  }

  for (const name of rest) {
    const engine = await tryEngine(name, settingsStore, null, opts.loaders);
    if (engine) return choose(engine);
  }

  console.warn("[voice] No TTS engine available — voice disabled");
  choose(new StubTTSEngine());
}

const ENGINE_LOADERS = {
  async elevenlabs(settingsStore, defaultVoice) {
    const apiKey = settingsStore?.getApiKey?.("elevenlabs")
      || settingsStore?.get("voice.elevenlabs.apiKey");
    if (!apiKey) return null;
    const { ElevenLabsTTSEngine } = await import("./elevenlabs-engine.js");
    return new ElevenLabsTTSEngine(apiKey, undefined, defaultVoice || "wNl2YBRc8v5uIcq6gOxd");
  },
  async piper(_s, defaultVoice) {
    const { PiperTTSEngine } = await import("./piper-engine.js");
    return new PiperTTSEngine(defaultVoice);
  },
  async "edge-tts"(_s, defaultVoice) {
    const { EdgeTTSEngine } = await import("./edge-tts-engine.js");
    return new EdgeTTSEngine(defaultVoice);
  },
  async phonon(settingsStore) {
    const { PhononTTSEngine } = await import("./phonon-engine.js");
    const barePeso = settingsStore?.get("voice.phonon.barePeso");
    return new PhononTTSEngine(settingsStore?.get("voice.phonon.voice"), {
      barePeso: barePeso === true || barePeso === "true",
    });
  },
};

const ACTIVE_LOG = {
  elevenlabs: (e, v) => `ElevenLabs TTS active (voice: ${v || "default"})`,
  piper: () => "Piper TTS active (local, ultra-fast)",
  "edge-tts": () => "Edge TTS active (Microsoft, free)",
  phonon: (e) => `Phonon TTS active (local 31M model by Gradium, voice: ${e.defaultVoice || "default"}; Edge TTS is its fallback)`,
};

/**
 * Try to initialize a specific engine. Returns the engine if available, null otherwise.
 * Phonon comes back wrapped, with Edge TTS behind it for any sentence it fails.
 */
async function tryEngine(name, settingsStore, defaultVoice, loaders, { quiet = false } = {}) {
  try {
    const make = loaders?.[name] || ENGINE_LOADERS[name];
    if (!make) return null;
    const engine = await make(settingsStore, defaultVoice);
    if (!engine || !(await engine.isAvailable())) return null;
    if (!quiet) console.log(`[voice] ${ACTIVE_LOG[name]?.(engine, defaultVoice) || `${name} TTS active`}`);
    const fallbackName = PREFERRED_FALLBACK[name];
    if (fallbackName) {
      return new FallbackTTSEngine(engine, async () => {
        const voice = fallbackVoiceFor(fallbackName, settingsStore?.get("voice.defaultVoiceId"));
        const fb = await tryEngine(fallbackName, settingsStore, voice, loaders, { quiet: true });
        if (fb) console.log(`[voice] ${fallbackName} ready as ${name}'s fallback`);
        return fb;
      }, fallbackName);
    }
    return engine;
  } catch (err) {
    console.warn(`[voice] Engine "${name}" failed:`, err.message);
    return null;
  }
}

/**
 * An engine with a spare: a sentence the primary fails is spoken by the
 * fallback (built on first need). After FAILS_TO_TRIP failures in a row the
 * primary is skipped for TRIP_MS, so a broken install does not add a delay to
 * every sentence; it is tried again after that.
 *
 * The fallback gets the request's voice id only when it is one of its own
 * voices: a Phonon voice such as "toby" means nothing to Edge TTS.
 */
export class FallbackTTSEngine extends TTSEngine {
  static FAILS_TO_TRIP = 3;
  static TRIP_MS = 5 * 60_000;

  constructor(primary, makeFallback, fallbackName = "edge-tts") {
    super();
    this.primary = primary;
    this._makeFallback = makeFallback;
    this._fallbackName = fallbackName;
    this._fallback = null;
    this._fails = 0;
    this._skipUntil = 0;
  }

  get name() { return this.primary.name; }
  get defaultVoice() { return this.primary.defaultVoice; }

  async _getFallback() {
    if (!this._fallback) this._fallback = Promise.resolve().then(() => this._makeFallback()).catch(() => null);
    const fb = await this._fallback;
    if (!fb) this._fallback = null; // try building it again next time
    return fb;
  }

  _fallbackSynth(fb, text, voiceId) {
    return fb.synthesize(text, fallbackVoiceFor(this._fallbackName, voiceId));
  }

  async synthesize(text, voiceId, opts) {
    if (Date.now() >= this._skipUntil) {
      try {
        const out = await this.primary.synthesize(text, voiceId, opts);
        this._fails = 0;
        return out;
      } catch (err) {
        if (err?.code === "EMPTY_TEXT") throw err; // nothing to say: no engine would do better
        this._fails++;
        if (this._fails >= FallbackTTSEngine.FAILS_TO_TRIP) {
          this._skipUntil = Date.now() + FallbackTTSEngine.TRIP_MS;
          this._fails = 0;
          console.warn(`[voice] ${this.primary.name} failed ${FallbackTTSEngine.FAILS_TO_TRIP} times in a row, using ${this._fallbackName} for ${FallbackTTSEngine.TRIP_MS / 60_000} min`);
        }
        console.warn(`[voice] ${this.primary.name} synth failed (${err?.message}), speaking with ${this._fallbackName}`);
        const fb = await this._getFallback();
        if (!fb) throw err;
        return this._fallbackSynth(fb, text, voiceId);
      }
    }
    const fb = await this._getFallback();
    if (!fb) return this.primary.synthesize(text, voiceId, opts);
    return this._fallbackSynth(fb, text, voiceId);
  }

  async isAvailable() { return this.primary.isAvailable(); }
  async listVoices() { return this.primary.listVoices(); }
  async cloneVoice(sample, name) { return this.primary.cloneVoice(sample, name); }
  setSpeed(speed) { this.primary.setSpeed?.(speed); }
  async warm() { return this.primary.warm?.(); }
  stop() { this.primary.stop?.(); }
}

export function stopTTSEngine() {
  if (currentEngine && typeof currentEngine.stop === "function") {
    try { currentEngine.stop(); } catch { /* ignore */ }
  }
}
