import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_MODELS,
  CLAUDE_MODELS_BY_ID,
  MODEL_TIERS,
  getRecommendedModel,
  resolveModelAlias,
  isKnownModel,
  tierOf,
} from "../src/config/constants.js";

// The registry is the single source of truth for every model Tarsee can run.
// These tests pin the invariants the rest of the app relies on: every tier has
// an alias, the newest model in each tier is reachable, exact ids beat
// substring guesses, and the default is an alias (never a stale pin).

describe("model registry", () => {
  it("has exactly one recommended model and it is an alias", () => {
    const recommended = CLAUDE_MODELS.filter((m) => m.recommended);
    assert.equal(recommended.length, 1);
    assert.equal(recommended[0].alias, true);
    assert.equal(getRecommendedModel(), recommended[0].id);
  });

  it("exposes every tier as an always-latest alias", () => {
    for (const tier of MODEL_TIERS) {
      const alias = CLAUDE_MODELS_BY_ID[tier];
      assert.ok(alias, `missing alias row for tier ${tier}`);
      assert.equal(alias.alias, true);
      assert.equal(alias.tier, tier);
    }
  });

  it("ranks fable above opus above sonnet above haiku", () => {
    assert.deepEqual(MODEL_TIERS, ["fable", "opus", "sonnet", "haiku"]);
  });

  it("pins Claude Fable 5.1 as the newest fable model", () => {
    const fable = CLAUDE_MODELS_BY_ID["claude-fable-5-1"];
    assert.ok(fable, "claude-fable-5-1 must be in the registry");
    assert.equal(fable.tier, "fable");
    assert.equal(fable.context, "1M");
    const pinnedFable = CLAUDE_MODELS.filter((m) => m.tier === "fable" && !m.alias);
    const newest = [...pinnedFable].sort((a, b) => b.released.localeCompare(a.released))[0];
    assert.equal(newest.id, "claude-fable-5-1");
  });

  it("every pinned row has a released stamp and every alias row does not", () => {
    for (const m of CLAUDE_MODELS) {
      if (m.alias) assert.equal(m.released, undefined, `${m.id} is an alias and must not carry released`);
      else assert.match(m.released, /^\d{4}-\d{2}$/, `${m.id} needs a YYYY-MM released stamp`);
    }
  });

  it("has no duplicate ids", () => {
    const ids = CLAUDE_MODELS.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("resolveModelAlias", () => {
  it("returns the bare alias for a tier name so the CLI resolves latest", () => {
    assert.equal(resolveModelAlias("fable"), "fable");
    assert.equal(resolveModelAlias("opus"), "opus");
    assert.equal(resolveModelAlias("Sonnet "), "sonnet");
    assert.equal(resolveModelAlias("HAIKU"), "haiku");
  });

  it("honors a full pinned id verbatim", () => {
    assert.equal(resolveModelAlias("claude-fable-5-1"), "claude-fable-5-1");
    assert.equal(resolveModelAlias("claude-opus-4-6"), "claude-opus-4-6");
  });

  it("resolves a short pinned form to the exact model, not a newer sibling", () => {
    // "fable-5" must NOT become claude-fable-5-1 just because 5.1 sorts first.
    assert.equal(resolveModelAlias("fable-5"), "claude-fable-5");
    assert.equal(resolveModelAlias("fable-5-1"), "claude-fable-5-1");
    assert.equal(resolveModelAlias("opus-4-8"), "claude-opus-4-8");
    assert.equal(resolveModelAlias("sonnet-5"), "claude-sonnet-5");
  });

  it("returns null for junk", () => {
    assert.equal(resolveModelAlias(""), null);
    assert.equal(resolveModelAlias(null), null);
    assert.equal(resolveModelAlias("gpt-4"), null);
  });
});

describe("tierOf / isKnownModel", () => {
  it("maps any known id to its tier", () => {
    assert.equal(tierOf("fable"), "fable");
    assert.equal(tierOf("claude-fable-5-1"), "fable");
    assert.equal(tierOf("claude-opus-5"), "opus");
    assert.equal(tierOf("claude-haiku-4-5"), "haiku");
  });

  it("guesses the tier from an unknown but well-formed id", () => {
    // A brand-new release the registry has not been taught yet should still
    // get a sensible badge instead of crashing the session bar.
    assert.equal(tierOf("claude-fable-6"), "fable");
    assert.equal(tierOf("claude-opus-6"), "opus");
    assert.equal(tierOf("claude-sonnet-6"), "sonnet");
    assert.equal(tierOf("claude-haiku-5"), "haiku");
    assert.equal(tierOf("something-else"), null);
    assert.equal(tierOf(""), null);
  });

  it("isKnownModel is strict", () => {
    assert.equal(isKnownModel("fable"), true);
    assert.equal(isKnownModel("claude-fable-5-1"), true);
    assert.equal(isKnownModel("claude-fable-6"), false);
  });
});
