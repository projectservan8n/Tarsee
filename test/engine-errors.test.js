// engine-errors.js (design 4.7 "Errors"): what an engine's failure means, per provider, in words the owner can act on.
// The messages below are the ones the pinned Claude Code CLI (Agent SDK 0.3.319) actually produced against a fake
// Messages API (test/fixtures/fake-anthropic.js): a 401 is "Not logged in · Please run /login" with
// error "authentication_failed", a 402 is "API Error: 402 Insufficient Balance", a 429 "API Error: Request rejected
// (429) · ...", an unknown model "There's an issue with the selected model (...)".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyEngineError, friendly, authMessage, failureStateFor, statusFromMessage, ERROR_KINDS } from "../src/ai/engine-errors.js";

const CC = "claude-code";
const CX = "codex";

describe("classifyEngineError: HTTP statuses", () => {
  it("401 on a key provider is a rejected key, naming that provider and where to fix it", () => {
    const e = classifyEngineError("deepseek", CC, { status: 401 });
    assert.equal(e.kind, "auth");
    assert.equal(e.state, "error");
    assert.equal(e.recoverable, false);
    assert.match(e.message, /DeepSeek key was rejected/);
    assert.match(e.message, /Settings > AI/);
    assert.doesNotMatch(e.message, /claude auth login|claude login/i, "a gateway's 401 is not Claude's sign-in");
  });

  it("401 on the Claude plan is the sign-in running out", () => {
    const e = classifyEngineError("claude", CC, { status: 401 });
    assert.equal(e.kind, "expired");
    assert.equal(e.state, "sign-in-expired");
    assert.match(e.message, /claude auth login/);
  });

  it("the CLI's 'Not logged in' (authentication_failed) is the provider's own auth failure", () => {
    const gw = classifyEngineError("openrouter", CC, { code: "authentication_failed", message: "Not logged in · Please run /login" });
    assert.equal(gw.kind, "auth");
    assert.match(gw.message, /OpenRouter key was rejected/);
    const plan = classifyEngineError("claude-code", CC, { code: "authentication_failed", message: "Not logged in · Please run /login" });
    assert.equal(plan.kind, "expired");
    assert.equal(plan.provider, "claude");
  });

  it("403 is an auth failure too", () => {
    assert.equal(classifyEngineError("anthropic", CC, { status: 403 }).kind, "auth");
  });

  it("402 is out of credit, with the provider's top-up link", () => {
    const ds = classifyEngineError("deepseek", CC, { message: "API Error: 402 Insufficient Balance" });
    assert.equal(ds.kind, "billing");
    assert.equal(ds.status, 402);
    assert.equal(ds.state, "out-of-credit");
    assert.match(ds.message, /DeepSeek balance is empty/);
    assert.match(ds.message, /platform\.deepseek\.com\/top_up/);
    const or = classifyEngineError("openrouter", CC, { status: 402 });
    assert.match(or.message, /spending limit/);
    assert.match(or.message, /openrouter\.ai\/settings\/keys/);
    const an = classifyEngineError("anthropic", CC, { code: "billing_error" });
    assert.equal(an.kind, "billing");
    assert.match(an.message, /platform\.claude\.com\/settings\/billing/, "the Claude Console's own address now");
  });

  it("an Anthropic key made outside a workspace: says to make one in a workspace (Tarsee sends no workspace header)", () => {
    for (const input of [
      { status: 400, message: "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"anthropic-workspace-id header is required for this API key\"}}" },
      { status: 401, message: "This key isn't scoped to a workspace" },
    ]) {
      const r = classifyEngineError("anthropic", CC, input);
      assert.equal(r.kind, "auth", input.message);
      assert.equal(r.state, "error");
      assert.match(r.message, /workspace/);
      assert.match(r.message, /Settings > AI/);
    }
    assert.doesNotMatch(classifyEngineError("anthropic", CC, { status: 401 }).message, /workspace/, "a plain 401 is a rejected key");
    assert.doesNotMatch(classifyEngineError("deepseek", CC, { status: 400, message: "workspace" }).message, /Anthropic/);
  });

  it("429 is busy; on a plan it is the plan's usage limit", () => {
    const gw = classifyEngineError("deepseek", CC, { code: "rate_limit", message: "API Error: Request rejected (429) · slow down" });
    assert.equal(gw.kind, "rate");
    assert.equal(gw.status, 429);
    assert.equal(gw.state, null, "busy is not a broken provider");
    assert.match(gw.message, /busy/i);
    const plan = classifyEngineError("chatgpt", CX, { status: 429 });
    assert.equal(plan.kind, "rate");
    assert.match(plan.message, /usage limit/i);
  });

  it("5xx and overloaded are the provider being unavailable", () => {
    for (const input of [{ status: 500 }, { status: 503 }, { status: 529 }, { code: "overloaded" }, { code: "server_error" }]) {
      const e = classifyEngineError("openrouter", CC, input);
      assert.equal(e.kind, "unavailable", JSON.stringify(input));
      assert.match(e.message, /OpenRouter/);
    }
  });

  it("an unknown model says to pick another one", () => {
    const e = classifyEngineError("deepseek", CC, { code: "model_not_found", message: "There's an issue with the selected model (deepseek-flash[1m]). It may not exist or you may not have access to it." });
    assert.equal(e.kind, "model");
    assert.match(e.message, /pick another model/i);
    assert.equal(classifyEngineError("openrouter", CC, { status: 404, message: "model not found" }).kind, "model");
    assert.equal(classifyEngineError("openrouter", CC, { status: 400, message: "invalid model id foo/bar" }).kind, "model");
  });

  it("only a failed session resume is recoverable", () => {
    const e = classifyEngineError("claude", CC, { message: "API Error: 400 diagnostics.previous_message_id: must be the id from a prior message" });
    assert.equal(e.kind, "session");
    assert.equal(e.recoverable, true);
    assert.equal(classifyEngineError("deepseek", CC, { message: "No conversation found with session ID: abc" }).recoverable, true);
    for (const k of [{ status: 401 }, { status: 402 }, { status: 429 }, { status: 500 }]) {
      assert.equal(classifyEngineError("deepseek", CC, k).recoverable, false);
    }
  });

  it("an expired Claude OAuth token in the words is the plan's sign-in, whatever the status", () => {
    const e = classifyEngineError("claude", CC, { message: "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue." });
    assert.equal(e.kind, "expired");
    assert.equal(e.status, 401);
  });

  it("a Claude sign-in token pasted as an API key is the wrong key slot", () => {
    const e = classifyEngineError("anthropic", CC, { code: "bad-key", message: "This is a Claude sign-in token, not an API key." });
    assert.equal(e.kind, "wrong-key");
    assert.equal(e.state, "error");
    assert.match(e.message, /sign-in token/);
  });

  it("Tarsee's own refusals keep their code and words", () => {
    const iso = classifyEngineError("deepseek", CC, { code: "credential-isolation", message: "X is a sign-in file in a folder meant only for an API key." });
    assert.equal(iso.kind, "credential-isolation");
    assert.match(iso.message, /sign-in file/);
    const nk = classifyEngineError("deepseek", CC, { code: "needs-key", message: "DeepSeek needs its API key." });
    assert.equal(nk.kind, "needs-key");
    assert.equal(nk.state, "needs-key");
  });

  it("anything else is unknown, keeps the engine's words, and is not recoverable", () => {
    const e = classifyEngineError("openrouter", CC, { message: "something odd happened" });
    assert.equal(e.kind, "unknown");
    assert.equal(e.recoverable, false);
    assert.match(e.message, /something odd happened/);
  });

  it("an unknown provider still gets a sensible answer", () => {
    const e = classifyEngineError("nope", CC, { status: 401 });
    assert.equal(e.kind, "auth");
    assert.equal(typeof e.message, "string");
  });
});

