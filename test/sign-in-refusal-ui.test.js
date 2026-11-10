// When signing in is refused for a while (429: a place's wait, the tries-a-minute limit, or the pause for everyone),
// the sign-in screen keeps the refusal on screen with the time left until its Retry-After runs out, on the desktop
// form and on the phone's PIN pad. It used to clear the PIN pad's line after 600 ms, so "signing in is paused for
// everyone for 15 minutes" flashed past and the owner kept typing. Trying again before then is refused anyway, so the
// Sign In button and the PIN keys wait too. A wrong PIN still shakes and clears.
// The dashboard from src/public runs against a small fake /api on Playwright's own Chromium, else an installed Chrome
// or Edge, with the page's clock under the test's hand; skipped where there is none (npx playwright install chromium).
/* global document, window -- the page.evaluate() bodies run in the browser */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".svg": "image/svg+xml" };
const PAUSED = "Too many wrong passwords have been tried here from different places, so signing in is paused for everyone for 15 minutes. Anyone already signed in stays signed in.";
// The refusal while tarsee.db can't be written (middleware/auth.js refuseUnrecorded).
const UNRECORDED = "Tarsee can't record sign-in attempts right now (is the disk full?), so new sign-ins are paused. Anyone already signed in stays signed in. Try again in 1 minute.";

describe("the sign-in screen, refused for a while", { skip }, () => {
  let pages;
  let origin;
  before(async () => {
    pages = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise((r) => pages.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${pages.address().port}`;
  });
  after(async () => {
    await new Promise((r) => (pages ? pages.close(r) : r()));
    await browser?.close();
  });

  /** The sign-in screen, its clock stopped; POST /api/auth/login answers with answers[i] in turn. */
  async function openSignIn({ width, height, answers }) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    let logins = 0;
    page.on("pageerror", (err) => errors.push(err.message));
    await page.clock.install({ time: new Date("2026-01-05T09:00:00Z") });
    await page.route((url) => !url.href.startsWith(origin), (route) => route.abort());
    await page.routeWebSocket(/.*/, () => {});
    await page.route(`${origin}/api/**`, (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === "/api/auth/status") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: false, method: null, needsPassword: true }) });
      if (p === "/api/auth/login") {
        const a = answers[Math.min(logins++, answers.length - 1)];
        return route.fulfill({ status: a.status, headers: a.retryAfter ? { "Retry-After": String(a.retryAfter) } : {}, contentType: "application/json", body: JSON.stringify({ error: a.error }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.goto(`${origin}/`);
    await page.locator("#loginScreen").waitFor({ state: "visible" });
    await page.clock.pauseAt(new Date("2026-01-05T09:00:30Z")); // from here the clock moves only when the test moves it
    return { page, context, errors, logins: () => logins };
  }

  it("on the desktop form: the refusal stays, counts down, and the button waits with it", async () => {
    const { page, context, errors, logins } = await openSignIn({ width: 1280, height: 900, answers: [{ status: 429, retryAfter: 900, error: PAUSED }] });
    try {
      await page.locator("#loginPassword").fill("4821");
      await page.locator("#loginForm button[type='submit']").click();
      const line = page.locator("#loginError");
      await line.waitFor({ state: "visible" });
      assert.ok((await line.textContent()).startsWith(PAUSED), await line.textContent());
      assert.match(await line.textContent(), /15:00 left/);
      const button = page.locator("#loginForm button[type='submit']");
      assert.equal(await button.isDisabled(), true, "the button waits");

      await page.clock.runFor(61_000);
      assert.ok(await line.isVisible(), "still on screen a minute later");
      assert.match(await line.textContent(), /13:59 left/);
      await page.locator("#loginPassword").press("Enter");
      assert.equal(logins(), 1, "Enter doesn't send another try meanwhile");

      await page.clock.runFor(14 * 60_000);
      assert.equal(await line.isVisible(), false, "gone once the wait is over");
      assert.equal(await button.isDisabled(), false, "and the button is back");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("on a phone's PIN pad: the refusal stays past the shake, with the time left, until the wait is over", async () => {
    const { page, context, errors, logins } = await openSignIn({
      width: 375, height: 800,
      answers: [{ status: 429, retryAfter: 30, error: "Too many wrong passwords from here. Try again in 30 seconds." }],
    });
    try {
      for (const d of "4821") await page.locator(`.pin-key[data-digit="${d}"]`).click();
      await page.clock.runFor(300);
      const line = page.locator("#pinError");
      await page.waitForFunction(() => /left/.test(document.getElementById("pinError").textContent));
      await page.clock.runFor(2000);
      assert.match(await line.textContent(), /^Too many wrong passwords from here\. Try again in 30 seconds\..*0:2\d left/s);
      assert.equal(await page.locator("#pinDots .pin-dot.filled").count(), 0, "the dots are cleared for the next try");
      for (const d of "1234") await page.locator(`.pin-key[data-digit="${d}"]`).click({ force: true });
      await page.clock.runFor(300);
      assert.equal(logins(), 1, "the keys wait too");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll");

      await page.clock.runFor(30_000);
      assert.equal(await line.textContent(), "", "gone once the wait is over");
      assert.equal(await page.locator(".pin-key[data-digit='1']").isDisabled(), false);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("on a phone's PIN pad: says so when Tarsee can't record sign-in attempts (a full disk), for its minute", async () => {
    const { page, context, errors, logins } = await openSignIn({ width: 375, height: 800, answers: [{ status: 429, retryAfter: 60, error: UNRECORDED }] });
    try {
      for (const d of "4821") await page.locator(`.pin-key[data-digit="${d}"]`).click();
      await page.clock.runFor(300);
      await page.waitForFunction(() => /left/.test(document.getElementById("pinError").textContent));
      const line = page.locator("#pinError");
      assert.ok((await line.textContent()).startsWith(UNRECORDED), await line.textContent());
      assert.match(await line.textContent(), /\(1:00 left\)|\(0:59 left\)/);
      await page.clock.runFor(30_000);
      assert.match(await line.textContent(), /is the disk full\?.*0:[23]\d left/s, "still on screen half a minute later");
      for (const d of "4821") await page.locator(`.pin-key[data-digit="${d}"]`).click({ force: true });
      assert.equal(logins(), 1, "the keys wait for the minute");
      await page.clock.runFor(31_000);
      assert.equal(await line.textContent(), "", "then it is gone, and the next try goes to Tarsee");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("on a phone's PIN pad: a wrong PIN still shakes and clears", async () => {
    const { page, context, errors } = await openSignIn({ width: 375, height: 800, answers: [{ status: 401, error: "Invalid password" }] });
    try {
      for (const d of "0000") await page.locator(`.pin-key[data-digit="${d}"]`).click();
      await page.clock.runFor(300);
      await page.waitForFunction(() => document.getElementById("pinError").textContent === "Wrong PIN");
      await page.clock.runFor(700);
      assert.equal(await page.locator("#pinError").textContent(), "");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
