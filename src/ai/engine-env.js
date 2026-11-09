/**
 * engine-env.js: the environment each agent engine starts with, so a provider's turn carries exactly its own
 * credential and nothing else (design 4.5, rules R1 to R10).
 *
 * The failures this guards against are credential leaks and silent billing switches: the Claude sign-in token sent to
 * a third-party gateway, a stray ANTHROPIC_API_KEY moving plan turns onto metered billing, a Railway provider key
 * reaching the agent's shell. So every environment is built the same way (R2):
 *
 *   base  = the server's env minus every credential name, Tarsee's own secrets and the Railway provider keys
 *   env   = base + the vault's keys (so scripts read them by name) + the cost savers (Claude Code only)
 *   env   = env minus every credential name again (a vault entry can't re-add one)
 *   env   = env + this provider's credential block, and nothing else
 *
 * Hosts are code constants from the provider's registry entry (R3), read through hostFor(); the only override is the
 * test-only base-URL seam, honored only when NODE_ENV is "test" and the host is loopback. A missing key refuses the
 * turn (R4); there is never a fallback to another credential.
 *
 * The functions take the provider's registry ENTRY (PROVIDERS[id]: {id, envKey, baseUrl, models, tiers, defaultModel,
 * wrongSlot}) and the key, so this module never reads Settings or the registry itself. A bare id string is accepted
 * only for the Claude plan, which has nothing in its entry to check; any other id is refused, because without the
 * entry there is no host constant and no wrong-slot check. Everything here is pure except ensureHome() (mkdir),
 * homeIsolationRefusal(), settingsFileGuard() and codexConfigGuard() (which look at the files they guard).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { costSaverEnv } from "./context-limits.js";

/**
 * Names that choose an engine's login, billing, host or home. Stripped from every environment, then added back per
 * provider. Besides the design's list this covers every Claude sign-in or host variable the pinned CLI reads
 * (test/claude-cli-env-names.test.js scans the installed CLI so a new one is caught on an SDK bump): the whole
 * CLAUDE_CODE_OAUTH_* family (the setup token, a refresh-token login with its scopes and client id), a claude.ai
 * session cookie, the files API host, the custom and local OAuth hosts, a trusted-device token, the session-ingress
 * token file, the background sign-in snapshot, and the file-descriptor sources of a token or key.
 */
export const AUTH_ENV_RE = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_SESSION_ACCESS_TOKEN$|CLAUDE_CODE_API_BASE_URL$|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_CUSTOM_OAUTH_URL$|CLAUDE_LOCAL_OAUTH_|CLAUDE_TRUSTED_DEVICE_TOKEN$|CLAUDE_SESSION_INGRESS_TOKEN_FILE$|CLAUDE_BG_AUTH_SNAPSHOT_PATH$|CLAUDE_[A-Z0-9_]*_FILE_DESCRIPTOR$|CLAUDE_CODE_SUBAGENT_MODEL$|CLAUDE_CONFIG_DIR$|CODEX_|OPENAI_BASE_URL$|AWS_BEARER_TOKEN_BEDROCK$|TARSEE_PROVIDER_KEY$|TARSEE_CHATGPT_ACCESS_TOKEN$|TARSEE_MCP_TOKEN$)/;

/**
 * The operator's Claude sign-in variables: `claude setup-token`'s CLAUDE_CODE_OAUTH_TOKEN, or a refresh-token login
 * (CLAUDE_CODE_OAUTH_REFRESH_TOKEN with its CLAUDE_CODE_OAUTH_SCOPES, and CLAUDE_CODE_OAUTH_CLIENT_ID). Stripped like
 * every credential, then put back from the server's environment on the Claude plan only, so the plan signs in as it
 * always has and no other provider ever sees them.
 */
export const PLAN_SIGN_IN_NAMES = Object.freeze([
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_CLIENT_ID",
]);

/** Tarsee's own secrets: never in any engine's environment. */
export const TARSEE_SECRETS = Object.freeze(["ENCRYPTION_KEY", "SETUP_PASSWORD", "TARSEE_API_TOKEN"]);

