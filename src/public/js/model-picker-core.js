/**
 * The composer's model picker, its rules with no page (js/model-picker.js draws it; test/model-picker-core.test.js
 * checks it in node). The list itself comes from the server (GET /api/chat/models, picker): Claude Code's own
 * catalog, the newest of each family in `main`, older ones in `more` (lib/model-picker.js).
 *
 *   entryFor      the list's entry for a chat's model ("opus", "claude-opus-4-7", "sonnet[1m]")
 *   modelName     what the button says for it: "Opus 5.5", or a name made from the id
 *   effortFor     the level a chat runs at on that model (its own, or the default; one the model has)
 *   effortName    "Extra" for xhigh, "Max", ...
 *   buttonLabel   { model: "Sonnet 5.5", effort: "High", title } for the composer's button
 *   pickValue     what picking an entry saves: its exact id (the family's word only when the server offers one)
 *   isPicked      whether an entry is the chat's model (for the check)
 *   numberKey     which entry a number key picks while the menu is open (1 to the count on top)
 *   nextIndex     the arrow keys, Home and End over a menu's rows
 *
 * Loaded by index.html as a plain script (window.ModelPickerCore) and by the tests as a module.
 */
(function () {
  "use strict";

  const EFFORT_NAMES = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" };
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

  const bare = (v) => String(v || "").toLowerCase().trim().replace(/\[1m\]$/, "");

  /** "claude-opus-5-5" as "Opus 5.5", "claude-haiku-4-5-20251001" as "Haiku 4.5", "opus" as "Opus". */
  function nameFromId(v) {
    const s = bare(v);
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(s);
    if (m) return `${cap(m[1])} ${m[2]}${m[3] != null ? `.${m[3]}` : ""}`;
    return s ? cap(s) : "";
  }

  /** The id with a date folded away ("claude-haiku-4-5-20251001" is "claude-haiku-4-5"). */
  function baseId(v) {
    const s = bare(v);
    const m = /^(claude-[a-z]+-\d+(?:-\d{1,2})?)(?:-\d{8})?$/.exec(s);
    return m ? m[1] : s;
  }

  function entries(picker) {
    return [...(picker?.main || []), ...(picker?.more || [])];
  }

  /** The list's entry for a model a chat runs on: a family's word is its newest, an id is itself. */
  function entryFor(picker, value) {
    const v = bare(value);
    if (!v) return null;
    const main = picker?.main || [];
    return main.find((e) => e.alias === v)
      || main.find((e) => e.family === v)
      || entries(picker).find((e) => e.id === baseId(v))
      || null;
  }

  function modelName(picker, value) {
    return entryFor(picker, value)?.name || nameFromId(value) || "Claude";
  }

  function effortName(entry, effort) {
    if (!effort) return "";
    return entry?.efforts?.find((e) => e.id === effort)?.name || EFFORT_NAMES[effort] || cap(effort);
  }

  /**
   * The level a chat runs at on a model: its own, else the default; a level the model does not have becomes the
   * nearest one it has below (Claude Code does the same), and a model with no levels has none.
   */
  function effortFor(entry, effort, defaultEffort = "medium") {
    const want = String(effort || defaultEffort || "medium").toLowerCase();
    if (!entry) return want;
    const have = (entry.efforts || []).map((e) => e.id);
    if (!have.length) return null;
    if (have.includes(want)) return want;
    const order = ["low", "medium", "high", "xhigh", "max"];
    for (let i = order.indexOf(want); i >= 0; i--) if (have.includes(order[i])) return order[i];
    return have[0];
  }

  /** The composer's button: "Sonnet 5.5" and "High", from the chat's own pick or the defaults. */
  function buttonLabel(picker, pick, defaults) {
    const modelValue = pick?.model || defaults?.model || "sonnet";
    const entry = entryFor(picker, modelValue);
    const model = entry?.name || nameFromId(modelValue) || "Claude";
    const level = effortFor(entry, pick?.effort, defaults?.effort);
    const effort = level ? effortName(entry, level) : "";
    return { model, effort, entry, level, title: effort ? `${model}, ${effort} effort. Change the model or the effort` : `${model}. Change the model` };
  }

  /** What picking an entry saves for the chat. */
  function pickValue(entry) {
    return entry ? (entry.alias || entry.id) : null;
  }

  /** Whether an entry is the chat's model (its word or its id). */
  function isPicked(picker, entry, value) {
    const cur = entryFor(picker, value);
    return !!(cur && entry && cur.id === entry.id);
  }

  /** The entry a number key picks while the menu is open: 1 is the first on top, as Claude Code numbers them. */
  function numberKey(picker, key) {
    if (!/^[1-9]$/.test(String(key))) return null;
    return (picker?.main || [])[Number(key) - 1] || null;
  }

  /** The row the arrows, Home and End move to over `count` rows from `index` (-1: none yet). Wraps around. */
  function nextIndex(count, index, key) {
    if (!count) return -1;
    if (key === "Home") return 0;
    if (key === "End") return count - 1;
    if (key === "ArrowDown") return index < 0 ? 0 : (index + 1) % count;
    if (key === "ArrowUp") return index < 0 ? count - 1 : (index - 1 + count) % count;
    return index;
  }

  const api = { EFFORT_NAMES, nameFromId, baseId, entryFor, modelName, effortName, effortFor, buttonLabel, pickValue, isPicked, numberKey, nextIndex };
  globalThis.ModelPickerCore = Object.freeze(api);
})();
