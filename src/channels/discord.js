import fs from "node:fs";
import path from "node:path";
import { Client, GatewayIntentBits, Events, ActivityType, ChannelType, OAuth2Scopes, PermissionFlagsBits } from "discord.js";
import { chatStream } from "../ai/router.js";
import { withConversationTurn } from "../lib/conversation-lock.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand, extractPlaybookPrompt } from "../lib/commands.js";
import { buildSystemPromptParts, sendFileHint } from "../lib/build-system-prompt.js";
import { parseReactions } from "../lib/reaction-parser.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { toolStatusLabel, toolDoneLabel } from "../lib/tool-status.js";
import { transcribeAudio } from "../voice/stt-handler.js";
import { formatForDiscord, splitMessageFenceSafe } from "../lib/discord-format.js";
import envConfig from "../config/env.js";
import { discordAdmin } from "../lib/discord-admin.js";
import { refused } from "../lib/channel-errors.js";
import { turnErrorNote, idleNote, errorStillToSay, sttProblem } from "./turn-notes.js";

/**
 * Creates and starts a Discord bot.
 *
 * @param {object} config - { token, enabled, allowedChannels?, allowDMs?, ackReaction?, streaming?, status?, activity?, activityType? }
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts] - Client: the discord.js client class (tests pass a stand-in that never reaches Discord);
 *   chatStream: the model stream (ai/router.js chatStream when left out).
 * @returns {Promise<{stop: Function}>}
 */
