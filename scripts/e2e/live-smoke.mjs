#!/usr/bin/env node
/**
 * scripts/e2e/live-smoke.mjs: a live test of every connected AI on a RUNNING Tarsee, over HTTP only, with real keys
 * (docs/live-testing.md has the steps). It never touches Tarsee's files or database: it does what the owner would do
 * in the browser, one AI at a time.
 *
 * It signs in with the password (POST /api/auth/login, then GET /api/auth/csrf, as the page does), reads Settings >
 * AI's cards (GET /api/ai/providers) and, for every card that is ready (or each AI named in --only):
 *   test     POST /api/ai/test/:id, the card's Test button, with the balance OpenRouter and DeepSeek report
 *   models   ChatGPT only: the account's own models as the chat's model picker lists them (GET /api/models)
 *   verify   with --verify: POST /api/ai/verify/:id for the OpenRouter and Local AI models it is about to chat with
 *   turn     a fresh chat set to that AI and model (PUT /api/models/picker), one message through the real chat route
 *            (POST /api/chat/send, read to the end), asking for a product only Tarsee's calculator tool should work out
 *   tool     tarsee_calculator ran, returned the right number, and the reply carries it
 *   usage    the chat's usage row (GET /api/analytics/usage/chat/:id): provider, model, engine, tokens, cost
 *   cleanup  a turn that wasn't seen to end (the time ran out, the connection broke, the stream ended with no "done")
 *            is stopped first (POST /api/chat/stop, the chat's Stop) and waited for until the chat shows no turn at
 *            work; then the test chat is deleted (--keep keeps it). Tarsee keeps a turn running when the page that
 *            sent it goes away, so a chat deleted under it would leave it running on the key with no Stop to press.
 * OpenRouter gets two chats, one on each engine (a Claude model on Claude Code, an OpenAI model on Codex), unless
 * --model names its own. ChatGPT's chat names no model: the account's default runs, as a new chat would.
 *
 *   node scripts/e2e/live-smoke.mjs [options]          (TARSEE_URL and TARSEE_PASSWORD set in the shell)
 *     --only a,b             just these AIs: claude anthropic chatgpt openai openrouter deepseek local
 *     --model id=model,...   chat with this model on that AI instead of its card's (OpenRouter may take two)
 *     --verify [list]        verify first. Alone: every OpenRouter and Local AI chat's model. A list of ids
 *                            (openrouter,local) or id=model items; an id=model also adds a chat on that model
 *     --keep                 keep the test chats (they are deleted by default)
 *     --timeout <seconds>    how long one reply may take (default 300)
 *
 * The address and password come only from the environment, never from arguments, and are never printed. Nothing it
 * prints carries a key, a token, a cookie or the password: every line goes through redact() (key-shaped text, Bearer
 * and cookie values, every cookie value it was given, and the password when it is long enough to blank out safely: a
 * short one, like a 4-digit PIN, is never in a line, and a gap in a date or a number would give it away). Exit code
 * 0 when every step passed, else 1.
 */
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

// --- What is never printed -----------------------------------------------------------------------------------------

const SECRETS = new Set();

/**
 * The shortest value redact() blanks out wherever it appears. Tarsee's cookie values are 40 characters and more. A
 * shorter secret, like a 4-digit SETUP_PASSWORD, is left out: the script never puts the password in a line, and a
 * short value blanked out of the dates, sums and model ids it prints shows exactly what it was ("[redacted]-11-10" is
 * the year; "worked out [redacted]7 * 3917 = 180796969" gives it to anyone who divides).
 */
const MIN_SECRET_LENGTH = 16;

/** A value that must never be printed (the password, a cookie's value), as it is and as it is URL-encoded. */
export function addSecret(value) {
  const add = (s) => { if (s.length >= MIN_SECRET_LENGTH) SECRETS.add(s); };
  const s = String(value ?? "");
  add(s);
  try { add(encodeURIComponent(s)); } catch { /* not encodable: the raw value is enough */ }
  try { add(decodeURIComponent(s)); } catch { /* not encoded */ }
}

