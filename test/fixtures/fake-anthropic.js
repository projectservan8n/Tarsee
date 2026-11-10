/**
 * A loopback stand-in for an Anthropic Messages API host (Anthropic itself, DeepSeek's /anthropic endpoint or
 * OpenRouter's), for running the REAL bundled Claude Code CLI against it in tests (design 4.7 and Phase 2's tests).
 * It records every request (method, path, headers, parsed body) and answers POST /v1/messages with a streamed (SSE)
 * reply chosen by a script, so a test can see exactly what the CLI sent: which key, which models, which betas.
 *
 *   const fake = await startFakeAnthropic();          // 127.0.0.1, a free port
 *   fake.url                                          // "http://127.0.0.1:<port>" (also <url>/anthropic, <url>/api)
 *   fake.script = (req) => reply                      // optional; the default answers every call with a short text
 *   fake.requests                                     // [{ method, path, headers, body, at }]
 *   fake.messages()                                   // only the POST .../v1/messages ones
 *   await fake.close()
 *
 * A reply is one of:
 *   { text: "..." }                                   a text answer (streamed in a few deltas)
 *   { toolUse: { name, input, id? }, text? }          a tool call (stop_reason tool_use), after optional words
 *   { status: 401, error: { type, message } }         an HTTP error with the Messages API's error body
 *   { hang: true, text? }                             starts streaming, then holds the line open (a stream to abort)
 * Any reply can add usage ({input_tokens, output_tokens, ...}) and cost (OpenRouter's usage.cost on message_delta).
 *
 * Helpers for scripts: lastUserBlocks(body), hasToolResult(body), toolNames(body).
 */
import http from "node:http";

const DEFAULT_USAGE = { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** The content blocks of a request's last user message (a string is one text block). */
export function lastUserBlocks(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const last = [...msgs].reverse().find((m) => m?.role === "user");
  if (!last) return [];
  return typeof last.content === "string" ? [{ type: "text", text: last.content }] : (Array.isArray(last.content) ? last.content : []);
}

/** Whether the request's last user message carries a tool_result (the CLI answering a tool call). */
export function hasToolResult(body) {
  return lastUserBlocks(body).some((b) => b?.type === "tool_result");
}

/** The tool names a request offers the model. */
export function toolNames(body) {
  return (Array.isArray(body?.tools) ? body.tools : []).map((t) => t?.name).filter(Boolean);
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function chunks(text) {
  const words = String(text).split(/(\s+)/);
  const out = [];
  for (let i = 0; i < words.length; i += 4) out.push(words.slice(i, i + 4).join(""));
  return out.filter(Boolean);
}

let seq = 0;

function streamReply(res, reply, body, onHang) {
  const id = `msg_fake_${++seq}`;
  const usage = { ...DEFAULT_USAGE, ...(reply.usage || {}) };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "request-id": `req_fake_${seq}` });
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id, type: "message", role: "assistant", model: body?.model || "fake-model", content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: usage.input_tokens, output_tokens: 1, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens },
    },
  });
  let index = 0;
  if (reply.text) {
    sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    for (const piece of chunks(reply.text)) sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
    if (reply.hang) { onHang(); return; }
    sse(res, "content_block_stop", { type: "content_block_stop", index });
    index += 1;
  } else if (reply.hang) {
    onHang();
    return;
  }
  let stop = "end_turn";
  if (reply.toolUse) {
    const tu = reply.toolUse;
    sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: tu.id || `toolu_fake_${seq}`, name: tu.name, input: {} } });
    sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tu.input || {}) } });
    sse(res, "content_block_stop", { type: "content_block_stop", index });
    stop = "tool_use";
  }
  const delta = { output_tokens: usage.output_tokens };
  if (reply.cost != null) delta.cost = reply.cost;
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: delta });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function jsonReply(res, reply, body) {
  const usage = { ...DEFAULT_USAGE, ...(reply.usage || {}) };
  const content = [];
  if (reply.text) content.push({ type: "text", text: reply.text });
  if (reply.toolUse) content.push({ type: "tool_use", id: reply.toolUse.id || `toolu_fake_${++seq}`, name: reply.toolUse.name, input: reply.toolUse.input || {} });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: `msg_fake_${++seq}`, type: "message", role: "assistant", model: body?.model || "fake-model", content,
    stop_reason: reply.toolUse ? "tool_use" : "end_turn", stop_sequence: null, usage: { ...usage, ...(reply.cost != null ? { cost: reply.cost } : {}) },
  }));
}

/** Start the fake on 127.0.0.1 and a free port. */
export async function startFakeAnthropic({ script = null } = {}) {
  const requests = [];
  const hanging = new Set();
  const state = { script };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const url = new URL(req.url, "http://127.0.0.1");
      const entry = { method: req.method, path: url.pathname, query: url.search, headers: { ...req.headers }, body, at: Date.now() };
      requests.push(entry);

      if (req.method === "POST" && /\/v1\/messages\/count_tokens$/.test(url.pathname)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      // The CLI's reachability check before a key turn (HEAD /api/hello).
      if ((req.method === "HEAD" || req.method === "GET") && /\/api\/hello$/.test(url.pathname)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.method === "HEAD" ? undefined : JSON.stringify({ message: "hello" }));
        return;
      }
      if (req.method === "GET" && /\/v1\/models$/.test(url.pathname)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [], has_more: false }));
        return;
      }
      if (!(req.method === "POST" && /\/v1\/messages$/.test(url.pathname))) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `fake-anthropic: no route for ${req.method} ${url.pathname}` } }));
        return;
      }

      let reply;
      try { reply = (state.script && state.script(entry, requests)) || null; } catch (err) { reply = { status: 500, error: { type: "api_error", message: String(err?.message || err) } }; }
      if (!reply) reply = { text: "Hello from the fake." };
      if (reply.status && reply.status >= 400) {
        res.writeHead(reply.status, { "content-type": "application/json", "request-id": `req_fake_err_${++seq}` });
        res.end(JSON.stringify({ type: "error", error: reply.error || { type: "api_error", message: `status ${reply.status}` } }));
        return;
      }
      if (body && body.stream === false) { jsonReply(res, reply, body); return; }
      streamReply(res, reply, body, () => {
        hanging.add(res);
        res.on("close", () => hanging.delete(res));
      });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get script() { return state.script; },
    set script(fn) { state.script = fn; },
    /** The POST .../v1/messages requests only. */
    messages: () => requests.filter((r) => r.method === "POST" && /\/v1\/messages$/.test(r.path)),
    async close() {
      for (const res of hanging) { try { res.destroy(); } catch { /* already gone */ } }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
