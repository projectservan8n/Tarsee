// The Local AI bridge (src/ai/local-bridge.js): Codex 0.167 sends Tarsee's tools as one {type: "namespace"} tool,
// which LM Studio, Ollama before 0.34 and llama-server drop, and finds the tool to run by the reply's {namespace, name}.
// The bridge flattens the tools on the way to the owner's server and puts the namespace back on the way out, cleans up
// what strict servers refuse, and keeps the owner's key out of the Codex process. Every key and token here is a fake.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  flatName, flattenTools, rewriteRequest, restoreEvent, restoreItem, createSseRewriter, startLocalBridge, redactBridgeUrls, MAX_TOOL_NAME,
} from "../src/ai/local-bridge.js";

const fn = (name, extra = {}) => ({ type: "function", name, description: `${name} does a thing`, strict: false, parameters: { type: "object", properties: {} }, ...extra });
/** Tarsee's tools as Codex 0.167 sends them (namespace "mcp__tarsee", captured from the pinned binary). */
const TARSEE_NS = { type: "namespace", name: "mcp__tarsee", description: "Tarsee's tools", tools: [fn("tarsee_calculator"), fn("tarsee_datetime")] };

describe("flat names: one fixed rule, at most 64 characters, no clashes", () => {
  it("joins the namespace and the name with __ (none added when the namespace already ends in __)", () => {
    assert.equal(flatName("mcp__tarsee", "tarsee_calculator"), "mcp__tarsee__tarsee_calculator");
    assert.equal(flatName("mcp__tarsee__", "tarsee_calculator"), "mcp__tarsee__tarsee_calculator");
    assert.equal(flatName("mcp__my.server", "do it"), "mcp__my_server__do_it", "only [A-Za-z0-9_-]");
  });

  it("a name past 64 characters is cut and given a short hash: the same every time, and different per tool", () => {
    const long = "x".repeat(80);
    const a = flatName("mcp__tarsee", `${long}_a`);
    const b = flatName("mcp__tarsee", `${long}_b`);
    assert.equal(a.length, MAX_TOOL_NAME);
    assert.equal(b.length, MAX_TOOL_NAME);
    assert.notEqual(a, b);
    assert.equal(flatName("mcp__tarsee", `${long}_a`), a, "fixed: nothing is kept between requests");
    assert.match(a, /^mcp__tarsee__x+_[0-9a-f]{8}$/);
  });

  it("a flat name that clashes with a plain function tool (or another flat name) gets the hashed form", () => {
    const { tools, names } = flattenTools([fn("mcp__tarsee__tarsee_calculator"), TARSEE_NS]);
    const flat = tools.map((t) => t.name);
    assert.equal(new Set(flat).size, flat.length, "no two tools share a name");
    assert.equal(flat[0], "mcp__tarsee__tarsee_calculator", "the plain tool keeps its own name");
    const moved = names.byPair.get("mcp__tarsee\u0000tarsee_calculator");
    assert.notEqual(moved, "mcp__tarsee__tarsee_calculator");
    assert.deepEqual(names.byFlat.get(moved), { namespace: "mcp__tarsee", name: "tarsee_calculator" });
    // Two namespaces whose joined names meet.
    const two = flattenTools([{ type: "namespace", name: "a__", tools: [fn("b")] }, { type: "namespace", name: "a", tools: [fn("b")] }]);
    assert.equal(new Set(two.tools.map((t) => t.name)).size, 2);
  });
});

