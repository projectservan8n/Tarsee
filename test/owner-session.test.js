// The owner is the person signed in to the dashboard: a live sign-in (the tarsee_session cookie), never the API token
// alone. The dashboard sends the token with every request too (js/api.js), and the AI's shell runs as the same user, so
// it can read the token (api.token in the state folder) and Tarsee's database (tarsee.db). So:
//   - the owner's chat commands (/cron, /briefing, /webhook) run only with a live sign-in: the chat route and the
//     WebSocket name the dashboard ("web") only then, and anything else is refused by commands.js as not the owner;
//   - the database keeps a hash of each sign-in's id, never the id: an id copied from it signs nobody in, and the ids
//     an older Tarsee kept are hashed at the next start, with their owners still signed in;
//   - an owner-only action refused because the sign-in has run out says so plainly, the API token keeps its own words,
//     and the dashboard shows the message on its sign-in screen.
// The routes run for real behind the real sign-in, token and CSRF checks; the browser part runs the dashboard from
// src/public against a small fake /api on Playwright's own Chromium, else an installed Chrome or Edge, and is skipped
// where there is none (npx playwright install chromium).
/* global document, window, Settings -- the page.evaluate() bodies run in the browser */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import WebSocket from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-owner-session-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
// No TARSEE_API_TOKEN: Tarsee makes one and saves it in the state folder, as on most installs.
delete process.env.TARSEE_API_TOKEN;
delete process.env.TARSEE_SESSION_MAX_AGE_DAYS;
process.env.SETUP_PASSWORD = "test-owner-pin-4821";
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const { sessionAuth, requireAuth, createSession, destroySession, initSessionStore } = await import("../src/middleware/auth.js");
const { csrfProtect } = await import("../src/middleware/security.js");
const { authRouter } = await import("../src/routes/auth-routes.js");
const { chatRouter } = await import("../src/routes/chat.js");
const { settingsRouter } = await import("../src/routes/settings.js");
const { automationApprovalRouter } = await import("../src/routes/automation-approval.js");
const { setupWebSocket } = await import("../src/channels/websocket.js");
const cron = await import("../src/lib/cron.js");

/** What the AI's shell reads: the token file in the state folder. */
const TOKEN = fs.readFileSync(path.join(tmp, "api.token"), "utf8").trim();
const DB_PATH = path.join(tmp, "tarsee.db");
const db = initDb(DB_PATH);
initSessionStore(db);
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);
const DAY = 24 * 60 * 60 * 1000;

let browser = null;
try {
  const { chromium } = await import("playwright");
  for (const opts of [{}, { channel: "chrome" }, { channel: "msedge" }]) {
    try { browser = await chromium.launch(opts); break; } catch { /* the next one */ }
  }
} catch {
  browser = null;
}
const skip = browser ? false : "no Chromium, Chrome or Edge for Playwright";

let server;
let base;
let port;

