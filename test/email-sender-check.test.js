// Who really sent a mail (src/channels/email.js senderVouched). Anyone can write any address on a From line, so the
// email channel counts a sender on the allowlist only when the owner's own mailbox provider vouches for it: the
// provider's topmost Authentication-Results line (RFC 8601), from the provider's own authserv-id, must say dmarc=pass
// with header.from equal to the From domain, or dkim=pass with that result's own header.d aligned to it, or spf=pass
// with smtp.mailfrom aligned to it. A line the sender wrote lower down never counts, and neither does a provider's
// line that doesn't read cleanly (a comment or quote left open, a ";" missing, a value that isn't one value, a word
// right after a comment, a line that reads two ways), that has two dmarc or two spf results, or whose dkim results
// disagree. That is how a result slipped into the provider's own line is kept out, through an envelope sender (MAIL
// FROM) it copies into a comment, or a HELO name it pastes unquoted.
// For a mail server Tarsee doesn't know, the owner types its name (the authserv-id) themselves, and only its topmost
// line counts, above all of the sender's part; one that writes no such line needs the owner's "my mail server doesn't
// check senders: trust the From line". Both are tied to the exact mailbox (IMAP host and user), and neither applies to
// a provider Tarsee knows. Mail refused for want of either leaves a one-time note in Settings, which never carries a
// name the mail itself wrote.
//
// The samples follow what each provider really writes (the provider's own documentation, or headers published by
// people reading them): Gmail (mx.google.com, header.i rather than header.d, header.b with "/" and "+", one dkim result
// per signature), Microsoft 365 and Outlook.com (no authserv-id at all, "action=none", a ";" at the end), iCloud (one
// line per check, each with its own name, a quoted reason), Fastmail (four lines with the MX host's name, the verdicts
// in the last), Yahoo (atlasNNN...yahoo.com, "pass(p=...)" with no space, a ";" at the end) and Zoho (mx.zohomail.com,
// header.from=<address>). Addresses, IPs and signatures are made up.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleParser } from "mailparser";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-email-sender-check-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "email-sender-check-test-only-key-0123456789";
fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });

const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { createEmailBot, parseAuthResults, senderVouched, mailProviderOf, SENDER_NOTE_KEY } = await import("../src/channels/email.js");

const db = initDb(path.join(tmp, "tarsee.db"));
const settings = new SettingsStore(db);

const logs = [];
const original = { log: console.log, warn: console.warn, error: console.error };
before(() => { for (const level of ["log", "warn", "error"]) console[level] = (...a) => logs.push(a.join(" ")); });
after(() => {
  Object.assign(console, original);
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left behind */ }
});

/** A raw message: the header lines as given (folded lines start with a space or tab), then a body. */
const raw = (headers, body = "@tarsee hello") => [...headers, "", body, ""].join("\r\n");
/** The mailbox Tarsee reads, in every sample. */
const MAILBOX = "assistant@example.com";
/** What the channel would decide for this raw mail, read from the IMAP host `imapHost` as `imapUser`. */
async function verdict(message, imapHost, senderCheck = null, imapUser = MAILBOX) {
  const mail = await simpleParser(message);
  return senderVouched(mail.headerLines, mail.from?.value?.[0]?.address, { imapHost, imapUser, senderCheck });
}
/** What the owner set for the mailbox `imapHost` (as MAILBOX) in Settings, as the route saves it. */
const setFor = (imapHost, check) => ({ imapHost, imapUser: MAILBOX, trustFromLine: false, authservId: "", ...check });

/** The sender's own part of a mail: everything the provider's servers found when it arrived. */
const fromGmail = (from = "Owner <owner@gmail.com>", extra = []) => [
  "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=gmail.com; s=20230601; t=1794240660;",
  "        h=to:subject:message-id:date:from:mime-version:from:to:cc:subject:date:message-id;",
  "        bh=ZmFrZS1ib2R5LWhhc2g=; b=ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Rz",
  ...extra,
  "MIME-Version: 1.0",
  `From: ${from}`,
  "Date: Mon, 9 Nov 2026 17:10:58 +0100",
  "Message-ID: <CAfakeMessageId0001@mail.gmail.com>",
  "Subject: hello",
  "To: assistant@example.com",
  "Content-Type: text/plain; charset=\"UTF-8\"",
];
const fromOutlook = (from = "Owner <owner@outlook.com>", extra = []) => [
  "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=outlook.com; s=selector1;",
  "        h=From:Date:Subject:Message-ID:Content-Type:MIME-Version:X-MS-Exchange-SenderADCheck;",
  "        bh=ZmFrZS1ib2R5LWhhc2g=; b=ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Rz",
  ...extra,
  "Received: from AM0PR10MB0001.EURPRD10.PROD.OUTLOOK.COM ([fe80::1]) by",
  " AM0PR10MB0001.EURPRD10.PROD.OUTLOOK.COM ([fe80::1%5]) with mapi id",
  " 15.20.8000.010; Mon, 9 Nov 2026 16:11:10 +0000",
  `From: ${from}`,
  "To: \"assistant@example.com\" <assistant@example.com>",
  "Subject: hello",
  "Date: Mon, 9 Nov 2026 16:11:10 +0000",
  "Message-ID: <AM0PR10MB0001fake@AM0PR10MB0001.EURPRD10.PROD.OUTLOOK.COM>",
  "Content-Type: text/plain; charset=\"us-ascii\"",
  "MIME-Version: 1.0",
];

// ── What each provider writes ────────────────────────────────────────────────────────────────────────────────────

/** Gmail: one line from mx.google.com, below its Received for the hop that brought the mail in. */
const gmailBox = ({ results, sender = fromOutlook(), mailfrom = "owner@outlook.com" } = {}) => raw([
  "Delivered-To: assistant@gmail.com",
  "Received: by 2002:a05:7300:5b8c:b0:12a:6b1e:2c1e with SMTP id k12csp1234567dyc;",
  "        Mon, 9 Nov 2026 08:11:12 -0800 (PST)",
  "ARC-Seal: i=1; a=rsa-sha256; t=1794240672; cv=none; d=google.com; s=arc-20240605;",
  "        b=ZmFrZS1hcmMtc2VhbA==",
  "ARC-Authentication-Results: i=1; mx.google.com;",
  "       dkim=pass header.i=@outlook.com header.s=selector1 header.b=AbCdEf12;",
  "       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=outlook.com",
  `Return-Path: <${mailfrom}>`,
  "Received: from EUR05-AM6-obe.outbound.protection.outlook.com (mail-am6eur05olkn2020.outbound.protection.outlook.com. [40.92.10.20])",
  "        by mx.google.com with ESMTPS id a640c23a62f3a-9e1234567890si1234567.123.2026.11.09.08.11.12",
  "        for <assistant@gmail.com>",
  "        (version=TLS1_2 cipher=ECDHE-ECDSA-AES128-GCM-SHA256 bits=128/128);",
  "        Mon, 09 Nov 2026 08:11:12 -0800 (PST)",
  `Received-SPF: pass (google.com: domain of ${mailfrom} designates 40.92.10.20 as permitted sender) client-ip=40.92.10.20;`,
  ...(results ?? [
    "Authentication-Results: mx.google.com;",
    "       dkim=pass header.i=@outlook.com header.s=selector1 header.b=AbCdEf12;",
    `       spf=pass (google.com: domain of ${mailfrom} designates 40.92.10.20 as permitted sender) smtp.mailfrom=${mailfrom};`,
    "       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=outlook.com",
  ]),
  ...sender,
]);

/** Microsoft 365 and Outlook.com: one line with no authserv-id, above Received-SPF and its Received. */
const microsoftBox = ({ results, sender = fromGmail() } = {}) => raw([
  "Received: from PH0PR10MB0002.namprd10.prod.outlook.com (2603:10b6:510:1::2) by",
  " SA1PR10MB0003.namprd10.prod.outlook.com with HTTPS; Mon, 9 Nov 2026 16:11:13",
  " +0000",
  "Received: from BN2PEPF000044A9.namprd04.prod.outlook.com (2603:10b6:408:fe:cafe::d) by",
  " PH0PR10MB0002.outlook.office365.com (2603:10b6:408:fe::8) with Microsoft SMTP",
  " Server (version=TLS1_3, cipher=TLS_AES_256_GCM_SHA384) id 15.20.8000.10; Mon,",
  " 9 Nov 2026 16:11:13 +0000",
  ...(results ?? [
    "Authentication-Results: spf=pass (sender IP is 209.85.128.41)",
    " smtp.mailfrom=gmail.com; dkim=pass (signature was verified)",
    " header.d=gmail.com;dmarc=pass action=none header.from=gmail.com;compauth=pass",
    " reason=100",
  ]),
  "Received-SPF: Pass (protection.outlook.com: domain of gmail.com designates",
  " 209.85.128.41 as permitted sender) receiver=protection.outlook.com;",
  " client-ip=209.85.128.41; helo=mail-wm1-f41.google.com; pr=C",
  "Received: from mail-wm1-f41.google.com (209.85.128.41) by",
  " BN2PEPF000044A9.mail.protection.outlook.com (10.167.243.103) with Microsoft",
  " SMTP Server (version=TLS1_3, cipher=TLS_AES_256_GCM_SHA384) id 15.20.8000.10",
  " via Frontend Transport; Mon, 9 Nov 2026 16:11:12 +0000",
  ...sender,
]);