describe("requests: what any Local AI server takes", () => {
  it("namespace tools become function tools; other tool kinds go; plain functions stay as they are", () => {
    const body = {
      model: "spark-4b", stream: true, tool_choice: "auto",
      tools: [fn("exec_command"), TARSEE_NS, { type: "custom", name: "apply_patch", format: { type: "grammar" } }, { type: "web_search" }],
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    };
    const before = JSON.stringify(body);
    const { body: out, names } = rewriteRequest(body);
    assert.equal(JSON.stringify(body), before, "the request Codex sent is not changed in place");
    assert.deepEqual(out.tools.map((t) => [t.type, t.name]), [["function", "exec_command"], ["function", "mcp__tarsee__tarsee_calculator"], ["function", "mcp__tarsee__tarsee_datetime"]]);
    assert.deepEqual(out.tools[1].parameters, TARSEE_NS.tools[0].parameters, "each tool keeps its own description and parameters");
    assert.equal(out.tools[1].description, "tarsee_calculator does a thing");
    assert.deepEqual(names.byFlat.get("mcp__tarsee__tarsee_datetime"), { namespace: "mcp__tarsee", name: "tarsee_datetime" });
    assert.equal(out.model, "spark-4b");
    assert.equal(out.stream, true);
    assert.equal(out.tool_choice, "auto");
  });

  it("earlier calls in the history get their flat names; unknown items go with their pairs; an orphaned output goes", () => {
    const { body } = rewriteRequest({
      tools: [TARSEE_NS],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "work it out" }] },
        { type: "function_call", call_id: "c1", namespace: "mcp__tarsee", name: "tarsee_calculator", arguments: "{\"expression\":\"6*7\"}" },
        { type: "function_call_output", call_id: "c1", output: "6*7 = 42" },
        { type: "tool_search_call", call_id: "s1", arguments: { query: "x" } },
        { type: "tool_search_output", call_id: "s1", tools: [] },
        { type: "custom_tool_call", call_id: "p1", name: "apply_patch", input: "*** Begin Patch" },
        { type: "custom_tool_call_output", call_id: "p1", output: "done" },
        { type: "function_call_output", call_id: "lost", output: "no call for this one" },
        { type: "additional_tools", tools: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "42" }] },
      ],
    });
    assert.deepEqual(body.input.map((i) => i.type), ["message", "function_call", "function_call_output", "message"]);
    assert.equal(body.input[1].name, "mcp__tarsee__tarsee_calculator");
    assert.equal(body.input[1].namespace, undefined);
    assert.equal(body.input[2].call_id, "c1");
  });

  it("a call to a tool this request no longer lists still gets the fixed rule's name", () => {
    const { body } = rewriteRequest({ tools: [], input: [{ type: "function_call", call_id: "c", namespace: "mcp__tarsee", name: "tarsee_remember", arguments: "{}" }, { type: "function_call_output", call_id: "c", output: "ok" }] });
    assert.equal(body.input[0].name, "mcp__tarsee__tarsee_remember");
  });

  it("reasoning with no content array goes (llama-server answers 400 for it); with one it stays", () => {
    const { body } = rewriteRequest({ input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] },
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "gAAAA" },
      { type: "reasoning", id: "rs_2", summary: [], content: [{ type: "reasoning_text", text: "kept" }] },
    ] });
    assert.deepEqual(body.input.map((i) => i.id ?? i.role), ["user", "rs_2"]);
  });

  it("the developer messages at the start become one (with the instructions); a later one becomes a user message", () => {
    // Codex 0.167 sends two developer messages first (its instructions, then Tarsee's), and no instructions field;
    // strict chat templates (the Qwen3.5 family's) refuse a system message that isn't first.
    const { body } = rewriteRequest({
      instructions: "Base instructions.",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "Permissions." }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Tarsee." }, { type: "input_text", text: "Tools: calculator." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "The model changed." }] },
        { role: "system", content: "A late system note." },
      ],
    });
    assert.equal(body.instructions, undefined, "folded into the one message at the start");
    assert.deepEqual(body.input.map((i) => i.role), ["developer", "user", "user", "user"]);
    assert.equal(body.input[0].content.length, 1);
    assert.equal(body.input[0].content[0].text, "Base instructions.\n\nPermissions.\n\nYou are Tarsee.\n\nTools: calculator.");
    assert.equal(body.input[2].content[0].text, "The model changed.");
    assert.equal(body.input[3].content, "A late system note.");
    // One developer message and no instructions: as it was.
    const one = rewriteRequest({ input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "only" }] }] }).body;
    assert.deepEqual(one.input, [{ type: "message", role: "developer", content: [{ type: "input_text", text: "only" }] }]);
  });

  it("an assistant's refusal part becomes output_text", () => {
    const { body } = rewriteRequest({ input: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't." }] }] });
    assert.deepEqual(body.input[0].content, [{ type: "output_text", text: "I can't.", annotations: [] }]);
  });
});

