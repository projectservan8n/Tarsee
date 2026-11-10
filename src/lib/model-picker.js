/**
 * The composer's model picker, as Claude Code's own: it pulls the models Claude Code itself lists, so a new
 * release shows up without a code change. With every AI (design 4.11), the small rules the picker and /model share
 * sit at the end of this file: the effort clamp, the context and price wording, the cost tier, and the matching
 * /model uses for "deepseek pro" or "flash". lib/model-catalog.js puts each AI's models together with them.
 *
 * Claude Code's picker is drawn from a model catalog the CLI keeps: for each model its name, a section ("main" for
 * the newest of each family, "overflow" for the older ones under More models), its effort levels with the
 * Recommended one and any warning (Max on Opus: "3.5x or more usage"), and a notice (Fable). The CLI fetches it for
 * the signed-in account and caches it in ~/.claude/cache/model-catalog/<org>-<account>-cc.json, and every CLI build
 * carries a signed copy of its own. lib/model-catalog.js reads both (the newer wins) and hands the models here; this
 * file turns them into the picker's list. Nothing here names a model: a new release reaches the list through the
 * CLI's catalog, or through Tarsee's own model table (a newer version of a family than the catalog lists goes on top).
 *
 * Page-free and side-effect free, so the tests run it on catalogs of their own.
 */

/** The families in the order Claude Code shows them. */
export const FAMILIES = ["opus", "fable", "sonnet", "haiku"];

/** Effort ids as the CLI takes them, and the words Claude Code shows. */
export const EFFORT_NAMES = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" };
export const EFFORT_IDS = ["low", "medium", "high", "xhigh", "max"];
/** What every effort is set to when a chat has none of its own (the ai.defaultEffort setting overrides it). */
export const TARSEE_DEFAULT_EFFORT = "medium";

const EFFORT_NOTE = "Higher effort means more thorough responses, but takes longer and uses your limits faster.";
const MAX_TIP = "May use a great many tokens, take long and hit token limits. Use it sparingly, for the hardest tasks.";
/** Fable on a subscription: included up to a share of the weekly limit, then it wants usage credits. Without them
 *  the turn falls back down the model ladder (the provider's fallbackModel). Never a default. */
export const FABLE_NOTE = "Uses usage credits past your weekly allowance";
const FABLE_TIP = "Fable is included up to part of the weekly plan limit. Past that it needs usage credits; without them Tarsee answers on the next model down.";

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** "claude-opus-5-5" (or with a date, "claude-haiku-4-5-20251001") as { id, family, version, name: "Opus 5.5" }. */
export function parsePickerId(raw) {
  const m = String(raw || "").toLowerCase().replace(/\[1m\]$/, "").match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/);
  if (!m) return null;
  const minor = m[3] != null ? Number(m[3]) : null;
  return {
    id: `claude-${m[1]}-${m[2]}${minor != null ? `-${minor}` : ""}`,
    family: m[1],
    version: [Number(m[2]), minor ?? 0],
    name: `${cap(m[1])} ${m[2]}${minor != null ? `.${minor}` : ""}`,
  };
}

const newer = (a, b) => (a.version[0] - b.version[0]) || (a.version[1] - b.version[1]);
const familyRank = (f) => { const i = FAMILIES.indexOf(f); return i === -1 ? FAMILIES.length : i; };

/** One effort option from the catalog ({ id, name, badge: { message, variant }, tooltip: { content } }). */
function effortFrom(o) {
  const id = String(o?.id || "").toLowerCase();
  if (!id) return null;
  const badgeText = o.badge?.message ? String(o.badge.message) : "";
  const recommended = /^recommended$/i.test(badgeText);
  return {
    id,
    name: o.name || EFFORT_NAMES[id] || cap(id),
    recommended,
    badge: badgeText && !recommended ? { text: badgeText, tone: o.badge.variant === "warning" ? "warning" : "neutral" } : null,
    tip: o.tooltip?.content ? String(o.tooltip.content) : null,
  };
}

