#!/usr/bin/env node
/**
 * scripts/e2e/ai-api-e2e.mjs: the multi-provider work end to end, at the API level, through the REAL server.
 *
 * Boots `node src/server.js` on a free port with a fresh temp TARSEE_STATE_DIR, a SETUP_PASSWORD and ENCRYPTION_KEY
 * made at run time (never written to a file), NODE_ENV=test (engine-env's TARSEE_TEST_BASE_URL_<ID> seam), and a fake
 * home folder (so this machine's own ~/.claude and ~/.codex sign-ins are never used). The engines are the real ones:
 * the Agent SDK's bundled Claude Code CLI against test/fixtures/fake-anthropic.js, and the pinned codex binary against
 * test/fixtures/fake-responses.js. OpenRouter runs on both engines through one seam, so a small loopback mux sends
 * /v1/messages to the Anthropic fake and /responses to the Responses fake.
 *
 * For every shipped provider it saves a fake key through PUT /api/ai/keys/:id (a wrong-slot key first, which must be
 * refused with a helpful message), makes it the default (PUT /api/ai/active), runs a web chat turn over SSE in which
 * the fake scripts a call to Tarsee's calculator tool, checks the usage row, switches the default AI mid-conversation
 * and looks for the handoff, presses Stop mid-reply, answers 401 and looks for the provider's own words, reads the
 * cards, and deletes the key. Then the real ChatGPT device sign-in (POST/GET/DELETE /api/ai/chatgpt/login with the
 * real codex binary against auth.openai.com: no account is involved), "API keys only", GET /api/models and
 * /healthz/deep. Every key is an obvious fake; canaries sit in the server's environment where nothing may read them.
 * The server's stdout/stderr and every HTTP answer are scanned for every canary and key.
 *
 * What the fakes have to know about the pinned codex 0.167: its own newest models (gpt-6.1-*, the OpenAI key's default,
 * and OpenRouter's openai/gpt-6.1-*) get their tools as `additional_tools` input items in "code mode": only `exec`
 * (JavaScript in a V8 isolate) and a few others at the top, with Tarsee's tools nested inside it as
 * tools.mcp__tarsee__<name>(); other models get them listed outright, or behind tool_search. And a ChatGPT sign-in
 * first asks ChatGPT's backend which workspace the account routes to (GET /backend-api/wham/accounts/check), taking
 * only an HTTPS origin: the ChatGPT front is an HTTPS mux with a throwaway authority (test/fixtures/test-tls.js) that
 * answers that itself (fake-responses.js chatgptAccountsCheck) and the server's Codex trusts through SSL_CERT_FILE.
 *
 *   node scripts/e2e/ai-api-e2e.mjs [--out <dir>] [--only anthropic,deepseek,...] [--keep] [--shots <dir>]
 *   --only takes step tags: anthropic deepseek openrouter-cc openai openrouter-cx local chatgpt chatgpt-login claude
 *   keys-only. --shots saves a picture of Settings > AI at the end.
 *
 * Exit code 0 when every check passed, 1 otherwise. Results: <out>/ai-api-e2e.json, the server log next to it.
 */
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name) => pathToFileURL(path.join(ROOT, "test", "fixtures", name)).href;
const fa = await import(fixture("fake-anthropic.js"));
const fr = await import(fixture("fake-responses.js"));
const { makeTestTls } = await import(fixture("test-tls.js"));

// --- Options -------------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const OUT = path.resolve(argOf("--out") || path.join(os.tmpdir(), "tarsee-e2e-out"));
const ONLY = argOf("--only") ? new Set(argOf("--only").split(",")) : null;
const KEEP = argv.includes("--keep");
const SHOTS = argOf("--shots") ? path.resolve(argOf("--shots")) : null;
fs.mkdirSync(OUT, { recursive: true });

const rand = (n = 10) => crypto.randomBytes(n).toString("hex").slice(0, n);
const alnum = (n = 10) => rand(n).replace(/[^a-z0-9]/g, "0");

// --- Fake credentials (all obvious fakes) --------------------------------------------------------------------------

const KEYS = {
  anthropic: `sk-ant-api03-test-canary-anthropic-${alnum(10)}`,
  deepseek: `sk-testcanarydeepseek${alnum(12)}`,
  openrouter: `sk-or-v1-0000testcanaryopenrouter${alnum(10)}`,
  openai: `sk-test-canary-openai-${alnum(12)}`,
  local: `sk-test-canary-local-${alnum(12)}`,
};
/** A key of the wrong kind for each slot, and words the refusal must contain. */
const WRONG_SLOT = {
  anthropic: { key: `sk-or-v1-0000testcanarywrongslot${alnum(8)}`, words: /OpenRouter card/i },
  deepseek: { key: `sk-proj-test-canary-wrongslot-${alnum(10)}`, words: /OpenAI API key card/i },
  openrouter: { key: `sk-ant-api03-test-canary-wrongslot-${alnum(8)}`, words: /Anthropic API key card/i },
  openai: { key: `sk-ant-oat01-test-canary-wrongslot-${alnum(8)}`, words: /Claude sign-in token/i },
  local: { key: `sk-or-v1-0000testcanarywrongslotlocal${alnum(6)}`, words: /OpenRouter card/i },
};
/** Canaries in the server's environment: none of them may ever reach a fake, an HTTP answer or the log. */
const ENV_CANARIES = {
  CODEX_API_KEY: `sk-test-canary-env-codex-api-key-${rand(8)}`,
  CODEX_ACCESS_TOKEN: `sk-test-canary-env-codex-access-${rand(8)}`,
  TARSEE_PROVIDER_KEY: `sk-test-canary-env-provider-key-${rand(8)}`,
  TARSEE_MCP_TOKEN: `sk-test-canary-env-mcp-token-${rand(8)}`,
  TARSEE_CHATGPT_ACCESS_TOKEN: `sk-test-canary-env-chatgpt-${rand(8)}`,
  ANTHROPIC_AUTH_TOKEN: `sk-ant-test-canary-env-auth-token-${rand(8)}`,
  // The Claude plan's Railway sign-in: makes the plan "ready". Only a plan turn may send it, and only to Anthropic
  // itself (no seam exists for the plan), where a fake token is turned down.
  CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-test-canary-plan-${rand(12)}`,
};
const SETUP_PASSWORD = crypto.randomBytes(18).toString("base64url");
const ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.testsig${rand(6)}`;
const nowSec = Math.floor(Date.now() / 1000);
const CHATGPT_ACCESS = jwt({ exp: nowSec + 86_400 * 9, "https://api.openai.com/auth": { chatgpt_plan_type: "free", chatgpt_account_id: "acct-e2e-test" }, note: "sk-test-canary-chatgpt-access" });
const CHATGPT_ID = jwt({ email: "owner@example.com", exp: nowSec + 3600, "https://api.openai.com/auth": { chatgpt_plan_type: "free", chatgpt_account_id: "acct-e2e-test" } });
const CHATGPT_REFRESH = `rt-test-canary-${rand(16)}`;

const SECRETS = [
  ...Object.values(KEYS), ...Object.values(WRONG_SLOT).map((w) => w.key), ...Object.values(ENV_CANARIES),
  SETUP_PASSWORD, ENCRYPTION_KEY, CHATGPT_ACCESS, CHATGPT_REFRESH,
];

// --- Results -------------------------------------------------------------------------------------------------------

const results = [];
const t0 = Date.now();
function log(...a) { console.log(`[e2e ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a); }
class Fail extends Error { constructor(msg, evidence) { super(msg); this.evidence = evidence; } }
function expect(cond, msg, evidence) { if (!cond) throw new Fail(msg, evidence); }
async function check(name, fn) {
  try {
    const r = await fn();
    results.push({ name, ok: true, ...(r && typeof r === "object" ? { note: r } : {}) });
    log(`PASS ${name}`);
    return r;
  } catch (err) {
    const ev = err?.evidence ?? null;
    results.push({ name, ok: false, error: err?.message || String(err), evidence: ev });
    log(`FAIL ${name}: ${err?.message || err}${ev ? `\n      evidence: ${clip(typeof ev === "string" ? ev : JSON.stringify(ev), 1500)}` : ""}`);
    return undefined;
  }
}
const clip = (s, n = 400) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}…` : t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeoutMs = 20_000, everyMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > end) return last;
    await sleep(everyMs);
  }
}

