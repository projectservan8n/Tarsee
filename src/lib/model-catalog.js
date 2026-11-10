/**
 * Which Claude models exist right now, for the composer's picker and for
 * turning a family word ("opus", "sonnet") into the newest model of that
 * family.
 *
 * Why this is needed: the Agent SDK runs its OWN bundled copy of the Claude
 * Code CLI, pinned to the SDK's release, not the `claude` installed in the
 * image. That bundled CLI resolves the family words to whatever was newest
 * when it was built, so "opus" quietly ran a model several releases old. A
 * concrete id ("claude-opus-5-5") goes to the API as it is and runs that
 * model. So Tarsee resolves the family words itself, from the newest list it
 * can find, before each turn.
 *
 * Sources, newest wins:
 *  1. The catalog Claude Code fetched for the signed-in account, cached under
 *     <claude home>/cache/model-catalog/*-cc.json by the CLI (every Claude home
 *     is looked at: in Docker HOME is /root while the config lives at
 *     /home/node/.claude, see lib/claude-transcript.js).
 *  2. The catalog every CLI build carries, read from the installed `claude`
 *     (the image installs the version pinned in the Dockerfile,
 *     CLAUDE_CODE_VERSION: a model released after it arrives when it is
 *     bumped, or with TARSEE_AUTO_UPDATE_CLI=1). Read once per CLI file, in
 *     chunks, off the request path.
 *  3. Tarsee's own model table (config/constants.js), as the floor.
 *
 * Every other AI (design 4.11) is put together at the end of this file, from
 * the provider registry: one group per AI that is switched on and ready (the
 * default AI first), each model with its levels, context, whether it sees
 * images, its badges and whether it can be picked (OpenRouter's models only
 * once verified). GET /api/models (routes/models.js) and /model, /think and
 * /status (lib/commands.js) read them here, so the picker and the commands
 * never disagree.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_MODELS, CLAUDE_MODELS_BY_ID, MODEL_TIERS, getRecommendedModel, resolveModelAlias } from "../config/constants.js";
import config from "../config/env.js";
import { claudeHomes } from "./claude-transcript.js";
import {
  buildPicker, catalogFromBuildText, CATALOG_MARKER, FAMILIES, TARSEE_DEFAULT_EFFORT, EFFORT_IDS,
  clampEffort, effortRows, contextLabel, priceHint, costTier, familyCostTier, familyOf, nameFromSlug,
  MESSAGE_AT_A_TIME, VERIFY_FIRST, FABLE_NOTE,
} from "./model-picker.js";
import {
  PROVIDERS, PROVIDER_IDS, getProvider, normalizeProviderId, isShipped as registryShipped, activeProviderId, keysOnly,
  modelsFor, verifiedModels, resolveModelFor, engineFor, contextTokensFor, effortsFor, capsFor, priceFor,
  setCatalogModels, catalogModels,
} from "../ai/provider-registry.js";
import { formatModelRef, parseModelRef } from "../ai/model-ref.js";
import { homeFor, baseEnv } from "../ai/engine-env.js";
import { providerStatus } from "../ai/provider-status.js";
import { loginStatus } from "../ai/codex-device-login.js";

const CATALOG_RECHECK_MS = 60_000;
const CLI_RECHECK_MS = 60 * 60_000;
const CLI_CHUNK = 16 * 1024 * 1024;
const CLI_CATALOG_MAX = 512 * 1024;   // the catalog a build carries is some tens of KB
const MARKER = Buffer.from(CATALOG_MARKER);

let _cli = null;            // { bin, catalog: { issuedAt, config } | null }
let _cliReading = null;     // the read in progress
let _account = null;        // { fetchedAt, config, file, mtimeMs }
let _accountCheckedAt = 0;
let _catalogDirs = null;    // tests only: where to look instead of the Claude homes

/**
 * The real file behind the installed `claude` (CLAUDE_BIN, else the PATH), so
 * a CLI update shows up as a new path. Never the SDK's bundled copy: that one
 * is the stale one this module works around.
 */
export function resolveCliBin() {
  const name = process.env.CLAUDE_BIN || "claude";
  const candidates = name.includes("/")
    ? [name]
    : [...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, name)), path.join(os.homedir(), ".local", "bin", name)];
  for (const c of candidates) {
    try {
      if (!fs.statSync(c).isFile()) continue;
      const real = fs.realpathSync(c);
      if (real.includes(`${path.sep}claude-agent-sdk`)) continue;
      return real;
    } catch { /* next */ }
  }
  return null;
}

