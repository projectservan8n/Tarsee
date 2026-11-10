// HEARTBEAT.md and BOOT.md run the AI on their own (every 30 minutes, and when Tarsee restarts), and each run is paid
// for. The AI can write either file with its file tools in any chat, so they run only text the owner has OK'd
// (lib/automation-approval.js, routes/automation-approval.js):
//   - a file the AI (or anything else outside Settings) wrote doesn't run: it waits for the owner's OK, logged once a
//     change, and Settings > Automation shows it with a Let it run (BOOT.md: Run at each restart) button;
//   - the owner's own save in the Settings editor OKs what they typed;
//   - the button OKs only the text the page showed (409 when it changed since), and only from the owner's signed-in
//     dashboard: the API token (Bearer) is refused, as a script or the AI's own shell could hold it;
//   - the first start of this version OKs what is already there, once, so existing installs run as before.
// Engines are scripted (test/fakes/fake-engine.js); the routes run for real behind the real session, token and CSRF
// checks.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-hb-approval-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
const API_TOKEN = "test-canary-api-token-000000000000";
process.env.TARSEE_API_TOKEN = API_TOKEN;
for (const name of ["TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_URL", "TARSEE_LOCAL_AI_KEY", "TARSEE_COMMIT_SHA"]) {
  delete process.env[name];
}
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });
// The Claude plan, signed in through its Railway variable: the default AI is ready, so only the owner's OK decides.
process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-canary-claude-oauth-token";

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { initLiveBus } = await import("../src/lib/live-bus.js");
const { registerEngine, configureTurns } = await import("../src/ai/turn.js");
const { createFakeEngine } = await import("./fakes/fake-engine.js");
const heartbeat = await import("../src/lib/heartbeat.js");
const { runBootChecklist } = await import("../src/lib/boot-runner.js");
const { writeWorkspaceFile, invalidateCache } = await import("../src/lib/workspace-files.js");
const { executeTool } = await import("../src/lib/tools.js");
const { sessionAuth, requireAuth, createSession, initSessionStore } = await import("../src/middleware/auth.js");
const { csrfProtect, generateCsrfCookie } = await import("../src/middleware/security.js");
const { settingsRouter } = await import("../src/routes/settings.js");

const db = initDb(path.join(tmp, "tarsee.db"));
initLiveBus(db);
initSessionStore(db);
const settings = new SettingsStore(db);

const BOOT_MARKER = path.join(tmp, ".boot-checklist-ran");
const HEARTBEAT_TASK = "# Heartbeat\n\n- Check the inbox and tell me about anything urgent.\n";
const BOOT_TASK = "# Boot\n\n- Post the day's plan on Telegram.\n";
const EMPTY_TEMPLATE = "# Heartbeat\n\n<!-- Add tasks here. Leave empty to skip heartbeat runs. -->\n";

let engine;
let restore;
const answer = (text) => [{ type: "text", content: text }, { type: "done", stopReason: "end_turn" }];

/** A fresh install's settings: no owner's OK stored yet for either file. */
function forgetApprovals() {
  for (const prefix of ["heartbeat.", "boot."]) for (const { key } of settings.getByPrefix(prefix)) settings.delete(key);
}

/** What the AI does with its file tool in a chat (lib/tools.js write_file). */
async function aiWrites(filename, content) {
  const out = await executeTool("write_file", { filename, content }, { db, settingsStore: settings, conversationId: null });
  assert.match(String(out), /Successfully wrote/, String(out));
}

/** A write that never goes through Tarsee at all (the engine's own Write tool, the shell): the 5 s read cache runs out. */
function writtenFromOutside(filename, content) {
  fs.writeFileSync(path.join(tmp, "workspace", filename), content, "utf8");
  invalidateCache();
}

/** Boot as server.js does it: the heartbeat timer starts (and the first start of this version OKs what is there). */
function bootHeartbeat() {
  heartbeat.stopHeartbeat();
  heartbeat.startHeartbeat({ db, settingsStore: settings, intervalMs: 24 * 60 * 60 * 1000 });
}

/** A restart on a new build: the boot checklist's once-per-build marker is gone. */
function bootChecklist() {
  fs.rmSync(BOOT_MARKER, { force: true });
  return runBootChecklist({ db, settingsStore: settings });
}

