/**
 * turn.js: one turn of the agent, on whichever AI it runs (design 4.6). Every channel's turn comes through here
 * (ai/router.js chatStream is runTurn): the dashboard, Telegram, Discord, Slack, WhatsApp, email, crons, subagents,
 * ACP and the external API.
 *
 * Two engines run the turns, each with its own tool loop: Claude Code (providers/claude-code.js) and Codex
 * (providers/codex.js). They are reached through loadEngine(), and tests put scripted ones in with registerEngine().
 * An engine's run(opts) yields Tarsee's events (text, thinking, tool_use, tool_result, usage, step, error, done); this
 * layer does everything that is the same on every AI:
 *
 *   a. which provider, model and effort (resolveTarget): the caller's own choice, else the chat's pick
 *      (session.<conv>.provider/model/effort), else the default provider (the registry's activeProviderId) and its model;
 *      the ChatGPT account's and Local AI's model lists are read first when nothing has since the restart
 *   b. refusals, each one text, an error and a done: API keys only, an AI that isn't set up, a model that must be
 *      verified first, this month's spending cap
 *   c. a `route` event first, naming the provider, engine, model and effort (callers ignore types they don't know)
 *   d. sessions: the chat's stored handle resumes only on the same provider, engine home and maker
 *      (session-handle.js); otherwise a fresh session with the recent conversation handed over (handoff.js), and the
 *      new session is stored tagged
 *   e. the prompt: the queued note once (never on a slash command), media adapted to what the model takes
 *   f. the live timeline (lib/live-bus.js): turn_start, the steps (usage at most every 3s), turn_end
 *   g. the engine, with the turn's ceilings (and Tarsee's tools over loopback MCP for Codex)
 *   h. the spend ceiling, for AIs whose engine has none of its own: running totals stop the work in progress; a cost
 *      that only arrives with the finished reply (Codex's, a Claude Code result's) marks the turn over budget (its
 *      done carries overBudget, ceilingUsd and spentUsd) and warns, and never fails what already happened
 *   i. one retry, fresh, for a session the engine couldn't resume, before anything was said
 *   j. the backup model (ai.backupModel, opt-in) when the AI can't answer (sign-in, credit, busy, unavailable, model)
 *   k. failure flags (ai.<id>.status) on a sign-in or credit failure, cleared by a success
 *   l. exactly one done, an error before every done that isn't a success or a stop, never stopReason "tool_use"
 *   m. Codex usage recorded directly (it writes no Claude transcript), and an Anthropic key's cost for a turn with no
 *      live conversation (no turn_end carries it to the usage index): the engine's exact total, or for a turn stopped
 *      before that came, its tokens so far at the list price (an estimate)
 *   n. the turn's MCP grant revoked and the turn unregistered, however it ends
 */
import { BACKGROUND_DEFAULTS } from "../config/constants.js";
import { SettingsStore } from "../db/settings.js";
import { EFFORT_IDS, TARSEE_DEFAULT_EFFORT } from "../lib/model-picker.js";
import { claimQueuedTurn, takeQueuedNote } from "../lib/conversation-lock.js";
import { publish, newTurnId } from "../lib/live-bus.js";
import { redactSecrets } from "../lib/redact.js";
import {
  activeProviderId, capsFor, catalogModels, effortsFor, engineFor, getProvider, isShipped, isTierWord, keysOnly, keysOnlyLocked,
  modelsFor, normalizeProviderId, resolveModelFor, vendorFor, verifiedModels,
} from "./provider-registry.js";
import { clearFailureFlag, failureFlag, providerStatus } from "./provider-status.js";
import { anthropicListCost, checkTurnBudget, costSource, monthlyCapStatus, priceUsage, recordReportedCost } from "./spend.js";
import { adaptMedia } from "./media.js";
import { isTranscriptOverCap, SESSION_JSONL_MAX_MB } from "../lib/claude-transcript.js";
import { parseModelRef } from "./model-ref.js";
import { homeKeyFor } from "./engine-env.js";
import { format as formatHandle, parse as parseHandle, sessionFor } from "./session-handle.js";
import { buildHandoff, HANDOFF_DEFAULT_CHARS } from "./handoff.js";

/** Live usage steps go out at most this often; their totals ride on turn_end. */
const USAGE_STEP_MS = 3000;
/** How long a turn's first words may wait to be sure they aren't the engine explaining a failure. */
const FIRST_WORDS_HOLD_MS = 1500;
/** Interactive turns' ceiling on the engine's own turns; background callers pass a lower one. */
const INTERACTIVE_MAX_TURNS = 50;
/** How many of a chat's stored messages the handoff is built from (its character cap decides how many fit). */
const HANDOFF_ROWS = 40;

const SUCCESS = "end_turn";
const ABORTED = "aborted";

/**
 * Provider states (provider-status.js) that mean a turn can't start: nothing to sign in or connect with, or a key in
 * the wrong slot. The failure flags an engine leaves (sign-in-expired, out-of-credit) don't stop a turn: the owner may
 * have fixed it at the provider, and the engine says so again if not.
 */
const NOT_READY_STATES = new Set(["needs-key", "needs-sign-in", "needs-setup", "error"]);
/** Failures the backup model answers. Never a stop, a refusal or a spend ceiling. */
const BACKUP_CODES = new Set(["auth", "billing", "rate", "unavailable", "model"]);
/** engine-errors.js kinds (and the SDKs' codes) by what they mean here. */
const CODE_ALIASES = {
  expired: "auth", "wrong-key": "auth", "auth-expired": "auth", "sign-in-expired": "auth", authentication_failed: "auth", unauthorized: "auth",
  "out-of-credit": "billing", billing_error: "billing", insufficient_quota: "billing",
  rate_limit: "rate", rate_limit_exceeded: "rate", usage_limit_reached: "rate",
  overloaded: "unavailable", server_error: "unavailable", model_not_found: "model",
};

/**
 * The note on a prompt that waited behind another turn of its conversation (lib/conversation-lock.js): it is one
 * message, sent once, even if the agent already saw it while it worked on the turn before (it can read the chat's
 * newest messages itself and answer there). Without it, the agent told the person their one message "reached me
 * twice". Added once only, and never in front of a slash command.
 */
export const QUEUED_NOTE = "[This message came in while you were still working on the one before. If you already saw it then (in the chat's history or the database) and answered it, it is the same single message, sent once, not a second copy: do not say it reached you twice. Carry on from where you are, briefly if it is already answered.]\n\n";

export function withQueuedNote(prompt) {
  if (typeof prompt !== "string" || !prompt || prompt.startsWith(QUEUED_NOTE) || prompt.trimStart().startsWith("/")) return prompt;
  return QUEUED_NOTE + prompt;
}

/** The setting that holds a provider's failure flag {state, at, detail}: ai.<public id>.status. */
export function failureFlagKey(providerId) {
  return `ai.${normalizeProviderId(providerId) || String(providerId)}.status`;
}

// --- Engines -----------------------------------------------------------------------------------------------------

const ENGINE_LOADERS = {
  "claude-code": () => import("./providers/claude-code.js"),
  codex: () => import("./providers/codex.js"),
};
const registeredEngines = new Map();

/**
 * Put an engine module ({ run(opts) }) in for a name ("claude-code", "codex"); null takes it out again, so the
 * engine's own module loads. For tests and for an engine loaded some other way.
 */
export function registerEngine(name, mod) {
  if (mod == null) { registeredEngines.delete(name); return; }
  if (typeof mod.run !== "function") throw new TypeError(`registerEngine: the ${name} engine has no run()`);
  registeredEngines.set(name, mod);
}