/** The catalog inside a CLI build (a native binary or a JS bundle): read in chunks, never blocking the server. */
export async function readCliCatalog(bin = resolveCliBin()) {
  if (!bin) return null;
  const fh = await fs.promises.open(bin, "r");
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(CLI_CHUNK + MARKER.length);
    for (let pos = 0; pos < size; pos += CLI_CHUNK) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      const at = buf.indexOf(MARKER);
      if (at === -1 || at >= Math.min(bytesRead, CLI_CHUNK)) continue;
      const len = Math.min(CLI_CATALOG_MAX, size - (pos + at));
      const out = Buffer.alloc(len);
      const r = await fh.read(out, 0, len, pos + at);
      try { return catalogFromBuildText(out.toString("utf8", 0, r.bytesRead)); } catch { return null; }
    }
    return null;
  } finally { await fh.close(); }
}

/** Read the installed CLI's catalog again when the CLI file changed (an update), at most hourly. */
function refreshCli() {
  if (_cliReading) return _cliReading;
  const bin = resolveCliBin();
  if (!bin || bin === _cli?.bin) return Promise.resolve(_cli);
  _cliReading = readCliCatalog(bin)
    .then((catalog) => {
      _cli = { bin, catalog };
      const n = catalog?.config?.models?.length || 0;
      console.log(`[models] Claude Code catalog: ${n} models (${path.basename(path.dirname(bin))}/${path.basename(bin)})`);
      return _cli;
    })
    .catch((err) => { console.warn(`[models] could not read Claude Code's catalog: ${err.message}`); _cli = { bin, catalog: null }; return _cli; })
    .finally(() => { _cliReading = null; });
  return _cliReading;
}

/**
 * The catalog Claude Code fetched for the signed-in account (the one its own
 * /model picker shows), from the CLI's cache in any Claude home: the newest
 * "cc" file. Re-read when a file changes, looked at once a minute at most.
 */
export function readAccountCatalog({ force = false } = {}) {
  if (!force && Date.now() - _accountCheckedAt < CATALOG_RECHECK_MS) return _account;
  _accountCheckedAt = Date.now();
  const dirs = _catalogDirs || claudeHomes().map((h) => path.join(h, "cache", "model-catalog"));
  let best = null;
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /-cc\.json$/.test(f)); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (_account?.file === file && _account.mtimeMs === st.mtimeMs) { if (!best || _account.fetchedAt > best.fetchedAt) best = _account; continue; }
      try {
        const doc = JSON.parse(fs.readFileSync(file, "utf8"));
        const config = doc?.catalog?.config;
        if (doc?.catalog?.surface !== "cc" || !Array.isArray(config?.models) || !config.models.length) continue;
        const entry = { fetchedAt: Number(doc.fetchedAt) || st.mtimeMs, config, file, mtimeMs: st.mtimeMs };
        if (!best || entry.fetchedAt > best.fetchedAt) best = entry;
      } catch { /* a file being written, or not one of these */ }
    }
  }
  _account = best;
  return _account;
}

/**
 * The composer's picker (lib/model-picker.js): Claude Code's catalog, the
 * account's or the installed build's, whichever is newer; with neither, the
 * models in Tarsee's table. Entries always carry exact ids, never a family
 * word (see the top of this file).
 */
export function getModelPicker({ defaultEffort } = {}) {
  const account = readAccountCatalog();
  const build = _cli?.catalog || null;
  const useBuild = build && (!account || (build.issuedAt || 0) > account.fetchedAt);
  const chosen = useBuild ? { config: build.config, at: build.issuedAt, source: "Claude Code's built-in catalog" }
    : account ? { config: account.config, at: account.fetchedAt, source: "Claude Code's catalog for this account" } : null;
  return buildPicker({
    catalog: chosen?.config || null,
    knownIds: CLAUDE_MODELS.filter((m) => !m.alias).map((m) => m.id),
    aliases: {},
    source: chosen?.source || null,
    fetchedAt: chosen?.at || null,
    defaultEffort: defaultEffort || TARSEE_DEFAULT_EFFORT,
  });
}

/**
 * A model as it should be sent for a turn: a bare family word ("opus",
 * "sonnet", "haiku", "fable", any case) becomes the newest model of that
 * family in the picker's list; anything else (an exact id, a word with no
 * known family) goes as it is.
 */
