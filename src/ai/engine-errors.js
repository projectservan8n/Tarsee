/**
 * engine-errors.js: what an engine's failure means, per provider, in words the owner can act on (design 4.7 "Errors").
 *
 * An engine reports a failure as an HTTP status, an error code (the Agent SDK's assistant `error`, a Codex error code,
 * or one of Tarsee's own refusal codes from engine-env.js) and/or the engine's own words. The same 401 means "Claude's
 * sign-in ran out" on the Claude plan and "your DeepSeek key was rejected" on DeepSeek, so the meaning depends on the
 * provider. classifyEngineError() answers:
 *
 *   { kind, provider, engine, status, code, recoverable, state, message }
 *
 *   kind        one of ERROR_KINDS:
 *                 expired      a plan's sign-in ran out (Claude plan, ChatGPT plan)
 *                 auth         a key was turned down (401, or a 403 that isn't one of the two below)
 *                 wrong-key    a key pasted in another provider's slot
 *                 billing      out of credit or over a spending limit (402, or OpenRouter's 403 for a key over its limit)
 *                 rate         busy, or a plan's usage limit (429)
 *                 unavailable  the provider is down or overloaded (5xx, 529)
 *                 model        the model doesn't exist there, or the account can't use it (404, 400 about a model)
 *                 context      the chat no longer fits in the model's context (llama-server's exceed_context_size_error,
 *                              "request (N tokens) exceeds the available context size", LM Studio's and Codex's own
 *                              words): never read as a "model" failure, whatever else the words name
 *                 session      resuming the stored session failed (start fresh and carry the chat over)
 *                 moderated    the provider's moderation turned the message down (OpenRouter's 403 "requires
 *                              moderation ... flagged for ..."): the key is fine, no flag, no retry, no backup
 *                 credential-isolation, needs-key, needs-setup, bad-model, wrong-engine, needs-mcp-token
 *                              Tarsee's own refusals before a turn starts (engine-env.js CredentialError codes)
 *                 unknown      anything else
 *   recoverable true only for a failed session resume: the turn layer retries once with a fresh session
 *   state       the provider's failure flag to write (ai.<id>.status, provider-status.js), or null for none
 *   message     the plain-language explanation for the chat
 *
 * Pure: no I/O. The words come from the provider registry (labels, errorHints, top-up links).
 */
import { getProvider, normalizeProviderId } from "./provider-registry.js";

export const ERROR_KINDS = Object.freeze([
  "expired", "auth", "wrong-key", "billing", "rate", "unavailable", "model", "context", "session", "moderated",
  "credential-isolation", "needs-key", "needs-setup", "bad-model", "wrong-engine", "needs-mcp-token", "unknown",
]);

/** Tarsee's own refusal codes (engine-env.js CredentialError), passed through as their own kind. */
const REFUSAL_CODES = new Set(["credential-isolation", "needs-key", "needs-setup", "bad-model", "wrong-engine", "needs-mcp-token"]);

/** The Claude plan's sign-in ran out: what to do instead. (Also re-exported by providers/claude-code.js.) */
export const AUTH_EXPIRED_MESSAGE = "**Claude's sign-in has expired**, so I can't reach the model right now. This isn't a network problem, and retrying won't fix it.\n\n"
  + "Open the Terminal in the Tarsee dashboard (the `>_` button at the top), run `claude auth login` and follow the link it prints. Then send your message again.";

const CHATGPT_EXPIRED_MESSAGE = "**The ChatGPT sign-in has expired**, so I can't reach the model right now. Retrying won't fix it.\n\n"
  + "Sign in again in Settings > AI (it shows a link and a one-time code), or run `codex login --device-auth` in the Terminal. Then send your message again.";

