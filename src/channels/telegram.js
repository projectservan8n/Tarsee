import { Telegraf } from "telegraf";
import { chatStream } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand } from "../lib/commands.js";

/**
 * Creates and starts a Telegram bot.
 *
 * @param {object} config - { token, enabled, allowedChats? }
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{stop: Function}>}
 */
export async function createTelegramBot(config, db) {
  const convStore = new ConversationStore(db);
  const settingsStore = new SettingsStore(db);

  const bot = new Telegraf(config.token);

  bot.on("text", async (ctx) => {
    const chatId = ctx.chat.id;
    const message = ctx.message.text;
    const username = ctx.from.username || ctx.from.first_name || "User";

    // Check allowed chats
    if (config.allowedChats?.length > 0) {
      if (!config.allowedChats.includes(String(chatId))) return;
    }

    if (!message?.trim()) return;

    // Check for commands
    if (message.startsWith("/")) {
      const channelKey = `telegram:${chatId}`;
      const existingConvId = settingsStore.get(`channel_conv.${channelKey}`);
      const cmdResult = await processCommand(message, {
        settingsStore,
        convStore,
        conversationId: existingConvId,
      });

      if (cmdResult.handled) {
        const chunks = splitMessage(cmdResult.response, 4096);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() => ctx.reply(chunk));
        }
        return;
      }
    }

    // Get or create conversation keyed by Telegram chat
    const channelKey = `telegram:${chatId}`;
    let convId = settingsStore.get(`channel_conv.${channelKey}`);

    if (!convId || !convStore.get(convId)) {
      const conv = convStore.create({
        title: ctx.chat.title || `Chat with ${username}`,
      });
      convId = conv.id;
      settingsStore.set(`channel_conv.${channelKey}`, convId);
    }

    // Save user message
    convStore.addMessage(convId, {
      role: "user",
      content: `[${username}]: ${message}`,
    });

    // Get provider
    const activeProvider = settingsStore.getActiveProvider();
    if (!activeProvider?.provider || !activeProvider?.apiKey) {
      await ctx.reply("No AI provider configured. Set one up in the OpusClaw web panel.");
      return;
    }

    // Send typing action
    await ctx.sendChatAction("typing").catch(() => {});

    const history = convStore.getRecentMessages(convId, 30);
    let fullResponse = "";

    try {
      const stream = chatStream({
        provider: activeProvider.provider,
        model: activeProvider.model,
        apiKey: activeProvider.apiKey,
        baseUrl: activeProvider.baseUrl,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        systemPrompt: "You are OpusClaw, a helpful AI assistant. Keep responses concise for chat. You are in a Telegram conversation.",
      });

      for await (const event of stream) {
        if (event.type === "text") {
          fullResponse += event.content;
        }
      }

      if (fullResponse) {
        convStore.addMessage(convId, {
          role: "assistant",
          content: fullResponse,
          provider: activeProvider.provider,
          model: activeProvider.model,
        });

        // Telegram has 4096 char limit
        const chunks = splitMessage(fullResponse, 4096);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() =>
            ctx.reply(chunk) // Fallback without markdown if parsing fails
          );
        }
      }
    } catch (err) {
      console.error("[telegram] chat error:", err.message);
      await ctx.reply("Sorry, I encountered an error processing your message.").catch(() => {});
    }
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