export async function createDiscordBot(config, db, { Client: DiscordClient = Client, chatStream: streamChat = chatStream } = {}) {
  const convStore = new ConversationStore(db);
  const settingsStore = new SettingsStore(db);

  const client = new DiscordClient({
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
    let voiceProblem = null;        // why a voice message wasn't transcribed, said back to the person
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
            // Voice message — transcribed on this server (voice/stt-handler.js)
            console.log(`[discord] voice attachment: ${att.name} (${ct})`);
            message.channel.sendTyping().catch(() => {});
            try {
              const result = await transcribeAudio(buffer, "en", { settingsStore });
              if (result.transcript?.trim()) {
                voiceTranscript = result.transcript;
                console.log(`[discord] transcribed: "${voiceTranscript.slice(0, 80)}..."`);
              }
            } catch (err) {
              console.error(`[discord] voice transcription failed: ${err.message}`);
              // Transcription that can't run says what to set up (Settings > Voice); anything else, a short note.
              voiceProblem = sttProblem(err) || "Couldn't transcribe the voice message. Try again, or type it.";
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

    // A voice message that couldn't be heard: say why first. Words or files sent with it are still answered below.
    if (voiceProblem) await message.reply(voiceProblem).catch(() => {});

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
          const chunks = splitMessage(formatForDiscord(cmdResult.response), 2000);
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
    const savedUser = convStore.addMessage(convId, {
      role: "user",
      content: `[${message.author.username}]: ${displayText}${mediaSuffix ? ` ${mediaSuffix}` : ""}`,
    });

    // Which AI answers is the turn layer's to decide (ai/turn.js: this chat's own pick, else the default), and so is
    // saying what to set up when that AI isn't ready: its answer is the reply.

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
    const systemParts = buildSystemPromptParts({
      settingsStore,
      db,
      conversationId: convId,
      messageCount: history.length,
      conversationPrompt: conv?.system_prompt,
      channelHint: `Keep responses concise for chat. You are in a Discord conversation.
You can use these special markers in your response:
- [react: emoji] — adds a reaction to the user's message (e.g. [react: ✅] or [react: 👍])
${sendFileHint("discord")}`,
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

    const renderSegmentDisplay = displayForDiscord;

    // The segment as Discord shows it, in fence-safe pieces of up to 2000 characters. Drawn whole, then split: a table
    // drawn as a grid or as lines can come out longer than the text it came from, and cutting the raw text at 2000
    // first lost whatever the drawing pushed past the first piece (and cut tables in half).
    const segmentPieces = () => splitMessage(renderSegmentDisplay(segmentText), 2000).filter(Boolean);

    const flushSegmentEdit = async (final = false) => {
      if (!segmentMsg || !segmentText) return;
      const now = Date.now();
      if (!final && now - lastSegmentEditAt < SEGMENT_EDIT_DEBOUNCE_MS) return;
      lastSegmentEditAt = now;
      const text = segmentPieces()[0];   // the message edited in place: the first piece
      if (!text) return;
      try {
        await retryOnRateLimit(() => segmentMsg.edit(text));
      } catch { /* best-effort */ }
    };

    const closeSegment = async () => {
      if (!segmentMsg) { segmentText = ""; return; }
      await flushSegmentEdit(true);
      // The rest of the segment past the first piece, as new replies, so the whole of it reaches the channel.
      for (const piece of segmentPieces().slice(1)) {
        await retryOnRateLimit(() => message.reply(piece));
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
    // The AI this turn runs on, from the turn layer's route event (the backup model's, if it answered instead).
    let routed = null;
    try {
      // messageId: the message this turn answers (its pictures are kept on it, not on whatever came in later)
      const toolCtx = { db, settingsStore, conversationId: convId, messageId: savedUser?.id || null };
      const workingMessages = history.map((m) => ({ role: m.role, content: m.content }));

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

      let surfacedError = null;
      // Token usage for this turn — drives Settings -> Token Health.
      // Channels previously recorded NO token data at all, so every
      // channel conversation showed up as an estimate instead of real numbers.
      let tokenUsage = {};
      const toolsSeen = new Map(); // tool id → { name, input }, for its "done" label

      // One call per message. The engine runs its own tools and ends the turn itself, and the turn layer
      // (ai/turn.js) retries, once and fresh, a session the engine couldn't resume. The channel never calls the AI
      // again on its own: it shows what the turn says.
      const stream = streamChat({
        liveSource: "discord",
        messages: workingMessages,
        systemParts,
        toolCtx,
        sessionId: convStore.getSessionHandle(convId),
        onSessionId: (handle) => convStore.setSessionHandle(convId, handle),
        signal: controller.signal,
      });

      for await (const event of stream) {
        lastEventAt = Date.now();
        if (event.type === "route") {
          routed = event;
        } else if (event.type === "text") {
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
          toolsSeen.set(event.id, { name: event.name, input: event.input });
          const callJson = JSON.stringify({ name: event.name, arguments: event.input })
            .replace(/<\/(tool_call|tool_response)>/gi, "<_/$1>");
          fullResponse += `\n<tool_call>${callJson}</tool_call>\n`;
          await postToolStatus(event);
        } else if (event.type === "tool_result") {
          // The engine runs the tool and reports its result here: the status line turns ✓ or ❌.
          const tc = toolsSeen.get(event.id);
          await markToolDone(event.id, tc?.name || "tool", tc?.input || {}, event.ok === false ? "error" : "");
        } else if (event.type === "error") {
          surfacedError = event.message || "something went wrong";
        } else if (event.type === "usage") {
          tokenUsage = { ...tokenUsage, ...event.usage };
        } else if (event.type === "done") {
          break;
        }
      }

      if (fullResponse) {
        fullResponse = extractAndSaveMemories(fullResponse, db, convId);
        const { cleanText, reactions } = parseReactions(fullResponse);

        convStore.addMessage(convId, {
          role: "assistant",
          content: cleanText,
          provider: routed?.provider || null,
          model: routed?.model || null,
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
      }
      // An error the turn reported (already in plain words: what went wrong, what to do), after whatever it said
      // before it: a spending limit or the turn ceiling can stop a reply halfway. Not again when the reply is the
      // error itself (the turn layer's "set this up first" answers).
      if (surfacedError && errorStillToSay(fullResponse, surfacedError)) {
        await message.reply(turnErrorNote(routed, surfacedError)).catch(() => {});
      } else if (!fullResponse && idleAborted) {
        await message.reply(idleNote(routed, IDLE_ABORT_MS)).catch(() => {});
      } else if (!fullResponse && !surfacedError) {
        await message.reply("⚠️ No response generated. Try rephrasing?").catch(() => {});
      }
    } catch (err) {
      console.error("[discord] chat error:", err.message);
      if (ackEmoji) {
        message.reactions.cache.get(ackEmoji)?.users.remove(client.user.id).catch(() => {});
      }
      const reason = idleAborted
        ? idleNote(routed, IDLE_ABORT_MS)
        : `⚠️ Error: ${err.message || "something went wrong"}. Try again.`;
      await message.reply(reason).catch(() => {});
    } finally {
      clearInterval(typingInterval);
      clearInterval(idleTimer);
    }
    }, {
      // Waiting behind the reply in progress: a "Queued" line on the dashboard too.
      live: { source: "discord", prompt: displayText },
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

  try {
    await client.login(config.token);
  } catch (err) {
    const why = discordLoginError(err);
    if (why) throw refused(why);
    throw err;
  }

  // Read when asked: login can return a moment before discord.js has handled READY, which sets the user and app.
  let inviteUrl = null;
  return {
    stop: async () => {
      await client.destroy();
    },
    /** Who it logged in as, for Settings → Channels: the bot's tag (its username), or null until Discord has said. */
    get identity() {
      return client.user ? client.user.tag || client.user.username : null;
    },
    /** The link that adds this bot to a server (Settings → Channels), or null until Discord has said who it is. */
    get inviteUrl() {
      inviteUrl ??= discordInviteUrl(client);
      return inviteUrl;
    },
    /** Send a message to a Discord channel (outbound push). */
    sendMessage: async (channelId, text) => {
      const channel = await client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        // Outbound tool sends (tarsee_send_message) get the same tables and quotes as streamed replies.
        const chunks = splitMessage(formatForDiscord(text), 2000);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      }
    },
    /**
     * tarsee_discord_admin (lib/discord-admin.js): list, make and edit channels, and make webhooks (the URL goes to the
     * vault), done by this logged-in client so the agent never handles the bot token. No deletes.
     */
    admin: (args) => discordAdmin(args, { client }),
    /** Send a file as a real Discord attachment (the send_file tool). Bots upload up to 25 MB on a server without boosts. */
    sendFile: async (channelId, filePath, caption) => {
      if (!fs.existsSync(filePath)) throw new Error(`sendFile: file not found at ${filePath}`);
      const sizeMb = fs.statSync(filePath).size / 1024 / 1024;
      if (sizeMb > 25) throw new Error(`sendFile: file is ${sizeMb.toFixed(1)} MB, over Discord's 25 MB upload cap`);
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) throw new Error(`sendFile: channel ${channelId} is not a text channel`);
      await channel.send({
        content: caption ? splitMessage(formatForDiscord(String(caption)), 2000)[0] : undefined,
        files: [{ attachment: filePath, name: path.basename(filePath) }],
      });
    },
  };
}

/**
 * What to do when Discord refuses the login, in place of discord.js's own words, or null for anything else (a network
 * error, an outage), which keeps them. A refused token is TokenInvalid (or gateway close 4004 "Authentication
 * failed"); Message Content left off in the Developer Portal is gateway close 4014 "Used disallowed intents".
 */
export function discordLoginError(err) {
  const code = err?.code;
  const message = String(err?.message || "");
  if (code === "TokenInvalid" || code === 4004 || err?.status === 401 || /invalid token was provided|^authentication failed$/i.test(message)) {
    return "Discord refused the bot token. In the Developer Portal: your app → Bot → Reset Token, then paste the new one.";
  }
  if (code === "DisallowedIntents" || code === 4014 || /disallowed intents/i.test(message)) {
    return "Turn on Message Content Intent: Developer Portal → your app → Bot → Privileged Gateway Intents, save, then save here again.";
  }
  return null;
}

/**
 * What the invite link asks for: what the bot needs to read a channel and answer in it, with files, reactions and
 * threads. Tarsee registers no slash commands, so the link has the bot scope only.
 */
export const DISCORD_INVITE_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
];

/** The OAuth2 link that adds a logged-in client's bot to a server, or null before Discord has said which app it is. */
export function discordInviteUrl(client) {
  if (!client?.application) return null;
  return client.generateInvite({ scopes: [OAuth2Scopes.Bot], permissions: DISCORD_INVITE_PERMISSIONS });
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

/**
 * An answer as Discord shows it: [react: ...] markers and tool-call records out, no runs of blank lines, tables and
 * quotes as Discord can draw them (lib/discord-format.js).
 */
export function displayForDiscord(raw) {
  const { cleanText } = parseReactions(raw);
  return formatForDiscord(
    String(cleanText ?? "")
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
      .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

// Fence-aware splitter. The old one split on the last "\n" before maxLen, which could cleave a ``` code fence across
// two messages: chunk 1 with an unterminated fence (everything after it renders as code), chunk 2 starting with a
// stray ```. Tables drawn as fenced grids made that likely. splitMessageFenceSafe closes and reopens fences across
// the boundary (keeping the language tag) and never cuts an emoji in half.
function splitMessage(text, maxLen) {
  return splitMessageFenceSafe(text, maxLen);
}