/**
 * The Railway (server environment) copies of the provider keys. They reach an engine only as that provider's own
 * credential, never by name: a key the owner wants scripts to read goes in Settings > Vault instead.
 */
export const PROVIDER_KEY_NAMES = Object.freeze(["OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_KEY"]);

export const CLAUDE_CODE = "claude-code";
export const CODEX = "codex";

/**
 * A turn that must not start, and why. code is one of:
 *   needs-key             no key for a provider that needs one (R4)
 *   needs-setup           Local AI without a usable server address
 *   needs-mcp-token       a Codex turn started without its per-turn token for Tarsee's tools (a caller bug)
 *   bad-key               a key that can't be sent as-is (a line break, or the entry's wrongSlot matched)
 *   bad-model             a gateway pin that names a Claude model (it would go to the wrong host)
 *   wrong-engine          a provider on an engine it doesn't run on, or with no host there
 *   credential-isolation  a sign-in file, or a stored key, where only this provider's key belongs (R1)
 */
export class CredentialError extends Error {
  constructor(code, message, provider = null) {
    super(message);
    this.name = "CredentialError";
    this.code = code;
    this.provider = provider;
  }
}

// --- Names ---------------------------------------------------------------------------------------------------------

/**
 * True for a name AUTH_ENV_RE covers, in any case: Windows looks environment names up case-insensitively, so there an
 * "anthropic_api_key" is the same variable as ANTHROPIC_API_KEY.
 */
export function isAuthEnvName(name) {
  return AUTH_ENV_RE.test(String(name).toUpperCase());
}

const SECRET_NAMES = new Set(TARSEE_SECRETS);
const RAILWAY_KEY_NAMES = new Set(PROVIDER_KEY_NAMES);

/** True for a name R2 strips from the server's environment before anything is merged in. */
function isBaseStripped(name, extra) {
  const upper = String(name).toUpperCase();
  return AUTH_ENV_RE.test(upper) || SECRET_NAMES.has(upper) || RAILWAY_KEY_NAMES.has(upper) || extra.has(upper);
}

/** The Claude plan: public id claude, stored as claude-code. */
const PLAN_IDS = new Set(["claude", "claude-code"]);
const isPlan = (id) => PLAN_IDS.has(String(id ?? "").toLowerCase());
const canonicalId = (id) => (isPlan(id) ? "claude" : String(id ?? "").toLowerCase());
const engineName = (engine) => (engine === CODEX ? "Codex" : "Claude Code");

/** Which engines each provider runs on, and its home key there (R1; design 4.10 for the keys). */
const HOMES = {
  claude: { [CLAUDE_CODE]: "cc" },
  anthropic: { [CLAUDE_CODE]: "cc" },
  deepseek: { [CLAUDE_CODE]: "cc", [CODEX]: "cx" },
  openrouter: { [CLAUDE_CODE]: "cc", [CODEX]: "cx" },
  chatgpt: { [CODEX]: "cxd" },
  openai: { [CODEX]: "cx" },
  local: { [CODEX]: "cx" },
};

/** Providers whose key is optional (Local AI's server may need none). */
const KEY_OPTIONAL = new Set(["local"]);

/** Sign-in providers: no key, and no host of Tarsee's (the engine signs in to its own). */
const SIGN_IN_IDS = new Set(["claude", "chatgpt"]);

function entryOf(provider) {
  if (typeof provider === "string") {
    if (isPlan(provider)) return { id: provider };
    throw new TypeError(`engine-env: pass the provider's registry entry (PROVIDERS.${provider}), not its id: the entry carries its hosts and key checks`);
  }
  if (!provider || typeof provider !== "object" || !provider.id) throw new TypeError("engine-env: a provider entry with an id is required");
  return provider;
}

function assertRuns(entry, engine) {
  const id = canonicalId(entry.id);
  const runs = HOMES[id]?.[engine] && (!Array.isArray(entry.engines) || entry.engines.includes(engine));
  if (!runs) throw new CredentialError("wrong-engine", `${entry.label || id} doesn't run on ${engineName(engine)}.`, id);
  return id;
}

// --- R2 ------------------------------------------------------------------------------------------------------------

function cleanLayer(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}

