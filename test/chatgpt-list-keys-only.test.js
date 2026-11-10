// "API keys only" promises that no plan sign-in is ever used. Reading the ChatGPT account's model list starts
// `codex app-server` in the plan's home, which sends the plan's sign-in to ChatGPT's backend, so with keys-only on
// (the ai.keysOnly setting, or TARSEE_KEYS_ONLY=1) lib/model-catalog.js refreshChatgptModels never reads it: not at
// boot (src/server.js passes the settings store), not for a turn, not for the picker. With it off, it reads as before.
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-chatgpt-keys-only-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
delete process.env.TARSEE_KEYS_ONLY;

const { refreshChatgptModels } = await import("../src/lib/model-catalog.js");
const { setCatalogModels, catalogModels } = await import("../src/ai/provider-registry.js");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ACCOUNT = [{ id: "gpt-6-luna", label: "GPT-6 Luna", default: true, efforts: ["low", "medium"] }];
function storeWith(values = {}) {
  const m = new Map(Object.entries(values));
  return { get: (k) => (m.has(k) ? m.get(k) : null) };
}
let reads = 0;
const list = async () => { reads++; return ACCOUNT; };

beforeEach(() => {
  reads = 0;
  setCatalogModels("chatgpt-models", []);
});

describe("the ChatGPT account's model list and API keys only", () => {
  it("keys-only in Settings: the list isn't read (no Codex, no sign-in sent)", async () => {
    const models = await refreshChatgptModels({ list, env: {}, stateDir: tmp, force: true, store: storeWith({ "ai.keysOnly": true }) });
    assert.equal(reads, 0);
    assert.deepEqual(models, []);
    assert.deepEqual(catalogModels("chatgpt-models"), []);
  });

  it("keys-only locked on by TARSEE_KEYS_ONLY=1: not read, with or without a store", async () => {
    await refreshChatgptModels({ list, env: { TARSEE_KEYS_ONLY: "1" }, stateDir: tmp, force: true, store: storeWith() });
    await refreshChatgptModels({ list, env: { TARSEE_KEYS_ONLY: "1" }, stateDir: tmp, force: true });
    assert.equal(reads, 0);
  });

  it("keys-only off: read as before", async () => {
    const models = await refreshChatgptModels({ list, env: {}, stateDir: tmp, force: true, store: storeWith({ "ai.keysOnly": false }) });
    assert.equal(reads, 1);
    assert.deepEqual(models.map((m) => m.id), ["gpt-6-luna"]);
  });
});
