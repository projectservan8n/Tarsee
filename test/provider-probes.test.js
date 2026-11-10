// The balance reads behind the OpenRouter and DeepSeek cards (src/ai/provider-probes.js refreshBalance, design 4.13):
// GET /api/ai/providers reads each card's balance with the stored key, or the one in its Railway variable. A key the
// provider turns down there must show on its card (so the wizard can't make it the default), and a key that works
// again must clear that. The network is a stub that records where each request went; every key is an obvious fake.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-provider-probes-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const { refreshBalance, probeProvider } = await import("../src/ai/provider-probes.js");
const { providerStatus, failureFlag, setFailureFlag } = await import("../src/ai/provider-status.js");
const { catalogModels, contextTokensFor } = await import("../src/ai/provider-registry.js");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const KEYS = { openrouter: "sk-or-v1-testcanaryRailway0001", deepseek: "sk-testcanaryRailwayDeepseek01" };
const ENV_NAMES = { openrouter: "OPENROUTER_API_KEY", deepseek: "DEEPSEEK_API_KEY" };

/** A settings store whose provider keys come from their Railway variables (getKeyWithSource's env: source). */
function railwayStore(keys = KEYS) {
  const m = new Map();
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, v); },
    delete: (k) => { m.delete(k); },
    getKeyWithSource: (id) => (keys[id] ? { key: keys[id], source: `env:${ENV_NAMES[id]}`, hint: `…${keys[id].slice(-4)}` } : { key: null, source: null, hint: null }),
    map: m,
  };
}

const ANSWERS = {
  openrouter: { data: { limit: 10, usage: 2, limit_remaining: 8 } },
  deepseek: { is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.20", granted_balance: "0", topped_up_balance: "4.20" }] },
};

function stubFetch(status) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization || null });
    const id = String(url).includes("openrouter") ? "openrouter" : "deepseek";
    const body = status === 200 ? ANSWERS[id] : { error: { message: "invalid key", code: 401 } };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