async function withLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = orig;
  }
}

// --- The dashboard and the API, behind the real auth and CSRF checks ---------------------------------------------

let server;
let base;
let sessionCookie;
let csrfToken;

async function serve() {
  const { automationApprovalRouter } = await import("../src/routes/automation-approval.js");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.set("db", db);
  app.set("settingsStore", settings);
  app.use(sessionAuth);
  app.get("/page", generateCsrfCookie, (_req, res) => res.send("ok"));
  // As src/server.js mounts them.
  app.use("/api/settings", requireAuth, csrfProtect, settingsRouter);
  app.use("/api/automation-approval", requireAuth, csrfProtect, automationApprovalRouter);
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  sessionCookie = `tarsee_session=${createSession("127.0.0.1")}`;
  const page = await fetch(`${base}/page`);
  csrfToken = /tarsee_csrf=([^;]+)/.exec(page.headers.get("set-cookie") || "")?.[1];
  assert.ok(csrfToken, "the page set a CSRF cookie");
}

/**
 * One request as `who`: "owner" is the signed-in dashboard (session cookie and CSRF token, no API token), "bearer" the
 * API token alone, "both" the dashboard with the API token added (as js/api.js sends every other request).
 */
async function call(method, p, body, who = "owner") {
  const headers = { "Content-Type": "application/json" };
  if (who === "owner" || who === "both") Object.assign(headers, { cookie: sessionCookie, "x-csrf-token": csrfToken });
  if (who === "bearer" || who === "both") headers.authorization = `Bearer ${API_TOKEN}`;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const fileIn = (list, name) => list?.files?.find((f) => f.name === name);

/** The owner types in Settings > Automation's editor: the autosave saves the file, then OKs what it saved. */
async function ownerSavesInSettings(name, content) {
  const put = await call("PUT", "/api/settings/workspace-file", { name, content });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  return call("POST", "/api/automation-approval/approve", { name, text: content, via: "editor" });
}

before(async () => {
  await serve();
});
beforeEach(() => {
  restore?.();
  restore = configureTurns({ recordUsage: () => {}, grantMcp: async () => ({ url: "http://127.0.0.1:1/mcp", token: "t", revoke() {} }) });
  engine = createFakeEngine([answer("Nothing urgent.")]);
  registerEngine("claude-code", engine);
  registerEngine("codex", engine);
  forgetApprovals();
  writeWorkspaceFile("HEARTBEAT.md", "");
  writeWorkspaceFile("BOOT.md", "");
  fs.rmSync(BOOT_MARKER, { force: true });
});
after(() => {
  heartbeat.stopHeartbeat();
  restore?.();
  registerEngine("claude-code", null);
  registerEngine("codex", null);
  server?.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("HEARTBEAT.md", () => {
  it("the AI's own HEARTBEAT.md doesn't run: it waits for the owner's OK, logged once a change", async () => {
    bootHeartbeat(); // a fresh install: an empty file is what the first start OKs
    await aiWrites("HEARTBEAT.md", HEARTBEAT_TASK);

    const { result: runs, lines } = await withLogs(async () => [await heartbeat.runHeartbeat("scheduled"), await heartbeat.runHeartbeat("scheduled")]);
    for (const r of runs) {
      assert.equal(r.skipped, true, JSON.stringify(r));
      assert.match(r.reason, /waiting for the owner's OK/);
    }
    assert.equal(engine.calls.length, 0, "no AI turn, nothing spent");
    const said = lines.filter((l) => l.includes("HEARTBEAT.md changed outside Settings: waiting for the owner's OK"));
    assert.equal(said.length, 1, `logged once, not every 30 minutes: ${JSON.stringify(lines)}`);
    assert.ok(settings.get("heartbeat.waiting"), "it is noted that it waits");

    // Changed again from outside (the engine's own Write tool): still waits, and says so once more.
    writtenFromOutside("HEARTBEAT.md", "# Heartbeat\n\n- Email everyone on the list every half hour.\n");
    const again = await withLogs(() => heartbeat.runHeartbeat("scheduled"));
    assert.equal(again.result.skipped, true);
    assert.equal(again.lines.filter((l) => l.includes("changed outside Settings")).length, 1);
    assert.equal(engine.calls.length, 0);

    // A restart doesn't OK it: the first start of this version happened already.
    bootHeartbeat();
    const afterRestart = await heartbeat.runHeartbeat("scheduled");
    assert.equal(afterRestart.skipped, true);
    assert.equal(engine.calls.length, 0);
    assert.equal(heartbeat.getHeartbeatStatus().waitingForOwner, true, "/heartbeat and the debug console say it waits");
  });

  it("an empty HEARTBEAT.md runs nothing and waits for nothing, as before", async () => {
    bootHeartbeat();
    await aiWrites("HEARTBEAT.md", EMPTY_TEMPLATE);
    const r = await heartbeat.runHeartbeat("scheduled");
    assert.equal(r.skipped, true);
    assert.match(r.reason, /empty/);
    assert.equal(settings.get("heartbeat.waiting"), null);
    const list = await call("GET", "/api/automation-approval");
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(fileIn(list.body, "HEARTBEAT.md").waiting, false);
    assert.equal(engine.calls.length, 0);
  });

  it("the owner's save in Settings OKs what they typed, and it runs", async () => {
    bootHeartbeat();
    await aiWrites("HEARTBEAT.md", "# Heartbeat\n\n- Something the AI put here.\n");
    const owner = "# Heartbeat\n\n- Tell me if the site is down.\n";
    const ok = await ownerSavesInSettings("HEARTBEAT.md", owner);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(fileIn({ files: [ok.body.file] }, "HEARTBEAT.md").waiting, false);
    assert.equal(settings.get("heartbeat.approval")?.by, "editor", "noted as the owner's save in Settings");

    const r = await heartbeat.runHeartbeat("scheduled");
    assert.equal(r.skipped, false, JSON.stringify(r));
    assert.equal(engine.calls.length, 1);
    assert.match(engine.calls[0].prompt, /Tell me if the site is down/);
    assert.doesNotMatch(engine.calls[0].prompt, /Something the AI put here/);
  });

  it("Settings shows what waits; Let it run with the text the page showed OKs it, and it runs", async () => {
    bootHeartbeat();
    await aiWrites("HEARTBEAT.md", HEARTBEAT_TASK);
    await heartbeat.runHeartbeat("scheduled");

    const list = await call("GET", "/api/automation-approval");
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const shown = fileIn(list.body, "HEARTBEAT.md");
    assert.equal(shown.waiting, true);
    assert.equal(shown.text, HEARTBEAT_TASK, "the whole text, for the owner to read before saying yes");

    const ok = await call("POST", "/api/automation-approval/approve", { name: "HEARTBEAT.md", text: shown.text });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.file.waiting, false);
    assert.equal(settings.get("heartbeat.approval")?.by, "button");
    assert.equal(settings.get("heartbeat.waiting"), null, "no longer noted as waiting");

    const r = await heartbeat.runHeartbeat("scheduled");
    assert.equal(r.skipped, false, JSON.stringify(r));
    assert.equal(engine.calls.length, 1);
    assert.match(engine.calls[0].prompt, /Check the inbox/);
  });

  it("line endings don't matter: a file saved with CRLF matches the text the page showed", async () => {
    bootHeartbeat();
    writtenFromOutside("HEARTBEAT.md", HEARTBEAT_TASK.replace(/\n/g, "\r\n"));
    const ok = await call("POST", "/api/automation-approval/approve", { name: "HEARTBEAT.md", text: HEARTBEAT_TASK });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const r = await heartbeat.runHeartbeat("scheduled");
    assert.equal(r.skipped, false, JSON.stringify(r));
  });

  it("text that changed since the page showed it gets 409 with the new text, and nothing is OK'd", async () => {
    bootHeartbeat();
    await aiWrites("HEARTBEAT.md", HEARTBEAT_TASK);
    const shown = fileIn((await call("GET", "/api/automation-approval")).body, "HEARTBEAT.md");
    await aiWrites("HEARTBEAT.md", "# Heartbeat\n\n- Something else entirely.\n");

    const stale = await call("POST", "/api/automation-approval/approve", { name: "HEARTBEAT.md", text: shown.text });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.match(stale.body.error, /changed/);
    assert.equal(stale.body.file.text, "# Heartbeat\n\n- Something else entirely.\n", "the new text, to show the owner");
    assert.notEqual(settings.get("heartbeat.approval")?.by, "button");
    const r = await heartbeat.runHeartbeat("scheduled");
    assert.equal(r.skipped, true);
    assert.equal(engine.calls.length, 0);
  });

  it("the API token (Bearer) can't OK it, alone or added to the dashboard's own session", async () => {
    bootHeartbeat();
    await aiWrites("HEARTBEAT.md", HEARTBEAT_TASK);
    const before = settings.get("heartbeat.approvedHash");

    for (const who of ["bearer", "both"]) {
      const res = await call("POST", "/api/automation-approval/approve", { name: "HEARTBEAT.md", text: HEARTBEAT_TASK }, who);
      assert.equal(res.status, 403, `${who}: ${JSON.stringify(res.body)}`);
    }
    // Nor does a save through the API, nor writing the stored OK directly.
    const put = await call("PUT", "/api/settings/workspace-file", { name: "HEARTBEAT.md", content: HEARTBEAT_TASK }, "bearer");
    assert.equal(put.status, 200);
    const { textHash } = await import("../src/lib/automation-approval.js");
    for (const key of ["heartbeat.approvedHash", "boot.approvedHash", "heartbeat.approval", "heartbeat.waiting"]) {
      const forged = await call("POST", "/api/settings/general", { key, value: textHash(HEARTBEAT_TASK) }, "bearer");
      assert.equal(forged.status, 400, `${key}: ${JSON.stringify(forged.body)}`);
    }
    assert.equal(settings.get("heartbeat.approvedHash"), before, "nothing OK'd");

    const r = await heartbeat.runHeartbeat("scheduled");
    assert.equal(r.skipped, true, JSON.stringify(r));
    assert.equal(engine.calls.length, 0);
  });

  it("the first start of this version OKs the HEARTBEAT.md already there, once, and notes it", async () => {
    writeWorkspaceFile("HEARTBEAT.md", HEARTBEAT_TASK); // an existing install's own file
    const { lines } = await withLogs(() => bootHeartbeat());
    assert.ok(settings.get("heartbeat.approvedHash"), "OK'd");
    assert.equal(settings.get("heartbeat.approval")?.by, "upgrade", "noted as the first start of this version");
    assert.ok(lines.some((l) => /HEARTBEAT\.md/.test(l) && /keeps running/.test(l)), JSON.stringify(lines));

    const r = await heartbeat.runHeartbeat("scheduled");
    assert.equal(r.skipped, false, JSON.stringify(r));
    assert.equal(engine.calls.length, 1, "runs exactly as before");

    // Only once: the AI's later change waits, through restarts too.
    await aiWrites("HEARTBEAT.md", "# Heartbeat\n\n- Something the AI added.\n");
    bootHeartbeat();
    assert.equal(settings.get("heartbeat.approval")?.by, "upgrade");
    const later = await heartbeat.runHeartbeat("scheduled");
    assert.equal(later.skipped, true, JSON.stringify(later));
    assert.equal(engine.calls.length, 1);
  });
});

describe("BOOT.md", () => {
  it("the AI's own BOOT.md doesn't run at the next restart: it waits for the owner's OK, logged once a change", async () => {
    await bootChecklist(); // a fresh install: the first start OKs the empty file
    await aiWrites("BOOT.md", BOOT_TASK);

    const { result: runs, lines } = await withLogs(async () => [await bootChecklist(), await bootChecklist()]);
    for (const r of runs) {
      assert.equal(r.skipped, true, JSON.stringify(r));
      assert.match(r.reason, /waiting for the owner's OK/);
    }
    assert.equal(engine.calls.length, 0, "no AI turn, nothing spent");
    assert.equal(lines.filter((l) => l.includes("BOOT.md changed outside Settings: waiting for the owner's OK")).length, 1, JSON.stringify(lines));
    assert.ok(settings.get("boot.waiting"));
  });

  it("Settings shows it; Run at each restart OKs the text the page showed, and the next restart runs it", async () => {
    await bootChecklist();
    await aiWrites("BOOT.md", BOOT_TASK);
    await bootChecklist();

    const shown = fileIn((await call("GET", "/api/automation-approval")).body, "BOOT.md");
    assert.equal(shown.waiting, true);
    assert.equal(shown.text, BOOT_TASK);
    const ok = await call("POST", "/api/automation-approval/approve", { name: "BOOT.md", text: shown.text });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(engine.calls.length, 0, "OK'ing it doesn't run it there and then");

    const r = await bootChecklist();
    assert.equal(r.skipped, false, JSON.stringify(r));
    assert.equal(engine.calls.length, 1);
    assert.match(engine.calls[0].prompt, /Post the day's plan/);
  });

  it("the owner's save in Settings OKs it, and the next restart runs it", async () => {
    await bootChecklist();
    const ok = await ownerSavesInSettings("BOOT.md", BOOT_TASK);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(settings.get("boot.approval")?.by, "editor");
    const r = await bootChecklist();
    assert.equal(r.skipped, false, JSON.stringify(r));
    assert.equal(engine.calls.length, 1);
  });

  it("text that changed since the page showed it gets 409; the API token can't OK it", async () => {
    await bootChecklist();
    await aiWrites("BOOT.md", BOOT_TASK);
    await aiWrites("BOOT.md", "# Boot\n\n- Something else.\n");
    const stale = await call("POST", "/api/automation-approval/approve", { name: "BOOT.md", text: BOOT_TASK });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.file.text, "# Boot\n\n- Something else.\n");

    for (const who of ["bearer", "both"]) {
      const res = await call("POST", "/api/automation-approval/approve", { name: "BOOT.md", text: "# Boot\n\n- Something else.\n" }, who);
      assert.equal(res.status, 403, `${who}: ${JSON.stringify(res.body)}`);
    }
    const r = await bootChecklist();
    assert.equal(r.skipped, true, JSON.stringify(r));
    assert.equal(engine.calls.length, 0);
  });

  it("the first start of this version OKs the BOOT.md already there, once, and notes it", async () => {
    writeWorkspaceFile("BOOT.md", BOOT_TASK);
    const first = await bootChecklist();
    assert.equal(first.skipped, false, JSON.stringify(first));
    assert.equal(engine.calls.length, 1, "runs exactly as before");
    assert.equal(settings.get("boot.approval")?.by, "upgrade");

    await aiWrites("BOOT.md", "# Boot\n\n- Something the AI added.\n");
    const later = await bootChecklist();
    assert.equal(later.skipped, true, JSON.stringify(later));
    assert.equal(engine.calls.length, 1);
    assert.equal(settings.get("boot.approval")?.by, "upgrade");
  });

  it("only HEARTBEAT.md and BOOT.md can be OK'd, and only with the text as a string", async () => {
    const other = await call("POST", "/api/automation-approval/approve", { name: "SOUL.md", text: "x" });
    assert.equal(other.status, 400);
    const noText = await call("POST", "/api/automation-approval/approve", { name: "BOOT.md" });
    assert.equal(noText.status, 400);
  });
});

describe("the page and the server", () => {
  const read = (p) => fs.readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

  it("src/server.js mounts the routes behind sign-in and the CSRF check, next to Settings'", () => {
    const src = read("server.js");
    assert.match(src, /^import \{ automationApprovalRouter \} from "\.\/routes\/automation-approval\.js";/m);
    assert.match(src, /^app\.use\("\/api\/automation-approval", requireAuth, csrfProtect, automationApprovalRouter\);/m);
  });

  it("Settings shows the note and its buttons, and OKs without the API token (the server would refuse it)", () => {
    const js = read("public/js/settings.js");
    for (const words of ["Changed outside Settings, waiting for your OK", "Let it run", "Run at each restart", "/api/automation-approval"]) {
      assert.ok(js.includes(words), words);
    }
    const post = /async _ownerPost\([\s\S]*?\n {2}\},/.exec(js)?.[0];
    assert.ok(post, "one helper sends the owner's OK");
    assert.match(post, /fetch\(/);
    assert.doesNotMatch(post, /Authorization|API\.token|API\.json|API\.request/, "never with the API token");
    assert.match(post, /X-CSRF-Token/);
    assert.match(js, /approveAutomationFile\(name, content, "editor"\)/, "the editor's autosave OKs what it saved");
  });
});