export function resolveModel(model) {
  const word = String(model || "").trim().toLowerCase();
  if (!FAMILIES.includes(word)) return model;
  try {
    const top = getModelPicker().main.find((e) => e.family === word);
    return top?.id || model;
  } catch { return model; }
}

/** Start reading the installed CLI's catalog (off the request path), and again when the CLI is updated. */
export function initModelCatalog() {
  refreshCli();
  setInterval(refreshCli, CLI_RECHECK_MS).unref?.();
}

/** Tests only. */
export function __setForTests({ catalogDirs, cli, chatgptListAt } = {}) {
  if (catalogDirs !== undefined) { _catalogDirs = catalogDirs; _account = null; _accountCheckedAt = 0; }
  if (cli !== undefined) _cli = cli;
  if (chatgptListAt !== undefined) _chatgptListAt = chatgptListAt;
}

/* ================================================================== every AI's models (design 4.11) */

const STATUS_TIMEOUT_MS = 4_000;
const CHATGPT_LIST_TIMEOUT_MS = 8_000;
const CHATGPT_RETRY_MS = 2 * 60_000;      // an account whose list could not be read is asked again after this
const CHATGPT_REFRESH_MS = 60 * 60_000;   // a list that came in is read again (in the background) after this
const TIER_WORDS = Object.freeze({ top: "opus", mid: "sonnet", small: "haiku" });
const SUBSCRIPTION_BADGE = (p) => ({ text: "Plan", tone: "neutral", title: `Included in your ${p.label.replace(/ plan$/, "")} plan` });

let _statusSource = null;
let _chatgptListAt = 0;
let _chatgptListing = null;

/**
 * Where readiness comes from. By default it is ai/provider-status.js providerStatus (design 4.3, the answer Settings
 * > AI shows too), with ChatGPT's sign-in read from its file rather than by running Codex, so the picker stays quick.
 * A caller can put its own in its place with setProviderStatusSource((id, store) => …).
 */
export function setProviderStatusSource(fn) {
  _statusSource = typeof fn === "function" ? fn : null;
}

function registryStatus(id, store, env, stateDir) {
  return providerStatus(id, {
    store,
    env,
    ...(stateDir ? { stateDir } : {}),
    // (ChatGPT's sign-in from its file: the picker never starts the Codex CLI just to ask.)
    loginStatus: (o) => loginStatus({ ...o, cli: false }),
  });
}

/**
 * Whether an AI can take a turn now: { provider, label, state, ready, detail, fix }. state is one of the registry's
 * (ready, needs-key, needs-sign-in, sign-in-expired, out-of-credit, blocked-keys-only, needs-setup, error), or "off"
 * for an AI this version doesn't switch on. deps: store, env, statusFor (a test's or the caller's own), isShipped,
 * stateDir.
 */
export async function providerReadiness(idOrAlias, { store = null, env = process.env, statusFor = null, isShipped = null, stateDir } = {}) {
  const p = getProvider(idOrAlias);
  if (!p) return { provider: null, label: String(idOrAlias ?? ""), state: "unknown", ready: false, detail: "Tarsee doesn't know that AI.", fix: null };
  if (!(isShipped || registryShipped)(p.id)) {
    return { provider: p.id, label: p.label, state: "off", ready: false, detail: `${p.label} can't be used in this version of Tarsee.`, fix: null };
  }
  const source = statusFor || _statusSource;
  let s;
  try {
    s = source
      ? await withTimeout(Promise.resolve().then(() => source(p.id, store)), STATUS_TIMEOUT_MS)
      : await withTimeout(registryStatus(p.id, store, env, stateDir), STATUS_TIMEOUT_MS);
  } catch (err) {
    s = { state: "error", detail: `Couldn't check ${p.label}: ${err?.message || err}`, fix: null };
  }
  const state = typeof s?.state === "string" && s.state ? s.state : "error";
  return { provider: p.id, label: p.label, state, ready: state === "ready", detail: s?.detail || null, fix: s?.fix || null };
}

/**
 * Read the signed-in ChatGPT account's models again (ai/codex-models.js listAccountModels) into the registry's
 * "chatgpt-models" catalog. An empty catalog is filled now (asked again two minutes after a failed try); a full one
 * is refreshed in the background once an hour. `list` is a test's (or a caller's) own lister.
 * Never while "API keys only" is on (`store`'s ai.keysOnly, or TARSEE_KEYS_ONLY=1): the read starts Codex with the
 * plan's sign-in, which sends it to ChatGPT's backend, and keys-only promises no plan sign-in is ever used.
 */
