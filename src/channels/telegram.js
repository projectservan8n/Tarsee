import { Telegraf } from "telegraf";
import { chatStream } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand } from "../lib/commands.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { parseReactions } from "../lib/reaction-parser.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";

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
   * Handle a text message (shared by text handler and callback handler).
   */
  async function handleMessage(ctx, text, replyToMessageId = null) {
    const chatId = ctx.chat.id;
    const username = ctx.from.username || ctx.from.first_name || "User";

    // Check allowed chats
    if (config.allowedChats?.length > 0) {
      if (!config.allowedChats.includes(String(chatId))) return;
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
        const chunks = splitMessage(cmdResult.response, 4096);
        for (const chunk of chunks) {
          await ctx.reply(chunk, {
            parse_mode: "Markdown",
            ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
          }).catch(() => ctx.reply(chunk));
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

    // Save user message
    convStore.addMessage(convId, {
      role: "user",
      content: `[${username}]: ${text}`,
    });

    // Get provider
    const activeProvider = settingsStore.getActiveProvider();
    if (!activeProvider?.provider || !activeProvider?.apiKey) {
      await ctx.reply("No AI provider configured. Set one up in the OpusClaw web panel.");
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
    const streaming = config.streaming ?? "partial";

    try {
      const stream = chatStream({
        provider: activeProvider.provider,
        model: activeProvider.model,
        apiKey: activeProvider.apiKey,
        baseUrl: activeProvider.baseUrl,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        systemPrompt,
      });

      // Live streaming: edit a preview message as tokens arrive
      let previewMsgId = null;
      let lastEditTime = 0;
      const EDIT_INTERVAL_MS = 1500;
      const typingInterval = setInterval(() => {
        ctx.sendChatAction("typing").catch(() => {});
      }, 4000);

      for await (const event of stream) {
        if (event.type === "text") {
          fullResponse += event.content;

          if (streaming === "partial" && fullResponse.length > 20) {
            const now = Date.now();
            if (now - lastEditTime > EDIT_INTERVAL_MS) {
              lastEditTime = now;
              const preview = fullResponse.slice(0, 4000) + (fullResponse.length > 4000 ? "..." : " ▎");
              try {
                if (!previewMsgId) {
                  const sent = await ctx.reply(preview, {
                    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
                  });
                  previewMsgId = sent.message_id;
                } else {
                  await ctx.telegram.editMessageText(
                    chatId, previewMsgId, undefined, preview
                  ).catch(() => {});
                }
              } catch {
                // Edit can fail
              }
            }
          }
        }
      }

      clearInterval(typingInterval);

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

        // Send final text
        const chunks = splitMessage(cleanText, 4096);

        if (previewMsgId && chunks.length === 1 && !buttons) {
          // Edit preview to final content
          await ctx.telegram.editMessageText(
            chatId, previewMsgId, undefined, chunks[0],
            { parse_mode: "Markdown" }
          ).catch(() =>
            ctx.telegram.editMessageText(chatId, previewMsgId, undefined, chunks[0]).catch(() => {})
          );
        } else {
          // Delete preview and send fresh
          if (previewMsgId) {
            await ctx.telegram.deleteMessage(chatId, previewMsgId).catch(() => {});
          }

          // Send text chunks
          for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            const opts = { parse_mode: "Markdown" };
            if (replyToMessageId && i === 0) opts.reply_to_message_id = replyToMessageId;

            // Attach inline buttons to the last chunk
            if (isLast && buttons?.length > 0) {
              opts.reply_markup = {
                inline_keyboard: buttonsToKeyboard(buttons),
              };
            }

            await ctx.reply(chunks[i], opts).catch(() => ctx.reply(chunks[i]));
          }

          // If no text chunks but we have buttons, send buttons alone
          if (chunks.length === 0 && buttons?.length > 0) {
            await ctx.reply("Choose:", {
              reply_markup: { inline_keyboard: buttonsToKeyboard(buttons) },
            });
          }
        }
      }
    } catch (err) {
      console.error("[telegram] chat error:", err.message);
      await ctx.reply("Sorry, I encountered an error processing your message.").catch(() => {});
    }
  }

  // --- Main text handler ---
  bot.on("text", async (ctx) => {
    await handleMessage(ctx, ctx.message.text);
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
  console.log(`[telegram] bot started`);

  return {
    stop: async () => {
      bot.stop("OpusClaw shutdown");
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
