import { Client, GatewayIntentBits, Events } from "discord.js";
import { chatStream } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";

/**
 * Creates and starts a Discord bot.
 *
 * @param {object} config - { token, enabled, allowedChannels?, allowDMs? }
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{stop: Function}>}
 */
export async function createDiscordBot(config, db) {
  const convStore = new ConversationStore(db);
  const settingsStore = new SettingsStore(db);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.on(Events.MessageCreate, async (message) => {
    // Ignore bots and self
    if (message.author.bot) return;
    if (message.author.id === client.user?.id) return;

    // Check if this channel/DM is allowed
    const isDM = !message.guild;
    if (isDM && config.allowDMs === false) return;

    if (!isDM && config.allowedChannels?.length > 0) {
      if (!config.allowedChannels.includes(message.channel.id)) return;
    }

    // Need to be mentioned in guilds (unless allowedChannels explicitly listed)
    if (!isDM && !config.allowedChannels?.length) {
      if (!message.mentions.has(client.user)) return;
    }

    const content = message.content
      .replace(new RegExp(`<@!?${client.user.id}>`), "")
      .trim();

    if (!content) return;

    // Get or create a conversation keyed by Discord channel
    const channelKey = `discord:${message.channel.id}`;
    let convId = settingsStore.get(`channel_conv.${channelKey}`);

    if (!convId || !convStore.get(convId)) {
      const conv = convStore.create({
        title: isDM ? `DM with ${message.author.username}` : `#${message.channel.name || "channel"}`,
        provider: null,
      });
      convId = conv.id;
      settingsStore.set(`channel_conv.${channelKey}`, convId);
    }

    // Save user message
    convStore.addMessage(convId, {
      role: "user",
      content: `[${message.author.username}]: ${content}`,
    });

    // Get provider config
    const activeProvider = settingsStore.getActiveProvider();
    if (!activeProvider?.provider || !activeProvider?.apiKey) {
      await message.reply("No AI provider configured. Set one up in the OpusClaw web panel.");
      return;
    }

    // Show typing indicator
    const typing = message.channel.sendTyping().catch(() => {});

    // Stream response
    const history = convStore.getRecentMessages(convId, 30);
    let fullResponse = "";

    try {
      const stream = chatStream({
        provider: activeProvider.provider,
        model: activeProvider.model,
        apiKey: activeProvider.apiKey,
        baseUrl: activeProvider.baseUrl,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        systemPrompt: "You are OpusClaw, a helpful AI assistant. Keep responses concise for chat. You are in a Discord conversation.",
      });

      for await (const event of stream) {
        if (event.type === "text") {
          fullResponse += event.content;
        }
      }

      // Save and send response
      if (fullResponse) {
        convStore.addMessage(convId, {
          role: "assistant",
          content: fullResponse,
          provider: activeProvider.provider,
          model: activeProvider.model,
        });

        // Discord has 2000 char limit — split if needed
        const chunks = splitMessage(fullResponse, 2000);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      }
    } catch (err) {
      console.error("[discord] chat error:", err.message);
      await message.reply("Sorry, I encountered an error processing your message.").catch(() => {});
    }
  });

  client.on(Events.ClientReady, () => {
    console.log(`[discord] logged in as ${client.user.tag}`);
  });

  client.on(Events.Error, (err) => {
    console.error("[discord] client error:", err.message);
  });

  await client.login(config.token);

  return {
    stop: async () => {
      await client.destroy();
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
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}