/**
 * R2's first step: the server's env minus credentials, Tarsee's secrets, the Railway provider keys and any stripNames.
 * Also what agentVaultEnv() should compare against (its `env` option), so a vault key that shares a name with a
 * stripped Railway variable (OPENAI_API_KEY, say) still reaches scripts instead of being skipped as "already set".
 */
export function baseEnv(env = process.env, stripNames = []) {
  const extra = new Set(stripNames.filter(Boolean).map((n) => String(n).toUpperCase()));
  const base = {};
  for (const [k, v] of Object.entries(cleanLayer(env))) if (!isBaseStripped(k, extra)) base[k] = v;
  return base;
}

/**
 * R2 in one call: baseEnv(env, stripNames), plus the vault's keys and extraEnv, minus credentials again, plus the
 * credential block. The block always wins.
 */
export function finalizeEnv({ env = process.env, vaultEnv = {}, extraEnv = {}, credentials = {}, stripNames = [] } = {}) {
  const merged = { ...baseEnv(env, stripNames), ...cleanLayer(vaultEnv), ...cleanLayer(extraEnv) };
  for (const k of Object.keys(merged)) if (isAuthEnvName(k)) delete merged[k];
  return { ...merged, ...cleanLayer(credentials) };
}

// --- Keys ----------------------------------------------------------------------------------------------------------

/** The provider's key, trimmed of whitespace and quotes, or a refusal (R4). null when the key is optional and absent. */
function requireKey(entry, id, key, { optional = false } = {}) {
  const k = String(key ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  const label = entry.label || id;
  if (!k) {
    if (optional) return null;
    const where = entry.envKey ? ` (Settings > AI, or the ${entry.envKey} variable)` : "";
    throw new CredentialError("needs-key", `${label} needs its API key${where}.`, id);
  }
  // A line break would let the key carry a second header; a NUL can't be in an environment string at all.
  if (/[\r\n\0]/.test(k)) throw new CredentialError("bad-key", `The ${label} key has a line break in it; paste it again.`, id);
  for (const slot of entry.wrongSlot || []) {
    if (slot?.re instanceof RegExp && slot.re.test(k)) throw new CredentialError("bad-key", slot.message || `That isn't a ${label} key.`, id);
  }
  return k;
}

// --- Hosts (R3) and the test-only seam -----------------------------------------------------------------------------

function isLoopbackHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "localhost" || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** A plain http(s) URL with no user info in it, or null. */
function plainHttpUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  return url;
}

/**
 * The test-only base-URL override TARSEE_TEST_BASE_URL_<ID>, or null. Honored only when NODE_ENV is exactly "test"
 * and the URL is plain http(s) on a loopback host with no user info, so a fake server in a test can stand in for a
 * provider and nothing in production can point a stored key anywhere else.
 */
export function testBaseUrl(providerId, env = process.env) {
  if (env?.NODE_ENV !== "test") return null;
  const name = `TARSEE_TEST_BASE_URL_${String(providerId).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const raw = String(env[name] ?? "").trim();
  if (!raw) return null;
  const url = plainHttpUrl(raw);
  return url && isLoopbackHost(url.hostname) ? raw : null;
}

/**
 * The host a provider's turn goes to on an engine, the one way to get it (Codex's config and Claude Code's
 * ANTHROPIC_BASE_URL are both built from it):
 *   claude, chatgpt   null: a sign-in plan signs in to the engine's own host, and no key goes with it
 *   local             the owner's server address (opts.localUrl: ai.local.baseUrl, else TARSEE_LOCAL_AI_URL), which
 *                     must be a plain http(s) URL; none refuses the turn with needs-setup
 *   every key provider  the entry's code constant for that engine; none refuses the turn with wrong-engine, so a key
 *                     never falls through to an engine's default host (Codex's is OpenAI's)
 * The test seam stands in for any provider but the sign-in plans, in tests only.
 */
export function hostFor(provider, engine, { env = process.env, localUrl } = {}) {
  const entry = entryOf(provider);
  const id = assertRuns(entry, engine);
  if (SIGN_IN_IDS.has(id)) return null;
  const seam = testBaseUrl(id, env);
  if (seam) return seam;
  const label = entry.label || id;
  if (id === "local") {
    const raw = String(localUrl ?? "").trim();
    if (!raw) throw new CredentialError("needs-setup", `${label} has no server address yet. Add it in Settings > AI.`, id);
    if (!plainHttpUrl(raw)) throw new CredentialError("needs-setup", `${label}'s server address must be an http:// or https:// URL with no password in it.`, id);
    return raw;
  }
  const host = entry.baseUrl?.[engine];
  if (!host) throw new CredentialError("wrong-engine", `${label} has no ${engineName(engine)} host.`, id);
  return host;
}

