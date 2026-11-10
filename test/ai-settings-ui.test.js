// Settings → AI, the setup wizard's "Choose your AI", the header chip and the Security tab's tool list (design 5,
// 4.14 and the Phase 5 UI tasks): what the page and its scripts must contain, read as files.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../src/public/${p}`, import.meta.url), "utf8");
const page = read("index.html");
const settings = read("js/settings.js");
const setup = read("js/setup.js");
const sw = read("sw.js");
const order = (html, a, b) => html.indexOf(a) >= 0 && html.indexOf(b) >= 0 && html.indexOf(a) < html.indexOf(b);

describe("Settings → AI: the page", () => {
  it("the tab is called AI", () => {
    assert.match(page, /<button class="settings-tab" data-tab="ai">[\s\S]*?AI\s*<\/button>/);
    assert.match(page, /<div class="settings-tab-panel" data-tab="ai">/);
    assert.doesNotMatch(page, /AI Provider/);
    assert.doesNotMatch(page, /data-tab="provider"/);
  });

  it("has the chips row, the banners, the default AI, the keys-only switch, the backup model and the monthly cap", () => {
    for (const id of ["aiChips", "aiBanners", "aiDefaultNow", "aiKeysOnly", "aiKeysOnlyNote", "aiBackupModel", "aiMonthlyCap", "aiSaveExtrasBtn", "aiTermsNote"]) {
      assert.match(page, new RegExp(`id="${id}"`), id);
    }
  });

  it("the old hidden provider fields are gone (no base URL a key could be pointed at)", () => {
    for (const id of ["settingsBaseUrl", "customBaseUrlGroup", "settingsProvider", "settingsApiKey", "saveProviderBtn"]) {
      assert.doesNotMatch(page, new RegExp(`id="${id}"`), `index.html: ${id}`);
      assert.doesNotMatch(settings, new RegExp(id), `settings.js: ${id}`);
    }
    assert.doesNotMatch(settings, /\bbaseUrl:\s*document/, "no base URL element");
  });

  it("the guides load before the scripts that use them, and the offline cache has them", () => {
    assert.match(page, /<script src="\/js\/provider-guides-core\.js"><\/script>/);
    assert.ok(order(page, "/js/provider-guides-core.js", "/js/settings.js"));
    assert.ok(order(page, "/js/provider-guides-core.js", "/js/setup.js"));
    assert.ok(sw.includes('"/js/provider-guides-core.js"'));
    assert.doesNotMatch(sw, /const CACHE_NAME = "tarsee-v12"/, "the cache version moves on so phones pick up the new page");
  });

  it("the header shows the active AI, and a banner when it needs attention", () => {
    assert.match(page, /id="aiHeaderChip"/);
    assert.match(page, /id="aiAttention"[^>]*hidden/);
  });

  it("talks to /api/ai for every card action", () => {
    for (const path of ["/api/ai/providers", "/api/ai/active", "/api/ai/keys/", "/api/ai/test/", "/api/ai/verify/", "/api/ai/keys-only", "/api/ai/chatgpt/login", "/api/ai/chatgpt/logout", "/api/ai/models/"]) {
      assert.ok(settings.includes(path), `settings.js: ${path}`);
    }
  });
});

describe("setup wizard: Choose your AI", () => {
  it("saves no placeholder key, and never the old 'subscription' one", () => {
    assert.doesNotMatch(setup, /["']subscription["']\s*}/, "no fake key value");
    assert.doesNotMatch(setup, /apiKey:\s*["'`]/, "a key sent is always one the person pasted");
    assert.doesNotMatch(setup, /saveProvider/);
  });

  it("offers the three choices and asks who will talk to this Tarsee", () => {
    for (const words of ["Choose your AI", "My Claude plan", "My ChatGPT plan", "My own API key", "Who will talk to this Tarsee?", "Just me", "Other people too"]) {
      assert.ok(setup.includes(words), words);
    }
    assert.ok(setup.includes("/api/ai/keys-only"), "the keys-only choice is saved, explicitly");
    assert.ok(setup.includes("/api/ai/active"), "the chosen AI becomes the default only once it's ready");
  });
});

describe("Settings → Security: Tool Permissions", () => {
  it("lists the tools from the registry, not a list written in the page", () => {
    assert.ok(settings.includes("/api/admin/tool-registry"));
    assert.doesNotMatch(settings, /\["read_file",\s*"write_file"/, "no hard-coded tool list");
    assert.doesNotMatch(settings, /const tools = \[/);
  });
});
