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
 *      - YES → buildSystemPrompt + chatStream + SMTP reply to From: only
 *      - NO  → persist as context to the conversation; NO outbound
 *   4. `[reply-all]` subject marker OR `@tarsee reply-all` opts into
 *      replying to To+Cc (sender-only otherwise).
 *
 * Safety gates before ever touching the chat pipeline:
 *   - Allowlist of From addresses (empty = warn + allow all, dev mode)
 *   - Self-loop guard (drop if From == tarseeEmailAddress)
 *   - Bulk/auto-reply drop (List-Id, Auto-Submitted, Precedence headers)
 *   - Per-sender rate limit (6/10 min)
 *   - Body truncation at 100 KB
 *   - Attachment caps: 10 MB per file, 5 files per email
 */

import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

import config from "../config/env.js";
import { chatStream } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand, extractPlaybookPrompt } from "../lib/commands.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
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
const MAX_TOOL_ROUNDS = 15;
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
 * @returns {Promise<{stop: Function, sendMessage: Function, sendNew: Function}>}
 */
export async function createEmailBot(rawConfig, db) {
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
  const smtp = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port || 465,
    secure: cfg.smtp.secure !== false && (cfg.smtp.port || 465) === 465, // 465 = implicit TLS
    auth: { user: cfg.smtp.user, pass: cfg.smtp.password },
  });

  // IMAP client with IDLE support.
  let client = null;
  let shuttingDown = false;
  let reconnectTimeout = null;

  async function connect() {
    if (shuttingDown) return;
    client = new ImapFlow({
      host: cfg.imap.host,
      port: cfg.imap.port || 993,
      secure: cfg.imap.secure !== false,
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

    convStore.addMessage(convId, {
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

    // Engage the AI. Same pipeline as Discord/Telegram.
    const activeProvider = settingsStore.getActiveProvider();
    if (!activeProvider?.provider || !activeProvider?.ready) {
      await sendReply({
        incoming: mail,
        bodyText: "No AI provider configured. Set one up in the Tarsee web panel.",
        replyAll,
      }).catch(() => {});
      return;
    }

    const history = convStore.getRecentMessages(convId, HISTORY_WINDOW);
    const conv = convStore.get(convId);
    const systemPrompt = buildSystemPrompt({
      settingsStore, db,
      conversationId: convId,
      messageCount: history.length,
      conversationPrompt: conv?.system_prompt,
      channelHint: "You are in an email conversation. Keep your reply in plain text — it will be sent as the email body. No markdown tables, no markdown code fences unless the content is literally code. Stay concise; emails shouldn't be 5 pages long.",
    });

    let fullResponse = "";
    // Token usage for this turn — drives Settings -> Token Health.
    let tokenUsage = {};
    try {
      const toolCtx = { db, settingsStore, conversationId: convId };
      const workingMessages = history.map((m) => ({ role: m.role, content: m.content }));
      // Slash-command playbooks: swap the AI-visible last user turn for
      // the playbook body while the stored email/message stays as-sent.
      if (aiPromptOverride && workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") last.content = aiPromptOverride;
      }
      // The very last message is the one we just saved — already has the
      // full context prefix, so Claude sees the whole picture.
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let stopReason = "end_turn";
        const stream = chatStream({
          provider: activeProvider.provider,
          model: activeProvider.model,
          messages: workingMessages,
          systemPrompt,
          toolCtx,
          sessionId: convStore.getClaudeSessionId(convId),
          onSessionId: (sid) => convStore.setClaudeSessionId(convId, sid),
        });
        for await (const event of stream) {
          if (event.type === "text") fullResponse += event.content;
          else if (event.type === "usage") tokenUsage = { ...tokenUsage, ...event.usage };
          else if (event.type === "done") { stopReason = event.stopReason || "end_turn"; break; }
        }
        if (stopReason !== "tool_use") break;
      }

      if (!fullResponse.trim()) {
        fullResponse = "(no response)";
      }

      // Persist + save any [REMEMBER:…] markers
      fullResponse = extractAndSaveMemories(fullResponse, db, convId);
      convStore.addMessage(convId, {
        role: "assistant",
        content: fullResponse,
        provider: activeProvider.provider,
        model: activeProvider.model,
        tokensIn: (tokenUsage.input_tokens || 0)
          + (tokenUsage.cache_read_input_tokens || 0)
          + (tokenUsage.cache_creation_input_tokens || 0) || null,
        tokensOut: tokenUsage.output_tokens ?? null,
      });

      await sendReply({
        incoming: mail,
        bodyText: fullResponse,
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
  }

  /**
   * Send an email reply preserving thread headers.
   */
  async function sendReply({ incoming, bodyText, replyAll }) {
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
    if (recipients.to.length === 0) {
      console.warn("[email] no recipients resolved — skipping send");
      return;
    }

    const referencesArr = Array.isArray(incoming.references)
      ? incoming.references
      : String(incoming.references || "").split(/\s+/).filter(Boolean);
    const { inReplyTo, references } = buildReplyHeaders({
      incomingMessageId: incoming.messageId,
      references: referencesArr,
    });

    const subject = normalizeReplySubject(incoming.subject);
    const replyParts = applySignature(String(bodyText || "").slice(0, 100_000), cfg.signature);

    await smtp.sendMail({
      from: `"${cfg.fromName || "Tarsee"}" <${selfAddress}>`,
      to: recipients.to.join(", "),
      cc: recipients.cc.length ? recipients.cc.join(", ") : undefined,
      subject,
      text: replyParts.text,
      ...(replyParts.html ? { html: replyParts.html } : {}),
      inReplyTo,
      references,
    });
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

  // Kick off connection. Errors surface to the caller so the ChannelManager
  // records a proper "error" status.
  await connect();

  return {
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
      const to = String(chatId).split(",").map((s) => s.trim()).filter(Boolean);
      if (to.length === 0) throw new Error("email.sendMessage needs a target address in chatId");
      const parts = applySignature(String(message || ""), cfg.signature);
      await smtp.sendMail({
        from: `"${cfg.fromName || "Tarsee"}" <${selfAddress}>`,
        to: to.join(", "),
        subject: cfg.defaultSubject || "Tarsee message",
        text: parts.text,
        ...(parts.html ? { html: parts.html } : {}),
      });
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
    sendNew: async ({ to, cc, subject, body, inReplyTo, attachments }) => {
      const toArr = Array.isArray(to) ? to : String(to).split(",").map((s) => s.trim()).filter(Boolean);
      const ccArr = cc ? (Array.isArray(cc) ? cc : String(cc).split(",").map((s) => s.trim()).filter(Boolean)) : [];
      const atts = normalizeAttachments(attachments);
      const parts = applySignature(String(body || ""), cfg.signature);
      const info = await smtp.sendMail({
        from: `"${cfg.fromName || "Tarsee"}" <${selfAddress}>`,
        to: toArr.join(", "),
        cc: ccArr.length ? ccArr.join(", ") : undefined,
        subject: inReplyTo ? normalizeReplySubject(subject) : (subject || "(no subject)"),
        text: parts.text,
        ...(parts.html ? { html: parts.html } : {}),
        ...(atts.length ? { attachments: atts } : {}),
        inReplyTo,
        references: inReplyTo,
      });
      return { messageId: info.messageId, attachmentCount: atts.length };
    },
  };
}

/**
 * Accept either the flat legacy shape or a nested config — return the
 * canonical nested shape.
 */
function normalizeConfig(c) {
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
