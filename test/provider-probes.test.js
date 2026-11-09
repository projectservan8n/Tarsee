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

const { refreshBalance } = await import("../src/ai/provider-probes.js");
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
