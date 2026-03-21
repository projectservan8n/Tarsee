import { getTTSEngine } from "./engine-registry.js";

/**
 * Handles voice cloning requests.
 * Receives an audio sample and creates a voice profile.
 *
 * @param {Buffer} audioBuffer - Audio sample (10-30 seconds recommended)
 * @param {string} name - Name for the voice profile
 * @param {import('better-sqlite3').Database} db - Database for storing voice profiles
 * @returns {Promise<{voiceId: string, name: string}>}
 */
export async function cloneVoice(audioBuffer, name, db) {
  if (!audioBuffer || audioBuffer.length === 0) {
    throw Object.assign(new Error("Audio sample is required"), { status: 400 });
  }
  if (!name || typeof name !== "string") {
    throw Object.assign(new Error("Voice name is required"), { status: 400 });
  }

  const engine = getTTSEngine();
  const result = await engine.cloneVoice(audioBuffer, name);

  // Save voice profile to database
  const crypto = await import("node:crypto");
  const id = result.voiceId || crypto.randomUUID();

  db.prepare(
    "INSERT OR REPLACE INTO voice_profiles (id, name, engine, data) VALUES (?, ?, ?, ?)"
  ).run(id, name, engine.name, audioBuffer);

  return { voiceId: id, name };
}

/**
 * Lists all voice profiles.
 */
export function listVoiceProfiles(db) {
  return db.prepare(
    "SELECT id, name, engine, created_at FROM voice_profiles ORDER BY created_at DESC"
  ).all();
}
