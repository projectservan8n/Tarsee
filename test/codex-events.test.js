// The Codex engine's event mapping (src/ai/providers/codex-events.js, design 4.8 "Event mapping"): what the Codex SDK
// streams becomes Tarsee's events, with Claude Code's tool names so the live view, the tool status lines and the loop
// guard need nothing new. Most cases replay JSONL captured from the real pinned codex binary
// (test/fixtures/codex/, made by capture.mjs against the fake Responses server); the few item kinds a Tarsee turn
// can't make Codex 0.167 produce (a to-do list, a web search) are written out from the SDK's own types.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCodexEventState, mapCodexEvent, finishCodexEvents, unwrapShellCommand, usageDelta, classifyCodexFailure,
} from "../src/ai/providers/codex-events.js";
import { authMessage } from "../src/ai/engine-errors.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));

/** Run a captured turn through the mapper: the SDK's own throw at the end ("x-sdk-threw") is what finish() sees. */
function replay(name, opts = {}) {
  const state = createCodexEventState({ providerId: "openrouter", model: "openai/gpt-6.1-sol", ...opts });
  const out = [];
  let thrown = null;
  for (const ev of fixture(name)) {
    if (ev.type === "x-sdk-threw") { thrown = new Error(ev.message); continue; }
    out.push(...mapCodexEvent(ev, state));
  }
  out.push(...finishCodexEvents(state, { error: thrown }));
  return { out, state };
}

const of = (out, type) => out.filter((e) => e.type === type);
const steps = (out, kind) => out.filter((e) => e.type === "step" && e.kind === kind);

