// A first save of one of Tarsee's own keys (src/lib/key-vault.js SERVER_ONLY_KEYS: RAILWAY_API_TOKEN) comes only from
// set_key in a chat's own turn, or from the owner in Settings > Keys. The vault itself holds every writer to that, so
// no caller can skip it: background work (a scheduled task, its direct action, the heartbeat, BOOT.md), a turn with no
// chat (a subagent, an ACP session), another tool's save_as_key, and a caller that names no writer all save none.
// The reviewer's case: discord_admin create_webhook with save_as_key "RAILWAY_API_TOKEN", from a scheduled task or a
// background turn, saved the webhook's URL as Tarsee's Railway token while Tarsee had none (only set_key checked
// ctx.background). Now discord_admin refuses that name before it makes the webhook, the vault refuses it anyway, and a
// scheduled task naming it isn't saved (test/scheduled-direct-actions.test.js).
// Uses the real vault in a temporary data folder, encrypted, with obvious fake keys; Discord is never reached.
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-server-only-first-save-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "2".repeat(40);
for (const name of ["RAILWAY_API_TOKEN", "TARSEE_AGENT_ENV_KEYS"]) delete process.env[name];

const vault = await import("../src/lib/key-vault.js");
const { executeTool } = await import("../src/lib/tools.js");
const { createTarseeMcp } = await import("../src/ai/tarsee-mcp.js");
const { toolDoneLabel } = await import("../src/lib/tool-status.js");
const { discordAdmin, keyNameFrom } = await import("../src/lib/discord-admin.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const TOKEN = "rw-test-canary-0000-1111-2222-333344445555";
const OTHER = "rw-test-canary-9999-8888-7777-666655554444";
const HOOK_TOKEN = "wh-test-canary-token-" + "0".repeat(40);
const HOOK_URL = `https://discord.com/api/webhooks/600000000000000001/${HOOK_TOKEN}`;
const VAULT_FILE = path.join(tmp, "data", "vault.json");

const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};
/** A chat's own turn, as a channel or the dashboard gives its tools: a conversation, and no background mark. */
const CHAT = Object.freeze({ conversationId: "test-chat-0001" });
const names = () => vault.listKeys().map((k) => k.name).sort();
const ownerSaves = (value) => vault.setKey("RAILWAY_API_TOKEN", value, "", { owner: true });

/** Every writer that isn't set_key in a chat's own turn or the owner, as setKey's options name it. */
const NOT_ALLOWED = [
  ["a caller that names no writer", undefined],
  ["a writer with no tool named", { writer: {} }],
  ["discord_admin's save_as_key", { writer: { tool: "discord_admin" } }],
  ["discord_admin's save_as_key, even in a chat's own turn", { writer: { tool: "discord_admin", ctx: CHAT } }],
  ["set_key in a scheduled task or its direct action", { writer: { tool: "set_key", ctx: { background: "cron" } } }],
  ["set_key in background work that names a chat", { writer: { tool: "set_key", ctx: { background: "cron", conversationId: "test-chat-0001" } } }],
  ["set_key in the heartbeat", { writer: { tool: "set_key", ctx: { background: "heartbeat" } } }],
  ["set_key in BOOT.md's run", { writer: { tool: "set_key", ctx: { background: "boot" } } }],
  ["set_key in a turn with no chat (a subagent, an ACP session)", { writer: { tool: "set_key", ctx: { conversationId: null } } }],
  ["set_key with no tool context", { writer: { tool: "set_key" } }],
];

