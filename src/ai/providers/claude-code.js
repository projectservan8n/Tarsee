/**
 * The Claude Code engine (design 4.7): runs one agent turn with the Claude Agent SDK's bundled Claude Code CLI, on
 * whichever of the four providers it serves:
 *
 *   claude      the Claude plan: the operator's own sign-in (`claude auth login`, or CLAUDE_CODE_OAUTH_TOKEN), today's behaviour
 *   anthropic   an Anthropic API key, in its own home (CLAUDE_CONFIG_DIR), billed per use with the exact cost
 *   deepseek    DeepSeek's Anthropic-compatible endpoint, every model pinned to DeepSeek's own ids
 *   openrouter  OpenRouter's Anthropic-compatible endpoint, anthropic/* models
 *
 * Claude Code runs its own tool loop (Read, Write, Edit, Bash, Glob, Grep and Tarsee's own tools through the in-process
 * tarsee MCP server); this module streams what it does as Tarsee events. The engine-neutral wrapper (the live timeline,
 * Stop, the chat's model and effort, the queued-message note, sessions and hand-offs) is src/ai/turn.js.
 *
 *   run(opts)                         the engine: an async generator of Tarsee events (see run() below)
 *   buildQueryOptions(provider, opts, deps)   the SDK options for a turn, pure (snapshot-tested)
 *
 * Credential isolation (design 4.5) is enforced here before and while a turn runs:
 *   R1  a key provider's home holding a sign-in file or a /login key refuses the turn (engine-env homeIsolationRefusal)
 *   R2  the environment is engine-env claudeEnvFor(): every credential stripped, then this provider's block added
 *   R4  a key provider with no key refuses the turn before anything starts
 *   R5  settingSources pinned per provider, and a settings file that would set a credential refuses the turn
 *   R6  the CLI's reported apiKeySource must be the one Tarsee set up (API_KEY_SOURCES), else the turn is stopped
 */
