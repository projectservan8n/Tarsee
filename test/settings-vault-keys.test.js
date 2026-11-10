// Settings > Keys (src/routes/vault-keys.js, mounted at /api/settings/keys, and its section in js/settings.js): the
// owner sees the vault's key names and when each was saved, adds or replaces a key, and deletes one.
//   - Only the owner's live sign-in (middleware/auth.js liveSessionId): the API token alone is refused, since the AI's
//     shell can read it; so is a sign-in that has run out, told so. Writes with the sign-in alone need the CSRF token.
//   - No answer ever carries a value, nor any part of one; the value box is emptied once saved, and never filled.
//   - The owner may replace and delete Tarsee's own key (RAILWAY_API_TOKEN), which chat may not.
//   - Writes and deletes are audited by name only.
// The routes run for real behind the real sign-in, token and CSRF checks, on the real vault (encrypted, in a temporary
// folder). The browser part runs the dashboard from src/public against those same routes, on Playwright's own
// Chromium, else an installed Chrome or Edge, and is skipped where there is none (npx playwright install chromium).
/* global document, window, Settings -- the page.evaluate() bodies run in the browser */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-settings-vault-keys-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "0".repeat(40);
process.env.SETUP_PASSWORD = "test-owner-pin-4821";
for (const name of ["TARSEE_API_TOKEN", "TARSEE_SESSION_MAX_AGE_DAYS", "RAILWAY_API_TOKEN"]) delete process.env[name];

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { sessionAuth, requireAuth, createSession, destroySession, initSessionStore } = await import("../src/middleware/auth.js");
const { csrfProtect } = await import("../src/middleware/security.js");
const { authRouter } = await import("../src/routes/auth-routes.js");
const { settingsRouter } = await import("../src/routes/settings.js");
const vault = await import("../src/lib/key-vault.js");

/** What the AI's shell reads: the token file in the state folder. */
const TOKEN = fs.readFileSync(path.join(tmp, "api.token"), "utf8").trim();
const db = initDb(path.join(tmp, "tarsee.db"));
initSessionStore(db);
const store = new SettingsStore(db);
const VAULT_FILE = path.join(tmp, "data", "vault.json");
const PUBLIC = fileURLToPath(new URL("../src/public/", import.meta.url));

const RAILWAY = "rw-test-canary-0000-1111-2222-333344445555";
const RAILWAY_NEW = "rw-test-canary-9999-8888-7777-666655554444";
const STRIPE = "sk-test-canary-stripe-000000000000";
const STRIPE_NEW = "sk-test-canary-stripe-111111111111";
const VALUES = [RAILWAY, RAILWAY_NEW, STRIPE, STRIPE_NEW];
/** Every value and both ends of each (what a masked display would show). */
const PIECES = VALUES.flatMap((v) => [v, v.slice(0, 4) + "...", "..." + v.slice(-4)]);

const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
};
const audits = () => db.prepare("SELECT action, target, actor, detail FROM audit_log WHERE target LIKE 'vault.%' ORDER BY id").all();

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

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.set("db", db);
  app.set("settingsStore", store);
  // As src/server.js has them: who is asking (the token or the sign-in), then each router behind its checks.
  app.use(sessionAuth);
  app.use("/api/auth", authRouter);
  // Set up, so the dashboard opens rather than the setup wizard.
  app.get("/api/settings/setup-status", (_req, res) => res.json({ needsSetup: false, needsPersonality: false, hasKey: true, botName: "Tarsee", provider: "claude-code" }));
  app.use("/api/settings", requireAuth, csrfProtect, settingsRouter);
  // The rest of what the dashboard asks for as it opens.
  app.use("/api", (_req, res) => res.json({}));
  app.use(express.static(PUBLIC));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise((r) => (server ? server.close(r) : r()));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* a temp folder left behind */ }
});
beforeEach(() => {
  fs.rmSync(VAULT_FILE, { force: true });
  db.prepare("DELETE FROM audit_log").run();
});

// --- Who is asking -----------------------------------------------------------------------------------------------

