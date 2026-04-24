/**
 * Email threading helpers — reply headers + subject dedup +
 * References-chain management.
 *
 * Used when Tarsee replies to an inbound email or starts a new thread
 * via the tarsee_send_email_thread MCP tool. Pure functions; no I/O.
 */

const MAX_REFERENCES = 10; // cap to keep outbound headers reasonable

/**
 * Build outbound reply headers for a reply to an inbound email.
 *
 *   In-Reply-To: <incomingMessageId>
 *   References:  <existingRefs...> <incomingMessageId>  (dedup, cap MAX_REFERENCES)
 *
 * @param {object} opts
 * @param {string} opts.incomingMessageId  the Message-ID of what we're replying to
 * @param {string[]} [opts.references]     existing References chain from the inbound email
 * @returns {{ inReplyTo: string, references: string }}
 *   Values are formatted for nodemailer's `inReplyTo` + `references`
 *   fields (both accept space-separated `<msg-id>` strings).
 */
export function buildReplyHeaders({ incomingMessageId, references = [] } = {}) {
  if (!incomingMessageId) {
    return { inReplyTo: undefined, references: undefined };
  }
  const chain = Array.isArray(references) ? [...references] : [];
  // Append the incoming message ID if not already present.
  if (!chain.includes(incomingMessageId)) chain.push(incomingMessageId);
  // Dedup while preserving order.
  const deduped = [];
  const seen = new Set();
  for (const r of chain) {
    const trimmed = String(r || "").trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push(trimmed);
  }
  // Cap: keep the first entry (root) + the last (MAX_REFERENCES - 1) — this
  // preserves thread grouping without header bloat on long threads.
  const capped = deduped.length <= MAX_REFERENCES
    ? deduped
    : [deduped[0], ...deduped.slice(-1 * (MAX_REFERENCES - 1))];
  return {
    inReplyTo: incomingMessageId,
    references: capped.join(" "),
  };
}

/**
 * Dedupe "Re: Re: Re: ..." chains on an outbound reply subject. Gmail and
 * Apple Mail already tolerate multi-Re, but we keep it clean.
 *
 * Examples:
 *   "Re: Re: status update"         →  "Re: status update"
 *   "RE: re: Fwd: status"           →  "Re: Fwd: status"
 *   "status update"                 →  "Re: status update"
 *   ""                              →  "Re: (no subject)"
 *
 * @param {string} subject
 * @returns {string}
 */
export function normalizeReplySubject(subject) {
  const s = String(subject || "").trim();
  if (!s) return "Re: (no subject)";
  // Strip leading "Re:" / "RE:" chains (with optional whitespace between).
  const stripped = s.replace(/^(\s*re\s*:\s*)+/i, "").trim();
  return "Re: " + (stripped || "(no subject)");
}

/**
 * Resolve who to send an outbound reply to based on policy + incoming
 * headers. Default is reply-to-sender-only. Reply-all only when
 * explicitly opted in AND we're actually part of the original
 * conversation (sender + anyone in To/Cc except us).
 *
 * @param {object} opts
 * @param {object} opts.incoming      parsed inbound email
 * @param {{address: string}} opts.incoming.from
 * @param {Array<{address: string}>} [opts.incoming.to]
 * @param {Array<{address: string}>} [opts.incoming.cc]
 * @param {{address: string}} [opts.incoming.replyTo]   Reply-To header if present
 * @param {boolean} opts.replyAll
 * @param {string} opts.selfAddress   Tarsee's own inbox address — always excluded
 * @returns {{ to: string[], cc: string[] }}
 */
export function resolveRecipients({ incoming, replyAll, selfAddress }) {
  const self = (selfAddress || "").toLowerCase().trim();
  const fromAddr = incoming?.from?.address?.toLowerCase().trim();
  // Honor Reply-To header if it's a single address. Multi-address Reply-To
  // is discarded (rare, malformed). Reply-To always takes precedence over From
  // for the primary recipient when present.
  const primaryReplyTo = incoming?.replyTo?.address?.toLowerCase().trim();
  const primary = primaryReplyTo || fromAddr;
  if (!primary) return { to: [], cc: [] };

  if (!replyAll) {
    return { to: [primary], cc: [] };
  }

  // Reply-all: primary + everyone in To + Cc who isn't us or the primary.
  const allTo = Array.isArray(incoming?.to) ? incoming.to : [];
  const allCc = Array.isArray(incoming?.cc) ? incoming.cc : [];
  const others = [...allTo, ...allCc]
    .map((a) => a?.address?.toLowerCase().trim())
    .filter((a) => !!a)
    .filter((a) => a !== self && a !== primary);
  // Dedup the cc list.
  const ccSet = new Set(others);
  return {
    to: [primary],
    cc: Array.from(ccSet),
  };
}
