/**
 * provider-status.js: "can this AI answer right now, and if not, what does the owner do?" (design 4.3 and 4.14).
 *
 * providerStatus(id, deps) is the one answer every readiness consumer reads: the provider cards in Settings > AI
 * (routes/ai.js), the setup check (/api/settings/setup-status), the doctor (self-heal.js checkProvider), /healthz/deep
 * and the boot line. It returns
 *   { id, label, kind, state, ready, detail, fix, keySource, keyHint, keySourceText, account, balance }
 * where state is one of PROVIDER_STATES:
 *   ready              it can answer
 *   needs-key          a key provider with no key in Settings or its Railway variable
 *   needs-sign-in      a plan nobody has signed in to (claude auth login, or ChatGPT's device code)
 *   sign-in-expired    a plan whose sign-in the engine reported as expired (the failure flag)
 *   out-of-credit      the engine reported billing, or the cached balance is empty
 *   blocked-keys-only  a plan while "API keys only" is on
 *   needs-setup        Local AI without a usable address or model
 *   error              anything else (a key pasted in the wrong slot, a rejected key, a sign-in check that failed)
 *
 * It reads Settings, the environment, the sign-in files and the failure flags the engines write (ai.<id>.status:
 * {state, at, detail}). It makes no network call: the balance it shows is the 10-minute cache (cache.<id>.balance)
 * that the Test button and the provider cards fill (provider-probes.js). It never hands out a key: only where it came
 * from ("settings", "env:NAME", "sign-in") and its last 4 characters.
 */
import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { claudeHomes as transcriptClaudeHomes } from "../lib/claude-transcript.js";
import { isEncrypted, isEncryptionEnabled } from "../lib/vault.js";
import {
  PROVIDERS,
  PROVIDER_IDS,
  getProvider,
  normalizeProviderId,
  checkKeySlot,
  keysOnly,
  keysOnlyLocked,
  activeProviderId,
  resolveModelFor,
  engineFor,
  modelsFor,
} from "./provider-registry.js";
import { PLAN_SIGN_IN_NAMES, homeFor } from "./engine-env.js";

export const PROVIDER_STATES = Object.freeze([
  "ready", "needs-key", "needs-sign-in", "sign-in-expired", "out-of-credit", "blocked-keys-only", "needs-setup", "error",
]);

/** How long a balance read from OpenRouter or DeepSeek is trusted before it is read again. */
export const BALANCE_TTL_MS = 10 * 60 * 1000;

/** The providers whose balance Tarsee reads (OpenRouter's key limit, DeepSeek's prepaid balance). */
export const BALANCE_PROVIDERS = Object.freeze(["openrouter", "deepseek"]);

// --- Small readers -------------------------------------------------------------------------------------------------

function readSetting(store, key) {
  try { return store?.get?.(key) ?? null; } catch { return null; }
}

function nonEmpty(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** "…a1b2": the last 4 characters, the only part of a key or token ever shown. */
export function hintOf(secret) {
  const s = String(secret ?? "");
  if (!s) return null;
  return s.length >= 8 ? `…${s.slice(-4)}` : "…";
}

/** A plain http(s) URL with no user info in it, or null (the same rule engine-env.js hostFor applies). */
export function plainHttpUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? "").trim()); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  return url;
}

/** Local AI's server address as the owner set it: ai.local.baseUrl, else TARSEE_LOCAL_AI_URL. "" when neither. */
export function localUrlFor(store, env = process.env) {
  return nonEmpty(readSetting(store, "ai.local.baseUrl")) ?? nonEmpty(env?.TARSEE_LOCAL_AI_URL) ?? "";
}

/**
 * The model the owner chose for a provider: its ai.<storageId>.model setting, else TARSEE_AI_MODEL when
 * TARSEE_AI_PROVIDER names this provider (the Railway-only setup). null when neither is set.
 */
export function chosenModel(idOrAlias, store, env = process.env) {
  const p = getProvider(idOrAlias);
  if (!p) return null;
  const own = nonEmpty(readSetting(store, `ai.${p.storageId}.model`));
  if (own) return own;
  if (normalizeProviderId(env?.TARSEE_AI_PROVIDER) === p.id) return nonEmpty(env?.TARSEE_AI_MODEL);
  return null;
}

