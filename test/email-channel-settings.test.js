// Settings > Channels > Email: the owner's save (POST /api/settings/channel, type "email", routes/settings.js), the
// owner's OK for what waits, the owner's sender check, and the form that sends them (js/settings.js). The rules:
//   - a saved mailbox password only goes to the server it was saved for. A save that changes a side's host, port, user
//     or secure setting must carry that side's password, or nothing is saved, and the form says which password it
//     needs. A save that keeps the server keeps the password, the secure setting and requireTLS (which the chat tool,
//     tarsee_configure_email_channel, sets for a server it sets up);
//   - what would change who can reach the AI by email, or where its mail goes, sent by the AI's tool or with the API
//     token alone, is saved as waiting and not put in force: turning email on, another IMAP or SMTP host or user, an
//     allowlist that lets in anyone the owner hasn't allowed, more trust in who sent a mail. A card at the top of the
//     form shows it as it is now and as it would be, with Approve and Discard. Only the owner's live sign-in approves:
//     the API token can't, since the AI's shell can read it. What narrows, and the owner's own save, go straight in;
//   - who really sent a mail is the owner's to trust (test/email-sender-check.test.js): their own server's name in its
//     Authentication-Results line, or "my mail server doesn't check senders: trust the From line", off by default.
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
const { SENDER_NOTE_KEY } = await import("../src/channels/email.js");

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
/** The same, switched on, with the list the owner saved. */
const ownerRunning = () => ({ ...ownerMailbox(), enabled: true, allowlistOwner: ["owner@mail.example"] });
/** A self-hosted server the chat tool set up on STARTTLS ports, with TLS required before the login. */
const startTlsMailbox = () => ({
  ...ownerMailbox(),
  imap: { host: "mail.self.example", port: 143, user: MAILBOX, password: IMAP_PW, secure: false, requireTLS: true },
  smtp: { host: "mail.self.example", port: 587, user: MAILBOX, password: SMTP_PW, secure: false, requireTLS: true },
});
const saved = () => settings.get("channel.email");

