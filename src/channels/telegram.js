import { Telegraf } from "telegraf";
import { chatStream } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand } from "../lib/commands.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { parseReactions } from "../lib/reaction-parser.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { transcribeAudio } from "../voice/stt-handler.js";

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
    return { data: buffer.toString("base64"), mediaType: contentType };
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

    // Check for commands
    if (text.startsWith("/")) {
      const existingConvId = settingsStore.get(`channel_conv.${channelKey}`);
      const cmdResult = await processCommand(text, {
        settingsStore,
        convStore,
        conversationId: existingConvId,
      });

      if (cmdResult.handled) {
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

    // Send typing action
    await ctx.sendChatAction("typing").catch(() => {});

    // Build full system prompt (identity + memory + skills)
    const history = convStore.getRecentMessages(convId, 30);
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

    // Keep typing indicator alive while processing
    const typingInterval = setInterval(() => {
      ctx.sendChatAction("typing").catch(() => {});
    }, 4000);

    try {
      let workingMessages = history.map((m) => ({ role: m.role, content: m.content }));

      // Enrich last user message with image blocks if attachments present
      if (attachments.length > 0 && workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") {
          const contentBlocks = [];
          for (const att of attachments) {
            contentBlocks.push(att);
          }
          contentBlocks.push({ type: "text", text: typeof last.content === "string" ? last.content : text });
          last.content = contentBlocks;
        }
      }

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const toolCalls = [];
        let roundText = "";
        let stopReason = "end_turn";

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
        });

        for await (const event of stream) {
          if (event.type === "text") {
            roundText += event.content;
            fullResponse += event.content;
          } else if (event.type === "tool_use") {
            toolCalls.push({ id: event.id, name: event.name, input: event.input });
          } else if (event.type === "done") {
            stopReason = event.stopReason || "end_turn";
            break;
          }
        }

        // No tool calls — done
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
          console.log(`[telegram] tool: ${tc.name}(${JSON.stringify(tc.input).slice(0, 80)})`);
          const result = await executeTool(tc.name, tc.input, toolCtx);
          toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
        }
        workingMessages.push({ role: "user", content: toolResults });
      }

      if (fullResponse) {
        // Extract memories before parsing reactions
        fullResponse = extractAndSaveMemories(fullResponse, db, convId);

        // Parse agent reactions and buttons
        const { cleanText, reactions, buttons } = parseReactions(fullResponse);

        convStore.addMessage(convId, {
          role: "assistant",
          content: cleanText,
          provider: activeProvider.provider,
          model: activeProvider.model,
        });

        // Apply agent reactions to the original message
        for (const emoji of reactions) {
          if (ctx.message?.message_id) {
            ctx.telegram.setMessageReaction?.(chatId, ctx.message.message_id, [{ type: "emoji", emoji }]).catch(() => {});
          }
        }

        // Send final text (convert markdown to Telegram HTML)
        const htmlText = mdToTelegramHtml(cleanText);
        const chunks = splitMessage(htmlText, 4096);

        for (let i = 0; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          const opts = { parse_mode: "HTML" };
          if (replyToMessageId && i === 0) opts.reply_to_message_id = replyToMessageId;

          // Attach inline buttons to the last chunk
          if (isLast && buttons?.length > 0) {
            opts.reply_markup = {
              inline_keyboard: buttonsToKeyboard(buttons),
            };
          }

          await ctx.reply(chunks[i], opts).catch(() =>
            ctx.reply(chunks[i].replace(/<[^>]+>/g, ""))
          );
        }

        // If no text chunks but we have buttons, send buttons alone
        if (chunks.length === 0 && buttons?.length > 0) {
          await ctx.reply("Choose:", {
            reply_markup: { inline_keyboard: buttonsToKeyboard(buttons) },
          });
        }
      }
    } catch (err) {
      console.error("[telegram] chat error:", err.message);
      await ctx.reply("Sorry, I encountered an error processing your message.").catch(() => {});
    } finally {
      clearInterval(typingInterval);
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

    // In groups: only respond if mentioned by @username or replied to
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      const botUsername = ctx.botInfo?.username;
      const isMentioned = botUsername && text.includes(`@${botUsername}`);
      const isReply = ctx.message.reply_to_message?.from?.id === ctx.botInfo?.id;
      if (!isMentioned && !isReply) return; // Ignore messages not directed at the bot
      // Strip the @mention from text
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

  // --- Document handler (files including images and PDFs) ---
  bot.on("document", async (ctx) => {
    try {
      const doc = ctx.message.document;
      const mime = doc.mime_type || "";
      const caption = ctx.message.caption || "";

      if (mime.startsWith("image/")) {
        const { data, mediaType } = await downloadTelegramFile(doc.file_id);
        const attachment = { type: "image", source: { type: "base64", media_type: mediaType, data } };
        await handleMessage(ctx, caption || "Please analyze this image.", null, [attachment]);
      } else if (mime === "application/pdf") {
        // Download PDF and pass as text description with base64
        const { data } = await downloadTelegramFile(doc.file_id);
        const text = caption || `[PDF attached: ${doc.file_name}]`;
        // Save PDF info for Claude to process via Bash tools
        await handleMessage(ctx, `${text}\n\n[PDF file: ${doc.file_name} (${Math.round(doc.file_size / 1024)}KB) — base64 data available in this message]`);
      } else {
        await handleMessage(ctx, caption || `[Sent file: ${doc.file_name} (${mime})]`);
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

  // Register /commands dropdown in Telegram
  bot.telegram.setMyCommands([
    { command: "help", description: "Show available commands" },
    { command: "model", description: "Switch model (opus, sonnet, haiku)" },
    { command: "clear", description: "Start a new conversation" },
    { command: "status", description: "System status" },
    { command: "soul", description: "Show personality" },
    { command: "skills", description: "List available skills" },
    { command: "cron", description: "Manage scheduled tasks" },
    { command: "remember", description: "Save to memory" },
    { command: "daily", description: "Today's log" },
    { command: "export", description: "Export conversation" },
    { command: "doctor", description: "Run diagnostics" },
  ]).then(() => console.log("[telegram] Commands registered")).catch(e => console.warn("[telegram] Failed to register commands:", e.message));

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
  return text
    // Code blocks first (before other transforms)
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => `<pre>${escapeHtml(code.trim())}</pre>`)
    // Inline code
    .replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`)
    // Bold (**text**)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    // Italic (*text*)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>")
    // Links [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
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
