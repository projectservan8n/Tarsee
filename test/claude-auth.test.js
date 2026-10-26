// Claude's sign-in running out (src/ai/providers/claude-code.js): the CLI answers with the error as if it were the
// reply, and that must not reach the chat as the answer.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAuthFailure, AUTH_EXPIRED_MESSAGE } from "../src/ai/providers/claude-code.js";

describe("an expired Claude sign-in is not a reply", () => {
  it("knows the CLI's words for it, and the SDK's flag", () => {
    assert.equal(isAuthFailure("Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue."), true);
    assert.equal(isAuthFailure("API Error: 401 {\"type\":\"error\"}"), true);
    assert.equal(isAuthFailure("OAuth token has expired"), true);
    assert.equal(isAuthFailure("", "authentication_failed"), true);
  });

  it("leaves ordinary answers alone, an answer about logins included", () => {
    assert.equal(isAuthFailure("Here's how to add a login page to your app."), false);
    assert.equal(isAuthFailure("The server returned 401 for that URL, so it needs a token."), false);
    assert.equal(isAuthFailure("Done.", "rate_limit"), false);
    assert.equal(isAuthFailure(null), false);
  });

  it("says what to do, where: the dashboard's terminal and claude login", () => {
    assert.match(AUTH_EXPIRED_MESSAGE, /sign-in has expired/);
    assert.match(AUTH_EXPIRED_MESSAGE, /`claude login`/);
    assert.match(AUTH_EXPIRED_MESSAGE, />_/);
  });
});
