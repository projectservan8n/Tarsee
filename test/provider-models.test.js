// The model lists a key can see (src/ai/provider-models.js), design 4.11 and Phase 4 "OpenAI, DeepSeek and Local
// /models":
//   - OpenAI: GET https://api.openai.com/v1/models with the key; the static table is narrowed to what it lists.
//   - DeepSeek: GET https://api.deepseek.com/models with the key confirms the static table.
//   - Local AI: GET {its address}/models, with its optional key; every model it lists becomes a choice.
//   - The key only ever goes to its own provider's host (engine-env.js hostFor), never follows a redirect, and is
//     never in an error message. A key pasted into the wrong card is refused before anything is sent.
// Every key here is an obvious fake.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-provider-models-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const registry = await import("../src/ai/provider-registry.js");
const { listProviderModels, refreshProviderModels, ensureLocalModels, forgetLocalModelsRead } = await import("../src/ai/provider-models.js");

const OPENAI_KEY = "sk-test-canary-openai-0001modelsAA";
const DEEPSEEK_KEY = "sk-testcanarydeepseek0001models";
const LOCAL_KEY = "test-canary-local-0001";

/** A loopback server answering GET <prefix>/models; records each request. */
function fakeModels({ status = 200, body, prefix = "/v1" } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url !== `${prefix}/models`) { res.writeHead(404); res.end("not here"); return; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, url: `${base}${prefix}`, requests, close: () => new Promise((r) => server.close(r)) });
  }));
}