/** The levels a model has no catalog entry for: Claude Code's five, Tarsee's default marked. */
function fallbackEfforts(defaultEffort) {
  return EFFORT_IDS.map((id) => ({ id, name: EFFORT_NAMES[id], recommended: id === defaultEffort, badge: null, tip: id === "max" ? MAX_TIP : null }));
}

function finishEntry(entry, defaultEffort) {
  // Medium is marked Recommended only where the CLI says so; with no word from the CLI, Tarsee's default is.
  if (entry.efforts.length && !entry.efforts.some((e) => e.recommended)) {
    const d = entry.efforts.find((e) => e.id === defaultEffort);
    if (d) d.recommended = true;
  }
  if (entry.family === "fable") entry.note = { text: FABLE_NOTE, tip: [entry.notice, FABLE_TIP].filter(Boolean).join(". ").replace(/\.\./g, ".") };
  return entry;
}

/** A catalog model ({ id, name, section, description, thinking, runtime, notice }) as a picker entry. */
function entryFromCatalog(m, defaultEffort) {
  const p = parsePickerId(m?.id);
  if (!p) return null;
  const family = String(m.runtime?.family || p.family).toLowerCase();
  const efforts = m.thinking?.type === "effort" && Array.isArray(m.thinking.effort_options)
    ? m.thinking.effort_options.map(effortFrom).filter(Boolean)
    : [];
  return finishEntry({
    id: p.id,
    family,
    version: p.version,
    name: m.name || p.name,
    description: m.description || null,
    section: m.section === "main" ? "main" : "more",
    efforts,
    effortNote: m.thinking?.description || (efforts.length ? EFFORT_NOTE : null),
    defaultEffort: String(m.runtime?.default_effort || efforts.find((e) => e.recommended)?.id || "").toLowerCase() || null,
    notice: m.notice?.text || null,
  }, defaultEffort);
}

/** A model the catalog does not list (only an id is known): the levels of its family's newest, or the five. */
function entryFromId(id, template, defaultEffort) {
  const p = parsePickerId(id);
  if (!p) return null;
  return finishEntry({
    id: p.id,
    family: p.family,
    version: p.version,
    name: p.name,
    description: template?.description || null,
    section: "main",
    efforts: template?.efforts?.length ? template.efforts.map((e) => ({ ...e, recommended: false })) : fallbackEfforts(defaultEffort),
    effortNote: template?.effortNote || EFFORT_NOTE,
    defaultEffort: template?.defaultEffort || null,
    notice: template?.notice || null,
  }, defaultEffort);
}

/**
 * The picker's list.
 *   catalog   the CLI's catalog config ({ models, provider_alias_targets }) or null
 *   knownIds  model ids known some other way (lib/model-catalog.js: Tarsee's model table): used in full
 *             when there is no catalog, and otherwise only for a version newer than the catalog's newest of a family
 *   aliases   the family words the CLI takes for "the newest" ({ opus: true, ... }): a main entry picks its family's
 *             word, so a chat stays on the newest when a new version comes out (Claude Code does the same)
 * Returns { main: [...], more: [...], effortNote, source, fetchedAt, defaultEffort }.
 */
