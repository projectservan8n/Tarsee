import fs from "node:fs";
import path from "node:path";
import { chatStream } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand, extractPlaybookPrompt } from "../lib/commands.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { parseReactions } from "../lib/reaction-parser.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { transcribeAudio } from "../voice/stt-handler.js";
import envConfig from "../config/env.js";

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
export function getChannelKey(chatId) {
  return `whatsapp:${chatId}`;
}

/**
 * Classify a WHAPI message as DM or group based on the WhatsApp chat id
 * suffix. DMs end in `@s.whatsapp.net`, groups in `@g.us`.
 */
export function isDirectMessage(chatId) {
  return typeof chatId === "string" && chatId.endsWith("@s.whatsapp.net");
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
 */
export async function createWhatsAppBot(config, db) {
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

  async function sendDocument(chatId, buffer, filename, mime = "application/octet-stream") {
    const media = `data:${mime};base64,${buffer.toString("base64")}`;
    return whapiFetch("/messages/document", {
      method: "POST",
      body: { to: chatId, media, filename },
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

  async function handleMessage(chatId, fromName, text, attachments = [], replyToId = null) {
    // Allowlist check (optional)
    const dbAllowlist = settingsStore.get("allowlist.whatsapp");
    const allowed = config.allowedChats?.length > 0
      ? config.allowedChats
      : (dbAllowlist ? (typeof dbAllowlist === "string" ? JSON.parse(dbAllowlist) : dbAllowlist) : []);
    if (allowed.length > 0 && !allowed.includes(chatId)) {
      console.log(`[whatsapp] dropping message from non-allowlisted chat: ${chatId}`);
      return;
    }

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

    convStore.addMessage(convId, {
      role: "user",
      content: `[${fromName}]: ${text}${attachments.length ? ` [+${attachments.length} attachment(s)]` : ""}`,
    });

    const activeProvider = settingsStore.getActiveProvider();
    if (!activeProvider?.provider || !activeProvider?.ready) {
      await sendMessage(chatId, "No AI provider configured. Set one up in the Tarsee web panel.").catch(() => {});
      return;
    }

    // Keep typing indicator alive while processing
    sendTyping(chatId);
    const typingInterval = setInterval(() => sendTyping(chatId), 10_000);
    typingIntervals.add(typingInterval);

    // Idle watchdog — abort if SDK goes 3 min without an event
    const controller = new AbortController();
    let lastEventAt = Date.now();
    let idleAborted = false;
    const IDLE_ABORT_MS = 3 * 60_000;
    const idleTimer = setInterval(() => {
      if (Date.now() - lastEventAt > IDLE_ABORT_MS) {
        idleAborted = true;
        try { controller.abort(); } catch {}
        clearInterval(idleTimer);
      }
    }, 15_000);

    const history = convStore.getRecentMessages(convId, 15);
    const conv = convStore.get(convId);
    const systemPrompt = buildSystemPrompt({
      settingsStore,
      db,
      conversationId: convId,
      messageCount: history.length,
      conversationPrompt: conv?.system_prompt,
      channelHint: `You are in a WhatsApp 1-on-1 chat. Keep responses concise and conversational.
Use plain text — markdown will render as literal characters in WhatsApp.
You can use these special markers in your response:
- [react: emoji] — adds a reaction to the user's message (e.g. [react: ✅])`,
    });

    let fullResponse = "";
    const tools = getToolDefinitions();
    const toolCtx = { db, settingsStore, conversationId: convId };
    const MAX_TOOL_ROUNDS = 15;

    try {
      let workingMessages = history.map((m) => ({ role: m.role, content: m.content }));

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

      // One-shot retry budget for session-corruption recovery (same pattern as telegram)
      let sessionRetried = false;
      let surfacedError = null;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const toolCalls = [];
        let roundText = "";
        let stopReason = "end_turn";
        let recoverRound = false;

        const existingSessionId = convStore.getClaudeSessionId(convId);
        const stream = chatStream({
          provider: activeProvider.provider,
          model: activeProvider.model,
          messages: workingMessages,
          systemPrompt,
          tools,
          toolCtx,
          sessionId: existingSessionId,
          onSessionId: (sid) => convStore.setClaudeSessionId(convId, sid),
          signal: controller.signal,
        });

        for await (const event of stream) {
          lastEventAt = Date.now();
          if (event.type === "text") {
            roundText += event.content;
            fullResponse += event.content;
          } else if (event.type === "tool_use") {
            toolCalls.push({ id: event.id, name: event.name, input: event.input });
            const callJson = JSON.stringify({ name: event.name, arguments: event.input })
              .replace(/<\/(tool_call|tool_response)>/gi, "<_/$1>");
            fullResponse += `\n<tool_call>${callJson}</tool_call>\n`;
          } else if (event.type === "error") {
            if (event.recoverable && !sessionRetried) {
              sessionRetried = true;
              recoverRound = true;
              convStore.setClaudeSessionId(convId, null);
              console.warn(`[whatsapp] session corrupt, clearing and retrying: ${String(event.message || "").slice(0, 200)}`);
            } else {
              surfacedError = event.message;
            }
          } else if (event.type === "done") {
            stopReason = event.stopReason || "end_turn";
            break;
          }
        }

        if (recoverRound) { round--; continue; }
        if (surfacedError) break;
        if (toolCalls.length === 0 || stopReason !== "tool_use") break;

        // Build assistant message with tool_use blocks
        const assistantContent = [];
        if (roundText) assistantContent.push({ type: "text", text: roundText });
        for (const tc of toolCalls) {
          assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        }
        workingMessages.push({ role: "assistant", content: assistantContent });

        // Execute tools
        const toolResults = [];
        for (const tc of toolCalls) {
          console.log(`[whatsapp] tool: ${tc.name}`);
          const result = await executeTool(tc.name, tc.input, toolCtx);
          toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
          const resultText = (typeof result === "string" ? result : JSON.stringify(result))
            .replace(/<\/(tool_call|tool_response)>/gi, "<_/$1>");
          fullResponse += `\n<tool_response>${resultText}</tool_response>\n`;
        }
        workingMessages.push({ role: "user", content: toolResults });
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
          provider: activeProvider.provider,
          model: activeProvider.model,
        });

        if (visible) {
          await sendMessage(chatId, visible);
        } else {
          await sendMessage(chatId, "⚠️ Done — no message body.").catch(() => {});
        }

        for (const emoji of reactions) {
          await sendReaction(chatId, replyToId, emoji);
        }
      } else if (surfacedError) {
        const isSessionErr = /previous_message_id|session/i.test(String(surfacedError));
        const userMsg = isSessionErr
          ? "⚠️ Session reset due to a transient API hiccup. Just send your message again — your history is preserved."
          : `⚠️ Upstream error: ${String(surfacedError).slice(0, 200)}\n\nTry again — if it keeps happening, /clear and try fresh.`;
        await sendMessage(chatId, userMsg).catch(() => {});
      } else if (idleAborted) {
        await sendMessage(chatId, "⚠️ Claude Code stopped responding (3 min idle). Try again — maybe with a smaller ask.").catch(() => {});
      } else {
        await sendMessage(chatId, "⚠️ No response generated. Try rephrasing?").catch(() => {});
      }
    } catch (err) {
      console.error("[whatsapp] chat error:", err.message);
      const reason = idleAborted
        ? "⚠️ Claude Code stopped responding (3 min idle). Try again — maybe with a smaller ask."
        : `⚠️ Error: ${err.message || "something went wrong"}. Try again.`;
      await sendMessage(chatId, reason).catch(() => {});
    } finally {
      clearInterval(typingInterval);
      clearInterval(idleTimer);
      typingIntervals.delete(typingInterval);
    }
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
            const mediaUrl = src.link;
            if (!mediaUrl) {
              await sendMessage(chatId, "Couldn't read the voice message.").catch(() => {});
              break;
            }
            const { buffer } = await downloadWhapiMedia(mediaUrl);
            const result = await transcribeAudio(buffer, "en", { settingsStore });
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
            const mediaUrl = img.link;
            const caption = img.caption || "";
            if (!mediaUrl) {
              await sendMessage(chatId, "Couldn't read the image.").catch(() => {});
              break;
            }
            const { buffer, contentType } = await downloadWhapiMedia(mediaUrl);
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
            const mediaUrl = doc.link;
            const filename = doc.filename || "file";
            const mime = doc.mime_type || "";
            const caption = doc.caption || "";
            const sizeKb = Math.round((doc.file_size || 0) / 1024);
            if (!mediaUrl) {
              await sendMessage(chatId, "Couldn't read the document.").catch(() => {});
              break;
            }
            const { buffer } = await downloadWhapiMedia(mediaUrl);

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
            const mediaUrl = vid.link;
            const caption = vid.caption || "";
            const sizeKb = Math.round((vid.file_size || 0) / 1024);
            if (!mediaUrl) {
              await sendMessage(chatId, "Couldn't read the video.").catch(() => {});
              break;
            }
            const { buffer } = await downloadWhapiMedia(mediaUrl);
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

  // Sanity check the token at startup — log a warning if WHAPI rejects it,
  // but don't throw (operator may have restricted the /health endpoint).
  try {
    await whapiFetch("/health", { method: "GET", timeout: 5000 });
    console.log("[whatsapp] WHAPI health check OK");
  } catch (err) {
    console.warn(`[whatsapp] WHAPI health check failed (continuing anyway): ${err.message}`);
  }

  console.log("[whatsapp] bot ready (webhook-driven)");

  return {
    stop: async () => {
      for (const t of typingIntervals) clearInterval(t);
      typingIntervals.clear();
    },
    sendMessage,
    sendImage,
    sendVoice,
    sendDocument,
    handleInbound,
  };
}
