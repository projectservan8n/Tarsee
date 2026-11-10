#!/usr/bin/env node
/**
 * Re-captures the Codex JSONL fixtures in this folder from the REAL pinned codex binary (@openai/codex 0.167.0, the
 * one @openai/codex-sdk starts), run with Tarsee's own options (providers/codex-options.js) against the fake
 * Responses server (../fake-responses.js) and the MCP stub (../mcp-stub.js). No network, no real key: every key here
 * is an obvious fake. Run it after a Codex bump:
 *
 *   node test/fixtures/codex/capture.mjs
 *
 * Each file is one turn's events exactly as the SDK hands them to providers/codex.js, one JSON object a line, with the
 * temporary folders replaced by "<tmp>" (so no machine's paths end up in the repo). test/codex-events.test.js maps
 * them; what each one shows is in SCENARIOS below.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Codex } from "@openai/codex-sdk";
import { startFakeResponses } from "../fake-responses.js";
import { startMcpStub } from "../mcp-stub.js";
import { buildCodexOptions } from "../../../src/ai/providers/codex-options.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = "sk-test-canary-local-key";
const MCP_TOKEN = "mcp-test-token-capture";

const node = (code) => `node -e "${code}"`;
const PATCH = [
  "*** Begin Patch",
  "*** Add File: notes.txt",
  "+first line",
  "*** Update File: readme.txt",
  "@@",
  "-old words",
  "+new words",
  "*** Delete File: stale.txt",
  "*** End Patch",
  "",
].join("\n");

/** name -> { model, prep?(ws), turns: [handler per turn], why } */
const SCENARIOS = {
  "text-reply": {
    why: "a plain answer with a reasoning summary, on a model Codex has no metadata for (an error item it carries on with)",
    model: "test-model",
    turns: [() => ({ reasoning: "Weighing a friendly greeting.", text: "Hello from the fake.", usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 30, reasoning_output_tokens: 12 } })],
  },
  "tools": {
    why: "every tool kind a Tarsee turn sees: a command that works, one that fails, Tarsee's MCP tool, one that errors, a patch that adds, updates and deletes, then the answer",
    model: "gpt-5.5",
    prep: (ws) => {
      fs.writeFileSync(path.join(ws, "readme.txt"), "old words\n");
      fs.writeFileSync(path.join(ws, "stale.txt"), "bye\n");
    },
    turns: [(body, { index }) => {
      switch (index) {
        case 0: return { calls: [{ name: "exec_command", arguments: { cmd: node("console.log('hi from the shell')") } }] };
        case 1: return { calls: [{ name: "exec_command", arguments: { cmd: node("console.error('nope'); process.exit(3)") } }] };
        case 2: return { calls: [{ name: "tarsee_datetime", namespace: "mcp__tarsee", arguments: { timezone: "UTC" } }] };
        case 3: return { calls: [{ name: "tarsee_fail", namespace: "mcp__tarsee", arguments: {} }] };
        case 4: return { calls: [{ type: "custom", name: "apply_patch", input: PATCH }] };
        default: return { reasoning: "Everything ran.", text: "All done.", usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 80 } };
      }
    }],
  },
  "resume": {
    why: "two turns on one thread: the second resumes it, and its usage is the thread's running total (cumulative)",
    model: "test-model",
    turns: [
      () => ({ text: "First answer.", usage: { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 10 } }),
      () => ({ text: "Second answer.", usage: { input_tokens: 1500, cached_input_tokens: 900, output_tokens: 20 } }),
    ],
  },
  "auth-401": {
    why: "the provider refuses the key: Codex retries five times, then the turn fails",
    model: "test-model",
    turns: [() => ({ status: 401, error: { message: "Incorrect API key provided: sk-test***", type: "invalid_request_error", code: "invalid_api_key" } })],
  },
  "quota": {
    why: "the provider fails the response for want of credit (response.failed insufficient_quota)",
    model: "test-model",
    turns: [() => ({ failed: { code: "insufficient_quota", message: "You exceeded your current quota" } })],
  },
  "rate-limit": {
    why: "the provider is busy (429): Codex retries, then the turn fails",
    model: "test-model",
    turns: [() => ({ status: 429, error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" } })],
  },
  "unreachable": {
    why: "Local AI's server isn't running (nothing listens at its address): Codex retries, then the turn fails",
    model: "llama3.1:8b",
    localUrl: "http://127.0.0.1:9/v1",
    turns: [() => ({ text: "never asked" })],
  },
};

async function capture(name, scenario) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-codex-capture-"));
  const ws = path.join(tmp, "workspace");
  fs.mkdirSync(ws);
  scenario.prep?.(ws);
  let turn = 0;
  const fake = await startFakeResponses({ handler: (body, info) => scenario.turns[turn](body, { ...info, index: info.index - (scenario.offsets?.[turn] ?? 0) }) });
  const mcp = await startMcpStub({ token: MCP_TOKEN });
  try {
    const o = buildCodexOptions({ providerId: "local", model: scenario.model }, {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME },
      stateDir: tmp, workspace: ws, mcp: { url: mcp.url, token: MCP_TOKEN }, key: KEY, localUrl: scenario.localUrl || fake.url,
      developerInstructions: "You are Tarsee (capture run).", contextTokens: 128_000,
    });
    fs.mkdirSync(o.home, { recursive: true });
    const codex = new Codex({ env: o.env, config: o.config });
    let thread = null;
    for (let i = 0; i < scenario.turns.length; i++) {
      turn = i;
      scenario.offsets = { ...(scenario.offsets || {}), [i]: fake.responses().length };
      thread = i === 0 ? codex.startThread(o.threadOptions) : codex.resumeThread(thread.id, o.threadOptions);
      const lines = [];
      try {
        const { events } = await thread.runStreamed(i === 0 ? "Please help." : "And again.");
        for await (const ev of events) lines.push(JSON.stringify(ev));
      } catch (err) {
        lines.push(JSON.stringify({ type: "x-sdk-threw", message: String(err?.message || err).split("\n")[0] }));
      }
      const file = scenario.turns.length > 1 ? `${name}-${i + 1}.jsonl` : `${name}.jsonl`;
      const text = scrub(lines.join("\n") + "\n", tmp);
      fs.writeFileSync(path.join(HERE, file), text);
      console.log(`${file}: ${lines.length} events (${scenario.why})`);
    }
  } finally {
    await fake.close();
    await mcp.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The run's temp folder as "<tmp>", then the system's temp folder and the home folder as "<tmpdir>" and "<home>", in
 * every spelling an event can carry them (as is, with forward slashes, JSON-escaped once or twice), so no machine's
 * paths (or user name) end up in the repo.
 */
function scrub(text, tmp) {
  let out = text;
  for (const [dir, label] of [[tmp, "<tmp>"], [os.tmpdir(), "<tmpdir>"], [os.homedir(), "<home>"]]) {
    const forms = new Set([dir, dir.split(path.sep).join("/")]);
    for (const f of [...forms]) forms.add(JSON.stringify(f).slice(1, -1));
    for (const f of [...forms]) forms.add(JSON.stringify(f).slice(1, -1));
    for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join(label);
  }
  return out;
}

const only = process.argv.slice(2);
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (only.length && !only.includes(name)) continue;
  await capture(name, scenario);
}
