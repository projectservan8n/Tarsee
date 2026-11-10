// Clicking a node in a diagram asks the chat about that node, in a real browser. A diagram is a canvas page the
// create_diagram tool writes (src/lib/diagram-renderer.js). The chat shows it in an iframe sandboxed without
// allow-same-origin (js/chat.js canvasEmbedHtml), and the canvas middleware (src/lib/canvas.js) serves it with a CSP
// sandbox, so its script runs in an opaque origin and what it posts arrives from origin "null".
// js/chat.js _initDiagramListener takes a node click from there:
//   - a click on a node sends "Tell me more about: <label>. <sublabel>", or the node's own question
//   - a diagram served from Tarsee's own origin (an iframe with allow-same-origin) works as well
//   - nothing else is taken: a message from the chat window itself, from another window, from an iframe that isn't a
//     diagram's, from a canvas that isn't a diagram, or from a diagram in any shape but a node click's
//   - nor from one of the chat's diagram iframes showing a page from another origin
// The page is src/public, the canvases come through the real middleware, and a small fake answers every /api call.
// Runs on Playwright's own Chromium, else an installed Chrome or Edge; skipped where there is none
// (npx playwright install chromium).
/* global document, window, Chat -- the evaluate() bodies run in the browser */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

// Keep the canvases away from the real state directory (all three, so a folder set in the shell cannot win). Set
// before the imports below: src/config/env.js reads them once, when it is first loaded.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-diagram-click-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
const { CanvasServer, canvasMiddleware } = await import("../src/lib/canvas.js");
const { renderDiagramHtml } = await import("../src/lib/diagram-renderer.js");
const { securityHeaders } = await import("../src/middleware/security.js");

const PUBLIC = fileURLToPath(new URL("../src/public/", import.meta.url));

let browser = null;
try {
  const { chromium } = await import("playwright");
  for (const opts of [{}, { channel: "chrome" }, { channel: "msedge" }]) {
    try { browser = await chromium.launch(opts); break; } catch { /* the next one */ }
  }
} catch {
  browser = null;
}
const skip = browser ? false : "no Chromium, Chrome or Edge for Playwright";

// --- The canvases ------------------------------------------------------------------------------------------------

// A diagram as the create_diagram tool makes one (src/lib/tools.js): its canvas id is "diagram-" and the title's
// slug, and the page names that id as its diagramId.
const DIAGRAM = "diagram-test-flow";
// A canvas that isn't a diagram (create_canvas).
const REPORT = "weekly-report";
const canvases = CanvasServer.create();
canvases.serve(DIAGRAM, renderDiagramHtml({
  title: "Test flow",
  diagramId: DIAGRAM,
  nodes: [
    { id: "fetch", label: "Fetch the feed", sublabel: "Every hour", kind: "trigger" },
    { id: "sort", label: "Sort the items", kind: "processing", question: "Why sort them before saving?" },
    { id: "save", label: "Save the results", kind: "output" },
  ],
  edges: [{ from: "fetch", to: "sort" }, { from: "sort", to: "save" }],
}));
canvases.serve(REPORT, "<!DOCTYPE html><html><body><h1>Weekly report</h1></body></html>");

// --- The server: Tarsee's page and its canvases ------------------------------------------------------------------

