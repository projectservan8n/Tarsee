// Settings > Channels > Email: the owner's save (POST /api/settings/channel, type "email", routes/settings.js), the
// owner's OK for a wider sender allowlist, and the form that sends both (js/settings.js). The rules:
//   - a saved mailbox password only goes to the server it was saved for. A save that changes a side's host, port, user
//     or secure setting must carry that side's password, or nothing is saved, and the form says which password it
//     needs. A save that keeps the server keeps the password, the secure setting and requireTLS (which the chat tool,
//     tarsee_configure_email_channel, sets for a server it sets up);
//   - the allowlist says who can reach the AI by email (empty: any sender). A list that lets in anyone the owner hasn't
//     allowed, sent by the AI's tool or with the API token alone, waits for the owner's OK, as a scheduled task the AI
//     makes waits (test/cron-approval.test.js). Only the owner's signed-in dashboard OKs it: the API token can't,
//     since the AI's shell can read it. A narrower list, or one the owner saves from the form, goes straight in.
// The routes run for real behind the real sign-in, token and CSRF checks. The browser part runs the form from
// src/public on Playwright's own Chromium, else an installed Chrome or Edge, and is skipped where there is none.
/* global document, window, Settings, API -- the page.evaluate() bodies run in the browser */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-email-channel-settings-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
// A key for this test's own temporary database, so passwords are stored encrypted as they are in a real install.
process.env.ENCRYPTION_KEY = "email-channel-settings-test-only-key-0123456789";
// No TARSEE_API_TOKEN: Tarsee makes one and saves it in the state folder, as on most installs.
delete process.env.TARSEE_API_TOKEN;
fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { sessionAuth, requireAuth, createSession } = await import("../src/middleware/auth.js");
const { csrfProtect, generateCsrfCookie } = await import("../src/middleware/security.js");
const { settingsRouter } = await import("../src/routes/settings.js");
const { executeTool } = await import("../src/lib/tools.js");

const PUBLIC = fileURLToPath(new URL("../src/public/", import.meta.url));
/** What the AI's shell reads: the token file in the state folder. */
const TOKEN = fs.readFileSync(path.join(tmp, "api.token"), "utf8").trim();

const db = initDb(path.join(tmp, "tarsee.db"));
const settings = new SettingsStore(db);

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

/** The email section exactly as index.html has it, with the scripts that run it. */
const INDEX = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
const EMAIL_SECTION = /<div class="settings-section channel-section" id="emailChannelSection"[\s\S]*?id="saveEmailChannelBtn">Save Email<\/button>\s*<\/div>/.exec(INDEX)?.[0];
assert.ok(EMAIL_SECTION, "index.html has the email section");
const FORM_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/style.css"></head>
<body><main class="settings-content">${EMAIL_SECTION}</main>
<script src="/js/api.js"></script><script src="/js/cron-core.js"></script><script src="/js/settings.js"></script>
<script>
  window.toasts = [];
  window.App = { showToast(message, kind) { window.toasts.push({ message, kind }); } };
  window.signInShown = 0;
  window.addEventListener("tarsee:auth-required", () => { window.signInShown++; });
