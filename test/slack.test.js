import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Isolate everything to a temp dir so we don't touch ~/.tarsee
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-slack-test-"));
process.env.TARSEE_STATE_DIR = TMP_DIR;
process.env.TARSEE_WORKSPACE_DIR = path.join(TMP_DIR, "workspace");
process.env.TARSEE_DATA_DIR = path.join(TMP_DIR, "data");
process.env.ENCRYPTION_KEY = "test-key-for-unit-tests-only-32chars!";

const { getChannelKey, decideSlackMessage, isSlackFileUrl, slackChatTitle, parseAllowlist } = await import("../src/channels/slack.js");
const { chatTargetOf } = await import("../src/lib/chat-target.js");

const BOT = "UBOT";
const TEAM = "T1";
const base = { botUserId: BOT, botTeamId: TEAM, allowlist: [], mentionMode: "required", engaged: false };
const dm = (over = {}) => ({ type: "message", channel: "D1", channel_type: "im", user: "U1", user_team: TEAM, text: "hi", ts: "100.1", ...over });
const inChannel = (over = {}) => ({ type: "message", channel: "C1", channel_type: "channel", user: "U1", user_team: TEAM, text: "hi", ts: "200.1", ...over });

describe("getChannelKey", () => {
  it("keys a top-level message by the thread its reply starts", () => {
    assert.equal(getChannelKey({ channel: "C1", ts: "200.1" }), "slack:C1:thread:200.1");
  });
  it("keys a thread reply by its thread", () => {
    assert.equal(getChannelKey({ channel: "C1", ts: "300.9", thread_ts: "200.1" }), "slack:C1:thread:200.1");
  });
});

describe("chatTargetOf for slack", () => {
  it("reads the channel and the thread out of a thread key", () => {
    assert.deepEqual(chatTargetOf("slack", "slack:C1:thread:1712.5"), { chatId: "C1", threadId: "1712.5" });
    assert.deepEqual(chatTargetOf("slack", "channel_conv.slack:C1:thread:1712.5"), { chatId: "C1", threadId: "1712.5" });
  });
  it("reads a plain channel key as the channel with no thread", () => {
    assert.deepEqual(chatTargetOf("slack", "slack:D9"), { chatId: "D9", threadId: null });
  });
});

describe("decideSlackMessage", () => {
  it("answers a DM", () => {
    assert.equal(decideSlackMessage(dm(), base).handle, true);
  });

  it("answers a file sent with no words, and a thread reply also sent to the channel", () => {
    assert.equal(decideSlackMessage(dm({ subtype: "file_share", text: "" }), base).handle, true);
    assert.equal(decideSlackMessage(inChannel({ subtype: "thread_broadcast", thread_ts: "200.1", ts: "201.1" }), { ...base, engaged: true }).handle, true);
  });

  it("ignores edits, deletions, joins and other housekeeping", () => {
    for (const subtype of ["message_changed", "message_deleted", "channel_join", "bot_message", "channel_topic"]) {
      assert.equal(decideSlackMessage(dm({ subtype }), base).handle, false, subtype);
    }
  });

  it("ignores other bots, itself, and messages with no person behind them", () => {
    assert.equal(decideSlackMessage(dm({ bot_id: "B1" }), base).handle, false);
    assert.equal(decideSlackMessage(dm({ user: BOT }), base).handle, false);
    assert.equal(decideSlackMessage(dm({ user: undefined }), base).handle, false);
  });

  it("in a channel, needs an @mention by default", () => {
    assert.equal(decideSlackMessage(inChannel(), base).handle, false);
    assert.equal(decideSlackMessage(inChannel({ text: "<@UBOT> hi" }), base).handle, true);
  });

  it("in a channel with mention mode off, answers without one", () => {
    assert.equal(decideSlackMessage(inChannel(), { ...base, mentionMode: "off" }).handle, true);
  });

  it("follows up in a thread it is already in without a mention, but stays out of other threads", () => {
    const reply = inChannel({ thread_ts: "200.1", ts: "250.1" });
    assert.equal(decideSlackMessage(reply, { ...base, engaged: true }).handle, true);
    assert.equal(decideSlackMessage(reply, base).handle, false);
    assert.equal(decideSlackMessage({ ...reply, text: "<@UBOT> join in" }, base).handle, true);
  });

  it("treats a group DM like a channel: a mention is needed", () => {
    const mpim = inChannel({ channel: "G1", channel_type: "mpim" });
    assert.equal(decideSlackMessage(mpim, base).handle, false);
    assert.equal(decideSlackMessage({ ...mpim, text: "<@UBOT> hi" }, base).handle, true);
  });

  it("with an allowlist, answers listed people anywhere and anyone in listed channels", () => {
    const allow = { ...base, allowlist: ["U7", "C1"] };
    assert.equal(decideSlackMessage(dm(), allow).handle, false, "a DM from someone not listed");
    assert.equal(decideSlackMessage(dm({ user: "U7" }), allow).handle, true);
    assert.equal(decideSlackMessage(inChannel({ text: "<@UBOT> hi" }), allow).handle, true, "listed channel");
    assert.equal(decideSlackMessage(inChannel({ channel: "C2", text: "<@UBOT> hi" }), allow).handle, false);
    assert.equal(decideSlackMessage(inChannel({ channel: "C2", user: "U7", text: "<@UBOT> hi" }), allow).handle, true, "listed person");
  });

  it("ignores people from another workspace (Slack Connect) unless they are listed by name", () => {
    const outsider = inChannel({ user: "U9", user_team: "T_OTHER", text: "<@UBOT> hi" });
    assert.equal(decideSlackMessage(outsider, base).handle, false);
    assert.equal(decideSlackMessage(outsider, { ...base, allowlist: ["C1"] }).handle, false, "a listed channel is not enough");
    assert.equal(decideSlackMessage(outsider, { ...base, allowlist: ["U9"] }).handle, true);
  });
});

