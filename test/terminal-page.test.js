// The dashboard's Terminal page (src/public/terminal.html, js/terminal.js) when the owner's sign-in has ended. The
// server closes the Terminal with 4401 (websocket/terminal-handler.js SIGN_IN_REQUIRED), and the page takes that as
// final: it stops trying to connect and shows "Sign in again", with a button that reloads the page. It used to try
// again every 5 s for as long as the tab stayed open, and each try wrote an audit row. Refused before it opens (no
// live sign-in at the upgrade), it asks /api/auth/status which it is: no sign-in gets the same "Sign in again"; the
// server being down gets a try every 5 s, as does a Terminal that drops while signed in.
// The page runs on Playwright's own Chromium, else an installed Chrome or Edge, against a small server standing in for
// Tarsee's, with xterm.js stood in for too and the page's clock under the test's hand; skipped where there is none
// (npx playwright install chromium).
/* global document, window -- the page.evaluate() bodies run in the browser */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

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

const PUBLIC = fileURLToPath(new URL("../src/public/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon" };
const REFUSAL = "Your sign-in has run out. Sign in to the dashboard again, then reload this page.";
// xterm.js and its add-ons, stood in for: what the page writes is kept on window.__written.
const XTERM = `window.__written = [];
window.Terminal = class {
  constructor() { this.cols = 80; this.rows = 24; }
  loadAddon() {} open() {} focus() {} onData() {}
  write(s) { window.__written.push(String(s)); }
  writeln(s) { window.__written.push(String(s) + "\\n"); }
};
window.FitAddon = { FitAddon: class { fit() {} } };
window.WebLinksAddon = { WebLinksAddon: class {} };`;

describe("the Terminal page, when the sign-in has ended", { skip }, () => {
  let server;
  let origin;
  // How the stand-in answers /terminal: "refuse" (opens, says why, closes with 4401, as Tarsee does), "401" (turned
  // away at the upgrade), "down" (the connection is dropped before it opens, and /api/auth/status fails too) or
  // "drop" (opens, then the connection is lost).
  let mode = "refuse";
  let signedIn = false;
  let upgrades = 0;
  let pageLoads = 0;
  before(async () => {
    const wss = new WebSocketServer({ noServer: true });
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/api/auth/status") {
        if (mode === "down") { res.writeHead(503); res.end(); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(signedIn ? { authenticated: true, method: "session", needsPassword: true } : { authenticated: false, method: null, needsPassword: true }));
        return;
      }
      const rel = decodeURIComponent(url.pathname.slice(1)) || "index.html";
      const file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      if (rel === "terminal.html") pageLoads++;
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.on("upgrade", (req, socket, head) => {
      upgrades++;
      if (mode === "401") { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
      if (mode === "down") { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (mode === "drop") {
          ws.send(JSON.stringify({ type: "connected", terminalId: "term-1", shell: "bash", cwd: "/data/workspace" }));
          setTimeout(() => ws.terminate(), 50);
          return;
        }
        ws.send(JSON.stringify({ type: "data", data: `\r\n\x1b[31m[${REFUSAL}]\x1b[0m\r\n` }));
        ws.send(JSON.stringify({ type: "error", message: REFUSAL }));
        ws.close(4401, "Sign-in required");
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => (server ? server.close(r) : r()));
    await browser?.close();
  });

  /** Waits, in real time, until `check()` holds (the page's own timers move only when the test moves its clock). */
  async function until(check, what, ms = 10_000) {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function openTerminal({ width = 1280, height = 800 } = {}) {
    upgrades = 0;
    pageLoads = 0;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.clock.install({ time: new Date("2026-01-05T09:00:00Z") });
    await page.route("https://cdn.jsdelivr.net/**", (route) => {
      const url = route.request().url();
      if (url.endsWith(".css")) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
      return route.fulfill({ status: 200, contentType: "text/javascript", body: url.includes("/xterm.min.js") ? XTERM : "" });
    });
    await page.route((url) => !url.href.startsWith(origin) && !url.href.startsWith("https://cdn.jsdelivr.net/"), (route) => route.abort());
    await page.goto(`${origin}/terminal.html`);
    return { page, context, errors };
  }

  it("stops trying once the server says the sign-in has ended, and offers Sign in again with a Reload button", async () => {
    mode = "refuse";
    const { page, context, errors } = await openTerminal();
    try {
      const box = page.locator("#sign-in-again");
      await box.waitFor({ state: "visible" });
      assert.match(await box.textContent(), /Sign in again/);
      assert.match(await box.textContent(), /sign-in has run out/);
      assert.equal(await page.locator("#status-text").textContent(), "Signed out");
      await page.clock.runFor(5 * 60_000);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(upgrades, 1, "no new try in five minutes");
      const written = (await page.evaluate(() => window.__written)).join("");
      assert.ok(!/Attempting to reconnect/.test(written), written);

      await page.getByRole("button", { name: "Reload" }).click();
      await until(() => pageLoads === 2, "the page to load again");
      await until(() => upgrades === 2, "the reloaded page to connect");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("shows Sign in again when turned away at the upgrade with no sign-in, and stops there too", async () => {
    mode = "401";
    signedIn = false;
    const { page, context, errors } = await openTerminal({ width: 375, height: 700 });
    try {
      const box = page.locator("#sign-in-again");
      await box.waitFor({ state: "visible" });
      assert.match(await box.textContent(), /signed in to the dashboard/);
      await page.clock.runFor(60_000);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(upgrades, 1, "no new try");
      const fits = await page.evaluate(() => {
        const r = document.getElementById("sign-in-again").getBoundingClientRect();
        return document.documentElement.scrollWidth <= window.innerWidth + 1 && r.left >= 0 && r.right <= window.innerWidth;
      });
      assert.ok(fits, "the box fits a phone's width, with no sideways scroll");
      assert.ok(await page.getByRole("button", { name: "Reload" }).isVisible());
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("keeps trying every 5 s while the server is down, and when a Terminal drops while signed in", async () => {
    for (const m of ["down", "drop"]) {
      mode = m;
      signedIn = true;
      const { page, context, errors } = await openTerminal();
      try {
        await until(() => upgrades === 1, "the first try");
        await new Promise((r) => setTimeout(r, 300)); // the close, and for "down" the status check
        await page.clock.runFor(5000);
        await until(() => upgrades === 2, `a second try (${m})`);
        await new Promise((r) => setTimeout(r, 300));
        await page.clock.runFor(5000);
        await until(() => upgrades === 3, `a third try (${m})`);
        assert.equal(await page.locator("#sign-in-again").count(), 0, `no Sign in again (${m})`);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  });
});
