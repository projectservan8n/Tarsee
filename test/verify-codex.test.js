// Verify's Codex half, end to end (design 4.11): verifyModel through its own default runner, the turn layer's
// verification mode (ai/turn.js runTurn with verify: true and engine: "codex"), the real pinned codex binary, Tarsee's
// real loopback MCP endpoint (ai/mcp-http.js, so tarsee_datetime really runs through executeTool) and a fake OpenRouter
// Responses server (test/fixtures/fake-responses.js) reached through engine-env's test-only base-URL seam. The fake
// model does what it is asked: it repeats the code word, calls tarsee_datetime, runs the echo with Codex's shell, and
// recalls the code word only from what a resumed thread sends it. Every key here is an obvious fake.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-verify-codex-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.NODE_ENV = "test";
for (const k of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME", "CODEX_API_KEY", "TARSEE_AI_PROVIDER", "TARSEE_KEYS_ONLY"]) delete process.env[k];
// tarsee_datetime answers in Tarsee's zone (config/env.js reads it once, at import), else the host's; the year below
// is UTC's, so the zone is UTC too, whatever this machine's is.
process.env.TARSEE_TIMEZONE = "UTC";

const { startFakeResponses, functionOutputs, outputText, messageTexts, toolNames } = await import("./fixtures/fake-responses.js");
const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { verifyModel } = await import("../src/ai/verify-model.js");
const { engineFor } = await import("../src/ai/provider-registry.js");
const { stopMcpHttp } = await import("../src/ai/mcp-http.js");
const { resolveCodexBin } = await import("../src/ai/codex-cli.js");

const KEY = "sk-or-v1-testcanaryverifycodex0001";
const MODEL = "test-maker/test-model";   // a maker Tarsee has no engine for: it must be verified first
let fake;
let db;
let store;

/** The fake model: does what each check asks, and remembers nothing a resumed thread doesn't send it. */
function model(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const last = input.at(-1);
  if (last?.type === "function_call_output" || last?.type === "custom_tool_call_output") {
    const out = outputText(last).trim();
    return { text: out.split(/\s+/).at(-1) || "done" };
  }
  const users = messageTexts(body, "user");
  const ask = users.at(-1) || "";
  if (/tarsee_datetime/.test(ask)) {
    assert.ok(toolNames(body).includes("mcp__tarsee.tarsee_datetime"), `Tarsee's tools are offered: ${toolNames(body).join(" ")}`);
    return { calls: [{ name: "tarsee_datetime", namespace: "mcp__tarsee", arguments: { format: "date" } }] };
  }
  const echo = /\becho\s+(\S+)/.exec(ask);
  if (echo) return { calls: [{ name: "exec_command", arguments: { cmd: `echo ${echo[1]}` } }] };
  if (/code word I gave you/i.test(ask)) {
    const m = /code word for later:\s*([A-Za-z0-9-]+)/.exec(users.join("\n"));
    return { text: m ? m[1] : "I don't know of any code word." };
  }
  const w = /code word[^:]*:\s*([A-Za-z0-9-]+)/i.exec(ask);
  return { text: w ? w[1] : "ok" };
}

const codexThere = (() => { try { return !!resolveCodexBin(); } catch { return false; } })();

before(async () => {
  fake = await startFakeResponses({ handler: (body) => model(body) });
  process.env.TARSEE_TEST_BASE_URL_OPENROUTER = fake.url;
  db = initDb(path.join(tmp, "tarsee.db"));
  store = new SettingsStore(db);
  store.set("ai.openrouter.apiKey", KEY);
});
after(async () => {
  await fake?.close();
  await stopMcpHttp();
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Verify on the real Codex engine", { skip: !codexThere && "the pinned codex binary isn't installed", timeout: 240_000 }, () => {
  it("passes an OpenRouter model on Codex: a real Tarsee tool call, a real shell command and a real resumed thread", async () => {
    assert.equal(engineFor("openrouter", MODEL, store), null, "before: it must be verified first");
    const yearBefore = new Date().getUTCFullYear();
    const r = await verifyModel("openrouter", MODEL, { store, stateDir: tmp, engines: ["codex"], efforts: [], limiter: null });
    assert.equal(r.ok, true, `${r.code}: ${r.error} ${JSON.stringify(r.steps)}`);
    assert.equal(r.engine, "codex");
    assert.deepEqual(r.checks, { reply: true, tool: true, shell: true, resume: true });
    assert.equal(store.get("ai.openrouter.verified")[MODEL].engine, "codex");
    assert.equal(engineFor("openrouter", MODEL, store), "codex", "after: the registry runs it on Codex");

    const calls = fake.responses();
    assert.ok(calls.length >= 6, `${calls.length} model calls`);
    for (const c of fake.requests) assert.equal(c.headers.authorization, `Bearer ${KEY}`, `${c.method} ${c.path}`);
    for (const c of calls) assert.equal(c.body.model, MODEL);
    // The tool really ran: its answer came back to the model with today's year in it (either side of the run, so a
    // run across midnight on 31 December still matches).
    const toolAnswers = calls.flatMap((c) => functionOutputs(c.body)).map(outputText).join("\n");
    assert.match(toolAnswers, new RegExp(`${yearBefore}|${new Date().getUTCFullYear()}`));
    assert.ok(!fs.existsSync(path.join(tmp, "verify")) || fs.readdirSync(path.join(tmp, "verify")).length === 0, "the scratch folder is gone");
  });
});
