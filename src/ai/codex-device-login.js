/**
 * codex-device-login.js: signing in to ChatGPT through Codex's own device-code login (design amendment A1, 4.14).
 *
 * Settings > AI starts it: Tarsee runs the pinned `codex login --device-auth` with CODEX_HOME pointing at the ChatGPT
 * home (.codex-home, created owner-only), reads OpenAI's sign-in link and the one-time code off its output, and shows
 * them. The person opens the link on any device, signs in to ChatGPT and types the code. Codex then writes
 * $CODEX_HOME/auth.json and exits; the sign-in counts once that file is new and `codex login status` agrees.
 *
 *   startDeviceLogin({codexHome})  -> {url, code, expiresAt, done, cancel}
 *                                     done resolves {ok:true, method:'chatgpt', email?, plan?} or {ok:false, code, error}
 *                                     (never rejects); cancel() and the 15-minute limit kill codex and its children.
 *                                     One login per home at a time: starting again while one waits returns it.
 *   getDeviceLogin({codexHome})    -> where the current (or last) login is: waiting, signed-in, failed, cancelled, expired
 *   cancelDeviceLogin({codexHome}) -> stop the login in progress, if any
 *   loginStatus({codexHome})       -> {signedIn, method:'chatgpt'|'api'|null, email?, plan?, lastRefresh?}, never a token
 *   logout({codexHome})            -> `codex logout`, then makes sure auth.json is gone
 *
 * Only OpenAI's own device page (https://auth.openai.com/codex/device) is ever passed on: output pointing anywhere
 * else stops the login. A file Codex would load that could redirect it (codexConfigGuard, R5: the home's config.toml,
 * or any .env in it) refuses the login before codex starts, and keeps `codex login status` and `codex logout` from
 * running in that home (the status then comes from auth.json, checked:false).
 * codex runs with the server's environment minus every credential (engine-env baseEnv), so no API key or base URL
 * on the server can change what it signs in to. Errors are plain language for the person at the screen; when ChatGPT
 * has device-code sign-in switched off, the answer says where to switch it on.
 */
import fs from "node:fs";
import path from "node:path";
import { codexConfigFilesFor, codexConfigGuard, ensureHome } from "./engine-env.js";
import {
  CODEX_BASE_ARGS, CodexCliError, authFingerprint, codexChildEnv, killTree, requireCodexHome, resolveCodexBin,
  runCodex, spawnCodex, stripAnsi,
} from "./codex-cli.js";
import { redactSecrets } from "../lib/redact.js";

/** OpenAI's device sign-in page, the only link Tarsee passes on. */
export const DEVICE_LOGIN_URL = "https://auth.openai.com/codex/device";

/** What the person is told when ChatGPT has device-code sign-in switched off. */
export const DEVICE_CODE_DISABLED_MESSAGE = "In ChatGPT, open Settings → Security and, under App security, turn on \"Enable device code sign-in for Codex\"";

/** How long a one-time code lasts (the CLI says so too, and gives up after it). */
export const LOGIN_TTL_MS = 15 * 60_000;

const MESSAGES = {
  cancelled: "Sign-in was cancelled.",
  timeout: "The sign-in code expired before it was used. Start again for a new code.",
  network: "Couldn't reach OpenAI to start the sign-in. Check this server's internet connection and try again.",
  "no-code": "Codex didn't show a sign-in code in time. Check this server's internet connection and try again.",
  "not-confirmed": "Codex finished without signing in. Start again for a new code.",
  "unexpected-output": "Codex didn't show OpenAI's sign-in page, so Tarsee stopped it. Try again, or sign in from the Terminal with: codex login --device-auth",
  failed: "Codex couldn't sign in",
};

/**
 * A login that couldn't start. code: device-code-disabled, network, no-code, unexpected-output, unsafe-config,
 * home-failed, codex-missing, spawn-failed, cancelled, failed.
 */
export class DeviceLoginError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeviceLoginError";
    this.code = code;
  }
}

// --- Reading the CLI's output ---------------------------------------------------------------------------------------

/** True only for https://auth.openai.com/codex/device, with or without a query. */
function isDevicePage(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  return u.protocol === "https:" && u.hostname === "auth.openai.com" && u.port === "" && !u.username && !u.password
    && u.pathname === "/codex/device";
}

