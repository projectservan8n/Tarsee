import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// A state folder of the test's own, set before Tarsee's modules load (config/env.js reads it once), so the tasks the
// tests below save land nowhere else.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-mcp-tools-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
const { createTarseeMcp } = await import("../src/ai/tarsee-mcp.js");
const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const cron = await import("../src/lib/cron.js");
const { toolDoneLabel } = await import("../src/lib/tool-status.js");

// Regression guard for the highest-impact bug in the codebase.
//
// `tarsee_schedule_task` declared its nested `action.args` as
// `z.record(z.any())`. That single-argument form was removed in zod 4 (the
// project pins ^4.3.6): it yields a record whose key schema is undefined, and
// the MCP server throws while converting the tool list to JSON Schema.
//
// The failure is NOT scoped to that one tool. tools/list is a single call, so
// one bad schema fails the whole listing: the server is marked failed and
// EVERY mcp__tarsee__* tool disappears. Claude Code then sees none of Tarsee's
// tools while the system prompt still advertises twenty of them, so the model
// improvises — shelling out to curl to reach Telegram, hand-editing MEMORY.md
// instead of calling remember. It looks like a prompting problem and is not.
//
// Nothing caught it because the server *constructs* fine; only listTools
// throws, and that happens inside the Claude Code subprocess where the error
// surfaces as absent tools rather than a crash. So the test has to do what
// the SDK does: connect a real MCP client and list the tools.

