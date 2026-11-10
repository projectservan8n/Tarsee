/**
 * Email channel — IMAP IDLE inbound + SMTP outbound.
 *
 * Mirrors the shape of src/channels/discord.js + src/channels/telegram.js:
 * exports `createEmailBot(config, db)` which returns { stop, sendMessage,
 * sendNew }. Wired into src/channels/manager.js alongside Discord/Telegram.
 *
 * Reply policy (mention-only, mirrors Discord's guild @mention rule):
 *   1. Parse inbound email with mailparser
 *   2. Strip quoted reply history → "stripped body"
 *   3. Check for mention keyword (default @tarsee) in stripped body
 *      - YES → buildSystemPromptParts + chatStream + SMTP reply to From: only
 *      - NO  → persist as context to the conversation; NO outbound
 *   4. `[reply-all]` subject marker OR `@tarsee reply-all` opts into
 *      replying to To+Cc (sender-only otherwise).
 *
 * Safety gates before ever touching the chat pipeline:
 *   - Allowlist of From addresses (empty = warn + allow all, dev mode)
 *   - The sender must be one the mailbox provider vouches for (its Authentication-Results line: senderVouched), as a
 *     From line is easy to fake; a self-hosted server that checks nothing needs the owner's "trust the From line"
 *   - Self-loop guard (drop if From == tarseeEmailAddress)
 *   - Bulk/auto-reply drop (List-Id, Auto-Submitted, Precedence headers)
 *   - Per-sender rate limit (6/10 min)
 *   - Body truncation at 100 KB
 *   - Attachment caps: 10 MB per file, 5 files per email
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

import config from "../config/env.js";
import { chatStream } from "../ai/router.js";
import { withConversationTurn } from "../lib/conversation-lock.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand, extractPlaybookPrompt } from "../lib/commands.js";
import { buildSystemPromptParts } from "../lib/build-system-prompt.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { refused } from "../lib/channel-errors.js";
import { turnErrorNote, errorStillToSay } from "./turn-notes.js";
import {
  stripQuotedReply,
  hasMention,
  isReplyAll,
  threadKeyFromHeaders,
  htmlToText,
} from "../lib/email-parser.js";
import {
  buildReplyHeaders,
  normalizeReplySubject,
  resolveRecipients,
} from "../lib/email-threading.js";

const DEFAULT_MENTION_KEYWORD = "tarsee";
const DEFAULT_REPLY_ALL_MARKER = "[reply-all]";
const MAX_BODY_BYTES = 100 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const HISTORY_WINDOW = 15;

/**
 * @param {object} config
 * @param {boolean} config.enabled
 * @param {string} config.tarseeEmailAddress  the inbox we listen on
 * @param {object} config.imap   {host, port, user, password, secure?}
 * @param {object} config.smtp   {host, port, user, password, secure?}
 * @param {string[]} [config.allowlistFromAddresses]
 * @param {string} [config.mentionKeyword]
 * @param {string} [config.replyAllMarker]
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts] - chatStream: the model stream (ai/router.js chatStream when left out). ImapFlow: the IMAP
 *   client class, and smtpTransport: a nodemailer transport ({verify, sendMail, close}) used instead of one made from
 *   config.smtp. Tests pass stand-ins for the last two, so nothing reaches a mail server.
 * @returns {Promise<{stop: Function, sendMessage: Function, sendNew: Function}>}
 */