import { query as sdkQuery, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "../../config/env.js";
import { MODEL_TIERS, tierOf } from "../../config/constants.js";
import { SettingsStore } from "../../db/settings.js";
import { resolveModel } from "../../lib/model-catalog.js";
import { isTranscriptOverCap, transcriptSizeMB, SESSION_JSONL_MAX_MB } from "../../lib/claude-transcript.js";
import { stepsFromSdkMessage, toolResultsFromSdkMessage, createStreamWatcher } from "../../lib/tool-steps.js";
import { agentVaultEnv } from "../agent-env.js";
import { getSecurityManager } from "../../lib/security-manager.js";
import { getProvider, normalizeProviderId, contextTokensFor, effortsFor, capsFor, engineFor, resolveModelFor } from "../provider-registry.js";
import {
  CLAUDE_CODE, CredentialError, HOST_MANAGED, baseEnv, claudeEnvFor, ensureHome, homeFor, homeIsolationRefusal,
  settingSourcesFor, settingsFilesFor, settingsFileGuard,
} from "../engine-env.js";
import { AUTH_EXPIRED_MESSAGE, classifyEngineError } from "../engine-errors.js";
import { buildPreamble } from "../preamble.js";
import { checkTurnBudget, priceUsage } from "../spend.js";
import { parse as parseHandle, sessionFor } from "../session-handle.js";

export { AUTH_EXPIRED_MESSAGE };

/** Tarsee's bundled skills (src/skills), handed to Claude Code as an additional directory. */
export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

/** The providers this engine runs. */
export const CLAUDE_ENGINE_PROVIDERS = Object.freeze(["claude", "anthropic", "deepseek", "openrouter"]);

/** The built-in tools every provider gets, plus Tarsee's own (without the mcp__tarsee__* entry the SDK filters them out). */
export const BUILTIN_TOOLS = Object.freeze(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);
const ALL_TOOLS = Object.freeze([...BUILTIN_TOOLS, "mcp__tarsee__*"]);

/**
 * R6: the apiKeySource the CLI may report on its init message for each provider, recorded with fake credentials
 * against the pinned CLI (2.1.319, test/claude-gateway.test.js):
 *   claude      "none": the claude.ai sign-in (a .credentials.json or CLAUDE_CODE_OAUTH_TOKEN) is not an API key.
 *               ("oauth" is the legacy name for the same, which current CLIs no longer send.)
 *   anthropic   "ANTHROPIC_API_KEY": the key Tarsee set (and approved) in the environment
 *   deepseek, openrouter   "none": a bearer token (ANTHROPIC_AUTH_TOKEN) is not an API key either
 * Anything else ("/login managed key": a Console key a Terminal /login saved in the home; "apiKeyHelper"; an
 * ANTHROPIC_API_KEY on the plan, which would move it to metered billing) stops the turn.
 */
export const API_KEY_SOURCES = Object.freeze({
  claude: Object.freeze(["none", "oauth"]),
  anthropic: Object.freeze(["ANTHROPIC_API_KEY"]),
  deepseek: Object.freeze(["none"]),
  openrouter: Object.freeze(["none"]),
});

/** R6: null when `source` is what this provider should report, else the refusal {code, message}. */
export function apiKeySourceRefusal(providerId, source) {
  const id = normalizeProviderId(providerId) || String(providerId || "");
  const allowed = API_KEY_SOURCES[id];
  if (!allowed) return null;
  const s = source == null ? "none" : String(source);
  if (allowed.includes(s)) return null;
  const label = getProvider(id)?.label || id;
  const why = s === "/login managed key"
    ? "an Anthropic Console key saved by a Terminal /login in this provider's folder"
    : s === "apiKeyHelper"
      ? "an apiKeyHelper command from a settings file"
      : s === "ANTHROPIC_API_KEY"
        ? "an Anthropic API key in its environment"
        : s === "none"
          ? "no API key at all (it would fall back to a sign-in)"
          : `"${s}"`;
  return {
    code: "credential-isolation",
    message: `Tarsee stopped this turn: Claude Code was about to use ${why} instead of ${id === "claude" ? "the Claude plan's sign-in" : `the ${label} key Tarsee gave it`}. Nothing was sent. Check Settings > AI, and remove any key a Terminal /login saved.`,
  };
}

/**
 * Build a comma-separated `--fallback-model` ladder for a Claude model: one tier down at a time (fable > opus > sonnet
 * > haiku), each resolved to the newest model of its tier (lib/model-catalog.js). Haiku has nothing below it.
 */
function fallbackLadderFor(modelId, resolve = resolveModel) {
  const tier = tierOf(modelId);
  if (!tier) return undefined;
  const below = MODEL_TIERS.slice(MODEL_TIERS.indexOf(tier) + 1);
  return below.length ? below.map((t) => resolve(t)).join(",") : undefined;
}

const SDK_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CONTEXT_SUFFIX_RE = /\[1m\]$/i;
const bare = (model) => String(model ?? "").trim().replace(CONTEXT_SUFFIX_RE, "");

/** A gateway model with Claude Code's "[1m]" when its window is at least 1M (engine-env's rule, for the fallback). */
function gatewayPin(id, model, store) {
  const m = bare(model);
  return Number(contextTokensFor(id, m, store)) >= 1_000_000 ? `${m}[1m]` : m;
}

function entryOf(provider) {
  if (provider && typeof provider === "object" && provider.id) return provider;
  const p = getProvider(provider ?? "claude");
  if (!p) throw new CredentialError("wrong-engine", `Tarsee doesn't know the AI "${provider}".`, String(provider));
  return p;
}

/** The system prompt as the SDK takes it: Tarsee's preamble first, then the caller's prompt (or its stable and volatile parts). */
function systemPromptFor({ preamble, systemPrompt, systemParts }) {
  const clean = (s) => String(s ?? "").replace(/[\uD800-\uDFFF]/g, "");
  let prompt;
  if (systemParts && (systemParts.stable != null || systemParts.volatile != null)) {
    const head = clean(preamble + (systemParts.stable ? `\n\n${systemParts.stable}` : ""));
    prompt = systemParts.volatile ? [head, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, clean(systemParts.volatile)] : head;
  } else {
    prompt = clean(preamble + (systemPrompt ? `\n\n${systemPrompt}` : ""));
  }
  // Rendered fresh on every request, as before the 0.3.319 SDK: that SDK records a plain prompt on a session's first
  // request and reuses it on every resume ("snapshot"), which would freeze each turn's date, memory and context.
  return { type: "custom", prompt, snapshot: false };
}

/**
 * The SDK options for one turn on `provider` (an id, an alias or the registry entry). Pure: it reads no file and
 * starts nothing (the guards that look at files run in run()). Throws engine-env's CredentialError when the turn must
 * not start (R4: no key; a key in the wrong slot; a gateway model pinned to a Claude id).
 *
 * opts:
 *   model, effort, maxTurns, maxBudgetUsd, thinkingSummaries
 *   systemPrompt | systemParts {stable, volatile}
 *   resume            the raw session id to resume (run() leaves it out past the transcript cap)
 *   key               the provider's key (anthropic, deepseek, openrouter)
 *   cwd               the workspace (default config.CLAUDE_WORKSPACE_DIR)
 *   mcpServer         the in-process tarsee MCP server (createTarseeMcp)
 *   abortController
 *   tiers, contextTokens, appTitle, referer   gateway extras (OpenRouter's editable tiers and attribution)
 * deps:
 *   env (default process.env), vaultEnv (default {}), stateDir (default config.STATE_DIR), homeDir, store,
 *   resolveModel, timezone
 *
 * Returns { options, providerId, home, settingSources, settingsFiles, model, apiKeySources, cost } where cost is
 * "plan" (included), "exact" (total_cost_usd) or "estimate" (Tarsee prices the tokens).
 */
export function buildQueryOptions(provider, opts = {}, deps = {}) {
  const entry = entryOf(provider);
  const id = normalizeProviderId(entry.id) || entry.id;
  if (!CLAUDE_ENGINE_PROVIDERS.includes(id)) {
    throw new CredentialError("wrong-engine", `${entry.label || id} doesn't run on Claude Code.`, id);
  }
  const env = deps.env ?? process.env;
  const store = deps.store ?? null;
  const stateDir = deps.stateDir ?? config.STATE_DIR;
  const resolve = deps.resolveModel ?? resolveModel;
  const cwd = opts.cwd || config.CLAUDE_WORKSPACE_DIR || process.cwd();
  const gateway = id === "deepseek" || id === "openrouter";
  const claudeModels = id === "claude" || id === "anthropic";
  const requested = opts.model || (claudeModels ? config.CLAUDE_DEFAULT_MODEL : entry.defaultModel);

  const credentialEnv = claudeEnvFor(entry, {
    env,
    vaultEnv: deps.vaultEnv ?? {},
    key: opts.key,
    model: gateway ? bare(requested) : undefined,
    tiers: opts.tiers,
    contextTokens: gateway ? (opts.contextTokens ?? contextTokensFor(id, bare(requested), store)) : undefined,
    appTitle: opts.appTitle,
    referer: opts.referer,
    stateDir,
    homeDir: deps.homeDir,
  });
  // Every key and gateway turn runs host-managed: settings files can't move it, and its key is not in the shell's
  // environment (still readable from the CLI's process on Linux; see HOST_MANAGED in engine-env.js).
  const turnEnv = id === "claude" ? credentialEnv : { ...credentialEnv, ...HOST_MANAGED };
  const home = id === "claude" ? homeFor("claude", CLAUDE_CODE, { homeDir: deps.homeDir }) : turnEnv.CLAUDE_CONFIG_DIR;
  const settingSources = settingSourcesFor(id);
  const model = gateway ? turnEnv.ANTHROPIC_MODEL : resolve(requested);
  const caps = capsFor(id, gateway ? bare(requested) : model, store) || {};

  const options = {
    cwd,
    env: turnEnv,
    model,
    tools: [...ALL_TOOLS],
    allowedTools: [...ALL_TOOLS],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // Interactive chat keeps the generous ceiling; background callers pass a much lower one.
    maxTurns: opts.maxTurns ?? 50,
    includePartialMessages: true,
    settingSources,
    // Key and gateway turns use only the servers Tarsee hands over, never MCP servers from .mcp.json, a settings file
    // or a plugin, because those would start with the CLI's environment, key included. The plan keeps today's
    // behaviour: the owner's project (.mcp.json), user, local and plugin servers load alongside tarsee.
    strictMcpConfig: id !== "claude",
    additionalDirectories: [BUNDLED_SKILLS_DIR],
    systemPrompt: systemPromptFor({
      preamble: buildPreamble({ engine: CLAUDE_CODE, cwd, ...(deps.timezone ? { timezone: deps.timezone } : {}) }),
      systemPrompt: opts.systemPrompt,
      systemParts: opts.systemParts,
    }),
  };
  if (opts.mcpServer) options.mcpServers = { tarsee: opts.mcpServer };
  if (opts.abortController) options.abortController = opts.abortController;
  if (opts.resume) options.resume = opts.resume;

  // Keep answering when the chosen model is saturated: Claude steps down one tier at a time; DeepSeek Pro falls back
  // to Flash; OpenRouter fails over between its own hosts, so it gets none.
  if (claudeModels) {
    const ladder = fallbackLadderFor(requested, resolve);
    if (ladder) options.fallbackModel = ladder;
  } else if (id === "deepseek") {
    const flash = entry.tiers?.sonnet;
    if (flash && bare(requested) !== flash) options.fallbackModel = gatewayPin(id, flash, store);
  }

  // The SDK's own dollar ceiling, on the providers whose prices it knows (the turn guard in run() covers the others).
  if (caps.nativeBudget && typeof opts.maxBudgetUsd === "number" && opts.maxBudgetUsd > 0) options.maxBudgetUsd = opts.maxBudgetUsd;

  // Effort only when the model takes that level (DeepSeek: low, high, max).
  if (opts.effort && SDK_EFFORTS.has(opts.effort) && effortsFor(id, gateway ? bare(requested) : model, store).includes(opts.effort)) {
    options.effort = opts.effort;
  }

  // Summaries of the model's thinking for the dashboard's live view, where the provider is known to send them.
  if (opts.thinkingSummaries && caps.thinkingSummaries) options.thinking = { type: "adaptive", display: "summarized" };

  const settingsFiles = settingsFilesFor(settingSources, { home, workspace: cwd });
  return {
    options,
    providerId: id,
    home,
    settingSources,
    settingsFiles,
    model,
    apiKeySources: API_KEY_SOURCES[id],
    cost: id === "claude" ? "plan" : id === "anthropic" ? "exact" : "estimate",
  };
}

/**
 * The CLI uses an ANTHROPIC_API_KEY from its environment only once that key is approved in its global config (the
 * key's last 20 characters in customApiKeyResponses.approved), the prompt a person answers in the Terminal. A turn has
 * nobody to answer it, so the Anthropic key's own home records the approval for the key Tarsee hands over. Writes the
 * file the CLI reads (.config.json when it is there, else .claude.json), keeping what else is in it.
 */
export function approveKeyInHome(home, key, { readFile = (p) => fs.readFileSync(p, "utf8"), writeFile = (p, s) => fs.writeFileSync(p, s, { mode: 0o600 }), exists = fs.existsSync } = {}) {
  const k = String(key ?? "").trim();
  if (!k) return null;
  const marker = k.slice(-20);
  const file = exists(path.join(home, ".config.json")) ? path.join(home, ".config.json") : path.join(home, ".claude.json");
  let json = {};
  try {
    const parsed = JSON.parse(String(readFile(file)).replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed;
  } catch { /* missing or not JSON: start it */ }
  const responses = json.customApiKeyResponses && typeof json.customApiKeyResponses === "object" ? json.customApiKeyResponses : {};
  const approved = Array.isArray(responses.approved) ? responses.approved.filter((x) => typeof x === "string") : [];
  const rejected = Array.isArray(responses.rejected) ? responses.rejected.filter((x) => typeof x === "string" && x !== marker) : [];
  if (approved.includes(marker) && rejected.length === (responses.rejected || []).length) return file;
  json.customApiKeyResponses = { ...responses, approved: [...approved.filter((x) => x !== marker), marker], rejected };
  writeFile(file, JSON.stringify(json, null, 2));
  return file;
}

// --- The engine ----------------------------------------------------------------------------------------------------

/** Whether an SDK message's words (or its error flag) are a sign-in failing rather than a reply. */
const AUTH_TEXT_RE = /(Failed to authenticate|OAuth (?:access )?token (?:has )?expired|Re-authenticate to continue|API Error:\s*401|Not logged in · Please run \/login)/i;
export function isAuthFailure(text, sdkError = null) {
  return sdkError === "authentication_failed" || AUTH_TEXT_RE.test(String(text || ""));
}

/** An API error delivered as the reply ("API Error: 402 ...", "There's an issue with the selected model ..."). */
function looksLikeApiError(text) {
  const t = String(text || "").trim();
  return /^API Error[:\s]/i.test(t) || /previous_message_id|must be the id from a prior/i.test(t) || /^There's an issue with the selected model/i.test(t);
}

function textOf(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("") : "";
}

function extractMedia(content) {
  if (!Array.isArray(content)) return { mediaBlocks: [], text: typeof content === "string" ? content : "" };
  const mediaBlocks = [];
  const textParts = [];
  for (const block of content) {
    if (block?.type === "image" && block.source?.data) {
      mediaBlocks.push({ type: "image", source: { type: "base64", media_type: block.source.media_type || "image/png", data: block.source.data } });
    } else if (block?.type === "document" && block.source?.data) {
      mediaBlocks.push({ type: "document", source: { type: "base64", media_type: block.source.media_type || "application/pdf", data: block.source.data } });
    } else if (block?.type === "text") {
      textParts.push(block.text);
    }
  }
  return { mediaBlocks, text: textParts.join("\n") };
}

/** The four token counts of the SDK's modelUsage for one model, in the Messages API's names. */
function usageOfModel(u) {
  return {
    input_tokens: Number(u?.inputTokens) || 0,
    output_tokens: Number(u?.outputTokens) || 0,
    cache_read_input_tokens: Number(u?.cacheReadInputTokens) || 0,
    cache_creation_input_tokens: Number(u?.cacheCreationInputTokens) || 0,
  };
}

/** A provider's settings store: the turn's, or one over its database. */
/**
 * OpenRouter's tier pins for Claude Code (its subagents, its small fast model): each tier as the registry resolves it
 * (the owner's map, the default model's maker, else the ~anthropic slugs), when that model runs on Claude Code; any
 * other tier is pinned to the turn's own model, since Claude Code can't be handed a model it wasn't verified on.
 */
function openRouterPinTiers(model, store) {
  const main = String(model ?? "").trim().replace(/\[1m\]$/i, "") || undefined;
  const out = {};
  for (const t of MODEL_TIERS) {
    const id = resolveModelFor("openrouter", t, store);
    out[t] = id && engineFor("openrouter", id, store) === CLAUDE_CODE ? id : main;
  }
  return out;
}

function storeOf(toolCtx, deps) {
  if (deps.store) return deps.store;
  if (toolCtx?.settingsStore) return toolCtx.settingsStore;
  if (toolCtx?.db) { try { return new SettingsStore(toolCtx.db); } catch { return null; } }
  return null;
}

function readSetting(store, key) {
  try { return store?.get?.(key) ?? null; } catch { return null; }
}

/** The provider's key: Settings first, then its Railway variable (db/settings.js getKeyWithSource). */
function keyFor(entry, store, env) {
  if (entry.kind === "subscription") return null;
  try {
    const found = store?.getKeyWithSource?.(entry.id);
    if (found?.key) return found.key;
  } catch { /* fall through to the environment */ }
  return entry.envKey ? (String(env?.[entry.envKey] ?? "").trim() || null) : null;
}

/**
 * The engine. An async generator of Tarsee events:
 *   text{content}, thinking{status}, tool_use{id,name,input}, tool_result{id,ok,result}, step{...} (the live
 *   timeline, lib/tool-steps.js), usage{usage, costUsd?}, error{message, recoverable?, subtype?, code?, status?}, and
 *   exactly one done{stopReason}: end_turn | aborted | auth-expired | error | max_turns | budget. Never tool_use.
 *
 * opts:
 *   target            {providerId (or provider), model, effort}: claude, anthropic, deepseek or openrouter
 *   messages          the conversation; the last user message is the prompt
 *   systemPrompt | systemParts {stable, volatile}
 *   signal            stops the turn (done{aborted})
 *   toolCtx           Tarsee's tool context (db, settingsStore, conversationId, ...)
 *   sessionId         the raw session id the turn layer chose to resume; null (present) starts fresh on purpose
 *   sessionHandle     without sessionId: the stored handle, resumed only when it is this provider's (a bare id is
 *                     the plan's)
 *   onSessionHandle(rawId)   called once with the session the turn runs in (the turn layer tags and stores it);
 *                     onSessionId when there is no onSessionHandle
 *   maxTurns, maxBudgetUsd, thinkingSummaries
 *   cwd               the workspace (default config.CLAUDE_WORKSPACE_DIR): verification's scratch folder, say
 *   media             the turn layer's adaptMedia() result ({media, text}) or its media blocks; without it the last
 *                     message's own blocks are sent
 *   deps              test seams: query, env, stateDir, homeDir, store, key, mcpServer, vaultEnv, guards
 */
export async function* run(opts = {}) {
  const deps = opts.deps || {};
  const target = opts.target || {};
  const id = normalizeProviderId(target.providerId ?? target.provider ?? opts.provider ?? "claude") || "claude";
  const entry = getProvider(id);
  const toolCtx = opts.toolCtx || {};
  const store = storeOf(toolCtx, deps);
  const env = deps.env ?? process.env;
  const signal = opts.signal;
  const model = target.model ?? opts.model;
  const effort = target.effort ?? opts.effort;

  let doneSent = false;
  const done = (stopReason) => { doneSent = true; return { type: "done", stopReason }; };
  /** A failure: its words (and for a sign-in, the fix as text too), then the one done. */
  function* fail(info, { stopReason = null, subtype = null } = {}) {
    const auth = info.kind === "expired" || info.kind === "auth";
    if (auth && !textOut) yield { type: "text", content: info.message };
    const evt = { type: "error", message: info.message, recoverable: !!info.recoverable, code: info.kind };
    if (info.status) evt.status = info.status;
    // The provider's failure flag for the turn layer to write (ai.<id>.status): expired, rejected, out of credit.
    if (info.state) evt.state = info.state;
    if (subtype) evt.subtype = subtype;
    yield evt;
    yield done(stopReason || (auth ? "auth-expired" : "error"));
  }
  let textOut = false;

  if (!entry || !CLAUDE_ENGINE_PROVIDERS.includes(entry.id)) {
    yield* fail(classifyEngineError(id, CLAUDE_CODE, { code: "wrong-engine", message: `${entry?.label || id} doesn't run on Claude Code.` }));
    return;
  }

  // --- The prompt ---
  const lastUser = [...(opts.messages || [])].reverse().find((m) => m?.role === "user");
  let mediaBlocks;
  let prompt;
  if (opts.media != null) {
    const adapted = opts.media;
    mediaBlocks = Array.isArray(adapted) ? adapted : (Array.isArray(adapted.media) ? adapted.media : []);
    prompt = !Array.isArray(adapted) && typeof adapted.text === "string" ? adapted.text : extractMedia(lastUser?.content).text;
  } else {
    const extracted = extractMedia(lastUser?.content);
    mediaBlocks = extracted.mediaBlocks;
    prompt = extracted.text;
    // A message's pictures are kept with it so the dashboard's chat shows them (lib/sent-files.js). Best-effort.
    if (mediaBlocks.length && toolCtx.conversationId) {
      try { (await import("../../lib/sent-files.js")).noteMediaBlocks(toolCtx.conversationId, mediaBlocks, { messageId: toolCtx.messageId || null }); } catch { /* best-effort */ }
    }
  }
  if (!prompt && !mediaBlocks.length) prompt = "hello";

  // --- The session to resume (only one of this provider's) ---
  // The turn layer passes the raw id it chose (sessionId, null for a fresh session on purpose) beside the stored
  // handle; that choice wins. A caller with only a handle gets it resumed when it is this provider's.
  let resume = null;
  if (Object.hasOwn(opts, "sessionId")) {
    resume = opts.sessionId ? String(opts.sessionId) : null;
  } else if (opts.sessionHandle) {
    const handle = String(opts.sessionHandle);
    const parsed = parseHandle(handle);
    resume = parsed?.tagged ? sessionFor(handle, { provider: entry.id, engine: CLAUDE_CODE, model }) : (parsed?.rawId ?? null);
  }
  if (resume) {
    const overCap = deps.isTranscriptOverCap ?? ((sid) => isTranscriptOverCap(sid, SESSION_JSONL_MAX_MB, { provider: entry.id }));
    if (overCap(resume)) {
      const mb = (deps.transcriptSizeMB ?? ((sid) => transcriptSizeMB(sid, { provider: entry.id })))(resume);
      console.warn(`[claude-code] session ${resume} transcript ${mb}MB > ${SESSION_JSONL_MAX_MB}MB cap: starting fresh instead of resuming it`);
      resume = null;
    }
  }

  // --- Abort plumbing: the SDK's own mechanism is options.abortController ---
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  // --- Options and the guards before anything starts (R1, R4, R5) ---
  let built;
  try {
    const key = entry.kind === "subscription" ? null : (deps.key ?? keyFor(entry, store, env));
    const vaultEnv = deps.vaultEnv ?? agentVaultEnv({
      env: baseEnv(env),
      denied: () => { try { return getSecurityManager(toolCtx.settingsStore).getToolPermission("get_key") === "always_deny"; } catch { return false; } },
    });
    const tiers = entry.id === "openrouter" ? openRouterPinTiers(model, store) : undefined;
    built = buildQueryOptions(entry, {
      model,
      effort,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      thinkingSummaries: !!opts.thinkingSummaries,
      systemPrompt: opts.systemPrompt,
      systemParts: opts.systemParts,
      resume,
      key,
      cwd: opts.cwd || deps.cwd,
      abortController,
      tiers,
      appTitle: entry.id === "openrouter" ? (readSetting(store, "ai.openrouter.appTitle") || entry.defaultAppTitle) : undefined,
      referer: entry.id === "openrouter" ? readSetting(store, "ai.openrouter.referer") : undefined,
    }, { env, vaultEnv, stateDir: deps.stateDir, homeDir: deps.homeDir, store, resolveModel: deps.resolveModel });

    if (entry.id !== "claude") {
      ensureHome(built.home);
      const refusal = (deps.homeIsolationRefusal ?? homeIsolationRefusal)(built.home, { providerId: entry.id, engine: CLAUDE_CODE });
      if (refusal) throw new CredentialError("credential-isolation", refusal.message, entry.id);
      if (entry.id === "anthropic") approveKeyInHome(built.home, built.options.env.ANTHROPIC_API_KEY);
    }
    const guard = (deps.settingsFileGuard ?? settingsFileGuard)(built.settingsFiles);
    if (!guard.ok) throw new CredentialError("credential-isolation", guard.message, entry.id);
  } catch (err) {
    if (signal) signal.removeEventListener("abort", onAbort);
    if (err instanceof CredentialError) {
      console.warn(`[claude-code] ${entry.id}: turn refused (${err.code}): ${err.message}`);
      yield* fail(classifyEngineError(entry.id, CLAUDE_CODE, { code: err.code, message: err.message }));
    } else {
      console.error(`[claude-code] ${entry.id}: couldn't set up the turn:`, err);
      yield* fail(classifyEngineError(entry.id, CLAUDE_CODE, { message: `Tarsee couldn't set up this turn: ${err?.message || err}` }));
    }
    return;
  }

  // Tarsee's own tools, in-process.
  let mcpServer = deps.mcpServer;
  if (mcpServer === undefined) {
    const { createTarseeMcp } = await import("../tarsee-mcp.js");
    mcpServer = createTarseeMcp(toolCtx);
  }
  const queryOptions = { ...built.options };
  if (mcpServer) queryOptions.mcpServers = { tarsee: mcpServer };
  let stderrTail = "";
  queryOptions.stderr = (data) => { stderrTail = (stderrTail + String(data)).slice(-2000); };

  console.log(`[claude-code] Starting ${entry.id} turn in ${queryOptions.cwd}, model: ${queryOptions.model}, session: ${resume || "new"}, media: ${mediaBlocks.length}`);

  let queryPrompt = prompt;
  if (mediaBlocks.length) {
    const contentBlocks = [...mediaBlocks, ...(prompt ? [{ type: "text", text: prompt }] : [])];
    queryPrompt = (async function* mediaPrompt() {
      yield { type: "user", message: { role: "user", content: contentBlocks }, parent_tool_use_id: null };
    })();
  }

  const query = deps.query ?? sdkQuery;
  const priced = built.cost === "estimate";
  const bareModel = bare(queryOptions.model);
  let reportedCost = 0;        // OpenRouter's usage.cost, summed over the turn's calls
  let reportedAny = false;
  let lastCallPrompt = 0;      // the last top-level call's prompt: how full the context is (the turn's usage sums calls)
  let lastSession = null;
  const report = (sid) => {
    if (!sid || sid === lastSession) return;
    lastSession = sid;
    try { (opts.onSessionHandle || opts.onSessionId)?.(sid); } catch (err) { console.warn(`[claude-code] storing the session failed: ${err?.message || err}`); }
  };
  let lastAssistantError = null;

  try {
    let messageCount = 0;
    let everStreamed = false;
    let inThinking = false;
    const seenToolIds = new Set();
    const watcher = createStreamWatcher();
    const stream = query({ prompt: queryPrompt, options: queryOptions });
    for await (const message of stream) {
      messageCount++;
      if (abortController.signal.aborted) break;

      // OpenRouter reports each call's cost on its message_delta: counted before the turn guard below looks.
      if (message.type === "stream_event" && message.event?.type === "message_delta") {
        const raw = message.event.usage?.cost;
        const c = Number(raw);
        if (raw != null && Number.isFinite(c) && c >= 0) { reportedCost += c; reportedAny = true; }
      }
      // Each top-level call's prompt, from its message_start (a subagent's calls are its own context, not this one's).
      if (message.type === "stream_event" && !message.parent_tool_use_id && message.event?.type === "message_start") {
        const u = message.event.message?.usage;
        const n = (Number(u?.input_tokens) || 0) + (Number(u?.cache_read_input_tokens) || 0) + (Number(u?.cache_creation_input_tokens) || 0);
        if (n > 0) lastCallPrompt = n;
      }

      // R6: the CLI says which credential it will use before it sends anything.
      if (message.type === "system" && message.subtype === "init") {
        console.log(`[claude-code] ${entry.id}: apiKeySource=${message.apiKeySource}`);
        const refusal = apiKeySourceRefusal(entry.id, message.apiKeySource);
        if (refusal) {
          abortController.abort();
          console.error(`[claude-code] ${entry.id}: stopped, apiKeySource ${message.apiKeySource} is not this provider's credential`);
          yield* fail(classifyEngineError(entry.id, CLAUDE_CODE, { code: refusal.code, message: refusal.message }));
          return;
        }
      }

      for (const step of watcher.onMessage(message)) {
        yield { type: "step", ...step };
        // The turn guard for the providers whose dollar ceiling the SDK can't keep (it doesn't know their prices).
        if (step.kind === "usage" && priced && typeof opts.maxBudgetUsd === "number" && opts.maxBudgetUsd > 0) {
          const check = checkTurnBudget({
            providerId: entry.id,
            model: bareModel,
            maxBudgetUsd: opts.maxBudgetUsd,
            store,
            ...(reportedAny ? { costUsd: reportedCost } : { usage: { input_tokens: step.input, output_tokens: step.output, cache_read_input_tokens: step.cacheRead, cache_creation_input_tokens: step.cacheWrite } }),
          });
          if (check.tripped) {
            abortController.abort();
            yield { type: "error", message: check.message, recoverable: false, subtype: "error_max_budget_usd", code: "budget" };
            yield done("budget");
            return;
          }
        }
      }

      switch (message.type) {
        case "stream_event": {
          const evt = message.event;
          if (evt?.type === "content_block_delta") {
            if (evt.delta?.type === "text_delta" && evt.delta.text) {
              yield { type: "text", content: evt.delta.text };
              everStreamed = true;
              textOut = true;
            } else if (evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
              everStreamed = true;
            }
          } else if (evt?.type === "content_block_start") {
            if (evt.content_block?.type === "thinking") {
              inThinking = true;
              yield { type: "thinking", status: "start" };
            }
          } else if (evt?.type === "content_block_stop" && inThinking) {
            inThinking = false;
            yield { type: "thinking", status: "stop" };
          }
          break;
        }

        case "assistant": {
          const top = !message.parent_tool_use_id;
          // An API failure the CLI delivers as if it were the reply: never shown as the answer.
          if (top && message.error) {
            lastAssistantError = { code: message.error, text: textOf(message.message?.content) };
            break;
          }
          if (top && !textOut && isAuthFailure(textOf(message.message?.content))) {
            lastAssistantError = { code: "authentication_failed", text: textOf(message.message?.content) };
            break;
          }
          if (top) {
            for (const step of stepsFromSdkMessage(message, seenToolIds)) yield { type: "step", ...step };
            if (!everStreamed) {
              const text = textOf(message.message?.content);
              if (text) {
                yield { type: "text", content: text };
                everStreamed = true;
                textOut = true;
              }
            }
            for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
              if (block?.type === "tool_use") yield { type: "tool_use", id: block.id, name: block.name, input: block.input };
            }
          }
          break;
        }

        case "user": {
          // A tool's output comes back as a user message holding a tool_result block. Replays of earlier turns on
          // resume are skipped, and so are a subagent's inner results.
          if (message.isReplay || message.parent_tool_use_id) break;
          for (const step of stepsFromSdkMessage(message, seenToolIds)) yield { type: "step", ...step };
          for (const r of toolResultsFromSdkMessage(message)) {
            yield { type: "tool_result", id: r.id, ok: r.ok, result: r.result.slice(0, 2000) };
          }
          break;
        }

        case "result": {
          report(message.session_id || message.sessionId);
          const usage = message.usage ? {
            input_tokens: message.usage.input_tokens || 0,
            output_tokens: message.usage.output_tokens || 0,
            cache_read_input_tokens: message.usage.cache_read_input_tokens || 0,
            cache_creation_input_tokens: message.usage.cache_creation_input_tokens || 0,
            // How full the context is (routes/chat.js's 95% check, the page's meter): the last call, not the sum.
            ...(lastCallPrompt > 0 ? { context_input_tokens: lastCallPrompt } : {}),
          } : null;
          const costUsd = turnCost(built.cost, entry.id, message, { reportedAny, reportedCost, store });
          // costExact: the provider's own figure (the Anthropic key's total, OpenRouter's usage.cost), not a price-table
          // estimate; the Usage page labels it exact (lib/token-usage.js).
          const costExact = costUsd != null && (built.cost === "exact" || (entry.id === "openrouter" && reportedAny));
          if (usage || costUsd != null) yield { type: "usage", usage: usage || { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...(costUsd != null ? { costUsd } : {}), ...(costExact ? { costExact: true } : {}) };

          // A result is not always a success: the SDK uses the same type for its stops, which carry errors[] instead.
          if (message.subtype && message.subtype !== "success") {
            const detail = Array.isArray(message.errors) && message.errors.length ? message.errors.join("; ") : message.subtype;
            if (message.subtype === "error_max_turns") {
              yield { type: "error", message: `Stopped after hitting the turn limit (${message.num_turns} turns). The task needs to be broken into smaller steps.`, recoverable: false, subtype: message.subtype, code: "max_turns" };
              yield done("max_turns");
            } else if (message.subtype === "error_max_budget_usd") {
              yield { type: "error", message: "Stopped after hitting the configured spend ceiling for this task.", recoverable: false, subtype: message.subtype, code: "budget" };
              yield done("budget");
            } else {
              const info = classifyEngineError(entry.id, CLAUDE_CODE, { code: lastAssistantError?.code, message: lastAssistantError?.text || detail, model: queryOptions.model });
              yield* fail(info.kind === "unknown" ? { ...info, message: `Claude Code ended with ${message.subtype}: ${detail}` } : info, { subtype: message.subtype });
            }
            return;
          }
          const resultText = message.result || "";
          const failed = message.is_error || lastAssistantError || (!textOut && (isAuthFailure(resultText) || looksLikeApiError(resultText)));
          if (failed) {
            const words = lastAssistantError?.text || resultText;
            const info = classifyEngineError(entry.id, CLAUDE_CODE, { code: lastAssistantError?.code, message: words, model: queryOptions.model });
            console.error(`[claude-code] ${entry.id}: ${info.kind}: ${String(words).slice(0, 200)}`);
            yield* fail(info);
            return;
          }
          if (!everStreamed && resultText) {
            yield { type: "text", content: resultText };
            textOut = true;
          }
          yield done("end_turn");
          return;
        }

        case "system": {
          if (message.session_id) report(message.session_id);
          // The tarsee server can fail to register (a bad tool schema fails the whole tools/list call) while the
          // system prompt keeps advertising its tools; say so loudly.
          if (Array.isArray(message.mcp_servers)) {
            for (const srv of message.mcp_servers) {
              if (srv?.status && srv.status !== "connected") console.error(`[claude-code] MCP server "${srv.name}" is ${srv.status}: its tools are NOT available this turn.`);
            }
          }
          break;
        }

        default:
          break;
      }
    }
    if (!doneSent) {
      if (abortController.signal.aborted) {
        console.log("[claude-code] Turn stopped.");
        yield done("aborted");
      } else if (messageCount === 0) {
        yield* fail(classifyEngineError(entry.id, CLAUDE_CODE, { message: `Claude Code returned no response.${stderrTail ? ` ${stderrTail.trim().slice(-300)}` : ""}` }));
      } else {
        yield* fail(classifyEngineError(entry.id, CLAUDE_CODE, { message: "Claude Code stopped without finishing its answer." }));
      }
    }
  } catch (error) {
    if (doneSent) return; // (the SDK throws after an error result it already reported)
    if (abortController.signal.aborted) {
      console.log("[claude-code] Turn stopped.");
      yield done("aborted");
      return;
    }
    console.error("[claude-code] Exception:", error);
    const errMsg = error?.message || "Claude Code crashed";
    if (/ENOENT.*claude/i.test(errMsg)) {
      yield* fail({ kind: "unknown", message: `**Claude Code isn't installed where Tarsee can run it.** Check the server logs.\n\nError: ${errMsg}`, recoverable: false });
      return;
    }
    yield* fail(classifyEngineError(entry.id, CLAUDE_CODE, { code: lastAssistantError?.code, message: lastAssistantError?.text || errMsg, model: queryOptions.model }));
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    if (!doneSent) abortController.abort();
  }
}

/**
 * A turn's cost in USD, or null when it has none here:
 *   plan       null (included in the plan)
 *   exact      the SDK's total_cost_usd (the Anthropic key)
 *   estimate   OpenRouter's own usage.cost when it streamed one, else the price table times every model's tokens
 *              (modelUsage: subagents and background calls included)
 */
function turnCost(kind, providerId, result, { reportedAny, reportedCost, store }) {
  if (kind === "plan") return null;
  if (kind === "exact") return Number.isFinite(Number(result.total_cost_usd)) ? Number(result.total_cost_usd) : null;
  if (providerId === "openrouter" && reportedAny) return round6(reportedCost);
  const byModel = result.modelUsage && typeof result.modelUsage === "object" ? result.modelUsage : null;
  if (!byModel) return null;
  let total = 0;
  let any = false;
  for (const [m, u] of Object.entries(byModel)) {
    const usd = priceUsage(providerId, bare(m), usageOfModel(u), null, store);
    if (usd != null) { total += usd; any = true; }
  }
  return any ? round6(total) : null;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;
