/**
 * codex-models.js: the models the signed-in ChatGPT account can use, read live from Codex (design amendment A2).
 *
 * Tarsee never writes a ChatGPT model into its code: what a ChatGPT account may use depends on its plan, and a Free
 * plan gets far fewer models than Codex knows about. So the picker lists only what the account's own list says, and
 * when that can't be read the caller leaves the model out and Codex uses its default.
 *
 * The documented way to ask is Codex's app-server: `codex app-server` speaks JSON-RPC over stdio, and after
 * `initialize` its `model/list` method answers with the models (paged by nextCursor). One catch, seen on the pinned
 * binary: model/list also answers when nobody is signed in, and when fetching the account's list fails, with the
 * catalog bundled in the binary (it only logs "failed to refresh available models"). That catalog isn't the
 * account's. A fetch that worked is cached by Codex in $CODEX_HOME/models_cache.json, keyed to the account, so an
 * answer counts as the account's only when:
 *   - account/read says the home is signed in with ChatGPT,
 *   - no fetch failure was logged (RUST_LOG is set to "error" for this, whatever the server's says), and
 *   - models_cache.json lists every model in the answer.
 * Anything else gives [] (with a reason from readAccountModels), never a guess.
 *
 *   listAccountModels({codexHome, env}) -> [{id, label, efforts, default?, defaultEffort?, vision, description?}]
 *   readAccountModels(same)             -> {models, source:'account'|null, reason?, account?:{email?, plan?}}
 *   syncChatgptCatalog(same)            -> readAccountModels' answer, after putting its models in the registry's
 *                                          "chatgpt-models" catalog (emptied when there are none)
 *
 * codex runs with the server's environment minus every credential, in the sign-in home, after the home's config.toml
 * passes codexConfigGuard (the app-server sends the account's token to its backend, so a planted chatgpt_base_url
 * must never get it). An answer is kept for five minutes per sign-in (a new auth.json asks again); failures are never
 * kept; callers asking at the same time share one app-server.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { codexConfigFilesFor, codexConfigGuard } from "./engine-env.js";
import { setCatalogModels } from "./provider-registry.js";
import {
  CODEX_BASE_ARGS, authFingerprint, codexChildEnv, collectText, killTree, requireCodexHome, resolveCodexBin, spawnCodex,
  stripAnsi,
} from "./codex-cli.js";

const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const MAX_PAGES = 20;

let VERSION = "0";
try { VERSION = String(createRequire(import.meta.url)("../../package.json").version || "0"); } catch {}

// --- Mapping --------------------------------------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EFFORT_RE = /^[a-z][a-z0-9_-]{0,23}$/i;

/**
 * The app-server's model entries as Tarsee's: {id (the model to pass to Codex), label, efforts (the reasoning levels
 * it takes, in Codex's words), default? (true for the one Codex picks), defaultEffort?, vision, description?}.
 * Hidden entries, duplicates and entries without a usable id are left out.
 */
export function mapModelList(data) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(data) ? data : []) {
    if (!m || typeof m !== "object" || m.hidden === true) continue;
    const id = String(m.model || m.id || "").trim();
    if (!ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const efforts = [];
    for (const e of Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []) {
      const v = typeof e === "string" ? e : e?.reasoningEffort;
      if (typeof v === "string" && EFFORT_RE.test(v) && !efforts.includes(v)) efforts.push(v);
    }
    const label = typeof m.displayName === "string" && m.displayName.trim() ? m.displayName.trim() : id;
    const entry = { id, label, efforts };
    if (m.isDefault === true) entry.default = true;
    if (typeof m.defaultReasoningEffort === "string" && EFFORT_RE.test(m.defaultReasoningEffort)) entry.defaultEffort = m.defaultReasoningEffort;
    entry.vision = (Array.isArray(m.inputModalities) ? m.inputModalities : ["text", "image"]).includes("image");
    if (typeof m.description === "string" && m.description.trim()) entry.description = m.description.trim();
    out.push(entry);
  }
  return out;
}

/** The model ids in Codex's models_cache.json, or null when there is no readable cache. */
function cachedModelIds(home) {
  let json;
  try { json = JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
  const models = Array.isArray(json?.models) ? json.models : null;
  if (!models) return null;
  const ids = new Set();
  for (const m of models) {
    for (const v of [m?.slug, m?.id, m?.model]) if (typeof v === "string" && v) ids.add(v);
  }
  return ids.size ? ids : null;
}

const cleanEmail = (v) => (typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(v) ? v : undefined);
const cleanPlan = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : undefined);

function accountInfo(account) {
  const out = {};
  const email = cleanEmail(account?.email);
  const plan = cleanPlan(account?.planType);
  if (email) out.email = email;
  if (plan) out.plan = plan;
  return out;
}

// --- JSON-RPC over the app-server's stdio ----------------------------------------------------------------------------

class RpcClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.closedWith = null;
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    const end = (err) => {
      if (this.closedWith) return;
      this.closedWith = err;
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    child.on("error", (err) => end(err));
    child.once("close", () => end(new Error("codex app-server exited")));
  }

  onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== "object") return;
    if (typeof m.method === "string" && m.id !== undefined) {
      // A request from the server (an approval, say): nothing here asks for one, so refuse it.
      this.write({ id: m.id, error: { code: -32601, message: "Tarsee's model check doesn't handle this request." } });
      return;
    }
    const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(String(m.error.message ?? "app-server error")), { rpcCode: m.error.code }));
    else p.resolve(m.result);
  }

  write(msg) {
    try { this.child.stdin.write(`${JSON.stringify(msg)}\n`); } catch {}
  }

  request(method, params) {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method) {
    this.write({ method });
  }
}

