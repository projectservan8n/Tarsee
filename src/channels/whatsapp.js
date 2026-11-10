import fs from "node:fs";
import path from "node:path";
import { chatStream } from "../ai/router.js";
import { withConversationTurn } from "../lib/conversation-lock.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand, extractPlaybookPrompt } from "../lib/commands.js";
import { buildSystemPromptParts, sendFileHint } from "../lib/build-system-prompt.js";
import { parseReactions } from "../lib/reaction-parser.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { transcribeAudio } from "../voice/stt-handler.js";
import envConfig from "../config/env.js";
import { refused } from "../lib/channel-errors.js";
import { turnErrorNote, idleNote, errorStillToSay, sttProblem } from "./turn-notes.js";

/**
 * Split a long message at line or word boundaries.
 * WhatsApp message limit is 4096 chars — we cap at 4000 for safety.
 * Exported separately for testability.
 */
export function splitMessage(text, maxLen = 4000) {
  if (!text) return [];
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = remaining.lastIndexOf(" ", maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}

/** Build a conversation key for the in-DB conversation store. */
// What a document's bytes are, by its extension, for the data: URL WHAPI takes. Anything else goes as plain bytes.
const DOC_MIME = {
  ".pdf": "application/pdf", ".html": "text/html", ".htm": "text/html", ".txt": "text/plain", ".md": "text/markdown",
  ".csv": "text/csv", ".json": "application/json", ".zip": "application/zip",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp4": "video/mp4", ".mov": "video/quicktime",
};
export const mimeOfFile = (name) => DOC_MIME[path.extname(String(name || "")).toLowerCase()] || "application/octet-stream";

export function getChannelKey(chatId) {
  return `whatsapp:${chatId}`;
}

/**
 * Normalize a WhatsApp identifier (chat id or phone) to digits only.
 * "447700900000@s.whatsapp.net" → "447700900000"
 * "+44 770 090 0000"           → "447700900000"
 * "(044) 7700-900000"          → "447700900000"
 * Returns "" for falsy or non-string input.
 */
export function normalizeWhatsappId(value) {
  if (typeof value !== "string") return "";
  const stripped = value.split("@")[0]; // drop @s.whatsapp.net / @g.us
  return stripped.replace(/\D+/g, ""); // digits only
}

/**
 * True if `chatId` matches at least one entry in `allowlist`. Both sides are
 * normalized to digit-only form so users can paste phone numbers however
 * they like (with or without +, spaces, dashes, or the @s.whatsapp.net
 * suffix).
 *
 * Matching rules (most → least specific):
 *   1. Exact digit match.
 *   2. Suffix match — entry is the trailing portion of the chat id. This
 *      handles "omitted country code" cases where the operator pasted
 *      a local-format number (e.g. "917 123 4567") but WhatsApp delivers
 *      the full international form ("639171234567"). Requires the entry
 *      to be at least 7 digits so a tiny number can't over-match.
 */
export function isAllowlisted(chatId, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true;
  const target = normalizeWhatsappId(chatId);
  if (!target) return false;
  return allowlist.some((entry) => {
    const normalized = normalizeWhatsappId(entry);
    if (!normalized) return false;
    if (normalized === target) return true;
    if (normalized.length >= 7 && target.endsWith(normalized)) return true;
    return false;
  });
}

/**
 * Classify a WHAPI message as DM or group based on the WhatsApp chat id
 * suffix. DMs end in `@s.whatsapp.net`, groups in `@g.us`.
 */
export function isDirectMessage(chatId) {
  return typeof chatId === "string" && chatId.endsWith("@s.whatsapp.net");
}

/**
 * The WhatsApp account a WHAPI channel is linked to, from its /health answer: "+<number> (<name>)", either alone, or
 * null when no account is linked yet (the QR code not scanned) or /health didn't say.
 */
export function whapiIdentity(health) {
  const user = health?.user;
  if (!user || typeof user !== "object") return null;
  const digits = String(user.phone || user.id || "").split("@")[0].replace(/\D/g, "");
  const number = digits ? `+${digits}` : null;
  const name = String(user.pushname || user.name || "").trim() || null;
  return number && name ? `${number} (${name})` : number || name;
}

/**
 * WhatsApp channel via WHAPI Cloud (whapi.cloud).
 *
 * WHAPI is push-only: inbound messages arrive as webhook POSTs to a URL
 * the operator pastes into the WHAPI dashboard. Outbound goes via simple
 * HTTPS POSTs with a Bearer token.
 *
 * This channel does NOT respond to group messages — only DMs
 * (chat_id ends in @s.whatsapp.net). That keeps the UX predictable and
 * avoids the WhatsApp-mention-by-phone-number problem.
 *
 * @param {object} config - { token, enabled, webhook_secret, baseUrl?, allowedChats? }
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts] - healthTimeoutMs: how long the startup token check waits for WHAPI (30 s; it takes ~16 s to
 *   refuse a token). Tests make it short. chatStream: the model stream (ai/router.js chatStream when left out).
 */
export async function createWhatsAppBot(config, db, { healthTimeoutMs = 30_000, chatStream: streamChat = chatStream } = {}) {
  const convStore = new ConversationStore(db);
  const settingsStore = new SettingsStore(db);
  const token = config.token;
  const baseUrl = (config.baseUrl || "https://gate.whapi.cloud").replace(/\/+$/, "");

  if (!token) throw new Error("WHAPI token is required");

  const WHAPI_TIMEOUT_MS = 30_000;
  const typingIntervals = new Set();

  // --- HTTP helpers ---

  async function whapiFetch(pathname, opts = {}) {
    const url = `${baseUrl}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    };
    let body = opts.body;
    if (body && typeof body === "object" && !(body instanceof Buffer) && !(body instanceof Uint8Array)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeout || WHAPI_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
    if (!res.ok) {
      const msg = typeof parsed === "object" ? (parsed.error?.message || parsed.message || JSON.stringify(parsed)) : String(parsed);
      const err = new Error(`WHAPI ${res.status}: ${msg.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return parsed;
  }

  async function downloadWhapiMedia(mediaUrl) {
    const res = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`download failed ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    return { buffer, contentType };
  }

  /**
   * Resolve a media reference from a WHAPI inbound message to bytes.
   *
   * WHAPI's webhook payload shape varies by channel settings — some send
   * a presigned `link` URL, others send `url`, and some send only the
   * media `id` (requiring a follow-up GET /media/<id> with the bearer
   * token to fetch the file). We accept all variants so the operator
   * doesn't have to know which webhook option WHAPI gave them.
   */
  async function resolveMedia(src) {
    if (!src || typeof src !== "object") {
      throw new Error("no media payload");
    }
    const directUrl = src.link || src.url || src.media || src.file_url;
    if (directUrl) return downloadWhapiMedia(directUrl);

    const mediaId = src.id || src.media_id;
    if (mediaId) {
      // /media/<id> returns the binary directly (or 302 → CDN); follow redirects
      const url = `${baseUrl}/media/${encodeURIComponent(mediaId)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`media id fetch ${res.status}: ${body.slice(0, 200)}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") || src.mime_type || "application/octet-stream";
      return { buffer, contentType };
    }
    throw new Error(`no link/url/id in payload — got keys: ${Object.keys(src).join(", ")}`);
  }

  function saveDocumentToDisk(buffer, fileName) {
    try {
      const uploadsDir = path.join(envConfig.WORKSPACE_DIR, "uploads");
      fs.mkdirSync(uploadsDir, { recursive: true });
      const safeName = (fileName || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(uploadsDir, `whatsapp-${Date.now()}-${safeName}`);
      fs.writeFileSync(filePath, buffer);
      return filePath;
    } catch (err) {
      console.error("[whatsapp] saveDocumentToDisk failed:", err.message);
      return null;
    }
  }

  // --- Outbound primitives ---

  async function sendMessage(chatId, text) {
    if (!text?.trim()) return;
    const chunks = splitMessage(text, 4000);
    for (const chunk of chunks) {
      await whapiFetch("/messages/text", {
        method: "POST",
        body: { to: chatId, body: chunk },
      });
    }
  }

  async function sendImage(chatId, mediaUrlOrBuffer, caption = "", mime = "image/jpeg") {
    const media = Buffer.isBuffer(mediaUrlOrBuffer)
      ? `data:${mime};base64,${mediaUrlOrBuffer.toString("base64")}`
      : mediaUrlOrBuffer;
    return whapiFetch("/messages/image", {
      method: "POST",
      body: { to: chatId, media, caption },
    });
  }

  async function sendVoice(chatId, audioBuffer, mime = "audio/ogg") {
    const media = `data:${mime};base64,${audioBuffer.toString("base64")}`;
    return whapiFetch("/messages/voice", {
      method: "POST",
      body: { to: chatId, media },
    });
  }

  async function sendDocument(chatId, buffer, filename, mime = "application/octet-stream", caption = "") {
    const media = `data:${mime};base64,${buffer.toString("base64")}`;
    return whapiFetch("/messages/document", {
      method: "POST",
      body: { to: chatId, media, filename, ...(caption ? { caption } : {}) },
    });
  }

  async function sendReaction(chatId, messageId, emoji) {
    if (!emoji || !messageId) return;
    try {
      await whapiFetch("/messages/reaction", {
        method: "POST",
        body: { to: chatId, body: emoji, message_id: messageId },
      });
    } catch (err) {
      console.warn("[whatsapp] reaction failed:", err.message);
    }
  }

  async function sendTyping(chatId) {
    try {
      // WHAPI's presence endpoint — fire-and-forget, ignore errors
      await whapiFetch(`/presences/${encodeURIComponent(chatId)}`, {
        method: "PUT",
        body: { presence: "typing", delay: 25 },
        timeout: 5000,
      });
    } catch { /* presence is best-effort */ }
  }

  // --- Main message handler ---

  /** The allowlist from config or Settings (see chatAllowed for what an entry may be). */
  function allowedChatsNow() {
    const dbAllowlist = settingsStore.get("allowlist.whatsapp");
    const rawAllow = config.allowedChats?.length > 0
      ? config.allowedChats
      : (dbAllowlist ? (typeof dbAllowlist === "string" ? JSON.parse(dbAllowlist) : dbAllowlist) : []);
    return Array.isArray(rawAllow) ? rawAllow.filter(Boolean) : [];
  }

  /**
   * Whether the sender is the owner, for the owner's commands (/cron, /briefing, /webhook: lib/commands.js): only DMs
   * reach Tarsee, so the chat is the sender, and their number must be on the allowlist. With no allowlist anyone can
   * write in, so nobody counts.
   */
  function senderIsOwner(chatId) {
    const allowed = allowedChatsNow();
    return allowed.length > 0 && isAllowlisted(chatId, allowed);
  }

  /**
   * Allowlist check (optional). Empty list = allow everyone.
   * Entries can be the full chat id (447700900000@s.whatsapp.net) or just
   * the phone in any common format (+44 770 090 0000, 447700900000, etc).
   */
  function chatAllowed(chatId) {
    const allowed = allowedChatsNow();
    if (isAllowlisted(chatId, allowed)) return true;
    const normalizedTarget = normalizeWhatsappId(chatId);
    const normalizedAllow = allowed.map((e) => normalizeWhatsappId(e)).filter(Boolean);
    console.log(
      `[whatsapp] dropping non-allowlisted chat — target=${normalizedTarget} ` +
      `allow=[${normalizedAllow.join(",")}]`
    );
    return false;
  }

  async function handleMessage(chatId, fromName, text, attachments = [], replyToId = null) {
    if (!chatAllowed(chatId)) return;

    if (!text?.trim() && attachments.length === 0) return;

    const channelKey = getChannelKey(chatId);

    // Slash commands
    let aiPromptOverride = null;
    if (text.startsWith("/")) {
      const existingConvId = settingsStore.get(`channel_conv.${channelKey}`);
      const cmdResult = await processCommand(text, {
        settingsStore,
        convStore,
        conversationId: existingConvId,
        platform: "whatsapp",
        owner: senderIsOwner(chatId),
        db, // was missing — /clear silently no-op'd
      });
      if (cmdResult.handled) {
        const playbook = extractPlaybookPrompt(cmdResult);
        if (playbook) {
          aiPromptOverride = playbook;
        } else {
          await sendMessage(chatId, cmdResult.response);
          return;
        }
      }
    }

    // Get or create conversation
    let convId = settingsStore.get(`channel_conv.${channelKey}`);
    if (!convId || !convStore.get(convId)) {
      const conv = convStore.create({ title: `WhatsApp · ${fromName}` });
      convId = conv.id;
      settingsStore.set(`channel_conv.${channelKey}`, convId);
    }

    const savedUser = convStore.addMessage(convId, {
      role: "user",
      content: `[${fromName}]: ${text}${attachments.length ? ` [+${attachments.length} attachment(s)]` : ""}`,
    });

    // Which AI answers is the turn layer's to decide (ai/turn.js: this chat's own pick, else the default), and so is
    // saying what to set up when that AI isn't ready: its answer is the reply.

    // Keep typing indicator alive while processing
    sendTyping(chatId);
    const typingInterval = setInterval(() => sendTyping(chatId), 10_000);
    typingIntervals.add(typingInterval);

    // Idle watchdog — abort if SDK goes 3 min without an event
    const controller = new AbortController();
    let lastEventAt = Date.now();
    let idleAborted = false;
    // Idle abort: how long a turn may go with NO stream event before we give up.
    // Was a hard 3 minutes, which killed legitimate long research/tool turns.
    // Now configurable, but deliberately FINITE — the Mac build sets this to
    // ~2e9 (23 days), which is only safe there because its PTY pool has a
    // heartbeat + dead-socket detector. This build has neither, so an infinite
    // value would wedge a turn forever with no console to kill it from.
    const IDLE_ABORT_MS = Number(process.env.TARSEE_CHANNEL_IDLE_ABORT_MS) || 20 * 60_000;
    const idleTimer = setInterval(() => {
      if (Date.now() - lastEventAt > IDLE_ABORT_MS) {
        idleAborted = true;
        try { controller.abort(); } catch {}
        clearInterval(idleTimer);
      }
    }, 15_000);

    const history = convStore.getRecentMessages(convId, 15);
    const conv = convStore.get(convId);
    const systemParts = buildSystemPromptParts({
      settingsStore,
      db,
      conversationId: convId,
      messageCount: history.length,
      conversationPrompt: conv?.system_prompt,
      channelHint: `You are in a WhatsApp 1-on-1 chat. Keep responses concise and conversational.
Use plain text — markdown will render as literal characters in WhatsApp.
You can use these special markers in your response:
- [react: emoji] — adds a reaction to the user's message (e.g. [react: ✅])
${sendFileHint("whatsapp")}`,
    });

    let fullResponse = "";
    // messageId: the message this turn answers (its pictures are kept on it, not on whatever came in later)
    const toolCtx = { db, settingsStore, conversationId: convId, messageId: savedUser?.id || null };

    // One turn at a time per conversation. Without this, two messages in the
    // same chat started two turns that both resumed the SAME Claude session
    // id, appending to one transcript from two processes. Replies interleaved
    // and the session could be left corrupt enough to break every later turn.
    await withConversationTurn(convId, async () => {
    // The AI this turn runs on, from the turn layer's route event (the backup model's, if it answered instead).
    let routed = null;
    try {
      const workingMessages = history.map((m) => ({ role: m.role, content: m.content }));

      if (aiPromptOverride && workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") last.content = aiPromptOverride;
      }

      // Enrich last user message with image/document blocks if attachments
      if (attachments.length > 0 && workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") {
          const contentBlocks = [...attachments];
          contentBlocks.push({ type: "text", text: typeof last.content === "string" ? last.content : text });
          last.content = contentBlocks;
        }
      }

      let surfacedError = null;
      // Token usage for this turn — drives Settings -> Token Health.
      // Channels previously recorded NO token data at all, so every
      // channel conversation showed up as an estimate instead of real numbers.
      let tokenUsage = {};

      // One call per message. The engine runs its own tools and ends the turn itself, and the turn layer
      // (ai/turn.js) retries, once and fresh, a session the engine couldn't resume. The channel never calls the AI
      // again on its own: it shows what the turn says.
      const stream = streamChat({
        liveSource: "whatsapp",
        messages: workingMessages,
        systemParts,
        toolCtx,
        sessionId: convStore.getSessionHandle(convId),
        onSessionId: (handle) => convStore.setSessionHandle(convId, handle),
        signal: controller.signal,
      });

      for await (const event of stream) {
        lastEventAt = Date.now();
        if (event.type === "route") {
          routed = event;
        } else if (event.type === "text") {
          fullResponse += event.content;
        } else if (event.type === "tool_use") {
          const callJson = JSON.stringify({ name: event.name, arguments: event.input })
            .replace(/<\/(tool_call|tool_response)>/gi, "<_/$1>");
          fullResponse += `\n<tool_call>${callJson}</tool_call>\n`;
        } else if (event.type === "error") {
          surfacedError = event.message || "something went wrong";
        } else if (event.type === "usage") {
          tokenUsage = { ...tokenUsage, ...event.usage };
        } else if (event.type === "done") {
          break;
        }
      }

      if (fullResponse) {
        fullResponse = extractAndSaveMemories(fullResponse, db, convId);
        const { cleanText, reactions } = parseReactions(fullResponse);

        // Strip tool xml + any leftover [buttons:...] markers (WhatsApp doesn't
        // support our button format in this v1)
        const visible = cleanText
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
          .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
          .replace(/\[buttons:\s*\[[\s\S]*?\]\s*\]/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        convStore.addMessage(convId, {
          role: "assistant",
          content: visible || "(empty)",
          provider: routed?.provider || null,
          model: routed?.model || null,
          // True prompt size = input + cache_read + cache_creation. Using
          // input_tokens alone undercounts context fill whenever caching
          // kicks in (which is almost always on a long session).
          tokensIn: (tokenUsage.input_tokens || 0)
            + (tokenUsage.cache_read_input_tokens || 0)
            + (tokenUsage.cache_creation_input_tokens || 0) || null,
          tokensOut: tokenUsage.output_tokens ?? null,
        });

        if (visible) {
          await sendMessage(chatId, visible);
        } else {
          await sendMessage(chatId, "⚠️ Done — no message body.").catch(() => {});
        }

        for (const emoji of reactions) {
          await sendReaction(chatId, replyToId, emoji);
        }
      }
      // An error the turn reported (already in plain words: what went wrong, what to do), after whatever it said
      // before it: a spending limit or the turn ceiling can stop a reply halfway. Not again when the reply is the
      // error itself (the turn layer's "set this up first" answers).
      if (surfacedError && errorStillToSay(fullResponse, surfacedError)) {
        await sendMessage(chatId, turnErrorNote(routed, surfacedError)).catch(() => {});
      } else if (!fullResponse && idleAborted) {
        await sendMessage(chatId, idleNote(routed, IDLE_ABORT_MS)).catch(() => {});
      } else if (!fullResponse && !surfacedError) {
        await sendMessage(chatId, "⚠️ No response generated. Try rephrasing?").catch(() => {});
      }
    } catch (err) {
      console.error("[whatsapp] chat error:", err.message);
      const reason = idleAborted
        ? idleNote(routed, IDLE_ABORT_MS)
        : `⚠️ Error: ${err.message || "something went wrong"}. Try again.`;
      await sendMessage(chatId, reason).catch(() => {});
    } finally {
      clearInterval(typingInterval);
      clearInterval(idleTimer);
      typingIntervals.delete(typingInterval);
    }
    }, {
      // Waiting behind the reply in progress: a "Queued" line on the dashboard.
      live: { source: "whatsapp", prompt: text },
    });
  }

  // --- Webhook entry point ---

  async function handleInbound(payload) {
    if (!payload || typeof payload !== "object") return;
    const messages = Array.isArray(payload.messages) ? payload.messages : [];

    for (const msg of messages) {
      try {
        if (msg.from_me === true) continue; // skip own echoes

        const chatId = msg.chat_id || msg.from;
        if (!chatId || typeof chatId !== "string") continue;

        // DMs only — group ids end in @g.us
        if (!isDirectMessage(chatId)) {
          if (chatId.endsWith("@g.us")) {
            console.log(`[whatsapp] ignoring group message from ${chatId}`);
          }
          continue;
        }

        // Off the allowlist: dropped before any media is fetched or transcribed, or anything is said back.
        if (!chatAllowed(chatId)) continue;

        const fromName = msg.from_name || (chatId.split("@")[0] || "User");
        const replyToId = msg.id;

        switch (msg.type) {
          case "text": {
            const text = msg.text?.body || "";
            await handleMessage(chatId, fromName, text, [], replyToId);
            break;
          }
          case "voice":
          case "audio": {
            const src = msg.voice || msg.audio || {};
            let buffer;
            try {
              ({ buffer } = await resolveMedia(src));
            } catch (err) {
              console.error(`[whatsapp] voice fetch failed: ${err.message}`, "msg keys:", Object.keys(src));
              await sendMessage(chatId, `Couldn't fetch the voice message (${err.message}).`).catch(() => {});
              break;
            }
            let result;
            try {
              result = await transcribeAudio(buffer, "en", { settingsStore });
            } catch (err) {
              console.error(`[whatsapp] voice transcription failed: ${err.message}`);
              // Transcription that can't run says what to set up (Settings > Voice); anything else, a short note.
              await sendMessage(chatId, sttProblem(err) || "Couldn't transcribe the voice message. Try again, or type it.").catch(() => {});
              break;
            }
            if (!result.transcript?.trim()) {
              await sendMessage(chatId, "Couldn't understand the voice message.").catch(() => {});
              break;
            }
            console.log(`[whatsapp] transcribed: "${result.transcript.slice(0, 80)}..."`);
            await handleMessage(chatId, fromName, result.transcript, [], replyToId);
            break;
          }
          case "image": {
            const img = msg.image || {};
            const caption = img.caption || "";
            let buffer; let contentType;
            try {
              ({ buffer, contentType } = await resolveMedia(img));
            } catch (err) {
              console.error(`[whatsapp] image fetch failed: ${err.message}`, "msg keys:", Object.keys(img));
              await sendMessage(chatId, `Couldn't fetch the image (${err.message}).`).catch(() => {});
              break;
            }
            const mediaType = img.mime_type || contentType || "image/jpeg";
            const attachment = {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") },
            };
            await handleMessage(chatId, fromName, caption || "Please analyze this image.", [attachment], replyToId);
            break;
          }
          case "document": {
            const doc = msg.document || {};
            const filename = doc.filename || "file";
            const mime = doc.mime_type || "";
            const caption = doc.caption || "";
            const sizeKb = Math.round((doc.file_size || 0) / 1024);
            let buffer;
            try {
              ({ buffer } = await resolveMedia(doc));
            } catch (err) {
              console.error(`[whatsapp] document fetch failed: ${err.message}`, "msg keys:", Object.keys(doc));
              await sendMessage(chatId, `Couldn't fetch "${filename}" (${err.message}).`).catch(() => {});
              break;
            }

            if (mime === "application/pdf") {
              const attachment = {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") },
              };
              const savedPath = saveDocumentToDisk(buffer, filename);
              const pathNote = savedPath
                ? `\n\n[PDF saved: ${filename} (${sizeKb}KB) → ${savedPath}]`
                : "";
              await handleMessage(chatId, fromName, (caption || "Please analyze this PDF.") + pathNote, [attachment], replyToId);
            } else if (mime.startsWith("image/")) {
              const attachment = {
                type: "image",
                source: { type: "base64", media_type: mime, data: buffer.toString("base64") },
              };
              await handleMessage(chatId, fromName, caption || "Please analyze this image.", [attachment], replyToId);
            } else {
              const savedPath = saveDocumentToDisk(buffer, filename);
              const note = savedPath
                ? `[Attached file: ${filename} (${mime || "unknown"}, ${sizeKb}KB) → ${savedPath}]\nYou can read this file with the Read tool at: ${savedPath}`
                : `[Attached file: ${filename} (${mime}) — failed to save to disk]`;
              const text = caption ? `${caption}\n\n${note}` : note;
              await handleMessage(chatId, fromName, text, [], replyToId);
            }
            break;
          }
          case "video": {
            const vid = msg.video || {};
            const caption = vid.caption || "";
            const sizeKb = Math.round((vid.file_size || 0) / 1024);
            let buffer;
            try {
              ({ buffer } = await resolveMedia(vid));
            } catch (err) {
              console.error(`[whatsapp] video fetch failed: ${err.message}`, "msg keys:", Object.keys(vid));
              await sendMessage(chatId, `Couldn't fetch the video (${err.message}).`).catch(() => {});
              break;
            }
            const savedPath = saveDocumentToDisk(buffer, `video-${Date.now()}.mp4`);
            const note = savedPath
              ? `[Video saved: (${sizeKb}KB) → ${savedPath}] You can read this file with the Read tool.`
              : "[Video received but failed to save]";
            const text = caption ? `${caption}\n\n${note}` : `User sent a video.\n\n${note}`;
            await handleMessage(chatId, fromName, text, [], replyToId);
            break;
          }
          default:
            console.log(`[whatsapp] unsupported message type: ${msg.type}`);
            break;
        }
      } catch (err) {
        console.error("[whatsapp] message handler error:", err.message);
      }
    }
  }

  // Check the token at startup. WHAPI refusing it fails the channel with what to do about it (Settings shows it): a
  // 401/403, or the 404 "Channel not found" it answers a token that matches no channel with (after ~16 s, so the wait
  // is long). Anything else (a timeout, a /health this gateway lacks, a WHAPI outage) starts the channel, with a
  // warning Settings shows in place of "Connected".
  let identity = null;
  let warning = null;
  try {
    identity = whapiIdentity(await whapiFetch("/health", { method: "GET", timeout: healthTimeoutMs }));
    console.log(`[whatsapp] WHAPI health check OK${identity ? ` (${identity})` : ""}`);
  } catch (err) {
    if (err.status === 401 || err.status === 403 || (err.status === 404 && /channel not found/i.test(err.message))) {
      throw refused("WHAPI refused the token. Copy it again from panel.whapi.cloud → your channel → API token.");
    }
    const why = err.name === "TimeoutError" || /aborted|timeout/i.test(err.message) ? "no answer in time" : err.message;
    warning = `Saved, but couldn't check the token with WHAPI (${why}). Messages arrive once WHAPI reaches the webhook; save again to recheck.`;
    console.warn(`[whatsapp] WHAPI health check failed (continuing anyway): ${err.message}`);
  }

  console.log("[whatsapp] bot ready (webhook-driven)");

  return {
    stop: async () => {
      for (const t of typingIntervals) clearInterval(t);
      typingIntervals.clear();
    },
    /** The linked WhatsApp account, as /health reported it, for Settings → Channels; null if it didn't say. */
    identity,
    /** Why the token could not be checked at startup (Settings shows it in place of "Connected"), or null. */
    warning,
    sendMessage,
    sendImage,
    sendVoice,
    sendDocument,
    /** Send a file from disk as a document (the send_file tool), with its own name and kind. */
    sendFile: async (chatId, filePath, caption) => {
      if (!fs.existsSync(filePath)) throw new Error(`sendFile: file not found at ${filePath}`);
      const buffer = fs.readFileSync(filePath);
      const name = path.basename(filePath);
      await sendDocument(chatId, buffer, name, mimeOfFile(name), caption ? String(caption).slice(0, 1024) : "");
    },
    handleInbound,
  };
}
