// The words a channel shows while a tool runs ("⚙️ Sending file…") and when it ends ("✓ File sent"). Tarsee's own
// tools reach the channels as mcp__tarsee__tarsee_*, which used to show raw, and a Windows path showed whole.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolStatusLabel, toolDoneLabel } from "../src/lib/tool-status.js";

describe("tool status labels", () => {
  it("names Tarsee's own tools in words, not as mcp__tarsee__tarsee_*", () => {
    assert.equal(toolStatusLabel("mcp__tarsee__tarsee_send_file", { file_path: "/data/report.pdf" }), "Sending report.pdf…");
    assert.equal(toolDoneLabel("mcp__tarsee__tarsee_send_file", { file_path: "/data/report.pdf" }), "Sent report.pdf");
    assert.equal(toolDoneLabel("mcp__tarsee__tarsee_send_file", { file_path: "/data/report.pdf" }, true), "Sending report.pdf failed");
    assert.equal(toolStatusLabel("mcp__tarsee__tarsee_send_message", {}), "Sending a message…");
    assert.equal(toolDoneLabel("mcp__tarsee__tarsee_send_message", {}), "Message sent");
    assert.equal(toolStatusLabel("mcp__tarsee__tarsee_web_search", { query: "secret plans" }), "Web searching…");
    assert.equal(toolStatusLabel("mcp__tarsee__tarsee_web_fetch", { url: "https://x.test/?token=abc" }), "Fetching URL…");
    assert.equal(toolStatusLabel("mcp__tarsee__tarsee_remember", { content: "x" }), "Saving a memory…");
    assert.equal(toolDoneLabel("mcp__tarsee__tarsee_remember", {}), "Memory saved");
    assert.equal(toolStatusLabel("mcp__tarsee__tarsee_search_memories_deep", {}), "Searching memories…");
    assert.equal(toolStatusLabel("mcp__tarsee__tarsee_read_file", { filename: "memory/2026-04-05.md" }), "Reading 2026-04-05.md…");
    assert.equal(toolDoneLabel("mcp__tarsee__tarsee_write_file", { filename: "MEMORY.md" }), "Wrote MEMORY.md");
    assert.equal(toolStatusLabel("mcp__tarsee__tarsee_schedule_task", {}), "Scheduling a task…");
    assert.equal(toolStatusLabel("mcp__tarsee__tarsee_browser", {}), "Using the browser…");
  });

  it("never shows a key's name or value", () => {
    for (const name of ["tarsee_get_key", "tarsee_set_key", "tarsee_delete_key", "tarsee_list_keys"]) {
      const input = { key: "STRIPE_SECRET", value: "sk_live_123" };
      for (const label of [toolStatusLabel(`mcp__tarsee__${name}`, input), toolDoneLabel(`mcp__tarsee__${name}`, input), toolDoneLabel(`mcp__tarsee__${name}`, input, true)]) {
        assert.ok(!/STRIPE|sk_live|mcp__|tarsee_/.test(label), `${name}: ${label}`);
      }
    }
  });

  it("shows any other MCP tool by its own name, without the mcp__server__ prefix", () => {
    assert.equal(toolStatusLabel("mcp__github__list_pull_requests", {}), "Running list pull requests…");
    assert.equal(toolDoneLabel("mcp__github__list_pull_requests", {}), "list pull requests done");
    assert.equal(toolDoneLabel("mcp__github__list_pull_requests", {}, true), "list pull requests failed");
  });

  it("shortens a Windows path to its file name too", () => {
    assert.equal(toolStatusLabel("Write", { file_path: "C:\\Users\\me\\workspace\\notes.txt" }), "Writing notes.txt…");
    assert.equal(toolDoneLabel("Read", { file_path: "C:\\Users\\me\\workspace\\notes.txt" }), "Read notes.txt");
    assert.equal(toolStatusLabel("Edit", { file_path: "/data/tarsee/workspace/SOUL.md" }), "Editing SOUL.md…");
  });

  it("keeps the built-in tools' words", () => {
    assert.equal(toolStatusLabel("Bash", { command: "cat .env" }), "Running command…");
    assert.equal(toolDoneLabel("Bash", {}), "Command done");
    assert.equal(toolDoneLabel("Bash", {}, true), "Command failed");
    assert.equal(toolStatusLabel("SomethingNew", {}), "Running SomethingNew…");
  });
});