async function freshCsrf() {
  const res = await fetch(`${base}/api/auth/csrf`);
  const csrf = /tarsee_csrf=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  assert.ok(csrf, "a CSRF token");
  return csrf;
}
/** The AI's shell: curl with the token it read from the state folder. */
const asToken = () => ({ Authorization: `Bearer ${TOKEN}` });
/** The owner's dashboard as js/api.js sends: the sign-in's cookie, the CSRF token, and the API token alongside. */
const asDashboard = (sessionId, csrf) => ({ Authorization: `Bearer ${TOKEN}`, Cookie: `tarsee_session=${sessionId}; tarsee_csrf=${csrf}`, "X-CSRF-Token": csrf });
/** The owner's Settings > Keys as it sends: the sign-in's cookie and the CSRF token, no API token. */
const asOwner = (sessionId, csrf) => ({ Cookie: `tarsee_session=${sessionId}; tarsee_csrf=${csrf}`, "X-CSRF-Token": csrf });

async function call(method, url, body, headers = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  for (const piece of PIECES) assert.ok(!text.includes(piece), `${method} ${url} answered with a value or part of one (${piece}): ${text}`);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json, headers: res.headers };
}
const list = (headers) => call("GET", "/api/settings/keys", undefined, headers);
const save = (body, headers) => call("POST", "/api/settings/keys", body, headers);
const remove = (name, headers) => call("DELETE", `/api/settings/keys/${encodeURIComponent(name)}`, undefined, headers);

describe("the Keys routes answer only the owner's live sign-in", () => {
  it("the API token alone is refused, to list, save or delete, and nothing changes", async () => {
    quiet(() => vault.setKey("STRIPE_SECRET_KEY", STRIPE));
    const before = fs.readFileSync(VAULT_FILE, "utf8");
    for (const res of [
      await list(asToken()),
      await save({ name: "STRIPE_SECRET_KEY", value: STRIPE_NEW }, asToken()),
      await save({ name: "RAILWAY_API_TOKEN", value: RAILWAY }, asToken()),
      await remove("STRIPE_SECRET_KEY", asToken()),
    ]) {
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.match(res.body.error, /signed in/i);
      assert.equal(res.body.needsSignIn, true);
      assert.equal(res.body.keys, undefined, "no list");
    }
    assert.equal(fs.readFileSync(VAULT_FILE, "utf8"), before, "the vault file is untouched");
    assert.deepEqual(audits(), []);
  });

  it("nothing at all, a sign-in the server doesn't know, and an ended one are refused too", async () => {
    assert.equal((await list()).status, 401);
    const unknown = await list({ ...asToken(), Cookie: "tarsee_session=" + "ab".repeat(32) });
    assert.equal(unknown.status, 403);
    const ended = createSession("127.0.0.1");
    destroySession(ended);
    const csrf = await freshCsrf();
    for (const res of [await list(asDashboard(ended, csrf)), await save({ name: "STRIPE_SECRET_KEY", value: STRIPE }, asDashboard(ended, csrf))]) {
      assert.equal(res.status, 403);
      assert.match(res.body.error, /sign-in has run out/);
      assert.equal(res.body.needsSignIn, true);
    }
    assert.equal(vault.getKey("STRIPE_SECRET_KEY"), null);
  });

  it("a write with the sign-in alone and no CSRF token is refused", async () => {
    const sessionId = createSession("127.0.0.1");
    const res = await save({ name: "STRIPE_SECRET_KEY", value: STRIPE }, { Cookie: `tarsee_session=${sessionId}` });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /CSRF/);
    assert.equal(vault.getKey("STRIPE_SECRET_KEY"), null);
  });
});

