import { chatStream } from "../ai/router.js";
import { formatModelRef, parseModelRef } from "../ai/model-ref.js";
import { activeProviderId, getProvider, isShipped, keysOnly } from "../ai/provider-registry.js";
import { providerStatus } from "../ai/provider-status.js";
import { ensureLocalModels } from "../ai/provider-models.js";
import { BACKGROUND_DEFAULTS, resolveModelAlias } from "../config/constants.js";
import { checkModel } from "./model-catalog.js";

/**
 * One place to run an unattended AI turn.
 *
 * Cron jobs, the heartbeat and the boot checklist each had their own copy of
 * "open a stream, concatenate text events, break on done". Each copy got the
 * cost and failure handling slightly wrong, and in the same direction:
 *
 *   - The cheap-model floor was documented but never applied, so every
 *     scheduled reminder ran on the top-tier model.
 *   - `error` events were logged and then treated as success, so an auth
 *     failure was delivered to the user as an empty but "successful" job.
 *   - The timeout aborted a controller the provider ignored, so a wedged turn
 *     kept running after the job had given up on it.
 *   - Nothing capped turns or spend.
 *
 * Fixing that once here is the point of this module. Callers describe the work;
 * the ceilings are applied consistently and the outcome is honest.
 *
 * The turn runs on the default AI (whatever the owner chose: the Claude plan,
 * DeepSeek, OpenAI...) through the turn layer (ai/turn.js), as every channel's
 * turn does. With no model of its own it runs on that AI's background model
 * (ai.<id>.backgroundModel, else its cheapest tier).
 */

/** Outcome of a background turn. Exactly one of `text` / `error` is meaningful. */
/**
 * @typedef {object} BackgroundTurnResult
 * @property {string} text - concatenated assistant text (may be empty)
 * @property {string|null} error - human-readable failure, or null on success
 * @property {boolean} timedOut - true if the wall-clock timeout fired
 * @property {string|null} model - the model actually used
 * @property {string|null} provider - the AI that ran it (claude, deepseek, ...)
 * @property {string|null} stopReason - how the turn ended (end_turn, auth-expired, spend-cap, error_max_budget_usd, ...)
 * @property {object|null} usage - token usage as reported by the engine
 * @property {number|null} costUsd - what the turn cost, when the engine reported it
 * @property {{ceilingUsd: number, spentUsd: number|null}|null} overBudget - a finished turn whose cost, known only at
 *   its end (a Codex AI's), went over its spending limit: the reply stands (no error, so it isn't run again), and
 *   the caller says so (overBudgetWarning)
 */

/**
 * The words for a job that finished over its spending limit ({ceilingUsd, spentUsd} from runBackgroundTurn), or null.
 * A cron job's post, push and status, the heartbeat's last result and the boot log all say it the same way.
 */
export function overBudgetWarning(overBudget) {
  if (!overBudget) return null;
  const usd = (n) => `$${Number(n).toFixed(2)}`;
  const spent = Number.isFinite(overBudget.spentUsd) ? ` (about ${usd(overBudget.spentUsd)})` : "";
  return `Finished over its spending limit of ${usd(overBudget.ceilingUsd)}${spent}.`;
}

/**
 * How a turn that ended without a success reads in the job's history, when the
 * turn layer gave no words of its own (it always sends an error first; this is
 * the belt to that brace).
 */
const STOP_WORDS = {
  aborted: "Stopped before it finished",
  "auth-expired": "The AI's sign-in has expired or its key was turned down",
  "not-ready": "The AI isn't set up: open Settings > AI",
  "blocked-keys-only": "\"API keys only\" is on, so the default AI can't be used",
  "needs-verification": "The chosen model must be verified first in Settings > AI",
  "spend-cap": "This month's AI spending cap is reached",
  error_max_budget_usd: "Stopped at this task's spending limit",
  budget: "Stopped at this task's spending limit",
  error_max_turns: "Stopped at the turn limit",
  max_turns: "Stopped at the turn limit",
};

