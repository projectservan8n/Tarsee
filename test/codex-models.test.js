// The signed-in ChatGPT account's own model list (src/ai/codex-models.js; design amendment A2). Tarsee never
// hard-codes a ChatGPT model: it asks Codex's app-server (`model/list` over JSON-RPC on stdio) and, when that can't
// be read as the account's own answer, returns [] so the caller leaves the model out and Codex picks its default.
// "The account's own answer" matters: the real pinned binary answers model/list with its bundled catalog both when
// nobody is signed in and when the account's fetch fails (it only logs the failure), and a Free account can't use
// most of that catalog. A fetch that worked leaves models_cache.json in CODEX_HOME (Codex keys it to the account), so
// the list counts only when that cache holds every model listed and no fetch failure was logged. The app-server here
// is a fake codex through the platform shim (test/fixtures/fake-codex-login), answering in the real binary's shapes;
// model-list.bundled.json and refresh-failed.stderr.txt are what the real binary sent when its fetch failed.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listAccountModels, readAccountModels, mapModelList, clearAccountModelsCache, syncChatgptCatalog } from "../src/ai/codex-models.js";
import { catalogModels, modelsFor } from "../src/ai/provider-registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "fake-codex-login");
const BUNDLED = JSON.parse(fs.readFileSync(path.join(FIXTURES, "model-list.bundled.json"), "utf8"));

let root;
let fakeBin;
let n = 0;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-codex-models-"));
  const bin = path.join(root, "bin");
  fs.cpSync(FIXTURES, bin, { recursive: true });
  fakeBin = path.join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
  if (process.platform !== "win32") fs.chmodSync(fakeBin, 0o755);
});
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const CANARIES = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "ENCRYPTION_KEY", "TARSEE_PROVIDER_KEY"];

/** A signed-in-looking home (any auth.json; the fake's account/read decides) and the env picking the fake's answers. */
function scenario(vars = {}, { signedIn = true } = {}) {
  const dir = path.join(root, `case-${++n}`);
  const home = path.join(dir, ".codex-home");
  fs.mkdirSync(home, { recursive: true });
  if (signedIn) fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "x.e30.y", access_token: "at-test-canary", refresh_token: "rt-test-canary" } }));
  const log = path.join(dir, "codex-calls.jsonl");
  const pidFile = path.join(dir, "codex.pid");
  const env = {
    ...process.env,
    ...Object.fromEntries(CANARIES.map((k) => [k, `sk-test-canary-${k}`])),
    CODEX_HOME: path.join(dir, "wrong-home"),
    RUST_LOG: "off",
    FAKE_CODEX_NODE: process.execPath,
    FAKE_CODEX_LOG: log,
    FAKE_CODEX_PID_FILE: pidFile,
    ...vars,
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const opts = (extra = {}) => ({ codexHome: home, env, codexBin: fakeBin, ...extra });
  return { dir, home, env, calls, opts, pid: () => Number(fs.readFileSync(pidFile, "utf8")) };
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}

async function goneSoon(pid, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

const LIVE = [
  { id: "test-free-small", label: "Test Free Small", efforts: ["medium", "low", "high"], default: true, defaultEffort: "medium", vision: true, description: "Test Free Small for tests." },
  { id: "test-free-mini", label: "Test Free Mini", efforts: ["low"], defaultEffort: "low", vision: false, description: "Test Free Mini for tests." },
];

describe("mapModelList: the app-server's model shape", () => {
  it("maps the real binary's answer: id, label, efforts, the default, and hidden ones left out", () => {
    const mapped = mapModelList(BUNDLED.data);
    const visible = BUNDLED.data.filter((m) => !m.hidden);
    assert.equal(mapped.length, visible.length);
    for (const [i, m] of visible.entries()) {
      assert.equal(mapped[i].id, m.model);
      assert.equal(mapped[i].label, m.displayName);
      assert.deepEqual(mapped[i].efforts, m.supportedReasoningEfforts.map((e) => e.reasoningEffort));
      assert.equal(mapped[i].defaultEffort, m.defaultReasoningEffort);
      assert.equal(mapped[i].default, m.isDefault ? true : undefined);
      assert.equal(mapped[i].vision, (m.inputModalities ?? ["text", "image"]).includes("image"));
    }
    assert.equal(mapped.filter((m) => m.default).length, 1, "one default");
  });

  it("drops entries without a usable id, duplicates, and odd effort values", () => {
    const mapped = mapModelList([
      { id: "a", model: "a", displayName: "A", hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "" }, {}], defaultReasoningEffort: "low" },
      { id: "a", model: "a", displayName: "A again", hidden: false, isDefault: false, supportedReasoningEfforts: [] },
      { id: "", model: "", displayName: "nothing", hidden: false },
      { id: "bad id with spaces", model: "bad id with spaces", displayName: "x", hidden: false },
      null,
      { id: "b", displayName: "", hidden: false, isDefault: true, supportedReasoningEfforts: [] },
    ]);
    assert.deepEqual(mapped, [
      { id: "a", label: "A", efforts: ["low"], defaultEffort: "low", vision: true },
      { id: "b", label: "b", efforts: [], default: true, vision: true },
    ]);
  });
});