export async function refreshChatgptModels({ list = null, env = process.env, stateDir, force = false, store = null } = {}) {
  if (keysOnly(store, { env })) return catalogModels("chatgpt-models");
  const have = catalogModels("chatgpt-models").length > 0;
  const age = Date.now() - _chatgptListAt;
  if (!force && age < (have ? CHATGPT_REFRESH_MS : CHATGPT_RETRY_MS)) return catalogModels("chatgpt-models");
  if (!_chatgptListing) {
    _chatgptListAt = Date.now();
    _chatgptListing = readChatgptList(list, env, stateDir).finally(() => { _chatgptListing = null; });
  }
  if (have) return catalogModels("chatgpt-models");
  await _chatgptListing;
  return catalogModels("chatgpt-models");
}

async function readChatgptList(list, env, stateDir) {
  try {
    const fn = list || (await import("../ai/codex-models.js")).listAccountModels;
    if (typeof fn !== "function") return;
    const codexHome = homeFor("chatgpt", "codex", { stateDir: stateDir || config.STATE_DIR });
    const models = await withTimeout(Promise.resolve().then(() => fn({ codexHome, env: { ...baseEnv(env || {}), CODEX_HOME: codexHome } })), CHATGPT_LIST_TIMEOUT_MS);
    if (!Array.isArray(models) || !models.length) return;
    setCatalogModels("chatgpt-models", models.map((m) => ({
      id: m?.id, label: m?.label, efforts: m?.efforts, default: m?.default === true, vendor: "openai",
      ...(typeof m?.context === "number" ? { context: m.context } : {}),
      ...(typeof m?.vision === "boolean" ? { vision: m.vision } : {}),
    })));
  } catch (err) {
    console.warn(`[models] could not read the ChatGPT account's models: ${err?.message || err}`);
  }
}

/** The AI and model a chat runs on when it has none of its own: { provider, model, effort, ref }. */
export function defaultPick(store, { env = process.env, isShipped = null } = {}) {
  const provider = activeProviderId(store, { env, isShipped: isShipped || registryShipped });
  const model = defaultModelFor(PROVIDERS[provider], store, env);
  const effort = nonEmpty(readSetting(store, "ai.defaultEffort")) || TARSEE_DEFAULT_EFFORT;
  return { provider, model: model || null, effort, ref: formatModelRef(provider, model || "") };
}

/**
 * A provider's default model: the owner's (ai.<storageId>.model), else for the default AI the TARSEE_AI_MODEL
 * variable (a bare model, or a ref naming that AI: the Railway-only setup, as the turn layer reads it), else the
 * provider's own; through resolveModelFor, so it is one the provider offers. "" means the engine picks. `env` is
 * passed only for the default AI.
 */
function defaultModelFor(p, store, env = null) {
  const saved = nonEmpty(readSetting(store, `ai.${p.storageId}.model`)) || envModelFor(p.id, env);
  if (p.catalog === "claude") return saved || getRecommendedModel();
  return resolveModelFor(p.id, saved, store) || "";
}

function envModelFor(providerId, env) {
  const raw = nonEmpty(env?.TARSEE_AI_MODEL);
  if (!raw) return null;
  const ref = parseModelRef(raw);
  return ref.provider && ref.provider !== providerId ? null : ref.model;
}

/**
 * The model chosen on the Local AI card, which runs without being verified: ai.local.model, else TARSEE_AI_MODEL
 * while Local AI is the default AI (the turn layer's reading, ai/turn.js resolveTarget); null when none is.
 */
export function localChosenModel(store, env = process.env) {
  return nonEmpty(readSetting(store, "ai.local.model"))
    || (activeProviderId(store, { env }) === "local" ? envModelFor("local", env) : null);
}

/** A chat's own AI, model and effort (session.<conv>.provider, .model, .effort); null where it has none. */
export function readPick(store, conversationId) {
  if (!conversationId) return { provider: null, model: null, effort: null };
  const str = (k) => { const v = readSetting(store, `session.${conversationId}.${k}`); return v == null || v === "" ? null : String(v); };
  return { provider: normalizeProviderId(str("provider")), model: str("model"), effort: str("effort") };
}

/** The levels a model takes (Tarsee's ids, lowest first); empty when it takes none. */
export function levelsFor(providerId, model, store = null) {
  const p = getProvider(providerId);
  if (!p) return [];
  if (p.catalog === "claude") {
    const e = claudeEntry(getModelPicker(), model || defaultModelFor(p, store));
    return e ? e.efforts.map((x) => x.id) : [...EFFORT_IDS];
  }
  const id = model == null || model === "" ? defaultModelFor(p, store) : model;
  return effortsFor(p.id, id, store);
}

