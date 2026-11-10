/**
 * local-bridge.js: the Local AI bridge, a small loopback server between Codex and the owner's own AI server (Ollama, LM
 * Studio, llama.cpp's llama-server or any other Responses server).
 *
 * Why it is there. Codex 0.167 always sends Tarsee's tools (its MCP server) as one {type: "namespace"} tool holding
 * function tools, and finds the tool to run from a reply's {namespace, name} pair, with no fallback to a flat name.
 * LM Studio, Ollama before 0.34 and llama-server drop a namespace tool without a word (llama-server logs "unsupported
 * Responses tool type 'namespace' skipped"), so a Local AI model never sees the calculator, the memory or the files,
 * and Verify's tool check fails. The bridge rewrites each request so every server sees plain function tools, and each
 * reply so Codex gets its {namespace, name} back. It also smooths over what strict servers refuse (below).
 *
 * How a turn uses it. codex.js opens a turn here before Codex starts: open({upstream, key}) gives a per-turn address,
 * http://127.0.0.1:<port>/t/<turn id>/v1, and a token. Codex's custom provider gets the address as its base_url and the
 * token as its key (TARSEE_PROVIDER_KEY, so it is never on Codex's command line, which the address is), and the
 * owner's key never enters the Codex process: the bridge adds it on the way to the owner's server. A request must name
 * the turn in its path and carry that turn's token as its Bearer header (compared in constant time); both stop working
 * when the turn releases them (codex.js's finally), or after MAX_TURN_MS.
 *
 * Requests to .../responses:
 *   - each namespace tool becomes plain function tools named by one fixed rule (flatName): the namespace and the
 *     name with "__" between them (none added when the namespace already ends in "__"), only [A-Za-z0-9_-], at most
 *     64 characters (a longer one, or one that clashes with another tool, is cut and given a short hash). The rule is
 *     fixed, so nothing is kept between requests: each reply is mapped back with its own request's tools.
 *   - earlier function_call items in the history get the same flat name (their namespace removed)
 *   - tool types that aren't functions are dropped, and so are input items a server doesn't know (only messages,
 *     function calls, their outputs and reasoning are kept), always a call and its output together
 *   - reasoning items with no content array are dropped (llama-server answers 400 for one: a chat that switched from
 *     another provider's model has them)
 *   - every developer or system message at the start is merged into one (with the request's instructions, when it
 *     has both), and any later one becomes a user message: llama.cpp makes each a system message, and strict chat
 *     templates (the Qwen3.5 family's) refuse a system message that isn't first. The start of the prompt then stays
 *     the same from turn to turn, so the server's prompt cache keeps working.
 *   - an assistant's refusal part becomes output_text
 *   - everything else goes through unchanged
 * Replies:
 *   - output_item.added and output_item.done events, function_call_arguments.done, and the output of
 *     response.completed (and of a reply that isn't streamed) get each function call's {namespace, name} back
 *   - a bare mid-stream error frame (llama-server's `data: {"error": ...}`, with no event name and no
 *     response.completed after it) becomes a response.failed event carrying the server's words
 *   - an HTTP error goes back unchanged; any other path (a GET of /models) is passed through as it is
 *   - when Codex hangs up, the request to the server is stopped
 *
 * Everything here runs inside Tarsee's own process. The server listens on 127.0.0.1 only, starts on first use and
 * doesn't keep the process alive. Nothing is logged with a key or a token in it.
 */
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";

/** The longest tool name the Responses API takes (and llama.cpp's chat templates expect). */
export const MAX_TOOL_NAME = 64;

/** How long a turn's token can work at most, even if its turn never says it is done. */
export const MAX_TURN_MS = 6 * 60 * 60 * 1000;

/** The largest request Codex sends that the bridge reads (its whole history; a picture is a file path, not bytes). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The input items every Responses server Tarsee knows takes. */
const KNOWN_ITEMS = new Set(["message", "function_call", "function_call_output", "reasoning"]);

const LEAD_ROLES = new Set(["developer", "system"]);

const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest();

// --- Names ---------------------------------------------------------------------------------------------------------