class Timeout extends Error {}

const SIGN_IN_GONE = /refresh|sign in|signed out|log ?in|log out|expired|unauthori[sz]ed|\b401\b/i;

/** initialize, then account/read, then every page of model/list. */
async function converse(rpc) {
  await rpc.request("initialize", { clientInfo: { name: "tarsee", title: "Tarsee", version: VERSION } });
  rpc.notify("initialized");
  let account;
  try {
    account = (await rpc.request("account/read", { refreshToken: false }))?.account ?? null;
  } catch (err) {
    return { reason: SIGN_IN_GONE.test(err.message) ? "sign-in-expired" : "error" };
  }
  if (!account) return { reason: "not-signed-in" };
  if (account.type !== "chatgpt") return { reason: "not-chatgpt" };
  const data = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await rpc.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (Array.isArray(res?.data)) data.push(...res.data);
    cursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : null;
    if (!cursor) break;
  }
  return { data, account };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

async function askCodex({ home, env, codexBin, timeoutMs }) {
  const fail = (reason) => ({ models: [], source: null, reason });
  const guard = codexConfigGuard(codexConfigFilesFor({ home, workspace: home }));
  if (!guard.ok) return fail("unsafe-config");
  let bin;
  try { bin = resolveCodexBin({ codexBin, env }); } catch { return fail("codex-missing"); }

  let child;
  try {
    child = spawnCodex(bin, [...CODEX_BASE_ARGS, "app-server"], { env: codexChildEnv(env, home, { RUST_LOG: "error" }), cwd: home });
  } catch {
    return fail("codex-missing");
  }
  let spawnError = null;
  child.on("error", (err) => { spawnError ??= err; });
  const stderr = collectText(child.stderr);
  const closed = new Promise((resolve) => child.once("close", resolve));
  const rpc = new RpcClient(child);
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Timeout()), timeoutMs); });
  try {
    let talk;
    try {
      talk = await Promise.race([converse(rpc), timeout]);
    } catch (err) {
      if (err instanceof Timeout) return fail("timeout");
      if (spawnError) return fail(spawnError.code === "ENOENT" || spawnError.code === "EACCES" ? "codex-missing" : "error");
      return fail("error");
    }
    if (talk.reason) return fail(talk.reason);
    // Let it finish on its own, so everything it logged is in before reading the log.
    try { child.stdin.end(); } catch {}
    await Promise.race([closed, sleep(3000)]);
    if (/failed to refresh available models/i.test(stripAnsi(stderr()))) return fail("not-live");
    const cached = cachedModelIds(home);
    const models = mapModelList(talk.data);
    if (!cached || models.some((m) => !cached.has(m.id))) return fail("not-live");
    if (!models.length) return fail("empty");
    return { models, source: "account", account: accountInfo(talk.account) };
  } finally {
    clearTimeout(timer);
    await killTree(child);
  }
}

// --- Public ---------------------------------------------------------------------------------------------------------

/** Answers kept per home: {fp (the auth.json they were read with), at, result}. */
const kept = new Map();
const inflight = new Map();

/** Forget every kept answer (after a sign-out, say; a changed auth.json already does this per home). */
export function clearAccountModelsCache() {
  kept.clear();
}

const copyResult = (r) => structuredClone(r);

/**
 * The signed-in ChatGPT account's models, with where they came from: {models, source, reason?, account?}.
 * source is 'account' for the account's live list, else null with models [] and a reason: not-signed-in,
 * not-chatgpt (an API key login), sign-in-expired, not-live (Codex answered from its bundled catalog), empty,
 * timeout, unsafe-config, codex-missing or error.
 *
 * opts: codexHome (required; the ChatGPT home), env (the server's environment; credentials are stripped from it),
 * codexBin (else TARSEE_CODEX_BIN, else the pinned binary), timeoutMs (20 s), maxAgeMs (how long an answer is kept;
 * 5 minutes, 0 to always ask).
 */
export async function readAccountModels({ codexHome, env, codexBin, timeoutMs = 20_000, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const home = requireCodexHome(codexHome);
  const fp = authFingerprint(home);
  if (!fp) return { models: [], source: null, reason: "not-signed-in" };
  const hit = kept.get(home);
  if (hit && hit.fp === fp && maxAgeMs > 0 && Date.now() - hit.at < maxAgeMs) return copyResult(hit.result);
  const key = `${home}\n${fp}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = askCodex({ home, env: env ?? process.env, codexBin, timeoutMs })
      .then((result) => {
        if (result.source === "account") kept.set(home, { fp, at: Date.now(), result });
        return result;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return copyResult(await pending);
}

/**
 * The signed-in ChatGPT account's models: [{id, label, efforts, default?, defaultEffort?, vision, description?}], or
 * [] when they can't be read as the account's own (the caller then leaves the model out and Codex uses its default).
 */
export async function listAccountModels(opts = {}) {
  return (await readAccountModels(opts)).models;
}

/**
 * Fill the provider registry's "chatgpt-models" catalog (what the picker, tiers and defaults read for ChatGPT) with
 * the signed-in account's list, or empty it when the list can't be read, so no model is named and Codex picks its
 * default. Call it at boot, after a sign-in, after a sign-out, and when the picker is opened (the five-minute
 * memory above keeps that cheap). Takes listAccountModels' options; resolves readAccountModels' answer.
 */
export async function syncChatgptCatalog(opts = {}) {
  const result = await readAccountModels(opts);
  setCatalogModels("chatgpt-models", result.models);
  return result;
}
