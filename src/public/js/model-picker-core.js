/**
 * The composer's model picker, its rules with no page (js/model-picker.js draws it; test/model-picker-core.test.js
 * checks it in node). The list itself comes from the server (GET /api/models, or the older /api/chat/models: the
 * `picker` in its answer). With every AI it holds one group per AI that is ready, the default AI first
 * (lib/model-catalog.js getModelGroups), and the AIs that aren't ready in `unavailable`. A list with no groups is the
 * Claude-only one: Claude Code's catalog, the newest of each family in `main`, older ones in `more`
 * (lib/model-picker.js). Every rule below takes either.
 *
 *   groupsOf      the list's groups ({ provider, label, sections: [{ id, label, collapsed, entries }] })
 *   entryFor      the list's entry for a chat's model: a ref ("deepseek:deepseek-flash"), an id, or a family word
 *   modelName     what the button says for it: "Opus 5.5", "DeepSeek Flash", or a name made from the id
 *   effortFor     the level a chat runs at on that model (its own, or the default; one the model has)
 *   effortName    "Extra" for xhigh, "Max", ...
 *   buttonLabel   { model: "Sonnet 5.5", effort: "High", warning, title } for the composer's button
 *   warningFor    "DeepSeek not connected, using default" when a chat's own model isn't what runs
 *   pickValue     what picking an entry saves: its ref (its AI and id), or on the Claude-only list its exact id
 *   isPicked      whether an entry is the chat's model (for the check)
 *   search        the models whose name, id or AI hold every word typed, the pickable ones first
 *   badgesFor     Plan, Free, an estimated cost tier ("$$"), Verified
 *   noteFor       "Replies appear a message at a time", "Verify it in Settings > AI first", Fable's note
 *   detailFor     "1M context · sees images"
 *   topRows       the pickable rows shown on top (not in a list that opens), in order
 *   numberKey     which entry a number key picks while the menu is open (1 to the count on top)
 *   nextIndex     the arrow keys, Home and End over a menu's rows
 *
 * Loaded by index.html as a plain script (window.ModelPickerCore) and by the tests as a module.
 */