/** The flat name for a namespace's tool, before any clash: "<namespace>__<name>", only [A-Za-z0-9_-]. */
function baseName(namespace, name) {
  const ns = String(namespace ?? "");
  const joined = ns && !ns.endsWith("__") ? `${ns}__${name}` : `${ns}${name}`;
  return joined.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The same name cut to fit 64 characters with a short hash of the pair at its end (always 64 long when cut). */
function hashedName(namespace, name, hashChars = 8) {
  const tag = sha(`${namespace}\u0000${name}`).toString("hex").slice(0, hashChars);
  return `${baseName(namespace, name).slice(0, MAX_TOOL_NAME - hashChars - 1)}_${tag}`;
}

/**
 * The flat name a namespace's tool is sent under, by the fixed rule: baseName, or hashedName when that is longer than
 * 64 characters or already taken (a Set of names in use).
 */
export function flatName(namespace, name, taken = null) {
  const plain = baseName(namespace, name);
  if (plain.length <= MAX_TOOL_NAME && !taken?.has(plain)) return plain;
  for (const chars of [8, 12, 16]) {
    const cut = hashedName(namespace, name, chars);
    if (!taken?.has(cut)) return cut;
  }
  return hashedName(namespace, name, 24);
}

/**
 * A request's tools for a server that only takes function tools: {tools, names}. tools keeps every function tool as
 * it is and puts each namespace's function tools in its place with their flat names; any other kind of tool is left
 * out. names maps each flat name back to {namespace, name}, and pairs each (namespace, name) with its flat name.
 */
export function flattenTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const taken = new Set();
  for (const t of list) if (t?.type === "function" && typeof t.name === "string") taken.add(t.name);
  const byFlat = new Map();
  const byPair = new Map();
  const out = [];
  for (const t of list) {
    if (t?.type === "function") { out.push(t); continue; }
    if (t?.type !== "namespace" || !Array.isArray(t.tools)) continue;
    for (const s of t.tools) {
      if (!s || typeof s.name !== "string" || (s.type && s.type !== "function")) continue;
      const flat = flatName(t.name, s.name, taken);
      taken.add(flat);
      byFlat.set(flat, { namespace: t.name, name: s.name });
      byPair.set(`${t.name}\u0000${s.name}`, flat);
      out.push({ ...s, type: "function", name: flat });
    }
  }
  return { tools: out, names: { byFlat, byPair } };
}

/** The flat name an earlier call to a namespace's tool goes under: its request's own, else the fixed rule's. */
function flatForCall(names, namespace, name) {
  return names.byPair.get(`${namespace}\u0000${name}`) || flatName(namespace, name);
}

// --- Requests ------------------------------------------------------------------------------------------------------

const itemType = (item) => (item && typeof item === "object" ? item.type || (item.role ? "message" : null) : null);

/** A message's words: its text parts joined (a string content as it is). */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n\n");
}

/** A message's parts that aren't words (kept when messages are merged). */
const otherParts = (content) => (Array.isArray(content) ? content.filter((p) => p && typeof p.text !== "string") : []);

/** An assistant's refusal parts as output_text (a server that doesn't know the part type answers 400). */
function withoutRefusals(item) {
  if (!Array.isArray(item.content) || !item.content.some((p) => p?.type === "refusal")) return item;
  return {
    ...item,
    content: item.content.map((p) => (p?.type === "refusal" ? { type: "output_text", text: String(p.refusal ?? p.text ?? ""), annotations: [] } : p)),
  };
}

/**
 * A Responses request body as any Local AI server takes it (see the top of this file): {body, names}. body is a new
 * object (the one given is not changed); names maps the reply's flat tool names back.
 */
export function rewriteRequest(original) {
  if (!original || typeof original !== "object" || Array.isArray(original)) return { body: original, names: { byFlat: new Map(), byPair: new Map() } };
  const body = { ...original };
  const { tools, names } = flattenTools(original.tools);
  if (Array.isArray(original.tools)) body.tools = tools;
  const choice = original.tool_choice;
  if (choice && typeof choice === "object" && choice.namespace && typeof choice.name === "string") {
    const { namespace, ...rest } = choice;
    body.tool_choice = { ...rest, type: "function", name: flatForCall(names, namespace, choice.name) };
  }
  if (Array.isArray(original.input)) body.input = rewriteInput(original.input, names, body);
  return { body, names };
}

