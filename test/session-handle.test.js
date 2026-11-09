// Session handles (src/ai/session-handle.js, design 4.10): the value stored in conversations.claude_session_id. The
// Claude plan keeps the bare raw id (every existing row stays valid); every other provider stores
// <provider>/<homeKey>/<vendor>:<rawId>, so a session is only ever resumed by the same provider, in the same engine
// home, on the same model maker. Anything else starts fresh (the turn layer then adds the handoff).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { format, parse, sessionFor, untag, vendorFor } from "../src/ai/session-handle.js";

const RAW = "3f2a9c1e-0b7d-4f43-9a51-2c8e7d6b1a00";
const T = {
  claude: { provider: "claude", engine: "claude-code" },
  claudeStored: { provider: "claude-code", engine: "claude-code" },
  anthropic: { provider: "anthropic", engine: "claude-code", model: "claude-sonnet-4-5" },
  deepseek: { provider: "deepseek", engine: "claude-code", model: "deepseek-flash[1m]" },
  deepseekCodex: { provider: "deepseek", engine: "codex", model: "deepseek-flash[1m]" },
  orAnthropic: { provider: "openrouter", engine: "claude-code", model: "~anthropic/claude-sonnet-latest" },
  orAnthropicOpus: { provider: "openrouter", engine: "claude-code", model: "anthropic/claude-opus-4" },
  orOpenai: { provider: "openrouter", engine: "codex", model: "openai/gpt-6.1-sol" },
  orGoogle: { provider: "openrouter", engine: "codex", model: "google/gemini-3-pro" },
  chatgpt: { provider: "chatgpt", engine: "codex", model: "gpt-6-luna" },
  openai: { provider: "openai", engine: "codex", model: "gpt-6.1-sol" },
  local: { provider: "local", engine: "codex", model: "qwen3:32b" },
};

