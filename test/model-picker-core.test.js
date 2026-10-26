// The composer's model picker on the page (src/public/js/model-picker-core.js): which entry a chat's model is, what
// the button says ("Sonnet 5.5 · Medium"), the level a model runs at, what a pick saves, the number keys and the arrows.
// The list is the server's (lib/model-picker.js), built here from a catalog like the CLI's.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPicker } from "../src/lib/model-picker.js";

await import("../src/public/js/model-picker-core.js");
const P = globalThis.ModelPickerCore;

const levels = (rec, ids = ["low", "medium", "high", "xhigh", "max"]) => ({
  type: "effort",
  effort_options: ids.map((id) => ({ id, name: P.EFFORT_NAMES[id], ...(id === rec ? { badge: { message: "Recommended" } } : {}) })),
});
const m = (id, name, section, family, rec, ids) => ({ id, name, section, runtime: { family }, thinking: ids === null ? { type: "none" } : levels(rec, ids) });
const PICKER = buildPicker({
  catalog: {
    models: [
      m("claude-opus-5-5", "Opus 5.5", "main", "opus", "medium"),
      m("claude-fable-5-1", "Fable 5.1", "main", "fable", "high"),
      m("claude-sonnet-5-5", "Sonnet 5.5", "main", "sonnet", "medium"),
      m("claude-haiku-5-5", "Haiku 5.5", "main", "haiku", "medium"),
      m("claude-opus-4-6", "Opus 4.6", "overflow", "opus", "high", ["low", "medium", "high", "max"]),
      m("claude-haiku-4-5-20251001", "Haiku 4.5", "overflow", "haiku", null, null),
    ],
  },
  // Tarsee's list has no family words: the SDK's bundled CLI would take one to an older model (lib/model-catalog.js).
  aliases: {},
});
const DEFAULTS = { model: "sonnet", effort: "medium" };

describe("model picker on the page: which model a chat is on", () => {
  it("a family's word is its newest; an id is itself; a date or [1m] makes no difference", () => {
    assert.equal(P.entryFor(PICKER, "opus").name, "Opus 5.5");
    assert.equal(P.entryFor(PICKER, "sonnet[1m]").name, "Sonnet 5.5");
    assert.equal(P.entryFor(PICKER, "claude-opus-4-6").name, "Opus 4.6");
    assert.equal(P.entryFor(PICKER, "claude-haiku-4-5-20251001").name, "Haiku 4.5");
    assert.equal(P.entryFor(PICKER, "claude-opus-5-5").name, "Opus 5.5");
    assert.equal(P.entryFor(PICKER, "gpt-5"), null);
  });

  it("a model the list does not have is named from its id", () => {
    assert.equal(P.modelName(PICKER, "claude-opus-6"), "Opus 6");
    assert.equal(P.modelName(null, "claude-sonnet-5-5"), "Sonnet 5.5");
    assert.equal(P.nameFromId("claude-haiku-4-5-20251001"), "Haiku 4.5");
  });

  it("the check goes on the chat's model, whether it was saved as the word or the id", () => {
    const opus = PICKER.main[0];
    assert.equal(P.isPicked(PICKER, opus, "opus"), true);
    assert.equal(P.isPicked(PICKER, opus, "claude-opus-5-5"), true);
    assert.equal(P.isPicked(PICKER, opus, "sonnet"), false);
  });

  it("a pick saves the model's exact id, the newest and an older one alike", () => {
    assert.equal(P.pickValue(PICKER.main[2]), "claude-sonnet-5-5");
    assert.equal(P.pickValue(PICKER.more[0]), "claude-opus-4-6");
  });
});

describe("model picker on the page: the button and the levels", () => {
  it("nothing of the chat's own: the defaults, Sonnet at Medium", () => {
    const b = P.buttonLabel(PICKER, { model: null, effort: null }, DEFAULTS);
    assert.equal(b.model, "Sonnet 5.5");
    assert.equal(b.effort, "Medium");
    assert.equal(b.level, "medium");
  });

  it("the chat's own model and level, Extra for xhigh", () => {
    const b = P.buttonLabel(PICKER, { model: "opus", effort: "xhigh" }, DEFAULTS);
    assert.equal(`${b.model} · ${b.effort}`, "Opus 5.5 · Extra");
  });

  it("a level the model does not have becomes the nearest one below; no levels, no level", () => {
    const o46 = P.entryFor(PICKER, "claude-opus-4-6");
    assert.equal(P.effortFor(o46, "xhigh"), "high");
    assert.equal(P.effortFor(o46, "max"), "max");
    assert.equal(P.effortFor(P.entryFor(PICKER, "claude-haiku-4-5"), "high"), null);
    const b = P.buttonLabel(PICKER, { model: "claude-haiku-4-5", effort: "high" }, DEFAULTS);
    assert.equal(b.effort, "");
    assert.equal(b.model, "Haiku 4.5");
  });

  it("the five levels Claude Code shows, Medium Recommended only where the CLI says so", () => {
    const opus = P.entryFor(PICKER, "opus");
    assert.deepEqual(opus.efforts.map((e) => e.name), ["Low", "Medium", "High", "Extra", "Max"]);
    assert.deepEqual(opus.efforts.filter((e) => e.recommended).map((e) => e.id), ["medium"]);
    assert.deepEqual(P.entryFor(PICKER, "fable").efforts.filter((e) => e.recommended).map((e) => e.id), ["high"]);
  });
});

describe("model picker on the page: keys", () => {
  it("1 to 4 pick the models on top while the menu is open; other keys do not", () => {
    assert.equal(P.numberKey(PICKER, "1").name, "Opus 5.5");
    assert.equal(P.numberKey(PICKER, "4").name, "Haiku 5.5");
    assert.equal(P.numberKey(PICKER, "5"), null);
    assert.equal(P.numberKey(PICKER, "a"), null);
    assert.equal(P.numberKey(PICKER, "0"), null);
  });

  it("the arrows move and wrap, Home and End go to the ends", () => {
    assert.equal(P.nextIndex(6, -1, "ArrowDown"), 0);
    assert.equal(P.nextIndex(6, 5, "ArrowDown"), 0);
    assert.equal(P.nextIndex(6, 0, "ArrowUp"), 5);
    assert.equal(P.nextIndex(6, 3, "Home"), 0);
    assert.equal(P.nextIndex(6, 3, "End"), 5);
    assert.equal(P.nextIndex(0, 0, "ArrowDown"), -1);
  });
});