/** iCloud: one line per check (bimi, arc, dmarc, dkim, spf), each with its own name, above its Received. */
const icloudBox = ({ results, sender = fromGmail() } = {}) => raw([
  "Received: from p00-icloudmta-asmtp-us-west-2a-60-percent-3 by p00-icloudmta-asmtp-us-west-2a-60-percent-3",
  "  (iCloud MTA) with LMTP; Mon, 9 Nov 2026 16:11:13 +0000 (UTC)",
  ...(results ?? [
    "Authentication-Results: bimi.icloud.com; bimi=skipped reason=\"insufficient dmarc\"",
    "X-ARC-Info: policy=fail; arc=none",
    "Authentication-Results: arc.icloud.com; arc=none",
    "Authentication-Results: dmarc.icloud.com; dmarc=pass header.from=gmail.com",
    "Authentication-Results: dkim-verifier.icloud.com;",
    "\tdkim=pass (2048-bit key) header.d=gmail.com header.i=@gmail.com header.b=AbCdEf12",
    "Authentication-Results: spf.icloud.com; spf=pass (spf.icloud.com: domain of owner@gmail.com designates 209.85.128.41 as permitted sender) smtp.mailfrom=owner@gmail.com",
  ]),
  "Received-SPF: pass (spf.icloud.com: domain of owner@gmail.com designates 209.85.128.41 as permitted sender) receiver=spf.icloud.com; client-ip=209.85.128.41; helo=mail-wm1-f41.google.com; envelope-from=owner@gmail.com",
  "Received: from mail-wm1-f41.google.com (mail-wm1-f41.google.com [209.85.128.41])",
  "\tby p00-icloudmta-asmtp-us-west-2a-60-percent-3 (iCloud MTA) with ESMTPS id 0123456789ABCDEF",
  "\tfor <assistant@icloud.com>; Mon, 9 Nov 2026 16:11:12 +0000 (UTC)",
  ...sender,
]);

/** Fastmail: four lines with the receiving MX host's name; the DKIM, DMARC and SPF verdicts are in the last. */
const fastmailBox = ({ results, sender = fromGmail(), mx = "stl-mx-04" } = {}) => raw([
  "Return-Path: <owner@gmail.com>",
  "Received: from compute1.internal (compute1.nyi.internal [10.202.2.41])",
  "\t by sloti12345 (Cyrus 3.13.0) with LMTPA;",
  "\t Mon, 09 Nov 2026 11:11:13 -0500",
  "X-Delivered-to: assistant@fastmail.com",
  `Received: from ${mx} ([10.202.2.163])`,
  "  by compute1.internal (LMTPProxy); Mon, 09 Nov 2026 11:11:13 -0500",
  ...(results ?? [
    `Authentication-Results: ${mx}.messagingengine.com;`,
    "    x-csa=none;",
    "    x-me-sender=none;",
    "    x-ptr=pass smtp.helo=mail-wm1-f41.google.com policy.ptr=mail-wm1-f41.google.com",
    `Authentication-Results: ${mx}.messagingengine.com;`,
    "    bimi=skipped (DMARC Policy is not at enforcement)",
    `Authentication-Results: ${mx}.messagingengine.com;`,
    "    arc=none (no signatures found)",
    `Authentication-Results: ${mx}.messagingengine.com;`,
    "    dkim=pass (2048-bit rsa key sha256) header.d=gmail.com header.i=@gmail.com header.b=AbCdEf12 header.a=rsa-sha256 header.s=20230601 x-bits=2048;",
    "    dmarc=pass policy.published-domain-policy=none policy.published-subdomain-policy=quarantine policy.applied-disposition=none policy.evaluated-disposition=none (p=none,sp=quarantine,d=none,d.eval=none) policy.policy-from=p header.from=gmail.com;",
    "    iprev=pass smtp.remote-ip=209.85.128.41 (mail-wm1-f41.google.com);",
    "    spf=pass smtp.mailfrom=owner@gmail.com smtp.helo=mail-wm1-f41.google.com",
  ]),
  "Received-SPF: pass",
  "    (gmail.com: 209.85.128.41 is authorized to use 'owner@gmail.com' in 'mfrom' identity (mechanism 'ip4:209.85.128.0/17' matched))",
  `    receiver=${mx}.messagingengine.com;`,
  "    identity=mailfrom;",
  "    envelope-from=\"owner@gmail.com\";",
  "    helo=mail-wm1-f41.google.com;",
  "    client-ip=209.85.128.41",
  "Received: from mail-wm1-f41.google.com (mail-wm1-f41.google.com [209.85.128.41])",
  "\t(using TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 (256/256 bits))",
  "\t(No client certificate requested)",
  `\tby ${mx}.messagingengine.com (Postfix) with ESMTPS`,
  "\tfor <assistant@fastmail.com>; Mon,  9 Nov 2026 11:11:13 -0500 (EST)",
  ...sender,
]);

/** Yahoo (and AOL): one line from an atlas host, with "dmarc=pass(p=...)" written without a space. */
const yahooBox = ({ results, sender = fromGmail() } = {}) => raw([
  "X-Apparently-To: assistant@yahoo.com; Mon, 9 Nov 2026 16:11:13 +0000",
  "Return-Path: <owner@gmail.com>",
  "Received-SPF: pass (domain of gmail.com designates 209.85.128.41 as permitted sender)",
  "X-YMailISG: ZmFrZS15bWFpbC1pc2c-",
  "X-Originating-IP: [209.85.128.41]",
  ...(results ?? [
    "Authentication-Results: atlas321.free.mail.ne1.yahoo.com;",
    " dkim=pass header.i=@gmail.com header.s=20230601;",
    " spf=pass smtp.mailfrom=gmail.com;",
    " dmarc=pass(p=NONE,sp=QUARANTINE) header.from=gmail.com;",
  ]),
  "Received: from 209.85.128.41 (EHLO mail-wm1-f41.google.com) (209.85.128.41)",
  "  by 10.217.135.83 with SMTPs (version=TLS1_3 cipher=TLS_AES_128_GCM_SHA256);",
  "  Mon, 09 Nov 2026 16:11:13 +0000",
  ...sender,
]);

/** Zoho: one line from mx.zohomail.com, with header.i=<domain> and header.from=<address>. */
const zohoBox = ({ results, sender = fromOutlook() } = {}) => raw([
  "Delivered-To: assistant@zohomail.com",
  "ARC-Seal: i=1; a=rsa-sha256; t=1794240672; cv=none; d=zohomail.com; s=zohoarc; b=ZmFrZS1hcmMtc2VhbA==",
  "ARC-Authentication-Results: i=1; mx.zohomail.com;",
  "\tdkim=pass  header.i=outlook.com;",
  "\tdmarc=pass header.from=<owner@outlook.com>",
  ...(results ?? [
    "Authentication-Results: mx.zohomail.com;",
    "\tdkim=pass  header.i=outlook.com;",
    "\tspf=pass (zohomail.com: domain of outlook.com designates 40.92.10.20 as permitted sender)  smtp.mailfrom=owner@outlook.com;",
    "\tdmarc=pass header.from=<owner@outlook.com>",
  ]),
  "Received: from EUR05-AM6-obe.outbound.protection.outlook.com (mail-am6eur05olkn2020.outbound.protection.outlook.com [40.92.10.20]) by mx.zohomail.com",
  "\twith SMTPS id 1794240672123456.789; Mon, 9 Nov 2026 08:11:12 -0800 (PST)",
  ...sender,
]);