beforeEach(() => {
  settings.set("channel.email", ownerMailbox());
  settings.delete(SENDER_NOTE_KEY);
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
/** The page after its sign-in ran out: the API token, and the cookie of a sign-in that ended. */
const asRanOut = () => ({ ...asToken(), Cookie: `tarsee_session=${"0".repeat(64)}; tarsee_csrf=${csrf}`, "X-CSRF-Token": csrf });
/** The tool the AI calls from a chat. */
const aiConfigures = (input) => executeTool("configure_email_channel", input, { db, settingsStore: settings });
const answer = (body, headers) => post({ type: "email", ...body }, headers);
const attackerImap = { host: "imap.attacker.example", port: 993, user: "inbox@attacker.example", password: "attacker-app-pw" };
const attackerSmtp = { host: "smtp.attacker.example", port: 465, user: "inbox@attacker.example", password: "attacker-app-pw" };

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

  it("with the password typed, the owner's new server is saved with it, and the other side keeps its own", async () => {
    const res = await post(formSave({ imap: { host: "imap.elsewhere.example", password: "typed-imap-pw" }, enabled: true }), asDashboard());
    assert.equal(res.status, 200, await res.clone().text());
    const now = saved();
    assert.deepEqual(now.imap, { host: "imap.elsewhere.example", port: 993, user: MAILBOX, password: "typed-imap-pw", secure: true });
    assert.deepEqual(now.smtp, ownerMailbox().smtp);
    assert.equal(now.enabled, true);
    assert.equal(now.waiting, undefined, "the owner's own save waits for nothing");
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
    // An API caller may say secure itself; on the same host and user that is no new mailbox, so it goes in.
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

describe("with the API token alone, what would let more reach the AI or send its mail elsewhere waits", () => {
  it("turning email on waits, and nothing starts", async () => {
    const res = await post(formSave({ enabled: true }), asToken());
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.enabled, false);
    assert.equal(body.waiting.enabled, true);
    assert.match(body.note, /waits for the owner's OK in Settings > Channels > Email/);
    assert.equal(saved().enabled, false);
    assert.equal(saved().waiting.by, "token");
    assert.ok(!channelCalls.some(([what]) => what === "restart"));
  });

  it("a fresh install set up with the token waits whole, whatever its list", async () => {
    for (const allowlistFromAddresses of [[], ["accomplice@attacker.example"]]) {
      settings.delete("channel.email");
      const res = await post(formSave({ enabled: true, imap: attackerImap, smtp: attackerSmtp, allowlistFromAddresses }), asToken());
      assert.equal(res.status, 200, await res.clone().text());
      const now = saved();
      assert.equal(now.enabled, false);
      assert.equal(now.imap.host, undefined);
      assert.deepEqual(now.allowlistFromAddresses, []);
      assert.equal("allowlistOwner" in now, false);
      assert.deepEqual(now.waiting.allowlistFromAddresses, allowlistFromAddresses, "no list saved is nobody, not anyone");
      assert.equal(now.waiting.imap.host, "imap.attacker.example");
    }
  });

  it("the mailbox swap: another IMAP or SMTP host or user waits, even with its password; the answer hides the password", async () => {
    for (const change of [
      { imap: attackerImap },
      { imap: { user: "other@mail.example", password: "other-pw" } },
      { smtp: attackerSmtp },
      { smtp: { user: "other@mail.example", password: "other-pw" } },
    ]) {
      settings.set("channel.email", ownerRunning());
      channelCalls.length = 0;
      const res = await post(formSave({ ...change, enabled: true }), asToken());
      assert.equal(res.status, 200, await res.clone().text());
      const body = await res.json();
      const side = change.imap ? "imap" : "smtp";
      assert.deepEqual(saved()[side], ownerRunning()[side], `${JSON.stringify(change)}: the server in force stays the owner's`);
      assert.equal(saved().waiting[side].password, change[side].password);
      const row = db.prepare("SELECT value FROM settings WHERE key = 'channel.email'").get().value;
      assert.ok(!row.includes(change[side].password), "a waiting server's password is stored encrypted, as one in force is");
      assert.equal(body.waiting[side].password, undefined, "no password in the answer");
      assert.equal(body.waiting[side].hasPassword, true);
      assert.equal(saved().enabled, true, "it goes on running on the owner's servers");
    }
  });

  it("a wider list waits, a narrower one goes straight in and replaces what waited", async () => {
    let res = await post(formSave({ allowlistFromAddresses: ["owner@mail.example", "stranger@elsewhere.example"], fromName: "Desk" }), asToken());
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await res.json()).waiting.allowlistFromAddresses, ["owner@mail.example", "stranger@elsewhere.example"]);
    assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
    assert.equal(saved().fromName, "Desk", "the rest of the save goes in");
    // Empty, it would let any sender in: that waits too.
    await post(formSave({ allowlistFromAddresses: [] }), asToken());
    assert.deepEqual(saved().waiting.allowlistFromAddresses, []);
    assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);

    settings.set("channel.email", { ...ownerMailbox(), allowlistFromAddresses: ["owner@mail.example", "team@mail.example"] });
    await post(formSave({ allowlistFromAddresses: ["stranger@elsewhere.example"] }), asToken());
    res = await post(formSave({ allowlistFromAddresses: ["team@mail.example"] }), asToken());
    assert.equal(res.status, 200);
    assert.equal((await res.json()).waiting, undefined);
    assert.deepEqual(saved().allowlistFromAddresses, ["team@mail.example"]);
    assert.equal(saved().waiting, undefined);
  });

  it("more trust in who sent a mail waits; less goes straight in", async () => {
    settings.set("channel.email", { ...ownerMailbox(), imap: { ...ownerMailbox().imap, host: "mail.self.example" } });
    const self = { host: "mail.self.example" };
    let res = await post(formSave({ imap: self, senderCheck: { trustFromLine: true } }), asToken());
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(saved().senderCheck, undefined);
    assert.deepEqual(saved().waiting.senderCheck, { trustFromLine: true, authservId: "" });
    res = await post(formSave({ imap: self, senderCheck: { authservId: "mx.forged.example" } }), asToken());
    assert.deepEqual(saved().waiting.senderCheck, { trustFromLine: false, authservId: "mx.forged.example" });
    // The owner trusts their server's name; the token can take that back, but not name another.
    settings.set("channel.email", { ...saved(), senderCheck: { imapHost: "mail.self.example", trustFromLine: false, authservId: "mail.self.example" } });
    res = await post(formSave({ imap: self, senderCheck: { trustFromLine: false, authservId: "" } }), asToken());
    assert.equal(res.status, 200);
    assert.deepEqual(saved().senderCheck, { imapHost: "mail.self.example", trustFromLine: false, authservId: "" });
    assert.equal(saved().waiting, undefined);
  });

  it("narrowing goes straight in: email off, the mention word, the display name", async () => {
    settings.set("channel.email", ownerRunning());
    const res = await post(formSave({ enabled: false, mentionKeyword: "@desk", fromName: "Front Desk" }), asToken());
    assert.equal(res.status, 200);
    assert.equal(saved().enabled, false);
    assert.equal(saved().mentionKeyword, "@desk");
    assert.equal(saved().fromName, "Front Desk");
    assert.equal(saved().waiting, undefined);
    assert.deepEqual(channelCalls, [["stop", "email"]]);
  });

  it("a dashboard tab whose sign-in ran out is told to sign in again, rather than leave the owner's change waiting", async () => {
    let res = await post(formSave({ allowlistFromAddresses: ["owner@mail.example", "team@mail.example"] }), asRanOut());
    assert.equal(res.status, 403);
    let body = await res.json();
    assert.equal(body.error, "Your sign-in has run out. Sign in again, then save again.");
    assert.equal(body.needsSignIn, true);
    assert.deepEqual(saved(), ownerMailbox(), "nothing saved, nothing waiting");
    res = await post(formSave({ enabled: true }), asRanOut());
    assert.equal(res.status, 403);
    // A save that lets in nobody new still goes in, as with the token.
    res = await post(formSave({ fromName: "Desk" }), asRanOut());
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(saved().fromName, "Desk");
    body = await res.json();
    assert.equal(body.waiting, undefined);
  });
});

describe("the owner's OK: only the owner's live sign-in approves", () => {
  it("the API token can't approve, nor a page without its CSRF token, nor one whose sign-in ran out", async () => {
    await aiConfigures({ imap: attackerImap, allowlistFromAddresses: ["owner@mail.example", "stranger@elsewhere.example"] });
    const waitingId = saved().waiting.id;
    let res = await answer({ waitingAnswer: "approve", waitingId }, asToken());
    assert.equal(res.status, 403);
    let body = await res.json();
    assert.match(body.error, /Only you can OK this, signed in to your dashboard/);
    assert.match(body.error, /Settings > Channels > Email/);
    assert.equal(body.needsSignIn, true);
    res = await answer({ waitingAnswer: "approve", waitingId }, { ...asToken(), Cookie: `tarsee_session=${sessionId}` });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /CSRF token/);
    res = await answer({ waitingAnswer: "approve", waitingId }, asRanOut());
    assert.equal(res.status, 403);
    body = await res.json();
    assert.equal(body.error, "Your sign-in has run out. Sign in again, then approve it.");
    assert.equal(saved().imap.host, "imap.mail.example", "still not in force");
    assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
  });

  it("the owner's approval puts all of it in force: email on, the servers with their passwords, the list, which is theirs now", async () => {
    for (const headers of [asDashboard(), asSignedIn()]) {
      settings.delete("channel.email");
      channelCalls.length = 0;
      await aiConfigures({
        enabled: true,
        tarseeEmailAddress: "inbox@mail.example",
        imap: { host: "imap.gmail.com", port: 993, user: "inbox@mail.example", password: "new-imap-pw" },
        smtp: { host: "smtp.gmail.com", port: 465, user: "inbox@mail.example", password: "new-smtp-pw" },
        allowlistFromAddresses: ["owner@mail.example"],
      });
      const res = await answer({ waitingAnswer: "approve", waitingId: saved().waiting.id }, headers);
      assert.equal(res.status, 200, await res.clone().text());
      assert.deepEqual(await res.json(), { ok: true, type: "email", enabled: true, allowlistFromAddresses: ["owner@mail.example"] });
      const now = saved();
      assert.equal(now.enabled, true);
      assert.deepEqual(now.imap, { host: "imap.gmail.com", port: 993, user: "inbox@mail.example", password: "new-imap-pw", secure: true });
      assert.equal(now.smtp.password, "new-smtp-pw");
      assert.deepEqual(now.allowlistFromAddresses, ["owner@mail.example"]);
      assert.deepEqual(now.allowlistOwner, ["owner@mail.example"]);
      assert.equal(now.waiting, undefined);
      assert.deepEqual(channelCalls, [["restart", "email"]], "it starts");
    }
  });

  it("approves only the change the page showed: one changed since is refused with what waits now", async () => {
    await aiConfigures({ allowlistFromAddresses: ["owner@mail.example", "stranger@elsewhere.example"] });
    const shownId = saved().waiting.id;
    await aiConfigures({ imap: attackerImap });
    let res = await answer({ waitingAnswer: "approve", waitingId: shownId }, asDashboard());
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /changed after this page showed it/);
    assert.equal(body.waiting.imap.host, "imap.attacker.example");
    assert.equal(body.waiting.imap.password, undefined);
    assert.equal(saved().imap.host, "imap.mail.example");
    // Without an id at all, nothing is approved.
    res = await answer({ waitingAnswer: "approve" }, asDashboard());
    assert.equal(res.status, 400);
    // Nothing waiting any more.
    settings.set("channel.email", ownerMailbox());
    res = await answer({ waitingAnswer: "approve", waitingId: shownId }, asDashboard());
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /Nothing is waiting/);
    assert.equal((await answer({ waitingAnswer: "maybe" }, asDashboard())).status, 400);
  });

  it("Discard turns it down: what waits goes, what is in force stays, and the token may do that too", async () => {
    for (const headers of [asDashboard(), asToken()]) {
      await aiConfigures({ imap: attackerImap, allowlistFromAddresses: [], enabled: true });
      const res = await answer({ waitingAnswer: "discard" }, headers);
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(saved().waiting, undefined);
      assert.deepEqual(saved().imap, ownerMailbox().imap);
      assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
      assert.equal(saved().enabled, false);
    }
  });

  it("the owner's own save leaves what waits waiting, except what it has made moot", async () => {
    await aiConfigures({ imap: { ...attackerImap, host: "imap.elsewhere.example" }, allowlistFromAddresses: ["owner@mail.example", "stranger@elsewhere.example"] });
    let res = await post(formSave({ allowlistFromAddresses: ["owner@mail.example", "Team@Mail.Example "] }), asDashboard());
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(saved().allowlistOwner, ["owner@mail.example", "team@mail.example"]);
    assert.ok(saved().waiting.imap && saved().waiting.allowlistFromAddresses, "a save isn't an answer to what waits");
    // The owner sets the same server up themselves, and lets in all the list asked for: nothing is left waiting.
    res = await post(formSave({
      imap: { host: "imap.elsewhere.example", user: "inbox@attacker.example", password: "owner-typed-pw" },
      allowlistFromAddresses: ["owner@mail.example", "stranger@elsewhere.example"],
    }), asSignedIn());
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(saved().waiting, undefined);
    assert.equal(saved().imap.password, "owner-typed-pw");
  });

  it("GET /api/settings shows what waits, for the card, with the passwords still hidden", async () => {
    await aiConfigures({ imap: attackerImap, allowlistFromAddresses: ["stranger@elsewhere.example"] });
    const res = await fetch(`${base}/api/settings`, { headers: asDashboard() });
    const email = (await res.json()).settings.find((s) => s.key === "channel.email").value;
    assert.deepEqual(email.waiting.allowlistFromAddresses, ["stranger@elsewhere.example"]);
    assert.equal(email.waiting.imap.host, "imap.attacker.example");
    assert.equal(email.waiting.imap.password, undefined);
    assert.equal(email.waiting.imap.hasPassword, true);
    assert.equal(email.imap.password, undefined);
    assert.equal(email.imap.hasPassword, true);
  });
});