/** A fetch that never touches the network: records where it was asked to go and answers with `body`. */
function recordingFetch(body = { data: [] }, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

let dbn = 0;
const dbs = [];
function freshStore() {
  const db = initDb(path.join(tmp, `models-${++dbn}.db`));
  dbs.push(db);
  return new SettingsStore(db);
}

beforeEach(() => {
  registry.setCatalogModels("openai-models", []);
  registry.setCatalogModels("local-models", []);
});

after(() => {
  for (const db of dbs) try { db.close(); } catch { /* closed */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the static model tables carry the published prices", () => {
  const peak = new Date(Date.UTC(2026, 10, 9, 2));

  it("prices OpenAI's models at its list prices, as OpenRouter's recorded list passes them through", () => {
    const recorded = JSON.parse(fs.readFileSync(new URL("./fixtures/openrouter-models.json", import.meta.url), "utf8")).data;
    const perMillion = (v) => Math.round(Number(v) * 1e12) / 1e6;
    for (const m of registry.PROVIDERS.openai.models) {
      const row = recorded.find((r) => r.id === `openai/${m.id}`);
      assert.ok(row, `openai/${m.id} is in the recorded list`);
      const p = registry.priceFor("openai", m.id, peak);
      assert.equal(p.in, perMillion(row.pricing.prompt), `${m.id} in`);
      assert.equal(p.out, perMillion(row.pricing.completion), `${m.id} out`);
      assert.equal(p.cacheRead, perMillion(row.pricing.input_cache_read), `${m.id} cacheRead`);
      assert.equal(p.cacheWrite, row.pricing.input_cache_write ? perMillion(row.pricing.input_cache_write) : p.in, `${m.id} cacheWrite`);
      assert.equal(registry.contextTokensFor("openai", m.id), row.context_length, `${m.id} context`);
    }
  });
});

describe("provider /models: where the key goes", () => {
  it("sends OpenAI's key only to api.openai.com/v1/models", async () => {
    const f = recordingFetch({ data: [{ id: "gpt-6.1-sol" }] });
    const out = await listProviderModels("openai", { key: OPENAI_KEY, env: {}, fetch: f });
    assert.equal(out.ok, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, "https://api.openai.com/v1/models");
    assert.equal(f.calls[0].init.headers.authorization, `Bearer ${OPENAI_KEY}`);
    assert.equal(f.calls[0].init.redirect, "error");
  });

  it("sends DeepSeek's key only to api.deepseek.com/models", async () => {
    const f = recordingFetch({ data: [{ id: "deepseek-flash" }] });
    await listProviderModels("deepseek", { key: DEEPSEEK_KEY, env: {}, fetch: f });
    assert.equal(f.calls[0].url, "https://api.deepseek.com/models");
    assert.equal(f.calls[0].init.redirect, "error");
  });

  it("ignores the test-only address outside tests", async () => {
    const f = recordingFetch({ data: [] });
    await listProviderModels("openai", { key: OPENAI_KEY, env: { TARSEE_TEST_BASE_URL_OPENAI: "http://127.0.0.1:9/v1" }, fetch: f });
    assert.equal(f.calls[0].url, "https://api.openai.com/v1/models");
  });

  it("refuses a key pasted into the wrong card before sending anything", async () => {
    const f = recordingFetch();
    const out = await listProviderModels("openai", { key: "sk-or-v1-testcanary0001wrongslot", env: {}, fetch: f });
    assert.equal(out.ok, false);
    assert.equal(out.code, "bad-key");
    assert.match(out.error, /OpenRouter/);
    assert.equal(f.calls.length, 0);
    const local = await listProviderModels("local", { key: "sk-ant-api03-testcanary0001wrongslot", localUrl: "http://127.0.0.1:9/v1", env: {}, fetch: f });
    assert.equal(local.code, "bad-key");
    assert.equal(f.calls.length, 0);
  });

  it("needs a key for OpenAI and DeepSeek, and sends nothing without one", async () => {
    const f = recordingFetch();
    for (const id of ["openai", "deepseek"]) {
      const out = await listProviderModels(id, { key: "  ", env: {}, fetch: f });
      assert.equal(out.ok, false, id);
      assert.equal(out.code, "needs-key", id);
    }
    assert.equal(f.calls.length, 0);
  });

  it("only lists models for OpenAI, DeepSeek and Local AI", async () => {
    const f = recordingFetch();
    for (const id of ["openrouter", "chatgpt", "claude", "anthropic", "nope"]) {
      const out = await listProviderModels(id, { key: OPENAI_KEY, env: {}, fetch: f });
      assert.equal(out.ok, false, id);
      assert.equal(out.code, "not-supported", id);
    }
    assert.equal(f.calls.length, 0);
  });
});

describe("provider /models: reading the answers (against a loopback server)", () => {
  let server;
  afterEachClose();
  function afterEachClose() {
    beforeEach(async () => { await server?.close(); server = null; });
    after(async () => { await server?.close(); });
  }
  const testEnv = (id, url) => ({ NODE_ENV: "test", [`TARSEE_TEST_BASE_URL_${id.toUpperCase()}`]: url });

  it("narrows OpenAI's table to what the key lists", async () => {
    server = await fakeModels({ body: { object: "list", data: [{ id: "gpt-6.1-sol", object: "model" }, { id: "gpt-6-luna" }, { id: "text-embedding-3-large" }] } });
    const out = await refreshProviderModels("openai", { key: OPENAI_KEY, env: testEnv("openai", server.url) });
    assert.equal(out.ok, true);
    assert.equal(server.requests[0].headers.authorization, `Bearer ${OPENAI_KEY}`);
    assert.deepEqual(out.ids, ["gpt-6.1-sol", "gpt-6-luna", "text-embedding-3-large"]);
    assert.deepEqual(registry.modelsFor("openai").map((m) => m.id), ["gpt-6.1-sol", "gpt-6-luna"]);
    assert.deepEqual(out.models.map((m) => m.id), ["gpt-6.1-sol", "gpt-6-luna"]);
  });

  it("confirms DeepSeek's table and names any model it doesn't know yet", async () => {
    server = await fakeModels({ prefix: "", body: { object: "list", data: [{ id: "deepseek-flash", owned_by: "deepseek" }, { id: "deepseek-v5-preview" }] } });
    const out = await refreshProviderModels("deepseek", { key: DEEPSEEK_KEY, env: testEnv("deepseek", server.base) });
    assert.equal(out.ok, true);
    assert.deepEqual(out.models.map((m) => [m.id, m.confirmed]), [["deepseek-flash", true], ["deepseek-v4-pro", false]]);
    assert.deepEqual(out.extra, ["deepseek-v5-preview"]);
  });

  it("lists every model a Local AI server has, with the context set on its card, and no key when there is none", async () => {
    server = await fakeModels({ body: { data: [{ id: "llama3.1:8b" }, { id: "qwen3-coder:30b" }, { id: "llama3.1:8b" }] } });
    const store = freshStore();
    store.set("ai.local.context", 32768);
    const out = await refreshProviderModels("local", { store, localUrl: server.url, env: {} });
    assert.equal(out.ok, true);
    assert.equal(server.requests[0].headers.authorization, undefined);
    assert.deepEqual(registry.modelsFor("local").map((m) => [m.id, m.context]), [["llama3.1:8b", 32768], ["qwen3-coder:30b", 32768]]);
  });

  it("sends Local AI's own key when it has one, and reads Ollama's own list shape", async () => {
    server = await fakeModels({ body: { models: [{ name: "gemma3:12b", model: "gemma3:12b" }] } });
    const out = await listProviderModels("local", { key: LOCAL_KEY, localUrl: server.url, env: {} });
    assert.equal(out.ok, true);
    assert.equal(server.requests[0].headers.authorization, `Bearer ${LOCAL_KEY}`);
    assert.deepEqual(out.ids, ["gemma3:12b"]);
  });

  it("reads the key and the Local AI address from Settings when not handed them", async () => {
    server = await fakeModels({ body: { data: [{ id: "gpt-6-luna" }] } });
    const store = freshStore();
    store.set("ai.openai.apiKey", OPENAI_KEY);
    const out = await refreshProviderModels("openai", { store, env: testEnv("openai", server.url) });
    assert.equal(out.ok, true);
    assert.equal(server.requests[0].headers.authorization, `Bearer ${OPENAI_KEY}`);
    await server.close();
    server = await fakeModels({ body: { data: [{ id: "phi4" }] } });
    store.set("ai.local.baseUrl", server.url);
    const local = await refreshProviderModels("local", { store, env: {} });
    assert.deepEqual(local.ids, ["phi4"]);
  });

  it("explains a rejected key in plain words, without the key", async () => {
    server = await fakeModels({ status: 401, body: { error: { message: `Incorrect API key provided: ${OPENAI_KEY}` } } });
    const out = await listProviderModels("openai", { key: OPENAI_KEY, env: testEnv("openai", server.url) });
    assert.equal(out.ok, false);
    assert.equal(out.code, "auth");
    assert.equal(out.status, 401);
    assert.equal(out.error, registry.PROVIDERS.openai.errorHints.auth);
    assert.ok(!JSON.stringify(out).includes(OPENAI_KEY));
  });

  it("explains an empty balance, a busy provider and other answers", async () => {
    server = await fakeModels({ prefix: "", status: 402, body: {} });
    const billing = await listProviderModels("deepseek", { key: DEEPSEEK_KEY, env: testEnv("deepseek", server.base) });
    assert.equal(billing.code, "billing");
    assert.equal(billing.error, registry.PROVIDERS.deepseek.errorHints.billing);
    await server.close();
    server = await fakeModels({ prefix: "", status: 429, body: {} });
    assert.equal((await listProviderModels("deepseek", { key: DEEPSEEK_KEY, env: testEnv("deepseek", server.base) })).code, "rate");
    await server.close();
    server = await fakeModels({ prefix: "", status: 500, body: {} });
    const other = await listProviderModels("deepseek", { key: DEEPSEEK_KEY, env: testEnv("deepseek", server.base) });
    assert.equal(other.code, "error");
    assert.match(other.error, /500/);
    await server.close();
    server = await fakeModels({ prefix: "", body: "not json" });
    assert.match((await listProviderModels("deepseek", { key: DEEPSEEK_KEY, env: testEnv("deepseek", server.base) })).error, /list/i);
  });

  it("says when a Local AI can't be reached, has no address, or has no /models at that address", async () => {
    const gone = await listProviderModels("local", { localUrl: "http://127.0.0.1:9/v1", env: {} });
    assert.equal(gone.ok, false);
    assert.equal(gone.code, "unreachable");
    assert.equal(gone.error, "Can't reach your Local AI at http://127.0.0.1:9/v1.");
    const none = await listProviderModels("local", { env: {} });
    assert.equal(none.code, "needs-setup");
    server = await fakeModels({ prefix: "/v1", body: { data: [] } });
    const wrongPath = await listProviderModels("local", { localUrl: server.base, env: {} });
    assert.equal(wrongPath.code, "needs-setup");
    assert.match(wrongPath.error, /\/v1/);
  });

  it("leaves the registry alone when the list can't be read", async () => {
    registry.setCatalogModels("openai-models", [{ id: "gpt-6-luna" }]);
    server = await fakeModels({ status: 401, body: {} });
    await refreshProviderModels("openai", { key: OPENAI_KEY, env: testEnv("openai", server.url) });
    assert.deepEqual(registry.modelsFor("openai").map((m) => m.id), ["gpt-6-luna"]);
  });
});

describe("ensureLocalModels: Local AI's list after a restart (nothing has opened Settings yet)", () => {
  let server = null;
  beforeEach(() => { forgetLocalModelsRead(); });
  after(async () => { await server?.close(); });

  it("reads the server's models once, at the address in Settings or TARSEE_LOCAL_AI_URL; a list that is there is kept", async () => {
    server = await fakeModels({ body: { data: [{ id: "llama3.1:8b" }, { id: "qwen3" }] } });
    const store = freshStore();
    const env = { TARSEE_LOCAL_AI_URL: server.url };
    const [a, b] = await Promise.all([ensureLocalModels(store, { env }), ensureLocalModels(store, { env })]);
    assert.deepEqual(a.map((m) => m.id), ["llama3.1:8b", "qwen3"]);
    assert.deepEqual(b.map((m) => m.id), ["llama3.1:8b", "qwen3"]);
    assert.equal(server.requests.length, 1, "callers asking together share one read");
    assert.deepEqual(registry.modelsFor("local").map((m) => m.id), ["llama3.1:8b", "qwen3"]);
    await ensureLocalModels(store, { env });
    assert.equal(server.requests.length, 1, "a list that is there is not read again");
    // The address in Settings wins over the variable.
    registry.setCatalogModels("local-models", []);
    store.set("ai.local.baseUrl", server.url);
    await ensureLocalModels(store, { env: { TARSEE_LOCAL_AI_URL: "http://127.0.0.1:9/v1" } });
    assert.equal(server.requests.length, 2);
  });

  it("no address, or one that isn't plain http(s): nothing is asked", async () => {
    const fetch = recordingFetch({ data: [{ id: "x" }] });
    assert.deepEqual(await ensureLocalModels(freshStore(), { env: {}, fetch }), []);
    assert.deepEqual(await ensureLocalModels(freshStore(), { env: { TARSEE_LOCAL_AI_URL: "ftp://box/v1" }, fetch }), []);
    assert.equal(fetch.calls.length, 0);
  });

  it("a server that can't be read is not asked again for a minute (every message would wait), then is", async () => {
    let now = 1_000_000;
    const calls = [];
    const fetch = async (url) => { calls.push(String(url)); throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
    const store = freshStore();
    const env = { TARSEE_LOCAL_AI_URL: "http://127.0.0.1:9/v1" };
    assert.deepEqual(await ensureLocalModels(store, { env, fetch, now: () => now }), []);
    assert.deepEqual(await ensureLocalModels(store, { env, fetch, now: () => now + 30_000 }), []);
    assert.equal(calls.length, 1);
    // Another address is asked at once (the owner fixed it).
    await ensureLocalModels(store, { env: { TARSEE_LOCAL_AI_URL: "http://127.0.0.1:10/v1" }, fetch, now: () => now + 31_000 });
    assert.equal(calls.length, 2);
    now += 61_000;
    await ensureLocalModels(store, { env, fetch, now: () => now });
    assert.equal(calls.length, 3);
  });
});
