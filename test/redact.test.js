import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/lib/redact.js";

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
});