describe("listAccountModels with a fake app-server", () => {
  it("returns the signed-in account's own list, following every page", async () => {
    const s = scenario();
    clearAccountModelsCache();
    assert.deepEqual(await listAccountModels(s.opts()), LIVE);
    const [call] = s.calls();
    assert.ok(call.argv.includes("app-server"));
    assert.ok(call.argv.includes('cli_auth_credentials_store="file"'));
    assert.equal(path.resolve(call.CODEX_HOME), path.resolve(s.home), "CODEX_HOME is the sign-in home");
    assert.equal(call.RUST_LOG, "error", "fetch failures are logged whatever the server's RUST_LOG says");
    const upper = new Set(call.env.map((k) => k.toUpperCase()));
    for (const k of CANARIES) assert.ok(!upper.has(k), `${k} must not reach codex`);
  });

  it("readAccountModels also says where the list came from and whose it is", async () => {
    const s = scenario({ FAKE_CODEX_EMAIL: "someone@example.test" });
    clearAccountModelsCache();
    const r = await readAccountModels(s.opts());
    assert.deepEqual(r, { models: LIVE, source: "account", account: { email: "someone@example.test", plan: "free" } });
  });

  it("the real binary's fallback after a failed fetch (bundled catalog + error line) is not the account's list", async () => {
    const s = scenario({ FAKE_CODEX_MODELS: "fallback" });
    clearAccountModelsCache();
    assert.deepEqual(await listAccountModels(s.opts()), []);
    clearAccountModelsCache();
    const r = await readAccountModels(s.opts());
    assert.equal(r.reason, "not-live");
    assert.deepEqual(r.models, []);
  });

  it("an answer with no cache behind it is not the account's list either", async () => {
    const s = scenario({ FAKE_CODEX_MODELS: "quiet-fallback" });
    clearAccountModelsCache();
    const r = await readAccountModels(s.opts());
    assert.deepEqual(r.models, []);
    assert.equal(r.reason, "not-live");
  });

  it("nor is one the cache doesn't cover", async () => {
    const s = scenario({ FAKE_CODEX_MODELS: "mismatch" });
    clearAccountModelsCache();
    const r = await readAccountModels(s.opts());
    assert.deepEqual(r.models, []);
    assert.equal(r.reason, "not-live");
  });

  it("not signed in, signed in with an API key, or a sign-in that has expired: []", async () => {
    for (const [account, reason] of [["none", "not-signed-in"], ["apikey", "not-chatgpt"], ["expired", "sign-in-expired"]]) {
      const s = scenario({ FAKE_CODEX_ACCOUNT: account });
      clearAccountModelsCache();
      const r = await readAccountModels(s.opts());
      assert.deepEqual(r.models, [], account);
      assert.equal(r.reason, reason, account);
    }
  });

  it("no auth.json: [] without starting codex", async () => {
    const s = scenario({}, { signedIn: false });
    clearAccountModelsCache();
    const r = await readAccountModels(s.opts());
    assert.deepEqual(r, { models: [], source: null, reason: "not-signed-in" });
    assert.equal(s.calls().length, 0);
  });

  it("a stuck app-server times out to [] and is killed", async () => {
    const s = scenario({ FAKE_CODEX_MODELS: "hang" });
    clearAccountModelsCache();
    const t0 = Date.now();
    const r = await readAccountModels(s.opts({ timeoutMs: 1500 }));
    assert.deepEqual(r.models, []);
    assert.equal(r.reason, "timeout");
    assert.ok(Date.now() - t0 < 8000);
    assert.ok(await goneSoon(s.pid()), "the app-server process is gone");
  });

  it("a config.toml that could send the sign-in elsewhere: [] without starting codex", async () => {
    const s = scenario();
    fs.writeFileSync(path.join(s.home, "config.toml"), 'chatgpt_base_url = "https://example.test/"\n');
    clearAccountModelsCache();
    const r = await readAccountModels(s.opts());
    assert.deepEqual(r.models, []);
    assert.equal(r.reason, "unsafe-config");
    assert.equal(s.calls().length, 0);
  });

  it("a .env in the home (Codex loads it into its own environment: a proxy, a certificate): [] without starting codex", async () => {
    const s = scenario();
    fs.writeFileSync(path.join(s.home, ".env"), "HTTPS_PROXY=http://127.0.0.1:9\n");
    clearAccountModelsCache();
    const r = await readAccountModels(s.opts());
    assert.deepEqual(r.models, []);
    assert.equal(r.reason, "unsafe-config");
    assert.equal(s.calls().length, 0);
  });

  it("no codex binary: []", async () => {
    const s = scenario();
    clearAccountModelsCache();
    const r = await readAccountModels(s.opts({ codexBin: path.join(s.dir, "no-such-codex") }));
    assert.deepEqual(r.models, []);
    assert.equal(r.reason, "codex-missing");
  });

  it("needs a home", async () => {
    await assert.rejects(listAccountModels({}), TypeError);
  });
});