export async function createEmailBot(rawConfig, db, { chatStream: streamChat = chatStream, ImapFlow: ImapClient = ImapFlow, smtpTransport = null } = {}) {
  const cfg = normalizeConfig(rawConfig);
  const convStore = new ConversationStore(db);
  const settingsStore = new SettingsStore(db);

  if (!cfg.imap?.host || !cfg.imap?.user || !cfg.smtp?.host || !cfg.smtp?.user) {
    throw new Error("Email channel requires imap.{host,user} and smtp.{host,user}");
  }

  const allowlist = (cfg.allowlistFromAddresses || [])
    .map((a) => String(a).toLowerCase().trim())
    .filter(Boolean);
  if (allowlist.length === 0) {
    console.warn("[email] WARNING: allowlistFromAddresses is empty — accepting mail from ANY sender. Set this in settings for production.");
  }

  const selfAddress = String(cfg.tarseeEmailAddress || cfg.imap.user).toLowerCase().trim();

  // Per-sender rate limiter
  const rate = new Map();
  const isRateLimited = (fromAddr) => {
    const now = Date.now();
    const key = fromAddr.toLowerCase();
    const stamps = (rate.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (stamps.length >= RATE_LIMIT_MAX) {
      rate.set(key, stamps);
      return true;
    }
    stamps.push(now);
    rate.set(key, stamps);
    return false;
  };

  const uploadsDir = path.join(config.WORKSPACE_DIR, "uploads");
  try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch {}

  // SMTP transporter — reused across all outbound messages.
  const smtp = smtpTransport || nodemailer.createTransport(smtpTransportOptions(cfg.smtp));
  const sender = { cfg, selfAddress };

  // IMAP client with IDLE support.
  let client = null;
  let shuttingDown = false;
  let reconnectTimeout = null;

  async function connect() {
    if (shuttingDown) return;
    client = new ImapClient({
      host: cfg.imap.host,
      port: cfg.imap.port || 993,
      secure: cfg.imap.secure !== false,
      // requireTLS (saved by tarsee_configure_email_channel): without TLS from the start, STARTTLS must succeed before the login.
      ...(cfg.imap.secure === false && cfg.imap.requireTLS ? { doSTARTTLS: true } : {}),
      auth: { user: cfg.imap.user, pass: cfg.imap.password },
      logger: false, // keep our own logs
    });

    client.on("error", (err) => {
      console.warn("[email] IMAP error:", err?.message || err);
    });

    client.on("close", () => {
      if (shuttingDown) return;
      console.warn("[email] IMAP connection closed — reconnecting in 5s");
      reconnectTimeout = setTimeout(() => connect().catch((e) =>
        console.warn("[email] reconnect failed:", e?.message)
      ), 5000);
    });

    await client.connect();
    console.log(`[email] IDLE connected to ${cfg.imap.host} as ${cfg.imap.user}`);

    const lock = await client.getMailboxLock("INBOX");
    try {
      // Mark existing unseen as seen on startup — avoid a deluge of old mail
      // triggering replies on first boot. Operator can disable via settings
      // if they ever want replay-on-boot.
      // (Keep this out for now — it's safer to just start listening for NEW mail.)
    } finally {
      lock.release();
    }

    // The 'exists' event fires when the mailbox message count changes
    // (new mail arrived). Fetch + process any new messages.
    client.on("exists", async () => {
      try { await pollNew(); } catch (e) { console.warn("[email] pollNew error:", e?.message); }
    });

    // Enter IDLE loop so the server pushes events to us.
    // ImapFlow handles the 29-min IDLE restart internally.
    // We don't await this — it runs for the connection lifetime.
    client.idle().catch((err) => {
      if (!shuttingDown) console.warn("[email] idle loop error:", err?.message);
    });

    // Initial pass: anything unseen right now.
    await pollNew().catch(() => {});
  }

  /**
   * Fetch + process any UNSEEN messages in INBOX. Marks each as seen
   * after processing so we never double-reply.
   */
  async function pollNew() {
    if (!client?.usable) return;
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Search for unseen. Range "all unseen" via search query.
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return;
      for (const uid of uids) {
        try {
          const { content } = await client.download(uid, undefined, { uid: true });
          const parsed = await simpleParser(content);
          await handleInbound(parsed).catch((e) =>
            console.warn("[email] handleInbound error:", e?.message)
          );
        } catch (err) {
          console.warn("[email] fetch error for uid", uid, err?.message);
        } finally {
          // Mark as seen regardless — we don't want infinite retry on a
          // parse failure. Operator can unflag manually if they want to replay.
          try { await client.messageFlagsAdd({ uid }, ["\\Seen"], { uid: true }); } catch {}
        }
      }
    } finally {
      lock.release();
    }
  }

  /**
   * Main inbound handler. Parsed `mail` is the mailparser result.
   */
  async function handleInbound(mail) {
    const fromAddr = mail.from?.value?.[0]?.address?.toLowerCase().trim();
    if (!fromAddr) return;

    // Self-loop guard
    if (fromAddr === selfAddress) {
      console.log("[email] dropped — self-loop");
      return;
    }

    // Bulk / auto-reply detection (RFC 3834)
    const headers = mail.headerLines || [];
    const hdr = (name) => headers.find((h) => h.key === name.toLowerCase())?.line || "";
    if (
      /auto-submitted\s*:\s*(auto-generated|auto-replied)/i.test(hdr("Auto-Submitted")) ||
      /precedence\s*:\s*(bulk|list|junk)/i.test(hdr("Precedence")) ||
      !!hdr("List-Id") ||
      !!hdr("List-Unsubscribe")
    ) {
      console.log(`[email] dropped bulk/auto-reply from ${fromAddr}`);
      return;
    }

    // Allowlist
    if (allowlist.length > 0 && !allowlist.includes(fromAddr)) {
      console.log(`[email] dropped — sender ${fromAddr} not on allowlist`);
      return;
    }

    // Who really sent it. Anyone can write any address on the From line, so the mailbox provider must vouch for it
    // (senderVouched); otherwise the mail gets no turn and isn't kept, as from a sender who isn't on the list.
    const vouched = senderVouched(headers, fromAddr, { imapHost: cfg.imap.host, senderCheck: cfg.senderCheck });
    if (!vouched.ok) {
      const by = vouched.provider || `the mail server ${cfg.imap.host}`;
      console.warn(vouched.why === "unchecked"
        ? `[email] dropped — mail from ${fromAddr}: ${by} wrote no Authentication-Results line Tarsee can read${vouched.seen ? ` (the topmost one names ${vouched.seen})` : ""}, so nothing says who sent it`
        : `[email] dropped — mail from ${fromAddr}: ${by} doesn't vouch for that sender (${vouched.detail})`);
      if (vouched.why === "unchecked") noteUncheckedMail(fromAddr, vouched);
      return;
    }

    // Rate limit
    if (isRateLimited(fromAddr)) {
      console.warn(`[email] rate-limited ${fromAddr}`);
      return;
    }

    // Prefer text/plain; fall back to html-stripped
    const rawBody = mail.text || htmlToText(mail.html || "");
    const body = String(rawBody || "").slice(0, MAX_BODY_BYTES);
    const stripped = stripQuotedReply(body);
    const subject = mail.subject || "(no subject)";
    const mentioned = hasMention(stripped, cfg.mentionKeyword);
    const replyAll = isReplyAll({
      stripped, subject,
      keyword: cfg.mentionKeyword,
      marker: cfg.replyAllMarker,
    });

    // Thread key + conversation lookup
    const referencesHeader = mail.references || [];
    const references = Array.isArray(referencesHeader)
      ? referencesHeader
      : String(referencesHeader).split(/\s+/).filter(Boolean);
    const threadKey = threadKeyFromHeaders({
      messageId: mail.messageId,
      references,
    }) || `unknown-${Date.now()}`;
    const channelKey = `email:${threadKey}`;

    let convId = settingsStore.get(`channel_conv.${channelKey}`);
    if (!convId || !convStore.get(convId)) {
      const conv = convStore.create({
        title: `Email: ${subject.slice(0, 100)}`,
      });
      convId = conv.id;
      settingsStore.set(`channel_conv.${channelKey}`, convId);
    }

    // Save attachments to disk and build a text preamble referencing them.
    const attachmentNotes = await saveAttachments(mail.attachments || [], uploadsDir);

    // Compose the message we save to the conversation.
    // Prefix includes from/to/cc + mention-state so Claude has full context
    // even when it's absorbing a no-reply "context-only" email.
    const participants = [
      ...(mail.to?.value || []),
      ...(mail.cc?.value || []),
    ].map((a) => a.address).filter(Boolean);
    const ccList = (mail.cc?.value || []).map((a) => a.address).join(", ");
    const header = [
      `[email from ${fromAddr}]`,
      `Subject: ${subject}`,
      participants.length ? `To/Cc: ${participants.join(", ")}` : null,
      mentioned ? "Mention: yes — reply expected" : "Mention: no — CONTEXT ONLY, do not reply",
    ].filter(Boolean).join(" · ");

    const savedContent = [
      header,
      "",
      stripped,
      attachmentNotes ? "\n" + attachmentNotes : "",
    ].join("\n").trim();

    const savedUser = convStore.addMessage(convId, {
      role: "user",
      content: savedContent,
    });

    // If there's no mention, we're done — the message has been absorbed
    // into the conversation but we don't generate a reply.
    if (!mentioned) {
      console.log(`[email] context-only from ${fromAddr} (subject: "${subject.slice(0, 40)}")`);
      return;
    }

    // Process commands ("/something") before engaging the AI. __PLAYBOOK__
    // sentinel responses are forwarded to the AI as the user's turn instead
    // of being mailed back verbatim.
    let aiPromptOverride = null;
    if (stripped.startsWith("/")) {
      try {
        const cmdResult = await processCommand(stripped, {
          settingsStore, convStore,
          conversationId: convId,
          platform: "email", // was missing — platform-gated commands misrouted
          // Never the owner, for the owner's commands (/cron, /briefing, /webhook: lib/commands.js): a From address,
          // allowlisted or not, is easy to fake.
          owner: false,
          db,                // was missing — /clear silently no-op'd
        });
        if (cmdResult?.handled) {
          const playbook = extractPlaybookPrompt(cmdResult);
          if (playbook) {
            aiPromptOverride = playbook;
          } else {
            await sendReply({
              incoming: mail,
              bodyText: cmdResult.response,
              replyAll,
            });
            return;
          }
        }
      } catch (err) {
        console.warn("[email] command handler error:", err?.message);
      }
    }

    // Engage the AI. Same pipeline as Discord/Telegram. Which AI answers is the turn layer's to decide (ai/turn.js:
    // this conversation's own pick, else the default), and so is saying what to set up when that AI isn't ready.
    const history = convStore.getRecentMessages(convId, HISTORY_WINDOW);
    const conv = convStore.get(convId);
    const systemParts = buildSystemPromptParts({
      settingsStore, db,
      conversationId: convId,
      messageCount: history.length,
      conversationPrompt: conv?.system_prompt,
      channelHint: "You are in an email conversation. Keep your reply in plain text — it will be sent as the email body. No markdown tables, no markdown code fences unless the content is literally code. Stay concise; emails shouldn't be 5 pages long.",
    });

    let fullResponse = "";
    // Token usage for this turn — drives Settings -> Token Health.
    let tokenUsage = {};
    // One turn at a time per conversation. Without this, two messages in the
    // same chat started two turns that both resumed the SAME Claude session
    // id, appending to one transcript from two processes. Replies interleaved
    // and the session could be left corrupt enough to break every later turn.
    await withConversationTurn(convId, async () => {
    try {
      // messageId: the message this turn answers (its files are kept on it, not on whatever came in later)
      const toolCtx = { db, settingsStore, conversationId: convId, messageId: savedUser?.id || null };
      const workingMessages = history.map((m) => ({ role: m.role, content: m.content }));
      // Slash-command playbooks: swap the AI-visible last user turn for
      // the playbook body while the stored email/message stays as-sent.
      if (aiPromptOverride && workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") last.content = aiPromptOverride;
      }
      // The very last message is the one we just saved — already has the
      // full context prefix, so the AI sees the whole picture.
      // One call per mail. The engine runs its own tools and ends the turn itself, and the turn layer (ai/turn.js)
      // retries, once and fresh, a session the engine couldn't resume. Email never calls the AI again on its own: it
      // used to call again for as long as a turn ended on a tool, mailing the same answer over and over.
      let routed = null; // the AI this turn runs on, from the turn layer's route event
      let surfacedError = null;
      const stream = streamChat({
        liveSource: "email",
        messages: workingMessages,
        systemParts,
        toolCtx,
        sessionId: convStore.getSessionHandle(convId),
        onSessionId: (handle) => convStore.setSessionHandle(convId, handle),
      });
      for await (const event of stream) {
        if (event.type === "route") routed = event;
        else if (event.type === "text") fullResponse += event.content;
        else if (event.type === "error") surfacedError = event.message || "something went wrong";
        else if (event.type === "usage") tokenUsage = { ...tokenUsage, ...event.usage };
        else if (event.type === "done") break;
      }

      // Persist + save any [REMEMBER:…] markers
      fullResponse = extractAndSaveMemories(fullResponse, db, convId).trim();
      if (fullResponse) {
        convStore.addMessage(convId, {
          role: "assistant",
          content: fullResponse,
          provider: routed?.provider || null,
          model: routed?.model || null,
          tokensIn: (tokenUsage.input_tokens || 0)
            + (tokenUsage.cache_read_input_tokens || 0)
            + (tokenUsage.cache_creation_input_tokens || 0) || null,
          tokensOut: tokenUsage.output_tokens ?? null,
        });
      }

      // An error the turn reported (already in plain words: what went wrong, what to do) goes after whatever was said
      // before it, but not again when the reply is the error itself (the turn layer's "set this up first" answers).
      const parts = [fullResponse];
      if (surfacedError && errorStillToSay(fullResponse, surfacedError)) {
        parts.push(turnErrorNote(routed, surfacedError, { clearHint: "reply with /clear", plain: true }));
      }
      const bodyText = parts.filter(Boolean).join("\n\n") || "(no response)";

      await sendReply({
        incoming: mail,
        bodyText,
        replyAll,
      });
    } catch (err) {
      console.error("[email] chat error:", err?.message);
      await sendReply({
        incoming: mail,
        bodyText: "Sorry, I hit an error processing your email. Try again?",
        replyAll,
      }).catch(() => {});
    }
    }, {
      // Waiting behind the reply in progress: a "Queued" line on the dashboard.
      live: { source: "email", prompt: stripped || savedContent },
    });
  }

  /**
   * The one-time note in Settings > Channels > Email (SENDER_NOTE_KEY) that mail to this mailbox was refused because
   * nothing in it said who sent it: written for the first such mail only, once per mail server. The owner's OK on it
   * only hides it (dismissedAt); a change of server or of what Tarsee trusts there clears it (routes/settings.js).
   */
  function noteUncheckedMail(fromAddr, vouched) {
    try {
      const was = settingsStore.get(SENDER_NOTE_KEY);
      if (was && String(was.host || "").toLowerCase() === String(cfg.imap.host).toLowerCase()) return;
      settingsStore.set(SENDER_NOTE_KEY, {
        host: cfg.imap.host,
        at: new Date().toISOString(),
        from: fromAddr.slice(0, 254),
        provider: vouched.provider,
        seen: vouched.seen ? vouched.seen.replace(/[^a-z0-9._-]/gi, "").slice(0, 120) : null,
      });
    } catch (err) {
      console.warn("[email] couldn't save the note for Settings:", err?.message);
    }
  }

  /**
   * Send an email reply preserving thread headers.
   */
  async function sendReply({ incoming, bodyText, replyAll }) {
    const built = buildReplyMail({ incoming, bodyText, replyAll }, sender);
    if (!built) {
      console.warn("[email] no recipients resolved — skipping send");
      return;
    }
    const { mail, recipients } = built;
    await smtp.sendMail(mail);
    console.log(`[email] sent reply to ${recipients.to.join(",")} ${recipients.cc.length ? `cc ${recipients.cc.join(",")}` : ""}`);
  }

  /**
   * Save inbound attachments to WORKSPACE_DIR/uploads/ and return a text
   * block describing them so Claude can Read the files via its Read tool.
   */
  async function saveAttachments(attachments, dir) {
    if (!Array.isArray(attachments) || attachments.length === 0) return "";
    const notes = [];
    let saved = 0;
    for (const att of attachments) {
      if (saved >= MAX_ATTACHMENTS) {
        notes.push(`[attachment limit reached — dropped ${attachments.length - saved} more]`);
        break;
      }
      try {
        const buf = att.content;
        if (!buf || !Buffer.isBuffer(buf)) continue;
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          notes.push(`[Attachment too large (${Math.round(buf.length/1024/1024)}MB): ${att.filename || "(unnamed)"} — not saved]`);
          continue;
        }
        const safe = String(att.filename || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
        const filePath = path.join(dir, `email-${Date.now()}-${safe}`);
        fs.writeFileSync(filePath, buf);
        const sizeKb = Math.round(buf.length / 1024);
        notes.push(`[Email attachment saved: ${att.filename || "file"} (${att.contentType || "unknown"}, ${sizeKb}KB) → ${filePath}]\nYou can read this file with the Read tool at: ${filePath}`);
        saved++;
      } catch (err) {
        console.warn("[email] attachment save failed:", err?.message);
      }
    }
    return notes.join("\n");
  }

  // Check the SMTP login first: refused, or a server that doesn't offer the TLS the settings require, no reply could
  // ever be sent, so the channel fails with what to do about it. A server that can't be reached only warns (inbound
  // still works, and some hosts block outbound SMTP), unless its name doesn't exist at all; so does one that offers
  // STARTTLS and turns it down (each reply asks again, and never logs in without TLS where the settings require it).
  // Bounded, as nodemailer would wait up to two minutes on a server that never answers.
  const smtpOptions = smtpTransportOptions(cfg.smtp);
  const smtpServer = { host: cfg.smtp.host, port: smtpOptions.port, user: cfg.smtp.user, requireTLS: smtpOptions.requireTLS === true };
  try {
    await withDeadline(smtp.verify(), 15_000, Object.assign(new Error("SMTP check timed out"), { code: "ETIMEDOUT" }));
  } catch (err) {
    const why = mailServerError(err, "SMTP", smtpServer);
    const onlyWarns = why && (why.kind === "tls-warning" || (why.kind === "tls" && why.temporary));
    if (why && !onlyWarns && (why.kind !== "unreachable" || why.notFound)) {
      smtp.close();
      throw why.kind === "unreachable" ? new Error(why.message) : refused(why.message);
    }
    console.warn(`[email] SMTP check failed (continuing anyway): ${why?.message || err.message}`);
  }

  // Kick off connection. Errors surface to the caller so the ChannelManager
  // records a proper "error" status, put as what to fix where we can. A failed
  // first connect must not leave the reconnect loop running behind it.
  try {
    await connect();
  } catch (err) {
    shuttingDown = true;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    try { client?.close(); } catch {}
    try { smtp.close(); } catch {}
    const imapServer = { host: cfg.imap.host, port: cfg.imap.port || 993, user: cfg.imap.user, requireTLS: cfg.imap.secure === false && cfg.imap.requireTLS === true };
    const why = mailServerError(err, "IMAP", imapServer);
    if (why) throw why.kind === "unreachable" || why.temporary ? new Error(why.message) : refused(why.message);
    throw err;
  }

  return {
    /** The mailbox it listens on, for Settings → Channels. */
    identity: selfAddress,
    /**
     * Stop the IMAP listener + close SMTP. Idempotent.
     */
    stop: async () => {
      shuttingDown = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      try { await client?.logout(); } catch {}
      try { smtp.close(); } catch {}
    },

    /**
     * Outbound from ChannelManager.sendMessage(type, chatId, message).
     * chatId here = target email address (or comma-separated list).
     */
    sendMessage: async (chatId, message) => {
      await smtp.sendMail(buildDirectMail(chatId, message, sender));
    },

    /**
     * Proactively start or continue a thread (used by the
     * tarsee_send_email_thread MCP tool).
     *
     * @param {object} opts
     * @param {string|string[]} opts.to
     * @param {string|string[]} [opts.cc]
     * @param {string} opts.subject
     * @param {string} opts.body
     * @param {string} [opts.inReplyTo]  Message-ID to thread under
     * @returns {Promise<{messageId: string}>}
     */
    /**
     * @param {Array<{path: string, filename?: string}>} [opts.attachments]
     *        Files to attach as real MIME parts. Pass these instead of inlining
     *        `<#part>` / Mutt-style markup in the body — that markup is plain
     *        text to nodemailer and ships verbatim to the recipient.
     */
    sendNew: async (opts) => {
      const { mail, attachmentCount } = buildNewMail(opts, sender);
      const info = await smtp.sendMail(mail);
      return { messageId: info.messageId, attachmentCount };
    },
  };
}

