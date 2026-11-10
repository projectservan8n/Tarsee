// Switching on a scheduled task is the owner's OK, and only the owner gives it: routes/settings.js (/api/settings/cron),
// js/cron-core.js, js/settings.js (the Switch on button) and css/style.css (the list on a phone). The rule: Tarsee calls
// an AI model, or spends on an API key, only when the owner sent a message, clicked a button that clearly does that, or
// set the job up themselves. So:
//   - the API token can't switch a task on. Tarsee saves it in the state folder (api.token), where the AI's own shell
//     can read it, so with the token alone the AI could approve the task it has just scheduled. Switching on takes the
//     owner's dashboard: its sign-in (the session cookie) and the page's CSRF token; the dashboard sends the API token
//     too. Pausing with the token is fine: it only stops runs;
//   - a task added with the token alone is the AI's, waiting for the owner's OK; /api/v1 can't add or switch on one;
//   - Switch on approves the task the owner saw: the PATCH says what the row showed (CronCore.seenOf), a task that
//     changed since is refused with 409, and the list is drawn again;
//   - on a phone a waiting task's prompt gets the row's whole width, with its badge and buttons on a line of their own.
// The browser parts run on Playwright's own Chromium, else an installed Chrome or Edge, and are skipped where there is
// none (npx playwright install chromium).
/* global document, window, getComputedStyle, Settings, API -- the page.evaluate() bodies run in the browser */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-cron-approval-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
// No TARSEE_API_TOKEN: Tarsee makes one and saves it in the state folder, as on most installs.
delete process.env.TARSEE_API_TOKEN;

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const { sessionAuth, requireAuth, createSession } = await import("../src/middleware/auth.js");
const { csrfProtect, generateCsrfCookie } = await import("../src/middleware/security.js");
const { settingsRouter } = await import("../src/routes/settings.js");
const { externalApiRouter } = await import("../src/routes/external-api.js");
const cron = await import("../src/lib/cron.js");
await import("../src/public/js/cron-core.js");
const CronCore = globalThis.CronCore;

const PUBLIC = fileURLToPath(new URL("../src/public/", import.meta.url));
/** What the AI's shell reads: the token file in the state folder. */
const TOKEN = fs.readFileSync(path.join(tmp, "api.token"), "utf8").trim();

const db = initDb(path.join(tmp, "tarsee.db"));
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);

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

/** The scheduled-task list on its own: Settings' styles, the section it sits in, and the scripts that draw it. */
const LIST_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/style.css"></head>
<body><main class="settings-content"><div class="settings-section"><h3>Scheduled tasks</h3>
<div id="cronJobsList" class="mb-3"></div></div></main>
<script src="/js/api.js"></script><script src="/js/cron-core.js"></script><script src="/js/settings.js"></script>
<script>
  window.toasts = [];
  window.App = { showToast(message, kind) { window.toasts.push({ message, kind }); } };
  window.signInShown = 0;
  window.addEventListener("tarsee:auth-required", () => { window.signInShown++; });
