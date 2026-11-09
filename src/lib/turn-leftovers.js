/**
 * turn-leftovers.js: what a turn leaves behind when the server stops in the middle of it.
 *
 * A Codex turn copies the person's pictures to <system temp>/tarsee-codex/tarsee-images-* (ai/media.js
 * writeLocalImages), and a Verify works in <state>/verify/<provider>-* (ai/verify-model.js). Each turn removes its own
 * when it ends, but a redeploy, Ctrl+C, a crash or `node --watch` restarting can end the server first, and then
 * nothing would ever remove them (the pictures sit outside Tarsee's data folder, where deleting the chat can't reach).
 * src/server.js sweeps them once at boot. Only what is over an hour old goes, so a turn another Tarsee sharing these
 * folders is running right now is never touched (a Verify takes well under an hour).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the Codex engine writes a turn's pictures (each turn in a tarsee-images-* folder of its own). */
export const CODEX_IMAGE_DIR = path.join(os.tmpdir(), "tarsee-codex");
const IMAGE_FOLDER_RE = /^tarsee-images-/;
const MAX_AGE_MS = 3_600_000;

/**
 * Remove the leftover picture folders and Verify workspaces over maxAgeMs old. Returns { pictures, verify }, how many
 * of each went; never throws.
 */
export function sweepTurnLeftovers({ tmpDir = os.tmpdir(), stateDir, now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  const cutoff = now - maxAgeMs;
  const pictures = sweep(path.join(tmpDir, path.basename(CODEX_IMAGE_DIR)), (name) => IMAGE_FOLDER_RE.test(name), cutoff);
  const state = String(stateDir ?? "").trim();
  const verify = state ? sweep(path.join(state, "verify"), () => true, cutoff) : 0;
  return { pictures, verify };
}

function sweep(dir, wanted, cutoff) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const e of entries) {
    if (!wanted(e.name)) continue;
    const p = path.join(dir, e.name);
    try {
      if (fs.lstatSync(p).mtimeMs >= cutoff) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    } catch (err) {
      console.warn(`[boot] couldn't remove ${p}: ${err?.message || err}`);
    }
  }
  return removed;
}
