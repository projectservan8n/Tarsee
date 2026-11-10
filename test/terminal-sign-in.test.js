// The web Terminal (/terminal) is a full shell as the server's user, so it opens only for the owner's live sign-in to
// the dashboard (the tarsee_session cookie), as owner-only commands do (middleware/auth.js liveSessionId). The API
// token opens none, sent as ?token= or as a Bearer header: the AI's shell can read the token (api.token in the state
// folder), and the token goes to every API client. A sign-in that ends while a Terminal is open ends it at the next
// key. The dashboard's own Terminal page (js/terminal.js) sends the cookie with its upgrade, so it still opens.
// Each connection and refusal is logged with the place the sign-in limit counts (signInKey), never a raw
// X-Forwarded-For.
// The refusals run through the real upgrade (channels/websocket.js); the shell itself is a stand-in, except in one
// test that opens a real one, as the dashboard does, where node-pty loads.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-terminal-sign-in-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.SETUP_PASSWORD = "test-owner-pin-4821";
delete process.env.TARSEE_API_TOKEN;
delete process.env.RAILWAY_PROJECT_ID;
delete process.env.TARSEE_TRUSTED_PROXY;
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });

const { initDb } = await import("../src/db/sqlite.js");
const { createSession, destroySession, initSessionStore } = await import("../src/middleware/auth.js");
const { handleTerminalConnection } = await import("../src/websocket/terminal-handler.js");
const { setupWebSocket } = await import("../src/channels/websocket.js");
const { AuditLog } = await import("../src/db/audit.js");

const TOKEN = fs.readFileSync(path.join(tmp, "api.token"), "utf8").trim();
const db = initDb(path.join(tmp, "data", "tarsee.db"));
initSessionStore(db);
const audit = new AuditLog(db);

let hasPty = true;
try { await import("node-pty"); } catch { hasPty = false; }

/** A stand-in for the browser's WebSocket, as the handler sees it. */
function fakeSocket() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.closed = null;
  ws.send = (text) => ws.sent.push(JSON.parse(text));
  ws.close = (code, reason) => { ws.closed = { code, reason }; ws.readyState = 3; };
  return ws;
}
/** A stand-in for node-pty: records what was spawned and what was written to it. */
function fakePty() {
  const spawned = [];
  return {
    spawned,
    spawn(shell, args, opts) {
      const proc = { shell, opts, written: [], killed: false, write(d) { proc.written.push(d); }, resize() {}, kill() { proc.killed = true; }, onData() {}, onExit() {} };
      spawned.push(proc);
      return proc;
    },
  };
}
const request = ({ cookie, xff, url = "/terminal", from = "127.0.0.1", authorization } = {}) => ({
  url,
  headers: { ...(cookie ? { cookie } : {}), ...(xff ? { "x-forwarded-for": xff } : {}), ...(authorization ? { authorization } : {}) },
  socket: { remoteAddress: from },
});
const entries = () => audit.query(100).filter((e) => e.action.startsWith("terminal."));

