// The daily retention sweep (lib/retention.js) also prunes Codex's rollouts (design 4.8 "Rollouts"): every Codex turn
// leaves a rollout-<time>-<thread>.jsonl under its home's sessions/YYYY/MM/DD/, in the ChatGPT plan's home
// (.codex-home) and the key providers' (.codex-home-keys). Ones untouched for 30 days (retention.codex_rollouts_days)
// go, with the day folders they leave empty; newer ones, and anything that isn't a rollout, stay.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-retention-codex-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { pruneOldRollouts } = await import("../src/lib/retention.js");
const codex = await import("../src/ai/providers/codex.js");
const rollouts = await import("../src/ai/codex-rollouts.js");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DAY = 86_400_000;
function rollout(home, day, name, ageDays, now) {
  const dir = path.join(tmp, home, "sessions", "2026", "10", day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "{}\n");
  const t = new Date(now - ageDays * DAY);
  fs.utimesSync(file, t, t);
  return file;
}

describe("Codex rollouts in the daily sweep", () => {
  it("prunes both Codex homes past the setting's age, keeps newer ones and anything else", () => {
    const now = Date.now();
    const oldPlan = rollout(".codex-home", "01", "rollout-2026-10-01T00-00-00-aaa.jsonl", 40, now);
    const oldKeys = rollout(".codex-home-keys", "02", "rollout-2026-10-02T00-00-00-bbb.jsonl", 31, now);
    const fresh = rollout(".codex-home-keys", "03", "rollout-2026-10-03T00-00-00-ccc.jsonl", 3, now);
    const other = rollout(".codex-home", "04", "notes.txt", 90, now);
    const settings = { get: (k) => (k === "retention.codex_rollouts_days" ? null : null) };

    assert.equal(pruneOldRollouts(settings, { stateDir: tmp, now }), 2);
    assert.ok(!fs.existsSync(oldPlan) && !fs.existsSync(oldKeys));
    assert.ok(!fs.existsSync(path.dirname(oldPlan)), "the day folder it left empty goes too");
    assert.ok(fs.existsSync(fresh));
    assert.ok(fs.existsSync(other), "only rollouts");

    const shorter = { get: (k) => (k === "retention.codex_rollouts_days" ? 2 : null) };
    assert.equal(pruneOldRollouts(shorter, { stateDir: tmp, now }), 1, "the setting shortens it");
    assert.ok(!fs.existsSync(fresh));
  });

  it("never throws, with no Codex home at all", () => {
    assert.equal(pruneOldRollouts({ get: () => null }, { stateDir: path.join(tmp, "nothing-here"), now: Date.now() }), 0);
  });

  it("the engine module still offers the same function", () => {
    assert.equal(codex.pruneCodexRollouts, rollouts.pruneCodexRollouts);
  });
});
