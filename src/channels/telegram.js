import fs from "node:fs";
import path from "node:path";
import { Telegraf } from "telegraf";
import { chatStream } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand, extractPlaybookPrompt, getCommandList } from "../lib/commands.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { parseReactions } from "../lib/reaction-parser.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { toolStatusLabel, toolDoneLabel } from "../lib/tool-status.js";
import { transcribeAudio } from "../voice/stt-handler.js";
import envConfig from "../config/env.js";

/**
 * Creates and starts a Telegram bot.
 *
 * @param {object} config - { token, enabled, allowedChats?, ackReaction?, streaming? }
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{stop: Function}>}
 */
export async function createTelegramBot(config, db) {
  const convStore = new ConversationStore(db);
  const settingsStore = new SettingsStore(db);

  const bot = new Telegraf(config.token);

  /**
   * Resolve channel key — supports topics (forum threads).
   */
  function getChannelKey(ctx) {
    const chatId = ctx.chat.id;
    const threadId = ctx.message?.message_thread_id;
    if (threadId) return `telegram:${chatId}:topic:${threadId}`;
    return `telegram:${chatId}`;
  }

  /**
   * Download a Telegram file and return as base64 + media type.
   */
  async function downloadTelegramFile(fileId) {
    const fileLink = await bot.telegram.getFileLink(fileId);
    const res = await fetch(fileLink.href);
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "image/jpeg";
    return { data: buffer.toString("base64"), mediaType: contentType, buffer };
  }

  /**
   * Save a downloaded file to WORKSPACE_DIR/uploads so Claude can reach it
   * via Read/Bash. Returns the absolute path or null on failure.
   */
  function saveDocumentToDisk(buffer, fileName) {
    try {
      const uploadsDir = path.join(envConfig.WORKSPACE_DIR, "uploads");
      fs.mkdirSync(uploadsDir, { recursive: true });
      const safeName = (fileName || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(uploadsDir, `telegram-${Date.now()}-${safeName}`);
      fs.writeFileSync(filePath, buffer);
      return filePath;
    } catch (err) {
      console.error("[telegram] saveDocumentToDisk failed:", err.message);
      return null;
    }
  }

  /**
   * Handle a message (shared by text, photo, and callback handlers).
   * @param {object} ctx - Telegraf context
   * @param {string} text - Message text
   * @param {number|null} replyToMessageId - Message to reply to
   * @param {Array} [attachments] - Image attachments [{type, source: {type, media_type, data}}]
   */
  async function handleMessage(ctx, text, replyToMessageId = null, attachments = []) {
    const chatId = ctx.chat.id;
    const username = ctx.from.username || ctx.from.first_name || "User";

    // Check allowed chats (from config or settings DB allowlist)
    const dbAllowlist = settingsStore.get("allowlist.telegram");
    const allowedChats = config.allowedChats?.length > 0 ? config.allowedChats : (dbAllowlist ? (typeof dbAllowlist === "string" ? JSON.parse(dbAllowlist) : dbAllowlist) : []);
    if (allowedChats.length > 0) {
      if (!allowedChats.includes(String(chatId))) return;
    }

    if (!text?.trim()) return;

    const channelKey = getChannelKey(ctx);

    // Check for commands. Commands can either (a) return a plain reply
    // to echo back, or (b) return a __PLAYBOOK__ sentinel that's meant to
    // be fed to the AI as the user's next turn. We detect (b) and fall
    // through to the normal AI pipeline instead of sending the playbook
    // text back at the user.
    let aiPromptOverride = null;
    if (text.startsWith("/")) {
      const existingConvId = settingsStore.get(`channel_conv.${channelKey}`);
      const cmdResult = await processCommand(text, {
        settingsStore,
        convStore,
        conversationId: existingConvId,
        platform: "telegram",
      });

      if (cmdResult.handled) {
        const playbook = extractPlaybookPrompt(cmdResult);
        if (playbook) {
          aiPromptOverride = playbook;
        } else {
          const chunks = splitMessage(mdToTelegramHtml(cmdResult.response), 4096);
          for (const chunk of chunks) {
            await ctx.reply(chunk, {
              parse_mode: "HTML",
              ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
            }).catch(() => ctx.reply(chunk.replace(/<[^>]+>/g, "")));
          }
          return;
        }
      }
    }

    // Get or create conversation keyed by Telegram chat/topic
    let convId = settingsStore.get(`channel_conv.${channelKey}`);

    if (!convId || !convStore.get(convId)) {
      const title = ctx.message?.message_thread_id
        ? `${ctx.chat.title || "Chat"} > Topic ${ctx.message.message_thread_id}`
        : ctx.chat.title || `Chat with ${username}`;
      const conv = convStore.create({ title });
      convId = conv.id;
      settingsStore.set(`channel_conv.${channelKey}`, convId);
    }

    // Save user message (text only — no base64 in DB)
    convStore.addMessage(convId, {
      role: "user",
      content: `[${username}]: ${text}${attachments.length ? ` [+${attachments.length} image(s)]` : ""}`,
    });

    // Get provider
    const activeProvider = settingsStore.getActiveProvider();
    if (!activeProvider?.provider || !activeProvider?.ready) {
      await ctx.reply("No AI provider configured. Set one up in the Tarsee web panel.");
      return;
    }

    // Ack reaction — let user know we're processing
    const ackEmoji = config.ackReaction ?? "👀";
    if (ackEmoji) {
      ctx.react?.(ackEmoji).catch?.(() => {});
    }

    // Keep the native "typing..." indicator alive while processing. No
    // "💭 Thinking..." placeholder message — we used to send one and edit
    // it with tool progress, but users found it noisy. Final reply is the
    // only bubble the user sees.
    await ctx.sendChatAction("typing").catch(() => {});
    const typingInterval = setInterval(() => {
      ctx.sendChatAction("typing").catch(() => {});
    }, 4000);

    // Build full system prompt
    const history = convStore.getRecentMessages(convId, 15);
    const conv = convStore.get(convId);
    const systemPrompt = buildSystemPrompt({
      settingsStore,
      db,
      conversationId: convId,
      messageCount: history.length,
      conversationPrompt: conv?.system_prompt,
      channelHint: `Keep responses concise for chat. You are in a Telegram conversation.
You can use these special markers in your response:
- [react: emoji] — adds a reaction to the user's message (e.g. [react: ✅])
- [buttons: ["Option A", "Option B"]] — sends inline buttons the user can tap`,
    });

    let fullResponse = "";
    const tools = getToolDefinitions();
    const toolCtx = { db, settingsStore, conversationId: convId };
    const MAX_TOOL_ROUNDS = 15;

    // Idle watchdog: if the SDK goes 3 min without emitting an event we abort
    // and send the user an explicit message instead of hanging forever.
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

    // Streaming-segment state — each text block between tool boundaries
    // becomes its own Telegram message that edit-streams as tokens arrive.
    // Tool calls produce ephemeral status messages ("Running command…"
    // → "✓ Command done") so the user sees realtime progress instead of
    // a long silence. The DB still gets the full XML-wrapped transcript
    // so subsequent turns and the webapp see the complete history.
    let segmentMsgId = null;
    let segmentText = "";
    let lastSegmentEditAt = 0;
    const SEGMENT_EDIT_DEBOUNCE_MS = 900; // Telegram edit cap is ~1/sec/message
    const toolMsgById = new Map(); // tool_use_id → status message_id
    const sentSegments = []; // for closeSegment overflow tracking, debug only

    const editMessageSafe = async (msgId, html, opts = {}) => {
      try {
        await ctx.telegram.editMessageText(chatId, msgId, undefined, html, { parse_mode: "HTML", ...opts });
      } catch (e) {
        const code = e?.response?.error_code || e?.code;
        // 400 "message is not modified" → benign. 429 → fall through; the
        // next debounced edit will retry. Fallback strip-on-error in case
        // of malformed HTML.
        if (code === 400 && /not modified/i.test(e?.description || e?.message || "")) return;
        if (code === 400) {
          try { await ctx.telegram.editMessageText(chatId, msgId, undefined, html.replace(/<[^>]+>/g, ""), opts); } catch {}
        }
      }
    };

    const renderSegmentDisplay = (raw) => {
      // Strip [react:] / [buttons:] markers for display — they're parsed
      // post-hoc from the saved fullResponse, so the user shouldn't see
      // them mid-stream.
      const { cleanText } = parseReactions(raw);
      const stripped = cleanText
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
        .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return mdToTelegramHtml(stripped);
    };

    const flushSegmentEdit = async (final = false) => {
      if (!segmentMsgId || !segmentText) return;
      const now = Date.now();
      if (!final && now - lastSegmentEditAt < SEGMENT_EDIT_DEBOUNCE_MS) return;
      lastSegmentEditAt = now;
      const html = renderSegmentDisplay(segmentText.slice(0, 4096));
      if (!html) return; // empty after stripping markers — wait for more
      await editMessageSafe(segmentMsgId, html);
    };

    const closeSegment = async (extraOpts = null) => {
      if (!segmentMsgId) { segmentText = ""; return; }
      await flushSegmentEdit(true);
      // If the segment text overflowed, send remainder as new replies so
      // the user sees the full thing.
      if (segmentText.length > 4096) {
        for (let i = 4096; i < segmentText.length; i += 4096) {
          const html = renderSegmentDisplay(segmentText.slice(i, i + 4096));
          if (!html) continue;
          const chunks = splitMessage(html, 4096);
          for (const chunk of chunks) {
            await ctx.reply(chunk, { parse_mode: "HTML", ...(extraOpts || {}) })
              .catch(() => ctx.reply(chunk.replace(/<[^>]+>/g, ""), extraOpts || {}));
          }
        }
      } else if (extraOpts && segmentMsgId) {
        // Re-edit the final segment with the extras (e.g. inline_keyboard
        // for buttons attached to the last narration block).
        const html = renderSegmentDisplay(segmentText.slice(0, 4096));
        if (html) await editMessageSafe(segmentMsgId, html, extraOpts);
      }
      sentSegments.push(segmentText);
      segmentMsgId = null;
      segmentText = "";
    };

    const postToolStatus = async (event) => {
      try {
        const label = toolStatusLabel(event.name, event.input);
        const msg = await ctx.reply(`<i>⚙️ ${escapeHtml(label)}</i>`, { parse_mode: "HTML" });
        toolMsgById.set(event.id, msg.message_id);
      } catch { /* best-effort */ }
    };
    const markToolDone = async (id, name, input, result) => {
      const msgId = toolMsgById.get(id);
      if (!msgId) return;
      const resultStr = typeof result === "string" ? result : JSON.stringify(result || "");
      const isErr = /error|forbidden|not found|enotfound|command not found/i.test(resultStr);
      const label = toolDoneLabel(name, input || {}, isErr);
      const html = isErr ? `<i>❌ ${escapeHtml(label)}</i>` : `<i>✓ ${escapeHtml(label)}</i>`;
      await editMessageSafe(msgId, html);
      toolMsgById.delete(id);
    };

    try {
      let workingMessages = history.map((m) => ({ role: m.role, content: m.content }));

      // Slash-command playbooks: keep the user's literal "/checkpoint" in
      // the DB / chat history, but swap the AI-visible last user turn for
      // the playbook body so the model acts on it.
      if (aiPromptOverride && workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") last.content = aiPromptOverride;
      }

      // Enrich last user message with image blocks if attachments present
      if (attachments.length > 0 && workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") {
          const contentBlocks = [];
          for (const att of attachments) contentBlocks.push(att);
          contentBlocks.push({ type: "text", text: typeof last.content === "string" ? last.content : text });
          last.content = contentBlocks;
        }
      }

      // One-shot retry budget for recoverable session-corruption errors
      // (Anthropic API rejecting diagnostics.previous_message_id from a
      // stale resumed session). We clear the stored session id and retry
      // the SAME round once. Further rounds use the cleared (null) session
      // so we don't loop on the same corrupt state.
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
            // Stream this delta into the current segment message — create
            // the placeholder on first text of each segment.
            if (!segmentMsgId) {
              try {
                const placeholder = await ctx.reply("…");
                segmentMsgId = placeholder.message_id;
              } catch { /* if reply fails just keep accumulating; we'll
                            fall back to a final batched send */ }
            }
            segmentText += event.content;
            await flushSegmentEdit(false);
          } else if (event.type === "tool_use") {
            // Narration ends here — finalize the visible segment and post
            // the tool status indicator.
            await closeSegment();
            toolCalls.push({ id: event.id, name: event.name, input: event.input });
            const callJson = JSON.stringify({ name: event.name, arguments: event.input })
              .replace(/<\/(tool_call|tool_response)>/gi, "<_/$1>");
            fullResponse += `\n<tool_call>${callJson}</tool_call>\n`;
            await postToolStatus(event);
          } else if (event.type === "error") {
            if (event.recoverable && !sessionRetried) {
              sessionRetried = true;
              recoverRound = true;
              convStore.setClaudeSessionId(convId, null);
              console.warn(`[telegram] session corrupt, clearing and retrying: ${String(event.message || "").slice(0, 200)}`);
              // Drop any half-built segment placeholder so we don't leave
              // a stray "…" message hanging when the retry succeeds.
              if (segmentMsgId) {
                try { await ctx.telegram.deleteMessage(chatId, segmentMsgId); } catch {}
                segmentMsgId = null;
                segmentText = "";
              }
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

        // Execute tools and update each status message as results land.
        const toolResults = [];
        for (const tc of toolCalls) {
          console.log(`[telegram] tool: ${tc.name}`);
          const result = await executeTool(tc.name, tc.input, toolCtx);
          toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
          const resultText = (typeof result === "string" ? result : JSON.stringify(result))
            .replace(/<\/(tool_call|tool_response)>/gi, "<_/$1>");
          fullResponse += `\n<tool_response>${resultText}</tool_response>\n`;
          await markToolDone(tc.id, tc.name, tc.input, result);
        }
        workingMessages.push({ role: "user", content: toolResults });
      }

      if (fullResponse) {
        fullResponse = extractAndSaveMemories(fullResponse, db, convId);
        const { cleanText, reactions, buttons } = parseReactions(fullResponse);

        convStore.addMessage(convId, {
          role: "assistant",
          content: cleanText,
          provider: activeProvider.provider,
          model: activeProvider.model,
        });

        // Apply agent reactions to the user's original message.
        for (const emoji of reactions) {
          if (ctx.message?.message_id) {
            ctx.telegram.setMessageReaction?.(chatId, ctx.message.message_id, [{ type: "emoji", emoji }]).catch(() => {});
          }
        }

        // Close the final narration segment. If buttons were emitted,
        // attach them to the last segment via inline_keyboard, or — if
        // the model replied with buttons but no text — send a separate
        // "Choose:" message.
        const buttonOpts = buttons?.length > 0
          ? { reply_markup: { inline_keyboard: buttonsToKeyboard(buttons) } }
          : null;

        if (segmentMsgId || segmentText) {
          await closeSegment(buttonOpts);
        } else if (buttonOpts) {
          await ctx.reply("Choose:", buttonOpts);
        } else if (sentSegments.length === 0) {
          // Model produced only tool calls + nothing user-facing.
          // Surface a soft note so the chat doesn't look broken.
          await ctx.reply("⚠️ Done — no message body.").catch(() => {});
        }
      } else if (surfacedError) {
        // Show a clean recovery message instead of leaking the raw API
        // error string. Session has already been cleared above, so the
        // next user message will start fresh.
        const isSessionErr = /previous_message_id|session/i.test(String(surfacedError));
        const userMsg = isSessionErr
          ? "⚠️ Session reset due to a transient API hiccup. Just send your message again — your history is preserved."
          : `⚠️ Upstream error: ${String(surfacedError).slice(0, 200)}\n\nTry again — if it keeps happening, /clear and try fresh.`;
        await ctx.reply(userMsg).catch(() => {});
      } else if (idleAborted) {
        await ctx.reply("⚠️ Claude Code stopped responding (3 min idle). Try again — maybe with a smaller ask.").catch(() => {});
      } else {
        await ctx.reply("⚠️ No response generated. Try rephrasing?").catch(() => {});
      }
    } catch (err) {
      console.error("[telegram] chat error:", err.message);
      const reason = idleAborted
        ? "⚠️ Claude Code stopped responding (3 min idle). Try again — maybe with a smaller ask."
        : `⚠️ Error: ${err.message || "something went wrong"}. Try again.`;
      await ctx.reply(reason).catch(() => {});
    } finally {
      clearInterval(typingInterval);
      clearInterval(idleTimer);
    }
  }

  // --- Main text handler ---
  bot.on("text", async (ctx) => {
    let text = ctx.message.text;

    // Detect forwarded messages — add context
    if (ctx.message.forward_from || ctx.message.forward_sender_name) {
      const from = ctx.message.forward_from?.first_name || ctx.message.forward_sender_name || "someone";
      text = `[Forwarded from ${from}]: ${text}`;
    }

    // Include replied-to message as context
    const repliedMsg = ctx.message.reply_to_message;
    if (repliedMsg && repliedMsg.text) {
      const repliedFrom = repliedMsg.from?.first_name || repliedMsg.from?.username || "someone";
      text = `[Replying to ${repliedFrom}: "${repliedMsg.text}"]\n\n${text}`;
    }

    // In groups: optionally require @mention or reply-to-bot. Toggleable via
    // telegram.mention_mode setting — "required" (default) keeps the prior
    // behavior; "off" lets allowlisted users chat without tagging the bot.
    // Always strip the bot's @handle from the text so the model never sees
    // it, regardless of mode.
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      const botUsername = ctx.botInfo?.username;
      const mentionMode = settingsStore.get("telegram.mention_mode") === "off" ? "off" : "required";
      if (mentionMode === "required") {
        const isMentioned = botUsername && text.includes(`@${botUsername}`);
        const isReply = repliedMsg?.from?.id === ctx.botInfo?.id;
        if (!isMentioned && !isReply) return;
      }
      if (botUsername) text = text.replace(new RegExp(`@${botUsername}\\b`, "gi"), "").trim();
    }

    await handleMessage(ctx, text);
  });

  // --- Photo handler with multi-image batching ---
  // Telegram sends media groups as separate messages with same media_group_id.
  // Buffer them and process together after a short delay.
  const mediaGroupBuffer = new Map(); // media_group_id → { ctx, images[], caption, timer }

  bot.on("photo", async (ctx) => {
    try {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const { data, mediaType } = await downloadTelegramFile(largest.file_id);
      const attachment = { type: "image", source: { type: "base64", media_type: mediaType, data } };
      const caption = ctx.message.caption || "";
      const groupId = ctx.message.media_group_id;

      if (groupId) {
        // Part of a media group — buffer it
        if (!mediaGroupBuffer.has(groupId)) {
          mediaGroupBuffer.set(groupId, { ctx, images: [], caption: "", timer: null });
        }
        const group = mediaGroupBuffer.get(groupId);
        group.images.push(attachment);
        if (caption) group.caption = caption;

        // Reset timer — process 500ms after last photo in group arrives
        clearTimeout(group.timer);
        group.timer = setTimeout(async () => {
          mediaGroupBuffer.delete(groupId);
          const text = group.caption || `Please analyze these ${group.images.length} images.`;
          await handleMessage(group.ctx, text, null, group.images);
        }, 500);
      } else {
        // Single photo — process immediately
        await handleMessage(ctx, caption || "Please analyze this image.", null, [attachment]);
      }
    } catch (err) {
      console.error("[telegram] photo handler error:", err.message);
      await ctx.reply("Failed to process image.").catch(() => {});
    }
  });

  // --- Document handler (files including images, PDFs, and generic files) ---
  bot.on("document", async (ctx) => {
    try {
      const doc = ctx.message.document;
      const mime = doc.mime_type || "";
      const caption = ctx.message.caption || "";
      const sizeKb = Math.round((doc.file_size || 0) / 1024);

      if (mime.startsWith("image/")) {
        const { data, mediaType } = await downloadTelegramFile(doc.file_id);
        const attachment = { type: "image", source: { type: "base64", media_type: mediaType, data } };
        await handleMessage(ctx, caption || "Please analyze this image.", null, [attachment]);
      } else if (mime === "application/pdf") {
        // PDF: multimodal document block + save to disk so Claude's Read
        // tool can reach it if needed.
        const { data, buffer } = await downloadTelegramFile(doc.file_id);
        const attachment = { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
        const savedPath = saveDocumentToDisk(buffer, doc.file_name);
        const pathNote = savedPath
          ? `\n\n[PDF attached: ${doc.file_name} (${sizeKb}KB) → ${savedPath}] — multimodal PDF block provided above; you can also Read this file directly at the path.`
          : "";
        await handleMessage(ctx, (caption || "Please analyze this PDF.") + pathNote, null, [attachment]);
      } else {
        // Generic file (txt/json/csv/docx/zip/etc.) — save to disk and
        // surface the path to Claude so it can Read the file. Previously
        // the bytes were thrown away after a one-line description.
        const { buffer } = await downloadTelegramFile(doc.file_id);
        const savedPath = saveDocumentToDisk(buffer, doc.file_name);
        const note = savedPath
          ? `[Attached file saved: ${doc.file_name} (${mime || "unknown"}, ${sizeKb}KB) → ${savedPath}]\nYou can read this file with the Read tool at: ${savedPath}`
          : `[Sent file: ${doc.file_name} (${mime}) — failed to save to disk]`;
        const text = caption ? `${caption}\n\n${note}` : note;
        await handleMessage(ctx, text);
      }
    } catch (err) {
      console.error("[telegram] document handler error:", err.message);
      await ctx.reply("Failed to process file.").catch(() => {});
    }
  });

  // --- Voice message handler (transcribe with whisper.cpp) ---
  bot.on("voice", async (ctx) => {
    try {
      const voice = ctx.message.voice;
      console.log(`[telegram] voice message: ${voice.duration}s, ${voice.file_size} bytes`);

      // Download the .ogg file from Telegram
      const fileLink = await bot.telegram.getFileLink(voice.file_id);
      const res = await fetch(fileLink.href);
      const audioBuffer = Buffer.from(await res.arrayBuffer());

      // Transcribe
      await ctx.sendChatAction("typing").catch(() => {});
      const result = await transcribeAudio(audioBuffer, "en", { settingsStore });

      if (!result.transcript?.trim()) {
        await ctx.reply("Couldn't understand the voice message.", {
          reply_to_message_id: ctx.message.message_id,
        });
        return;
      }

      console.log(`[telegram] transcribed: "${result.transcript.slice(0, 80)}..."`);
      await handleMessage(ctx, result.transcript, ctx.message.message_id);
    } catch (err) {
      console.error("[telegram] voice handler error:", err.message);
      await ctx.reply("Failed to process voice message.").catch(() => {});
    }
  });

  // --- Voice note (video message / round video) handler ---
  bot.on("video_note", async (ctx) => {
    try {
      const vn = ctx.message.video_note;
      console.log(`[telegram] video note: ${vn.duration}s`);

      const fileLink = await bot.telegram.getFileLink(vn.file_id);
      const res = await fetch(fileLink.href);
      const audioBuffer = Buffer.from(await res.arrayBuffer());

      await ctx.sendChatAction("typing").catch(() => {});
      const result = await transcribeAudio(audioBuffer, "en", { settingsStore });

      if (!result.transcript?.trim()) {
        await ctx.reply("Couldn't understand the video note.", {
          reply_to_message_id: ctx.message.message_id,
        });
        return;
      }

      console.log(`[telegram] transcribed video note: "${result.transcript.slice(0, 80)}..."`);
      await handleMessage(ctx, result.transcript, ctx.message.message_id);
    } catch (err) {
      console.error("[telegram] video_note handler error:", err.message);
      await ctx.reply("Failed to process video note.").catch(() => {});
    }
  });

  // --- Inline button callback handler ---
  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (!data) return;

    // Acknowledge the button press immediately
    await ctx.answerCbQuery().catch(() => {});

    // Feed button click back into the conversation as a user message
    const buttonText = `[Button clicked: ${data}]`;
    await handleMessage(ctx, buttonText, ctx.callbackQuery?.message?.message_id);
  });

  bot.catch((err) => {
    console.error("[telegram] bot error:", err.message);
  });

  // Use polling (no webhook needed)
  await bot.launch({ dropPendingUpdates: true });

  // Register the /commands dropdown with Telegram so typing "/" in a chat
  // pops up the native command suggestions. Derive it from the shared
  // command registry so new commands automatically show up here instead
  // of needing a hardcoded list to stay in sync.
  //
  // Telegram rules: name must match ^[a-z0-9_]{1,32}$, description must
  // be 3–256 chars, max 100 commands total. We filter + truncate rather
  // than silently dropping the whole set if one entry is out of spec.
  try {
    const tgCommands = getCommandList()
      .filter((c) => /^[a-z0-9_]{1,32}$/.test(c.name) && c.description)
      .map((c) => ({
        command: c.name,
        description: String(c.description).slice(0, 256),
      }))
      .slice(0, 100);
    await bot.telegram.setMyCommands(tgCommands);
    console.log(`[telegram] registered ${tgCommands.length} commands with Telegram`);
  } catch (err) {
    console.warn("[telegram] Failed to register commands:", err.message);
  }

  console.log(`[telegram] bot started`);

  return {
    stop: async () => {
      bot.stop("Tarsee shutdown");
    },
    /** Send a message to a Telegram chat (outbound push). */
    sendMessage: async (chatId, text) => {
      const html = mdToTelegramHtml(text);
      await bot.telegram.sendMessage(chatId, html, { parse_mode: "HTML" })
        .catch(() => bot.telegram.sendMessage(chatId, html.replace(/<[^>]+>/g, "")));
    },
  };
}

