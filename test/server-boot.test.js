// What src/server.js does once at boot that can't be reached any other way (the module starts the whole server when
// it loads, so these read its text; the work itself is tested where it lives):
//  - it sweeps what a turn stopped mid-way left behind (lib/turn-leftovers.js, test/turn-leftovers.test.js);
//  - it reads the ChatGPT account's model list only through the settings store, so "API keys only" stops it
//    (lib/model-catalog.js refreshChatgptModels, test/chatgpt-list-keys-only.test.js): that read sends the plan's
//    sign-in to ChatGPT's backend.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

describe("src/server.js at boot", () => {
  it("sweeps a stopped turn's leftovers", () => {
    assert.match(server, /import \{[^}]*\bsweepTurnLeftovers\b[^}]*\} from "\.\/lib\/turn-leftovers\.js";/);
    assert.match(server, /\bsweepTurnLeftovers\(\{[^)]*stateDir: config\.STATE_DIR/);
  });

  it("reads the ChatGPT account's models with the settings store, so API keys only can stop it", () => {
    const calls = server.match(/refreshChatgptModels\([^)]*\)/g) || [];
    assert.ok(calls.length >= 1, "the boot read is there");
    for (const call of calls) assert.match(call, /store: settingsStore/, call);
  });
});
