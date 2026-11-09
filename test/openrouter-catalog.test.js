// OpenRouter's model catalog (src/lib/openrouter-catalog.js), design 4.11 and Phase 4.
//   - The list comes from OpenRouter's public GET /api/v1/models: no key is ever sent with it.
//   - Only models Tarsee can run are kept: tool use (supported_parameters), a chat endpoint one of the engines speaks
//     (Claude Code: /api/v1/messages, Codex: /api/v1/responses; ":batch" copies only take batches), a price that can be
//     shown (routers that pick a different model per request list -1), and not retired.
//   - Prices, context, vision, Free (":free") and the reasoning levels each model lists become the picker's rows.
//   - It is cached for 6 hours in the cache.openrouter.models setting and fed to the provider registry.
//   - The picker has three sections: Recommended, Verified by you, All models (searchable; a row is selectable once
//     Tarsee knows which engine runs it).
// test/fixtures/openrouter-models.json is a real response of that public endpoint, recorded 2026-11-09 and trimmed to
// 43 of its 461 entries (each kept entry is verbatim), chosen to cover every rule above.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-openrouter-catalog-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const registry = await import("../src/ai/provider-registry.js");
const catalog = await import("../src/lib/openrouter-catalog.js");
const { EFFORT_IDS } = await import("../src/lib/model-picker.js");

const {
  parseOpenRouterModels, refreshOpenRouterCatalog, loadOpenRouterCatalog, initOpenRouterCatalog,
  openRouterSections, openRouterModels, searchModels, priceLabel, catalogEnginesFor,
  OPENROUTER_MODELS_URL, CATALOG_CACHE_KEY, CATALOG_TTL_MS,
} = catalog;

const FIXTURE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "openrouter-models.json"), "utf8");
const BODY = JSON.parse(FIXTURE);
const NOW = Date.UTC(2026, 10, 9, 12, 0);   // 2026-11-09, the day the fixture was recorded
const HOUR = 60 * 60 * 1000;
// A key that must never be sent with the public list, even when it is right there in the environment.
const CANARY = "sk-or-v1-testcanary0000catalog";

let dbn = 0;
const dbs = [];
function freshStore() {
  const db = initDb(path.join(tmp, `catalog-${++dbn}.db`));
  dbs.push(db);
  return new SettingsStore(db);
}

/** A loopback stand-in for openrouter.ai: serves the recorded list and records every request. */
function fakeOpenRouter({ status = 200, body = FIXTURE, delayMs = 0 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    setTimeout(() => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "function" ? body() : body);
    }, delayMs);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    resolve({ url: `http://127.0.0.1:${port}/api/v1/models`, requests, close: () => new Promise((r) => server.close(r)) });
  }));
}

const ids = (rows) => rows.map((m) => m.id);
const byId = (rows, id) => rows.find((m) => m.id === id);

beforeEach(() => {
  registry.setCatalogModels("openrouter", []);
  catalog.__resetForTests();
});

