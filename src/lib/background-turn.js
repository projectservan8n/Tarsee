import { chatStream } from "../ai/router.js";
import { BACKGROUND_DEFAULTS, resolveModelAlias } from "../config/constants.js";

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
 */

/** Outcome of a background turn. Exactly one of `text` / `error` is meaningful. */
/**
 * @typedef {object} BackgroundTurnResult
 * @property {string} text - concatenated assistant text (may be empty)
 * @property {string|null} error - human-readable failure, or null on success
 * @property {boolean} timedOut - true if the wall-clock timeout fired
 * @property {string} model - the model actually used
 * @property {object|null} usage - token usage as reported by the SDK
 */

/**
 * Resolve which model an unattended turn should use.
 *
 * The floor is a cheap tier alias, NOT the interactive default. Background work
 * is mostly "check a thing and say nothing", and paying top-tier rates for that
 * around the clock is the single largest avoidable cost in an always-on agent.
 * A caller that genuinely needs more passes `preferred`.
 *
 * @param {string|null} preferred - explicit model/tier, or null for the floor
 * @param {string|null} floor - override the default cheap floor
 * @returns {string} a model id or tier alias
 */
export function resolveBackgroundModel(preferred, floor = null) {
  const pick = preferred || floor || BACKGROUND_DEFAULTS.MODEL;
  return resolveModelAlias(pick) || BACKGROUND_DEFAULTS.MODEL;
}

/**
 * Run a single unattended AI turn with cost and time ceilings.
 *
 * @param {object} opts
 * @param {string} opts.label - short id for logs, e.g. "cron:daily-standup"
 * @param {Array} opts.messages - conversation messages
 * @param {string} opts.systemPrompt
 * @param {object} opts.toolCtx - tool execution context
 * @param {string} [opts.model] - resolved model; defaults to the cheap floor
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTurns]
 * @param {number} [opts.maxBudgetUsd]
 * @param {AbortSignal} [opts.signal] - caller's own cancellation, if any
 * @returns {Promise<BackgroundTurnResult>}
 */
export async function runBackgroundTurn({
  label,
  messages,
  systemPrompt,
  toolCtx,
  model,
  timeoutMs = BACKGROUND_DEFAULTS.TIMEOUT_MS,
  maxTurns = BACKGROUND_DEFAULTS.MAX_TURNS,
  maxBudgetUsd = BACKGROUND_DEFAULTS.MAX_BUDGET_USD,
  signal,
}) {
  const chosenModel = model || resolveBackgroundModel(null);

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

  try {
    const stream = chatStream({
      messages,
      systemPrompt,
      toolCtx,
      model: chosenModel,
      signal: controller.signal,
      maxTurns,
      maxBudgetUsd,
    });

    for await (const event of stream) {
      if (event.type === "text") {
        text += event.content;
      } else if (event.type === "usage") {
        usage = event.usage;
      } else if (event.type === "error") {
        // Record it. Previously this was logged and the job still reported
        // success, so "your API credentials expired" reached the user as a
        // blank but green cron run.
        error = event.message || "Unknown error";
      } else if (event.type === "done") {
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

  if (error) {
    console.error(`[${label}] failed on ${chosenModel}: ${error}`);
  } else {
    console.log(`[${label}] completed on ${chosenModel} (${text.length} chars)`);
  }

  return { text, error, timedOut, model: chosenModel, usage };
}