/** The engine module for a name: one registered, else the engine's own module. Throws for a name with no engine. */
export async function loadEngine(name) {
  if (registeredEngines.has(name)) return registeredEngines.get(name);
  const loader = ENGINE_LOADERS[name];
  if (!loader) throw new Error(`No AI engine called ${JSON.stringify(name)}`);
  const mod = await loader();
  if (typeof mod?.run !== "function") throw new Error(`The ${name} engine can't run turns (it has no run())`);
  return mod;
}

// --- Seams -------------------------------------------------------------------------------------------------------

/**
 * The parts of a turn that live in other modules, each replaceable (configureTurns) so tests can script them:
 *   providerStatus(id, store)        readiness, provider-status.js ({state, detail, fix}); the engines' failure flags
 *                                    are left out (see NOT_READY_STATES) and the ChatGPT sign-in is read from its file
 *   monthlyCap({providerId, model, store, db})   spend.js monthlyCapStatus: {ok, capUsd, spentUsd, message}
 *   checkTurnBudget(opts)            spend.js: {tripped, spentUsd, message} for the turn's usage so far
 *   priceUsage(providerId, model, usage, at, store)   spend.js: the turn's cost in USD at the price table, or null
 *   grantMcp(ctx, {turnId, signal})  mcp-http.js grantTurn: {url, token, revoke()}, Tarsee's tools for a Codex turn
 *   recordUsage(row, db)             token-usage.js recordDirect: a turn with no Claude transcript (Codex)
 *   recordReported(row, db)          spend.js recordReportedCost: an Anthropic key's exact cost for a turn with no
 *                                    live conversation (no turn_end will carry it to the usage index)
 *   chatgptModels(store)             lib/model-catalog.js refreshChatgptModels: fill the ChatGPT account's model list
 *                                    (empty after a restart) before a turn names one of its models
 *   localModels(store)               provider-models.js ensureLocalModels: Local AI's model list, read from its
 *                                    server when nothing has read it since the restart
 *   adaptMedia(content, caps, ctx)   media.js: the prompt's pictures, PDFs and voice notes as the model takes them
 *                                    ({content, ...}); it also keeps the pictures with the person's message
 *   transcriptOverCap(rawId, provider)   claude-transcript.js: a Claude Code session too big to resume
 */
const DEFAULT_DEPS = Object.freeze({
  providerStatus: (id, store) => providerStatus(id, { store, ignoreFlags: true, loginStatus: fileLoginStatus }),
  monthlyCap: (args) => monthlyCapStatus(args),
  checkTurnBudget: (opts) => checkTurnBudget(opts),
  priceUsage: (providerId, model, usage, at, store) => priceUsage(providerId, model, usage, at, store),
  grantMcp: async (ctx, opts) => (await import("./mcp-http.js")).grantTurn(ctx, opts),
  recordUsage: async (row, db) => (await import("../lib/token-usage.js")).recordDirect(row, db),
  recordReported: async (row, db) => recordReportedCost(row, db || (await import("../lib/token-usage.js")).usageIndex()?.db || null),
  chatgptModels: async (store) => (await import("../lib/model-catalog.js")).refreshChatgptModels({ store }),
  localModels: async (store) => (await import("./provider-models.js")).ensureLocalModels(store),
  adaptMedia: (content, caps, ctx) => adaptMedia(content, caps, ctx),
  transcriptOverCap: (rawId, provider) => isTranscriptOverCap(rawId, SESSION_JSONL_MAX_MB, { provider }),
});
let deps = { ...DEFAULT_DEPS };

/** Replace some of the seams above. Returns a function that puts back what was there before. */
export function configureTurns(overrides = {}) {
  const before = deps;
  const own = Object.fromEntries(Object.entries(overrides || {}).filter(([k, v]) => k in DEFAULT_DEPS && typeof v === "function"));
  deps = { ...deps, ...own };
  return () => { deps = before; };
}

/** The ChatGPT sign-in as its file says (auth.json): a turn doesn't start the Codex CLI just to ask. */
async function fileLoginStatus(opts) {
  const { loginStatus } = await import("./codex-device-login.js");
  return loginStatus({ ...opts, cli: false });
}

// --- Which AI ----------------------------------------------------------------------------------------------------

/**
 * The Target a turn runs on: { provider, providerId, storageId, kind, engine, model, effort, vendor, homeKey, caps,
 * label, providerLabel }. engine is null for a model that must be verified first.
 *
 *  Provider: the caller's own (opts.provider, or a ref's "provider:" in opts.model), then the chat's pick
 *    (session.<conv>.provider, when that AI is switched on and set up), then the default (activeProviderId).
 *    A caller that passes the default provider (what the channels do) has not chosen one.
 *  Model: the caller's own, then the chat's (session.<conv>.model, only when it belongs to that provider: a pick
 *    stored before providers existed is a Claude model, for the Claude plan or the Anthropic key), then for
 *    background work ai.<sid>.backgroundModel and the provider's haiku tier, then ai.<sid>.model (and
 *    TARSEE_AI_MODEL for the default provider), then the provider's default; all through the registry's resolveModelFor. A caller that passes the default provider's
 *    default model (what the channels do) has not chosen one either.
 *  Effort: the caller's own, then the chat's, then ai.defaultEffort, then Medium (background work without a chat
 *    sends none), stepped down to a level the model takes.
 * Returns { target } or { refusal: {subtype, message} } (an AI Tarsee doesn't know).
 */
