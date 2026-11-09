// tarsee_push_notification under Tool Permissions. The MCP tool used to call lib/push.js itself, so it skipped
// executeTool and with it the policy gate and the audit log: setting push_notification to always_deny in
// Settings > Tool Permissions changed a stored value and the agent kept pinging every device. These tests drive
// the real MCP tool through an in-memory MCP client, the way Claude Code calls it. Nothing leaves the process:
// web-push's sender is replaced with a counter.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-push-policy-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { default: webpush } = await import("web-push");
const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { initPush, saveSubscription } = await import("../src/lib/push.js");
const { getSecurityManager } = await import("../src/lib/security-manager.js");
const { executeTool } = await import("../src/lib/tools.js");
const { createTarseeMcp } = await import("../src/ai/tarsee-mcp.js");

const db = initDb(path.join(tmp, "tarsee.db"));
const settings = new SettingsStore(db);
const ctx = { db, settingsStore: settings };

/** Every notification web-push was asked to deliver. */
const delivered = [];
const realSend = webpush.sendNotification;

before(() => {
  initPush(db);
  webpush.sendNotification = async (sub, body) => { delivered.push({ endpoint: sub.endpoint, body: JSON.parse(body) }); return { statusCode: 201 }; };
  saveSubscription({ endpoint: "https://push.example.invalid/device-1", keys: { p256dh: "test-p256dh", auth: "test-auth" } }, "test phone");
});

after(() => {
  webpush.sendNotification = realSend;
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  delivered.length = 0;
  getSecurityManager(settings).setToolPermission("push_notification", "always_allow");
});

/** Call the MCP tool tarsee_push_notification and return its text. */
async function callPushTool(args) {
  const server = createTarseeMcp(ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tarsee-test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.instance.connect(serverSide), client.connect(clientSide)]);
  try {
    const res = await client.callTool({ name: "tarsee_push_notification", arguments: args });
    return res.content.map((c) => c.text).join("\n");
  } finally {
    await client.close();
  }
}

/** The tool.denied audit rows for push_notification. */
const deniedRows = () => db.prepare("SELECT * FROM audit_log WHERE action = 'tool.denied' AND target = 'push_notification'").all();

describe("tarsee_push_notification obeys Tool Permissions", () => {
  it("is refused when the owner set push_notification to always_deny, and nothing is sent", async () => {
    getSecurityManager(settings).setToolPermission("push_notification", "always_deny");
    const out = await callPushTool({ title: "Backup done", body: "All files copied." });
    assert.match(out, /Refused by security policy/);
    assert.match(out, /Settings > Tool Permissions/);
    assert.equal(delivered.length, 0, "a denied push still reached a device");
  });

  it("writes a tool.denied audit row for the refused push", async () => {
    const before = deniedRows().length;
    getSecurityManager(settings).setToolPermission("push_notification", "always_deny");
    await callPushTool({ title: "Backup done", body: "All files copied." });
    const rows = deniedRows();
    assert.equal(rows.length, before + 1, "no audit row for the denied push");
    assert.match(rows.at(-1).detail, /denied by policy/i);
  });

  it("still sends when allowed, through the MCP tool and executeTool alike", async () => {
    const out = await callPushTool({ title: "Backup done", body: "All files copied.", url: "/?conv=abc", tag: "backup" });
    assert.match(out, /^Push sent to 1\/1 devices/);
    assert.equal(delivered.length, 1);
    assert.deepEqual(
      { title: delivered[0].body.title, body: delivered[0].body.body, url: delivered[0].body.url, tag: delivered[0].body.tag },
      { title: "Backup done", body: "All files copied.", url: "/?conv=abc", tag: "backup" },
    );
    const direct = await executeTool("push_notification", { title: "Ping", body: "Direct" }, ctx);
    assert.match(direct, /^Push sent to 1\/1 devices/);
    assert.equal(delivered.length, 2);
  });

  it("says so when no device has subscribed", async () => {
    const subs = settings.get("push.subscriptions");
    settings.set("push.subscriptions", []);
    try {
      const out = await executeTool("push_notification", { title: "Ping", body: "Nobody" }, ctx);
      assert.match(out, /No devices have subscribed/);
      assert.equal(delivered.length, 0);
    } finally {
      settings.set("push.subscriptions", subs);
    }
  });
});