/** The ChatGPT plan's sign-in folder: <stateDir>/.codex-home (CODEX_HOME on Railway points at the same place). */
export function codexHomeFor(stateDir = config.STATE_DIR) {
  return homeFor("chatgpt", "codex", { stateDir });
}

/** Where the Claude plan's `claude auth login` may have left its .credentials.json (the same candidates the audit used). */
function defaultClaudeHomes(env) {
  return env?.CLAUDE_CODE_HOME ? [env.CLAUDE_CODE_HOME] : transcriptClaudeHomes();
}

/** The Claude plan's sign-in: a Railway sign-in variable (PLAN_SIGN_IN_NAMES), else a .credentials.json. */
export function claudeSignIn({ env = process.env, claudeHomes, exists = fs.existsSync } = {}) {
  for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN"]) {
    if (!PLAN_SIGN_IN_NAMES.includes(name)) continue;
    const value = nonEmpty(env?.[name]);
    if (value) return { signedIn: true, source: `env:${name}`, hint: hintOf(value) };
  }
  const homes = (claudeHomes ? claudeHomes() : defaultClaudeHomes(env)) || [];
  for (const home of homes) {
    try { if (home && exists(path.join(home, ".credentials.json"))) return { signedIn: true, source: "sign-in", hint: null, home }; } catch { /* unreadable */ }
  }
  return { signedIn: false, source: null, hint: null };
}

/** Whether the stored copy of a setting is encrypted at rest (read raw, without decrypting it). */
function storedEncrypted(store, key) {
  try {
    const row = store?.db?.prepare?.("SELECT value FROM settings WHERE key = ?").get(key);
    if (row) return isEncrypted(row.value);
  } catch { /* a store without a database */ }
  return isEncryptionEnabled();
}

/** The key providers with a key saved in Settings (not a Railway variable), found without decrypting any. */
export function savedKeyProviders(store) {
  const out = [];
  for (const id of PROVIDER_IDS) {
    const p = PROVIDERS[id];
    if (p.kind === "subscription") continue;
    const slot = `ai.${p.storageId}.apiKey`;
    let present;
    if (typeof store?.db?.prepare === "function") {
      const row = store.db.prepare("SELECT value FROM settings WHERE key = ?").get(slot);
      present = !!row && String(row.value ?? "").trim() !== "";
    } else {
      present = !!nonEmpty(String(readSetting(store, slot) ?? ""));
    }
    if (present) out.push(p.id);
  }
  return out;
}

/** Plain words for where a credential came from. */
export function keySourceText(source, { encrypted = true, provider = null } = {}) {
  if (!source) return null;
  if (source === "settings") return encrypted ? "Saved in Tarsee (encrypted)" : "Saved in Tarsee (not encrypted: set ENCRYPTION_KEY)";
  if (source.startsWith("env:")) return `Railway variable ${source.slice(4)}`;
  if (source === "sign-in") return provider === "chatgpt" ? "Signed in with ChatGPT" : "Signed in with claude auth login";
  return source;
}

// --- Failure flags and balances ------------------------------------------------------------------------------------

/** The setting keys a provider's failure flag may be under (its public id, and the Claude plan's storage id). */
function flagKeys(p) {
  return [...new Set([`ai.${p.id}.status`, `ai.${p.storageId}.status`])];
}

/** The engines' failure flag for a provider ({state, at, detail}), or null. */
export function failureFlag(store, idOrAlias) {
  const p = getProvider(idOrAlias);
  if (!p) return null;
  let newest = null;
  for (const key of flagKeys(p)) {
    let v = readSetting(store, key);
    if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = { state: v }; } }
    if (!v || typeof v !== "object" || typeof v.state !== "string") continue;
    if (!newest || String(v.at || "") > String(newest.at || "")) newest = v;
  }
  return newest;
}

/** Clear a provider's failure flag (a new key, a passing Test, a fresh sign-in). */
export function clearFailureFlag(store, idOrAlias, opts = {}) {
  const p = getProvider(idOrAlias);
  if (!p) return;
  for (const key of flagKeys(p)) { try { store?.delete?.(key, opts); } catch { /* nothing to clear */ } }
}