/** The input items, cleaned for the server (rewriteRequest's list). May move the request's instructions into them. */
function rewriteInput(input, names, body) {
  // Items the server wouldn't know, and every call that has one of them as its pair.
  const dropped = new Set();
  for (const item of input) {
    const type = itemType(item);
    if (!KNOWN_ITEMS.has(type) && item?.call_id) dropped.add(item.call_id);
  }
  const kept = [];
  for (const item of input) {
    const type = itemType(item);
    if (!KNOWN_ITEMS.has(type)) continue;
    if ((type === "function_call" || type === "function_call_output") && item.call_id && dropped.has(item.call_id)) continue;
    if (type === "reasoning" && !Array.isArray(item.content)) continue;
    if (type === "function_call" && item.namespace) {
      const { namespace, ...rest } = item;
      kept.push({ ...rest, name: flatForCall(names, namespace, item.name) });
      continue;
    }
    kept.push(type === "message" ? withoutRefusals(item) : item);
  }
  // An output whose call is gone can't be sent alone (a chat template has nothing to attach it to).
  const calls = new Set(kept.filter((i) => itemType(i) === "function_call").map((i) => i.call_id));
  const paired = kept.filter((i) => itemType(i) !== "function_call_output" || calls.has(i.call_id));

  // The developer and system messages at the start become one; any later one is a user message.
  let lead = 0;
  while (lead < paired.length && itemType(paired[lead]) === "message" && LEAD_ROLES.has(paired[lead].role)) lead++;
  const instructions = typeof body.instructions === "string" && body.instructions.trim() ? body.instructions : null;
  const out = [];
  if (lead > 1 || (lead === 1 && instructions)) {
    const first = paired[0];
    const words = [instructions, ...paired.slice(0, lead).map((m) => textOf(m.content))].filter((s) => s && s.trim());
    out.push({
      ...(first.type ? { type: "message" } : {}),
      role: first.role,
      content: [{ type: "input_text", text: words.join("\n\n") }, ...paired.slice(0, lead).flatMap((m) => otherParts(m.content))],
    });
    if (instructions) delete body.instructions;
  } else if (lead === 1) {
    out.push(paired[0]);
  }
  for (const item of paired.slice(lead)) {
    if (itemType(item) === "message" && LEAD_ROLES.has(item.role)) out.push({ ...item, role: "user" });
    else out.push(item);
  }
  return out;
}

// --- Replies -------------------------------------------------------------------------------------------------------

/** A reply's item with its {namespace, name} back, when it is a call to a flattened tool (else the same item). */
export function restoreItem(item, names) {
  if (!item || typeof item !== "object" || item.type !== "function_call") return item;
  const orig = names?.byFlat?.get(item.name);
  return orig ? { ...item, name: orig.name, namespace: orig.namespace } : item;
}

/** A Responses event (or a whole response) with every flattened call's {namespace, name} back; the same object when nothing changed. */
export function restoreEvent(evt, names) {
  if (!evt || typeof evt !== "object" || !names?.byFlat?.size) return evt;
  let out = evt;
  const set = (k, v) => { if (out === evt) out = { ...evt }; out[k] = v; };
  if (evt.item) {
    const item = restoreItem(evt.item, names);
    if (item !== evt.item) set("item", item);
  }
  if (Array.isArray(evt.output)) {
    const list = evt.output.map((i) => restoreItem(i, names));
    if (list.some((i, n) => i !== evt.output[n])) set("output", list);
  }
  if (evt.response && typeof evt.response === "object") {
    const r = restoreEvent(evt.response, names);
    if (r !== evt.response) set("response", r);
  }
  if (typeof evt.name === "string" && /function_call/.test(String(evt.type || "")) && names.byFlat.has(evt.name)) {
    const orig = names.byFlat.get(evt.name);
    set("name", orig.name);
    set("namespace", orig.namespace);
  }
  return out;
}

/** A context overflow in a server's words (llama-server, LM Studio, Ollama). */
export const CONTEXT_OVERFLOW_RE = /exceed_context_size_error|exceeds the available context size|is larger than the max context size|context (?:length|window) (?:exceeded|is exceeded)|context_length_exceeded|maximum context length/i;

/** A bare error frame's payload as a response.failed event, carrying the server's words. */
function failedEvent(payload, responseId) {
  const e = payload?.error;
  const message = typeof e === "string" ? e : String(e?.message ?? JSON.stringify(e ?? payload));
  const raw = typeof e === "object" && e ? (e.type ?? e.code) : null;
  const code = CONTEXT_OVERFLOW_RE.test(`${raw ?? ""} ${message}`) ? "context_length_exceeded" : String(raw ?? "server_error");
  return {
    type: "response.failed",
    response: { id: responseId || "resp_local_bridge", object: "response", status: "failed", error: { code, message }, output: [] },
  };
}

/**
 * A rewriter for a reply's SSE stream: push(text) gives the text to pass on (whole frames only; a frame split across
 * network chunks waits for its end), end() whatever was left. Frames that don't change are passed on exactly as they
 * came.
 */
