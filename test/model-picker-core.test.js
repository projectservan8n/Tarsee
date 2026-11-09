// The composer's model picker on the page (src/public/js/model-picker-core.js): which entry a chat's model is, what
// the button says ("Sonnet 5.5 · Medium"), the level a model runs at, what a pick saves, the number keys and the arrows.
// The list is the server's (lib/model-picker.js), built here from a catalog like the CLI's; with every AI, the list the
// server builds (lib/model-catalog.js getModelGroups, the body of GET /api/models): one group per ready AI, search,
// badges, the "a message at a time" note, the warning when a chat's AI is gone, the effort clamp.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPicker } from "../src/lib/model-picker.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-model-picker-core-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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

/* ---------------------------------------------------------------------------------------------- every AI's models */

const { getModelGroups, __setForTests } = await import("../src/lib/model-catalog.js");
const { setCatalogModels } = await import("../src/ai/provider-registry.js");

const STATES = { claude: "ready", anthropic: "needs-key", chatgpt: "ready", openai: "needs-key", openrouter: "ready", deepseek: "ready", local: "blocked-keys-only" };
const SETTINGS = new Map([["ai.openrouter.verified", { "qwen/qwen3-coder": { engine: "codex", at: "2026-11-01", engineVersion: "0.167.0" } }]]);
const store = { get: (k) => (SETTINGS.has(k) ? SETTINGS.get(k) : null) };
__setForTests({ catalogDirs: [path.join(tmp, "none")], cli: { bin: "/x", catalog: { issuedAt: 1, config: {
  models: [
    { id: "claude-opus-5-5", name: "Opus 5.5", section: "main", runtime: { family: "opus" }, thinking: levels("medium") },
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5", section: "main", runtime: { family: "sonnet" }, thinking: levels("medium") },
    { id: "claude-haiku-5-5", name: "Haiku 5.5", section: "main", runtime: { family: "haiku" }, thinking: levels("medium") },
  ],
} } } });
setCatalogModels("chatgpt-models", [{ id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["low", "medium", "high"], default: true }]);
setCatalogModels("openrouter", [
  { id: "qwen/qwen3-coder", label: "Qwen: Qwen3 Coder", vendor: "qwen", efforts: ["low", "high"], price: { in: 0.2, out: 0.8 } },
  { id: "deepseek/deepseek-chat:free", label: "DeepSeek: DeepSeek Chat (free)", vendor: "deepseek", free: true },
]);
const LIST = await getModelGroups({ store, isShipped: () => true, statusFor: (id) => ({ state: STATES[id], detail: "", fix: "" }), env: {}, listChatgptModels: async () => [] });
const G = LIST.picker;
const GD = LIST.defaults;
after(() => { setCatalogModels("chatgpt-models", []); setCatalogModels("openrouter", []); __setForTests({ catalogDirs: null, cli: null }); });

