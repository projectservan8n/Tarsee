import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBackgroundModel } from "../src/lib/background-turn.js";
import { BACKGROUND_DEFAULTS, MODEL_TIERS, tierOf } from "../src/config/constants.js";

// Unattended work is where an always-on agent quietly spends money: cron jobs,
// the 30-minute heartbeat, the boot checklist. The rule is that they run on a
// cheap floor unless something deliberately raises the tier.
//
// The floor was documented for months and never actually applied — the last
// fallback in the chain was the global interactive default (the Opus alias), so
// every trivial scheduled reminder ran top-tier. These tests pin the contract
// so the floor cannot silently regress into the interactive default again.

describe("background model floor", () => {
  it("defaults to the cheap tier when nothing is configured", () => {
    const model = resolveBackgroundModel(null);
    assert.equal(model, BACKGROUND_DEFAULTS.MODEL);
    assert.equal(tierOf(model), "haiku");
  });

  it("never falls back to a top tier", () => {
    for (const input of [null, undefined, "", "  ", "not-a-real-model"]) {
      const tier = tierOf(resolveBackgroundModel(input));
      assert.notEqual(tier, "fable", `${JSON.stringify(input)} escalated to fable`);
      assert.notEqual(tier, "opus", `${JSON.stringify(input)} escalated to opus`);
    }
  });

  it("honors an explicit escalation", () => {
    assert.equal(tierOf(resolveBackgroundModel("opus")), "opus");
    assert.equal(tierOf(resolveBackgroundModel("fable")), "fable");
    assert.equal(resolveBackgroundModel("claude-fable-5-1"), "claude-fable-5-1");
  });

  it("honors a caller-supplied floor over the global one", () => {
    assert.equal(tierOf(resolveBackgroundModel(null, "sonnet")), "sonnet");
  });

  it("the cheap floor really is the cheapest tier we ship", () => {
    // Guards against someone "raising the default a bit" without noticing they
    // just multiplied the cost of every scheduled job in every deployment.
    assert.equal(MODEL_TIERS[MODEL_TIERS.length - 1], tierOf(BACKGROUND_DEFAULTS.MODEL));
  });
});

describe("background ceilings", () => {
  it("caps turns well below the interactive limit", () => {
    // Interactive chat allows 50 turns. An unattended loop must not.
    assert.ok(BACKGROUND_DEFAULTS.MAX_TURNS > 0);
    assert.ok(BACKGROUND_DEFAULTS.MAX_TURNS < 50);
  });

  it("sets a positive spend ceiling and a finite timeout", () => {
    assert.ok(BACKGROUND_DEFAULTS.MAX_BUDGET_USD > 0);
    assert.ok(Number.isFinite(BACKGROUND_DEFAULTS.TIMEOUT_MS));
    assert.ok(BACKGROUND_DEFAULTS.TIMEOUT_MS > 0);
    // Boot runs once per build, so it gets more room than a recurring job.
    assert.ok(BACKGROUND_DEFAULTS.BOOT_TIMEOUT_MS >= BACKGROUND_DEFAULTS.TIMEOUT_MS);
  });
});