// ── What Tarsee sends, built apart from the sending (test/email-smtp.test.js
//    sends these through nodemailer to a local SMTP server) ──────────────────

/**
 * nodemailer's SMTP transport options: port 465 is implicit TLS; any other port upgrades with STARTTLS when offered,
 * or, with requireTLS (saved by tarsee_configure_email_channel), must upgrade before the login.
 */
export function smtpTransportOptions(smtpCfg = {}) {
  const port = smtpCfg.port || 465;
  const secure = smtpCfg.secure !== false && port === 465;
  return {
    host: smtpCfg.host,
    port,
    secure,
    ...(smtpCfg.requireTLS && !secure ? { requireTLS: true } : {}),
    auth: { user: smtpCfg.user, pass: smtpCfg.password },
  };
}

// ── Who really sent a mail: the mailbox provider's word, not the From line (test/email-sender-check.test.js) ────────

/** The one-time note in Settings > Channels > Email when mail was refused because nothing said who sent it. */
export const SENDER_NOTE_KEY = "channel.email-sender-note";

/**
 * The mailbox providers whose Authentication-Results lines (RFC 8601) Tarsee knows, by the IMAP host it reads mail
 * from: the authserv-id they write, and which of the topmost lines are theirs.
 *   "top": one line, the topmost in the mail (Gmail, Microsoft 365 and Outlook.com, Yahoo and AOL, Zoho).
 *   "block": several, all above the Received line of the hop that brought the mail in: iCloud writes one per check,
 *     each with its own name (dmarc.icloud.com, dkim-verifier.icloud.com, ...); Fastmail writes four with the MX host's
 *     name, the verdicts in the last.
 * Microsoft writes no authserv-id at all: its line starts with "spf=".
 */