describe("the owner's Settings > Keys", () => {
  it("lists names, descriptions and when each was saved, with Tarsee's own marked, and never a value", async () => {
    quiet(() => { vault.setKey("RAILWAY_API_TOKEN", RAILWAY, "Railway account"); vault.setKey("STRIPE_SECRET_KEY", STRIPE, "Stripe"); });
    const sessionId = createSession("127.0.0.1");
    const csrf = await freshCsrf();
    for (const headers of [asOwner(sessionId, csrf), asDashboard(sessionId, csrf)]) {
      const res = await list(headers);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.match(res.headers.get("cache-control") || "", /no-store/);
      const byName = Object.fromEntries(res.body.keys.map((k) => [k.name, k]));
      assert.deepEqual(Object.keys(byName).sort(), ["RAILWAY_API_TOKEN", "STRIPE_SECRET_KEY"]);
      assert.equal(byName.RAILWAY_API_TOKEN.serverOnly, true);
      assert.equal(byName.RAILWAY_API_TOKEN.usedBy, "tarsee_railway");
      assert.equal(byName.STRIPE_SECRET_KEY.serverOnly, false);
      assert.equal(byName.STRIPE_SECRET_KEY.description, "Stripe");
      assert.ok(!Number.isNaN(Date.parse(byName.STRIPE_SECRET_KEY.savedAt)), "when it was saved");
      for (const k of res.body.keys) assert.deepEqual(Object.keys(k).sort(), ["createdAt", "description", "name", "savedAt", "serverOnly", "usedBy"]);
    }
  });

  it("adds a key, replaces it (keeping its description), and deletes it, each audited by name only", async () => {
    const sessionId = createSession("127.0.0.1");
    const csrf = await freshCsrf();
    const added = await save({ name: " STRIPE_SECRET_KEY ", value: `  ${STRIPE}\n`, description: "Stripe live key" }, asOwner(sessionId, csrf));
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.replaced, false);
    assert.equal(added.body.key.name, "STRIPE_SECRET_KEY");
    assert.equal(vault.getKey("STRIPE_SECRET_KEY"), STRIPE, "saved trimmed");
    assert.ok(!fs.readFileSync(VAULT_FILE, "utf8").includes(STRIPE), "encrypted at rest");

    const firstSaved = added.body.key.savedAt;
    await new Promise((r) => setTimeout(r, 5));
    const replaced = await save({ name: "STRIPE_SECRET_KEY", value: STRIPE_NEW }, asDashboard(sessionId, csrf));
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(replaced.body.replaced, true);
    assert.equal(replaced.body.key.description, "Stripe live key", "the description stays when none is given");
    assert.ok(replaced.body.key.savedAt > firstSaved, "a new saved time");
    assert.equal(vault.getKey("STRIPE_SECRET_KEY"), STRIPE_NEW);

    const gone = await remove("STRIPE_SECRET_KEY", asOwner(sessionId, csrf));
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(vault.getKey("STRIPE_SECRET_KEY"), null);
    assert.equal((await remove("STRIPE_SECRET_KEY", asOwner(sessionId, csrf))).status, 404, "nothing left to delete");

    const rows = audits();
    assert.deepEqual(rows.map((r) => [r.action, r.target, r.actor]), [
      ["credential.write", "vault.STRIPE_SECRET_KEY", "user"],
      ["credential.write", "vault.STRIPE_SECRET_KEY", "user"],
      ["credential.delete", "vault.STRIPE_SECRET_KEY", "user"],
    ]);
    for (const r of rows) for (const piece of PIECES) assert.ok(!String(r.detail).includes(piece), r.detail);
  });

  it("the owner replaces and deletes Tarsee's own key, which chat can't; a name in another case is saved as Tarsee reads it", async () => {
    quiet(() => vault.setKey("RAILWAY_API_TOKEN", RAILWAY));
    const sessionId = createSession("127.0.0.1");
    const csrf = await freshCsrf();
    const res = await save({ name: "railway_api_token", value: RAILWAY_NEW }, asOwner(sessionId, csrf));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.replaced, true);
    assert.equal(res.body.key.name, "RAILWAY_API_TOKEN");
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), RAILWAY_NEW);
    assert.deepEqual(vault.listKeys().map((k) => k.name), ["RAILWAY_API_TOKEN"]);
    assert.equal((await remove("RAILWAY_API_TOKEN", asOwner(sessionId, csrf))).status, 200);
    assert.equal(vault.getKey("RAILWAY_API_TOKEN"), null);
  });

  it("refuses a name that isn't one, an empty value, and a value too big, saving nothing", async () => {
    const sessionId = createSession("127.0.0.1");
    const csrf = await freshCsrf();
    for (const body of [
      { name: "", value: STRIPE },
      { name: "has space", value: STRIPE },
      { name: "__proto__", value: STRIPE },
      { name: "X".repeat(200), value: STRIPE },
      { name: "STRIPE_SECRET_KEY", value: "   " },
      { name: "STRIPE_SECRET_KEY" },
      { name: "STRIPE_SECRET_KEY", value: 42 },
      { name: "STRIPE_SECRET_KEY", value: "x".repeat(70 * 1024) },
      { name: "STRIPE_SECRET_KEY", value: STRIPE, description: "d".repeat(400) },
    ]) {
      const res = await save(body, asOwner(sessionId, csrf));
      assert.equal(res.status, 400, JSON.stringify({ body: { ...body, value: undefined }, got: res.body }));
      assert.ok(res.body.error);
    }
    assert.ok(!fs.existsSync(VAULT_FILE) || vault.listKeys().length === 0, "nothing saved");
  });

  it("a key saved from chat under a name the form wouldn't take can still be replaced and deleted", async () => {
    // Saved by an older version, before the vault took only names of its shape: written straight into the file.
    quiet(() => vault.setKey("MY_KEY", STRIPE));
    const saved = JSON.parse(fs.readFileSync(VAULT_FILE, "utf8"));
    saved["my key"] = saved.MY_KEY;
    delete saved.MY_KEY;
    fs.writeFileSync(VAULT_FILE, JSON.stringify(saved));
    assert.equal(vault.getKey("my key"), STRIPE);
    assert.throws(() => vault.setKey("my other key", STRIPE), /isn't a key's name/, "a new one of that shape isn't taken");
    const refused = await save({ name: "my other key", value: STRIPE }, asOwner(createSession("127.0.0.1"), await freshCsrf()));
    assert.equal(refused.status, 400, "nor from the form");
    const sessionId = createSession("127.0.0.1");
    const csrf = await freshCsrf();
    assert.equal((await save({ name: "my key", value: STRIPE_NEW }, asOwner(sessionId, csrf))).status, 200);
    assert.equal(vault.getKey("my key"), STRIPE_NEW);
    assert.equal((await remove("my key", asOwner(sessionId, csrf))).status, 200);
    assert.ok(!vault.listKeys().some((k) => k.name === "my key"), "deleted");
    assert.throws(() => vault.getKey("my key"), /isn't a key's name/, "and with it gone, the name is no key's");
  });
});