describe("session handles", () => {
  it("the Claude plan stores the bare raw id (legacy rows need no rewrite)", () => {
    assert.equal(format(T.claude, RAW), RAW);
    assert.equal(format(T.claudeStored, RAW), RAW);
  });

  it("every other provider stores <provider>/<homeKey>/<vendor>:<rawId>", () => {
    assert.equal(format(T.anthropic, RAW), `anthropic/cc/anthropic:${RAW}`);
    assert.equal(format(T.deepseek, RAW), `deepseek/cc/deepseek:${RAW}`);
    assert.equal(format(T.deepseekCodex, RAW), `deepseek/cx/deepseek:${RAW}`);
    assert.equal(format(T.orAnthropic, RAW), `openrouter/cc/anthropic:${RAW}`);
    assert.equal(format(T.orOpenai, RAW), `openrouter/cx/openai:${RAW}`);
    assert.equal(format(T.chatgpt, RAW), `chatgpt/cxd/chatgpt:${RAW}`);
    assert.equal(format(T.openai, RAW), `openai/cx/openai:${RAW}`);
    assert.equal(format(T.local, RAW), `local/cx/local:${RAW}`);
  });

  it("an explicit homeKey and vendor on the target win", () => {
    assert.equal(format({ provider: "openrouter", homeKey: "cx", vendor: "Meta-Llama" }, RAW), `openrouter/cx/meta-llama:${RAW}`);
  });

  it("no raw id means no handle", () => {
    assert.equal(format(T.deepseek, ""), null);
    assert.equal(format(T.claude, null), null);
  });

  it("never stores a handle it couldn't read back: a raw id with a space (or, bare, a slash) is refused", () => {
    assert.throws(() => format(T.deepseek, "a b"), /session-handle/);
    assert.throws(() => format(T.openai, "tab\there"), /session-handle/);
    assert.throws(() => format(T.claude, "x/y"), /session-handle/);
    assert.throws(() => format(T.claude, "a b"), /session-handle/);
    // A slash is fine inside a tagged handle: everything after the vendor's colon is the raw id.
    assert.equal(untag(format(T.deepseek, "x/y")), "x/y");
  });

  it("round-trips: every handle it stores parses back to the same raw id and place", () => {
    const raws = [RAW, "thread:with:colons", "x/y", "a.b-c_d", "UPPER-Case-9", "~tilde", "été"];
    for (const [name, target] of Object.entries(T)) {
      for (const raw of raws) {
        let handle;
        try { handle = format(target, raw); } catch { continue; } // refused: never stored
        const parsed = parse(handle);
        assert.ok(parsed, `${name} ${raw}: ${handle} doesn't parse`);
        assert.equal(parsed.rawId, raw, `${name} ${raw}`);
        assert.equal(sessionFor(handle, target), raw, `${name} ${raw}: doesn't resume on its own target`);
      }
    }
  });

  it("a provider the registry doesn't know can't be placed, even with a home key", () => {
    assert.throws(() => format({ provider: "nobody", homeKey: "cx" }, RAW), /session-handle/);
  });

  it("vendorFor: the maker on OpenRouter (without ~), otherwise the provider", () => {
    assert.equal(vendorFor("openrouter", "~anthropic/claude-sonnet-latest"), "anthropic");
    assert.equal(vendorFor("openrouter", "deepseek/deepseek-chat:free"), "deepseek");
    assert.equal(vendorFor("openrouter", "OpenAI/gpt-6"), "openai");
    assert.equal(vendorFor("openrouter", "auto"), "openrouter");
    assert.equal(vendorFor("deepseek", "deepseek-flash[1m]"), "deepseek");
    assert.equal(vendorFor("claude-code", "sonnet"), "claude");
  });

  it("parse: a bare id is the Claude plan's; a tagged one splits into its parts", () => {
    assert.deepEqual(parse(RAW), { provider: "claude", engine: "claude-code", homeKey: "cc", vendor: "claude", rawId: RAW, tagged: false });
    assert.deepEqual(parse(`openrouter/cx/openai:${RAW}`), { provider: "openrouter", engine: "codex", homeKey: "cx", vendor: "openai", rawId: RAW, tagged: true });
    assert.deepEqual(parse(`chatgpt/cxd/chatgpt:${RAW}`), { provider: "chatgpt", engine: "codex", homeKey: "cxd", vendor: "chatgpt", rawId: RAW, tagged: true });
  });

  it("parse: nothing, or a malformed tag, gives null", () => {
    for (const bad of [null, undefined, "", "   ", 42, "deepseek/zz/deepseek:abc", "deepseek/cc/deepseek:", "deepseek/cc:abc", "a/b", "has space"]) {
      assert.equal(parse(bad), null, JSON.stringify(bad));
    }
  });

  it("sessionFor: the Claude plan resumes a bare id, and never a tagged one", () => {
    assert.equal(sessionFor(RAW, T.claude), RAW);
    assert.equal(sessionFor(RAW, T.claudeStored), RAW);
    assert.equal(sessionFor(`deepseek/cc/deepseek:${RAW}`, T.claude), null);
    assert.equal(sessionFor(`claude/cc/claude:${RAW}`, T.claude), null);
  });

  it("sessionFor: a bare id is foreign to every other provider", () => {
    for (const key of ["anthropic", "deepseek", "orAnthropic", "chatgpt", "openai", "local"]) {
      assert.equal(sessionFor(RAW, T[key]), null, key);
    }
  });

  it("sessionFor: the same provider, home and vendor resume; a foreign provider, home or vendor gives null", () => {
    assert.equal(sessionFor(format(T.deepseek, RAW), T.deepseek), RAW);
    assert.equal(sessionFor(format(T.orAnthropic, RAW), T.orAnthropicOpus), RAW, "same maker, other model: resume");
    assert.equal(sessionFor(format(T.deepseek, RAW), T.anthropic), null, "foreign provider");
    assert.equal(sessionFor(format(T.deepseek, RAW), T.deepseekCodex), null, "foreign home (engine switch)");
    assert.equal(sessionFor(format(T.orAnthropic, RAW), T.orOpenai), null, "foreign home and vendor");
    assert.equal(sessionFor(`openrouter/cx/openai:${RAW}`, T.orGoogle), null, "foreign vendor, same home");
    assert.equal(sessionFor(`openai/cx/openai:${RAW}`, T.chatgpt), null, "foreign provider on Codex");
    assert.equal(sessionFor(`chatgpt/cx/chatgpt:${RAW}`, T.chatgpt), null, "the key home is foreign to the sign-in home");
  });

  it("sessionFor: no handle, or a target it can't place, gives null", () => {
    assert.equal(sessionFor(null, T.deepseek), null);
    assert.equal(sessionFor("", T.claude), null);
    assert.equal(sessionFor(`deepseek/cc/deepseek:${RAW}`, null), null);
    assert.equal(sessionFor(`deepseek/cc/deepseek:${RAW}`, { provider: "deepseek" }), null, "no engine or homeKey");
  });

  it("untag round-trips for every provider, and leaves a bare id as it is", () => {
    for (const target of Object.values(T)) assert.equal(untag(format(target, RAW)), RAW, JSON.stringify(target));
    assert.equal(untag(RAW), RAW);
    const colons = "thread:with:colons";
    assert.equal(untag(format(T.openai, colons)), colons);
    assert.equal(sessionFor(format(T.openai, colons), T.openai), colons);
  });

  it("untag: nothing or a malformed tag gives null", () => {
    assert.equal(untag(null), null);
    assert.equal(untag(""), null);
    assert.equal(untag("deepseek/zz/deepseek:abc"), null);
  });
});