const MAIL_PROVIDERS = [
  { name: "Gmail", imap: /^imap\.(gmail|googlemail)\.com$/, id: (id) => id === "mx.google.com", lines: "top" },
  { name: "Microsoft 365", imap: /^(outlook\.office365\.com|outlook\.office\.com|imap-mail\.outlook\.com)$/, id: (id) => id === "", lines: "top" },
  { name: "iCloud", imap: /^(p\d+-)?imap\.mail\.me\.com$/, id: (id) => id.endsWith(".icloud.com"), lines: "block" },
  { name: "Fastmail", imap: /^(imap\.fastmail\.com|mail\.messagingengine\.com)$/, id: (id) => id.endsWith(".messagingengine.com"), lines: "block" },
  { name: "Yahoo", imap: /^((export\.)?imap\.mail\.yahoo\.com|imap\.aol\.com)$/, id: (id) => id.endsWith(".yahoo.com"), lines: "top" },
  {
    name: "Zoho",
    imap: /^imap(pro)?\.zoho\.(com|eu|in|com\.au|jp|com\.cn|sa|ca)$/,
    id: (id) => /^mx\d*\.zoho(mail)?\.(com|eu|in|com\.au|jp|com\.cn|sa|ca)$/.test(id),
    lines: "top",
  },
];

/** The provider Tarsee knows for this IMAP host ({ name, ... }), or null for one it doesn't (a self-hosted server). */
export function mailProviderOf(imapHost) {
  const host = String(imapHost || "").trim().toLowerCase().replace(/\.$/, "");
  return MAIL_PROVIDERS.find((p) => p.imap.test(host)) || null;
}

/**
 * What the owner set in Settings > Channels > Email for the mail server Tarsee reads now: { trustFromLine, authservId }.
 * It is kept with the IMAP host it was set for (senderCheck.imapHost), so it never carries over to another server.
 */
export function senderCheckFor(senderCheck, imapHost) {
  const s = senderCheck && typeof senderCheck === "object" ? senderCheck : {};
  const same = typeof s.imapHost === "string" && s.imapHost.trim().toLowerCase() === String(imapHost || "").trim().toLowerCase();
  return {
    trustFromLine: same && s.trustFromLine === true,
    authservId: same && typeof s.authservId === "string" ? s.authservId.trim().toLowerCase() : "",
  };
}

/** Methods that start a result even where a ";" was left out (an older Zoho line reads "dkim=pass spf=pass ..."). */
const AUTH_METHODS = new Set(["auth", "dkim", "dkim2", "domainkeys", "iprev", "sender-id", "spf", "dmarc", "arc", "bimi", "rrvs", "smime", "vbr", "dnswl", "compauth"]);

/** An Authentication-Results value as words and ";" separators: comments dropped, a quoted string kept in its word. */
function authResultsWords(text) {
  const words = [];
  let word = "";
  let depth = 0;
  const end = () => { if (word) words.push(word); word = ""; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (depth > 0) {
      if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      continue;
    }
    if (c === "(") { end(); depth = 1; continue; }
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\") i++;
        word += text[i] ?? "";
      }
      continue;
    }
    if (c === ";") { end(); words.push(";"); continue; }
    if (/\s/.test(c)) { end(); continue; }
    word += c;
  }
  end();
  return words;
}

