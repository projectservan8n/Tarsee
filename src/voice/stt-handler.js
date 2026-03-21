/**
 * Speech-to-text handler.
 *
 * Primary STT is handled client-side via the Web Speech API (zero server cost).
 * This module provides a server-side fallback endpoint for browsers that don't
 * support Web Speech API, or for external API clients sending audio.
 *
 * Currently stubbed — will delegate to a configured STT engine when available.
 */

/**
 * Handles an audio buffer and returns a transcript.
 * @param {Buffer} audioBuffer - Audio data (webm, wav, mp3)
 * @param {string} [language] - Language code (e.g., "en-US")
 * @returns {Promise<{transcript: string, confidence: number}>}
 */
export async function transcribeAudio(_audioBuffer, _language) {
  throw Object.assign(
    new Error(
      "Server-side STT not configured. Use browser Web Speech API for transcription, " +
      "or configure a server STT engine in Settings."
    ),
    { status: 501 }
  );
}