before(async () => {
  cron.initCron({ db, settingsStore: settings, convStore: convs });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.set("db", db);
  app.set("settingsStore", settings);
  // As src/server.js has them: who is asking (the token or the sign-in), then each router behind its checks.
  app.use(sessionAuth);
  app.use("/api/auth", authRouter);
  app.use("/api/chat", requireAuth, csrfProtect, chatRouter);
  app.use("/api/settings", requireAuth, csrfProtect, settingsRouter);
  app.use("/api/automation-approval", requireAuth, csrfProtect, automationApprovalRouter);
  server = http.createServer(app);
  setupWebSocket(server, db, app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
beforeEach(() => {
  cron.stopCronScheduler();
  settings.delete("cron.jobs");
});
after(async () => {
  cron.stopCronScheduler();
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise((r) => (server ? server.close(r) : r()));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* a temp folder left behind */ }
});

// --- Who is asking -----------------------------------------------------------------------------------------------

/** The owner signing in at the dashboard (POST /api/auth/login): the sign-in's id, from its cookie. */
async function signIn() {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.SETUP_PASSWORD }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const id = /tarsee_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  assert.ok(id, "the sign-in sets its cookie");
  return id;
}

/** A fresh CSRF token, as the page gets one (GET /api/auth/csrf): anyone can have one. */
async function freshCsrf() {
  const res = await fetch(`${base}/api/auth/csrf`);
  const csrf = /tarsee_csrf=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  assert.ok(csrf, "a CSRF token");
  return csrf;
}

/** The AI's shell: curl with the token it read from the state folder. */
const asToken = () => ({ Authorization: `Bearer ${TOKEN}` });
/** The owner's dashboard (js/api.js): the sign-in's cookie, the CSRF token, and the API token alongside. */
const asDashboard = (sessionId, csrf) => ({ Authorization: `Bearer ${TOKEN}`, Cookie: `tarsee_session=${sessionId}; tarsee_csrf=${csrf}`, "X-CSRF-Token": csrf });
/** The owner's OK as js/settings.js _ownerPost sends it: the sign-in's cookie and the CSRF token, no API token. */
const asOwnerPost = (sessionId, csrf) => ({ Cookie: `tarsee_session=${sessionId}; tarsee_csrf=${csrf}`, "X-CSRF-Token": csrf });

async function call(method, url, body, headers = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

/** A message typed in the dashboard's chat (POST /api/chat/send): a command's answer. */
async function chat(message, headers) {
  const res = await call("POST", "/api/chat/send", { message }, headers);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.command, true, JSON.stringify(res.body));
  return String(res.body.response);
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

/** A WebSocket to the chat, with the API token (?token=, as a script would) and/or a sign-in's cookie. */
async function openSocket({ token, sessionId } = {}) {
  const url = `ws://127.0.0.1:${port}/${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const ws = new WebSocket(url, sessionId ? { headers: { Cookie: `tarsee_session=${sessionId}` } } : {});
  const got = [];
  ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  assert.ok(await until(() => got.some((m) => m.type === "auth_ok")), JSON.stringify(got));
  return {
    async send(message) {
      const from = got.length;
      ws.send(JSON.stringify({ type: "chat", message }));
      assert.ok(await until(() => got.slice(from).some((m) => m.type === "command")), JSON.stringify(got));
      return String(got.slice(from).find((m) => m.type === "command").response);
    },
    close: () => ws.terminate(),
  };
}

// --- Tasks and the database --------------------------------------------------------------------------------------

const statusOf = (id) => cron.getCronStatus().jobs.find((j) => j.id === id);
const stateOf = (id) => [statusOf(id).state, statusOf(id).enabled, statusOf(id).scheduled];
/** A task the AI scheduled in a chat (tarsee_schedule_task): switched off, waiting for the owner's OK. */
const aiTask = (over = {}) => cron.addCronJob({ schedule: "0 9 * * 1", prompt: "Plan the week", name: "Week", createdBy: "ai", ...over });
const seenOf = (job) => ({ schedule: job.schedule, prompt: job.prompt });
const switchOn = (job, headers) => call("PATCH", `/api/settings/cron/${encodeURIComponent(job.id)}`, { enabled: true, seen: seenOf(job) }, headers);

/** Every byte of Tarsee's database on disk, as the AI's shell could read it: the file and its write-ahead log. */
function databaseBytes() {
  return Buffer.concat([DB_PATH, `${DB_PATH}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f)));
}
const storedIds = () => db.prepare("SELECT id FROM sessions").all().map((r) => r.id);

