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
});