/**
 * Resolve which model an unattended turn should use.
 *
 * The floor is a cheap tier alias, NOT the interactive default. Background work
 * is mostly "check a thing and say nothing", and paying top-tier rates for that
 * around the clock is the single largest avoidable cost in an always-on agent.
 * A caller that genuinely needs more passes `preferred` (heartbeat.model,
 * boot.model, cron.defaultModel, job.model): a tier word (haiku, sonnet, opus),
 * a model of the default AI, or a model ref naming its AI
 * ("deepseek:deepseek-v4-pro", kept as it is).
 *
 * With the settings store, a choice is checked against the default AI
 * (lib/model-catalog.js checkModel, the rule the composer's menu and /model
 * follow) and handed on as a ref naming that AI, so the turn layer runs it as
 * given: "gpt-6.1-sol" on the OpenAI key, "sonnet" on the Claude plan,
 * "opus" on DeepSeek (its own top tier). A name the default AI doesn't offer,
 * or a model it must verify first, is logged and the floor runs instead: a typo
 * never moves unattended work up to the interactive model. The floor itself
 * stays the floor word, so the default AI's own background model answers
 * (ai.<id>.backgroundModel; runBackgroundTurn passes no model for it).
 *
 * @param {string|null} preferred - explicit model/tier, or null for the floor
 * @param {string|null} floor - override the default cheap floor
 * @param {object|null} store - the settings store (the default AI and its models)
 * @returns {string} a model id, tier alias or model ref
 */
export function resolveBackgroundModel(preferred, floor = null, store = null) {
  const pick = [preferred, floor].map((v) => (v == null ? "" : String(v).trim())).find(Boolean) || "";
  if (!pick || pick.toLowerCase() === BACKGROUND_DEFAULTS.MODEL) return BACKGROUND_DEFAULTS.MODEL;
  if (parseModelRef(pick).provider) return pick;
  let refused = null;
  if (store) {
    const id = activeProviderId(store);
    let r;
    try { r = checkModel(id, pick, store); } catch (err) { r = { ok: false, error: err?.message || String(err) }; }
    if (r.ok && r.model) return formatModelRef(id, r.model);
    if (!r.ok) refused = r;
  }
  // Claude's own names (a pinned id, "opus-4-6"): as before. Never for a model the default AI must verify first.
  const claude = refused?.verify ? null : resolveModelAlias(pick);
  if (claude) return claude;
  const why = refused?.error ? ` (${refused.error})` : "";
  console.warn(`[background] "${pick}" isn't a model the default AI offers${why}; using its background model instead`);
  return BACKGROUND_DEFAULTS.MODEL;
}

/** Provider states that mean a turn can't start (the turn layer's own list, ai/turn.js NOT_READY_STATES). */
const NOT_READY_STATES = new Set(["needs-key", "needs-sign-in", "needs-setup", "error"]);

/**
 * Whether the default AI can take a turn now, for the callers that would rather skip quietly than fail every time
 * (the heartbeat, every 30 minutes; the boot checklist): { ready, provider, label, reason }. The checks the turn
 * layer makes before a turn: switched on in this version, not blocked by "API keys only", set up (a key, a sign-in,
 * Local AI's address). The default is the registry's (activeProviderId: the setting, then TARSEE_AI_PROVIDER, then
 * the Claude plan), so an install set up only through Railway variables counts too. The engines' failure flags don't
 * count, as in the turn layer: a turn says so itself if the problem is still there.
 */
export async function defaultAiReadiness(store) {
  const id = activeProviderId(store);
  const p = getProvider(id);
  const not = (reason) => ({ ready: false, provider: p.id, label: p.label, reason });
  if (!isShipped(p.id)) return not(`This Tarsee can't use the ${p.label}. Choose another AI in Settings > AI.`);
  if (p.kind === "subscription" && keysOnly(store)) {
    return not(`"API keys only" is switched on, so Tarsee won't use your ${p.label}. Choose an AI that uses an API key in Settings > AI.`);
  }
  let s;
  try {
    s = await providerStatus(p.id, { store, ignoreFlags: true });
    // Local AI with an address and no model named counts as "not set up" until its models are read, and they live
    // only in memory: read them once (ensureLocalModels never throws) and ask again.
    if (p.id === "local" && s?.state === "needs-setup") {
      await ensureLocalModels(store);
      s = await providerStatus(p.id, { store, ignoreFlags: true });
    }
  } catch (err) {
    return not(`Tarsee couldn't check the ${p.label}: ${err?.message || err}`);
  }
  if (s && NOT_READY_STATES.has(s.state)) {
    return not([s.detail, s.fix].filter(Boolean).join(" ") || `The ${p.label} isn't set up yet. Open Settings > AI.`);
  }
  return { ready: true, provider: p.id, label: p.label, reason: null };
}