// --- The world outside: fakes, a mux, a trap ------------------------------------------------------------------------

/** What each provider's fake does with its next main request: tool | hang | 401 | text. */
const MODES = {};
const TAGS = {};
const OPENROUTER_COST = 0.0021;

const CRED_OWNERS = () => ({
  [`x-api-key ${KEYS.anthropic}`]: "anthropic",
  [`Bearer ${KEYS.anthropic}`]: "anthropic",
  [`Bearer ${KEYS.deepseek}`]: "deepseek",
  [`Bearer ${KEYS.openrouter}`]: "openrouter",
  [`Bearer ${KEYS.openai}`]: "openai",
  [`Bearer ${KEYS.local}`]: "local",
  [`Bearer ${CHATGPT_ACCESS}`]: "chatgpt",
});
function ownerOf(headers) {
  const owners = CRED_OWNERS();
  if (headers["x-api-key"] && owners[`x-api-key ${headers["x-api-key"]}`]) return owners[`x-api-key ${headers["x-api-key"]}`];
  if (headers.authorization && owners[headers.authorization]) return owners[headers.authorization];
  return null;
}

/** Tools Codex offers as `additional_tools` input items (its newer models), as "<namespace>.<name>". */
function additionalToolNames(body) {
  const out = [];
  for (const item of body?.input || []) {
    if (item?.type !== "additional_tools") continue;
    for (const t of item.tools || []) {
      if (t?.type === "namespace") for (const s of t.tools || []) out.push(`${t.name}.${s?.name}`);
      else if (t?.name) out.push(t.name);
    }
  }
  return out;
}

/** Whose credential a recorded request carried (null: none of ours). */
function ownerOfRec(r) {
  if (r.owner !== undefined && r.owner !== null) return r.owner;
  return ownerOf(r.headers || {});
}

function toolResultText(body) {
  const blocks = fa.lastUserBlocks(body).filter((b) => b?.type === "tool_result");
  return blocks.map((b) => (typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => c?.text ?? "").join("") : "")).join(" ");
}

function anthropicScript(entry) {
  const prov = ownerOf(entry.headers);
  entry.owner = prov;
  const mode = MODES[prov === "openrouter" ? "openrouter-cc" : prov] || { kind: "text" };
  const names = fa.toolNames(entry.body);
  const main = names.some((n) => /tarsee/i.test(n));
  entry.main = main;
  const cost = prov === "openrouter" ? OPENROUTER_COST : undefined;
  if (mode.kind === "401") return { status: 401, error: { type: "authentication_error", message: "invalid x-api-key" } };
  if (!main) return { text: "ok", cost };
  if (mode.kind === "hang") return { hang: true, text: `Partial answer for ${mode.tag} that will be stopped ` };
  if (mode.kind === "tool") {
    if (fa.hasToolResult(entry.body)) {
      const res = toolResultText(entry.body);
      return { text: /= 42/.test(res) ? `The calculator says 42 [${mode.tag}].` : `The tool said something else: ${clip(res, 200)}`, cost };
    }
    const calc = names.find((n) => /tarsee_calculator$/.test(n));
    if (calc) return { toolUse: { name: calc, input: { expression: "6*7" } }, cost };
    return { text: `No calculator was offered (${names.join(",")}).`, cost };
  }
  return { text: `A plain reply [${mode.tag || prov}].`, cost };
}

function responsesHandler(body, info) {
  const prov = ownerOf(info.headers);
  const rec = info.requests[info.requests.length - 1];
  if (rec) rec.owner = prov;
  const mode = MODES[prov === "openrouter" ? "openrouter-cx" : prov] || { kind: "text" };
  if (mode.kind === "401") return { status: 401, error: { message: "Incorrect API key provided.", code: "invalid_api_key", type: "invalid_request_error" } };
  if (mode.kind === "hang") return { hang: true };
  if (mode.kind === "tool") {
    const outs = fr.functionOutputs(body).map(fr.outputText).join(" ");
    const names = [...fr.toolNames(body), ...additionalToolNames(body)];
    const searched = fr.searchedTools(body);
    if (/=\s*42/.test(outs)) return { text: `The calculator says 42 [${mode.tag}].` };
    if (fr.functionOutputs(body).length) return { text: `The tool said something else: ${clip(outs, 300)}` };
    if (names.includes("mcp__tarsee.tarsee_calculator") || searched.includes("mcp__tarsee.tarsee_calculator")) {
      return { calls: [{ name: "tarsee_calculator", namespace: "mcp__tarsee", arguments: { expression: "6*7" } }] };
    }
    if (names.includes("tool_search") && !searched.length) return { calls: [{ type: "tool_search", query: "tarsee calculator math expression" }] };
    // Codex's code mode (its newest models): Tarsee's tools are nested tools, reached only from inside `exec`.
    if (names.includes("functions.exec") || names.includes("exec")) {
      const js = [
        "const r = await tools.mcp__tarsee__tarsee_calculator({ expression: \"6*7\" });",
        "text(typeof r === \"string\" ? r : JSON.stringify(r));",
      ].join("\n");
      return { calls: [{ type: "custom", name: "exec", input: js }] };
    }
    return { text: `No calculator was offered (${names.join(",")}; searched ${searched.join(",")}).` };
  }
  return { text: `A plain reply [${mode.tag || prov}].` };
}

/** A loopback front for the two fakes: plain HTTP, or HTTPS with `tls` ({key, cert}); answer() can take a path itself. */
function startMux(aPort, rPort, { answer, tls } = {}) {
  const requests = [];
  const onRequest = (req, res) => {
    const p = (req.url || "").split("?")[0];
    const own = answer?.(req, p);
    if (own) {
      requests.push({ method: req.method, path: p, to: "mux", auth: req.headers.authorization ? "yes" : "no" });
      req.resume();
      res.writeHead(own.status || 200, { "content-type": "application/json" });
      res.end(JSON.stringify(own.body));
      return;
    }
    const toR = /\/responses$/.test(p) || (/\/models$/.test(p) && !/\/v1\/models$/.test(p));
    requests.push({ method: req.method, path: p, to: toR ? "responses" : "anthropic" });
    const up = http.request({ host: "127.0.0.1", port: toR ? rPort : aPort, method: req.method, path: req.url, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on("error", () => { try { res.destroy(); } catch { /* gone */ } });
    res.on("close", () => { try { up.destroy(); } catch { /* gone */ } });
    req.pipe(up);
  };
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, onRequest) : http.createServer(onRequest);
  server.on("upgrade", (req, socket, head) => {
    requests.push({ method: "UPGRADE", path: req.url, to: "responses" });
    const up = net.connect(rPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  const sockets = new Set();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    origin: `${tls ? "https" : "http"}://127.0.0.1:${server.address().port}`,
    requests,
    close: () => { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(() => r())); },
  })));
}

