import pkg from "@slack/bolt";
const { App } = pkg;
import { chatStream } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand } from "../lib/commands.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { parseReactions } from "../lib/reaction-parser.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";

/**
 * Creates and starts a Slack bot.
 *
 * @param {object} config - { token (bot token), appToken (app-level token), enabled, ackReaction?, streaming? }
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{stop: Function}>}
 */
export async function createSlackBot(config, db) {
  const convStore = new ConversationStore(db);
  const settingsStore = new SettingsStore(db);

  const app = new App({
    token: config.token,
    appToken: config.appToken,
    socketMode: true,
  });

  const ackEmoji = config.ackReaction ?? "eyes";
  const streaming = config.streaming ?? "partial";

  /**
   * Shared handler for messages and mentions.
   */
  async function handleSlackMessage({ text, channel, user, ts, say, isThread, threadTs }) {
    if (!text?.trim()) return;

    const channelKey = `slack:${channel}`;

    // Check for commands
    if (text.startsWith("/")) {
      const existingConvId = settingsStore.get(`channel_conv.${channelKey}`);
      const cmdResult = await processCommand(text, {
        settingsStore,
        convStore,
        conversationId: existingConvId,
      });

      if (cmdResult.handled) {
        const chunks = splitMessage(cmdResult.response, 3000);
        for (const chunk of chunks) {
          await say({ text: chunk, ...(threadTs ? { thread_ts: threadTs } : {}) });
        }
        return;
      }
    }

    // Get or create conversation
    let convId = settingsStore.get(`channel_conv.${channelKey}`);

    if (!convId || !convStore.get(convId)) {
      const conv = convStore.create({ title: `Slack #${channel}` });
      convId = conv.id;
      settingsStore.set(`channel_conv.${channelKey}`, convId);
    }

    // Save user message
    convStore.addMessage(convId, { role: "user", content: text });

    // Get provider
    const activeProvider = settingsStore.getActiveProvider();
    if (!activeProvider?.provider || !activeProvider?.apiKey) {
      await say("No AI provider configured. Set one up in the OpusClaw web panel.");
      return;
    }

    // ACK reaction — let user know we're processing
    if (ackEmoji) {
      try {
        await app.client.reactions.add({
          token: config.token,
          channel,
          timestamp: ts,
          name: ackEmoji,
        });
      } catch {
        // Reaction may already exist or be invalid
      }
    }

    const history = convStore.getRecentMessages(convId, 30);
    const conv = convStore.get(convId);
    const systemPrompt = buildSystemPrompt({
      settingsStore,
      db,
      conversationId: convId,
      messageCount: history.length,
      conversationPrompt: conv?.system_prompt,
      channelHint: `Keep responses concise for chat. You are in a Slack conversation.
You can use [react: emoji_name] to add a reaction to the user's message (e.g. [react: thumbsup]).`,
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

      // Live streaming: post a message and edit it as tokens arrive
      let previewTs = null;
      let lastEditTime = 0;
      const EDIT_INTERVAL_MS = 1500;

      for await (const event of stream) {
        if (event.type === "text") {
          fullResponse += event.content;

          if (streaming === "partial" && fullResponse.length > 20) {
            const now = Date.now();
            if (now - lastEditTime > EDIT_INTERVAL_MS) {
              lastEditTime = now;
              const preview = fullResponse.slice(0, 3000) + (fullResponse.length > 3000 ? "..." : " ▎");
              try {
                if (!previewTs) {
                  const result = await app.client.chat.postMessage({
                    token: config.token,
                    channel,
                    text: preview,
                    ...(threadTs ? { thread_ts: threadTs } : {}),
                  });
                  previewTs = result.ts;
                } else {
                  await app.client.chat.update({
                    token: config.token,
                    channel,
                    ts: previewTs,
                    text: preview,
                  });
                }
              } catch {
                // Edit can fail
              }
            }
          }
        }
      }

      if (fullResponse) {
        // Extract memories before parsing reactions
        fullResponse = extractAndSaveMemories(fullResponse, db, convId);

        // Parse agent reactions
        const { cleanText, reactions } = parseReactions(fullResponse);

        convStore.addMessage(convId, {
          role: "assistant",
          content: cleanText,
          provider: activeProvider.provider,
          model: activeProvider.model,
        });

        // Apply agent reactions to the user's message
        for (const emoji of reactions) {
          app.client.reactions.add({
            token: config.token,
            channel,
            timestamp: ts,
            name: emoji.replace(/:/g, ""), // Strip colons if present
          }).catch(() => {});
        }

        // Remove ACK reaction
        if (ackEmoji) {
          app.client.reactions.remove({
            token: config.token,
            channel,
            timestamp: ts,
            name: ackEmoji,
          }).catch(() => {});
        }

        // Send final response
        const chunks = splitMessage(cleanText, 3000);

        if (previewTs && chunks.length === 1) {
          // Edit the preview to final content
          await app.client.chat.update({
            token: config.token,
            channel,
            ts: previewTs,
            text: chunks[0],
          }).catch(() => {});
        } else {
          // Delete preview and send fresh
          if (previewTs) {
            await app.client.chat.delete({
              token: config.token,
              channel,
              ts: previewTs,
            }).catch(() => {});
          }
          for (const chunk of chunks) {
            await say({ text: chunk, ...(threadTs ? { thread_ts: threadTs } : {}) });
          }
        }
      }
    } catch (err) {
      console.error("[slack] chat error:", err.message);
      // Remove ACK reaction on error
      if (ackEmoji) {
        app.client.reactions.remove({
          token: config.token,
          channel,
          timestamp: ts,
          name: ackEmoji,
        }).catch(() => {});
      }
      await say("Sorry, I encountered an error processing your message.").catch(() => {});
    }
  }

  // Listen for messages
  app.message(async ({ message, say }) => {
    if (message.subtype || message.bot_id) return;
    await handleSlackMessage({
      text: message.text?.trim(),
      channel: message.channel,
      user: message.user,
      ts: message.ts,
      say,
      isThread: !!message.thread_ts,
      threadTs: message.thread_ts,
    });
  });

  // Listen for app mentions
  app.event("app_mention", async ({ event, say }) => {
    const text = event.text?.replace(/<@[^>]+>/g, "").trim();
    await handleSlackMessage({
      text,
      channel: event.channel,
      user: event.user,
      ts: event.ts,
      say,
      isThread: !!event.thread_ts,
      threadTs: event.thread_ts,
    });
  });

  await app.start();
  console.log("[slack] bot started (Socket Mode)");

  return {
    stop: async () => {
      await app.stop();
    },
  };
}

function splitMessage(text, maxLen) {
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
    if (splitIdx < maxLen * 0.5) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}