/** Write a provider's failure flag (a Test that the provider turned down). */
export function setFailureFlag(store, idOrAlias, state, detail = null) {
  const p = getProvider(idOrAlias);
  if (!p) return;
  store.set(`ai.${p.id}.status`, { state, at: new Date().toISOString(), detail });
}

/**
 * A provider's cached balance, or null when there is none, it is older than BALANCE_TTL_MS, or it was read for
 * another key (keyHint differs).
 */
export function cachedBalance(store, idOrAlias, { now = Date.now(), keyHint = undefined } = {}) {
  const p = getProvider(idOrAlias);
  if (!p) return null;
  let v = readSetting(store, `cache.${p.id}.balance`);
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== "object") return null;
  const at = Number(v.at);
  if (!Number.isFinite(at) || now - at > BALANCE_TTL_MS || at - now > BALANCE_TTL_MS) return null;
  if (keyHint !== undefined && v.keyHint !== keyHint) return null;
  return v;
}

/** Cache a balance for BALANCE_TTL_MS, tied to the key it was read with (by its last 4 characters). */
export function saveBalance(store, idOrAlias, balance, { now = Date.now(), keyHint = null } = {}) {
  const p = getProvider(idOrAlias);
  if (!p || !balance) return;
  store.set(`cache.${p.id}.balance`, { ...balance, at: now, keyHint });
}

/** Forget a provider's cached balance (its key changed). */
export function clearBalance(store, idOrAlias) {
  const p = getProvider(idOrAlias);
  if (!p) return;
  try { store?.delete?.(`cache.${p.id}.balance`); } catch { /* nothing cached */ }
}

// --- Status --------------------------------------------------------------------------------------------------------

function result(p, state, { detail, fix = null, cred = null, account = null, balance = null, encrypted = true } = {}) {
  const source = cred?.source ?? null;
  return {
    id: p.id,
    label: p.label,
    kind: p.kind,
    state,
    ready: state === "ready",
    detail,
    fix,
    keySource: source,
    keyHint: cred?.hint ?? null,
    keySourceText: keySourceText(source, { encrypted, provider: p.id }),
    account,
    balance,
  };
}

function unknownProvider(idOrAlias) {
  return {
    id: String(idOrAlias ?? ""), label: String(idOrAlias ?? ""), kind: null, state: "error", ready: false,
    detail: `Tarsee doesn't know an AI called "${idOrAlias}".`, fix: null,
    keySource: null, keyHint: null, keySourceText: null, account: null, balance: null,
  };
}

/** Where to put a key right: the card, or the Railway variable it came from. */
function keyFix(p, cred) {
  const where = cred?.source?.startsWith("env:")
    ? `Fix the Railway variable ${cred.source.slice(4)}, or paste a key in Settings > AI (a saved key is used first).`
    : "Replace it in Settings > AI.";
  return where;
}

function needsKey(p) {
  const get = p.keyHelpUrl ? ` Get one at ${p.keyHelpUrl.replace(/^https:\/\//, "")}.` : "";
  return {
    detail: `${p.label} needs ${p.keyNoun}.`,
    fix: `Paste ${p.keyNoun} in Settings > AI, or set the Railway variable ${p.envKey}.${get}`,
  };
}

function blockedKeysOnly(p, env) {
  const locked = keysOnlyLocked(env);
  return result(p, "blocked-keys-only", {
    detail: `"API keys only" is on, so the ${p.label} isn't used.`,
    fix: locked
      ? "The Railway variable TARSEE_KEYS_ONLY=1 keeps API keys only on. Remove it to use a plan sign-in again."
      : "Turn off \"API keys only\" in Settings > AI to use it.",
  });
}

function signInFix(p) {
  if (p.id === "claude") {
    return "Run claude auth login in the Terminal, then click Check. Or set CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) as a Railway variable.";
  }
  return "Sign in with ChatGPT in Settings > AI (you get a one-time code to enter at auth.openai.com), or run codex login --device-auth in the Terminal.";
}

