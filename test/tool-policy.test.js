import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getSecurityManager } from "../src/lib/security-manager.js";
import { executeTool } from "../src/lib/tools.js";

// Settings > Tool Permissions saved a mode and nothing read it. SecurityManager
// implemented checkToolPermission; no caller ever invoked it. So an operator
// who set `exec` to always_deny got a UI that confirmed the change and an agent
// that still ran shell commands — the worst kind of security control, one that
// reports success while enforcing nothing.
//
// executeTool is the single choke point for every tool call (the MCP server and
// the legacy channel loop both route through it), so these tests drive the
// policy through that real path rather than calling the checker directly.

/** A minimal settings store: the manager only needs get/set. */
function fakeStore() {
  const map = new Map();
  return { get: (k) => map.get(k) ?? null, set: (k, v) => map.set(k, v) };
}

const store = fakeStore();
const ctx = { settingsStore: store };

beforeEach(() => {
  // getSecurityManager is a singleton; reset the modes each test touches.
  const sm = getSecurityManager(store);
  for (const tool of ["exec", "web_fetch", "calculator", "browser"]) {
    sm.setToolPermission(tool, "always_allow");
  }
});

describe("tool permissions are enforced, not just stored", () => {
  it("refuses a tool the operator set to always_deny", async () => {
    getSecurityManager(store).setToolPermission("exec", "always_deny");
    const result = await executeTool("exec", { command: "echo hi" }, ctx);
    assert.match(result, /Refused by security policy/);
    assert.match(result, /denied by policy/i);
  });

  it("tells the model not to work around the refusal", async () => {
    // Without this the agent just tries Bash or curl instead, which defeats
    // the point of denying the tool at all.
    getSecurityManager(store).setToolPermission("exec", "always_deny");
    const result = await executeTool("exec", { command: "ls" }, ctx);
    assert.match(result, /Do not retry|work around/i);
  });

  it("still runs a tool that is allowed", async () => {
    const result = await executeTool("calculator", { expression: "2+2" }, ctx);
    assert.doesNotMatch(result, /Refused/);
    assert.match(String(result), /4/);
  });

  it("rejects path traversal in write_file before it executes", async () => {
    const result = await executeTool("write_file", { filename: "../../etc/passwd", content: "x" }, ctx);
    assert.match(result, /Refused|Error/);
    assert.doesNotMatch(result, /^Wrote /);
  });
});

describe("SSRF protection", () => {
  it("blocks the cloud instance metadata endpoint", async () => {
    // 169.254.169.254 hands out cloud credentials to anything on the box. An
    // agent that fetches URLs found in email or web pages is exactly that.
    const result = await executeTool("web_fetch", { url: "http://169.254.169.254/latest/meta-data/" }, ctx);
    assert.match(result, /Refused|blocked|SSRF/i);
  });

  it("blocks loopback and RFC1918 targets", async () => {
    for (const url of [
      "http://127.0.0.1:3000/api/settings",
      "http://localhost/admin",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
    ]) {
      const result = await executeTool("web_fetch", { url }, ctx);
      assert.match(result, /Refused|blocked|SSRF/i, `${url} was not blocked`);
    }
  });

  it("blocks private targets for the browser tool too", async () => {
    const result = await executeTool("browser", { action: "navigate", url: "http://169.254.169.254/" }, ctx);
    assert.match(result, /Refused|blocked/i);
  });
});
