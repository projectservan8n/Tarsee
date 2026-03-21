/**
 * Abstract TTS Engine interface.
 * Implementations must extend this class and override all methods.
 */
export class TTSEngine {
  /**
   * Synthesize text to audio.
   * @param {string} text - Text to speak
   * @param {string} [voiceId] - Voice profile ID (null for default)
   * @returns {Promise<{audio: Buffer, contentType: string}>}
   */
  async synthesize(_text, _voiceId) {
    throw new Error("Not implemented");
  }

  /**
   * Clone a voice from an audio sample.
   * @param {Buffer} audioSample - Audio data (wav/mp3)
   * @param {string} name - Name for the voice profile
   * @returns {Promise<{voiceId: string, name: string}>}
   */
  async cloneVoice(_audioSample, _name) {
    throw new Error("Not implemented");
  }

  /**
   * List available voices.
   * @returns {Promise<Array<{id: string, name: string, isClone: boolean}>>}
   */
  async listVoices() {
    return [];
  }

  /**
   * Check if the engine is available and configured.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return false;
  }

  /**
   * Get engine name.
   * @returns {string}
   */
  get name() {
    return "base";
  }
}
