// The channel health monitor and Slack: a Socket Mode connection that stays down (Bolt gave up reconnecting) is
// restarted, and so is a Slack channel whose last start failed, once enough time has passed. A connection that is
// up, or only briefly down while Bolt reconnects, is left alone.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { checkSlack, SLACK_DOWN_MS } = await import("../src/lib/channel-health.js");

function manager(entry) {
  const restarts = [];
  return {
    restarts,
    channels: new Map(entry ? [["slack", entry]] : []),
    restart: async (type) => { restarts.push(type); },
  };
}

describe("checkSlack", () => {
  it("leaves a connected bot, and one reconnecting for a moment, alone", async () => {
    const up = manager({ status: "running", bot: { health: () => ({ connected: true, downForMs: 0 }) } });
    assert.equal(await checkSlack(up), false);
    const blip = manager({ status: "running", bot: { health: () => ({ connected: false, downForMs: 20_000 }) } });
    assert.equal(await checkSlack(blip), false);
    assert.deepEqual([...up.restarts, ...blip.restarts], []);
  });

  it("restarts a bot whose connection has been down too long", async () => {
    const down = manager({ status: "running", bot: { health: () => ({ connected: false, downForMs: SLACK_DOWN_MS + 1 }) } });
    assert.equal(await checkSlack(down), true);
    assert.deepEqual(down.restarts, ["slack"]);
  });

  it("tries a failed start again, but not on every check", async () => {
    const failed = manager({ status: "error", bot: null, error: "Could not connect to Slack" });
    const t0 = 1_000_000;
    assert.equal(await checkSlack(failed, { now: t0, enabled: true }), true);
    assert.equal(await checkSlack(failed, { now: t0 + 60_000, enabled: true }), false, "too soon");
    assert.equal(await checkSlack(failed, { now: t0 + SLACK_DOWN_MS + 1, enabled: true }), true);
    assert.equal(await checkSlack(failed, { now: t0 + 3 * SLACK_DOWN_MS, enabled: false }), false, "not when Slack was turned off");
    assert.deepEqual(failed.restarts, ["slack", "slack"]);
  });

  it("does nothing when Slack is not running at all", async () => {
    assert.equal(await checkSlack(manager(null)), false);
  });
});
