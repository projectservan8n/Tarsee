// What a chat channel says when it connects (Settings → Channels shows it from GET /api/status): who it connected as,
// or, when the platform refuses the credential, what to do about it, instead of "running" or a library's own words.
// Telegram, WhatsApp and email run against small servers on 127.0.0.1; Discord's login needs Discord, so its mapping
// and invite link are checked as functions. Nothing here touches the network beyond 127.0.0.1.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-channel-connect-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { ChannelManager } = await import("../src/channels/manager.js");
const { createTelegramBot } = await import("../src/channels/telegram.js");
const { createWhatsAppBot, whapiIdentity } = await import("../src/channels/whatsapp.js");
const { discordLoginError, discordInviteUrl, DISCORD_INVITE_PERMISSIONS } = await import("../src/channels/discord.js");
const { createEmailBot, mailServerError } = await import("../src/channels/email.js");

const db = initDb(path.join(tmp, "tarsee.db"));
const settings = new SettingsStore(db);

// The Console lines a test reads, kept instead of printed.
const logs = [];
const original = { log: console.log, warn: console.warn, error: console.error };
before(() => {
  for (const level of ["log", "warn", "error"]) console[level] = (...args) => { logs.push(args.join(" ")); };
});
after(() => {
  Object.assign(console, original);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function until(check, what, ms = 8_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A port nothing listens on. */
async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

// ── Telegram ────────────────────────────────────────────────────────────────

/** A Bot API server: getMe answers as `tg.getMe` says ("ok", 401, 404, 500 or "hang"); getUpdates hands out tg.updates. */
function fakeTelegram() {
  const tg = { getMe: "ok", updates: [], calls: [], nextUpdateId: 1 };
  tg.server = http.createServer(async (req, res) => {
    const method = req.url.split("/").pop();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    const fields = body && /json/.test(req.headers["content-type"] || "") ? JSON.parse(body) : {};
    tg.calls.push({ method, fields });
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (method === "getMe") {
      if (tg.getMe === "hang") return;
      if (tg.getMe === 401) return send(401, { ok: false, error_code: 401, description: "Unauthorized" });
      if (tg.getMe === 404) return send(404, { ok: false, error_code: 404, description: "Not Found" });
      if (tg.getMe === 500) return send(500, { ok: false, error_code: 500, description: "Internal Server Error" });
      return send(200, { ok: true, result: { id: 1, is_bot: true, first_name: "Test", username: "test_bot" } });
    }
    if (method === "getUpdates") {
      await new Promise((r) => setTimeout(r, 50));
      return send(200, { ok: true, result: tg.updates.splice(0) });
    }
    if (method === "sendMessage") {
      return send(200, { ok: true, result: { message_id: tg.calls.length, date: 0, chat: { id: Number(fields.chat_id), type: "private" }, text: fields.text } });
    }
    return send(200, { ok: true, result: true });
  });
  tg.message = (chat, text) => {
    const id = tg.nextUpdateId++;
    tg.updates.push({ update_id: id, message: { message_id: id, date: 0, chat, from: { id: chat.id, is_bot: false, first_name: chat.first_name || "Sam" }, text } });
  };
  return tg;
}

describe("Telegram checks its token before it starts polling", () => {
  const tg = fakeTelegram();
  let apiRoot;
  before(async () => {
    await new Promise((r) => tg.server.listen(0, "127.0.0.1", r));
    apiRoot = `http://127.0.0.1:${tg.server.address().port}`;
  });
  after(() => {
    tg.server.closeAllConnections?.();
    tg.server.close();
  });

  it("refuses a token Telegram does not know (401, or 404 for one that is not a token), saying where to get it", async () => {
    for (const refusal of [401, 404]) {
      tg.getMe = refusal;
      await assert.rejects(
        createTelegramBot({ token: "123:wrong" }, db, { apiRoot }),
        { message: "Telegram refused the bot token. Copy it again from @BotFather: /mybots → your bot → API Token.", refused: true },
      );
    }
    assert.equal(tg.calls.filter((c) => c.method === "getUpdates").length, 0, "it never started polling");
  });

  it("says who it connected as, asking Telegram once, and logs the chat IDs people need for the allowlist", async () => {
    tg.getMe = "ok";
    tg.calls.length = 0;
    const bot = await createTelegramBot({ token: "123:test" }, db, { apiRoot });
    try {
      assert.equal(bot.identity, "@test_bot");
      await until(() => tg.calls.some((c) => c.method === "getUpdates"), "polling");
      assert.equal(tg.calls.filter((c) => c.method === "getMe").length, 1, "launch reuses the answer instead of asking again");

      // A chat that is not on the allowlist: dropped, but its ID is in the Console to add.
      settings.set("allowlist.telegram", ["777"]);
      tg.message({ id: 555, type: "private", first_name: "Sam", username: "sam" }, "/help");
      await until(() => logs.some((l) => l.includes("chat 555")), "the ignored chat's line");
      assert.ok(logs.includes("[telegram] ignoring message from chat 555 (@sam): not on the Telegram allowlist"), logs.join("\n"));
      assert.equal(tg.calls.filter((c) => c.method === "sendMessage").length, 0, "no answer to a chat off the allowlist");

      // No allowlist yet: each chat's ID once, so the Console shows it without filling up.
      settings.set("allowlist.telegram", []);
      tg.message({ id: -100888, type: "group", title: "Ops Room" }, "/help@test_bot");
      tg.message({ id: -100888, type: "group", title: "Ops Room" }, "/help@test_bot");
      await until(() => tg.calls.filter((c) => c.method === "sendMessage" && c.fields.chat_id === -100888).length >= 2, "both answers");
      assert.deepEqual(logs.filter((l) => l.includes("chat -100888")), ["[telegram] message from chat -100888 (Ops Room)"]);
    } finally {
      await bot.stop();
    }
  });

  it("starts anyway when Telegram fails or does not answer in time, without a name until it does", async () => {
    tg.getMe = 500;
    const failing = await createTelegramBot({ token: "123:test" }, db, { apiRoot });
    assert.equal(failing.identity, null);
    await failing.stop().catch(() => {});

    tg.getMe = "hang";
    const started = Date.now();
    const slow = await createTelegramBot({ token: "123:test" }, db, { apiRoot, getMeTimeoutMs: 300 });
    assert.ok(Date.now() - started < 5_000, "the token check gave up instead of holding startup");
    assert.equal(slow.identity, null);
    assert.ok(logs.some((l) => l.startsWith("[telegram] could not check the bot token")), logs.join("\n"));
    await slow.stop().catch(() => {});
  });
});

// ── WhatsApp (WHAPI) ────────────────────────────────────────────────────────

describe("WhatsApp checks its WHAPI token", () => {
  let health = { status: 200, body: {} };
  let baseUrl;
  const server = http.createServer((req, res) => {
    res.writeHead(health.status, { "content-type": "application/json" });
    res.end(JSON.stringify(health.body));
  });
  before(async () => {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  it("refuses a token WHAPI refuses (401 or 403), saying where to copy it from", async () => {
    for (const status of [401, 403]) {
      health = { status, body: { error: { code: status, message: "Unauthorized" } } };
      await assert.rejects(
        createWhatsAppBot({ token: "wrong", baseUrl }, db),
        { message: "WHAPI refused the token. Copy it again from panel.whapi.cloud → your channel → API token.", refused: true },
      );
    }
  });

  it("refuses a token that matches no WHAPI channel: 404 Channel not found, which is how WHAPI answers one", async () => {
    health = { status: 404, body: { error: "Channel not found", requestId: "r1" } };
    await assert.rejects(
      createWhatsAppBot({ token: "wrong", baseUrl }, db),
      { message: "WHAPI refused the token. Copy it again from panel.whapi.cloud → your channel → API token.", refused: true },
    );
  });

  it("says which number it is linked to", async () => {
    health = { status: 200, body: { start_at: 1, uptime: 2, status: { code: 4, text: "AUTH" }, user: { id: "14155550123", name: "Tarsee Bot", pushname: "Tarsee" } } };
    const bot = await createWhatsAppBot({ token: "good", baseUrl }, db);
    assert.equal(bot.identity, "+14155550123 (Tarsee)");
    assert.equal(bot.warning, null);
    await bot.stop();
  });

  it("starts anyway when /health is missing or WHAPI is down, saying it couldn't check the token", async () => {
    for (const [status, body] of [[404, { error: "Service not found" }], [500, { error: { code: 500, message: "nope" } }]]) {
      health = { status, body };
      const bot = await createWhatsAppBot({ token: "good", baseUrl }, db);
      assert.equal(bot.identity, null);
      assert.match(bot.warning, /couldn't check the token with WHAPI/, `${status}`);
      await bot.stop();
    }
  });

  it("waits a while for WHAPI (it takes ~16 s to refuse a token), then starts with a warning", async () => {
    const silent = http.createServer(() => { /* never answers */ });
    await new Promise((r) => silent.listen(0, "127.0.0.1", r));
    try {
      const bot = await createWhatsAppBot({ token: "good", baseUrl: `http://127.0.0.1:${silent.address().port}` }, db, { healthTimeoutMs: 300 });
      assert.match(bot.warning, /couldn't check the token with WHAPI/);
      await bot.stop();
    } finally {
      silent.closeAllConnections?.();
      silent.close();
    }
  });

  it("reads the linked number and name out of /health", () => {
    assert.equal(whapiIdentity({ user: { id: "447700900000@s.whatsapp.net", name: "Ops" } }), "+447700900000 (Ops)");
    assert.equal(whapiIdentity({ user: { id: "x", phone: "+63 917 555 0100" } }), "+639175550100");
    assert.equal(whapiIdentity({ user: { name: "Only a name" } }), "Only a name");
    assert.equal(whapiIdentity({ status: { code: 3, text: "QR" } }), null, "no number linked yet");
    assert.equal(whapiIdentity(null), null);
  });
});

// ── Discord ─────────────────────────────────────────────────────────────────

describe("Discord says what to fix when it cannot log in", () => {
  const TOKEN = "Discord refused the bot token. In the Developer Portal: your app → Bot → Reset Token, then paste the new one.";
  const INTENTS = "Turn on Message Content Intent: Developer Portal → your app → Bot → Privileged Gateway Intents, save, then save here again.";

  it("a token Discord refuses, however discord.js words it", () => {
    assert.equal(discordLoginError(Object.assign(new Error("An invalid token was provided."), { code: "TokenInvalid" })), TOKEN);
    assert.equal(discordLoginError(new Error("An invalid token was provided.")), TOKEN);
    assert.equal(discordLoginError(new Error("Authentication failed")), TOKEN, "gateway close 4004");
  });

  it("the Message Content intent left off", () => {
    assert.equal(discordLoginError(new Error("Used disallowed intents")), INTENTS);
    assert.equal(discordLoginError(Object.assign(new Error("closed"), { code: 4014 })), INTENTS);
  });

  it("leaves anything else (a network error, an outage) in its own words", () => {
    assert.equal(discordLoginError(Object.assign(new Error("getaddrinfo ENOTFOUND discord.com"), { code: "ENOTFOUND" })), null);
    assert.equal(discordLoginError(undefined), null);
  });

  it("an invite link that adds the bot with what it needs to read and answer, once logged in", async () => {
    const { Client, PermissionFlagsBits, PermissionsBitField } = await import("discord.js");
    for (const p of ["ViewChannel", "SendMessages", "SendMessagesInThreads", "ReadMessageHistory", "AttachFiles", "EmbedLinks", "AddReactions"]) {
      assert.ok(DISCORD_INVITE_PERMISSIONS.includes(PermissionFlagsBits[p]), p);
    }
    assert.ok(!DISCORD_INVITE_PERMISSIONS.includes(PermissionFlagsBits.Administrator));
    const client = new Client({ intents: [] });
    try {
      assert.equal(discordInviteUrl(client), null, "not logged in: no application id yet");
      client.application = { id: "123456789012345678" };
      const url = new URL(discordInviteUrl(client));
      assert.equal(url.searchParams.get("client_id"), "123456789012345678");
      assert.equal(url.searchParams.get("scope"), "bot");
      assert.equal(url.searchParams.get("permissions"), PermissionsBitField.resolve(DISCORD_INVITE_PERMISSIONS).toString());
    } finally {
      client.application = null;
      await client.destroy();
    }
  });
});

// ── Email ───────────────────────────────────────────────────────────────────

/** An SMTP server that refuses every login with 535, as Gmail does to a normal password. */
function refusingSmtp() {
  return net.createServer((sock) => {
    sock.write("220 test.local ESMTP\r\n");
    sock.on("data", (d) => {
      for (const line of d.toString("utf8").split("\r\n").filter(Boolean)) {
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") sock.write("250-test.local\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (cmd === "AUTH") sock.write("535 5.7.8 Username and Password not accepted.\r\n");
        else if (cmd === "QUIT") sock.end("221 bye\r\n");
        else sock.write("250 ok\r\n");
      }
    });
    sock.on("error", () => {});
  });
}

/** An IMAP server that refuses every LOGIN. */
function refusingImap() {
  return net.createServer((sock) => {
    sock.write("* OK [CAPABILITY IMAP4rev1] test ready\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, cmd = ""] = line.split(" ");
        if (cmd.toUpperCase() === "CAPABILITY") sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        else if (cmd.toUpperCase() === "LOGIN") sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
        else if (cmd.toUpperCase() === "LOGOUT") sock.end(`* BYE\r\n${tag} OK bye\r\n`);
        else sock.write(`${tag} OK done\r\n`);
      }
    });
    sock.on("error", () => {});
  });
}

describe("email says what to fix when the mail server refuses the login or can't be reached", () => {
  const user = "tarsee@example.com";
  const servers = [];
  const listen = async (server) => {
    servers.push(server);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return server.address().port;
  };
  after(() => { for (const s of servers) s.close(); });

  const config = (imapPort, smtpPort) => ({
    enabled: true,
    imap: { host: "127.0.0.1", port: imapPort, secure: false, user, password: "normal-password" },
    smtp: { host: "127.0.0.1", port: smtpPort, secure: false, user, password: "normal-password" },
  });

  it("an IMAP login the server refuses: use an app password, with the server's own words", async () => {
    const imapPort = await listen(refusingImap());
    await assert.rejects(createEmailBot(config(imapPort, await closedPort()), db), {
      message: `The mail server refused the IMAP login for ${user}. Use an app password, not your normal password (see the steps for your provider). The server said: Invalid credentials (Failure)`,
      refused: true,
    });
    assert.ok(logs.some((l) => l.startsWith("[email] SMTP check failed (continuing anyway)")), "an SMTP server it can't reach only warns");
  });

  it("an SMTP login the server refuses fails the channel too: no reply could ever be sent", async () => {
    const smtpPort = await listen(refusingSmtp());
    await assert.rejects(createEmailBot(config(await closedPort(), smtpPort), db), {
      message: `The mail server refused the SMTP login for ${user}. Use an app password, not your normal password (see the steps for your provider). The server said: 535 5.7.8 Username and Password not accepted.`,
      refused: true,
    });
  });

  it("an IMAP server it can't reach: check the host and port", async () => {
    const port = await closedPort();
    // Not marked refused: at boot the network may just not be up yet, so it is worth trying again.
    await assert.rejects(createEmailBot(config(port, await closedPort()), db), (err) =>
      err.message === `Could not reach 127.0.0.1:${port}. Check the IMAP host and port.` && !err.refused);
  });

  it("maps imapflow's and nodemailer's errors, and leaves others alone", () => {
    const imap = { host: "imap.example.com", port: 993, user };
    const smtp = { host: "smtp.example.com", port: 465, user };
    assert.equal(mailServerError(Object.assign(new Error("getaddrinfo ENOTFOUND imap.example.com"), { code: "ENOTFOUND" }), "IMAP", imap).message,
      "Could not reach imap.example.com:993. Check the IMAP host and port.");
    for (const code of ["ECONNREFUSED", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "ETIMEDOUT", "EHOSTUNREACH"]) {
      assert.equal(mailServerError(Object.assign(new Error(code), { code }), "IMAP", imap).kind, "unreachable", code);
    }
    const dns = mailServerError(Object.assign(new Error("getaddrinfo ENOTFOUND smtp.example.com"), { code: "EDNS", originalCode: "ENOTFOUND" }), "SMTP", smtp);
    assert.deepEqual(dns, { kind: "unreachable", notFound: true, message: "Could not reach smtp.example.com:465. Check the SMTP host and port." });
    assert.equal(mailServerError(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }), "SMTP", smtp).notFound, false);
    assert.equal(mailServerError(Object.assign(new Error("Command failed"), { authenticationFailed: true }), "IMAP", imap).message,
      `The mail server refused the IMAP login for ${user}. Use an app password, not your normal password (see the steps for your provider).`);
    assert.equal(mailServerError(Object.assign(new Error("No password configured"), { authenticationFailed: true }), "IMAP", imap).message,
      `No IMAP password is saved for ${user}. Enter its app password and save again.`);
    assert.equal(mailServerError(Object.assign(new Error('Missing credentials for "PLAIN"'), { code: "EAUTH" }), "SMTP", smtp).kind, "password");
    assert.equal(mailServerError(new Error("Unexpected server response"), "IMAP", imap), null);
  });
});

// ── The channel manager ─────────────────────────────────────────────────────

describe("the channel manager's status", () => {
  it("names who each running channel connected as, and Discord's invite link, and nothing for one that is not running", () => {
    const mgr = new ChannelManager(db);
    mgr.channels.set("discord", { type: "discord", status: "running", bot: { identity: "tarsee", inviteUrl: "https://discord.com/oauth2/authorize?client_id=1&scope=bot" } });
    mgr.channels.set("whatsapp", { type: "whatsapp", status: "running", bot: { warning: "Saved, but couldn't check the token with WHAPI (timed out)." } });
    mgr.channels.set("slack", { type: "slack", status: "starting", bot: { identity: "@old in Old Team" } });
    mgr.channels.set("email", { type: "email", status: "error", error: "nope", bot: null });
    const s = mgr.getStatus();
    assert.deepEqual(s.discord, { status: "running", error: null, identity: "tarsee", inviteUrl: "https://discord.com/oauth2/authorize?client_id=1&scope=bot", warning: null });
    assert.deepEqual(s.whatsapp, { status: "running", error: null, identity: null, inviteUrl: null, warning: "Saved, but couldn't check the token with WHAPI (timed out)." });
    assert.equal(s.slack.identity, null, "the old bot's name is not the new one's while it starts");
    assert.deepEqual(s.email, { status: "error", error: "nope", identity: null, inviteUrl: null, warning: null });
  });

  it("switching a channel off clears the error it failed with, so Settings says Off", async () => {
    const mgr = new ChannelManager(db);
    mgr.channels.set("telegram", { type: "telegram", status: "error", error: "Telegram refused the bot token.", bot: null });
    await mgr.stop("telegram");
    assert.equal(mgr.getStatus().telegram.status, "not_configured");
  });

  it("from a real start: a refused Telegram token is the error Settings shows, a good one the name", async () => {
    const tg = fakeTelegram();
    await new Promise((r) => tg.server.listen(0, "127.0.0.1", r));
    const apiRoot = `http://127.0.0.1:${tg.server.address().port}`;
    const mgr = new ChannelManager(db);
    try {
      tg.getMe = 401;
      await assert.rejects(mgr.start("telegram", { enabled: true, token: "123:wrong" }, { apiRoot }));
      assert.deepEqual(mgr.getStatus().telegram, {
        status: "error",
        error: "Telegram refused the bot token. Copy it again from @BotFather: /mybots → your bot → API Token.",
        identity: null,
        inviteUrl: null,
        warning: null,
      });
      tg.getMe = "ok";
      await mgr.start("telegram", { enabled: true, token: "123:test" }, { apiRoot });
      assert.equal(mgr.getStatus().telegram.status, "running");
      assert.equal(mgr.getStatus().telegram.identity, "@test_bot");
      await until(() => tg.calls.some((c) => c.method === "getUpdates"), "polling");
    } finally {
      await mgr.stop("telegram");
      tg.server.closeAllConnections?.();
      tg.server.close();
    }
  });
});

describe("starting at boot: a refused credential is not tried again", () => {
  it("stops at the first refusal, which only a change in Settings can fix, and still retries anything else", async () => {
    const mgr = new ChannelManager(db);
    let calls = 0;
    mgr.start = async () => { calls++; throw Object.assign(new Error("Telegram refused the bot token."), { refused: true }); };
    await mgr._startWithRetry("telegram", {}, 3);
    assert.equal(calls, 1, "a refused token is tried once");

    calls = 0;
    mgr.start = async () => { calls++; if (calls === 1) throw new Error("getaddrinfo EAI_AGAIN api.telegram.org"); };
    await mgr._startWithRetry("telegram", {}, 3);
    assert.equal(calls, 2, "a network error at boot is tried again");
  });
});
