// The daily retention sweep (lib/retention.js) also prunes Codex's rollouts (design 4.8 "Rollouts"): every Codex turn
// leaves a rollout-<time>-<thread>.jsonl under its home's sessions/YYYY/MM/DD/, in the ChatGPT plan's home
// (.codex-home) and the key providers' (.codex-home-keys). Ones untouched for 30 days (retention.codex_rollouts_days)
// go, with the day folders they leave empty; newer ones, and anything that isn't a rollout, stay.
// Codex also keeps every thread in sqlite databases in the same home (the person's words, every message and command
// output); a thread's rows go once its rollout is gone and it is past the same cutoff (lib/codex-thread-dbs.js). The
// last suite runs the REAL pinned codex binary against the fake Responses server and an MCP stub, as
// test/codex-engine.test.js does.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { startFakeResponses } from "./fixtures/fake-responses.js";
import { startMcpStub } from "./fixtures/mcp-stub.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-retention-codex-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { pruneOldRollouts } = await import("../src/lib/retention.js");
const codex = await import("../src/ai/providers/codex.js");
const rollouts = await import("../src/ai/codex-rollouts.js");
const { resolveCodexBin } = await import("../src/ai/codex-cli.js");
const { CODEX, homeFor } = await import("../src/ai/engine-env.js");

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment */ } });

const DAY = 86_400_000;
function rollout(home, day, name, ageDays, now) {
  const dir = path.join(tmp, home, "sessions", "2026", "10", day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "{}\n");
  const t = new Date(now - ageDays * DAY);
  fs.utimesSync(file, t, t);
  return file;
}

describe("Codex rollouts in the daily sweep", () => {
  it("prunes both Codex homes past the setting's age, keeps newer ones and anything else", () => {
    const now = Date.now();
    const oldPlan = rollout(".codex-home", "01", "rollout-2026-10-01T00-00-00-aaa.jsonl", 40, now);
    const oldKeys = rollout(".codex-home-keys", "02", "rollout-2026-10-02T00-00-00-bbb.jsonl", 31, now);
    const fresh = rollout(".codex-home-keys", "03", "rollout-2026-10-03T00-00-00-ccc.jsonl", 3, now);
    const other = rollout(".codex-home", "04", "notes.txt", 90, now);
    const settings = { get: (k) => (k === "retention.codex_rollouts_days" ? null : null) };

    assert.deepEqual(pruneOldRollouts(settings, { stateDir: tmp, now }), { rollouts: 2, threads: 0 });
    assert.ok(!fs.existsSync(oldPlan) && !fs.existsSync(oldKeys));
    assert.ok(!fs.existsSync(path.dirname(oldPlan)), "the day folder it left empty goes too");
    assert.ok(fs.existsSync(fresh));
    assert.ok(fs.existsSync(other), "only rollouts");

    const shorter = { get: (k) => (k === "retention.codex_rollouts_days" ? 2 : null) };
    assert.equal(pruneOldRollouts(shorter, { stateDir: tmp, now }).rollouts, 1, "the setting shortens it");
    assert.ok(!fs.existsSync(fresh));
  });

  it("never throws, with no Codex home at all", () => {
    assert.deepEqual(pruneOldRollouts({ get: () => null }, { stateDir: path.join(tmp, "nothing-here"), now: Date.now() }), { rollouts: 0, threads: 0 });
  });

  it("a Codex database that fails doesn't lose the rollout count", (t) => {
    t.mock.method(console, "warn", () => {});
    const state = path.join(tmp, "broken-db");
    const home = path.join(state, ".codex-home-keys");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "state_5.sqlite"), "not a database, and longer than a sqlite header ".repeat(4));
    const now = Date.now();
    const dir = path.join(home, "sessions", "2026", "10", "05");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "rollout-2026-10-05T00-00-00-ddd.jsonl");
    fs.writeFileSync(file, "{}\n");
    fs.utimesSync(file, new Date(now - 40 * DAY), new Date(now - 40 * DAY));
    assert.deepEqual(pruneOldRollouts({ get: () => null }, { stateDir: state, now }), { rollouts: 1, threads: 0 });
  });

  it("the engine module still offers the same function", () => {
    assert.equal(codex.pruneCodexRollouts, rollouts.pruneCodexRollouts);
  });
});

// --- The real pinned codex binary ------------------------------------------------------------------------------------

/** Only what a program needs to start (no credential of this machine), and TARSEE_CODEX_BIN when set. */
function hostEnv() {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "SystemDrive", "TEMP", "TMP", "TMPDIR", "ComSpec", "PATHEXT", "WINDIR", "windir", "LANG", "TARSEE_CODEX_BIN"];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
}
const CODEX_THERE = (() => { try { return !!resolveCodexBin(); } catch { return false; } })();