</script></body></html>`;

/** The channel manager's starts and stops, instead of real mail servers. */
const channelCalls = [];
const channelManager = {
  async restart(type) { channelCalls.push(["restart", type]); },
  async stop(type) { channelCalls.push(["stop", type]); },
};

let server;
let base;
let csrf;
let sessionId;

before(async () => {
  const app = express();
  app.use(express.json());
  app.set("db", db);
  app.set("channelManager", channelManager);
  // As server.js has them: who is asking (the token or the sign-in), then the router behind its checks.
  app.use(sessionAuth);
  app.get("/__email.html", generateCsrfCookie, (_req, res) => res.type("html").send(FORM_PAGE));
  app.use("/api/settings", requireAuth, csrfProtect, settingsRouter);
  app.use(express.static(PUBLIC));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
  // The owner, signed in to the dashboard, with the CSRF token the page gets.
  sessionId = createSession("127.0.0.1");
  const page = await fetch(`${base}/__email.html`);
  csrf = /tarsee_csrf=([^;]+)/.exec(page.headers.get("set-cookie") || "")?.[1];
  assert.ok(csrf, "the page hands out a CSRF token");
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise((r) => (server ? server.close(r) : r()));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* a temp folder left behind */ }
});

const IMAP_PW = "owner-imap-pw-7Q2x";
const SMTP_PW = "owner-smtp-pw-9K4z";
const MAILBOX = "assistant@mail.example";

/** The mailbox as the owner saved it in Settings > Channels > Email: an ordinary provider, TLS on both sides. */
const ownerMailbox = () => ({
  enabled: false,
  tarseeEmailAddress: MAILBOX,
  fromName: "Tarsee",
  defaultSubject: "Tarsee",
  mentionKeyword: "tarsee",
  replyAllMarker: "[reply-all]",
  allowlistFromAddresses: ["owner@mail.example"],
  imap: { host: "imap.mail.example", port: 993, user: MAILBOX, password: IMAP_PW, secure: true },
  smtp: { host: "smtp.mail.example", port: 465, user: MAILBOX, password: SMTP_PW, secure: true },
});
/** A self-hosted server the chat tool set up on STARTTLS ports, with TLS required before the login. */
const startTlsMailbox = () => ({
  ...ownerMailbox(),
  imap: { host: "mail.self.example", port: 143, user: MAILBOX, password: IMAP_PW, secure: false, requireTLS: true },
  smtp: { host: "mail.self.example", port: 587, user: MAILBOX, password: SMTP_PW, secure: false, requireTLS: true },
});
const saved = () => settings.get("channel.email");

beforeEach(() => {
  settings.set("channel.email", ownerMailbox());
  channelCalls.length = 0;
});

/** What the form sends (js/settings.js saveEmailChannel): every field, with a password only when one was typed. */
function formSave({ imap = {}, smtp = {}, ...rest } = {}) {
  return {
    type: "email",
    enabled: false,
    tarseeEmailAddress: MAILBOX,
    imap: { host: "imap.mail.example", port: 993, user: MAILBOX, ...imap },
    smtp: { host: "smtp.mail.example", port: 465, user: MAILBOX, ...smtp },
    mentionKeyword: "@tarsee",
    replyAllMarker: "[reply-all]",
    fromName: "Tarsee",
    allowlistFromAddresses: ["owner@mail.example"],
    ...rest,
  };
}

const post = (body, headers) => fetch(`${base}/api/settings/channel`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
/** The AI's shell: curl with the token it read from the state folder. */
const asToken = () => ({ Authorization: `Bearer ${TOKEN}` });
/** The owner's dashboard (js/api.js): the sign-in's cookie and the CSRF token, and the API token alongside. */
const asDashboard = () => ({ Authorization: `Bearer ${TOKEN}`, Cookie: `tarsee_session=${sessionId}; tarsee_csrf=${csrf}`, "X-CSRF-Token": csrf });
/** Signed in, without the API token. */
const asSignedIn = () => ({ Cookie: `tarsee_session=${sessionId}; tarsee_csrf=${csrf}`, "X-CSRF-Token": csrf });
/** The tool the AI calls from a chat. */
const aiConfigures = (input) => executeTool("configure_email_channel", input, { db, settingsStore: settings });

// ---------------------------------------------------------------------------------------------------------------

describe("the owner's save: a saved password only goes to the server it was saved for", () => {
  it("a save that changes a side's host, port, user or secure setting without its password is refused, and names the password", async () => {
    const changes = [
      [{ imap: { host: "imap.elsewhere.example" } }, "imap", /IMAP host/],
      [{ imap: { port: 1993 } }, "imap", /IMAP port/],
      [{ imap: { user: "someone@mail.example" } }, "imap", /IMAP user/],
      [{ imap: { secure: false } }, "imap", /IMAP secure setting/],
      [{ smtp: { host: "smtp.elsewhere.example" } }, "smtp", /SMTP host/],
      [{ smtp: { port: 587 } }, "smtp", /SMTP port/],
      [{ smtp: { user: "someone@mail.example" } }, "smtp", /SMTP user/],
      [{ smtp: { secure: false } }, "smtp", /SMTP secure setting/],
      // A password for the other side doesn't carry this one through.
      [{ imap: { host: "imap.elsewhere.example" }, smtp: { password: "typed-smtp-pw" } }, "imap", /IMAP host/],
    ];
    for (const headers of [asDashboard(), asToken()]) {
      for (const [change, side, what] of changes) {
        const res = await post(formSave(change), headers);
        assert.equal(res.status, 400, JSON.stringify(change));
        const body = await res.json();
        assert.deepEqual(body.needsPassword, [side], JSON.stringify(change));
        assert.match(body.error, what);
        assert.match(body.error, new RegExp(`type the ${side.toUpperCase()} app password again`));
        assert.match(body.error, /Nothing was saved\.$/);
        assert.deepEqual(saved(), ownerMailbox(), `${JSON.stringify(change)} saves nothing`);
      }
    }
    assert.deepEqual(channelCalls, [], "and starts nothing");
  });

  it("both sides changed: both passwords, said once", async () => {
    const res = await post(formSave({ imap: { host: "imap.elsewhere.example" }, smtp: { port: 587 } }), asDashboard());
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body.needsPassword, ["imap", "smtp"]);
    assert.match(body.error, /^You changed the IMAP host and the SMTP port, so type the IMAP and SMTP app passwords again: /);
  });

  it("with the password typed, the new server is saved with it, and the other side keeps its own", async () => {
    const res = await post(formSave({ imap: { host: "imap.elsewhere.example", password: "typed-imap-pw" }, enabled: true }), asDashboard());
    assert.equal(res.status, 200, await res.clone().text());
    const now = saved();
    assert.deepEqual(now.imap, { host: "imap.elsewhere.example", port: 993, user: MAILBOX, password: "typed-imap-pw", secure: true });
    assert.deepEqual(now.smtp, ownerMailbox().smtp);
    assert.deepEqual(channelCalls, [["restart", "email"]]);
  });

  it("a save that keeps the server keeps the passwords, and the host typed in another case is the same server", async () => {
    const res = await post(formSave({ imap: { host: " IMAP.Mail.Example " }, mentionKeyword: "@desk", fromName: "Front Desk" }), asDashboard());
    assert.equal(res.status, 200, await res.clone().text());
    const now = saved();
    assert.deepEqual(now.imap, ownerMailbox().imap);
    assert.deepEqual(now.smtp, ownerMailbox().smtp);
    assert.equal(now.mentionKeyword, "@desk");
    assert.equal(now.fromName, "Front Desk");
    // A new password for the same server is just saved.
    assert.equal((await post(formSave({ smtp: { password: "rotated-smtp-pw" } }), asDashboard())).status, 200);
    assert.equal(saved().smtp.password, "rotated-smtp-pw");
    assert.equal(saved().imap.password, IMAP_PW);
  });

  it("keeps the secure setting and requireTLS the chat tool saved, instead of dropping them", async () => {
    settings.set("channel.email", startTlsMailbox());
    // The form has no secure switch: it sends the host, port and user it shows.
    const res = await post(formSave({ imap: { host: "mail.self.example", port: 143 }, smtp: { host: "mail.self.example", port: 587 }, fromName: "Desk" }), asDashboard());
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(saved().imap, startTlsMailbox().imap);
    assert.deepEqual(saved().smtp, startTlsMailbox().smtp);
    assert.equal(saved().fromName, "Desk");
  });

  it("a new host on the same port keeps the TLS rule saved for that port; a new port takes the form's defaults", async () => {
    settings.set("channel.email", startTlsMailbox());
    let res = await post(formSave({
      imap: { host: "mail.other.example", port: 143, password: "typed-imap-pw" },
      smtp: { host: "mail.self.example", port: 465, password: "typed-smtp-pw" },
    }), asDashboard());
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(saved().imap, { host: "mail.other.example", port: 143, user: MAILBOX, password: "typed-imap-pw", secure: false, requireTLS: true });
    assert.deepEqual(saved().smtp, { host: "mail.self.example", port: 465, user: MAILBOX, password: "typed-smtp-pw", secure: true });
    // An API caller may say secure itself.
    res = await post(formSave({ imap: { host: "mail.other.example", port: 143, secure: true, password: "typed-imap-pw" }, smtp: { host: "mail.self.example", port: 465 } }), asToken());
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(saved().imap, { host: "mail.other.example", port: 143, user: MAILBOX, password: "typed-imap-pw", secure: true });
  });

  it("with no saved password there is nothing to keep, so nothing is asked", async () => {
    settings.set("channel.email", { ...ownerMailbox(), imap: { host: "", port: 993, user: "", password: "", secure: true }, smtp: {} });
    const res = await post(formSave(), asDashboard());
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(saved().imap.host, "imap.mail.example");
    assert.equal(saved().imap.password, "");
    assert.equal(saved().smtp.password, "");
  });

  it("refuses a port that isn't a port, and a side that isn't an object", async () => {
    for (const change of [{ imap: { port: "abc", password: "pw" } }, { smtp: { port: 70000, password: "pw" } }, { smtp: { port: 1.5, password: "pw" } }]) {
      const res = await post(formSave(change), asDashboard());
      assert.equal(res.status, 400, JSON.stringify(change));
      assert.match((await res.json()).error, /port must be a whole number from 1 to 65535/);
    }
    const res = await post({ ...formSave(), imap: "imap.elsewhere.example" }, asDashboard());
    assert.equal(res.status, 400);
    assert.deepEqual(saved(), ownerMailbox());
  });
});

describe("a wider allowlist waits for the owner's OK", () => {
  const answer = (body, headers) => post({ type: "email", ...body }, headers);

  it("sent with the API token alone, a list that lets in someone new waits, and the list in force stays", async () => {
    const res = await post(formSave({ allowlistFromAddresses: ["owner@mail.example", "stranger@elsewhere.example"], fromName: "Desk" }), asToken());
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.deepEqual(body.allowlistWaiting.addresses, ["owner@mail.example", "stranger@elsewhere.example"]);
    assert.match(body.note, /waits for the owner's OK in Settings > Channels > Email/);
    const now = saved();
    assert.deepEqual(now.allowlistFromAddresses, ["owner@mail.example"]);
    assert.equal(now.allowlistWaiting.by, "token");
    assert.equal(now.fromName, "Desk", "the rest of the save goes in");
    // Empty, it would let any sender in: that waits too.
    await post(formSave({ allowlistFromAddresses: [] }), asToken());
    assert.deepEqual(saved().allowlistWaiting.addresses, []);
    assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
  });

  it("with the token, a narrower list goes straight in and replaces what waits", async () => {
    settings.set("channel.email", { ...ownerMailbox(), allowlistFromAddresses: ["owner@mail.example", "team@mail.example"] });
    await post(formSave({ allowlistFromAddresses: ["stranger@elsewhere.example"] }), asToken());
    const res = await post(formSave({ allowlistFromAddresses: ["team@mail.example"] }), asToken());
    assert.equal(res.status, 200);
    assert.equal((await res.json()).allowlistWaiting, undefined);
    assert.deepEqual(saved().allowlistFromAddresses, ["team@mail.example"]);
    assert.equal(saved().allowlistWaiting, undefined);
    assert.deepEqual(saved().allowlistOwner, ["owner@mail.example", "team@mail.example"], "what the owner had stays theirs");
  });

  it("the owner's own save from the dashboard goes straight in and is the owner's list from then on", async () => {
    await aiConfigures({ allowlistFromAddresses: ["owner@mail.example", "stranger@elsewhere.example"] });
    let res = await post(formSave({ allowlistFromAddresses: ["owner@mail.example", "Team@Mail.Example "] }), asDashboard());
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example", "team@mail.example"]);
    assert.deepEqual(saved().allowlistOwner, ["owner@mail.example", "team@mail.example"]);
    assert.deepEqual(saved().allowlistWaiting.addresses, ["owner@mail.example", "stranger@elsewhere.example"], "a save isn't an answer to what waits");
    // A list of the owner's that already lets in all that waited leaves nothing waiting.
    res = await post(formSave({ allowlistFromAddresses: ["owner@mail.example", "stranger@elsewhere.example"] }), asSignedIn());
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(saved().allowlistWaiting, undefined);
  });

  it("only the owner's signed-in dashboard OKs it: the API token can't", async () => {
    await aiConfigures({ allowlistFromAddresses: ["owner@mail.example", "stranger@elsewhere.example"] });
    const seen = ["owner@mail.example", "stranger@elsewhere.example"];
    let res = await answer({ allowlistAnswer: "approve", allowlistSeen: seen }, asToken());
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /Only you can let more senders reach Tarsee by email/);
    assert.match(body.error, /Settings > Channels > Email/);
    assert.doesNotMatch(body.error, /CSRF/);
    assert.equal(body.needsSignIn, true);
    // Signed in, without the page's CSRF token: the page fetches a fresh one and asks again.
    res = await answer({ allowlistAnswer: "approve", allowlistSeen: seen }, { ...asToken(), Cookie: `tarsee_session=${sessionId}` });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /CSRF token/);
    assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"], "still not in force");

    for (const headers of [asDashboard(), asSignedIn()]) {
      settings.set("channel.email", { ...ownerMailbox(), enabled: true });
      channelCalls.length = 0;
      await aiConfigures({ allowlistFromAddresses: seen });
      res = await answer({ allowlistAnswer: "approve", allowlistSeen: [...seen].reverse() }, headers);
      assert.equal(res.status, 200, await res.clone().text());
      assert.deepEqual((await res.json()).allowlistFromAddresses, seen);
      const now = saved();
      assert.deepEqual(now.allowlistFromAddresses, seen);
      assert.deepEqual(now.allowlistOwner, seen);
      assert.equal(now.allowlistWaiting, undefined);
      assert.deepEqual(now.imap, ownerMailbox().imap, "nothing else changes");
      assert.equal(now.enabled, true);
      assert.deepEqual(channelCalls, [["restart", "email"]], "the running channel picks it up");
    }
  });

  it("a dashboard tab whose sign-in ran out is told to sign in again, and its wider list doesn't wait as someone else's", async () => {
    // The page goes on with the API token, and the cookie of a sign-in that ended.
    const ranOut = { ...asToken(), Cookie: `tarsee_session=${"0".repeat(64)}; tarsee_csrf=${csrf}`, "X-CSRF-Token": csrf };
    let res = await post(formSave({ allowlistFromAddresses: ["owner@mail.example", "team@mail.example"] }), ranOut);
    assert.equal(res.status, 403);
    let body = await res.json();
    assert.equal(body.error, "Your sign-in has run out. Sign in again, then save the allowlist again.");
    assert.equal(body.needsSignIn, true);
    assert.deepEqual(saved(), ownerMailbox(), "nothing saved, nothing waiting");
    // A save that lets in nobody new still goes in, as with the token.
    res = await post(formSave({ fromName: "Desk" }), ranOut);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(saved().fromName, "Desk");

    await aiConfigures({ allowlistFromAddresses: [] });
    res = await answer({ allowlistAnswer: "approve", allowlistSeen: [] }, ranOut);
    assert.equal(res.status, 403);
    body = await res.json();
    assert.equal(body.error, "Your sign-in has run out. Sign in again, then let them in.");
    assert.equal(body.needsSignIn, true);
    assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
  });

  it("OKs only the list the page showed: one the AI changed since is refused with what waits now", async () => {
    await aiConfigures({ allowlistFromAddresses: ["owner@mail.example", "stranger@elsewhere.example"] });
    await aiConfigures({ allowlistFromAddresses: [] });
    let res = await answer({ allowlistAnswer: "approve", allowlistSeen: ["owner@mail.example", "stranger@elsewhere.example"] }, asDashboard());
    assert.equal(res.status, 409);
    let body = await res.json();
    assert.match(body.error, /changed after this page showed it/);
    assert.deepEqual(body.allowlistWaiting.addresses, []);
    assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
    // Without seen at all, nothing is OK'd (as a scheduled task's Switch on without seen).
    res = await answer({ allowlistAnswer: "approve" }, asDashboard());
    assert.equal(res.status, 400);
    // Nothing waiting any more.
    settings.set("channel.email", ownerMailbox());
    res = await answer({ allowlistAnswer: "approve", allowlistSeen: [] }, asDashboard());
    assert.equal(res.status, 409);
    body = await res.json();
    assert.match(body.error, /No allowlist change is waiting/);
    assert.equal((await answer({ allowlistAnswer: "maybe" }, asDashboard())).status, 400);
  });

  it("Keep my list turns it down: what waits goes, the list in force stays, and the token may do that too", async () => {
    for (const headers of [asDashboard(), asToken()]) {
      await aiConfigures({ allowlistFromAddresses: [] });
      const res = await answer({ allowlistAnswer: "decline" }, headers);
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(saved().allowlistWaiting, undefined);
      assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
    }
  });

  it("GET /api/settings shows what waits, for the form's note, with the passwords still hidden", async () => {
    await aiConfigures({ allowlistFromAddresses: ["stranger@elsewhere.example"] });
    const res = await fetch(`${base}/api/settings`, { headers: asDashboard() });
    const email = (await res.json()).settings.find((s) => s.key === "channel.email").value;
    assert.deepEqual(email.allowlistWaiting.addresses, ["stranger@elsewhere.example"]);
    assert.deepEqual(email.allowlistOwner, ["owner@mail.example"]);
    assert.equal(email.imap.password, undefined);
    assert.equal(email.imap.hasPassword, true);
  });
});

// --- In a real browser -------------------------------------------------------------------------------------------

/** The form page, signed in like the owner's dashboard: the sign-in's cookie, the page's CSRF cookie, the API token. */
async function openForm() {
  const context = await browser.newContext({ viewport: { width: 1000, height: 1400 }, serviceWorkers: "block" });
  await context.addCookies([{ name: "tarsee_session", value: sessionId, url: base }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route((url) => !url.href.startsWith(base), (route) => route.abort());
  await page.goto(`${base}/__email.html`);
  await page.evaluate(async (token) => {
    API.token = token;
    // The email form's elements, as Settings.init() finds them.
    const ids = {
      emailEnabled: "settingsEmailEnabled", emailAddress: "settingsEmailAddress",
      emailImapHost: "settingsEmailImapHost", emailImapPort: "settingsEmailImapPort", emailImapUser: "settingsEmailImapUser", emailImapPassword: "settingsEmailImapPassword",
      emailSmtpHost: "settingsEmailSmtpHost", emailSmtpPort: "settingsEmailSmtpPort", emailSmtpUser: "settingsEmailSmtpUser", emailSmtpPassword: "settingsEmailSmtpPassword",
      emailMentionKeyword: "settingsEmailMentionKeyword", emailReplyAllMarker: "settingsEmailReplyAllMarker", emailFromName: "settingsEmailFromName",
      emailAllowlist: "settingsEmailAllowlist", emailMentionHint: "emailMentionHint", emailPresetHint: "emailPresetHint",
    };
    Settings.elements = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, document.getElementById(id)]));
    Settings.loadEmailChannel((await API.getSettings()).settings);
  }, TOKEN);
  return { page, context, errors };
}

describe("the email form (js/settings.js), against the real route", { skip }, () => {
  it("says which password a changed server needs, and saves once it is typed", async () => {
    const { page, context, errors } = await openForm();
    try {
      const imapPw = page.locator("#settingsEmailImapPassword");
      const smtpPw = page.locator("#settingsEmailSmtpPassword");
      assert.match(await imapPw.getAttribute("placeholder"), /leave blank to keep/);
      await page.fill("#settingsEmailImapHost", "imap.elsewhere.example");
      assert.match(await imapPw.getAttribute("placeholder"), /Type the IMAP app password again/, "it says so as the host changes");
      assert.match(await smtpPw.getAttribute("placeholder"), /leave blank to keep/, "the SMTP side still keeps its own");
      await page.fill("#settingsEmailImapHost", "IMAP.mail.example");
      assert.match(await imapPw.getAttribute("placeholder"), /leave blank to keep/, "the same server again, in another case");

      await page.fill("#settingsEmailImapHost", "imap.elsewhere.example");
      await page.evaluate(() => Settings.saveEmailChannel());
      const toast = await page.evaluate(() => window.toasts.at(-1));
      assert.equal(toast.kind, "error");
      assert.match(toast.message, /type the IMAP app password again/);
      assert.equal(await imapPw.getAttribute("aria-invalid"), "true");
      assert.equal(await smtpPw.getAttribute("aria-invalid"), null);
      assert.equal(await page.evaluate(() => document.activeElement?.id), "settingsEmailImapPassword", "the cursor goes to the password it needs");
      assert.deepEqual(saved(), ownerMailbox(), "nothing saved");

      await imapPw.fill("typed-imap-pw");
      await page.evaluate(() => Settings.saveEmailChannel());
      assert.equal((await page.evaluate(() => window.toasts.at(-1))).kind, "success");
      assert.equal(saved().imap.host, "imap.elsewhere.example");
      assert.equal(saved().imap.password, "typed-imap-pw");
      assert.equal(saved().smtp.password, SMTP_PW);
      assert.equal(await imapPw.getAttribute("aria-invalid"), null);
      assert.match(await imapPw.getAttribute("placeholder"), /leave blank to keep/);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("shows a wider allowlist the AI asked for; Let them in OKs the list it showed", async () => {
    await aiConfigures({ allowlistFromAddresses: ["owner@mail.example", "stranger@elsewhere.example"] });
    const { page, context, errors } = await openForm();
    try {
      const note = page.locator("[data-email-allowlist-note]");
      await note.waitFor();
      assert.match(await note.innerText(), /Waiting for your OK/i, "the badge (upper case in CSS)");
      assert.match(await note.innerText(), /stranger@elsewhere\.example/);
      assert.equal(await page.inputValue("#settingsEmailAllowlist"), "owner@mail.example", "the box shows the list in force");
      const sent = page.waitForRequest((req) => req.method() === "POST");
      await note.locator("button", { hasText: "Let them in" }).click();
      assert.deepEqual((await sent).postDataJSON(), { type: "email", allowlistAnswer: "approve", allowlistSeen: ["owner@mail.example", "stranger@elsewhere.example"] });
      await page.waitForFunction(() => document.querySelector("[data-email-allowlist-note]")?.hidden === true);
      assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example", "stranger@elsewhere.example"]);
      assert.equal(await page.inputValue("#settingsEmailAllowlist"), "owner@mail.example\nstranger@elsewhere.example");
      assert.equal((await page.evaluate(() => window.toasts.at(-1))).kind, "success");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Keep my list turns it down; a list the AI changed since is shown again instead of OK'd", async () => {
    await aiConfigures({ allowlistFromAddresses: [] });
    const { page, context, errors } = await openForm();
    try {
      const note = page.locator("[data-email-allowlist-note]");
      await note.waitFor();
      assert.match(await note.innerText(), /any sender/);
      // While the owner looks, the AI asks for something else.
      await aiConfigures({ allowlistFromAddresses: ["stranger@elsewhere.example"] });
      await note.locator("button", { hasText: "Let them in" }).click();
      await page.waitForFunction(() => /stranger@elsewhere\.example/.test(document.querySelector("[data-email-allowlist-note]")?.textContent || ""));
      const toast = await page.evaluate(() => window.toasts.at(-1));
      assert.equal(toast.kind, "error");
      assert.match(toast.message, /changed after this page showed it/);
      assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"], "not OK'd");

      await note.locator("button", { hasText: "Keep my list" }).click();
      await page.waitForFunction(() => document.querySelector("[data-email-allowlist-note]")?.hidden === true);
      assert.equal(saved().allowlistWaiting, undefined);
      assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