describe("who really sent it: the owner's sender check, and the one-time note", () => {
  it("the owner's save keeps it with the IMAP host it is for; a server name that isn't one is refused", async () => {
    let res = await post(formSave({ senderCheck: { trustFromLine: true, authservId: " Mail.Self.Example " } }), asDashboard());
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(saved().senderCheck, { imapHost: "imap.mail.example", trustFromLine: true, authservId: "mail.self.example" });
    res = await post(formSave({ senderCheck: { trustFromLine: false, authservId: "" } }), asDashboard());
    assert.equal(saved().senderCheck, undefined, "off and empty is the default, so nothing is kept");
    for (const senderCheck of [{ authservId: "mail.self.example; dmarc=pass" }, { trustFromLine: "yes" }, "on", { authservId: 42 }]) {
      res = await post(formSave({ senderCheck }), asDashboard());
      assert.equal(res.status, 400, JSON.stringify(senderCheck));
    }
  });

  it("the note: only the owner dismisses it, which hides it for good, and a change of trust or server clears it", async () => {
    const note = { host: "imap.mail.example", at: new Date().toISOString(), from: "owner@mail.example", provider: null, seen: "mx.forged.example" };
    settings.set(SENDER_NOTE_KEY, note);
    let res = await answer({ senderNote: "dismiss" }, asToken());
    assert.equal(res.status, 403);
    assert.deepEqual(settings.get(SENDER_NOTE_KEY), note);
    res = await answer({ senderNote: "dismiss" }, asDashboard());
    assert.equal(res.status, 200);
    const hidden = settings.get(SENDER_NOTE_KEY);
    assert.ok(!Number.isNaN(Date.parse(hidden.dismissedAt)), "kept, marked dismissed, so the channel doesn't write it again (test/email-sender-check.test.js)");
    assert.equal(hidden.host, note.host);

    settings.set(SENDER_NOTE_KEY, note);
    await post(formSave({ fromName: "Desk" }), asDashboard());
    assert.deepEqual(settings.get(SENDER_NOTE_KEY), note, "a save that changes neither keeps it");
    await post(formSave({ senderCheck: { trustFromLine: true } }), asDashboard());
    assert.equal(settings.get(SENDER_NOTE_KEY), null);
  });

  it("the general settings route can't write the note or the channel", async () => {
    for (const key of [SENDER_NOTE_KEY, "channel.email"]) {
      const res = await fetch(`${base}/api/settings/general`, { method: "POST", headers: { "Content-Type": "application/json", ...asToken() }, body: JSON.stringify({ key, value: {} }) });
      assert.equal(res.status, 400, key);
    }
  });
});

