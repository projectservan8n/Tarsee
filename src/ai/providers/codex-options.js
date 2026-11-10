/**
 * codex-options.js: everything a Codex turn starts with, worked out before anything runs (design 4.8, rules R1 to R7).
 * Pure: no I/O, no settings, no registry lookups beyond the provider's entry.
 *
 * buildCodexOptions(target, ctx) gives the four things the Codex SDK takes:
 *   env            the child's whole environment (engine-env codexEnvFor: the server's environment minus every
 *                  credential, plus the vault's keys, plus this provider's own credential block)
 *   config         the --config overrides (the SDK flattens them into dotted keys)
 *   apiKey         the OpenAI key, for the openai provider only (the SDK turns it into CODEX_API_KEY in the child)
 *   threadOptions  startThread()/resumeThread()'s options
 * No key or token is ever placed in config or on the command line: the custom providers read theirs from
 * TARSEE_PROVIDER_KEY (env_key), Tarsee's tools from TARSEE_MCP_TOKEN (bearer_token_env_var), and none of the three
 * reaches the agent's shell (shell_environment_policy, R7). Every host comes from engine-env hostFor(), OpenAI's
 * included, and none is ever passed as the SDK's baseUrl.
 *
 * Provider blocks:
 *   chatgpt     Codex's own ChatGPT sign-in in .codex-home (forced_login_method "chatgpt"); no host of Tarsee's.
 *               The model is only ever one the signed-in account lists (a free account can't use the paid ones),
 *               and none at all when that list is unknown: Codex then picks.
 *   openai      the built-in provider with the SDK's apiKey, OpenAI's host passed explicitly (openai_base_url), so no
 *               config file can move it; forced_login_method "api"
 *   openrouter  a custom Responses provider on OpenRouter's host, with its attribution headers
 *   deepseek    a custom Responses provider on DeepSeek's host (the alternative engine, used only when a model was
 *               verified on it)
 *   local       a custom Responses provider at the turn's Local AI bridge address (ai/local-bridge.js, which passes
 *               the requests on to the owner's server); its key is the bridge's per-turn token, so the owner's key
 *               never reaches the Codex process; the context window from the server or the card
 */
import { PROVIDERS, normalizeProviderId } from "../provider-registry.js";
import { CODEX, CODEX_SHELL_EXCLUDED, CredentialError, codexChatgptTestHosts, codexEnvFor, hostFor } from "../engine-env.js";
import { compactWindowTokens } from "../context-limits.js";

/** How long one call to a Tarsee tool may take (a browser task, a long fetch): over the 180 s floor the design sets. */
export const MCP_TOOL_TIMEOUT_SEC = 300;
const MCP_STARTUP_TIMEOUT_SEC = 20;

/** What Codex may say about a tool's output before trimming it for the model (tokens). */
const TOOL_OUTPUT_TOKEN_LIMIT = 3000;

/** The custom provider each key provider runs as (Tarsee's own names, so none can shadow a built-in one). */
const CUSTOM_PROVIDERS = {
  openrouter: { name: "OpenRouter" },
  deepseek: { name: "DeepSeek" },
  local: { name: "Local AI" },
};

/**
 * Codex features a Tarsee turn keeps off. Tarsee's own tools do these jobs, the same on every engine: ChatGPT's apps
 * and plugins (connectors that would bring their own tools and hosts), extra agents and goals, the built-in browser
 * and computer use, picture generation (its pictures don't reach a chat), tool suggestions, and installing a skill's
 * MCP servers on the fly. Hooks too: a hook is a program Codex runs around each tool call with the turn's whole
 * environment (the engine's own key included, which is kept out of the shell's environment), and Tarsee uses none. Also
 * unbounded_connection_retries: with it, a server that isn't there (a Local AI that is switched off) is retried for
 * ever and the turn never ends; without it Codex gives up after its usual retries and the turn says where it looked.
 * Set on every turn's command line, so a config file can't switch one back on.
 */
const FEATURES_OFF = Object.freeze([
  "apps", "plugins", "remote_plugin", "plugin_discovery_prefetch", "multi_agent", "goals", "computer_use",
  "browser_use", "browser_use_external", "in_app_browser", "image_generation", "tool_suggest", "skill_mcp_dependency_install",
  "memories", "hooks", "unbounded_connection_retries",
]);

/** The effort levels Codex takes that Tarsee also names (lib/model-picker.js EFFORT_IDS). */
const CODEX_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** The per-argument limit developer_instructions must fit: 128 KiB per argument on Linux, 32K characters in all on Windows. */
export function instructionsLimit(platform = process.platform) {
  return platform === "win32" ? 24 * 1024 : 96 * 1024;
}