beforeEach(() => {
  try { fs.rmSync(VAULT_FILE, { force: true }); } catch { /* none yet */ }
  delete process.env.RAILWAY_API_TOKEN;
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the vault's own rule for a first save of Tarsee's own key", () => {
  it("with no token yet, every other writer is refused, in any case of the name", () => {
    for (const [what, opts] of NOT_ALLOWED) {
      for (const name of ["RAILWAY_API_TOKEN", "railway_api_token"]) {
        assert.throws(() => vault.setKey(name, HOOK_URL, "Discord webhook", opts), /wasn't saved/, `${what}: ${name}`);
      }
      const why = vault.serverOnlyWriteRefusal("RAILWAY_API_TOKEN", opts);
      assert.match(why || "", /^RAILWAY_API_TOKEN wasn't saved/, what);
      assert.match(why, /Settings > Keys/, what);
      assert.ok(!why.includes(HOOK_TOKEN), what);
    }
    assert.deepEqual(names(), [], "nothing was saved");
  });

  it("each refusal says who may: background work, another tool and a turn with no chat in their own words", () => {
    assert.match(vault.serverOnlyWriteRefusal("RAILWAY_API_TOKEN", { writer: { tool: "set_key", ctx: { background: "heartbeat" } } }), /background work \(a scheduled task or its direct action, a webhook, the heartbeat, BOOT\.md\) never saves/);
    assert.match(vault.serverOnlyWriteRefusal("RAILWAY_API_TOKEN", { writer: { tool: "discord_admin" } }), /discord_admin never saves Tarsee's own keys, not even a first one/);
    assert.match(vault.serverOnlyWriteRefusal("RAILWAY_API_TOKEN", { writer: { tool: "set_key", ctx: { conversationId: null } } }), /this turn isn't a chat's own/);
  });

  it("set_key in a chat's own turn saves the first one; the owner always may", async () => {
    await quiet(() => vault.setKey("RAILWAY_API_TOKEN", TOKEN, "", { writer: { tool: "set_key", ctx: CHAT } }));
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);
    // After that, only the owner replaces it, even from a chat.
    assert.throws(() => vault.setKey("RAILWAY_API_TOKEN", OTHER, "", { writer: { tool: "set_key", ctx: CHAT } }), /change it in Settings > Keys/);
    await quiet(() => ownerSaves(OTHER));
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), OTHER);
  });

  it("a chat's own turn: a conversation, and no background mark", () => {
    assert.equal(vault.chatTurn(CHAT), true);
    assert.equal(vault.chatTurn({ conversationId: "c-1", dashboard: true, messageId: 4 }), true);
    for (const ctx of [undefined, null, "test-chat-0001", {}, { conversationId: null }, { conversationId: "" }, { conversationId: "   " }, { conversationId: 5 },
      { conversationId: "c-1", background: "cron" }, { conversationId: "c-1", background: true }, { conversationId: "c-1", background: "heartbeat" }]) {
      assert.equal(vault.chatTurn(ctx), false, JSON.stringify(ctx));
    }
  });

  it("every other key saves as before, whoever writes it", async () => {
    for (const [, opts] of NOT_ALLOWED) await quiet(() => vault.setKey("ALERTS_WEBHOOK", HOOK_URL, "", opts));
    assert.equal(vault.getKey("ALERTS_WEBHOOK"), HOOK_URL);
  });

  it("every vault write in Tarsee names who writes it: the owner, or a tool with its turn's context", () => {
    const root = new URL("../src/", import.meta.url);
    const files = fs.readdirSync(root, { recursive: true }).filter((f) => f.endsWith(".js") && !f.startsWith("public"));
    const calls = [];
    for (const f of files) {
      if (path.basename(f) === "key-vault.js") continue;
      const src = fs.readFileSync(new URL(f.split(path.sep).join("/"), root), "utf8");
      for (const m of src.matchAll(/\bsetKey\(([^\n]*)\);/g)) calls.push(`${f}: ${m[1]}`);
    }
    assert.ok(calls.length >= 3, calls.join("\n"));
    for (const call of calls) assert.match(call, /\{ owner: true \}|\{ writer(?:: [A-Z_]+)? \}/, call);
  });

  it("the token set where Tarsee runs (a Railway variable) still can't be shadowed from a chat", () => {
    process.env.RAILWAY_API_TOKEN = TOKEN;
    assert.throws(() => vault.setKey("RAILWAY_API_TOKEN", OTHER, "", { writer: { tool: "set_key", ctx: CHAT } }), /already has one in its environment/);
    assert.deepEqual(names(), []);
  });
});

