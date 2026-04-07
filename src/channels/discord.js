import { Client, GatewayIntentBits, Events, ActivityType, ChannelType } from "discord.js";
import { chatStream } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand } from "../lib/commands.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { parseReactions } from "../lib/reaction-parser.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";
import { transcribeAudio } from "../voice/stt-handler.js";

/**
 * Creates and starts a Discord bot.
 *
 * @param {object} config - { token, enabled, allowedChannels?, allowDMs?, ackReaction?, streaming?, status?, activity?, activityType? }
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

  /**
   * Resolve channel key — supports threads.
   */
  function getChannelKey(message) {
    const channel = message.channel;
    // Thread channels get their own session
    if (channel.isThread?.()) {
      return `discord:${channel.parentId}:thread:${channel.id}`;
    }
    return `discord:${channel.id}`;
  }

  /**
   * Get a human-readable title for the channel.
   */
  function getChannelTitle(message) {
    const isDM = !message.guild;
    const channel = message.channel;
    if (isDM) return `DM with ${message.author.username}`;
    if (channel.isThread?.()) return `${channel.parent?.name || "channel"} > ${channel.name}`;
    return `#${channel.name || "channel"}`;
  }

  client.on(Events.MessageCreate, async (message) => {
    // Ignore bots and self
    if (message.author.bot) return;
    if (message.author.id === client.user?.id) return;

    // Check if this channel/DM is allowed
    const isDM = !message.guild;
    if (isDM && config.allowDMs === false) return;

    // For threads: always respond if parent channel is allowed
    const isThread = message.channel.isThread?.();
    const effectiveChannelId = isThread ? message.channel.parentId : message.channel.id;

    // Check allowlist (from config or settings DB)
    const dbAllowlist = settingsStore.get("allowlist.discord");
    const allowedIds = config.allowedChannels?.length > 0 ? config.allowedChannels : (dbAllowlist ? (typeof dbAllowlist === "string" ? JSON.parse(dbAllowlist) : dbAllowlist) : []);

    if (allowedIds.length > 0) {
      // Check if channel, user, or DM is allowed
      const allowed = allowedIds.includes(effectiveChannelId) || allowedIds.includes(message.author.id) || allowedIds.includes(message.channel.id);
      if (!allowed && !isDM) return;
      if (isDM && !allowedIds.includes(message.author.id)) return;
    } else {
      // No allowlist: require mention in guilds (default behavior)
      if (!isDM && !isThread) {
        if (!message.mentions.has(client.user)) return;
      }
    }

    // In threads: always respond (no mention needed)
    // In DMs: always respond

    let content = message.content
      .replace(new RegExp(`<@!?${client.user.id}>`), "")
      .trim();

    // Download attachments from Discord CDN (images, PDFs, voice)
    const mediaAttachments = [];
    let voiceTranscript = "";
    if (message.attachments?.size > 0) {
      for (const [, att] of message.attachments) {
        try {
          const res = await fetch(att.url);
          const buffer = Buffer.from(await res.arrayBuffer());
          if (att.contentType?.startsWith("image/")) {
            mediaAttachments.push({
              type: "image",
              source: { type: "base64", media_type: att.contentType, data: buffer.toString("base64") },
            });
          } else if (att.contentType === "application/pdf") {
            mediaAttachments.push({
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") },
            });
          } else if (att.contentType?.startsWith("audio/") || att.name?.endsWith(".ogg") || att.name?.endsWith(".webm")) {
            // Voice message — transcribe with whisper
            console.log(`[discord] voice attachment: ${att.name} (${att.contentType})`);
            message.channel.sendTyping().catch(() => {});
            const result = await transcribeAudio(buffer, "en", { settingsStore });
            if (result.transcript?.trim()) {
              voiceTranscript = result.transcript;
              console.log(`[discord] transcribed: "${voiceTranscript.slice(0, 80)}..."`);
            }
          }
        } catch (err) {
          console.error("[discord] Failed to process attachment:", err.message);
        }
      }
    }
    const imageAttachments = mediaAttachments; // Backward compat for enrichment below

    // Use voice transcript as content if no text was provided
    if (voiceTranscript && !content) {
      content = voiceTranscript;
    } else if (voiceTranscript) {
      content = `${content}\n\n[Voice message]: ${voiceTranscript}`;
    }

    // Need either text or images to proceed
    if (!content && imageAttachments.length === 0) return;

    const channelKey = getChannelKey(message);

    // Check for commands
    if (content.startsWith("/")) {
      const existingConvId = settingsStore.get(`channel_conv.${channelKey}`);
      const cmdResult = await processCommand(content, {
        settingsStore,
        convStore,
        conversationId: existingConvId,
      });

      if (cmdResult.handled) {
        const chunks = splitMessage(cmdResult.response, 2000);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
        return;
      }
    }

    // Get or create conversation keyed by Discord channel/thread
    let convId = settingsStore.get(`channel_conv.${channelKey}`);

    if (!convId || !convStore.get(convId)) {
      const conv = convStore.create({
        title: getChannelTitle(message),
      });
      convId = conv.id;
      settingsStore.set(`channel_conv.${channelKey}`, convId);
    }

    // Save user message (text only — no base64 in DB)
    const displayText = content || "Please analyze this image.";
    convStore.addMessage(convId, {
      role: "user",
      content: `[${message.author.username}]: ${displayText}${imageAttachments.length ? ` [+${imageAttachments.length} image(s)]` : ""}`,
    });

    // Get provider config
    const activeProvider = settingsStore.getActiveProvider();
    if (!activeProvider?.provider || !activeProvider?.ready) {
      await message.reply("No AI provider configured. Set one up in the Tarsee web panel.");
      return;
    }

    // Ack reaction — let user know we're processing
    const ackEmoji = config.ackReaction ?? "👀";
    if (ackEmoji) {
      message.react(ackEmoji).catch(() => {});
    }

    // Show typing indicator
    message.channel.sendTyping().catch(() => {});

    // Build full system prompt (identity + memory + skills)
    const history = convStore.getRecentMessages(convId, 30);
    const conv = convStore.get(convId);
    const systemPrompt = buildSystemPrompt({
      settingsStore,
      db,
      conversationId: convId,
      messageCount: history.length,
      conversationPrompt: conv?.system_prompt,
      channelHint: `Keep responses concise for chat. You are in a Discord conversation.
You can use these special markers in your response:
- [react: emoji] — adds a reaction to the user's message (e.g. [react: ✅] or [react: 👍])`,
    });

    let fullResponse = "";
    const streaming = config.streaming ?? "partial";

    try {
      const tools = getToolDefinitions();
      const toolCtx = { db, settingsStore, conversationId: convId };
      const MAX_TOOL_ROUNDS = 15;
      let workingMessages = history.map((m) => ({ role: m.role, content: m.content }));

      // Enrich last user message with image blocks if attachments present
      if (imageAttachments.length > 0 && workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") {
          const contentBlocks = [...imageAttachments];
          contentBlocks.push({ type: "text", text: typeof last.content === "string" ? last.content : displayText });
          last.content = contentBlocks;
        }
      }

      // Live streaming: edit a preview message as tokens arrive
      let previewMsg = null;
      let lastEditTime = 0;
      const EDIT_INTERVAL_MS = 1200;

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

            if (streaming === "partial" && fullResponse.length > 10) {
              const now = Date.now();
              if (now - lastEditTime > EDIT_INTERVAL_MS) {
                lastEditTime = now;
                const preview = fullResponse.slice(0, 1950) + (fullResponse.length > 1950 ? "..." : " ▎");
                try {
                  if (!previewMsg) {
                    previewMsg = await message.reply(preview);
                  } else {
                    await previewMsg.edit(preview);
                  }
                } catch {
                  // Editing can fail if message was deleted
                }
                message.channel.sendTyping().catch(() => {});
              }
            }
          } else if (event.type === "tool_use") {
            toolCalls.push({ id: event.id, name: event.name, input: event.input });
          } else if (event.type === "done") {
            stopReason = event.stopReason || "end_turn";
            break;
          }
        }

        if (toolCalls.length === 0 || stopReason !== "tool_use") break;

        // Build assistant content blocks
        const assistantContent = [];
        if (roundText) assistantContent.push({ type: "text", text: roundText });
        for (const tc of toolCalls) {
          assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        }
        workingMessages.push({ role: "assistant", content: assistantContent });

        // Execute tools
        const toolResults = [];
        for (const tc of toolCalls) {
          console.log(`[discord] tool: ${tc.name}`);
          const result = await executeTool(tc.name, tc.input, toolCtx);
          toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
        }
        workingMessages.push({ role: "user", content: toolResults });

        // Keep typing indicator alive during tool rounds
        message.channel.sendTyping().catch(() => {});
      }

      // Save and send final response
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

        // Remove ack reaction
        if (ackEmoji) {
          message.reactions.cache.get(ackEmoji)?.users.remove(client.user.id).catch(() => {});
        }

        // Apply agent reactions to the user's message
        for (const emoji of reactions) {
          message.react(emoji).catch(() => {});
        }

        // Discord has 2000 char limit — split if needed
        const chunks = splitMessage(cleanText, 2000);

        if (previewMsg && chunks.length === 1) {
          await previewMsg.edit(chunks[0]).catch(() => {});
        } else {
          if (previewMsg) {
            await previewMsg.delete().catch(() => {});
          }
          for (const chunk of chunks) {
            await retryOnRateLimit(() => message.reply(chunk));
          }
        }
      }
    } catch (err) {
      console.error("[discord] chat error:", err.message);
      if (ackEmoji) {
        message.reactions.cache.get(ackEmoji)?.users.remove(client.user.id).catch(() => {});
      }
      await message.reply("Sorry, I encountered an error processing your message.").catch(() => {});
    }
  });

  client.on(Events.ClientReady, () => {
    console.log(`[discord] logged in as ${client.user.tag}`);

    // Set bot presence/status
    const activityTypeMap = {
      playing: ActivityType.Playing,        // 0
      streaming: ActivityType.Streaming,    // 1
      listening: ActivityType.Listening,    // 2
      watching: ActivityType.Watching,      // 3
      competing: ActivityType.Competing,    // 5
    };

    const activityType = activityTypeMap[config.activityType || "listening"] ?? ActivityType.Listening;
    const activityName = config.activity || "your messages";
    const status = config.status || "online"; // online | idle | dnd | invisible

    client.user.setPresence({
      status,
      activities: [{
        name: activityName,
        type: activityType,
      }],
    });

    console.log(`[discord] presence: ${status}, ${config.activityType || "listening"} to "${activityName}"`);
  });

  client.on(Events.Error, (err) => {
    console.error("[discord] client error:", err.message);
  });

  await client.login(config.token);

  return {
    stop: async () => {
      await client.destroy();
    },
    /** Send a message to a Discord channel (outbound push). */
    sendMessage: async (channelId, text) => {
      const channel = await client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        const chunks = splitMessage(text, 2000);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      }
    },
  };
}

async function retryOnRateLimit(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn(); }
    catch (err) {
      if (err.status === 429 && i < maxRetries - 1) {
        const delay = err.retryAfter ? err.retryAfter * 1000 : (i + 1) * 2000;
        console.warn(`[discord] Rate limited, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else throw err;
    }
  }
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
