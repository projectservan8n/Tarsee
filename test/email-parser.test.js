/**
 * Unit tests for src/lib/email-parser.js + src/lib/email-threading.js
 *
 * No network. No filesystem. No SMTP. Pure-function fixtures covering
 * the reply policy in the plan: mention-only reply, quote-strip before
 * mention match, reply-all opt-in, thread-key extraction, subject
 * normalization, and recipient resolution.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripQuotedReply,
  hasMention,
  isReplyAll,
  threadKeyFromHeaders,
  htmlToText,
} from "../src/lib/email-parser.js";
import {
  buildReplyHeaders,
  normalizeReplySubject,
  resolveRecipients,
} from "../src/lib/email-threading.js";

// ---------------------------------------------------------------
// stripQuotedReply
// ---------------------------------------------------------------

test("stripQuotedReply — Gmail/Apple-style quote header ends the body", () => {
  const body = [
    "@tarsee what do you think?",
    "",
    "On Wed, Apr 24, 2026 at 3:14 PM Alice <alice@example.com> wrote:",
    "> @tarsee earlier message from the thread",
    "> more quoted content",
  ].join("\n");

  const stripped = stripQuotedReply(body);
  assert.equal(stripped, "@tarsee what do you think?");
});

test("stripQuotedReply — Outlook Original-Message separator", () => {
  const body = [
    "ok, go ahead.",
    "",
    "-----Original Message-----",
    "From: Alice <alice@example.com>",
    "Sent: Wednesday, April 24, 2026",
    "Subject: status",
    "",
    "original content here",
  ].join("\n");

  const stripped = stripQuotedReply(body);
  assert.equal(stripped, "ok, go ahead.");
});

test("stripQuotedReply — RFC 3676 signature delimiter ends the body", () => {
  const body = [
    "@tarsee please note",
    "",
    "-- ",
    "@tarsee  <- this in the sig should NOT be read as a mention",
    "Best, Alice",
  ].join("\n");

  const stripped = stripQuotedReply(body);
  assert.equal(stripped, "@tarsee please note");
  assert.equal(hasMention(stripped), true);
});

test("stripQuotedReply — lines starting with > are dropped", () => {
  const body = "> old content\n> more old content\nnew line";
  const stripped = stripQuotedReply(body);
  assert.equal(stripped, "new line");
});

test("stripQuotedReply — forwarded From: header block stops consumption", () => {
  const body = [
    "please handle this forward",
    "",
    "From: Bob <bob@example.com>",
    "To: Alice <alice@example.com>",
    "",
    "... original forwarded content ...",
  ].join("\n");

  const stripped = stripQuotedReply(body);
  assert.equal(stripped, "please handle this forward");
});

test("stripQuotedReply — CRLF line endings are handled", () => {
  const body = "line 1\r\nline 2\r\n> quoted\r\nline 3";
  const stripped = stripQuotedReply(body);
  assert.equal(stripped, "line 1\nline 2\nline 3");
});

test("stripQuotedReply — empty/null input safe", () => {
  assert.equal(stripQuotedReply(""), "");
  assert.equal(stripQuotedReply(null), "");
  assert.equal(stripQuotedReply(undefined), "");
});

// ---------------------------------------------------------------
// hasMention
// ---------------------------------------------------------------

test("hasMention — direct @tarsee with word-boundary matches", () => {
  assert.equal(hasMention("@tarsee hi there"), true);
  assert.equal(hasMention("hey @tarsee can you"), true);
  assert.equal(hasMention("can you @Tarsee respond?"), true); // case insensitive
  assert.equal(hasMention("@TARSEE!"), true);                  // uppercase
});

test("hasMention — email-address-looking @tarsee is NOT a mention", () => {
  // Standard bounce — Tarsee's address should not trigger a mention.
  assert.equal(hasMention("send it to alice@tarsee.example.com"), false);
  assert.equal(hasMention("cc: bot@tarsee.io"), false);
  // A username with a 'tarsee' substring inside a longer local-part.
  assert.equal(hasMention("replied to btarsee@example.com"), false);
});

test("hasMention — 'tarsee' as a bare word (no @) does NOT match", () => {
  assert.equal(hasMention("the tarsee animal is cute"), false);
  assert.equal(hasMention("Tarsee, please"), false);
});

test("hasMention — custom keyword with or without leading @", () => {
  assert.equal(hasMention("@jarvis status?", "jarvis"), true);
  assert.equal(hasMention("@jarvis status?", "@jarvis"), true); // leading @ in keyword ok
  assert.equal(hasMention("@tarsee yo", "jarvis"), false);       // wrong keyword
});

test("hasMention — keyword with regex metacharacters is escaped", () => {
  // Hypothetical operator using a bracket or dot in keyword — shouldn't regex-inject.
  assert.equal(hasMention("@bot.tarsee hi", "bot.tarsee"), true);
  assert.equal(hasMention("@botxtarsee hi", "bot.tarsee"), false); // dot treated literally
});

test("hasMention — empty/null input safe", () => {
  assert.equal(hasMention(""), false);
  assert.equal(hasMention(null), false);
  assert.equal(hasMention("@tarsee hi", ""), false); // empty keyword
});

// ---------------------------------------------------------------
// isReplyAll
// ---------------------------------------------------------------

test("isReplyAll — subject marker triggers reply-all", () => {
  assert.equal(
    isReplyAll({ stripped: "anything", subject: "[reply-all] status update" }),
    true,
  );
  // Case insensitive
  assert.equal(
    isReplyAll({ stripped: "anything", subject: "[REPLY-ALL] status" }),
    true,
  );
});

test("isReplyAll — body phrase `@tarsee reply-all` triggers reply-all", () => {
  assert.equal(
    isReplyAll({ stripped: "@tarsee reply-all please", subject: "status" }),
    true,
  );
  assert.equal(
    isReplyAll({ stripped: "@tarsee reply all please", subject: "status" }),
    true,
  );
});

test("isReplyAll — default (mention only) is NOT reply-all", () => {
  assert.equal(
    isReplyAll({ stripped: "@tarsee status?", subject: "status" }),
    false,
  );
});

test("isReplyAll — custom keyword + marker", () => {
  assert.equal(
    isReplyAll({
      stripped: "@jarvis reply-all now",
      subject: "whatever",
      keyword: "jarvis",
    }),
    true,
  );
  assert.equal(
    isReplyAll({
      stripped: "no mention here",
      subject: "[share-all] update",
      marker: "[share-all]",
    }),
    true,
  );
});

// ---------------------------------------------------------------
// threadKeyFromHeaders
// ---------------------------------------------------------------

test("threadKeyFromHeaders — references[0] wins when present", () => {
  const key = threadKeyFromHeaders({
    messageId: "<current@example.com>",
    references: ["<root@example.com>", "<middle@example.com>"],
  });
  assert.equal(key, "<root@example.com>");
});

test("threadKeyFromHeaders — falls back to messageId for a fresh thread", () => {
  const key = threadKeyFromHeaders({
    messageId: "<new-thread@example.com>",
    references: [],
  });
  assert.equal(key, "<new-thread@example.com>");
});

test("threadKeyFromHeaders — null-safe", () => {
  assert.equal(threadKeyFromHeaders(), null);
  assert.equal(threadKeyFromHeaders({}), null);
  assert.equal(threadKeyFromHeaders({ messageId: null, references: null }), null);
});

// ---------------------------------------------------------------
// buildReplyHeaders
// ---------------------------------------------------------------

test("buildReplyHeaders — appends current messageId to references", () => {
  const r = buildReplyHeaders({
    incomingMessageId: "<msg3@example.com>",
    references: ["<root@example.com>", "<msg2@example.com>"],
  });
  assert.equal(r.inReplyTo, "<msg3@example.com>");
  assert.equal(
    r.references,
    "<root@example.com> <msg2@example.com> <msg3@example.com>",
  );
});

test("buildReplyHeaders — de-dupes if already in chain", () => {
  const r = buildReplyHeaders({
    incomingMessageId: "<msg2@example.com>",
    references: ["<root@example.com>", "<msg2@example.com>"],
  });
  assert.equal(r.references, "<root@example.com> <msg2@example.com>");
});

test("buildReplyHeaders — caps long chains at MAX_REFERENCES keeping root + tail", () => {
  const refs = Array.from({ length: 20 }, (_, i) => `<m${i}@x.com>`);
  const r = buildReplyHeaders({
    incomingMessageId: "<new@x.com>",
    references: refs,
  });
  const parts = r.references.split(" ");
  assert.equal(parts.length, 10, "should cap at 10");
  assert.equal(parts[0], "<m0@x.com>", "root preserved");
  assert.equal(parts[parts.length - 1], "<new@x.com>", "latest is the incoming id");
});

test("buildReplyHeaders — no incoming messageId returns undefineds", () => {
  const r = buildReplyHeaders({ references: ["<x@y>"] });
  assert.equal(r.inReplyTo, undefined);
  assert.equal(r.references, undefined);
});

// ---------------------------------------------------------------
// normalizeReplySubject
// ---------------------------------------------------------------

test("normalizeReplySubject — dedupes Re: chains", () => {
  assert.equal(normalizeReplySubject("Re: Re: Re: status"), "Re: status");
  assert.equal(normalizeReplySubject("RE: re: RE: Fwd: status"), "Re: Fwd: status");
  assert.equal(normalizeReplySubject("status"), "Re: status");
  assert.equal(normalizeReplySubject(""), "Re: (no subject)");
  assert.equal(normalizeReplySubject("   "), "Re: (no subject)");
});

// ---------------------------------------------------------------
// resolveRecipients
// ---------------------------------------------------------------

test("resolveRecipients — default reply-to-sender only", () => {
  const r = resolveRecipients({
    incoming: {
      from: { address: "alice@example.com" },
      to: [{ address: "tarsee@example.com" }],
      cc: [{ address: "bob@example.com" }],
    },
    replyAll: false,
    selfAddress: "tarsee@example.com",
  });
  assert.deepEqual(r, { to: ["alice@example.com"], cc: [] });
});

test("resolveRecipients — reply-all includes To + Cc, excludes self + primary", () => {
  const r = resolveRecipients({
    incoming: {
      from: { address: "alice@example.com" },
      to: [{ address: "tarsee@example.com" }, { address: "carol@example.com" }],
      cc: [{ address: "bob@example.com" }, { address: "alice@example.com" }],
    },
    replyAll: true,
    selfAddress: "tarsee@example.com",
  });
  assert.deepEqual(r.to, ["alice@example.com"]);
  // carol and bob should be CC'd; alice (primary) excluded from cc; tarsee (self) excluded.
  assert.deepEqual(new Set(r.cc), new Set(["carol@example.com", "bob@example.com"]));
});

test("resolveRecipients — Reply-To header takes precedence over From", () => {
  const r = resolveRecipients({
    incoming: {
      from: { address: "noreply@example.com" },
      replyTo: { address: "alice@example.com" },
      to: [{ address: "tarsee@example.com" }],
    },
    replyAll: false,
    selfAddress: "tarsee@example.com",
  });
  assert.deepEqual(r, { to: ["alice@example.com"], cc: [] });
});

test("resolveRecipients — empty headers is safe", () => {
  const r = resolveRecipients({
    incoming: {},
    replyAll: false,
    selfAddress: "tarsee@example.com",
  });
  assert.deepEqual(r, { to: [], cc: [] });
});

// ---------------------------------------------------------------
// htmlToText
// ---------------------------------------------------------------

test("htmlToText — strips tags, decodes common entities, preserves line structure", () => {
  const html =
    "<p>hi <b>@tarsee</b></p><p>please &amp; review</p><script>alert(1)</script>";
  const text = htmlToText(html);
  assert.match(text, /hi @tarsee/);
  assert.match(text, /please & review/);
  assert.doesNotMatch(text, /<|>|script/);
});

test("htmlToText — empty-safe", () => {
  assert.equal(htmlToText(""), "");
  assert.equal(htmlToText(null), "");
});