describe("parseAllowlist", () => {
  it("reads the stored setting as a list of ids", () => {
    assert.deepEqual(parseAllowlist(null), []);
    assert.deepEqual(parseAllowlist(["U1", " C1 "]), ["U1", "C1"]);
    assert.deepEqual(parseAllowlist('["U1","C2"]'), ["U1", "C2"]);
    assert.deepEqual(parseAllowlist("not json"), []);
  });
});

describe("isSlackFileUrl", () => {
  it("only lets the bot token go to Slack's own file host over https", () => {
    assert.equal(isSlackFileUrl("https://files.slack.com/files-pri/T1-F1/download/a.png"), true);
    assert.equal(isSlackFileUrl("http://files.slack.com/files-pri/T1-F1/a.png"), false);
    assert.equal(isSlackFileUrl("https://files.slack.com.evil.io/a.png"), false);
    assert.equal(isSlackFileUrl("https://example.com/a.png"), false);
    assert.equal(isSlackFileUrl("not a url"), false);
  });
});

describe("the channel manager and Slack", () => {
  it("starts Slack only with both tokens, and lists it in the status", async () => {
    const { isChannelReady, ChannelManager } = await import("../src/channels/manager.js");
    const { initDb } = await import("../src/db/sqlite.js");
    const { SettingsStore } = await import("../src/db/settings.js");
    assert.equal(isChannelReady("slack", { enabled: true, token: "xoxb-1" }), false, "no app token");
    assert.equal(isChannelReady("slack", { enabled: true, token: "xoxb-1", appToken: "xapp-1" }), true);
    assert.equal(isChannelReady("slack", { enabled: false, token: "xoxb-1", appToken: "xapp-1" }), false);
    assert.equal(isChannelReady("discord", { enabled: true, token: "abc" }), true);

    const db = initDb(path.join(TMP_DIR, "manager.db"));
    const mgr = new ChannelManager(db);
    assert.equal(mgr.getStatus().slack.status, "not_configured");
    new SettingsStore(db).set("channel.slack", { enabled: true, token: "xoxb-1", appToken: "xapp-1" });
    assert.equal(mgr.getStatus().slack.status, "stopped");
    await assert.rejects(() => mgr.restart("slack-nope"), /not configured/);
    new SettingsStore(db).set("channel.slack", { enabled: true, token: "xoxb-1" });
    await assert.rejects(() => mgr.restart("slack"), /not configured/);
    db.close();
  });
});

describe("Slack in the shared commands and labels", () => {
  it("/mention sets Slack's mention mode, from Slack or by name", async () => {
    const { processCommand } = await import("../src/lib/commands.js");
    const { initDb } = await import("../src/db/sqlite.js");
    const { SettingsStore } = await import("../src/db/settings.js");
    const settingsStore = new SettingsStore(initDb(path.join(TMP_DIR, "commands.db")));
    let r = await processCommand("/mention off", { settingsStore, platform: "slack" });
    assert.match(r.response, /slack/);
    assert.equal(settingsStore.get("slack.mention_mode"), "off");
    r = await processCommand("/mention slack required", { settingsStore });
    assert.equal(settingsStore.get("slack.mention_mode"), "required");
    r = await processCommand("/mention", { settingsStore });
    assert.match(r.response, /slack/);
    r = await processCommand("/send slack", { settingsStore });
    assert.doesNotMatch(r.response, /Unknown channel/);
  });

  it("labels Slack turns on the Usage page and the live timeline", async () => {
    const { channelOf } = await import("../src/lib/token-usage.js");
    assert.equal(channelOf("slack", "abc"), "Slack");
    const live = fs.readFileSync(new URL("../src/public/js/live.js", import.meta.url), "utf8");
    assert.match(live, /slack: "Slack"/);
  });

  it("shows a file the Slack bot saved by its own name", async () => {
    const { shownName } = await import("../src/lib/sent-files.js");
    const core = await import("../src/public/js/file-viewer-core.js");
    assert.equal(shownName("/data/uploads/slack-1712345678901-Q3_report.pdf"), "Q3_report.pdf");
    assert.equal(core.shownName("/data/uploads/slack-1712345678901-Q3_report.pdf"), "Q3_report.pdf");
  });
});

describe("slackChatTitle", () => {
  it("names a chat the way the sidebar shows it", () => {
    assert.equal(slackChatTitle({ kind: "im", userName: "alice", snippet: "what's on today" }), "DM with alice > what's on today");
    assert.equal(slackChatTitle({ kind: "channel", channelName: "ops", snippet: "deploy status" }), "#ops > deploy status");
    assert.equal(slackChatTitle({ kind: "mpim", snippet: "plan" }), "Group DM > plan");
    assert.equal(slackChatTitle({ kind: "channel", channelName: "ops", snippet: "" }), "#ops");
  });
  it("cuts a long first message to a short name", () => {
    const t = slackChatTitle({ kind: "channel", channelName: "ops", snippet: "x".repeat(200) });
    assert.ok(t.length <= 70, t);
    assert.ok(t.endsWith("…"));
  });
});