describe("Codex's thread databases with the real codex binary", { skip: CODEX_THERE ? false : "the pinned codex binary isn't installed", timeout: 240_000 }, () => {
  const root = path.join(tmp, "real");
  const state = path.join(root, "state");
  const ws = path.join(root, "workspace");
  const fakeHome = path.join(root, "home");
  const MCP_TOKEN = "mcp-test-token-retention-0001";
  // An obvious fake, never a real key's shape.
  const KEY = ["sk", "or", "v1", "test-retention-fake-0001"].join("-");
  const values = new Map();
  const store = {
    get: (k) => (values.has(k) ? values.get(k) : null),
    set: (k, v) => { values.set(k, v); },
    delete: (k) => { values.delete(k); },
    getKeyWithSource: (id) => (id === "openrouter" ? { key: KEY, source: "settings" } : { key: null, source: null }),
  };
  let fake;
  let mcp;

  before(async () => {
    for (const d of [state, ws, fakeHome]) fs.mkdirSync(d, { recursive: true });
    fake = await startFakeResponses({ handler: () => ({ text: "ok" }) });
    mcp = await startMcpStub({ token: MCP_TOKEN });
  });
  after(async () => {
    await fake?.close();
    await mcp?.close();
  });

  async function turn(conv, sessionHandle) {
    const handles = [];
    const out = [];
    for await (const ev of codex.run({
      target: { provider: "openrouter", model: "openai/gpt-5.5" },
      messages: [{ role: "user", content: `hello from ${conv}` }],
      systemParts: { stable: "You are Tarsee, under test.", volatile: "Today is a test day." },
      toolCtx: { settingsStore: store, conversationId: conv },
      mcpGrant: { url: mcp.url, token: MCP_TOKEN },
      sessionHandle,
      onSessionHandle: (h) => handles.push(h),
      turnId: `retention-${conv}`,
      deps: {
        env: { ...hostEnv(), HOME: fakeHome, USERPROFILE: fakeHome, NODE_ENV: "test", TARSEE_TEST_BASE_URL_OPENROUTER: fake.url },
        stateDir: state, workspace: ws, vaultEnv: async () => ({}), accountModels: () => [],
      },
    })) out.push(ev);
    return { done: out.filter((e) => e.type === "done"), errors: out.filter((e) => e.type === "error"), handle: handles[0] };
  }
  const threadOf = (handle) => handle.slice(handle.lastIndexOf(":") + 1);
  function count(home, file, sql, id) {
    const db = new Database(path.join(home, file), { readonly: true, fileMustExist: true });
    try { return db.prepare(sql).get(id).c; } finally { db.close(); }
  }
  const threadRows = (home, id) => count(home, "state_5.sqlite", "SELECT COUNT(*) AS c FROM threads WHERE id = ?", id);
  const itemRows = (home, id) => count(home, "thread_history_1.sqlite", "SELECT COUNT(*) AS c FROM thread_items WHERE thread_id = ?", id);

  it("a thread whose rollout is gone loses its rows once past the cutoff; the others stay and still resume", async () => {
    const one = await turn("conv-one");
    const two = await turn("conv-two");
    for (const t of [one, two]) assert.deepEqual(t.done, [{ type: "done", stopReason: "end_turn" }], JSON.stringify(t.errors));
    const gone = threadOf(one.handle);
    const kept = threadOf(two.handle);
    assert.notEqual(gone, kept);
    const home = homeFor("openrouter", CODEX, { stateDir: state });
    for (const id of [gone, kept]) {
      assert.equal(threadRows(home, id), 1, "Codex keeps a threads row");
      assert.ok(itemRows(home, id) > 0, "and the thread's items");
    }

    // The first thread's rollout goes (as retention's rollout prune does); the second's is still there.
    const goneRollout = codex.findRollout(home, gone);
    const keptRollout = codex.findRollout(home, kept);
    assert.ok(goneRollout && keptRollout);
    fs.rmSync(goneRollout);

    const settings = { get: () => null };
    assert.deepEqual(pruneOldRollouts(settings, { stateDir: state, now: Date.now() }), { rollouts: 0, threads: 0 }, "today nothing is old enough");
    assert.equal(threadRows(home, gone), 1);

    // A month on. The kept thread's rollout was touched since (so the rollout prune keeps it).
    const later = Date.now() + 31 * DAY;
    fs.utimesSync(keptRollout, new Date(later), new Date(later));
    assert.deepEqual(pruneOldRollouts(settings, { stateDir: state, now: later }), { rollouts: 0, threads: 1 });
    assert.equal(threadRows(home, gone), 0, "the gone thread's row went");
    assert.equal(itemRows(home, gone), 0, "and its items, with the person's words");
    assert.equal(threadRows(home, kept), 1, "the kept thread's row stays");
    assert.ok(itemRows(home, kept) > 0, "and its items");

    const again = await turn("conv-two", two.handle);
    assert.deepEqual(again.done, [{ type: "done", stopReason: "end_turn" }], JSON.stringify(again.errors));
    assert.equal(again.handle, two.handle, "the same thread resumed");
    const fresh = await turn("conv-three");
    assert.deepEqual(fresh.done, [{ type: "done", stopReason: "end_turn" }], JSON.stringify(fresh.errors));
  });
});