/** Connect an in-memory MCP client to the Tarsee server (around this tool context) and return it. */
async function connect(ctx = {}) {
  const server = createTarseeMcp(ctx, { quiet: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tarsee-test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("tarsee MCP server", () => {
  it("lists its tools without throwing", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    assert.ok(Array.isArray(listed.tools));
    assert.ok(listed.tools.length > 0, "tools/list returned an empty tool list");
    await client.close();
  });

  it("exposes every declared tool, so none is silently dropped", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    // The provider advertises these by name in the system prompt; if one stops
    // being listed, the model is being told about a tool it cannot call.
    const required = [
      "tarsee_send_message",
      "tarsee_schedule_task",
      "tarsee_remember",
      "tarsee_read_file",
      "tarsee_write_file",
      "tarsee_search_memories",
    ];
    const names = new Set(listed.tools.map((t) => t.name));
    for (const name of required) {
      assert.ok(names.has(name), `${name} is missing from tools/list`);
    }
    await client.close();
  });

  it("produces a valid JSON Schema for schedule_task's nested action.args", async () => {
    // The exact shape that used to throw. `args` is a free-form object, so the
    // schema must describe an object — not undefined.
    const { client } = await connect();
    const listed = await client.listTools();
    const scheduleTask = listed.tools.find((t) => t.name === "tarsee_schedule_task");
    assert.ok(scheduleTask, "tarsee_schedule_task not listed");
    const args = scheduleTask.inputSchema?.properties?.action?.properties?.args;
    assert.ok(args, "action.args has no schema");
    assert.equal(args.type, "object");
    await client.close();
  });

  it("schedule_task says to schedule only when the owner asks, and that a task starts paused until the owner switches it on", async () => {
    // Every run of a scheduled task can be a paid turn on the AI, so the owner decides: lib/cron.js saves the AI's
    // tasks paused, and the description tells the model so before it calls the tool.
    const { client } = await connect();
    const listed = await client.listTools();
    const { description } = listed.tools.find((t) => t.name === "tarsee_schedule_task");
    assert.match(description, /Only schedule a task when the owner asks for one/);
    assert.match(description, /starts paused/);
    assert.match(description, /until the owner switches it on/);
    assert.match(description, /\/cron on <id>/);
    assert.match(description, /at most once every 15 minutes/);
    await client.close();
  });
});

// Every engine reads a tool's result as a success unless the result is marked isError (Claude Code turns it into the
// tool_result's is_error, Codex into a failed tool call), and the chat bots show a tick or a cross from that: Slack's
// card, Telegram's and Discord's status line (lib/tool-status.js words it). So a task that was not saved must come
// back marked, or the owner sees a tick and "Task saved, waiting for your OK" for nothing.
describe("tarsee_schedule_task says whether the task was saved", () => {
  const db = initDb(path.join(tmp, "tarsee.db"));
  const settings = new SettingsStore(db);
  cron.initCron({ db, settingsStore: settings });
  after(() => {
    cron.stopCronScheduler();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A chat turn's tool context, with whatever else this case needs. */
  const ctxWith = (extra = {}) => ({ db, settingsStore: settings, conversationId: null, ...extra });
  async function schedule(ctx, args) {
    const { client } = await connect(ctx);
    try {
      return await client.callTool({ name: "tarsee_schedule_task", arguments: args });
    } finally {
      await client.close();
    }
  }
  const textOf = (res) => res.content.map((c) => c.text).join("\n");
  /** What a chat bot shows when the tool ends: Slack and the others pass the engine's error mark along. */
  const shownFor = (res, args) => toolDoneLabel("mcp__tarsee__tarsee_schedule_task", args, res.isError === true);

  it("a saved task has no error mark, and the bots say it waits for the owner's OK", async () => {
    const args = { schedule: "0 8 * * 1", prompt: "Sum up the week", name: "Weekly summary" };
    const res = await schedule(ctxWith(), args);
    assert.match(textOf(res), /^Saved the task "Weekly summary"/);
    assert.notEqual(res.isError, true);
    assert.equal(shownFor(res, args), "Task saved, waiting for your OK");
    const job = cron.loadCronJobs().find((j) => j.name === "Weekly summary");
    assert.ok(job, "the task is saved");
    assert.equal(job.awaitingOwner, true);
    assert.equal(job.enabled, false);
  });

  it("so is a direct action (no AI)", async () => {
    const args = { schedule: "0 9 * * *", name: "Morning hello", action: { tool: "send_message", args: { channel: "web", message: "Good morning" } } };
    const res = await schedule(ctxWith(), args);
    assert.match(textOf(res), /^Saved the task "Morning hello"/);
    assert.notEqual(res.isError, true);
    assert.equal(shownFor(res, args), "Task saved, waiting for your OK");
  });

  const NOT_SAVED = [
    ["no prompt and no action", {}, { schedule: "0 8 * * 1", name: "Nothing to do" }, /Either 'prompt' or 'action' is required/],
    ["a schedule that isn't one", {}, { schedule: "every morning at 8", prompt: "Say hi", name: "Not a schedule" }, /schedule_task error: Invalid cron schedule/],
    ["a task that asks the AI more often than every 15 minutes", {}, { schedule: "*/5 * * * *", prompt: "Check the inbox", name: "Too often" }, /at most once every 15 minutes/],
    ["a seconds part on a task that asks the AI", {}, { schedule: "0 0 8 * * 1", prompt: "Sum up", name: "With seconds" }, /has a seconds part/],
    ["a direct action that would schedule more tasks", {}, { schedule: "0 8 * * 1", name: "Task maker", action: { tool: "schedule_task", args: { schedule: "* * * * *", prompt: "x" } } }, /can't schedule more tasks/],
    ["a scheduled task's own run asking for another", { background: "cron" }, { schedule: "0 8 * * 1", prompt: "Do it again", name: "From a run" }, /schedule_task refused: this run was started by a scheduled task/],
    ["the heartbeat asking for one", { background: "heartbeat" }, { schedule: "0 8 * * 1", prompt: "Check in", name: "From the heartbeat" }, /schedule_task refused/],
  ];
  for (const [what, extra, args, said] of NOT_SAVED) {
    it(`${what}: nothing is saved, the result is marked as an error, and the bots say the task was not saved`, async () => {
      const before = cron.loadCronJobs().length;
      const res = await schedule(ctxWith(extra), args);
      assert.match(textOf(res), said);
      assert.equal(res.isError, true, textOf(res));
      assert.equal(cron.loadCronJobs().length, before, "nothing was saved");
      assert.equal(shownFor(res, args), "Task not saved");
    });
  }

  it("the bots' words: the saved wording only for a saved task", () => {
    const name = "mcp__tarsee__tarsee_schedule_task";
    assert.equal(toolDoneLabel(name, {}, false), "Task saved, waiting for your OK");
    assert.equal(toolDoneLabel(name, {}), "Task saved, waiting for your OK");
    assert.equal(toolDoneLabel(name, {}, true), "Task not saved");
    assert.doesNotMatch(toolDoneLabel(name, {}, true), /waiting|OK/);
  });
});