export function createSseRewriter(names) {
  let buf = "";
  let responseId = null;
  const frame = (raw) => {
    if (!raw.trim()) return "";
    let event = null;
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    let payload = null;
    if (data.length) { try { payload = JSON.parse(data.join("\n")); } catch { payload = null; } }
    if (!payload || typeof payload !== "object") return `${raw}\n\n`;
    if (payload.response?.id && !responseId) responseId = payload.response.id;
    if (!event && !payload.type && payload.error) {
      const failed = failedEvent(payload, responseId);
      return `event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`;
    }
    const restored = restoreEvent(payload, names);
    if (restored === payload) return `${raw}\n\n`;
    return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(restored)}\n\n`;
  };
  const take = (final) => {
    let out = "";
    for (;;) {
      const m = /\r?\n\r?\n/.exec(buf);
      if (!m) break;
      out += frame(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
    }
    if (final && buf) { out += frame(buf); buf = ""; }
    return out;
  };
  return { push: (text) => { buf += text; return take(false); }, end: () => take(true) };
}

// --- The server ----------------------------------------------------------------------------------------------------

const json = (res, status, body) => {
  if (res.headersSent) { try { res.destroy(); } catch { /* gone */ } return; }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const refuse = (res) => json(res, 401, { error: { message: "This address is only for the Local AI turn it was made for.", type: "invalid_request_error", code: "invalid_api_key" } });

/** Codex's request headers worth passing on (never its Authorization: that is the turn's token). */
const DROPPED_HEADERS = new Set(["authorization", "host", "content-length", "connection", "keep-alive", "transfer-encoding", "accept-encoding", "upgrade", "proxy-authorization", "te", "trailer"]);

function upstreamHeaders(req, key) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROPPED_HEADERS.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
  headers["accept-encoding"] = "identity";
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

/** The request's body, at most MAX_BODY_BYTES (null when it was bigger). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Why a request to the owner's server failed, in short words (a connection refused, a timeout...). */
function reachWhy(err) {
  const code = err?.cause?.code || err?.code || "";
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the name isn't known";
  if (code === "ECONNRESET") return "the connection was reset";
  if (err?.name === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "it took too long to answer";
  return code || "network error";
}

/**
 * One request to the owner's server: resolves to its response (a readable stream with statusCode and headers) once
 * the headers are in. Plain node:http(s), on purpose: no timeout of its own (a slow model on a CPU can take minutes
 * before its first byte; Codex keeps its own clock and hangs up, which aborts this through signal), and no redirect is
 * ever followed, so the owner's key goes to this one address only.
 */
function upstreamRequest(target, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const req = (u.protocol === "https:" ? https : http).request(u, { method, headers, signal }, resolve);
    req.on("error", reject);
    if (body && body.length) req.end(body);
    else req.end();
  });
}

/**
 * Start a bridge: {port, open({upstream, key}) -> {url, id, token, release()}, turns(), close()}.
 * opts: request (one request to the owner's server, as upstreamRequest; tests), now, maxTurnMs, host (127.0.0.1).
 */
export async function startLocalBridge({ request: doRequest = upstreamRequest, now = Date.now, maxTurnMs = MAX_TURN_MS, host = "127.0.0.1" } = {}) {
  /** turn id -> {id, digest: sha256(token), upstream, key, until, live: Set<AbortController>} */
  const turns = new Map();
  const lookup = (id) => {
    const t = turns.get(id);
    if (!t) return null;
    if (now() > t.until) { closeTurn(t); return null; }
    return t;
  };
  const closeTurn = (t) => {
    turns.delete(t.id);
    for (const ac of t.live) { try { ac.abort(); } catch { /* done */ } }
    t.live.clear();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://bridge");
    const m = /^\/t\/([A-Za-z0-9_-]{16,128})(\/.*)?$/.exec(url.pathname);
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ""))?.[1] || "";
    if (!m || !bearer) { req.resume(); return refuse(res); }
    const turn = lookup(m[1]);
    // The turn named in the path, and its token in the header: compared as fixed-length digests, in constant time.
    if (!turn || !crypto.timingSafeEqual(turn.digest, sha(bearer))) { req.resume(); return refuse(res); }

    const rest = (m[2] || "/").replace(/^\/v1(?=\/|$)/, "") || "/";
    const target = `${turn.upstream}${rest === "/" ? "" : rest}${url.search}`;
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: { message: "The request couldn't be read." } }); }
    if (body === null) return json(res, 413, { error: { message: "The request is too big for the Local AI bridge." } });

    let names = { byFlat: new Map(), byPair: new Map() };
    const encoded = req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity";
    if (req.method === "POST" && /\/responses$/.test(rest) && body.length && !encoded) {
      try {
        const r = rewriteRequest(JSON.parse(body.toString("utf8")));
        names = r.names;
        body = Buffer.from(JSON.stringify(r.body), "utf8");
      } catch { /* not JSON: the server says what is wrong with it */ }
    }

    const ac = new AbortController();
    turn.live.add(ac);
    // Codex hung up (a stop, its own timeout): the owner's server stops working on the request too.
    res.on("close", () => { if (!res.writableFinished) ac.abort(); });
    try {
      let up;
      try {
        up = await doRequest(target, {
          method: req.method,
          headers: { ...upstreamHeaders(req, turn.key), ...(body.length ? { "content-length": String(body.length) } : {}) },
          body: ["GET", "HEAD"].includes(req.method) ? null : body,
          signal: ac.signal,
        });
      } catch (err) {
        if (ac.signal.aborted) { try { res.destroy(); } catch { /* gone */ } return undefined; }
        return json(res, 502, { error: { message: `Can't reach your Local AI at ${turn.upstream} (${reachWhy(err)}).`, type: "server_error", code: "local_ai_unreachable" } });
      }
      const status = up.statusCode || 502;
      const type = String(up.headers["content-type"] || "");
      const headers = { "content-type": type || "application/octet-stream", "cache-control": "no-cache" };
      if (up.headers["retry-after"]) headers["retry-after"] = String(up.headers["retry-after"]);
      if (status < 200 || status >= 300 || (!names.byFlat.size && !/event-stream/i.test(type))) {
        // An HTTP error, or nothing to map back: as it came.
        res.writeHead(status, headers);
        for await (const chunk of up) res.write(chunk);
        res.end();
        return undefined;
      }
      if (/event-stream/i.test(type)) {
        res.writeHead(status, headers);
        res.flushHeaders?.();
        const sse = createSseRewriter(names);
        const decoder = new TextDecoder();
        for await (const chunk of up) {
          const out = sse.push(decoder.decode(chunk, { stream: true }));
          if (out) res.write(out);
        }
        const last = sse.push(decoder.decode()) + sse.end();
        if (last) res.write(last);
        res.end();
        return undefined;
      }
      const chunks = [];
      for await (const chunk of up) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      let out = text;
      try { out = JSON.stringify(restoreEvent(JSON.parse(text), names)); } catch { /* not JSON: as it came */ }
      res.writeHead(status, headers);
      res.end(out);
      return undefined;
    } catch {
      // The server's stream broke off (or Codex hung up): Codex sees the stream end early, as it would without the bridge.
      try { res.destroy(); } catch { /* gone */ }
      return undefined;
    } finally {
      turn.live.delete(ac);
    }
  });
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => { server.off("error", reject); resolve(); });
  });
  server.unref();
  const { port } = server.address();

  return {
    port,
    /**
     * A turn's own address: upstream is the owner's server address (…/v1), key its key or null. Returns {url, token,
     * release()}; release() is safe to call more than once.
     */
    open({ upstream, key = null } = {}) {
      let u;
      try { u = new URL(String(upstream ?? "").trim()); } catch { u = null; }
      if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) {
        throw new TypeError("local-bridge: the Local AI address must be a plain http(s) URL");
      }
      const k = key == null ? "" : String(key).trim();
      if (/[\r\n\0]/.test(k)) throw new TypeError("local-bridge: the key has a line break in it");
      const token = crypto.randomBytes(32).toString("base64url");
      const id = crypto.randomBytes(16).toString("base64url");
      const t = { id, digest: sha(token), upstream: String(upstream).trim().replace(/\/+$/, ""), key: k || null, until: now() + maxTurnMs, live: new Set() };
      turns.set(id, t);
      return { url: `http://${host}:${port}/t/${id}/v1`, id, token, release: () => { if (turns.get(id) === t) closeTurn(t); } };
    },
    /** How many turns are open (tests). */
    turns: () => turns.size,
    close() {
      for (const t of [...turns.values()]) closeTurn(t);
      return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    },
  };
}

let shared = null;

/** The process's bridge, started on first use. */
export function localBridge() {
  shared ||= startLocalBridge().catch((err) => { shared = null; throw err; });
  return shared;
}

/** A bridge address's turn id blanked out, for words that may be shown or logged ("…/t/…/v1/responses"). */
export function redactBridgeUrls(text) {
  return String(text ?? "").replace(/(127\.0\.0\.1:\d+\/t\/)[A-Za-z0-9_-]{16,128}(?=\/|\b)/g, "$1…");
}
