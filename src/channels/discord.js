import fs from "node:fs";
import path from "node:path";
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
import config from "../config/env.js";

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
    const isThread = message.channel.isThread?.();
    const effectiveChannelId = isThread ? message.channel.parentId : message.channel.id;

    // DMs: always respond (this is YOUR personal agent)
    // No allowlist check for DMs — if someone can DM the bot, they can talk to it
    if (isDM) {
      // Proceed to message handling
    } else {
      // Guild messages: check allowlist + require @mention
      const dbAllowlist = settingsStore.get("allowlist.discord");
      const allowedIds = config.allowedChannels?.length > 0 ? config.allowedChannels : (dbAllowlist ? (typeof dbAllowlist === "string" ? JSON.parse(dbAllowlist) : dbAllowlist) : []);

      if (allowedIds.length > 0) {
        const allowed = allowedIds.includes(effectiveChannelId) || allowedIds.includes(message.author.id) || allowedIds.includes(message.channel.id);
        if (!allowed) return;
      }

      // Always require @mention in servers (threads exempt)
      if (!isThread && !message.mentions.has(client.user)) return;
    }

    let content = message.content
      .replace(new RegExp(`<@!?${client.user.id}>`), "")
      .trim();

    // Include replied-to message as context
    if (message.reference?.messageId) {
      try {
        const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
        if (repliedMsg?.content) {
          const repliedFrom = repliedMsg.author?.displayName || repliedMsg.author?.username || "someone";
          content = `[Replying to ${repliedFrom}: "${repliedMsg.content}"]\n\n${content}`;
        }
      } catch { /* referenced message deleted or inaccessible */ }
    }

    // Download attachments from Discord CDN.
    //   Images → base64 image content block (multimodal)
    //   PDFs   → base64 document content block AND saved to workspace so Claude's
    //            Read tool can also reach them
    //   Audio  → transcribed via whisper
    //   Anything else (txt/json/csv/docx/...) → saved to workspace and surfaced
    //            to Claude via a text block pointing at the path. Matches the
    //            web composer's handling so Claude can Bash/Read the file.
    const mediaAttachments = [];    // multimodal content blocks for model
    const savedFileNotes = [];      // text notes describing files on disk
    let voiceTranscript = "";
    const uploadsDir = path.join(config.WORKSPACE_DIR, "uploads");
    if (message.attachments?.size > 0) {
      try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch {}
    }
    const saveToDisk = (buffer, att) => {
      const safeName = (att.name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(uploadsDir, `discord-${Date.now()}-${safeName}`);
      try {
        fs.writeFileSync(filePath, buffer);
        return filePath;
      } catch (err) {
        console.error("[discord] saveToDisk failed:", err.message);
        return null;
      }
    };

    if (message.attachments?.size > 0) {
      for (const [, att] of message.attachments) {
        try {
          const res = await fetch(att.url);
          const buffer = Buffer.from(await res.arrayBuffer());
          const ct = att.contentType || "";

          if (ct.startsWith("image/")) {
            mediaAttachments.push({
              type: "image",
              source: { type: "base64", media_type: ct, data: buffer.toString("base64") },
            });
          } else if (ct === "application/pdf" || att.name?.toLowerCase().endsWith(".pdf")) {
            // PDF: multimodal document block + also save to disk so Claude can
            // Read it with tools if needed.
            mediaAttachments.push({
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") },
            });
            const savedPath = saveToDisk(buffer, att);
            if (savedPath) {
              savedFileNotes.push(`[PDF attached: ${att.name} → ${savedPath}] — multimodal PDF block provided above; you can also Read this file directly at the path.`);
            }
          } else if (ct.startsWith("audio/") || att.name?.endsWith(".ogg") || att.name?.endsWith(".webm")) {
            // Voice message — transcribe with whisper
            console.log(`[discord] voice attachment: ${att.name} (${ct})`);
            message.channel.sendTyping().catch(() => {});
            const result = await transcribeAudio(buffer, "en", { settingsStore });
            if (result.transcript?.trim()) {
              voiceTranscript = result.transcript;
              console.log(`[discord] transcribed: "${voiceTranscript.slice(0, 80)}..."`);
            }
          } else {
            // Generic file (txt, json, csv, docx, zip, etc.) — save to disk
            // and surface the path to Claude so it can Read the file.
            const savedPath = saveToDisk(buffer, att);
            if (savedPath) {
              const sizeKb = Math.round(buffer.length / 1024);
              savedFileNotes.push(`[Attached file saved: ${att.name} (${ct || "unknown"}, ${sizeKb}KB) → ${savedPath}]\nYou can read this file with the Read tool at: ${savedPath}`);
            }
          }
        } catch (err) {
          console.error("[discord] Failed to process attachment:", err.message, att?.name);
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

    // Fold saved-file notes into the text content so Claude sees where the
    // files are on disk even if it's text-only (no multimodal block).
    if (savedFileNotes.length > 0) {
      const notes = savedFileNotes.join("\n");
      content = content ? `${content}\n\n${notes}` : notes;
    }

    // Need either text or any attachment (multimodal or saved-to-disk) to proceed.
    // Previously returned when there were no images; that swallowed messages
    // whose only payload was a .txt / .json / other generic file.
    if (!content && imageAttachments.length === 0 && savedFileNotes.length === 0) return;

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

    // Save user message (text only — no base64 in DB).
    // Display text already includes saved-file notes folded in above, so
    // viewing this convo in the web UI shows the file paths the AI saw.
    const displayText = content || (imageAttachments.length ? "Please analyze this image." : "(attachment)");
    const mediaCount = imageAttachments.length;
    const fileCount = savedFileNotes.length;
    const mediaSuffix = [
      mediaCount ? `[+${mediaCount} media]` : null,
      fileCount ? `[+${fileCount} file${fileCount > 1 ? "s" : ""}]` : null,
    ].filter(Boolean).join(" ");
    convStore.addMessage(convId, {
      role: "user",
      content: `[${message.author.username}]: ${displayText}${mediaSuffix ? ` ${mediaSuffix}` : ""}`,
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

    // Send initial "Thinking..." message that we'll edit in-place
    let statusMsg = null;
    try {
      statusMsg = await message.reply("💭 Thinking...");
    } catch {
      statusMsg = await message.channel.send("💭 Thinking...");
    }

    // Helper: edit the status message (debounced to avoid rate limits)
    let lastEdit = 0;
    const editStatus = async (text) => {
      const now = Date.now();
      if (now - lastEdit < 2000) return; // Min 2s between edits
      lastEdit = now;
      try { await statusMsg.edit(text); } catch { /* rate limited or deleted */ }
    };

    // Build full system prompt (identity + memory + skills)
    const history = convStore.getRecentMessages(convId, 15);
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

    try {
      const tools = getToolDefinitions();
      const toolCtx = { db, settingsStore, conversationId: convId };
      const MAX_TOOL_ROUNDS = 15;
      let workingMessages = history.map((m) => ({ role: m.role, content: m.content }));
      const toolLog = []; // Track tool names for status display

      // Enrich last user message with image blocks if attachments present
      if (imageAttachments.length > 0 && workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") {
          const contentBlocks = [...imageAttachments];
          contentBlocks.push({ type: "text", text: typeof last.content === "string" ? last.content : displayText });
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
            // Serialize into fullResponse so the web UI can re-render the tool call
            // when this conversation is viewed later. Neutralize any literal
            // closing tags inside the payload so the strip regex below can't
            // terminate early on content that happens to contain them.
            const callJson = JSON.stringify({ name: event.name, arguments: event.input })
              .replace(/<\/(tool_call|tool_response)>/gi, "<_/$1>");
            fullResponse += `\n<tool_call>${callJson}</tool_call>\n`;
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

        // Execute tools and update status message
        const toolResults = [];
        for (const tc of toolCalls) {
          const shortName = tc.name.replace("mcp__tarsee__tarsee_", "").replace("mcp__tarsee__", "");
          toolLog.push(shortName);
          const statusLines = toolLog.map((t, i) => i === toolLog.length - 1 ? `⚙️ Running **${t}**...` : `✅ ${t}`);
          await editStatus(statusLines.join("\n"));

          console.log(`[discord] tool: ${tc.name}`);
          const result = await executeTool(tc.name, tc.input, toolCtx);
          toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
          const resultText = (typeof result === "string" ? result : JSON.stringify(result))
            .replace(/<\/(tool_call|tool_response)>/gi, "<_/$1>");
          fullResponse += `\n<tool_response>${resultText}</tool_response>\n`;
        }
        workingMessages.push({ role: "user", content: toolResults });

        // Mark last tool as done
        const doneLines = toolLog.map(t => `✅ ${t}`);
        await editStatus(doneLines.join("\n") + "\n💭 Thinking...");
      }

      // Final response — edit the status message with clean text
      if (fullResponse) {
        fullResponse = extractAndSaveMemories(fullResponse, db, convId);
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

        // Apply agent reactions
        for (const emoji of reactions) {
          message.react(emoji).catch(() => {});
        }

        // Strip tool_call/tool_response XML — those are only for web-UI replay,
        // Discord users see the prose only.
        const displayText = cleanText
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
          .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        // Delete the status bubble and send the final answer as a fresh reply
        // so Discord fires notifications / unread markers properly (edits don't).
        try { await statusMsg.delete(); } catch {}
        const chunks = splitMessage(displayText, 2000);
        for (let i = 0; i < chunks.length; i++) {
          await retryOnRateLimit(() => message.reply(chunks[i]));
        }
      } else {
        try { await statusMsg.delete(); } catch {}
      }
    } catch (err) {
      console.error("[discord] chat error:", err.message);
      if (ackEmoji) {
        message.reactions.cache.get(ackEmoji)?.users.remove(client.user.id).catch(() => {});
      }
      try { await statusMsg.edit("Sorry, I encountered an error processing your message."); } catch {}
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
