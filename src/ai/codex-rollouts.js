/**
 * codex-rollouts.js: Codex's own record of each thread (a rollout, $CODEX_HOME/sessions/YYYY/MM/DD/
 * rollout-<time>-<thread>.jsonl), kept tidy. lib/retention.js prunes old ones from both Codex homes (design 4.8
 * "Rollouts"); the engine (providers/codex.js) re-exports it.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Remove rollouts (and the day folders they leave empty) untouched for maxAgeDays, under each Codex home's sessions/.
 * Returns how many files went.
 */
export function pruneCodexRollouts({ homes = [], maxAgeDays = 30, now = Date.now(), fsImpl = fs } = {}) {
  const cutoff = now - maxAgeDays * 86_400_000;
  let removed = 0;
  const sweep = (dir, depth) => {
    let entries;
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) {
        sweep(p, depth - 1);
        try { if (!fsImpl.readdirSync(p).length) fsImpl.rmdirSync(p); } catch { /* not empty, or gone */ }
      } else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        try { if (fsImpl.statSync(p).mtimeMs < cutoff) { fsImpl.rmSync(p, { force: true }); removed++; } } catch { /* gone */ }
      }
    }
  };
  for (const home of homes) if (home) sweep(path.join(home, "sessions"), 3);
  return removed;
}
