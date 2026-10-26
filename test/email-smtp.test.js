// What the email channel sends (src/channels/email.js), through the real nodemailer to a small SMTP server in this
// test: the bytes that arrive, headers, threading, signature and attachments, as a mail server would see them.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import nodemailer from "nodemailer";
import { smtpTransportOptions, buildReplyMail, buildNewMail, buildDirectMail, normalizeConfig } from "../src/channels/email.js";

/** An SMTP server that takes everything (AUTH PLAIN, no TLS) and keeps each message: { auth, from, rcpt, data }. */
function fakeSmtp() {
  const mails = [];
  const server = net.createServer((sock) => {
    let buf = "";
    let inData = false;
    let cur = { rcpt: [] };
    sock.write("220 test.local ESMTP\r\n");
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end === -1) return;
          cur.data = buf.slice(0, end + 2).replace(/^\.\./gm, ".");
          buf = buf.slice(end + 5);
          inData = false;
          mails.push(cur);
          cur = { rcpt: [], auth: cur.auth };
          sock.write("250 queued\r\n");
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i === -1) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") sock.write("250-test.local\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
        else if (cmd === "AUTH") { cur.auth = line; sock.write("235 ok\r\n"); }
        else if (cmd === "MAIL") { cur.from = line; sock.write("250 ok\r\n"); }
        else if (cmd === "RCPT") { cur.rcpt.push(line); sock.write("250 ok\r\n"); }
        else if (cmd === "DATA") { inData = true; sock.write("354 go ahead\r\n"); }
        else if (cmd === "QUIT") { sock.end("221 bye\r\n"); return; }
        else sock.write("250 ok\r\n");
      }
    });
    sock.on("error", () => {});
  });
  return { mails, server };
}

const header = (raw, name) => {
  const m = new RegExp(`^${name}: ((?:.*)(?:\\r\\n[ \\t].*)*)`, "mi").exec(raw);
  return m ? m[1].replace(/\r\n[ \t]+/g, " ") : null;
};

describe("email channel: what reaches the SMTP server (nodemailer 10)", () => {
  const smtp = fakeSmtp();
  let transport;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-smtp-"));
  const cfg = normalizeConfig({
    imap: { host: "imap.test", user: "agent@example.com" },
    smtp: { host: "127.0.0.1", port: 0, user: "agent@example.com", password: "s3cret" },
    fromName: "Tarsee",
    signature: "<p>Sent by <b>Tarsee</b></p>",
  });
  const sender = { cfg, selfAddress: "agent@example.com" };

  before(async () => {
    await new Promise((r) => smtp.server.listen(0, "127.0.0.1", r));
    cfg.smtp.port = smtp.server.address().port;
    transport = nodemailer.createTransport(smtpTransportOptions(cfg.smtp));
  });
  after(() => { transport?.close(); smtp.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it("port 465 is implicit TLS; another port is plain until STARTTLS; secure: false turns 465's TLS off", () => {
    assert.equal(smtpTransportOptions({ host: "h", port: 465 }).secure, true);
    assert.equal(smtpTransportOptions({ host: "h" }).port, 465);
    assert.equal(smtpTransportOptions({ host: "h", port: 587 }).secure, false);
    assert.equal(smtpTransportOptions({ host: "h", port: 465, secure: false }).secure, false);
    assert.deepEqual(smtpTransportOptions({ host: "h", user: "u", password: "p" }).auth, { user: "u", pass: "p" });
  });

  it("a reply-all keeps the thread, answers the sender, copies the others, and signs in", async () => {
    const incoming = {
      from: { value: [{ address: "sam@example.com", name: "Sam" }] },
      to: { value: [{ address: "agent@example.com" }, { address: "lee@example.com" }] },
      cc: { value: [{ address: "kim@example.com" }] },
      subject: "Invoice for October",
      messageId: "<orig-2@example.com>",
      references: ["<orig-1@example.com>"],
    };
    const { mail } = buildReplyMail({ incoming, bodyText: "Paid, thanks.", replyAll: true }, sender);
    await transport.sendMail(mail);
    const got = smtp.mails.at(-1);
    assert.equal(Buffer.from(got.auth.split(" ")[2], "base64").toString("utf8"), "\0agent@example.com\0s3cret");
    assert.match(got.from, /<agent@example\.com>/);
    assert.deepEqual(got.rcpt.map((r) => r.match(/<(.+)>/)[1]).sort(), ["kim@example.com", "lee@example.com", "sam@example.com"]);
    assert.equal(header(got.data, "Subject"), "Re: Invoice for October");
    assert.equal(header(got.data, "In-Reply-To"), "<orig-2@example.com>");
    assert.equal(header(got.data, "References"), "<orig-1@example.com> <orig-2@example.com>");
    assert.match(header(got.data, "From"), /"?Tarsee"? <agent@example\.com>/);
    assert.match(got.data, /Content-Type: multipart\/alternative/i, "an HTML signature makes a text and an HTML part");
    assert.match(got.data, /Paid, thanks\./);
  });

  it("a new mail in a thread carries its attachment as a real MIME part, whole", async () => {
    const file = path.join(tmp, "report.csv");
    fs.writeFileSync(file, "month,total\nOctober,1200\n");
    const { mail, attachmentCount } = buildNewMail({ to: "lee@example.com", cc: ["kim@example.com"], subject: "Report", body: "Attached.", inReplyTo: "<orig-3@example.com>", attachments: [file] }, sender);
    assert.equal(attachmentCount, 1);
    const info = await transport.sendMail(mail);
    assert.ok(info.messageId);
    const got = smtp.mails.at(-1);
    assert.equal(header(got.data, "Subject"), "Re: Report");
    assert.equal(header(got.data, "In-Reply-To"), "<orig-3@example.com>");
    assert.match(got.data, /Content-Type: multipart\/mixed/i);
    assert.match(got.data, /Content-Disposition: attachment; filename=report\.csv/i);
    const part = got.data.split(/filename=report\.csv/i)[1].split(/\r\n\r\n/)[1].split(/\r\n--/)[0].replace(/\s+/g, "");
    assert.equal(Buffer.from(part, "base64").toString("utf8"), "month,total\nOctober,1200\n");
  });

  it("a missing attachment is an error before anything is sent", () => {
    assert.throws(() => buildNewMail({ to: "lee@example.com", subject: "x", body: "y", attachments: ["/no/such/file.pdf"] }, sender), /attachment path not found/);
  });

  it("a direct message goes to each address in the list", async () => {
    await transport.sendMail(buildDirectMail("a@example.com, b@example.com", "Ping", sender));
    const got = smtp.mails.at(-1);
    assert.deepEqual(got.rcpt.map((r) => r.match(/<(.+)>/)[1]), ["a@example.com", "b@example.com"]);
    assert.equal(header(got.data, "Subject"), "Tarsee");
    assert.throws(() => buildDirectMail(" , ", "x", sender), /needs a target address/);
  });

  it("a mail with no sender address to answer gets no reply built", () => {
    const incoming = { from: { value: [] }, to: { value: [{ address: "agent@example.com" }] }, subject: "bounce", messageId: "<m@x>" };
    assert.equal(buildReplyMail({ incoming, bodyText: "x", replyAll: true }, sender), null);
  });
});
