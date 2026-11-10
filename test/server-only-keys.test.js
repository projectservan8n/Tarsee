// Vault keys Tarsee itself uses (SERVER_ONLY_KEYS in src/lib/key-vault.js): RAILWAY_API_TOKEN, the token
// tarsee_railway reaches Railway with. With it in hand, one call to Railway's API from the AI's shell would skip every
// limit that tool keeps, so, whether the AI's commands run as the server's user (today) or as a user of their own:
//   - the agent's environment never carries it (src/ai/agent-env.js), under its name in any case, named in
//     TARSEE_AGENT_ENV_KEYS, or copied under another name;
//   - tarsee_get_key refuses it ("RAILWAY_API_TOKEN is Tarsee's own; use tarsee_railway"), and a copy of it;
//   - tarsee_list_keys still names it, without even its masked ends;
//   - from a chat's own turn, tarsee_set_key saves one while Tarsee has none yet (the way owners save it today), and
//     replacing or deleting one already there is refused ("change it in Settings > Keys"); only the owner's Settings >
//     Keys ({ owner: true }) may. Every other writer (background work, another tool's save_as_key, a caller that names
//     none) saves none at all: test/server-only-first-save.test.js.
// Uses the real vault in a temporary data folder, encrypted, with obvious fake keys.
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-server-only-keys-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "0".repeat(40);
for (const name of ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN", "TARSEE_AGENT_ENV_KEYS", "TEST_SCRIPT_KEY"]) delete process.env[name];

const vault = await import("../src/lib/key-vault.js");
const { agentVaultEnv, __resetAgentEnv } = await import("../src/ai/agent-env.js");
const { executeTool } = await import("../src/lib/tools.js");
const { TOKEN_KEY, railwayAdmin } = await import("../src/lib/railway-admin.js");
const engineEnv = await import("../src/ai/engine-env.js");
const { createTarseeMcp } = await import("../src/ai/tarsee-mcp.js");
const { toolDoneLabel } = await import("../src/lib/tool-status.js");
const { getSecurityManager } = await import("../src/lib/security-manager.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const TOKEN = "rw-test-canary-0000-1111-2222-333344445555";
const OTHER_TOKEN = "rw-test-canary-9999-8888-7777-666655554444";
const SCRIPT_KEY = "sk-test-canary-script-0000000000";
const VAULT_FILE = path.join(tmp, "data", "vault.json");

const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};
/** A chat's own turn, as a channel or the dashboard gives its tools: a conversation, no background mark. */
const CHAT = Object.freeze({ conversationId: "test-chat-0001" });
const tool = (name, input, ctx = CHAT) => quiet(() => executeTool(name, input, ctx));
/** The owner saving the token in Settings > Keys (routes/vault-keys.js). */
const ownerSaves = (value, description = "") => vault.setKey("RAILWAY_API_TOKEN", value, description, { owner: true });
const names = () => vault.listKeys().map((k) => k.name).sort();
const emptyVault = () => { try { fs.rmSync(VAULT_FILE, { force: true }); } catch { /* none yet */ } };

beforeEach(() => {
  emptyVault();
  __resetAgentEnv();
  delete process.env.RAILWAY_API_TOKEN;
});
after(() => {
  delete process.env.RAILWAY_API_TOKEN;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("SERVER_ONLY_KEYS", () => {
  it("is RAILWAY_API_TOKEN, the vault key tarsee_railway reads its token from", () => {
    assert.deepEqual([...vault.SERVER_ONLY_KEYS], ["RAILWAY_API_TOKEN"]);
    assert.ok(vault.SERVER_ONLY_KEYS.includes(TOKEN_KEY), "railway-admin.js's TOKEN_KEY is one of them");
    assert.ok(Object.isFrozen(vault.SERVER_ONLY_KEYS));
  });

  it("matches its names in any case, spaces trimmed, and nothing else", () => {
    for (const n of ["RAILWAY_API_TOKEN", " railway_api_token ", "Railway_Api_Token"]) assert.equal(vault.serverOnlyName(n), "RAILWAY_API_TOKEN", n);
    for (const n of ["RAILWAY_TOKEN", "RAILWAY_API_TOKEN_2", "OPENAI_API_KEY", "", null, undefined, 42]) assert.equal(vault.serverOnlyName(n), null, String(n));
  });
});

describe("the agent's environment never carries the Railway token", () => {
  it("not from the vault, whatever else goes in", async () => {
    await quiet(() => { ownerSaves(TOKEN); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
    const env = agentVaultEnv({ env: {} });
    assert.equal(env.TEST_SCRIPT_KEY, SCRIPT_KEY, "an ordinary key still reaches scripts");
    assert.ok(!("RAILWAY_API_TOKEN" in env), JSON.stringify(Object.keys(env)));
    assert.ok(!Object.values(env).includes(TOKEN));
  });

  it("not when TARSEE_AGENT_ENV_KEYS names it", async () => {
    await quiet(() => { ownerSaves(TOKEN); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
    const env = agentVaultEnv({ env: { TARSEE_AGENT_ENV_KEYS: "RAILWAY_API_TOKEN, TEST_SCRIPT_KEY" } });
    assert.deepEqual(env, { TEST_SCRIPT_KEY: SCRIPT_KEY });
  });

  it("not as a copy saved under another name, of the vault's token or of the one in Tarsee's environment", async () => {
    await quiet(() => { ownerSaves(TOKEN); vault.setKey("RAILWAY_TOKEN", ` ${TOKEN} `); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
    assert.deepEqual(agentVaultEnv({ env: {} }), { TEST_SCRIPT_KEY: SCRIPT_KEY });

    emptyVault();
    process.env.RAILWAY_API_TOKEN = OTHER_TOKEN;   // the owner set it as a Railway variable instead
    await quiet(() => { vault.setKey("DEPLOY_TOKEN", OTHER_TOKEN); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
    // engine-env passes its stripped copy of the environment; the server's own still counts.
    assert.deepEqual(agentVaultEnv({ env: {} }), { TEST_SCRIPT_KEY: SCRIPT_KEY });
  });

  it("not on the default call, cached or not", async () => {
    await quiet(() => { ownerSaves(TOKEN); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
    const first = await quiet(() => agentVaultEnv());
    const cached = await quiet(() => agentVaultEnv());
    for (const env of [first, cached]) {
      assert.equal(env.TEST_SCRIPT_KEY, SCRIPT_KEY);
      assert.ok(!("RAILWAY_API_TOKEN" in env));
    }
  });

  it("with fake vault functions too (as engine tests pass them)", () => {
    const fake = { RAILWAY_API_TOKEN: TOKEN, SHOUTY_COPY: TOKEN, GITHUB_TOKEN: "ghp_test_canary" };
    const env = agentVaultEnv({ get: (n) => fake[n] ?? null, list: () => Object.keys(fake), env: {} });
    assert.deepEqual(env, { GITHUB_TOKEN: "ghp_test_canary" });
  });
});

describe("tarsee_get_key and tarsee_list_keys", () => {
  it("get_key refuses the token, by any spelling of its name, and points at tarsee_railway", async () => {
    await quiet(() => ownerSaves(TOKEN));
    for (const name of ["RAILWAY_API_TOKEN", " railway_api_token "]) {
      const out = await tool("get_key", { name });
      assert.ok(out.startsWith("get_key refused: RAILWAY_API_TOKEN is Tarsee's own; use tarsee_railway"), out);
      assert.ok(!out.includes(TOKEN), out);
    }
  });

  it("get_key refuses a copy of the token saved under another name; an ordinary key still comes back", async () => {
    await quiet(() => { ownerSaves(TOKEN); vault.setKey("MY_RAILWAY", TOKEN); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
    const copy = await tool("get_key", { name: "MY_RAILWAY" });
    assert.match(copy, /RAILWAY_API_TOKEN/, copy);
    assert.match(copy, /tarsee_railway/, copy);
    assert.ok(!copy.includes(TOKEN), copy);
    assert.equal(await tool("get_key", { name: "TEST_SCRIPT_KEY" }), SCRIPT_KEY);
  });

  it("get_key refuses a copy of the token in Tarsee's environment, and the name when only the environment has it", async () => {
    process.env.RAILWAY_API_TOKEN = TOKEN;
    await quiet(() => vault.setKey("MY_RAILWAY", TOKEN));
    for (const name of ["MY_RAILWAY", "RAILWAY_API_TOKEN"]) {
      const out = await tool("get_key", { name });
      assert.match(out, /tarsee_railway/, out);
      assert.ok(!out.includes(TOKEN), out);
    }
  });

  it("list_keys still names it, and shows no part of it", async () => {
    await quiet(() => { ownerSaves(TOKEN, "Railway account token"); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
    const out = await tool("list_keys", {});
    assert.match(out, /^RAILWAY_API_TOKEN: Railway account token/m, out);
    assert.match(out, /^TEST_SCRIPT_KEY: /m, out);
    assert.ok(!out.includes(TOKEN.slice(0, 4) + "...") && !out.includes(TOKEN.slice(-4)), out);
    assert.match(out, /tarsee_railway/, out);
  });
});

describe("tarsee_set_key and tarsee_delete_key from chat", () => {
  it("the first save still works, under the name Tarsee reads, and says where to change it later", async () => {
    const out = await tool("set_key", { name: " railway_api_token ", value: TOKEN, description: "Railway" });
    assert.match(out, /saved/i, out);
    assert.match(out, /Settings > Keys/, out);
    assert.ok(!out.includes(TOKEN), out);
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);
    assert.deepEqual(names(), ["RAILWAY_API_TOKEN"]);
    assert.ok(!fs.readFileSync(VAULT_FILE, "utf8").includes(TOKEN), "encrypted at rest");
  });

  it("replacing one already saved is refused, by any spelling, and nothing changes", async () => {
    await tool("set_key", { name: "RAILWAY_API_TOKEN", value: TOKEN });
    const before = fs.readFileSync(VAULT_FILE, "utf8");
    for (const name of ["RAILWAY_API_TOKEN", "railway_api_token", " RAILWAY_API_TOKEN"]) {
      const out = await tool("set_key", { name, value: OTHER_TOKEN });
      assert.match(out, /change it in Settings > Keys/, out);
      assert.ok(!out.includes(TOKEN) && !out.includes(OTHER_TOKEN), out);
    }
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);
    assert.equal(fs.readFileSync(VAULT_FILE, "utf8"), before, "the vault file is untouched");
    assert.deepEqual(names(), ["RAILWAY_API_TOKEN"]);
  });

  it("deleting it is refused, and it stays", async () => {
    await tool("set_key", { name: "RAILWAY_API_TOKEN", value: TOKEN });
    for (const name of ["RAILWAY_API_TOKEN", "railway_api_token"]) {
      const out = await tool("delete_key", { name });
      assert.match(out, /change it in Settings > Keys/, out);
    }
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);
  });

  it("with the token set in Tarsee's environment instead, a vault copy that would take its place is refused", async () => {
    process.env.RAILWAY_API_TOKEN = TOKEN;
    const out = await tool("set_key", { name: "RAILWAY_API_TOKEN", value: OTHER_TOKEN });
    assert.match(out, /change it in Settings > Keys/, out);
    assert.deepEqual(names(), []);
  });

  it("every other key saves, replaces and deletes from chat as before", async () => {
    await tool("set_key", { name: "RAILWAY_API_TOKEN", value: TOKEN });
    assert.match(await tool("set_key", { name: "TEST_SCRIPT_KEY", value: "first-value-0000" }), /saved securely/);
    assert.match(await tool("set_key", { name: "TEST_SCRIPT_KEY", value: SCRIPT_KEY }), /saved securely/);
    assert.equal(vault.getKey("TEST_SCRIPT_KEY"), SCRIPT_KEY);
    assert.match(await tool("delete_key", { name: "TEST_SCRIPT_KEY" }), /deleted/);
    assert.equal(vault.getKey("TEST_SCRIPT_KEY"), null);
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);
  });
});

describe("the vault itself holds every writer but the owner to that", () => {
  it("setKey and deleteKey refuse to replace or delete a saved server-only key, unless { owner: true }", async () => {
    await quiet(() => ownerSaves(TOKEN));
    assert.throws(() => vault.setKey("RAILWAY_API_TOKEN", OTHER_TOKEN, "a tool that saves to the vault"), /Settings > Keys/);
    assert.throws(() => vault.deleteKey("RAILWAY_API_TOKEN"), /Settings > Keys/);
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);

    await quiet(() => vault.setKey("RAILWAY_API_TOKEN", OTHER_TOKEN, "", { owner: true }));
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), OTHER_TOKEN);
    assert.equal(await quiet(() => vault.deleteKey("RAILWAY_API_TOKEN", { owner: true })), true);
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), null);
  });

  it("a first save needs the owner or set_key in a chat's own turn; other keys are as before", async () => {
    assert.throws(() => vault.setKey("RAILWAY_API_TOKEN", TOKEN), /wasn't saved/, "a caller that names no writer");
    assert.deepEqual(names(), []);
    await quiet(() => vault.setKey("RAILWAY_API_TOKEN", TOKEN, "", { writer: { tool: "set_key", ctx: CHAT } }));
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);
    await quiet(() => { vault.setKey("TEST_SCRIPT_KEY", "a"); vault.setKey("TEST_SCRIPT_KEY", "b"); });
    assert.equal(vault.getKey("TEST_SCRIPT_KEY"), "b");
    assert.equal(await quiet(() => vault.deleteKey("TEST_SCRIPT_KEY")), true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A key's name is text of the vault's shape. JavaScript turns ["RAILWAY_API_TOKEN"], or an object whose toString gives
// that, into "RAILWAY_API_TOKEN" when it is used as a property name, so a name that isn't text used to skip the check on
// Tarsee's own keys while the vault still wrote to RAILWAY_API_TOKEN. The vault (setKey, getKey, deleteKey, hasKey) and
// the key tools refuse such a name before anything else looks at it.

const EVIL = "rw-test-attacker-0000-9999-8888-777766665555";
/** Names that aren't text: each would be "RAILWAY_API_TOKEN" (or "42", "true") as a property name. */
const NOT_TEXT = [
  ["a list", ["RAILWAY_API_TOKEN"]],
  ["a list in a list", [["RAILWAY_API_TOKEN"]]],
  ["an object whose toString gives the name", { toString: () => "RAILWAY_API_TOKEN" }],
  ["a String object", Object("RAILWAY_API_TOKEN")],
  ["a number", 42],
  ["true", true],
  ["null", null],
  ["nothing", undefined],
];
/** Text, but not a key's name: spaces or a line break round it, a character that looks like nothing, empty, too long. */
const NOT_A_NAME = [" RAILWAY_API_TOKEN ", "RAILWAY_API_TOKEN ", "RAILWAY_API_TOKEN\n", "RAILWAY_API_TOKEN" + String.fromCharCode(0x200b), "", "   ", "__proto__", "A".repeat(129)];
const vaultFile = () => fs.readFileSync(VAULT_FILE, "utf8");

describe("the vault takes a key's name only as text of its shape", () => {
  for (const [what, name] of NOT_TEXT) {
    it(`${what}: setKey, getKey, deleteKey and hasKey refuse it, and the token stays as it was`, async () => {
      await quiet(() => ownerSaves(TOKEN));
      const before = vaultFile();
      assert.throws(() => vault.setKey(name, EVIL), /name is text/);
      assert.throws(() => vault.setKey(name, EVIL, "", { owner: true }), /name is text/, "not even the owner's own Settings > Keys");
      assert.throws(() => vault.getKey(name), /name is text/);
      assert.throws(() => vault.deleteKey(name), /name is text/);
      assert.throws(() => vault.hasKey(name), /name is text/);
      assert.equal(vaultFile(), before, "the vault file is untouched");
      assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);
    });
  }

  it("with no token saved yet, a name that isn't text isn't a first save either", async () => {
    for (const [, name] of NOT_TEXT) assert.throws(() => vault.setKey(name, EVIL), /name is text/);
    assert.deepEqual(names(), []);
  });

  it("text that isn't a key's name is refused: spaces round it, a line break, an invisible character, empty, __proto__, too long", async () => {
    await quiet(() => ownerSaves(TOKEN));
    const before = vaultFile();
    for (const name of NOT_A_NAME) {
      assert.throws(() => vault.setKey(name, EVIL), /isn't a key's name|name is text/, JSON.stringify(name));
      assert.throws(() => vault.getKey(name), /isn't a key's name|name is text/, JSON.stringify(name));
      assert.throws(() => vault.deleteKey(name), /isn't a key's name|name is text/, JSON.stringify(name));
    }
    assert.equal(vaultFile(), before);
    assert.deepEqual(names(), ["RAILWAY_API_TOKEN"]);
  });

  it("the shape: a letter first, then letters, digits, _ . or -, up to 128 (what Settings > Keys takes)", async () => {
    for (const name of ["A", "STRIPE_SECRET_KEY", "openai.key-2", "x".repeat(128)]) {
      await quiet(() => vault.setKey(name, "value-0000"));
      assert.equal(vault.getKey(name), "value-0000", name);
      assert.equal(await quiet(() => vault.deleteKey(name)), true, name);
    }
    assert.ok(vault.isKeyName("STRIPE_SECRET_KEY"));
    for (const name of ["1ABC", "_ABC", "A B", "A/B", String.fromCharCode(0xc4), "x".repeat(129), ["A"], 1]) assert.equal(vault.isKeyName(name), false, String(name));
  });

  it("a name every object has (constructor, toString) is just a key that isn't there", async () => {
    assert.equal(vault.getKey("constructor"), null);
    assert.equal(vault.hasKey("toString"), false);
    assert.equal(await quiet(() => vault.deleteKey("hasOwnProperty")), false);
    await quiet(() => vault.setKey("constructor", "value-0000"));
    assert.equal(vault.getKey("constructor"), "value-0000");
    assert.deepEqual(names(), ["constructor"]);
  });

  it("a key saved under another name before this check is still read, replaced and deleted by its exact name", async () => {
    await quiet(() => vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY));
    const saved = JSON.parse(vaultFile());
    saved["my old key"] = { ...saved.TEST_SCRIPT_KEY };
    fs.writeFileSync(VAULT_FILE, JSON.stringify(saved));
    assert.equal(vault.getKey("my old key"), SCRIPT_KEY);
    assert.equal(vault.hasKey("my old key"), true);
    await quiet(() => vault.setKey("my old key", "new-value-0000"));
    assert.equal(vault.getKey("my old key"), "new-value-0000");
    assert.equal(await quiet(() => vault.deleteKey("my old key")), true);
    assert.throws(() => vault.setKey("my old key", "again"), /isn't a key's name/, "once gone, a new key needs the shape");
  });

  it("a value is text too", () => {
    for (const value of [["x"], { toString: () => "x" }, 42, null, undefined]) assert.throws(() => vault.setKey("TEST_SCRIPT_KEY", value), /value is text/);
    assert.deepEqual(names(), []);
  });
});

describe("the key tools check the name's type before anything else", () => {
  for (const [what, name] of NOT_TEXT) {
    it(`${what}: set_key, get_key and delete_key refuse it, and the token stays`, async () => {
      await quiet(() => ownerSaves(TOKEN));
      const before = vaultFile();
      for (const [t, input] of [["set_key", { name, value: EVIL }], ["get_key", { name }], ["delete_key", { name }]]) {
        const out = await tool(t, input);
        assert.ok(out.startsWith(`${t} refused: `), `${t}: ${out}`);
        assert.match(out, /name is text/, out);
        assert.ok(!out.includes(TOKEN) && !out.includes(EVIL), out);
      }
      assert.equal(vaultFile(), before);
      assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);
    });
  }

  it("with no token saved yet, set_key with a list for a name saves nothing", async () => {
    const out = await tool("set_key", { name: ["RAILWAY_API_TOKEN"], value: EVIL });
    assert.ok(out.startsWith("set_key refused: "), out);
    assert.deepEqual(names(), []);
  });

  it("a value that isn't text, and a description that isn't text, are refused", async () => {
    for (const input of [{ name: "TEST_SCRIPT_KEY", value: ["x"] }, { name: "TEST_SCRIPT_KEY", value: 42 }, { name: "TEST_SCRIPT_KEY", value: "" }, { name: "TEST_SCRIPT_KEY", value: "abc", description: ["x"] }]) {
      const out = await tool("set_key", input);
      assert.ok(out.startsWith("set_key refused: "), out);
    }
    assert.deepEqual(names(), []);
  });

  it("spaces round an ordinary name are trimmed, as for Tarsee's own; a name that isn't one is refused", async () => {
    assert.match(await tool("set_key", { name: " TEST_SCRIPT_KEY ", value: SCRIPT_KEY }), /^Key "TEST_SCRIPT_KEY" saved securely/);
    assert.equal(await tool("get_key", { name: " TEST_SCRIPT_KEY " }), SCRIPT_KEY);
    for (const name of ["A B", "", "1ABC"]) assert.ok((await tool("set_key", { name, value: SCRIPT_KEY })).startsWith("set_key refused: "), name);
    assert.match(await tool("delete_key", { name: " TEST_SCRIPT_KEY " }), /^Key "TEST_SCRIPT_KEY" deleted from vault\.$/);
    assert.deepEqual(names(), []);
  });

  it("from background work (a scheduled task, the heartbeat, BOOT.md) even a first save of Tarsee's own key is refused", async () => {
    for (const background of ["cron", "heartbeat", "boot"]) {
      const out = await quiet(() => executeTool("set_key", { name: "RAILWAY_API_TOKEN", value: EVIL }, { background }));
      assert.ok(out.startsWith("set_key refused: "), out);
      assert.match(out, /Settings > Keys/, out);
    }
    assert.deepEqual(names(), []);
    assert.match(await tool("set_key", { name: "RAILWAY_API_TOKEN", value: TOKEN }), /saved securely/, "a chat's first save still works");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A RAILWAY_API_TOKEN set as a variable where Tarsee runs (Railway's own Variables tab) reaches no AI command: engine-env
// strips it from every engine's environment, and the exec tool runs with that stripped environment, not the server's.
// tarsee_railway (lib/railway-admin.js) still reads it from Tarsee's own environment.

describe("Tarsee's own keys set as variables where it runs reach no AI command", () => {
  const SECRETS = {
    RAILWAY_API_TOKEN: TOKEN,
    SETUP_PASSWORD: "test-canary-setup-password-0000",
    TARSEE_API_TOKEN: "test-canary-api-token-000000000000",
    OPENAI_API_KEY: "sk-proj-test-canary-openai-00000000",
  };
  const saved = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(SECRETS)) { saved[k] = process.env[k]; process.env[k] = v; }
  });
  after(() => {
    for (const k of Object.keys(SECRETS)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  it("engine-env's list is key-vault's SERVER_ONLY_KEYS (a literal there, so engine-env never loads config)", () => {
    assert.deepEqual([...engineEnv.SERVER_ONLY_KEY_NAMES], [...vault.SERVER_ONLY_KEYS]);
    assert.ok(Object.isFrozen(engineEnv.SERVER_ONLY_KEY_NAMES));
    const src = fs.readFileSync(new URL("../src/ai/engine-env.js", import.meta.url), "utf8");
    assert.doesNotMatch(src, /from\s+["'][^"']*(?:config\/env|key-vault)\.js["']/, "engine-env imports neither config nor the vault");
  });

  it("baseEnv strips it, in any case, and a copy of it under another name; the rest stays", () => {
    const env = { PATH: "/usr/bin", RAILWAY_PROJECT_ID: "p-1", RAILWAY_API_TOKEN: ` ${TOKEN} `, railway_api_token: TOKEN, RAILWAY_TOKEN: TOKEN, SHORT: "abc" };
    const base = engineEnv.baseEnv(env);
    assert.deepEqual(base, { PATH: "/usr/bin", RAILWAY_PROJECT_ID: "p-1", SHORT: "abc" });
  });

  it("baseEnv strips a copy of the vault's token held by a variable under another name", async () => {
    delete process.env.RAILWAY_API_TOKEN;
    await quiet(() => ownerSaves(OTHER_TOKEN));
    const base = engineEnv.baseEnv({ PATH: "/usr/bin", MY_RAILWAY: OTHER_TOKEN });
    assert.deepEqual(base, { PATH: "/usr/bin" });
  });

  it("finalizeEnv: not from the server's environment; the vault's other keys still reach scripts", () => {
    const env = engineEnv.finalizeEnv({ env: { ...process.env }, vaultEnv: { TEST_SCRIPT_KEY: SCRIPT_KEY } });
    assert.equal(env.TEST_SCRIPT_KEY, SCRIPT_KEY);
    for (const [k, v] of Object.entries(SECRETS)) {
      assert.ok(!(k in env), k);
      assert.ok(!Object.values(env).includes(v), `${k}'s value`);
    }
    assert.ok(env.PATH || env.Path, "PATH stays");
  });

  it("the exec tool runs with that stripped environment, plus the vault's keys for scripts", async () => {
    await quiet(() => vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY));
    const out = await tool("exec", { command: "env" });
    assert.match(out, /^Exit code: 0\n/, out);
    assert.ok(out.includes(`TEST_SCRIPT_KEY=${SCRIPT_KEY}`), "a vault key reaches the command, as it does the AI's own shell");
    for (const [k, v] of Object.entries(SECRETS)) assert.ok(!out.includes(v), `${k} reached the command`);
    assert.ok(!out.includes(process.env.ENCRYPTION_KEY), "ENCRYPTION_KEY reached the command");
  });

  it("exec: the vault's token, and a copy of it, never; no vault key at all while get_key is denied", async () => {
    delete process.env.RAILWAY_API_TOKEN;
    await quiet(() => { ownerSaves(OTHER_TOKEN); vault.setKey("MY_RAILWAY", OTHER_TOKEN); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
    const out = await tool("exec", { command: "env" });
    assert.ok(!out.includes(OTHER_TOKEN), out.slice(0, 200));
    assert.ok(out.includes(SCRIPT_KEY));
    const sm = getSecurityManager();
    const was = sm.getToolPermission("get_key");
    sm.setToolPermission("get_key", "always_deny");
    try {
      const denied = await tool("exec", { command: "env" });
      assert.match(denied, /^Exit code: 0\n/);
      assert.ok(!denied.includes(SCRIPT_KEY), "with get_key denied, no vault key goes into a command");
    } finally {
      sm.setToolPermission("get_key", was);
    }
  });

  it("exec refuses a command that isn't text", async () => {
    for (const command of [["env"], 42, null, ""]) {
      const out = await tool("exec", { command });
      assert.ok(out.startsWith("exec refused: "), out);
    }
  });

  it("tarsee_railway still reads the token from Tarsee's own environment", async () => {
    const sent = [];
    const fakeFetch = async (_url, init) => {
      sent.push(init.headers.Authorization);
      return new Response(JSON.stringify({ data: { projects: { edges: [] } } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await railwayAdmin({ action: "list_projects" }, { vault: { getKey: () => null }, fetch: fakeFetch, log: () => {} });
    assert.deepEqual(sent, [`Bearer ${TOKEN}`]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A key tool's refusal comes back marked isError, MCP's own failure mark, so the chat bots' status line
// (lib/tool-status.js) says the save, the removal or the check failed: it said "Key saved" when replacing the token was
// refused.

describe("the key tools' refusals are marked as errors, and the status line says so", () => {
  async function connect() {
    const server = createTarseeMcp({ ...CHAT }, { quiet: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tarsee-test", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.instance.connect(serverSide), client.connect(clientSide)]);
    return client;
  }
  const call = async (client, name, args) => quiet(() => client.callTool({ name, arguments: args }));
  const text = (res) => res.content.map((c) => c.text).join("\n");
  const status = (name, res) => toolDoneLabel(`mcp__tarsee__${name}`, {}, res.isError === true);

  it("replacing, deleting or reading Tarsee's own key: isError, and the bots don't say it worked", async () => {
    const client = await connect();
    try {
      await quiet(() => ownerSaves(TOKEN));
      const set = await call(client, "tarsee_set_key", { key: "RAILWAY_API_TOKEN", value: EVIL });
      assert.equal(set.isError, true, text(set));
      assert.match(text(set), /Settings > Keys/);
      assert.equal(status("tarsee_set_key", set), "Saving the key failed");
      const del = await call(client, "tarsee_delete_key", { key: "railway_api_token" });
      assert.equal(del.isError, true, text(del));
      assert.equal(status("tarsee_delete_key", del), "Removing the key failed");
      const get = await call(client, "tarsee_get_key", { key: "RAILWAY_API_TOKEN" });
      assert.equal(get.isError, true, text(get));
      assert.ok(!text(get).includes(TOKEN));
      assert.equal(status("tarsee_get_key", get), "Vault check failed");
      assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);
    } finally {
      await client.close();
    }
  });

  it("a key that isn't there, a name that isn't one, a copy of the token, a policy denial: all marked", async () => {
    const client = await connect();
    try {
      await quiet(() => { ownerSaves(TOKEN); vault.setKey("MY_RAILWAY", TOKEN); });
      for (const [name, args] of [
        ["tarsee_get_key", { key: "NO_SUCH_KEY" }],
        ["tarsee_get_key", { key: "MY_RAILWAY" }],
        ["tarsee_delete_key", { key: "NO_SUCH_KEY" }],
        ["tarsee_set_key", { key: "A B", value: "value-0000" }],
        ["tarsee_set_key", { key: ["RAILWAY_API_TOKEN"], value: EVIL }],
        ["tarsee_delete_key", { key: ["RAILWAY_API_TOKEN"] }],
      ]) {
        const res = await call(client, name, args);
        assert.equal(res.isError, true, `${name} ${JSON.stringify(args)}: ${text(res)}`);
      }
      const sm = getSecurityManager();
      const was = sm.getToolPermission("set_key");
      sm.setToolPermission("set_key", "always_deny");
      try {
        const denied = await call(client, "tarsee_set_key", { key: "TEST_SCRIPT_KEY", value: SCRIPT_KEY });
        assert.equal(denied.isError, true, text(denied));
        assert.equal(status("tarsee_set_key", denied), "Saving the key failed");
      } finally {
        sm.setToolPermission("set_key", was);
      }
      assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);
      assert.deepEqual(names(), ["MY_RAILWAY", "RAILWAY_API_TOKEN"]);
    } finally {
      await client.close();
    }
  });

  it("what worked has no mark: a save, a first save of the token, a read, a list, a removal", async () => {
    const client = await connect();
    try {
      for (const [name, args, shown] of [
        ["tarsee_set_key", { key: "RAILWAY_API_TOKEN", value: TOKEN }, "Key saved"],
        ["tarsee_set_key", { key: "TEST_SCRIPT_KEY", value: SCRIPT_KEY }, "Key saved"],
        ["tarsee_get_key", { key: "TEST_SCRIPT_KEY" }, "Vault checked"],
        ["tarsee_list_keys", {}, "Vault checked"],
        ["tarsee_delete_key", { key: "TEST_SCRIPT_KEY" }, "Key removed"],
      ]) {
        const res = await call(client, name, args);
        assert.notEqual(res.isError, true, `${name}: ${text(res)}`);
        assert.equal(status(name, res), shown, name);
      }
      assert.deepEqual(names(), ["RAILWAY_API_TOKEN"]);
    } finally {
      await client.close();
    }
  });
});