/**
 * Convert buttons array to Telegram inline keyboard format.
 * Arranges up to 3 buttons per row.
 */
function buttonsToKeyboard(buttons) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += 3) {
    rows.push(
      buttons.slice(i, i + 3).map((b) => ({
        text: b.text,
        callback_data: String(b.data).slice(0, 64), // Telegram 64-byte limit
      }))
    );
  }
  return rows;
}

/**
 * Convert common Markdown to Telegram HTML.
 * Handles: **bold**, *italic*, `code`, ```code blocks```, [links](url)
 */
function mdToTelegramHtml(text) {
  // 1. Extract code blocks first (protect from other transforms)
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const langTag = lang ? `<code class="language-${escapeHtml(lang)}">` : "";
    const langClose = lang ? "</code>" : "";
    codeBlocks.push(`<pre>${langTag}${escapeHtml(code.trim())}${langClose}</pre>`);
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  // 2. Detect markdown tables (lines with |) and wrap in <pre> with aligned columns
  text = text.replace(/((?:^|\n)\|.+\|(?:\n\|.+\|)+)/g, (table) => {
    const lines = table.trim().split("\n");
    // Parse all rows into cells
    const rows = lines
      .filter(line => !/^\|[\s\-:|]+\|$/.test(line)) // remove separator rows
      .map(line => line.replace(/^\||\|$/g, "").split("|").map(c => c.trim()));

    if (rows.length === 0) return table;

    // Calculate max width for each column
    const colCount = Math.max(...rows.map(r => r.length));
    const colWidths = Array(colCount).fill(0);
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        colWidths[i] = Math.max(colWidths[i], (row[i] || "").length);
      }
    }

    // Format rows with padding
    const formatted = rows.map((row, rowIdx) => {
      const cells = row.map((cell, i) => (cell || "").padEnd(colWidths[i]));
      const line = cells.join(" | ");
      return line;
    });

    // Insert separator after header
    if (formatted.length > 1) {
      const sep = colWidths.map(w => "-".repeat(w)).join("-+-");
      formatted.splice(1, 0, sep);
    }

    return `\n<pre>${escapeHtml(formatted.join("\n"))}</pre>\n`;
  });

  text = text
    // Inline code
    .replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`)
    // Bold (**text**)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    // Italic (*text*)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>")
    // Strikethrough (~~text~~)
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    // Links [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Headings (## text) → bold
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    // Blockquotes (> text) — merge consecutive lines into single blockquote
    .replace(/(^>\s?.+$(\n^>\s?.+$)*)/gm, (block) => {
      const lines = block.split("\n").map(l => l.replace(/^>\s?/, "")).join("\n");
      return `<blockquote>${lines}</blockquote>`;
    });

  // 3. Restore code blocks
  text = text.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)]);

  return text;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}
