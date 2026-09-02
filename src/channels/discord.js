import fs from "node:fs";
import path from "node:path";
import { Client, GatewayIntentBits, Events, ActivityType, ChannelType } from "discord.js";
import { chatStream } from "../ai/router.js";
import { withConversationTurn } from "../lib/conversation-lock.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand, extractPlaybookPrompt } from "../lib/commands.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { parseReactions } from "../lib/reaction-parser.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";
import { toolStatusLabel, toolDoneLabel } from "../lib/tool-status.js";
import { transcribeAudio } from "../voice/stt-handler.js";
import envConfig from "../config/env.js";

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
    // The whole body runs inside try/catch. Everything from the allowlist
    // parse down to the first `message.reply` used to sit OUTSIDE any handler,
    // and this is an async listener: a rejected promise there is an unhandled
    // rejection, which on Node 22 terminates the process. Ordinary Discord
    // conditions reach it — replying in a channel where the bot lacks Send
    // Messages, or to a message the author deleted (DiscordAPIError 10008) —
    // so one bad reply took down Telegram, WhatsApp, email, the web UI and any
    // in-flight turn with it.
    try {
    // Ignore bots and self
    if (message.author.bot) return;
    if (message.author.id === client.user?.id) return;

    // Check if this channel/DM is allowed
    const isDM = !message.guild;
    const isThread = message.channel.isThread?.();
    const effectiveChannelId = isThread ? message.channel.parentId : message.channel.id;

    // Resolve the allowlist once — DMs need it too.
    const dbAllowlist = settingsStore.get("allowlist.discord");
    const allowedIds = config.allowedChannels?.length > 0
      ? config.allowedChannels
      : (dbAllowlist ? (typeof dbAllowlist === "string" ? JSON.parse(dbAllowlist) : dbAllowlist) : []);

    if (isDM) {
      // DMs are NOT automatically trusted. A bot must share a guild for anyone
      // to DM it, so "can DM the bot" is not proof of being the operator — it
      // means any member of any server the bot sits in could open a DM and get
      // a Bash-capable agent running on the operator's volume and Claude
      // subscription. Require the author to be allowlisted. An empty allowlist
      // still means "no restriction configured", matching guild behaviour, but
      // that is now a deliberate, documented choice rather than a DM-only hole.
      if (allowedIds.length > 0 && !allowedIds.includes(message.author.id)) {
        console.warn(`[discord] ignoring DM from non-allowlisted user ${message.author.id}`);
        return;
      }
    } else {
      // Guild messages: check allowlist first (always), then mention gate (toggleable)
      if (allowedIds.length > 0) {
        const allowed = allowedIds.includes(effectiveChannelId) || allowedIds.includes(message.author.id) || allowedIds.includes(message.channel.id);
        if (!allowed) return;
      }

      // Mention gate. discord.mention_mode controls whether the bot ignores
      // non-mention messages in guild channels:
      //   "required" (default) — must @mention the bot
      //   "off"                — respond to any allowed message (lazy mode)
      // Threads remain exempt regardless — preserves prior thread carve-out.
      const mentionMode = settingsStore.get("discord.mention_mode") === "off" ? "off" : "required";
      if (mentionMode === "required" && !isThread && !message.mentions.has(client.user)) return;
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
    const uploadsDir = path.join(envConfig.WORKSPACE_DIR, "uploads");
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

    // Check for commands. __PLAYBOOK__ responses should be routed to the
    // AI as a prompt, not echoed back as a chat message.
    let aiPromptOverride = null;
    if (content.startsWith("/")) {
      const existingConvId = settingsStore.get(`channel_conv.${channelKey}`);
      const cmdResult = await processCommand(content, {
        settingsStore,
        convStore,
        conversationId: existingConvId,
        platform: "discord",
        db, // was missing — /clear silently no-op'd
      });

      if (cmdResult.handled) {
        const playbook = extractPlaybookPrompt(cmdResult);
        if (playbook) {
          aiPromptOverride = playbook;
        } else {
          const chunks = splitMessage(cmdResult.response, 2000);
          for (const chunk of chunks) {
            await message.reply(chunk);
          }
          return;
        }
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

    // No "💭 Thinking..." placeholder — we surface progress via the native
    // typing indicator only, and the final reply is the only message that
    // shows up in the channel.
    const typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8000);
    message.channel.sendTyping().catch(() => {});

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

    // Idle watchdog — abort if SDK goes 3 min without emitting anything.
    const controller = new AbortController();
    let lastEventAt = Date.now();
    let idleAborted = false;
    // Idle abort: how long a turn may go with NO stream event before we give up.
    // Was a hard 3 minutes, which killed legitimate long research/tool turns.
    // Now configurable, but deliberately FINITE — the Mac build sets this to
    // ~2e9 (23 days), which is only safe there because its PTY pool has a
    // heartbeat + dead-socket detector. This build has neither, so an infinite
    // value would wedge a turn forever with no console to kill it from.
    const IDLE_ABORT_MS = Number(process.env.TARSEE_CHANNEL_IDLE_ABORT_MS) || 20 * 60_000;
    const idleTimer = setInterval(() => {
      if (Date.now() - lastEventAt > IDLE_ABORT_MS) {
        idleAborted = true;
        try { controller.abort(); } catch {}
        clearInterval(idleTimer);
      }
    }, 15_000);

    // Streaming-segment state — same shape as Telegram's. Each text block
    // between tool boundaries becomes its own Discord message that
    // edit-streams as tokens arrive. Tool calls produce ephemeral status
    // messages ("⚙️ Running command…" → "✓ Command done") so Discord
    // users see realtime feedback like the CLI's narration trail.
    let segmentMsg = null;        // discord.js Message object
    let segmentText = "";
    let lastSegmentEditAt = 0;
    const SEGMENT_EDIT_DEBOUNCE_MS = 1100; // Discord channel cap is 5 req / 5s
    const toolMsgById = new Map(); // tool_use_id → discord.js Message
    const sentSegments = [];

    const renderSegmentDisplay = (raw) => {
      const { cleanText } = parseReactions(raw);
      return cleanText
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
        .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    };

    const flushSegmentEdit = async (final = false) => {
      if (!segmentMsg || !segmentText) return;
      const now = Date.now();
      if (!final && now - lastSegmentEditAt < SEGMENT_EDIT_DEBOUNCE_MS) return;
      lastSegmentEditAt = now;
      const text = renderSegmentDisplay(segmentText.slice(0, 2000));
      if (!text) return;
      try {
        await retryOnRateLimit(() => segmentMsg.edit(text));
      } catch { /* best-effort */ }
    };

    const closeSegment = async () => {
      if (!segmentMsg) { segmentText = ""; return; }
      await flushSegmentEdit(true);
      // If segment overflowed Discord's 2000-char cap, send remainder as
      // new replies so the user sees the full thing.
      if (segmentText.length > 2000) {
        for (let i = 2000; i < segmentText.length; i += 2000) {
          const chunkText = renderSegmentDisplay(segmentText.slice(i, i + 2000));
          if (!chunkText) continue;
          for (const piece of splitMessage(chunkText, 2000)) {
            await retryOnRateLimit(() => message.reply(piece));
          }
        }
      }
      sentSegments.push(segmentText);
      segmentMsg = null;
      segmentText = "";
    };

    const postToolStatus = async (event) => {
      try {
        const label = toolStatusLabel(event.name, event.input);
        const msg = await retryOnRateLimit(() => message.reply(`-# ⚙️ *${label}*`));
        if (msg) toolMsgById.set(event.id, msg);
      } catch { /* best-effort */ }
    };
    const markToolDone = async (id, name, input, result) => {
      const msg = toolMsgById.get(id);
      if (!msg) return;
      const resultStr = typeof result === "string" ? result : JSON.stringify(result || "");
      const isErr = /error|forbidden|not found|enotfound|command not found/i.test(resultStr);
      const label = toolDoneLabel(name, input || {}, isErr);
      const text = isErr ? `-# ❌ *${label}*` : `-# ✓ *${label}*`;
      try { await retryOnRateLimit(() => msg.edit(text)); } catch { /* best-effort */ }
      toolMsgById.delete(id);
    };

    // One turn at a time per conversation. Without this, two messages in the
    // same chat started two turns that both resumed the SAME Claude session
    // id, appending to one transcript from two processes. Replies interleaved
    // and the session could be left corrupt enough to break every later turn.
    await withConversationTurn(convId, async () => {
    try {
      const tools = getToolDefinitions();
      const toolCtx = { db, settingsStore, conversationId: convId };
      const MAX_TOOL_ROUNDS = 15;
      let workingMessages = history.map((m) => ({ role: m.role, content: m.content }));

      // Slash-command playbooks: swap the AI-visible last user turn for
      // the playbook body while the stored message stays as "/checkpoint".
      if (aiPromptOverride && workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") last.content = aiPromptOverride;
      }

      // Enrich last user message with image blocks if attachments present
      if (imageAttachments.length > 0 && workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") {
          const contentBlocks = [...imageAttachments];
          contentBlocks.push({ type: "text", text: typeof last.content === "string" ? last.content : displayText });
          last.content = contentBlocks;
        }
      }

      // One-shot retry budget for recoverable session-corruption errors
      // (Anthropic API rejecting diagnostics.previous_message_id from a
      // stale resumed session). Mirror the same pattern as the Telegram
      // handler so both channels self-heal on a corrupt session.
      let sessionRetried = false;
      let surfacedError = null;
      // Token usage for this turn — drives Settings -> Token Health.
      // Channels previously recorded NO token data at all, so every
      // channel conversation showed up as an estimate instead of real numbers.
      let tokenUsage = {};

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
          // Resolve per-session thinking effort so /think works here too
          // (web chat calls the provider directly; channels go via the router).
          effort: settingsStore.get(`session.${convId}.effort`) || undefined,
          signal: controller.signal,
        });

        for await (const event of stream) {
          lastEventAt = Date.now();
          if (event.type === "text") {
            roundText += event.content;
            fullResponse += event.content;
            // Stream this delta into the current segment message — create
            // the placeholder on first text of each segment.
            if (!segmentMsg) {
              try {
                segmentMsg = await retryOnRateLimit(() => message.reply("…"));
              } catch { /* fall through to batched send at the end */ }
            }
            segmentText += event.content;
            await flushSegmentEdit(false);
          } else if (event.type === "tool_use") {
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
              console.warn(`[discord] session corrupt, clearing and retrying: ${String(event.message || "").slice(0, 200)}`);
              if (segmentMsg) {
                try { await segmentMsg.delete(); } catch {}
                segmentMsg = null;
                segmentText = "";
              }
            } else {
              surfacedError = event.message;
            }
          } else if (event.type === "usage") {
            tokenUsage = { ...tokenUsage, ...event.usage };
          } else if (event.type === "done") {
            stopReason = event.stopReason || "end_turn";
            break;
          }
        }

        if (recoverRound) { round--; continue; }
        if (surfacedError) break;
        if (toolCalls.length === 0 || stopReason !== "tool_use") break;

        // Build assistant content blocks
        const assistantContent = [];
        if (roundText) assistantContent.push({ type: "text", text: roundText });
        for (const tc of toolCalls) {
          assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        }
        workingMessages.push({ role: "assistant", content: assistantContent });

        // Execute tools and update each status message as results land.
        const toolResults = [];
        for (const tc of toolCalls) {
          console.log(`[discord] tool: ${tc.name}`);
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
        const { cleanText, reactions } = parseReactions(fullResponse);

        convStore.addMessage(convId, {
          role: "assistant",
          content: cleanText,
          provider: activeProvider.provider,
          model: activeProvider.model,
          // True prompt size = input + cache_read + cache_creation. Using
          // input_tokens alone undercounts context fill whenever caching
          // kicks in (which is almost always on a long session).
          tokensIn: (tokenUsage.input_tokens || 0)
            + (tokenUsage.cache_read_input_tokens || 0)
            + (tokenUsage.cache_creation_input_tokens || 0) || null,
          tokensOut: tokenUsage.output_tokens ?? null,
        });

        // Remove ack reaction
        if (ackEmoji) {
          message.reactions.cache.get(ackEmoji)?.users.remove(client.user.id).catch(() => {});
        }

        // Apply agent reactions
        for (const emoji of reactions) {
          message.react(emoji).catch(() => {});
        }

        // Close the final narration segment — its content has been
        // edit-streaming during the loop. If nothing user-facing came
        // out (model only emitted tool calls), surface a soft note.
        await closeSegment();
        if (sentSegments.length === 0) {
          await message.reply("⚠️ Done — no message body.").catch(() => {});
        }
      } else if (surfacedError) {
        const isSessionErr = /previous_message_id|session/i.test(String(surfacedError));
        const userMsg = isSessionErr
          ? "⚠️ Session reset due to a transient API hiccup. Just send your message again — your history is preserved."
          : `⚠️ Upstream error: ${String(surfacedError).slice(0, 200)}\n\nTry again — if it keeps happening, /clear and try fresh.`;
        await message.reply(userMsg).catch(() => {});
      } else if (idleAborted) {
        await message.reply("⚠️ Claude Code stopped responding (3 min idle). Try again — maybe with a smaller ask.").catch(() => {});
      } else {
        await message.reply("⚠️ No response generated. Try rephrasing?").catch(() => {});
      }
    } catch (err) {
      console.error("[discord] chat error:", err.message);
      if (ackEmoji) {
        message.reactions.cache.get(ackEmoji)?.users.remove(client.user.id).catch(() => {});
      }
      const reason = idleAborted
        ? "⚠️ Claude Code stopped responding (3 min idle). Try again — maybe with a smaller ask."
        : `⚠️ Error: ${err.message || "something went wrong"}. Try again.`;
      await message.reply(reason).catch(() => {});
    } finally {
      clearInterval(typingInterval);
      clearInterval(idleTimer);
    }
    }, {
      onQueued: () => {
        message.reply("⏳ Still working on your last message — yours is next.").catch(() => {});
      },
    });
    } catch (err) {
      console.error("[discord] message handler error:", err);
      // Best-effort: tell the user something broke rather than going silent.
      message.reply("⚠️ Something went wrong handling that message.").catch(() => {});
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
