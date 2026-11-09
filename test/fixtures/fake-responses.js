/**
 * fake-responses.js: a loopback stand-in for the OpenAI Responses API, for the Codex engine's tests.
 *
 * The real pinned codex binary is pointed at it (a custom provider's base_url, the built-in provider's
 * openai_base_url, or chatgpt_base_url, each through engine-env's test-only seam), so every test runs the engine end
 * to end with no network and no real key. It records every request (method, path, headers, parsed body) so a test can
 * assert which key went where, and answers POST .../responses with a scripted SSE stream. Codex's built-in provider
 * (the OpenAI key and the ChatGPT sign-in) talks to the same path over a WebSocket first: the fake answers that too,
 * each response.create message getting the same scripted events as text frames (a warm-up message, generate:false,
 * gets an empty response and is recorded with prewarm:true, never handed to the handler).
 *
 *   const fake = await startFakeResponses({ handler: (body, info) => ({ text: "hi" }) });
 *   fake.url        "http://127.0.0.1:<port>/v1" (a custom provider's base_url)
 *   fake.origin     "http://127.0.0.1:<port>"
 *   fake.requests   every request, oldest first
 *   fake.responses() the POST .../responses requests only
 *   await fake.close()
 *
 * The handler gets the request's parsed JSON body and {index, path, headers, requests} (index counts the responses
 * requests from 0) and returns one reply:
 *   { text, reasoning?, usage? }                     an assistant message (reasoning adds a summary item before it)
 *   { calls: [{name, arguments, call_id?, namespace?}], text?, usage? }   function calls (arguments: object or JSON);
 *                                                    {type: "custom", name, input} is a freeform call (apply_patch);
 *                                                    {type: "tool_search", query} searches Codex's deferred tools
 *   { status, error? }                               an HTTP error with an OpenAI-style JSON body
 *   { failed: {code, message} }                      a response.failed event
 *   { events: [...] }                                raw Responses events (each needs a type)
 *   delayMs (with any of them)                       wait that long before answering
 *   hang: true                                       never answer (until the client goes away or close())
 * The default handler answers every request with the text "ok".
 *
 * Other options: models (the JSON a GET .../models gets), upgrade(headers, path) (return an HTTP status to refuse a
 * WebSocket upgrade with, as OpenAI does for a bad key; nothing to accept it).
 *
 * Standing in for ChatGPT's backend (the ChatGPT plan, through TARSEE_TEST_BASE_URL_CHATGPT): before any model request
 * Codex asks which workspace the signed-in account routes to (GET .../wham/accounts/check) and accepts only an HTTPS
 * origin, so this needs both
 *   tls: { key, cert }       serve HTTPS (fixtures/test-tls.js makes them; Codex trusts its authority through
 *                            SSL_CERT_FILE); origin and url are then https://
 *   chatgpt: { accountId, planType?, origin?, routingOverride?, refreshError? }
 *                            answer accounts/check with that account (chatgptAccountsCheck), routed to this server,
 *                            and refuse a sign-in renewal (POST .../oauth/token) with refreshError's code
 *                            (chatgptRefreshRefusal); auth.json's tokens.oauth_provenance.issuer sends it here
 */
import http from "node:http";
import https from "node:https";
import { WebSocketServer } from "ws";

const DEFAULT_USAGE = Object.freeze({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 });