/** What a person calls a model: "Opus 5.5", "DeepSeek Flash", "Claude Sonnet (latest)", "ChatGPT's default model". */
export function describeModel(providerId, model, store = null) {
  const p = getProvider(providerId);
  if (!p) return String(model || "");
  const id = model == null || model === "" ? defaultModelFor(p, store) : String(model);
  if (p.catalog === "claude") {
    const e = claudeEntry(getModelPicker(), id);
    return e?.name || CLAUDE_MODELS_BY_ID[id]?.displayName || id;
  }
  if (!id) return p.id === "chatgpt" ? "ChatGPT's default model" : "its default model";
  const row = modelsFor(p.id).find((m) => m.id === id);
  return row?.label || nameFromSlug(id);
}

/** Whether a model on a provider replies a message at a time (Codex) rather than word by word. */
export function repliesWhole(providerId, model, store = null) {
  const p = getProvider(providerId);
  if (!p) return false;
  const id = model == null || model === "" ? defaultModelFor(p, store) : model;
  const engine = id ? engineFor(p.id, id, store) : (p.engines.length === 1 ? p.engines[0] : null);
  return engine === "codex";
}

/**
 * Whether a model can be picked on a provider, and as which id: { ok, model, error?, verify? }. A tier word
 * ("haiku", "opus[1m]") maps through the provider's tiers; the Claude providers take what Claude Code's list and
 * Tarsee's table take, as before; any other provider only a model its list offers and that can be picked (OpenRouter's
 * once verified). No model (null, "") is the provider's own default. opts.env: where TARSEE_AI_PROVIDER and
 * TARSEE_AI_MODEL are read (process.env by default).
 */
export function checkModel(providerId, raw, store = null, { env = null } = {}) {
  const p = getProvider(providerId);
  if (!p) return { ok: false, error: "Tarsee doesn't know that AI." };
  const v = raw == null ? "" : String(raw).trim();
  if (!v) return { ok: true, model: null };
  const tier = tierWord(v);
  if (p.catalog === "claude") {
    const lower = v.toLowerCase();
    const picker = getModelPicker();
    if ([...picker.main, ...picker.more].some((e) => e.id === lower || e.alias === lower)) return { ok: true, model: lower };
    if (tier) return { ok: true, model: resolveModelFor(p.id, lower, store) };
    const known = resolveModelAlias(lower);
    return known ? { ok: true, model: known } : { ok: false, error: `Unknown model ${v}` };
  }
  if (tier) return { ok: true, model: resolveModelFor(p.id, v, store) || null };
  const all = groupEntries(buildGroup(p, { store, env })).filter((e) => e.id);
  const e = all.find((x) => x.id === v) || all.find((x) => x.id.toLowerCase() === v.toLowerCase());
  if (!e) return { ok: false, error: `${p.label} has no model "${v}".` };
  if (!e.selectable) return { ok: false, verify: true, error: `${e.name} on ${p.label} hasn't been verified yet. ${VERIFY_FIRST}.` };
  return { ok: true, model: e.id };
}

/**
 * Every model a provider offers, as /model matches them: [{ provider, providerLabel, id, name, ref, selectable }].
 * opts.env as checkModel's.
 */
export function modelChoices(providerId, store = null, { env = null } = {}) {
  const p = getProvider(providerId);
  if (!p) return [];
  const out = groupEntries(buildGroup(p, { store, env })).filter((e) => e.id).map((e) => ({ provider: p.id, providerLabel: p.label, id: e.id, name: e.name, ref: e.ref, selectable: e.selectable !== false }));
  if (p.catalog === "claude") {
    // Tarsee's own table too: the family words and the pinned versions /model has always taken.
    for (const m of CLAUDE_MODELS) {
      if (!out.some((c) => c.id === m.id)) out.push({ provider: p.id, providerLabel: p.label, id: m.id, name: m.displayName, ref: formatModelRef(p.id, m.id), selectable: true });
    }
  }
  return out;
}