</script></body></html>`;

let server;
let base;
let csrf;
let sessionId;

before(async () => {
  cron.initCron({ db, settingsStore: settings, convStore: convs });
  const app = express();
  app.use(express.json());
  app.set("db", db);
  // As server.js has them: who is asking (the token or the sign-in), then each router behind its checks.
  app.use(sessionAuth);
  app.get("/__cron.html", generateCsrfCookie, (_req, res) => res.type("html").send(LIST_PAGE));
  app.use("/api/settings", requireAuth, csrfProtect, settingsRouter);
  app.use("/api/v1", requireAuth, externalApiRouter);
  app.use(express.static(PUBLIC));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
  // The owner, signed in to the dashboard, with the CSRF token the page gets.
  sessionId = createSession("127.0.0.1");
  const page = await fetch(`${base}/__cron.html`);
  csrf = /tarsee_csrf=([^;]+)/.exec(page.headers.get("set-cookie") || "")?.[1];
  assert.ok(csrf, "the page hands out a CSRF token");
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

const call = (method, url, body, headers = {}) => fetch(`${base}${url}`, {
  method,
  headers: { "Content-Type": "application/json", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});
/** The AI's shell: curl with the token it read from the state folder. */
const asToken = () => ({ Authorization: `Bearer ${TOKEN}` });
/** The owner's dashboard (js/api.js): the sign-in's cookie and the CSRF token, and the API token alongside. */
const asDashboard = () => ({ Authorization: `Bearer ${TOKEN}`, Cookie: `tarsee_session=${sessionId}; tarsee_csrf=${csrf}`, "X-CSRF-Token": csrf });
/** Signed in, without the API token. */
const asSignedIn = () => ({ Cookie: `tarsee_session=${sessionId}; tarsee_csrf=${csrf}`, "X-CSRF-Token": csrf });

const statusOf = (id) => cron.getCronStatus().jobs.find((j) => j.id === id);
const stateOf = (id) => [statusOf(id).state, statusOf(id).enabled, statusOf(id).scheduled];
/** A task the AI scheduled in a chat (tarsee_schedule_task): switched off, waiting for the owner's OK. */
const aiTask = (over = {}) => cron.addCronJob({ schedule: "0 9 * * 1", prompt: "Plan the week", name: "Week", createdBy: "ai", ...over });
/** What the owner's row shows of a task, from GET /api/settings/cron as the page reads it. */
async function seenOnTheRow(id) {
  const res = await call("GET", "/api/settings/cron", undefined, asDashboard());
  return CronCore.seenOf((await res.json()).jobs.find((j) => j.id === id));
}
/**
 * A task changed where it is saved, keeping its id, as anything that writes Tarsee's database could (the AI's shell
 * runs as the same user); Tarsee itself never gives a deleted task's id to another one.
 */
function changeSaved(id, change) {
  const jobs = cron.loadCronJobs();
  Object.assign(jobs.find((j) => j.id === id), change);
  settings.set("cron.jobs", JSON.stringify(jobs));
}
const switchOn = async (id, headers, seen) => call("PATCH", `/api/settings/cron/${encodeURIComponent(id)}`, { enabled: true, seen: seen === undefined ? await seenOnTheRow(id) : seen }, headers);

// ---------------------------------------------------------------------------------------------------------------

describe("the API token can't switch a task on", () => {
  it("the AI's shell, with the token from the state folder, can't switch on the task it just scheduled: 403, and where the owner can", async () => {
    const job = aiTask();
    const res = await switchOn(job.id, asToken());
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /Settings > Automation > Scheduled tasks/);
    assert.ok(body.error.includes(`/cron on ${job.id}`), body.error);
    assert.match(body.error, /from your own chat/);
    assert.doesNotMatch(body.error, /CSRF/, "not a word the owner has to know");
    assert.deepEqual(stateOf(job.id), ["waiting", false, false], "still waiting, with no timer");
  });

  it("nor with a session cookie that isn't a sign-in, a sign-in without the page's CSRF token, or a made-up token", async () => {
    const job = aiTask();
    for (const headers of [
      { ...asToken(), Cookie: `tarsee_session=${"0".repeat(64)}; tarsee_csrf=${csrf}`, "X-CSRF-Token": csrf },
      { ...asToken(), Cookie: `tarsee_session=${sessionId}` },
      { ...asToken(), Cookie: `tarsee_session=${sessionId}`, "X-CSRF-Token": "123.abc" },
    ]) {
      const res = await switchOn(job.id, headers);
      assert.equal(res.status, 403, JSON.stringify(headers));
    }
    assert.deepEqual(stateOf(job.id), ["waiting", false, false]);
  });

  it("pausing with the token is fine: it only stops runs", async () => {
    const job = cron.addCronJob({ schedule: "0 8 * * *", prompt: "Morning summary", createdBy: "owner" });
    assert.equal(statusOf(job.id).scheduled, true);
    const res = await call("PATCH", `/api/settings/cron/${job.id}`, { enabled: false }, asToken());
    assert.equal(res.status, 200);
    assert.deepEqual(stateOf(job.id), ["off", false, false]);
  });

  it("the owner's dashboard switches it on: the sign-in and the CSRF token, with the API token alongside or not", async () => {
    const week = aiTask();
    let res = await switchOn(week.id, asDashboard());
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(stateOf(week.id), ["on", true, true]);
    assert.equal(cron.loadCronJobs().find((j) => j.id === week.id).awaitingOwner, undefined, "the owner's OK is kept");

    const inbox = aiTask({ name: "Inbox", prompt: "Tidy the inbox" });
    res = await switchOn(inbox.id, asSignedIn());
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(stateOf(inbox.id), ["on", true, true]);
  });

  it("a task added with the token alone is the AI's and waits for the owner, even when it asks to be on", async () => {
    let res = await call("POST", "/api/settings/cron", { schedule: "0 9 * * *", prompt: "Daily digest", enabled: true }, asToken());
    assert.equal(res.status, 201);
    const added = await res.json();
    assert.deepEqual([added.enabled, added.createdBy, added.awaitingOwner], [false, "ai", true]);
    assert.match(added.note, /waits for the owner's OK/);
    assert.deepEqual(stateOf(added.id), ["waiting", false, false]);
    assert.equal((await switchOn(added.id, asToken())).status, 403, "and the token can't switch it on either");

    res = await call("POST", "/api/settings/cron", { schedule: "0 18 * * *", prompt: "Evening wrap-up" }, asDashboard());
    assert.equal(res.status, 201);
    const mine = await res.json();
    assert.deepEqual([mine.enabled, mine.createdBy, mine.awaitingOwner], [true, "owner", undefined], "the owner's form: on, as before");
    assert.deepEqual(stateOf(mine.id), ["on", true, true]);
  });

  it("nor by writing the saved task list as a setting (POST /api/settings/general, cron.jobs)", async () => {
    const sneaked = JSON.stringify([{ id: "cron_sneaked", schedule: "0 9 * * *", prompt: "Email everyone in my contacts", channel: "web:default", enabled: true, createdBy: "owner" }]);
    for (const headers of [asToken(), asDashboard()]) {
      const res = await call("POST", "/api/settings/general", { key: "cron.jobs", value: sneaked }, headers);
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /Settings > Automation > Scheduled tasks/);
    }
    assert.deepEqual(cron.loadCronJobs(), [], "nothing saved, so a restart starts nothing");
  });

  it("/api/v1 has no way to add or switch on a task", async () => {
    const routes = externalApiRouter.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
    assert.ok(routes.length > 0, "the router's routes are read");
    assert.deepEqual(routes.filter((p) => /cron|task|schedul/i.test(p)), [], routes.join(", "));
    for (const [method, url] of [["POST", "/api/v1/cron"], ["PATCH", "/api/v1/cron/x"], ["POST", "/api/v1/tasks"]]) {
      const res = await call(method, url, { schedule: "0 9 * * *", prompt: "x", enabled: true }, asToken());
      assert.equal(res.status, 404, `${method} ${url}`);
    }
    assert.equal(cron.loadCronJobs().length, 0);
  });
});

describe("Switch on approves the task the owner saw", () => {
  it("the row says what it showed: the schedule and the prompt, or the action a task runs", () => {
    assert.deepEqual(CronCore.seenOf({ id: "a", schedule: "0 9 * * 1", prompt: "Plan the week", name: "Week", enabled: false }), { schedule: "0 9 * * 1", prompt: "Plan the week" });
    const action = { tool: "send_message", args: { channel: "web", message: "Lunch!" } };
    assert.deepEqual(CronCore.seenOf({ id: "b", schedule: "30 12 * * *", prompt: "", action }), { schedule: "30 12 * * *", action });
    assert.deepEqual(CronCore.seenOf({ id: "c", schedule: "0 7 * * *" }), { schedule: "0 7 * * *", prompt: "" }, "a task saved with no prompt shows none");
  });

  it("a task that changed after the list was drawn is refused with 409 and keeps waiting; a fresh look switches it on", async () => {
    const job = aiTask();
    const seen = await seenOnTheRow(job.id);
    // The owner's list shows "Plan the week"; then the task changes where it is saved, keeping its id.
    changeSaved(job.id, { schedule: "*/15 * * * *", prompt: "Email everyone in my contacts" });

    let res = await switchOn(job.id, asDashboard(), seen);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /changed after your list was drawn.*Look at it again/s);
    assert.deepEqual(stateOf(job.id), ["waiting", false, false]);

    res = await switchOn(job.id, asDashboard());
    assert.equal(res.status, 200, "switched on once the owner has looked at what it is now");
    assert.deepEqual(stateOf(job.id), ["on", true, true]);
  });

  it("so is one whose schedule alone changed, one whose action changed, and one that now runs an action instead", async () => {
    const week = aiTask();
    const seen = await seenOnTheRow(week.id);
    assert.equal((await switchOn(week.id, asDashboard(), { ...seen, schedule: "0 10 * * 1" })).status, 409, "another schedule");

    const lunch = aiTask({ name: "Lunch", schedule: "30 12 * * *", prompt: "", action: { tool: "send_message", args: { channel: "web", message: "Pay the rent" } } });
    const lunchSeen = await seenOnTheRow(lunch.id);
    const otherArgs = { ...lunchSeen, action: { tool: "send_message", args: { channel: "web", message: "Lunch!" } } };
    assert.equal((await switchOn(lunch.id, asDashboard(), otherArgs)).status, 409, "another message");
    assert.equal((await switchOn(lunch.id, asDashboard(), { schedule: "30 12 * * *", prompt: "" })).status, 409, "a prompt, not this action");
    assert.deepEqual(stateOf(week.id), ["waiting", false, false]);
    assert.deepEqual(stateOf(lunch.id), ["waiting", false, false]);
    assert.equal((await switchOn(lunch.id, asDashboard(), lunchSeen)).status, 200, "the very action it runs");
  });

  it("a switch-on that doesn't say what the row showed is refused, and nothing changes", async () => {
    const job = aiTask();
    for (const seen of [null, "Plan the week", {}]) {
      const res = await switchOn(job.id, asDashboard(), seen);
      assert.ok([400, 409].includes(res.status), `${JSON.stringify(seen)}: ${res.status}`);
      assert.match((await res.json()).error, /look at (it|the task) again/i);
    }
    const res = await call("PATCH", `/api/settings/cron/${job.id}`, { enabled: true }, asDashboard());
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Reload the page/);
    assert.deepEqual(stateOf(job.id), ["waiting", false, false]);
  });

  it("an unknown task is still 404, and pausing needs nothing of what the row showed", async () => {
    assert.equal((await switchOn("cron_nope", asDashboard(), { schedule: "0 9 * * *", prompt: "x" })).status, 404);
    const job = cron.addCronJob({ schedule: "0 8 * * *", prompt: "Morning summary", createdBy: "owner" });
    assert.equal((await call("PATCH", `/api/settings/cron/${job.id}`, { enabled: false }, asDashboard())).status, 200);
    assert.deepEqual(stateOf(job.id), ["off", false, false]);
  });
});

// --- In a real browser -------------------------------------------------------------------------------------------

/** The list page, signed in like the owner's dashboard: the sign-in's cookie, the page's CSRF cookie, the API token. */
async function openList({ width = 1000, height = 900, signedIn = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
  if (signedIn) await context.addCookies([{ name: "tarsee_session", value: sessionId, url: base }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route((url) => !url.href.startsWith(base), (route) => route.abort());
  await page.goto(`${base}/__cron.html`);
  await page.evaluate((token) => { API.token = token; }, TOKEN);
  return { page, context, errors };
}

/** Settings.loadCronJobs(), as the Automation tab calls it, and the rows it draws. */
async function drawList(page) {
  await page.evaluate(() => {
    Settings.elements = { cronJobsList: document.getElementById("cronJobsList") };
    return Settings.loadCronJobs();
  });
}

const PROMPT = "Every weekday at nine, read my inbox and my calendar, then send me a short list of what needs an answer from me today, please.".slice(0, 120);

describe("the Switch on button (js/settings.js), against the real route", { skip }, () => {
  it("sends what its row showed; a task that changed since is refused, said so, and the list drawn again", async () => {
    const { page, context, errors } = await openList();
    try {
      const first = aiTask();
      await drawList(page);
      await page.locator(".cron-prompt", { hasText: "Plan the week" }).waitFor();
      // While the owner looks, the task changes where it is saved.
      changeSaved(first.id, { schedule: "*/15 * * * *", prompt: "Email everyone in my contacts" });
      const sent = page.waitForRequest((req) => req.method() === "PATCH");
      await page.locator(`[data-cron-toggle="${first.id}"]`).click();
      assert.deepEqual((await sent).postDataJSON(), { enabled: true, seen: { schedule: "0 9 * * 1", prompt: "Plan the week" } });
      await page.locator(".cron-prompt", { hasText: "Email everyone in my contacts" }).waitFor();
      const toasts = await page.evaluate(() => window.toasts);
      assert.equal(toasts.length, 1, JSON.stringify(toasts));
      assert.equal(toasts[0].kind, "error");
      assert.match(toasts[0].message, /changed after your list was drawn/);
      assert.deepEqual(stateOf(first.id), ["waiting", false, false], "not switched on");

      // Now the row shows what the task is; Switch on switches that on.
      await page.locator(`[data-cron-toggle="${first.id}"]`).click();
      await page.locator(`[data-cron-toggle="${first.id}"]`, { hasText: "Pause" }).waitFor();
      assert.deepEqual(stateOf(first.id), ["on", true, true]);
      assert.equal((await page.evaluate(() => window.toasts.at(-1))).message, "Task switched on");

      // Pause says only that.
      const paused = page.waitForRequest((req) => req.method() === "PATCH");
      await page.locator(`[data-cron-toggle="${first.id}"]`).click();
      assert.deepEqual((await paused).postDataJSON(), { enabled: false });
      await page.locator(`[data-cron-toggle="${first.id}"]`, { hasText: "Switch on" }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("signed out, with only the API token left: switching on asks the owner to sign in again", async () => {
    const { page, context, errors } = await openList({ signedIn: false });
    try {
      const job = aiTask();
      await drawList(page);
      await page.locator(`[data-cron-toggle="${job.id}"]`).click();
      await page.waitForFunction(() => window.signInShown > 0);
      assert.match((await page.evaluate(() => window.toasts.at(-1))).message, /Settings > Automation > Scheduled tasks/);
      assert.deepEqual(stateOf(job.id), ["waiting", false, false]);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("the form's task, if it ends up waiting (signed out, with only the API token), says so", async () => {
    const { page, context } = await openList({ signedIn: false });
    try {
      await page.evaluate(() => {
        document.body.insertAdjacentHTML("beforeend", '<input id="s" value="0 9 * * *"><input id="p" value="Daily digest">');
        Settings.elements = { cronJobsList: document.getElementById("cronJobsList"), cronScheduleInput: document.getElementById("s"), cronPromptInput: document.getElementById("p") };
        return Settings.addCronJob();
      });
      const toast = await page.evaluate(() => window.toasts.at(-1));
      assert.match(toast.message, /waits for your OK/, JSON.stringify(toast));
      const [added] = cron.loadCronJobs();
      assert.deepEqual([added.createdBy, added.enabled], ["ai", false]);
    } finally {
      await context.close();
    }
  });
});

describe("a waiting task on a phone (css/style.css)", { skip }, () => {
  /** One waiting task with a 120-character prompt and a long id, drawn by CronCore.listHtml, measured. */
  async function measure(width) {
    const { page, context } = await openList({ width, height: 800 });
    try {
      return await page.evaluate((prompt) => {
        const list = document.getElementById("cronJobsList");
        list.innerHTML = window.CronCore.listHtml([
          { id: `cron_${"weeklyplanning".repeat(5)}`, schedule: "0 9 * * 1-5", name: "Morning", prompt, enabled: false, createdBy: "ai", awaitingOwner: true, state: "waiting" },
          { id: "cron_evening", schedule: "0 18 * * *", prompt: "Evening wrap-up", enabled: true, createdBy: "owner", state: "on" },
        ]);
        const box = (el) => el.getBoundingClientRect();
        const row = list.querySelector(".cron-job");
        const at = (sel) => box(row.querySelector(sel));
        const edges = box(list);
        const outside = [...list.querySelectorAll("*")]
          .filter((el) => { const b = box(el); return b.width > 0 && (b.left < edges.left - 0.5 || b.right > edges.right + 0.5); })
          .map((el) => el.className || el.tagName);
        const spilling = [...list.querySelectorAll(".memory-content, .memory-content > div")]
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => el.className);
        return {
          prompt: at(".cron-prompt"),
          content: at(".memory-content"),
          badge: at(".cron-state"),
          toggle: at(".cron-toggle"),
          remove: at(".memory-delete"),
          removeOpacity: getComputedStyle(row.querySelector(".memory-delete")).opacity,
          outside,
          spilling,
          pageWidth: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
        };
      }, PROMPT);
    } finally {
      await context.close();
    }
  }
  const middle = (b) => b.top + b.height / 2;

  it("at 360px the prompt gets the row's width, the badge and buttons a line of their own, and nothing runs off the side", async () => {
    assert.equal(PROMPT.length, 120);
    const m = await measure(360);
    assert.ok(m.prompt.width >= 200, `the prompt column is ${m.prompt.width}px wide`);
    assert.deepEqual(m.outside, [], "nothing sticks out of the list");
    assert.deepEqual(m.spilling, [], "nothing runs past its box, the long id included");
    assert.ok(m.pageWidth <= m.viewport, `the page scrolls sideways: ${m.pageWidth}px in ${m.viewport}px`);
    for (const part of ["badge", "toggle", "remove"]) {
      assert.ok(m[part].top >= m.content.bottom - 0.5, `the ${part} is under the prompt, not beside it`);
    }
    // With a wide font (Linux's fallback, when the page's own font isn't loaded) the badge may sit on a line above the
    // buttons; each is whole, under the prompt and inside the row (checked above), and the two buttons stay together.
    assert.ok(Math.abs(middle(m.toggle) - middle(m.remove)) < 4, "the Switch on and delete buttons share one line");
    assert.ok(middle(m.badge) <= m.toggle.bottom + 0.5, "the badge is on the buttons' line or above it, never below");
    assert.ok(m.toggle.left > m.badge.right, "the buttons after the badge");
    assert.equal(m.removeOpacity, "1", "Delete shows without a mouse to hover with");
  });

  it("on a wide screen the row stays one line: badge, what it does, then the buttons", async () => {
    const m = await measure(1000);
    assert.ok(m.content.left >= m.badge.right && m.toggle.left >= m.content.right, JSON.stringify(m));
    assert.ok(m.toggle.top < m.content.bottom, "the buttons beside the prompt");
    assert.deepEqual(m.outside, []);
    assert.deepEqual(m.spilling, []);
  });
});