describe("set_key passes its turn's context to the vault", () => {
  it("from background work or a turn with no chat, even a first save is refused, and says so", async () => {
    for (const ctx of [{ background: "cron" }, { background: "heartbeat" }, { background: "boot" }, { conversationId: null }, {}]) {
      const out = await quiet(() => executeTool("set_key", { name: "RAILWAY_API_TOKEN", value: OTHER }, ctx));
      assert.ok(out.startsWith("set_key refused: RAILWAY_API_TOKEN wasn't saved"), `${JSON.stringify(ctx)}: ${out}`);
      assert.match(out, /Settings > Keys/, out);
      assert.ok(!out.includes(OTHER), out);
    }
    assert.deepEqual(names(), []);
    assert.match(await quiet(() => executeTool("set_key", { name: "RAILWAY_API_TOKEN", value: TOKEN }, CHAT)), /^Key "RAILWAY_API_TOKEN" saved securely/);
  });

  it("through tarsee_set_key in a heartbeat's turn: marked as an error, and nothing saved", async () => {
    const server = createTarseeMcp({ background: "heartbeat" }, { quiet: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tarsee-test", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.instance.connect(serverSide), client.connect(clientSide)]);
    try {
      const res = await quiet(() => client.callTool({ name: "tarsee_set_key", arguments: { key: "RAILWAY_API_TOKEN", value: OTHER } }));
      assert.equal(res.isError, true, JSON.stringify(res));
      assert.match(res.content.map((c) => c.text).join("\n"), /background work/);
      assert.equal(toolDoneLabel("mcp__tarsee__tarsee_set_key", {}, res.isError), "Saving the key failed");
    } finally {
      await client.close();
    }
    assert.deepEqual(names(), []);
  });
});

// A stand-in Discord: one server channel the bot sees, whose createWebhook is recorded and never reached for real.
const CH = "500000000000000001";
function fakeDiscord() {
  const made = [];
  const channel = {
    id: CH, name: "alerts", guild: { id: "200000000000000001", name: "Test Server" },
    isThread: () => false,
    fetchWebhooks: async () => new Map(),
    createWebhook: async (opts) => { made.push(opts); return { id: "600000000000000001", token: HOOK_TOKEN }; },
  };
  const client = { user: { id: "300000000000000001" }, isReady: () => true, channels: { cache: new Map([[CH, channel]]), fetch: async () => null } };
  return { client, made };
}
const createWebhook = (client, save_as_key, extra = {}) => quiet(() => discordAdmin(
  { action: "create_webhook", channel_id: CH, name: "Alerts", save_as_key, approved_by: "the owner in #general: a webhook for alerts", ...extra },
  { client, log: () => {} },
));

describe("discord_admin's save_as_key never names Tarsee's own key, with the real vault", () => {
  it("the reviewer's case: with no token yet, refused before the webhook is made, in any spelling", async () => {
    const { client, made } = fakeDiscord();
    for (const save_as_key of ["RAILWAY_API_TOKEN", "railway api token", "Railway-Api-Token", " railway_api_token "]) {
      assert.equal(keyNameFrom(save_as_key), "RAILWAY_API_TOKEN", "the name the tool would save under");
      const out = await createWebhook(client, save_as_key);
      assert.match(out, /^discord_admin create_webhook error: save_as_key names RAILWAY_API_TOKEN\. /, out);
      assert.match(out, /Pick another save_as_key\. No webhook was made\.$/, out);
      assert.ok(!out.includes(HOOK_TOKEN), out);
    }
    assert.deepEqual(made, [], "no webhook was made");
    assert.deepEqual(names(), [], "nothing was saved");
  });

  it("with the token saved, overwrite_key doesn't replace it either", async () => {
    await quiet(() => ownerSaves(TOKEN));
    const { client, made } = fakeDiscord();
    const out = await createWebhook(client, "RAILWAY_API_TOKEN", { overwrite_key: true });
    assert.match(out, /save_as_key names RAILWAY_API_TOKEN\. .*No webhook was made\./s, out);
    assert.deepEqual(made, []);
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);
  });

  it("any other name still makes the webhook and saves its URL", async () => {
    const { client, made } = fakeDiscord();
    const out = await createWebhook(client, "ALERTS_WEBHOOK");
    assert.match(out, /URL saved in the vault as ALERTS_WEBHOOK/, out);
    assert.equal(made.length, 1);
    assert.equal(vault.getKey("ALERTS_WEBHOOK"), HOOK_URL);
  });

  it("the vault's loose match is the name discord_admin would save under", () => {
    for (const raw of ["RAILWAY_API_TOKEN", "railway api token", "Railway-Api-Token", "  railway__api--token  ", "railway.api.token", "RAILWAY_API_TOKENS", "RAILWAY_API", "x RAILWAY_API_TOKEN", "", 42, null]) {
      const own = keyNameFrom(raw) === "RAILWAY_API_TOKEN" ? "RAILWAY_API_TOKEN" : null;
      assert.equal(vault.serverOnlyNameLoose(raw), own, JSON.stringify(raw));
    }
  });
});