// --- In a real browser -------------------------------------------------------------------------------------------

/** The dashboard, signed in (the sign-in's cookie in the browser), on Settings > Keys. */
async function openKeys({ width = 1280, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
  await context.addCookies([{ name: "tarsee_session", value: createSession("127.0.0.1"), url: base }]);
  const page = await context.newPage();
  const errors = [];
  const sent = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("request", (req) => {
    const p = new URL(req.url()).pathname;
    if (p.startsWith("/api/settings/keys")) sent.push({ method: req.method(), path: p, auth: req.headers().authorization || null, body: req.postData() });
  });
  await page.route((url) => !url.href.startsWith(base), (route) => route.abort());
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`${base}/`);
  await page.locator("#appScreen").waitFor({ state: "visible" });
  await page.evaluate(() => Settings.open());
  await page.locator('.settings-tab[data-tab="keys"]').click();
  await page.locator("#vaultKeysList[data-loaded]").waitFor({ state: "attached" });
  return { page, context, errors, sent };
}

/** Answer the question on screen (js/dialogs.js) with the button called `name`, after its first 400 ms. */
async function answerDialog(page, name) {
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  await page.waitForTimeout(450);
  await dialog.getByRole("button", { name }).click();
}

/** A screenshot into $AI_UI_SHOTS (a folder), when it is set: for looking at the page by eye. */
const shot = async (page, name) => {
  if (process.env.AI_UI_SHOTS) await page.screenshot({ path: path.join(process.env.AI_UI_SHOTS, `${name}.png`), fullPage: true });
};
const row = (page, name) => page.locator(`#vaultKeysList [data-vault-key="${name}"]`);
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

