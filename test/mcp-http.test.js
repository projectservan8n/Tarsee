// Tarsee's tools for the Codex engine (src/ai/mcp-http.js, design 4.9 and 4.5 R12). Codex can't take an in-process MCP
// server the way Claude Code does, so Tarsee serves the same tarsee_* tools on a loopback streamable-HTTP endpoint, and
// each Codex turn gets a grant: a URL and a 32-byte bearer token tied to that turn's tool context. These tests drive it
// with the MCP SDK's real streamable-HTTP client, the way Codex's own client calls it: the full tool list, a call that
// reaches executeTool with the granted context (and only that one), Tool Permissions, and every refusal (no, wrong,
// expired or revoked token; a foreign Host or Origin; a caller that isn't on this machine; a body over 4 MB; anything
// but POST /mcp). A result too long for the model's context is saved to a file under the state folder, outside the
// workspace, and the model gets the path. Nothing leaves the machine; every token here is generated per test run.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-mcp-http-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
delete process.env.TARSEE_TOOL_RESULT_MAX_CHARS;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { getSecurityManager } = await import("../src/lib/security-manager.js");
const { createTarseeMcp } = await import("../src/ai/tarsee-mcp.js");
const {
  startMcpHttp, stopMcpHttp, grantTurn, grantMcp, grantCount, isLoopbackAddress, pruneToolOutput, spillThreshold, MCP_BODY_LIMIT,
  TOOL_OUTPUT_KEEP_MS,
} = await import("../src/ai/mcp-http.js");

const db = initDb(path.join(tmp, "tarsee.db"));
const settings = new SettingsStore(db);
/** The tool context a turn would grant: this test's database and a conversation id the tools record. */
const ctxFor = (conversationId) => ({ db, settingsStore: settings, conversationId });

/** Rows the remember tool wrote for one conversation. */
const memoriesOf = (conversationId) => db.prepare("SELECT * FROM bot_memory WHERE source_conversation_id = ?").all(conversationId);

let endpoint;
before(async () => { endpoint = await startMcpHttp(); });
after(async () => {
  await stopMcpHttp();
  db.close();
  // Windows can take a moment to let go of a finished codex's files.
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* a temp folder left behind */ }
});
beforeEach(() => {
  getSecurityManager(settings).setToolPermission("remember", "always_allow");
  getSecurityManager(settings).setToolPermission("read_file", "always_allow");
});

