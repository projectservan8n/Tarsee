// What src/server.js does once at boot. Loading that module starts the whole server, so the steps themselves live in
// lib/boot-fixups.js runBootFixups and run here for real (a real settings store on a temp database, real temp
// folders); src/server.js is read as text only to prove it calls them, and read with its comments taken out, so a
// call that has been commented out (or left only in a comment) never counts as made.
//  - runBootFixups tidies what older versions left in the settings (the old wizard's placeholder Claude key, per
//    provider base URLs, the old Voice tab's masked keys, empty secrets such as an old captcha Save left) and sweeps
//    what a turn stopped mid-way left behind (lib/turn-leftovers.js, test/turn-leftovers.test.js);
//  - the ChatGPT account's model list is read only through the settings store, so "API keys only" stops it
//    (lib/model-catalog.js refreshChatgptModels, test/chatgpt-list-keys-only.test.js): that read sends the plan's
//    sign-in to ChatGPT's backend.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-server-boot-"));
process.env.TARSEE_STATE_DIR = path.join(tmp, "state");
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "2".repeat(40);

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { AuditLog } = await import("../src/db/audit.js");
const { runBootFixups } = await import("../src/lib/boot-fixups.js");

const opened = [];
after(() => {
  for (const db of opened) db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Source text with its comments taken out (line breaks kept, so a match can be anchored to the start of a line).
 * Strings, template strings and regex literals are copied as they are, so a "//" inside one ("http://...") is code.
 */
function liveCode(src) {
  let out = "";
  let last = "";
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
      continue;
    }
    const regex = c === "/" && (!last || "(,=:[!&|?{};".includes(last));
    if (c === '"' || c === "'" || c === "`" || regex) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const ch = src[j];
        if (ch === "\\") { j += 2; continue; }
        if (ch === "\n" && c !== "`") break;
        if (regex) {
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) break;
        } else if (ch === c) break;
        j++;
      }
      out += src.slice(i, j + 1);
      last = c;
      i = j + 1;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out;
}

const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const BOOT_IMPORT = /^import \{ runBootFixups \} from "\.\/lib\/boot-fixups\.js";/m;
const BOOT_CALL = /^runBootFixups\(\{ settingsStore, stateDir: config\.STATE_DIR \}\);/m;

describe("src/server.js at boot", () => {
  it("runs the boot fixups, as live code (not in a comment)", () => {
    const code = liveCode(server);
    assert.match(code, BOOT_IMPORT);
    assert.match(code, BOOT_CALL);
    assert.equal(code.match(new RegExp(BOOT_CALL.source, "gm")).length, 1, "once");
    // The call comes after the settings store it is given, and before the boot key report reads the settings.
    const at = (re) => code.search(re);
    assert.ok(at(/^const settingsStore = new SettingsStore\(db, auditLog\);/m) < at(BOOT_CALL), "after the store is made");
    assert.ok(at(BOOT_CALL) < at(/^settingsStore\.logKeyStatus\(\);/m), "before the key report");
  });

  it("a commented-out call doesn't count", () => {
    const commented = [
      server.replace(BOOT_CALL, (line) => `// ${line}`),
      server.replace(BOOT_CALL, (line) => `/* ${line} */`),
      server.replace(BOOT_CALL, (line) => `const skipped = 0; // ${line}`),
    ];
    for (const text of commented) {
      assert.notEqual(text, server, "the call was found to comment out");
      assert.doesNotMatch(liveCode(text), BOOT_CALL);
    }
    // A string with // in it is code, not a comment.
    assert.match(liveCode('const at = "http://0.0.0.0"; const re = /\\/\\//;\nrunBootFixups({ settingsStore, stateDir: config.STATE_DIR });'), BOOT_CALL);
  });

  it("reads the ChatGPT account's models with the settings store, so API keys only can stop it", () => {
    const calls = liveCode(server).match(/refreshChatgptModels\([^)]*\)/g) || [];
    assert.ok(calls.length >= 1, "the boot read is there");
    for (const call of calls) assert.match(call, /store: settingsStore/, call);
  });
});

