import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelRef, formatModelRef } from "../src/ai/model-ref.js";

// A model ref names a model on a provider: "deepseek:deepseek-flash",
// "openrouter:deepseek/deepseek-chat:free", or a bare "sonnet". OpenRouter and
// Ollama ids carry colons of their own, so a ref splits on the FIRST colon
// only, and only when what is in front of it is a provider Tarsee knows.

describe("parseModelRef", () => {
  it("keeps the colons inside an OpenRouter id", () => {
    assert.deepEqual(parseModelRef("openrouter:deepseek/x:free"), { provider: "openrouter", model: "deepseek/x:free" });
    assert.deepEqual(parseModelRef("openrouter:deepseek/deepseek-chat-v3.1:free"), { provider: "openrouter", model: "deepseek/deepseek-chat-v3.1:free" });
  });

  it("treats a model with no provider in front as bare", () => {
    assert.deepEqual(parseModelRef("deepseek/x:free"), { provider: null, model: "deepseek/x:free" });
    assert.deepEqual(parseModelRef("sonnet"), { provider: null, model: "sonnet" });
    assert.deepEqual(parseModelRef("~anthropic/claude-sonnet-latest"), { provider: null, model: "~anthropic/claude-sonnet-latest" });
  });

  it("treats an unknown prefix as part of a bare model", () => {
    assert.deepEqual(parseModelRef("llama3.1:8b"), { provider: null, model: "llama3.1:8b" });
    assert.deepEqual(parseModelRef("gemini:pro"), { provider: null, model: "gemini:pro" });
    assert.deepEqual(parseModelRef("deepseek-r1:7b"), { provider: null, model: "deepseek-r1:7b" });
    assert.deepEqual(parseModelRef(":sonnet"), { provider: null, model: ":sonnet" });
  });

  it("splits on a known provider id", () => {
    assert.deepEqual(parseModelRef("deepseek:deepseek-flash"), { provider: "deepseek", model: "deepseek-flash" });
    assert.deepEqual(parseModelRef("local:llama3.1:8b"), { provider: "local", model: "llama3.1:8b" });
    assert.deepEqual(parseModelRef("chatgpt:gpt-6-luna"), { provider: "chatgpt", model: "gpt-6-luna" });
    for (const id of ["claude", "anthropic", "chatgpt", "openai", "openrouter", "deepseek", "local"]) {
      assert.equal(parseModelRef(`${id}:m`).provider, id, id);
    }
  });

  it("reads the claude-code alias as the Claude plan, and ignores the prefix's case", () => {
    assert.deepEqual(parseModelRef("claude-code:sonnet"), { provider: "claude", model: "sonnet" });
    assert.deepEqual(parseModelRef("OpenRouter:anthropic/claude-sonnet-5"), { provider: "openrouter", model: "anthropic/claude-sonnet-5" });
  });

  it("gives a provider with no model a null model (the provider's default)", () => {
    assert.deepEqual(parseModelRef("openrouter:"), { provider: "openrouter", model: null });
    assert.deepEqual(parseModelRef("deepseek:   "), { provider: "deepseek", model: null });
  });

  it("trims, and gives nothing for nothing", () => {
    assert.deepEqual(parseModelRef("  deepseek:deepseek-flash  "), { provider: "deepseek", model: "deepseek-flash" });
    for (const empty of [undefined, null, "", "   "]) assert.deepEqual(parseModelRef(empty), { provider: null, model: null }, String(empty));
  });

  it("does not take a bare provider name for a provider", () => {
    assert.deepEqual(parseModelRef("openrouter"), { provider: null, model: "openrouter" });
  });
});

describe("formatModelRef", () => {
  it("writes provider:model with the public id", () => {
    assert.equal(formatModelRef("openrouter", "deepseek/x:free"), "openrouter:deepseek/x:free");
    assert.equal(formatModelRef("claude-code", "sonnet"), "claude:sonnet");
    assert.equal(formatModelRef({ provider: "deepseek", model: "deepseek-flash" }), "deepseek:deepseek-flash");
  });

  it("writes a bare model when there is no provider, and provider: when there is no model", () => {
    assert.equal(formatModelRef(null, "sonnet"), "sonnet");
    assert.equal(formatModelRef({ provider: null, model: "sonnet" }), "sonnet");
    assert.equal(formatModelRef("openrouter", null), "openrouter:");
    assert.equal(formatModelRef(null, null), "");
  });

  it("refuses a provider Tarsee does not know", () => {
    assert.throws(() => formatModelRef("gemini", "pro"), /unknown provider/i);
  });

  it("refuses a bare model that would read back as another provider's (a local model named deepseek:7b)", () => {
    for (const model of ["deepseek:7b", "openai:latest", "claude-code:x", "OpenRouter:y", " local:z "]) {
      assert.throws(() => formatModelRef(null, model), /provider/i, model);
      assert.throws(() => formatModelRef({ provider: null, model }), /provider/i, model);
    }
    // Named with its provider, the same model round-trips.
    assert.deepEqual(parseModelRef(formatModelRef("local", "deepseek:7b")), { provider: "local", model: "deepseek:7b" });
  });

  it("round-trips a bare model whenever it writes one", () => {
    for (const model of ["sonnet", "llama3.1:8b", "deepseek-r1:7b", "gemini:pro", "deepseek/x:free", ":odd", ""]) {
      const ref = formatModelRef(null, model);
      assert.deepEqual(parseModelRef(ref), { provider: null, model: model || null }, model);
    }
  });

  it("round-trips through parseModelRef", () => {
    const models = ["sonnet", "deepseek/x:free", "llama3.1:8b", "~anthropic/claude-sonnet-latest", "a:b:c", null];
    for (const provider of ["claude", "anthropic", "chatgpt", "openai", "openrouter", "deepseek", "local"]) {
      for (const model of models) {
        assert.deepEqual(parseModelRef(formatModelRef(provider, model)), { provider, model }, `${provider} ${model}`);
      }
    }
  });
});
