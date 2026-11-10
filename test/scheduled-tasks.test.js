// Scheduled tasks and the owner's OK (src/lib/cron.js, lib/tools.js schedule_task, routes/settings.js, lib/commands.js
// /cron, js/cron-core.js). The rule: Tarsee calls an AI model, or spends on an API key, only when the owner sent a
// message, clicked a button that clearly does that, or set the job up themselves. So:
//   - a task the AI schedules (tarsee_schedule_task) is saved paused, waiting for the owner's OK; the owner's own
//     tasks (the Settings form, /cron add) are switched on as before;
//   - the owner switches a task on or off: PATCH /api/settings/cron/:id, /cron on <id>, /cron off <id>, and the
//     Switch on / Pause button in Settings > Automation > Scheduled tasks;
//   - on a chat platform only the owner manages tasks (lib/commands.js ownerOnly);
//   - a scheduled run, a webhook's run, the heartbeat and BOOT.md can't schedule more, on either engine;
//   - a task that asks the AI runs at most once every 15 minutes, with no seconds field; a task saved before keeps
//     running;
//   - a run still going when its next time comes is skipped, not stacked, even when the task's timer was made again
//     meanwhile (switched off and on, or every timer re-made); a run paused meanwhile isn't tried again;
//   - every saved task has its own id: two that share one (older versions could save that) each keep their own
//     timer, and an id is never used again for a different task;
//   - a schedule node-cron can't read without hanging (a step of 0) is refused before node-cron sees it.
// Engines are scripted (test/fakes/fake-engine.js); nothing leaves the machine.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import express from "express";
import nodeCron from "node-cron";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-scheduled-tasks-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
for (const name of ["TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_URL", "TARSEE_LOCAL_AI_KEY"]) {
  delete process.env[name];
}
fs.mkdirSync(path.join(tmp, "workspace", "memory"), { recursive: true });
// The Claude plan, signed in through its Railway variable; nothing chosen in Settings.
process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-canary-claude-oauth-token";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ConversationStore } = await import("../src/db/conversations.js");
const { initLiveBus } = await import("../src/lib/live-bus.js");
const { registerEngine, configureTurns, runTurn } = await import("../src/ai/turn.js");
const { createFakeEngine } = await import("./fakes/fake-engine.js");
const { createTarseeMcp } = await import("../src/ai/tarsee-mcp.js");
const { stopMcpHttp } = await import("../src/ai/mcp-http.js");
const { executeTool } = await import("../src/lib/tools.js");
const { processCommand } = await import("../src/lib/commands.js");
const { settingsRouter } = await import("../src/routes/settings.js");
const cron = await import("../src/lib/cron.js");
const heartbeat = await import("../src/lib/heartbeat.js");
const { runBootChecklist } = await import("../src/lib/boot-runner.js");
const { writeWorkspaceFile: writeFile } = await import("../src/lib/workspace-files.js");
const { isAutomationFile, approveText } = await import("../src/lib/automation-approval.js");
// HEARTBEAT.md and BOOT.md run only text the owner OK'd (test/heartbeat-approval.test.js); here each is the owner's.
const writeWorkspaceFile = (name, content) => { writeFile(name, content); if (isAutomationFile(name)) approveText(settings, name, content, "editor"); };
await import("../src/public/js/cron-core.js");
const CronCore = globalThis.CronCore;

const db = initDb(path.join(tmp, "tarsee.db"));
initLiveBus(db);
const settings = new SettingsStore(db);
const convs = new ConversationStore(db);
const OPENAI_KEY = "sk-proj-testcanaryopenai00000000000";

let engine;
let restore;
let server;
let base;
const answer = (text) => [{ type: "text", content: text }, { type: "done", stopReason: "end_turn" }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusOf = (id) => cron.getCronStatus().jobs.find((j) => j.id === id);
const jobNamed = (name) => cron.loadCronJobs().find((j) => j.name === name);
/** A tool context as an interactive chat's turn builds it. */
const chatCtx = () => ({ db, settingsStore: settings, conversationId: convs.create({ title: "chat" }).id });
/** The owner, typing in the dashboard's chat. */
const owner = (text) => processCommand(text, { settingsStore: settings, db, platform: "web" }).then((r) => String(r.response));

/** Call one of Tarsee's tools the way Claude Code does: its in-process MCP server, around the turn's tool context. */
async function callInProcess(ctx, name, args) {
  const mcp = createTarseeMcp(ctx, { quiet: true });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tarsee-test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([mcp.instance.connect(serverSide), client.connect(clientSide)]);
  try {
    const r = await client.callTool({ name, arguments: args });
    return r.content.map((c) => c.text).join("\n");
  } finally {
    await client.close();
  }
}

/** The same, the way Codex does: over Tarsee's loopback HTTP endpoint, with the turn's grant. */
async function callOverHttp(mcp, name, args) {
  const transport = new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } } });
  const client = new Client({ name: "codex-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name, arguments: args });
    return r.content.map((c) => c.text).join("\n");
  } finally {
    await client.close();
  }
}

const api = (method, url, body) => fetch(`${base}/api/settings${url}`, {
  method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});