/** The failure flag as a state, or null when it doesn't apply. */
function flagState(p, flag) {
  if (!flag) return null;
  const s = String(flag.state).toLowerCase();
  const hints = p.errorHints || {};
  if (["auth", "auth-expired", "sign-in-expired", "expired"].includes(s)) {
    if (p.kind === "subscription") {
      return { state: "sign-in-expired", detail: hints.auth || `The ${p.label} sign-in has expired.`, fix: signInFix(p) };
    }
    return {
      state: "error",
      detail: hints.auth || `Your ${p.label} key was rejected.`,
      fix: "Replace the key in Settings > AI (or its Railway variable), then press Test.",
    };
  }
  if (["billing", "out-of-credit"].includes(s)) {
    const where = hints.topUpUrl ? ` at ${hints.topUpUrl.replace(/^https:\/\//, "")}` : " with the provider";
    return { state: "out-of-credit", detail: hints.billing || `${p.label} has run out of credit.`, fix: `Add credit${where}, then press Test.` };
  }
  if (s === "error") {
    // (The plans' cards have a Check button; the key cards a Test button.)
    const button = p.kind === "subscription" ? "Click Check" : "Press Test";
    return { state: "error", detail: nonEmpty(flag.detail) || `${p.label} reported an error on its last turn.`, fix: `${button} in Settings > AI to check it again.` };
  }
  return null;
}

function balanceOutOfCredit(p, balance) {
  if (!balance?.empty) return null;
  if (p.id === "openrouter") {
    return { state: "out-of-credit", detail: "Your OpenRouter key has used up its spending limit.", fix: "Raise the key's limit at openrouter.ai/settings/keys, or add credit at openrouter.ai/settings/credits." };
  }
  return { state: "out-of-credit", detail: `Your ${p.label} balance is empty.`, fix: p.errorHints?.billing || "Add credit." };
}

function planAccount(login) {
  if (!login?.email && !login?.plan) return null;
  const plan = login.plan ? String(login.plan).replace(/^./, (c) => c.toUpperCase()) : null;
  if (login.email && plan) return `${login.email} (${plan})`;
  return login.email || `${plan} plan`;
}

/**
 * codex-device-login's loginStatus() answer ({signedIn, method: "chatgpt" | "api" | "other" | null, email?, plan?})
 * as {signedIn, expired, email, plan, otherLogin}. Only a ChatGPT sign-in counts: an API-key login (or any other
 * kind) in the ChatGPT home is not one.
 */
function normalizeLogin(r) {
  if (!r || typeof r !== "object") return { signedIn: false, expired: false, otherLogin: null };
  const raw = r.method ?? r.authMode ?? r.auth_mode ?? r.mode;
  const method = raw == null || raw === "" ? null : String(raw).toLowerCase();
  const otherLogin = method && method !== "chatgpt" ? (["api", "apikey", "api_key"].includes(method) ? "api" : "other") : null;
  const expired = r.expired === true || ["sign-in-expired", "expired"].includes(String(r.state || "").toLowerCase());
  const signedIn = Boolean(r.signedIn ?? r.loggedIn ?? r.ok ?? r.ready ?? false) && !otherLogin;
  return {
    signedIn,
    expired,
    otherLogin,
    email: nonEmpty(r.email ?? r.account?.email),
    plan: nonEmpty(r.plan ?? r.planType ?? r.plan_type ?? r.account?.plan),
  };
}

async function defaultLoginStatus(opts) {
  const mod = await import("./codex-device-login.js");
  return mod.loginStatus(opts);
}

/**
 * The parts of a provider's status that need nothing but Settings, the environment and the files on disk: key
 * presence and slot, the Claude sign-in, ChatGPT's auth.json being there, Local AI's address and model, keys-only.
 * Synchronous, for the security audit; providerStatus() builds on it.
 * deps: { store, env, stateDir, claudeHomes, exists, codexHome }
 */