(function () {
  "use strict";

  const EFFORT_NAMES = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" };
  const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
  /** Each AI's name, for one the list doesn't carry (the server's `unavailable` names it when it can). */
  const PROVIDER_LABELS = {
    claude: "Claude plan", anthropic: "Anthropic API key", chatgpt: "ChatGPT plan", openai: "OpenAI API key",
    openrouter: "OpenRouter", deepseek: "DeepSeek", local: "Local AI",
  };
  const PROVIDER_ALIASES = { "claude-code": "claude" };
  /** The AIs with Claude's own models (provider-registry.js: catalog "claude"): the Claude plan and an Anthropic key. */
  const CLAUDE_MODEL_AIS = new Set(["claude", "anthropic"]);
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

  const bare = (v) => String(v || "").toLowerCase().trim().replace(/\[1m\]$/, "");

  /** "claude-opus-5-5" as "Opus 5.5", "claude-haiku-4-5-20251001" as "Haiku 4.5", "opus" as "Opus". */
  function nameFromId(v) {
    const s = bare(v);
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(s);
    if (m) return `${cap(m[1])} ${m[2]}${m[3] != null ? `.${m[3]}` : ""}`;
    return s ? cap(s.includes("/") ? s.slice(s.lastIndexOf("/") + 1) : s) : "";
  }

  /** The id with a date folded away ("claude-haiku-4-5-20251001" is "claude-haiku-4-5"). */
  function baseId(v) {
    const s = bare(v);
    const m = /^(claude-[a-z]+-\d+(?:-\d{1,2})?)(?:-\d{8})?$/.exec(s);
    return m ? m[1] : s;
  }

  /** A provider id as the list writes it ("claude-code" is the Claude plan), or null. */
  function providerId(v) {
    const k = String(v || "").toLowerCase().trim();
    if (!k) return null;
    if (Object.hasOwn(PROVIDER_LABELS, k)) return k;
    return PROVIDER_ALIASES[k] || null;
  }

  /** "deepseek:deepseek-flash" as { provider: "deepseek", model: "deepseek-flash" }; a bare model has no provider. */
  function splitRef(value) {
    const s = String(value || "").trim();
    const i = s.indexOf(":");
    if (i > 0) {
      const p = providerId(s.slice(0, i));
      if (p) return { provider: p, model: s.slice(i + 1).trim() };
    }
    return { provider: null, model: s };
  }

  /** The list's groups. The Claude-only list (main and more, no groups) is one group with no provider. */
  function groupsOf(picker) {
    if (Array.isArray(picker?.groups)) return picker.groups;
    if (!picker || (!picker.main && !picker.more)) return [];
    const main = picker.main || [];
    const more = picker.more || [];
    return [{
      provider: null, label: null, main, more,
      sections: [{ id: "main", label: null, entries: main }, ...(more.length ? [{ id: "more", label: "More models", collapsed: true, entries: more }] : [])],
    }];
  }

  function sectionsOf(group) {
    if (Array.isArray(group?.sections)) return group.sections;
    return [{ id: "main", label: null, entries: group?.main || [] }, { id: "more", label: "More models", collapsed: true, entries: group?.more || [] }];
  }

  function groupEntries(group) {
    return sectionsOf(group).flatMap((s) => s.entries || []);
  }

  function entries(picker) {
    return groupsOf(picker).flatMap(groupEntries);
  }

  /** A model in one group: its family's word (Claude's newest), its id, or (no model) the group's default. */
  function findIn(group, model) {
    const all = groupEntries(group);
    const v = bare(model);
    if (!v) {
      const d = bare(group.defaultModel);
      return (d && all.find((e) => bare(e.id) === d)) || all.find((e) => e.id === "") || null;
    }
    const top = sectionsOf(group).filter((s) => !s.collapsed).flatMap((s) => s.entries || []);
    return top.find((e) => e.alias === v)
      || top.find((e) => e.family && e.family === v)
      || all.find((e) => bare(e.id) === v)
      || all.find((e) => e.family && baseId(e.id) === baseId(v))
      || null;
  }

  /**
   * The list's entry for a model a chat runs on. A ref names its AI; a bare model is looked for on `provider` when
   * given, else on the default AI first and then the others. A family's word is its newest, an id is itself.
   */
  function entryFor(picker, value, provider) {
    const ref = splitRef(value);
    const p = ref.provider || providerId(provider);
    if (!ref.model && !p) return null;
    const groups = groupsOf(picker);
    if (p) {
      const g = groups.find((x) => x.provider === p);
      return g ? findIn(g, ref.model) : null;
    }
    const first = groups.filter((g) => !g.provider || g.default);
    for (const g of [...first, ...groups.filter((g) => !first.includes(g))]) {
      const e = findIn(g, ref.model);
      if (e) return e;
    }
    return null;
  }

  function modelName(picker, value, provider) {
    const e = entryFor(picker, value, provider);
    if (e) return e.name;
    const ref = splitRef(value);
    return nameFromId(ref.model) || PROVIDER_LABELS[ref.provider || providerId(provider)] || "Claude";
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
    for (let i = EFFORT_ORDER.indexOf(want); i >= 0; i--) if (have.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
    return have[0];
  }

  /**
   * A model chosen before Tarsee had other AIs: kept bare ("haiku", "claude-sonnet-4-6"), with no AI of its own.
   * Only a list of AIs tells it apart; on the Claude-only list every model is bare.
   */
  function isLegacyPick(picker, pick) {
    return Array.isArray(picker?.groups) && !!String(pick?.model || "").trim()
      && !providerId(pick?.provider) && !splitRef(pick?.model).provider;
  }

  /**
   * The AI a chat's pick is on: its own provider, or the one its model's ref names. A model chosen before Tarsee had
   * other AIs goes with its chat to the default AI (ai/turn.js resolveTarget runs it there).
   */
  function pickProvider(pick, picker = null, defaults = null) {
    return providerId(pick?.provider) || splitRef(pick?.model).provider
      || (isLegacyPick(picker, pick) ? providerId(defaults?.provider) : null);
  }

  /** An AI's name, as the list gives it. */
  function providerLabel(picker, id) {
    return groupsOf(picker).find((g) => g.provider === id)?.label
      || (picker?.unavailable || []).find((u) => u.provider === id)?.label || PROVIDER_LABELS[id] || id;
  }

  /**
   * The warning a chat shows when its own model isn't what runs: its AI is no longer ready ("DeepSeek not connected,
   * using default", or, with only API keys allowed, "ChatGPT plan is off (API keys only), using default"), or its
   * model was chosen before Tarsee had other AIs and the default AI hasn't Claude's models ("DeepSeek doesn't have
   * Haiku 4.5, using default": the turn layer runs that AI's default model). null when all is well, and always on the
   * Claude-only list (it knows no AIs).
   */
  function warningFor(picker, pick, defaults = null) {
    if (!Array.isArray(picker?.groups)) return null;
    if (isLegacyPick(picker, pick)) {
      const def = providerId(defaults?.provider);
      if (!def || CLAUDE_MODEL_AIS.has(def)) return null;
      const name = [...CLAUDE_MODEL_AIS].map((id) => entryFor(picker, pick.model, id)?.name).find(Boolean) || nameFromId(pick.model);
      return `${providerLabel(picker, def)} doesn't have ${name}, using default`;
    }
    const p = pickProvider(pick);
    if (!p || picker.groups.some((g) => g.provider === p)) return null;
    const u = (picker.unavailable || []).find((x) => x.provider === p);
    const label = providerLabel(picker, p);
    return u?.state === "blocked-keys-only" ? `${label} is off (API keys only), using default` : `${label} not connected, using default`;
  }

  /**
   * The composer's button: "Sonnet 5.5" and "High", from the chat's own pick or the defaults. With a warning the
   * default model runs, at the chat's own level when it has one (the turn layer keeps it), as one that model has.
   */
  function buttonLabel(picker, pick, defaults) {
    const warning = warningFor(picker, pick, defaults);
    const own = !warning && (pick?.model || pickProvider(pick, picker, defaults));
    const value = own ? (pick.model || "") : (defaults?.ref || defaults?.model || "sonnet");
    const provider = own ? pickProvider(pick, picker, defaults) : providerId(defaults?.provider);
    const entry = entryFor(picker, value, provider);
    const model = entry?.name || nameFromId(splitRef(value).model) || PROVIDER_LABELS[provider] || "Claude";
    const level = effortFor(entry, pick?.effort, defaults?.effort);
    const effort = level ? effortName(entry, level) : "";
    const base = effort ? `${model}, ${effort} effort. Change the model or the effort` : `${model}. Change the model`;
    return { model, effort, entry, level, provider, warning, title: warning ? `${warning}. ${base}` : base };
  }

  /**
   * The model a turn ran on, from its route ({model, provider, label}: the server's model_selected): the list's own
   * name for it, else the name the turn gave, else one made from the id. null for no turn.
   */
  function turnName(picker, turn) {
    if (!turn?.model) return null;
    return entryFor(picker, turn.model, turn.provider)?.name || turn.label || nameFromId(splitRef(turn.model).model);
  }

  /** What a change of a chat's pick sends (PUT …/picker): the provider, model and effort that changed, and only those. */
  function pickChange(before, after) {
    const out = {};
    for (const k of ["provider", "model", "effort"]) {
      const a = after?.[k] ?? null;
      if (a !== (before?.[k] ?? null)) out[k] = a;
    }
    return out;
  }

  /** What picking an entry saves for the chat. */
  function pickValue(entry) {
    return entry ? (entry.ref || entry.alias || entry.id) : null;
  }

  /** Whether an entry is the chat's model (its word, its id or its ref). */
  function isPicked(picker, entry, value, provider) {
    const cur = entryFor(picker, value, provider);
    return !!(cur && entry && cur.id === entry.id && (cur.provider || null) === (entry.provider || null));
  }

  /** The models whose name, id or AI hold every word typed: [{ entry, group }], the pickable ones first. */
  function search(picker, query) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const out = [];
    let i = 0;
    for (const group of groupsOf(picker)) {
      for (const entry of groupEntries(group)) {
        const name = String(entry.name || "").toLowerCase();
        const hay = `${name} ${String(entry.id || "").toLowerCase()} ${String(group.label || "").toLowerCase()}`;
        if (!words.every((w) => hay.includes(w))) continue;
        out.push({ entry, group, rank: (entry.selectable === false ? 2 : 0) + (name.startsWith(words[0]) ? 0 : 1), i: i++ });
      }
    }
    return out.sort((a, b) => a.rank - b.rank || a.i - b.i).map(({ entry, group }) => ({ entry, group }));
  }

  /** The badges a row shows: [{ text, tone, title }]. */
  function badgesFor(entry) {
    return Array.isArray(entry?.badges) ? entry.badges.filter((b) => b && b.text) : [];
  }

  /** The line under a row's name: the server's note (Codex's, Verify first, Fable's), as text. */
  function noteFor(entry) {
    const n = entry?.note;
    if (!n) return null;
    return typeof n === "string" ? n : n.text || null;
  }

  /** "1M context · sees images" for a row that knows its context. */
  function detailFor(entry) {
    if (!entry?.contextLabel) return "";
    return [`${entry.contextLabel} context`, entry.vision ? "sees images" : null].filter(Boolean).join(" · ");
  }

  /** The pickable rows on top (not in a list that opens), in the order the menu shows them. */
  function topRows(picker) {
    return groupsOf(picker).flatMap((g) => sectionsOf(g).filter((s) => !s.collapsed).flatMap((s) => s.entries || []))
      .filter((e) => e.selectable !== false);
  }

  /** The entry a number key picks while the menu is open: 1 is the first on top, as Claude Code numbers them. */
  function numberKey(picker, key) {
    if (!/^[1-9]$/.test(String(key))) return null;
    return topRows(picker)[Number(key) - 1] || null;
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

  const api = {
    EFFORT_NAMES, PROVIDER_LABELS, nameFromId, baseId, splitRef, groupsOf, sectionsOf, groupEntries, entryFor, modelName,
    effortName, effortFor, warningFor, buttonLabel, turnName, pickChange, pickValue, isPicked, search, badgesFor, noteFor,
    detailFor, topRows, numberKey, nextIndex,
  };
  globalThis.ModelPickerCore = Object.freeze(api);
})();