// --- Claude Code (R2 blocks, design 4.7) ---------------------------------------------------------------------------

const oneLine = (s) => String(s ?? "").replace(/[\r\n\0]+/g, " ").trim();

/** Claude Code's "[1m]" context suffix is the engine's business, not part of a provider's model id. */
const CONTEXT_SUFFIX_RE = /\[1m\]$/i;
const bareModel = (model) => String(model ?? "").trim().replace(CONTEXT_SUFFIX_RE, "");
const ONE_MILLION = 1_000_000;

/** A model's context window from the entry's catalog (by its bare id), or NaN. */
function catalogContext(entry, model) {
  const id = bareModel(model);
  return Number(entry.models?.find((m) => m.id === id)?.context);
}

/**
 * A gateway pin: the provider's own id, with Claude Code's "[1m]" when that model's window is at least 1M (design 4.7's
 * rule for the turn's model). Every pin follows the same rule, so the main, tier and subagent pins agree.
 */
function pinOf(model, context) {
  const id = bareModel(model);
  return Number(context) >= ONE_MILLION ? `${id}[1m]` : id;
}

function gatewayPins(entry, id, opts) {
  const tiers = { ...(entry.tiers || {}), ...(opts.tiers || {}) };
  const model = bareModel(opts.model || entry.defaultModel);
  if (!model) throw new CredentialError("bad-model", `No model chosen for ${entry.label || id}.`, id);
  const context = Number(opts.contextTokens ?? catalogContext(entry, model));
  const main = pinOf(model, context);
  // A tier naming the turn's own model gets the main pin; any other is pinned by its own catalog window.
  const tier = (t) => (!t || bareModel(t) === model ? main : pinOf(t, catalogContext(entry, t)));
  const pins = {
    ANTHROPIC_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: tier(tiers.opus),
    ANTHROPIC_DEFAULT_SONNET_MODEL: tier(tiers.sonnet),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: tier(tiers.haiku),
    ANTHROPIC_DEFAULT_FABLE_MODEL: tier(tiers.fable || tiers.opus),
    ANTHROPIC_SMALL_FAST_MODEL: tier(tiers.haiku),
    CLAUDE_CODE_SUBAGENT_MODEL: main,
  };
  for (const [name, value] of Object.entries(pins)) {
    if (/^claude-/i.test(String(value))) throw new CredentialError("bad-model", `${name} names a Claude model (${value}), which ${entry.label || id} doesn't serve.`, id);
  }
  return { context, pins };
}

/** CLAUDE_CODE_MAX_CONTEXT_TOKENS and a compact window no bigger than the model's context, for a gateway model. */
function contextEnv(context, merged) {
  if (!Number.isFinite(context) || context <= 0) return {};
  const compact = Number(merged.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  const window = Number.isFinite(compact) && compact > 0 ? Math.min(compact, context) : context;
  return { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(Math.round(context)), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.round(window)) };
}