/**
 * The composer's list for every AI: { groups, unavailable, defaults, picker }.
 *   groups       one per AI that is switched on and ready, the default AI first:
 *                { provider, label, kind, default, defaultModel, sections: [{ id, label, collapsed?, entries }],
 *                  main, more, searchable, effortNote, note }
 *   unavailable  the AIs switched on but not ready: { provider, label, state, detail, fix } (the warning chip)
 *   defaults     what a chat with nothing of its own runs on: { provider, model, effort, ref }
 *   picker       what the page keeps: the groups, plus the Claude list's main and more as they always were
 * deps: store, env, isShipped, statusFor, now, listChatgptModels (the ChatGPT account's lister), stateDir.
 */
export async function getModelGroups({ store = null, env = process.env, isShipped = null, statusFor = null, now = new Date(), listChatgptModels = null, stateDir } = {}) {
  const shipped = isShipped || registryShipped;
  const ids = PROVIDER_IDS.filter((id) => shipped(id));
  const statuses = await Promise.all(ids.map((id) => providerReadiness(id, { store, env, statusFor, isShipped: shipped, stateDir })));
  const ready = statuses.filter((s) => s.ready).map((s) => s.provider);
  if (ready.includes("chatgpt")) await refreshChatgptModels({ list: listChatgptModels, env, stateDir, store });
  const defaults = defaultPick(store, { env, isShipped: shipped });
  const order = [...ready.filter((id) => id === defaults.provider), ...ready.filter((id) => id !== defaults.provider)];
  const groups = order.map((id) => buildGroup(PROVIDERS[id], { store, env, now, defaultEffort: defaults.effort, isDefault: id === defaults.provider }));
  const unavailable = statuses.filter((s) => !s.ready).map(({ provider, label, state, detail, fix }) => ({ provider, label, state, detail, fix }));
  const claude = groups.find((g) => g.provider === "claude") || groups[0] || null;
  const picker = {
    groups,
    unavailable,
    defaultProvider: defaults.provider,
    main: claude?.main || [],
    more: claude?.more || [],
    effortNote: claude?.effortNote || getModelPicker().effortNote,
    defaultEffort: defaults.effort,
    source: claude?.source || null,
    fetchedAt: claude?.fetchedAt || null,
  };
  return { groups, unavailable, defaults, picker };
}

/** One provider's group: its models in sections, every model as a picker entry. */
function buildGroup(p, { store = null, env = null, now = new Date(), defaultEffort, isDefault = false } = {}) {
  const effort = defaultEffort || nonEmpty(readSetting(store, "ai.defaultEffort")) || TARSEE_DEFAULT_EFFORT;
  const sections = p.catalog === "claude" ? claudeSections(p, store, effort) : registrySections(p, store, now, effort, env);
  const visible = sections.filter((s) => !s.collapsed).flatMap((s) => s.entries);
  const hidden = sections.filter((s) => s.collapsed).flatMap((s) => s.entries);
  const count = visible.length + hidden.length;
  const claudeList = p.catalog === "claude" ? getModelPicker({ defaultEffort: effort }) : null;
  return {
    provider: p.id,
    label: p.label,
    kind: p.kind,
    state: "ready",
    ready: true,
    default: isDefault,
    defaultModel: defaultModelFor(p, store, isDefault ? env : null),
    sections,
    main: visible,
    more: hidden,
    searchable: p.id === "openrouter" || count > 12,
    effortNote: claudeList?.effortNote || "Higher effort means more thorough responses, but takes longer and costs more.",
    note: count ? null : (p.id === "local" ? "Choose a model for Local AI in Settings > AI." : null),
    source: claudeList?.source || null,
    fetchedAt: claudeList?.fetchedAt || null,
  };
}

const groupEntries = (g) => g.sections.flatMap((s) => s.entries);

/** The Claude providers: Claude Code's own list (newest of each family, then More models). */
function claudeSections(p, store, effort) {
  const picker = getModelPicker({ defaultEffort: effort });
  const deco = (e) => {
    const context = contextTokensFor(p.id, e.id, store);
    const tier = p.kind === "subscription" ? null : familyCostTier(e.family);
    return {
      ...e,
      // Fable's note is about a plan's weekly allowance: an API key is billed per use and has none.
      note: p.kind !== "subscription" && e.note?.text === FABLE_NOTE ? null : e.note,
      provider: p.id,
      ref: formatModelRef(p.id, e.alias || e.id),
      context,
      contextLabel: contextLabel(context),
      vision: true,
      streaming: true,
      selectable: true,
      verify: false,
      free: false,
      costTier: tier,
      priceHint: null,
      badges: p.kind === "subscription" ? [SUBSCRIPTION_BADGE(p)]
        : tier ? [{ text: tier, tone: "neutral", title: "Billed per token by Anthropic (est. tier); the exact cost shows after each reply" }] : [],
    };
  };
  const out = [{ id: "main", label: null, entries: picker.main.map(deco) }];
  if (picker.more.length) out.push({ id: "more", label: "More models", collapsed: true, entries: picker.more.map(deco) });
  return out;
}