let server;
let otherServer;
let origin;
let otherOrigin;
before(async () => {
  if (!browser) return;
  const app = express();
  app.use(securityHeaders);
  // Signed in (the canvases need it); /api never reaches here, the fake below answers it.
  app.use((req, _res, next) => { req.auth = { authenticated: true }; next(); });
  app.use(canvasMiddleware);
  // The same diagram with no sandbox header, which any page may frame: what an iframe with allow-same-origin loads
  // from Tarsee's own origin, or what one sent to another site gets from there.
  app.get("/unsandboxed/:id/", (req, res) => {
    res.removeHeader("X-Frame-Options");
    res.type("html").send(canvases.get(req.params.id));
  });
  app.use(express.static(PUBLIC));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  origin = `http://127.0.0.1:${server.address().port}`;
  // Another origin: the same server on another port.
  await new Promise((r) => { otherServer = app.listen(0, "127.0.0.1", r); });
  otherOrigin = `http://127.0.0.1:${otherServer.address().port}`;
});
after(async () => {
  await browser?.close();
  for (const s of [server, otherServer]) await new Promise((r) => (s ? s.close(r) : r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- A fake /api -------------------------------------------------------------------------------------------------

function fakeApi() {
  const calls = [];
  const card = { id: "claude", storageId: "claude-code", label: "Claude plan", kind: "subscription", shipped: true, active: true, state: "ready", ready: true, detail: "Ready.", fix: null, keySource: "sign-in", keyHint: null, keySourceText: null, account: null, balance: null, envKey: null, model: "sonnet", notes: [], settings: null };
  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ method, path: url.pathname, body });
    const json = (status, data) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    const p = url.pathname;
    if (p === "/api/auth/status") return json(200, { authenticated: true, needsPassword: true });
    if (p === "/api/auth/api-token") return json(200, { apiToken: null });
    if (p === "/api/settings/setup-status") return json(200, { needsSetup: false, needsPersonality: false, botName: "Tarsee", provider: "claude-code", hasKey: true });
    if (p === "/api/settings") return json(200, { settings: [] });
    if (p === "/api/skills") return json(200, { skills: [] });
    if (p === "/api/ai/providers") {
      return json(200, {
        active: { provider: "claude", label: "Claude plan", model: "sonnet", engine: "claude-code", chosenBy: "settings", state: "ready", ready: true, detail: "Ready.", fix: null, streaming: true },
        keysOnly: { on: false, locked: false },
        providers: [card],
        spend: { monthUsd: 0, costNote: "est", capUsd: null, timeZone: "UTC" },
        banners: [],
      });
    }
    if (p === "/api/chat/models") {
      return json(200, {
        picker: { groups: [{ provider: "claude", label: "Claude plan", kind: "subscription", defaultModel: "sonnet", searchable: false, sections: [{ id: "main", label: null, entries: [{ id: "sonnet", name: "Sonnet 5.5", provider: "claude", ref: "claude:sonnet", alias: "sonnet", family: "sonnet", badges: [] }] }] }], unavailable: [] },
        defaults: { provider: "claude", model: "sonnet", ref: "claude:sonnet", effort: "medium" },
        models: [],
      });
    }
    if (p.startsWith("/api/chat/channels")) return json(200, { channels: [] });
    // A message sent: answered as the server answers a command (no stream), so the bubble just turns Sent.
    if (p === "/api/chat/send" && method === "POST") return json(200, { command: true, response: "", conversationId: null });
    return json(200, {});
  }
  return { calls, handle };
}

async function openPage({ bypassCSP = false } = {}) {
  const api = fakeApi();
  // No service worker, by not registering one: Playwright's serviceWorkers: "block" reads navigator.serviceWorker in
  // every frame, which throws in a sandboxed one like a diagram's.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  // Nothing leaves the machine: fonts and CDN scripts are refused, /api goes to the fake.
  await page.route((url) => !url.href.startsWith(`${origin}/`) && !url.href.startsWith(`${otherOrigin}/`), (route) => route.abort());
  await page.route(`${origin}/api/**`, (route) => api.handle(route));
  await page.route(`${origin}/js/sw-register.js`, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`${origin}/`);
  await page.locator("#messageInput").waitFor();
  return { page, api, errors, context };
}

/** What the chat sent to the AI: the words of each POST /api/chat/send. */
const sent = (api) => api.calls.filter((c) => c.method === "POST" && c.path === "/api/chat/send").map((c) => c.body?.message);

async function waitForSent(api, count) {
  for (let i = 0; i < 100 && sent(api).length < count; i++) await new Promise((r) => setTimeout(r, 50));
  return sent(api);
}

/** The frame whose address ends with `suffix`, once it has loaded. */
async function frameAt(page, suffix) {
  for (let i = 0; i < 100; i++) {
    const frame = page.frames().find((f) => f.url().endsWith(suffix));
    if (frame) { await frame.waitForLoadState("load"); return frame; }
    await page.waitForTimeout(50);
  }
  throw new Error(`no frame at ${suffix}`);
}

/** Draw an answer in the chat, as a reply that names the canvases does. */
const showAnswer = (page, text) => page.evaluate((t) => { Chat.appendMessage("assistant", t); }, text);

/** What a click on the "Fetch the feed" node posts (diagram-renderer.js), with `over` changed. */
const nodeClick = (over = {}) => ({ type: "tarsee:diagram-click", diagramId: DIAGRAM, nodeId: "fetch", label: "Fetch the feed", sublabel: "Every hour", ...over });

describe("a click on a diagram's node asks about it in the chat", { skip }, () => {
  it("in the sandboxed iframe the chat draws: the node's label and sublabel, or its own question, are sent", async () => {
    const { page, api, errors, context } = await openPage();
    try {
      await showAnswer(page, `Here is the flow: /canvas/${DIAGRAM}/`);
      const embed = page.locator(`.canvas-embed[data-canvas-id="${DIAGRAM}"] iframe.canvas-iframe`);
      assert.equal(await embed.getAttribute("sandbox"), "allow-scripts", "the diagram's iframe has no allow-same-origin");
      const frame = await frameAt(page, `/canvas/${DIAGRAM}/`);
      assert.equal(await frame.evaluate(() => window.origin), "null", "so its messages come from origin \"null\"");
      const diagram = page.frameLocator(`.canvas-embed[data-canvas-id="${DIAGRAM}"] iframe`);

      await diagram.locator(".node", { hasText: "Fetch the feed" }).click();
      assert.deepEqual(await waitForSent(api, 1), ["Tell me more about: Fetch the feed. Every hour"]);
      await page.locator(".message.user", { hasText: "Tell me more about: Fetch the feed. Every hour" }).waitFor();
      assert.equal(await page.locator("#messageInput").inputValue(), "", "sent, not left in the box");

      await diagram.locator(".node", { hasText: "Sort the items" }).click();
      assert.deepEqual((await waitForSent(api, 2)).slice(1), ["Why sort them before saving?"], "a node's own question");
      await diagram.locator(".node", { hasText: "Save the results" }).click();
      assert.deepEqual((await waitForSent(api, 3)).slice(2), ["Tell me more about: Save the results"], "no sublabel");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("a diagram from Tarsee's own origin (an iframe with allow-same-origin) works as before", async () => {
    const { page, api, errors, context } = await openPage();
    try {
      await showAnswer(page, `/canvas/${DIAGRAM}/`);
      await page.evaluate(({ id }) => {
        const f = document.querySelector(`.canvas-embed[data-canvas-id="${id}"] iframe`);
        f.setAttribute("sandbox", "allow-scripts allow-same-origin");
        f.src = `/unsandboxed/${id}/`;
      }, { id: DIAGRAM });
      const frame = await frameAt(page, `${origin}/unsandboxed/${DIAGRAM}/`);
      assert.equal(await frame.evaluate(() => window.origin), origin, "its messages come from Tarsee's own origin");
      await page.frameLocator(`.canvas-embed[data-canvas-id="${DIAGRAM}"] iframe`).locator(".node", { hasText: "Fetch the feed" }).click();
      assert.deepEqual(await waitForSent(api, 1), ["Tell me more about: Fetch the feed. Every hour"]);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("nothing else is taken: the chat window, another window, another iframe, a canvas that isn't a diagram, any other shape", async () => {
    const { page, api, errors, context } = await openPage();
    try {
      await showAnswer(page, `Here is the flow: /canvas/${DIAGRAM}/\n\nAnd the report: /canvas/${REPORT}/`);
      const diagram = await frameAt(page, `/canvas/${DIAGRAM}/`);
      const report = await frameAt(page, `/canvas/${REPORT}/`);
      const toParent = (frame, msg) => frame.evaluate((m) => window.parent.postMessage(m, "*"), msg);

      // The chat window itself, with a node click's exact shape.
      await page.evaluate((m) => window.postMessage(m, "*"), nodeClick());
      // Another window: a popup the page opened.
      const [popup] = await Promise.all([page.waitForEvent("popup"), page.evaluate(() => { window.open("about:blank", "_blank"); })]);
      await popup.evaluate((m) => window.opener.postMessage(m, "*"), nodeClick());
      // Another iframe in the chat, even one with the canvas iframe's class and sandbox.
      await page.evaluate(() => {
        const f = document.createElement("iframe");
        f.className = "canvas-iframe";
        f.id = "strayFrame";
        f.setAttribute("sandbox", "allow-scripts");
        f.srcdoc = "<p>Not a diagram</p>";
        Chat.elements.chatArea.appendChild(f);
      });
      const stray = await (await page.$("#strayFrame")).contentFrame();
      await stray.waitForLoadState("load");
      assert.equal(await stray.evaluate(() => window.origin), "null", "an opaque origin, like a diagram's");
      await toParent(stray, nodeClick());
      // A canvas the chat drew that isn't a diagram, naming itself or the diagram.
      await toParent(report, nodeClick({ diagramId: REPORT }));
      await toParent(report, nodeClick());
      // The diagram itself, in any other shape than a node click's.
      for (const msg of [
        nodeClick({ diagramId: "diagram-another-flow" }),
        nodeClick({ type: "tarsee:diagram-clicked" }),
        nodeClick({ extra: "field" }),
        nodeClick({ label: 42 }),
        nodeClick({ sublabel: ["Every hour"] }),
        nodeClick({ nodeId: null }),
        nodeClick({ question: 7 }),
        nodeClick({ question: { text: "Why?" } }),
        nodeClick({ label: "", question: "" }),
        { type: "tarsee:diagram-click", diagramId: DIAGRAM, label: "Fetch the feed" },
        [nodeClick()],
        "tarsee:diagram-click",
        null,
      ]) await toParent(diagram, msg);

      await page.waitForTimeout(500);
      assert.deepEqual(sent(api), [], "nothing was sent");
      assert.equal(await page.locator("#messageInput").inputValue(), "", "nothing was put in the box");

      // The listener is there all along: the same diagram's real click is taken.
      await page.frameLocator(`.canvas-embed[data-canvas-id="${DIAGRAM}"] iframe`).locator(".node", { hasText: "Fetch the feed" }).click();
      assert.deepEqual(await waitForSent(api, 1), ["Tell me more about: Fetch the feed. Every hour"]);
      await page.waitForTimeout(300);
      assert.deepEqual(sent(api), ["Tell me more about: Fetch the feed. Every hour"], "and only that");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("a diagram's iframe showing a page from another origin is refused, even a real click on it", async () => {
    // Tarsee's page already keeps other sites out of its iframes (its CSP says frame-src 'self'). With that set aside,
    // the listener still refuses them.
    const { page, api, errors, context } = await openPage({ bypassCSP: true });
    try {
      await showAnswer(page, `/canvas/${DIAGRAM}/`);
      const load = (src, sandbox) => page.evaluate(({ id, url, flags }) => {
        const f = document.querySelector(`.canvas-embed[data-canvas-id="${id}"] iframe`);
        if (flags == null) f.removeAttribute("sandbox"); else f.setAttribute("sandbox", flags);
        f.src = url;
      }, { id: DIAGRAM, url: src, flags: sandbox });
      const diagram = page.frameLocator(`.canvas-embed[data-canvas-id="${DIAGRAM}"] iframe`);

      await load(`${otherOrigin}/unsandboxed/${DIAGRAM}/`, null);
      const elsewhere = await frameAt(page, `${otherOrigin}/unsandboxed/${DIAGRAM}/`);
      assert.equal(await elsewhere.evaluate(() => window.origin), otherOrigin);
      await diagram.locator(".node", { hasText: "Fetch the feed" }).click();
      await page.waitForTimeout(500);
      assert.deepEqual(sent(api), [], "nothing was sent");

      // The same iframe back on the diagram, sandboxed as the chat draws it: taken.
      await load(`/canvas/${DIAGRAM}/`, "allow-scripts");
      const back = await frameAt(page, `${origin}/canvas/${DIAGRAM}/`);
      assert.equal(await back.evaluate(() => window.origin), "null");
      await diagram.locator(".node", { hasText: "Fetch the feed" }).click();
      assert.deepEqual(await waitForSent(api, 1), ["Tell me more about: Fetch the feed. Every hour"]);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
