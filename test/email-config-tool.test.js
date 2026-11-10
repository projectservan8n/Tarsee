// tarsee_configure_email_channel (src/lib/tools.js): the email settings the AI can change from chat. The AI may be
// steered by a web page or a message it reads, so a saved mailbox password only ever goes to the server it was saved
// for: a call that changes the IMAP or SMTP host, port, user or secure setting must carry that password itself, and
// the tool never sets up a connection that could log in in plain text. The mail servers here are small fakes on
// 127.0.0.1 that write down every line they are sent, logins included. Nothing reaches the network beyond 127.0.0.1.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-email-config-tool-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
// A key for this test's own temporary database, so passwords are stored encrypted as they are in a real install.
process.env.ENCRYPTION_KEY = "email-config-tool-test-only-key-0123456789";
fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ChannelManager } = await import("../src/channels/manager.js");
const { executeTool } = await import("../src/lib/tools.js");
const { createEmailBot, smtpTransportOptions, mailServerError } = await import("../src/channels/email.js");
const { createTarseeMcp } = await import("../src/ai/tarsee-mcp.js");

const db = initDb(path.join(tmp, "tarsee.db"));
const settings = new SettingsStore(db);
const manager = new ChannelManager(db);
const ctx = { db, settingsStore: settings, channelManager: manager };
const configure = (input) => executeTool("configure_email_channel", input, ctx);

// The channel's own Console lines, kept out of the test output.
const original = { log: console.log, warn: console.warn, error: console.error };
before(() => { for (const level of ["log", "warn", "error"]) console[level] = () => {}; });

const IMAP_PW = "owner-imap-pw-7Q2x";
const SMTP_PW = "owner-smtp-pw-9K4z";
const MAILBOX = "assistant@mail.example";

/** Every line any fake mail server here was sent: { server, line }. */
const heard = [];
/** The name of the fake server each connection reached, in order. */
const connected = [];

/** Whether a fake mail server was sent this secret, as typed or base64-encoded (SMTP AUTH PLAIN). */
function serverHeard(secret) {
  return heard.some(({ line }) => line.includes(secret) || line.split(/\s+/).some((token) => {
    try { return Buffer.from(token, "base64").toString("utf8").includes(secret); } catch { return false; }
  }));
}

/** The logins the fake servers were sent: IMAP LOGIN or AUTHENTICATE, SMTP AUTH. */
const logins = () => heard.filter(({ server, line }) =>
  server === "imap" ? /^\S+ (LOGIN|AUTHENTICATE)\b/i.test(line) : /^AUTH\b/i.test(line));

/** Calls onLine(line, sock) for each CRLF line a client sends, after writing the greeting. */
function lineServer(name, greeting, onLine) {
  return net.createServer((sock) => {
    connected.push(name);
    sock.on("error", () => {});
    sock.write(greeting);
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i;
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        heard.push({ server: name, line });
        onLine(line, sock);
      }
    });
  });
}

/** An IMAP server with no STARTTLS that writes down the LOGIN it is sent and refuses it. */
const fakeImap = () => lineServer("imap", "* OK [CAPABILITY IMAP4rev1] fake ready\r\n", (line, sock) => {
  const [tag, cmd = ""] = line.split(" ");
  const verb = cmd.toUpperCase();
  if (verb === "CAPABILITY") sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
  else if (verb === "LOGIN" || verb === "AUTHENTICATE") sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
  else if (verb === "LOGOUT") sock.end(`* BYE\r\n${tag} OK bye\r\n`);
  else sock.write(`${tag} OK done\r\n`);
});

/** An SMTP server with no STARTTLS that takes any AUTH PLAIN login, after writing it down. */
const fakeSmtp = () => lineServer("smtp", "220 fake.local ESMTP\r\n", (line, sock) => {
  const verb = line.split(" ")[0].toUpperCase();
  if (verb === "EHLO") sock.write("250-fake.local\r\n250 AUTH PLAIN\r\n");
  else if (verb === "AUTH") sock.write("235 2.7.0 ok\r\n");
  else if (verb === "STARTTLS") sock.write("454 4.7.0 TLS not available\r\n");
  else if (verb === "QUIT") sock.end("221 bye\r\n");
  else sock.write("250 ok\r\n");
});

