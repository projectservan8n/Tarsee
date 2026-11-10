#!/usr/bin/env node
/**
 * scripts/e2e/live-smoke-fakes.mjs: proves scripts/e2e/live-smoke.mjs against a REAL Tarsee whose AIs are fakes, so
 * the owner's morning live test is known to work before any real key goes in.
 *
 * It boots `node src/server.js` the way scripts/e2e/ai-api-e2e.mjs does (a free port, a fresh temp TARSEE_STATE_DIR,
 * a fake home folder, SETUP_PASSWORD and ENCRYPTION_KEY made at run time and never written to a file, NODE_ENV=test
 * for engine-env's TARSEE_TEST_BASE_URL_<ID> seam, env canaries), with the same fakes (test/fixtures/fake-anthropic.js
 * for Claude Code, fake-responses.js for Codex, test-tls.js for ChatGPT's HTTPS backend) behind small fronts that also
 * answer what live-smoke's Test reads: DeepSeek's GET /user/balance, OpenRouter's GET /api/v1/key and Local AI's
 * GET /v1/models. The engines are the real ones. The fake models do what they are asked: live-smoke's "work out
 * A * B" gets a call to Tarsee's tarsee_calculator (on Codex directly, behind tool_search, or from code mode's exec,
 * as each model is offered it) and the tool's own result as the reply; Verify's four checks get a code word, a
 * tarsee_datetime call, a real shell echo and a recall from the session's own history.
 *
 * Set up as the owner would in Settings > AI (obvious fake keys for Anthropic, DeepSeek, OpenRouter, OpenAI and Local
 * AI, Local AI's address and model, DeepSeek as the default AI, and a fake ChatGPT sign-in file), it runs
 * live-smoke.mjs as a child with only TARSEE_URL and TARSEE_PASSWORD in its environment, in these scenarios:
 *   wrong-password   exit 1, says the password was turned down, never prints it
 *   all-ready        no options: every ready AI (OpenRouter twice, one chat per engine) passes; exit 0
 *   verify-local     --only local --verify local=qwen3:4b: Verify passes, and that model gets a chat of its own
 *   verify-openrouter  --only openrouter --model openrouter=<another maker's model> --verify
 *   rejected-key     DeepSeek's address turns the key down: exit 1, Test FAIL and the chat refused, the key nowhere
 *   rejected-turn    OpenAI's Test passes, then its model turns the key down mid-chat quoting it: exit 1, turn FAIL
 *   not-ready        --only claude (no Claude sign-in here): exit 1, the chat refused
 *   cut-stream       --only deepseek through a proxy in front of Tarsee: DeepSeek's model starts its answer and goes
 *                    quiet, and the proxy resets the chat's connection. Exit 1, the turn FAIL; POST /api/chat/stop
 *                    comes before the DELETE, the turn is over on Tarsee when the DELETE comes, and the engine's own
 *                    call to the model is ended by the stop (its signal fired)
 *   cut-stream-clean the same, with the proxy closing the connection cleanly and no "done"
 *   pin-password     Tarsee started again with a 4-digit SETUP_PASSWORD (this year), the six AIs set up here named
 *                    with --only, every chat's factors carrying the password: exit 0, and the header's date, every
 *                    sum and every other number print whole
 *   verify-local-llama  Local AI moved to a llama.cpp llama-server (a front answering /v1/models, /props and /health
 *                    as b12238 does, before the llama-flavoured fake model, which drops every tool that isn't a
 *                    function): --only local --verify passes Test (build and context named), Verify and the calculator
 *                    chat through the Local AI bridge, every request llama-server got had plain function tools and
 *                    the owner's key; Codex's own request sent straight to it (no bridge) has its calculator dropped.
 *                    Run on a Tarsee without the bridge, this scenario fails at Verify's tool check.
 * plus redact() on its own, and scans: nothing live-smoke printed carries a key, token, cookie value, password or
 * canary; every test chat was deleted; nothing reached a stripped host variable.
 *
 *   node scripts/e2e/live-smoke-fakes.mjs [--out <dir>] [--keep] [--skip-verify] [--scenario <name>,...]
 *     --scenario   only these scenarios (by the names above); the setup, redact() and the scans always run
 *
 * Exit 0 when every check passed, 1 otherwise. Results: <out>/live-smoke-fakes.json and each run's output next to it.
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
const SCRIPT = path.join(ROOT, "scripts", "e2e", "live-smoke.mjs");
const fixture = (name) => pathToFileURL(path.join(ROOT, "test", "fixtures", name)).href;
const fa = await import(fixture("fake-anthropic.js"));
const fr = await import(fixture("fake-responses.js"));
const { makeTestTls } = await import(fixture("test-tls.js"));
const smoke = await import(pathToFileURL(SCRIPT).href);

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const OUT = path.resolve(argOf("--out") || path.join(os.tmpdir(), "tarsee-live-smoke-fakes"));
const KEEP = argv.includes("--keep");
const SKIP_VERIFY = argv.includes("--skip-verify");
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
const ENV_CANARIES = {
  CODEX_API_KEY: `sk-test-canary-env-codex-api-key-${rand(8)}`,
  CODEX_ACCESS_TOKEN: `sk-test-canary-env-codex-access-${rand(8)}`,
  TARSEE_PROVIDER_KEY: `sk-test-canary-env-provider-key-${rand(8)}`,
  TARSEE_MCP_TOKEN: `sk-test-canary-env-mcp-token-${rand(8)}`,
  ANTHROPIC_AUTH_TOKEN: `sk-ant-test-canary-env-auth-token-${rand(8)}`,
};
const SETUP_PASSWORD = `pw-test-canary-${crypto.randomBytes(12).toString("base64url")}`;
const WRONG_PASSWORD = `pw-test-canary-wrong-${rand(12)}`;
const ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.testsig${rand(6)}`;
const nowSec = Math.floor(Date.now() / 1000);
const CHATGPT_ACCESS = jwt({ exp: nowSec + 86_400 * 9, "https://api.openai.com/auth": { chatgpt_plan_type: "free", chatgpt_account_id: "acct-live-smoke-test" }, note: "sk-test-canary-chatgpt-access" });
const CHATGPT_ID = jwt({ email: "owner@example.com", exp: nowSec + 3600, "https://api.openai.com/auth": { chatgpt_plan_type: "free", chatgpt_account_id: "acct-live-smoke-test" } });
const CHATGPT_REFRESH = `rt-test-canary-${rand(16)}`;

/** Everything that must never appear in live-smoke's output (the API token is added once the server made it). */
const SECRETS = [...Object.values(KEYS), ...Object.values(ENV_CANARIES), SETUP_PASSWORD, WRONG_PASSWORD, ENCRYPTION_KEY, CHATGPT_ACCESS, CHATGPT_ID, CHATGPT_REFRESH];

const LOCAL_MODELS = ["llama3.1:8b", "qwen3:4b"];
const OPENROUTER_COST = 0.0021;

// --- Results -------------------------------------------------------------------------------------------------------

