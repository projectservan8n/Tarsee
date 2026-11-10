// Local AI on Railway: Railway has no GPUs, so a model server would have to live somewhere else; Tarsee doesn't offer
// Local AI there (the setup wizard, Settings > AI, the model list, every route), unless an address is already set
// (TARSEE_LOCAL_AI_URL, or one saved in Settings), so a setup that works keeps working. Self-hosted installs (Docker on
// your own machine, npm start) offer it as before.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-local-railway-"));
process.env.TARSEE_STATE_DIR = tmp;
for (const name of ["RAILWAY_PROJECT_ID", "TARSEE_LOCAL_AI_URL", "TARSEE_AI_PROVIDER", "TARSEE_KEYS_ONLY"]) delete process.env[name];

const { localAiHiddenHere, hideProviders, isShipped, shippedProviders } = await import("../src/ai/provider-registry.js");
const { runBootFixups } = await import("../src/lib/boot-fixups.js");
const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { createAiRouter } = await import("../src/routes/ai.js");

const db = initDb(path.join(tmp, "tarsee.db"));
const store = new SettingsStore(db);
const fakeStore = (values = {}) => ({ get: (k) => (k in values ? values[k] : null) });
after(() => {
  hideProviders([]);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Local AI isn't offered on Railway", () => {
  it("on Railway with no address set: hidden; an address set (the variable or Settings), or not on Railway: offered", () => {
    assert.equal(localAiHiddenHere({ env: { RAILWAY_PROJECT_ID: "p1" }, store: fakeStore() }), true);
    assert.equal(localAiHiddenHere({ env: { RAILWAY_PROJECT_ID: "p1", TARSEE_LOCAL_AI_URL: "http://ollama.railway.internal:11434/v1" }, store: fakeStore() }), false, "a model server the owner runs as a Railway service");
    assert.equal(localAiHiddenHere({ env: { RAILWAY_PROJECT_ID: "p1" }, store: fakeStore({ "ai.local.baseUrl": "http://10.0.0.5:9931/v1" }) }), false, "an address already saved keeps working");
    assert.equal(localAiHiddenHere({ env: {}, store: fakeStore() }), false, "self-hosted: offered");
    assert.equal(localAiHiddenHere({ env: { RAILWAY_PROJECT_ID: "" }, store: fakeStore() }), false);
  });

  it("a hidden AI is switched off everywhere isShipped is asked, and comes back when no longer hidden", () => {
    hideProviders(["local"]);
    assert.equal(isShipped("local"), false);
    assert.ok(!shippedProviders().some((p) => p.id === "local"));
    assert.equal(isShipped("deepseek"), true, "the others are untouched");
    hideProviders([]);
    assert.equal(isShipped("local"), true);
  });

  it("the boot decides it: on Railway with no address, Local AI is hidden and the log says why", () => {
    const logs = [];
    const log = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      const out = runBootFixups({ settingsStore: store, stateDir: tmp, tmpDir: tmp, env: { RAILWAY_PROJECT_ID: "p1" } });
      assert.deepEqual(out.hidden, ["local"]);
      assert.equal(isShipped("local"), false);
      assert.ok(logs.some((l) => /Local AI isn't offered on Railway/.test(l) && /TARSEE_LOCAL_AI_URL/.test(l)), logs.join("\n"));
      const self = runBootFixups({ settingsStore: store, stateDir: tmp, tmpDir: tmp, env: {} });
      assert.deepEqual(self.hidden, []);
      assert.equal(isShipped("local"), true, "a self-hosted boot offers it");
    } finally {
      console.log = log;
      hideProviders([]);
    }
  });

  it("Settings > AI and the setup wizard (GET /api/ai/providers) don't list it while hidden", async () => {
    const app = express();
    app.use(express.json());
    app.set("db", db);
    app.set("settingsStore", store);
    app.use("/api/ai", createAiRouter({ stateDir: tmp, claudeHomes: () => [], loginStatus: async () => ({ signedIn: false }), fetch: async () => { throw new TypeError("no network in this test"); } }));
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    try {
      const cards = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/ai/providers`)).json()).providers;
      hideProviders(["local"]);
      const hidden = (await cards()).find((c) => c.id === "local");
      assert.ok(!hidden || hidden.shipped === false, `hidden: ${JSON.stringify(hidden)}`);
      hideProviders([]);
      assert.equal((await cards()).find((c) => c.id === "local")?.shipped, true);
    } finally {
      hideProviders([]);
      server.closeAllConnections?.();
      server.close();
    }
  });
});
