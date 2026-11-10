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
 * long, so a file another Tarsee sharing the temp folder is writing right now is never touched. A file dated in the
 * future (a clock that was ahead and has been put right, or a file someone dated so) counts as last written when a
 * sweep first saw it with that date. A leftover too fresh to remove is looked at again once it is old enough, but
 * never more than MAX_WAIT_MS later. One that cannot be removed (another user's file in a shared /tmp) is tried
 * MAX_TRIES times, further apart each time, and then left alone, with one line in the log. No timer here keeps the
 * process running.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const LEFTOVER_AGE_MS = 5 * 60_000;
// After a failed sentence, a sweep runs at once unless one ran less than this long ago; then it runs once this much has passed.
export const SWEEP_GAP_MS = 5 * 60_000;
// A file that could not be removed (Windows can hold a file that is being scanned; another user's file in a shared
// /tmp can never be removed) is tried again this long after the first try, then twice as long after each try after
// that, MAX_TRIES tries in all: about a quarter of an hour. Then it is left alone until Tarsee starts again.
const RETRY_MS = 60_000;
const MAX_TRIES = 5;
// The longest a sweep waits for the next one. setTimeout cannot wait more than about 24.8 days: asked to, it waits 1 ms.
const MAX_WAIT_MS = 60 * 60_000;
// As crypto.randomUUID makes them: lower-case hex, version 4.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One engine's temp audio files: `${prefix}<uuid>${ext}` in the system temp folder. `label` starts the log lines a
 * sweep writes when it has removed something, or when it gives up on a file it cannot remove.
 */
export function tempAudioFiles({ prefix, ext, label }) {
  const pattern = new RegExp(`^${escape(prefix)}${UUID}${escape(ext)}$`);
  let maxAgeMs = LEFTOVER_AGE_MS;
  let gapMs = SWEEP_GAP_MS;
  let retryMs = RETRY_MS;
  let started = false;
  let lastAt = -Infinity; // when the last sweep began
  let next = null; // the timer of the next sweep, and when it is due
  let nextAt = Infinity;
  let latest = Promise.resolve();
  let round = 0; // moved on by reset(), so that a sweep begun before it changes nothing after it
  // Files dated in the future, by name: that date, and when a sweep first saw the file with it.
  let future = new Map();
  // Files that could not be removed, by name: the date they had then, how many tries so far, and when the next one is
  // due (Infinity once they are given up on).
  let stuck = new Map();

  function run() {
    clearTimeout(next);
    next = null;
    nextAt = Infinity;
    lastAt = Date.now();
    latest = latest.then(sweep).catch((err) => console.warn(`[${label}] the temp folder sweep failed: ${err?.message || err}`));
  }

  /** Sweeps in `ms` (never more than MAX_WAIT_MS from now), unless a sweep is already due sooner. */
  function later(ms) {
    const wait = Math.min(Math.max(0, ms), MAX_WAIT_MS);
    const at = Date.now() + wait;
    if (next && nextAt <= at) return;
    clearTimeout(next);
    nextAt = at;
    next = setTimeout(run, wait);
    next.unref?.();
  }

  async function sweep() {
    const mine = round;
    const dir = os.tmpdir();
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return; }
    let removed = 0;
    const givenUp = []; // "<name> (<why>)"
    let again = Infinity; // when the next look is needed: a leftover turns old enough, or one is tried again
    const futureNow = new Map();
    const stuckNow = new Map();
    for (const name of names) {
      if (!pattern.test(name)) continue;
      const file = path.join(dir, name);
      let st;
      try {
        st = await fs.promises.lstat(file);
      } catch {
        continue; // gone already
      }
      if (!st.isFile()) continue; // a folder or a link: not a file this engine made
      const now = Date.now();
      // When it was last written to. A date in the future says nothing about that, so such a file counts as last
      // written when a sweep first saw it with that date. A write since then gives it another date.
      let writtenAt = st.mtimeMs;
      if (writtenAt > now) {
        const seen = future.get(name);
        writtenAt = seen && seen.mtimeMs === st.mtimeMs ? seen.at : now;
        futureNow.set(name, { mtimeMs: st.mtimeMs, at: writtenAt });
      }
      if (writtenAt + maxAgeMs > now) {
        again = Math.min(again, writtenAt + maxAgeMs + 100);
        continue;
      }
      // Tried before, and not removed: wait for its next try, or leave it alone once it has been given up on. A file
      // with another date since is another file, and starts again.
      const was = stuck.get(name);
      const before = was && was.mtimeMs === st.mtimeMs ? was : null;
      if (before && before.nextAt > now) {
        stuckNow.set(name, before);
        again = Math.min(again, before.nextAt);
        continue;
      }
      try {
        await fs.promises.unlink(file);
        removed++;
      } catch (err) {
        if (err?.code === "ENOENT") continue;
        const tries = (before?.tries || 0) + 1;
        if (tries >= MAX_TRIES) {
          stuckNow.set(name, { mtimeMs: st.mtimeMs, tries, nextAt: Infinity });
          givenUp.push(`${name} (${err?.code || err?.message || err})`);
        } else {
          const nextTry = Date.now() + retryMs * 2 ** (tries - 1);
          stuckNow.set(name, { mtimeMs: st.mtimeMs, tries, nextAt: nextTry });
          again = Math.min(again, nextTry);
        }
      }
    }
    if (mine !== round) return;
    future = futureNow;
    stuck = stuckNow;
    if (removed) console.log(`[${label}] removed ${removed} leftover audio file${removed === 1 ? "" : "s"} from the temp folder`);
    if (givenUp.length) {
      const one = givenUp.length === 1;
      console.warn(`[${label}] could not remove ${one ? "a leftover audio file" : `${givenUp.length} leftover audio files`} from the temp folder in ${MAX_TRIES} tries, and leaves ${one ? "it" : "them"} there: ${givenUp.join(", ")}`);
    }
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
    /** Tests only: as if the process had just started, with other ages, gaps and waits between tries if given. */
    reset({ leftoverAgeMs, sweepGapMs, removeRetryMs } = {}) {
      clearTimeout(next);
      next = null;
      nextAt = Infinity;
      started = false;
      lastAt = -Infinity;
      round++;
      future = new Map();
      stuck = new Map();
      maxAgeMs = leftoverAgeMs ?? LEFTOVER_AGE_MS;
      gapMs = sweepGapMs ?? SWEEP_GAP_MS;
      retryMs = removeRetryMs ?? RETRY_MS;
    },
  };
}