/**
 * One Authentication-Results value (what follows "Authentication-Results:"): { authservId, results }, authservId ""
 * when the line names none (Microsoft's), each result { method, result, props } with props such as header.d,
 * header.i, header.from, smtp.mailfrom (the first of each).
 */
export function parseAuthResults(value) {
  const words = authResultsWords(String(value || "").replace(/\r?\n/g, " "));
  let i = 0;
  let authservId = "";
  if (words.length && words[0] !== ";" && !words[0].includes("=")) {
    authservId = words[0].toLowerCase();
    i = 1;
    if (/^\d+$/.test(words[i] || "")) i++; // authres-version
  }
  const results = [];
  let current = null;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === ";") { current = null; continue; }
    const eq = w.indexOf("=");
    if (eq <= 0) continue;
    const key = w.slice(0, eq).toLowerCase();
    const val = w.slice(eq + 1);
    if (!key.includes(".") && (current === null || AUTH_METHODS.has(key))) {
      current = { method: key, result: val.toLowerCase(), props: {} };
      results.push(current);
    } else if (current && key.includes(".") && !(key in current.props)) {
      current.props[key] = val;
    }
  }
  return { authservId, results };
}

/** The domain of an address or domain as these lines write them: "owner@example.com", "@example.com", "<a@b>". */
function domainOf(v) {
  const s = String(v || "").trim().replace(/^<|>$/g, "");
  return s.slice(s.lastIndexOf("@") + 1).toLowerCase().replace(/\.$/, "");
}

/** DMARC's relaxed alignment, as far as it can be told without a public-suffix list: the same domain, or one inside the other. */
function aligned(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.includes(".") && long.endsWith(`.${short}`);
}

/**
 * Whether the owner's own mailbox provider vouches for the sender of a mail (mailparser's headerLines, top first, and
 * the From address): the provider's topmost Authentication-Results line, from the provider's own authserv-id, says
 * dmarc=pass for the From domain, or dkim=pass with header.d (else header.i) aligned to it, or spf=pass with
 * smtp.mailfrom aligned to it. A dmarc=fail there is final. Lines lower down are the sender's to write and are never
 * read. The provider is known by the IMAP host (mailProviderOf); for a server Tarsee doesn't know, the owner names its
 * authserv-id in Settings, or says it checks nothing and the From line is to be trusted (senderCheck).
 * { ok: true, by: "dmarc"|"dkim"|"spf"|"from-line", provider } or
 * { ok: false, why: "unchecked" (no line Tarsee can read as the provider's) | "failed", provider, seen?, detail? }:
 * provider is its name, or the owner's name for their server, or null; seen is the topmost line's authserv-id.
 */
export function senderVouched(headerLines, fromAddress, { imapHost = "", senderCheck = null } = {}) {
  const lines = Array.isArray(headerLines) ? headerLines : [];
  const own = senderCheckFor(senderCheck, imapHost);
  const known = mailProviderOf(imapHost);
  // A name the owner gave counts too, for a provider that names itself in a way Tarsee doesn't expect.
  const ownId = (id) => !!own.authservId && id === own.authservId;
  const profile = known
    ? { ...known, id: (id) => known.id(id) || ownId(id) }
    : own.authservId ? { name: own.authservId, id: ownId, lines: "top" } : null;
  const provider = profile?.name ?? null;
  if (own.trustFromLine) return { ok: true, by: "from-line", provider };

  if (lines.filter((h) => h.key === "from").length !== 1) return { ok: false, why: "failed", provider, detail: "more than one From line" };
  const fromDomain = domainOf(fromAddress);
  if (!fromDomain) return { ok: false, why: "failed", provider, detail: "no From address" };

  const valueOf = (h) => String(h.line || "").slice(String(h.line || "").indexOf(":") + 1);
  const top = lines.findIndex((h) => h.key === "authentication-results");
  const topLine = top >= 0 ? parseAuthResults(valueOf(lines[top])) : null;
  const seen = topLine ? topLine.authservId.slice(0, 120) : null;
  if (!profile || !topLine || !profile.id(topLine.authservId)) return { ok: false, why: "unchecked", provider, seen };

  // The provider's lines: the topmost one, or the run of its lines above the Received of the hop that brought the
  // mail in (anything below that hop is the sender's).
  const block = [topLine];
  if (profile.lines === "block" && lines.slice(top + 1).some((h) => h.key === "received")) {
    for (let i = top + 1; i < lines.length && lines[i].key !== "received"; i++) {
      if (lines[i].key !== "authentication-results") continue;
      const next = parseAuthResults(valueOf(lines[i]));
      if (!profile.id(next.authservId)) break;
      block.push(next);
    }
  }
  const results = block.flatMap((b) => b.results);

  const dmarc = results.find((r) => r.method === "dmarc");
  const dmarcFor = dmarc ? domainOf(dmarc.props["header.from"]) : "";
  if (dmarc?.result === "pass" && dmarcFor === fromDomain) return { ok: true, by: "dmarc", provider };
  const said = ["dmarc", "dkim", "spf"]
    .map((m) => results.find((r) => r.method === m))
    .filter(Boolean)
    .map((r) => `${r.method}=${r.result}`)
    .join(", ") || "no DMARC, DKIM or SPF verdict";
  if (dmarc?.result === "fail" && (!dmarcFor || dmarcFor === fromDomain)) return { ok: false, why: "failed", provider, detail: said };
  const dkim = results.some((r) => r.method === "dkim" && r.result === "pass" && aligned(domainOf(r.props["header.d"] || r.props["header.i"]), fromDomain));
  if (dkim) return { ok: true, by: "dkim", provider };
  const spf = results.find((r) => r.method === "spf");
  if (spf?.result === "pass" && aligned(domainOf(spf.props["smtp.mailfrom"]), fromDomain)) return { ok: true, by: "spf", provider };
  return { ok: false, why: "failed", provider, detail: said };
}

// ── What a save may change on its own, for the owner's save in Settings > Channels > Email (routes/settings.js) and
//    the chat tool (lib/tools.js configure_email_channel), so both go by the same rules ───────────────────────────────

/**
 * The mail server one side of the settings logs in to, as the channel connects: { host, port, user, secure }. No port
 * means 993 for IMAP and 465 for SMTP; secure is on unless it is false. A saved password goes only to this server.
 */
export function mailServerOf(side, s) {
  const was = s && typeof s === "object" ? s : {};
  return {
    host: typeof was.host === "string" ? was.host.trim() : "",
    port: Number(was.port) || (side === "imap" ? 993 : 465),
    user: typeof was.user === "string" ? was.user.trim() : "",
    secure: was.secure !== false,
  };
}

/** What makes `next` another server than `saved` (both as mailServerOf gives them): "host" (in any case), "port", "user", "secure setting". */
export function mailServerChanges(saved, next) {
  return [
    next.host.toLowerCase() !== saved.host.toLowerCase() && "host",
    next.port !== saved.port && "port",
    next.user !== saved.user && "user",
    next.secure !== saved.secure && "secure setting",
  ].filter(Boolean);
}

/** An allowlist as the channel reads it: lower case, trimmed, no blanks, each address once. */
export function normalizeAllowlist(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const address = String(a).toLowerCase().trim();
    if (address && !out.includes(address)) out.push(address);
  }
  return out;
}

/** Whether two allowlists hold the same addresses, in any order. */
export function sameAllowlist(a, b) {
  const x = normalizeAllowlist(a).sort();
  const y = normalizeAllowlist(b).sort();
  return x.length === y.length && x.every((address, i) => address === y[i]);
}