beforeEach(() => { db.prepare("DELETE FROM audit_log").run(); });
// (A real shell, killed as its socket closes, holds its working folder for a moment on Windows: the retries wait
// without blocking, so the server can end it meanwhile.)
after(async () => {
  db.close();
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe("opening the Terminal", () => {
  it("opens a shell for the owner's live sign-in", () => {
    const pty = fakePty();
    const ws = fakeSocket();
    const id = createSession("127.0.0.1");
    handleTerminalConnection(ws, request({ cookie: `tarsee_session=${id}` }), { auditLog: audit, pty });
    assert.equal(pty.spawned.length, 1);
    assert.equal(ws.sent[0].type, "connected");
    assert.equal(ws.closed, null);
    ws.emit("message", JSON.stringify({ type: "input", data: "ls\r" }));
    assert.deepEqual(pty.spawned[0].written, ["ls\r"]);
  });

  it("opens none for the API token, in the address or as a Bearer header", () => {
    for (const req of [request({ url: `/terminal?token=${TOKEN}` }), request({ authorization: `Bearer ${TOKEN}` })]) {
      const pty = fakePty();
      const ws = fakeSocket();
      handleTerminalConnection(ws, req, { auditLog: audit, pty });
      assert.equal(pty.spawned.length, 0, "no shell");
      assert.equal(ws.closed?.code, 1008);
      const said = ws.sent.filter((m) => m.type === "data").map((m) => m.data).join("");
      assert.match(said, /signed in to the dashboard/);
    }
  });

  it("opens none for a sign-in that has ended, and says so", () => {
    const pty = fakePty();
    const ws = fakeSocket();
    const id = createSession("127.0.0.1");
    destroySession(id);
    handleTerminalConnection(ws, request({ cookie: `tarsee_session=${id}`, url: `/terminal?token=${TOKEN}` }), { auditLog: audit, pty });
    assert.equal(pty.spawned.length, 0);
    assert.match(ws.sent.map((m) => m.data || m.message || "").join(""), /sign-in has run out/);
  });

  it("ends the shell at the next key once the sign-in ends", () => {
    const pty = fakePty();
    const ws = fakeSocket();
    const id = createSession("127.0.0.1");
    handleTerminalConnection(ws, request({ cookie: `tarsee_session=${id}` }), { auditLog: audit, pty });
    destroySession(id);
    ws.emit("message", JSON.stringify({ type: "input", data: "cat secrets\r" }));
    assert.deepEqual(pty.spawned[0].written, [], "the key isn't typed");
    assert.equal(pty.spawned[0].killed, true);
    assert.equal(ws.closed?.code, 1008);
  });

  it("logs the place the sign-in limit counts, not a raw X-Forwarded-For", () => {
    const id = createSession("127.0.0.1");
    handleTerminalConnection(fakeSocket(), request({ cookie: `tarsee_session=${id}`, xff: "203.0.113.9" }), { auditLog: audit, pty: fakePty() });
    handleTerminalConnection(fakeSocket(), request({ url: `/terminal?token=${TOKEN}`, xff: "198.51.100.4", from: "192.0.2.10" }), { auditLog: audit, pty: fakePty() });
    const byAction = Object.fromEntries(entries().map((e) => [e.action, e]));
    assert.equal(byAction["terminal.connect"].ip, "this machine");
    assert.equal(byAction["terminal.refused"].ip, "192.0.2.10");
    assert.ok(entries().every((e) => !/203\.0\.113\.9|198\.51\.100\.4/.test(`${e.ip} ${e.detail}`)), JSON.stringify(entries()));
  });
});

describe("through the real upgrade", () => {
  let server;
  let url;
  before(async () => {
    server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    setupWebSocket(server, db, null);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    url = `ws://127.0.0.1:${server.address().port}/terminal`;
  });
  after(async () => { await new Promise((r) => server.close(r)); });

  /** Opens /terminal; resolves with what came back until it closed, or until the first "connected". */
  function open(target, headers = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(target, { headers });
      const got = [];
      ws.on("message", (m) => {
        const msg = JSON.parse(String(m));
        got.push(msg);
        if (msg.type === "connected") { ws.close(); resolve({ got, code: null }); }
      });
      ws.on("close", (code) => resolve({ got, code }));
      ws.on("unexpected-response", (_req, res) => resolve({ got, code: null, status: res.statusCode }));
      ws.on("error", reject);
    });
  }

  it("refuses ?token= without the sign-in, before any shell", async () => {
    const { got, code } = await open(`${url}?token=${encodeURIComponent(TOKEN)}`);
    assert.equal(code, 1008);
    assert.ok(!got.some((m) => m.type === "connected"), JSON.stringify(got));
    assert.match(got.map((m) => m.data || "").join(""), /signed in to the dashboard/);
  });

  it("opens the dashboard's Terminal, which sends the sign-in's cookie with the token", { skip: hasPty ? false : "node-pty doesn't load here", timeout: 60_000 }, async () => {
    const id = createSession("127.0.0.1");
    // As js/terminal.js does: the token in the address, and the browser adds the sign-in's cookie.
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(TOKEN)}`, { headers: { cookie: `tarsee_session=${id}` } });
    const got = [];
    let output = "";
    let answered = false;
    const closed = new Promise((resolve, reject) => {
      ws.on("message", (m) => {
        const msg = JSON.parse(String(m));
        got.push(msg.type);
        if (msg.type === "connected") ws.send(JSON.stringify({ type: "input", data: "echo tarsee-terminal-ok\r" }));
        if (msg.type === "data") {
          output += msg.data;
          // The typed line comes back as typed; the shell's answer is on a line of its own. Then the tab is closed,
          // which ends the shell (the handler kills it as the socket closes).
          // eslint-disable-next-line no-control-regex -- ESC starts the terminal's colour and cursor codes
          if (!answered && /(^|\n)tarsee-terminal-ok\r?\n/.test(output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))) {
            answered = true;
            ws.close();
          }
        }
      });
      ws.on("close", () => resolve());
      ws.on("error", reject);
    });
    await closed;
    assert.equal(got[0], "connected", JSON.stringify(got));
    assert.ok(answered, `the shell answered: ${JSON.stringify(output.slice(-400))}`);
  });
});