/**
 * Every other provider: its catalog, OpenRouter in three sections, Local AI's unverified models apart. env: where
 * TARSEE_AI_PROVIDER and TARSEE_AI_MODEL are read (process.env when none is given).
 */
function registrySections(p, store, now, effort, env = null) {
  const list = modelsFor(p.id);
  const verified = verifiedModels(p.id, store);
  const row = (id) => list.find((m) => m.id === id) || p.models.find((m) => m.id === id) || { id, label: nameFromSlug(id) };
  const make = (m, opts) => registryEntry(p, m, { store, now, effort, ...opts });

  if (p.id === "openrouter") {
    // Recommended: the registry's list (the default first; Anthropic's models through OpenRouter's guaranteed
    // Claude Code endpoint), then the shipped verified ones. Verified by you: the owner's own. All models: the rest,
    // by name. One rule with the turn layer (the registry's engineFor): a model whose maker's engine is known
    // (anthropic/* on Claude Code, openai/* on Codex) can be picked as it is; any other must be verified first.
    const shippedVerified = p.models.filter((m) => m.verified).map((m) => m.id);
    const base = Array.isArray(p.recommended) && p.recommended.length ? p.recommended : [p.defaultModel, ...MODEL_TIERS.map((t) => p.tiers[t])];
    const rec = unique([...base, ...shippedVerified].filter(Boolean));
    const mine = Object.keys(verified).filter((id) => !rec.includes(id));
    const byName = (a, b) => String(a.label || a.id).toLowerCase().localeCompare(String(b.label || b.id).toLowerCase()) || (a.id < b.id ? -1 : 1);
    const rest = list.filter((m) => !rec.includes(m.id) && !mine.includes(m.id)).sort(byName);
    return [
      { id: "recommended", label: "Recommended", entries: rec.map((id) => make(row(id), { selectable: true })) },
      { id: "verified", label: "Verified by you", entries: mine.map((id) => make(row(id), { selectable: true, verifiedRow: true })) },
      { id: "all", label: "All models", collapsed: true, entries: rest.map((m) => make(m, { selectable: !!engineFor(p.id, m.id, store) })) },
    ];
  }

  if (p.id === "local") {
    // One rule with the turn layer: the model chosen on the card runs at once (ai.local.model, else TARSEE_AI_MODEL
    // while Local AI is the default AI, as ai/turn.js reads it); any other must be verified first.
    const chosen = localChosenModel(store, env ?? process.env);
    const ids =unique([...(chosen ? [chosen] : []), ...Object.keys(verified), ...list.map((m) => m.id)]);
    const ok = (id) => !!verified[id] || id === chosen;
    const sections = [{ id: "main", label: null, entries: ids.filter(ok).map((id) => make(row(id), { selectable: true, verifiedRow: !!verified[id] && id !== chosen })) }];
    const rest = ids.filter((id) => !ok(id));
    if (rest.length) sections.push({ id: "all", label: "All models", collapsed: true, entries: rest.map((id) => make(row(id), { selectable: false })) });
    return sections;
  }

  if (p.id === "openai") {
    // The table's models the key can use; the owner's own verified ids (a newer model the table lacks, checked with
    // Verify on the OpenAI card); and, collapsed, the key's other chat models, which need Verify first (design 4.11):
    // the turn layer runs a model it doesn't know only once it is verified.
    const mine = Object.keys(verified).filter((id) => !p.models.some((m) => m.id === id));
    const others = unique(catalogModels("openai-models").map((m) => m.id))
      .filter((id) => !p.models.some((m) => m.id === id) && !mine.includes(id) && isOpenAiChatModel(id))
      .sort();
    const sections = [{ id: "main", label: null, entries: [...list.map((m) => make(m, { selectable: true })), ...mine.map((id) => make(row(id), { selectable: true, verifiedRow: true }))] }];
    if (others.length) sections.push({ id: "all", label: "All models", collapsed: true, entries: others.map((id) => make(row(id), { selectable: false })) });
    return sections;
  }

  if (p.id === "chatgpt" && !list.length) {
    // The account's list could not be read: name no model and let Codex use the plan's own default.
    const e = make({ id: "", label: "ChatGPT's default model" }, { selectable: true });
    e.description = "Codex picks the model your ChatGPT plan includes";
    return [{ id: "main", label: null, entries: [e] }];
  }

  return [{ id: "main", label: null, entries: list.map((m) => make(m, { selectable: true })) }];
}