before(async () => {
  cron.initCron({ db, settingsStore: settings, convStore: convs });
  heartbeat.startHeartbeat({ db, settingsStore: settings, intervalMs: 24 * 60 * 60 * 1000 });
  const app = express();
  app.use(express.json());
  app.set("db", db);
  // The owner's signed-in dashboard, as sessionAuth marks it. What the API token can't do: test/cron-approval.test.js.
  app.use((req, _res, next) => { req.auth = { authenticated: true, method: "session" }; next(); });
  app.use("/api/settings", settingsRouter);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  cron.stopCronScheduler();
  settings.delete("cron.jobs");
  for (const prefix of ["ai.", "session."]) for (const { key } of settings.getByPrefix(prefix)) settings.delete(key);
  restore?.();
  restore = configureTurns({ recordUsage: () => {} });
  engine = createFakeEngine([answer("All good.")]);
  registerEngine("claude-code", engine);
  registerEngine("codex", engine);
});
after(async () => {
  cron.stopCronScheduler();
  heartbeat.stopHeartbeat();
  restore?.();
  registerEngine("claude-code", null);
  registerEngine("codex", null);
  await stopMcpHttp();
  server?.close();
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* a temp folder left behind */ }
});

// ---------------------------------------------------------------------------------------------------------------

describe("a task the AI schedules waits for the owner's OK", () => {
  it("a task that asks the AI is saved paused, as the AI's, waiting; nothing is scheduled; the tool says how to switch it on", async () => {
    const ctx = chatCtx();
    const text = await callInProcess(ctx, "tarsee_schedule_task", { schedule: "0 9 * * *", prompt: "Summarise my inbox", name: "Inbox" });
    const job = jobNamed("Inbox");
    assert.ok(job, text);
    assert.equal(job.enabled, false);
    assert.equal(job.createdBy, "ai");
    assert.equal(job.awaitingOwner, true);
    assert.equal(job.conversationId, ctx.conversationId, "the chat it was made in");
    const st = statusOf(job.id);
    assert.equal(st.state, "waiting");
    assert.equal(st.scheduled, false, "no timer");
    assert.match(text, /paused/i);
    assert.match(text, /won't run until the owner switches it on/);
    assert.ok(text.includes("Settings > Automation > Scheduled tasks"), text);
    assert.ok(text.includes(`/cron on ${job.id}`), text);
    assert.match(text, /Tell the owner/);

    cron.startCronScheduler();
    assert.equal(statusOf(job.id).scheduled, false, "still waiting after a restart");
  });

  it("so is a direct-action task (no AI), which the tool calls instant", async () => {
    const text = await callInProcess(chatCtx(), "tarsee_schedule_task", {
      schedule: "30 12 * * *", name: "Lunch", once: true, action: { tool: "send_message", args: { channel: "web", message: "Lunch!" } },
    });
    const job = jobNamed("Lunch");
    assert.ok(job, text);
    assert.deepEqual([job.enabled, job.createdBy, job.awaitingOwner, job.once], [false, "ai", true, true]);
    assert.equal(statusOf(job.id).scheduled, false);
    assert.ok(text.includes(`/cron on ${job.id}`), text);
  });

  it("the owner's own tasks are switched on as before: the Settings form and /cron add", async () => {
    const res = await api("POST", "/cron", { schedule: "0 8 * * *", prompt: "Morning summary" });
    assert.equal(res.status, 201);
    const made = await res.json();
    assert.deepEqual([made.enabled, made.createdBy, made.awaitingOwner], [true, "owner", undefined]);
    assert.equal(statusOf(made.id).scheduled, true);
    assert.equal(statusOf(made.id).state, "on");

    const said = await owner('/cron add "0 18 * * *" Evening wrap-up');
    const typed = cron.loadCronJobs().find((j) => j.prompt === "Evening wrap-up");
    assert.ok(typed, said);
    assert.deepEqual([typed.enabled, typed.createdBy], [true, "owner"]);
    assert.equal(statusOf(typed.id).scheduled, true);
    assert.ok(said.includes(typed.id), said);
  });

  it("anything that doesn't say the owner made it waits too", () => {
    const job = cron.addCronJob({ schedule: "0 7 * * *", prompt: "hello" });
    assert.deepEqual([job.enabled, job.createdBy, job.awaitingOwner], [false, "ai", true]);
    assert.equal(statusOf(job.id).scheduled, false);
  });

  it("two tasks with the same name get their own ids, so each can be switched on or deleted", () => {
    const a = cron.addCronJob({ schedule: "0 7 * * *", prompt: "a", name: "Daily", createdBy: "owner" });
    const b = cron.addCronJob({ schedule: "0 8 * * *", prompt: "b", name: "Daily", createdBy: "owner" });
    assert.notEqual(a.id, b.id);
    assert.equal(cron.setCronJobEnabled(b.id, false).enabled, false);
    assert.equal(statusOf(a.id).scheduled, true, "the other one keeps its timer");
    assert.equal(statusOf(b.id).scheduled, false);
  });
});

describe("the owner switches a task on and off", () => {
  it("PATCH /api/settings/cron/:id: on clears the waiting mark and schedules it, off unschedules it", async () => {
    await callInProcess(chatCtx(), "tarsee_schedule_task", { schedule: "0 9 * * 1", prompt: "Plan the week", name: "Week" });
    const { id } = jobNamed("Week");

    // Switch on says what the owner's row showed (CronCore.seenOf), so only that task is switched on.
    let res = await api("PATCH", `/cron/${id}`, { enabled: true, seen: CronCore.seenOf(jobNamed("Week")) });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.job.enabled, true);
    assert.equal(body.job.awaitingOwner, undefined, "the owner's OK is kept with the task");
    assert.equal(jobNamed("Week").awaitingOwner, undefined);
    assert.equal(statusOf(id).scheduled, true);
    assert.equal(statusOf(id).state, "on");
    assert.equal(statusOf(id).createdBy, "ai", "still says who made it");

    res = await api("PATCH", `/cron/${id}`, { enabled: false });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.job.enabled, false);
    assert.equal(statusOf(id).scheduled, false);
    assert.equal(statusOf(id).state, "off", "off, not waiting: the owner has seen it");

    cron.startCronScheduler();
    assert.equal(statusOf(id).scheduled, false, "a restart keeps it off");
    await api("PATCH", `/cron/${id}`, { enabled: true, seen: CronCore.seenOf(jobNamed("Week")) });
    cron.startCronScheduler();
    assert.equal(statusOf(id).scheduled, true, "and on");
  });

  it("PATCH says what is wrong: an unknown task, or enabled that isn't true or false", async () => {
    let res = await api("PATCH", "/cron/cron_nope", { enabled: true });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /No scheduled task/);
    const job = cron.addCronJob({ schedule: "0 9 * * *", prompt: "x" });
    res = await api("PATCH", `/cron/${job.id}`, { enabled: "yes" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /true or false/);
    assert.equal(cron.loadCronJobs()[0].enabled, false, "nothing changed");
  });

  it("/cron on <id> and /cron off <id>, and /cron list says each task's state and who made it", async () => {
    await callInProcess(chatCtx(), "tarsee_schedule_task", { schedule: "0 9 * * *", prompt: "Check the deploys", name: "Deploys" });
    const { id } = jobNamed("Deploys");
    let list = await owner("/cron list");
    assert.match(list, new RegExp(`${id}.*waiting for your OK`, "i"));
    assert.match(list, /made by the AI in a chat/i);
    assert.match(list, /\/cron on/);

    let said = await owner(`/cron on ${id}`);
    assert.match(said, /switched on/i);
    assert.equal(jobNamed("Deploys").enabled, true);
    assert.equal(jobNamed("Deploys").awaitingOwner, undefined);
    assert.equal(statusOf(id).scheduled, true);
    list = await owner("/cron list");
    assert.match(list, new RegExp(`${id}.*\\bon\\b`, "i"));

    said = await owner(`/cron off ${id}`);
    assert.match(said, /paused/i);
    assert.equal(statusOf(id).scheduled, false);
    assert.equal(statusOf(id).state, "off");

    assert.match(await owner("/cron on cron_nope"), /No scheduled task cron_nope/);
    assert.match(await owner("/cron on"), /\/cron on <id>/);
  });
});