export async function resolveTarget(opts = {}, store = storeOf(opts)) {
  const conv = opts.toolCtx?.conversationId || null;
  const activeId = activeProviderId(store);
  const ref = parseModelRef(typeof opts.model === "string" ? opts.model : "");

  let asked = null;
  if (opts.provider != null && String(opts.provider).trim() !== "") {
    asked = normalizeProviderId(String(opts.provider));
    if (!asked) {
      return { refusal: { subtype: "not-ready", message: `Tarsee doesn't know an AI called "${clip(String(opts.provider), 40)}". Choose one in Settings > AI.` } };
    }
  }
  const explicit = ref.provider || (asked && asked !== activeId ? asked : null);

  const chatProvider = conv ? normalizeProviderId(readStr(store, `session.${conv}.provider`)) : null;
  let providerId = explicit;
  if (!providerId && chatProvider && chatProvider !== activeId) {
    if (await usable(chatProvider, store)) providerId = chatProvider;
    else console.log(`[turn] chat ${conv} picked ${chatProvider}, which can't take turns now: using the default AI`);
  }
  providerId ||= asked || activeId;

  // The model
  const activeDefault = defaultModelSetting(activeId, store);
  let pick;
  // (A bare model equal to the default AI's own is no choice from a chat's picker, so the chat's own pick still
  // applies; background work has no chat, and a model it names is the one it asked for.)
  if (ref.provider) pick = ref.model;
  else if (ref.model && (opts.background || ref.model !== activeDefault)) pick = ref.model;
  if (pick === undefined && conv) {
    const chosen = readStr(store, `session.${conv}.model`);
    if (chosen) {
      const own = parseModelRef(chosen);
      const owner = own.provider || chatProvider || "claude";
      // A pick stored before providers existed (a bare model, no AI with it) is a Claude model: it runs on the Claude
      // plan and on the Anthropic key alike, which have the same models (the composer shows it on either). Any other
      // AI would read it as one of its own tiers, another model than the one picked, so there the default runs.
      const legacy = !own.provider && !chatProvider && getProvider(providerId)?.catalog === "claude";
      if (own.model && (owner === providerId || legacy)) pick = own.model;
    }
  }
  const p = getProvider(providerId);
  if (pick === undefined) {
    if (opts.background) pick = readStr(store, `ai.${p.storageId}.backgroundModel`) || "haiku";
    else pick = readStr(store, `ai.${p.storageId}.model`) || (providerId === activeId ? envModelFor(providerId) : null);
  }

  // The effort
  let wanted = EFFORT_IDS.includes(opts.effort) ? opts.effort : null;
  if (!wanted && conv) {
    const chats = readStr(store, `session.${conv}.effort`);
    const fallback = readStr(store, "ai.defaultEffort");
    wanted = [chats, fallback, TARSEE_DEFAULT_EFFORT].find((e) => EFFORT_IDS.includes(e));
  }

  await ensureModelList(providerId, pick, store);
  const target = targetFor(providerId, pick, wanted, store);
  // Verification (verify-model.js): the probe runs the model on the engine it is checking, one the provider runs on,
  // and tries the effort level as given; the registry's choice would refuse an unverified model or pick another engine.
  if (opts.verify === true && typeof opts.engine === "string" && p.engines.includes(opts.engine)) {
    // The model being checked runs as it is: the registry puts its default in place of an id it doesn't list (a
    // model the OpenAI key's table lacks, one Local AI's server didn't list yet), and the check would then pass on a
    // model that never ran. A tier word (or a Claude id, which other AIs read as a tier) is still the AI's own.
    const asked = ref.model ? ref.model.replace(/\[1m\]$/i, "") : "";
    if (asked && p.catalog !== "claude" && !isTierWord(asked) && !/^claude-/i.test(asked) && asked !== target.model) {
      target.model = asked;
      target.vendor = vendorFor(p.id, asked);
      target.caps = capsFor(p.id, asked, store) || {};
      target.label = modelLabel(p, asked);
    }
    target.engine = opts.engine;
    target.homeKey = homeKeyFor(target.provider, opts.engine);
    target.caps = {
      ...target.caps,
      streaming: opts.engine === "claude-code",
      pdf: !!target.caps.pdf && opts.engine === "claude-code",
    };
    target.effort = EFFORT_IDS.includes(opts.effort) ? opts.effort : null;
  }
  return { target };
}

/**
 * The model lists a model is named from, when nothing has read them since the server started (they live only in
 * memory): the ChatGPT account's own models (Codex's live list, design A2: without it a chosen model, and the
 * account's default, can't be named, and Codex would run its own), and Local AI's server's models when the pick isn't
 * a model of its own (Local AI has no default: without the list an install set up only through Railway variables is
 * "not set up" after every restart). A list that can't be read leaves things as they were: ChatGPT then names no
 * model (Codex picks), and Local AI is refused with how to fix it.
 */
async function ensureModelList(providerId, pick, store) {
  try {
    if (providerId === "chatgpt") {
      // "API keys only" refuses the ChatGPT sign-in (refusalFor), so its list isn't read either: that would start Codex
      // on the account the owner switched off.
      if (keysOnly(store)) return;
      if (!catalogModels("chatgpt-models").length) await deps.chatgptModels(store);
    } else if (providerId === "local") {
      if (!catalogModels("local-models").length && !resolveModelFor("local", pick ?? null, store)) await deps.localModels(store);
    }
  } catch (err) {
    console.warn(`[turn] reading ${providerId}'s model list failed: ${err?.message || err}`);
  }
}

/** The Target for a provider, a model (or tier word, or nothing for the default) and an effort. */
function targetFor(providerId, pick, wantedEffort, store) {
  const p = getProvider(providerId);
  const model = resolveModelFor(p.id, pick ?? null, store);
  const engine = engineFor(p.id, model, store);
  return {
    provider: p.id,
    providerId: p.id,
    storageId: p.storageId,
    kind: p.kind,
    engine: engine || null,
    model: model || null,
    effort: clampEffort(wantedEffort, effortsFor(p.id, model, store)),
    vendor: vendorFor(p.id, model),
    homeKey: engine ? homeKeyFor(p.id, engine) : null,
    caps: capsFor(p.id, model, store) || {},
    label: modelLabel(p, model),
    providerLabel: p.label,
  };
}

/** The level a model takes nearest to the one wanted: the next one down, else the next one up; null for none. */
function clampEffort(wanted, allowed) {
  if (!wanted || !Array.isArray(allowed) || !allowed.length) return null;
  if (allowed.includes(wanted)) return wanted;
  const i = EFFORT_IDS.indexOf(wanted);
  for (let j = i - 1; j >= 0; j--) if (allowed.includes(EFFORT_IDS[j])) return EFFORT_IDS[j];
  for (let j = i + 1; j < EFFORT_IDS.length; j++) if (allowed.includes(EFFORT_IDS[j])) return EFFORT_IDS[j];
  return null;
}

/** A model's name for people: "DeepSeek Flash", "Claude Sonnet", "Claude Opus 4.8", or the id / the AI's name. */
function modelLabel(p, model) {
  const plain = p.label.replace(/ (plan|API key)$/, "");
  if (!model) return plain;
  const bare = model.replace(/\[1m\]$/i, "");
  const row = modelsFor(p.id).find((m) => m.id === bare);
  if (p.catalog === "claude") {
    if (row?.alias && row.tier) return `Claude ${row.tier[0].toUpperCase()}${row.tier.slice(1)}`;
    return row?.label || bare;
  }
  return row?.label && row.label !== row.id ? row.label : bare;
}

/** Whether a chat's own pick can take a turn now (switched on, not blocked by API keys only, set up). */
async function usable(providerId, store) {
  const p = getProvider(providerId);
  if (!p || !isShipped(p.id)) return false;
  if (p.kind === "subscription" && keysOnly(store)) return false;
  try {
    const s = await deps.providerStatus(p.id, store);
    return !NOT_READY_STATES.has(s?.state);
  } catch {
    return false;
  }
}

function defaultModelSetting(providerId, store) {
  const p = getProvider(providerId);
  return readStr(store, `ai.${p.storageId}.model`) || p.defaultModel || null;
}

/** TARSEE_AI_MODEL: the default provider's model for a headless setup (a bare model, or a ref naming that provider). */
function envModelFor(providerId) {
  const raw = typeof process.env.TARSEE_AI_MODEL === "string" ? process.env.TARSEE_AI_MODEL.trim() : "";
  if (!raw) return null;
  const ref = parseModelRef(raw);
  if (ref.provider && ref.provider !== providerId) return null;
  return ref.model;
}

/**
 * Local AI's one rule (lib/model-catalog.js has it for the composer's menu and /model): the model chosen on its card
 * (ai.local.model, else TARSEE_AI_MODEL while Local AI is the default AI; with neither, the first model its server
 * lists), its background model, and the models verified in Settings > AI run; any other must be verified first. A
 * chat's pick saved while it was the card's model keeps to the rule once the card moves on.
 */
function localModelAllowed(model, store) {
  if (verifiedModels("local", store)[model]) return true;
  const chosen = readStr(store, "ai.local.model") || (activeProviderId(store) === "local" ? envModelFor("local") : null);
  if (model === chosen || model === resolveModelFor("local", chosen, store)) return true;
  const background = readStr(store, "ai.local.backgroundModel");
  return !!background && model === background;
}