export function credentialPresence(idOrAlias, deps = {}) {
  const p = getProvider(idOrAlias);
  if (!p) return unknownProvider(idOrAlias);
  const { store, env = process.env, exists = fs.existsSync } = deps;

  if (p.kind === "subscription" && keysOnly(store, { env })) return blockedKeysOnly(p, env);

  if (p.id === "claude") {
    const cred = claudeSignIn({ env, claudeHomes: deps.claudeHomes, exists });
    if (!cred.signedIn) return result(p, "needs-sign-in", { detail: "Nobody has signed in to the Claude plan yet.", fix: signInFix(p) });
    const how = cred.source === "sign-in" ? "" : ` through the Railway variable ${cred.source.slice(4)}`;
    return result(p, "ready", { detail: `Signed in to your Claude plan${how}.`, cred });
  }

  if (p.id === "chatgpt") {
    const home = deps.codexHome || codexHomeFor(deps.stateDir ?? config.STATE_DIR);
    let present = false;
    try { present = exists(path.join(home, "auth.json")); } catch { /* unreadable */ }
    if (!present) return result(p, "needs-sign-in", { detail: "Nobody has signed in to ChatGPT yet.", fix: signInFix(p) });
    return result(p, "ready", { detail: "Signed in to ChatGPT.", cred: { source: "sign-in", hint: null } });
  }

  const cred = store?.getKeyWithSource ? store.getKeyWithSource(p.id) : { key: null, source: null, hint: null };
  const encrypted = cred.source === "settings" ? storedEncrypted(store, `ai.${p.storageId}.apiKey`) : true;
  const safeCred = { source: cred.source, hint: cred.hint };

  if (cred.key) {
    const slot = checkKeySlot(p.id, cred.key);
    if (!slot.ok) return result(p, "error", { detail: slot.message, fix: keyFix(p, cred), cred: safeCred, encrypted });
  }

  if (p.id === "local") {
    const raw = localUrlFor(store, env);
    if (!raw) {
      return result(p, "needs-setup", {
        detail: "Local AI has no server address yet.",
        fix: "Add your server's address in Settings > AI (its buttons fill in the usual ones, such as http://localhost:11434/v1), or set the Railway variable TARSEE_LOCAL_AI_URL.",
        cred: safeCred, encrypted,
      });
    }
    if (!plainHttpUrl(raw)) {
      return result(p, "needs-setup", {
        detail: "Local AI's address must start with http:// or https:// and have no password in it.",
        fix: "Fix the address in Settings > AI (or TARSEE_LOCAL_AI_URL).",
        cred: safeCred, encrypted,
      });
    }
    const model = chosenModel(p.id, store, env) || modelsFor(p.id)[0]?.id || null;
    if (!model) {
      return result(p, "needs-setup", {
        detail: `Local AI at ${raw} has no model chosen yet.`,
        fix: "Choose a model on the Local AI card in Settings > AI (Test lists what your server has), or set the Railway variable TARSEE_AI_MODEL to one of your server's models.",
        cred: safeCred, encrypted,
      });
    }
    return result(p, "ready", { detail: `Using your Local AI at ${raw}.`, cred: safeCred, encrypted });
  }

  if (!cred.key) return result(p, "needs-key", { ...needsKey(p), cred: safeCred });
  const from = cred.source === "settings" ? `Key saved in Tarsee (${cred.hint})` : `Key from the Railway variable ${cred.source.slice(4)} (${cred.hint})`;
  return result(p, "ready", { detail: `${from}.`, cred: safeCred, encrypted });
}

/**
 * A provider's full status (see the top of this file). Async: the ChatGPT plan asks Codex's own sign-in
 * (codex-device-login.js loginStatus).
 * deps: { store, env, stateDir, claudeHomes, exists, codexHome, loginStatus, loginCli, now, ignoreFlags }
 * ignoreFlags leaves the engines' failure flag out (the Test button asks "is the sign-in there now?"); loginCli has
 * Codex itself confirm the ChatGPT sign-in instead of reading its file.
 */