// ── What waits for the owner's OK (test/email-config-tool.test.js, test/email-channel-settings.test.js) ────────────

/**
 * Whom the owner allowed to reach the AI by email: { anyone, addresses }. Their list is the one they last saved in
 * Settings > Channels > Email or OK'd there (allowlistOwner; an empty one is their choice of any sender). Settings
 * saved before Tarsee kept it have none, and then a list in force counts as the owner's. No list at all is nobody:
 * "no list saved" never means the owner let anyone in.
 */
export function ownerAllowed(cfg) {
  if (Array.isArray(cfg?.allowlistOwner)) {
    const addresses = normalizeAllowlist(cfg.allowlistOwner);
    return { anyone: addresses.length === 0, addresses };
  }
  const old = cfg && typeof cfg === "object" && !("allowlistOwner" in cfg) ? normalizeAllowlist(cfg.allowlistFromAddresses) : [];
  return { anyone: false, addresses: old };
}

/** Who can reach the AI by email with these settings in force: nobody while email is off, any sender with an empty list. */
function reachableNow(cfg) {
  if (cfg?.enabled !== true) return { anyone: false, addresses: [] };
  const addresses = normalizeAllowlist(cfg.allowlistFromAddresses);
  return { anyone: addresses.length === 0, addresses };
}

/**
 * Whom the list `asked` lets reach the AI by email that `allowed` ({ anyone, addresses }) doesn't. An empty list lets
 * any sender in. null for nobody, else { anyone: true, added: [] } or { anyone: false, added }.
 */
export function allowlistWidening(asked, allowed) {
  if (allowed?.anyone) return null;
  const want = normalizeAllowlist(asked);
  if (want.length === 0) return { anyone: true, added: [] };
  const have = allowed?.addresses || [];
  const added = want.filter((address) => !have.includes(address));
  return added.length ? { anyone: false, added } : null;
}

/** The parts of a waiting record (cfg.waiting) that are well formed: enabled, imap, smtp, allowlistFromAddresses, senderCheck. */
function waitingParts(w) {
  const out = {};
  if (!w || typeof w !== "object") return out;
  if (w.enabled === true) out.enabled = true;
  for (const side of ["imap", "smtp"]) {
    if (w[side] && typeof w[side] === "object" && !Array.isArray(w[side])) out[side] = w[side];
  }
  if (Array.isArray(w.allowlistFromAddresses)) out.allowlistFromAddresses = normalizeAllowlist(w.allowlistFromAddresses);
  if (w.senderCheck && typeof w.senderCheck === "object") out.senderCheck = ownSenderCheck(w.senderCheck);
  return out;
}

/** The owner's sender-check fields as given: { trustFromLine, authservId } (authservId lower case, "" for none). */
function ownSenderCheck(s) {
  return {
    trustFromLine: s?.trustFromLine === true,
    authservId: typeof s?.authservId === "string" ? s.authservId.trim().toLowerCase() : "",
  };
}

/** Whether `next` trusts more than `now` to say who sent a mail: the From line, or a server name it didn't. */
function trustsMore(now, next) {
  return (next.trustFromLine && !now.trustFromLine) || (!!next.authservId && next.authservId !== now.authservId);
}

/** Whether a server is another mailbox (IMAP: the one Tarsee reads) or another place replies go (SMTP): its host or user. */
function anotherMailbox(side, from, to) {
  const a = mailServerOf(side, from);
  const b = mailServerOf(side, to);
  return a.host.toLowerCase() !== b.host.toLowerCase() || a.user !== b.user;
}

/** The waiting parts the settings in force (cfg) haven't made moot: a part the owner has since put in force goes. */
function stillWaiting(cfg, parts) {
  const out = { ...parts };
  if (out.enabled && cfg.enabled === true) delete out.enabled;
  for (const side of ["imap", "smtp"]) {
    if (out[side] && mailServerChanges(mailServerOf(side, cfg[side]), mailServerOf(side, out[side])).length === 0) delete out[side];
  }
  if (out.allowlistFromAddresses && !allowlistWidening(out.allowlistFromAddresses, ownerAllowed(cfg))) delete out.allowlistFromAddresses;
  if (out.senderCheck && !trustsMore(senderCheckFor(cfg.senderCheck, cfg.imap?.host), out.senderCheck)) delete out.senderCheck;
  return out;
}

/**
 * cfg with `parts` as what waits (none: nothing waits). A record whose parts changed gets a new id (the owner's OK
 * names it, so a page showing an older one can't OK this) and time, and says who asked (`by`: "ai" or "token").
 */
function withWaiting(cfg, before, parts, by, now = new Date()) {
  const out = { ...cfg };
  delete out.waiting;
  if (Object.keys(parts).length === 0) return out;
  const same = before && typeof before.id === "string" && isDeepStrictEqual(waitingParts(before), parts);
  out.waiting = same
    ? { ...parts, id: before.id, since: before.since, by: before.by }
    : { ...parts, id: crypto.randomUUID(), since: now.toISOString(), by: by || before?.by || "ai" };
  return out;
}

/**
 * A save from a caller that may be the AI: the chat tool ("ai"), or the API token without the owner's live sign-in
 * ("token"), which the AI's shell can read. What would change who can reach the AI by email, or where its mail goes,
 * isn't put in force: it is saved as waiting (cfg.waiting) for the owner's OK in Settings > Channels > Email, as a
 * scheduled task the AI makes is saved switched off (lib/cron.js). That is:
 *   - turning email on;
 *   - another IMAP host or user: the mailbox Tarsee reads, and whoever controls a mailbox can put any mail in it;
 *   - another SMTP host or user: where its replies go;
 *   - an allowlist that lets in anyone the owner hasn't allowed (ownerAllowed) and who can't reach the AI now;
 *   - trusting more to say who sent a mail (senderCheck), which only the API token can ask for.
 * What narrows goes straight in: senders removed, email off, the mention word, the display name, a port. For each part
 * the call asks about (asked: { enabled, imap, smtp, allowlist, senderCheck }) the latest ask replaces what waited.
 * The owner's own list and sender check change only with their save or OK.
 * prev: the settings saved now. next: prev with the call's changes, the servers already checked (one that changes
 * carries its own password), next.senderCheck the { trustFromLine, authservId } asked for.
 * Returns { cfg: what to save, held: the parts this call left waiting }.
 */