/**
 * The environment for a Claude Code turn on `provider` (its registry entry; the plan may be given as its id).
 *
 * opts:
 *   env         the server's environment (default process.env)
 *   vaultEnv    the vault's keys for scripts: agentVaultEnv({ env: baseEnv(env), ... })
 *   costSaver   extra env for Claude Code (default costSaverEnv(env))
 *   key         the provider's key (anthropic, deepseek, openrouter); never read from env here
 *   model       the turn's model id (gateways; default the entry's defaultModel; "[1m]" or not, the same model)
 *   tiers       tier overrides {fable, opus, sonnet, haiku} (OpenRouter's editable tiers)
 *   contextTokens  the turn model's context (default from entry.models; pass contextTokensFor() for OpenRouter)
 *   appTitle, referer   OpenRouter's attribution headers
 *   home        the provider's CLAUDE_CONFIG_DIR (default homeFor(id, "claude-code", opts))
 *   stateDir    Tarsee's state folder (config.STATE_DIR), required for a key home unless `home` is given
 *
 * Blocks:
 *   claude      the operator's Claude sign-in variables (PLAN_SIGN_IN_NAMES), only those set in the server's
 *               environment. Nothing else.
 *   anthropic   CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY (no ANTHROPIC_BASE_URL: it is stripped, so Claude Code uses its
 *               own default, which is the entry's constant)
 *   gateways    CLAUDE_CONFIG_DIR, ANTHROPIC_BASE_URL (constant), ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY="", every
 *               model pinned to the provider's own ids, betas, attribution and nonessential traffic off, the context.
 */
export function claudeEnvFor(provider, opts = {}) {
  const entry = entryOf(provider);
  const id = assertRuns(entry, CLAUDE_CODE);
  const env = opts.env ?? process.env;
  const costSaver = opts.costSaver ?? costSaverEnv(env);
  const stripNames = [entry.envKey];
  const merged = finalizeEnv({ env, vaultEnv: opts.vaultEnv, extraEnv: costSaver, stripNames });

  if (id === "claude") {
    const signIn = {};
    for (const name of PLAN_SIGN_IN_NAMES) {
      const value = String(env[name] ?? "").trim();
      if (value) signIn[name] = value;
    }
    return { ...merged, ...signIn };
  }

  const key = requireKey(entry, id, opts.key);
  const home = opts.home || homeFor(id, CLAUDE_CODE, opts);

  if (id === "anthropic") {
    const seam = testBaseUrl(id, env);
    return { ...merged, CLAUDE_CONFIG_DIR: home, ...(seam ? { ANTHROPIC_BASE_URL: seam } : {}), ANTHROPIC_API_KEY: key };
  }

  const baseUrl = hostFor(entry, CLAUDE_CODE, { env });
  const { context, pins } = gatewayPins(entry, id, opts);
  const block = {
    CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: "",
    ...pins,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...contextEnv(context, merged),
  };
  if (id === "openrouter") {
    const headers = [`X-OpenRouter-Title: ${oneLine(opts.appTitle) || "Tarsee"}`];
    const referer = oneLine(opts.referer);
    if (referer) headers.push(`HTTP-Referer: ${referer}`);
    block.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n");
  }
  return { ...merged, ...block };
}

// --- Codex (R2 blocks, design 4.8) ---------------------------------------------------------------------------------

/**
 * The environment for a Codex turn on `provider` (its registry entry). No base URL ever goes in it (Codex hosts go in
 * its config, from hostFor(), and OPENAI_BASE_URL is stripped), and no key is ever placed in config or argv.
 *
 * opts: env, vaultEnv, key, mcpToken (required: the per-turn token for Tarsee's MCP endpoint), home, stateDir
 * (config.STATE_DIR, required unless `home` is given).
 *
 * Blocks (all get CODEX_HOME and TARSEE_MCP_TOKEN):
 *   chatgpt     nothing else: Codex's own sign-in in its home (.codex-home)
 *   openai      nothing else in env: pass the key as the Codex SDK's apiKey, which sets CODEX_API_KEY in the child only.
 *               The key is still required here, so a missing one refuses the turn before anything starts.
 *   openrouter, deepseek, local   TARSEE_PROVIDER_KEY (the custom provider's env_key; optional for local)
 */
export function codexEnvFor(provider, opts = {}) {
  const entry = entryOf(provider);
  const id = assertRuns(entry, CODEX);
  const env = opts.env ?? process.env;
  const mcpToken = String(opts.mcpToken ?? "").trim();
  if (!mcpToken || /[\r\n\0]/.test(mcpToken)) throw new CredentialError("needs-mcp-token", "This turn has no token for Tarsee's tools.", id);
  const merged = finalizeEnv({ env, vaultEnv: opts.vaultEnv, stripNames: [entry.envKey] });
  const block = { CODEX_HOME: opts.home || homeFor(id, CODEX, opts), TARSEE_MCP_TOKEN: mcpToken };
  if (id === "openai") {
    requireKey(entry, id, opts.key);
  } else if (id !== "chatgpt") {
    const key = requireKey(entry, id, opts.key, { optional: KEY_OPTIONAL.has(id) });
    if (key) block.TARSEE_PROVIDER_KEY = key;
  }
  return { ...merged, ...block };
}