export async function providerStatus(idOrAlias, deps = {}) {
  const p = getProvider(idOrAlias);
  if (!p) return unknownProvider(idOrAlias);
  const { store, now: clock = Date.now } = deps;
  const now = typeof clock === "function" ? clock() : Number(clock) || Date.now();

  let base = credentialPresence(p.id, deps);
  if (base.state === "blocked-keys-only" || base.state === "needs-setup") return base;

  if (p.id === "chatgpt") {
    const codexHome = deps.codexHome || codexHomeFor(deps.stateDir ?? config.STATE_DIR);
    let login;
    try {
      // The cards, the doctor and the health check read Codex's sign-in file (cli:false, no process started); the
      // Test button passes loginCli so `codex login status` itself confirms it.
      login = normalizeLogin(await (deps.loginStatus || defaultLoginStatus)({ codexHome, cli: deps.loginCli === true }));
    } catch (err) {
      return result(p, "error", { detail: `Tarsee couldn't check the ChatGPT sign-in: ${err?.message || err}`, fix: "Try again in a moment; if it keeps failing, sign in again in Settings > AI." });
    }
    if (login.expired) return result(p, "sign-in-expired", { detail: p.errorHints?.auth || "The ChatGPT sign-in has expired.", fix: signInFix(p) });
    if (!login.signedIn) {
      const detail = login.otherLogin === "api"
        ? "The ChatGPT sign-in folder holds an API-key login, not a ChatGPT sign-in."
        : login.otherLogin
          ? "Codex in the ChatGPT sign-in folder is signed in some other way, not with a ChatGPT account."
          : "Nobody has signed in to ChatGPT yet.";
      return result(p, "needs-sign-in", { detail, fix: signInFix(p) });
    }
    const account = planAccount(login);
    base = result(p, "ready", { detail: account ? `Signed in as ${account}.` : "Signed in to ChatGPT.", cred: { source: "sign-in", hint: null }, account });
  }

  if (base.state !== "ready") return base;

  const flagged = deps.ignoreFlags ? null : flagState(p, failureFlag(store, p.id));
  if (flagged) return { ...base, ...flagged, ready: false };

  if (BALANCE_PROVIDERS.includes(p.id)) {
    const balance = cachedBalance(store, p.id, { now, keyHint: base.keyHint });
    if (balance) {
      const empty = balanceOutOfCredit(p, balance);
      if (empty) return { ...base, ...empty, ready: false, balance };
      return { ...base, detail: `${base.detail} ${balance.text}.`.replace(/\.\.$/, "."), balance };
    }
  }
  return base;
}

// --- The default provider ------------------------------------------------------------------------------------------

/**
 * The provider a turn uses when nothing more specific is chosen, its model and engine, and who chose it:
 * { provider, label, model, engine, chosenBy: "settings" | "env" | "default" }. model is null when the engine picks its
 * own (the ChatGPT plan before its account list is in); engine is null for an OpenRouter model that must be verified.
 */
export function activeTarget(store, { env = process.env, isShipped } = {}) {
  const provider = activeProviderId(store, { env, isShipped });
  const p = PROVIDERS[provider];
  const chosenBy = nonEmpty(readSetting(store, "ai.activeProvider")) ? "settings" : nonEmpty(env?.TARSEE_AI_PROVIDER) ? "env" : "default";
  const model = resolveModelFor(provider, chosenModel(provider, store, env), store);
  const engine = engineFor(provider, model, store);
  return { provider, label: p.label, model, engine, chosenBy };
}

/**
 * The one boot line (design 4.5 R9), e.g.
 *   [ai] default=deepseek:deepseek-flash engine=claude-code key=env:DEEPSEEK_API_KEY (…a1b2) ready
 * When the default isn't ready it adds what to do; when an ANTHROPIC_API_KEY sits in the environment while the
 * Claude plan is the default it says that key is not used (the plan's turns strip it).
 */
export async function aiBootLine(deps = {}) {
  const env = deps.env ?? process.env;
  const target = activeTarget(deps.store, { env, isShipped: deps.isShipped });
  const s = await providerStatus(target.provider, deps);
  const key = s.keySource ? `${s.keySource}${s.keyHint ? ` (${s.keyHint})` : ""}` : "none";
  let line = `[ai] default=${target.provider}:${target.model ?? "auto"} engine=${target.engine ?? "needs-verification"} key=${key} ${s.state}`;
  if (!s.ready) line += `: ${s.detail}${s.fix ? ` ${s.fix}` : ""}`;
  if (target.provider === "claude" && nonEmpty(env?.ANTHROPIC_API_KEY)) {
    line += " (ANTHROPIC_API_KEY is set but not used: the default AI is the Claude plan. To bill that key instead, choose \"Anthropic API key\" in Settings > AI.)";
  }
  return line;
}
