// The vault's keys in the agent's environment (src/ai/agent-env.js): every key named like an environment variable,
// except what would change Claude's login or billing, how programs run, or what Tarsee already set; none at all when
// get_key is denied in Tool Permissions or TARSEE_AGENT_ENV_KEYS is "off".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentVaultEnv } from "../src/ai/agent-env.js";

const vault = {
  OPENAI_API_KEY: "sk-test-1", RESEND_API_KEY: " re_test_2 ", GITHUB_TOKEN: "ghp_test",
  ANTHROPIC_API_KEY: "sk-ant-test", CLAUDE_CODE_OAUTH_TOKEN: "oat-test", TARSEE_TIMEZONE: "UTC",
  NODE_OPTIONS: "--require /tmp/x.js", PATH: "/evil", HTTPS_PROXY: "http://evil", LD_PRELOAD: "/evil.so",
  PYTHONSTARTUP: "/evil.py", BASH_ENV: "/evil.sh", lower_case: "x", "NOT-A-NAME": "x", EMPTY_ONE: "  ", ALREADY_SET: "vault",
};
const get = (name) => vault[name] ?? null;
const list = () => Object.keys(vault);

describe("the vault's keys in the agent's environment", () => {
  it("every key named like an environment variable, trimmed; the rest left out", () => {
    const env = agentVaultEnv({ get, list, env: { ALREADY_SET: "tarsee" } });
    assert.deepEqual(env, { OPENAI_API_KEY: "sk-test-1", RESEND_API_KEY: "re_test_2", GITHUB_TOKEN: "ghp_test" });
  });

  it("TARSEE_AGENT_ENV_KEYS names the keys instead, with the same limits; \"off\" gives none", () => {
    assert.deepEqual(agentVaultEnv({ get, list, env: { TARSEE_AGENT_ENV_KEYS: " OPENAI_API_KEY , ANTHROPIC_API_KEY,MISSING" } }), { OPENAI_API_KEY: "sk-test-1" });
    assert.deepEqual(agentVaultEnv({ get, list, env: { TARSEE_AGENT_ENV_KEYS: "off" } }), {});
  });

  it("none when the owner denied get_key, or when the vault can't be read", () => {
    assert.deepEqual(agentVaultEnv({ get, list, env: {}, denied: () => true }), {});
    assert.deepEqual(agentVaultEnv({ get: () => { throw new Error("locked"); }, list, env: {} }), {});
    assert.deepEqual(agentVaultEnv({ get, list: () => { throw new Error("locked"); }, env: {} }), {});
  });
});