// --- In a real browser -------------------------------------------------------------------------------------------

/** The form page, signed in like the owner's dashboard: the sign-in's cookie, the page's CSRF cookie, the API token. */
async function openForm(width = 1000) {
  const context = await browser.newContext({ viewport: { width, height: 1400 }, serviceWorkers: "block" });
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

  it("shows what waits, old and new: email on, the server and user, the list; Approve OKs the change it showed", async () => {
    await aiConfigures({ enabled: true, imap: attackerImap, allowlistFromAddresses: ["owner@mail.example", "stranger@elsewhere.example"] });
    const { page, context, errors } = await openForm();
    try {
      const card = page.locator("[data-email-waiting]");
      await card.waitFor();
      const text = await card.innerText();
      assert.match(text, /Waiting for your OK/i, "the badge (upper case in CSS)");
      assert.match(text, /the AI, in a chat/);
      assert.match(text, /Email\s+now: +off\s+would be: on/);
      assert.match(text, /IMAP: the mailbox Tarsee reads\s+now: +imap\.mail\.example:993 as assistant@mail\.example\s+would be: imap\.attacker\.example:993 as inbox@attacker\.example/);
      assert.match(text, /SMTP: where its replies would go\s+smtp\.mail\.example:465 as assistant@mail\.example/);
      assert.match(text, /Who can reach Tarsee by email\s+now: +owner@mail\.example\s+would be: owner@mail\.example\s+stranger@elsewhere\.example/);
      assert.equal(await page.inputValue("#settingsEmailImapHost"), "imap.mail.example", "the form shows what is in force");
      assert.equal(await page.isChecked("#settingsEmailEnabled"), false);
      const shownId = saved().waiting.id;
      const sent = page.waitForRequest((req) => req.method() === "POST");
      await card.locator("button", { hasText: "Approve" }).click();
      assert.deepEqual((await sent).postDataJSON(), { type: "email", waitingAnswer: "approve", waitingId: shownId });
      await page.waitForFunction(() => document.querySelector("[data-email-waiting]")?.hidden === true);
      assert.equal(saved().imap.host, "imap.attacker.example");
      assert.equal(saved().enabled, true);
      assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example", "stranger@elsewhere.example"]);
      assert.equal(await page.inputValue("#settingsEmailImapHost"), "imap.attacker.example", "the form shows it in force now");
      assert.equal(await page.isChecked("#settingsEmailEnabled"), true);
      assert.equal(await page.inputValue("#settingsEmailAllowlist"), "owner@mail.example\nstranger@elsewhere.example");
      assert.equal((await page.evaluate(() => window.toasts.at(-1))).kind, "success");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Discard turns it down; a change made since is shown again instead of OK'd; it fits a phone", async () => {
    await aiConfigures({ allowlistFromAddresses: [] });
    const { page, context, errors } = await openForm(375);
    try {
      const card = page.locator("[data-email-waiting]");
      await card.waitFor();
      assert.match(await card.innerText(), /any sender/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll at phone width");
      // While the owner looks, the AI asks for something else.
      await aiConfigures({ smtp: attackerSmtp });
      await card.locator("button", { hasText: "Approve" }).click();
      await page.waitForFunction(() => /smtp\.attacker\.example/.test(document.querySelector("[data-email-waiting]")?.textContent || ""));
      const toast = await page.evaluate(() => window.toasts.at(-1));
      assert.equal(toast.kind, "error");
      assert.match(toast.message, /changed after this page showed it/);
      assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"], "not OK'd");
      assert.equal(saved().smtp.host, "smtp.mail.example");

      await card.locator("button", { hasText: "Discard" }).click();
      await page.waitForFunction(() => document.querySelector("[data-email-waiting]")?.hidden === true);
      assert.equal(saved().waiting, undefined);
      assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("the sender check: off by default with its warning, the one-time note, and the owner's choice saved", async () => {
    settings.set("channel.email", { ...ownerMailbox(), imap: { ...ownerMailbox().imap, host: "mail.self.example" } });
    settings.set(SENDER_NOTE_KEY, { host: "mail.self.example", at: new Date().toISOString(), from: "owner@mail.example", provider: null, seen: null });
    const { page, context, errors } = await openForm();
    try {
      const block = page.locator("[data-email-sender-check]");
      await block.waitFor();
      assert.equal(await page.isChecked("#settingsEmailTrustFromLine"), false, "off by default");
      assert.match(await block.innerText(), /My mail server doesn't check senders: trust the From line/);
      assert.match(await block.innerText(), /anyone who writes an address from your list on the From line can talk to Tarsee/);
      const note = page.locator("[data-email-sender-note]");
      assert.match(await note.innerText(), /didn't answer mail from owner@mail\.example/);
      assert.match(await note.innerText(), /mail\.self\.example/);
      await note.locator("button", { hasText: "OK" }).click();
      await page.waitForFunction(() => document.querySelector("[data-email-sender-note]")?.hidden === true);
      assert.ok(settings.get(SENDER_NOTE_KEY).dismissedAt);
      await page.evaluate(async () => Settings.loadEmailChannel((await API.getSettings()).settings));
      assert.equal(await page.locator("[data-email-sender-note]").isHidden(), true, "a dismissed note stays hidden");

      await page.check("#settingsEmailTrustFromLine");
      await page.evaluate(() => Settings.saveEmailChannel());
      assert.equal((await page.evaluate(() => window.toasts.at(-1))).kind, "success", JSON.stringify(await page.evaluate(() => window.toasts)));
      assert.deepEqual(saved().senderCheck, { imapHost: "mail.self.example", trustFromLine: true, authservId: "" });
      assert.equal(await page.isChecked("#settingsEmailTrustFromLine"), true, "shown as saved");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