const byteLength = (s) => Buffer.byteLength(s, "utf8");
const stripSurrogates = (s) => String(s ?? "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

/** The longest start of `s` that fits in maxBytes of UTF-8, never ending on half a character. */
function fitBytes(s, maxBytes) {
  if (byteLength(s) <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let out = s.slice(0, lo);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/** The longest end of `s` that fits in maxBytes of UTF-8, never starting on half a character. */
function lastBytes(s, maxBytes) {
  if (byteLength(s) <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (byteLength(s.slice(mid)) <= maxBytes) hi = mid;
    else lo = mid + 1;
  }
  let out = s.slice(lo);
  if (/^[\uDC00-\uDFFF]/.test(out)) out = out.slice(1);
  return out;
}

/** The first whole lines of `block` that fit in maxBytes ("" when not even the first one does). */
function fitLines(block, maxBytes) {
  let out = "";
  for (const line of block.split("\n")) {
    const next = out ? `${out}\n${line}` : line;
    if (byteLength(next) > maxBytes) break;
    out = next;
  }
  return out;
}

/**
 * The database's saved memories in the system prompt (db/memory.js MemoryStore.getContextString): its first line and
 * its one-line "- [category] …" rows. The preamble's own "## Memory" section is how to use the memory tools, not
 * memories, and is never cut.
 */
const QUICK_MEMORIES_RE = /^Additional quick memories[^\n]*\n(?:- \[[^\n]*(?:\n|$))*/m;
const TRIMMED = "\n[… trimmed to fit; search the memory files for the rest]\n";
const TRIMMED_MIDDLE = "\n[… trimmed to fit; the workspace files are on disk]\n";

/**
 * Instructions that fit in maxBytes. Broken surrogate halves go first (they can't be sent). When it is still too long,
 * the saved memories lose their last rows first (search_memories finds them again), down to none; then, if that
 * wasn't enough, the middle of the text goes, never either end: the start is the preamble (Tarsee's tools and how to
 * use memory), the end the conversation's own prompt and the channel hint (how to send a file there).
 */
export function capInstructions(text, maxBytes) {
  let s = stripSurrogates(text);
  if (byteLength(s) <= maxBytes) return s;
  const m = QUICK_MEMORIES_RE.exec(s);
  if (m) {
    const before = s.slice(0, m.index);
    const after = s.slice(m.index + m[0].length).replace(/^\n+/, "\n");
    const room = maxBytes - byteLength(before) - byteLength(after) - byteLength(TRIMMED);
    const kept = room > 0 ? fitLines(m[0].replace(/\n+$/, ""), room) : "";
    if (kept) return before + kept + TRIMMED + after;
    // Not even the first line fits: the memories go, and the middle is cut below if that still isn't enough.
    s = before.replace(/\s+$/, "") + TRIMMED + after;
    if (byteLength(s) <= maxBytes) return s;
  }
  if (maxBytes <= byteLength(TRIMMED_MIDDLE) * 4) return fitBytes(s, maxBytes);
  let tail = lastBytes(s, Math.floor(maxBytes / 4));
  const lineStart = tail.indexOf("\n");
  if (lineStart >= 0 && lineStart < tail.length / 2) tail = tail.slice(lineStart + 1);
  let head = fitBytes(s, maxBytes - byteLength(TRIMMED_MIDDLE) - byteLength(tail));
  const lineEnd = head.lastIndexOf("\n");
  if (lineEnd > head.length / 2) head = head.slice(0, lineEnd);
  return head + TRIMMED_MIDDLE + tail;
}

/** Tarsee's effort level as Codex's, or undefined to send none (an unknown level, or one this model doesn't take). */
export function codexEffort(effort, allowed = null) {
  const e = typeof effort === "string" ? effort.trim().toLowerCase() : "";
  if (!CODEX_EFFORTS.has(e)) return undefined;
  if (Array.isArray(allowed) && allowed.length && !allowed.includes(e)) return undefined;
  return e;
}

/**
 * The model to name on the command line, or undefined for Codex's own default.
 *   chatgpt  only a model the signed-in account's live list has, the one it marks as its default included (left out,
 *            a `model` in the home's config.toml, which the Terminal's /model writes, would run instead of the model
 *            Tarsee shows and records); nothing when the list is unknown or empty, or doesn't have it. A ChatGPT model
 *            is never hard-coded.
 *   others   the model as chosen; nothing for none or "default".
 */
export function codexModelFor(providerId, model, { accountModels } = {}) {
  const m = typeof model === "string" ? model.trim() : "";
  if (!m || m.toLowerCase() === "default") return undefined;
  if (normalizeProviderId(providerId) !== "chatgpt") return m;
  const list = Array.isArray(accountModels) ? accountModels : [];
  return list.some((r) => r && r.id === m) ? m : undefined;
}

/** The SDK's --config arguments for a config object (dotted keys, TOML values), for checks and logs. */
export function configArgs(config) {
  const out = [];
  const flatten = (value, prefix) => {
    if (isPlainObject(value)) {
      const entries = Object.entries(value).filter(([, v]) => v !== undefined);
      if (!entries.length) { if (prefix) out.push(`${prefix}={}`); return; }
      for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k);
      return;
    }
    out.push(`${prefix}=${toml(value)}`);
  };
  flatten(config, "");
  return out;
}

function toml(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (isPlainObject(value)) {
    const parts = Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${toml(v)}`);
    return `{${parts.join(", ")}}`;
  }
  throw new TypeError(`A Codex config value can't be ${value === null ? "null" : typeof value}`);
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const oneLine = (s) => String(s ?? "").replace(/[\r\n\0]+/g, " ").trim();

/**
 * Everything a Codex turn on `target` starts with.
 *
 * target: { providerId (or provider), model, effort }
 * ctx:
 *   env, vaultEnv   the server's environment and the vault's keys for scripts (engine-env R2)
 *   key             the provider's key (openai, openrouter, deepseek; local's is optional)
 *   stateDir        config.STATE_DIR (the key and sign-in homes live under it), or home to name the home outright
 *   workspace       the agent's working folder (required)
 *   mcp             the turn's grant for Tarsee's tools: { url, token } (required)
 *   developerInstructions   the stable instructions (preamble, workspace CLAUDE.md, stable system prompt)
 *   localUrl        Local AI's server address (ai.local.baseUrl, else TARSEE_LOCAL_AI_URL): checked, never sent to Codex
 *   localBridge     Local AI only, required: the turn's bridge {url, token} (local-bridge.js open()); Codex's base_url
 *                   is url and its key (TARSEE_PROVIDER_KEY) is token. ctx.key is not used for Local AI.
 *   appTitle, referer   OpenRouter's attribution
 *   contextTokens   the model's context window; compactWindow   TARSEE_COMPACT_WINDOW's value (default from env)
 *   thinkingSummaries   ask for reasoning summaries (the dashboard's live view)
 *   accountModels   the ChatGPT account's live model list ([{id, efforts?, default?}])
 *   skillsDir       Tarsee's bundled skills (added to the turn's folders)
 *   turnMark        a value unique to this turn, set as TARSEE_CODEX_TURN so Stop can find everything the turn started
 *   platform        for the instructions' size limit (default process.platform)
 * Throws CredentialError (engine-env's codes) when the turn can't start: a missing key, Local AI without an address,
 * a provider Codex doesn't run, no grant for the tools.
 */
export function buildCodexOptions(target, ctx = {}) {
  const id = normalizeProviderId(target?.providerId ?? target?.provider);
  if (!id) throw new TypeError(`buildCodexOptions: unknown provider ${JSON.stringify(target?.providerId ?? target?.provider)}`);
  const entry = ctx.entry || PROVIDERS[id];
  const env = ctx.env ?? process.env;
  const workspace = String(ctx.workspace ?? "").trim();
  if (!workspace) throw new TypeError("buildCodexOptions: the turn's workspace folder is required");
  if (!ctx.mcp?.url) throw new CredentialError("needs-mcp-token", "This turn has no grant for Tarsee's tools.", id);

  // Local AI: the owner's address is checked (none refuses the turn), and Codex is given the turn's bridge instead.
  let bridge = null;
  if (id === "local") {
    hostFor(entry, CODEX, { env, localUrl: ctx.localUrl });
    bridge = ctx.localBridge;
    if (!bridge?.url || !bridge?.token) throw new TypeError("buildCodexOptions: a Local AI turn goes through its bridge (ctx.localBridge {url, token})");
  }

  // The environment first: it refuses a provider Codex doesn't run, a missing key and a missing token (R4).
  const childEnv = codexEnvFor(entry, {
    env, vaultEnv: ctx.vaultEnv, key: bridge ? bridge.token : ctx.key, mcpToken: ctx.mcp.token, home: ctx.home, stateDir: ctx.stateDir,
  });
  if (ctx.turnMark) childEnv.TARSEE_CODEX_TURN = String(ctx.turnMark);

  const context = Number(ctx.contextTokens) > 0 ? Math.round(Number(ctx.contextTokens)) : Number(entry.defaultContext) || null;
  const compact = Number(ctx.compactWindow) > 0 ? Number(ctx.compactWindow) : compactWindowTokens(env.TARSEE_COMPACT_WINDOW);

  const config = {
    developer_instructions: capInstructions(ctx.developerInstructions ?? "", instructionsLimit(ctx.platform)),
    project_doc_max_bytes: 0,
    // No project root search: by default Codex treats the nearest folder above with .git as the project root and loads
    // a .codex/config.toml from every folder between it and the workspace (a trusted root's mcp_servers there would
    // get the turn's environment, its key included). With no markers the workspace is the root, and the only project
    // file Codex loads is <workspace>/.codex/config.toml, which codexConfigGuard reads before every turn.
    project_root_markers: [],
    history: { persistence: "none" },
    cli_auth_credentials_store: "file",
    check_for_update_on_startup: false,
    model_reasoning_summary: ctx.thinkingSummaries ? "concise" : "none",
    tool_output_token_limit: TOOL_OUTPUT_TOKEN_LIMIT,
    shell_environment_policy: {
      inherit: "all",
      ignore_default_excludes: true,
      filters: Object.fromEntries(CODEX_SHELL_EXCLUDED.map((n) => [n, "exclude"])),
    },
    mcp_servers: {
      tarsee: {
        url: ctx.mcp.url,
        bearer_token_env_var: "TARSEE_MCP_TOKEN",
        default_tools_approval_mode: "approve",
        required: true,
        startup_timeout_sec: MCP_STARTUP_TIMEOUT_SEC,
        tool_timeout_sec: MCP_TOOL_TIMEOUT_SEC,
      },
    },
    features: Object.fromEntries(FEATURES_OFF.map((f) => [f, false])),
  };
  if (context) config.model_auto_compact_token_limit = Math.min(compact, Math.floor(context * 0.85));

  let apiKey;
  if (id === "chatgpt") {
    config.forced_login_method = "chatgpt";
    const hosts = codexChatgptTestHosts(env);
    if (hosts) Object.assign(config, hosts);
  } else if (id === "openai") {
    config.forced_login_method = "api";
    config.openai_base_url = hostFor(entry, CODEX, { env });
    apiKey = String(ctx.key).trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  } else {
    const name = `tarsee_${id}`;
    const provider = {
      name: CUSTOM_PROVIDERS[id]?.name || entry.label || id,
      base_url: bridge ? bridge.url : hostFor(entry, CODEX, { env }),
      ...(childEnv.TARSEE_PROVIDER_KEY ? { env_key: "TARSEE_PROVIDER_KEY" } : {}),
      wire_api: "responses",
    };
    // A Local AI server that sends its headers and then nothing (a wedged GPU, a model too big for its memory) costs
    // Codex 5 minutes per try: one retry instead of five gives up in about 10 minutes, so the backup model can answer.
    // The 5 minutes themselves stay: a slow local model still streams within them.
    if (id === "local") provider.stream_max_retries = 1;
    if (id === "openrouter") {
      const headers = { "X-OpenRouter-Title": oneLine(ctx.appTitle) || entry.defaultAppTitle || "Tarsee" };
      const referer = oneLine(ctx.referer);
      if (referer) headers["HTTP-Referer"] = referer;
      provider.http_headers = headers;
    }
    config.model_provider = name;
    config.model_providers = { [name]: provider };
    config.forced_login_method = "api";
    if (context) config.model_context_window = context;
  }

  const model = codexModelFor(id, target.model, { accountModels: ctx.accountModels });
  const modelRow = id === "chatgpt" && model ? (ctx.accountModels || []).find((r) => r?.id === model) : null;
  const effort = codexEffort(target.effort, id === "chatgpt" ? modelRow?.efforts : null);

  const threadOptions = {
    ...(model ? { model } : {}),
    ...(effort ? { modelReasoningEffort: effort } : {}),
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    workingDirectory: workspace,
    skipGitRepoCheck: true,
    networkAccessEnabled: true,
    webSearchMode: "disabled",
    ...(ctx.skillsDir ? { additionalDirectories: [ctx.skillsDir] } : {}),
  };

  return { providerId: id, home: childEnv.CODEX_HOME, env: childEnv, config, apiKey, threadOptions };
}
