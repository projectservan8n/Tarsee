/**
 * mcp-http.js: Tarsee's own tools for the Codex engine, on a loopback MCP endpoint (design 4.9, rule R12).
 *
 * Claude Code takes Tarsee's tools as an in-process MCP server (tarsee-mcp.js). Codex runs as a child process and can
 * only reach an MCP server it starts itself or one over HTTP, so Tarsee serves the very same tools (createTarseeMcp, so
 * the same executeTool path, Tool Permissions, SSRF checks and audit log) over streamable HTTP, from inside the main
 * process:
 *
 *   - its own http server on 127.0.0.1, on a port the system picks (listen(0)), started on first use. It is never
 *     mounted on the Express app, so Railway's proxy can't reach it and the dashboard's login and CSRF don't apply;
 *   - each Codex turn gets a grant, {url, token, revoke()}: a fresh 32-byte bearer token tied to that turn's tool
 *     context. Codex reads it from TARSEE_MCP_TOKEN (bearer_token_env_var), which is not in its shell's environment
 *     (R7), though on Linux the shell can still read it from codex's /proc environ: the grant lasts one turn and is
 *     revoked when the turn ends, and Tool Permissions still apply to every call made with it;
 *   - every request must come from this machine, name this endpoint in its Host header (no DNS rebinding), carry no
 *     web page's Origin, and carry a live grant's token (compared in constant time); the body is capped at 4 MB, and
 *     only POST /mcp is served (stateless: a fresh MCP server and transport per request);
 *   - a tool result too long for the model's context (TARSEE_TOOL_RESULT_MAX_CHARS, default 12,000 characters, the
 *     same limit Claude Code applies) is saved to STATE_DIR/tool-output/<turn>/, outside the workspace and the files
 *     screen, and the model gets the path and the start of it. Those files are pruned after 7 days;
 *   - a grant ends when the turn revokes it (runTurn's finally), when the turn's stop signal fires, or when it
 *     expires (a backstop for a turn that never got to its finally).
 *
 * Logging is quiet: one line when it starts listening, refusals at most once a minute per kind, never a token.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createTarseeMcp } from "./tarsee-mcp.js";
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from "./context-limits.js";
import config from "../config/env.js";

/** Largest request body accepted (R12). */
export const MCP_BODY_LIMIT = 4 * 1024 * 1024;

/** How long a spilled tool result is kept. */
export const TOOL_OUTPUT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a grant lives when the turn names no limit of its own. A backstop only: the turn revokes its grant when it
 * ends, and its stop signal revokes it too. Interactive turns have no fixed length (only an idle abort), so this is
 * generous; a turn with a timeout passes it as ttlMs.
 */
export const DEFAULT_GRANT_TTL_MS = 6 * 60 * 60 * 1000;

const HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
const PRUNE_EVERY_MS = 12 * 60 * 60 * 1000;
const PREVIEW_CHARS = 2000;
/** Tool servers a grant keeps between requests (more only when Codex calls tools in parallel). */
const MAX_IDLE_SERVERS = 4;

/** The endpoint while it listens: {server, port, url, stateDir, pruneTimer}. */
let running = null;
/** The start in progress, so concurrent first grants share one server. */
let starting = null;
/** Live grants by id: {id, tokenHash, ctx, turnDir, expiresAt, seq, idle}. */
const grants = new Map();

/**
 * Most characters of one tool result the model gets inline; past it the result goes to a file. Same rule as
 * context-limits.js mcpOutputEnv(): TARSEE_TOOL_RESULT_MAX_CHARS when it is at least 1,000, else 12,000.
 */
export function spillThreshold(env = process.env) {
  const own = Number(env.TARSEE_TOOL_RESULT_MAX_CHARS);
  return Number.isFinite(own) && own >= 1000 ? Math.round(own) : DEFAULT_TOOL_RESULT_MAX_CHARS;
}

/** True only for this machine's own addresses (127.0.0.0/8, ::1, and their IPv4-mapped form). */
export function isLoopbackAddress(addr) {
  if (typeof addr !== "string" || !addr) return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  if (a === "::1") return true;
  return net.isIPv4(a) && a.startsWith("127.");
}