describe("listAccountModels caching", () => {
  it("one app-server for callers at the same time, and none again while the answer is fresh", async () => {
    const s = scenario();
    clearAccountModelsCache();
    const [a, b] = await Promise.all([listAccountModels(s.opts()), listAccountModels(s.opts())]);
    assert.deepEqual(a, LIVE);
    assert.deepEqual(b, LIVE);
    assert.deepEqual(await listAccountModels(s.opts()), LIVE);
    assert.equal(s.calls().length, 1);
    a.pop(); // a caller changing its copy doesn't change the next answer
    assert.deepEqual(await listAccountModels(s.opts()), LIVE);
  });

  it("a new sign-in (auth.json changed) asks again", async () => {
    const s = scenario();
    clearAccountModelsCache();
    await listAccountModels(s.opts());
    fs.writeFileSync(path.join(s.home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "x.e30.y", access_token: "at-test-canary-2", refresh_token: "rt-test-canary-2" }, last_refresh: "2026-11-09T00:00:00Z" }));
    await listAccountModels(s.opts());
    assert.equal(s.calls().length, 2);
  });

  it("maxAgeMs: 0 always asks, and a failed answer is never kept", async () => {
    const s = scenario({ FAKE_CODEX_MODELS: "fallback" });
    clearAccountModelsCache();
    assert.deepEqual(await listAccountModels(s.opts()), []);
    s.env.FAKE_CODEX_MODELS = "live";
    assert.deepEqual(await listAccountModels(s.opts()), LIVE, "the failure wasn't cached");
    await listAccountModels(s.opts({ maxAgeMs: 0 }));
    assert.equal(s.calls().length, 3);
  });
});

describe("syncChatgptCatalog: the registry's ChatGPT models come from the account", () => {
  it("fills chatgpt-models with the account's list, and empties it when the list can't be read", async () => {
    const s = scenario();
    clearAccountModelsCache();
    const r = await syncChatgptCatalog(s.opts());
    assert.equal(r.source, "account");
    const listed = catalogModels("chatgpt-models");
    assert.deepEqual(listed.map((m) => m.id), ["test-free-small", "test-free-mini"]);
    assert.equal(listed[0].default, true);
    assert.deepEqual(listed[1].efforts, ["low"]);
    assert.equal(listed[1].vision, false);
    assert.deepEqual(modelsFor("chatgpt").map((m) => m.id), ["test-free-small", "test-free-mini"], "the provider offers exactly these");

    s.env.FAKE_CODEX_MODELS = "fallback";
    const failed = await syncChatgptCatalog(s.opts({ maxAgeMs: 0 }));
    assert.equal(failed.reason, "not-live");
    assert.deepEqual(catalogModels("chatgpt-models"), [], "no model named: Codex picks its default");
  });

  it("signed out: emptied without starting codex", async () => {
    const s = scenario();
    clearAccountModelsCache();
    await syncChatgptCatalog(s.opts());
    assert.equal(catalogModels("chatgpt-models").length, 2);
    fs.rmSync(path.join(s.home, "auth.json"));
    const r = await syncChatgptCatalog(s.opts());
    assert.equal(r.reason, "not-signed-in");
    assert.deepEqual(catalogModels("chatgpt-models"), []);
    assert.equal(s.calls().length, 1);
  });
});

describe("no ChatGPT model is written into Tarsee's code", () => {
  it("the sign-in and model-list modules name no model", () => {
    for (const file of ["codex-models.js", "codex-device-login.js", "codex-cli.js"]) {
      const src = fs.readFileSync(path.join(here, "..", "src", "ai", file), "utf8");
      assert.doesNotMatch(src, /\bgpt-\d|\bo[1-9](-mini)?\b|\bluna\b|\bastra\b|\bcodex-mini\b/i, file);
    }
  });
});