export function holdForOwner(prev, next, asked, by, now = new Date()) {
  const was = prev && typeof prev === "object" ? prev : {};
  const cfg = { ...next };
  delete cfg.allowlistOwner;
  delete cfg.senderCheck;
  delete cfg.waiting;
  if ("allowlistOwner" in was) cfg.allowlistOwner = was.allowlistOwner;
  if (was.senderCheck !== undefined) cfg.senderCheck = was.senderCheck;
  const parts = waitingParts(was.waiting);
  const held = [];
  if (asked.enabled) {
    if (next.enabled === true && was.enabled !== true) {
      cfg.enabled = false;
      parts.enabled = true;
      held.push("enabled");
    } else {
      delete parts.enabled;
    }
  }
  for (const side of ["imap", "smtp"]) {
    if (!asked[side]) continue;
    if (anotherMailbox(side, was[side], next[side])) {
      cfg[side] = was[side] && typeof was[side] === "object" ? was[side] : {};
      parts[side] = next[side];
      held.push(side);
    } else {
      delete parts[side];
    }
  }
  if (asked.allowlist) {
    const list = normalizeAllowlist(next.allowlistFromAddresses);
    if (allowlistWidening(list, ownerAllowed(was)) && allowlistWidening(list, reachableNow(was))) {
      cfg.allowlistFromAddresses = Array.isArray(was.allowlistFromAddresses) ? was.allowlistFromAddresses : [];
      parts.allowlistFromAddresses = list;
      held.push("allowlist");
    } else {
      cfg.allowlistFromAddresses = list;
      delete parts.allowlistFromAddresses;
    }
  }
  if (asked.senderCheck) {
    const want = ownSenderCheck(next.senderCheck);
    if (trustsMore(senderCheckFor(was.senderCheck, cfg.imap?.host), want)) {
      parts.senderCheck = want;
      held.push("senderCheck");
    } else {
      cfg.senderCheck = { imapHost: cfg.imap?.host || "", ...want };
      delete parts.senderCheck;
    }
  }
  return { cfg: withWaiting(cfg, was.waiting, stillWaiting(cfg, parts), by, now), held };
}

/**
 * The owner's own save from Settings > Channels > Email: everything in it is in force. What waited stays waiting
 * (a save isn't an answer to it), except a part the save has made moot.
 */
export function ownerSaved(cfg, now = new Date()) {
  const before = cfg?.waiting;
  return withWaiting(cfg, before, stillWaiting(cfg, waitingParts(before)), before?.by, now);
}

/**
 * The settings once the owner OKs what waits (cfg.waiting): it goes in force. When it turns email on or sets the
 * allowlist, the list in force is the owner's from then on (allowlistOwner).
 */
export function applyWaiting(cfg) {
  const parts = stillWaiting(cfg, waitingParts(cfg?.waiting));
  const out = { ...cfg };
  delete out.waiting;
  if (parts.enabled) out.enabled = true;
  for (const side of ["imap", "smtp"]) if (parts[side]) out[side] = parts[side];
  if (parts.allowlistFromAddresses) out.allowlistFromAddresses = parts.allowlistFromAddresses;
  if (parts.enabled || parts.allowlistFromAddresses) out.allowlistOwner = normalizeAllowlist(out.allowlistFromAddresses);
  if (parts.senderCheck) out.senderCheck = { imapHost: out.imap?.host || "", ...parts.senderCheck };
  return out;
}

/** What waits for the owner's OK, in plain words for the AI or a log: one line per part, [] when nothing waits. */
export function waitingSummary(cfg) {
  const w = stillWaiting(cfg || {}, waitingParts(cfg?.waiting));
  const server = (side, s) => {
    const m = mailServerOf(side, s);
    return m.host ? `${m.host}:${m.port} as ${m.user || "(no user)"}` : "not set up";
  };
  const lines = [];
  if (w.enabled) lines.push("turning email on");
  if (w.imap) lines.push(`IMAP, the mailbox Tarsee reads: ${server("imap", w.imap)} (in force now: ${server("imap", cfg.imap)})`);
  if (w.smtp) lines.push(`SMTP, where its replies go: ${server("smtp", w.smtp)} (in force now: ${server("smtp", cfg.smtp)})`);
  if (w.allowlistFromAddresses) {
    const more = allowlistWidening(w.allowlistFromAddresses, ownerAllowed(cfg));
    lines.push(more?.anyone || w.allowlistFromAddresses.length === 0
      ? "an empty allowlist, which lets any sender reach you by email"
      : `the allowlist ${w.allowlistFromAddresses.join(", ")}, which lets ${more ? more.added.join(", ") : "them"} reach you by email`);
  }
  if (w.senderCheck?.trustFromLine) lines.push("trusting the From line of mail to this mailbox");
  if (w.senderCheck?.authservId) lines.push(`trusting the Authentication-Results lines named ${w.senderCheck.authservId}`);
  return lines;
}

const UNREACHABLE_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE",
  "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT", // imapflow
  "EDNS", "ESOCKET", "ECONNECTION", "ETLS", // nodemailer (the system code is kept as originalCode)
]);

/**
 * The server's answer when it turned down STARTTLS: nodemailer's ETLS on the STARTTLS command carries the server's
 * reply ("454 4.7.0 TLS not available due to temporary reason", "502 5.5.1 Unrecognized command"), which is quoted;
 * imapflow's "Server does not support STARTTLS" (only with doSTARTTLS, which requireTLS sets) carries none, so "".
 * null for anything else: a TLS handshake that fails after a yes keeps its own words.
 */
