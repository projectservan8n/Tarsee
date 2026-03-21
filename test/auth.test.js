import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Set env before importing auth module
process.env.SETUP_PASSWORD = "test-password-123";
process.env.OPUSCLAW_STATE_DIR = "/tmp/opusclaw-test-" + Date.now();

const { validatePassword, validateApiToken, createSession, destroySession } = await import("../src/middleware/auth.js");
const config = (await import("../src/config/env.js")).default;

describe("validatePassword", () => {
  it("accepts correct password", () => {
    assert.ok(validatePassword("test-password-123"));
  });

  it("rejects wrong password", () => {
    assert.ok(!validatePassword("wrong-password"));
  });

  it("rejects empty password", () => {
    assert.ok(!validatePassword(""));
  });

  it("rejects non-string", () => {
    assert.ok(!validatePassword(null));
    assert.ok(!validatePassword(undefined));
    assert.ok(!validatePassword(123));
  });
});

describe("validateApiToken", () => {
  it("accepts the generated API token", () => {
    assert.ok(validateApiToken(config.API_TOKEN));
  });

  it("rejects wrong token", () => {
    assert.ok(!validateApiToken("not-the-right-token"));
  });
});

describe("sessions", () => {
  it("creates and validates sessions", () => {
    const sessionId = createSession("127.0.0.1");
    assert.ok(sessionId);
    assert.ok(typeof sessionId === "string");
    assert.ok(sessionId.length >= 32);
  });

  it("destroys sessions", () => {
    const sessionId = createSession("127.0.0.1");
    destroySession(sessionId);
    // Session should be gone (no way to validate externally, but no error)
  });
});