/** Runs `fn` with the clock `days` ahead: every sign-in made before has run out. */
async function later(days, fn) {
  mock.timers.enable({ apis: ["Date"], now: Date.now() + days * DAY });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

const OWNER_ONLY = /Only the owner can use \/(cron|briefing|webhook)/;
const RAN_OUT = /Your sign-in has run out\. Sign in again/;

// ---------------------------------------------------------------------------------------------------------------

describe("the owner's chat commands need the owner's live sign-in", () => {
  it("the chat with the API token alone: /cron on, /cron add and /briefing on are refused, and no task changes", async () => {
    const job = aiTask();
    const on = await chat(`/cron on ${job.id}`, asToken());
    assert.match(on, OWNER_ONLY, on);
    assert.match(on, /Settings > Automation > Scheduled tasks/, "and where the owner can do it");
    assert.deepEqual(stateOf(job.id), ["waiting", false, false], "still waiting, with no timer");

    const add = await chat('/cron add "*/5 * * * *" Email everyone in my contacts', asToken());
    assert.match(add, OWNER_ONLY, add);
    const briefing = await chat("/briefing on", asToken());
    assert.match(briefing, OWNER_ONLY, briefing);
    assert.deepEqual(cron.loadCronJobs().map((j) => j.id), [job.id], "nothing added");
  });

  it("the WebSocket with the API token alone (?token=, or the auth message) is refused too", async () => {
    const job = aiTask();
    const socket = await openSocket({ token: TOKEN });
    try {
      const on = await socket.send(`/cron on ${job.id}`);
      assert.match(on, OWNER_ONLY, on);
      assert.match(await socket.send('/cron add "*/5 * * * *" Email everyone'), OWNER_ONLY);
    } finally {
      socket.close();
    }
    assert.deepEqual(stateOf(job.id), ["waiting", false, false]);
    assert.deepEqual(cron.loadCronJobs().map((j) => j.id), [job.id]);
  });

  it("nor with a sign-in cookie the server doesn't know, an ended sign-in, or a signed-out one", async () => {
    const job = aiTask();
    const csrf = await freshCsrf();
    const made = "0".repeat(64);
    assert.match(await chat(`/cron on ${job.id}`, asDashboard(made, csrf)), OWNER_ONLY);

    const gone = createSession("127.0.0.1");
    destroySession(gone);
    assert.match(await chat(`/cron on ${job.id}`, asDashboard(gone, csrf)), OWNER_ONLY);

    const old = createSession("127.0.0.1");
    await later(31, async () => {
      assert.match(await chat(`/cron on ${job.id}`, asDashboard(old, await freshCsrf())), OWNER_ONLY);
    });
    assert.deepEqual(stateOf(job.id), ["waiting", false, false]);
  });

  it("the owner's signed-in dashboard still runs them: the chat (cookie and token) and its WebSocket", async () => {
    const sessionId = await signIn();
    const csrf = await freshCsrf();
    const week = aiTask();
    const on = await chat(`/cron on ${week.id}`, asDashboard(sessionId, csrf));
    assert.match(on, /Switched on/, on);
    assert.deepEqual(stateOf(week.id), ["on", true, true]);

    const inbox = aiTask({ name: "Inbox", prompt: "Tidy the inbox" });
    const socket = await openSocket({ sessionId, token: TOKEN });
    try {
      assert.match(await socket.send(`/cron on ${inbox.id}`), /Switched on/);
      assert.deepEqual(stateOf(inbox.id), ["on", true, true]);
      assert.match(await socket.send('/cron add "0 7 * * *" Morning summary'), /created and switched on/);

      // Signed out on this device while the socket stays open: the sign-in is checked at each command.
      const out = await call("POST", "/api/auth/logout", undefined, asDashboard(sessionId, csrf));
      assert.equal(out.status, 200);
      const paused = cron.addCronJob({ schedule: "0 6 * * *", prompt: "Early digest", createdBy: "ai" });
      assert.match(await socket.send(`/cron on ${paused.id}`), OWNER_ONLY);
      assert.deepEqual(stateOf(paused.id), ["waiting", false, false]);
    } finally {
      socket.close();
    }
  });

  it("signing out ends the sign-in on the server, also from the dashboard (which sends the API token too)", async () => {
    const sessionId = createSession("127.0.0.1");
    const csrf = await freshCsrf();
    assert.equal((await call("GET", "/api/auth/status", undefined, { Cookie: `tarsee_session=${sessionId}` })).body.authenticated, true);
    const out = await call("POST", "/api/auth/logout", undefined, asDashboard(sessionId, csrf));
    assert.equal(out.status, 200);
    const after = await call("GET", "/api/auth/status", undefined, { Cookie: `tarsee_session=${sessionId}` });
    assert.equal(after.body.authenticated, false, "the cookie signs nobody in once signed out");
  });
});

describe("the database keeps no sign-in id", () => {
  it("only a hash of each sign-in's id is stored, and an id copied from the database signs nobody in", async () => {
    const sessionId = await signIn();
    const ids = storedIds();
    assert.ok(ids.length > 0, "the sign-in is stored, so it outlives a restart");
    assert.ok(!ids.includes(sessionId), "not the id itself");
    assert.ok(ids.every((id) => !id.includes(sessionId)), "nor anything holding it");
    assert.equal(databaseBytes().indexOf(Buffer.from(sessionId)), -1, "nowhere in the database's files");
    assert.equal((await call("GET", "/api/auth/status", undefined, { Cookie: `tarsee_session=${sessionId}` })).body.method, "session", "the owner's cookie still signs them in");

    // The AI's shell: an id read from tarsee.db, a free CSRF token, the API token, and a task it scheduled.
    const job = aiTask();
    for (const stored of ids) {
      for (const copied of new Set([stored, stored.split(":").pop()])) {
        const status = await call("GET", "/api/auth/status", undefined, { Cookie: `tarsee_session=${copied}` });
        assert.equal(status.body.authenticated, false, copied);
        const csrf = await freshCsrf();
        const res = await switchOn(job, asDashboard(copied, csrf));
        assert.equal(res.status, 403, JSON.stringify(res.body));
        assert.match(await chat(`/cron on ${job.id}`, asDashboard(copied, csrf)), OWNER_ONLY);
      }
    }
    assert.deepEqual(stateOf(job.id), ["waiting", false, false]);
  });

  it("a sign-in an older Tarsee stored as its id is hashed at the next start, and its cookie still signs in", async () => {
    const kept = await signIn();   // stored by this version: hashed already
    const legacy = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (id, created_at, ip) VALUES (?, ?, ?)").run(legacy, Date.now(), "127.0.0.1");
    assert.notEqual(databaseBytes().indexOf(Buffer.from(legacy)), -1, "the check finds an id written to the database");

    initSessionStore(db);   // the next start

    const ids = storedIds();
    assert.ok(!ids.includes(legacy), "the old row holds the id no more");
    assert.equal(ids.length, new Set(ids).size);
    assert.equal(databaseBytes().indexOf(Buffer.from(legacy)), -1, "nor do the database's files");
    for (const id of [legacy, kept]) {
      const status = await call("GET", "/api/auth/status", undefined, { Cookie: `tarsee_session=${id}` });
      assert.deepEqual([status.body.authenticated, status.body.method], [true, "session"], id === legacy ? "the older sign-in" : "a sign-in already hashed isn't hashed again");
    }
    const job = aiTask();
    assert.match(await chat(`/cron on ${job.id}`, asDashboard(legacy, await freshCsrf())), /Switched on/);

    initSessionStore(db);   // and the start after: nothing to do, everyone still signed in
    assert.deepEqual(storedIds().sort(), ids.sort());
    assert.equal((await call("GET", "/api/auth/status", undefined, { Cookie: `tarsee_session=${legacy}` })).body.authenticated, true);
  });

  it("a sign-in that has run out is dropped at the next start", async () => {
    const old = createSession("127.0.0.1");
    const before = storedIds().length;
    await later(31, async () => {
      const fresh = createSession("127.0.0.1");
      initSessionStore(db);
      assert.equal((await call("GET", "/api/auth/status", undefined, { Cookie: `tarsee_session=${old}` })).body.authenticated, false);
      assert.equal((await call("GET", "/api/auth/status", undefined, { Cookie: `tarsee_session=${fresh}` })).body.authenticated, true);
      assert.equal(storedIds().length, 1, `${before} sign-ins ran out; only the fresh one is left`);
    });
  });
});

describe("an owner-only action after the sign-in has run out", () => {
  it("says the sign-in ran out; the API token alone keeps its own words", async () => {
    const job = aiTask();
    const sessionId = createSession("127.0.0.1");
    await later(31, async () => {
      const csrf = await freshCsrf();
      // Switch on, from the dashboard: the ended sign-in's cookie, with the API token the page still has.
      let res = await switchOn(job, asDashboard(sessionId, csrf));
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.match(res.body.error, RAN_OUT);
      assert.match(res.body.error, /switch (it|the task) on/);
      assert.doesNotMatch(res.body.error, /API token|CSRF/);
      assert.equal(res.body.needsSignIn, true);

      // Let it run, Run at each restart and the editor's OK (js/settings.js _ownerPost: no API token).
      res = await call("POST", "/api/automation-approval/approve", { name: "HEARTBEAT.md", text: "# Heartbeat\n" }, asOwnerPost(sessionId, csrf));
      assert.equal(res.status, 401, JSON.stringify(res.body));
      assert.match(res.body.error, RAN_OUT);
      assert.doesNotMatch(res.body.error, /Authentication required|API token/);
      assert.equal(res.body.needsSignIn, true);
    });

    // A real API caller, with no sign-in at all: the token's own words.
    let res = await switchOn(job, asToken());
    assert.equal(res.status, 403);
    assert.match(res.body.error, /the API token can't, because the AI can read it/);
    assert.doesNotMatch(res.body.error, RAN_OUT);
    res = await call("POST", "/api/automation-approval/approve", { name: "HEARTBEAT.md", text: "# Heartbeat\n" }, asToken());
    assert.equal(res.status, 403);
    assert.match(res.body.error, /API token can't/);
    res = await call("POST", "/api/automation-approval/approve", { name: "HEARTBEAT.md", text: "# Heartbeat\n" });
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.body.error, RAN_OUT, "nobody signed in on this device: nothing ran out");
    assert.deepEqual(stateOf(job.id), ["waiting", false, false]);
  });

  it("the sign-in's cookie outlives the sign-in, so a tab left open still says whose it was", async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: process.env.SETUP_PASSWORD }),
    });
    const cookie = res.headers.get("set-cookie") || "";
    const maxAge = Number(/Max-Age=(\d+)/i.exec(cookie)?.[1]);
    assert.ok(maxAge * 1000 > 31 * DAY, `the browser keeps it past the 30-day sign-in: ${cookie}`);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    // A page load renews the cookie of a sign-in made before (GET /api/auth/status, the first thing the dashboard asks).
    const id = /tarsee_session=([^;]+)/.exec(cookie)[1];
    const status = await fetch(`${base}/api/auth/status`, { headers: { Cookie: `tarsee_session=${id}` } });
    const renewed = status.headers.get("set-cookie") || "";
    assert.match(renewed, new RegExp(`tarsee_session=${id}`));
    assert.ok(Number(/Max-Age=(\d+)/i.exec(renewed)?.[1]) * 1000 > 31 * DAY, renewed);
  });
});