/**
 * Whether an id the OpenAI key lists is a chat model Tarsee could run on Codex: GPT, o-series and codex- models, not
 * the audio, realtime, transcription, speech, image, search, embedding, moderation or instruct ones.
 */
export function isOpenAiChatModel(id) {
  const v = String(id || "");
  return /^(gpt-\d|o\d|codex-)/i.test(v) && !/(audio|realtime|transcribe|tts|image|search|embed|moderation|instruct)/i.test(v);
}

/** A registry model as a picker entry. */
function registryEntry(p, m, { store, now, effort, selectable, verifiedRow = false }) {
  const id = m.id;
  const engine = id ? engineFor(p.id, id, store) : (p.engines.length === 1 ? p.engines[0] : null);
  const caps = capsFor(p.id, id, store) || {};
  const streaming = engine ? engine === "claude-code" : null;
  const levels = selectable ? effortsFor(p.id, id, store) : (Array.isArray(m.efforts) ? m.efforts : []);
  const context = contextTokensFor(p.id, id, store);
  const listPrice = m.price && typeof m.price.in === "number" ? m.price : null;
  const price = p.kind === "subscription" ? null : listPrice || (p.id === "local" ? priceFor(p.id, id, now, store) : null);
  const free = m.free === true || /:free$/i.test(id) || (!!price && price.in === 0 && price.out === 0);
  const tier = free || p.kind === "subscription" ? null : costTier(price) || (familyOf(id) && (p.id === "openrouter" || p.id === "anthropic") ? familyCostTier(familyOf(id)) : null);
  let hint = price && !free ? priceHint(price) : null;
  if (hint && listPrice?.peak) hint += " Half price outside peak hours.";
  const badges = [];
  if (p.kind === "subscription") badges.push(SUBSCRIPTION_BADGE(p));
  if (free) badges.push({ text: "Free", tone: "neutral", title: p.id === "local" ? "Runs on your own server" : "No charge per token" });
  else if (tier) badges.push({ text: tier, tone: "neutral", title: hint ? `Cost: ${hint}` : "Billed per token (est. tier)" });
  if (verifiedRow) badges.push({ text: "Verified", tone: "neutral", title: "You verified it in Settings > AI" });
  const note = !selectable ? { text: VERIFY_FIRST, tone: "neutral" } : streaming === false ? { text: MESSAGE_AT_A_TIME, tone: "neutral" } : null;
  return {
    id,
    provider: p.id,
    ref: formatModelRef(p.id, id),
    name: m.label || nameFromSlug(id) || id,
    description: null,
    family: null,
    section: null,
    alias: null,
    efforts: effortRows(levels, effort),
    effortNote: null,
    defaultEffort: clampEffort(levels, effort),
    context,
    contextLabel: contextLabel(context),
    vision: !!caps.vision,
    streaming,
    selectable: !!selectable,
    verify: !selectable,
    free,
    costTier: tier,
    priceHint: hint,
    badges,
    note,
  };
}

/** A Claude list's entry for a model a chat runs on: a family's word is its newest, an id is itself. */
function claudeEntry(picker, value) {
  const v = String(value || "").toLowerCase().trim().replace(/\[1m\]$/, "");
  if (!v) return null;
  const all = [...(picker?.main || []), ...(picker?.more || [])];
  return (picker?.main || []).find((e) => e.alias === v || e.family === v)
    || all.find((e) => e.id === v)
    || all.find((e) => e.id === v.replace(/-\d{8}$/, ""))
    || null;
}

function tierWord(raw) {
  const w = String(raw || "").toLowerCase().trim().replace(/\[1m\]$/, "");
  if (Object.hasOwn(TIER_WORDS, w)) return TIER_WORDS[w];
  return MODEL_TIERS.includes(w) ? w : null;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("took too long to answer")), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

function unique(list) {
  return [...new Set(list)];
}

function readSetting(store, key) {
  try { return store?.get?.(key) ?? null; } catch { return null; }
}

function readJson(store, key) {
  const v = readSetting(store, key);
  if (v == null || v === "") return null;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  return typeof v === "object" ? v : null;
}

function nonEmpty(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
