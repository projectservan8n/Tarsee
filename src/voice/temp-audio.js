/**
 * temp-audio.js: the audio files a speech engine keeps in the system temp folder, and the ones it leaves there.
 *
 * Edge TTS and Piper write each sentence's audio to a file of its own in the temp folder and remove it once the
 * sentence has been spoken or has failed. A crash, a restart or a redeploy in the middle of a sentence leaves its file
 * behind, and so can a file made after its sentence gave up (Edge TTS opens its file on Node's thread pool, which can
 * be busy for a while). So each engine sweeps its own leftovers when it starts, and now and then after a sentence fails.
 *
 * A sweep removes only regular files whose whole name is one the engine makes (its prefix, a random UUID, its
 * extension), and only once nothing has written to them for LEFTOVER_AGE_MS. No sentence takes anywhere near that
 * long, so a file another Tarsee sharing the temp folder is writing right now is never touched. A leftover too fresh
 * to remove is looked at again once it is old enough. No timer here keeps the process running.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const LEFTOVER_AGE_MS = 5 * 60_000;
// After a failed sentence, a sweep runs at once unless one ran less than this long ago; then it runs once this much has passed.
export const SWEEP_GAP_MS = 5 * 60_000;
// How long a file that could not be removed (Windows can hold a file that is being scanned) waits before it is tried again.
const RETRY_MS = 60_000;
// As crypto.randomUUID makes them: lower-case hex, version 4.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One engine's temp audio files: `${prefix}<uuid>${ext}` in the system temp folder. `label` starts the log line a
 * sweep writes when it has removed something.
 */
export function tempAudioFiles({ prefix, ext, label }) {
  const pattern = new RegExp(`^${escape(prefix)}${UUID}${escape(ext)}$`);
  let maxAgeMs = LEFTOVER_AGE_MS;
  let gapMs = SWEEP_GAP_MS;
  let started = false;
  let lastAt = -Infinity; // when the last sweep began
  let next = null; // the timer of the next sweep, and when it is due
  let nextAt = Infinity;
  let latest = Promise.resolve();

  function run() {
    clearTimeout(next);
    next = null;
    nextAt = Infinity;
    lastAt = Date.now();
    latest = latest.then(sweep).catch((err) => console.warn(`[${label}] the temp folder sweep failed: ${err?.message || err}`));
  }

  /** Sweeps in `ms`, unless a sweep is already due sooner. */
  function later(ms) {
    const at = Date.now() + Math.max(0, ms);
    if (next && nextAt <= at) return;
    clearTimeout(next);
    nextAt = at;
    next = setTimeout(run, at - Date.now());
    next.unref?.();
  }

  async function sweep() {
    const dir = os.tmpdir();
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return; }
    let removed = 0;
    let again = Infinity; // when the next look is needed: a leftover turns old enough, or one is tried again
    for (const name of names) {
      if (!pattern.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = await fs.promises.lstat(file);
        if (!st.isFile()) continue; // a folder or a link: not a file this engine made
        const oldAt = st.mtimeMs + maxAgeMs;
        if (oldAt > Date.now()) {
          again = Math.min(again, oldAt + 100);
          continue;
        }
        await fs.promises.unlink(file);
        removed++;
      } catch (err) {
        if (err?.code !== "ENOENT") again = Math.min(again, Date.now() + RETRY_MS);
      }
    }
    if (removed) console.log(`[${label}] removed ${removed} leftover audio file${removed === 1 ? "" : "s"} from the temp folder`);
    if (again !== Infinity) later(again - Date.now());
  }

  return {
    /** Where a new sentence's audio goes: a name of its own, so two sentences spoken at once never share a file. */
    newPath: () => path.join(os.tmpdir(), `${prefix}${crypto.randomUUID()}${ext}`),
    /** The engine has started: sweeps once for the whole process, however many engines are made. */
    atStart() {
      if (started) return;
      started = true;
      run();
    },
    /** A sentence failed: sweeps now, or once SWEEP_GAP_MS has passed since the last sweep. */
    afterFailure() {
      const wait = lastAt + gapMs - Date.now();
      if (wait <= 0) run();
      else later(wait);
    },
    /** Tests only: settles once the sweeps begun so far are done. */
    settled: () => latest,
    /** Tests only: as if the process had just started, with other ages and gaps if given. */
    reset({ leftoverAgeMs, sweepGapMs } = {}) {
      clearTimeout(next);
      next = null;
      nextAt = Infinity;
      started = false;
      lastAt = -Infinity;
      maxAgeMs = leftoverAgeMs ?? LEFTOVER_AGE_MS;
      gapMs = sweepGapMs ?? SWEEP_GAP_MS;
    },
  };
}