function startTlsTurnedDown(err) {
  if (err.code === "ETLS" && err.command === "STARTTLS" && typeof err.response === "string" && err.response) {
    return err.response.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  return err.tlsFailed === true && /does not support STARTTLS/i.test(String(err.message || "")) ? "" : null;
}

/**
 * A mail server's refusal or silence, put as what to fix: { kind, message } with kind
 *   "login"        the server refused the login (usually a normal password where the provider wants an app password);
 *   "password"     none is saved;
 *   "tls"          the settings require TLS before the login (requireTLS) and the server didn't switch to it, so
 *                  nothing logs in. temporary: it answered with a 4xx ("not available just now"), else it doesn't offer
 *                  TLS on that port. Only with requireTLS: without it, a server that turns STARTTLS down did offer it
 *                  (nodemailer only asks then), so the port is right;
 *   "tls-warning"  that case: the server offers STARTTLS and turned it down, quoted, and replies wait until it works;
 *   "unreachable"  notFound: the host name doesn't exist.
 * null for anything else, which keeps its own words.
 * Reads imapflow's errors (authenticationFailed, responseText, tlsFailed) and nodemailer's (code EAUTH or ETLS, response).
 *
 * @param {Error} err
 * @param {"IMAP"|"SMTP"} protocol
 * @param {{host: string, port: number, user: string, requireTLS?: boolean}} server
 */
export function mailServerError(err, protocol, { host, port, user, requireTLS = false } = {}) {
  if (!err) return null;
  const text = String(err.message || "");
  if (text === "No password configured" || /^Missing credentials/.test(text) || err.code === "ENOAUTH") {
    return { kind: "password", message: `No ${protocol} password is saved for ${user}. Enter its app password and save again.` };
  }
  if (err.authenticationFailed || err.code === "EAUTH") {
    const said = String(err.responseText || (typeof err.response === "string" ? err.response : "")).replace(/\s+/g, " ").trim().slice(0, 200);
    return {
      kind: "login",
      message: `The mail server refused the ${protocol} login for ${user}. Use an app password, not your normal password (see the steps for your provider).${said ? ` The server said: ${said}` : ""}`,
    };
  }
  const reply = startTlsTurnedDown(err);
  if (reply !== null && requireTLS) {
    const said = reply ? ` The server said: ${reply}` : "";
    if (/^4/.test(reply)) {
      return {
        kind: "tls",
        temporary: true,
        message: `The ${protocol} server ${host}:${port} offers TLS (STARTTLS) but couldn't switch to it just now, and these settings require TLS before the login, so Tarsee won't ${protocol === "SMTP" ? "send replies" : "log in"} until it can.${said}`,
      };
    }
    const ports = protocol === "IMAP" ? "993 (TLS)" : "465 (TLS) or 587 (STARTTLS)";
    const what = reply ? "doesn't offer TLS (STARTTLS) on this port" : "won't switch to TLS (STARTTLS) on this port";
    return {
      kind: "tls",
      message: `The ${protocol} server ${host}:${port} ${what}, so Tarsee won't log in to it. Check the ${protocol} port: most providers take ${ports}.${said}`,
    };
  }
  if (reply) {
    return {
      kind: "tls-warning",
      message: `The ${protocol} server ${host}:${port} offers TLS (STARTTLS) but didn't switch to it, so replies can't be sent until it does. The server said: ${reply}`,
    };
  }
  const codes = [err.code, err.originalCode, err.cause?.code];
  if (codes.some((c) => UNREACHABLE_CODES.has(c))) {
    return { kind: "unreachable", notFound: codes.includes("ENOTFOUND"), message: `Could not reach ${host}:${port}. Check the ${protocol} host and port.` };
  }
  return null;
}

/** The promise, or a rejection with `error` once `ms` have passed. */
function withDeadline(promise, ms, error) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(error), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function fromHeader({ cfg, selfAddress }) {
  return `"${cfg.fromName || "Tarsee"}" <${selfAddress}>`;
}

/**
 * The reply to an incoming mail (as mailparser parsed it), keeping the thread:
 * { mail, recipients }, or null when nobody is left to send to.
 * sender: { cfg (normalized), selfAddress }
 */
export function buildReplyMail({ incoming, bodyText, replyAll }, sender) {
  const { cfg, selfAddress } = sender;
  const recipients = resolveRecipients({
    incoming: {
      from: incoming.from?.value?.[0],
      to: incoming.to?.value,
      cc: incoming.cc?.value,
      replyTo: incoming.replyTo?.value?.[0],
    },
    replyAll: !!replyAll,
    selfAddress,
  });
  if (recipients.to.length === 0) return null;

  const referencesArr = Array.isArray(incoming.references)
    ? incoming.references
    : String(incoming.references || "").split(/\s+/).filter(Boolean);
  const { inReplyTo, references } = buildReplyHeaders({
    incomingMessageId: incoming.messageId,
    references: referencesArr,
  });

  const replyParts = applySignature(String(bodyText || "").slice(0, 100_000), cfg.signature);
  return {
    recipients,
    mail: {
      from: fromHeader(sender),
      to: recipients.to.join(", "),
      cc: recipients.cc.length ? recipients.cc.join(", ") : undefined,
      subject: normalizeReplySubject(incoming.subject),
      text: replyParts.text,
      ...(replyParts.html ? { html: replyParts.html } : {}),
      inReplyTo,
      references,
    },
  };
}

/** A new mail, or one continuing a thread (tarsee_send_email_thread): { mail, attachmentCount }. */
export function buildNewMail({ to, cc, subject, body, inReplyTo, attachments }, sender) {
  const toArr = Array.isArray(to) ? to : String(to).split(",").map((s) => s.trim()).filter(Boolean);
  const ccArr = cc ? (Array.isArray(cc) ? cc : String(cc).split(",").map((s) => s.trim()).filter(Boolean)) : [];
  const atts = normalizeAttachments(attachments);
  const parts = applySignature(String(body || ""), sender.cfg.signature);
  return {
    attachmentCount: atts.length,
    mail: {
      from: fromHeader(sender),
      to: toArr.join(", "),
      cc: ccArr.length ? ccArr.join(", ") : undefined,
      subject: inReplyTo ? normalizeReplySubject(subject) : (subject || "(no subject)"),
      text: parts.text,
      ...(parts.html ? { html: parts.html } : {}),
      ...(atts.length ? { attachments: atts } : {}),
      inReplyTo,
      references: inReplyTo,
    },
  };
}

/** A plain message from ChannelManager.sendMessage; chatId is the address (or a comma-separated list). */
export function buildDirectMail(chatId, message, sender) {
  const to = String(chatId).split(",").map((s) => s.trim()).filter(Boolean);
  if (to.length === 0) throw new Error("email.sendMessage needs a target address in chatId");
  const parts = applySignature(String(message || ""), sender.cfg.signature);
  return {
    from: fromHeader(sender),
    to: to.join(", "),
    subject: sender.cfg.defaultSubject || "Tarsee message",
    text: parts.text,
    ...(parts.html ? { html: parts.html } : {}),
  };
}

/**
 * Accept either the flat legacy shape or a nested config — return the
 * canonical nested shape.
 */
export function normalizeConfig(c) {
  if (!c) return {};
  const out = {
    enabled: !!c.enabled,
    tarseeEmailAddress: c.tarseeEmailAddress || c.emailAddress || c.imap?.user || "",
    fromName: c.fromName || "Tarsee",
    defaultSubject: c.defaultSubject || "Tarsee",
    mentionKeyword: c.mentionKeyword || DEFAULT_MENTION_KEYWORD,
    replyAllMarker: c.replyAllMarker || DEFAULT_REPLY_ALL_MARKER,
    // Outbound signature — plain text, or HTML (rendered as multipart/alternative).
    signature: typeof c.signature === "string" ? c.signature : "",
    allowlistFromAddresses: Array.isArray(c.allowlistFromAddresses)
      ? c.allowlistFromAddresses
      : [],
    // What the owner trusts to say who sent a mail, for the IMAP host it was set for (senderVouched).
    senderCheck: c.senderCheck && typeof c.senderCheck === "object" ? c.senderCheck : null,
    imap: c.imap || {},
    smtp: c.smtp || {},
  };
  // Strip leading "@" from mentionKeyword — we always match with a prefix "@".
  if (out.mentionKeyword.startsWith("@")) out.mentionKeyword = out.mentionKeyword.slice(1);
  return out;
}


/**
 * Normalize an attachments spec into nodemailer's format. Accepts a path
 * string, an object with {path|filepath|file}, or a pass-through inline
 * content/cid attachment. Throws early if a path does not exist so the model
 * gets a real error instead of silently sending a mail with nothing attached.
 */
function normalizeAttachments(atts) {
  if (!atts) return [];
  const arr = Array.isArray(atts) ? atts : [atts];
  const out = [];
  for (const a of arr) {
    if (!a) continue;
    if (typeof a === "string") {
      if (!fs.existsSync(a)) throw new Error(`attachment path not found: ${a}`);
      out.push({ path: a, filename: path.basename(a) });
      continue;
    }
    if (typeof a !== "object") continue;
    const p = a.path || a.filepath || a.file;
    if (p) {
      if (!fs.existsSync(p)) throw new Error(`attachment path not found: ${p}`);
      out.push({ path: p, filename: a.filename || path.basename(p), contentType: a.contentType });
      continue;
    }
    if (a.content || a.raw) out.push(a); // inline content / cid
  }
  return out;
}

/**
 * Build the body + signature for nodemailer. Returns { text, html? }.
 * A plain-text signature is appended to the text part; an HTML signature
 * additionally produces a multipart/alternative html part so it renders.
 */
function applySignature(body, signature) {
  const bodyStr = String(body || "");
  const sig = (signature || "").trim();
  if (!sig) return { text: bodyStr };

  const isHtml = /<[a-z][^>]*>/i.test(sig);
  const trimmed = bodyStr.replace(/\s+$/, "");
  if (!isHtml) return { text: `${trimmed}\n\n${sig}\n` };

  return {
    text: `${trimmed}\n\n${htmlToText(sig)}\n`,
    html: `<div style="white-space:pre-wrap;font-family:-apple-system,Helvetica,Arial,sans-serif">${escapeHtml(bodyStr)}</div><br>${sig}`,
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