/** A real MCP client over streamable HTTP, carrying the grant's bearer token like Codex does. */
async function connect(grant, token = grant.token) {
  const transport = new StreamableHTTPClientTransport(new URL(grant.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "codex-stand-in", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

/** Call one tool and return its text. */
async function callTool(grant, name, args) {
  const client = await connect(grant);
  try {
    const res = await client.callTool({ name, arguments: args });
    return { text: res.content.map((c) => c.text).join("\n"), res };
  } finally {
    await client.close();
  }
}

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1.0.0" } },
};

/**
 * One raw HTTP request to the endpoint, so a test can set what a real client never would (a foreign Host, an Origin,
 * a huge body). Resolves {status, headers, body}.
 */
function raw({ method = "POST", urlPath = "/mcp", token, host, headers = {}, body = JSON.stringify(INIT), port = endpoint.port }) {
  return new Promise((resolve, reject) => {
    const h = { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (host) h.host = host;
    if (body != null) h["content-length"] = Buffer.byteLength(body);
    // A fresh connection every time (no keep-alive agent), so each request is seen as a new caller.
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    // The server may answer a refused upload before it has all of it; that answer is what the test wants.
    req.on("error", (err) => (err.code === "EPIPE" || err.code === "ECONNRESET" ? undefined : reject(err)));
    if (body != null) req.end(body); else req.end();
  });
}

describe("the loopback endpoint", () => {
  it("listens on 127.0.0.1 on a port the system picked, and grants point at its /mcp", async () => {
    assert.equal(endpoint.host, "127.0.0.1");
    assert.ok(endpoint.port > 0);
    assert.equal(grantMcp, grantTurn, "the design's name for it is the same function");
    const grant = grantTurn(ctxFor("conv-url"));
    try {
      assert.equal(grant.url, `http://127.0.0.1:${endpoint.port}/mcp`);
    } finally {
      grant.revoke();
    }
  });

  it("gives each grant its own 32-byte token", () => {
    const a = grantTurn(ctxFor("conv-a"));
    const b = grantTurn(ctxFor("conv-b"));
    try {
      assert.equal(Buffer.from(a.token, "base64url").length, 32);
      assert.equal(Buffer.from(b.token, "base64url").length, 32);
      assert.notEqual(a.token, b.token);
      assert.match(a.token, /^[A-Za-z0-9_-]+$/, "the token must be safe in an environment variable");
    } finally {
      a.revoke();
      b.revoke();
    }
  });

  it("starts by itself when a turn asks for a grant first, and startMcpHttp is idempotent", async () => {
    await stopMcpHttp();
    const pending = grantTurn(ctxFor("conv-lazy"));
    assert.equal(typeof pending.then, "function", "before the endpoint listens, the grant comes as a promise");
    const grant = await pending;
    try {
      endpoint = await startMcpHttp();
      assert.equal(grant.url, `http://127.0.0.1:${endpoint.port}/mcp`);
      assert.equal((await startMcpHttp()).port, endpoint.port, "a second start must not open a second port");
      const client = await connect(grant);
      assert.ok((await client.listTools()).tools.length > 0);
      await client.close();
      const later = grantTurn(ctxFor("conv-lazy-2"));
      assert.equal(typeof later.then, "undefined", "once it listens, the grant comes straight back");
      later.revoke();
    } finally {
      grant.revoke();
    }
  });
});

describe("tools over streamable HTTP", () => {
  it("tools/list returns the full Tarsee tool list, the same one Claude Code gets in-process", async () => {
    const inProcess = createTarseeMcp(ctxFor("conv-list"));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const local = new Client({ name: "in-process", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([inProcess.instance.connect(b), local.connect(a)]);
    const expected = (await local.listTools()).tools.map((t) => t.name).sort();
    await local.close();

    const grant = grantTurn(ctxFor("conv-list"));
    try {
      const client = await connect(grant);
      const listed = (await client.listTools()).tools;
      await client.close();
      assert.deepEqual(listed.map((t) => t.name).sort(), expected);
      assert.ok(listed.length >= 26, `only ${listed.length} tools listed`);
      assert.ok(listed.every((t) => t.name.startsWith("tarsee_")));
      const schedule = listed.find((t) => t.name === "tarsee_schedule_task");
      assert.equal(schedule.inputSchema?.properties?.action?.properties?.args?.type, "object");
    } finally {
      grant.revoke();
    }
  });

  it("a call reaches executeTool with the granted context, and each token reaches only its own", async () => {
    const one = grantTurn(ctxFor("conv-one"));
    const two = grantTurn(ctxFor("conv-two"));
    try {
      const { text } = await callTool(one, "tarsee_remember", { content: "The canary fact is teal-42", category: "fact" });
      assert.equal(text, 'Remembered: "The canary fact is teal-42"');
      await callTool(two, "tarsee_remember", { content: "The other turn's fact is amber-7" });
      assert.deepEqual(memoriesOf("conv-one").map((m) => m.content), ["The canary fact is teal-42"]);
      assert.deepEqual(memoriesOf("conv-two").map((m) => m.content), ["The other turn's fact is amber-7"]);
    } finally {
      one.revoke();
      two.revoke();
    }
  });

  it("enforces a Tool Permissions deny: nothing runs, the model is told why, and the audit log has it", async () => {
    getSecurityManager(settings).setToolPermission("remember", "always_deny");
    const deniedBefore = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'tool.denied' AND target = 'remember'").get().n;
    const grant = grantTurn(ctxFor("conv-denied"));
    try {
      const { text } = await callTool(grant, "tarsee_remember", { content: "This must not be saved" });
      assert.match(text, /Refused by security policy/);
      assert.match(text, /Settings > Tool Permissions/);
      assert.equal(memoriesOf("conv-denied").length, 0, "a denied call still wrote a memory");
      const deniedAfter = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'tool.denied' AND target = 'remember'").get().n;
      assert.equal(deniedAfter, deniedBefore + 1);
    } finally {
      grant.revoke();
    }
  });

  it("saves a result too long for the model's context to a file outside the workspace and returns its path", async () => {
    const limit = spillThreshold();
    assert.equal(limit, 12_000);
    // The same setting as Claude Code's limit (context-limits.js), with the same floor.
    assert.equal(spillThreshold({ TARSEE_TOOL_RESULT_MAX_CHARS: "5000" }), 5000);
    assert.equal(spillThreshold({ TARSEE_TOOL_RESULT_MAX_CHARS: "500" }), 12_000);
    const body = Array.from({ length: 900 }, (_, i) => `- line ${i}: the owner's notes go on for a while here`).join("\n");
    const full = `# Memory\n${body}\nEND-OF-MEMORY-CANARY\n`;
    assert.ok(full.length > limit * 2);
    fs.writeFileSync(path.join(process.env.TARSEE_WORKSPACE_DIR, "MEMORY.md"), full);

    const grant = grantTurn(ctxFor("conv-spill"), { turnId: "turn-spill-1" });
    try {
      const { text } = await callTool(grant, "tarsee_read_file", { filename: "MEMORY.md" });
      assert.ok(text.length < limit, `the model still got ${text.length} characters`);
      const m = text.match(/saved in full to (.+?\.txt)/);
      assert.ok(m, `no path in: ${text.slice(0, 400)}`);
      const saved = m[1];
      assert.ok(path.isAbsolute(saved));
      const outputRoot = path.join(tmp, "tool-output");
      assert.ok(saved.startsWith(path.join(outputRoot, "turn-spill-1") + path.sep), `saved at ${saved}`);
      assert.ok(!saved.startsWith(path.resolve(process.env.TARSEE_WORKSPACE_DIR)), "the spill file is in the workspace");
      assert.equal(fs.readFileSync(saved, "utf8"), full, "the file must hold the whole result");
      assert.ok(text.includes("# Memory\n- line 0:"), "the model gets the start of it to go on");
      assert.ok(!text.includes("END-OF-MEMORY-CANARY"));
    } finally {
      grant.revoke();
    }
  });

  it("is quiet: a turn's requests build its tool server once, not once per request", async () => {
    const grant = grantTurn(ctxFor("conv-quiet"));
    const realLog = console.log;
    const lines = [];
    console.log = (...args) => { lines.push(args.join(" ")); };
    try {
      const client = await connect(grant);
      await client.listTools();
      await client.callTool({ name: "tarsee_calculator", arguments: { expression: "1 + 1" } });
      await client.callTool({ name: "tarsee_calculator", arguments: { expression: "2 + 2" } });
      await client.close();
    } finally {
      console.log = realLog;
      grant.revoke();
    }
    const builds = lines.filter((l) => l.includes("Creating Tarsee MCP server"));
    assert.ok(builds.length <= 1, `built ${builds.length} times for one turn`);
    assert.ok(!lines.some((l) => l.includes(grant.token)), "a token reached the log");
  });

  it("leaves a short result as it is", async () => {
    const grant = grantTurn(ctxFor("conv-short"), { turnId: "turn-short" });
    try {
      const { text } = await callTool(grant, "tarsee_calculator", { expression: "6 * 7" });
      assert.match(text, /42/);
      assert.ok(!fs.existsSync(path.join(tmp, "tool-output", "turn-short")));
    } finally {
      grant.revoke();
    }
  });
});

describe("refusals", () => {
  it("answers 401 to a request with no token or a wrong one", async () => {
    const grant = grantTurn(ctxFor("conv-401"));
    try {
      const none = await raw({});
      assert.equal(none.status, 401);
      assert.match(none.headers["www-authenticate"] || "", /^Bearer/);
      const wrong = await raw({ token: Buffer.alloc(32, 7).toString("base64url") });
      assert.equal(wrong.status, 401);
      const short = await raw({ token: "sk-test-canary-not-a-grant" });
      assert.equal(short.status, 401);
      const right = await raw({ token: grant.token });
      assert.equal(right.status, 200, right.body);
      // A real client gets nowhere with a made-up token.
      await assert.rejects(connect(grant, Buffer.alloc(32, 9).toString("base64url")), (err) => err.code === 401);
    } finally {
      grant.revoke();
    }
  });

  it("answers 401 once a grant has expired", async () => {
    const grant = grantTurn(ctxFor("conv-expired"), { ttlMs: 40 });
    assert.equal((await raw({ token: grant.token })).status, 200);
    await new Promise((r) => setTimeout(r, 90));
    assert.equal((await raw({ token: grant.token })).status, 401);
  });

  it("answers 401 once the turn has ended and revoked its grant, even to a client already connected", async () => {
    const live = grantCount();
    const grant = grantTurn(ctxFor("conv-revoked"));
    assert.equal(grantCount(), live + 1);
    const client = await connect(grant);
    assert.ok((await client.listTools()).tools.length > 0);
    grant.revoke();
    grant.revoke(); // twice is harmless
    assert.equal(grantCount(), live, "the grant outlived its turn");
    await assert.rejects(client.listTools(), (err) => err.code === 401);
    await client.close();
    assert.equal((await raw({ token: grant.token })).status, 401);
  });

  it("revokes a grant when the turn's stop signal fires", async () => {
    const stopper = new AbortController();
    const grant = grantTurn(ctxFor("conv-stopped"), { signal: stopper.signal });
    assert.equal((await raw({ token: grant.token })).status, 200);
    stopper.abort();
    assert.equal((await raw({ token: grant.token })).status, 401);
    const already = grantTurn(ctxFor("conv-stopped-2"), { signal: AbortSignal.abort() });
    assert.equal((await raw({ token: already.token })).status, 401, "a grant for a turn already stopped must not work");
  });

  it("answers 403 to a foreign Host header, even with a good token (DNS rebinding)", async () => {
    const grant = grantTurn(ctxFor("conv-host"));
    try {
      for (const host of ["evil.example", `evil.example:${endpoint.port}`, "127.0.0.1:1", `127.0.0.1.evil.example:${endpoint.port}`]) {
        const res = await raw({ token: grant.token, host });
        assert.equal(res.status, 403, `Host ${host} got ${res.status}`);
      }
      assert.equal((await raw({ token: grant.token, host: `localhost:${endpoint.port}` })).status, 200);
    } finally {
      grant.revoke();
    }
  });

  it("answers 403 to a request a web page sent (a foreign Origin)", async () => {
    const grant = grantTurn(ctxFor("conv-origin"));
    try {
      assert.equal((await raw({ token: grant.token, headers: { origin: "https://evil.example" } })).status, 403);
      assert.equal((await raw({ token: grant.token, headers: { origin: "null" } })).status, 403);
    } finally {
      grant.revoke();
    }
  });

  it("refuses a caller that is not on this machine", async () => {
    const grant = grantTurn(ctxFor("conv-remote"));
    // The endpoint only listens on 127.0.0.1, so a remote caller can't be produced for real: the socket is made to
    // report a remote address before the server sees the request.
    const fakeRemote = (socket) => Object.defineProperty(socket, "remoteAddress", { value: "203.0.113.9", configurable: true });
    endpoint.server.prependListener("connection", fakeRemote);
    try {
      const res = await raw({ token: grant.token });
      assert.equal(res.status, 403);
    } finally {
      endpoint.server.removeListener("connection", fakeRemote);
      grant.revoke();
    }
    for (const addr of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackAddress(addr), true, addr);
    for (const addr of ["203.0.113.9", "10.0.0.5", "192.168.1.20", "::ffff:10.0.0.5", "fe80::1", "", undefined, "0.0.0.0", "::"]) {
      assert.equal(isLoopbackAddress(addr), false, String(addr));
    }
  });

  it("answers 413 to a body over 4 MB without reading it all", async () => {
    assert.equal(MCP_BODY_LIMIT, 4 * 1024 * 1024);
    const grant = grantTurn(ctxFor("conv-big"));
    try {
      const big = JSON.stringify({ ...INIT, params: { ...INIT.params, pad: "x".repeat(MCP_BODY_LIMIT) } });
      const res = await raw({ token: grant.token, body: big });
      assert.equal(res.status, 413);
      // Just under the cap is still served.
      const fits = JSON.stringify({ ...INIT, params: { ...INIT.params, pad: "x".repeat(MCP_BODY_LIMIT - 1024) } });
      assert.equal((await raw({ token: grant.token, body: fits })).status, 200);
    } finally {
      grant.revoke();
    }
  });

  it("serves only POST /mcp", async () => {
    const grant = grantTurn(ctxFor("conv-routes"));
    try {
      assert.equal((await raw({ token: grant.token, urlPath: "/" })).status, 404);
      assert.equal((await raw({ token: grant.token, urlPath: "/api/chat" })).status, 404);
      const get = await raw({ token: grant.token, method: "GET", body: null });
      assert.equal(get.status, 405);
      assert.equal(get.headers.allow, "POST");
      assert.equal((await raw({ token: grant.token, method: "DELETE", body: null })).status, 405);
      assert.equal((await raw({ token: grant.token, body: "{not json" })).status, 400);
    } finally {
      grant.revoke();
    }
  });
});

/**
 * The pinned codex binary, found the way @openai/codex-sdk finds it (TARSEE_CODEX_BIN first), or null when this
 * machine doesn't have it installed.
 */
function findCodexBin() {
  if (process.env.TARSEE_CODEX_BIN && fs.existsSync(process.env.TARSEE_CODEX_BIN)) return process.env.TARSEE_CODEX_BIN;
  const triples = {
    "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin", "darwin-arm64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc",
  };
  const key = `${process.platform}-${process.arch}`;
  if (!triples[key]) return null;
  try {
    const req = createRequire(createRequire(import.meta.url).resolve("@openai/codex/package.json"));
    const vendor = path.join(path.dirname(req.resolve(`@openai/codex-${key}/package.json`)), "vendor", triples[key]);
    const name = process.platform === "win32" ? "codex.exe" : "codex";
    return [path.join(vendor, "bin", name), path.join(vendor, "codex", name)].find((p) => fs.existsSync(p)) || null;
  } catch {
    return null;
  }
}

/**
 * Codex's app-server on stdio, set up the way a Codex turn reaches Tarsee's tools: the tarsee MCP server at the
 * grant's url, its token read from TARSEE_MCP_TOKEN. Its own home, no credentials, its model hosts pointed at a closed
 * port on this machine, and the features that reach out on their own switched off (on startup it otherwise git-fetches
 * OpenAI's plugin list from GitHub, in a child that outlives it), so nothing can leave the machine.
 * rpc(method, params) resolves the reply (or {timeout:true}).
 */
function codexAppServer(bin, grant) {
  const home = fs.mkdtempSync(path.join(tmp, "codex-home-"));
  const env = { ...process.env, CODEX_HOME: home, TARSEE_MCP_TOKEN: grant.token };
  for (const name of Object.keys(env)) {
    if (name !== "TARSEE_MCP_TOKEN" && /^(OPENAI_|CODEX_API|ANTHROPIC_|CLAUDE_CODE_OAUTH)|(_KEY|_TOKEN|SECRET|PASSWORD)$/i.test(name)) delete env[name];
  }
  const closed = "http://127.0.0.1:9";
  const offline = ["plugins", "remote_plugin", "plugin_discovery_prefetch", "apps", "in_app_updates", "daemon_auto_start"];
  const child = spawn(bin, [
    "app-server",
    ...offline.flatMap((feature) => ["--disable", feature]),
    "-c", `mcp_servers.tarsee.url="${grant.url}"`,
    "-c", 'mcp_servers.tarsee.bearer_token_env_var="TARSEE_MCP_TOKEN"',
    "-c", 'mcp_servers.tarsee.default_tools_approval_mode="approve"',
    "-c", "mcp_servers.tarsee.required=true",
    "-c", "mcp_servers.tarsee.startup_timeout_sec=20",
    "-c", "check_for_update_on_startup=false",
    "-c", "analytics.enabled=false",
    "-c", `openai_base_url="${closed}/v1"`,
    "-c", `chatgpt_base_url="${closed}/backend-api"`,
  ], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buf = "";
  let next = 0;
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  child.stderr.resume();
  const rpc = (method, params, ms = 30_000) => new Promise((resolve) => {
    const id = ++next;
    const timer = setTimeout(() => { waiting.delete(id); resolve({ timeout: true, method }); }, ms);
    waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const notify = (method) => child.stdin.write(JSON.stringify({ method }) + "\n");
  // End of input lets app-server shut down by itself; kill it only if it hasn't within 5 seconds.
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => child.kill(), 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.stdin.end();
  });
  return { rpc, notify, stop };
}

const codexBin = findCodexBin();
describe("with Codex's own MCP client (the pinned codex binary)", { skip: codexBin ? false : "the pinned codex binary is not installed here" }, () => {
  it("lists every Tarsee tool and runs a call with the granted context", { timeout: 120_000 }, async () => {
    const grant = grantTurn(ctxFor("conv-codex"), { turnId: "turn-codex" });
    const codex = codexAppServer(codexBin, grant);
    try {
      const init = await codex.rpc("initialize", { clientInfo: { name: "tarsee-test", version: "1.0.0" } });
      assert.ok(init.result, `initialize: ${JSON.stringify(init)}`);
      codex.notify("initialized");

      const status = await codex.rpc("mcpServerStatus/list", { serverName: "tarsee" });
      const server = status.result?.data?.find((s) => s.name === "tarsee");
      assert.ok(server, `no tarsee server in ${JSON.stringify(status).slice(0, 500)}`);
      const inProcess = createTarseeMcp(ctxFor("conv-codex"));
      const [a, b] = InMemoryTransport.createLinkedPair();
      const local = new Client({ name: "in-process", version: "1.0.0" }, { capabilities: {} });
      await Promise.all([inProcess.instance.connect(b), local.connect(a)]);
      const expected = (await local.listTools()).tools.map((t) => t.name).sort();
      await local.close();
      assert.deepEqual(Object.keys(server.tools || {}).sort(), expected);

      const thread = await codex.rpc("thread/start", { cwd: tmp });
      const threadId = thread.result?.thread?.id;
      assert.ok(threadId, `thread/start: ${JSON.stringify(thread).slice(0, 500)}`);
      const call = await codex.rpc("mcpServer/tool/call", {
        server: "tarsee", threadId, tool: "tarsee_remember", arguments: { content: "Codex reached the tools" },
      });
      assert.equal(call.result?.content?.[0]?.text, 'Remembered: "Codex reached the tools"', JSON.stringify(call).slice(0, 500));
      assert.deepEqual(memoriesOf("conv-codex").map((m) => m.content), ["Codex reached the tools"]);
    } finally {
      await codex.stop();
      grant.revoke();
    }
  });
});

describe("spilled results are kept for a week", () => {
  it("prunes turn folders older than seven days and keeps newer ones", () => {
    const root = path.join(tmp, "prune-test");
    const old = path.join(root, "turn-old");
    const recent = path.join(root, "turn-recent");
    for (const dir of [old, recent]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "1-tarsee_read_file.txt"), "x");
    }
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 3600_000);
    fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
    assert.equal(TOOL_OUTPUT_KEEP_MS, 7 * 24 * 3600_000);
    const removed = pruneToolOutput({ dir: root, now });
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(recent), true);
    assert.equal(pruneToolOutput({ dir: path.join(tmp, "no-such-folder"), now }), 0);
  });
});