describe("captured turns", () => {
  it("a plain answer: the thinking summary, the words, the usage, one done", () => {
    const { out, state } = replay("text-reply");
    assert.equal(state.threadId, fixture("text-reply")[0].thread_id);
    assert.deepEqual(of(out, "thinking").map((e) => e.status), ["start", "stop"]);
    assert.deepEqual(steps(out, "thinking").map((s) => s.text), ["Weighing a friendly greeting."]);
    assert.deepEqual(of(out, "text").map((e) => e.content), ["Hello from the fake."]);
    assert.deepEqual(steps(out, "text").map((s) => s.text), ["Hello from the fake."]);
    // input_tokens counts the cached part too: the uncached rest is input, the cached part cache reads.
    assert.deepEqual(of(out, "usage")[0].usage, { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 30 });
    assert.deepEqual(of(out, "done"), [{ type: "done", stopReason: "end_turn" }]);
    assert.equal(out.at(-1).type, "done");
    assert.equal(of(out, "error").length, 0);
    // Codex's note that it has no metadata for an unlisted model is noise on every OpenRouter or Local AI turn.
    assert.equal(steps(out, "status").length, 0);
  });

  it("every tool kind, with Claude Code's names, paired ids and honest ok flags", () => {
    const { out, state } = replay("tools");
    const uses = of(out, "tool_use");
    const results = of(out, "tool_result");
    assert.deepEqual(uses.map((u) => u.name), ["Bash", "Bash", "mcp__tarsee__tarsee_datetime", "mcp__tarsee__tarsee_fail", "Write", "Edit", "Edit"]);
    assert.deepEqual(uses.map((u) => u.id), results.map((r) => r.id), "each use has its result, in order");
    assert.equal(new Set(uses.map((u) => u.id)).size, uses.length, "ids are unique");
    assert.deepEqual(results.map((r) => r.ok), [true, false, true, false, true, true, true]);
    // The shell's own wrapper (PowerShell here, bash -lc on Linux) is taken off the command.
    assert.equal(uses[0].input.command, "node -e \"console.log('hi from the shell')\"");
    assert.equal(results[0].result, "hi from the shell\n");
    assert.deepEqual(uses[2].input, { timezone: "UTC" });
    assert.match(results[2].result, /09:00 UTC \(stub\)/);
    assert.match(results[3].result, /always fails/);
    assert.deepEqual(uses.slice(4).map((u) => path.basename(u.input.file_path.replace(/\\/g, "/"))), ["notes.txt", "readme.txt", "stale.txt"]);
    assert.equal(uses[6].input.change, "delete");
    for (const r of results) assert.ok(r.result.length <= 2000);
    // The live view: a tool_start when each began, a tool_end when it finished, the same ids.
    const starts = steps(out, "tool_start");
    const ends = steps(out, "tool_end");
    assert.deepEqual(starts.map((s) => s.id), uses.map((u) => u.id));
    assert.deepEqual(ends.map((s) => s.id), results.map((r) => r.id));
    assert.equal(starts[2].name, "tarsee_datetime");
    assert.equal(starts[0].rawName, "Bash");
    // Tools started, for maxTurns: two commands, two MCP calls, one patch.
    assert.equal(state.toolCount, 5);
    assert.deepEqual(of(out, "text").map((e) => e.content), ["All done."]);
    assert.deepEqual(of(out, "done"), [{ type: "done", stopReason: "end_turn" }]);
  });

  it("a resumed thread: Codex reports the thread's running total, so the turn's usage is the difference", () => {
    const first = replay("resume-1");
    const t1 = first.state.totals;
    assert.deepEqual(t1, { input_tokens: 1000, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 });
    // Settled against the real binary: the second turn's turn.completed carries both turns' tokens.
    const raw2 = fixture("resume-2").find((e) => e.type === "turn.completed").usage;
    assert.equal(raw2.input_tokens, 2500, "cumulative across the resumed thread");
    const second = replay("resume-2", { baseline: t1 });
    assert.deepEqual(of(second.out, "usage")[0].usage, { input_tokens: 600, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 20 });
    assert.equal(second.state.totals.input_tokens, 2500, "the new running total, for the next turn");
    // Without the baseline the whole total would be charged again.
    assert.equal(of(replay("resume-2").out, "usage")[0].usage.input_tokens, 1500);
  });

  it("a refused key: the provider's own fix, an error, done auth-expired; the retries are status lines", () => {
    const { out } = replay("auth-401");
    const status = steps(out, "status");
    assert.equal(status.length, 5);
    assert.match(status[0].text, /401/);
    assert.match(status[0].text, /1 of 5/);
    const msg = authMessage("openrouter");
    assert.deepEqual(of(out, "text").map((e) => e.content), [msg]);
    const [err] = of(out, "error");
    assert.equal(err.message, msg);
    assert.equal(err.code, "auth");
    assert.equal(err.recoverable, false);
    assert.deepEqual(of(out, "done"), [{ type: "done", stopReason: "auth-expired" }]);
    assert.equal(out.at(-1).type, "done");
  });

  it("the same refusal on the ChatGPT plan is its sign-in running out", () => {
    const { out } = replay("auth-401", { providerId: "chatgpt", model: null });
    assert.equal(of(out, "error")[0].code, "expired");
    assert.equal(of(out, "text")[0].content, authMessage("chatgpt"));
    assert.deepEqual(of(out, "done"), [{ type: "done", stopReason: "auth-expired" }]);
  });

  it("out of credit and busy are classified, with an error before the one done", () => {
    for (const [name, code] of [["quota", "billing"], ["rate-limit", "rate"]]) {
      const { out } = replay(name);
      const errors = of(out, "error");
      assert.equal(errors.length, 1, name);
      assert.equal(errors[0].code, code, name);
      assert.equal(errors[0].recoverable, false, name);
      assert.deepEqual(of(out, "done"), [{ type: "done", stopReason: "error" }], name);
      assert.equal(of(out, "text").length, 0, name);
      assert.ok(out.indexOf(errors[0]) < out.findIndex((e) => e.type === "done"), name);
    }
  });

  it("Local AI that isn't running: where it was looked for", () => {
    const { out } = replay("unreachable", { providerId: "local", model: "llama3.1:8b", localUrl: "http://127.0.0.1:9/v1" });
    const [err] = of(out, "error");
    assert.equal(err.code, "unavailable");
    assert.match(err.message, /Can't reach your Local AI at http:\/\/127\.0\.0\.1:9\/v1/);
    assert.deepEqual(of(out, "done"), [{ type: "done", stopReason: "error" }]);
  });
});

describe("item kinds and edge cases", () => {
  const run = (events, opts = {}) => {
    const state = createCodexEventState({ providerId: "openai", model: "gpt-6.1-sol", ...opts });
    const out = [];
    for (const ev of events) out.push(...mapCodexEvent(ev, state));
    return { out, state };
  };

  it("a to-do list is TodoWrite each time it changes; a web search is WebSearch", () => {
    const items = (done) => [{ text: "Read the file", completed: done }, { text: "Answer", completed: false }];
    const { out } = run([
      { type: "item.started", item: { id: "t1", type: "todo_list", items: items(false) } },
      { type: "item.updated", item: { id: "t1", type: "todo_list", items: items(false) } },
      { type: "item.updated", item: { id: "t1", type: "todo_list", items: items(true) } },
      { type: "item.completed", item: { id: "t1", type: "todo_list", items: items(true) } },
      { type: "item.started", item: { id: "w1", type: "web_search", query: "tarsier facts" } },
      { type: "item.completed", item: { id: "w1", type: "web_search", query: "tarsier facts" } },
    ]);
    const uses = of(out, "tool_use");
    assert.deepEqual(uses.map((u) => u.name), ["TodoWrite", "TodoWrite", "WebSearch"]);
    assert.deepEqual(uses[1].input.todos, [{ content: "Read the file", status: "completed", activeForm: "Read the file" }, { content: "Answer", status: "pending", activeForm: "Answer" }]);
    assert.deepEqual(uses[2].input, { query: "tarsier facts" });
    assert.deepEqual(of(out, "tool_result").map((r) => r.id), uses.map((u) => u.id));
  });

  it("several messages are one reply with a blank line between them; reasoning that started is stopped once", () => {
    const { out } = run([
      { type: "item.started", item: { id: "r1", type: "reasoning", text: "" } },
      { type: "item.completed", item: { id: "r1", type: "reasoning", text: "Plan the answer." } },
      { type: "item.completed", item: { id: "m1", type: "agent_message", text: "First." } },
      { type: "item.completed", item: { id: "m2", type: "agent_message", text: "Second." } },
    ]);
    assert.deepEqual(of(out, "thinking").map((e) => e.status), ["start", "stop"]);
    assert.deepEqual(of(out, "text").map((e) => e.content), ["First.", "\n\nSecond."]);
  });

  it("a tool that only reports its end still gets its start, and a secret in a step is redacted", () => {
    const { out } = run([
      { type: "item.completed", item: { id: "c9", type: "command_execution", command: "/bin/bash -lc 'echo sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'", aggregated_output: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n", exit_code: 0, status: "completed" } },
    ]);
    assert.deepEqual(out.filter((e) => e.type === "tool_use" || e.type === "tool_result").map((e) => e.type), ["tool_use", "tool_result"]);
    assert.equal(of(out, "tool_use")[0].input.command, "echo sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    for (const s of out.filter((e) => e.type === "step")) assert.ok(!JSON.stringify(s).includes("sk-ant-api03-AAAA"), JSON.stringify(s));
  });

  it("an error event that isn't followed by turn.failed still ends the turn with an error and one done", () => {
    const { out, state } = run([
      { type: "thread.started", thread_id: "th-1" },
      { type: "turn.started" },
      { type: "error", message: "stream disconnected before completion: connection reset" },
    ]);
    assert.equal(of(out, "done").length, 0);
    const end = finishCodexEvents(state, {});
    assert.deepEqual(end.map((e) => e.type), ["error", "done"]);
    assert.equal(end[0].code, "unavailable");
    assert.deepEqual(finishCodexEvents(state, {}), [], "never a second done");
  });

  it("a thread that can't be resumed is recoverable: the turn layer starts fresh with the conversation handed over", () => {
    const state = createCodexEventState({ providerId: "openai", model: "gpt-6.1-sol" });
    const end = finishCodexEvents(state, { error: new Error("Codex Exec exited with code 1: Error: thread/resume: thread/resume failed: no rollout found for thread id 01a1 (code -32600)") });
    assert.equal(end[0].type, "error");
    assert.equal(end[0].recoverable, true);
    assert.equal(end[0].code, "session");
    assert.deepEqual(end[1], { type: "done", stopReason: "error" });
  });

  it("finish: Stop gives done aborted and no error; the turn limit gives error_max_turns; open tools are closed", () => {
    const opened = () => run([{ type: "item.started", item: { id: "c1", type: "command_execution", command: "sleep 30", aggregated_output: "", status: "in_progress" } }]).state;
    const noSteps = (list) => list.filter((e) => e.type !== "step");
    const stopped = noSteps(finishCodexEvents(opened(), { aborted: true }));
    assert.deepEqual(stopped.map((e) => e.type), ["tool_result", "done"]);
    assert.equal(stopped[0].ok, false);
    assert.deepEqual(stopped[1], { type: "done", stopReason: "aborted" });
    const limited = noSteps(finishCodexEvents(opened(), { maxTurns: 3 }));
    assert.deepEqual(limited.map((e) => e.type), ["tool_result", "error", "done"]);
    assert.equal(limited[1].subtype, "error_max_turns");
    assert.match(limited[1].message, /3/);
    assert.deepEqual(limited[2], { type: "done", stopReason: "max_turns" });
    // A turn that finished needs nothing more; an engine that ended with nothing at all says so.
    const silent = finishCodexEvents(createCodexEventState({ providerId: "openai" }), {});
    assert.deepEqual(silent.map((e) => e.type), ["error", "done"]);
    assert.equal(silent[1].stopReason, "error");
  });

  it("the binary missing, or exiting on its own, reads as a plain explanation", () => {
    const missing = finishCodexEvents(createCodexEventState({ providerId: "openai" }), { error: new Error("Unable to locate Codex CLI binaries. Ensure @openai/codex is installed with optional dependencies.") });
    assert.match(missing[0].message, /Codex isn't installed/);
    const exited = finishCodexEvents(createCodexEventState({ providerId: "openai" }), { error: new Error("Codex Exec exited with code 2: WARNING: proceeding, even though we could not create PATH aliases: x\nReading prompt from stdin...\nError: bad config value") });
    assert.match(exited[0].message, /bad config value/);
    assert.doesNotMatch(exited[0].message, /PATH aliases|Reading prompt/);
  });
});

describe("helpers", () => {
  it("unwrapShellCommand takes off the shells Codex wraps a command in, and leaves anything else alone", () => {
    assert.equal(unwrapShellCommand("/bin/bash -lc 'ls -la'"), "ls -la");
    assert.equal(unwrapShellCommand("/bin/bash -lc \"node -e \\\"x\\\"\""), "node -e \"x\"");
    assert.equal(unwrapShellCommand("bash -c 'a && b'"), "a && b");
    assert.equal(unwrapShellCommand("/usr/bin/zsh -lc 'pwd'"), "pwd");
    assert.equal(unwrapShellCommand("\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"Get-Date\""), "Get-Date");
    assert.equal(unwrapShellCommand("pwsh -NoProfile -Command \"dir\""), "dir");
    assert.equal(unwrapShellCommand("git status"), "git status");
    assert.equal(unwrapShellCommand(""), "");
  });

  it("usageDelta subtracts a baseline, never below zero, and a missing baseline is none", () => {
    const now = { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 2 };
    assert.deepEqual(usageDelta(now, null), now);
    assert.deepEqual(usageDelta(now, { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 }), { input_tokens: 7, cached_input_tokens: 3, cache_write_input_tokens: 1, output_tokens: 3, reasoning_output_tokens: 2 });
    // A baseline bigger than now (a compacted or replaced thread) can't make usage negative.
    assert.equal(usageDelta(now, { input_tokens: 99 }).input_tokens, 10);
  });

  it("classifyCodexFailure reads the status out of Codex's words and uses engine-errors' meaning", () => {
    assert.equal(classifyCodexFailure("openai", "unexpected status 402 Payment Required: x").kind, "billing");
    assert.equal(classifyCodexFailure("openai", "unexpected status 404 Not Found: The model `nope` does not exist", { model: "nope" }).kind, "model");
    assert.equal(classifyCodexFailure("deepseek", "exceeded retry limit, last status: 503 Service Unavailable").kind, "unavailable");
    assert.equal(classifyCodexFailure("chatgpt", "You've hit your usage limit. subscription_sharing_usage_limit_exceeded").kind, "rate");
  });

  it("every way codex 0.167 says the ChatGPT sign-in couldn't be renewed is the sign-in running out", () => {
    // codex-rs/login/src/auth/manager.rs and cloud-config/src/chatgpt.rs: what the pinned codex writes when it can't
    // renew the ChatGPT sign-in. Each must give the plan's own "sign in again" words and turn the card sign-in-expired,
    // not "ChatGPT ran into a problem".
    for (const message of [
      "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      "Your access token could not be refreshed. Please log out and sign in again.",
      "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
      "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
    ]) {
      const e = classifyCodexFailure("chatgpt", message);
      assert.equal(e.kind, "expired", message);
      assert.equal(e.message, authMessage("chatgpt"), message);
    }
  });
});