const servers = [fakeImap(), fakeSmtp()];
let imapPort;
let smtpPort;
before(async () => {
  for (const s of servers) await new Promise((r) => s.listen(0, "127.0.0.1", r));
  imapPort = servers[0].address().port;
  smtpPort = servers[1].address().port;
});
after(async () => {
  for (const type of [...manager.channels.keys()]) await manager.stop(type).catch(() => {});
  for (const s of servers) s.close();
  Object.assign(console, original);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

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
const saved = () => settings.get("channel.email");

beforeEach(async () => {
  await manager.stop("email").catch(() => {});
  settings.set("channel.email", ownerMailbox());
  heard.length = 0;
  connected.length = 0;
});

describe("tarsee_configure_email_channel: a saved password only goes to the server it was saved for", () => {
  it("moving IMAP and SMTP to another server without the passwords is refused, and nothing logs in there", async () => {
    // What a steered AI would send: the owner's mailbox, pointed at a server someone else runs, switched on.
    for (const secure of [false, undefined]) {
      heard.length = 0;
      connected.length = 0;
      const result = await configure({
        imap: { host: "127.0.0.1", port: imapPort, ...(secure === undefined ? {} : { secure }) },
        smtp: { host: "127.0.0.1", port: smtpPort, ...(secure === undefined ? {} : { secure }) },
        enabled: true,
      });
      assert.equal(serverHeard(IMAP_PW), false, `secure ${secure}: the other server never sees the saved IMAP password`);
      assert.equal(serverHeard(SMTP_PW), false, `secure ${secure}: the other server never sees the saved SMTP password`);
      assert.deepEqual(logins(), [], "nothing logs in there at all");
      assert.deepEqual(connected, [], "nothing even connects there");
      assert.match(result, /^configure_email_channel error: /, `secure ${secure}: ${result}`);
      assert.match(result, /Nothing was saved\.$/);
      assert.deepEqual(saved(), ownerMailbox(), "the saved settings stay as they were");
    }
  });

  it("a change of host alone, of port, of user or of the secure setting needs that side's password in the same call", async () => {
    const changes = [
      [{ imap: { host: "127.0.0.1" } }, /IMAP host/],
      [{ smtp: { host: "127.0.0.1" } }, /SMTP host/],
      [{ imap: { port: imapPort } }, /IMAP port/],
      [{ smtp: { port: 587 } }, /SMTP port/],
      [{ imap: { user: "someone@mail.example" } }, /IMAP user/],
      [{ smtp: { user: "someone@mail.example" } }, /SMTP user/],
      [{ imap: { host: "127.0.0.1", password: "" } }, /IMAP host/],
      // One side with its password doesn't carry the other side's change through.
      [{ smtp: { host: "smtp.other.example", password: "typed-smtp-pw" }, imap: { host: "imap.other.example" } }, /IMAP host/],
    ];
    for (const [input, what] of changes) {
      const result = await configure(input);
      assert.match(result, /^configure_email_channel error: /, JSON.stringify(input));
      assert.match(result, what, JSON.stringify(input));
      assert.match(result, /password/, "it says the password is what's missing");
      assert.deepEqual(saved(), ownerMailbox(), `${JSON.stringify(input)} saves nothing`);
    }
    // secure: false on a STARTTLS port is allowed (below), but still a change that needs the password.
    settings.set("channel.email", { ...ownerMailbox(), smtp: { ...ownerMailbox().smtp, port: 587 } });
    const result = await configure({ smtp: { secure: false } });
    assert.match(result, /^configure_email_channel error: .*SMTP secure setting/);
    assert.equal(saved().smtp.secure, true);
  });

  it("the call that carries the password moves the side, and its new server is only reached over TLS", async () => {
    const result = await configure({
      imap: { host: "127.0.0.1", port: imapPort, password: "typed-imap-pw" },
      smtp: { host: "127.0.0.1", port: smtpPort, password: "typed-smtp-pw" },
      enabled: true,
    });
    assert.doesNotMatch(result, /^configure_email_channel error/, result);
    const now = saved();
    assert.equal(now.imap.host, "127.0.0.1");
    assert.equal(now.imap.password, "typed-imap-pw");
    assert.equal(now.imap.secure, true);
    assert.equal(now.smtp.password, "typed-smtp-pw");
    assert.equal(now.smtp.requireTLS, true, "SMTP on a port other than 465 must upgrade to TLS before it logs in");
    // These servers offer no TLS, so the channel gives up before any login: not the old passwords, not the new ones.
    // SMTP is checked first, and a server that won't switch to TLS stops the channel there.
    assert.ok(connected.includes("smtp"), `the channel did try the SMTP server: ${connected}`);
    // The IMAP side as saved, started with an SMTP stand-in that lets it through: it never logs in either.
    const okSmtp = { verify: async () => true, sendMail: async () => ({}), close() {} };
    await assert.rejects(createEmailBot(now, db, { smtpTransport: okSmtp }));
    assert.ok(connected.includes("imap"), `the channel did try the IMAP server: ${connected}`);
    for (const secret of [IMAP_PW, SMTP_PW, "typed-imap-pw", "typed-smtp-pw"]) assert.equal(serverHeard(secret), false, secret);
    assert.deepEqual(logins(), []);
  });

  it("the same server with other settings changed keeps the saved passwords, and they still log in there", async () => {
    // The owner's own server here is the fake one, as the owner set it up in Settings (plain text is their choice).
    const own = {
      ...ownerMailbox(),
      allowlistFromAddresses: ["owner@mail.example", "team@mail.example"],
      imap: { host: "127.0.0.1", port: imapPort, user: MAILBOX, password: IMAP_PW, secure: false },
      smtp: { host: "127.0.0.1", port: smtpPort, user: MAILBOX, password: SMTP_PW, secure: false },
    };
    settings.set("channel.email", own);
    const result = await configure({
      mentionKeyword: "helper",
      fromName: "Front Desk",
      replyAllMarker: "[all]",
      allowlistFromAddresses: ["team@mail.example"],
      // Repeating what is already saved, in another case, is no change.
      imap: { host: "127.0.0.1", port: imapPort, user: MAILBOX },
      smtp: { host: "127.0.0.1" },
      enabled: true,
    });
    assert.doesNotMatch(result, /^configure_email_channel error/, result);
    const now = saved();
    assert.deepEqual(now.imap, own.imap, "IMAP stays exactly as the owner saved it");
    assert.deepEqual(now.smtp, own.smtp, "SMTP stays exactly as the owner saved it");
    assert.equal(now.mentionKeyword, "helper");
    assert.equal(now.fromName, "Front Desk");
    assert.equal(now.replyAllMarker, "[all]");
    assert.deepEqual(now.allowlistFromAddresses, ["team@mail.example"]);
    assert.equal(now.enabled, true);
    assert.equal(serverHeard(IMAP_PW), true, "the saved IMAP password still logs in at its own server");
    assert.equal(serverHeard(SMTP_PW), true, "the saved SMTP password still logs in at its own server");

    // A host name differs only in case: still the same server.
    settings.set("channel.email", ownerMailbox());
    const again = await configure({ imap: { host: "IMAP.Mail.Example" }, smtp: { host: " smtp.mail.example " }, mentionKeyword: "desk" });
    assert.doesNotMatch(again, /^configure_email_channel error/, again);
    assert.equal(saved().imap.password, IMAP_PW);
    assert.equal(saved().smtp.password, SMTP_PW);
    assert.equal(saved().mentionKeyword, "desk");
  });

  it("a new password for the same server is just saved", async () => {
    const result = await configure({ imap: { password: "rotated-imap-pw" } });
    assert.doesNotMatch(result, /^configure_email_channel error/, result);
    assert.deepEqual(saved().imap, { ...ownerMailbox().imap, password: "rotated-imap-pw" });
    assert.equal(saved().smtp.password, SMTP_PW);
  });
});

describe("tarsee_configure_email_channel: no plain-text logins", () => {
  it("secure: false is refused unless the port is a STARTTLS port", async () => {
    const refusals = [
      { imap: { host: "imap.mail.example", port: 993, secure: false, password: "pw" } },
      { imap: { host: "mail.self.example", port: 1143, secure: false, user: MAILBOX, password: "pw" } },
      { smtp: { host: "smtp.mail.example", port: 465, secure: false, password: "pw" } },
      { smtp: { host: "mail.self.example", port: 2526, secure: false, user: MAILBOX, password: "pw" } },
      // The reviewer's call, but with a password: still plain text.
      { imap: { host: "127.0.0.1", port: imapPort, secure: false, password: "pw" }, enabled: true },
    ];
    for (const input of refusals) {
      const result = await configure(input);
      assert.match(result, /^configure_email_channel error: .*plain text/, JSON.stringify(input));
      assert.match(result, /STARTTLS/, "it says which ports can do without secure");
      assert.deepEqual(saved(), ownerMailbox(), `${JSON.stringify(input)} saves nothing`);
    }
    assert.deepEqual(logins(), []);
  });

  it("secure: false on a STARTTLS port is saved with TLS required", async () => {
    const result = await configure({
      imap: { host: "mail.self.example", port: 143, secure: false, user: MAILBOX, password: "self-imap-pw" },
      smtp: { host: "mail.self.example", port: 587, secure: false, user: MAILBOX, password: "self-smtp-pw" },
    });
    assert.doesNotMatch(result, /^configure_email_channel error/, result);
    assert.match(result, /STARTTLS, TLS required/);
    assert.deepEqual(saved().imap, { host: "mail.self.example", port: 143, user: MAILBOX, password: "self-imap-pw", secure: false, requireTLS: true });
    assert.deepEqual(saved().smtp, { host: "mail.self.example", port: 587, user: MAILBOX, password: "self-smtp-pw", secure: false, requireTLS: true });
    for (const port of [25, 2525]) {
      const r = await configure({ smtp: { port, secure: false, password: "self-smtp-pw" } });
      assert.doesNotMatch(r, /^configure_email_channel error/, r);
      assert.equal(saved().smtp.requireTLS, true);
    }
  });

  it("the common providers still save as before", async () => {
    const providers = {
      gmail: { imap: ["imap.gmail.com", 993], smtp: ["smtp.gmail.com", 465] },
      icloud: { imap: ["imap.mail.me.com", 993], smtp: ["smtp.mail.me.com", 587] },
      zoho: { imap: ["imap.zoho.com", 993], smtp: ["smtp.zoho.com", 465] },
      fastmail: { imap: ["imap.fastmail.com", 993], smtp: ["smtp.fastmail.com", 465] },
      yahoo: { imap: ["imap.mail.yahoo.com", 993], smtp: ["smtp.mail.yahoo.com", 465] },
      outlook: { imap: ["outlook.office365.com", 993], smtp: ["smtp.office365.com", 587] },
    };
    for (const [name, p] of Object.entries(providers)) {
      settings.delete("channel.email");
      const address = `assistant@${name}.example`;
      const result = await configure({
        tarseeEmailAddress: address,
        imap: { host: p.imap[0], port: p.imap[1], user: address, password: `${name}-app-pw` },
        smtp: { host: p.smtp[0], port: p.smtp[1], user: address, password: `${name}-app-pw` },
      });
      assert.doesNotMatch(result, /^configure_email_channel error/, `${name}: ${result}`);
      const now = saved();
      assert.equal(now.imap.secure, true, name);
      assert.equal(now.imap.requireTLS, undefined, `${name}: IMAP on 993 is TLS from the start`);
      assert.equal(now.smtp.secure, true, name);
      assert.equal(now.smtp.requireTLS, p.smtp[1] === 587 ? true : undefined, `${name}: SMTP on 587 must upgrade to TLS`);
      assert.equal(now.smtp.password, `${name}-app-pw`);
    }
  });

  it("refuses a port that isn't a port, and a side that isn't an object", async () => {
    const refusals = [
      { imap: { port: "abc", password: "pw" } },
      { smtp: { port: 70000, password: "pw" } },
      { imap: { port: true, password: "pw" } },
      { smtp: { port: [587], password: "pw" } },
      { smtp: { port: 587.5, password: "pw" } },
      { imap: "imap.evil.example" },
      { smtp: { host: 42, password: "pw" } },
      { imap: { secure: "false", password: "pw" } },
    ];
    for (const input of refusals) {
      const result = await configure(input);
      assert.match(result, /^configure_email_channel error: /, JSON.stringify(input));
      assert.deepEqual(saved(), ownerMailbox());
    }
    // A port written as text is still a port.
    const result = await configure({ smtp: { port: "465" } });
    assert.doesNotMatch(result, /^configure_email_channel error/, result);
    assert.equal(saved().smtp.password, SMTP_PW, "the same port, written as text, is no change");
  });

  it("a saved server without a port is the one the channel connects to, on 993 or 465", async () => {
    settings.set("channel.email", {
      ...ownerMailbox(),
      imap: { ...ownerMailbox().imap, port: undefined },
      smtp: { ...ownerMailbox().smtp, port: 0 },
    });
    const result = await configure({ imap: { port: 993 }, smtp: { port: 465 }, mentionKeyword: "desk" });
    assert.doesNotMatch(result, /^configure_email_channel error/, result);
    assert.equal(saved().imap.password, IMAP_PW);
    assert.equal(saved().smtp.password, SMTP_PW);
    const moved = await configure({ smtp: { port: 587 } });
    assert.match(moved, /^configure_email_channel error: .*SMTP port/);
  });
});

describe("the email channel insists on TLS when its settings say so", () => {
  const requireTls = () => ({
    enabled: true,
    imap: { host: "127.0.0.1", port: imapPort, secure: false, requireTLS: true, user: MAILBOX, password: IMAP_PW },
    smtp: { host: "127.0.0.1", port: smtpPort, secure: false, requireTLS: true, user: MAILBOX, password: SMTP_PW },
  });

  it("SMTP with requireTLS never logs in to a server that offers no STARTTLS, and says that, not that it can't be reached", async () => {
    await assert.rejects(createEmailBot(requireTls(), db), (err) => {
      assert.equal(err.message, `The SMTP server 127.0.0.1:${smtpPort} doesn't offer TLS (STARTTLS) on this port, so Tarsee won't log in to it. Check the SMTP port: most providers take 465 (TLS) or 587 (STARTTLS).`);
      assert.doesNotMatch(err.message, /reach/);
      assert.equal(err.refused, true, "trying again can't help until the settings change");
      return true;
    });
    assert.ok(heard.some(({ server, line }) => server === "smtp" && /^STARTTLS\b/i.test(line)), "SMTP asked for TLS and stopped when it was refused");
    assert.equal(serverHeard(SMTP_PW), false);
    assert.deepEqual(logins(), []);
  });

  it("IMAP with requireTLS never logs in to a server that offers no STARTTLS, and says so in the same words", async () => {
    const okSmtp = { verify: async () => true, sendMail: async () => ({}), close() {} };
    await assert.rejects(createEmailBot(requireTls(), db, { smtpTransport: okSmtp }), (err) => {
      assert.equal(err.message, `The IMAP server 127.0.0.1:${imapPort} doesn't offer TLS (STARTTLS) on this port, so Tarsee won't log in to it. Check the IMAP port: most providers take 993 (TLS).`);
      assert.equal(err.refused, true);
      return true;
    });
    assert.ok(connected.includes("imap"), `the channel did try the IMAP server: ${connected}`);
    assert.equal(serverHeard(IMAP_PW), false);
    assert.deepEqual(logins(), []);
  });

  it("a STARTTLS refusal is its own case; a server that can't be reached is still told as before", () => {
    const smtp = { host: "smtp.example.com", port: 587, user: MAILBOX };
    const refusedTls = Object.assign(new Error("Error upgrading connection with STARTTLS"), { code: "ETLS", command: "STARTTLS", response: "454 4.7.0 TLS not available" });
    assert.deepEqual(mailServerError(refusedTls, "SMTP", smtp), {
      kind: "tls",
      message: "The SMTP server smtp.example.com:587 doesn't offer TLS (STARTTLS) on this port, so Tarsee won't log in to it. Check the SMTP port: most providers take 465 (TLS) or 587 (STARTTLS).",
    });
    const imapNoTls = Object.assign(new Error("Server does not support STARTTLS"), { tlsFailed: true });
    assert.equal(mailServerError(imapNoTls, "IMAP", { host: "imap.example.com", port: 143, user: MAILBOX }).kind, "tls");
    assert.equal(mailServerError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION", originalCode: "ECONNREFUSED" }), "SMTP", smtp).kind, "unreachable");
  });

  it("settings without it connect as they always have", () => {
    assert.equal(smtpTransportOptions({ host: "h", port: 587 }).requireTLS, undefined);
    assert.equal(smtpTransportOptions({ host: "h", port: 587, requireTLS: true }).requireTLS, true);
    assert.equal(smtpTransportOptions({ host: "h", port: 465, requireTLS: true }).secure, true);
  });
});

// The allowlist says who can reach the AI by email; an empty one lets any sender in. A steered AI could let in someone
// who then talks to it by email, so a list that lets in anyone the owner hasn't allowed waits for the owner's OK in
// Settings > Channels > Email (test/email-channel-settings.test.js), as a scheduled task the AI makes and a HEARTBEAT.md
// it writes wait. The owner's list is the one they last saved there or OK'd (allowlistOwner); with none stored yet,
// the list in force counts as theirs.
describe("tarsee_configure_email_channel: who can reach the AI by email", () => {
  it("adding an address the owner hasn't allowed waits for the owner's OK, and the list in force stays", async () => {
    const result = await configure({ allowlistFromAddresses: ["owner@mail.example", " Stranger@Elsewhere.example "] });
    assert.doesNotMatch(result, /^configure_email_channel error/, result);
    assert.match(result, /waits for the owner's OK/);
    assert.match(result, /Settings > Channels > Email/);
    assert.match(result, /stranger@elsewhere\.example/);
    assert.match(result, /Allowlist: {3}1 address \(owner@mail\.example\)/, "the list in force is the one shown");
    const now = saved();
    assert.deepEqual(now.allowlistFromAddresses, ["owner@mail.example"], "the channel still answers only the owner's list");
    assert.deepEqual(now.allowlistWaiting.addresses, ["owner@mail.example", "stranger@elsewhere.example"]);
    assert.equal(now.allowlistWaiting.by, "ai");
    assert.ok(!Number.isNaN(Date.parse(now.allowlistWaiting.since)), now.allowlistWaiting.since);
    assert.deepEqual(now.allowlistOwner, ["owner@mail.example"], "the list from before this rule counts as the owner's");
  });

  it("emptying the list waits too: an empty list lets any sender in", async () => {
    const result = await configure({ allowlistFromAddresses: [] });
    assert.match(result, /waits for the owner's OK/);
    assert.match(result, /any sender/);
    assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
    assert.deepEqual(saved().allowlistWaiting.addresses, []);
  });

  it("narrowing goes straight in, an address the owner put on the list can come back, and the latest ask replaces what waits", async () => {
    settings.set("channel.email", { ...ownerMailbox(), allowlistFromAddresses: ["owner@mail.example", "team@mail.example"] });
    let result = await configure({ allowlistFromAddresses: ["team@mail.example"] });
    assert.doesNotMatch(result, /waits/, result);
    assert.deepEqual(saved().allowlistFromAddresses, ["team@mail.example"]);
    assert.equal(saved().allowlistWaiting, undefined);
    assert.deepEqual(saved().allowlistOwner, ["owner@mail.example", "team@mail.example"]);

    result = await configure({ allowlistFromAddresses: ["team@mail.example", "OWNER@mail.example"] });
    assert.doesNotMatch(result, /waits/, result);
    assert.deepEqual(saved().allowlistFromAddresses, ["team@mail.example", "owner@mail.example"]);

    result = await configure({ allowlistFromAddresses: ["team@mail.example", "stranger@elsewhere.example"] });
    assert.match(result, /waits for the owner's OK/);
    assert.deepEqual(saved().allowlistFromAddresses, ["team@mail.example", "owner@mail.example"]);

    result = await configure({ allowlistFromAddresses: ["owner@mail.example"] });
    assert.doesNotMatch(result, /waits/, result);
    assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
    assert.equal(saved().allowlistWaiting, undefined, "what waited was the AI's earlier ask; this one replaces it");
  });

  it("the rest of the call is saved while the allowlist waits, and a call without an allowlist leaves what waits", async () => {
    await configure({ allowlistFromAddresses: ["stranger@elsewhere.example"], mentionKeyword: "desk", fromName: "Front Desk" });
    assert.equal(saved().mentionKeyword, "desk");
    assert.equal(saved().fromName, "Front Desk");
    assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
    await configure({ fromName: "Desk" });
    assert.equal(saved().fromName, "Desk");
    assert.deepEqual(saved().allowlistWaiting.addresses, ["stranger@elsewhere.example"]);
  });

  it("a list the owner left empty (any sender) has nothing to widen", async () => {
    settings.set("channel.email", { ...ownerMailbox(), allowlistFromAddresses: [], allowlistOwner: [] });
    let result = await configure({ allowlistFromAddresses: ["owner@mail.example"] });
    assert.doesNotMatch(result, /waits/, result);
    assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
    result = await configure({ allowlistFromAddresses: [] });
    assert.doesNotMatch(result, /waits/, result);
    assert.deepEqual(saved().allowlistFromAddresses, [], "back to the owner's own choice");
  });

  it("the tool can't mark a list as the owner's, or OK what waits", async () => {
    const result = await configure({
      allowlistFromAddresses: ["stranger@elsewhere.example"],
      allowlistOwner: ["stranger@elsewhere.example"],
      allowlistWaiting: null,
      allowlistAnswer: "approve",
      allowlistSeen: ["stranger@elsewhere.example"],
    });
    assert.match(result, /waits for the owner's OK/);
    assert.deepEqual(saved().allowlistFromAddresses, ["owner@mail.example"]);
    assert.deepEqual(saved().allowlistOwner, ["owner@mail.example"]);
    await configure({ allowlistOwner: [], allowlistWaiting: null });
    assert.deepEqual(saved().allowlistOwner, ["owner@mail.example"]);
    assert.deepEqual(saved().allowlistWaiting.addresses, ["stranger@elsewhere.example"]);
  });

  it("refuses an allowlist that isn't a list of addresses", async () => {
    for (const allowlistFromAddresses of ["stranger@elsewhere.example", [42], [{}], { 0: "a@b.example" }]) {
      const result = await configure({ allowlistFromAddresses });
      assert.match(result, /^configure_email_channel error: allowlistFromAddresses/, JSON.stringify(allowlistFromAddresses));
      assert.deepEqual(saved(), ownerMailbox());
    }
  });
});

describe("the tool says what it needs", () => {
  it("its description and its password fields say a changed server needs the password in the same call", async () => {
    const server = createTarseeMcp(ctx, { quiet: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tarsee-test", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "tarsee_configure_email_channel");
      assert.ok(tool, "the tool is listed");
      assert.match(tool.description, /host, port, user or secure/);
      assert.match(tool.description, /same call/);
      assert.match(tool.description, /STARTTLS/);
      assert.match(tool.description, /allowlist[^.]*owner's OK in Settings > Channels > Email/i, "a wider allowlist waits for the owner");
      assert.match(tool.inputSchema.properties.allowlistFromAddresses.description, /owner's OK/);
      for (const side of ["imap", "smtp"]) {
        const fields = tool.inputSchema.properties[side].properties;
        assert.match(fields.password.description, /host, port, user or secure/, `${side}.password`);
        assert.match(fields.secure.description, /STARTTLS/, `${side}.secure`);
      }
    } finally {
      await client.close();
    }
  });
});