describe("refreshBalance: the card's balance read", () => {
  before(() => { for (const name of Object.values(ENV_NAMES)) delete process.env[name]; });

  for (const id of ["openrouter", "deepseek"]) {
    it(`${id}: a Railway key the provider turns down makes the card say so (not Ready); a key that works again clears it`, async () => {
      const store = railwayStore();
      const before = await providerStatus(id, { store, env: {} });
      assert.equal(before.state, "ready", "with nothing known yet, a key that is there looks ready");

      const refused = stubFetch(401);
      assert.equal(await refreshBalance(id, { store, fetch: refused.fetch }), null, "no balance to show");
      assert.equal(refused.calls.length, 1);
      assert.equal(refused.calls[0].auth, `Bearer ${KEYS[id]}`, "the key went to its own provider only");
      assert.equal(failureFlag(store, id)?.state, "auth");
      const after = await providerStatus(id, { store, env: {} });
      assert.equal(after.state, "error");
      assert.equal(after.ready, false, "the wizard's Next stays off");
      assert.match(after.detail, /rejected/);
      assert.ok(!JSON.stringify(after).includes(KEYS[id]), "never the key");

      // The owner fixes the Railway variable: the next read works and the card is Ready again.
      const fixed = railwayStore({ ...KEYS, [id]: `${KEYS[id]}Fixed` });
      for (const [k, v] of store.map) fixed.set(k, v);
      const works = stubFetch(200);
      const balance = await refreshBalance(id, { store: fixed, fetch: works.fetch });
      assert.ok(balance?.text, JSON.stringify(balance));
      assert.equal(failureFlag(fixed, id), null);
      assert.equal((await providerStatus(id, { store: fixed, env: {} })).state, "ready");
    });
  }

  it("in a test server (NODE_ENV=test and a loopback TARSEE_TEST_BASE_URL_<ID>) the read goes to the fake, never the real host", async () => {
    for (const id of ["openrouter", "deepseek"]) {
      const real = { openrouter: "https://openrouter.ai/api/v1/key", deepseek: "https://api.deepseek.com/user/balance" }[id];
      const path = new URL(real).pathname;
      const seam = { NODE_ENV: "test", [`TARSEE_TEST_BASE_URL_${id.toUpperCase()}`]: "http://127.0.0.1:47811/anthropic" };
      let net = stubFetch(200);
      await refreshBalance(id, { store: railwayStore(), fetch: net.fetch, env: seam });
      assert.deepEqual(net.calls.map((c) => c.url), [`http://127.0.0.1:47811${path}`], id);
      // Outside tests, or a seam that isn't loopback: the provider's own host, as always.
      for (const env of [{ ...seam, NODE_ENV: "production" }, { ...seam, [`TARSEE_TEST_BASE_URL_${id.toUpperCase()}`]: "http://canary.invalid" }, {}]) {
        net = stubFetch(200);
        await refreshBalance(id, { store: railwayStore(), fetch: net.fetch, env });
        assert.deepEqual(net.calls.map((c) => c.url), [real], `${id} ${JSON.stringify(env)}`);
      }
    }
  });

  it("only a turned-down key flags the card: no connection, a slow or broken provider, and a good read leave other flags alone", async () => {
    const store = railwayStore();
    const offline = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); };
    assert.equal(await refreshBalance("openrouter", { store, fetch: offline }), null);
    assert.equal(failureFlag(store, "openrouter"), null, "no connection is no verdict on the key");
    assert.equal(await refreshBalance("openrouter", { store, fetch: stubFetch(503).fetch, force: true }), null);
    assert.equal(failureFlag(store, "openrouter"), null, "a provider's own outage is no verdict on the key either");
    // An out-of-credit flag a turn wrote is the engine's to clear (a turn that works, or Test), not a balance read's.
    setFailureFlag(store, "openrouter", "out-of-credit", "used up");
    assert.ok(await refreshBalance("openrouter", { store, fetch: stubFetch(200).fetch, force: true }));
    assert.equal(failureFlag(store, "openrouter")?.state, "out-of-credit");
  });
});

describe("Test on Local AI: a server with no Responses API", () => {
  const ADDRESS = "http://192.168.1.20:11434/v1";
  /** A Local AI server: GET /models lists one model; POST /responses answers as `responses` says. */
  function localServer(responses) {
    const calls = [];
    const fetch = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET", body: init.body ?? null, auth: init.headers?.Authorization || null });
      if (String(url) === `${ADDRESS}/models`) return new Response(JSON.stringify({ object: "list", data: [{ id: "llama3.1:8b" }] }), { status: 200 });
      if (String(url) === `${ADDRESS}/responses`) {
        if (responses instanceof Error) throw responses;
        return new Response(responses.text ?? JSON.stringify(responses.json ?? {}), { status: responses.status, headers: { "content-type": responses.text ? "text/plain" : "application/json" } });
      }
      throw new TypeError(`fetch failed: no stub for ${url}`);
    };
    return { fetch, calls };
  }
  const localStore = () => {
    const store = railwayStore({});
    store.set("ai.local.baseUrl", `${ADDRESS}/`);
    return store;
  };

  it("says so, with what to update, when /responses isn't there (old Ollama, old LM Studio, a chat-completions-only server)", async () => {
    for (const answer of [
      { status: 404, text: "404 page not found" },
      { status: 404, json: { detail: "Not Found" } },
      { status: 200, json: { error: "Unexpected endpoint or method. (POST /v1/responses)" } },
    ]) {
      const net = localServer(answer);
      const r = await probeProvider("local", { store: localStore(), fetch: net.fetch, env: {} });
      assert.equal(r.ok, false, JSON.stringify(answer));
      assert.equal(r.state, "needs-setup");
      assert.match(r.message, /no Responses API/);
      assert.match(r.message, /Ollama to 0\.13\.3 or newer/);
      const post = net.calls.find((c) => c.method === "POST");
      assert.equal(post.url, `${ADDRESS}/responses`);
      assert.equal(post.body, "{}", "no model named, so nothing loads on the server");
    }
  });

  it("anything else means the route is there: Test passes as before", async () => {
    for (const answer of [
      { status: 400, json: { error: { message: "model is required" } } },
      { status: 404, json: { error: { message: "model \"\" not found, try pulling it first" } } },
      { status: 422, json: { detail: [{ msg: "Field required", loc: ["body", "model"] }] } },
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
    ]) {
      const r = await probeProvider("local", { store: localStore(), fetch: localServer(answer).fetch, env: {} });
      assert.equal(r.ok, true, answer instanceof Error ? "network" : JSON.stringify(answer));
      assert.equal(r.message, "Reached your Local AI · 1 model");
    }
  });

  it("an Ollama-shaped or unknown server gets no request beyond /models and /responses", async () => {
    const net = localServer({ status: 400, json: { error: { message: "model is required" } } });
    await probeProvider("local", { store: localStore(), fetch: net.fetch, env: {} });
    assert.deepEqual(net.calls.map((c) => `${c.method} ${c.url.replace(ADDRESS, "")}`).sort(), ["GET /models", "POST /responses"]);
  });
});