describe("Settings > Keys in a real browser, against the real routes", { skip }, () => {
  it("adds a key, replaces it and deletes it; no value is ever on the page, and the value box is emptied", async () => {
    const { page, context, errors, sent } = await openKeys();
    try {
      await page.locator("#vaultKeysList", { hasText: "No keys saved yet" }).waitFor();

      // Add
      await page.locator("#vaultKeyName").fill("STRIPE_SECRET_KEY");
      await page.locator("#vaultKeyValue").fill(STRIPE);
      await page.locator("#vaultKeyDescription").fill("Stripe live key");
      assert.equal(await page.locator("#vaultKeyValue").getAttribute("type"), "password");
      await page.locator("#vaultKeySaveBtn").click();
      await row(page, "STRIPE_SECRET_KEY").waitFor();
      assert.equal(vault.getKey("STRIPE_SECRET_KEY"), STRIPE);
      assert.equal(await page.locator("#vaultKeyValue").inputValue(), "", "the value box is emptied once saved");
      assert.match(await row(page, "STRIPE_SECRET_KEY").textContent(), /Stripe live key/);
      assert.match(await row(page, "STRIPE_SECRET_KEY").textContent(), /Saved /);
      await shot(page, "keys-desktop");

      // Replace: its button puts the name in the form; the new value is typed in.
      await row(page, "STRIPE_SECRET_KEY").getByRole("button", { name: "Replace" }).click();
      assert.equal(await page.locator("#vaultKeyName").inputValue(), "STRIPE_SECRET_KEY");
      assert.equal(await page.locator("#vaultKeyValue").inputValue(), "", "the old value is never put back");
      await page.locator("#vaultKeyFormNote", { hasText: "replaces" }).waitFor();
      await page.locator("#vaultKeyValue").fill(STRIPE_NEW);
      await page.locator("#vaultKeyValue").press("Enter");
      await page.getByText("Replaced STRIPE_SECRET_KEY").waitFor();
      assert.equal(vault.getKey("STRIPE_SECRET_KEY"), STRIPE_NEW);
      assert.equal(await page.locator("#vaultKeyValue").inputValue(), "");

      for (const piece of PIECES) assert.ok(!(await page.content()).includes(piece), `on the page: ${piece}`);

      // Delete, after a question; Cancel first leaves it.
      await row(page, "STRIPE_SECRET_KEY").getByRole("button", { name: "Delete" }).click();
      await answerDialog(page, "Cancel");
      // The same question asked again while it is still up is answered no at once (js/dialogs.js): wait for it to go.
      await page.getByRole("alertdialog").waitFor({ state: "hidden" });
      assert.equal(vault.getKey("STRIPE_SECRET_KEY"), STRIPE_NEW, "Cancel deletes nothing");
      await row(page, "STRIPE_SECRET_KEY").getByRole("button", { name: "Delete" }).click();
      await answerDialog(page, "Delete");
      await page.locator("#vaultKeysList", { hasText: "No keys saved yet" }).waitFor();
      assert.equal(vault.getKey("STRIPE_SECRET_KEY"), null);

      assert.ok(sent.length >= 4, JSON.stringify(sent));
      assert.ok(sent.every((s) => s.auth === null), "Settings > Keys goes without the API token: " + JSON.stringify(sent));
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Tarsee's own key is marked, and the owner can replace it here", async () => {
    quiet(() => vault.setKey("RAILWAY_API_TOKEN", RAILWAY, "Railway account"));
    const { page, context, errors } = await openKeys();
    try {
      const own = row(page, "RAILWAY_API_TOKEN");
      await own.waitFor();
      assert.match(await own.textContent(), /Tarsee's own/);
      await own.getByRole("button", { name: "Replace" }).click();
      await page.locator("#vaultKeyValue").fill(RAILWAY_NEW);
      await page.locator("#vaultKeySaveBtn").click();
      await page.getByText("Replaced RAILWAY_API_TOKEN").waitFor();
      assert.equal(vault.getKey("RAILWAY_API_TOKEN"), RAILWAY_NEW);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("at phone width: the list and the form fit, with nothing scrolling sideways", async () => {
    quiet(() => {
      vault.setKey("RAILWAY_API_TOKEN", RAILWAY, "Railway account");
      vault.setKey("A_VERY_LONG_KEY_NAME_FOR_SOME_THIRD_PARTY_SERVICE_API", STRIPE, "A key with a long name and a long description to see it wrap on a phone");
    });
    const { page, context, errors } = await openKeys({ width: 360, height: 780 });
    try {
      await row(page, "A_VERY_LONG_KEY_NAME_FOR_SOME_THIRD_PARTY_SERVICE_API").waitFor();
      assert.ok(await noSideScroll(page), "no sideways scroll at phone width");
      await shot(page, "keys-phone");
      const fits = await page.evaluate(() => {
        const box = document.querySelector('.settings-tab-panel[data-tab="keys"]').getBoundingClientRect();
        return [...document.querySelectorAll("#vaultKeysList button, #vaultKeySaveBtn, #vaultKeyValue")].every((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= box.left - 1 && r.right <= box.right + 1 && r.width > 0;
        });
      });
      assert.ok(fits, "every button and the value box are inside the panel");
      await row(page, "A_VERY_LONG_KEY_NAME_FOR_SOME_THIRD_PARTY_SERVICE_API").getByRole("button", { name: "Delete" }).click();
      await answerDialog(page, "Delete");
      await row(page, "A_VERY_LONG_KEY_NAME_FOR_SOME_THIRD_PARTY_SERVICE_API").waitFor({ state: "detached" });
      assert.equal(vault.getKey("A_VERY_LONG_KEY_NAME_FOR_SOME_THIRD_PARTY_SERVICE_API"), null);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