const URL_RE = /https?:\/\/[^\s"'<>]+/g;
// A code like ABCD-12345: groups of capitals and digits joined by dashes, alone on its line.
const DASHED_CODE_RE = /(?:^|[\s:])([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+)[ \t]*\n/;
const PLAIN_CODE_LINE_RE = /^[ \t]*([A-Z0-9]{6,12})[ \t]*$/;

/**
 * The link, the code and how long it lasts, from the CLI's output so far; parts are null until they've arrived. The
 * code must be followed by a line break, so a code cut off mid-stream is never taken. foreignUrl is true when a link
 * was printed that isn't OpenAI's device page.
 */
function readPrompt(text) {
  const plain = stripAnsi(text).replace(/\r\n?/g, "\n");
  let url = null;
  let from = 0;
  let foreignUrl = false;
  for (const m of plain.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:)\]]+$/, "");
    if (isDevicePage(raw)) { url = raw; from = m.index + m[0].length; break; }
    foreignUrl = true;
  }
  const after = plain.slice(from);
  const marker = /one-time code|enter (?:this|the) code/i.exec(after);
  const region = marker ? after.slice(marker.index + marker[0].length) : after;
  let code = DASHED_CODE_RE.exec(region)?.[1] ?? null;
  if (!code && marker) {
    // No dash: the first line after the instruction that is just capitals and digits, with a digit in it.
    const lines = region.split("\n");
    lines.pop(); // the last piece may be cut off
    for (const line of lines.slice(1)) {
      const m = PLAIN_CODE_LINE_RE.exec(line);
      if (m && /\d/.test(m[1])) { code = m[1]; break; }
    }
  }
  const minutes = /expires in (\d{1,3}) minutes?/i.exec(after);
  const expiresInMs = (minutes ? Number(minutes[1]) : 15) * 60_000;
  return { url, code, expiresInMs, foreignUrl: foreignUrl && !url };
}

/**
 * {url, code, expiresInMs} once the CLI has shown OpenAI's device page and a complete one-time code, else null.
 * Works on raw output: ANSI colours, CRLF, and output cut anywhere.
 */
export function parseDeviceAuthOutput(text) {
  const p = readPrompt(text);
  return p.url && p.code ? { url: p.url, code: p.code, expiresInMs: p.expiresInMs } : null;
}