/** Why a target can't take a turn, as {subtype, message}, or null. Order: switched on, keys only, set up, verified, cap. */
async function refusalFor(target, ctx) {
  const p = getProvider(target.provider);
  const { store } = ctx;
  if (!isShipped(p.id)) {
    return { subtype: "not-ready", message: `This Tarsee can't use the ${p.label}. Choose another AI in Settings > AI.` };
  }
  if (p.kind === "subscription" && keysOnly(store)) {
    const locked = keysOnlyLocked() ? " (it is locked on by the TARSEE_KEYS_ONLY variable)" : "";
    return {
      subtype: "blocked-keys-only",
      message: `"API keys only" is switched on${locked}, so Tarsee won't use your ${p.label}. Choose an AI that uses an API key in Settings > AI.`,
    };
  }
  let status = null;
  try { status = await deps.providerStatus(p.id, store); } catch (err) { console.warn(`[turn] readiness of ${p.id}: ${err?.message || err}`); }
  if (status && NOT_READY_STATES.has(status.state)) {
    const nothingChosen = !readStr(store, "ai.activeProvider") && !String(process.env.TARSEE_AI_PROVIDER || "").trim();
    const message = nothingChosen && p.id === "claude"
      ? "Tarsee isn't connected to an AI yet: open Settings > AI."
      : [status.detail, status.fix].filter(Boolean).join(" ") || `The ${p.label} isn't set up yet. Open Settings > AI.`;
    return { subtype: "not-ready", message };
  }
  if (!target.engine || (p.id === "local" && ctx.opts?.verify !== true && target.model && !localModelAllowed(target.model, store))) {
    return { subtype: "needs-verification", message: `This model (${target.model || "unnamed"}) hasn't been verified yet. Verify it in Settings > AI first.` };
  }
  if (p.kind !== "subscription") {
    let cap = null;
    try {
      cap = await deps.monthlyCap({ providerId: p.id, model: target.model, store, db: ctx.db });
    } catch (err) {
      console.warn(`[turn] the monthly spending cap check failed: ${err?.message || err}`);
    }
    if (cap && cap.ok === false) {
      const amount = cap.capUsd != null ? ` (${usd(cap.capUsd)})` : "";
      return { subtype: "spend-cap", message: cap.message || `This month's AI spending cap${amount} is reached. Raise it in Settings > AI.` };
    }
  }
  return null;
}

// --- The turn ----------------------------------------------------------------------------------------------------

/** Live conversation id -> controllers of the turns running in it right now. */
const runningTurns = new Map();

/**
 * Stop every turn running in a conversation, whichever channel started it.
 * @param {string} conversationId a conversation id, or a background job's live id
 * @returns {number} how many turns were told to stop
 */
export function stopTurns(conversationId) {
  const set = runningTurns.get(conversationId);
  if (!set) return 0;
  let n = 0;
  for (const c of set) { if (!c.signal.aborted) { c.abort(); n++; } }
  return n;
}

/**
 * One turn. Options (all optional but messages):
 *   messages            the chat's messages, the turn's prompt last (role "user"; a string or content blocks)
 *   provider, model     the caller's own choice (a model may be a ref, "deepseek:deepseek-flash"); see resolveTarget
 *   effort              this message's thinking effort (/think, !think)
 *   background          unattended work (crons, the heartbeat): the background model, a lower turn ceiling, and a
 *                       tool context marked with its source (toolCtx.background = liveSource)
 *   systemPrompt | systemParts {stable, volatile}
 *   toolCtx             {db, settingsStore, conversationId, channelManager, messageId, ...} for Tarsee's tools
 *   sessionId           the chat's stored session handle (bare for the Claude plan, tagged for the rest)
 *   onSessionId(handle) store the handle of the session this turn ran in (tagged as session-handle.js says)
 *   signal              the caller's stop
 *   maxTurns, maxBudgetUsd   ceilings (maxBudgetUsd goes to an engine that keeps one itself, else the turn guard)
 *   thinkingSummaries   summaries of the model's thinking (default: on for a turn from the dashboard)
 *   queuedNote          whether the prompt waited in its chat's queue (default: asked of conversation-lock.js)
 *   liveConversationId, liveSource, liveDisabled, liveTurnId   the live timeline (lib/live-bus.js)
 * Legacy options (apiKey, baseUrl, tools, executeTool) are ignored: engines run their own tools.
 */
export async function* runTurn(opts = {}) {
  opts = { ...opts };
  // Unattended work (a scheduled task's or a webhook's run, the heartbeat, BOOT.md) says so to Tarsee's tools, by its
  // source: both engines hand the tools this context (Claude Code's in-process MCP server gets it as it is, Codex's
  // grant copies it), and schedule_task refuses in it (lib/tools.js), so background work never schedules more.
  if (opts.background && !opts.toolCtx?.background) opts.toolCtx = { ...(opts.toolCtx || {}), background: opts.liveSource || "background" };
  if (opts.thinkingSummaries == null) opts.thinkingSummaries = opts.liveSource === "web";
  const liveConv = opts.liveDisabled ? null : (opts.liveConversationId || opts.toolCtx?.conversationId || null);
  // (A turn that waited behind another in its conversation says so to the agent, once. Not a subagent's turn, which
  // runs off the timeline: its task is not the message that waited.)
  if (opts.queuedNote == null) opts.queuedNote = takeQueuedNote(liveConv);
  const store = storeOf(opts);
  const db = opts.toolCtx?.db || store?.db || null;

  // Our own controller, following the caller's signal, so stopTurns() can end this turn without the caller's help.
  const stopper = new AbortController();
  follow(opts.signal, stopper);
  let set = null;
  if (liveConv) {
    set = runningTurns.get(liveConv);
    if (!set) { set = new Set(); runningTurns.set(liveConv, set); }
    set.add(stopper);
  }
  // (A turn that waited in its chat's queue keeps the id of its "Queued" line: the same line begins.)
  const turnId = (liveConv && (opts.liveTurnId || claimQueuedTurn(liveConv))) || opts.liveTurnId || newTurnId();
  const turnStartedAt = Date.now();
  // unloggedCost: the cost of the attempts no transcript prices (an Anthropic key's), for a turn with no turn_end to
  // carry it (unloggedExact: every figure in it is the provider's own; unloggedTarget: the attempt it came from).
  const state = { stopReason: null, error: null, sessionRaw: null, target: null, costUsd: null, costExact: null, overBudget: false, unloggedCost: 0, unloggedExact: null, unloggedTarget: null };
  const ctx = { opts, store, db, stopper, turnId, liveConv, state };

  let resolved;
  try {
    resolved = await resolveTarget(opts, store);
  } catch (err) {
    console.error("[turn] could not work out which AI to use:", err);
    resolved = { refusal: { subtype: "error", message: `Tarsee couldn't work out which AI to use: ${err?.message || err}` } };
  }
  state.target = resolved.target || null;

  if (liveConv) {
    const lastUser = [...(opts.messages || [])].reverse().find((m) => m?.role === "user");
    publish(liveConv, "turn_start", {
      model: resolved.target?.model || null,
      effort: resolved.target?.effort || null,
      source: opts.liveSource || null,
      prompt: String(contentText(lastUser?.content) || "").slice(0, 300),
      provider: resolved.target?.provider || null,
      engine: resolved.target?.engine || null,
      label: resolved.target?.label || null,
      streaming: resolved.target ? !!resolved.target.caps?.streaming : null,
    }, { turnId });
  }

  let usage = null;
  let usageSentAt = 0;
  let usageTimer = null;
  const sendUsage = () => {
    clearTimeout(usageTimer);
    usageTimer = null;
    if (!usage || !liveConv) return;
    usageSentAt = Date.now();
    publish(liveConv, "step", usage, { turnId });
  };
  try {
    for await (const evt of turnBody(ctx, resolved)) {
      if (evt?.type === "step") {
        if (!liveConv) continue;
        const { type: _t, ...step } = evt;
        if (step.kind === "usage") {
          usage = step;
          const wait = USAGE_STEP_MS - (Date.now() - usageSentAt);
          if (wait <= 0) sendUsage();
          else if (!usageTimer) { usageTimer = setTimeout(sendUsage, wait); usageTimer.unref?.(); }
          continue;
        }
        publish(liveConv, "step", step, { turnId });
        continue;
      }
      if (evt?.type === "done") state.stopReason = evt.stopReason || SUCCESS;
      else if (evt?.type === "error") state.error = evt.message || "error";
      yield evt;
    }
  } finally {
    if (set) {
      set.delete(stopper);
      if (!set.size && runningTurns.get(liveConv) === set) runningTurns.delete(liveConv);
    }
    if (usageTimer) sendUsage();
    if (liveConv) {
      const { kind: _k, ...totals } = usage || {};
      publish(liveConv, "turn_end", {
        stopReason: state.stopReason || (stopper.signal.aborted ? ABORTED : "ended"),
        ...(state.error ? { error: String(state.error).slice(0, 500) } : {}),
        ...(state.sessionRaw ? { sessionId: state.sessionRaw } : {}),
        ...(usage ? { usage: totals } : {}),
        provider: state.target?.provider || null,
        engine: state.target?.engine || null,
        ...(state.costUsd != null ? { costUsd: round6(state.costUsd), ...(state.costExact ? { costExact: true } : {}) } : {}),
        ...(state.overBudget ? { overBudget: true } : {}),
      }, { turnId });
    } else if (state.unloggedCost > 0) {
      // No turn_end will carry this turn's cost to the usage index (a subagent, ACP, a Verify probe): an Anthropic
      // key's calls are never priced, so without this its spend would slip past this month's cap.
      const row = {
        turnId,
        conversationId: opts.toolCtx?.conversationId || `${opts.liveSource || (opts.verify === true ? "verify" : "turn")}:${turnId}`,
        source: opts.liveSource || (opts.verify === true ? "verify" : null),
        stopReason: state.stopReason || null,
        provider: state.unloggedTarget?.provider || "anthropic",
        engine: "claude-code",
        model: state.unloggedTarget?.model || null,
        effort: state.unloggedTarget?.effort || null,
        startedAt: turnStartedAt,
        endedAt: Date.now(),
        costUsd: round6(state.unloggedCost),
        exact: state.unloggedExact !== false,
      };
      Promise.resolve()
        .then(() => deps.recordReported(row, db))
        .catch((err) => console.warn(`[turn] recording this turn's cost failed: ${err?.message || err}`));
    }
  }
}