const results = [];
const t0 = Date.now();
function log(...a) { console.log(`[fakes ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a); }
class Fail extends Error { constructor(msg, evidence) { super(msg); this.evidence = evidence; } }
function expect(cond, msg, evidence) { if (!cond) throw new Fail(msg, evidence); }
const clip = (s, n = 400) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}…` : t; };
async function check(name, fn) {
  try {
    const r = await fn();
    results.push({ name, ok: true, ...(r && typeof r === "object" ? { note: r } : {}) });
    log(`PASS ${name}`);
    return r;
  } catch (err) {
    const ev = err?.evidence ?? null;
    results.push({ name, ok: false, error: err?.message || String(err), evidence: ev });
    log(`FAIL ${name}: ${err?.message || err}${ev ? `\n      evidence: ${clip(typeof ev === "string" ? ev : JSON.stringify(ev), 2500)}` : ""}`);
    return undefined;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeoutMs = 20_000, everyMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const last = await fn();
    if (last || Date.now() > end) return last;
    await sleep(everyMs);
  }
}

// --- The fake models -----------------------------------------------------------------------------------------------

/**
 * What each provider's fake does: "ok" (do as asked), "401" (its address turns the key down: Test and the model
 * alike), "401-turn" (Test passes, then the model itself turns the key down mid-chat, quoting it) or "hang" (Claude
 * Code's model starts its answer to live-smoke's sum, then goes quiet with the line held open, as a stuck model does).
 */
const MODES = {};
const modelRejects = (prov) => MODES[prov] === "401" || MODES[prov] === "401-turn";
/** The model calls left hanging ("hang"), oldest first: what the cut-stream scenarios wait for before cutting. */
const HANGS = [];

const CRED_OWNERS = () => ({
  [`Bearer ${KEYS.anthropic}`]: "anthropic",
  [`Bearer ${KEYS.deepseek}`]: "deepseek",
  [`Bearer ${KEYS.openrouter}`]: "openrouter",
  [`Bearer ${KEYS.openai}`]: "openai",
  [`Bearer ${KEYS.local}`]: "local",
  [`Bearer ${CHATGPT_ACCESS}`]: "chatgpt",
});
function ownerOf(headers) {
  const owners = CRED_OWNERS();
  if (headers?.["x-api-key"] && owners[`Bearer ${headers["x-api-key"]}`]) return owners[`Bearer ${headers["x-api-key"]}`];
  if (headers?.authorization && owners[headers.authorization]) return owners[headers.authorization];
  return null;
}

/** The exact asks the fakes answer: live-smoke's sum and Verify's four checks (src/ai/verify-model.js promptFor). */
const ASKS = [
  { kind: "calc", re: /work out (\d+) \* (\d+), then reply with just the number/ },
  { kind: "date", re: /Call the tarsee_datetime tool \(it is on the tarsee MCP server\)/ },
  { kind: "echo", re: /Run this exact shell command and reply with its output: echo (TARSEE-OK-[0-9A-F]+)/ },
  { kind: "recall", re: /What was the code word I gave you at the start/ },
  { kind: "word", re: /code word[^:]*:\s*(CODE-[0-9A-F]{6})/ },
];
/** The newest ask among a request's user texts (the session's history comes first, the new question last). */
function latestAsk(texts) {
  for (let i = texts.length - 1; i >= 0; i--) {
    for (const a of ASKS) { const m = a.re.exec(texts[i]); if (m) return { kind: a.kind, m, texts }; }
  }
  return null;
}
const recalled = (texts) => /code word for later:\s*(CODE-[0-9A-F]{6})/.exec(texts.join("\n"))?.[1] || "I don't know of any code word.";

/** A reply from a tool's own output: the calculator's number, the shell's marker, or the date's year. */
function fromToolOutput(text) {
  const marker = /TARSEE-OK-[0-9A-F]+/i.exec(text);
  if (marker) return marker[0];
  const calc = /=\s*(-?\d+(?:\.\d+)?)/.exec(text);
  if (calc) return `The answer is ${calc[1]}.`;
  const year = /\b(20\d\d)\b/.exec(text);
  return year ? year[1] : "done";
}

/** Every user text block of a Messages request, oldest first. */
function anthropicUserTexts(body) {
  const out = [];
  for (const m of body?.messages || []) {
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") out.push(m.content);
    else for (const b of m.content || []) if (b?.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out;
}
function toolResultText(body) {
  return fa.lastUserBlocks(body).filter((b) => b?.type === "tool_result")
    .map((b) => (typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => c?.text ?? "").join("") : "")).join(" ");
}

/** Claude Code's model (DeepSeek, OpenRouter's Claude models, and any model Verify runs there). */
function anthropicScript(entry) {
  const prov = ownerOf(entry.headers);
  entry.owner = prov;
  const cost = prov === "openrouter" ? OPENROUTER_COST : undefined;
  if (modelRejects(prov)) {
    // The provider's own words carry the key it was sent: if they ever reach the owner's screen, the scan sees it.
    return { status: 401, error: { type: "authentication_error", message: `invalid x-api-key: ${entry.headers?.authorization || entry.headers?.["x-api-key"] || ""}` } };
  }
  const names = fa.toolNames(entry.body);
  if (!names.some((n) => /tarsee/i.test(n))) return { text: "ok", cost }; // the CLI's own side calls
  if (fa.hasToolResult(entry.body)) return { text: fromToolOutput(toolResultText(entry.body)), cost };
  const ask = latestAsk(anthropicUserTexts(entry.body));
  if (MODES[prov] === "hang" && ask?.kind === "calc") {
    HANGS.push({ at: Date.now(), owner: prov });
    return { hang: true, text: "Let me work that out" };
  }
  const tool = (suffix) => names.find((n) => n.endsWith(suffix));
  switch (ask?.kind) {
    case "calc": return tool("tarsee_calculator") ? { toolUse: { name: tool("tarsee_calculator"), input: { expression: `${ask.m[1]} * ${ask.m[2]}` } }, cost } : { text: `No calculator was offered (${names.join(",")}).`, cost };
    case "date": return tool("tarsee_datetime") ? { toolUse: { name: tool("tarsee_datetime"), input: { format: "date" } }, cost } : { text: "No datetime tool was offered.", cost };
    case "echo": return { toolUse: { name: "Bash", input: { command: `echo ${ask.m[1]}`, description: "Print the marker" } }, cost };
    case "recall": return { text: recalled(ask.texts), cost };
    case "word": return { text: ask.m[1], cost };
    default: return { text: "A plain reply.", cost };
  }
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

/**
 * A call to one of Tarsee's tools, however this request offers it: outright (in Codex's mcp__tarsee namespace, or as
 * the plain function the Local AI bridge makes of it, which a Local AI model calls by that flat name), behind
 * tool_search, or inside exec.
 */
function codexToolCall(body, tool, args) {
  const names = [...fr.toolNames(body), ...additionalToolNames(body)];
  const searched = fr.searchedTools(body);
  const full = `mcp__tarsee.${tool}`;
  if (names.includes(full) || searched.includes(full)) return { calls: [{ name: tool, namespace: "mcp__tarsee", arguments: args }] };
  if (names.includes(`mcp__tarsee__${tool}`)) return { calls: [{ name: `mcp__tarsee__${tool}`, arguments: args }] };
  if (names.includes("tool_search") && !searched.length) return { calls: [{ type: "tool_search", query: `tarsee ${tool.replace(/^tarsee_/, "")}` }] };
  if (names.includes("functions.exec") || names.includes("exec")) {
    const js = [`const r = await tools.mcp__tarsee__${tool}(${JSON.stringify(args)});`, "text(typeof r === \"string\" ? r : JSON.stringify(r));"].join("\n");
    return { calls: [{ type: "custom", name: "exec", input: js }] };
  }
  return { text: `No ${tool} was offered (${names.join(",")}; searched ${searched.join(",")}).` };
}

/** Codex's model (the OpenAI key, ChatGPT, OpenRouter's OpenAI models, Local AI, and any model Verify runs there). */
function responsesHandler(body, info) {
  const prov = ownerOf(info.headers);
  const rec = info.requests[info.requests.length - 1];
  if (rec) rec.owner = prov;
  if (modelRejects(prov)) return { status: 401, error: { message: `Incorrect API key provided: ${info.headers?.authorization || ""}`, code: "invalid_api_key", type: "invalid_request_error" } };
  const last = (body?.input || []).at(-1);
  if (last && (last.type === "function_call_output" || last.type === "custom_tool_call_output")) return { text: fromToolOutput(fr.outputText(last)) };
  const ask = latestAsk(fr.messageTexts(body, "user"));
  switch (ask?.kind) {
    case "calc": return codexToolCall(body, "tarsee_calculator", { expression: `${ask.m[1]} * ${ask.m[2]}` });
    case "date": return codexToolCall(body, "tarsee_datetime", { format: "date" });
    case "echo": {
      const names = fr.toolNames(body);
      if (names.includes("exec_command")) return { calls: [{ name: "exec_command", arguments: { cmd: `echo ${ask.m[1]}` } }] };
      if (names.includes("shell")) return { calls: [{ name: "shell", arguments: { command: ["bash", "-lc", `echo ${ask.m[1]}`] } }] };
      return { text: `No shell was offered (${names.join(",")}).` };
    }
    case "recall": return { text: recalled(ask.texts) };
    case "word": return { text: ask.m[1] };
    default: return { text: "A plain reply." };
  }
}

// --- Fronts: what each provider's address answers besides the model -----------------------------------------------

/** A loopback front for the two fakes: plain HTTP, or HTTPS with `tls`; answer(req, path) may answer a path itself. */
function startMux(aPort, rPort, { answer, tls } = {}) {
  const requests = [];
  const onRequest = (req, res) => {
    const p = (req.url || "").split("?")[0];
    const own = answer?.(req, p);
    if (own) {
      requests.push({ method: req.method, path: p, to: "front" });
      req.resume();
      res.writeHead(own.status || 200, { "content-type": "application/json" });
      res.end(JSON.stringify(own.body));
      return;
    }
    const toR = /\/responses$/.test(p) || (/\/models$/.test(p) && !/\/v1\/models$/.test(p));
    const rec = { method: req.method, path: p, to: toR ? "responses" : "anthropic", at: Date.now() };
    requests.push(rec);
    const up = http.request({ host: "127.0.0.1", port: toR ? rPort : aPort, method: req.method, path: req.url, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on("error", () => { try { res.destroy(); } catch { /* gone */ } });
    res.on("close", () => {
      // The caller hung up before the answer was over (an engine stopping mid-call): when, for the cut scenarios.
      if (!res.writableFinished) rec.cutAt = Date.now();
      try { up.destroy(); } catch { /* gone */ }
    });
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

const refused = (provider, req) => MODES[provider] === "401" || req.headers.authorization !== `Bearer ${KEYS[provider]}`;

/** DeepSeek's prepaid balance (GET /user/balance), as DeepSeek answers it. */
function deepseekFront(req, p) {
  if (req.method !== "GET" || p !== "/user/balance") return null;
  if (refused("deepseek", req)) return { status: 401, body: { error: { message: `Authentication Fails, Your api key: ${req.headers.authorization || ""} is invalid`, type: "authentication_error", code: "invalid_request_error" } } };
  return { body: { is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.20", granted_balance: "0.00", topped_up_balance: "4.20" }] } };
}
/** OpenRouter's key and its spending limit (GET /api/v1/key). Its label carries part of the key, as OpenRouter's does. */
function openrouterFront(req, p) {
  if (req.method !== "GET" || p !== "/api/v1/key") return null;
  if (refused("openrouter", req)) return { status: 401, body: { error: { message: "No auth credentials found", code: 401 } } };
  return { body: { data: { label: `sk-or-v1-0000...${KEYS.openrouter.slice(-3)}`, limit: 10, usage: 1.25, limit_remaining: 8.75, usage_daily: 0.1, usage_monthly: 1.25, is_free_tier: false } } };
}
/** Local AI's model list (GET /v1/models, as Ollama's OpenAI-compatible address answers it). */
function localFront(req, p) {
  if (req.method !== "GET" || !/\/v1\/models$/.test(p)) return null;
  if (refused("local", req)) return { status: 401, body: { error: { message: "unauthorized" } } };
  return { body: { object: "list", data: LOCAL_MODELS.map((id) => ({ id, object: "model", owned_by: "library" })) } };
}

/** The model llama.cpp's llama-server runs in the verify-local-llama scenario (its --alias), and its -c. */
const LLAMA_MODEL = "qwen3.5-9b";
const LLAMA_CTX = 65_536;
/**
 * llama-server b12238 started with --api-key (Local AI's fake key): it answers GET /v1/models, /props and /health
 * itself, as the real one does (/health without a key); POST /v1/responses goes to the llama-flavoured fake model
 * (fake-responses.js llama mode), which drops every tool that isn't a function, as llama-server does.
 */
function llamaFront(req, p) {
  if (req.method !== "GET") return null;
  if (p === "/health") return { body: { status: "ok" } };
  if (p !== "/props" && !/\/v1\/models$/.test(p)) return null;
  if (refused("local", req)) return { status: 401, body: { error: { code: 401, message: "Invalid API Key", type: "authentication_error" } } };
  return { body: p === "/props" ? fr.llamaProps({ alias: LLAMA_MODEL, nCtx: LLAMA_CTX }) : fr.llamaModels({ alias: LLAMA_MODEL, nCtx: LLAMA_CTX }) };
}

/**
 * A proxy in front of Tarsee, standing where a Railway edge would: live-smoke talks to it, and it notes every request
 * in order (with the conversation a POST names). With cut ("destroy" or "end") it gives up on the chat's reply (POST
 * /api/chat/send) once Tarsee has said which AI answers and ready() says the model's call is under way: "destroy"
 * resets the connection, "end" closes it cleanly with no "done". Either way it hangs up on Tarsee too, as a proxy
 * that gives up does. beforeDelete(conversationId) runs before a chat's DELETE is passed on, and what it returns is
 * kept on that request's note.
 */
async function startTarseeFront(target, { cut = null, ready = () => true, beforeDelete = null } = {}) {
  const to = new URL(target);
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const p = (req.url || "").split("?")[0];
      const rec = { method: req.method, path: p, at: Date.now() };
      requests.push(rec);
      try { rec.conversationId = JSON.parse(body.toString("utf8") || "null")?.conversationId ?? null; } catch { /* not JSON */ }
      const deleting = req.method === "DELETE" && /^\/api\/chat\/conversations\/[^/]+$/.test(p);
      if (deleting && beforeDelete) {
        try { rec.before = await beforeDelete(decodeURIComponent(p.split("/").pop())); } catch (err) { rec.before = { error: err?.message || String(err) }; }
      }
      const cutThis = cut && req.method === "POST" && p === "/api/chat/send";
      const up = http.request({ host: to.hostname, port: to.port, method: req.method, path: req.url, headers: req.headers }, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        if (!cutThis) { ur.pipe(res); return; }
        let seen = "";
        let cutting = false;
        ur.on("error", () => { /* hung up on below */ });
        ur.on("data", (c) => {
          if (cutting) return;
          res.write(c);
          seen += c.toString("utf8");
          if (!seen.includes("event: model_selected")) return;
          cutting = true;
          until(ready, { timeoutMs: 60_000, everyMs: 100 }).then(() => {
            rec.cutAt = Date.now();
            if (cut === "destroy") { res.destroy(); up.destroy(); } else res.end(() => up.destroy());
          });
        });
        ur.on("end", () => { if (!cutting) res.end(); });
      });
      up.on("error", () => { if (!res.writableEnded) { try { res.destroy(); } catch { /* gone */ } } });
      up.end(body);
    });
  });
  const sockets = new Set();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(() => r())); },
  };
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

function hostEnv() {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "SystemDrive", "TEMP", "TMP", "TMPDIR", "ComSpec", "PATHEXT", "WINDIR", "windir", "LANG", "CLAUDE_CODE_GIT_BASH_PATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
}

async function bootServer({ tmp, fakeA, dsMux, orMux, fakeR, chatgptMux, caFile, trap, password = SETUP_PASSWORD }) {
  const port = await freePort();
  const home = path.join(tmp, "home");
  for (const d of [home, path.join(home, "AppData", "Roaming"), path.join(home, "AppData", "Local")]) fs.mkdirSync(d, { recursive: true });
  const env = {
    ...hostEnv(),
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    PORT: String(port),
    TARSEE_STATE_DIR: path.join(tmp, "state"),
    SETUP_PASSWORD: password, ENCRYPTION_KEY,
    NODE_ENV: "test",
    TARSEE_PHONON_AUTO_INSTALL: "0",
    TARSEE_TEST_BASE_URL_ANTHROPIC: fakeA.url,
    TARSEE_TEST_BASE_URL_DEEPSEEK: dsMux.origin,
    TARSEE_TEST_BASE_URL_OPENROUTER: orMux.origin,
    TARSEE_TEST_BASE_URL_OPENAI: fakeR.url,
    TARSEE_TEST_BASE_URL_CHATGPT: chatgptMux.origin,
    SSL_CERT_FILE: caFile,
    OPENAI_BASE_URL: `${trap.url}/v1`,
    ANTHROPIC_BASE_URL: trap.url,
    ...ENV_CANARIES,
  };
  log(`booting the server on port ${port}`);
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  child.stdout.on("data", (b) => { serverLog += b.toString("utf8"); });
  child.stderr.on("data", (b) => { serverLog += b.toString("utf8"); });
  child.on("exit", (code, sig) => { serverLog += `\n[harness] server exited code=${code} signal=${sig}\n`; });
  server = child;
  BASE = `http://127.0.0.1:${port}`;
  const ok = await until(async () => { try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; } }, { timeoutMs: 60_000, everyMs: 300 });
  if (!ok) throw new Error(`the server didn't come up:\n${clip(serverLog, 3000)}`);
}

async function killServer() {
  if (!server?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => execFile("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
  } else {
    try { process.kill(-server.pid, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch { /* gone */ } }
  }
}

// --- The harness's own session (the owner's clicks in Settings > AI) ----------------------------------------------

const jar = new Map();
function takeCookies(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const kv = c.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
}
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "x-csrf-token": decodeURIComponent(jar.get("tarsee_csrf") || "") },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  takeCookies(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
/** Sign the harness in afresh, as the page does: {login, csrf} statuses. */
async function signIn(password) {
  jar.clear();
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  takeCookies(r);
  return { login: r.status, csrf: r.status === 200 ? (await api("GET", "/api/auth/csrf")).status : 0 };
}

// --- Running live-smoke as the owner would --------------------------------------------------------------------------

const runs = {};

/**
 * live-smoke.mjs in a child process with only TARSEE_URL and TARSEE_PASSWORD (and the shell's basics) set. url: an
 * address other than the server's own (a proxy in front of it). factors: the numbers live-smoke's crypto.randomInt
 * gives, in turn (each chat's "work out A * B" takes two), set by a module node loads before the script.
 */
async function runSmoke(name, args, { password = SETUP_PASSWORD, url = BASE, factors = null, timeoutMs = 25 * 60_000 } = {}) {
  log(`--- live-smoke ${name}: ${args.join(" ") || "(no options)"} ---`);
  const env = { ...hostEnv(), TARSEE_URL: url, TARSEE_PASSWORD: password };
  const preload = [];
  if (factors) {
    const file = path.join(tmp, `live-smoke-factors-${name}.mjs`);
    fs.writeFileSync(file, [
      "// live-smoke-fakes: the factors of live-smoke's \"work out A * B\", chosen by the harness instead of at random.",
      "import crypto from \"node:crypto\";",
      `const factors = ${JSON.stringify(factors)};`,
      "let next = 0;",
      "crypto.randomInt = () => factors[next++ % factors.length];",
      "",
    ].join("\n"));
    preload.push("--import", pathToFileURL(file).href);
  }
  const started = Date.now();
  const child = spawn(process.execPath, [...preload, SCRIPT, ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  let pending = "";
  child.stdout.on("data", (b) => {
    const s = b.toString("utf8");
    stdout += s;
    pending += s;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const l of lines) process.stdout.write(`    | ${l}\n`);
  });
  child.stdout.on("end", () => { if (pending) process.stdout.write(`    | ${pending}\n`); });
  child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
  const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
  const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
  clearTimeout(timer);
  const run = { name, args, code, stdout, stderr, secs: Math.round((Date.now() - started) / 1000), rows: parseTable(stdout) };
  runs[name] = run;
  const how = [url !== BASE && "through a proxy in front of Tarsee", factors && `the factors set to ${factors.join(", ")}`].filter(Boolean).join("; ");
  fs.writeFileSync(path.join(OUT, `live-smoke-${name}.txt`), scrub(`$ node scripts/e2e/live-smoke.mjs ${args.join(" ")}\n(exit ${code}, ${run.secs} s${how ? `; ${how}` : ""})\n\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`));
  return run;
}

/** The final table's rows: [{provider, test, turn, tool, cost, notes}]. */
function parseTable(stdout) {
  const lines = stdout.split(/\r?\n/);
  const at = lines.findIndex((l) => /^provider\s+\| test\s+\| turn\s+\| tool\s+\| cost\s+\| notes$/.test(l));
  if (at < 0) return [];
  const rows = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.trim()) break;
    const [provider, test, turn, tool, cost, ...notes] = l.split(" | ").map((c) => c.trim());
    rows.push({ provider, test, turn, tool, cost, notes: notes.join(" | ") });
  }
  return rows;
}
const tableOf = (run) => {
  const lines = run.stdout.split(/\r?\n/);
  const at = lines.findIndex((l) => /^provider\s+\| test/.test(l));
  if (at < 0) return "(no table)";
  const end = lines.findIndex((l, i) => i > at && !l.trim());
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
};

/** Nothing live-smoke printed may carry a secret, a cookie's value or anything key-shaped. */
function leaksIn(text) {
  const found = [];
  for (const s of SECRETS) if (s && text.includes(s)) found.push(`a secret (${s.slice(0, 10)}…)`);
  for (const [label, re] of [
    ["an sk- key", /\bsk-(?!\[redacted\])[A-Za-z0-9_-]{8,}/],
    ["a JWT", /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\./],
    ["a Tarsee cookie value", /\btarsee_(?:session|csrf)=(?!\[redacted\])[^;\s]+/],
    ["a Bearer value", /\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{6,}/i],
    ["a 32+ hex run (a session id or key)", /\b[a-f0-9]{32,}\b/i],
  ]) {
    const m = re.exec(text);
    if (m) found.push(`${label} near "${clip(text.slice(Math.max(0, m.index - 40), m.index), 40)}"`);
  }
  return found;
}

// --- Main ----------------------------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-live-smoke-fakes-"));
let fakeA; let fakeR; let fakeL; let dsMux; let orMux; let localMux; let llamaMux; let chatgptMux; let trap;
let exitCode = 1;
/** --scenario a,b: only these scenarios (the setup and the scans always run). */
const ONLY_SCENARIOS = argOf("--scenario") ? argOf("--scenario").split(",").map((s) => s.trim()).filter(Boolean) : null;
const want = (name) => !ONLY_SCENARIOS || ONLY_SCENARIOS.includes(name);

try {
  fakeA = await fa.startFakeAnthropic({ script: (entry) => anthropicScript(entry) });
  fakeR = await fr.startFakeResponses({
    handler: (body, info) => responsesHandler(body, info),
    upgrade: (headers) => (modelRejects(ownerOf(headers)) ? 401 : null),
  });
  // llama.cpp's llama-server: the same fake models, behind llama-server's own rules (fake-responses.js llama mode).
  fakeL = await fr.startFakeResponses({ handler: (body, info) => responsesHandler(body, info), llama: { alias: LLAMA_MODEL, nCtx: LLAMA_CTX } });
  const aPort = Number(new URL(fakeA.url).port);
  const rPort = Number(new URL(fakeR.origin).port);
  dsMux = await startMux(aPort, rPort, { answer: deepseekFront });
  orMux = await startMux(aPort, rPort, { answer: openrouterFront });
  localMux = await startMux(aPort, rPort, { answer: localFront });
  llamaMux = await startMux(aPort, Number(new URL(fakeL.origin).port), { answer: llamaFront });
  const tlsKit = makeTestTls();
  const caFile = path.join(tmp, "test-ca-bundle.pem");
  fs.writeFileSync(caFile, tlsKit.bundlePem);
  chatgptMux = await startMux(aPort, rPort, {
    tls: { key: tlsKit.keyPem, cert: tlsKit.certPem },
    answer: (req, p) => {
      if (req.method === "GET" && fr.ACCOUNTS_CHECK_PATH.test(p)) return { body: fr.chatgptAccountsCheck({ accountId: "acct-live-smoke-test", planType: "free", origin: chatgptMux.origin }) };
      if (req.method === "POST" && fr.REFRESH_PATH.test(p)) return { status: 401, body: fr.chatgptRefreshRefusal("refresh_token_invalidated") };
      return null;
    },
  });
  trap = await startTrap();
  log(`fakes: anthropic ${fakeA.url}, responses ${fakeR.origin}, deepseek ${dsMux.origin}, openrouter ${orMux.origin}, local ${localMux.origin}, llama-server ${llamaMux.origin}, chatgpt ${chatgptMux.origin}; temp ${tmp}`);

  await bootServer({ tmp, fakeA, dsMux, orMux, fakeR, chatgptMux, caFile, trap });
  const STATE = path.join(tmp, "state");
  try { SECRETS.push(fs.readFileSync(path.join(STATE, "api.token"), "utf8").trim()); } catch { /* none made */ }

  // --- The owner's setup in Settings > AI ---
  await check("setup: sign in, save the five fake keys, Local AI's address and model, a ChatGPT sign-in, DeepSeek as the default", async () => {
    const signed = await signIn(SETUP_PASSWORD);
    expect(signed.login === 200, `login answered ${signed.login}`);
    expect(signed.csrf === 200, "no CSRF cookie");
    const local = await api("PUT", "/api/ai/providers/local", { baseUrl: `${localMux.origin}/v1`, model: LOCAL_MODELS[0] });
    expect(local.status === 200, `PUT /api/ai/providers/local answered ${local.status}`, local.text);
    for (const [id, key] of Object.entries(KEYS)) {
      const k = await api("PUT", `/api/ai/keys/${id}`, { apiKey: key });
      expect(k.status === 200 && k.json?.status?.state === "ready", `PUT /api/ai/keys/${id}: ${k.status} ${k.json?.status?.state}`, k.text);
    }
    const home = path.join(STATE, ".codex-home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
      tokens: { access_token: CHATGPT_ACCESS, refresh_token: CHATGPT_REFRESH, account_id: "acct-live-smoke-test", id_token: CHATGPT_ID, oauth_provenance: { issuer: chatgptMux.origin, client_id: "app_tarsee_live_smoke_test" } },
    }));
    const a = await api("PUT", "/api/ai/active", { provider: "deepseek" });
    expect(a.status === 200, `PUT /api/ai/active answered ${a.status}`, a.text);
    const c = await api("GET", "/api/ai/providers");
    const states = Object.fromEntries(c.json.providers.map((p) => [p.id, p.state]));
    expect(["anthropic", "deepseek", "openrouter", "openai", "local", "chatgpt"].every((id) => states[id] === "ready"), "not every AI is ready", states);
    expect(states.claude !== "ready", "the Claude plan is ready here (it must not be: there is no sign-in)", states);
    return { states };
  });
  const chats = async () => (await api("GET", "/api/chat/conversations?limit=200")).json?.conversations?.length ?? -1;

  // --- redact() on its own ---
  await check("redact(): every key shape, cookie and given secret goes; model ids, numbers and chat ids stay", async () => {
    smoke.addSecret(SETUP_PASSWORD);
    const session = rand(64);
    const csrfValue = `${Date.now()}.${rand(20)}`;
    const opaque = { bearer: `tok${rand(24)}`, xkey: `xk${rand(16)}`, refresh: `rf${rand(20)}`, pw: `pw${rand(12)}` };
    // [the text as it might appear, the secret part that must not survive]
    const bad = [
      ...[...Object.values(KEYS), CHATGPT_ACCESS, CHATGPT_REFRESH, ENCRYPTION_KEY, SETUP_PASSWORD].map((k) => [k, k]),
      [`Authorization: Bearer ${opaque.bearer}`, opaque.bearer], [`x-api-key: ${opaque.xkey}`, opaque.xkey],
      [`tarsee_session=${session}; tarsee_csrf=${csrfValue}`, session], [`tarsee_session=${session}; tarsee_csrf=${csrfValue}`, csrfValue],
      [`"refresh_token": "${opaque.refresh}"`, opaque.refresh], [`password=${opaque.pw}`, opaque.pw],
    ];
    const kept = bad.filter(([text, secret]) => smoke.redact(`before ${text} after`).includes(secret));
    expect(kept.length === 0, "redact() left these in", kept.map(([t]) => clip(t, 30)));
    const plain = ["openrouter · anthropic/claude-sonnet-4.5", "189077507", "0b0c1d2e-3f40-4152-8364-758697a8b9c0", "llama3.1:8b", "1,234 tokens (in 1,000, out 234)", "~anthropic/claude-sonnet-latest", "Balance $4.20"];
    const changed = plain.filter((s) => smoke.redact(s) !== s);
    expect(changed.length === 0, "redact() changed ordinary text", changed);
  });
  // A 4-digit SETUP_PASSWORD blanked out wherever it appears would show in the gap: "[redacted]-11-10" is the year,
  // and "worked out [redacted]7 * 3917 = 180796969" gives it away to anyone who divides.
  await check("redact(): a short secret (a 4-digit password) is never blanked out of the dates, sums and model ids around it", async () => {
    const pin = String(new Date().getUTCFullYear());
    smoke.addSecret(pin);
    const a = Number(`${pin}7`);
    const text = `[   0.0s] INFO tarsee: http://127.0.0.1:3000 (live test, ${pin}-11-10 08:00 UTC) · worked out ${a} * ${pin} = ${a * Number(pin)} · claude-haiku-4-5-${pin}1001 · $0.${pin}`;
    expect(smoke.redact(text) === text, "redact() changed the text around a short secret", smoke.redact(text));
  });

  // --- Scenarios ---
  if (want("wrong-password")) await check("wrong-password: exit 1, the password turned down in words, and never printed", async () => {
    const run = await runSmoke("wrong-password", ["--only", "deepseek"], { password: WRONG_PASSWORD });
    expect(run.code === 1, `exit ${run.code}`, run.stdout);
    expect(/TARSEE_PASSWORD was turned down/.test(run.stdout), "no plain words about the password", run.stdout);
  });

  const before1 = await chats();
  if (want("all-ready")) await check("all-ready: no options, every ready AI passes test, turn, tool and usage; exit 0", async () => {
    const run = await runSmoke("all-ready", []);
    const by = (re) => run.rows.filter((r) => re.test(r.provider));
    expect(run.code === 0, `exit ${run.code}`, run.stdout.split(/\r?\n/).filter((l) => /FAIL|WARN/.test(l)));
    expect(run.rows.length >= 7, `${run.rows.length} rows`, tableOf(run));
    for (const r of run.rows) {
      expect(r.test === "ok" && r.turn === "ok" && r.tool === "tarsee_calculator" && !/^FAIL|^-$/.test(r.cost), `row ${r.provider}`, r);
    }
    expect(by(/^deepseek /).length === 1 && /est\.$/.test(by(/^deepseek /)[0].cost) && /Balance \$4\.20/.test(by(/^deepseek /)[0].notes), "DeepSeek's row: an estimate and the balance", by(/^deepseek /));
    const or = by(/^openrouter /);
    expect(or.length === 2, `${or.length} OpenRouter rows (one per engine)`, tableOf(run));
    expect(or.some((r) => /claude-code/.test(r.notes)) && or.some((r) => /codex/.test(r.notes)), "OpenRouter's rows aren't one per engine", or);
    const orCc = or.find((r) => /claude-code/.test(r.notes));
    expect(/^\$[\d.]+$/.test(orCc.cost), `OpenRouter on Claude Code: OpenRouter's own cost, got ${orCc.cost}`, orCc);
    expect(or.every((r) => /Spending limit left \$8\.75 of \$10\.00/.test(r.notes)), "OpenRouter's spending limit isn't shown", or);
    expect(by(/^anthropic /).length === 1 && /^\$[\d.]+$/.test(by(/^anthropic /)[0].cost) && /claude-code/.test(by(/^anthropic /)[0].notes), "Anthropic key row: Anthropic's own cost, on Claude Code", by(/^anthropic /));
    expect(by(/^openai /).length === 1 && /est\.$/.test(by(/^openai /)[0].cost), "OpenAI's row: an estimate", by(/^openai /));
    expect(by(/^local /).length === 1 && by(/^local /)[0].cost === "Free", "Local AI's row: Free", by(/^local /));
    expect(by(/^chatgpt /).length === 1 && by(/^chatgpt /)[0].cost === "Included in plan", "ChatGPT's row: Included in plan", by(/^chatgpt /));
    expect(/chatgpt · models: /.test(run.stdout), "no line for ChatGPT's model list", run.stdout);
    expect(!run.rows.some((r) => /^claude /.test(r.provider)), "the Claude plan (not ready) was tested without --only", tableOf(run));
    return { secs: run.secs, rows: run.rows.map((r) => `${r.provider} | ${r.cost}`) };
  });
  if (want("all-ready")) await check("all-ready: every test chat was deleted", async () => {
    const after = await chats();
    expect(after === before1, `chats before ${before1}, after ${after}`);
  });

  let orOther = null;
  if (!SKIP_VERIFY) {
    const before2 = await chats();
    if (want("verify-local")) await check("verify-local: --only local --verify local=qwen3:4b: Verify passes, then a chat on each model; exit 0", async () => {
      const run = await runSmoke("verify-local", ["--only", "local", "--verify", `local=${LOCAL_MODELS[1]}`]);
      expect(run.code === 0, `exit ${run.code}`, run.stdout.split(/\r?\n/).filter((l) => /FAIL|WARN/.test(l)));
      expect(new RegExp(`PASS local · ${LOCAL_MODELS[1].replace(/[.]/g, "\\.")} · verify: passed on codex`).test(run.stdout), "no PASS line for Verify", run.stdout);
      const models = run.rows.map((r) => r.provider);
      expect(models.length === 2 && models.some((m) => m.includes(LOCAL_MODELS[0])) && models.some((m) => m.includes(LOCAL_MODELS[1])), `rows ${models}`, tableOf(run));
      expect(run.rows.every((r) => r.turn === "ok" && r.tool === "tarsee_calculator" && r.cost === "Free"), "a row didn't pass", run.rows);
      return { secs: run.secs };
    });

    const list = await api("GET", "/api/ai/models/openrouter");
    const makers = /^(google|deepseek|qwen|mistralai|x-ai|z-ai|moonshotai|meta-llama|minimax)\//;
    orOther = (list.json?.models || []).filter((m) => m.needsVerification && !m.free && m.price && makers.test(m.id) && !/:free|image|audio|vision|embed/i.test(m.id))
      .map((m) => m.id).sort()[0] || null;
    if (orOther && want("verify-openrouter")) {
      await check(`verify-openrouter: --only openrouter --model openrouter=${orOther} --verify: Verify passes, then its chat; exit 0`, async () => {
        const run = await runSmoke("verify-openrouter", ["--only", "openrouter", "--model", `openrouter=${orOther}`, "--verify"]);
        expect(run.code === 0, `exit ${run.code}`, run.stdout.split(/\r?\n/).filter((l) => /FAIL|WARN/.test(l)));
        expect(/· verify: passed on (claude-code|codex)/.test(run.stdout), "no PASS line for Verify", run.stdout);
        expect(run.rows.length === 1 && run.rows[0].provider.includes(orOther) && run.rows[0].turn === "ok" && run.rows[0].tool === "tarsee_calculator", "the row didn't pass", tableOf(run));
        return { model: orOther, secs: run.secs };
      });
    } else if (want("verify-openrouter")) {
      results.push({ name: "verify-openrouter: skipped (OpenRouter's public model list has no other maker's model to try: no internet?)", ok: true });
      log("SKIP verify-openrouter: no model by another maker on OpenRouter's list");
    }
    await check("verify scenarios: every test chat was deleted", async () => {
      const after = await chats();
      expect(after === before2, `chats before ${before2}, after ${after}`);
    });
  }

  // --- llama.cpp's llama-server as the Local AI: it drops the namespace tool Codex 0.167 puts Tarsee's tools in, so
  // without the Local AI bridge Verify's tool check and the calculator chat fail; through the bridge they pass.
  if (!SKIP_VERIFY && want("verify-local-llama")) {
    const before3 = await chats();
    await check(`verify-local-llama: Local AI on llama-server (${LLAMA_MODEL}), --only local --verify: Test names the build and the context, Verify and the calculator pass through the bridge; exit 0`, async () => {
      const set = await api("PUT", "/api/ai/providers/local", { baseUrl: `${llamaMux.origin}/v1`, model: LLAMA_MODEL });
      expect(set.status === 200, `PUT /api/ai/providers/local answered ${set.status}`, set.text);
      fakeL.reset();
      const run = await runSmoke("verify-local-llama", ["--only", "local", "--verify"]);
      expect(run.code === 0, `exit ${run.code}`, run.stdout.split(/\r?\n/).filter((l) => /FAIL|WARN/.test(l)));
      expect(/PASS local · test: Reached your Local AI · llama\.cpp b12238 · 1 model · 64K context/.test(run.stdout), "Test doesn't name llama.cpp's build and context", run.stdout);
      expect(new RegExp(`PASS local · ${LLAMA_MODEL.replace(/[.]/g, "\\.")} · verify: passed on codex`).test(run.stdout), "no PASS line for Verify", run.stdout);
      expect(run.rows.length === 1 && run.rows[0].turn === "ok" && run.rows[0].tool === "tarsee_calculator" && run.rows[0].cost === "Free", "the chat didn't use the calculator", tableOf(run));
      // What the bridge sent llama-server: plain function tools (nothing for it to drop), no namespace in the history.
      // (Test's own POST /v1/responses with no input isn't a model request.)
      const model = fakeL.responses().filter((r) => r.body && typeof r.body === "object" && r.body.input !== undefined);
      expect(model.length >= 4, `${model.length} model requests`);
      expect(model.every((r) => Array.isArray(r.dropped) && r.dropped.length === 0), "llama-server had a tool to drop", model.map((r) => r.dropped));
      expect(model.every((r) => fr.toolNames(r.body).includes("mcp__tarsee__tarsee_calculator")), "Tarsee's calculator wasn't offered as a plain function", fr.toolNames(model[0].body));
      expect(model.every((r) => !(r.body.input || []).some((i) => i?.namespace)), "a namespace reached llama-server in the history");
      expect(model.every((r) => r.headers.authorization === `Bearer ${KEYS.local}`), "the owner's key didn't reach llama-server (or something else did)", model.map((r) => r.headers.authorization?.slice(0, 12)));
      // And without the bridge: Codex's own request (Tarsee's tools in their namespace) straight to llama-server, as
      // before the bridge: it drops the namespace, and the model has no calculator to call.
      const direct = await fetch(`${llamaMux.origin}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEYS.local}` },
        body: JSON.stringify({
          model: LLAMA_MODEL, stream: true,
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: {} } }, { type: "namespace", name: "mcp__tarsee", tools: [{ type: "function", name: "tarsee_calculator", parameters: { type: "object", properties: {} } }] }],
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Use Tarsee's calculator tool to work out 12 * 34, then reply with just the number." }] }],
        }),
      });
      const words = await direct.text();
      const last = fakeL.responses().at(-1);
      expect(last.dropped.includes("namespace") && /No tarsee_calculator was offered/.test(words), "straight to llama-server, the calculator was still offered", { dropped: last.dropped, words: clip(words, 300) });
      return { secs: run.secs, modelRequests: model.length, withoutTheBridge: "namespace dropped, no calculator offered" };
    });
    const back = await api("PUT", "/api/ai/providers/local", { baseUrl: `${localMux.origin}/v1`, model: LOCAL_MODELS[0] });
    if (back.status !== 200) log(`WARN Local AI's address couldn't be set back: ${back.status}`);
    await check("verify-local-llama: every test chat was deleted", async () => {
      const after = await chats();
      expect(after === before3, `chats before ${before3}, after ${after}`);
    });
  }

  MODES.deepseek = "401";
  if (want("rejected-key")) await check("rejected-key: DeepSeek turns the key down: exit 1, test and turn fail in the table, the key never printed", async () => {
    const run = await runSmoke("rejected-key", ["--only", "deepseek"]);
    expect(run.code === 1, `exit ${run.code}`, run.stdout);
    const r = run.rows[0];
    // A Test that sees the key rejected flags the card, so the chat is then refused ("skipped") rather than sent.
    expect(run.rows.length === 1 && r.test === "FAIL" && ["FAIL", "skipped"].includes(r.turn), "the row doesn't show the failure", tableOf(run));
    expect(/FAIL deepseek · test: .*DeepSeek/i.test(run.stdout) && /FAIL deepseek · .* · turn: .*DeepSeek key was rejected/i.test(run.stdout), "no plain words for the rejected key", run.stdout);
    return { row: r };
  });
  MODES.deepseek = "ok";

  MODES.openai = "401-turn";
  if (want("rejected-turn")) await check("rejected-turn: OpenAI's Test passes, then the model turns the key down mid-chat (quoting it): exit 1, turn FAIL in OpenAI's words, the key never printed", async () => {
    const run = await runSmoke("rejected-turn", ["--only", "openai"]);
    expect(run.code === 1, `exit ${run.code}`, run.stdout);
    const r = run.rows[0];
    expect(run.rows.length === 1 && r.test === "ok" && r.turn === "FAIL" && r.tool === "-" && r.cost === "-", "the row doesn't show a turn that failed after a good Test (and nothing else)", tableOf(run));
    expect(/FAIL openai · .* · turn: Your OpenAI key was rejected/.test(run.stdout), "no plain words (without Markdown) for the rejected key", run.stdout);
    expect(!/· usage:/.test(run.stdout) && run.secs < 45, `a failed turn's usage was waited for (${run.secs} s)`, run.stdout);
    return { row: r };
  });
  MODES.openai = "ok";

  if (want("not-ready")) await check("not-ready: --only claude with no Claude sign-in: exit 1, the test says so and the chat is refused", async () => {
    const run = await runSmoke("not-ready", ["--only", "claude"]);
    expect(run.code === 1, `exit ${run.code}`, run.stdout);
    expect(run.rows.length === 1 && run.rows[0].test === "FAIL" && run.rows[0].turn === "skipped", "the row doesn't show it", tableOf(run));
  });

  if (want("bad-options")) await check("bad options: a stray argument (a pasted key) is refused without being shown", async () => {
    const run = await runSmoke("bad-options", [KEYS.openai, "--only", "nope"]);
    expect(run.code === 1, `exit ${run.code}`, run.stdout);
    expect(/isn't an option/.test(run.stdout) && /isn't an AI Tarsee knows/.test(run.stdout), "no words for the bad options", run.stdout);
  });

  // --- A reply that never finishes: Tarsee keeps a turn running when the page that sent it goes away, so the test
  // must stop it (as the chat's Stop does) and see it over before it deletes the chat, or the turn runs on, on the
  // owner's key, in a chat nobody can see.
  for (const [name, how, words] of [
    ["cut-stream", "destroy", "resets the chat's connection"],
    ["cut-stream-clean", "end", "closes the chat's connection cleanly, with no \"done\""],
  ]) {
    if (!want(name)) continue;
    const before = await chats();
    const hangsBefore = HANGS.length;
    const callsBefore = dsMux.requests.length;
    const front = await startTarseeFront(BASE, {
      cut: how,
      ready: () => HANGS.length > hangsBefore,
      beforeDelete: async (conv) => ({ activeTurn: (await api("GET", `/api/chat/conversations/${encodeURIComponent(conv)}`)).json?.activeTurn || null }),
    });
    MODES.deepseek = "hang";
    await check(`${name}: DeepSeek's model goes quiet mid-reply and a proxy ${words}: exit 1, the turn FAIL, then POST /api/chat/stop, the turn over, the engine's call ended, and only then the DELETE`, async () => {
      const run = await runSmoke(name, ["--only", "deepseek"], { url: front.origin });
      const order = front.requests.map((x) => `${x.method} ${x.path}`);
      expect(HANGS.length > hangsBefore, "the model was never left hanging, so the scenario didn't happen", run.stdout);
      const send = front.requests.findIndex((x) => x.method === "POST" && x.path === "/api/chat/send");
      expect(send >= 0 && front.requests[send].cutAt, "the proxy never cut the chat's connection", order);
      expect(run.code === 1, `exit ${run.code}`, run.stdout);
      expect(/FAIL deepseek · .* · turn: /.test(run.stdout), "no FAIL line for the turn", run.stdout);
      const conv = front.requests[send].conversationId;
      const stop = front.requests.findIndex((x, i) => i > send && x.method === "POST" && x.path === "/api/chat/stop" && x.conversationId === conv);
      const del = front.requests.findIndex((x) => x.method === "DELETE" && x.path === `/api/chat/conversations/${encodeURIComponent(conv)}`);
      expect(stop > send, "no POST /api/chat/stop for the chat after its reply was cut", order.slice(send));
      expect(del > stop, "the chat wasn't deleted after the stop", order.slice(send));
      expect(front.requests[del].before && !front.requests[del].before.error && !front.requests[del].before.activeTurn, "the chat's turn was still at work on Tarsee when its DELETE came", front.requests[del].before);
      // The engine's own call to the model, held open until then, ended once the stop came: the engine's signal fired.
      const call = await until(() => dsMux.requests.slice(callsBefore).find((x) => x.cutAt), { timeoutMs: 10_000 });
      expect(call && call.cutAt >= front.requests[stop].at, "the engine's call to the model wasn't ended by the stop", { call: call || null, stopAt: front.requests[stop].at });
      expect(/INFO deepseek · .* · cleanup: the reply didn't finish, so its turn was stopped first/.test(run.stdout), "no line saying the turn was stopped first", run.stdout);
      expect(/PASS deepseek · .* · cleanup: the test chat is deleted/.test(run.stdout), "no line saying the chat was deleted", run.stdout);
      // (From the turn's line, not the whole run: live-smoke may first wait out Tarsee's limit of five sign-ins a minute.)
      const at = (re) => Number(/^\[\s*([\d.]+)s\]/.exec(run.stdout.split(/\r?\n/).find((l) => re.test(l)) || "")?.[1]);
      const tookSecs = at(/ · cleanup: the test chat is deleted/) - at(/FAIL deepseek · .* · turn: /);
      expect(!/· usage:/.test(run.stdout) && tookSecs < 20, `an unfinished turn's usage was waited for (${tookSecs} s from the turn to the delete)`, run.stdout);
      const after = await chats();
      expect(after === before, `chats before ${before}, after ${after}`);
      return { order: order.slice(send), stopToCallEnded: call.cutAt - front.requests[stop].at, turnToDeleteSecs: tookSecs };
    });
    MODES.deepseek = "ok";
    await front.close();
  }

  // --- A 4-digit password (SETUP_PASSWORD is often a PIN): Tarsee started again with this year as its password, and
  // every chat's factors carrying it. Nothing is blanked out of the date, the sums or anything else live-smoke prints.
  const PIN = String(new Date().getUTCFullYear());
  if (want("pin-password")) await killServer();
  if (want("pin-password")) await bootServer({ tmp, fakeA, dsMux, orMux, fakeR, chatgptMux, caFile, trap, password: PIN });
  if (want("pin-password")) await check(`pin-password: Tarsee with a 4-digit SETUP_PASSWORD (this year), every chat's factors carrying it: exit 0, and the header's date, every sum and every other number print whole`, async () => {
    const signed = await signIn(PIN);
    expect(signed.login === 200 && signed.csrf === 200, `the harness couldn't sign in with the 4-digit password (${signed.login}, ${signed.csrf})`);
    const before = await chats();
    const factors = [10001, Number(PIN), Number(`${PIN}7`), 3917, Number(`4${PIN}`), Number(PIN.slice(0, 3))];
    // Every AI by name: rejected-turn left OpenAI's card flagged, and naming it has its Test (which now passes) clear it.
    const run = await runSmoke("pin-password", ["--only", "anthropic,chatgpt,openai,openrouter,deepseek,local"], { password: PIN, factors });
    const lines = run.stdout.split(/\r?\n/);
    expect(new RegExp(`\\(live test, ${PIN}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\)`).test(lines[0]), "the header's date isn't whole", lines[0]);
    // Nothing in a run where every step passes is secret, so nothing in it is blanked out: a "[redacted]" here is the
    // password matched inside a date, a number or a model id, and the gap gives it away.
    const blanked = lines.filter((l) => l.includes("[redacted]"));
    expect(blanked.length === 0, `${blanked.length} lines with something blanked out`, blanked);
    expect(run.code === 0, `exit ${run.code}`, lines.filter((l) => /FAIL|WARN/.test(l)));
    const sums = lines.map((l) => /worked out (\d+) \* (\d+) = (\d+)/.exec(l)).filter(Boolean);
    expect(run.rows.length === 7 && sums.length === run.rows.length, `${sums.length} sums for ${run.rows.length} rows`, run.stdout);
    expect(sums.every(([, a, b]) => a.includes(PIN) || b.includes(PIN)), "a chat's factors didn't carry the password, so the scenario didn't happen", sums.map(([s]) => s));
    const wrong = sums.filter(([, a, b, p]) => Number(a) * Number(b) !== Number(p));
    expect(wrong.length === 0, "a printed sum doesn't add up", wrong.map(([s]) => s));
    // Never printed as itself: with the header's date and the sums taken out, the password stands alone nowhere.
    const rest = run.stdout.replace(/\(live test, [^)]*\)/, "").replace(/worked out \d+ \* \d+ = \d+/g, "");
    const alone = new RegExp(`(?<![\\d.,])${PIN}(?![\\d.,])`).exec(rest);
    expect(!alone, "the password stands alone in what live-smoke printed", alone && clip(rest.slice(Math.max(0, alone.index - 80), alone.index + 20), 120));
    const after = await chats();
    expect(after === before, `chats before ${before}, after ${after}`);
    return { secs: run.secs, sums: sums.map(([s]) => s) };
  });

  // --- Scans ---
  await check("nothing live-smoke printed carries a key, token, cookie, password or canary", async () => {
    const found = Object.values(runs).flatMap((run) => leaksIn(`${run.stdout}\n${run.stderr}`).map((f) => `${run.name}: ${f}`));
    expect(found.length === 0, `${found.length} found`, found);
  });
  await check("live-smoke wrote nothing to stderr", async () => {
    const noisy = Object.values(runs).filter((run) => run.stderr.trim()).map((run) => `${run.name}: ${clip(run.stderr, 300)}`);
    expect(noisy.length === 0, "stderr output", noisy);
  });
  await check("no stripped host variable was followed: the trap got nothing", async () => {
    expect(trap.hits.length === 0, `${trap.hits.length} requests reached OPENAI_BASE_URL/ANTHROPIC_BASE_URL`, trap.hits.slice(0, 10));
  });
  await check("no key or password in the server's stdout/stderr", async () => {
    const found = [...Object.values(KEYS), SETUP_PASSWORD, WRONG_PASSWORD].filter((s) => serverLog.includes(s));
    expect(found.length === 0, `found ${found.length}`, found.map((s) => `${s.slice(0, 12)}…`));
  });
} catch (err) {
  results.push({ name: "harness", ok: false, error: err?.stack || String(err) });
  log("HARNESS ERROR", err?.stack || err);
} finally {
  await killServer();
  for (const f of [fakeA, fakeR, fakeL, dsMux, orMux, localMux, llamaMux, chatgptMux, trap]) await f?.close().catch(() => {});
  fs.writeFileSync(path.join(OUT, "live-smoke-fakes.server.log"), scrub(serverLog));
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, "live-smoke-fakes.json"), JSON.stringify(JSON.parse(scrub(JSON.stringify({ passed, failed: failed.length, results, tmp }))), null, 2));
  for (const name of ["all-ready", "verify-local", "verify-local-llama", "verify-openrouter", "rejected-key", "rejected-turn", "cut-stream", "cut-stream-clean", "pin-password"]) {
    if (runs[name]) console.log(`\n=== live-smoke ${name} (exit ${runs[name].code}, ${runs[name].secs} s): node scripts/e2e/live-smoke.mjs ${runs[name].args.join(" ")}\n${tableOf(runs[name])}`);
  }
  log(`done: ${passed} passed, ${failed.length} failed. Results: ${path.join(OUT, "live-smoke-fakes.json")}; each run's output: ${path.join(OUT, "live-smoke-<scenario>.txt")}`);
  if (!KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment */ } }
  exitCode = failed.length ? 1 : 0;
}
process.exit(exitCode);

/** What the harness writes to disk: never a secret. */
function scrub(s) {
  let out = String(s);
  for (const k of SECRETS) if (k) out = out.split(k).join(`<secret …${k.slice(-4)}>`);
  return out;
}