describe("the owner's ordinary mail is vouched for by the provider of the mailbox Tarsee reads", () => {
  it("Gmail: mail from Outlook.com (DMARC passes, DKIM given as header.i)", async () => {
    assert.deepEqual(await verdict(gmailBox(), "imap.gmail.com"), { ok: true, by: "dmarc", provider: "Gmail" });
  });

  it("Microsoft 365 and Outlook.com: mail from Gmail, with Microsoft's line that names no authserv-id", async () => {
    for (const host of ["outlook.office365.com", "Outlook.Office365.com", "imap-mail.outlook.com"]) {
      assert.deepEqual(await verdict(microsoftBox(), host), { ok: true, by: "dmarc", provider: "Microsoft 365" }, host);
    }
  });

  it("iCloud: one line per check, each with its own name", async () => {
    assert.deepEqual(await verdict(icloudBox(), "imap.mail.me.com"), { ok: true, by: "dmarc", provider: "iCloud" });
  });

  it("Fastmail: the verdicts are in the fourth line, whichever MX host took the mail", async () => {
    assert.deepEqual(await verdict(fastmailBox(), "imap.fastmail.com"), { ok: true, by: "dmarc", provider: "Fastmail" });
    assert.equal((await verdict(fastmailBox({ mx: "stl-mx-02" }), "imap.fastmail.com")).ok, true);
  });

  it("Yahoo: dmarc=pass(p=...) written without a space", async () => {
    assert.deepEqual(await verdict(yahooBox(), "imap.mail.yahoo.com"), { ok: true, by: "dmarc", provider: "Yahoo" });
  });

  it("Zoho: header.from=<address>; an older line of theirs with a ';' left out doesn't read cleanly, so it doesn't count", async () => {
    assert.deepEqual(await verdict(zohoBox(), "imap.zoho.com"), { ok: true, by: "dmarc", provider: "Zoho" });
    const older = zohoBox({
      sender: fromGmail(),
      results: ["Authentication-Results: mx.zoho.com;", "\tdkim=pass", "\tspf=pass (zoho.com: domain of _spf.google.com designates 209.85.192.169 as permitted sender)", "\tsmtp.mailfrom=owner@gmail.com;"],
    });
    const v = await verdict(older, "imap.zoho.com");
    assert.deepEqual([v.ok, v.why, v.provider], [false, "failed", "Zoho"]);
    assert.match(v.detail, /doesn't read cleanly/);
    assert.match(v.detail, /";" is missing before spf=/);
  });

  it("more of what they really write: Gmail's header.b with / and +, a dkim result per signature, Microsoft's action= and a closing ';'", async () => {
    // Mail from Fastmail, which signs twice (its own domain and messagingengine.com), read at Gmail.
    const fromFastmail = fromGmail("Owner <owner@fastmail.com>").map((l) => l.replace("d=gmail.com", "d=fastmail.com"));
    const twoSignatures = gmailBox({
      sender: fromFastmail,
      mailfrom: "owner@fastmail.com",
      results: [
        "Authentication-Results: mx.google.com;",
        "       dkim=pass header.i=@fastmail.com header.s=fm1 header.b=k/4bX3+d;",
        "       dkim=pass header.i=@messagingengine.com header.s=fm1 header.b=Q+7z/Ab1;",
        "       spf=pass (google.com: domain of owner@fastmail.com designates 103.168.172.150 as permitted sender) smtp.mailfrom=owner@fastmail.com;",
        "       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=fastmail.com",
      ],
    });
    assert.deepEqual(await verdict(twoSignatures, "imap.gmail.com"), { ok: true, by: "dmarc", provider: "Gmail" });
    // A domain with no DMARC record, read at Microsoft: dmarc=none, no signature, an aligned SPF pass.
    const noPolicy = microsoftBox({
      sender: fromGmail("Owner <owner@self.example>"),
      results: [
        "Authentication-Results: spf=pass (sender IP is 192.0.2.10)",
        " smtp.mailfrom=self.example; dkim=none (message not signed)",
        " header.d=none;dmarc=none action=none header.from=self.example;",
      ],
    });
    assert.deepEqual(await verdict(noPolicy, "outlook.office365.com"), { ok: true, by: "spf", provider: "Microsoft 365" });
  });

  it("the owner's ordinary mail from Gmail and from Outlook.com passes at every provider", async () => {
    const boxes = { "imap.gmail.com": gmailBox, "outlook.office365.com": microsoftBox, "imap.mail.me.com": icloudBox, "imap.fastmail.com": fastmailBox, "imap.mail.yahoo.com": yahooBox, "imap.zoho.com": zohoBox };
    for (const [host, box] of Object.entries(boxes)) {
      const sample = box();
      // The same mail from the other of the two: the sender's domain swapped throughout (lower case only, so host
      // names in upper case stay as they are).
      const [one, other] = sample.includes("From: Owner <owner@gmail.com>") ? ["gmail.com", "outlook.com"] : ["outlook.com", "gmail.com"];
      for (const message of [sample, sample.split(one).join(other)]) {
        const v = await verdict(message, host);
        assert.equal(v.ok, true, `${host}: ${JSON.stringify(v)}`);
      }
    }
  });

  it("fuller lines, with all else each provider writes in them (IPv6 addresses, bit counts, ARC, Fastmail's x- checks), still vouch", async () => {
    const ipv6 = "2a00:1450:4864:20::335";
    const fuller = {
      "imap.gmail.com": gmailBox({ results: [
        "Authentication-Results: mx.google.com;",
        "       dkim=pass header.i=@outlook.com header.s=selector1 header.b=Qx7/k+2A;",
        "       arc=pass (i=1 spf=pass spfdomain=outlook.com dkim=pass dkdomain=outlook.com dmarc=pass fromdomain=outlook.com);",
        "       spf=pass (google.com: domain of owner@outlook.com designates 2a01:111:f403:2c14::801 as permitted sender) smtp.mailfrom=owner@outlook.com;",
        "       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=outlook.com;",
        "       dara=pass header.i=@gmail.com",
      ] }),
      "outlook.office365.com": microsoftBox({ results: [
        `Authentication-Results: spf=pass (sender IP is ${ipv6})`,
        " smtp.mailfrom=gmail.com; dkim=pass (signature was verified)",
        " header.d=gmail.com;dmarc=pass action=none header.from=gmail.com;compauth=pass",
        " reason=100",
      ] }),
      "imap-mail.outlook.com": microsoftBox({ results: [
        `Authentication-Results: spf=pass (sender IP is ${ipv6}) smtp.mailfrom=gmail.com; dkim=pass (signature was verified) header.d=gmail.com;dmarc=pass action=none header.from=gmail.com;compauth=pass reason=100`,
      ] }),
      "imap.mail.me.com": icloudBox({ results: [
        "Authentication-Results: bimi.icloud.com; bimi=skipped reason=\"insufficient dmarc\"",
        "Authentication-Results: arc.icloud.com; arc=none",
        "Authentication-Results: dmarc.icloud.com; dmarc=pass header.from=gmail.com",
        "Authentication-Results: dkim-verifier.icloud.com;",
        "\tdkim=pass (2048-bit key) header.d=gmail.com header.i=@gmail.com header.b=k/4bX3+d",
        `Authentication-Results: spf.icloud.com; spf=pass (spf.icloud.com: domain of owner@gmail.com designates ${ipv6} as permitted sender) smtp.mailfrom=owner@gmail.com`,
      ] }),
      // Fastmail's older form: every check in one line, x-return-mx once for the From domain and once for MAIL FROM's.
      "imap.fastmail.com": fastmailBox({ results: [
        "Authentication-Results: stl-mx-04.messagingengine.com;",
        "    dkim=pass (2048-bit rsa key sha256) header.d=gmail.com header.i=@gmail.com header.b=k/4bX3+d header.a=rsa-sha256 header.s=20230601 x-bits=2048;",
        "    dmarc=pass policy.published-domain-policy=none policy.published-subdomain-policy=quarantine policy.applied-disposition=none policy.evaluated-disposition=none (p=none,sp=quarantine,d=none,d.eval=none) policy.policy-from=p header.from=gmail.com;",
        `    iprev=pass smtp.remote-ip=${ipv6} (mail-wm1-x335.google.com);`,
        "    spf=pass smtp.mailfrom=owner@gmail.com smtp.helo=mail-wm1-x335.google.com;",
        "    x-aligned-from=pass (Address match);",
        "    x-me-sender=none;",
        "    x-ptr=pass smtp.helo=mail-wm1-x335.google.com policy.ptr=mail-wm1-x335.google.com;",
        "    x-return-mx=pass header.domain=gmail.com policy.is_org=yes (MX Records found: gmail-smtp-in.l.google.com,alt1.gmail-smtp-in.l.google.com);",
        "    x-return-mx=pass smtp.domain=gmail.com policy.is_org=yes (MX Records found: gmail-smtp-in.l.google.com,alt1.gmail-smtp-in.l.google.com);",
        "    x-tls=pass smtp.version=TLSv1.3 smtp.cipher=TLS_AES_256_GCM_SHA384 smtp.bits=256/256;",
        "    x-vs=clean score=-100 state=0",
      ] }),
      "imap.mail.yahoo.com": yahooBox({ results: [
        "Authentication-Results: atlas-production.v2.mail.ne1.yahoo.com;",
        " dkim=pass header.i=@gmail.com header.s=20230601;",
        " spf=pass smtp.mailfrom=gmail.com;",
        " dmarc=pass(p=NONE,sp=QUARANTINE) header.from=gmail.com;",
      ] }),
      "imap.zoho.com": zohoBox({ results: [
        "Authentication-Results: mx.zohomail.com;",
        "\tdkim=pass  header.i=outlook.com;",
        "\tspf=pass (zohomail.com: domain of outlook.com designates 2a01:111:f403:2c14::801 as permitted sender)  smtp.mailfrom=owner@outlook.com;",
        "\tdmarc=pass(p=none dis=none)  header.from=<owner@outlook.com>",
      ] }),
    };
    for (const [host, mail] of Object.entries(fuller)) {
      const v = await verdict(mail, host);
      assert.deepEqual([v.ok, v.by], [true, "dmarc"], `${host}: ${JSON.stringify(v)}`);
    }
  });

  it("with no DMARC verdict, a DKIM pass counts only with its own header.d aligned, an SPF pass only with smtp.mailfrom aligned", async () => {
    const only = (...lines) => gmailBox({ results: ["Authentication-Results: mx.google.com;", ...lines] });
    assert.deepEqual(await verdict(only("       dkim=pass header.d=outlook.com header.i=@outlook.com header.s=selector1"), "imap.gmail.com"), { ok: true, by: "dkim", provider: "Gmail" });
    assert.deepEqual(await verdict(only("       dkim=pass header.d=mail.outlook.com"), "imap.gmail.com"), { ok: true, by: "dkim", provider: "Gmail" }, "a subdomain is aligned");
    assert.deepEqual(await verdict(only("       spf=pass smtp.mailfrom=owner@outlook.com"), "imap.gmail.com"), { ok: true, by: "spf", provider: "Gmail" });
    // One signature by the sender's service and one by the From domain: the aligned one counts, whichever comes first.
    assert.deepEqual(await verdict(only("       dkim=pass header.d=esp.example; dkim=pass header.d=outlook.com"), "imap.gmail.com"), { ok: true, by: "dkim", provider: "Gmail" });
    for (const line of [
      "       dkim=pass header.i=@outlook.com header.s=selector1", // header.i alone: no header.d
      "       dkim=pass header.i=@evil.example header.s=s1",
      "       dkim=pass header.d=evil.example header.i=@outlook.com", // header.i can't stand in for an unaligned header.d
      "       spf=pass smtp.mailfrom=bounce@evil.example",
      "       dkim=pass header.d=com",
      "       dkim=fail header.d=outlook.com; dkim=pass header.d=evil.example",
      "       dkim=fail header.i=@outlook.com; spf=softfail smtp.mailfrom=owner@outlook.com",
      "       dmarc=bestguesspass header.from=outlook.com",
    ]) {
      const v = await verdict(only(line), "imap.gmail.com");
      assert.equal(v.ok, false, line);
      assert.equal(v.why, "failed", line);
    }
  });

  it("a DMARC pass counts only for the From line's own domain: one for another domain refuses the mail", async () => {
    const only = (...lines) => gmailBox({ results: ["Authentication-Results: mx.google.com;", ...lines] });
    for (const line of [
      "       dkim=pass header.d=outlook.com; dmarc=pass header.from=mail.outlook.com",
      "       dkim=pass header.d=outlook.com; dmarc=pass header.from=evil.example",
    ]) {
      const v = await verdict(only(line), "imap.gmail.com");
      assert.deepEqual([v.ok, v.why], [false, "failed"], line);
      assert.match(v.detail, /DMARC result is for .* not the From line's outlook\.com/, line);
    }
  });

  it("knows the providers by the IMAP host Tarsee reads, and nothing else", () => {
    const names = Object.fromEntries([
      "imap.gmail.com", "imap.googlemail.com", "outlook.office365.com", "imap.mail.me.com", "imap.fastmail.com",
      "imap.mail.yahoo.com", "imap.aol.com", "imap.zoho.com", "imappro.zoho.eu", "mail.self.example", "imap.gmail.com.evil.example",
    ].map((h) => [h, mailProviderOf(h)?.name ?? null]));
    assert.deepEqual(names, {
      "imap.gmail.com": "Gmail", "imap.googlemail.com": "Gmail", "outlook.office365.com": "Microsoft 365", "imap.mail.me.com": "iCloud",
      "imap.fastmail.com": "Fastmail", "imap.mail.yahoo.com": "Yahoo", "imap.aol.com": "Yahoo", "imap.zoho.com": "Zoho",
      "imappro.zoho.eu": "Zoho", "mail.self.example": null, "imap.gmail.com.evil.example": null,
    });
  });
});

// ── Reading a line strictly ──────────────────────────────────────────────────────────────────────────────────────

describe("an Authentication-Results line is read strictly, as RFC 8601 writes it", () => {
  it("reads an authserv-id and version, nested and escaped comments, quoted strings, space around '=', a method version", () => {
    assert.deepEqual(parseAuthResults(" mx.microsoft.com 1; spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=example.com"), {
      authservId: "mx.microsoft.com",
      results: [{ method: "spf", result: "pass", props: { "smtp.mailfrom": "example.com" } }],
      problem: null,
    });
    assert.equal(parseAuthResults(" spf=pass smtp.mailfrom=example.com; dkim=none").authservId, "", "Microsoft's line names none");
    assert.deepEqual(parseAuthResults(" mx.example.com; none"), { authservId: "mx.example.com", results: [], problem: null });
    const nested = parseAuthResults(' mx.example.com; dkim=pass (good (very \\) good) key) header.d=example.com reason="a \\"b\\" c"; dmarc = pass header.from = example.com;');
    assert.equal(nested.problem, null);
    assert.deepEqual(nested.results, [
      { method: "dkim", result: "pass", props: { "header.d": "example.com" } },
      { method: "dmarc", result: "pass", props: { "header.from": "example.com" } },
    ]);
    assert.equal(parseAuthResults(" mx.example.com; dkim/1=pass header.d=example.com").results[0].method, "dkim");
    // Envelope senders with "=" in them (SRS, VERP), and addresses in any script, are plain addresses.
    assert.equal(parseAuthResults(" mx.example.com; spf=pass smtp.mailfrom=SRS0=abcd=xy=example.com=user@forwarder.example").problem, null);
    assert.equal(parseAuthResults(" mx.example.com; dmarc=pass header.from=ejemplo.españa.example; spf=pass smtp.mailfrom=josé@ejemplo.españa.example").problem, null);
    // A comment can't hide a result, and one inside another is still a comment.
    assert.deepEqual(parseAuthResults(" mx.example.com; spf=fail (no (dmarc=pass header.from=x.example)) smtp.mailfrom=e.example").results.map((r) => r.method), ["spf"]);
  });

  it("a line that doesn't read cleanly says why, and holds nothing Tarsee would read", () => {
    for (const [line, why] of [
      [" mx.example.com; dmarc=pass (left open header.from=example.com", /a comment is never closed/],
      [' mx.example.com; spf=pass smtp.mailfrom="a@example.com', /a quoted string is never closed/],
      [" mx.example.com; spf=pass) smtp.mailfrom=example.com", /a "\)" closes no comment/],
      [" mx.example.com; spf=pass \\ smtp.mailfrom=example.com", /a "\\" outside a quoted string or comment/],
      [" mx.example.com; dkim=pass spf=pass smtp.mailfrom=example.com", /a ";" is missing before spf=/],
      [" mx.example.com; dkim=pass;; dmarc=pass header.from=example.com", /two ";" with nothing between/],
      [" mx.example.com dmarc=pass header.from=example.com", /the server's name isn't followed by ";"/],
      [" mx.example.com; pass", /"pass" isn't method=result/],
      [' mx.example.com; "dmarc"=pass header.from=example.com', /isn't method=result/],
      [" mx.example.com; dmarc=pass header.from", /"header.from" has no value/],
      [" mx.example.com; dmarc=pass header.from=", /"header.from" has no value/],
      [" mx.example.com; dmarc=pass header.from=a.example header.from=b.example", /header\.from is given twice/],
      [" mx.example.com; spf=pass smtp.mailfrom=a@[x:y]", /smtp\.mailfrom isn't a plain address or domain/],
      [' mx.example.com; spf=pass smtp.mailfrom="a;dmarc=pass header.from=victim.example"@evil.example', /smtp\.mailfrom isn't a plain address or domain/],
      // Strictly, the comment ends at "a)" and the line still reads cleanly; as pasted, it ends at "here)".
      [' mx.example.com; spf=pass (domain of "a) x=" designates "b (" here) smtp.mailfrom=evil.example', /reads two ways/],
      // With no space after "a)", a word starts right after the comment: that alone doesn't read cleanly.
      [' mx.example.com; spf=pass (domain of "a)x=" designates "b(" here) smtp.mailfrom=evil.example', /a word right after a comment/],
    ]) {
      const parsed = parseAuthResults(line);
      assert.match(String(parsed.problem), why, line);
      assert.deepEqual(parsed.results, [], line);
    }
  });

  it("every value in a result is one value, whatever it is for: a word, a quoted string, or an address or domain", () => {
    // What real lines hold in values Tarsee doesn't read: base64 with "/" and "+", IPv6 addresses, bit counts.
    const clean = parseAuthResults(" mx.example.com; dkim=pass header.d=example.com header.b=k/4bX3+d header.a=rsa-sha256 x-bits=2048;"
      + " iprev=pass smtp.remote-ip=2001:db8::1 policy.iprev=192.0.2.1; x-tls=pass smtp.version=TLSv1.3 smtp.cipher=TLS_AES_256_GCM_SHA384 smtp.bits=256/256;"
      + ' x-vs=clean score=-100 state=0; bimi=skipped reason="insufficient dmarc; or [none]"; dmarc=none action=none policy.note="a [quoted] (value)" header.from=example.com');
    assert.equal(clean.problem, null);
    assert.equal(clean.results.length, 6);
    // A line folded with a tab, or with spaces, at any point between words.
    const folded = parseAuthResults("\tmx.example.com;\r\n\tdkim=pass\r\n\t header.d=example.com;\n\tdmarc=pass\r\n    header.from=example.com");
    assert.deepEqual([folded.problem, folded.authservId, folded.results.map((r) => r.method)], [null, "mx.example.com", ["dkim", "dmarc"]]);
    for (const [line, why] of [
      // A piece of a sender's address literal, cut where it held ";" or "()".
      [" mx.example.com; spf=none smtp.helo=[x:", /smtp\.helo isn't one value/],
      [" mx.example.com; x=y z.z=]", /z\.z isn't one value/],
      // Strictly, an address literal isn't a value either: RFC 8601 would have it quoted.
      [" mx.example.com; spf=none smtp.helo=[192.0.2.1]", /smtp\.helo isn't one value/],
      [" mx.example.com; dkim=pass reason=a[b header.d=example.com", /reason isn't one value/],
      [" mx.example.com; dmarc=none action=<x header.from=example.com", /action isn't one value/],
      [" mx.example.com; spf=none policy.x=a,b", /policy\.x isn't one value/],
      [" mx.example.com; spf=none policy.x=a@b@c", /policy\.x isn't one value/],
      [' mx.example.com; spf=none policy.x="a"b', /policy\.x isn't one value/],
      [' mx.example.com; spf=pass smtp.mailfrom=owner@"example".com', /smtp\.mailfrom isn't a plain address or domain/],
      // Words are parted by a space, or where the line is folded, not by a tab in the middle of a line, a space of
      // another script, or a comment alone.
      [" mx.example.com; dkim=pass\theader.d=example.com", /isn't method=result/],
      [" mx.example.com; dkim=pass header.d=example.com", /isn't method=result/],
      [" mx.example.com; dkim=pass header.d=example.com", /isn't method=result/],
      [" mx.example.com; dkim=pass()header.d=example.com", /a word right after a comment/],
      [" mx.example.com; dkim=pass (ok)header.d=example.com", /a word right after a comment/],
      [' mx.example.com; dkim=pass (ok)"x" header.d=example.com', /a word right after a comment/],
      [" mx.example.com; dkim=pass (a)(b)header.d=example.com", /a word right after a comment/],
    ]) {
      const parsed = parseAuthResults(line);
      assert.match(String(parsed.problem), why, line);
      assert.deepEqual(parsed.results, [], line);
    }
  });

  it("a provider's line with two results for one check, or results that disagree, doesn't count", async () => {
    const only = (...lines) => gmailBox({ results: ["Authentication-Results: mx.google.com;", ...lines] });
    for (const [line, why] of [
      ["       dmarc=pass header.from=outlook.com; dmarc=fail header.from=outlook.com", /more than one dmarc result/],
      ["       dmarc=fail header.from=outlook.com; dmarc=pass header.from=outlook.com", /more than one dmarc result/],
      ["       spf=pass smtp.mailfrom=owner@outlook.com; spf=fail smtp.mailfrom=owner@outlook.com", /more than one spf result/],
      ["       dkim=pass header.d=outlook.com header.s=s1; dkim=fail header.d=outlook.com header.s=s1", /dkim results for outlook\.com disagree/],
    ]) {
      const v = await verdict(only(line), "imap.gmail.com");
      assert.deepEqual([v.ok, v.why], [false, "failed"], line);
      assert.match(v.detail, why, line);
    }
    // iCloud and Fastmail write several lines: a check given twice across them doesn't count either.
    const twice = icloudBox({ results: [
      "Authentication-Results: dmarc.icloud.com; dmarc=pass header.from=gmail.com",
      "Authentication-Results: dmarc.icloud.com; dmarc=fail header.from=gmail.com",
    ] });
    const v = await verdict(twice, "imap.mail.me.com");
    assert.equal(v.ok, false);
    assert.match(v.detail, /more than one dmarc result/);
  });
});

describe("one result slipped into the provider's own line doesn't win", () => {
  // Gmail, iCloud and Zoho copy the envelope sender (MAIL FROM, the sender's to choose) into their spf comment and
  // value. An unescaped ")" in a quoted local part ends the comment early on a strict reading, so what follows reads
  // as a result of the provider's own.
  /** Gmail's line on a mail sent with the envelope sender `mailfrom`, with Gmail's own DMARC verdict, if any. */
  const gmailOn = (mailfrom, from, dmarc) => gmailBox({
    mailfrom,
    sender: forgedFrom(from),
    results: [
      "Authentication-Results: mx.google.com;",
      "       dkim=pass header.i=@evil.example header.s=s1 header.b=ZmFrZQ;",
      `       spf=pass (google.com: domain of ${mailfrom} designates 192.0.2.66 as permitted sender) smtp.mailfrom=${mailfrom}${dmarc ? ";" : ""}`,
      ...(dmarc ? [`       ${dmarc}`] : []),
    ],
  });

  it("the reviewer's MAIL FROM: a dmarc=pass, or a dkim=pass, slipped in ahead of Gmail's own dmarc=fail", async () => {
    const realFail = "dmarc=fail (p=NONE sp=QUARANTINE dis=NONE) header.from=gmail.com";
    for (const mailfrom of [
      '"a)dmarc=pass header.from=gmail.com;("@evil.example',
      '"a)dkim=pass header.d=gmail.com;("@evil.example',
    ]) {
      const v = await verdict(gmailOn(mailfrom, "owner@gmail.com", realFail), "imap.gmail.com");
      assert.deepEqual([v.ok, v.why, v.provider], [false, "failed", "Gmail"], mailfrom);
      assert.match(v.detail, /doesn't read cleanly/, mailfrom);
    }
  });

  it("nor where the From domain has no DMARC record, so Gmail writes no dmarc result to stop it", async () => {
    const from = "owner@nopolicy.example";
    // Without anything slipped in, Gmail's line is for the forger's own domain only: refused.
    assert.equal((await verdict(gmailOn("bounce@evil.example", from), "imap.gmail.com")).ok, false);
    for (const mailfrom of [
      '"a);dkim=pass header.d=nopolicy.example;("@evil.example',
      // Reads cleanly the strict way: the slipped-in result stands alone and smtp.mailfrom lands on a made-up one.
      '"a);dkim=pass header.d=nopolicy.example;x-note=1 ("@evil.example',
      // An address literal in place of the domain (dcontent may hold ";" and "=").
      "a@[x:;dkim=pass header.d=nopolicy.example x=]",
    ]) {
      const v = await verdict(gmailOn(mailfrom, from), "imap.gmail.com");
      assert.deepEqual([v.ok, v.why], [false, "failed"], mailfrom);
      assert.match(v.detail, /doesn't read cleanly/, mailfrom);
    }
  });

  it("the reviewer's HELO: an address literal holding \";\" and \"()\", pasted unquoted into smtp.helo at Gmail, Fastmail or Microsoft", async () => {
    // The sender chooses the name it introduces itself by (HELO). A general address literal (RFC 5321) may hold ";",
    // "=", "(" and ")" but no space, so "()" stands in for one. Pasted unquoted, it splits into "smtp.helo=[x:", a
    // dkim=pass for the From domain, and "z.z=]": the pieces with "[" and "]" aren't values, so the line vouches for
    // nothing. The From domain has no DMARC record, so the provider writes no dmarc result that would stop it.
    const from = "owner@nopolicy.example";
    const lines = (helo) => ({
      "imap.gmail.com": gmailBox({ mailfrom: "", sender: forgedFrom(from), results: [
        "Authentication-Results: mx.google.com;",
        "       dkim=pass header.i=@evil.example header.s=s1 header.b=ZmFrZQ;",
        `       spf=none (google.com: postmaster@${helo} does not designate permitted sender hosts) smtp.helo=${helo}`,
      ] }),
      "imap.fastmail.com": fastmailBox({ sender: forgedFrom(from), results: [
        "Authentication-Results: stl-mx-04.messagingengine.com;",
        "    dkim=pass (2048-bit rsa key sha256) header.d=evil.example header.i=@evil.example header.s=s1;",
        "    dmarc=none policy.published-domain-policy=none header.from=nopolicy.example;",
        `    spf=none smtp.mailfrom=bounce@evil.example smtp.helo=${helo}`,
      ] }),
      "outlook.office365.com": microsoftBox({ sender: forgedFrom(from), results: [
        `Authentication-Results: spf=none (sender IP is 192.0.2.66) smtp.helo=${helo}; dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=nopolicy.example;compauth=fail reason=001`,
      ] }),
    });
    for (const [host, mail] of Object.entries(lines("mail.evil.example"))) {
      const v = await verdict(mail, host);
      assert.deepEqual([v.ok, v.why], [false, "failed"], `${host}, with an ordinary HELO: nothing aligned passes`);
    }
    // A HELO name has no space in it. To part dkim=pass from header.d it needs a comment, a space of another script,
    // or a cut-off piece: each makes the line read uncleanly. With no brackets at all, it is no domain either.
    for (const helo of [
      "[x:;dkim=pass()header.d=nopolicy.example;x=y()z.z=]",
      "a.example;dkim=pass()header.d=nopolicy.example",
      "a.example;dkim=pass(x)header.d=nopolicy.example;x=y",
      "a.example;dkim=pass header.d=nopolicy.example",
      "a.example;dkim=pass header.d=nopolicy.example",
      "a.example;dkim=pass\fheader.d=nopolicy.example",
      "a.example;dkim=pass\vheader.d=nopolicy.example",
      "a.example;dkim=pass\theader.d=nopolicy.example",
    ]) {
      for (const [host, mail] of Object.entries(lines(helo))) {
        // As UTF-8, and as the one byte 0xA0 for a no-break space (mailparser reads header bytes one to a character).
        for (const message of helo.includes(" ") ? [mail, Buffer.from(mail, "latin1")] : [mail]) {
          const v = await verdict(message, host);
          assert.deepEqual([v.ok, v.why, v.provider], [false, "failed", mailProviderOf(host).name], `${host} ${JSON.stringify(helo)}: ${JSON.stringify(v)}`);
          assert.match(v.detail, /doesn't read cleanly/, host);
        }
      }
    }
  });

  it("the same slip into iCloud's and Zoho's spf lines", async () => {
    const mailfrom = '"a);dkim=pass header.d=gmail.com;x-note=1 ("@evil.example';
    const icloud = icloudBox({ sender: forgedFrom("owner@gmail.com"), results: [
      "Authentication-Results: dmarc.icloud.com; dmarc=none header.from=gmail.com",
      `Authentication-Results: spf.icloud.com; spf=pass (spf.icloud.com: domain of ${mailfrom} designates 192.0.2.66 as permitted sender) smtp.mailfrom=${mailfrom}`,
    ] });
    assert.equal((await verdict(icloud, "imap.mail.me.com")).ok, false);
    const zoho = zohoBox({ sender: forgedFrom("owner@outlook.com"), results: [
      "Authentication-Results: mx.zohomail.com;",
      `\tspf=pass (zohomail.com: domain of ${mailfrom} designates 192.0.2.66 as permitted sender)  smtp.mailfrom=${mailfrom}`,
    ] });
    assert.equal((await verdict(zoho, "imap.zoho.com")).ok, false);
  });
});

// ── Forged lines ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What a sender running their own mail server can add to their part of a mail. */
const FORGED_GMAIL = ["Authentication-Results: mx.google.com; dkim=pass header.d=outlook.com header.i=@outlook.com; spf=pass smtp.mailfrom=owner@outlook.com; dmarc=pass header.from=outlook.com"];
/** A sender's own server, which signs with its own domain. */
const fromForger = (forged = []) => [
  ...forged,
  "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=evil.example; s=s1; bh=ZmFrZQ==; b=ZmFrZQ==",
  "Received: from [192.0.2.66] by mail.evil.example; Mon, 9 Nov 2026 16:11:00 +0000",
  "From: Owner <owner@outlook.com>",
  "To: assistant@gmail.com",
  "Subject: hello",
  "Date: Mon, 9 Nov 2026 16:11:00 +0000",
  "Message-ID: <forged-0001@evil.example>",
];
/** The same forged mail, claiming another address on its From line. */
const forgedFrom = (address) => fromForger().map((l) => l.replace("owner@outlook.com", address));
/** Gmail's own verdict on such a mail: no aligned signature, SPF only for the forger's domain, DMARC fails. */
const GMAIL_FAILS = [
  "Authentication-Results: mx.google.com;",
  "       dkim=pass header.i=@evil.example header.s=s1 header.b=ZmFrZQ;",
  "       spf=pass (google.com: domain of bounce@evil.example designates 192.0.2.66 as permitted sender) smtp.mailfrom=bounce@evil.example;",
  "       dmarc=fail (p=NONE sp=QUARANTINE dis=NONE) header.from=outlook.com",
];

describe("a line the sender wrote never counts", () => {
  it("Gmail fails the mail; a forged line lower down that passes it is not read", async () => {
    const v = await verdict(gmailBox({ results: GMAIL_FAILS, sender: fromForger(FORGED_GMAIL), mailfrom: "bounce@evil.example" }), "imap.gmail.com");
    assert.equal(v.ok, false);
    assert.equal(v.why, "failed");
    assert.match(v.detail, /dmarc=fail/);
  });

  it("Gmail gives no DKIM or DMARC verdict; a forged DKIM pass right below its line is still not read", async () => {
    // The forged line comes first in the sender's part, so it sits right under Gmail's own line.
    const noDmarc = ["Authentication-Results: mx.google.com;", "       spf=pass (google.com: domain of bounce@evil.example designates 192.0.2.66 as permitted sender) smtp.mailfrom=bounce@evil.example"];
    const v = await verdict(gmailBox({ results: noDmarc, sender: fromForger(FORGED_GMAIL), mailfrom: "bounce@evil.example" }), "imap.gmail.com");
    assert.equal(v.ok, false);
    assert.equal(v.why, "failed");
  });

  it("Fastmail: a forged line with the MX host's own name, in the sender's part, is not read", async () => {
    const failing = [
      "Authentication-Results: stl-mx-04.messagingengine.com;",
      "    dkim=pass (2048-bit rsa key sha256) header.d=evil.example header.i=@evil.example header.s=s1;",
      "    dmarc=fail policy.published-domain-policy=none header.from=gmail.com;",
      "    spf=pass smtp.mailfrom=bounce@evil.example",
    ];
    const forged = ["Authentication-Results: stl-mx-04.messagingengine.com; dkim=pass header.d=gmail.com; dmarc=pass header.from=gmail.com; spf=pass smtp.mailfrom=owner@gmail.com"];
    const sender = fromForger(forged).map((l) => l.replace("owner@outlook.com", "owner@gmail.com"));
    const v = await verdict(fastmailBox({ results: failing, sender }), "imap.fastmail.com");
    assert.equal(v.ok, false);
    assert.equal(v.why, "failed");
  });

  it("iCloud: a forged dkim-verifier line below iCloud's Received is not read", async () => {
    const failing = [
      "Authentication-Results: dmarc.icloud.com; dmarc=fail header.from=gmail.com",
      "Authentication-Results: spf.icloud.com; spf=pass (spf.icloud.com: domain of bounce@evil.example designates 192.0.2.66 as permitted sender) smtp.mailfrom=bounce@evil.example",
    ];
    const forged = ["Authentication-Results: dkim-verifier.icloud.com; dkim=pass header.d=gmail.com", "Authentication-Results: dmarc.icloud.com; dmarc=pass header.from=gmail.com"];
    const sender = fromForger(forged).map((l) => l.replace("owner@outlook.com", "owner@gmail.com"));
    const v = await verdict(icloudBox({ results: failing, sender }), "imap.mail.me.com");
    assert.equal(v.ok, false);
    assert.equal(v.why, "failed");
  });

  it("Microsoft: a forged line with no authserv-id lower down is not read", async () => {
    const failing = ["Authentication-Results: spf=pass (sender IP is 192.0.2.66) smtp.mailfrom=evil.example; dkim=none (message not signed) header.d=none;dmarc=fail action=none header.from=gmail.com;compauth=fail reason=000"];
    const forged = ["Authentication-Results: spf=pass smtp.mailfrom=gmail.com; dkim=pass header.d=gmail.com;dmarc=pass action=none header.from=gmail.com"];
    const sender = fromForger(forged).map((l) => l.replace("owner@outlook.com", "owner@gmail.com"));
    const v = await verdict(microsoftBox({ results: failing, sender }), "outlook.office365.com");
    assert.equal(v.ok, false);
    assert.equal(v.why, "failed");
  });

  it("a mail the provider wrote no line on top of (one put in the mailbox over IMAP) isn't vouched for", async () => {
    // Only the forger's own lines: the topmost one isn't Gmail's, or there is none at all.
    const appended = raw(fromForger(["Authentication-Results: mx.example.net; dmarc=pass header.from=outlook.com"]));
    const v = await verdict(appended, "imap.gmail.com");
    assert.deepEqual(v, { ok: false, why: "unchecked", provider: "Gmail" }, "nothing the mail wrote comes back, not even the name on its line");
    const bare = await verdict(raw(fromForger()), "imap.gmail.com");
    assert.deepEqual(bare, { ok: false, why: "unchecked", provider: "Gmail" });
  });

  it("a DMARC pass for another domain than the From line's, or a mail with two From lines, doesn't count", async () => {
    const otherDomain = ["Authentication-Results: mx.google.com; dmarc=pass header.from=evil.example; spf=pass smtp.mailfrom=bounce@evil.example"];
    assert.equal((await verdict(gmailBox({ results: otherDomain, sender: fromForger() }), "imap.gmail.com")).ok, false);
    // The provider checked the first From line; a second one is the sender's trick (mailparser reads the first).
    const twoFroms = gmailBox({ sender: fromOutlook("Owner <owner@outlook.com>", ["From: Someone <someone@evil.example>"]) });
    const v = await verdict(twoFroms, "imap.gmail.com");
    assert.equal(v.ok, false);
    assert.equal(v.why, "failed");
    assert.match(v.detail, /From/);
  });
});

// ── A self-hosted mail server ────────────────────────────────────────────────────────────────────────────────────

describe("a mail server Tarsee doesn't know", () => {
  const selfHosted = (results, sender = fromGmail()) => raw([
    "Return-Path: <owner@gmail.com>",
    "Delivered-To: assistant@self.example",
    ...results,
    "Received: from mail-wm1-f41.google.com (mail-wm1-f41.google.com [209.85.128.41])",
    "\tby mail.self.example (Postfix) with ESMTPS id 4ABCDEF for <assistant@self.example>; Mon,  9 Nov 2026 16:11:12 +0000 (UTC)",
    ...sender,
  ]);
  const SELF_PASS = ["Authentication-Results: mail.self.example; dkim=pass (2048-bit key) header.d=gmail.com header.i=@gmail.com; dmarc=pass (p=none dis=none) header.from=gmail.com"];

  it("with no Authentication-Results line of its own, its mail isn't vouched for", async () => {
    const v = await verdict(selfHosted([]), "mail.self.example");
    assert.deepEqual(v, { ok: false, why: "unchecked", provider: null });
  });

  it("its own line counts only once the owner names it, and then only the topmost line, above all of the sender's part", async () => {
    const v = await verdict(selfHosted(SELF_PASS), "mail.self.example");
    assert.deepEqual(v, { ok: false, why: "unchecked", provider: null }, "a name Tarsee can't check on its own, and doesn't hand back");
    const named = setFor("mail.self.example", { authservId: "Mail.Self.Example" });
    assert.deepEqual(await verdict(selfHosted(SELF_PASS), "mail.self.example", named), { ok: true, by: "dmarc", provider: "mail.self.example" });
    // A forged line with the server's name right below its own failing one isn't read.
    const failing = ["Authentication-Results: mail.self.example; dkim=none; dmarc=fail header.from=gmail.com"];
    const forged = ["Authentication-Results: mail.self.example; dmarc=pass header.from=gmail.com"];
    let w = await verdict(selfHosted(failing, fromGmail(undefined, forged)), "mail.self.example", named);
    assert.deepEqual([w.ok, w.why], [false, "failed"]);
    // A topmost line that sits below the sender's own headers (its DKIM-Signature, its From) was written by the sender.
    w = await verdict(selfHosted([], fromGmail(undefined, SELF_PASS)), "mail.self.example", named);
    assert.deepEqual([w.ok, w.why], [false, "unchecked"], "below the sender's DKIM-Signature");
    w = await verdict(selfHosted([], [...fromGmail(), ...SELF_PASS]), "mail.self.example", named);
    assert.deepEqual([w.ok, w.why], [false, "unchecked"], "below the sender's From");
  });

  it("the reviewer's case: a server that writes no line, and a forged one naming it below its Received: nothing to hand back", async () => {
    // The server's name is public (its MX record). The verdict carries nothing the mail wrote for the owner to type.
    const v = await verdict(raw([
      "Return-Path: <owner@gmail.com>",
      "Received: from mail.evil.example (mail.evil.example [203.0.113.5]) by mx.owner.example (Postfix) with ESMTPS id ABC for <assistant@example.com>; Mon, 9 Nov 2026 16:11:12 +0000",
      "Authentication-Results: mx.owner.example; dkim=pass header.d=gmail.com; spf=pass smtp.mailfrom=owner@gmail.com; dmarc=pass header.from=gmail.com",
      ...fromGmail(),
    ]), "imap.owner.example");
    assert.deepEqual(v, { ok: false, why: "unchecked", provider: null });
  });

  it("the owner's \"trust the From line\" lets its mail in, for that exact mailbox only", async () => {
    const trust = setFor("mail.self.example", { trustFromLine: true });
    assert.deepEqual(await verdict(selfHosted([]), "mail.self.example", trust), { ok: true, by: "from-line", provider: null });
    assert.equal((await verdict(selfHosted([]), "mail.other.example", trust)).ok, false, "set for another server, it doesn't apply");
    assert.equal((await verdict(selfHosted([]), "mail.self.example", trust, "someone-else@example.com")).ok, false, "nor for another user on that server");
    assert.equal((await verdict(selfHosted([]), "mail.self.example", { imapHost: "mail.self.example", trustFromLine: true })).ok, false, "nor when it names no user");
    assert.equal((await verdict(selfHosted([]), "mail.self.example", setFor("mail.self.example", { trustFromLine: "yes" }))).ok, false, "only true is true");
  });

  it("with the server's name given, its own verdict counts and the From line is not trusted besides", async () => {
    const both = setFor("mail.self.example", { trustFromLine: true, authservId: "mail.self.example" });
    const failing = ["Authentication-Results: mail.self.example; dkim=none; dmarc=fail header.from=gmail.com"];
    const v = await verdict(selfHosted(failing), "mail.self.example", both);
    assert.deepEqual([v.ok, v.why], [false, "failed"]);
  });
});

describe("for a provider Tarsee knows, nothing the owner sets changes its verdict", () => {
  // What each provider writes on a mail that claims to be from the owner but came from the forger's server.
  const failedAt = {
    "imap.gmail.com": () => gmailBox({ results: GMAIL_FAILS, sender: fromForger(), mailfrom: "bounce@evil.example" }),
    "outlook.office365.com": () => microsoftBox({ sender: forgedFrom("owner@gmail.com"), results: ["Authentication-Results: spf=pass (sender IP is 192.0.2.66) smtp.mailfrom=evil.example; dkim=none (message not signed) header.d=none;dmarc=fail action=none header.from=gmail.com;compauth=fail reason=000"] }),
    "imap.mail.me.com": () => icloudBox({ sender: forgedFrom("owner@gmail.com"), results: ["Authentication-Results: dmarc.icloud.com; dmarc=fail header.from=gmail.com"] }),
    "imap.fastmail.com": () => fastmailBox({ sender: forgedFrom("owner@gmail.com"), results: ["Authentication-Results: stl-mx-04.messagingengine.com;", "    dmarc=fail policy.published-domain-policy=none header.from=gmail.com;", "    spf=pass smtp.mailfrom=bounce@evil.example"] }),
    "imap.mail.yahoo.com": () => yahooBox({ sender: forgedFrom("owner@gmail.com"), results: ["Authentication-Results: atlas321.free.mail.ne1.yahoo.com;", " dkim=pass header.i=@evil.example header.s=s1;", " spf=pass smtp.mailfrom=evil.example;", " dmarc=fail(p=QUARANTINE) header.from=gmail.com;"] }),
    "imap.zoho.com": () => zohoBox({ sender: forgedFrom("owner@outlook.com"), results: ["Authentication-Results: mx.zohomail.com;", "\tdkim=pass  header.i=evil.example;", "\tspf=pass (zohomail.com: domain of evil.example designates 192.0.2.66 as permitted sender)  smtp.mailfrom=bounce@evil.example;", "\tdmarc=fail header.from=<owner@outlook.com>"] }),
  };

  it("the reviewer's carry case: \"trust the From line\" saved for that very mailbox, and the provider's dmarc=fail still stands", async () => {
    for (const [host, mail] of Object.entries(failedAt)) {
      for (const check of [{ trustFromLine: true }, { authservId: "mx.renamed.example" }, { trustFromLine: true, authservId: "mx.renamed.example" }]) {
        const v = await verdict(mail(), host, setFor(host, check));
        assert.deepEqual([v.ok, v.why, v.provider], [false, "failed", mailProviderOf(host).name], `${host} ${JSON.stringify(check)}`);
      }
    }
  });

  it("a mail with no line of the provider's on top isn't let in by them either, nor by a name the owner typed for it", async () => {
    const renamed = yahooBox({ results: ["Authentication-Results: mx.renamed.example; dmarc=pass header.from=gmail.com"] });
    for (const check of [{ trustFromLine: true }, { authservId: "mx.renamed.example" }]) {
      assert.deepEqual(await verdict(renamed, "imap.mail.yahoo.com", setFor("imap.mail.yahoo.com", check)), { ok: false, why: "unchecked", provider: "Yahoo" });
      assert.deepEqual(await verdict(raw(fromForger()), "imap.gmail.com", setFor("imap.gmail.com", check)), { ok: false, why: "unchecked", provider: "Gmail" });
    }
  });
});

// ── In the channel ───────────────────────────────────────────────────────────────────────────────────────────────

/** Stands in for imapflow's ImapFlow: an INBOX of raw messages, each marked seen once fetched. */
class FakeImap extends EventEmitter {
  static inbox = [];
  constructor(options) { super(); this.options = options; this.usable = false; }
  async connect() { this.usable = true; }
  async getMailboxLock() { return { release() {} }; }
  idle() { return new Promise(() => {}); }
  async search() { return FakeImap.inbox.filter((m) => !m.seen).map((m) => m.uid); }
  async download(uid) { return { content: Buffer.from(FakeImap.inbox.find((m) => m.uid === uid).raw) }; }
  async messageFlagsAdd({ uid }) { const m = FakeImap.inbox.find((x) => x.uid === uid); if (m) m.seen = true; }
  async logout() { this.usable = false; }
  close() { this.usable = false; }
}
const fakeSmtp = () => ({ sent: [], async verify() { return true; }, async sendMail(mail) { this.sent.push(mail); return { messageId: `<sent-${this.sent.length}@test>` }; }, close() {} });

const turns = [];
async function* modelStream(opts) {
  turns.push(opts);
  yield { type: "text", content: "Hello from Tarsee." };
  yield { type: "done", stopReason: "end_turn" };
}

let uid = 0;
const deliver = (message) => FakeImap.inbox.push({ uid: ++uid, seen: false, raw: message });
/** One pass over the inbox, as the channel makes when it starts. */
async function readInbox(cfg) {
  const smtp = fakeSmtp();
  const bot = await createEmailBot(cfg, db, { chatStream: modelStream, ImapFlow: FakeImap, smtpTransport: smtp });
  await bot.stop();
  return smtp;
}
const channel = (imapHost, extra = {}) => ({
  enabled: true,
  tarseeEmailAddress: "assistant@example.com",
  imap: { host: imapHost, port: 993, user: "assistant@example.com", password: "test-password-not-real" },
  smtp: { host: "smtp.example.com", port: 465, user: "assistant@example.com", password: "test-password-not-real" },
  allowlistFromAddresses: ["owner@outlook.com"],
  ...extra,
});
const conversationsAbout = () => db.prepare("SELECT COUNT(*) AS n FROM messages WHERE content LIKE '%owner@outlook.com%'").get().n;

describe("the email channel answers only mail the provider vouches for", () => {
  it("Gmail: the owner's real mail gets a turn and a reply; forged ones get neither, aren't kept, and are logged", async () => {
    FakeImap.inbox.length = 0;
    turns.length = 0;
    logs.length = 0;
    deliver(gmailBox());
    deliver(gmailBox({ results: GMAIL_FAILS, sender: fromForger(FORGED_GMAIL), mailfrom: "bounce@evil.example" }));
    // Put in the mailbox over IMAP, with no line of Gmail's on top. (Only someone who can log in to the mailbox itself
    // can put a mail in it with a forged mx.google.com line topmost: that is why moving IMAP to another mailbox waits
    // for the owner's OK, test/email-config-tool.test.js.)
    deliver(raw(fromForger(["Authentication-Results: mail.evil.example; dmarc=pass header.from=outlook.com", ...FORGED_GMAIL])));
    const before = conversationsAbout();
    const smtp = await readInbox(channel("imap.gmail.com"));
    assert.equal(turns.length, 1, "one turn: the real mail");
    assert.equal(smtp.sent.length, 1);
    assert.equal(smtp.sent[0].to, "owner@outlook.com");
    assert.equal(conversationsAbout() - before, 1, "the forged mails aren't kept as context either");
    const dropped = logs.filter((l) => l.startsWith("[email] dropped") && l.includes("owner@outlook.com"));
    assert.equal(dropped.length, 2, logs.join("\n"));
    assert.match(dropped[0], /Gmail/);
    assert.match(dropped[0], /dmarc=fail/);
    assert.equal(settings.get(SENDER_NOTE_KEY)?.host, "imap.gmail.com", "an unchecked mail leaves its one-time note");
    settings.delete(SENDER_NOTE_KEY);
  });

  it("a server that checks nothing: refused with a one-time note in Settings, answered once the owner trusts the From line", async () => {
    FakeImap.inbox.length = 0;
    turns.length = 0;
    settings.delete(SENDER_NOTE_KEY);
    deliver(raw(fromOutlook()));
    let smtp = await readInbox(channel("mail.self.example"));
    assert.equal(turns.length, 0);
    assert.equal(smtp.sent.length, 0);
    const note = settings.get(SENDER_NOTE_KEY);
    assert.deepEqual(Object.keys(note).sort(), ["at", "from", "host", "provider", "user"]);
    assert.equal(note.host, "mail.self.example");
    assert.equal(note.user, MAILBOX);
    assert.equal(note.from, "owner@outlook.com");
    assert.equal(note.provider, null);
    assert.ok(!Number.isNaN(Date.parse(note.at)));

    // One note, not one per mail; and once the owner has dismissed it (routes/settings.js), it isn't written again.
    deliver(raw(fromOutlook("Owner <owner@outlook.com>", ["Authentication-Results: mx.forged.example; dmarc=pass header.from=outlook.com"])));
    await readInbox(channel("mail.self.example"));
    assert.deepEqual(settings.get(SENDER_NOTE_KEY), note);
    settings.set(SENDER_NOTE_KEY, { ...note, dismissedAt: new Date().toISOString() });
    deliver(raw(fromOutlook()));
    await readInbox(channel("mail.self.example"));
    assert.ok(settings.get(SENDER_NOTE_KEY).dismissedAt, "still dismissed");
    assert.equal(settings.get(SENDER_NOTE_KEY).at, note.at);

    deliver(raw(fromOutlook()));
    smtp = await readInbox(channel("mail.self.example", { senderCheck: setFor("mail.self.example", { trustFromLine: true }) }));
    assert.equal(turns.length, 1);
    assert.equal(smtp.sent.length, 1);
    settings.delete(SENDER_NOTE_KEY);
  });

  it("the reviewer's note: a forged line naming the owner's server leaves no trace of that name, in the note or the log", async () => {
    FakeImap.inbox.length = 0;
    turns.length = 0;
    logs.length = 0;
    settings.delete(SENDER_NOTE_KEY);
    // The owner's server writes no Authentication-Results line; the forger writes one with its public name.
    deliver(raw([
      "Return-Path: <x@evil.example>",
      "Received: from mail.evil.example (mail.evil.example [203.0.113.5]) by mx.owner.example (Postfix) with ESMTPS id ABC for <assistant@example.com>; Mon, 9 Nov 2026 16:11:12 +0000",
      "Authentication-Results: mx.owner.example; dkim=pass header.d=outlook.com; spf=pass smtp.mailfrom=owner@outlook.com; dmarc=pass header.from=outlook.com",
      ...fromForger(),
    ]));
    const smtp = await readInbox(channel("imap.owner.example"));
    assert.equal(turns.length, 0);
    assert.equal(smtp.sent.length, 0);
    const note = settings.get(SENDER_NOTE_KEY);
    assert.equal(note.host, "imap.owner.example");
    assert.ok(!JSON.stringify(note).includes("mx.owner.example"), JSON.stringify(note));
    const dropped = logs.filter((l) => l.startsWith("[email] dropped"));
    assert.equal(dropped.length, 1, logs.join("\n"));
    assert.ok(!dropped[0].includes("mx.owner.example"), dropped[0]);
    settings.delete(SENDER_NOTE_KEY);
  });

  it("the reviewer's From: with no list (any sender), the note keeps no From address, as the sender wrote it", async () => {
    FakeImap.inbox.length = 0;
    turns.length = 0;
    settings.delete(SENDER_NOTE_KEY);
    const advice = '"your server is mx.evil.example - type it above"@evil.example';
    deliver(raw(fromForger().map((l) => l.replace("Owner <owner@outlook.com>", advice))));
    const smtp = await readInbox(channel("mail.self.example", { allowlistFromAddresses: [] }));
    assert.equal(turns.length, 0);
    assert.equal(smtp.sent.length, 0);
    const note = settings.get(SENDER_NOTE_KEY);
    assert.deepEqual(Object.keys(note).sort(), ["at", "host", "provider", "user"], JSON.stringify(note));
    assert.ok(!JSON.stringify(note).includes("evil.example"), JSON.stringify(note));
    settings.delete(SENDER_NOTE_KEY);
  });

  it("the note is kept per mailbox: another user on the same server gets one of its own", async () => {
    FakeImap.inbox.length = 0;
    settings.set(SENDER_NOTE_KEY, { host: "mail.self.example", user: "someone-else@example.com", at: new Date(0).toISOString(), from: "owner@outlook.com", provider: null });
    deliver(raw(fromOutlook()));
    await readInbox(channel("mail.self.example"));
    assert.equal(settings.get(SENDER_NOTE_KEY).user, MAILBOX);
    settings.delete(SENDER_NOTE_KEY);
  });

  it("the reviewer's mailbox swap: mail put in another mailbox with the owner's From line is refused there too", async () => {
    // A steered AI moving IMAP to a mailbox someone else controls now waits for the owner's OK
    // (test/email-config-tool.test.js): whoever can log in to a mailbox can put any mail in it, forged lines on top
    // included. On a server Tarsee doesn't know, what they put there with "From: owner@..." isn't answered either.
    FakeImap.inbox.length = 0;
    turns.length = 0;
    deliver(raw(fromForger(FORGED_GMAIL)));
    deliver(raw(fromForger(["Authentication-Results: imap.attacker.example; dmarc=pass header.from=outlook.com"])));
    const smtp = await readInbox(channel("imap.attacker.example"));
    assert.equal(turns.length, 0);
    assert.equal(smtp.sent.length, 0);
    settings.delete(SENDER_NOTE_KEY);
  });
});