/**
 * Start the endpoint (once; later calls return the same one). Resolves {host, port, url, server, close}.
 * opts.stateDir: where tool-output/ goes (default config.STATE_DIR).
 */
export function startMcpHttp(opts = {}) {
  if (running) return Promise.resolve(endpointInfo());
  if (starting) return starting;
  const stateDir = opts.stateDir || config.STATE_DIR;
  if (!stateDir) return Promise.reject(new TypeError("startMcpHttp needs a state folder for long tool results"));
  starting = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        warnOnce("internal", `a request failed: ${err?.message || err}`);
        if (!res.headersSent) reply(res, 500, "Tarsee's tool endpoint failed on this request.");
        else res.destroy();
      });
    });
    server.on("error", (err) => {
      if (!running) { starting = null; reject(err); return; }
      warnOnce("server", `server error: ${err.message}`);
    });
    server.listen(0, HOST, () => {
      const { port } = server.address();
      server.unref();
      const pruneTimer = setInterval(() => safePrune(stateDir), PRUNE_EVERY_MS);
      pruneTimer.unref?.();
      running = { server, port, url: `http://${HOST}:${port}${MCP_PATH}`, stateDir, pruneTimer };
      starting = null;
      setImmediate(() => safePrune(stateDir));
      console.log(`[mcp-http] Tarsee's tools for Codex listening on ${HOST}:${port}`);
      resolve(endpointInfo());
    });
  });
  return starting;
}

/** Stop the endpoint and end every grant (shutdown, tests). */
export async function stopMcpHttp() {
  if (starting) await starting.catch(() => {});
  const current = running;
  running = null;
  grants.clear();
  if (!current) return;
  clearInterval(current.pruneTimer);
  await new Promise((resolve) => {
    current.server.close(() => resolve());
    current.server.closeAllConnections?.();
  });
}

/**
 * Grant one turn the use of Tarsee's tools: {url, token, expiresAt, revoke()}. The token goes to Codex as
 * TARSEE_MCP_TOKEN (codexEnvFor's mcpToken) and the url as the tarsee MCP server's url.
 *
 * ctx is the turn's tool context ({db, settingsStore, channelManager, conversationId, channel, ...}), exactly what
 * the tools get. opts:
 *   turnId  names the folder long results go in (default ctx.turnId, else the grant's own id)
 *   ttlMs   how long the grant may live (default DEFAULT_GRANT_TTL_MS); pass the turn's timeout when it has one
 *   signal  the turn's stop signal: aborting it revokes the grant
 *
 * Once the endpoint is listening the grant comes straight back; before that (the first turn after boot, when nothing
 * called startMcpHttp) it starts the endpoint and returns a promise of the grant, so `await grantTurn(ctx)` always
 * works.
 */
export function grantTurn(ctx, opts = {}) {
  if (!ctx || typeof ctx !== "object") throw new TypeError("grantTurn needs the turn's tool context");
  if (!running) return startMcpHttp().then(() => grantTurn(ctx, opts));
  const ttlMs = Number(opts.ttlMs ?? DEFAULT_GRANT_TTL_MS);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("grantTurn: ttlMs must be a positive number of milliseconds");

  const id = crypto.randomBytes(8).toString("hex");
  const token = crypto.randomBytes(32).toString("base64url");
  const turnDir = safeName(opts.turnId ?? ctx.turnId) || `grant-${id}`;
  const expiresAt = Date.now() + ttlMs;
  grants.set(id, { id, tokenHash: hashToken(token), ctx, turnDir, expiresAt, seq: 0, idle: [] });

  const signal = opts.signal;
  const revoke = () => {
    grants.delete(id);
    signal?.removeEventListener?.("abort", revoke);
  };
  if (signal?.aborted) revoke();
  else signal?.addEventListener?.("abort", revoke, { once: true });

  return { url: running.url, token, expiresAt, revoke };
}

/** The design's name for grantTurn (section 4.9). */
export const grantMcp = grantTurn;

/** How many grants are live (turns holding the tools right now). */
export function grantCount() {
  const now = Date.now();
  for (const [id, g] of grants) if (now >= g.expiresAt) grants.delete(id);
  return grants.size;
}

/**
 * Remove turn folders (and stray files) under the tool-output folder untouched for maxAgeMs. Returns how many went.
 * A folder's time moves on with every result saved in it, so a folder goes a week after its turn's last long result.
 */