export function buildPicker({ catalog = null, knownIds = [], aliases = {}, source = null, fetchedAt = null, defaultEffort = TARSEE_DEFAULT_EFFORT } = {}) {
  const byId = new Map();
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  for (const m of models) {
    const e = entryFromCatalog(m, defaultEffort);
    if (e && FAMILIES.includes(e.family) && !byId.has(e.id)) byId.set(e.id, e);
  }
  const fromCatalog = byId.size > 0;
  if (!fromCatalog) {
    // No catalog: every known id of the four families; the newest of each goes on top.
    for (const id of knownIds) {
      const e = entryFromId(id, null, defaultEffort);
      if (e && FAMILIES.includes(e.family) && !byId.has(e.id)) { e.section = "more"; byId.set(e.id, e); }
    }
  }
  const all = [...byId.values()];
  // The newest of each family: the catalog's main entry, unless a newer version of it is known (a release the
  // catalog has not caught up with yet).
  const top = {};
  for (const e of all) {
    const cur = top[e.family];
    if (fromCatalog ? (e.section === "main" && (!cur || newer(e, cur) > 0)) : (!cur || newer(e, cur) > 0)) top[e.family] = e;
  }
  for (const f of FAMILIES) {
    if (!top[f]) { const newest = all.filter((e) => e.family === f).sort((a, b) => newer(b, a))[0]; if (newest) top[f] = newest; }
  }
  if (fromCatalog) {
    for (const id of knownIds) {
      const p = parsePickerId(id);
      if (!p || !FAMILIES.includes(p.family) || byId.has(p.id)) continue;
      const cur = top[p.family];
      if (cur && newer(p, cur) <= 0) continue;
      const e = entryFromId(p.id, cur, defaultEffort);
      byId.set(e.id, e);
      top[p.family] = e;
    }
  }
  const targets = catalog?.provider_alias_targets || {};
  const main = FAMILIES.map((f) => top[f]).filter(Boolean).map((e) => {
    const target = parsePickerId(targets[e.family]?.default)?.id;
    // The family's word follows the newest; when the CLI would send it to an older one, the entry keeps its own id.
    const alias = aliases[e.family] && (!target || target === e.id) ? e.family : null;
    return { ...e, section: "main", alias };
  });
  const mainIds = new Set(main.map((e) => e.id));
  const more = [...byId.values()]
    .filter((e) => !mainIds.has(e.id))
    .sort((a, b) => newer(b, a) || familyRank(a.family) - familyRank(b.family))
    .map((e) => ({ ...e, section: "more", alias: null }));
  const strip = ({ version, notice, ...rest }) => rest;
  return {
    main: main.map(strip),
    more: more.map(strip),
    effortNote: main.find((e) => e.effortNote)?.effortNote || EFFORT_NOTE,
    defaultEffort,
    source: fromCatalog ? source : "known models",
    fetchedAt: fromCatalog ? fetchedAt : null,
  };
}

/* ------------------------------------------------------------------ the catalog inside the CLI's own build */

const CATALOG_MARKER = '{$schema:"https://downloads.claude.ai/model-catalog/';

/** Where the object that starts at `start` ends (the index after its closing brace), strings skipped. -1 if open. */
export function literalEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/**
 * A JavaScript object literal as the CLI's build writes it ({id:"x",n:1e6,on:!0,off:!1,none:void 0}) as JSON text.
 * Read as data, never run. Throws on anything that is not plain data (a call, a variable).
 */
