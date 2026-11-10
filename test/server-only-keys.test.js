// Vault keys Tarsee itself uses (SERVER_ONLY_KEYS in src/lib/key-vault.js): RAILWAY_API_TOKEN, the token
// tarsee_railway reaches Railway with. With it in hand, one call to Railway's API from the AI's shell would skip every
// limit that tool keeps, so, whether the AI's commands run as the server's user (today) or as a user of their own:
//   - the agent's environment never carries it (src/ai/agent-env.js), under its name in any case, named in
//     TARSEE_AGENT_ENV_KEYS, or copied under another name;
//   - tarsee_get_key refuses it ("RAILWAY_API_TOKEN is Tarsee's own; use tarsee_railway"), and a copy of it;
//   - tarsee_list_keys still names it, without even its masked ends;
//   - from chat, tarsee_set_key saves one while Tarsee has none yet (the way owners save it today), and replacing or
//     deleting one already there is refused ("change it in Settings > Keys"); other vault writers are held to the
//     same, and only the owner's Settings > Keys ({ owner: true }) may.
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
const { TOKEN_KEY } = await import("../src/lib/railway-admin.js");

const TOKEN = "rw-test-canary-0000-1111-2222-333344445555";
const OTHER_TOKEN = "rw-test-canary-9999-8888-7777-666655554444";
const SCRIPT_KEY = "sk-test-canary-script-0000000000";
const VAULT_FILE = path.join(tmp, "data", "vault.json");

const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};
const tool = (name, input) => quiet(() => executeTool(name, input, {}));
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
    await quiet(() => { vault.setKey("RAILWAY_API_TOKEN", TOKEN); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
    const env = agentVaultEnv({ env: {} });
    assert.equal(env.TEST_SCRIPT_KEY, SCRIPT_KEY, "an ordinary key still reaches scripts");
    assert.ok(!("RAILWAY_API_TOKEN" in env), JSON.stringify(Object.keys(env)));
    assert.ok(!Object.values(env).includes(TOKEN));
  });

  it("not when TARSEE_AGENT_ENV_KEYS names it", async () => {
    await quiet(() => { vault.setKey("RAILWAY_API_TOKEN", TOKEN); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
    const env = agentVaultEnv({ env: { TARSEE_AGENT_ENV_KEYS: "RAILWAY_API_TOKEN, TEST_SCRIPT_KEY" } });
    assert.deepEqual(env, { TEST_SCRIPT_KEY: SCRIPT_KEY });
  });

  it("not as a copy saved under another name, of the vault's token or of the one in Tarsee's environment", async () => {
    await quiet(() => { vault.setKey("RAILWAY_API_TOKEN", TOKEN); vault.setKey("RAILWAY_TOKEN", ` ${TOKEN} `); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
    assert.deepEqual(agentVaultEnv({ env: {} }), { TEST_SCRIPT_KEY: SCRIPT_KEY });

    emptyVault();
    process.env.RAILWAY_API_TOKEN = OTHER_TOKEN;   // the owner set it as a Railway variable instead
    await quiet(() => { vault.setKey("DEPLOY_TOKEN", OTHER_TOKEN); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
    // engine-env passes its stripped copy of the environment; the server's own still counts.
    assert.deepEqual(agentVaultEnv({ env: {} }), { TEST_SCRIPT_KEY: SCRIPT_KEY });
  });

  it("not on the default call, cached or not", async () => {
    await quiet(() => { vault.setKey("RAILWAY_API_TOKEN", TOKEN); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
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
    await quiet(() => vault.setKey("RAILWAY_API_TOKEN", TOKEN));
    for (const name of ["RAILWAY_API_TOKEN", " railway_api_token "]) {
      const out = await tool("get_key", { name });
      assert.ok(out.startsWith("RAILWAY_API_TOKEN is Tarsee's own; use tarsee_railway"), out);
      assert.ok(!out.includes(TOKEN), out);
    }
  });

  it("get_key refuses a copy of the token saved under another name; an ordinary key still comes back", async () => {
    await quiet(() => { vault.setKey("RAILWAY_API_TOKEN", TOKEN); vault.setKey("MY_RAILWAY", TOKEN); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
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
    await quiet(() => { vault.setKey("RAILWAY_API_TOKEN", TOKEN, "Railway account token"); vault.setKey("TEST_SCRIPT_KEY", SCRIPT_KEY); });
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
    await quiet(() => vault.setKey("RAILWAY_API_TOKEN", TOKEN));
    assert.throws(() => vault.setKey("RAILWAY_API_TOKEN", OTHER_TOKEN, "a tool that saves to the vault"), /Settings > Keys/);
    assert.throws(() => vault.deleteKey("RAILWAY_API_TOKEN"), /Settings > Keys/);
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), TOKEN);

    await quiet(() => vault.setKey("RAILWAY_API_TOKEN", OTHER_TOKEN, "", { owner: true }));
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), OTHER_TOKEN);
    assert.equal(await quiet(() => vault.deleteKey("RAILWAY_API_TOKEN", { owner: true })), true);
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), null);
  });

  it("a first save needs no owner; other keys are as before", async () => {
    await quiet(() => vault.setKey("RAILWAY_API_TOKEN", TOKEN));
    await quiet(() => { vault.setKey("TEST_SCRIPT_KEY", "a"); vault.setKey("TEST_SCRIPT_KEY", "b"); });
    assert.equal(vault.getKey("TEST_SCRIPT_KEY"), "b");
    assert.equal(await quiet(() => vault.deleteKey("TEST_SCRIPT_KEY")), true);
  });
});