// --- Homes (R1) ----------------------------------------------------------------------------------------------------

/**
 * The credential home for a provider on an engine:
 *   claude on Claude Code              <homeDir>/.claude (the Terminal's `claude login`; /home/node/.claude on Railway)
 *   anthropic, deepseek, openrouter    <stateDir>/.claude-home-<id> (CLAUDE_CONFIG_DIR)
 *   chatgpt on Codex                   <stateDir>/.codex-home (Codex's own device sign-in)
 *   every other Codex turn             <stateDir>/.codex-home-keys
 * opts: stateDir (config.STATE_DIR: required for every home but the plan's; there is no default, because only
 * config/env.js knows where the state folder really is, a Railway volume included), homeDir (default os.homedir()).
 */
export function homeFor(providerId, engine, { stateDir, homeDir } = {}) {
  const id = canonicalId(providerId);
  if (!HOMES[id]?.[engine]) throw new CredentialError("wrong-engine", `${providerId} doesn't run on ${engine}.`, id);
  if (id === "claude") return path.join(homeDir || os.homedir(), ".claude");
  const state = String(stateDir ?? "").trim();
  if (!state) throw new TypeError(`engine-env: stateDir (config.STATE_DIR) is required for ${id}'s ${engineName(engine)} home`);
  if (engine === CLAUDE_CODE) return path.join(state, `.claude-home-${id}`);
  return path.join(state, id === "chatgpt" ? ".codex-home" : ".codex-home-keys");
}

/** The session-handle home key (design 4.10): cc on Claude Code, cxd for .codex-home, cx for .codex-home-keys; null if it can't run there. */
export function homeKeyFor(providerId, engine) {
  return HOMES[canonicalId(providerId)]?.[engine] ?? null;
}

/** Create a credential home (and its parents) owner-only, tightening one that exists. Returns the folder. */
export function ensureHome(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

const isMissing = (err) => err?.code === "ENOENT" || err?.code === "ENOTDIR";

/**
 * Whether a Claude Code global config file holds a Console key saved by `/login` (primaryApiKey). The CLI writes
 * this file on every run, so only a stored key counts. A file that isn't JSON is searched as text, so a torn write
 * can't hide one; a file that is there but can't be read counts as holding one (fail closed).
 */
function holdsLoginKey(file, readFile) {
  let text;
  try { text = String(readFile(file)); } catch (err) { return !isMissing(err); }
  try {
    const json = JSON.parse(text.replace(/^\uFEFF/, ""));
    return !!json && typeof json === "object" && typeof json.primaryApiKey === "string" && json.primaryApiKey.trim() !== "";
  } catch {
    return /"primaryApiKey"\s*:\s*"\s*[^"\s]/.test(text);
  }
}

/**
 * R1's refusal: a key home holding a sign-in or another key, so the Claude or ChatGPT sign-in, or a Console key, could
 * load in a process aimed at someone else. Returns {code, file, message} or null.
 *   - A .claude-home-* folder must hold no .credentials.json (the claude.ai sign-in), and its global config
 *     (.config.json, which the CLI reads first when it is there, else .claude.json) no primaryApiKey (a Console key
 *     a Terminal `/login` saved): on a gateway turn ANTHROPIC_API_KEY is empty, and the CLI would fall back to that
 *     key and send it to the gateway's host.
 *   - .codex-home-keys must hold no auth.json.
 * With providerId and engine, the same holds for a key home at any other path.
 */