export function pruneToolOutput({ dir, maxAgeMs = TOOL_OUTPUT_KEEP_MS, now = Date.now() } = {}) {
  const root = dir || path.join(running?.stateDir || config.STATE_DIR, "tool-output");
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    try {
      if (fs.lstatSync(full).mtimeMs >= now - maxAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch { /* gone already, or busy: next round */ }
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------------------------
// Requests

function endpointInfo() {
  const { server, port, url } = running;
  return { host: HOST, port, url, server, close: stopMcpHttp };
}

async function handle(req, res) {
  const port = running?.port;
  if (!port) return reply(res, 503, "Tarsee's tool endpoint is shutting down.");

  // Only this machine. The server listens on 127.0.0.1 only; this is the second lock.
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    warnOnce("remote", "refused a caller that is not on this machine");
    return reply(res, 403, "Only this machine may use this endpoint.");
  }
  // The Host must name this endpoint, so a web page that rebinds its own domain to 127.0.0.1 gets nowhere.
  const host = String(req.headers.host || "").toLowerCase();
  if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) {
    warnOnce("host", "refused a request for another host (Host header)");
    return reply(res, 403, "Wrong Host for this endpoint.");
  }
  // Codex sends no Origin; a browser does. Nothing in a web page may call this endpoint.
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`) {
    warnOnce("origin", "refused a request a web page sent (Origin header)");
    return reply(res, 403, "Web pages may not use this endpoint.");
  }
  let pathname;
  try {
    pathname = new URL(req.url || "/", `http://${HOST}:${port}`).pathname;
  } catch {
    pathname = "";
  }
  if (pathname !== MCP_PATH) return reply(res, 404, "Not found.");

  const grant = grantFor(req.headers.authorization);
  if (!grant) {
    warnOnce("token", "refused a request without a live grant's token");
    return reply(res, 401, "This needs a live grant's token.", { "WWW-Authenticate": 'Bearer realm="tarsee"' });
  }
  if (req.method !== "POST") return reply(res, 405, "Only POST is served here.", { Allow: "POST" });

  const body = await readBody(req, MCP_BODY_LIMIT);
  if (body.tooLarge) {
    warnOnce("size", "refused a request body over 4 MB");
    return reply(res, 413, "The request is over 4 MB.");
  }
  let message;
  try {
    message = JSON.parse(body.text);
  } catch {
    return reply(res, 400, "Parse error: the body is not JSON.", {}, -32700);
  }
  await serve(req, res, grant, message);
}

/**
 * Run one stateless MCP exchange for the grant's turn: Tarsee's tool server around that turn's context, on a transport
 * made for this request. A turn's requests come one after another (initialize, tools/list, each call), so the server
 * goes back to the grant when its request is answered in full and the next request reuses it: it is built about once
 * per turn, as on Claude Code, instead of once per request. One whose client went away mid-call is dropped, so a late
 * answer can never land on another request.
 */