/** The Claude CLI's and API's words for a sign-in or key that failed. */
const AUTH_WORDS_RE = /(Failed to authenticate|OAuth (?:access )?token (?:has )?expired|Re-authenticate to continue|Not logged in|Please run \/login|invalid (?:x-)?api[- ]?key|authentication[_ ]error|unauthori[sz]ed|invalid bearer|no auth credentials)/i;
// codex 0.167 says "Your access token could not be refreshed ..." or "Your authentication session could not be
// refreshed ..." for every ChatGPT sign-in it can't renew (expired, reused, revoked or replaced refresh token).
const EXPIRED_WORDS_RE = /(OAuth (?:access )?token (?:has )?expired|Re-authenticate to continue|refresh token (?:was )?(?:revoked|expired|invalid)|(?:access token|authentication session) could not be refreshed|sign-?in (?:has )?expired|token_expired)/i;
const BILLING_WORDS_RE = /(insufficient (?:balance|credits?|funds|quota)|credit balance is too low|out of credits?|payment required|billing|spend(?:ing)? limit|key limit|budget limit|exceeded your current quota)/i;
const RATE_WORDS_RE = /(rate[_ ]?limit|too many requests|request rejected \(429\)|usage limit|slow down)/i;
const UNAVAILABLE_WORDS_RE = /(overloaded|service unavailable|bad gateway|gateway timeout|internal server error|server_error|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|couldn't connect|could not reach)/i;
const MODEL_WORDS_RE = /(issue with the selected model|model[_ ]not[_ ]found|not a valid model|invalid model|unknown model|no such model|model .*(?:does not exist|not found|not available|unavailable)|does not exist or you do not have access)/i;
/**
 * A chat that no longer fits in the model's context: llama-server's 400s (exceed_context_size_error, "request (N tokens)
 * exceeds the available context size", "is larger than the max context size"), LM Studio's, a Responses server's
 * context_length_exceeded, and Codex's own words for one ("ran out of room in the model's context window").
 */
const CONTEXT_WORDS_RE = /(exceed_context_size_error|exceeds the available context size|is larger than the max context size|context_length_exceeded|greater than the context length|ran out of room in the model's context window)/i;
const SESSION_WORDS_RE =/(previous_message_id|must be the id from a prior|No conversation found with session ID|session.*(?:expired|invalid|not found|corrupt))/i;
const WORKSPACE_WORDS_RE = /workspace/i;
/** OpenRouter's 403 for a prompt its moderation flagged ("<model> requires moderation on <maker>. Your input was flagged for ..."). */
const MODERATION_WORDS_RE = /requires moderation|input was flagged/i;
/** OpenRouter's 403 for a key over the limit set on it ("Key limit exceeded (total limit)", "Budget limit exceeded (weekly limit)"). */
const KEY_LIMIT_WORDS_RE = /\b(?:key|budget|spend(?:ing)?) limit\b/i;

const ANTHROPIC_WORKSPACE_MESSAGE = "**Your Anthropic key isn't in a workspace**, so Anthropic turns it down for Tarsee. "
  + "In the Claude Console, create a new key and choose a workspace for it (Default is fine), then paste it in Settings > AI (the Anthropic guide's step 3).";

/** The SDK's assistant error codes (and Codex's), by what they mean. */
const CODE_KINDS = {
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  account_on_hold: "auth",
  verification_required: "auth",
  cloud_credential_error: "auth",
  billing_error: "billing",
  insufficient_quota: "billing",
  rate_limit: "rate",
  rate_limit_exceeded: "rate",
  usage_limit_reached: "rate",
  overloaded: "unavailable",
  server_error: "unavailable",
  model_not_found: "model",
  "bad-key": "wrong-key",
};

const PLAN_IDS = new Set(["claude", "chatgpt"]);

/** An HTTP status in the engine's words ("API Error: 402 ...", "Request rejected (429)"), or null. */
export function statusFromMessage(message) {
  const s = String(message ?? "");
  const m = /API Error:?\s*(\d{3})\b/i.exec(s) || /\((\d{3})\)/.exec(s) || /\b(?:status|HTTP)\s*:?\s*(\d{3})\b/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 400 && n <= 599 ? n : null;
}

function kindFromStatus(status, message) {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  if (status === 429) return "rate";
  if (status === 529 || (status >= 500 && status <= 599)) return "unavailable";
  if (status === 404) return "model";
  if (status === 400 && MODEL_WORDS_RE.test(message)) return "model";
  if (status === 400 && /model/i.test(message)) return "model";
  return null;
}

function kindFromWords(message) {
  if (!message) return null;
  if (SESSION_WORDS_RE.test(message)) return "session";
  if (EXPIRED_WORDS_RE.test(message)) return "expired";
  if (BILLING_WORDS_RE.test(message)) return "billing";
  if (MODEL_WORDS_RE.test(message)) return "model";
  if (AUTH_WORDS_RE.test(message)) return "auth";
  if (RATE_WORDS_RE.test(message)) return "rate";
  if (UNAVAILABLE_WORDS_RE.test(message)) return "unavailable";
  return null;
}

/** The failure flag a kind sets on the provider (provider-status.js PROVIDER_STATES), or null for none. */
export function failureStateFor(kind) {
  switch (kind) {
    case "expired": return "sign-in-expired";
    case "auth":
    case "wrong-key": return "error";
    case "billing": return "out-of-credit";
    case "needs-key": return "needs-key";
    case "needs-setup": return "needs-setup";
    default: return null;
  }
}

/** The service's own name, for sentences ("Anthropic isn't answering", not the card's "Anthropic API key"). */
const SERVICE_NAMES = { claude: "Claude", anthropic: "Anthropic", chatgpt: "ChatGPT", openai: "OpenAI" };

function labelOf(p, id) {
  return SERVICE_NAMES[id] || p?.label || id || "This AI";
}

/** The provider's own fix for a sign-in or key that failed. */
export function authMessage(providerId) {
  const id = normalizeProviderId(providerId) || String(providerId || "");
  if (id === "claude") return AUTH_EXPIRED_MESSAGE;
  if (id === "chatgpt") return CHATGPT_EXPIRED_MESSAGE;
  const p = getProvider(id);
  const hint = p?.errorHints?.auth;
  if (hint) {
    // The hint's first sentence in bold: "**Your DeepSeek key was rejected.** Update it in ..."
    const cut = hint.indexOf(". ");
    return cut > 0 ? `**${hint.slice(0, cut + 1)}** ${hint.slice(cut + 2)}` : `**${hint}**`;
  }
  return `**${labelOf(p, id)} turned down the key.** Check it in Settings > AI.`;
}

/**
 * A Local AI server with no Responses API, the one Tarsee talks to it through (Ollama before 0.13.3, LM Studio before
 * 0.3.29, llama.cpp's llama-server before b7793, a chat-completions-only server): what to do. It names b11768 for
 * llama.cpp, the first build whose tool calls Tarsee can rely on. localUrl is the address the owner set (…/v1).
 */
export function localNoResponsesMessage(localUrl) {
  const where = localUrl ? String(localUrl).trim().replace(/\/+$/, "") : "";
  return `**Your Local AI${where ? ` at ${where}` : ""} has no Responses API**: ${where ? `${where}/responses` : "its /responses address"} answered "not found". `
    + "Tarsee talks to Local AI through that API. Update Ollama to 0.13.3 or newer, LM Studio to 0.3.29 or newer or llama.cpp to b11768 or newer, or use a server that has it.";
}

/** The provider's own words for being out of credit, with its top-up link. */
function billingMessage(p, id) {
  const hints = p?.errorHints || {};
  if (id === "claude") return "**The Claude plan's usage limit is reached** for now. It resets on its own; you can check it at claude.ai/settings/usage, or switch to another AI in Settings > AI meanwhile.";
  if (id === "chatgpt") return "**The ChatGPT plan's usage limit is reached** for now. It resets on its own; you can check it at chatgpt.com/codex/settings/usage, or switch to another AI in Settings > AI meanwhile.";
  const base = hints.billing || `${labelOf(p, id)} says the account is out of credit.`;
  const link = hints.topUpUrl && !base.includes(hints.topUpUrl) ? ` (${hints.topUpUrl})` : "";
  return `**${labelOf(p, id)} is out of credit.** ${base}${link}`;
}

/**
 * The words for a kind of failure on a provider. opts.detail is the engine's own words (shown for unknown failures and
 * Tarsee's refusals), opts.model the model that failed.
 */
export function friendly(providerId, kind, { detail = null, model = null } = {}) {
  const id = normalizeProviderId(providerId) || String(providerId || "");
  const p = getProvider(id);
  const label = labelOf(p, id);
  const words = detail ? String(detail).trim() : "";
  const plan = PLAN_IDS.has(id);
  switch (kind) {
    case "expired":
    case "auth":
      return authMessage(id);
    case "wrong-key":
      return `**That key belongs somewhere else.** ${words || `It isn't ${p?.keyNoun || "a key for this AI"}.`} Paste the right key in Settings > AI.`;
    case "billing":
      return billingMessage(p, id);
    case "rate":
      return plan
        ? billingMessage(p, id)
        : `**${label} is busy right now** (too many requests). Wait a minute and send your message again.`;
    case "unavailable":
      return `**${label} isn't answering right now** (the service is down or overloaded). This usually clears up on its own: try again in a few minutes, or switch to another AI in Settings > AI.`;
    case "model":
      return `**${label} can't run ${model ? `the model ${model}` : "the chosen model"}**: it doesn't exist there, or this account can't use it. Pick another model in the chat's model menu or in Settings > AI.`;
    case "context":
      return id === "local"
        ? "**This chat no longer fits in your Local AI's memory** (its context is full). Start a new chat, or give the model more room: start llama-server with a larger -c, load the model in LM Studio with a longer context length, or raise Ollama's OLLAMA_CONTEXT_LENGTH."
        : `**This chat no longer fits in ${model ? `${model}'s` : `${label}'s`} context window.** Start a new chat, or pick a model with a bigger one.`;
    case "session":
      return "**The earlier conversation couldn't be picked up again**, so I'm starting a fresh one.";
    case "moderated": {
      const why = /flagged for ([^.\n]+)/i.exec(words);
      const reason = why ? why[1].replace(/[\\"]/g, "").trim().slice(0, 80) : "";
      return `**${label}'s moderation turned this message down**${reason ? ` (flagged for ${reason})` : ""}. Nothing is wrong with the key. Rephrase the message, or pick a model ${label} doesn't moderate (another maker's) in the chat's model menu.`;
    }
    case "credential-isolation":
    case "needs-key":
    case "needs-setup":
    case "bad-model":
    case "wrong-engine":
    case "needs-mcp-token":
      return words || `**${label} can't start this turn.** Check it in Settings > AI.`;
    default:
      return words ? `**${label} ran into a problem:** ${words}` : `**${label} ran into a problem** it didn't explain. Try again, or check the server logs.`;
  }
}

/**
 * What an engine failure means on a provider. input: {status, code, message, model}. The first clear signal wins, in
 * this order: Tarsee's refusal codes, a moderation refusal, a failed session resume, an expired plan sign-in in the
 * words, the HTTP status (given or read from the words), the SDK's error code, the words.
 */
export function classifyEngineError(providerId, engine, { status = null, code = null, message = null, model = null } = {}) {
  const id = normalizeProviderId(providerId) || (providerId == null ? null : String(providerId));
  const text = message == null ? "" : String(message);
  const st = Number.isInteger(Number(status)) && Number(status) >= 400 ? Number(status) : statusFromMessage(text);
  const c = code == null ? null : String(code);

  let kind = null;
  if (c && REFUSAL_CODES.has(c)) kind = c;
  // Before the status: llama-server's 400 for a full context is no "model" failure, whatever else its words name.
  else if (CONTEXT_WORDS_RE.test(text)) kind = "context";
  // A 403 is not always the key: OpenRouter answers 403 for a prompt its moderation flagged. Its body quotes the
  // person's own words (metadata.flagged_input), so this comes before anything else reads them.
  else if (st === 403 && MODERATION_WORDS_RE.test(text)) kind = "moderated";
  else if (SESSION_WORDS_RE.test(text)) kind = "session";
  else if (EXPIRED_WORDS_RE.test(text)) kind = "expired";
  if (!kind && c && CODE_KINDS[c]) kind = CODE_KINDS[c];
  if (!kind || kind === "auth" || kind === "rate") {
    // A status is more exact than a broad code (the SDK calls a 402 "unknown"), except for an auth code with no status.
    const byStatus = st ? kindFromStatus(st, text) : null;
    if (byStatus && !(kind && !st)) kind = byStatus;
  }
  if (!kind) kind = kindFromWords(text) || "unknown";
  // OpenRouter's 403 for a key over the limit set on it: raise the limit, the key itself is fine.
  if (kind === "auth" && st === 403 && KEY_LIMIT_WORDS_RE.test(text)) kind = "billing";

  // On a plan, a turned-down sign-in is the sign-in running out; on a key provider an "expired" is its key failing.
  if (kind === "auth" && PLAN_IDS.has(id)) kind = "expired";
  if (kind === "expired" && id && !PLAN_IDS.has(id) && getProvider(id)) kind = "auth";

  // An Anthropic key made outside a workspace needs a workspace header on every request, which Tarsee never sends:
  // the fix is a key made in a workspace (the guide's step 3), not a new copy of the same key.
  const noWorkspace = id === "anthropic" && (st === 400 || st === 401 || st === 403 || kind === "auth") && WORKSPACE_WORDS_RE.test(text);
  if (noWorkspace) kind = "auth";

  const detail = REFUSAL_CODES.has(kind) || kind === "unknown" || kind === "wrong-key" || kind === "moderated" ? text : null;
  return {
    kind,
    provider: id,
    engine: engine || null,
    status: st,
    code: c,
    recoverable: kind === "session",
    state: failureStateFor(kind),
    message: noWorkspace ? ANTHROPIC_WORKSPACE_MESSAGE : friendly(id, kind, { detail, model }),
  };
}