describe("Test on Local AI: what the server really runs (llama.cpp, LM Studio, Ollama)", () => {
  const LLAMA = "http://127.0.0.1:9931/v1";

  /**
   * A server stub: routes maps "METHOD path" (the path after the origin) to a reply {status?, json?, text?}, or an
   * Error to throw. Records every request.
   */
  function server(origin, routes) {
    const calls = [];
    const fetch = async (url, init = {}) => {
      const p = String(url).slice(origin.length);
      calls.push({ method: init.method || "GET", path: p, auth: init.headers?.Authorization || null, body: init.body ?? null });
      const r = routes[`${init.method || "GET"} ${p}`];
      if (!r) throw new TypeError(`fetch failed: no stub for ${init.method || "GET"} ${p}`);
      if (r instanceof Error) throw r;
      const reply = typeof r === "function" ? r(init) : r;
      return new Response(reply.text ?? JSON.stringify(reply.json ?? {}), { status: reply.status || 200 });
    };
    return { fetch, calls };
  }
  const store = (url, extra = {}) => {
    const s = railwayStore({});
    s.set("ai.local.baseUrl", url);
    for (const [k, v] of Object.entries(extra)) s.set(k, v);
    return s;
  };
  /** llama-server b12238 as it answers (checked against a real one): -m <file> --alias spark-4b -c <ctx>. */
  const llama = ({ ctx = 65_536, build = "b12238-08f945ffb", id = "qwen3.5-9b", responses = { status: 400, json: { error: { code: 400, message: "'input' is required", type: "invalid_request_error" } } }, props } = {}) => server("http://127.0.0.1:9931", {
    "GET /v1/models": { json: {
      models: [{ name: id, model: id, capabilities: ["completion"] }], object: "list",
      data: [{ id, aliases: [id], object: "model", created: 1794273395, owned_by: "llamacpp", meta: { n_ctx: ctx, n_ctx_train: 262_144, n_params: 9e9 } }],
    } },
    "GET /props": props ?? { json: { build_info: build, default_generation_settings: { n_ctx: ctx, params: {} }, total_slots: 4, model_alias: id } },
    "POST /v1/responses": responses,
  });

  it("llama.cpp: the build and the context from the server, in Test's words, and the context a turn uses", async () => {
    const net = llama();
    const s = store(LLAMA);
    const r = await probeProvider("local", { store: s, fetch: net.fetch, env: {} });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, "Reached your Local AI · llama.cpp b12238 · 1 model · 64K context");
    assert.deepEqual(net.calls.map((c) => `${c.method} ${c.path}`).sort(), ["GET /props", "GET /v1/models", "POST /v1/responses"]);
    assert.deepEqual(catalogModels("local-models").map((m) => [m.id, m.context, m.serverContext]), [["qwen3.5-9b", 65_536, 65_536]]);
    // The context rule: the server's size, the owner's when smaller, never the 128K default over the server's.
    assert.equal(contextTokensFor("local", "qwen3.5-9b", s), 65_536);
    s.set("ai.local.context", 128_000);
    assert.equal(contextTokensFor("local", "qwen3.5-9b", s), 65_536, "the owner's 128,000 can't stretch what the server gives");
    s.set("ai.local.context", 40_000);
    assert.equal(contextTokensFor("local", "qwen3.5-9b", s), 40_000, "a smaller setting wins");
  });

  it("llama.cpp with room for under 32,768 tokens: Test says so, and how to start it", async () => {
    const r = await probeProvider("local", { store: store(LLAMA), fetch: llama({ ctx: 8192 }).fetch, env: {} });
    assert.equal(r.ok, false);
    assert.equal(r.state, "needs-setup");
    assert.equal(r.message, "llama.cpp was started with room for only 8,192 tokens. Tarsee needs at least 32,768. Start it again with -c 65536.");
  });

  it("a llama.cpp build before b11768: Test says to update it", async () => {
    const r = await probeProvider("local", { store: store(LLAMA), fetch: llama({ build: "b9000-abcdef0" }).fetch, env: {} });
    assert.equal(r.ok, false);
    assert.match(r.message, /^Update llama\.cpp to b11768 or newer: older builds can mix up tool calls\. This one is b9000\.$/);
  });

  it("a llama-server before b7793 (404 File Not Found for /v1/responses) has no Responses API, and the words name all three servers", async () => {
    const r = await probeProvider("local", { store: store(LLAMA), fetch: llama({ build: "b7792-0000000", responses: { status: 404, text: "File Not Found" } }).fetch, env: {} });
    assert.equal(r.ok, false);
    assert.match(r.message, /no Responses API/);
    assert.match(r.message, /Update Ollama to 0\.13\.3 or newer, LM Studio to 0\.3\.29 or newer or llama\.cpp to b11768 or newer/);
  });

  it("still loading its model (503 Loading model): Test says to try again in a minute", async () => {
    const loading = { status: 503, json: { error: { code: 503, message: "Loading model", type: "unavailable_error" } } };
    const r = await probeProvider("local", { store: store(LLAMA), fetch: server("http://127.0.0.1:9931", { "GET /v1/models": loading, "POST /v1/responses": loading }).fetch, env: {} });
    assert.equal(r.ok, false);
    assert.equal(r.message, "Your Local AI is still loading its model. Click Test again in a minute.");
  });

  it("started with --api-key and no key (or the wrong one) in Tarsee: the key hint, from /models or from /responses", async () => {
    const denied = { status: 401, json: { error: { code: 401, message: "Invalid API Key", type: "authentication_error" } } };
    for (const net of [
      server("http://127.0.0.1:9931", { "GET /v1/models": denied, "POST /v1/responses": denied }),
      llama({ responses: denied, props: denied }),
    ]) {
      const s = store(LLAMA);
      const r = await probeProvider("local", { store: s, fetch: net.fetch, env: {} });
      assert.equal(r.ok, false);
      assert.equal(r.message, "Your Local AI turned down Tarsee's key. Check it in Settings > AI.");
      assert.equal(failureFlag(s, "local")?.state, "auth", "the card shows the rejected key");
    }
  });

  it("a model named after its file path, with spaces in it: Test says to start llama-server with --alias", async () => {
    const r = await probeProvider("local", { store: store(LLAMA), fetch: llama({ id: "E:/models/My Model Q4.gguf" }).fetch, env: {} });
    assert.equal(r.ok, false);
    assert.match(r.message, /with spaces in it, which Tarsee can't use\. Start llama-server with --alias and a short name/);
  });

  it("LM Studio: its embedding models aren't chat models, and a loaded model's context is the one it was loaded with", async () => {
    const LMS = "http://127.0.0.1:1234";
    const net = server(LMS, {
      "GET /v1/models": { json: { object: "list", data: ["spark-4b", "text-embedding-nomic-embed-text-v1.5", "qwen3.6-35b"].map((id) => ({ id, object: "model", owned_by: "organization_owner" })) } },
      "POST /v1/responses": { status: 400, json: { error: { message: "Missing required parameter: 'model'." } } },
      "GET /api/v0/models": { json: { object: "list", data: [
        { id: "spark-4b", type: "llm", state: "loaded", loaded_context_length: 32_768, max_context_length: 1_048_576 },
        { id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings", state: "not-loaded", max_context_length: 2048 },
        { id: "qwen3.6-35b", type: "vlm", state: "not-loaded", max_context_length: 262_144 },
      ] } },
    });
    const s = store(`${LMS}/v1`, { "ai.local.model": "spark-4b" });
    const r = await probeProvider("local", { store: s, fetch: net.fetch, env: {} });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, "Reached your Local AI · LM Studio · 2 models · 32K context");
    assert.deepEqual(r.models, ["spark-4b", "qwen3.6-35b"], "the embedding model is left out");
    assert.deepEqual(catalogModels("local-models").map((m) => [m.id, m.context, m.serverContext ?? null]), [["spark-4b", 32_768, 32_768], ["qwen3.6-35b", 128_000, null]]);
    // The owner's case: LM Studio loaded the model at 32,768 while the card assumed 128,000.
    assert.equal(contextTokensFor("local", "spark-4b", s), 32_768);
    // Loaded too small for the card's model: Test says so.
    const small = server(LMS, {
      "GET /v1/models": { json: { data: [{ id: "spark-4b", owned_by: "organization_owner" }] } },
      "POST /v1/responses": { status: 400, json: { error: { message: "Missing required parameter: 'model'." } } },
      "GET /api/v0/models": { json: { data: [{ id: "spark-4b", type: "llm", state: "loaded", loaded_context_length: 4096 }] } },
    });
    const r2 = await probeProvider("local", { store: s, fetch: small.fetch, env: {} });
    assert.equal(r2.ok, false);
    assert.equal(r2.message, "LM Studio loaded spark-4b with room for only 4,096 tokens. Tarsee needs at least 32,768. Load it again with a longer context length (65536 is a good choice).");
  });

  it("Ollama: its capabilities leave the embedding models out; a loaded model's context comes from /api/ps", async () => {
    const OLL = "http://127.0.0.1:11434";
    const net = server(OLL, {
      "GET /v1/models": { json: { object: "list", data: [
        { id: "qwen3:8b", object: "model", created: 1_760_000_000, owned_by: "library" },
        { id: "nomic-embed-text:latest", object: "model", created: 1_760_000_000, owned_by: "library" },
      ] } },
      "POST /v1/responses": { status: 400, json: { error: { message: "model is required" } } },
      "GET /api/ps": { json: { models: [{ name: "qwen3:8b", model: "qwen3:8b", context_length: 16_384 }] } },
      "POST /api/show": (init) => ({ json: JSON.parse(init.body).model === "qwen3:8b"
        ? { capabilities: ["completion", "tools", "thinking"], parameters: "temperature 0.6", model_info: { "qwen3.context_length": 40_960 } }
        : { capabilities: ["embedding"], model_info: { "nomic-bert.context_length": 2048 } } }),
    });
    const s = store(`${OLL}/v1`, { "ai.local.model": "qwen3:8b" });
    const r = await probeProvider("local", { store: s, fetch: net.fetch, env: {} });
    assert.deepEqual(r.models, ["qwen3:8b"]);
    assert.equal(r.ok, false, "16,384 is too little room");
    assert.match(r.message, /^Ollama runs qwen3:8b with room for only 16,384 tokens\. Tarsee needs at least 32,768\. Set OLLAMA_CONTEXT_LENGTH=65536/);
  });
});