describe("only the owner manages scheduled tasks from a chat", () => {
  const chat = (text, extra) => processCommand(text, { settingsStore: settings, db, ...extra }).then((r) => String(r.response));

  it("on a chat platform, someone who isn't the owner can't add, switch on, run or list tasks, or set up the briefing or a webhook", async () => {
    const job = cron.addCronJob({ schedule: "0 9 * * *", prompt: "x", name: "Waiting" });
    for (const platform of ["telegram", "discord", "slack", "whatsapp"]) {
      for (const text of ['/cron add "0 9 * * *" Spend money', `/cron on ${job.id}`, `/cron run ${job.id}`, "/cron list", "/briefing on", "/briefing", "/webhook list", "/webhook add hook Do things"]) {
        const said = await chat(text, { platform });
        assert.match(said, /Only the owner/, `${platform} ${text}: ${said}`);
        assert.match(said, /Settings > Automation > Scheduled tasks|dashboard/, said);
      }
    }
    assert.equal(cron.loadCronJobs().length, 1, "nothing added");
    assert.equal(jobNamed("Waiting").enabled, false, "still waiting");
    assert.equal(settings.get("webhooks"), null, "no webhook made");
    assert.equal(engine.calls.length, 0, "the AI never ran");
  });

  it("the refusal says how to be recognised: their own user id on that platform's allowlist", async () => {
    assert.match(await chat("/cron list", { platform: "telegram" }), /your own Telegram user ID on the allowlist in Settings > Channels/);
    assert.match(await chat("/cron list", { platform: "email" }), /can't be done by email/);
  });

  it("the owner can, on the dashboard or from a chat where the channel says it's them", async () => {
    const job = cron.addCronJob({ schedule: "0 9 * * *", prompt: "x", name: "Waiting" });
    assert.match(await chat(`/cron on ${job.id}`, { platform: "telegram", owner: true }), /switched on/i);
    assert.equal(jobNamed("Waiting").enabled, true);
    assert.match(await chat(`/cron off ${job.id}`, { platform: "web" }), /paused/i);
    assert.match(await chat("/cron list", { platform: "discord", owner: true }), /Waiting|cron_/);
  });

  it("a channel that says nothing about the sender counts as not the owner", async () => {
    assert.match(await chat("/cron list", {}), /Only the owner/);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a scheduled run, a webhook's run, the heartbeat and BOOT.md can't schedule more", () => {
  const ARGS = { schedule: "0 9 * * *", prompt: "Do it again tomorrow", name: "Again" };

  it("schedule_task refuses in background work, says why, and saves nothing", async () => {
    for (const background of ["cron", "heartbeat", "boot"]) {
      const out = await executeTool("schedule_task", ARGS, { db, settingsStore: settings, conversationId: null, background });
      assert.match(out, /^schedule_task refused/, out);
      assert.match(out, /only the owner can set up scheduled tasks/, out);
      assert.match(out, /Nothing was saved/, out);
    }
    assert.match(await executeTool("schedule_task", ARGS, { background: "cron" }), /scheduled task or a webhook/);
    assert.match(await executeTool("schedule_task", ARGS, { background: "heartbeat" }), /heartbeat/);
    assert.match(await executeTool("schedule_task", ARGS, { background: "boot" }), /BOOT\.md/);
    assert.equal(cron.loadCronJobs().length, 0);
  });

  it("on Claude Code: a cron job's, the heartbeat's and the boot checklist's turns get a tool context that says so", async () => {
    const outs = [];
    engine = createFakeEngine([async (opts) => {
      outs.push(await callInProcess(opts.toolCtx, "tarsee_schedule_task", ARGS));
      return answer("Done.");
    }]);
    registerEngine("claude-code", engine);

    const out = await cron.runCronJob({ id: "daily", prompt: "Check the weather" });
    assert.equal(out.error, undefined, JSON.stringify(out));
    writeWorkspaceFile("HEARTBEAT.md", "# Heartbeat\n\n- Check the inbox.\n");
    const hb = await heartbeat.runHeartbeat("test");
    assert.equal(hb.skipped, false, JSON.stringify(hb));
    writeWorkspaceFile("BOOT.md", "# Boot\n\n- Say hello (claude).\n");
    const boot = await runBootChecklist({ db, settingsStore: settings });
    assert.equal(boot.skipped, false, JSON.stringify(boot));

    assert.deepEqual(engine.calls.map((c) => [c.target.engine, c.toolCtx.background]), [["claude-code", "cron"], ["claude-code", "heartbeat"], ["claude-code", "boot"]]);
    assert.equal(outs.length, 3);
    for (const o of outs) assert.match(o, /^schedule_task refused/, o);
    assert.equal(cron.loadCronJobs().length, 0, "no task made");
  });

  it("on Codex: the grant's tool context says so too, and the call over HTTP is refused", async () => {
    settings.set("ai.openai.apiKey", OPENAI_KEY);
    settings.set("ai.activeProvider", "openai");
    const outs = [];
    engine = createFakeEngine([async (opts) => {
      outs.push(await callOverHttp(opts.mcp, "tarsee_schedule_task", ARGS));
      return answer("Done.");
    }]);
    registerEngine("codex", engine);

    const out = await cron.runCronJob({ id: "codexdaily", prompt: "Check the weather" });
    assert.equal(out.error, undefined, JSON.stringify(out));
    writeWorkspaceFile("BOOT.md", "# Boot\n\n- Say hello (codex).\n");
    const boot = await runBootChecklist({ db, settingsStore: settings });
    assert.equal(boot.skipped, false, JSON.stringify(boot));

    assert.deepEqual(engine.calls.map((c) => c.target.engine), ["codex", "codex"]);
    assert.equal(outs.length, 2);
    assert.match(outs[0], /^schedule_task refused.*scheduled task or a webhook/s, outs[0]);
    assert.match(outs[1], /^schedule_task refused.*BOOT\.md/s, outs[1]);
    assert.equal(cron.loadCronJobs().length, 0);
  });

  it("a chat's own turn can still schedule one, paused", async () => {
    const outs = [];
    engine = createFakeEngine([async (opts) => {
      outs.push(await callInProcess(opts.toolCtx, "tarsee_schedule_task", ARGS));
      return answer("Saved, waiting for your OK.");
    }]);
    registerEngine("claude-code", engine);
    for await (const evt of runTurn({ messages: [{ role: "user", content: "remind me daily" }], systemPrompt: "", toolCtx: chatCtx(), liveSource: "web" })) {
      if (evt.type === "done") break;
    }
    assert.equal(engine.calls[0].toolCtx.background, undefined);
    assert.match(outs[0], /paused/i, outs[0]);
    assert.equal(jobNamed("Again").awaitingOwner, true);
  });

  it("a direct-action task can't name schedule_task, so a task never makes tasks", async () => {
    assert.throws(() => cron.addCronJob({ schedule: "0 9 * * *", action: { tool: "schedule_task", args: ARGS }, createdBy: "owner" }), /can't schedule more tasks/);
    // One saved before this rule: its run is background work, so the tool refuses there too.
    const conv = convs.create({ title: "web" }).id;
    settings.set("channel_conv.web:default", conv);
    const out = await cron.runCronJob({ id: "old-action", schedule: "0 9 * * *", action: { tool: "schedule_task", args: ARGS } });
    assert.match(out.response, /^schedule_task refused/, JSON.stringify(out));
    assert.equal(cron.loadCronJobs().length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("how often a task that asks the AI may run", () => {
  it("no seconds field, and no two runs closer than 15 minutes, across midnight too", () => {
    assert.equal(cron.MIN_PROMPT_GAP_MINUTES, 15);
    for (const [schedule, words] of [
      ["* * * * * *", /seconds/],
      ["*/10 * * * * *", /seconds/],
      ["0 9 * * * * *", /7 parts/],
      ["* * * * *", /1 minute apart/],
      ["*/5 * * * *", /5 minutes apart/],
      ["*/14 * * * *", /4 minutes apart/],          // :56, then :00 the next hour
      ["0,10 9 * * *", /10 minutes apart/],
      ["59-0 * * * *", /1 minute apart/],            // node-cron reads a backwards range as every minute
      ["5,55 0,23 * * *", /10 minutes apart/],       // 23:55, then 00:05 the next day
      ["* * 29 2 *", /1 minute apart/],              // every minute, one day in four years
    ]) {
      const problem = cron.promptScheduleProblem(schedule);
      assert.ok(problem, `${schedule} should be refused`);
      assert.match(problem, words, `${schedule}: ${problem}`);
      assert.match(problem, /at most once every 15 minutes/, problem);
    }
    for (const schedule of ["*/15 * * * *", "0,15,30,45 * * * *", "0 9 * * *", "0 9 * * 1-5", "30 8 1 * *", "5,55 0,23 * * 1", "0 */2 * * *", "0  9 * * *"]) {
      assert.equal(cron.promptScheduleProblem(schedule), null, schedule);
    }
  });

  it("every way of making one says the rule: the AI's tool, the Settings form and /cron add", async () => {
    const tool = await callInProcess(chatCtx(), "tarsee_schedule_task", { schedule: "*/5 * * * *", prompt: "Check the price" });
    assert.match(tool, /^schedule_task error: .*at most once every 15 minutes/s, tool);
    const res = await api("POST", "/cron", { schedule: "* * * * * *", prompt: "Check the price" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /seconds.*at most once every 15 minutes/s);
    assert.match(await owner('/cron add "*/2 * * * *" Check the price'), /at most once every 15 minutes/);
    assert.equal(cron.loadCronJobs().length, 0);
  });

  it("a direct-action task (no AI) keeps today's rules", () => {
    const action = { tool: "send_message", args: { channel: "web", message: "ping" } };
    for (const schedule of ["* * * * *", "*/10 * * * * *"]) {
      const job = cron.addCronJob({ schedule, action, createdBy: "owner" });
      assert.equal(job.schedule, schedule);
      cron.removeCronJob(job.id);
    }
    assert.throws(() => cron.addCronJob({ schedule: "not a schedule", action, createdBy: "owner" }), /Invalid cron schedule/);
  });

  it("a task saved before the rule keeps running", () => {
    // Every minute, but only on 29 February: it breaks the rule, and won't fire while the tests run.
    settings.set("cron.jobs", JSON.stringify([{ id: "cron_old", schedule: "* * 29 2 *", prompt: "tick", channel: "web:default", enabled: true }]));
    cron.startCronScheduler();
    try {
      assert.equal(statusOf("cron_old").scheduled, true);
      assert.equal(statusOf("cron_old").state, "on");
    } finally {
      cron.stopCronScheduler();
    }
  });
});

describe("a run still going when the next time comes", () => {
  it("is skipped, not stacked: one run at a time, and Running while it goes", { timeout: 20_000 }, async () => {
    let active = 0;
    let most = 0;
    let starts = 0;
    let sawRunning = false;
    engine = createFakeEngine([async () => {
      starts++;
      active++;
      most = Math.max(most, active);
      await sleep(300);
      sawRunning ||= statusOf("cron_fast")?.state === "running";
      await sleep(1900);
      active--;
      return answer("tick");
    }]);
    registerEngine("claude-code", engine);
    // Every second (saved before the frequency rule, so it still loads), and each run takes 2.2 seconds.
    settings.set("cron.jobs", JSON.stringify([{ id: "cron_fast", schedule: "* * * * * *", prompt: "tick", channel: "web:default", enabled: true }]));
    cron.startCronScheduler();
    const deadline = Date.now() + 8000;
    while (!starts && Date.now() < deadline) await sleep(50);
    assert.ok(starts >= 1, "the job ran");
    await sleep(3400);
    cron.stopCronScheduler();
    while (active && Date.now() < deadline + 5000) await sleep(50);

    assert.equal(most, 1, "never two runs at once");
    assert.ok(starts <= 2, `ticks during a run are skipped: ${starts} runs in about 3.4 seconds`);
    assert.equal(sawRunning, true, "the job's state is Running while a run goes");
    assert.equal(statusOf("cron_fast").running, false, "and not after");
  });

  it("paused while a failed run waits to retry: no retry, so no more paid runs", { timeout: 20_000 }, async () => {
    engine = createFakeEngine([[{ type: "error", message: "The AI broke." }, { type: "done", stopReason: "error" }]]);
    registerEngine("claude-code", engine);
    settings.set("cron.jobs", JSON.stringify([{ id: "cron_flaky", schedule: "* * * * * *", prompt: "tick", channel: "web:default", enabled: true, createdBy: "owner" }]));
    cron.startCronScheduler();
    const deadline = Date.now() + 8000;
    while (!engine.calls.length && Date.now() < deadline) await sleep(50);
    assert.equal(engine.calls.length, 1, "the first try ran, and failed");
    cron.setCronJobEnabled("cron_flaky", false);   // the retry waits 5 seconds
    while (statusOf("cron_flaky").running && Date.now() < deadline + 8000) await sleep(100);
    assert.equal(statusOf("cron_flaky").running, false, "the run ended");
    assert.equal(engine.calls.length, 1, "and was not tried again once paused");
  });
});

describe("a run still going when the task's timer is made again", () => {
  it("switched off and on, or every timer re-made (as /briefing off does): still one run at a time", { timeout: 20_000 }, async () => {
    let active = 0;
    let most = 0;
    let starts = 0;
    engine = createFakeEngine([async () => {
      starts++;
      active++;
      most = Math.max(most, active);
      await sleep(3500);
      active--;
      return answer("tick");
    }]);
    registerEngine("claude-code", engine);
    const logs = [];
    const log = console.log;
    console.log = (...args) => { logs.push(args.join(" ")); };
    try {
      // Every second (saved before the frequency rule), and each run takes 3.5 seconds.
      settings.set("cron.jobs", JSON.stringify([{ id: "cron_slow", schedule: "* * * * * *", prompt: "tick", channel: "web:default", enabled: true, createdBy: "owner" }]));
      cron.startCronScheduler();
      const deadline = Date.now() + 8000;
      while (!starts && Date.now() < deadline) await sleep(20);
      assert.equal(starts, 1, "the task ran");
      cron.startCronScheduler();                       // every timer made again
      await sleep(1100);
      cron.setCronJobEnabled("cron_slow", false);      // paused and switched on again
      cron.setCronJobEnabled("cron_slow", true);
      await sleep(1100);
      cron.stopCronScheduler();                        // before the run ends, so no tick may start a run legitimately
      while (active && Date.now() < deadline + 8000) await sleep(50);
    } finally {
      console.log = log;
    }
    assert.equal(most, 1, "never two runs of the task at once");
    assert.equal(starts, 1, "the times that came while it ran were skipped");
    assert.ok(logs.some((l) => /cron_slow.*still running.*skipped/i.test(l)), `a skipped time is logged: ${logs.join(" | ")}`);
  });

  it("paused and switched on again while a failed run waits to retry: that run isn't tried again", { timeout: 25_000 }, async () => {
    engine = createFakeEngine([[{ type: "error", message: "The AI broke." }, { type: "done", stopReason: "error" }]]);
    registerEngine("claude-code", engine);
    settings.set("cron.jobs", JSON.stringify([{ id: "cron_flaky2", schedule: "* * * * * *", prompt: "tick", channel: "web:default", enabled: true, createdBy: "owner" }]));
    cron.startCronScheduler();
    const deadline = Date.now() + 8000;
    while (!engine.calls.length && Date.now() < deadline) await sleep(50);
    assert.equal(engine.calls.length, 1, "the first try ran, and failed");
    cron.setCronJobEnabled("cron_flaky2", false);    // the retry waits 5 seconds
    // Back on, at a time that won't come while the test runs: any later try could only be the paused run's retry.
    settings.set("cron.jobs", JSON.stringify(cron.loadCronJobs().map((j) => ({ ...j, schedule: "* * 29 2 *" }))));
    cron.setCronJobEnabled("cron_flaky2", true);
    while (statusOf("cron_flaky2").running && Date.now() < deadline + 12_000) await sleep(100);
    assert.equal(statusOf("cron_flaky2").running, false, "the run ended");
    assert.equal(engine.calls.length, 1, "and was not tried again");
    assert.equal(statusOf("cron_flaky2").scheduled, true, "the task is on, for its next time");
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("every saved task has its own id", () => {
  // Older versions made an id from "cron_" and the first 12 letters of the name, and never checked it was free.
  const twins = (a, b) => settings.set("cron.jobs", JSON.stringify([
    { id: "cron_dailyreport", channel: "web:default", enabled: true, createdBy: "owner", ...a },
    { id: "cron_dailyreport", channel: "web:default", enabled: true, createdBy: "owner", ...b },
  ]));

  it("two saved with one id each keep their own timer: both run", { timeout: 20_000 }, async () => {
    twins({ schedule: "* * * * * *", prompt: "first copy" }, { schedule: "* * * * * *", prompt: "second copy" });
    cron.startCronScheduler();
    const ran = () => new Set(engine.calls.map((c) => c.prompt.split("\n\n").pop()));
    const deadline = Date.now() + 8000;
    while (ran().size < 2 && Date.now() < deadline) await sleep(50);
    cron.stopCronScheduler();
    while (cron.getCronStatus().jobs.some((j) => j.running) && Date.now() < deadline + 5000) await sleep(50);
    assert.deepEqual([...ran()].sort(), ["first copy", "second copy"]);
  });

  it("the first keeps the id and the later one gets a new one, saved once; both show on; pausing one leaves the other on", () => {
    twins({ schedule: "* * 29 2 *", prompt: "a" }, { schedule: "0 0 29 2 *", prompt: "b" });
    let saves = 0;
    const set = settings.set;
    settings.set = function (key, value) {
      if (key === "cron.jobs") saves++;
      return set.call(this, key, value);
    };
    try {
      cron.startCronScheduler();
      cron.startCronScheduler();
    } finally {
      delete settings.set;
    }
    const [a, b] = cron.loadCronJobs();
    assert.equal(a.id, "cron_dailyreport", "the first keeps its id");
    assert.match(b.id, /^cron_dailyreport_\w+$/, "the later one, a new one");
    assert.deepEqual([a.prompt, b.prompt], ["a", "b"]);
    assert.equal(saves, 1, "the new id is saved once, and kept after that");
    assert.equal(cron.getCronStatus().activeJobs, 2);
    for (const { id } of [a, b]) assert.deepEqual([statusOf(id).state, statusOf(id).scheduled], ["on", true], id);

    cron.setCronJobEnabled(b.id, false);
    assert.deepEqual([statusOf(a.id).state, statusOf(a.id).scheduled], ["on", true], "pausing one leaves the other on");
    assert.deepEqual([statusOf(b.id).state, statusOf(b.id).scheduled], ["off", false]);
    cron.setCronJobEnabled(a.id, false);
    cron.setCronJobEnabled(b.id, true);
    assert.deepEqual([statusOf(a.id).scheduled, statusOf(b.id).scheduled], [false, true], "and the other way round");
    assert.equal(cron.removeCronJob(a.id), true);
    assert.deepEqual(cron.loadCronJobs().map((j) => j.id), [b.id], "deleting one leaves the other");
    assert.equal(statusOf(b.id).scheduled, true);
  });

  it("an id freed by a deleted task never goes to a different one", () => {
    const a = cron.addCronJob({ schedule: "0 9 * * *", prompt: "Report to the team", name: "Daily report", createdBy: "owner" });
    assert.match(a.id, /^cron_dailyreport_\w+$/, "still says what it is");
    cron.removeCronJob(a.id);
    const b = cron.addCronJob({ schedule: "0 18 * * *", prompt: "Something else", name: "Daily report", createdBy: "owner" });
    assert.notEqual(b.id, a.id);
    const ids = new Set();
    for (let i = 0; i < 20; i++) {
      const job = cron.addCronJob({ schedule: "0 9 * * *", prompt: "x" });
      ids.add(job.id);
      cron.removeCronJob(job.id);
    }
    assert.equal(ids.size, 20, "unnamed ones too, even made in the same moment");
  });

  it("the morning briefing keeps its own id, so /briefing time and /briefing off still find it", async () => {
    try {
      assert.match(await owner("/briefing on"), /enabled/i);
      assert.deepEqual(cron.loadCronJobs().map((j) => j.id), ["cron_briefingam"]);
      assert.match(await owner("/briefing time 7"), /7:00/);
      assert.deepEqual(cron.loadCronJobs().map((j) => [j.id, j.schedule]), [["cron_briefingam", "0 7 * * *"]]);
      assert.match(await owner("/briefing off"), /disabled/i);
      assert.equal(cron.loadCronJobs().length, 0);
    } finally {
      settings.delete("briefing.hour");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a schedule with a step of 0 can't take the server down", () => {
  // node-cron 4.2.1 writes out every number of a range one step at a time before it checks anything, so a step of 0
  // never ends: it fills the memory until the server falls over. In the weekday part it first reads the first 7 as 0
  // (both are Sunday), so "*/7" and "0-6/7" there are a step of 0 too.
  const HANGS = ["*/0 * * * *", "0 9 * * */7", "0 9 * * 0-6/7"];
  const FINE = ["*/5 * * * *", "0 9 * * 1-5", "0 0 * * 7"];

  // Tarsee's cron code, in a worker with little memory and a time limit: a schedule that reached node-cron unchecked
  // fails the test in a few seconds instead of filling the test run's memory.
  const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const cron = await import(workerData.cronUrl);
  const saved = new Map();
  cron.initCron({ db: {}, settingsStore: { get: (k) => saved.get(k) ?? null, set: (k, v) => saved.set(k, v), delete: (k) => saved.delete(k) } });
  const made = {};
  for (const s of workerData.schedules) {
    const r = { prompt: cron.promptScheduleProblem(s) };
    try { cron.addCronJob({ schedule: s, action: { tool: "send_message", args: { message: "hi" } } }); r.added = true; } catch (e) { r.added = e.message; }
    made[s] = r;
  }
  saved.set("cron.jobs", JSON.stringify(workerData.schedules.map((schedule, i) => ({ id: "cron_saved" + i, schedule, prompt: "x", enabled: true, createdBy: "owner" }))));
  cron.startCronScheduler();
  const scheduled = Object.fromEntries(cron.getCronStatus().jobs.map((j) => [j.schedule, j.scheduled]));
  cron.stopCronScheduler();
  parentPort.postMessage({ made, scheduled });
})().catch((e) => parentPort.postMessage({ crashed: String((e && e.stack) || e) }));
`;
  function inWorker(schedules) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER, {
        eval: true,
        workerData: { cronUrl: new URL("../src/lib/cron.js", import.meta.url).href, schedules },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      const end = (fn, value) => {
        clearTimeout(timer);
        worker.terminate();
        fn(value);
      };
      const timer = setTimeout(() => end(reject, new Error("no answer after 15 seconds: a schedule reached node-cron unchecked")), 15_000);
      worker.once("message", (m) => end(resolve, m));
      worker.once("error", (e) => end(reject, e));
    });
  }

  it("making one is refused in plain words (the AI's tool, the form, /cron add), and one saved before is skipped at boot", { timeout: 30_000 }, async () => {
    const out = await inWorker([...HANGS, ...FINE]);
    assert.equal(out.crashed, undefined, out.crashed);
    for (const s of HANGS) {
      const { prompt, added } = out.made[s];
      assert.match(prompt, /step of 0/, `${s}: ${prompt}`);
      assert.equal(added, prompt, `${s}: addCronJob refuses it the same way, for a direct-action task too`);
      assert.equal(out.scheduled[s], false, `${s}: saved before, it gets no timer, and the boot goes on`);
    }
    assert.match(out.made["0 9 * * */7"].prompt, /weekday part.*7.*Sunday/s);
    assert.match(out.made["*/5 * * * *"].prompt, /5 minutes apart/, "only the usual frequency rule");
    for (const s of ["0 9 * * 1-5", "0 0 * * 7"]) assert.equal(out.made[s].prompt, null, s);
    for (const s of FINE) {
      assert.equal(out.made[s].added, true, s);
      assert.equal(out.scheduled[s], true, `${s}: saved before, it runs`);
    }
  });

  it("the check reads the schedule as node-cron does, without writing anything out", () => {
    const check = cron.unsafeScheduleProblem;
    assert.equal(typeof check, "function");
    for (const [s, words] of [
      ...HANGS.map((s) => [s, /step of 0/]),
      ["0 9 * * */sun", /weekday part.*step of 0/s],     // "sun" is day 0 to node-cron
      ["0 9 * * */70", /weekday part.*step of 0/s],      // the first 7 becomes 0: "*/00"
      ["0 9 * * 1-5/0", /step of 0/],
      ["0-59/00 * * * *", /step of 0/],
      ["*/0.5 * * * *", /step of 0/],                    // node-cron reads the step's digits, "0"
      ["5/0 * * * *", /step of 0/],                      // no hang, but a step of 0 is never meant
      ["*/-1 * * * *", /step of -1/],
      ["0 9 * * * * 1-2/0", /step of 0/],                // node-cron writes out a seventh part's ranges too
      ["0-99999999999 * * * *", /range "0-99999999999"/],
      ["99999999999999999999-99999999999999999999 * * * *", /range/],
      [`${"1,".repeat(600)}2 * * * *`, /characters long/],
      [42, /text/],
    ]) {
      const started = Date.now();
      const problem = check(s);
      assert.ok(Date.now() - started < 500, `${s}: quick`);
      assert.match(String(problem), words, `${s}: ${problem}`);
      assert.doesNotMatch(String(problem), /node-cron|regex|NaN|undefined/, "plain words");
    }
    for (const s of [...FINE, "*/15 * * * *", "0,15,30,45 * * * *", "59-0 * * * *", "* * 29 2 *", "0 */2 * * *", "0  9 * * *", "* * * * * *", "0 9 * * sun", "0 9 * jan-mar mon-fri", "0 9 * * 0-7", "*/90 * * * *", "0 9 * * 1-7/2"]) {
      assert.equal(check(s), null, s);
      assert.equal(nodeCron.validate(s), true, `${s} is one node-cron takes`);
    }
    assert.equal(check("not a schedule"), null, "anything else is node-cron's to judge: it says no without hanging");
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("Settings > Automation > Scheduled tasks (js/cron-core.js)", () => {
  const page = fs.readFileSync(new URL("../src/public/index.html", import.meta.url), "utf8");
  const settingsJs = fs.readFileSync(new URL("../src/public/js/settings.js", import.meta.url), "utf8");
  const sw = fs.readFileSync(new URL("../src/public/sw.js", import.meta.url), "utf8");
  const job = (over) => ({ id: "cron_a", schedule: "0 9 * * *", prompt: "Summarise my inbox", enabled: true, createdBy: "owner", ...over });

  it("each task says its state in plain words", () => {
    assert.equal(CronCore.stateOf(job({ enabled: false, createdBy: "ai", awaitingOwner: true })), "waiting");
    assert.equal(CronCore.stateOf(job()), "on");
    assert.equal(CronCore.stateOf(job({ enabled: false })), "off");
    assert.equal(CronCore.stateOf(job({ running: true })), "running");
    assert.equal(CronCore.stateOf(job({ state: "running" })), "running", "the server's word wins");
    assert.match(CronCore.jobHtml(job({ enabled: false, createdBy: "ai", awaitingOwner: true })), />Waiting for your OK</);
    assert.match(CronCore.jobHtml(job()), />On</);
    assert.match(CronCore.jobHtml(job({ enabled: false })), />Off</);
    assert.match(CronCore.jobHtml(job({ running: true })), />Running</);
  });

  it("says who made it", () => {
    assert.match(CronCore.jobHtml(job({ createdBy: "ai", awaitingOwner: true, enabled: false })), /Made by the AI in a chat/);
    assert.match(CronCore.jobHtml(job()), /Made by you/);
    assert.match(CronCore.jobHtml(job({ createdBy: undefined })), /Made before Tarsee noted who makes each task/);
  });

  it("shows the whole prompt and the schedule, escaped", () => {
    const long = `Check <script>alert(1)</script> & "report" ${"word ".repeat(40)}END`;
    const html = CronCore.jobHtml(job({ prompt: long, schedule: "0 9 * * *<img src=x onerror=alert(1)>", name: "<b>n</b>", id: 'cron_"x' }));
    assert.ok(html.includes("END"), "the whole prompt, not the first 60 characters");
    assert.ok(!html.includes("<script>") && !html.includes("<img") && !html.includes("<b>n</b>"), html);
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;report&quot;"), html);
    assert.ok(html.includes("0 9 * * *&lt;img src=x onerror=alert(1)&gt;"), html);
    assert.ok(!html.includes('cron_"x'), "the id is escaped in its attributes too");
  });

  it("a direct-action task says what it runs, with no AI", () => {
    const html = CronCore.jobHtml(job({ prompt: "", action: { tool: "send_message", args: { message: "<hi>" } } }));
    assert.match(html, /Runs <code>send_message<\/code> directly, no AI/);
    assert.ok(html.includes("&lt;hi&gt;") && !html.includes("<hi>"), html);
  });

  it("has Switch on for a waiting or switched-off task, Pause for one that is on, and Delete", () => {
    for (const [over, words, to] of [
      [{ enabled: false, createdBy: "ai", awaitingOwner: true }, "Switch on", "true"],
      [{ enabled: false }, "Switch on", "true"],
      [{}, "Pause", "false"],
      [{ running: true }, "Pause", "false"],
    ]) {
      const html = CronCore.jobHtml(job(over));
      assert.match(html, new RegExp(`data-cron-toggle="cron_a" data-cron-enabled="${to}"[^>]*>${words}<`), html);
      assert.match(html, /data-cron-delete="cron_a"/);
    }
  });

  it("the empty list names the form below and /cron add", () => {
    assert.match(CronCore.EMPTY_HTML, /form below/);
    assert.match(CronCore.EMPTY_HTML, /<code>\/cron add<\/code>/);
  });

  it("the page: the section is Scheduled tasks, cron-core.js loads before settings.js and is cached, and the buttons use PATCH", () => {
    assert.match(page, /<h3>Scheduled tasks<\/h3>/);
    assert.ok(page.indexOf('<script src="/js/cron-core.js"></script>') > 0);
    assert.ok(page.indexOf("/js/cron-core.js") < page.indexOf('<script src="/js/settings.js"></script>'));
    assert.ok(sw.includes('"/js/cron-core.js"'));
    assert.doesNotMatch(sw, /const CACHE_NAME = "tarsee-v21"/, "the cache version moves on so phones pick up the new page");
    assert.match(settingsJs, /CronCore\.listHtml/);
    assert.match(settingsJs, /method: "PATCH"/);
    assert.match(settingsJs, /\/api\/settings\/cron\/\$\{encodeURIComponent/);
  });
});