/** The line that says what went wrong: the last error line, without the CLI's prefix, secrets taken out. */
function reasonLine(plain) {
  const lines = plain.split("\n").map((l) => l.trim()).filter((l) => l && !/^WARNING\b/i.test(l));
  const line = [...lines].reverse().find((l) => /error|fail|denied|invalid|unable|could not|can't/i.test(l)) ?? lines.at(-1) ?? "";
  const bare = line.replace(/^Error(?: [a-z ]+)?:\s*/i, "");
  const clean = redactSecrets(bare).replace(/\s+/g, " ").trim();
  return clean.length > 300 ? `${clean.slice(0, 297)}...` : clean;
}

/** What the CLI's error output means for the person: {code, error}. */
export function classifyLoginError(text) {
  const plain = stripAnsi(text).replace(/\r\n?/g, "\n");
  if (/device[ _-]?(?:code|auth)[\s\S]{0,80}?(?:not[ _-]?enabled|disabled|turned[ _-]?off)/i.test(plain)) {
    return { code: "device-code-disabled", error: DEVICE_CODE_DISABLED_MESSAGE };
  }
  if (/timed out after \d+ minutes?|device auth timed out/i.test(plain)) return { code: "timeout", error: MESSAGES.timeout };
  if (/failed to request device code|error sending request|connection (?:refused|reset)|dns error|failed to lookup address|network is unreachable|timed out connecting/i.test(plain)) {
    return { code: "network", error: MESSAGES.network };
  }
  const line = reasonLine(plain);
  return { code: "failed", error: line ? `${MESSAGES.failed}: ${line}` : `${MESSAGES.failed}.` };
}

// --- auth.json, read for display only ------------------------------------------------------------------------------

function jwtClaims(token) {
  const raw = typeof token === "string" ? token : typeof token?.raw_jwt === "string" ? token.raw_jwt : "";
  const part = raw.split(".")[1];
  if (!part || part.length > 16_384) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

const cleanEmail = (v) => (typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(v) ? v : undefined);
const cleanPlan = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : undefined);

/** What auth.json says, without a single token: {method, email?, plan?, lastRefresh?}, or null when there's none. */
function readAuthSummary(home) {
  let json;
  try { json = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const tokens = json.tokens && typeof json.tokens === "object" ? json.tokens : null;
  const hasTokens = !!(tokens && (tokens.refresh_token || tokens.access_token));
  const mode = String(json.auth_mode ?? "").toLowerCase();
  const hasKey = typeof json.OPENAI_API_KEY === "string" && json.OPENAI_API_KEY.trim() !== "";
  let method = null;
  if (mode.startsWith("chatgpt") || (!mode && hasTokens)) method = hasTokens ? "chatgpt" : null;
  else if (mode === "apikey" || mode === "api_key" || (!mode && hasKey)) method = hasKey ? "api" : null;
  if (!method) return null;
  const out = { method };
  if (method === "chatgpt") {
    const claims = jwtClaims(tokens.id_token) ?? {};
    const email = cleanEmail(claims.email) ?? cleanEmail(claims["https://api.openai.com/profile"]?.email);
    const plan = cleanPlan(claims["https://api.openai.com/auth"]?.chatgpt_plan_type);
    if (email) out.email = email;
    if (plan) out.plan = plan;
    const at = json.last_refresh ? new Date(json.last_refresh) : null;
    if (at && !Number.isNaN(at.getTime())) out.lastRefresh = at.toISOString();
  }
  return out;
}

/** The public status shape; details only for a ChatGPT sign-in the file agrees on. */
function statusShape(method, file) {
  if (!method) return { signedIn: false, method: null };
  const out = { signedIn: true, method };
  if (method === "chatgpt" && file?.method === "chatgpt") {
    for (const k of ["email", "plan", "lastRefresh"]) if (file[k]) out[k] = file[k];
  }
  return out;
}

/** The sign-in `codex login status` reports: chatgpt, api, other, null (not signed in), or undefined (unreadable). */
function statusMethod(text) {
  if (/\bNot logged in\b/i.test(text)) return null;
  if (/Logged in using ChatGPT/i.test(text)) return "chatgpt";
  if (/API key configured|Logged in using an API key/i.test(text)) return "api";
  if (/Logged in using/i.test(text)) return "other";
  return undefined;
}

/**
 * Who this Codex home is signed in as. By default `codex login status` decides (it only reads auth.json; it never goes
 * online) and auth.json supplies the email, plan and last refresh for display. cli:false reads the file alone. When
 * codex can't be run or its answer can't be read, the file's answer comes back with checked:false. method is
 * 'chatgpt', 'api', null, or 'other' for a sign-in Tarsee doesn't use (an access token, a cloud account).
 */
export async function loginStatus({ codexHome, codexBin, env, cli = true, timeoutMs = 15_000 } = {}) {
  const home = requireCodexHome(codexHome);
  const file = readAuthSummary(home);
  if (!cli) return statusShape(file?.method ?? null, file);
  if (!fs.existsSync(home)) return statusShape(null);
  const serverEnv = env ?? process.env;
  const unchecked = () => ({ ...statusShape(file?.method ?? null, file), checked: false });
  // A home whose files would steer codex (a proxy in its .env, a host in its config.toml): codex isn't run there.
  if (!codexConfigGuard(codexConfigFilesFor({ home, workspace: home })).ok) return unchecked();
  let bin;
  try { bin = resolveCodexBin({ codexBin, env: serverEnv }); } catch { return unchecked(); }
  let r;
  try {
    r = await runCodex(bin, [...CODEX_BASE_ARGS, "login", "status"], { env: codexChildEnv(serverEnv, home), cwd: home, timeoutMs });
  } catch {
    return unchecked();
  }
  if (r.timedOut) return unchecked();
  const method = statusMethod(stripAnsi(`${r.stderr}\n${r.stdout}`));
  if (method === undefined) return unchecked();
  return statusShape(method, file);
}

// --- The login ------------------------------------------------------------------------------------------------------

/** Logins by home: the one in progress, or the last one (for getDeviceLogin). */
const logins = new Map();

const running = (child) => !!child && child.exitCode === null && child.signalCode === null;

function waitExit(child, ms) {
  if (!running(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    child.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

function toLoginError(err) {
  if (err instanceof DeviceLoginError) return err;
  if (err instanceof CodexCliError) return new DeviceLoginError(err.code, err.message);
  return new DeviceLoginError("spawn-failed", `Codex couldn't start (${err?.code || err?.message || "unknown error"}).`);
}

/**
 * Start a ChatGPT sign-in for this Codex home. Resolves once codex has shown the link and code:
 * {url, code, expiresAt (ms since 1970), done, cancel}. Rejects with a DeviceLoginError when it can't get that far
 * (device-code sign-in switched off, no connection, an unsafe config.toml, codex missing...).
 *
 * opts: codexHome (required), env (the server's environment; credentials are stripped from it), codexBin (else
 * TARSEE_CODEX_BIN, else the pinned binary), timeoutMs (default and maximum: what the CLI says, 15 minutes),
 * startTimeoutMs (how long codex may take to show the code; 30 s), pollMs (how often auth.json is checked; 1 s).
 */
export async function startDeviceLogin({ codexHome, codexBin, env, timeoutMs = LOGIN_TTL_MS, startTimeoutMs = 30_000, pollMs = 1000 } = {}) {
  const home = requireCodexHome(codexHome);
  const current = logins.get(home);
  if (current?.status === "waiting") return current.handle;
  if (current?.status === "starting") return current.starting;
  const session = { status: "starting", startedAt: Date.now(), abort: null };
  logins.set(home, session);
  session.starting = begin(session, { home, codexBin, env: env ?? process.env, timeoutMs, startTimeoutMs, pollMs });
  try {
    return await session.starting;
  } catch (err) {
    session.status = err.code === "cancelled" ? "cancelled" : "failed";
    session.errorCode = err.code;
    session.error = err.message;
    session.finishedAt = Date.now();
    throw err;
  } finally {
    session.starting = null;
  }
}

async function begin(session, { home, codexBin, env, timeoutMs, startTimeoutMs, pollMs }) {
  let bin;
  try { bin = resolveCodexBin({ codexBin, env }); } catch (err) { throw toLoginError(err); }
  try {
    ensureHome(home);
  } catch (err) {
    throw new DeviceLoginError("home-failed", `Tarsee couldn't create the folder that keeps the ChatGPT sign-in (${err.code || err.message}).`);
  }
  const guard = codexConfigGuard(codexConfigFilesFor({ home, workspace: home }));
  if (!guard.ok) throw new DeviceLoginError("unsafe-config", guard.message);
  const before = authFingerprint(home);

  let child;
  try {
    child = spawnCodex(bin, [...CODEX_BASE_ARGS, "login", "--device-auth"], { env: codexChildEnv(env, home), cwd: home });
  } catch (err) {
    throw toLoginError(err);
  }
  child.stdin.end();
  let out = "";
  let errText = "";
  const MAX = 64 * 1024;
  child.stdout.on("data", (b) => { if (out.length < MAX) out += b; });
  child.stderr.on("data", (b) => { if (errText.length < MAX) errText += b; });
  let exitCode;
  const closed = new Promise((resolve) => child.once("close", (code) => { exitCode = code; resolve(code); }));

  // 1. Wait for the link and the code.
  const prompt = await new Promise((resolve, reject) => {
    let done = false;
    const stop = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout.off("data", check);
      child.stderr.off("data", check);
      fn();
    };
    const fail = (err) => stop(() => killTree(child).then(() => reject(err)));
    function check() {
      let p = readPrompt(out);
      if (!p.url || !p.code) p = readPrompt(`${out}\n${errText}`);
      if (p.url && p.code) return stop(() => resolve(p));
      if (p.foreignUrl && p.code) fail(new DeviceLoginError("unexpected-output", MESSAGES["unexpected-output"]));
    }
    const timer = setTimeout(() => {
      const p = readPrompt(`${out}\n${errText}`);
      if (p.foreignUrl) return fail(new DeviceLoginError("unexpected-output", MESSAGES["unexpected-output"]));
      const said = stripAnsi(errText).split("\n").some((l) => l.trim() && !/^WARNING\b/i.test(l.trim()));
      if (said) {
        const c = classifyLoginError(errText);
        return fail(new DeviceLoginError(c.code, c.error));
      }
      fail(new DeviceLoginError("no-code", MESSAGES["no-code"]));
    }, startTimeoutMs);
    timer.unref?.();
    session.abort = () => fail(new DeviceLoginError("cancelled", MESSAGES.cancelled));
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.on("error", (err) => stop(() => reject(toLoginError(err))));
    closed.then(() => {
      if (done) return;
      const p = readPrompt(`${out}\n\n${errText}\n`);
      if (p.foreignUrl && p.code) return stop(() => reject(new DeviceLoginError("unexpected-output", MESSAGES["unexpected-output"])));
      const c = classifyLoginError(`${errText}\n${out}`);
      stop(() => reject(new DeviceLoginError(c.code, c.error)));
    });
  });
  session.abort = null;

  // 2. Wait for the person to sign in.
  const startedAt = session.startedAt;
  session.status = "waiting";
  session.url = prompt.url;
  session.code = prompt.code;
  session.expiresAt = startedAt + Math.min(timeoutMs, prompt.expiresInMs);

  let finished = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const finish = async (result, status) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearInterval(poller);
    session.status = status;
    session.finishedAt = Date.now();
    if (result.ok) {
      if (result.email) session.email = result.email;
      if (result.plan) session.plan = result.plan;
      await waitExit(child, 1000); // codex exits on its own once it has saved the sign-in
    } else {
      session.errorCode = result.code;
      session.error = result.error;
    }
    await killTree(child);
    resolveDone(result);
  };

  // auth.json counts only once it is new (not the sign-in that was there before) and codex confirms it.
  let chain = Promise.resolve();
  const verify = (final) => {
    chain = chain.then(async () => {
      if (finished) return;
      let st = null;
      try { st = await loginStatus({ codexHome: home, codexBin: bin, env }); } catch {}
      if (finished) return;
      if (st?.signedIn && st.method === "chatgpt" && authFingerprint(home) !== before) {
        const result = { ok: true, method: "chatgpt" };
        if (st.email) result.email = st.email;
        if (st.plan) result.plan = st.plan;
        return finish(result, "signed-in");
      }
      if (final) return finish({ ok: false, code: "not-confirmed", error: MESSAGES["not-confirmed"] }, "failed");
    });
    return chain;
  };

  let tried = before;
  let polling = false;
  const poller = setInterval(() => {
    if (finished || polling) return;
    const now = authFingerprint(home);
    if (!now || now === tried) return;
    tried = now;
    polling = true;
    verify(false).finally(() => { polling = false; });
  }, pollMs);
  poller.unref?.();

  const timer = setTimeout(() => {
    finish({ ok: false, code: "timeout", error: MESSAGES.timeout }, "expired");
  }, Math.max(0, session.expiresAt - Date.now()));
  timer.unref?.();

  closed.then(() => {
    if (finished) return;
    if (exitCode === 0) return verify(true);
    const c = classifyLoginError(`${errText}\n${out}`);
    finish({ ok: false, code: c.code, error: c.error }, c.code === "timeout" ? "expired" : "failed");
  });

  const cancel = async () => {
    await finish({ ok: false, code: "cancelled", error: MESSAGES.cancelled }, "cancelled");
    await done;
  };
  session.handle = { url: prompt.url, code: prompt.code, expiresAt: session.expiresAt, done, cancel };
  return session.handle;
}

/**
 * Where this home's login is, for a page that polls: {status, url, code, expiresAt, startedAt, finishedAt?,
 * errorCode?, error?, email?, plan?}, or null when none has run since the server started. status is starting,
 * waiting, signed-in, failed, cancelled or expired.
 */
export function getDeviceLogin({ codexHome } = {}) {
  const s = logins.get(requireCodexHome(codexHome));
  if (!s) return null;
  const out = { status: s.status, startedAt: s.startedAt };
  for (const k of ["url", "code", "expiresAt", "finishedAt", "errorCode", "error", "email", "plan"]) {
    if (s[k] !== undefined && s[k] !== null) out[k] = s[k];
  }
  return out;
}

/** Stop this home's login if one is starting or waiting (codex is killed). True when there was one. */
export async function cancelDeviceLogin({ codexHome } = {}) {
  const s = logins.get(requireCodexHome(codexHome));
  if (s?.status === "waiting") {
    await s.handle.cancel();
    return true;
  }
  if (s?.status === "starting") {
    s.abort?.();
    await s.starting?.catch(() => {});
    return true;
  }
  return false;
}

/**
 * Sign this Codex home out: stops a login in progress, runs `codex logout` (skipped when the home's config.toml
 * fails the guard, since logging out may contact the sign-in server), then makes sure auth.json is gone.
 * Resolves {ok} or {ok:false, error}.
 */
export async function logout({ codexHome, codexBin, env } = {}) {
  const home = requireCodexHome(codexHome);
  await cancelDeviceLogin({ codexHome: home });
  if (!fs.existsSync(home)) return { ok: true };
  const serverEnv = env ?? process.env;
  const guard = codexConfigGuard(codexConfigFilesFor({ home, workspace: home }));
  let bin = null;
  try { bin = resolveCodexBin({ codexBin, env: serverEnv }); } catch {}
  if (bin && guard.ok) {
    try {
      await runCodex(bin, [...CODEX_BASE_ARGS, "logout"], { env: codexChildEnv(serverEnv, home), cwd: home, timeoutMs: 20_000 });
    } catch {}
  }
  try {
    fs.rmSync(path.join(home, "auth.json"), { force: true });
  } catch (err) {
    return { ok: false, error: `Couldn't remove the saved ChatGPT sign-in (${err.code || err.message}).` };
  }
  return { ok: true };
}