/** The turn after its target is known: refusals, the prompt, the engine with its retry and backup, one done. */
async function* turnBody(ctx, resolved) {
  const { opts } = ctx;
  if (resolved.refusal) { yield* refuse(resolved.refusal); return; }
  const primary = resolved.target;
  const refusal = await refusalFor(primary, ctx);
  if (refusal) { yield* refuse(refusal); return; }

  // The prompt. Its media is adapted per model below (adaptFor), which also keeps its pictures with the person's message.
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  const lastIdx = findLastIndex(messages, (m) => m?.role === "user");
  const content = lastIdx >= 0 ? messages[lastIdx].content : "";
  const promptText = contentText(content);
  const slash = promptText.trimStart().startsWith("/");
  const conv = opts.toolCtx?.conversationId || null;
  // A verification probe (verify-model.js) checks the model alone: no handoff (only its session may carry context),
  // and no second try or backup model that could pass the check in its place.
  const probe = opts.verify === true;
  let handoffText = null;
  const handoff = () => {
    if (handoffText == null) {
      handoffText = slash || probe ? "" : buildHandoff(handoffHistory(ctx), {
        maxChars: readNum(ctx.store, "ai.handoffChars", HANDOFF_DEFAULT_CHARS),
        since: conv ? readStr(ctx.store, `session.${conv}.clearedAt`) : null,
      });
    }
    return handoffText;
  };

  const stored = typeof opts.sessionId === "string" ? opts.sessionId : (typeof opts.sessionHandle === "string" ? opts.sessionHandle : null);
  let target = primary;
  let raw = sessionFor(stored, primary);
  // A Claude Code transcript past its cap is re-read whole on resume, which fills the window before the message is
  // even read: that session starts fresh instead, with the recent conversation handed over.
  if (raw && primary.engine === "claude-code" && deps.transcriptOverCap(raw, primary.provider)) {
    console.warn(`[turn] session ${clip(raw, 40)}'s transcript is over ${SESSION_JSONL_MAX_MB}MB: starting fresh with the recent conversation`);
    raw = null;
  }
  let fresh = !raw;
  let retried = false;
  let backupUsed = false;
  yield routeEvent(primary);

  for (;;) {
    const turnContent = await adaptFor(content, target, ctx);
    const prompt = prefixPrompt(turnContent, fresh ? handoff() : "", !!opts.queuedNote && !slash);
    const turnMessages = lastIdx >= 0 ? messages.map((m, i) => (i === lastIdx ? { ...m, content: prompt } : m)) : [...messages, { role: "user", content: prompt }];
    ctx.state.target = target;
    const res = yield* runAttempt(ctx, {
      target,
      messages: turnMessages,
      media: Array.isArray(prompt) ? prompt.filter(isMediaBlock) : [],
      raw: fresh ? null : raw,
      handle: fresh ? null : stored,
    });
    if (res.costUsd != null) {
      ctx.state.costUsd = (ctx.state.costUsd || 0) + res.costUsd;
      // Exact only while every figure added up is the provider's own (a backup's estimate makes the sum one).
      ctx.state.costExact = (ctx.state.costExact ?? true) && res.costExact;
      // An Anthropic key's figure (its engine's exact total, or the list-price estimate of an attempt stopped before
      // that came) is the only record of what its attempt cost: its calls are never priced. OpenRouter's exact
      // figure is not counted here, since its calls are priced and counted already.
      if (target.engine === "claude-code" && costSource(target.provider, ctx.store) === "exact") {
        ctx.state.unloggedCost += res.costUsd;
        ctx.state.unloggedExact = (ctx.state.unloggedExact ?? true) && res.costExact;
        ctx.state.unloggedTarget = target;
      }
    }
    writeFailureFlag(ctx.store, target, res);

    const beforeOutput = res.kind === "failed" && !res.sawOutput && !ctx.stopper.signal.aborted && !probe;
    if (beforeOutput && res.failure?.recoverable && !retried) {
      retried = true;
      fresh = true;
      raw = null;
      console.warn(`[turn] ${target.provider} couldn't resume the session (${clip(res.failure.message, 160)}): trying once more, fresh`);
      continue;
    }
    if (beforeOutput && !backupUsed && BACKUP_CODES.has(res.failure?.code)) {
      const backup = await backupTarget(ctx, target);
      if (backup) {
        backupUsed = true;
        const why = reasonWords(target, res.failure.code);
        console.warn(`[turn] ${target.provider} can't answer (${why}): answering with the backup, ${backup.provider}:${backup.model}`);
        yield { type: "step", kind: "status", text: `${target.providerLabel} unavailable (${why}); answering with ${backup.label}` };
        yield routeEvent(backup, { backup: true });
        // The live view's working line names the AI answering from here on (runTurn publishes steps, never yields them).
        yield { type: "step", kind: "route", provider: backup.provider, engine: backup.engine, model: backup.model, label: backup.label, streaming: !!backup.caps?.streaming };
        yield { type: "text", content: `_${backup.label} answered: the ${target.providerLabel} is unavailable (${why})._\n\n` };
        target = backup;
        fresh = true;
        raw = null;
        continue;
      }
    }
    for (const evt of res.tail) yield evt.type === "error" ? withoutRecoverable(evt) : evt;
    yield res.done;
    return;
  }
}