function startTrap() {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(418); res.end(); });
  server.on("upgrade", (req, socket) => { hits.push(`UPGRADE ${req.url}`); socket.destroy(); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(() => r())),
  })));
}

async function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

// --- The server ----------------------------------------------------------------------------------------------------

let server = null;
let serverLog = "";
let BASE = null;
const answers = []; // every HTTP answer body, for the canary scan

function hostEnv() {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "SystemDrive", "TEMP", "TMP", "TMPDIR", "ComSpec", "PATHEXT", "WINDIR", "windir", "LANG", "CLAUDE_CODE_GIT_BASH_PATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
}

async function bootServer({ tmp, fakeA, fakeR, mux, trap, extraEnv = {} }) {
  const port = await freePort();
  const home = path.join(tmp, "home");
  for (const d of [home, path.join(home, "AppData", "Roaming"), path.join(home, "AppData", "Local")]) fs.mkdirSync(d, { recursive: true });
  const env = {
    ...hostEnv(),
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    PORT: String(port),
    TARSEE_STATE_DIR: path.join(tmp, "state"),
    SETUP_PASSWORD, ENCRYPTION_KEY,
    NODE_ENV: "test",
    TARSEE_PHONON_AUTO_INSTALL: "0",
    TARSEE_TEST_BASE_URL_ANTHROPIC: fakeA.url,
    TARSEE_TEST_BASE_URL_DEEPSEEK: fakeA.url,
    TARSEE_TEST_BASE_URL_OPENROUTER: mux.origin,
    TARSEE_TEST_BASE_URL_OPENAI: fakeR.url,
    TARSEE_TEST_BASE_URL_CHATGPT: chatgptMux.origin,
    // The HTTPS ChatGPT front's authority, with the public roots (Node itself never reads SSL_CERT_FILE).
    SSL_CERT_FILE: CA_FILE,
    // Where a stripped host variable would send a turn if it leaked through.
    OPENAI_BASE_URL: `${trap.url}/v1`,
    ANTHROPIC_BASE_URL: trap.url,
    ...ENV_CANARIES,
    ...extraEnv,
  };
  log(`booting the server on port ${port}`);
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (b) => { serverLog += b.toString("utf8"); });
  child.stderr.on("data", (b) => { serverLog += b.toString("utf8"); });
  child.on("exit", (code, sig) => { serverLog += `\n[harness] server exited code=${code} signal=${sig}\n`; });
  server = child;
  BASE = `http://127.0.0.1:${port}`;
  const ok = await until(async () => {
    try { const r = await fetch(`${BASE}/healthz`); return r.ok; } catch { return false; }
  }, { timeoutMs: 60_000, everyMs: 300 });
  if (!ok) throw new Error(`the server didn't come up:\n${clip(serverLog, 3000)}`);
  return { port, env, home };
}

async function killTreeWin(pid) {
  if (!pid) return;
  await new Promise((resolve) => execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
}

// --- HTTP ----------------------------------------------------------------------------------------------------------

const jar = new Map();
function takeCookies(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const kv = c.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const csrf = () => decodeURIComponent(jar.get("tarsee_csrf") || "");

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json", cookie: cookieHeader(), "x-csrf-token": csrf() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  takeCookies(res);
  const text = await res.text();
  answers.push(`${method} ${p} ${res.status} ${text}`);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

/** POST /api/chat/send and read its SSE stream to the end: {status, events: [{event, data}]}. */
async function chat(body, { onEvent, timeoutMs = 240_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const events = [];
  let raw = "";
  let status = 0;
  try {
    const res = await fetch(`${BASE}/api/chat/send`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader(), "x-csrf-token": csrf() },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    status = res.status;
    if (!String(res.headers.get("content-type") || "").includes("text/event-stream")) {
      raw = await res.text();
      answers.push(`POST /api/chat/send ${status} ${raw}`);
      return { status, events, raw };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      raw += s;
      buf += s;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (!ev) continue;
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        const e = { event: ev, data: parsed, at: Date.now() };
        events.push(e);
        try { await onEvent?.(e); } catch (err) { log("onEvent threw:", err.message); }
      }
    }
  } catch (err) {
    if (ac.signal.aborted) events.push({ event: "harness-timeout", data: { timeoutMs } });
    else events.push({ event: "harness-error", data: { message: err.message } });
  } finally {
    clearTimeout(timer);
    answers.push(`POST /api/chat/send (SSE) ${status} ${raw}`);
  }
  return { status, events, raw };
}

const ofType = (events, t) => events.filter((e) => e.event === t);
const textOf = (events) => ofType(events, "text").map((e) => e.data?.content ?? "").join("");
const brief = (events) => events.filter((e) => e.event !== "heartbeat").map((e) => `${e.event}:${clip(JSON.stringify(e.data), 220)}`);

// --- Processes -----------------------------------------------------------------------------------------------------

/** Windows processes: [{pid, ppid, name, cmd}] (PowerShell CIM). */
async function processes() {
  const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const list = JSON.parse(stdout);
        resolve((Array.isArray(list) ? list : [list]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: p.CommandLine || "" })));
      } catch { resolve([]); }
    });
  });
}
function descendants(list, rootPid) {
  const out = [];
  const queue = [rootPid];
  while (queue.length) {
    const p = queue.shift();
    for (const c of list) if (c.ppid === p && !out.includes(c)) { out.push(c); queue.push(c.pid); }
  }
  return out;
}

// --- Provider plans ------------------------------------------------------------------------------------------------

/**
 * The relay: each step makes `provider` the default and takes a turn in the same chat, so every step after the first
 * is a switch mid-conversation. engine is what the turn must run on; model is chosen at run time where needed.
 */
const STEPS = [
  { tag: "anthropic", provider: "anthropic", engine: "claude-code", costNote: "exact" },
  { tag: "deepseek", provider: "deepseek", engine: "claude-code", costNote: "est", model: "deepseek-flash" },
  { tag: "openrouter-cc", provider: "openrouter", engine: "claude-code", costNote: "exact", model: "~anthropic/claude-sonnet-latest" },
  { tag: "openai", provider: "openai", engine: "codex", costNote: "est", model: "gpt-6.1-sol" },
  { tag: "openrouter-cx", provider: "openrouter", engine: "codex", costNote: null, model: null /* an openai/* slug, picked at run time */ },
  { tag: "local", provider: "local", engine: "codex", costNote: "free", model: "llama3.1:8b" },
  { tag: "chatgpt", provider: "chatgpt", engine: "codex", costNote: "plan", model: null },
];

const AUTH_WORDS = {
  anthropic: /Your Anthropic key was rejected/,
  deepseek: /Your DeepSeek key was rejected/,
  openrouter: /Your OpenRouter key was rejected/,
  openai: /Your OpenAI key was rejected/,
  local: /Your Local AI turned down Tarsee's key/,
  chatgpt: /ChatGPT sign-in has expired/,
  claude: /Claude's sign-in has expired/,
};

