// agentVaultEnv's one-minute cache (src/ai/agent-env.js) holds the answer for the default call only: the live turn's
// agentVaultEnv() against Tarsee's own environment. A call that passes its own `env` (engine-env's handoff,
// agentVaultEnv({ env: baseEnv(process.env) })) compares the vault against a different environment, so it must neither
// read that cache nor write it; and the owner denying get_key in Tool Permissions applies at once, cache or not.
// Uses the real vault in a temporary data folder, with obvious fake keys.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-vault-env-cache-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
delete process.env.TARSEE_AGENT_ENV_KEYS;
delete process.env.TEST_SCRIPT_KEY;
delete process.env.TEST_SHARED_KEY;

const { setKey } = await import("../src/lib/key-vault.js");
const { agentVaultEnv, __resetAgentEnv } = await import("../src/ai/agent-env.js");

const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
};

before(() => {
  setKey("TEST_SCRIPT_KEY", "sk-test-canary-script");
  setKey("TEST_SHARED_KEY", "sk-test-canary-shared");
});
beforeEach(() => __resetAgentEnv());
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("agentVaultEnv's cache", () => {
  it("the default call reads the vault and caches it", () => {
    const a = quiet(() => agentVaultEnv());
    assert.deepEqual(a, { TEST_SCRIPT_KEY: "sk-test-canary-script", TEST_SHARED_KEY: "sk-test-canary-shared" });
    assert.equal(quiet(() => agentVaultEnv()), a, "a second call within the minute is the cached answer");
  });

  it("a call with its own env isn't answered from the default call's cache", () => {
    quiet(() => agentVaultEnv());
    // TEST_SHARED_KEY is set in this environment, so it must stay out (names already set win).
    const own = quiet(() => agentVaultEnv({ env: { TEST_SHARED_KEY: "set-by-the-host" } }));
    assert.deepEqual(own, { TEST_SCRIPT_KEY: "sk-test-canary-script" });
  });

  it("a call with its own env doesn't fill the cache the default call reads", () => {
    quiet(() => agentVaultEnv({ env: { TEST_SHARED_KEY: "set-by-the-host" } }));
    assert.deepEqual(quiet(() => agentVaultEnv()), { TEST_SCRIPT_KEY: "sk-test-canary-script", TEST_SHARED_KEY: "sk-test-canary-shared" });
  });

  it("denying get_key applies at once, even with a cached answer, and allowing it again doesn't wait a minute", () => {
    quiet(() => agentVaultEnv());
    let calls = 0;
    const denied = quiet(() => agentVaultEnv({ denied: () => { calls++; return true; } }));
    assert.deepEqual(denied, {});
    assert.equal(calls, 1, "denied() is asked on every call");
    assert.deepEqual(quiet(() => agentVaultEnv({ denied: () => false })), { TEST_SCRIPT_KEY: "sk-test-canary-script", TEST_SHARED_KEY: "sk-test-canary-shared" });
  });
});
