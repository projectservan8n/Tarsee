import { StubTTSEngine } from "./tts-stub.js";

let currentEngine = new StubTTSEngine();

/**
 * Gets the current TTS engine instance.
 * @returns {import('./tts-interface.js').TTSEngine}
 */
export function getTTSEngine() {
  return currentEngine;
}

/**
 * Sets the TTS engine.
 * @param {import('./tts-interface.js').TTSEngine} engine
 */
export function setTTSEngine(engine) {
  currentEngine = engine;
}