/** A refusal: the reason as the reply, the same as an error, and a done with the reason. */
async function* refuse({ subtype, message }) {
  yield { type: "text", content: message };
  yield { type: "error", message, subtype, recoverable: false };
  yield { type: "done", stopReason: subtype };
}

function routeEvent(t, extra = {}) {
  return {
    type: "route",
    provider: t.provider,
    engine: t.engine,
    model: t.model,
    label: t.label,
    providerLabel: t.providerLabel,
    effort: t.effort,
    vendor: t.vendor,
    streaming: !!t.caps?.streaming,
    backup: !!extra.backup,
  };
}

/**
 * One run of an engine. Output (words after the first, tools) is yielded as it comes; steps go to the live view.
 * The first words wait until the next event (at most FIRST_WORDS_HOLD_MS): an engine explaining a failure says so in
 * words before its error or done, and those must not reach the person if the turn is retried or answered by the
 * backup. Returns { kind: ok|failed|aborted|budget, failure, tail (events still to send), done, sawOutput, costUsd }.
 */
async function* runAttempt(ctx, a) {
  const { opts, store } = ctx;
  const { target } = a;
  const res = { kind: null, failure: null, tail: [], done: null, sawOutput: false, costUsd: null, costExact: false };
  const ctl = new AbortController();
  follow(ctx.stopper.signal, ctl);
  const hold = [];
  const meter = { totals: null, reported: null, exact: false };
  const startedAt = Date.now();
  let sessionRaw = null;
  let grant = null;
  let iter = null;
  let finished = false;
  let budget = null;

  const release = function* () { while (hold.length) { const e = hold.shift(); yield e.type === "error" ? withoutRecoverable(e) : e; } };
  const onSession = (value) => {
    const rawId = rawOf(value);
    if (!rawId) return;
    sessionRaw = rawId;
    ctx.state.sessionRaw = rawId;
    let handle;
    try { handle = formatHandle(target, rawId); } catch (err) { console.warn(`[turn] session ${clip(rawId, 40)} can't be stored: ${err.message}`); return; }
    try { opts.onSessionId?.(handle); } catch (err) { console.warn(`[turn] storing the session failed: ${err?.message || err}`); }
  };

  // The turn's dollar ceiling: the caller's, else the background one for unattended work (none for an interactive turn).
  const ceiling = Number(opts.maxBudgetUsd) > 0 ? Number(opts.maxBudgetUsd) : (opts.background ? BACKGROUND_DEFAULTS.MAX_BUDGET_USD : null);

  try {
    const engine = await loadEngine(target.engine);
    if (target.engine === "codex") {
      try {
        grant = await deps.grantMcp({ ...(opts.toolCtx || {}), turnId: ctx.turnId, provider: target.provider }, { turnId: ctx.turnId, signal: ctl.signal });
      } catch (err) {
        throw new Error(`Tarsee's tools couldn't be opened for this turn: ${err?.message || err}`);
      }
    }
    const systemParts = opts.systemParts && typeof opts.systemParts === "object"
      ? { stable: String(opts.systemParts.stable ?? ""), volatile: String(opts.systemParts.volatile ?? "") }
      : { stable: String(opts.systemPrompt ?? ""), volatile: "" };
    const native = !!target.caps?.nativeBudget;
    iter = engine.run({
      target: { ...target, caps: { ...target.caps } },
      model: target.model,
      effort: target.effort || undefined,
      messages: a.messages,
      systemPrompt: typeof opts.systemPrompt === "string" && !opts.systemParts ? opts.systemPrompt : systemParts.stable + systemParts.volatile,
      systemParts,
      media: a.media,
      signal: ctl.signal,
      toolCtx: opts.toolCtx,
      sessionHandle: a.handle,
      sessionId: a.raw,
      onSessionHandle: onSession,
      onSessionId: onSession,
      maxTurns: opts.maxTurns ?? (opts.background ? BACKGROUND_DEFAULTS.MAX_TURNS : INTERACTIVE_MAX_TURNS),
      maxBudgetUsd: native && ceiling ? ceiling : undefined,
      thinkingSummaries: !!opts.thinkingSummaries && !!target.caps?.thinkingSummaries,
      queuedNote: false,
      turnId: ctx.turnId,
      // Tarsee's tools over loopback MCP, for Codex (providers/codex-options.js reads it as ctx.mcp).
      mcp: grant ? { url: grant.url, token: grant.token } : undefined,
      mcpGrant: grant ? { url: grant.url, token: grant.token } : undefined,
      liveSource: opts.liveSource,
      background: !!opts.background,
      // The folder the agent works in, when the caller has its own (Verify's scratch folder); else the workspace.
      cwd: typeof opts.cwd === "string" && opts.cwd ? opts.cwd : undefined,
    })[Symbol.asyncIterator]();

    let next = iter.next();
    for (;;) {
      let r;
      if (hold.length && !res.failure && !res.sawOutput) {
        r = await raceTimeout(next, FIRST_WORDS_HOLD_MS);
        if (r === TIMED_OUT) { res.sawOutput = true; yield* release(); continue; }
      } else {
        r = await next;
      }
      if (r.done) { finished = true; break; }
      const evt = r.value;
      if (!evt || typeof evt !== "object") { next = iter.next(); continue; }

      if (evt.type === "done") { res.done = { ...evt }; break; }
      if (evt.type === "step") {
        if (evt.kind === "usage") meter.totals = usageFromStep(evt);
        yield evt;
      } else if (evt.type === "usage") {
        meter.totals = normalizeUsage(evt.usage);
        const reported = evt.costUsd ?? evt.usage?.cost_usd ?? evt.usage?.cost;
        if (reported != null && Number.isFinite(Number(reported))) {
          meter.reported = Number(reported);
          meter.exact = evt.costExact === true;
        }
        if (res.sawOutput) yield evt; else hold.push(evt);
      } else if (evt.type === "text") {
        if (res.sawOutput) yield evt;
        else if (res.failure || !hold.some((e) => e.type === "text")) hold.push(evt);
        else { res.sawOutput = true; yield* release(); yield evt; }
      } else if (evt.type === "tool_use" || evt.type === "tool_result") {
        if (res.failure && !res.sawOutput) hold.push(evt);
        else { res.sawOutput = true; yield* release(); yield evt; }
      } else if (evt.type === "error") {
        if (res.sawOutput) { res.failure ||= evt; yield withoutRecoverable(evt); }
        else { res.failure ||= evt; hold.push(evt); }
      } else if (evt.type === "thinking") {
        if (res.failure && !res.sawOutput) hold.push(evt);
        else {
          if (hold.some((e) => e.type === "text")) res.sawOutput = true;
          yield* release();
          yield evt;
        }
      } else if (res.sawOutput || !hold.length) {
        yield evt;
      } else {
        hold.push(evt);
      }

      // The spend ceiling mid-turn, for an AI whose engine keeps none of its own (design 4.6 h). Only running totals an
      // engine reports while it works can stop it: Codex reports usage once, at turn.completed (its usage event and
      // step both come with the finished reply), and a Claude Code result's usage comes with the finished reply too;
      // both are checked after the turn instead (below), which warns and never fails what already happened.
      if (evt.type === "step" && evt.kind === "usage" && target.engine !== "codex" && !target.caps?.nativeBudget && ceiling) {
        budget = await budgetCheck(ctx, target, meter, ceiling);
        if (budget?.tripped) break;
      }
      next = iter.next();
    }
  } catch (err) {
    if (ctl.signal.aborted && !budget?.tripped) {
      res.done = { type: "done", stopReason: ABORTED };
    } else {
      console.error(`[turn] the ${target.engine || "AI"} engine failed:`, err);
      res.failure ||= { type: "error", message: err?.message || String(err) };
      if (!res.failure.message) res.failure.message = "The AI engine failed.";
      if (!hold.includes(res.failure)) hold.push(res.failure);
      res.done = { type: "done", stopReason: "error" };
    }
  } finally {
    if (iter && !finished) {
      if (!res.done || budget?.tripped) ctl.abort();
      try { await iter.return?.(); } catch { /* an engine closing up badly changes nothing now */ }
    }
    try { await grant?.revoke?.(); } catch (err) { console.warn(`[turn] revoking the MCP grant failed: ${err?.message || err}`); }
  }

  res.costUsd = meter.reported ?? (meter.totals ? costOf(target, meter.totals, store) : null);
  res.costExact = meter.reported != null && meter.exact;
  // An Anthropic key's cost comes only with the engine's result. A turn stopped, timed out or crashed before that was
  // still billed for every call so far: its running totals at the list price, an estimate (never labelled exact).
  if (res.costUsd == null && meter.totals && costSource(target.provider, store) === "exact") res.costUsd = anthropicListCost(target.model, meter.totals);

  if (budget?.tripped) {
    res.kind = "budget";
    res.tail = [...release(), {
      type: "error",
      subtype: "error_max_budget_usd",
      message: budget.message || `Stopped after reaching this task's spending limit of ${usd(ceiling)}.`,
      recoverable: false,
    }];
    res.done = { type: "done", stopReason: "error_max_budget_usd" };
    recordUsage(ctx, target, meter, sessionRaw, startedAt, res);
    return res;
  }

  if (!res.done) {
    if (ctl.signal.aborted) res.done = { type: "done", stopReason: ABORTED };
    else {
      // The engine ended without a done: one is made, with the error before it (unless the engine gave one).
      res.done = { type: "done", stopReason: "error" };
      if (!res.failure) {
        res.failure = { type: "error", message: "The AI stopped without finishing its reply. Try again.", recoverable: false };
        res.tail.push(res.failure);
      }
    }
  }
  const stopReason = res.done.stopReason || SUCCESS;
  res.done = { type: "done", ...res.done, stopReason };

  if (stopReason === ABORTED) {
    res.kind = "aborted";
  } else if (stopReason === "tool_use") {
    // Both engines run their own tool loop: a turn that ends waiting for its caller to run a tool is a fault.
    console.error(`[turn] the ${target.engine} engine ended a turn on stopReason "tool_use": engines run their own tool loop`);
    res.kind = "failed";
    res.done = { type: "done", stopReason: "error" };
    if (!res.failure) {
      res.failure = { type: "error", message: "The AI stopped halfway through using a tool. This is a fault in Tarsee, not in your message; try again.", subtype: "tool_use", recoverable: false };
      res.tail.push(res.failure);
    }
  } else if (stopReason !== SUCCESS || res.failure) {
    res.kind = "failed";
    if (!res.failure) {
      // An engine that ended badly without saying why: its own words (if any) stay, and the error says it plainly.
      res.failure = { type: "error", message: failureMessage(target, stopReason), subtype: stopReason, recoverable: false };
      res.tail.push(res.failure);
    }
  } else {
    res.kind = "ok";
    // The ceiling after the turn (design 4.6 h: "a post-turn check marks the job over budget and warns"). The work
    // is done and its reply stands; the owner is told, on the live timeline and in the log.
    if (ceiling && !target.caps?.nativeBudget) {
      const after = await budgetCheck(ctx, target, meter, ceiling);
      if (after?.tripped) {
        const text = `This task went over its spending limit of ${usd(ceiling)}${after.spentUsd != null ? ` (about ${usd(after.spentUsd)})` : ""}; it had already finished.`;
        console.warn(`[turn] ${target.provider}:${target.model || "default"} finished over its spending limit: ${text}`);
        res.tail.push({ type: "step", kind: "status", text });
        ctx.state.overBudget = true;
        // Steps reach only the live timeline: the done tells the caller (a cron's run, its push, its chat post).
        res.done = { ...res.done, overBudget: true, ceilingUsd: ceiling, ...(after.spentUsd != null ? { spentUsd: after.spentUsd } : {}) };
      }
    }
  }
  if (res.failure) res.failure.code = codeOf(res.failure, stopReason);
  res.tail = [...release(), ...res.tail];
  recordUsage(ctx, target, meter, sessionRaw, startedAt, res);
  return res;
}