export function jsLiteralToJson(src) {
  let out = "";
  const n = src.length;
  for (let i = 0; i < n;) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let s = "";
      let j = i + 1;
      for (; j < n && src[j] !== c; j++) {
        if (src[j] === "\\") {
          const e = src[j + 1];
          if (e === "x") { s += `\\u00${src.slice(j + 2, j + 4)}`; j += 3; }
          else if (e === "'") { s += "'"; j += 1; }
          else if (e === "\n") { j += 1; }
          else { s += `\\${e}`; j += 1; }
        } else if (src[j] === '"') s += '\\"';
        else s += src[j];
      }
      out += `"${s}"`;
      i = j + 1;
      continue;
    }
    if (c === "!" && (src[i + 1] === "0" || src[i + 1] === "1")) { out += src[i + 1] === "0" ? "true" : "false"; i += 2; continue; }
    const num = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i, i + 40));
    if (num && (c === "-" || c === "." || (c >= "0" && c <= "9"))) {
      let t = num[0];
      if (/^-?\./.test(t)) t = t.replace(".", "0.");
      if (/\.$/.test(t)) t += "0";
      out += t;
      i += num[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(src[k])) k++;
      if (src[k] === ":") { out += JSON.stringify(word); i = j; continue; }
      if (word === "true" || word === "false" || word === "null") { out += word; i = j; continue; }
      if (word === "void") { k = j; while (k < n && /[\s0-9]/.test(src[k])) k++; out += "null"; i = k; continue; }
      if (word === "undefined") { out += "null"; i = j; continue; }
      throw new Error(`not plain data at ${i}: ${word}`);
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * The model catalog a CLI build carries, from the text around its marker: { issuedAt, config } for the Claude Code
 * surface ("cc"), or null.
 */
export function catalogFromBuildText(text) {
  const at = text.indexOf(CATALOG_MARKER);
  if (at === -1) return null;
  const end = literalEnd(text, at);
  if (end === -1) return null;
  const doc = JSON.parse(jsLiteralToJson(text.slice(at, end)));
  const config = (doc.surfaces?.cc?.model_selector_config || []).find((c) => c?.id === "cc") || null;
  if (!config?.models?.length) return null;
  return { issuedAt: Date.parse(doc.issued_at) || null, version: doc.version || null, config };
}

export { CATALOG_MARKER };

/* ------------------------------------------------------------------ every AI's models (design 4.11) */

/** The note on a model Codex runs: its replies arrive whole, one message at a time, not word by word. */
export const MESSAGE_AT_A_TIME = "Replies appear a message at a time";
/** What a model that must be verified before it can be used says instead of being pickable. */
export const VERIFY_FIRST = "Verify it in Settings > AI first";

/**
 * The level a model runs at, from the levels it has (ids, or { id } objects): the one asked for, else the nearest
 * one it has below (as Claude Code does), else its lowest. Nothing asked for is the default (Medium). null when the
 * model takes no level at all.
 */
export function clampEffort(levels, want, fallback = TARSEE_DEFAULT_EFFORT) {
  const have = [...new Set((levels || []).map((l) => (typeof l === "string" ? l : l?.id)).filter(Boolean).map((l) => String(l).toLowerCase()))];
  if (!have.length) return null;
  const rank = (id) => { const i = EFFORT_IDS.indexOf(id); return i === -1 ? EFFORT_IDS.length : i; };
  have.sort((a, b) => rank(a) - rank(b));
  const w = String(want || fallback || TARSEE_DEFAULT_EFFORT).toLowerCase();
  if (have.includes(w)) return w;
  for (let i = EFFORT_IDS.indexOf(w); i >= 0; i--) if (have.includes(EFFORT_IDS[i])) return EFFORT_IDS[i];
  return have[0];
}

/** The effort rows a picker shows for a model's levels: names, the one it runs at by default marked Recommended. */
export function effortRows(levels, defaultEffort = TARSEE_DEFAULT_EFFORT) {
  const ids = (levels || []).map((l) => String(typeof l === "string" ? l : l?.id || "").toLowerCase()).filter(Boolean);
  const rec = clampEffort(ids, defaultEffort);
  return ids.map((id) => ({ id, name: EFFORT_NAMES[id] || cap(id), recommended: id === rec, badge: null, tip: id === "max" ? MAX_TIP : null }));
}

/** A context window in words a person reads: 1000000 as "1M", 400000 as "400K", 1500000 as "1.5M". */
export function contextLabel(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000)}K`;
}

const usd = (n) => `$${n >= 10 ? n.toFixed(0) : n.toFixed(2)}`;

/** A model's list price as one line: "$0.15 in · $0.60 out per million tokens, est.". null without a price. */
export function priceHint(price) {
  if (!price || typeof price.in !== "number" || typeof price.out !== "number") return null;
  if (price.in === 0 && price.out === 0) return "Free";
  return `${usd(price.in)} in · ${usd(price.out)} out per million tokens, est.`;
}

/**
 * A rough cost tier for a metered model, from its price in USD per million tokens, weighted three tokens in for one
 * out (a chat's usual mix): "$" under $0.50, "$$" under $5, "$$$" above. null with no price, or when it is free.
 */
export function costTier(price) {
  if (!price || typeof price.in !== "number" || typeof price.out !== "number") return null;
  // A model with peak hours (DeepSeek: peak rates for 35 hours of the week, half price the rest) is tiered at its
  // week-average price, which is what a chat that runs at any hour pays; the hint still gives the peak figures.
  const f = weekAverageFactor(price.peak);
  const blended = ((price.in * 3 + price.out) / 4) * f;
  if (blended <= 0) return null;
  return blended < 0.5 ? "$" : blended < 5 ? "$$" : "$$$";
}

/**
 * What a peak-priced rate averages to over a week, as a factor of the peak rate: peak = {days, hoursUtc, offPeakFactor}
 * (the registry's DeepSeek window). 1 for a price with no peak hours.
 */
export function weekAverageFactor(peak) {
  if (!peak || typeof peak !== "object" || !Array.isArray(peak.days) || !Array.isArray(peak.hoursUtc)) return 1;
  const off = Number(peak.offPeakFactor);
  if (!Number.isFinite(off) || off <= 0) return 1;
  const hoursPerDay = peak.hoursUtc.reduce((n, [a, b]) => n + Math.max(0, Math.min(24, b) - Math.max(0, a)), 0);
  const share = Math.min(1, (peak.days.length * hoursPerDay) / (7 * 24));
  return share + (1 - share) * off;
}

/** A Claude family's cost tier when there is no per-token price to go by (Anthropic reports the exact cost after each reply). */
export function familyCostTier(family) {
  const f = String(family || "").toLowerCase();
  if (f === "haiku") return "$$";
  if (f === "sonnet" || f === "opus" || f === "fable") return "$$$";
  return null;
}

/** A Claude family named in an id or a slug ("claude-sonnet-5-5", "~anthropic/claude-haiku-latest"), or null. */
export function familyOf(id) {
  const m = /(?:^|[/-])(fable|opus|sonnet|haiku)(?:-|$)/.exec(String(id || "").toLowerCase());
  return m ? m[1] : null;
}

/** A name for a model known only by its id: "~anthropic/claude-sonnet-latest" as "Claude Sonnet (latest)". */
export function nameFromSlug(id) {
  const s = String(id || "").replace(/^~/, "");
  const tail = s.includes("/") ? s.slice(s.lastIndexOf("/") + 1) : s;
  const latest = /-latest$/i.test(tail);
  const words = tail.replace(/-latest$/i, "").split(/[-_]/).filter(Boolean).map((w) => (/^\d/.test(w) ? w : cap(w)));
  const name = words.join(" ") || s;
  return latest ? `${name} (latest)` : name;
}

const normWord = (s) => String(s || "").toLowerCase().replace(/\[1m\]$/, "").trim();
const tokensOf = (s) => normWord(s).split(/[^a-z0-9]+/).filter(Boolean);

/** How well a model fits what someone typed: 100 its exact id or name, down to 30 a piece of either; 0 not at all. */
function fit(choice, q, qTokens) {
  const id = normWord(choice.id);
  const name = normWord(choice.name);
  if (!q) return 0;
  if (id === q || name === q || normWord(choice.ref) === q) return 100;
  if (id.replace(/^~/, "").split("/").pop() === q) return 90;
  const hay = [...tokensOf(id), ...tokensOf(name)];
  if (qTokens.length && qTokens.every((t) => hay.includes(t))) return 70;
  if (qTokens.length && qTokens.every((t) => hay.some((h) => h.startsWith(t)))) return 50;
  if (id.includes(q) || name.includes(q)) return 30;
  return 0;
}

/**
 * The models that best fit what someone typed (/model's "flash", "deepseek pro", "opus 4.6"), from
 * choices [{ provider, id, name, ref?, selectable? }]. Only the best-fitting ones come back: one is a clear answer,
 * several are choices to list. The same model on two AIs (GPT-6 Luna on the ChatGPT plan and an OpenAI key) goes
 * to `preferProvider`, the default AI, when it is one of them. Returns { matches, score }.
 */
export function matchModels(choices, query, { preferProvider = null } = {}) {
  const q = normWord(query);
  const qTokens = tokensOf(q);
  let best = 0;
  let matches = [];
  const seen = new Set();
  for (const c of choices || []) {
    const key = `${c.provider}\u0000${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const s = fit(c, q, qTokens);
    if (!s) continue;
    if (s > best) { best = s; matches = [c]; } else if (s === best) matches.push(c);
  }
  if (matches.length > 1 && preferProvider && new Set(matches.map((m) => normWord(m.id))).size === 1) {
    const mine = matches.filter((m) => m.provider === preferProvider);
    if (mine.length === 1) matches = mine;
  }
  return { matches, score: best };
}