export function homeIsolationRefusal(home, { providerId, engine, exists = fs.existsSync, readFile = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const name = path.basename(path.resolve(home));
  const id = providerId == null ? null : canonicalId(providerId);
  const keyClaudeHome = name.startsWith(".claude-home-") || (id && id !== "claude" && engine === CLAUDE_CODE);
  const keyCodexHome = name === ".codex-home-keys" || (id && id !== "chatgpt" && engine === CODEX);
  const signIn = keyClaudeHome ? ".credentials.json" : keyCodexHome ? "auth.json" : null;
  if (!signIn) return null;
  const file = path.join(home, signIn);
  if (exists(file)) {
    return {
      code: "credential-isolation",
      file,
      message: `${file} is a sign-in file in a folder meant only for an API key. Tarsee won't start this turn while it is there; delete it (or sign in from the Terminal without pointing at this folder).`,
    };
  }
  if (keyClaudeHome) {
    for (const config of [".config.json", ".claude.json"]) {
      const configFile = path.join(home, config);
      if (!holdsLoginKey(configFile, readFile)) continue;
      return {
        code: "credential-isolation",
        file: configFile,
        message: `${configFile} holds an Anthropic Console key saved by /login (primaryApiKey), in a folder meant only for this provider's key. Tarsee won't start this turn while it is there; remove the primaryApiKey entry (or run /login from the Terminal without pointing at this folder).`,
      };
    }
  }
  return null;
}

// --- Settings files (R5) -------------------------------------------------------------------------------------------

/** settingSources per provider: today's behaviour for the plan, made explicit; only the project's for every other. */
export function settingSourcesFor(providerId) {
  return isPlan(providerId) ? ["user", "project", "local"] : ["project"];
}

/**
 * The settings files a Claude Code turn would load: the home's settings.json always (the agent's Bash can write it),
 * then <workspace>/.claude/settings.json for "project" and settings.local.json for "local".
 */
export function settingsFilesFor(settingSources, { home, workspace }) {
  const files = [path.join(home, "settings.json")];
  if (settingSources.includes("project")) files.push(path.join(workspace, ".claude", "settings.json"));
  if (settingSources.includes("local")) files.push(path.join(workspace, ".claude", "settings.local.json"));
  return files;
}

/**
 * R5: refuse the turn when any settings file that will load sets a credential through its env block (a name
 * AUTH_ENV_RE covers, in any case) or defines apiKeyHelper. A file that is there but can't be read as JSON refuses
 * too (fail closed); a missing one is fine. Returns {ok, files: [{file, entries, unreadable?}], message?}; entries are
 * names like "env.ANTHROPIC_BASE_URL" and "apiKeyHelper", never values.
 */
export function settingsFileGuard(paths, { readFile = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const files = [];
  for (const file of paths) {
    let text;
    try { text = readFile(file); } catch (err) {
      if (isMissing(err)) continue;
      files.push({ file, entries: [], unreadable: true });
      continue;
    }
    let json;
    try { json = JSON.parse(String(text).replace(/^\uFEFF/, "")); } catch {
      files.push({ file, entries: [], unreadable: true });
      continue;
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) continue;
    const entries = [];
    if (json.env && typeof json.env === "object" && !Array.isArray(json.env)) {
      for (const name of Object.keys(json.env)) if (isAuthEnvName(name)) entries.push(`env.${name}`);
    }
    if (Object.hasOwn(json, "apiKeyHelper")) entries.push("apiKeyHelper");
    if (entries.length) files.push({ file, entries });
  }
  if (!files.length) return { ok: true, files: [] };
  const lines = files.map((f) => (f.unreadable ? `${f.file} (can't be read as JSON)` : `${f.file}: ${f.entries.join(", ")}`));
  return {
    ok: false,
    files,
    message: `A Claude Code settings file would change which account this AI uses, so Tarsee won't start the turn. Remove these entries: ${lines.join("; ")}`,
  };
}

// --- Codex's config.toml (R5's counterpart for Codex) --------------------------------------------------------------

/**
 * The root entries a Codex config.toml may have: what Tarsee seeds (cli_auth_credentials_store,
 * check_for_update_on_startup, forced_login_method) and what Codex itself writes there when used from the Terminal
 * (project trust, notices, the model and effort chosen, the TUI's settings). Anything else refuses the turn. An
 * allowlist, not a denylist: the agent's shell can write this file, and Codex keeps adding entries that change where
 * requests go or run a program with the turn's environment (openai_base_url, chatgpt_base_url, model_provider(s),
 * profile(s), mcp_servers, notify, plugins, a network proxy...). --config overrides on the command line don't remove
 * any of them.
 */
export const CODEX_CONFIG_ALLOWED = Object.freeze([
  "cli_auth_credentials_store", "check_for_update_on_startup", "forced_login_method",
  "projects", "notice", "model", "model_reasoning_effort", "tui",
]);
const CODEX_ALLOWED = new Set(CODEX_CONFIG_ALLOWED);

/** The Codex config files a turn would load: the home's config.toml, then the workspace's project config. */
export function codexConfigFilesFor({ home, workspace } = {}) {
  const files = [path.join(home, "config.toml")];
  if (workspace) files.push(path.join(workspace, ".codex", "config.toml"));
  return files;
}

class UnreadableToml extends Error {}

/**
 * A TOML key path at the start of `s`: bare, 'literal' or "basic" segments joined by dots, with optional spaces.
 * Returns {segments, rest}. A basic segment with an escape in it is refused (it could spell any name).
 */
function readKeyPath(s) {
  const segments = [];
  let i = 0;
  for (;;) {
    while (s[i] === " " || s[i] === "\t") i++;
    let seg;
    if (s[i] === "\"" || s[i] === "'") {
      const q = s[i];
      const end = s.indexOf(q, i + 1);
      if (end < 0) throw new UnreadableToml();
      seg = s.slice(i + 1, end);
      if (q === "\"" && seg.includes("\\")) throw new UnreadableToml();
      i = end + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) throw new UnreadableToml();
      seg = m[0];
      i += seg.length;
    }
    segments.push(seg);
    while (s[i] === " " || s[i] === "\t") i++;
    if (s[i] !== ".") break;
    i++;
  }
  return { segments, rest: s.slice(i) };
}

/**
 * The root names (each root key's or table's first segment) a config.toml sets, read line by line and strictly:
 * every line must be blank, a comment, a [table] or [[table]] header, or a key = value line. Anything else (a value
 * continued on the next line, a multi-line string) throws, so nothing can hide a root entry from the guard.
 */
function codexRootNames(text) {
  const src = String(text).replace(/^\uFEFF/, "");
  if (src.includes("\"\"\"") || src.includes("'''")) throw new UnreadableToml();
  const names = [];
  let atRoot = true;
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const header = /^\s*(\[\[?)(.*)$/.exec(line);
    if (header) {
      const { segments, rest } = readKeyPath(header[2]);
      const close = header[1] === "[[" ? "]]" : "]";
      const after = rest.trimStart();
      if (!after.startsWith(close) || !/^\s*(#.*)?$/.test(after.slice(close.length))) throw new UnreadableToml();
      names.push(segments[0]);
      atRoot = false;
      continue;
    }
    const { segments, rest } = readKeyPath(line);
    if (!rest.trimStart().startsWith("=")) throw new UnreadableToml();
    if (atRoot) names.push(segments[0]);
  }
  return names;
}

/**
 * Before every Codex turn: refuse when a config file it would load has a root entry outside CODEX_CONFIG_ALLOWED. A
 * file that is there but can't be read safely refuses too (fail closed); a missing one is fine. Returns
 * {ok, files: [{file, entries, unreadable?}], message?}; entries are root names, never values.
 */
export function codexConfigGuard(paths, { readFile = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const files = [];
  for (const file of paths) {
    let text;
    try { text = readFile(file); } catch (err) {
      if (isMissing(err)) continue;
      files.push({ file, entries: [], unreadable: true });
      continue;
    }
    let names;
    try { names = codexRootNames(text); } catch {
      files.push({ file, entries: [], unreadable: true });
      continue;
    }
    const entries = [...new Set(names.filter((n) => !CODEX_ALLOWED.has(n)))];
    if (entries.length) files.push({ file, entries });
  }
  if (!files.length) return { ok: true, files: [] };
  const lines = files.map((f) => (f.unreadable ? `${f.file} (can't be read safely)` : `${f.file}: ${f.entries.join(", ")}`));
  return {
    ok: false,
    files,
    message: `A Codex config file could change where this AI's key goes, so Tarsee won't start the turn. Remove these entries: ${lines.join("; ")}`,
  };
}
