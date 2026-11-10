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
 *   - The sender must be one the mailbox provider vouches for (its own Authentication-Results line, read strictly:
 *     senderVouched), as a From line is easy to fake; a self-hosted server needs the owner to type its name, or, if it
 *     checks nothing, the owner's "trust the From line", each for that exact mailbox
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
    const vouched = senderVouched(headers, fromAddr, { imapHost: cfg.imap.host, imapUser: cfg.imap.user, senderCheck: cfg.senderCheck });
    if (!vouched.ok) {
      const by = vouched.provider || `the mail server ${cfg.imap.host}`;
      // No name from the mail itself: the sender may have written it, and the owner might take it for their server's.
      console.warn(vouched.why === "unchecked"
        ? `[email] dropped — mail from ${fromAddr}: ${by} wrote no Authentication-Results line Tarsee trusts on top of it, so nothing says who sent it`
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
   * nothing in it said who sent it: written for the first such mail only, once per mailbox (IMAP host and user). It
   * holds nothing the mail wrote but the From address, which is on the owner's list: never a server name from the
   * mail, which the sender may have written. The owner's OK on it only hides it (dismissedAt); a change of mailbox or
   * of what Tarsee trusts there clears it (routes/settings.js).
   */
  function noteUncheckedMail(fromAddr, vouched) {
    try {
      const mailbox = { host: cfg.imap.host, user: cfg.imap.user };
      const was = settingsStore.get(SENDER_NOTE_KEY);
      if (was && sameMailbox(was, mailbox)) return;
      settingsStore.set(SENDER_NOTE_KEY, {
        host: cfg.imap.host,
        user: cfg.imap.user,
        at: new Date().toISOString(),
        from: fromAddr.slice(0, 254),
        provider: vouched.provider,
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

/** Nothing trusted: what the owner's sender check gives for any mailbox it wasn't set for. */
const NO_SENDER_CHECK = Object.freeze({ trustFromLine: false, authservId: "" });

/**
 * Whether two mailboxes ({ host, user }, as the settings or a sender check name them) are the same one: the same IMAP
 * host (in any case) and the same user. A mailbox with no host or no user is no mailbox.
 */
export function sameMailbox(a, b) {
  const host = (m) => (typeof m?.host === "string" ? m.host.trim().toLowerCase() : "");
  const user = (m) => (typeof m?.user === "string" ? m.user.trim() : "");
  return !!host(a) && !!user(a) && host(a) === host(b) && user(a) === user(b);
}

/**
 * What the owner set in Settings > Channels > Email for the mailbox Tarsee reads now (imap: { host, user }):
 * { trustFromLine, authservId }. It is kept with the exact mailbox it was set for (senderCheck.imapHost and imapUser),
 * so it never carries over to another server or another user, and it means nothing for a provider Tarsee knows: that
 * provider's own line is the only word on who sent a mail there.
 */
export function senderCheckFor(senderCheck, imap) {
  const s = senderCheck && typeof senderCheck === "object" ? senderCheck : {};
  if (mailProviderOf(imap?.host) || !sameMailbox({ host: s.imapHost, user: s.imapUser }, imap)) return { ...NO_SENDER_CHECK };
  return {
    trustFromLine: s.trustFromLine === true,
    authservId: typeof s.authservId === "string" ? s.authservId.trim().toLowerCase() : "",
  };
}

/** Method names: one of them as a bare name=value inside another result means a ";" is missing between the two. */
const AUTH_METHODS = new Set(["auth", "dkim", "dkim2", "domainkeys", "iprev", "sender-id", "spf", "dmarc", "arc", "bimi", "rrvs", "smime", "vbr", "dnswl", "compauth"]);
/** Checks that give one result per signature; every other check gives one verdict for the whole mail. */
const PER_SIGNATURE = new Set(["dkim", "dkim2", "domainkeys"]);
/** The properties Tarsee reads: each must be a plain address or domain. */
const READ_PROPERTIES = new Set(["header.d", "header.i", "header.from", "smtp.mailfrom"]);
const METHOD = /^[a-z0-9][a-z0-9_-]*(\/[0-9]+)?$/;
const KEYWORD = /^[a-z0-9][a-z0-9_-]*$/;
const PROPERTY = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_.-]*$/;
// Letters and digits of any script count (RFC 6531 addresses): they can't make a line read as something else.
const DOMAIN = /^(?=.{1,253}$)(?:[\p{L}\p{N}_](?:[\p{L}\p{N}_-]{0,61}[\p{L}\p{N}_])?\.)*[\p{L}\p{N}_](?:[\p{L}\p{N}_-]{0,61}[\p{L}\p{N}_])?$/u;
const DOT_ATOM = /^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-]+$/u;

/**
 * An Authentication-Results value as words and ";" (RFC 8601 over RFC 5322's lexical rules): { tokens, problem }.
 * A word is a run of text and quoted strings ("\" escapes the next character in one), kept as its parts so a "=" or
 * a local part inside quotes stays apart from one outside. Comments are dropped; they nest, and "\" escapes the next
 * character in them. With `quotesInComments`, a '"' inside a comment opens a quoted run in which "(" and ")" don't
 * count: how a provider that pasted an address with a quoted local part into a comment meant it to read.
 */
function authResultsTokens(text, quotesInComments) {
  const tokens = [];
  let word = null;
  const end = () => { if (word) tokens.push(word); word = null; };
  const add = (s, quoted) => {
    word ??= { t: "word", parts: [] };
    const last = word.parts.at(-1);
    if (last && last.quoted === quoted && !quoted) last.s += s;
    else word.parts.push({ s, quoted });
  };
  let i = 0;
  /** The quoted string at text[i] (a '"'), unescaped, with i after its closing '"'; null if it never closes. */
  const quotedString = () => {
    let s = "";
    for (i++; i < text.length; i++) {
      const c = text[i];
      if (c === "\\") {
        i++;
        if (i >= text.length) return null;
        s += text[i];
      } else if (c === '"') {
        i++;
        return s;
      } else {
        s += c;
      }
    }
    return null;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "(") {
      end();
      let depth = 0;
      while (i < text.length) {
        const d = text[i];
        if (d === "\\") { i += 2; continue; }
        if (d === '"' && quotesInComments) {
          if (quotedString() === null) return { tokens, problem: "a quoted part of a comment is never closed" };
          continue;
        }
        i++;
        if (d === "(") depth++;
        else if (d === ")" && --depth === 0) break;
      }
      if (depth > 0) return { tokens, problem: "a comment is never closed" };
    } else if (c === '"') {
      const s = quotedString();
      if (s === null) return { tokens, problem: "a quoted string is never closed" };
      add(s, true);
    } else if (c === ")") {
      return { tokens, problem: 'a ")" closes no comment' };
    } else if (c === "\\") {
      return { tokens, problem: 'a "\\" outside a quoted string or comment' };
    } else if (c === ";") {
      end();
      tokens.push({ t: ";" });
      i++;
    } else if (/\s/.test(c)) {
      end();
      i++;
    } else {
      add(c, false);
      i++;
    }
  }
  end();
  return { tokens: joinAroundEquals(tokens), problem: null };
}

/** A word's text, with its quoted parts unquoted. */
const wordText = (w) => w.parts.map((p) => p.s).join("");
/** Where a word's first "=" outside quotes is, in its text, or -1. */
function wordEquals(w) {
  let at = 0;
  for (const p of w.parts) {
    if (!p.quoted && p.s.includes("=")) return at + p.s.indexOf("=");
    at += p.s.length;
  }
  return -1;
}

/** RFC 8601 lets comments and space stand around "=": "dkim = pass" is one word, as "dkim=pass" is. */
function joinAroundEquals(tokens) {
  const out = [];
  for (const t of tokens) {
    const last = out.at(-1);
    if (t.t === "word" && last?.t === "word") {
      const lastEq = wordEquals(last);
      const startsWithEq = !t.parts[0].quoted && t.parts[0].s.startsWith("=");
      if ((lastEq === -1 && startsWithEq) || (lastEq === wordText(last).length - 1 && !startsWithEq)) {
        last.parts.push(...t.parts);
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

/** A word as name=value: { name, value, quotedName, quotedValue }, or null when it has no "=" outside quotes. */
function nameValue(w) {
  const eq = wordEquals(w);
  if (eq < 0) return null;
  let at = 0;
  let quotedName = false;
  let quotedValue = false;
  for (const p of w.parts) {
    if (p.quoted) {
      if (at < eq) quotedName = true;
      else quotedValue = true;
    }
    at += p.s.length;
  }
  const text = wordText(w);
  return { name: text.slice(0, eq), value: text.slice(eq + 1), quotedName, quotedValue };
}

/** What a word looked like, for a problem's words: short, and printable only. */
const shown = (w) => (w.t === "word" ? wordText(w) : w.t).replace(/[^\x20-\x7e]/g, "?").slice(0, 40);

/**
 * Whether a property value is a plain address or domain, as RFC 8601's pvalue writes one: [local-part "@"] domain,
 * here also in <...> (Zoho's header.from). A quoted local part may not hold what would let it pass for something
 * else in the line, and an address literal ("[...]") isn't a domain name.
 */
function plainAddress({ value, quotedValue }) {
  let s = value.trim();
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1);
  const at = s.lastIndexOf("@");
  const local = at >= 0 ? s.slice(0, at) : "";
  const domain = (at >= 0 ? s.slice(at + 1) : s).replace(/\.$/, "");
  if (!DOMAIN.test(domain)) return false;
  if (!local) return true;
  return quotedValue ? !/[()<>[\]:;@\\,"=]/.test(local) : DOT_ATOM.test(local);
}

/** One result (the words between two ";"): { method, result, props }, or a string saying why it isn't one. */
function authResultOf(words) {
  const [first, ...rest] = words;
  const head = first.t === "word" ? nameValue(first) : null;
  if (!head || head.quotedName || head.quotedValue) return `"${shown(first)}" isn't method=result`;
  const method = head.name.toLowerCase();
  const result = head.value.toLowerCase();
  if (!METHOD.test(method) || !KEYWORD.test(result)) return `"${shown(first)}" isn't method=result`;
  const out = { method: method.replace(/\/[0-9]+$/, ""), result, props: {} };
  for (const w of rest) {
    const p = w.t === "word" ? nameValue(w) : null;
    if (!p || p.quotedName || p.value === "") return `"${p ? p.name : shown(w)}" has no value`;
    const name = p.name.toLowerCase();
    // Older Zoho lines read "dkim=pass spf=pass ...": a result that ran into another can't be read for sure.
    if (AUTH_METHODS.has(name)) return `a ";" is missing before ${name}=`;
    // reason=..., and a name=value Tarsee doesn't read (Microsoft's action=, Fastmail's x-bits=), are left as they are.
    if (name === "reason" || !name.includes(".")) continue;
    if (!PROPERTY.test(name)) return `"${p.name}" isn't a property name`;
    if (name in out.props) return `${name} is given twice`;
    if (READ_PROPERTIES.has(name) && !plainAddress(p)) return `${name} isn't a plain address or domain`;
    out.props[name] = p.value;
  }
  return out;
}

/** The words of a reading, for comparing two readings of one line. */
const readingOf = (tokens) => JSON.stringify(tokens.map((t) => (t.t === "word" ? t.parts : t.t)));

/**
 * One Authentication-Results value (what follows "Authentication-Results:"), read strictly as RFC 8601 writes it:
 * { authservId, results, problem }. authservId is "" when the line names none (Microsoft's); each result is
 * { method, result, props } with the props Tarsee reads (header.d, header.i, header.from, smtp.mailfrom, ...).
 * problem says why the line doesn't read cleanly, and then results is empty: a comment or quoted string left open, a
 * stray ")" or "\", a result that isn't method=result, a ";" missing or doubled, a property with no value or given
 * twice, an address that isn't a plain one, or a line that reads two ways: a provider that pastes the envelope sender
 * (MAIL FROM, the sender's to choose) into a comment unescaped can have its comment closed early by a ")" in it. The
 * authserv-id is given even then, as far as it was read, so the line is still known as the provider's.
 */
export function parseAuthResults(value) {
  const text = String(value || "").replace(/\r?\n/g, " ");
  const strict = authResultsTokens(text, false);
  const unclean = (problem) => {
    const [first, second] = strict.tokens;
    const named = first?.t === "word" && wordEquals(first) < 0 && (!second || second.t === ";" || /^[0-9]+$/.test(second.t === "word" ? wordText(second) : ""));
    return { authservId: named ? wordText(first).toLowerCase() : "", results: [], problem };
  };
  if (strict.problem) return unclean(strict.problem);
  const asPasted = authResultsTokens(text, true);
  if (asPasted.problem || readingOf(asPasted.tokens) !== readingOf(strict.tokens)) {
    return unclean("it reads two ways: a comment in it holds a quoted address with a parenthesis in it");
  }

  const groups = [[]];
  for (const t of strict.tokens) {
    if (t.t === ";") groups.push([]);
    else groups.at(-1).push(t);
  }
  let authservId = "";
  let rest = groups.slice(1);
  const [head] = groups;
  if (head.length && !(head[0].t === "word" && wordEquals(head[0]) >= 0)) {
    // authserv-id [authres-version], then ";".
    authservId = wordText(head[0]).toLowerCase();
    const version = head.slice(1);
    if (version.length > 1 || (version.length === 1 && (version[0].parts.some((p) => p.quoted) || !/^[0-9]+$/.test(wordText(version[0]))))) {
      return unclean(`the server's name isn't followed by ";"`);
    }
  } else if (head.length) {
    rest = groups; // no authserv-id (Microsoft's): the line starts with a result
  } else if (groups.length > 1) {
    return unclean('no server name or result before the first ";"');
  }
  if (rest.length && rest.at(-1).length === 0) rest = rest.slice(0, -1); // a ";" at the end (Yahoo's, Microsoft's)
  if (authservId && rest.length === 1 && rest[0].length === 1 && wordText(rest[0][0]).toLowerCase() === "none" && !rest[0][0].parts.some((p) => p.quoted)) {
    return { authservId, results: [], problem: null };
  }
  const results = [];
  for (const words of rest) {
    if (words.length === 0) return unclean('two ";" with nothing between');
    const r = authResultOf(words);
    if (typeof r === "string") return unclean(r);
    results.push(r);
  }
  return { authservId, results, problem: null };
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

/** Headers only the sender writes: an Authentication-Results line below one of them is in the sender's part. */
const SENDER_PART = new Set(["from", "sender", "reply-to", "to", "cc", "subject", "date", "message-id", "in-reply-to", "references", "mime-version", "content-type", "dkim-signature"]);

/**
 * Whether the owner's own mailbox provider vouches for the sender of a mail (mailparser's headerLines, top first, and
 * the From address). The provider is known by the IMAP host Tarsee reads (mailProviderOf); for a server Tarsee
 * doesn't know, it is the one whose name (authserv-id) the owner typed in Settings for this exact mailbox
 * (senderCheck, with imapHost and imapUser). Its topmost Authentication-Results line, with its own authserv-id, must
 * read cleanly (parseAuthResults) and say:
 *   - dmarc=pass with header.from equal to the From domain (a dmarc=fail is final, and a DMARC result for another
 *     domain refuses the mail: the provider read another From line than Tarsee did); else
 *   - dkim=pass with that result's own header.d aligned to the From domain; else
 *   - spf=pass with smtp.mailfrom aligned to it.
 * Two results for a check that gives one verdict for the mail (dmarc, spf, ...), or two dkim results for one
 * signature that disagree, can't both be the provider's word, so they refuse it too. Lines lower down are the
 * sender's to write and are never read; for the owner's own server, the topmost line must also sit above every
 * header only the sender writes. "Trust the From line" (senderCheck.trustFromLine) counts only for a server Tarsee
 * doesn't know and the owner named no line for: one that writes none.
 * { ok: true, by: "dmarc"|"dkim"|"spf"|"from-line", provider } or
 * { ok: false, why: "unchecked" (no line Tarsee can read as the provider's) | "failed", provider, detail? }:
 * provider is its name, or the name the owner gave their server, or null. Nothing the mail wrote comes back but the
 * detail of a verdict, which is for the log.
 */
export function senderVouched(headerLines, fromAddress, { imapHost = "", imapUser = "", senderCheck = null } = {}) {
  const lines = Array.isArray(headerLines) ? headerLines : [];
  const known = mailProviderOf(imapHost);
  const own = senderCheckFor(senderCheck, { host: imapHost, user: imapUser });
  const profile = known || (own.authservId ? { name: own.authservId, id: (id) => id === own.authservId, lines: "top", own: true } : null);
  const provider = profile?.name ?? null;
  if (!profile && own.trustFromLine) return { ok: true, by: "from-line", provider };
  const failed = (detail) => ({ ok: false, why: "failed", provider, detail });
  const unchecked = { ok: false, why: "unchecked", provider };

  const froms = lines.filter((h) => h.key === "from").length;
  if (froms !== 1) return failed(froms ? "more than one From line" : "no From line");
  const fromDomain = domainOf(fromAddress);
  if (!fromDomain) return failed("no From address");

  const valueOf = (h) => String(h.line || "").slice(String(h.line || "").indexOf(":") + 1);
  const top = lines.findIndex((h) => h.key === "authentication-results");
  if (!profile || top < 0) return unchecked;
  const topLine = parseAuthResults(valueOf(lines[top]));
  if (!profile.id(topLine.authservId)) return unchecked;
  // The owner's server: its line goes on top as the mail comes in, above all the sender wrote.
  if (profile.own && lines.slice(0, top).some((h) => SENDER_PART.has(h.key))) return unchecked;

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
  const unread = block.find((b) => b.problem);
  if (unread) return failed(`its Authentication-Results line doesn't read cleanly: ${unread.problem}`);
  const results = block.flatMap((b) => b.results);

  const count = new Map();
  for (const r of results) if (!PER_SIGNATURE.has(r.method)) count.set(r.method, (count.get(r.method) || 0) + 1);
  const twice = [...count].find(([, n]) => n > 1);
  if (twice) return failed(`more than one ${twice[0]} result`);
  const signatures = new Map();
  for (const r of results.filter((x) => PER_SIGNATURE.has(x.method))) {
    const d = domainOf(r.props["header.d"] || r.props["header.i"]);
    const key = `${r.method} ${d} ${String(r.props["header.s"] || "").toLowerCase()}`;
    if (signatures.has(key) && signatures.get(key) !== r.result) return failed(`its ${r.method} results for ${d || "one signature"} disagree`);
    signatures.set(key, r.result);
  }

  const said = ["dmarc", "dkim", "spf"]
    .map((m) => results.find((r) => r.method === m))
    .filter(Boolean)
    .map((r) => `${r.method}=${r.result}`)
    .join(", ") || "no DMARC, DKIM or SPF verdict";
  const dmarc = results.find((r) => r.method === "dmarc");
  if (dmarc) {
    const dmarcFor = domainOf(dmarc.props["header.from"]);
    if (dmarcFor && dmarcFor !== fromDomain) return failed(`its DMARC result is for ${dmarcFor}, not the From line's ${fromDomain}`);
    if (dmarc.result === "pass" && dmarcFor === fromDomain) return { ok: true, by: "dmarc", provider };
    if (dmarc.result === "fail") return failed(said);
  }
  if (results.some((r) => r.method === "dkim" && r.result === "pass" && aligned(domainOf(r.props["header.d"]), fromDomain))) {
    return { ok: true, by: "dkim", provider };
  }
  const spf = results.find((r) => r.method === "spf");
  if (spf?.result === "pass" && aligned(domainOf(spf.props["smtp.mailfrom"]), fromDomain)) return { ok: true, by: "spf", provider };
  return failed(said);
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

/**
 * The parts of a waiting record (cfg.waiting) that are well formed: enabled, imap, smtp, allowlistFromAddresses. A
 * sender check never waits (the owner types it, signed in: holdForOwner), so one an earlier version left waiting is
 * dropped here, never approved.
 */
function waitingParts(w) {
  const out = {};
  if (!w || typeof w !== "object") return out;
  if (w.enabled === true) out.enabled = true;
  for (const side of ["imap", "smtp"]) {
    if (w[side] && typeof w[side] === "object" && !Array.isArray(w[side])) out[side] = w[side];
  }
  if (Array.isArray(w.allowlistFromAddresses)) out.allowlistFromAddresses = normalizeAllowlist(w.allowlistFromAddresses);
  return out;
}

/**
 * A sender check as saved or asked for: { imapHost, imapUser, trustFromLine, authservId }, the mailbox it is for
 * (host lower case), and what is trusted there (authservId lower case, "" for none).
 */
function ownSenderCheck(s) {
  return {
    imapHost: typeof s?.imapHost === "string" ? s.imapHost.trim().toLowerCase() : "",
    imapUser: typeof s?.imapUser === "string" ? s.imapUser.trim() : "",
    trustFromLine: s?.trustFromLine === true,
    authservId: typeof s?.authservId === "string" ? s.authservId.trim().toLowerCase() : "",
  };
}

/** The mailbox a sender check is for: { host, user }. */
const mailboxOfCheck = (s) => ({ host: s?.imapHost, user: s?.imapUser });

/**
 * cfg without a sender check that no longer applies: one for another mailbox than the IMAP one in force, one for a
 * provider Tarsee knows, or one that trusts nothing. What the owner trusted never carries over to another mailbox.
 */
export function senderCheckInForce(cfg) {
  if (!cfg || typeof cfg !== "object" || cfg.senderCheck === undefined) return cfg;
  const s = senderCheckFor(cfg.senderCheck, cfg.imap);
  if (s.trustFromLine || s.authservId) return cfg;
  const out = { ...cfg };
  delete out.senderCheck;
  return out;
}

/**
 * How a mail server set up by a caller that may be the AI (the chat tool, or the API token without the owner's live
 * sign-in) is logged in to: over TLS only. secure: false is refused except on a STARTTLS port (IMAP 143; SMTP 587, 25,
 * 2525), and a login that isn't over TLS from the start must switch to TLS first (requireTLS: nodemailer's requireTLS,
 * ImapFlow's doSTARTTLS). { refused: what to say } or { requireTLS }.
 */
export function aiLoginRule(side, { port, secure }) {
  if (!secure && !(side === "imap" ? [143] : [587, 25, 2525]).includes(port)) {
    return {
      refused: side === "imap"
        ? `IMAP with secure: false on port ${port} would log in in plain text. Keep secure on (port 993), or, for a server that offers STARTTLS, use port 143 with secure: false: Tarsee then insists on TLS before it logs in.`
        : `SMTP with secure: false on port ${port} would log in in plain text. Keep secure on (port 465, or 587 with STARTTLS), or, for a server that offers STARTTLS, use port 587, 25 or 2525 with secure: false: Tarsee then insists on TLS before it logs in.`,
    };
  }
  const tlsFromStart = side === "imap" ? secure : secure && port === 465;
  return { requireTLS: !tlsFromStart };
}

/** Whether `next` trusts more than `now` to say who sent a mail: the From line, or a server name it didn't. */
function trustsMore(now, next) {
  return (next.trustFromLine && !now.trustFromLine) || (!!next.authservId && next.authservId !== now.authservId);
}

/**
 * Whether a sender check asked for ({ imapHost, imapUser, trustFromLine, authservId }) trusts more, for the mailbox it
 * names, than cfg has in force there. Only the owner's live sign-in may give that: the owner types their server's name
 * themselves, and a name the AI asks for may be one it read in a forged mail.
 */
export function senderCheckTrustsMore(cfg, check) {
  const want = ownSenderCheck(check);
  return trustsMore(senderCheckFor(cfg?.senderCheck, mailboxOfCheck(want)), want);
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
 *   - an allowlist that lets in anyone the owner hasn't allowed (ownerAllowed) and who can't reach the AI now.
 * What narrows goes straight in: senders removed, email off, the mention word, the display name, a port, and less
 * trust in who sent a mail (senderCheck, which only the API token can send). More trust there never goes in nor waits:
 * the owner types it, signed in (routes/settings.js refuses it first: senderCheckTrustsMore). For each part the call
 * asks about (asked: { enabled, imap, smtp, allowlist, senderCheck }) the latest ask replaces what waited.
 * The owner's own list and sender check change only with their save or OK, and a sender check never outlives the
 * mailbox it was set for (senderCheckInForce).
 * prev: the settings saved now. next: prev with the call's changes, the servers already checked (one that changes
 * carries its own password), next.senderCheck the { imapHost, imapUser, trustFromLine, authservId } asked for.
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
  // Less trust goes straight in, for the mailbox in force (for one that only waits there is nothing in force). More is
  // left as it is: neither in force nor waiting.
  if (asked.senderCheck && !senderCheckTrustsMore(was, next.senderCheck)) {
    const want = ownSenderCheck(next.senderCheck);
    if (sameMailbox(mailboxOfCheck(want), cfg.imap)) {
      if (want.trustFromLine || want.authservId) cfg.senderCheck = want;
      else delete cfg.senderCheck;
    }
  }
  const kept = senderCheckInForce(cfg);
  return { cfg: withWaiting(kept, was.waiting, stillWaiting(kept, parts), by, now), held };
}

/**
 * The owner's own save from Settings > Channels > Email: everything in it is in force. What waited stays waiting
 * (a save isn't an answer to it), except a part the save has made moot. A sender check for another mailbox than the
 * one now in force goes (senderCheckInForce).
 */
export function ownerSaved(cfg, now = new Date()) {
  const before = cfg?.waiting;
  const kept = senderCheckInForce(cfg);
  return withWaiting(kept, before, stillWaiting(kept, waitingParts(before)), before?.by, now);
}

/**
 * The settings once the owner OKs what waits (cfg.waiting): it goes in force. When it turns email on or sets the
 * allowlist, the list in force is the owner's from then on (allowlistOwner). What the owner trusted to say who sent a
 * mail stays with its mailbox: an OK that moves IMAP to another one drops it (senderCheckInForce).
 */
export function applyWaiting(cfg) {
  const parts = stillWaiting(cfg, waitingParts(cfg?.waiting));
  const out = { ...cfg };
  delete out.waiting;
  if (parts.enabled) out.enabled = true;
  for (const side of ["imap", "smtp"]) if (parts[side]) out[side] = parts[side];
  if (parts.allowlistFromAddresses) out.allowlistFromAddresses = parts.allowlistFromAddresses;
  if (parts.enabled || parts.allowlistFromAddresses) out.allowlistOwner = normalizeAllowlist(out.allowlistFromAddresses);
  return senderCheckInForce(out);
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
    // What the owner trusts to say who sent a mail, for the exact mailbox it was set for (senderVouched).
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