describe("model picker on the page: every ready AI in its own group", () => {
  it("the groups the server sent, the default AI first", () => {
    assert.deepEqual(P.groupsOf(G).map((g) => g.provider), ["claude", "chatgpt", "openrouter", "deepseek"]);
    assert.deepEqual(P.groupsOf(PICKER).map((g) => g.provider), [null], "the Claude-only list is one group");
  });

  it("a ref finds its model on its AI; a bare model looks on the default AI first", () => {
    assert.equal(P.entryFor(G, "deepseek:deepseek-v4-pro").name, "DeepSeek Pro");
    assert.equal(P.entryFor(G, "deepseek-flash").name, "DeepSeek Flash");
    assert.equal(P.entryFor(G, "opus").name, "Opus 5.5");
    assert.equal(P.entryFor(G, "claude-code:sonnet").name, "Sonnet 5.5", "the Claude plan's old id");
    assert.equal(P.entryFor(G, "luna", "chatgpt"), null, "only an exact id, not a guess");
    assert.equal(P.entryFor(G, "gpt-6-luna", "chatgpt").name, "GPT-6 Luna");
    assert.equal(P.entryFor(G, "openai:gpt-6-luna"), null, "that AI isn't in the list");
    assert.equal(P.entryFor(G, "openrouter:qwen/qwen3-coder").name, "Qwen: Qwen3 Coder");
  });

  it("a pick saves the model's ref, its AI included; the check goes on that AI's row only", () => {
    const pro = P.entryFor(G, "deepseek:deepseek-v4-pro");
    assert.equal(P.pickValue(pro), "deepseek:deepseek-v4-pro");
    assert.equal(P.isPicked(G, pro, "deepseek:deepseek-v4-pro"), true);
    assert.equal(P.isPicked(G, pro, "deepseek-v4-pro", "deepseek"), true);
    assert.equal(P.isPicked(G, P.entryFor(G, "deepseek:deepseek-flash"), "deepseek:deepseek-v4-pro"), false);
  });

  it("the button: the chat's AI and model, its level clamped to the ones the model has", () => {
    const b = P.buttonLabel(G, { provider: "deepseek", model: "deepseek:deepseek-v4-pro", effort: "xhigh" }, GD);
    assert.equal(`${b.model} · ${b.effort}`, "DeepSeek Pro · High");
    assert.equal(b.warning, null);
    assert.equal(P.buttonLabel(G, { model: null, effort: null }, GD).model, "Sonnet 5.5", "the default AI's default model");
    assert.equal(P.effortFor(P.entryFor(G, "deepseek:deepseek-flash"), "medium"), "low");
    assert.equal(P.effortFor(P.entryFor(G, "openrouter:deepseek/deepseek-chat:free"), "high"), null, "no levels, no level");
  });

  it("a chat whose AI is gone: a warning, and the default shown", () => {
    const b = P.buttonLabel(G, { provider: "anthropic", model: "anthropic:claude-opus-5-5", effort: "max" }, GD);
    assert.equal(b.warning, "Anthropic API key not connected, using default");
    assert.equal(b.model, "Sonnet 5.5");
    assert.match(b.title, /not connected, using default/);
    assert.equal(P.warningFor(G, { provider: "local", model: "local:llama3" }), "Local AI is off (API keys only), using default");
    assert.equal(P.warningFor(G, { provider: "deepseek", model: "deepseek:deepseek-flash" }), null);
    assert.equal(P.warningFor(PICKER, { model: "claude-opus-4-6" }), null, "the Claude-only list knows no AIs");
  });

  it("search finds models on every AI by name, id or AI, pickable ones first", () => {
    assert.deepEqual(P.search(G, "flash").map((r) => r.entry.id), ["deepseek-flash"]);
    assert.deepEqual(P.search(G, "deepseek").map((r) => r.entry.id).slice(0, 2), ["deepseek-flash", "deepseek-v4-pro"]);
    const ds = P.search(G, "deepseek").map((r) => r.entry.id);
    assert.ok(ds.indexOf("deepseek/deepseek-chat:free") > ds.indexOf("deepseek-v4-pro"), "the unverified one last");
    assert.equal(P.search(G, "qwen coder")[0].group.label, "OpenRouter");
    assert.deepEqual(P.search(G, ""), []);
  });

  it("badges, the note on Codex models and on rows that need verifying", () => {
    const texts = (e) => P.badgesFor(e).map((b) => b.text);
    assert.ok(texts(P.entryFor(G, "chatgpt:gpt-6-luna")).includes("Plan"));
    assert.ok(texts(P.entryFor(G, "openrouter:deepseek/deepseek-chat:free")).includes("Free"));
    assert.deepEqual(texts(P.entryFor(G, "deepseek:deepseek-flash")), ["$"]);
    assert.equal(P.noteFor(P.entryFor(G, "chatgpt:gpt-6-luna")), "Replies appear a message at a time");
    assert.equal(P.noteFor(P.entryFor(G, "deepseek:deepseek-flash")), null);
    assert.equal(P.noteFor(P.entryFor(G, "openrouter:deepseek/deepseek-chat:free")), "Verify it in Settings > AI first");
    assert.equal(P.detailFor(P.entryFor(G, "deepseek:deepseek-v4-pro")), "1M context");
    assert.equal(P.detailFor(P.entryFor(G, "deepseek:deepseek-flash")), "1M context · sees images");
  });

  it("the model a turn ran on (its route): the list's name for it, else the name the turn gave", () => {
    assert.equal(P.turnName(G, { model: "deepseek-flash", provider: "deepseek", label: "DeepSeek Flash" }), "DeepSeek Flash");
    assert.equal(P.turnName(G, { model: "claude-sonnet-5-5", provider: "claude", label: "Claude Sonnet" }), "Sonnet 5.5", "the list's own words for it");
    assert.equal(P.turnName(G, { model: "gpt-9-new", provider: "chatgpt", label: "GPT-9 New" }), "GPT-9 New", "a model the list doesn't have yet");
    assert.equal(P.turnName(G, { model: "x-unknown", provider: "local" }), P.nameFromId("x-unknown"), "no name given: one made from the id");
    assert.equal(P.turnName(G, null), null);
  });

  it("what a change of pick sends: only what changed, the AI included", () => {
    const before = { provider: null, model: null, effort: "high" };
    assert.deepEqual(P.pickChange(before, { provider: "deepseek", model: "deepseek:deepseek-flash", effort: "high" }), { provider: "deepseek", model: "deepseek:deepseek-flash" });
    assert.deepEqual(P.pickChange(before, { ...before, effort: "low" }), { effort: "low" });
    assert.deepEqual(P.pickChange(before, { ...before }), {});
    assert.deepEqual(P.pickChange({ provider: "deepseek", model: "deepseek:deepseek-flash", effort: null }, { provider: null, model: null, effort: null }), { provider: null, model: null }, "back to the default");
    assert.deepEqual(P.pickChange(null, { provider: "chatgpt", model: null, effort: null }), { provider: "chatgpt" }, "a new chat's first pick: what it has");
  });

  it("number keys count the pickable rows on top, across the AIs", () => {
    assert.equal(P.numberKey(G, "1").name, "Opus 5.5");
    assert.equal(P.numberKey(G, "4").name, "Haiku 5.5", "Fable 5.1 joins from Tarsee's table: the catalog has no Fable");
    assert.equal(P.numberKey(G, "5").name, "GPT-6 Luna");
    assert.equal(P.topRows(G).every((e) => e.selectable !== false), true);
  });
});
