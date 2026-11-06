// Saving the Slack channel from Settings → Channels (POST /api/settings/channel, type "slack") and the app manifest
// the page copies (GET /api/settings/channel/slack/manifest). A fake channel manager stands in for the bot.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-slack-settings-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-key-for-unit-tests-only-32chars!";

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { settingsRouter } = await import("../src/routes/settings.js");

const db = initDb(path.join(tmp, "tarsee.db"));
const settings = new SettingsStore(db);
const calls = [];
const channelManager = {
  restart: async (type) => { calls.push(["restart", type]); },
  stop: async (type) => { calls.push(["stop", type]); },
};
let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.set("db", db);
  app.set("channelManager", channelManager);
  app.use("/api/settings", settingsRouter);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const save = (body) => fetch(`${base}/api/settings/channel`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "slack", ...body }),
});

describe("saving the Slack channel", () => {
  it("says which token is which when they are swapped or mistyped", async () => {
    let res = await save({ enabled: true, token: "xapp-1-A", appToken: "xoxb-1" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /xoxb-/);
    res = await save({ enabled: true, token: "xoxb-1", appToken: "nope" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /xapp-/);
    assert.equal(settings.get("channel.slack"), null, "nothing saved");
  });

  it("needs both tokens to turn it on", async () => {
    const res = await save({ enabled: true, token: "xoxb-1" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /app-level token/i);
  });

  it("saves both tokens and starts the bot", async () => {
    calls.length = 0;
    const res = await save({ enabled: true, token: "xoxb-1", appToken: "xapp-1" });
    assert.equal(res.status, 200);
    const stored = settings.get("channel.slack");
    assert.equal(stored.token, "xoxb-1");
    assert.equal(stored.appToken, "xapp-1");
    assert.deepEqual(calls, [["restart", "slack"]]);
  });

  it("keeps the stored tokens when saved without them, and restarts when turned back on", async () => {
    calls.length = 0;
    assert.equal((await save({ enabled: false })).status, 200);
    assert.deepEqual(calls, [["stop", "slack"]]);
    assert.equal(settings.get("channel.slack").token, "xoxb-1");
    calls.length = 0;
    assert.equal((await save({ enabled: true })).status, 200);
    assert.deepEqual(calls, [["restart", "slack"]], "turning it on again starts it with the stored tokens");
    calls.length = 0;
    assert.equal((await save({ enabled: true, appToken: "xapp-2" })).status, 200);
    assert.equal(settings.get("channel.slack").appToken, "xapp-2");
    assert.equal(settings.get("channel.slack").token, "xoxb-1");
    assert.deepEqual(calls, [["restart", "slack"]], "a new app token alone restarts it");
  });

  it("never hands the tokens back to the page", async () => {
    const all = await (await fetch(`${base}/api/settings`)).json();
    const slack = all.settings.find((s) => s.key === "channel.slack").value;
    assert.equal(slack.token, undefined);
    assert.equal(slack.appToken, undefined);
    assert.equal(slack.hasToken, true);
    assert.equal(slack.hasAppToken, true);
  });
});

describe("the Slack app manifest", () => {
  it("is served for the Copy manifest button, set up for Socket Mode with what the bot uses", async () => {
    const res = await fetch(`${base}/api/settings/channel/slack/manifest`);
    assert.equal(res.status, 200);
    const yml = await res.text();
    assert.match(yml, /socket_mode_enabled: true/);
    assert.match(yml, /token_rotation_enabled: false/);
    for (const scope of ["chat:write", "files:read", "files:write", "reactions:write", "users:read", "im:history", "channels:history", "commands", "im:write"]) {
      assert.match(yml, new RegExp(`- ${scope}\\b`), scope);
    }
    for (const ev of ["message.im", "message.channels", "message.groups", "message.mpim", "agent_session_stopped"]) {
      assert.match(yml, new RegExp(`- ${ev.replace(".", "\\.")}\\b`), ev);
    }
    assert.match(yml, /command: \/tarsee/);
    assert.ok(!/chat:write\.public/.test(yml), "no posting in channels it is not in: it could not read the replies there");
  });
});