describe("replies: every call gets its {namespace, name} back", () => {
  const { names } = flattenTools([TARSEE_NS, fn("exec_command")]);
  const call = (name) => ({ type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: "{}", status: "completed" });

  it("output_item.added and .done, function_call_arguments.done, response.completed, and a whole response", () => {
    assert.deepEqual(restoreItem(call("mcp__tarsee__tarsee_calculator"), names), { ...call("tarsee_calculator"), namespace: "mcp__tarsee" });
    const plain = call("exec_command");
    assert.equal(restoreItem(plain, names), plain, "a plain tool's call is left alone");
    for (const type of ["response.output_item.added", "response.output_item.done"]) {
      const e = restoreEvent({ type, output_index: 0, item: call("mcp__tarsee__tarsee_datetime") }, names);
      assert.equal(e.item.name, "tarsee_datetime");
      assert.equal(e.item.namespace, "mcp__tarsee");
    }
    const args = restoreEvent({ type: "response.function_call_arguments.done", item_id: "fc_1", name: "mcp__tarsee__tarsee_datetime", arguments: "{}" }, names);
    assert.equal(args.name, "tarsee_datetime");
    const done = restoreEvent({ type: "response.completed", response: { id: "r", output: [call("mcp__tarsee__tarsee_calculator"), { type: "message", content: [] }] } }, names);
    assert.equal(done.response.output[0].namespace, "mcp__tarsee");
    assert.equal(done.response.output[0].name, "tarsee_calculator");
    const whole = restoreEvent({ id: "r", object: "response", output: [call("mcp__tarsee__tarsee_calculator")] }, names);
    assert.equal(whole.output[0].name, "tarsee_calculator");
    const text = { type: "response.output_text.delta", delta: "hi" };
    assert.equal(restoreEvent(text, names), text, "anything else is the very same object");
  });

  it("an SSE event split across network chunks is rewritten once it is whole; untouched frames pass exactly as they came", () => {
    const sse = createSseRewriter(names);
    const created = "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_9\"}}\n\n";
    const item = `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: call("mcp__tarsee__tarsee_calculator") })}\r\n\r\n`;
    let out = sse.push(created.slice(0, 20));
    assert.equal(out, "", "half a frame waits");
    out += sse.push(created.slice(20) + item.slice(0, 31));
    assert.equal(out, created, "the whole first frame, as it was");
    out += sse.push(item.slice(31, 70));
    out += sse.push(item.slice(70)) + sse.end();
    const last = JSON.parse(out.slice(created.length).replace(/^data: /, ""));
    assert.equal(last.item.name, "tarsee_calculator");
    assert.equal(last.item.namespace, "mcp__tarsee");
    assert.ok(!/event:/.test(out.slice(created.length)), "no event line added where the server sent none (llama-server's done events)");
  });

  it("a bare mid-stream error frame (llama-server's) becomes response.failed with the server's words", () => {
    const sse = createSseRewriter(names);
    sse.push("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_5\"}}\n\n");
    const out = sse.push("data: {\"error\":{\"code\":500,\"message\":\"the model crashed\",\"type\":\"server_error\"}}\n\n");
    assert.match(out, /^event: response\.failed\ndata: /);
    const e = JSON.parse(out.split("\n")[1].slice(6));
    assert.equal(e.type, "response.failed");
    assert.equal(e.response.id, "resp_5");
    assert.equal(e.response.status, "failed");
    assert.equal(e.response.error.message, "the model crashed");
    assert.equal(e.response.error.code, "server_error");
    const full = createSseRewriter(names).push("data: {\"error\":{\"code\":400,\"message\":\"request (40000 tokens) exceeds the available context size (32768 tokens), try increasing it\",\"type\":\"exceed_context_size_error\"}}\n\n");
    assert.equal(JSON.parse(full.split("\n")[1].slice(6)).response.error.code, "context_length_exceeded", "Codex's own code for a full context: no retry");
    const done = createSseRewriter(names).push("data: [DONE]\n\n");
    assert.equal(done, "data: [DONE]\n\n");
  });
});