/**
 * Run a single unattended AI turn with cost and time ceilings.
 *
 * @param {object} opts
 * @param {string} opts.label - short id for logs, e.g. "cron:daily-standup"
 * @param {Array} opts.messages - conversation messages
 * @param {{stable: string, volatile: string}} [opts.systemParts] - the prompt in its two parts (buildSystemPromptParts):
 *   Codex keeps the stable part as its instructions and gets the volatile part with the message
 * @param {string} [opts.systemPrompt] - the prompt as one string, for a caller that has no parts
 * @param {object} opts.toolCtx - tool execution context
 * @param {string} [opts.model] - a model, tier or ref; the cheap floor (or none) means the default AI's background model
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTurns]
 * @param {number} [opts.maxBudgetUsd]
 * @param {AbortSignal} [opts.signal] - caller's own cancellation, if any
 * @param {string} [opts.liveId] - where the dashboard's live timeline shows
 *   this run ("cron:<id>", "heartbeat", "boot"); background work has no
 *   conversation of its own
 * @param {string} [opts.liveSource] - the kind of job, for its label
 * @returns {Promise<BackgroundTurnResult>}
 */
export async function runBackgroundTurn({
  label,
  messages,
  systemParts,
  systemPrompt,
  toolCtx,
  model,
  timeoutMs = BACKGROUND_DEFAULTS.TIMEOUT_MS,
  maxTurns = BACKGROUND_DEFAULTS.MAX_TURNS,
  maxBudgetUsd = BACKGROUND_DEFAULTS.MAX_BUDGET_USD,
  signal,
  liveId,
  liveSource,
}) {
  // The cheap floor is not a choice: the default AI's own background model answers (the turn layer picks it).
  const chosen = model && model !== resolveBackgroundModel(null) ? model : undefined;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Honour a caller's own signal too (job disabled, server shutting down).
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let text = "";
  let error = null;
  let usage = null;
  let costUsd = null;
  let stopReason = null;
  let overBudget = null;
  let ran = { provider: null, model: chosen || null };

  try {
    const stream = chatStream({
      messages,
      ...(systemParts ? { systemParts } : { systemPrompt }),
      toolCtx,
      model: chosen,
      background: true,
      signal: controller.signal,
      maxTurns,
      maxBudgetUsd,
      liveConversationId: liveId || undefined,
      liveSource: liveSource || undefined,
    });

    for await (const event of stream) {
      if (event.type === "route") {
        ran = { provider: event.provider || null, model: event.model || null };
      } else if (event.type === "text") {
        text += event.content;
      } else if (event.type === "usage") {
        usage = event.usage;
        if (Number.isFinite(event.costUsd)) costUsd = event.costUsd;
      } else if (event.type === "error") {
        // Record it. Previously this was logged and the job still reported
        // success, so "your API credentials expired" reached the user as a
        // blank but green cron run.
        error = event.message || "Unknown error";
      } else if (event.type === "done") {
        stopReason = event.stopReason || "end_turn";
        // A finished turn whose cost (known only at its end) passed the ceiling: the turn layer says so on the done.
        if (event.overBudget) {
          overBudget = {
            ceilingUsd: Number.isFinite(event.ceilingUsd) ? event.ceilingUsd : maxBudgetUsd,
            spentUsd: Number.isFinite(event.spentUsd) ? event.spentUsd : null,
          };
        }
        // Anything but a finished reply is a failed run: a stop (the partial
        // text is not a finished run, and must not be posted as one), an
        // expired sign-in, a refusal (not set up, API keys only, the monthly
        // spending cap), the spending limit or the turn limit.
        if (stopReason !== "end_turn" && !error) error = STOP_WORDS[stopReason] || `The AI stopped (${stopReason})`;
        break;
      }
    }
  } catch (err) {
    error = err?.name === "AbortError" ? null : (err?.message || String(err));
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    error = `Timed out after ${Math.round(timeoutMs / 1000)}s`;
  }

  const on = [ran.provider, ran.model].filter(Boolean).join(":") || "the default AI";
  if (error) {
    console.error(`[${label}] failed on ${on}: ${error}`);
    overBudget = null;
  } else {
    console.log(`[${label}] completed on ${on} (${text.length} chars)`);
    if (overBudget) console.warn(`[${label}] ${overBudgetWarning(overBudget)}`);
  }

  return { text, error, timedOut, model: ran.model, provider: ran.provider, stopReason, usage, costUsd, overBudget };
}