/** The turn's spend so far against its ceiling (spend.js checkTurnBudget): {tripped, spentUsd, message} or null. */
async function budgetCheck(ctx, target, meter, ceiling) {
  try {
    const r = await deps.checkTurnBudget({
      providerId: target.provider,
      model: target.model,
      usage: meter.totals,
      costUsd: meter.reported ?? undefined,
      maxBudgetUsd: ceiling,
      background: !!ctx.opts.background,
      caps: target.caps,
      store: ctx.store,
      at: Date.now(),
    });
    return r && typeof r === "object" ? { tripped: !!r.tripped, spentUsd: r.spentUsd ?? null, message: r.message || null } : null;
  } catch (err) {
    console.warn(`[turn] the spend ceiling check failed: ${err?.message || err}`);
    return null;
  }
}

/**
 * Codex writes no Claude transcript, so its usage goes into the usage index directly (design 4.13). A turn with no
 * chat of its own (a subagent, an ACP session) is filed under one named for its turn: the index needs a conversation,
 * and unrecorded spend would slip past this month's spending cap.
 */
function recordUsage(ctx, target, meter, sessionRaw, startedAt, res) {
  if (target.engine !== "codex" || !meter.totals) return;
  const u = meter.totals;
  const row = {
    id: `codex:${sessionRaw || "no-thread"}:${ctx.turnId}`,
    sessionId: sessionRaw,
    conversationId: ctx.opts.toolCtx?.conversationId || ctx.liveConv || `${ctx.opts.liveSource || "turn"}:${ctx.turnId}`,
    turnId: ctx.turnId,
    provider: target.provider,
    engine: target.engine,
    model: target.model,
    effort: target.effort,
    startedAt,
    endedAt: Date.now(),
    input: u.input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    output: u.output_tokens || 0,
    costUsd: meter.reported ?? null,
  };
  Promise.resolve()
    .then(() => deps.recordUsage(row, ctx.db))
    .catch((err) => console.warn(`[turn] recording this turn's usage failed: ${err?.message || err}`));
}

/** The backup model's Target, when ai.backupModel is set, differs from the one that failed and can take a turn. */
async function backupTarget(ctx, failed) {
  const raw = readStr(ctx.store, "ai.backupModel");
  if (!raw) return null;
  const ref = parseModelRef(raw);
  const providerId = ref.provider || failed.provider;
  if (!getProvider(providerId)) return null;
  await ensureModelList(getProvider(providerId).id, ref.model ?? null, ctx.store);
  let t;
  try { t = targetFor(providerId, ref.model, failed.effort, ctx.store); } catch { return null; }
  if (t.provider === failed.provider && t.model === failed.model) return null;
  const why = await refusalFor(t, ctx);
  if (why) {
    console.warn(`[turn] the backup model (${raw}) can't answer: ${why.message}`);
    return null;
  }
  return t;
}