describe("friendly, authMessage, failureStateFor, statusFromMessage", () => {
  it("every kind has words for every provider", () => {
    for (const id of ["claude", "anthropic", "chatgpt", "openai", "openrouter", "deepseek", "local"]) {
      for (const kind of ERROR_KINDS) {
        const text = friendly(id, kind, { detail: "detail words" });
        assert.equal(typeof text, "string");
        assert.ok(text.length > 10, `${id}/${kind}`);
        assert.doesNotMatch(text, /undefined|null/, `${id}/${kind}: ${text}`);
      }
    }
  });

  it("authMessage is the provider's own fix", () => {
    assert.match(authMessage("claude"), /`claude auth login`/);
    assert.match(authMessage("claude-code"), /`claude auth login`/);
    assert.match(authMessage("chatgpt"), /Sign in again in Settings > AI/);
    assert.match(authMessage("deepseek"), /DEEPSEEK_API_KEY/);
  });

  it("failure flags: expired, rejected key, out of credit, missing key; nothing for busy or a model", () => {
    assert.equal(failureStateFor("expired"), "sign-in-expired");
    assert.equal(failureStateFor("auth"), "error");
    assert.equal(failureStateFor("wrong-key"), "error");
    assert.equal(failureStateFor("billing"), "out-of-credit");
    assert.equal(failureStateFor("needs-key"), "needs-key");
    for (const k of ["rate", "unavailable", "model", "session", "unknown"]) assert.equal(failureStateFor(k), null, k);
  });

  it("reads a status out of the CLI's words", () => {
    assert.equal(statusFromMessage("API Error: 402 Insufficient Balance"), 402);
    assert.equal(statusFromMessage("API Error: Request rejected (429) · slow down"), 429);
    assert.equal(statusFromMessage("Failed to authenticate. API Error: 401 bad"), 401);
    assert.equal(statusFromMessage("all good, 200 apples"), null);
  });
});