describe("the bridge server", () => {
  let bridge;
  let upstream;
  const seen = [];
  let answer = null;
  before(async () => {
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const rec = { method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8"), closedEarly: false };
        seen.push(rec);
        res.on("close", () => { if (!res.writableFinished) rec.closedEarly = true; });
        answer(req, res, rec);
      });
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    bridge = await startLocalBridge();
  });
  after(async () => {
    await bridge.close();
    upstream.closeAllConnections?.();
    await new Promise((r) => upstream.close(() => r()));
  });
  const base = () => `http://127.0.0.1:${upstream.address().port}/v1`;
  const OWNER_KEY = "sk-test-canary-owner-local-key";
  const post = (url, token, body, extra = {}) => fetch(`${url}/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), ...extra });

  it("needs the turn named in the path and its token as the Bearer header; a released turn's address stops working", async () => {
    seen.length = 0;
    answer = (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{\"object\":\"list\",\"data\":[]}"); };
    const t = bridge.open({ upstream: base(), key: OWNER_KEY });
    const other = bridge.open({ upstream: base(), key: null });
    assert.match(t.url, /^http:\/\/127\.0\.0\.1:\d+\/t\/[A-Za-z0-9_-]{16,}\/v1$/);
    assert.ok(!t.url.includes(t.token), "the token is never in the address (Codex's command line carries the address)");
    assert.match(t.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal((await fetch(`${t.url}/models`)).status, 401, "no header");
    assert.equal((await fetch(`${t.url}/models`, { headers: { authorization: `Bearer ${other.token}` } })).status, 401, "another turn's token");
    assert.equal((await fetch(`${other.url}/models`, { headers: { authorization: `Bearer ${t.token}` } })).status, 401, "this token on another turn's address");
    assert.equal((await fetch(`${t.url}/models`, { headers: { authorization: `Bearer ${OWNER_KEY}` } })).status, 401, "the owner's key itself is no way in");
    assert.equal((await fetch(t.url.replace(t.id, "x".repeat(22)) + "/models", { headers: { authorization: `Bearer ${t.token}` } })).status, 401, "a made-up turn");
    assert.equal(seen.length, 0, "nothing refused reached the owner's server");
    const ok = await fetch(`${t.url}/models`, { headers: { authorization: `Bearer ${t.token}` } });
    assert.equal(ok.status, 200);
    assert.equal(seen[0].url, "/v1/models", "any other path is passed on as it is");
    t.release();
    t.release();
    assert.equal((await fetch(`${t.url}/models`, { headers: { authorization: `Bearer ${t.token}` } })).status, 401, "released");
    other.release();
    assert.equal(bridge.turns(), 0);
  });

  it("the owner's key goes to the owner's server, the turn's token never does; tools go flat, calls come back namespaced (streamed)", async () => {
    seen.length = 0;
    answer = (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frames = [
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "mcp__tarsee__tarsee_calculator", arguments: "" } },
        { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "mcp__tarsee__tarsee_calculator", arguments: "{\"expression\":\"6*7\"}", status: "completed" } },
        { type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "mcp__tarsee__tarsee_calculator", arguments: "{\"expression\":\"6*7\"}" }] } },
      ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
      // In small pieces, so frames arrive split across chunks.
      let i = 0;
      const step = () => { if (i >= frames.length) { res.end(); return; } res.write(frames.slice(i, i + 37)); i += 37; setTimeout(step, 1); };
      step();
    };
    const t = bridge.open({ upstream: base(), key: OWNER_KEY });
    const res = await post(t.url, t.token, { model: "spark-4b", stream: true, tools: [fn("exec_command"), TARSEE_NS], input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "6*7?" }] }] });
    assert.equal(res.status, 200);
    const text = await res.text();
    t.release();
    assert.equal(seen[0].url, "/v1/responses");
    assert.equal(seen[0].headers.authorization, `Bearer ${OWNER_KEY}`);
    assert.ok(!JSON.stringify(seen[0]).includes(t.token), "the turn's token stays between Codex and the bridge");
    const sent = JSON.parse(seen[0].body);
    assert.deepEqual(sent.tools.map((x) => x.name), ["exec_command", "mcp__tarsee__tarsee_calculator", "mcp__tarsee__tarsee_datetime"]);
    assert.ok(sent.tools.every((x) => x.type === "function"), "no namespace tool reaches the server");
    const events = text.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.split("\n").find((l) => l.startsWith("data: ")).slice(6)));
    assert.deepEqual(events.map((e) => e.type), ["response.created", "response.output_item.added", "response.output_item.done", "response.completed"]);
    for (const e of [events[1].item, events[2].item, events[3].response.output[0]]) {
      assert.equal(e.name, "tarsee_calculator");
      assert.equal(e.namespace, "mcp__tarsee");
    }
  });

  it("a server with no key gets no Authorization at all; a reply that isn't streamed is mapped back too", async () => {
    seen.length = 0;
    answer = (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_2", object: "response", status: "completed", output: [{ type: "function_call", call_id: "c", name: "mcp__tarsee__tarsee_datetime", arguments: "{}" }] }));
    };
    const t = bridge.open({ upstream: `${base()}/`, key: null });
    const res = await post(t.url, t.token, { model: "m", tools: [TARSEE_NS], input: [] });
    const body = await res.json();
    t.release();
    assert.equal(seen[0].headers.authorization, undefined);
    assert.equal(seen[0].url, "/v1/responses", "one trailing slash on the address changes nothing");
    assert.deepEqual([body.output[0].namespace, body.output[0].name], ["mcp__tarsee", "tarsee_datetime"]);
  });

  it("an HTTP error comes back unchanged; a bare error frame mid-stream becomes response.failed", async () => {
    const t = bridge.open({ upstream: base(), key: OWNER_KEY });
    answer = (req, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end("{\"error\":{\"code\":400,\"message\":\"request (40000 tokens) exceeds the available context size (32768 tokens), try increasing it\",\"type\":\"exceed_context_size_error\"}}"); };
    const bad = await post(t.url, t.token, { model: "m", input: [] });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /exceed_context_size_error/);
    answer = (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_3\"}}\n\ndata: {\"error\":{\"code\":500,\"message\":\"Failed to parse the tool call\",\"type\":\"server_error\"}}\n\n");
    };
    const mid = await (await post(t.url, t.token, { model: "m", stream: true, input: [] })).text();
    t.release();
    assert.match(mid, /event: response\.failed\ndata: \{"type":"response\.failed".*Failed to parse the tool call/);
  });

  it("when Codex hangs up, the request to the owner's server is stopped", async () => {
    seen.length = 0;
    answer = (req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}\n\n"); /* and then nothing */ };
    const t = bridge.open({ upstream: base(), key: OWNER_KEY });
    const ac = new AbortController();
    const res = await post(t.url, t.token, { model: "m", stream: true, tools: [TARSEE_NS], input: [] }, { signal: ac.signal });
    const reader = res.body.getReader();
    await reader.read();
    ac.abort();
    const deadline = Date.now() + 5_000;
    while (!seen[0]?.closedEarly && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    t.release();
    assert.equal(seen[0]?.closedEarly, true, "the owner's server saw the request end before its answer did");
  });

  it("an owner's server that isn't there is a 502 that names the owner's address (never the bridge's token)", async () => {
    const t = bridge.open({ upstream: "http://127.0.0.1:9/v1", key: OWNER_KEY });
    const res = await post(t.url, t.token, { model: "m", input: [] });
    t.release();
    assert.equal(res.status, 502);
    const words = await res.text();
    assert.match(words, /Can't reach your Local AI at http:\/\/127\.0\.0\.1:9\/v1/);
    assert.ok(!words.includes(t.token) && !words.includes(OWNER_KEY) && !words.includes(t.id));
  });

  it("refuses an address that isn't plain http(s), and a key with a line break", () => {
    assert.throws(() => bridge.open({ upstream: "ftp://x/v1" }), TypeError);
    assert.throws(() => bridge.open({ upstream: "http://user:pw@x/v1" }), TypeError);
    assert.throws(() => bridge.open({ upstream: base(), key: "a\nb" }), TypeError);
  });

  it("a turn's token works no longer than its time", async () => {
    let now = 1_000;
    const b = await startLocalBridge({ now: () => now, maxTurnMs: 60_000 });
    answer = (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); };
    const t = b.open({ upstream: base() });
    assert.equal((await fetch(`${t.url}/models`, { headers: { authorization: `Bearer ${t.token}` } })).status, 200);
    now += 60_001;
    assert.equal((await fetch(`${t.url}/models`, { headers: { authorization: `Bearer ${t.token}` } })).status, 401);
    await b.close();
  });
});

describe("redactBridgeUrls", () => {
  it("blanks a bridge address's turn out of words that may be shown or logged", () => {
    const id = "abcdefghijklmnopqrstuv";
    assert.equal(redactBridgeUrls(`error sending request for url (http://127.0.0.1:5555/t/${id}/v1/responses)`), "error sending request for url (http://127.0.0.1:5555/t/…/v1/responses)");
    assert.equal(redactBridgeUrls("http://localhost:9931/v1/responses"), "http://localhost:9931/v1/responses");
  });
});