/**
 * The failure flag a provider's card and the header chip read (provider-status.js): set on a sign-in or credit
 * failure, cleared by a success, under both of the provider's names (the Claude plan's is stored as claude-code).
 */
function writeFailureFlag(store, target, res) {
  if (!store || !target) return;
  const key = failureFlagKey(target.provider);
  try {
    if (res.kind === "ok") {
      if (failureFlag(store, target.provider)) clearFailureFlag(store, target.provider);
      return;
    }
    if (res.kind !== "failed") return;
    // (provider-status.js reads these: a plan's "sign-in-expired", a key provider's "auth" as a rejected key.)
    const code = res.failure?.code;
    let flagState = null;
    if (code === "auth") flagState = target.kind === "subscription" ? "sign-in-expired" : "auth";
    else if (code === "billing") flagState = "out-of-credit";
    if (!flagState) return;
    store.set(key, { state: flagState, at: new Date().toISOString(), detail: redactSecrets(clip(res.failure?.message || "", 300)) });
  } catch (err) {
    console.warn(`[turn] the failure flag for ${target.provider} couldn't be written: ${err?.message || err}`);
  }
}

// --- Helpers -----------------------------------------------------------------------------------------------------

function storeOf(opts) {
  const ctx = opts?.toolCtx;
  if (ctx?.settingsStore) return ctx.settingsStore;
  if (ctx?.db) {
    try { return new SettingsStore(ctx.db); } catch { return null; }
  }
  return null;
}

function follow(signal, controller) {
  if (!signal) return;
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
}

function readStr(store, key) {
  try {
    const v = store?.get?.(key);
    if (v == null) return null;
    const s = String(v).trim();
    return s || null;
  } catch {
    return null;
  }
}

function readNum(store, key, fallback) {
  try {
    const v = store?.get?.(key);
    if (v == null || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/** The chat's messages to hand over: its stored ones (with their times), else the caller's; the prompt left out. */
function handoffHistory(ctx) {
  const conv = ctx.opts.toolCtx?.conversationId;
  let rows = null;
  if (conv && ctx.db) {
    try {
      rows = ctx.db.prepare("SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
        .all(conv, HANDOFF_ROWS).reverse();
    } catch { rows = null; }
  }
  const list = rows?.length ? rows : (Array.isArray(ctx.opts.messages) ? ctx.opts.messages : []);
  // The turn's own prompt is last, and anything sent after it waits its own turn: the trailing user messages go.
  let end = list.length;
  while (end > 0 && list[end - 1]?.role === "user") end--;
  return list.slice(0, end);
}

/** The prompt with the handoff and the queued note in front of its words (a slash command gets neither). */
function prefixPrompt(content, handoffText, queued) {
  const lead = (text) => {
    if (text.trimStart().startsWith("/")) return text;
    let out = queued ? withQueuedNote(text) : text;
    if (handoffText) out = `${handoffText}\n\n${out}`;
    return out;
  };
  if (typeof content === "string") return lead(content);
  if (Array.isArray(content)) {
    const i = content.findIndex((b) => b?.type === "text");
    if (i < 0) return handoffText ? [...content, { type: "text", text: handoffText }] : content;
    const copy = content.slice();
    copy[i] = { ...copy[i], text: lead(String(copy[i].text ?? "")) };
    return copy;
  }
  return content;
}

async function adaptFor(content, target, ctx) {
  if (!Array.isArray(content) || !content.some(isMediaBlock)) return content;
  try {
    const out = await deps.adaptMedia(content, target.caps, {
      conversationId: ctx.opts.toolCtx?.conversationId || null,
      messageId: ctx.opts.toolCtx?.messageId || null,
      via: ctx.opts.liveSource || "",
      settingsStore: ctx.store,
      label: target.label,
    });
    if (typeof out === "string" || Array.isArray(out)) return out;
    if (out && (typeof out.content === "string" || Array.isArray(out.content))) return out.content;
    return content;
  } catch (err) {
    console.warn(`[turn] adapting the prompt's media failed: ${err?.message || err}`);
    return content;
  }
}

function isMediaBlock(b) {
  return !!b && typeof b === "object" && (b.type === "image" || b.type === "document" || b.type === "audio");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
}

function findLastIndex(list, fn) {
  for (let i = list.length - 1; i >= 0; i--) if (fn(list[i])) return i;
  return -1;
}

/** A raw session id from what an engine reports: a raw id, or a handle it tagged itself. */
function rawOf(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const parsed = parseHandle(s);
  return parsed?.tagged ? parsed.rawId : s;
}

function withoutRecoverable(evt) {
  if (!evt?.recoverable) return evt;
  const { recoverable: _r, ...rest } = evt;
  return rest;
}

function codeOf(evt, stopReason) {
  const raw = String(evt?.code || "").trim().toLowerCase();
  const c = CODE_ALIASES[raw] || raw;
  if (BACKUP_CODES.has(c)) return c;
  const sub = String(evt?.subtype || "").trim().toLowerCase();
  if (BACKUP_CODES.has(CODE_ALIASES[sub] || sub)) return CODE_ALIASES[sub] || sub;
  if (stopReason === "auth-expired") return "auth";
  return c || null;
}

function reasonWords(target, code) {
  if (code === "auth") return target.kind === "subscription" ? "sign-in expired" : "key rejected";
  if (code === "billing") return "out of credit";
  if (code === "rate") return "busy";
  if (code === "model") return "model not available";
  return "not answering";
}

function failureMessage(target, stopReason) {
  const p = getProvider(target.provider);
  if (stopReason === "auth-expired") {
    if (p?.kind === "subscription") return `${p.errorHints?.auth || `The ${target.providerLabel} sign-in has expired.`} Settings > AI shows how to sign in again.`;
    return p?.errorHints?.auth || `The ${target.providerLabel} key was turned down. Fix it in Settings > AI.`;
  }
  if (stopReason === "max_turns" || stopReason === "error_max_turns") return "Stopped after hitting the turn limit. The task needs to be broken into smaller steps.";
  if (stopReason === "budget" || stopReason === "error_max_budget_usd") return "Stopped after hitting the spend ceiling for this task.";
  return `${target.label || target.providerLabel} stopped with an error. Try again.`;
}

function usageFromStep(s) {
  return {
    input_tokens: Number(s.input) || 0,
    output_tokens: Number(s.output) || 0,
    cache_read_input_tokens: Number(s.cacheRead) || 0,
    cache_creation_input_tokens: Number(s.cacheWrite) || 0,
  };
}

function normalizeUsage(u) {
  return {
    input_tokens: Number(u?.input_tokens) || 0,
    output_tokens: Number(u?.output_tokens) || 0,
    cache_read_input_tokens: Number(u?.cache_read_input_tokens) || 0,
    cache_creation_input_tokens: Number(u?.cache_creation_input_tokens) || 0,
  };
}

/** What a turn's usage cost at the price table (spend.js); null where nothing is billed per token (a plan, the Anthropic key's exact figure). */
function costOf(target, usage, store) {
  try {
    const usd = deps.priceUsage(target.provider, target.model, usage, Date.now(), store);
    return Number.isFinite(usd) ? usd : null;
  } catch {
    return null;
  }
}

const TIMED_OUT = Symbol("timed out");
function raceTimeout(promise, ms) {
  let timer;
  const t = new Promise((r) => { timer = setTimeout(() => r(TIMED_OUT), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

function clip(s, n) {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function usd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "$?";
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}