// --- Main ----------------------------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-e2e-api-"));
let fakeA; let fakeR; let mux; let trap; let chatgptMux; let CA_FILE;
/** The sign-in's OAuth issuer in auth.json: Codex renews a ChatGPT sign-in there, so the fake front, never auth.openai.com. */
const chatgptIssuer = () => ({ issuer: chatgptMux.origin, client_id: "app_tarsee_e2e_test" });
let exitCode = 1;

try {
  fakeA = await fa.startFakeAnthropic({ script: (entry) => anthropicScript(entry) });
  fakeR = await fr.startFakeResponses({
    handler: (body, info) => responsesHandler(body, info),
    upgrade: (headers) => {
      const prov = ownerOf(headers);
      const mode = MODES[prov === "openrouter" ? "openrouter-cx" : prov];
      return mode?.kind === "401" ? 401 : null;
    },
  });
  mux = await startMux(Number(new URL(fakeA.url).port), Number(new URL(fakeR.origin).port));
  // ChatGPT's backend in front of the Responses fake. Codex first asks which workspace the account routes to
  // (GET /backend-api/wham/accounts/check) and takes only an HTTPS origin, so this front serves HTTPS with a throwaway
  // authority (test/fixtures/test-tls.js), which the server's Codex trusts through SSL_CERT_FILE (the authority plus
  // the public roots, so the real device sign-in to auth.openai.com still works).
  const tlsKit = makeTestTls();
  CA_FILE = path.join(tmp, "test-ca-bundle.pem");
  fs.writeFileSync(CA_FILE, tlsKit.bundlePem);
  chatgptMux = await startMux(Number(new URL(fakeA.url).port), Number(new URL(fakeR.origin).port), {
    tls: { key: tlsKit.keyPem, cert: tlsKit.certPem },
    answer: (req, p) => {
      if (req.method === "GET" && fr.ACCOUNTS_CHECK_PATH.test(p)) {
        return { body: fr.chatgptAccountsCheck({ accountId: "acct-e2e-test", planType: "free", origin: chatgptMux.origin }) };
      }
      // A renewal of the sign-in (after a 401) comes here, its issuer (chatgptIssuer), and is refused: revoked.
      if (req.method === "POST" && fr.REFRESH_PATH.test(p)) return { status: 401, body: fr.chatgptRefreshRefusal("refresh_token_invalidated") };
      return null;
    },
  });
  trap = await startTrap();
  log(`fakes: anthropic ${fakeA.url}, responses ${fakeR.origin}, mux ${mux.origin}, trap ${trap.url}; temp ${tmp}`);

  const booted = await bootServer({ tmp, fakeA, fakeR, mux, trap });
  const STATE = path.join(tmp, "state");

  // Sign in
  await check("sign in with SETUP_PASSWORD and get a CSRF cookie", async () => {
    const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: SETUP_PASSWORD }) });
    takeCookies(r);
    const t = await r.text();
    answers.push(`POST /api/auth/login ${r.status} ${t}`);
    expect(r.status === 200 && jar.has("tarsee_session"), `login answered ${r.status}`, t);
    const c = await api("GET", "/api/auth/csrf");
    expect(c.status === 200 && jar.has("tarsee_csrf"), `csrf answered ${c.status}`, c.text);
  });

  const cards = async () => {
    const r = await api("GET", "/api/ai/providers");
    if (r.status !== 200) throw new Fail(`GET /api/ai/providers answered ${r.status}`, r.text);
    return { ...r.json, byId: Object.fromEntries(r.json.providers.map((c) => [c.id, c])), text: r.text };
  };

  // --- Baseline ---
  await check("GET /api/ai/providers: every provider shipped, the plan ready from its Railway sign-in, the rest waiting", async () => {
    const c = await cards();
    const ids = c.providers.map((p) => p.id);
    expect(JSON.stringify(ids) === JSON.stringify(["claude", "anthropic", "chatgpt", "openai", "openrouter", "deepseek", "local"]), `cards: ${ids}`);
    expect(c.providers.every((p) => p.shipped), "a provider isn't shipped", c.providers.map((p) => [p.id, p.shipped]));
    const st = Object.fromEntries(c.providers.map((p) => [p.id, p.state]));
    const want = { claude: "ready", anthropic: "needs-key", chatgpt: "needs-sign-in", openai: "needs-key", openrouter: "needs-key", deepseek: "needs-key", local: "needs-setup" };
    expect(JSON.stringify(st) === JSON.stringify(want), "states differ", { got: st, want });
    expect(c.byId.claude.keyHint === `…${ENV_CANARIES.CLAUDE_CODE_OAUTH_TOKEN.slice(-4)}`, `claude keyHint ${c.byId.claude.keyHint}`);
    expect(c.active.provider === "claude", `active ${c.active.provider}`);
    return { states: st };
  });

  const modelsMatchReady = async (label) => check(`GET /api/models lists only the ready providers (${label})`, async () => {
    const c = await cards();
    const ready = c.providers.filter((p) => p.ready).map((p) => p.id).sort();
    const m = await api("GET", "/api/models");
    expect(m.status === 200, `GET /api/models answered ${m.status}`, m.text);
    const groups = (m.json.groups || []).map((g) => g.provider).sort();
    const unavailable = (m.json.unavailable || []).map((u) => u.provider).sort();
    expect(JSON.stringify(groups) === JSON.stringify(ready), "groups differ from the ready cards", { groups, ready });
    const notReady = c.providers.filter((p) => !p.ready).map((p) => p.id).sort();
    expect(JSON.stringify(unavailable) === JSON.stringify(notReady), "unavailable differs from the cards that aren't ready", { unavailable, notReady });
    return { groups };
  });
  await modelsMatchReady("baseline");

  const healthFollows = async (label, provider, wantReady, wantState) => check(`/healthz/deep follows the default AI (${label})`, async () => {
    const r = await fetch(`${BASE}/healthz/deep`);
    const t = await r.text();
    answers.push(`GET /healthz/deep ${r.status} ${t}`);
    const j = JSON.parse(t);
    expect(j.ai?.provider === provider, `ai.provider ${j.ai?.provider}, want ${provider}`, j.ai);
    expect(j.ai?.ready === wantReady, `ai.ready ${j.ai?.ready}, want ${wantReady}`, j.ai);
    if (wantState) expect(j.ai?.state === wantState, `ai.state ${j.ai?.state}, want ${wantState}`, j.ai);
    if (!wantReady) expect(r.status === 503, `HTTP ${r.status} with the default AI not ready`, j.ai);
    return { status: r.status, ai: j.ai };
  });
  await healthFollows("baseline: the Claude plan", "claude", true, "ready");

  // --- ChatGPT device sign-in with the REAL codex binary ---
  if (!ONLY || ONLY.has("chatgpt-login")) {
    let start = null;
    await check("POST /api/ai/chatgpt/login (real codex): OpenAI's device link and a one-time code", async () => {
      const r = await api("POST", "/api/ai/chatgpt/login", {});
      expect(r.status === 200, `answered ${r.status}`, r.text);
      expect(r.json.state === "waiting", `state ${r.json.state}`, r.json);
      expect(r.json.url === "https://auth.openai.com/codex/device", `url ${r.json.url}`, r.json);
      expect(/^[A-Z0-9]{4,8}(-[A-Z0-9]{4,8})+$|^[A-Z0-9]{6,12}$/.test(String(r.json.code || "")), `code ${r.json.code}`, r.json);
      start = r.json;
      return { url: r.json.url, code: r.json.code, expiresAt: r.json.expiresAt };
    });
    let loginProcs = [];
    await check("GET /api/ai/chatgpt/login polls: waiting, the same link and code; the codex child is running", async () => {
      const r = await api("GET", "/api/ai/chatgpt/login");
      expect(r.status === 200 && r.json.state === "waiting", `state ${r.json?.state}`, r.json);
      expect(r.json.code === start?.code && r.json.url === start?.url, "the code or link changed", r.json);
      const list = await processes();
      loginProcs = descendants(list, server.pid).filter((p) => /device-auth/.test(p.cmd));
      expect(loginProcs.length >= 1, "no codex login --device-auth child of the server", descendants(list, server.pid).map((p) => `${p.pid} ${p.name} ${clip(p.cmd, 120)}`));
      return { children: loginProcs.map((p) => `${p.pid} ${p.name}`) };
    });
    await check("DELETE /api/ai/chatgpt/login cancels it, the codex child is gone, and polling says idle", async () => {
      const r = await api("DELETE", "/api/ai/chatgpt/login");
      expect(r.status === 200 && r.json.ok === true && r.json.state === "idle", `answered ${r.status}`, r.text);
      const gone = await until(async () => {
        const list = await processes();
        const alive = list.filter((p) => loginProcs.some((l) => l.pid === p.pid) || (descendants(list, server.pid).includes(p) && /device-auth/.test(p.cmd)));
        return alive.length === 0 ? true : null;
      }, { timeoutMs: 10_000, everyMs: 500 });
      expect(gone, "the codex login child is still running 10 s after DELETE", loginProcs);
      const g = await api("GET", "/api/ai/chatgpt/login");
      expect(g.json?.state === "idle", `GET after DELETE: ${g.text}`);
    });
  }

  // --- The relay ---
  const conv = await api("POST", "/api/chat/conversations", { title: "e2e relay" });
  const RELAY = conv.json?.id;
  log(`relay conversation ${RELAY}`);
  let prev = null;

  for (const step of STEPS) {
    if (ONLY && !ONLY.has(step.tag)) continue;
    const P = step.provider;
    const name = (s) => `${step.tag}: ${s}`;
    log(`--- ${step.tag} ---`);

    // Set up the credential
    if (KEYS[P]) {
      await check(name("PUT /api/ai/keys refuses a key from another provider's slot, helpfully"), async () => {
        const w = WRONG_SLOT[P];
        const r = await api("PUT", `/api/ai/keys/${P}`, { apiKey: w.key });
        expect(r.status === 400, `answered ${r.status}`, r.text);
        expect(w.words.test(r.json?.error || ""), `message: ${r.json?.error}`, r.text);
        const c = await cards();
        expect(c.byId[P].keySource == null || c.byId[P].keyHint !== `…${w.key.slice(-4)}`, "the refused key was stored", c.byId[P]);
      });
      if (P === "local") {
        await check(name("PUT /api/ai/providers/local sets the server address and model"), async () => {
          const r = await api("PUT", "/api/ai/providers/local", { baseUrl: fakeR.url, model: step.model });
          expect(r.status === 200, `answered ${r.status}`, r.text);
        });
      }
      await check(name("PUT /api/ai/keys saves the key: stored, encrypted, only its last 4 shown"), async () => {
        const r = await api("PUT", `/api/ai/keys/${P}`, { apiKey: KEYS[P] });
        expect(r.status === 200 && r.json.ok, `answered ${r.status}`, r.text);
        expect(r.json.keyHint === `…${KEYS[P].slice(-4)}`, `keyHint ${r.json.keyHint}`);
        expect(r.json.encrypted === true && r.json.keySource === "settings", "not encrypted / not settings", r.json);
        expect(r.json.status?.state === "ready", `state ${r.json.status?.state}`, r.json.status);
        expect(!r.text.includes(KEYS[P]), "the key came back in the answer");
      });
    } else if (P === "chatgpt") {
      await check(name("a ChatGPT sign-in file (fake tokens) makes the plan ready"), async () => {
        const home = path.join(STATE, ".codex-home");
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({
          auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
          tokens: { access_token: CHATGPT_ACCESS, refresh_token: CHATGPT_REFRESH, account_id: "acct-e2e-test", id_token: CHATGPT_ID, oauth_provenance: chatgptIssuer() },
        }));
        const c = await cards();
        expect(c.byId.chatgpt.state === "ready", `state ${c.byId.chatgpt.state}`, c.byId.chatgpt);
        return { account: c.byId.chatgpt.account };
      });
    }

    // The model, for OpenRouter on Codex: an openai/* slug from OpenRouter's live list
    if (step.tag === "openrouter-cx") {
      const m = await api("GET", "/api/ai/models/openrouter");
      const ids = (m.json?.models || []).map((x) => x.id);
      step.model = ids.find((id) => /^openai\/gpt-/.test(id) && !/image|audio|realtime|search/.test(id)) || "openai/gpt-5.5";
      log(`openrouter on codex will use ${step.model} (${ids.length} models listed)`);
    }

    await check(name("PUT /api/ai/active makes it the default"), async () => {
      const body = { provider: P };
      if (step.model && P !== "local") body.model = step.model;
      const r = await api("PUT", "/api/ai/active", body);
      expect(r.status === 200 && r.json.ok, `answered ${r.status}`, r.text);
      expect(r.json.provider === P, `provider ${r.json.provider}`);
      const c = await cards();
      expect(c.active.provider === P && c.byId[P].active, `active ${c.active.provider}`);
      return { model: r.json.model };
    });
    await healthFollows(`${step.tag} ready`, P, true, "ready");
    await modelsMatchReady(step.tag);

    // The tool turn, in the relay chat (a switch mid-conversation for every step after the first)
    MODES[step.tag === "openrouter-cc" || step.tag === "openrouter-cx" ? step.tag : P] = { kind: "tool", tag: step.tag };
    const fakeFor = step.engine === "codex" ? fakeR : fakeA;
    const before = fakeFor.requests.length;
    const turnStart = Date.now();
    const question = `[e2e:${step.tag}] What is 6*7? Use the calculator tool.`;
    let turn = null;
    await check(name("a web chat turn streams the reply, runs Tarsee's calculator tool and returns its result"), async () => {
      turn = await chat({ conversationId: RELAY, message: question });
      const ev = turn.events;
      expect(turn.status === 200, `HTTP ${turn.status}`, turn.raw);
      const sel = ofType(ev, "model_selected")[0]?.data;
      expect(sel?.provider === P, `model_selected provider ${sel?.provider}`, brief(ev));
      const errs = ofType(ev, "error");
      expect(errs.length === 0, `error events: ${errs.map((e) => e.data?.message).join(" | ")}`, brief(ev));
      const calls = ofType(ev, "tool_call");
      expect(calls.some((c) => /tarsee_calculator/.test(c.data?.name)), `tool calls: ${calls.map((c) => c.data?.name)}`, brief(ev));
      const res = ofType(ev, "tool_result");
      expect(res.some((r) => /6\*7 = 42/.test(r.data?.result || "")), `tool results: ${res.map((r) => clip(r.data?.result, 100))}`, brief(ev));
      expect(textOf(ev).includes(`The calculator says 42 [${step.tag}]`), `reply text: ${clip(textOf(ev), 300)}`, brief(ev));
      const dones = ofType(ev, "done");
      expect(dones.length === 1, `${dones.length} done events`, brief(ev));
      expect(dones[0].data?.provider === P, `done provider ${dones[0].data?.provider}`, dones[0].data);
      return { model: sel?.model, engine: step.engine, label: sel?.label };
    });
    const turnReqs = fakeFor.requests.slice(before).filter((r) => ownerOfRec(r) === P);

    // The credential that went out: this provider's own, and nothing else
    await check(name("only this provider's own credential reached its fake; no canary"), async () => {
      expect(turnReqs.length > 0, "the fake got no request from this provider", fakeFor.requests.slice(before).map((r) => `${r.method} ${r.path} owner=${r.owner} auth=${clip(r.headers?.authorization, 30)} x-api-key=${clip(r.headers?.["x-api-key"], 30)}`));
      // A request with no credential at all (the CLI's HEAD /api/hello) carries nothing to leak.
      const credOf = (r) => String(r.headers?.authorization || r.headers?.["x-api-key"] || "").trim();
      const strangers = fakeFor.requests.slice(before).filter((r) => credOf(r) && ownerOfRec(r) !== P);
      expect(strangers.length === 0, "requests in this turn carried no credential of this provider", strangers.map((r) => ({ m: r.method, p: r.path, auth: clip(r.headers?.authorization, 40), xk: clip(r.headers?.["x-api-key"], 40) })));
      const text = JSON.stringify(fakeFor.requests.slice(before).map((r) => ({ h: r.headers, b: r.body })));
      const others = SECRETS.filter((s) => s !== KEYS[P] && !(P === "chatgpt" && s === CHATGPT_ACCESS) && text.includes(s));
      expect(others.length === 0, "another secret reached the fake", others.map((s) => `${s.slice(0, 18)}…`));
    });

    // The handoff: the previous provider's exchange is in this provider's first request
    if (prev) {
      await check(name(`switching from ${prev.tag} mid-conversation hands the conversation over`), async () => {
        const first = turnReqs.find((r) => JSON.stringify(r.body || "").includes(`[e2e:${step.tag}]`));
        expect(first, "no request carried this turn's question", turnReqs.map((r) => `${r.method} ${r.path}`));
        const s = JSON.stringify(first.body);
        expect(s.includes(`[e2e:${prev.tag}] What is 6*7?`), `the first request doesn't carry ${prev.tag}'s question`, clip(s, 1500));
        expect(s.includes(`The calculator says 42 [${prev.tag}]`), `the first request doesn't carry ${prev.tag}'s answer`, clip(s, 1500));
      });
    }

    // The usage row
    await check(name("a usage row with the right provider, model and cost"), async () => {
      const want = ofType(turn?.events || [], "model_selected")[0]?.data?.model ?? null;
      // The row appears at turn_end; its tokens and model once the engine's calls are read (a transcript, or
      // Codex's own record): wait for those, and for the turn to be over (a read landing mid-turn can hold only
      // its first call), up to 40 s.
      let row = null;
      await until(async () => {
        const r = await api("GET", `/api/analytics/usage/chat/${RELAY}`);
        const rows = (r.json?.recent || []).filter((t) => t.provider === P && t.startedAt >= turnStart - 2000);
        row = rows.length ? rows[rows.length - 1] : null;
        return row && !row.running && (row.input || 0) + (row.output || 0) > 0 && (row.model || row.modelId) ? row : null;
      }, { timeoutMs: 40_000, everyMs: 1000 });
      expect(row, "no usage row for this turn", (await api("GET", `/api/analytics/usage/chat/${RELAY}`)).json?.recent?.slice(-4));
      expect((row.input || 0) + (row.output || 0) > 0, `the row has no tokens 40 s after the turn (calls ${row.calls})`, row);
      const bareWant = String(want ?? "").replace(/\[1m\]$/, "");
      const gotModel = String(row.modelId ?? row.model ?? "");
      const tierOk = /^(fable|opus|sonnet|haiku)$/.test(bareWant) && gotModel.includes(bareWant);
      expect(!want || tierOk || gotModel === bareWant || gotModel === want || String(row.model) === bareWant, `model ${row.model}/${row.modelId}, want ${want}`, row);
      if (step.costNote) expect(row.costNote === step.costNote, `costNote ${row.costNote}, want ${step.costNote}`, row);
      if (step.costNote === "plan") expect(row.costUsd == null, `a plan turn has a cost ${row.costUsd}`, row);
      if (step.costNote === "free") expect(row.costUsd === 0 || row.costUsd == null, `a free turn costs ${row.costUsd}`, row);
      if (step.costNote === "exact" || step.costNote === "est") expect(row.costUsd > 0, `cost ${row.costUsd}`, row);
      if (step.tag === "openrouter-cc") {
        const replies = turnReqs.filter((r) => r.method === "POST" && /\/v1\/messages$/.test(r.path)).length;
        expect(Math.abs(row.costUsd - replies * OPENROUTER_COST) < 1e-6, `OpenRouter's own cost: ${row.costUsd}, want ${replies} x ${OPENROUTER_COST}`, row);
      }
      if (step.tag === "deepseek") {
        const peak = isDeepSeekPeak(new Date(turnStart));
        const f = peak ? 1 : 0.5;
        const calls = turnReqs.filter((r) => r.method === "POST" && /\/v1\/messages$/.test(r.path)).length;
        const wantCost = calls * (12 * 0.3 * f + 6 * 1.2 * f) / 1e6;
        expect(Math.abs(row.costUsd - wantCost) < 1e-9, `DeepSeek cost ${row.costUsd}, want ${wantCost} (${calls} calls, ${peak ? "peak" : "off-peak"})`, row);
      }
      return { provider: row.provider, model: row.model, modelId: row.modelId, engine: row.engine, costUsd: row.costUsd, costNote: row.costNote, input: row.input, output: row.output };
    });

    // Stop mid-reply, in a chat of its own
    const side = (await api("POST", "/api/chat/conversations", { title: `e2e side ${step.tag}` })).json?.id;
    MODES[step.tag === "openrouter-cc" || step.tag === "openrouter-cx" ? step.tag : P] = { kind: "hang", tag: step.tag };
    await check(name("Stop mid-reply ends the stream with exactly one done and no error"), async () => {
      const beforeStop = fakeFor.requests.length;
      let stopped = null;
      const stopNow = async () => {
        if (stopped) return;
        stopped = api("POST", "/api/chat/stop", { conversationId: side });
      };
      const watcher = setInterval(() => {
        // Codex answers a message at a time: once the fake holds the request, stop.
        if (step.engine === "codex" && fakeFor.requests.slice(beforeStop).some((r) => ownerOfRec(r) === P && (r.method === "POST" || r.method === "WS") && !r.prewarm)) stopNow();
      }, 200);
      const fallback = setTimeout(stopNow, 45_000);
      const t = await chat({ conversationId: side, message: `[e2e:${step.tag}] Tell me a long story.` }, {
        onEvent: (e) => { if (e.event === "text" && step.engine === "claude-code") stopNow(); },
        timeoutMs: 120_000,
      });
      clearInterval(watcher);
      clearTimeout(fallback);
      const s = await stopped;
      const ev = t.events;
      expect(s?.json?.stopped === true, `POST /api/chat/stop answered ${s?.text}`, brief(ev));
      const dones = ofType(ev, "done");
      expect(dones.length === 1, `${dones.length} done events`, brief(ev));
      expect(ofType(ev, "error").length === 0, `error events: ${ofType(ev, "error").map((e) => e.data?.message)}`, brief(ev));
      expect(!ofType(ev, "harness-timeout").length, "the stream didn't end after Stop", brief(ev));
      const after = await api("GET", `/api/chat/conversations/${side}?limit=5`);
      expect(after.json?.activeTurn == null, "the conversation still shows a turn at work after Stop", after.json?.activeTurn);
      return { done: dones[0]?.data, stopReasonOnDone: dones[0]?.data?.stopReason ?? null };
    });

    // A 401 from the fake: the provider's own words
    {
      MODES[step.tag === "openrouter-cc" || step.tag === "openrouter-cx" ? step.tag : P] = { kind: "401", tag: step.tag };
      await check(name("a 401 gives the provider's own plain-language message, and the card says so"), async () => {
        const t = await chat({ conversationId: side, message: `[e2e:${step.tag}] Hello again.` }, { timeoutMs: 180_000 });
        const ev = t.events;
        const errs = ofType(ev, "error").map((e) => e.data?.message || "");
        const words = AUTH_WORDS[P];
        expect(errs.some((m) => words.test(m)), `error events: ${errs.map((m) => clip(m, 200)).join(" | ") || "(none)"}`, brief(ev));
        expect(ofType(ev, "done").length === 1, `${ofType(ev, "done").length} done events`, brief(ev));
        const c = await cards();
        const card = c.byId[P];
        const wantState = P === "chatgpt" ? "sign-in-expired" : "error";
        expect(card.state === wantState, `card state ${card.state}, want ${wantState}`, card);
        return { error: clip(errs[0], 200), card: { state: card.state, detail: card.detail } };
      });
    }
    MODES[step.tag === "openrouter-cc" || step.tag === "openrouter-cx" ? step.tag : P] = { kind: "text", tag: step.tag };

    // The cards: state and keyHint, never the key
    await check(name("GET /api/ai/providers shows the card's keyHint and never the key"), async () => {
      const c = await cards();
      const card = c.byId[P];
      if (KEYS[P]) expect(card.keyHint === `…${KEYS[P].slice(-4)}`, `keyHint ${card.keyHint}`, card);
      for (const k of Object.values(KEYS)) expect(!c.text.includes(k), "a key is in GET /api/ai/providers");
      expect(!c.text.includes(CHATGPT_ACCESS) && !c.text.includes(CHATGPT_REFRESH), "a ChatGPT token is in GET /api/ai/providers");
      return { state: card.state, keyHint: card.keyHint, keySourceText: card.keySourceText };
    });

    // Delete the key (or sign out)
    if (KEYS[P]) {
      await check(name("DELETE /api/ai/keys: the provider reports needs-key, and /healthz/deep says so"), async () => {
        const r = await api("DELETE", `/api/ai/keys/${P}`);
        expect(r.status === 200 && r.json.ok, `answered ${r.status}`, r.text);
        if (P === "local") {
          expect(r.json.status?.state === "ready" && r.json.status?.keySource == null, `Local AI after delete: ${r.json.status?.state} ${r.json.status?.keySource}`, r.json.status);
        } else {
          expect(r.json.status?.state === "needs-key", `state ${r.json.status?.state}`, r.json.status);
          const c = await cards();
          expect(c.byId[P].state === "needs-key" && c.byId[P].keyHint == null, `card ${c.byId[P].state} ${c.byId[P].keyHint}`);
        }
      });
      if (P !== "local") await healthFollows(`${step.tag} key deleted`, P, false, "needs-key");
    } else if (P === "chatgpt") {
      await check(name("POST /api/ai/chatgpt/logout signs out: needs-sign-in"), async () => {
        const r = await api("POST", "/api/ai/chatgpt/logout", {});
        expect(r.status === 200 && r.json.ok, `answered ${r.status}`, r.text);
        expect(r.json.status?.state === "needs-sign-in", `state ${r.json.status?.state}`, r.json.status);
        expect(!fs.existsSync(path.join(STATE, ".codex-home", "auth.json")), "auth.json is still there");
      });
    }
    prev = step;
  }

  // --- The Claude plan: no seam exists, so its (fake) sign-in goes to Anthropic itself and is turned down ---
  if (!ONLY || ONLY.has("claude")) {
    await check("claude: PUT /api/ai/active claude (ready from CLAUDE_CODE_OAUTH_TOKEN)", async () => {
      const r = await api("PUT", "/api/ai/active", { provider: "claude" });
      expect(r.status === 200 && r.json.provider === "claude", `answered ${r.status}`, r.text);
    });
    await healthFollows("the Claude plan again", "claude", true, "ready");
    await check("claude: a turn with a turned-down sign-in says to run claude auth login, once", async () => {
      const side = (await api("POST", "/api/chat/conversations", { title: "e2e plan" })).json?.id;
      const before = fakeA.requests.length + fakeR.requests.length;
      const t = await chat({ conversationId: side, message: "[e2e:claude] Hello." }, { timeoutMs: 180_000 });
      const ev = t.events;
      const errs = ofType(ev, "error").map((e) => e.data?.message || "");
      expect(ofType(ev, "model_selected")[0]?.data?.provider === "claude", "not routed to the plan", brief(ev));
      expect(errs.some((m) => AUTH_WORDS.claude.test(m)), `errors: ${errs.map((m) => clip(m, 200)).join(" | ") || "(none)"}`, brief(ev));
      expect(ofType(ev, "done").length === 1, `${ofType(ev, "done").length} done events`, brief(ev));
      expect(fakeA.requests.length + fakeR.requests.length === before, "a plan turn reached a fake (test seam honoured for the plan?)");
      const c = await cards();
      expect(c.byId.claude.state === "sign-in-expired", `card ${c.byId.claude.state}`, c.byId.claude);
      return { error: clip(errs[0], 160) };
    });
  }

  // --- API keys only ---
  if (!ONLY || ONLY.has("keys-only")) {
    await api("PUT", "/api/ai/keys/deepseek", { apiKey: KEYS.deepseek });
    await api("PUT", "/api/ai/active", { provider: "deepseek" });
    // A plan sign-in present, so "API keys only" is what turns it off
    const home = path.join(STATE, ".codex-home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
      tokens: { access_token: CHATGPT_ACCESS, refresh_token: CHATGPT_REFRESH, account_id: "acct-e2e-test", id_token: CHATGPT_ID, oauth_provenance: chatgptIssuer() },
    }));
    await check("keys-only: PUT /api/ai/keys-only on", async () => {
      const r = await api("PUT", "/api/ai/keys-only", { on: true });
      expect(r.status === 200 && r.json.keysOnly?.on === true && r.json.activeBlocked === false, `answered ${r.status}`, r.text);
    });
    await check("keys-only: the plans' cards say blocked-keys-only", async () => {
      const c = await cards();
      expect(c.byId.claude.state === "blocked-keys-only" && c.byId.chatgpt.state === "blocked-keys-only", `claude ${c.byId.claude.state}, chatgpt ${c.byId.chatgpt.state}`);
    });
    for (const plan of ["claude", "chatgpt"]) {
      await check(`keys-only: PUT /api/ai/active ${plan} is refused`, async () => {
        const r = await api("PUT", "/api/ai/active", { provider: plan });
        expect(r.status === 409, `answered ${r.status}`, r.text);
        expect(/API keys only/i.test(r.json?.error || ""), `error ${r.json?.error}`);
        expect(r.json?.state === "blocked-keys-only", `state ${r.json?.state}`);
      });
    }
    await check("keys-only: POST /api/ai/chatgpt/login is refused", async () => {
      const r = await api("POST", "/api/ai/chatgpt/login", {});
      expect(r.status === 409 && r.json?.state === "blocked-keys-only", `answered ${r.status}`, r.text);
    });
    for (const plan of ["claude", "chatgpt"]) {
      await check(`keys-only: a chat turn asking for ${plan} is refused in words, with one done`, async () => {
        const side = (await api("POST", "/api/chat/conversations", { title: `e2e keys-only ${plan}` })).json?.id;
        const before = fakeA.requests.length + fakeR.requests.length;
        const t = await chat({ conversationId: side, message: "[e2e:keys-only] Hello.", provider: plan });
        const ev = t.events;
        const errs = ofType(ev, "error").map((e) => e.data?.message || "");
        expect(errs.some((m) => /API keys only/i.test(m)), `errors: ${errs.join(" | ") || "(none)"}`, brief(ev));
        expect(ofType(ev, "done").length === 1, `${ofType(ev, "done").length} done events`, brief(ev));
        expect(fakeA.requests.length + fakeR.requests.length === before, "a refused turn reached a fake");
      });
    }
    await modelsMatchReady("keys-only on");
    await check("keys-only: GET /api/models lists the plans as blocked-keys-only", async () => {
      const m = await api("GET", "/api/models");
      const blocked = (m.json.unavailable || []).filter((u) => u.state === "blocked-keys-only").map((u) => u.provider).sort();
      expect(JSON.stringify(blocked) === JSON.stringify(["chatgpt", "claude"]), `blocked ${blocked}`, m.json.unavailable);
    });
    await check("keys-only: off again", async () => {
      const r = await api("PUT", "/api/ai/keys-only", { on: false });
      expect(r.status === 200 && r.json.keysOnly?.on === false, `answered ${r.status}`, r.text);
    });
    fs.rmSync(path.join(home, "auth.json"), { force: true });
  }

  // --- A picture of Settings > AI as the API left it (best effort; not a check) ---
  if (SHOTS) {
    try {
      const { createRequire } = await import("node:module");
      const { chromium } = createRequire(path.join(ROOT, "package.json"))("playwright");
      const exe = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1234", "chrome-win64", "chrome.exe") : undefined;
      const browser = await chromium.launch(exe && fs.existsSync(exe) ? { executablePath: exe } : {});
      try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
        await context.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
        const page = await context.newPage();
        await page.goto(`${BASE}/`);
        await page.waitForTimeout(2500);
        fs.mkdirSync(SHOTS, { recursive: true });
        if (await page.locator("#settingsBtn").isVisible().catch(() => false)) {
          await page.locator("#settingsBtn").click();
          await page.locator('.settings-tab[data-tab="ai"]').click();
          await page.waitForTimeout(2500);
        }
        const file = path.join(SHOTS, "e2e-api-settings-ai.png");
        await page.screenshot({ path: file, fullPage: true });
        log(`screenshot: ${file}`);
      } finally { await browser.close(); }
    } catch (err) { log("screenshot skipped:", err.message); }
  }

  // --- Scans ---
  await check("no stripped host variable was followed: the trap got nothing", async () => {
    expect(trap.hits.length === 0, `${trap.hits.length} requests reached OPENAI_BASE_URL/ANTHROPIC_BASE_URL`, trap.hits.slice(0, 10));
  });
  await check("no env canary ever reached a fake", async () => {
    const text = JSON.stringify([...fakeA.requests, ...fakeR.requests].map((r) => ({ h: r.headers, b: r.body })));
    const found = Object.entries(ENV_CANARIES).filter(([, v]) => text.includes(v)).map(([k]) => k);
    expect(found.length === 0, `canaries at the fakes: ${found}`);
  });
  await check("no key, token or canary in any HTTP answer", async () => {
    const all = answers.join("\n");
    const found = SECRETS.filter((s) => all.includes(s));
    expect(found.length === 0, `found ${found.length}`, found.map((s) => { const i = all.indexOf(s); return `${s.slice(0, 14)}… in: ${clip(all.slice(Math.max(0, i - 200), i + 40), 260)}`; }));
  });
  await check("no key, token or canary in the server's stdout/stderr", async () => {
    const found = SECRETS.filter((s) => serverLog.includes(s));
    expect(found.length === 0, `found ${found.length}`, found.map((s) => { const i = serverLog.indexOf(s); return `${s.slice(0, 14)}… in: ${clip(serverLog.slice(Math.max(0, i - 200), i + 40), 260)}`; }));
  });
  await check("no saved key in plain text anywhere in the state folder", async () => {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        let buf;
        try { const st = fs.statSync(p); if (st.size > 64 * 1024 * 1024) continue; buf = fs.readFileSync(p); } catch { continue; }
        for (const [id, k] of Object.entries(KEYS)) if (buf.includes(Buffer.from(k))) hits.push(`${id} in ${path.relative(tmp, p)}`);
      }
    };
    walk(path.join(tmp, "state"));
    expect(hits.length === 0, `${hits.length} files hold a key in plain text`, hits);
  });

  void booted;
} catch (err) {
  results.push({ name: "harness", ok: false, error: err?.stack || String(err) });
  log("HARNESS ERROR", err?.stack || err);
} finally {
  // Stop everything this run started
  let leftovers = [];
  if (server?.pid) {
    const list = await processes();
    leftovers = descendants(list, server.pid).map((p) => `${p.pid} ${p.name} ${clip(p.cmd, 160)}`);
    await killTreeWin(server.pid);
  }
  await fakeA?.close().catch(() => {});
  await fakeR?.close().catch(() => {});
  await mux?.close().catch(() => {});
  await chatgptMux?.close().catch(() => {});
  await trap?.close().catch(() => {});
  try {
    const dump = (list) => (list || []).map((r) => ({ method: r.method, path: r.path, owner: ownerOfRec(r), prewarm: !!r.prewarm, at: r.at, body: r.body }));
    fs.writeFileSync(path.join(OUT, "ai-api-e2e.fake-requests.json"), scrub(JSON.stringify({ anthropic: dump(fakeA?.requests), responses: dump(fakeR?.requests), mux: mux?.requests || [], chatgptMux: chatgptMux?.requests || [] })));
  } catch (err) { log("couldn't write the fakes' requests:", err.message); }
  const logFile = path.join(OUT, "ai-api-e2e.server.log");
  fs.writeFileSync(logFile, scrub(serverLog));
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, "ai-api-e2e.json"), JSON.stringify(scrubDeep({ passed, failed: failed.length, results, leftoversAtShutdown: leftovers, tmp }), null, 2));
  log(`done: ${passed} passed, ${failed.length} failed. Results: ${path.join(OUT, "ai-api-e2e.json")}; server log: ${logFile}`);
  if (leftovers.length) log("processes under the server at shutdown:", leftovers);
  if (!KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment */ } }
  exitCode = failed.length ? 1 : 0;
}
process.exit(exitCode);

// --- Helpers that need no state ------------------------------------------------------------------------------------

function isDeepSeekPeak(d) {
  if (![1, 2, 3, 4, 5].includes(d.getUTCDay())) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return [[1, 4], [6, 10]].some(([a, b]) => mins >= a * 60 && mins < b * 60);
}
/** What the harness writes to disk: never a secret (the result files may be read by others). */
function scrub(s) {
  let out = String(s);
  for (const k of SECRETS) out = out.split(k).join(`<secret …${k.slice(-4)}>`);
  return out;
}
function scrubDeep(o) { return JSON.parse(scrub(JSON.stringify(o))); }
