import pkg from "@slack/bolt";
const { App } = pkg;
import { chatStream } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand } from "../lib/commands.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";

/**
 * Creates and starts a Slack bot.
 *
 * @param {object} config - { token (bot token), appToken (app-level token), enabled }
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{stop: Function}>}
 */
export async function createSlackBot(config, db) {
  const convStore = new ConversationStore(db);
  const settingsStore = new SettingsStore(db);

  const app = new App({
    token: config.token,
    appToken: config.appToken,
    socketMode: true,  // No public URL needed
  });

  // Listen for messages
  app.message(async ({ message, say }) => {
    // Ignore bot messages
    if (message.subtype || message.bot_id) return;

    const text = message.text?.trim();
    if (!text) return;

    // Check for commands
    if (text.startsWith("/")) {
      const channelKey = `slack:${message.channel}`;
      const existingConvId = settingsStore.get(`channel_conv.${channelKey}`);
      const cmdResult = await processCommand(text, {
        settingsStore,
        convStore,
        conversationId: existingConvId,
      });

      if (cmdResult.handled) {
        await say(cmdResult.response);
        return;
      }
    }

    const channelKey = `slack:${message.channel}`;
    let convId = settingsStore.get(`channel_conv.${channelKey}`);

    if (!convId || !convStore.get(convId)) {
      const conv = convStore.create({
        title: `Slack #${message.channel}`,
      });
      convId = conv.id;
      settingsStore.set(`channel_conv.${channelKey}`, convId);
    }

    // Save user message
    convStore.addMessage(convId, {
      role: "user",
      content: text,
    });

    // Get provider
    const activeProvider = settingsStore.getActiveProvider();
    if (!activeProvider?.provider || !activeProvider?.apiKey) {
      await say("No AI provider configured. Set one up in the OpusClaw web panel.");
      return;
    }

    const history = convStore.getRecentMessages(convId, 30);
    const conv = convStore.get(convId);
    const systemPrompt = buildSystemPrompt({
      settingsStore,
      db,
      conversationId: convId,
      messageCount: history.length,
      conversationPrompt: conv?.system_prompt,
      channelHint: "Keep responses concise for chat. You are in a Slack conversation.",
    });

    let fullResponse = "";

    try {
      const stream = chatStream({
        provider: activeProvider.provider,
        model: activeProvider.model,
        apiKey: activeProvider.apiKey,
        baseUrl: activeProvider.baseUrl,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        systemPrompt,
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

        await say(fullResponse);
      }
    } catch (err) {
      console.error("[slack] chat error:", err.message);
      await say("Sorry, I encountered an error processing your message.").catch(() => {});
    }
  });

  // Listen for app mentions
  app.event("app_mention", async ({ event, say }) => {
    const text = event.text?.replace(/<@[^>]+>/g, "").trim();
    if (!text) return;

    const channelKey = `slack:${event.channel}`;
    let convId = settingsStore.get(`channel_conv.${channelKey}`);

    if (!convId || !convStore.get(convId)) {
      const conv = convStore.create({ title: `Slack #${event.channel}` });
      convId = conv.id;
      settingsStore.set(`channel_conv.${channelKey}`, convId);
    }

    convStore.addMessage(convId, { role: "user", content: text });

    const activeProvider = settingsStore.getActiveProvider();
    if (!activeProvider?.provider || !activeProvider?.apiKey) {
      await say("No AI provider configured.");
      return;
    }

    const history = convStore.getRecentMessages(convId, 30);
    const conv = convStore.get(convId);
    const systemPrompt = buildSystemPrompt({
      settingsStore,
      db,
      conversationId: convId,
      messageCount: history.length,
      conversationPrompt: conv?.system_prompt,
      channelHint: "Keep responses concise. You are responding to a mention in Slack.",
    });

    let fullResponse = "";

    try {
      const stream = chatStream({
        provider: activeProvider.provider,
        model: activeProvider.model,
        apiKey: activeProvider.apiKey,
        baseUrl: activeProvider.baseUrl,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        systemPrompt,
      });

      for await (const event of stream) {
        if (event.type === "text") fullResponse += event.content;
      }

      if (fullResponse) {
        convStore.addMessage(convId, {
          role: "assistant",
          content: fullResponse,
          provider: activeProvider.provider,
          model: activeProvider.model,
        });
        await say(fullResponse);
      }
    } catch (err) {
      console.error("[slack] mention error:", err.message);
      await say("Sorry, I encountered an error.").catch(() => {});
    }
  });

  await app.start();
  console.log("[slack] bot started (Socket Mode)");

  return {
    stop: async () => {
      await app.stop();
    },
  };
}
