// How to set up each AI (src/public/js/provider-guides-core.js): Settings → AI and the setup wizard's "Choose your AI"
// draw their steps, costs and status lines from it, so it has to cover every provider Tarsee knows (the registry,
// src/ai/provider-registry.js) and match the cards on the page it fills.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

await import("../src/public/js/provider-guides-core.js");
const G = globalThis.ProviderGuides;
const { PROVIDERS: REGISTRY, PROVIDER_IDS } = await import("../src/ai/provider-registry.js");
const page = fs.readFileSync(fileURLToPath(new URL("../src/public/index.html", import.meta.url)), "utf8");

/** Every piece of text a provider's guide shows. */
const allText = (p) => [p.needs, p.cost, ...p.steps, ...p.tips].join("\n");

describe("provider guides: what they cover", () => {
  it("every provider the registry knows, plans first, in the order the wizard offers them", () => {
    assert.deepEqual(G.PROVIDERS.map((p) => p.id), ["claude", "chatgpt", "anthropic", "openai", "openrouter", "deepseek", "local"]);
    assert.deepEqual([...G.PROVIDERS.map((p) => p.id)].sort(), [...PROVIDER_IDS].sort());
  });

  it("each kind matches the registry's: a plan sign-in, an API key, or a server you run", () => {
    const kindOf = { subscription: "plan", key: "key", local: "local" };
    for (const p of G.PROVIDERS) assert.equal(p.kind, kindOf[REGISTRY[p.id].kind], p.id);
  });

  it("each has a name, a one-line 'what it takes', a one-line cost, numbered steps and tips", () => {
    for (const p of G.PROVIDERS) {
      assert.ok(p.name && p.needs && p.cost, p.id);
      assert.ok(!/\n/.test(p.needs) && !/\n/.test(p.cost), `${p.id}: one line each`);
      assert.ok(p.steps.length >= 3, `${p.id}: steps`);
      assert.ok(Array.isArray(p.tips) && p.tips.length >= 1, `${p.id}: tips`);
      assert.ok(!/\$\{/.test(allText(p)), `${p.id}: no template left in the text`);
    }
  });

  it("the key providers say where the key comes from and what one looks like", () => {
    for (const p of G.PROVIDERS.filter((x) => x.kind === "key")) {
      assert.match(p.getKeyUrl, /^https:\/\//, p.id);
      assert.ok(p.keyPlaceholder, `${p.id}: a placeholder for the key box`);
      assert.ok(/spend|limit|budget|top.?up|credit/i.test(allText(p)), `${p.id}: how to keep its spending small`);
    }
  });

  it("the Claude plan signs in with claude auth login in the Terminal (or a Railway token)", () => {
    const text = allText(G.get("claude"));
    assert.match(text, /claude auth login/, "Claude Code's own sign-in command (claude auth login --help)");
    assert.equal(G.get("claude").command, "claude auth login");
    assert.match(text, /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.match(text, /claude setup-token/);
  });

  it("ChatGPT uses Codex's device-code sign-in, names no model, and says free plans get less", () => {
    const text = allText(G.get("chatgpt"));
    assert.match(text, /Settings.*Security/, "where to turn device code sign-in on");
    assert.match(text, /device code/i);
    // The switch's own name and heading as ChatGPT shows them (Settings → Security → App security).
    assert.match(text, /Enable device code sign-in for Codex/, "the switch named as ChatGPT names it");
    assert.match(text, /App security/, "the heading the switch sits under");
    assert.doesNotMatch(text, /device code authorization for Codex/, "the old, wrong name of the switch");
    assert.match(text, /codex login --device-auth/, "the Terminal fallback");
    assert.match(text, /[Ff]ree/);
    assert.doesNotMatch(text, /\bgpt-|Luna|Sol\b|Astra/, "never a hard-coded ChatGPT model");
    for (const p of G.PROVIDERS) assert.doesNotMatch(allText(p), /Continue with ChatGPT/, `${p.id}: no Continue with ChatGPT`);
  });

  it("Local AI names Ollama and LM Studio with their usual addresses", () => {
    const local = G.get("local");
    const text = allText(local);
    assert.match(text, /Ollama/);
    assert.match(text, /LM Studio/);
    assert.deepEqual(local.presets.map((x) => x.url), ["http://localhost:11434/v1", "http://localhost:1234/v1"]);
  });

  it("Local AI says which versions speak the Responses API Tarsee uses (Ollama 0.13.3, LM Studio 0.3.29)", () => {
    const text = allText(G.get("local"));
    assert.match(text, /Ollama 0\.13\.3 or newer/);
    assert.match(text, /LM Studio 0\.3\.29 or newer/);
  });

  it("the Anthropic key is made in a workspace (a key outside one needs a header Tarsee doesn't send)", () => {
    const a = G.get("anthropic");
    assert.match(a.steps.join("\n"), /<strong>Create key<\/strong>[\s\S]*workspace/i, "the step that makes the key picks a workspace");
    assert.match(a.tips.join("\n"), /workspace/i, "and the tip for when Test says so");
    assert.match(allText(a), /starts with <code>sk-ant-<\/code>/, "the prefix the Console documents");
  });

  it("the plan-vs-key note says plans are for your own use and API keys for other people", () => {
    assert.match(G.TERMS_NOTE, /own (personal )?use/i);
    assert.match(G.TERMS_NOTE, /API key/);
    assert.match(G.TERMS_NOTE, /other people|team|customers/i);
  });

  it("every key provider's guide and card, and the docs, say a command the agent runs can still read the key (design 4.5 R10, A9)", async () => {
    // Both engines keep the key out of the environment of the commands the agent runs, but those commands run as the
    // same user as the engine, so on Linux they can still read it from the engine's process
    // (test/key-exposure-linux.test.js). A capped key is the real guard, so every place that takes a key says so.
    const docs = fs.readFileSync(fileURLToPath(new URL("../docs/providers.md", import.meta.url)), "utf8");
    const routes = fs.readFileSync(fileURLToPath(new URL("../src/routes/ai.js", import.meta.url)), "utf8");
    const STATED = /can still read (this|the) key/i;
    for (const p of G.PROVIDERS.filter((x) => ["anthropic", "openai", "openrouter", "deepseek", "local"].includes(x.id))) assert.match(allText(p), STATED, p.id);
    assert.match(docs, STATED, "docs/providers.md");
    assert.match(routes, STATED, "routes/ai.js notesFor");
    for (const [name, text] of [...G.PROVIDERS.map((p) => [p.id, allText(p)]), ["docs/providers.md", docs], ["routes/ai.js", routes]]) {
      assert.doesNotMatch(text, /kept out of the agent['’]s shell|commands the agent runs can['’]?t read|can['’]?t read (it|this key|the key)|\bkept out\b/i, `${name} promises the key can't be read`);
    }
  });

  it("the wizard's three choices: the two plans, then the five key providers", () => {
    assert.deepEqual(G.WIZARD.plans, ["claude", "chatgpt"]);
    assert.deepEqual(G.WIZARD.keys, ["anthropic", "openai", "openrouter", "deepseek", "local"]);
    for (const id of [...G.WIZARD.plans, ...G.WIZARD.keys]) assert.ok(G.get(id), id);
  });
});

describe("provider guides: the page they fill", () => {
  it("each provider has its own card on the AI tab, with a status line, a place for its guide and its controls", () => {
    for (const p of G.PROVIDERS) {
      assert.match(page, new RegExp(`id="${p.section}"`), `${p.id}: card`);
      assert.match(page, new RegExp(`id="${p.id}AiStatus"`), `${p.id}: status line`);
      assert.match(page, new RegExp(`data-ai-guide-slot="${p.id}"`), `${p.id}: guide slot`);
      assert.match(page, new RegExp(`data-ai-body="${p.id}"`), `${p.id}: controls`);
    }
  });

  it("links open in a new tab, over https", () => {
    const texts = [...G.PROVIDERS.map(allText), G.TERMS_NOTE];
    let links = 0;
    for (const t of texts) {
      for (const a of t.match(/<a [^>]*>/g) || []) {
        links++;
        assert.match(a, /href="https:\/\//, a);
        assert.match(a, /target="_blank"/, a);
        assert.match(a, /rel="noopener noreferrer"/, a);
      }
    }
    assert.ok(links >= 10, "the guides link to where things are done");
  });

  it("draws a guide as steps in order, the cost and the tips, folded unless asked open", () => {
    const html = G.guideHtml("deepseek");
    assert.match(html, /^<details class="channel-guide ai-guide" data-ai-guide="deepseek">/);
    assert.match(html, /<summary>How to set up DeepSeek<\/summary>/);
    const d = G.get("deepseek");
    assert.equal((html.match(/<li>/g) || []).length, d.steps.length + d.tips.length);
    assert.ok(html.indexOf(d.steps[0]) < html.indexOf(d.steps[1]), "steps in order");
    assert.ok(html.includes(d.cost), "what it costs");
    assert.match(G.guideHtml("claude", { open: true }), /data-ai-guide="claude" open>/);
    assert.equal(G.guideHtml("nope"), "");
  });

  it("the setup wizard's steps name the wizard's own buttons, not Settings → AI's (Save key, Test, Use this AI, Verify)", () => {
    const setup = fs.readFileSync(fileURLToPath(new URL("../src/public/js/setup.js", import.meta.url)), "utf8");
    const stepsOf = (html) => html.match(/<ol class="channel-guide-steps">([\s\S]*?)<\/ol>/)[1];
    for (const id of [...G.WIZARD.plans, ...G.WIZARD.keys]) {
      const steps = stepsOf(G.guideHtml(id, { wizard: true }));
      // (Other companies' pages have buttons of their own, OpenAI's Save among them: only Tarsee's Settings words are out.)
      assert.doesNotMatch(steps, /<strong>(Save key|Test|Use this AI|Verify)<\/strong>|<strong>Save<\/strong>, then|&gt;_/, id);
      // Read as text, as a person does: "click Test" would send them to a button the wizard doesn't have.
      assert.doesNotMatch(steps.replace(/<[^>]+>/g, ""), /click (Save key|Test|Use this AI|Verify)\b|\bTest (shows|lists)\b/, id);
    }
    for (const id of ["anthropic", "openai", "openrouter", "deepseek"]) assert.match(stepsOf(G.guideHtml(id, { wizard: true })), /<strong>Test and save<\/strong>/, id);
    assert.match(stepsOf(G.guideHtml("local", { wizard: true })), /<strong>Save and test<\/strong>/);
    for (const id of ["chatgpt", "anthropic", "openai", "openrouter", "deepseek", "local"]) assert.match(stepsOf(G.guideHtml(id, { wizard: true })), /click <strong>Next<\/strong>/, id);
    assert.match(stepsOf(G.guideHtml("claude", { wizard: true })), /<strong>Open the Terminal<\/strong> below/);
    assert.match(stepsOf(G.guideHtml("openrouter", { wizard: true })), /later in Settings → AI/, "OpenRouter's other models are verified there");
    // The buttons the wizard's steps name are the ones setup.js draws.
    assert.match(setup, />Test and save</);
    assert.match(setup, />Save and test</);
    assert.match(setup, /`Next: use /);
    assert.match(setup, />Open the Terminal ↗</);
    assert.match(setup, /guideHtml\(id, \{[^}]*wizard: true/, "and the wizard asks for its own wording");
    // Settings → AI keeps its own.
    assert.match(G.guideHtml("deepseek"), /click <strong>Save key<\/strong>, then <strong>Test<\/strong>/);
    assert.match(G.guideHtml("local"), /click <strong>Save<\/strong>, then <strong>Test<\/strong>/);
    assert.match(G.guideHtml("openrouter"), /click <strong>Verify<\/strong> first/);
    assert.match(G.guideHtml("claude"), /&gt;_/);
    assert.equal((G.guideHtml("deepseek", { wizard: true }).match(/<li>/g) || []).length, (G.guideHtml("deepseek").match(/<li>/g) || []).length, "the same steps and tips");
  });
});

describe("provider guides: status in words", () => {
  const card = (over) => ({ id: "deepseek", label: "DeepSeek", state: "ready", ready: true, detail: "Key saved in Tarsee (…a1b2).", fix: null, model: "deepseek-flash", ...over });

  it("a ready AI says what it uses, and its balance", () => {
    assert.deepEqual(G.statusLine(card(), { modelLabel: "DeepSeek Flash" }), { text: "Ready, using DeepSeek Flash", tone: "ok" });
    assert.deepEqual(G.statusLine(card()), { text: "Ready, using deepseek-flash", tone: "ok" });
    assert.deepEqual(G.statusLine(card({ balance: { text: "Balance $4.20" } }), { modelLabel: "DeepSeek Flash" }), { text: "Ready, using DeepSeek Flash · Balance $4.20", tone: "ok" });
    assert.deepEqual(G.statusLine(card({ id: "chatgpt", model: null, account: "you@example.com (Free)" })), { text: "Ready, signed in as you@example.com (Free), using your account's default model", tone: "ok" });
  });

  it("an AI that isn't ready says what's wrong and what to do", () => {
    assert.deepEqual(G.statusLine(card({ state: "needs-key", ready: false, detail: "No DeepSeek key yet.", fix: "Paste one below." })), { text: "No DeepSeek key yet. Paste one below.", tone: "off" });
    assert.deepEqual(G.statusLine(card({ state: "out-of-credit", ready: false, detail: "The balance is empty.", fix: null })), { text: "The balance is empty.", tone: "bad" });
    assert.equal(G.statusLine(card({ state: "sign-in-expired", ready: false, detail: "Expired." })).tone, "bad");
    assert.equal(G.statusLine(card({ state: "error", ready: false, detail: "Rejected." })).tone, "bad");
    assert.equal(G.statusLine(card({ state: "needs-sign-in", ready: false, detail: "Nobody has signed in." })).tone, "off");
    assert.equal(G.statusLine(card({ state: "needs-setup", ready: false, detail: "No address." })).tone, "off");
    assert.deepEqual(G.statusLine(card({ state: "blocked-keys-only", ready: false, detail: "x" })), { text: "Off: \"Only use API keys\" is on", tone: "off" });
    assert.deepEqual(G.statusLine(undefined), { text: "Checking…", tone: "wait" });
  });

  it("a short word for each state, for the chips and the header", () => {
    assert.equal(G.stateWord("ready"), "Ready");
    assert.equal(G.stateWord("needs-key"), "Needs a key");
    assert.equal(G.stateWord("needs-sign-in"), "Needs sign-in");
    assert.equal(G.stateWord("sign-in-expired"), "Sign-in expired");
    assert.equal(G.stateWord("out-of-credit"), "Out of credit");
    assert.equal(G.stateWord("blocked-keys-only"), "Off (API keys only)");
    assert.equal(G.stateWord("needs-setup"), "Needs setup");
    assert.equal(G.stateWord("error"), "Needs attention");
    assert.equal(G.toneOf("ready"), "ok");
    assert.equal(G.toneOf("out-of-credit"), "bad");
    assert.equal(G.toneOf("needs-key"), "off");
  });

  it("a Test result in words: the balance or the spending limit left", () => {
    assert.deepEqual(G.testLine({ ok: true, message: "Key works · Balance $4.20" }), { text: "✓ Key works · Balance $4.20", tone: "ok" });
    assert.deepEqual(G.testLine({ ok: false, message: "Key works, but the balance is empty. Top up at platform.deepseek.com." }), { text: "✗ Key works, but the balance is empty. Top up at platform.deepseek.com.", tone: "bad" });
    assert.deepEqual(G.testLine({ ok: false, state: "needs-key", message: "No key yet." }), { text: "No key yet.", tone: "off" });
  });
});
