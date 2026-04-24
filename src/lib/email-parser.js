/**
 * Email parsing helpers — quote-strip, mention detection, reply-all
 * detection, thread-key extraction.
 *
 * All functions are pure. No network, no filesystem, no state.
 * Unit-tested in test/email-parser.test.js.
 *
 * Design principle: quote-strip FIRST, then match. A quoted `@tarsee`
 * from the earlier turn of a thread must NOT re-trigger a reply on
 * every subsequent reply.
 */

/**
 * Strip quoted text from an email reply body so only the user's new
 * content remains. Handles the common reply-quote markers:
 *
 *   - "On Wed, Apr 24, 2026 at 3:14 PM Alice <a@x.com> wrote:"   (Gmail, Apple Mail)
 *   - "-----Original Message-----"                                (Outlook classic)
 *   - "From: name <email>" block after content                   (Outlook forward)
 *   - "-- " line on its own                                      (RFC 3676 signature)
 *   - Lines starting with "> " or ">"                            (quoted)
 *
 * Stops consumption at the first match of any of the above. Returns
 * the trimmed head of the message — what the user actually typed this
 * turn.
 *
 * @param {string} text  plain-text email body (prefer text/plain part)
 * @returns {string}     stripped body
 */
export function stripQuotedReply(text) {
  if (!text) return "";
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const out = [];

  for (const line of lines) {
    // "On <date>, <name> <addr?> wrote:" — Gmail / Apple Mail style
    if (/^\s*On .{10,200}wrote:\s*$/i.test(line)) break;
    // Occasionally the "wrote:" wraps to the next line; catch the short variant
    if (/^\s*On .{1,200}$/i.test(line) && /\s(at|,)\s/.test(line) && line.length < 160 && /@/.test(line)) {
      // Heuristic: looks like the start of a "On X, Y <a@b> wrote:" line that wrapped.
      // Peek ahead one line — if it's "wrote:", treat as quote boundary.
      // (We still break because the header alone strongly signals quoted content.)
      // This is loose on purpose; false negatives here just mean we keep more text
      // than strictly necessary, never fewer.
      // Don't break here by default — too loose — but dropping this line is fine.
      continue;
    }
    // Outlook "-----Original Message-----"
    if (/^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i.test(line)) break;
    // Forwarded header block: "From: <name> <email>" after some real content has been seen
    if (out.length > 0 && /^\s*From:\s.+<.+@.+>/i.test(line)) break;
    // RFC 3676 signature delimiter — a line containing exactly "-- "
    if (/^-- \s*$/.test(line)) break;
    // Any line starting with ">" is a quoted line — drop it
    if (/^\s*>/.test(line)) continue;

    out.push(line);
  }

  return out.join("\n").trim();
}

/**
 * Detect whether the stripped body "mentions" the bot using the configured
 * keyword. Case-insensitive word-boundary match on `@<keyword>`.
 *
 * Importantly, this must NOT match when the keyword appears inside an
 * email address like `foo@tarsee.example.com`. The regex uses a
 * negative-alternation character class `[^A-Za-z0-9._%+\-]` on the
 * character immediately preceding `@` to rule that out — if the
 * character before `@` looks like it could be part of an email local-part,
 * we don't treat it as a mention.
 *
 * @param {string} stripped  body after stripQuotedReply()
 * @param {string} keyword   default "tarsee"; strip leading "@" if present
 * @returns {boolean}
 */
export function hasMention(stripped, keyword = "tarsee") {
  if (!stripped) return false;
  // Accept keyword with or without a leading "@"
  const kw = keyword.startsWith("@") ? keyword.slice(1) : keyword;
  if (!kw) return false;
  // Escape regex metacharacters in the keyword so users can pick anything.
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[^A-Za-z0-9._%+\\-])@${escaped}\\b`, "i");
  return re.test(stripped);
}

/**
 * Detect whether this message is asking for a reply-all. Two triggers,
 * either one is enough:
 *
 *   1. Subject contains the reply-all marker (default "[reply-all]").
 *   2. Body (stripped) contains "@<keyword> reply-all" as a phrase.
 *
 * Reply-all is explicit opt-in only. Default reply behavior is always
 * reply-to-sender.
 *
 * @param {object} opts
 * @param {string} opts.stripped   stripped body
 * @param {string} opts.subject    full subject line
 * @param {string} [opts.keyword]  mention keyword (default "tarsee")
 * @param {string} [opts.marker]   reply-all subject marker (default "[reply-all]")
 * @returns {boolean}
 */
export function isReplyAll({ stripped, subject, keyword = "tarsee", marker = "[reply-all]" }) {
  if (subject && marker && subject.toLowerCase().includes(marker.toLowerCase())) {
    return true;
  }
  if (!stripped) return false;
  const kw = keyword.startsWith("@") ? keyword.slice(1) : keyword;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@${escaped}\\s+reply[\\s-]?all\\b`, "i");
  return re.test(stripped);
}

/**
 * Compute the thread key used to look up / create the conversation
 * that this email belongs to. Convention:
 *
 *   - If `references` is non-empty, use the FIRST entry (root of the
 *     thread tree) — all replies in a thread share the same root ref,
 *     so this gives us a stable per-thread key.
 *   - Otherwise, use the current message's own `messageId` (this is
 *     the root of a fresh thread).
 *
 * Message-ID brackets `<...>` are preserved if present — they're part
 * of the canonical header form and help distinguish between thread
 * roots that happen to share local-parts.
 *
 * @param {object} headers
 * @param {string|null} [headers.messageId]
 * @param {string[]} [headers.references]
 * @returns {string|null}  thread key, or null if headers missing entirely
 */
export function threadKeyFromHeaders({ messageId, references } = {}) {
  if (Array.isArray(references) && references.length > 0 && references[0]) {
    return String(references[0]).trim();
  }
  if (messageId) return String(messageId).trim();
  return null;
}

/**
 * Best-effort HTML → plain-text fallback for emails that have no
 * text/plain part. Strips tags, decodes a handful of common entities,
 * collapses whitespace. Good enough for quote-strip + mention match —
 * not meant to be a perfect rendering.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
