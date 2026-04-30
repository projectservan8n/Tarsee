import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, redactDeep } from "../src/lib/redact.js";

describe("redactSecrets", () => {
  it("redacts OpenAI API keys", () => {
    assert.equal(
      redactSecrets("key is sk-1234567890abcdef1234567890"),
      "key is [REDACTED]"
    );
  });

  it("redacts Anthropic API keys", () => {
    assert.equal(
      redactSecrets("sk-ant-api03-1234567890abcdefghijk"),
      "[REDACTED]"
    );
  });

  it("redacts OpenRouter keys", () => {
    assert.equal(
      redactSecrets("sk-or-v1-1234567890abcdef1234567890abcdef1234567890ab"),
      "[REDACTED]"
    );
  });

  it("redacts GitHub tokens", () => {
    assert.equal(
      redactSecrets("token: ghp_1234567890abcdefghijk"),
      "token: [REDACTED]"
    );
  });

  it("redacts Slack tokens", () => {
    assert.equal(
      redactSecrets("xoxb-1234567890-1234567890-abcdefghijklmnop"),
      "[REDACTED]"
    );
  });

  it("redacts Telegram bot tokens", () => {
    assert.equal(
      redactSecrets("12345678:ABCDefgh_ijklmn123456"),
      "[REDACTED]"
    );
  });

  it("redacts Google API keys", () => {
    assert.equal(
      redactSecrets("AIzaSyAbcdefghijklmnopqrstuvwxyz1234567"),
      "[REDACTED]"
    );
  });

  it("does not redact normal text", () => {
    const text = "Hello, this is a normal message with no secrets.";
    assert.equal(redactSecrets(text), text);
  });

  it("redacts multiple secrets in one string", () => {
    const input = "openai: sk-abc123456789xyz key, slack: xoxb-123456789012-something";
    const result = redactSecrets(input);
    assert.ok(!result.includes("sk-abc123456789xyz"));
    assert.ok(!result.includes("xoxb-123456789012"));
  });

  it("redacts Stripe live/test secret keys", () => {
    assert.ok(!redactSecrets("sk_live_abcdefghijklmnopqrstuv").includes("sk_live_abc"));
    assert.ok(!redactSecrets("sk_test_abcdefghijklmnopqrstuv").includes("sk_test_abc"));
    assert.ok(!redactSecrets("whsec_1234567890abcdefghij").includes("whsec_1234"));
  });

  it("redacts AWS access key IDs", () => {
    assert.equal(
      redactSecrets("creds: AKIAIOSFODNN7EXAMPLE"),
      "creds: [REDACTED]"
    );
  });

  it("redacts Bearer tokens in Authorization headers", () => {
    const input = `Authorization: Bearer abcdef1234567890tokenvalue`;
    const out = redactSecrets(input);
    assert.ok(out.includes("Authorization: Bearer "));
    assert.ok(!out.includes("abcdef1234567890tokenvalue"));
  });

  it("redacts DB connection string passwords", () => {
    const out = redactSecrets("postgres://user:supersecret123@db.example.com/mydb");
    assert.ok(out.includes("postgres://user:[REDACTED]@db.example.com/mydb"));
  });

  it("redacts JWT-shaped tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIiw.SflKxwRJSMeKKF2QT4f";
    const out = redactSecrets(`token ${jwt} end`);
    assert.ok(out.includes("token "));
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes("eyJhbGc"));
  });

  it("redacts inline KEY=value secrets but leaves URLs alone", () => {
    assert.equal(
      redactSecrets("MY_API_KEY=hunter2_password"),
      "MY_API_KEY=[REDACTED]"
    );
    // KEY=URL should NOT be redacted (false-positive guard)
    assert.equal(
      redactSecrets("PUBLIC_KEY=https://example.com/key.pem"),
      "PUBLIC_KEY=https://example.com/key.pem"
    );
  });
});

describe("redactDeep", () => {
  it("redacts secrets inside nested objects (e.g. tool inputs)", () => {
    const input = {
      command: 'curl -H "Authorization: Bearer sk-ant-FAKEkey1234567890abcd"',
      cwd: "/tmp",
      env: { OPENAI_API_KEY: "sk-fakefakefakefakefakefakefakefake" },
    };
    const out = redactDeep(input);
    assert.ok(!JSON.stringify(out).includes("sk-ant-FAKEkey"));
    assert.ok(!JSON.stringify(out).includes("sk-fakefake"));
    assert.equal(out.cwd, "/tmp"); // safe values pass through
  });

  it("preserves arrays and non-string values", () => {
    const input = { items: ["safe", "ghp_secrettoken1234567890abc"], n: 42, b: true };
    const out = redactDeep(input);
    assert.equal(out.n, 42);
    assert.equal(out.b, true);
    assert.equal(out.items[0], "safe");
    assert.ok(!out.items[1].includes("ghp_secret"));
  });
});
