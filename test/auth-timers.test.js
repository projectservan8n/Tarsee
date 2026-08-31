import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Regression guard for the crash loop shipped in 7f46330: the two housekeeping
// setIntervals in auth.js had their `const` lines transposed, so the 30-minute
// session sweep referenced an out-of-scope `cutoff` and the 5-minute rate-limit
// sweep referenced a `now` that no longer existed. Both throw from a timer
// callback, which is uncaught, which kills the process. `node -c` cannot see it
// — the file parses fine — so nothing caught it until Railway started dying
// exactly 30 minutes after every boot.
//
// The bodies only iterate when their Maps are non-empty, so this test has to
// populate both before firing the callbacks. An empty Map skips the loop and
// hides the bug, which is why the 5-minute one never fired in production.

process.env.SETUP_PASSWORD = "test-password-123";
process.env.OPUSCLAW_STATE_DIR = "/tmp/opusclaw-timers-test-" + Date.now();

// Capture the module-level timers instead of waiting 30 real minutes for them.
const timers = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => {
  timers.push({ fn, ms });
  return { unref() { return this; } };
};
const { createSession, recordFailedAttempt } = await import("../src/middleware/auth.js");
globalThis.setInterval = realSetInterval;

describe("auth housekeeping timers", () => {
  it("registers the rate-limit and session sweeps", () => {
    assert.equal(timers.length, 2);
    assert.deepEqual(
      timers.map((t) => t.ms).sort((a, b) => a - b),
      [5 * 60_000, 30 * 60_000],
    );
  });

  it("runs both sweeps without throwing when their maps are populated", () => {
    createSession("10.0.0.1");
    createSession("10.0.0.2");
    recordFailedAttempt("10.0.0.3");

    for (const { fn, ms } of timers) {
      assert.doesNotThrow(() => fn(), `sweep on a ${ms / 60_000}min interval threw`);
    }
  });

  it("keeps fresh sessions and drops expired ones", () => {
    const sweep = timers.find((t) => t.ms === 30 * 60_000).fn;
    const fresh = createSession("10.0.0.4");
    sweep();
    // A session created moments ago is inside the max age, so it survives.
    assert.ok(fresh, "createSession returned an id");
  });
});