/** The SSE body for a list of Responses events. */
export function sseBody(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** A Responses API usage object from {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}. */
export function apiUsage(u = {}) {
  const usage = { ...DEFAULT_USAGE, ...u };
  return {
    input_tokens: usage.input_tokens,
    input_tokens_details: { cached_tokens: usage.cached_input_tokens },
    output_tokens: usage.output_tokens,
    output_tokens_details: { reasoning_tokens: usage.reasoning_output_tokens },
    total_tokens: usage.input_tokens + usage.output_tokens,
  };
}

/** The events of one scripted reply (see the header). */
export function replyEvents(reply, n) {
  if (Array.isArray(reply.events)) return reply.events;
  const id = `resp_${n}`;
  const events = [{ type: "response.created", response: { id } }];
  if (reply.failed) {
    events.push({ type: "response.failed", response: { id, error: { code: reply.failed.code || "server_error", message: reply.failed.message || "failed" } } });
    return events;
  }
  let i = 0;
  if (reply.reasoning) {
    events.push({
      type: "response.output_item.done",
      output_index: i++,
      item: { type: "reasoning", id: `rs_${n}`, summary: [{ type: "summary_text", text: String(reply.reasoning) }], content: [], encrypted_content: null },
    });
  }
  if (reply.text != null) {
    events.push({
      type: "response.output_item.done",
      output_index: i++,
      item: { type: "message", role: "assistant", id: `msg_${n}`, status: "completed", content: [{ type: "output_text", text: String(reply.text), annotations: [] }] },
    });
  }
  for (const [k, call] of (reply.calls || []).entries()) {
    let item;
    if (call.type === "tool_search") {
      // Codex's own models get MCP tools deferred behind tool_search: the client runs the search and returns the
      // matching tools (tool_search_output) for the next request.
      const args = { query: String(call.query ?? ""), ...(call.limit ? { limit: call.limit } : {}) };
      item = { type: "tool_search_call", id: `ts_${n}_${k}`, call_id: call.call_id || `call_${n}_${k}`, execution: "client", status: "completed", arguments: args };
    } else if (call.type === "custom") {
      // A freeform tool (apply_patch on the models that have it): the input is plain text, not JSON.
      item = { type: "custom_tool_call", id: `ctc_${n}_${k}`, call_id: call.call_id || `call_${n}_${k}`, name: call.name, input: String(call.input ?? ""), status: "completed" };
    } else {
      const args = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
      item = { type: "function_call", id: `fc_${n}_${k}`, call_id: call.call_id || `call_${n}_${k}`, name: call.name, arguments: args, status: "completed" };
      if (call.namespace) item.namespace = call.namespace;
    }
    events.push({ type: "response.output_item.done", output_index: i++, item });
  }
  events.push({ type: "response.completed", response: { id, status: "completed", usage: apiUsage(reply.usage) } });
  return events;
}

// --- Reading a request body ----------------------------------------------------------------------------------------

/** Every tool name a request offers, MCP namespaces flattened as "<namespace>.<name>" too. */
export function toolNames(body) {
  const out = [];
  for (const t of body?.tools || []) {
    if (t?.name) out.push(t.name);
    else if (t?.type) out.push(t.type);
    if (t?.type === "namespace" && Array.isArray(t.tools)) for (const s of t.tools) if (s?.name) out.push(`${t.name}.${s.name}`);
  }
  return out;
}

/** The tools a tool_search found, as "<namespace>.<name>", from every tool_search_output in a request's input. */
export function searchedTools(body) {
  const out = [];
  for (const item of body?.input || []) {
    if (item?.type !== "tool_search_output") continue;
    for (const t of item.tools || []) {
      if (t?.type === "namespace" && Array.isArray(t.tools)) for (const s of t.tools) out.push(`${t.name}.${s?.name}`);
      else if (t?.name) out.push(t.name);
    }
  }
  return out;
}

/** The tool output items (function_call_output, custom_tool_call_output) in a request's input, oldest first. */
export function functionOutputs(body) {
  return (body?.input || []).filter((i) => i?.type === "function_call_output" || i?.type === "custom_tool_call_output");
}

/** The text of a function_call_output item (a string, or its content parts joined). */
export function outputText(item) {
  const o = item?.output;
  if (typeof o === "string") return o;
  if (Array.isArray(o)) return o.map((p) => p?.text ?? "").join("");
  if (o && typeof o === "object") return typeof o.content === "string" ? o.content : JSON.stringify(o);
  return "";
}

/** The text of every message in a request's input with this role ("user", "developer", "system"). */
export function messageTexts(body, role) {
  return (body?.input || [])
    .filter((i) => i?.type === "message" && i.role === role)
    .map((i) => (Array.isArray(i.content) ? i.content.map((c) => c?.text ?? "").join("") : String(i.content ?? "")));
}

/** Whether the request's input already holds an answer to every call this test made (so it's time to finish). */
export function answeredCalls(body) {
  return functionOutputs(body).length;
}

// --- ChatGPT's workspace routing ------------------------------------------------------------------------------------

/**
 * The body of ChatGPT's GET /backend-api/wham/accounts/check for one signed-in account, in the shape codex 0.167 reads
 * (codex-rs backend-client RawAccountsCheckResponse; app-server account_processor/workspace_routing.rs):
 * `accounts` is a list of AccountEntry, the entry whose id is the sign-in's account id is the one used, its
 * workspace_backend_origin must be an HTTPS origin with no path or credentials (or "NO_CONSTRAINT": the configured
 * backend's), and its account_routing_override one of "NO_CONSTRAINT", "us" or "us_cr" (null is refused).
 */
export function chatgptAccountsCheck({ accountId, planType = "free", origin = "NO_CONSTRAINT", routingOverride = "NO_CONSTRAINT", name = null } = {}) {
  if (!accountId) throw new TypeError("chatgptAccountsCheck: accountId is required");
  return {
    accounts: [{
      id: accountId,
      name,
      structure: "personal",
      plan_type: planType,
      is_deactivated: false,
      is_fedramp_compliant_workspace: false,
      can_access_with_session: true,
      sso_connection_name: null,
      workspace_backend_origin: origin,
      account_routing_override: routingOverride,
      profile_picture_url: null,
    }],
    account_ordering: [accountId],
    default_account_id: accountId,
  };
}

/** ChatGPT's accounts/check path, on either backend spelling (/backend-api/wham/..., /api/codex/...). */
export const ACCOUNTS_CHECK_PATH = /\/(?:wham|api\/codex)\/accounts\/check$/;

/**
 * Where Codex renews a ChatGPT sign-in: <issuer>/oauth/token, the issuer being auth.json's tokens.oauth_provenance
 * (else auth.openai.com). A test's sign-in names the fake as its issuer, so a renewal never leaves the machine.
 */
export const REFRESH_PATH = /\/oauth\/token$/;

/**
 * The fake never hands out new tokens: a renewal is refused (401) with this code, which Codex reads from
 * error.code (codex-rs login oauth/error.rs) and turns into its own words: refresh_token_invalidated "...your refresh
 * token was revoked...", refresh_token_expired "...has expired...", refresh_token_reused "...was already used...",
 * anything else "Your access token could not be refreshed. Please log out and sign in again."
 */
export function chatgptRefreshRefusal(code = "refresh_token_invalidated") {
  return { error: { code: code || "refresh_token_invalidated", message: "This test sign-in can't be renewed." } };
}

// --- The server ----------------------------------------------------------------------------------------------------

export async function startFakeResponses({ handler, models, upgrade, tls, chatgpt } = {}) {
  let respond = handler || (() => ({ text: "ok" }));
  const requests = [];
  const sockets = new Set();
  let n = 0;
  let origin = null;

  /** The scripted reply for one responses request (HTTP or WebSocket), recorded on it. */
  async function replyFor(record) {
    const index = n++;
    let reply;
    try {
      reply = (await respond(record.body, { index, path: record.path, headers: record.headers, requests })) || { text: "ok" };
    } catch (err) {
      reply = { status: 500, error: { message: `fake handler threw: ${err?.message || err}` } };
    }
    record.reply = reply;
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    return { reply, index };
  }

  const wss = new WebSocketServer({ noServer: true });

  const onRequest = (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const path = (req.url || "").split("?")[0];
      const record = { method: req.method, path, url: req.url, headers: { ...req.headers }, body, at: Date.now() };
      requests.push(record);

      if (req.method === "GET" && /\/models$/.test(path)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(models ?? { object: "list", data: [], models: [] }));
        return;
      }
      if (chatgpt && req.method === "GET" && ACCOUNTS_CHECK_PATH.test(path)) {
        const { refreshError: _r, ...account } = chatgpt;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(chatgptAccountsCheck({ origin, ...account })));
        return;
      }
      if (chatgpt && req.method === "POST" && REFRESH_PATH.test(path)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify(chatgptRefreshRefusal(chatgpt.refreshError)));
        return;
      }
      if (req.method !== "POST" || !/\/responses$/.test(path)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `The fake has nothing at ${req.method} ${path}`, type: "invalid_request_error" } }));
        return;
      }

      const { reply, index } = await replyFor(record);
      if (reply.hang) return; // The client gives up (or close() ends the socket).
      if (reply.status && reply.status !== 200) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "error", type: "invalid_request_error", code: null, ...(reply.error || {}) } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(sseBody(replyEvents(reply, index + 1)));
    });
  };
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, onRequest) : http.createServer(onRequest);
  // The built-in provider's WebSocket transport: one response.create message per model request.
  server.on("upgrade", (req, socket, head) => {
    // An upgraded socket is ours to look after: a client that resets it (Codex does, over TLS, after a refusal) must
    // not take the test process down.
    socket.on("error", () => {});
    const path = (req.url || "").split("?")[0];
    const headers = { ...req.headers };
    requests.push({ method: "UPGRADE", path, url: req.url, headers, body: null, at: Date.now() });
    if (!/\/responses$/.test(path)) { socket.destroy(); return; }
    const refuse = upgrade?.(headers, path);
    if (refuse) {
      const text = JSON.stringify({ error: { message: `refused (${refuse})`, type: "invalid_request_error", code: refuse === 401 ? "invalid_api_key" : null } });
      socket.end(`HTTP/1.1 ${refuse} ${http.STATUS_CODES[refuse] || "Error"}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", async (data) => {
        let msg = null;
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (msg?.type !== "response.create") return;
        const { type: _t, ...body } = msg;
        const record = { method: "WS", path, url: req.url, headers, body, at: Date.now() };
        requests.push(record);
        if (body.generate === false) {
          record.prewarm = true;
          for (const e of replyEvents({ events: [{ type: "response.created", response: { id: "resp_prewarm" } }, { type: "response.completed", response: { id: "resp_prewarm", status: "completed", usage: apiUsage({ input_tokens: 0, output_tokens: 0 }) } }] }, 0)) ws.send(JSON.stringify(e));
          return;
        }
        const { reply, index } = await replyFor(record);
        if (reply.hang) return;
        if (reply.status && reply.status !== 200) {
          ws.send(JSON.stringify({ type: "error", status: reply.status, error: { message: "error", type: "invalid_request_error", ...(reply.error || {}) } }));
          ws.close();
          return;
        }
        for (const e of replyEvents(reply, index + 1)) ws.send(JSON.stringify(e));
      });
    });
  });
  // (An HTTPS server's raw sockets come through "connection" too, so close() can end them.)
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  origin = `${tls ? "https" : "http"}://127.0.0.1:${port}`;

  return {
    origin,
    url: `${origin}/v1`,
    requests,
    /** The model requests (POST .../responses, or a WebSocket response.create that isn't a warm-up), oldest first. */
    responses: () => requests.filter((r) => (r.method === "POST" || (r.method === "WS" && !r.prewarm)) && /\/responses$/.test(r.path)),
    setHandler(fn) { respond = fn; },
    reset() { requests.length = 0; n = 0; },
    close() {
      for (const c of wss.clients) c.terminate();
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