// --- In a real browser -------------------------------------------------------------------------------------------

const PUBLIC = fileURLToPath(new URL("../src/public/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".svg": "image/svg+xml" };

describe("the dashboard, signed in when it opened, after its sign-in has run out", { skip }, () => {
  let pages;
  let origin;
  /** What the real routes answer an ended sign-in, which the fake /api hands the page. */
  const refusals = {};
  const HEARTBEAT = "# Heartbeat\n\n- Check the inbox and tell me about anything urgent.\n";
  const WAITING = { id: "cron_week", schedule: "0 9 * * 1", name: "Week", prompt: "Plan the week", enabled: false, createdBy: "ai", awaitingOwner: true, state: "waiting", scheduled: false };

  before(async () => {
    pages = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise((r) => pages.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${pages.address().port}`;

    const job = aiTask();
    const sessionId = createSession("127.0.0.1");
    await later(31, async () => {
      const csrf = await freshCsrf();
      refusals.switchOn = await switchOn(job, asDashboard(sessionId, csrf));
      refusals.approve = await call("POST", "/api/automation-approval/approve", { name: "HEARTBEAT.md", text: HEARTBEAT }, asOwnerPost(sessionId, csrf));
    });
    assert.equal(refusals.switchOn.status, 403);
    assert.equal(refusals.approve.status, 401);
  });
  after(async () => {
    await new Promise((r) => (pages ? pages.close(r) : r()));
  });

  /** The dashboard as it opens signed in, then every owner-only action refused as the real routes refuse it. */
  async function openDashboard({ width = 1280, height = 900 } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    const sent = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.route((url) => !url.href.startsWith(origin), (route) => route.abort());
    await page.routeWebSocket(/.*/, () => {});
    await page.route(`${origin}/api/**`, (route) => {
      const req = route.request();
      const p = new URL(req.url()).pathname;
      const method = req.method();
      sent.push({ method, path: p, auth: req.headers().authorization || null });
      const json = (status, data) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
      if (p === "/api/auth/status") return json(200, { authenticated: true, method: "session", needsPassword: true });
      if (p === "/api/auth/api-token") return json(200, { apiToken: "dashboard-api-token" });
      if (p === "/api/settings/setup-status") return json(200, { needsSetup: false, needsPersonality: false, hasKey: true, botName: "Tarsee", provider: "claude-code" });
      if (p === "/api/settings" && method === "GET") return json(200, { settings: [] });
      if (p === "/api/settings/cron" && method === "GET") return json(200, { jobs: [WAITING], activeJobs: 0, totalJobs: 1 });
      if (p === `/api/settings/cron/${WAITING.id}` && method === "PATCH") return json(refusals.switchOn.status, refusals.switchOn.body);
      if (p === "/api/settings/workspace-file") return json(200, { content: "" });
      if (p === "/api/automation-approval" && method === "GET") {
        return json(200, { files: [
          { name: "HEARTBEAT.md", text: HEARTBEAT, empty: false, approved: false, waiting: true },
          { name: "BOOT.md", text: "", empty: true, approved: false, waiting: false },
        ] });
      }
      if (p === "/api/automation-approval/approve") return json(refusals.approve.status, refusals.approve.body);
      if (p.startsWith("/api/chat/channels")) return json(200, { channels: [] });
      return json(200, {});
    });
    await page.goto(`${origin}/`);
    await page.locator("#appScreen").waitFor({ state: "visible" });
    await page.evaluate(() => Settings.open());
    await page.locator('.settings-tab[data-tab="automation"]').click();
    return { page, context, errors, sent };
  }

  /** The sign-in screen is up, saying why, and the message was shown as the action's answer too. */
  async function assertAsksToSignIn(page, message) {
    await page.locator("#loginScreen").waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await page.locator("#appScreen").isVisible(), false, "the sign-in screen, in place of the app");
    const why = page.locator("#loginError");
    await why.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await why.textContent(), message, "the sign-in screen says why");
    assert.ok(await page.locator("#loginPassword").isVisible(), "ready to sign in again");
    const toasts = await page.locator("#toastContainer .toast").allTextContents();
    assert.ok(toasts.some((t) => t.includes(message)), JSON.stringify(toasts));
    assert.ok(toasts.every((t) => !/Authentication required|API token|Session expired/.test(t)), JSON.stringify(toasts));
  }

  it("Let it run: the message, and the sign-in screen", async () => {
    const { page, context, errors, sent } = await openDashboard();
    try {
      const button = page.locator('[data-automation-approve="HEARTBEAT.md"]');
      await button.waitFor({ state: "visible" });
      assert.equal(await button.textContent(), "Let it run");
      await button.click();
      await assertAsksToSignIn(page, refusals.approve.body.error);
      const ok = sent.find((s) => s.path === "/api/automation-approval/approve");
      assert.equal(ok.auth, null, "the owner's OK goes without the API token");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Switch on: the message, and the sign-in screen", async () => {
    const { page, context, errors } = await openDashboard();
    try {
      const button = page.locator(`[data-cron-toggle="${WAITING.id}"]`);
      await button.waitFor({ state: "visible" });
      await button.click();
      await assertAsksToSignIn(page, refusals.switchOn.body.error);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("on a phone, the PIN pad says why", async () => {
    const { page, context, errors } = await openDashboard({ width: 375, height: 800 });
    try {
      const button = page.locator(`[data-cron-toggle="${WAITING.id}"]`);
      await button.waitFor({ state: "visible" });
      await button.click();
      await page.locator("#loginScreen").waitFor({ state: "visible", timeout: 5000 });
      const pin = page.locator("#pinError");
      assert.ok(await pin.isVisible(), "the PIN pad's line is on screen");
      assert.equal(await pin.textContent(), refusals.switchOn.body.error);
      assert.ok(await page.locator(".pin-key[data-digit]").first().isVisible(), "ready to sign in again");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