async function serve(req, res, grant, message) {
  // Notifications only (initialized, cancelled): nothing to answer, and in a stateless exchange nothing to act on.
  if (onlyNotifications(message)) {
    res.writeHead(202);
    res.end();
    return;
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const calls = toolCallsIn(message);
  if (calls.size) {
    const send = transport.send.bind(transport);
    transport.send = async (msg, options) => send(await spillIfLong(msg, calls, grant), options);
  }
  let mcp = grant.idle.pop();
  try {
    if (!mcp) throw new Error("none idle");
    await mcp.instance.connect(transport);
  } catch {
    mcp = createTarseeMcp(grant.ctx, { quiet: true });
    await mcp.instance.connect(transport);
  }
  res.on("close", () => {
    // close() detaches the server from this transport at once (its onclose runs synchronously).
    transport.close().catch(() => {});
    if (res.writableFinished && grants.get(grant.id) === grant && grant.idle.length < MAX_IDLE_SERVERS) {
      grant.idle.push(mcp);
    } else {
      mcp.instance.close().catch(() => {});
    }
  });
  await transport.handleRequest(req, res, message);
}

/** True when the body holds only JSON-RPC notifications (a method, no id). */
function onlyNotifications(message) {
  const list = Array.isArray(message) ? message : [message];
  return list.length > 0 && list.every((m) => m && typeof m === "object" && m.jsonrpc === "2.0" &&
    typeof m.method === "string" && !("id" in m));
}

/** The live grant whose token the Authorization header carries, or null. Expired grants are dropped on the way. */
function grantFor(authorization) {
  const m = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(String(authorization || ""));
  const presented = hashToken(m ? m[1] : "");
  const now = Date.now();
  let found = null;
  for (const [id, g] of grants) {
    if (now >= g.expiresAt) { grants.delete(id); continue; }
    // Every live grant is compared, in constant time, so the timing says nothing about which or how close.
    if (crypto.timingSafeEqual(presented, g.tokenHash) && m) found = g;
  }
  return found;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest();
}

/** Read the body up to limit bytes. Past it, stop keeping data, let the rest drain, and say tooLarge. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve({ tooLarge: true });
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        resolve({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({ text: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** A JSON-RPC style error reply (the MCP client reads these), no session, no secrets. */
function reply(res, status, message, headers = {}, code = -32000) {
  if (res.headersSent) return;
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

// ---------------------------------------------------------------------------------------------------------------
// Long results

/** The tools/call requests in one POST body (one message or a batch): request id -> tool name. */
function toolCallsIn(message) {
  const calls = new Map();
  for (const m of Array.isArray(message) ? message : [message]) {
    if (m && typeof m === "object" && m.method === "tools/call" && m.id !== undefined && m.id !== null) {
      calls.set(m.id, String(m.params?.name || "tool"));
    }
  }
  return calls;
}

/**
 * If msg answers one of this request's tool calls with more text than the model should take in, save the whole text
 * to a file and answer with its path and the start of it instead. Anything else passes through untouched.
 */
async function spillIfLong(msg, calls, grant) {
  if (!msg || typeof msg !== "object" || !calls.has(msg.id)) return msg;
  const content = msg.result?.content;
  if (!Array.isArray(content)) return msg;
  const texts = content.filter((c) => c?.type === "text" && typeof c.text === "string");
  const text = texts.map((c) => c.text).join("\n");
  const limit = spillThreshold();
  if (text.length <= limit) return msg;

  const rest = content.filter((c) => !(c?.type === "text" && typeof c.text === "string"));
  const previewChars = Math.min(PREVIEW_CHARS, Math.floor(limit / 2));
  const preview = text.slice(0, previewChars);
  let note;
  try {
    const file = await saveLongResult(grant, calls.get(msg.id), text);
    note =
      `[This result is ${text.length.toLocaleString("en-US")} characters, too long to show here, so it was saved in full to ${file}\n` +
      `Read the parts you need from that file with the shell (sed -n, head, tail or grep), a part at a time. ` +
      `It is not in the workspace and is deleted after 7 days. The first ${preview.length.toLocaleString("en-US")} characters:]\n` +
      preview;
  } catch (err) {
    warnOnce("spill", `could not save a long tool result: ${err.message}`);
    const kept = text.slice(0, Math.max(0, limit - 300));
    note = `${kept}\n[Cut at ${kept.length.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters; the rest could not be saved to a file (${err.message}).]`;
  }
  return { ...msg, result: { ...msg.result, content: [{ type: "text", text: note }, ...rest] } };
}

async function saveLongResult(grant, toolName, text) {
  const stateDir = running?.stateDir || config.STATE_DIR;
  const dir = path.join(stateDir, "tool-output", grant.turnDir);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  grant.seq += 1;
  const file = path.join(dir, `${grant.seq}-${safeName(toolName) || "tool"}-${crypto.randomBytes(3).toString("hex")}.txt`);
  await fs.promises.writeFile(file, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return file;
}

/** A folder or file name made of safe characters only (no separators, no dots at the start), at most 80 long. */
function safeName(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function safePrune(stateDir) {
  try {
    pruneToolOutput({ dir: path.join(stateDir, "tool-output") });
  } catch { /* housekeeping never breaks a turn */ }
}

const lastWarned = new Map();
function warnOnce(kind, text) {
  const now = Date.now();
  if (now - (lastWarned.get(kind) || 0) < 60_000) return;
  lastWarned.set(kind, now);
  console.warn(`[mcp-http] ${text}`);
}