after(() => {
  for (const db of dbs) try { db.close(); } catch { /* already closed */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("OpenRouter catalog: which models are kept", () => {
  const rows = parseOpenRouterModels(BODY, { now: NOW });

  it("keeps the 36 models Tarsee can run out of the 43 recorded", () => {
    assert.equal(BODY.data.length, 43);
    assert.equal(rows.length, 36);
  });

  it("drops models without tool use, whatever endpoint they have", () => {
    for (const id of ["tencent/hy-mt2-7b", "writer/palmyra-x5", "google/gemini-3.1-flash-image", "openai/gpt-5.4-image-2"]) {
      assert.ok(BODY.data.some((m) => m.id === id), `${id} is in the fixture`);
      assert.equal(byId(rows, id), undefined, id);
    }
  });

  it("drops the :batch copies, which only take batch jobs", () => {
    assert.equal(byId(rows, "anthropic/claude-sonnet-5.5:batch"), undefined);
    assert.equal(byId(rows, "openai/gpt-6.1-sol:batch"), undefined);
    assert.ok(byId(rows, "anthropic/claude-sonnet-5.5"));
  });

  it("drops routers whose price is per request (-1): no cost can be shown or bounded", () => {
    assert.equal(byId(rows, "openrouter/auto"), undefined);
  });

  it("keeps the ~latest aliases (the tools-filtered endpoint leaves them out, so the full list is read)", () => {
    for (const id of ["~anthropic/claude-sonnet-latest", "~anthropic/claude-opus-latest", "~anthropic/claude-haiku-latest", "~openai/gpt-sol-latest"]) {
      assert.ok(byId(rows, id), id);
    }
    assert.equal(byId(rows, "~anthropic/claude-sonnet-latest").aliasOf, "anthropic/claude-sonnet-5.5");
  });

  it("drops a model once its retirement date has passed, and says when one is retiring", () => {
    assert.equal(byId(rows, "liquid/lfm-2.5-2.6b:free").retires, "2026-11-13");
    assert.equal(byId(rows, "moonshotai/kimi-k2.5").retires, "2026-11-18");
    const later = parseOpenRouterModels(BODY, { now: Date.UTC(2026, 10, 14) });
    assert.equal(byId(later, "liquid/lfm-2.5-2.6b:free"), undefined);
    assert.ok(byId(later, "moonshotai/kimi-k2.5"));
  });

  it("skips rows it can't read instead of failing the whole list", () => {
    const out = parseOpenRouterModels({ data: [null, 7, { id: "" }, { id: "x/no-params" }, BODY.data.find((m) => m.id === "z-ai/glm-5.3")] }, { now: NOW });
    assert.deepEqual(ids(out), ["z-ai/glm-5.3"]);
    assert.throws(() => parseOpenRouterModels({ nope: true }), /model list/i);
  });
});

describe("OpenRouter catalog: what each row says", () => {
  const rows = parseOpenRouterModels(BODY, { now: NOW });

  it("gives prices in dollars per million tokens, with no float noise", () => {
    assert.deepEqual(byId(rows, "anthropic/claude-sonnet-5.5").price, { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    assert.deepEqual(byId(rows, "openai/gpt-6-luna").price, { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
    // No separate cache-write price listed: writes cost the input rate.
    assert.deepEqual(byId(rows, "z-ai/glm-5.3").price, { in: 0.0699, out: 1.4, cacheRead: 0.0689, cacheWrite: 0.0699 });
  });

  it("marks the :free models Free, and only those cost nothing", () => {
    const free = ids(rows.filter((m) => m.free)).sort();
    assert.deepEqual(free, [
      "cohere/north-mini-code:free", "google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free",
      "liquid/lfm-2.5-2.6b:free", "nvidia/nemotron-3.5-super-vl:free",
    ]);
    for (const id of free) assert.deepEqual(byId(rows, id).price, { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, id);
  });

  it("reads the context window, the maker and whether it can see images", () => {
    const grok = byId(rows, "x-ai/grok-4.7");
    assert.equal(grok.context, 500_000);
    assert.equal(grok.vendor, "x-ai");
    assert.equal(grok.vision, true);
    assert.equal(byId(rows, "z-ai/glm-5.3").vision, false);
    assert.equal(byId(rows, "~anthropic/claude-sonnet-latest").vendor, "anthropic");
    assert.equal(byId(rows, "anthropic/claude-opus-5.5").label, "Anthropic: Claude Opus 5.5");
  });

  it("sends PDFs natively only to Anthropic's models (the rest get the text)", () => {
    assert.equal(byId(rows, "anthropic/claude-sonnet-5.5").pdf, true);
    assert.equal(byId(rows, "openai/gpt-6.1-sol").pdf, false);
    assert.equal(byId(rows, "google/gemini-4-argon").pdf, false);
  });

  it("shows the reasoning levels each model lists as Tarsee's effort levels, lowest first", () => {
    assert.deepEqual(byId(rows, "anthropic/claude-sonnet-5.5").reasoning.efforts, EFFORT_IDS);
    // "none" and "minimal" are not levels Tarsee offers.
    assert.deepEqual(byId(rows, "openai/gpt-6-luna").reasoning.efforts, EFFORT_IDS);
    assert.deepEqual(byId(rows, "z-ai/glm-5.3").reasoning.efforts, ["low", "high", "max"]);
    assert.deepEqual(byId(rows, "deepseek/deepseek-v4-pro").reasoning.efforts, ["high", "xhigh"]);
    assert.deepEqual(byId(rows, "google/gemini-4-argon").reasoning.efforts, ["low", "medium", "high"]);
    assert.equal(byId(rows, "google/gemini-4-argon").reasoning.default, "medium");
    assert.equal(byId(rows, "x-ai/grok-4.7").reasoning.default, "high");
    // A model that reasons but lists no levels takes OpenRouter's common three.
    assert.deepEqual(byId(rows, "qwen/qwen3.8-flash").reasoning.efforts, ["low", "medium", "high"]);
    // One that doesn't reason has none.
    assert.equal(byId(rows, "qwen/qwen3-coder").reasoning, null);
  });

  it("knows which engines a model's endpoints allow", () => {
    assert.deepEqual(byId(rows, "google/gemini-4-argon").engines, ["claude-code", "codex"]);
    const onlyResponses = parseOpenRouterModels({ data: [{ ...BODY.data.find((m) => m.id === "z-ai/glm-5.3"), endpoints: ["/api/v1/responses"] }] }, { now: NOW });
    assert.deepEqual(onlyResponses[0].engines, ["codex"]);
    const unlisted = parseOpenRouterModels({ data: [{ ...BODY.data.find((m) => m.id === "z-ai/glm-5.3"), endpoints: undefined }] }, { now: NOW });
    assert.deepEqual(unlisted[0].engines, ["claude-code", "codex"]);
  });

  it("labels prices in plain words", () => {
    assert.equal(priceLabel(byId(rows, "anthropic/claude-sonnet-5.5").price), "$2 in, $10 out per million tokens");
    assert.equal(priceLabel(byId(rows, "~deepseek/deepseek-flash-latest").price), "$0.006 in, $0.5 out per million tokens");
    assert.equal(priceLabel({ in: 0, out: 0 }), "Free");
    assert.equal(priceLabel(null), null);
  });
});

describe("OpenRouter catalog: fetching and the 6-hour cache", () => {
  let server;
  const savedKey = process.env.OPENROUTER_API_KEY;
  before(() => { process.env.OPENROUTER_API_KEY = CANARY; });
  after(() => { if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey; });
  beforeEach(async () => { await server?.close(); server = await fakeOpenRouter(); });
  after(() => server?.close());

  it("asks OpenRouter's public list, with no key", async () => {
    assert.equal(OPENROUTER_MODELS_URL, "https://openrouter.ai/api/v1/models");
    const store = freshStore();
    const out = await refreshOpenRouterCatalog(store, { url: server.url, now: () => NOW });
    assert.equal(out.source, "network");
    assert.equal(out.models.length, 36);
    assert.equal(server.requests.length, 1);
    const req = server.requests[0];
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, undefined);
    assert.ok(!JSON.stringify(req).includes(CANARY));
  });

  it("caches the list in cache.openrouter.models and feeds the registry", async () => {
    const store = freshStore();
    await refreshOpenRouterCatalog(store, { url: server.url, now: () => NOW });
    const cached = store.get(CATALOG_CACHE_KEY);
    assert.equal(cached.fetchedAt, new Date(NOW).toISOString());
    assert.equal(cached.models.length, 36);
    assert.equal(registry.catalogModels("openrouter").length, 36);
    assert.deepEqual(registry.priceFor("openrouter", "~anthropic/claude-sonnet-latest", NOW), { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5, peak: null });
    assert.equal(registry.contextTokensFor("openrouter", "x-ai/grok-4.7"), 500_000);
    assert.equal(registry.capsFor("openrouter", "z-ai/glm-5.3").vision, false);
    assert.equal(openRouterModels().length, 36);
  });

  it("serves the cache for 6 hours, then fetches again", async () => {
    const store = freshStore();
    await refreshOpenRouterCatalog(store, { url: server.url, now: () => NOW });
    const again = await refreshOpenRouterCatalog(store, { url: server.url, now: () => NOW + CATALOG_TTL_MS - 1 });
    assert.equal(again.source, "cache");
    assert.equal(server.requests.length, 1);
    const later = await refreshOpenRouterCatalog(store, { url: server.url, now: () => NOW + CATALOG_TTL_MS });
    assert.equal(later.source, "network");
    assert.equal(server.requests.length, 2);
    assert.equal(CATALOG_TTL_MS, 6 * HOUR);
  });

  it("fetches again when forced", async () => {
    const store = freshStore();
    await refreshOpenRouterCatalog(store, { url: server.url, now: () => NOW });
    await refreshOpenRouterCatalog(store, { url: server.url, now: () => NOW, force: true });
    assert.equal(server.requests.length, 2);
  });

  it("asks once when two callers want the list at the same time", async () => {
    await server.close();
    server = await fakeOpenRouter({ delayMs: 50 });
    const store = freshStore();
    const [a, b] = await Promise.all([
      refreshOpenRouterCatalog(store, { url: server.url, now: () => NOW }),
      refreshOpenRouterCatalog(store, { url: server.url, now: () => NOW }),
    ]);
    assert.equal(server.requests.length, 1);
    assert.equal(a.models.length, 36);
    assert.equal(b.models.length, 36);
  });

  it("keeps the last list when OpenRouter can't be reached, and says why", async () => {
    const store = freshStore();
    await refreshOpenRouterCatalog(store, { url: server.url, now: () => NOW });
    await server.close();
    registry.setCatalogModels("openrouter", []);
    const out = await refreshOpenRouterCatalog(store, { url: server.url, now: () => NOW + 7 * HOUR });
    assert.equal(out.source, "stale");
    assert.match(out.error, /couldn't reach OpenRouter/i);
    assert.equal(out.models.length, 36);
    assert.equal(registry.catalogModels("openrouter").length, 36);
    server = await fakeOpenRouter();
  });

  it("never throws: no cache and no answer gives an empty list and the reason", async () => {
    await server.close();
    server = await fakeOpenRouter({ status: 503, body: "busy" });
    const out = await refreshOpenRouterCatalog(freshStore(), { url: server.url, now: () => NOW });
    assert.equal(out.source, "none");
    assert.deepEqual(out.models, []);
    assert.match(out.error, /503/);
  });

  it("rejects an answer that isn't the model list", async () => {
    await server.close();
    server = await fakeOpenRouter({ body: "{\"data\": \"no\"}" });
    const out = await refreshOpenRouterCatalog(freshStore(), { url: server.url, now: () => NOW });
    assert.equal(out.source, "none");
    assert.match(out.error, /model list/i);
  });

  it("loads the cached list at boot without asking OpenRouter", async () => {
    const store = freshStore();
    await refreshOpenRouterCatalog(store, { url: server.url, now: () => NOW });
    registry.setCatalogModels("openrouter", []);
    catalog.__resetForTests();
    const loaded = loadOpenRouterCatalog(store);
    assert.equal(loaded.models.length, 36);
    assert.equal(registry.catalogModels("openrouter").length, 36);
    assert.equal(server.requests.length, 1);
    assert.equal(loadOpenRouterCatalog(freshStore()), null);
  });

  it("init loads the cache, refreshes in the background and can be stopped", async () => {
    const store = freshStore();
    const handle = initOpenRouterCatalog(store, { url: server.url, now: () => NOW, intervalMs: 60_000 });
    const first = await handle.ready;
    assert.equal(first.source, "network");
    assert.equal(server.requests.length, 1);
    handle.stop();
  });
});

describe("OpenRouter picker sections", () => {
  beforeEach(() => {
    registry.setCatalogModels("openrouter", []);
    catalog.__resetForTests();
    catalog.__setModelsForTests(parseOpenRouterModels(BODY, { now: NOW }));
  });

  function section(sections, id) {
    const s = sections.find((x) => x.id === id);
    assert.ok(s, `section ${id}`);
    return s;
  }

  it("has Recommended, Verified by you and All models, in that order", () => {
    const sections = openRouterSections(freshStore());
    assert.deepEqual(sections.map((s) => [s.id, s.label]), [["recommended", "Recommended"], ["verified", "Verified by you"], ["all", "All models"]]);
    assert.equal(section(sections, "all").searchable, true);
  });

  it("recommends the default first, then the other tier models, all ready to pick", () => {
    const rec = section(openRouterSections(freshStore()), "recommended").models;
    assert.deepEqual(ids(rec), ["~anthropic/claude-sonnet-latest", "~anthropic/claude-opus-latest", "~anthropic/claude-haiku-latest"]);
    for (const m of rec) {
      assert.equal(m.selectable, true, m.id);
      assert.equal(m.engine, "claude-code", m.id);
      assert.equal(m.streaming, true, m.id);
      assert.deepEqual(m.efforts, EFFORT_IDS, m.id);
    }
    assert.equal(rec[0].priceLabel, "$2 in, $10 out per million tokens");
    assert.equal(rec[0].context, 1_000_000);
  });

  it("lists every runnable model under All models, sorted by name, with Free badges", () => {
    const all = section(openRouterSections(freshStore()), "all").models;
    assert.equal(all.length, 36);
    const labels = all.map((m) => m.label.toLowerCase());
    assert.deepEqual(labels, [...labels].sort());
    assert.equal(byId(all, "google/gemma-4-31b-it:free").free, true);
    assert.equal(byId(all, "google/gemma-4-31b-it:free").priceLabel, "Free");
  });

  it("makes a model selectable only once Tarsee knows its engine: Anthropic and OpenAI now, any other maker after Verify", () => {
    const all = section(openRouterSections(freshStore()), "all").models;
    assert.equal(byId(all, "anthropic/claude-opus-5.5").selectable, true);
    assert.equal(byId(all, "openai/gpt-6.1-sol").selectable, true);
    assert.equal(byId(all, "openai/gpt-6.1-sol").engine, "codex");
    assert.equal(byId(all, "openai/gpt-6.1-sol").streaming, false);
    for (const id of ["google/gemini-4-argon", "qwen/qwen3.8-flash", "deepseek/deepseek-v4.1-flash", "google/gemma-4-31b-it:free"]) {
      const row = byId(all, id);
      assert.equal(row.selectable, false, id);
      assert.equal(row.needsVerify, true, id);
      assert.equal(row.engine, null, id);
      assert.deepEqual(row.efforts, [], `${id}: nothing to pick until it is verified`);
      assert.ok(row.reasoning === null || Array.isArray(row.reasoning.efforts), id);
    }
  });

  it("shows the owner's own verified models under Verified by you, with the engine and efforts that passed", () => {
    const store = freshStore();
    store.set("ai.openrouter.verified", {
      "qwen/qwen3.8-flash": { engine: "codex", at: "2026-11-09T12:00:00.000Z", engineVersion: "0.167.0", efforts: ["low", "high"], checks: { reply: true, tool: true, shell: true, resume: true } },
      "gone/retired-model": { engine: "claude-code", at: "2026-10-01T00:00:00.000Z", engineVersion: "2.1.300", efforts: [] },
    });
    const sections = openRouterSections(store);
    const mine = section(sections, "verified").models;
    assert.deepEqual(ids(mine), ["qwen/qwen3.8-flash", "gone/retired-model"]);
    const qwen = byId(mine, "qwen/qwen3.8-flash");
    assert.equal(qwen.selectable, true);
    assert.equal(qwen.engine, "codex");
    assert.deepEqual(qwen.efforts, ["low", "high"]);
    assert.equal(qwen.verified.engine, "codex");
    assert.equal(qwen.label, "Qwen: Qwen3.8 Flash");
    // A model OpenRouter no longer lists still shows, by its id.
    assert.equal(byId(mine, "gone/retired-model").label, "gone/retired-model");
    assert.equal(byId(mine, "gone/retired-model").listed, false);
    // And All models marks it ready too.
    assert.equal(byId(section(sections, "all").models, "qwen/qwen3.8-flash").selectable, true);
  });

  it("searches All models by name or id, every word must match", () => {
    const store = freshStore();
    const all = section(openRouterSections(store, { query: "kimi" }), "all").models;
    assert.deepEqual(ids(all).sort(), ["moonshotai/kimi-k2.5", "moonshotai/kimi-k3", "~moonshotai/kimi-latest"]);
    assert.deepEqual(ids(section(openRouterSections(store, { query: "gemma free" }), "all").models).sort(),
      ["google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free"]);
    assert.deepEqual(searchModels([{ id: "a/b", label: "Alpha" }], "  "), [{ id: "a/b", label: "Alpha" }]);
    // The other sections are short and stay whole.
    assert.equal(section(openRouterSections(store, { query: "kimi" }), "recommended").models.length, 3);
  });

  it("knows which engines to try a model on, from its endpoints", () => {
    assert.deepEqual(catalogEnginesFor("google/gemini-4-argon"), ["claude-code", "codex"]);
    assert.equal(catalogEnginesFor("not/listed"), null);
  });
});
