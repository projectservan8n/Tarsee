// How to connect each chat platform (src/public/js/channel-guides-core.js): Settings → Channels and the setup
// wizard draw their steps from it, so it has to cover every channel the server runs and match the page it fills.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

await import("../src/public/js/channel-guides-core.js");
const G = globalThis.ChannelGuides;
const page = fs.readFileSync(fileURLToPath(new URL("../src/public/index.html", import.meta.url)), "utf8");

describe("channel guides", () => {
  it("cover every channel the server can run, in the order they are offered", () => {
    assert.deepEqual(G.PLATFORMS.map((p) => p.id), ["telegram", "discord", "slack", "whatsapp", "email"]);
  });

  it("each has a name, a one-line 'what it takes', steps and tips", () => {
    for (const p of G.PLATFORMS) {
      assert.ok(p.name && p.needs, p.id);
      assert.ok(p.steps.length >= 4, `${p.id}: steps`);
      assert.ok(Array.isArray(p.tips), `${p.id}: tips`);
      assert.ok(!/\$\{/.test(p.steps.join("") + p.tips.join("")), `${p.id}: no template left in the text`);
    }
  });

  it("each has its own section on the Channels page, with a status line and a place for its guide", () => {
    for (const p of G.PLATFORMS) {
      assert.match(page, new RegExp(`id="${p.section}"`), `${p.id}: section`);
      assert.match(page, new RegExp(`id="${p.id}ChannelStatus"`), `${p.id}: status line`);
      assert.match(page, new RegExp(`data-guide-slot="${p.id}"`), `${p.id}: guide slot`);
    }
  });

  it("links open in a new tab, over https", () => {
    for (const p of G.PLATFORMS) {
      for (const a of (p.steps.join("") + p.tips.join("")).match(/<a [^>]*>/g) || []) {
        assert.match(a, /href="https:\/\//, a);
        assert.match(a, /target="_blank"/, a);
        assert.match(a, /rel="noopener noreferrer"/, a);
      }
    }
  });

  it("draws a guide as steps in order and tips, folded unless asked open", () => {
    const html = G.guideHtml("telegram");
    assert.match(html, /^<details class="channel-guide" data-guide="telegram">/);
    assert.match(html, /<summary>How to connect Telegram<\/summary>/);
    assert.equal((html.match(/<li>/g) || []).length, G.get("telegram").steps.length + G.get("telegram").tips.length);
    assert.ok(html.indexOf("/newbot") < html.indexOf("Paste it"), "steps in order");
    assert.match(G.guideHtml("slack", { open: true }), /data-guide="slack" open>/);
    assert.equal(G.guideHtml("nope"), "");
  });

  it("has an app-password note for every email preset button", () => {
    const presets = [...page.matchAll(/data-preset="([a-z]+)"/g)].map((m) => m[1]);
    assert.ok(presets.length >= 6);
    for (const name of presets) assert.ok(G.EMAIL_PROVIDERS[name], `email preset ${name}`);
  });

  it("says a channel's status in words", () => {
    assert.deepEqual(G.statusLine({ status: "running", identity: "@my_tarsee_bot" }), { text: "Connected as @my_tarsee_bot", tone: "ok" });
    assert.deepEqual(G.statusLine({ status: "running" }), { text: "Connected", tone: "ok" });
    assert.deepEqual(G.statusLine({ status: "starting" }), { text: "Connecting…", tone: "wait" });
    assert.deepEqual(G.statusLine({ status: "error", error: "Telegram refused the bot token." }), { text: "Telegram refused the bot token.", tone: "bad" });
    assert.deepEqual(G.statusLine({ status: "error" }), { text: "Could not connect", tone: "bad" });
    assert.deepEqual(G.statusLine({ status: "stopped" }), { text: "Saved, not connected yet", tone: "wait" });
    assert.deepEqual(G.statusLine({ status: "not_configured" }, { enabled: false, configured: true }), { text: "Off", tone: "off" }, "saved, switched off");
    assert.deepEqual(G.statusLine({ status: "not_configured" }, { enabled: false, configured: false }), { text: "Not set up", tone: "off" }, "never set up");
    assert.deepEqual(G.statusLine({ status: "not_configured" }), { text: "Not set up", tone: "off" });
    const warning = "Saved, but couldn't check the token with WHAPI (no answer in time).";
    assert.deepEqual(G.statusLine({ status: "running", identity: null, warning }), { text: warning, tone: "wait" }, "running but unchecked is not 'Connected'");
    assert.deepEqual(G.statusLine(undefined), { text: "Not set up", tone: "off" });
  });
});