describe("runBootFixups (lib/boot-fixups.js)", () => {
  const HOUR = 3_600_000;
  const NOW = Date.now();
  function folder(dir, name, ageMs) {
    const p = path.join(dir, name);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "file.txt"), "x");
    const t = new Date(NOW - ageMs);
    fs.utimesSync(path.join(p, "file.txt"), t, t);
    fs.utimesSync(p, t, t);
    return p;
  }
  function fresh(name) {
    const db = initDb(path.join(tmp, `${name}.db`));
    opened.push(db);
    const raw = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
    return { db, store: new SettingsStore(db, new AuditLog(db)), raw };
  }
  const quiet = (fn) => {
    const { log, warn } = console;
    console.log = () => {};
    console.warn = () => {};
    try { return fn(); } finally { Object.assign(console, { log, warn }); }
  };

  it("tidies what older versions left in the settings and sweeps a stopped turn's leftovers", () => {
    const { store, raw } = fresh("tidy");
    const realKey = "sk-proj-test-" + "0".repeat(24);
    store.set("ai.claude-code.apiKey", "subscription");
    store.set("ai.openrouter.baseUrl", "https://example.invalid/v1");
    store.set("ai.local.baseUrl", "http://127.0.0.1:11434/v1");
    store.set("ai.openai.apiKey", "sk-p...wxyz");
    store.set("voice.openai_api_key", realKey);
    store.set("captcha.api_key", "");
    store.set("ai.deepseek.apiKey", realKey);
    const stateDir = path.join(tmp, "state-tidy");
    const tmpDir = path.join(tmp, "system-temp-tidy");
    const oldVerify = folder(path.join(stateDir, "verify"), "deepseek-aaaaaa", 2 * HOUR);
    const newVerify = folder(path.join(stateDir, "verify"), "deepseek-bbbbbb", 60_000);
    const oldPictures = folder(path.join(tmpDir, "tarsee-codex"), "tarsee-images-cccccc", 2 * HOUR);

    const result = quiet(() => runBootFixups({ settingsStore: store, stateDir, tmpDir, now: NOW }));

    for (const key of ["ai.claude-code.apiKey", "ai.openrouter.baseUrl", "ai.openai.apiKey", "voice.openai_api_key", "captcha.api_key"]) {
      assert.equal(raw(key), null, `${key} is removed`);
    }
    assert.equal(store.get("ai.local.baseUrl"), "http://127.0.0.1:11434/v1", "Local AI's own address stays");
    assert.equal(store.get("ai.deepseek.apiKey"), realKey, "a real key stays");
    assert.ok(!fs.existsSync(oldVerify) && !fs.existsSync(oldPictures), "a stopped turn's leftovers are swept");
    assert.ok(fs.existsSync(newVerify), "a Verify running now stays");
    assert.deepEqual(result.leftovers, { pictures: 1, verify: 1 });
    assert.deepEqual(result.settings.emptySecrets.removed, ["captcha.api_key"]);

    const again = quiet(() => runBootFixups({ settingsStore: store, stateDir, tmpDir, now: NOW }));
    assert.deepEqual(again.leftovers, { pictures: 0, verify: 0 }, "nothing more the second time");
    assert.deepEqual(again.settings.emptySecrets.removed, []);
  });

  it("one step that fails is logged and the others still run", () => {
    const { store, raw } = fresh("one-fails");
    store.set("captcha.api_key", "");
    store.set("ai.openai.apiKey", "sk-p...wxyz");
    store.removeProviderBaseUrls = () => { throw new Error("the database is busy"); };
    const stateDir = path.join(tmp, "state-one-fails");
    const oldVerify = folder(path.join(stateDir, "verify"), "openai-dddddd", 2 * HOUR);
    const warned = [];
    const { log, warn } = console;
    console.log = () => {};
    console.warn = (...args) => warned.push(args.join(" "));
    let result;
    try { result = runBootFixups({ settingsStore: store, stateDir, tmpDir: path.join(tmp, "no-temp"), now: NOW }); } finally { Object.assign(console, { log, warn }); }
    assert.ok(warned.some((w) => /base URL fixup failed: the database is busy/.test(w)), warned.join("\n"));
    assert.equal(raw("captcha.api_key"), null);
    assert.equal(raw("ai.openai.apiKey"), null);
    assert.ok(!fs.existsSync(oldVerify));
    assert.equal(result.settings.baseUrls, null);
  });
});