/** Key-shaped text, whatever key it is: [pattern, replacement]. */
const KEY_SHAPES = [
  // Provider keys and Claude sign-in tokens: sk-..., sk-ant-..., sk-or-v1-..., sk-proj-..., DeepSeek's sk-<hex>
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]"],
  [/\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{8,}/g, "[redacted]"],
  // JWTs: ChatGPT's access and id tokens
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]"],
  // Authorization header values
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]"],
  // A key, token, password or cookie after its label: x-api-key: ..., "refresh_token": "...", password=...
  [/((?:x-api-key|api[_-]?key|apikey|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|secret|client[_-]?secret|cookie|set-cookie)["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi, "$1[redacted]"],
  // Tarsee's own cookies
  [/\b(tarsee_session|tarsee_csrf)=[^;\s"',]+/g, "$1=[redacted]"],
  // Refresh tokens, GitHub, Slack, Google, AWS
  [/\brt[-_][A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\b(?:gh[opsur]_|github_pat_)[A-Za-z0-9_]{10,}/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  // Long opaque runs: hex (session ids, encryption keys) and base64url (tokens of any provider)
  [/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]"],
  [/[A-Za-z0-9_-]{40,}/g, "[redacted]"],
];

/** Text with every secret it was given and everything key-shaped taken out. */
export function redact(text, secrets = SECRETS) {
  let out = String(text ?? "");
  for (const s of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(s).join("[redacted]");
  for (const [re, to] of KEY_SHAPES) out = out.replace(re, to);
  return out;
}

// --- Options -------------------------------------------------------------------------------------------------------

export const PROVIDER_IDS = ["claude", "anthropic", "chatgpt", "openai", "openrouter", "deepseek", "local"];

const USAGE = `Usage: node scripts/e2e/live-smoke.mjs [--only a,b] [--model id=model,...] [--verify [list]] [--keep] [--timeout <s>]
Set TARSEE_URL (for example http://localhost:3000) and TARSEE_PASSWORD (Tarsee's SETUP_PASSWORD) in the shell first.
AIs: ${PROVIDER_IDS.join(" ")}. See docs/live-testing.md.`;

/** The options, and what was wrong with them (never echoing a value that isn't an option: it could be a key). */
export function parseArgs(argv) {
  const o = { only: null, models: [], verify: null, keep: false, timeoutSec: 300, help: false, errors: [] };
  const list = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean);
  const knownId = (id, flag) => {
    if (PROVIDER_IDS.includes(id)) return true;
    o.errors.push(`${flag}: "${id.slice(0, 20)}" isn't an AI Tarsee knows (use ${PROVIDER_IDS.join(", ")})`);
    return false;
  };
  const pair = (item, flag) => {
    const i = item.indexOf("=");
    const id = i > 0 ? item.slice(0, i).trim() : "";
    const model = i > 0 ? item.slice(i + 1).trim() : "";
    if (!id || !model) { o.errors.push(`${flag} takes id=model items (for example openrouter=openai/gpt-5.5)`); return null; }
    return knownId(id, flag) ? { provider: id, model } : null;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : null;
    const value = () => (inline !== null ? inline : (i + 1 < argv.length && !String(argv[i + 1]).startsWith("--") ? String(argv[++i]) : null));
    switch (flag) {
      case "--help": case "-h": o.help = true; break;
      case "--keep": o.keep = true; break;
      case "--only": {
        const v = value();
        if (!v) { o.errors.push("--only takes a list of AIs, for example --only deepseek,openrouter"); break; }
        o.only = list(v).filter((id) => knownId(id, "--only"));
        break;
      }
      case "--model": {
        const v = value();
        if (!v) { o.errors.push("--model takes id=model, for example --model openrouter=openai/gpt-5.5"); break; }
        for (const item of list(v)) { const p = pair(item, "--model"); if (p) o.models.push(p); }
        break;
      }
      case "--verify": {
        o.verify ||= { all: false, ids: new Set(), extra: [] };
        const v = value();
        if (!v) { o.verify.all = true; break; }
        for (const item of list(v)) {
          if (item.includes("=")) { const p = pair(item, "--verify"); if (p) o.verify.extra.push(p); } else if (knownId(item, "--verify")) o.verify.ids.add(item);
        }
        break;
      }
      case "--timeout": {
        const n = Number(value());
        if (!Number.isFinite(n) || n < 10 || n > 3600) o.errors.push("--timeout takes a number of seconds between 10 and 3600");
        else o.timeoutSec = n;
        break;
      }
      default:
        // A stray argument may be a key or the password pasted in the wrong place: say so without showing it.
        o.errors.push(a.startsWith("--") ? `Unknown option ${redact(flag).slice(0, 30)}` : "An argument that isn't an option was given and ignored (it isn't shown: the address and password go in TARSEE_URL and TARSEE_PASSWORD, never on the command line)");
    }
  }
  return o;
}

// --- Output --------------------------------------------------------------------------------------------------------

let T0 = Date.now();
let anyFailed = false;

/** One line per step: "[  12.3s] PASS deepseek · deepseek-flash · turn: ...". Every line is redacted. */
function say(status, who, step, detail) {
  if (status === "FAIL") anyFailed = true;
  const t = `${((Date.now() - T0) / 1000).toFixed(1)}s`.padStart(7);
  const text = `[${t}] ${status.padEnd(4)} ${who}${step ? ` · ${step}` : ""}${detail ? `: ${detail}` : ""}`;
  console.log(redact(text).replace(/[\r\n]+/g, " "));
}

const clip = (s, n = 220) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const thousands = (n) => Number(n || 0).toLocaleString("en-US");

/** Dollars as the owner reads them, with enough digits for a fraction of a cent: $1.25, $0.0021, $0.000012. */
export function dollars(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "$0.00";
  if (Math.abs(n) >= 0.01) return `$${n.toFixed(2)}`;
  const digits = Math.min(8, -Math.floor(Math.log10(Math.abs(n))) + 1);
  return `$${n.toFixed(digits)}`;
}

/** What a usage row cost, in the Usage page's words ("Included in plan", "Free", "$0.0021", "$0.00012 est."). */
export function costText(row) {
  if (!row) return "-";
  if (row.costNote === "plan") return "Included in plan";
  if (row.costNote === "free") return "Free";
  if (row.costNote === "unknown") return "Cost not known";
  if (row.costUsd == null || !Number.isFinite(Number(row.costUsd))) return "no cost";
  return `${dollars(row.costUsd)}${row.costNote === "est" ? " est." : ""}`;
}

/** The final table: provider | test | turn | tool | cost | notes. */
export function table(rows) {
  const head = ["provider", "test", "turn", "tool", "cost", "notes"];
  const body = rows.map((r) => [r.title, r.test, r.turn, r.tool, r.cost, r.notes.filter(Boolean).join("; ") || ""].map((c) => redact(String(c ?? "")).replace(/\|/g, "/")));
  const width = head.slice(0, 5).map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cells) => cells.map((c, i) => (i < 5 ? c.padEnd(width[i]) : c)).join(" | ").trimEnd();
  return [fmt(head), fmt(width.map((w) => "-".repeat(w)).concat("-----")), ...body.map(fmt)].join("\n");
}

// --- HTTP: Tarsee only ---------------------------------------------------------------------------------------------

class Tarsee {
  constructor(origin) {
    this.origin = origin;
    this.jar = new Map();
  }

  take(setCookie) {
    for (const c of [].concat(setCookie || [])) {
      const kv = String(c).split(";")[0];
      const i = kv.indexOf("=");
      if (i <= 0) continue;
      const value = kv.slice(i + 1);
      addSecret(value);
      this.jar.set(kv.slice(0, i).trim(), value);
    }
  }

  headers(method, body) {
    const h = { accept: "application/json, text/event-stream" };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (!["GET", "HEAD"].includes(method)) {
      const csrf = this.jar.get("tarsee_csrf");
      if (csrf) h["x-csrf-token"] = decodeURIComponent(csrf);
    }
    if (body !== undefined) {
      h["content-type"] = "application/json";
      h["content-length"] = Buffer.byteLength(body);
    }
    return h;
  }

  /** One request: {status, headers, text, json}, or {status: 0, error} when there was no answer. Never throws. */
  request(method, p, payload, { timeoutMs = 60_000 } = {}) {
    const url = new URL(p, this.origin);
    const lib = url.protocol === "https:" ? https : http;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
      const req = lib.request(url, { method, headers: this.headers(method, body) }, (res) => {
        this.take(res.headers["set-cookie"]);
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", (err) => done({ status: 0, error: err.message }));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
          done({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      // A plain timer for the whole request (a socket idle timeout would let a slow trickle run forever).
      const timer = setTimeout(() => { req.destroy(); done({ status: 0, error: `no answer in ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
      req.on("error", (err) => done({ status: 0, error: err.code ? `${err.code} ${err.message}` : err.message }));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /** POST and read a Server-Sent Events answer to its end: {status, events, timedOut?, error?, text?, json?}. */
  stream(p, payload, { timeoutMs = 300_000, idleMs = 120_000 } = {}) {
    const url = new URL(p, this.origin);
    const lib = url.protocol === "https:" ? https : http;
    const body = JSON.stringify(payload);
    return new Promise((resolve) => {
      const events = [];
      let status = 0;
      let settled = false;
      let idle = null;
      const done = (extra = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(idle);
        resolve({ status, events, ...extra });
      };
      const req = lib.request(url, { method: "POST", headers: this.headers("POST", body) }, (res) => {
        status = res.statusCode;
        this.take(res.headers["set-cookie"]);
        res.setEncoding("utf8");
        if (!String(res.headers["content-type"] || "").includes("text/event-stream")) {
          let text = "";
          res.on("data", (c) => { text += c; });
          res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } done({ text, json }); });
          return;
        }
        let buf = "";
        const poke = () => { clearTimeout(idle); idle = setTimeout(() => { req.destroy(); done({ error: `nothing came for ${Math.round(idleMs / 1000)} s` }); }, idleMs); };
        poke();
        res.on("data", (s) => {
          poke();
          buf += s.replace(/\r\n/g, "\n");
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: ?(.*)$/m.exec(chunk)?.[1];
            const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.replace(/^data: ?/, "")).join("\n");
            if (!event) continue;
            let parsed = data;
            try { parsed = JSON.parse(data); } catch { /* text */ }
            events.push({ event, data: parsed, at: Date.now() });
          }
        });
        res.on("error", (err) => done({ error: err.message }));
        res.on("end", () => done());
      });
      const timer = setTimeout(() => { req.destroy(); done({ timedOut: true }); }, timeoutMs);
      req.on("error", (err) => done({ error: err.code ? `${err.code} ${err.message}` : err.message }));
      req.write(body);
      req.end();
    });
  }
}

/** What an answer said went wrong, in a short line. */
function whyNot(r) {
  if (!r) return "no answer";
  if (r.status === 0) return r.error || "no answer";
  const msg = r.json?.error || r.json?.message || clip(r.text, 160);
  return `HTTP ${r.status}${msg ? `: ${typeof msg === "string" ? msg : JSON.stringify(msg)}` : ""}`;
}

// --- The run -------------------------------------------------------------------------------------------------------

/** The engine each AI's turns run on (OpenRouter's depends on the model's maker). */
const ENGINE = { claude: "claude-code", anthropic: "claude-code", deepseek: "claude-code", chatgpt: "codex", openai: "codex", local: "codex" };
const PLANS = new Set(["claude", "chatgpt"]);
const TEST_CHAT_TITLE = "Live test (live-smoke)";

/** OpenRouter's engine for a model: Claude Code for anthropic/*, Codex for openai/*, null for any other maker. */
export function openRouterEngine(model) {
  const m = String(model || "").replace(/^~/, "");
  if (/^anthropic\//.test(m)) return "claude-code";
  if (/^openai\//.test(m)) return "codex";
  return null;
}

function versionOf(id) {
  const m = /(\d+)(?:[.-](\d+))?/.exec(String(id).split("/").pop() || "");
  return m ? Number(m[1]) + (m[2] ? Number(`0.${m[2]}`) : 0) : 0;
}

/**
 * A model from OpenRouter's list for the other engine's chat: one the picker takes without Verify, a solid and cheap
 * one. Claude: the latest Haiku. OpenAI: the newest gpt-N-mini, else the newest gpt-N.
 */
export function pickOpenRouterModel(models, maker) {
  const usable = (models || []).filter((m) => m && m.id && m.inMenu !== false && !m.needsVerification && !m.free
    && m.id.replace(/^~/, "").startsWith(`${maker}/`) && !/image|audio|realtime|search|tts|transcribe|embed|moderation|:free/i.test(m.id));
  const newest = (list) => [...list].sort((a, b) => versionOf(b.id) - versionOf(a.id))[0] || null;
  if (maker === "anthropic") {
    return usable.find((m) => m.id === "~anthropic/claude-haiku-latest") || newest(usable.filter((m) => /claude-haiku/.test(m.id))) || usable[0] || null;
  }
  return newest(usable.filter((m) => /^openai\/gpt-\d+(\.\d+)?-mini$/.test(m.id)))
    || newest(usable.filter((m) => /^openai\/gpt-\d+(\.\d+)?$/.test(m.id)))
    || usable.find((m) => /^openai\/gpt-/.test(m.id)) || usable[0] || null;
}

const all = (events, type) => events.filter((e) => e.event === type);

/** The reply's text with thousands separators between digits taken out ("189,077,507" -> "189077507"). */
const plainDigits = (s) => String(s || "").replace(/(?<=\d)[,   '’](?=\d{3})/g, "");

export async function main(argv = process.argv.slice(2), env = process.env) {
  T0 = Date.now();
  anyFailed = false;
  if (env.TARSEE_PASSWORD) addSecret(env.TARSEE_PASSWORD);
  const o = parseArgs(argv);
  if (o.help) { console.log(USAGE); return 0; }
  if (o.errors.length) {
    for (const e of o.errors) say("FAIL", "options", null, e);
    console.log(redact(USAGE));
    return 1;
  }

  const rawUrl = String(env.TARSEE_URL || "").trim();
  const password = String(env.TARSEE_PASSWORD || "");
  if (!rawUrl || !password) {
    say("FAIL", "setup", null, `Set ${[!rawUrl && "TARSEE_URL", !password && "TARSEE_PASSWORD"].filter(Boolean).join(" and ")} in this shell first (docs/live-testing.md)`);
    return 1;
  }
  let base;
  try { base = new URL(rawUrl); } catch { base = null; }
  if (!base || !/^https?:$/.test(base.protocol)) { say("FAIL", "setup", null, "TARSEE_URL must be an http:// or https:// address, for example http://localhost:3000"); return 1; }
  if (base.username || base.password) { say("FAIL", "setup", null, "TARSEE_URL has a user name or password in it: take it out (the password goes in TARSEE_PASSWORD only)"); return 1; }
  const tarsee = new Tarsee(base.origin);
  const api = (method, p, body, opts) => tarsee.request(method, p, body, opts);
  const timeoutMs = o.timeoutSec * 1000;

  /** A request again after the wait Tarsee asks for (a per-minute limit), when it says how long and that is short. */
  async function patient(what, who, fn, maxWaitSec = 90) {
    let r = await fn();
    const wait = Number(r.headers?.["retry-after"]);
    if (r.status === 429 && Number.isFinite(wait) && wait <= maxWaitSec) {
      say("INFO", who, what, `Tarsee allows only a few of these a minute; waiting ${wait} s, then trying again`);
      await sleep((wait + 1) * 1000);
      r = await fn();
    }
    return r;
  }

  // Test chats still open, deleted if the run is stopped with Ctrl+C.
  const openChats = new Set();
  const onSigint = async () => {
    say("INFO", "tarsee", "stopped", o.keep ? "stopping their turns and leaving the test chats" : "stopping their turns and deleting the test chats first");
    for (const id of openChats) {
      await stopTurn(id, 5000);
      if (!o.keep) await api("DELETE", `/api/chat/conversations/${encodeURIComponent(id)}`, undefined, { timeoutMs: 5000 });
    }
    process.exit(130);
  };
  process.once("SIGINT", onSigint);

  // --- Sign in, as the page does ---
  say("INFO", "tarsee", null, `${base.origin} (live test, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`);
  const health = await api("GET", "/healthz", undefined, { timeoutMs: 15_000 });
  if (health.status !== 200) { say("FAIL", "tarsee", "reach", `Tarsee didn't answer at ${base.origin} (${whyNot(health)}). Is it running?`); return 1; }
  const status = await api("GET", "/api/auth/status");
  if (status.json && status.json.needsPassword === false) say("INFO", "tarsee", "sign in", "this Tarsee has no SETUP_PASSWORD set");
  const login = await patient("sign in", "tarsee", () => api("POST", "/api/auth/login", { password }));
  if (login.status !== 200 || !tarsee.jar.has("tarsee_session")) {
    const why = login.status === 401 ? "TARSEE_PASSWORD was turned down (it is Tarsee's SETUP_PASSWORD)" : whyNot(login);
    say("FAIL", "tarsee", "sign in", why);
    return 1;
  }
  const csrf = await api("GET", "/api/auth/csrf");
  if (csrf.status !== 200 || !tarsee.jar.has("tarsee_csrf")) { say("FAIL", "tarsee", "sign in", `no CSRF cookie (${whyNot(csrf)})`); return 1; }
  say("PASS", "tarsee", "sign in", "signed in with the password, as the page does");

  // --- The cards ---
  const cardsAnswer = await api("GET", "/api/ai/providers");
  if (cardsAnswer.status !== 200 || !Array.isArray(cardsAnswer.json?.providers)) { say("FAIL", "tarsee", "cards", `GET /api/ai/providers: ${whyNot(cardsAnswer)}`); return 1; }
  const cards = Object.fromEntries(cardsAnswer.json.providers.map((c) => [c.id, c]));
  say("INFO", "tarsee", "cards", cardsAnswer.json.providers.map((c) => `${c.id} ${c.state}${c.active ? " (default)" : ""}`).join(", "));
  for (const b of cardsAnswer.json.banners || []) say("INFO", "tarsee", "Settings > AI says", b.message);

  const wanted = new Set(o.only || cardsAnswer.json.providers.filter((c) => c.ready && c.shipped !== false).map((c) => c.id));
  for (const p of o.models) if (!o.only) wanted.add(p.provider);
  for (const p of o.verify?.extra || []) wanted.add(p.provider);
  const providers = PROVIDER_IDS.filter((id) => wanted.has(id));
  if (!providers.length) { say("FAIL", "tarsee", "cards", "no AI is ready. Connect one in Settings > AI (or name one with --only)"); return 1; }
  say("INFO", "tarsee", "plan", `testing ${providers.join(", ")}${o.verify ? " (with Verify)" : ""}`);

  const rows = [];
  const tests = {};
  for (const id of providers) {
    const card = cards[id];
    const who = id;
    if (!card) { say("FAIL", who, "card", "this Tarsee has no card for it"); rows.push(row(id, null, `${id}`)); continue; }

    // --- Test ---
    const t = await patient("test", who, () => api("POST", `/api/ai/test/${id}`, {}, { timeoutMs: 60_000 }));
    const test = { ok: t.status === 200 && t.json?.ok === true, balance: t.json?.balance?.text || null, account: t.json?.account || null };
    tests[id] = test;
    if (test.ok) say("PASS", who, "test", t.json.message || "ok");
    else say("FAIL", who, "test", t.status === 200 ? `${t.json?.message || "it didn't pass"} (${t.json?.state || "error"})` : whyNot(t));

    // --- The chats this AI gets ---
    const mine = [];
    const overrides = o.models.filter((m) => m.provider === id);
    if (overrides.length) for (const m of overrides) mine.push({ model: m.model, label: m.model, why: "--model" });
    else mine.push({ model: null, label: card.model || (id === "chatgpt" ? "account default" : "default model"), why: "card" });

    if (id === "chatgpt" && card.ready) {
      // The account's own models, as the picker lists them; the chat names none, so the account's default runs.
      const m = await api("GET", "/api/models", undefined, { timeoutMs: 120_000 });
      const group = (m.json?.groups || []).find((g) => g.provider === "chatgpt");
      if (m.status !== 200) say("FAIL", who, "models", `GET /api/models: ${whyNot(m)}`);
      else if (!group) say("FAIL", who, "models", `ChatGPT isn't in the chat's model picker (${(m.json?.unavailable || []).find((u) => u.provider === "chatgpt")?.detail || "not ready"})`);
      else {
        const ids = (group.sections || []).flatMap((s) => s.entries || []).map((e) => e.id).filter(Boolean);
        const def = group.defaultModel || null;
        if (ids.length) {
          say("PASS", who, "models", `${ids.length} on the account's list: ${ids.map((x) => (x === def ? `${x} (default)` : x)).join(", ")}`);
        } else {
          const n = await api("GET", "/api/ai/models/chatgpt", undefined, { timeoutMs: 120_000 });
          say("WARN", who, "models", n.json?.note || "the account's model list couldn't be read, so the chat names no model and Codex uses the account's default");
        }
        if (!overrides.length) Object.assign(mine[0], { label: def ? `account default (${def})` : "account default", expect: def });
        test.models = ids.length;
      }
    }

    if (id === "openrouter" && !overrides.length && card.ready) {
      // One chat on each engine: the card's model, then one by the other maker from OpenRouter's list.
      const cardEngine = openRouterEngine(card.model);
      const makers = cardEngine === "claude-code" ? ["openai"] : cardEngine === "codex" ? ["anthropic"] : ["anthropic", "openai"];
      const list = await api("GET", "/api/ai/models/openrouter", undefined, { timeoutMs: 60_000 });
      for (const maker of makers) {
        const pick = pickOpenRouterModel(list.json?.models, maker);
        if (pick) mine.push({ model: pick.id, label: pick.id, why: `the ${maker === "openai" ? "Codex" : "Claude Code"} chat` });
        else say("WARN", who, "models", `no ${maker}/* model OpenRouter offers was found (${list.status === 200 ? "its list didn't have one" : whyNot(list)}), so there is no ${maker === "openai" ? "Codex" : "Claude Code"} chat; name one with --model openrouter=${maker}/...`);
      }
    }

    for (const v of (o.verify?.extra || []).filter((x) => x.provider === id)) {
      const same = mine.find((m) => m.model === v.model);
      if (same) same.verify = true;
      else mine.push({ model: v.model, label: v.model, why: "--verify", verify: true, verifyOnly: true });
    }
    if (o.verify && (id === "openrouter" || id === "local") && (o.verify.all || o.verify.ids.has(id))) for (const m of mine) m.verify = true;

    for (const m of mine) {
      const r = row(id, m, `${id} · ${m.label}`);
      rows.push(r);
      r.test = test.ok ? "ok" : "FAIL";
      if (test.balance) r.notes.push(test.balance);
      await chatOnce(r, m, card);
    }
  }

  function row(provider, m, title) {
    return { provider, title, test: "-", turn: "-", tool: "-", cost: "-", notes: [], model: m?.model ?? null };
  }

  /**
   * Stop the chat's turn, as its Stop button does (POST /api/chat/stop), and wait up to waitMs for it to be over (the
   * chat shows no turn at work), so nothing it still writes lands after the chat is deleted. (A stopped Claude Code
   * turn can take about 7 s to end: the Agent SDK gives its CLI 2 s, then up to 5 s more before it kills it.)
   * {ended, stopped (there was a turn to stop), secs} or {ended: false, error}.
   */
  async function stopTurn(conv, waitMs = 15_000) {
    const started = Date.now();
    const s = await api("POST", "/api/chat/stop", { conversationId: conv }, { timeoutMs: 10_000 });
    if (s.status !== 200) return { ended: false, error: `POST /api/chat/stop: ${whyNot(s)}` };
    const stopped = s.json?.stopped === true;
    const end = started + waitMs;
    for (;;) {
      const c = await api("GET", `/api/chat/conversations/${encodeURIComponent(conv)}`, undefined, { timeoutMs: 10_000 });
      if (c.status === 404 || (c.status === 200 && !c.json?.activeTurn)) return { ended: true, stopped, secs: (Date.now() - started) / 1000 };
      if (Date.now() > end) {
        return { ended: false, stopped, error: c.status === 200 ? `it was still at work ${Math.round(waitMs / 1000)} s after Stop` : `the chat couldn't be read: ${whyNot(c)}` };
      }
      await sleep(500);
    }
  }

  /** Verify (when asked), then one chat on this AI and model, its usage row, and the chat deleted. */
  async function chatOnce(r, m, card) {
    const who = r.title;
    if (m.verify) {
      const model = m.model || card.model;
      if (!model) {
        say("FAIL", who, "verify", "there is no model to verify: choose one on the card first");
        r.notes.push("verify: no model");
      } else {
        const list = await api("GET", `/api/ai/models/${r.provider}`, undefined, { timeoutMs: 60_000 });
        const entry = (list.json?.models || []).find((x) => x.id === model);
        say("INFO", who, "verify", `${model}: four short test turns${entry?.verifyCost ? `, ${entry.verifyCost}` : ""}; this takes a minute or two`);
        const v = await patient("verify", who, () => api("POST", `/api/ai/verify/${r.provider}`, { model }, { timeoutMs: 25 * 60_000 }));
        if (v.status === 200 && v.json?.ok) {
          const checks = v.json.checks ? Object.entries(v.json.checks).map(([k, ok]) => `${k} ${ok ? "ok" : "no"}`).join(", ") : "";
          say("PASS", who, "verify", `passed on ${v.json.engine}${checks ? ` (${checks})` : ""}${v.json.efforts?.length ? `; effort levels ${v.json.efforts.join(", ")}` : ""}`);
          r.notes.push(`verified on ${v.json.engine}`);
          m.engine = v.json.engine;
        } else {
          say("FAIL", who, "verify", v.status === 200 ? (v.json?.error || v.json?.message || "it didn't pass") : whyNot(v));
          r.notes.push("verify failed");
          if (m.verifyOnly) { r.turn = "skipped"; r.notes.push("not chatted with: it didn't pass Verify"); return; }
        }
      }
    }

    // --- A fresh chat, set to this AI and model ---
    const a = crypto.randomInt(1000, 99_999);
    const b = crypto.randomInt(100, 9999);
    const product = a * b;
    const message = `Live test: use Tarsee's tarsee_calculator tool to work out ${a} * ${b}, then reply with just the number the tool gives you.`;
    const created = await api("POST", "/api/chat/conversations", { title: TEST_CHAT_TITLE });
    const conv = created.json?.id;
    if (!(created.status === 200 || created.status === 201) || !conv) {
      say("FAIL", who, "turn", `couldn't start a chat: ${whyNot(created)}`);
      r.turn = "FAIL";
      return;
    }
    openChats.add(conv);
    // A turn this chat sent that wasn't seen to end: it is stopped before the chat is deleted (or kept).
    let unfinished = false;
    try {
      const pick = { conversationId: conv, provider: r.provider };
      if (m.model) pick.model = m.model;
      const picked = await api("PUT", "/api/models/picker", pick);
      if (picked.status !== 200) {
        say("FAIL", who, "turn", `the chat couldn't be set to it: ${whyNot(picked)}${picked.json?.verify ? " (Verify it first: --verify)" : ""}`);
        r.turn = "skipped";
        r.notes.push(clip(picked.json?.error || `HTTP ${picked.status}`, 120));
        anyFailed = true;
        return;
      }

      // --- The turn ---
      const started = Date.now();
      unfinished = true;
      const s = await tarsee.stream("/api/chat/send", { conversationId: conv, message }, { timeoutMs });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const ev = s.events;
      const sel = all(ev, "model_selected")[0]?.data || null;
      // (Tarsee's error words carry the chat's Markdown bold, which a terminal shows as asterisks.)
      const errors = all(ev, "error").map((e) => String(e.data?.message || e.data || "").replace(/\*\*/g, ""));
      const dones = all(ev, "done");
      // Seen to end: Tarsee sent its "done" (it comes once the turn is over), or turned the message down with a 4xx
      // before any turn began. Anything else (the time running out, the connection cut, a stream that ended with no
      // "done", a proxy's 5xx, no answer at all) may have left the turn running on Tarsee.
      unfinished = !dones.length && !(s.status >= 400 && s.status < 500);
      const text = all(ev, "text").map((e) => e.data?.content ?? "").join("");
      const problems = [];
      if (s.status !== 200) problems.push(`HTTP ${s.status || "no answer"}${s.json?.error ? `: ${s.json.error}` : s.error ? `: ${s.error}` : ""}`);
      else {
        if (s.timedOut) problems.push(`no full reply in ${o.timeoutSec} s`);
        if (s.error) problems.push(`the reply broke off: ${s.error}`);
        if (!sel) problems.push("Tarsee never said which AI answered");
        else if (sel.provider !== r.provider) problems.push(`${sel.label || sel.provider} answered, not ${r.provider}${sel.backup ? " (the backup model)" : ""}`);
        if (errors.length) problems.push(errors[0]);
        if (dones.length !== 1 && !s.timedOut && !s.error) problems.push(`${dones.length} "done" events, not 1`);
        if (!text.trim() && !errors.length) problems.push("an empty reply");
      }

      // --- The tool (when there was a reply to look at: a refused or broken turn is already a failure) ---
      if (!problems.length) {
        const calls = all(ev, "tool_call").filter((e) => /tarsee_(calculator|datetime)/.test(String(e.data?.name || "")));
        const results = all(ev, "tool_result");
        const resultFor = (c) => results.find((x) => c.data?.id && x.data?.id === c.data.id) || results.find((x) => x.data?.name && x.data.name === c.data?.name) || null;
        const right = new RegExp(`=\\s*${product}(?!\\d)`);
        const calc = calls.find((c) => right.test(String(resultFor(c)?.data?.result || "")));
        if (calc) {
          r.tool = "tarsee_calculator";
          say("PASS", who, "tool", `${calc.data.name} worked out ${a} * ${b} = ${product}`);
        } else {
          const others = all(ev, "tool_call").map((e) => e.data?.name).filter(Boolean);
          r.tool = calls.length ? "wrong answer" : "none";
          const why = calls.length
            ? `${calls[0].data?.name} ran, but its result wasn't ${product}: ${clip(resultFor(calls[0])?.data?.result || "(no result)", 120)}`
            : `the AI didn't use Tarsee's calculator${others.length ? ` (it used ${[...new Set(others)].join(", ")})` : ""}`;
          say("FAIL", who, "tool", why);
          r.notes.push(why);
        }
        if (!new RegExp(`(^|\\D)${product}(\\D|$)`).test(plainDigits(text))) problems.push(`the reply doesn't carry the calculator's answer ${product}: "${clip(text, 100)}"`);
      }
      const ran = sel?.model || null;
      if (m.expect && ran && ran !== m.expect) r.notes.push(`ran ${ran}, the picker's default is ${m.expect}`);
      if (problems.length) {
        r.turn = "FAIL";
        say("FAIL", who, "turn", `${problems.join("; ")} (${secs} s)`);
        r.notes.push(clip(problems[0], 160));
      } else {
        r.turn = "ok";
        say("PASS", who, "turn", `${sel.label || sel.provider}${ran ? ` · ${ran}` : ""} answered "${clip(text, 80)}" in ${secs} s`);
      }

      // --- The usage row (for a turn that got a reply and ended: one that failed with an error used nothing to count,
      // and one that didn't finish is stopped below, not waited on here) ---
      if (!unfinished && s.status === 200 && sel && !errors.length && !s.timedOut && !s.error) {
        const u = await usageRow(conv, r.provider);
        if (!u.row) {
          r.cost = "FAIL";
          say("FAIL", who, "usage", `no usage row for the chat after 60 s${u.error ? ` (${u.error})` : ""}`);
          r.notes.push("no usage row");
        } else {
          const x = u.row;
          const tokens = (x.input || 0) + (x.cacheRead || 0) + (x.cacheWrite || 0) + (x.output || 0);
          const model = x.modelId && x.model && x.model !== x.modelId ? `${x.model} (${x.modelId})` : (x.modelId || x.model || "no model named");
          const wrong = [];
          if (x.provider && x.provider !== r.provider) wrong.push(`the row says ${x.provider}`);
          if (!tokens) wrong.push("it has no tokens");
          if (PLANS.has(r.provider) && x.costNote !== "plan") wrong.push(`a plan turn should say "Included in plan", not "${costText(x)}"`);
          if (!PLANS.has(r.provider) && x.costNote === "plan") wrong.push("an API-key turn says \"Included in plan\"");
          const want = m.engine || (r.provider === "openrouter" ? openRouterEngine(ran || m.model || card.model) : ENGINE[r.provider]);
          if (want && x.engine && x.engine !== want) wrong.push(`it ran on ${x.engine}, not ${want}`);
          r.cost = wrong.length ? `FAIL ${costText(x)}` : costText(x);
          r.title = `${r.provider} · ${x.modelId || ran || m.label}`;
          r.notes.unshift(`${thousands(tokens)} tokens (in ${thousands((x.input || 0) + (x.cacheRead || 0) + (x.cacheWrite || 0))}, out ${thousands(x.output)})`, x.engine || "");
          say(wrong.length ? "FAIL" : "PASS", who, "usage", `${x.providerLabel || x.provider} · ${model} · ${x.engine || "engine not recorded"} · ${thousands(tokens)} tokens · ${costText(x)}${wrong.length ? ` · ${wrong.join("; ")}` : ""}`);
          if (wrong.length) r.notes.push(wrong.join("; "));
        }
      }
    } finally {
      // Stopped first, --keep or not: Tarsee keeps a turn running when the page that sent it goes away (a cut
      // connection is one), and a deleted chat leaves no Stop to press while it runs on, on the owner's key.
      let leftRunning = false;
      if (unfinished) {
        const st = await stopTurn(conv);
        if (st.ended) {
          say("INFO", who, "cleanup", st.stopped ? `the reply didn't finish, so its turn was stopped first; it was over in ${st.secs.toFixed(1)} s` : "the reply didn't finish; its turn had already ended");
        } else {
          leftRunning = true;
          say("FAIL", who, "cleanup", `the unfinished turn couldn't be stopped (${st.error})${o.keep ? "" : ", so the test chat is kept"}: open "${TEST_CHAT_TITLE}" in Tarsee and press Stop`);
          r.notes.push("a turn left running in the test chat");
        }
      }
      if (o.keep) {
        say("INFO", who, "cleanup", "kept the test chat (--keep)");
      } else if (!leftRunning) {
        const d = await api("DELETE", `/api/chat/conversations/${encodeURIComponent(conv)}`, undefined, { timeoutMs: 30_000 });
        if (d.status === 200) say("PASS", who, "cleanup", "the test chat is deleted");
        else { say("FAIL", who, "cleanup", `the test chat couldn't be deleted: ${whyNot(d)}`); r.notes.push("test chat left behind"); }
      }
      openChats.delete(conv);
    }
  }

  /**
   * The chat's usage row once it is complete (the turn over and its tokens read), up to 60 s. Tokens and the model
   * come from the same records, so a row with tokens and no model ran the engine's own default (ChatGPT with no list).
   */
  async function usageRow(conv, provider) {
    const end = Date.now() + 60_000;
    let last = null;
    let error = null;
    for (;;) {
      const u = await api("GET", `/api/analytics/usage/chat/${encodeURIComponent(conv)}`, undefined, { timeoutMs: 30_000 });
      if (u.status === 200) {
        const list = (u.json?.recent || []).filter((t) => !t.provider || t.provider === provider);
        last = list.at(-1) || (u.json?.recent || []).at(-1) || last;
        const tokens = last ? (last.input || 0) + (last.cacheRead || 0) + (last.cacheWrite || 0) + (last.output || 0) : 0;
        if (last && !last.running && tokens > 0) return { row: last };
        error = null;
      } else error = whyNot(u);
      if (Date.now() > end) return { row: last, error };
      await sleep(1500);
    }
  }

  // --- The table ---
  process.removeListener("SIGINT", onSigint);
  console.log("");
  console.log(table(rows));
  console.log("");
  const failedRows = rows.filter((r) => [r.test, r.turn].includes("FAIL") || r.turn === "skipped" || /^FAIL/.test(r.cost) || ["none", "wrong answer"].includes(r.tool)).length;
  console.log(redact(anyFailed
    ? `Something failed${failedRows ? ` (${failedRows} of ${rows.length} rows)` : ""}: see the FAIL lines above.`
    : `Every step passed (${rows.length} chat${rows.length === 1 ? "" : "s"}).`));
  return anyFailed ? 1 : 0;
}

// Run when started as a script (not when another script imports redact() and friends).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (err) => {
    console.log(redact(`[live-smoke] stopped by an error: ${err?.stack || err}`));
    process.exit(1);
  });
}
