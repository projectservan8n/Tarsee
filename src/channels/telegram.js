import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { Telegraf } from "telegraf";
import { chatStream } from "../ai/router.js";
import { withConversationTurn } from "../lib/conversation-lock.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { processCommand, extractPlaybookPrompt, getCommandList, answeredAtOnce } from "../lib/commands.js";
import { buildSystemPromptParts, sendFileHint } from "../lib/build-system-prompt.js";
import { parseReactions } from "../lib/reaction-parser.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { toolStatusLabel, toolDoneLabel } from "../lib/tool-status.js";
import { transcribeAudio } from "../voice/stt-handler.js";
import envConfig from "../config/env.js";
import { refused } from "../lib/channel-errors.js";
import { turnErrorNote, idleNote, errorStillToSay, sttProblem } from "./turn-notes.js";

/**
 * Creates and starts a Telegram bot.
 *
 * @param {object} config - { token, enabled, allowedChats?, ackReaction?, streaming? }
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts] - apiRoot: the Bot API base; chatStream: the model stream (ai/router.js chatStream when left
 *   out); deliverPending (see manager.js); getMeTimeoutMs: how long the startup token check waits (15 s);
 *   typingEveryMs: how often "typing…" is sent while a message is answered or waits for its turn (4 s). Tests point
 *   the first two at 127.0.0.1 and a scripted model.
 * @returns {Promise<{stop: Function, identity: string|null}>}
 */
export async function createTelegramBot(config, db, opts = {}) {
  const convStore = new ConversationStore(db);
  const settingsStore = new SettingsStore(db);
  const streamChat = opts.chatStream || chatStream;

  // Telegraf's default handlerTimeout (90s) abandons a handler mid-turn — the
  // reply gets generated but NEVER delivered, and stderr fills with
  // "Promise timed out after 90000 milliseconds". Long agent turns are the norm
  // here, so effectively disable it (largest setTimeout-safe value).
  //
  // NOTE: the Mac build also pins the HTTPS agent to `family: 4`. That is
  // deliberately NOT ported — Railway's egress is dual-stack and forcing IPv4
  // there is a regression risk, not a fix. keepAlive alone is the portable win.
  const tgAgent = new https.Agent({ keepAlive: true });
  const bot = new Telegraf(config.token, {
    // opts.apiRoot: another Bot API server (test/send-file.test.js runs one on 127.0.0.1 over plain HTTP).
    telegram: opts.apiRoot ? { apiRoot: opts.apiRoot } : { agent: tgAgent },
    handlerTimeout: 2_000_000_000,
  });

  // ── Inbound dedup ──────────────────────────────────────────────────────
  // Telegram re-delivers any update the poller pulled but didn't CONFIRM (via
  // the next getUpdates offset) before it was stopped — e.g. on a container
  // restart or a channel relaunch. Without dedup that arrives as the SAME
  // message processed twice. Drop repeats by update_id, bounded to 1000.
  const _seenUpdates = new Set();
  const _seenOrder = [];
  const chatsSeen = new Set(); // chats whose ID has been logged (no allowlist yet), once each
  let _updatesReceived = 0;
  let _handlerActive = 0;
  let _lastUpdateAt = 0;

  // ── One update at a time, without holding up the poll loop ─────────────
  // Telegraf's poll loop waits until a batch of updates is handled before it asks Telegram for more, and a message is
  // handled until its reply ends, which can take many minutes. So a /stop sent while a reply ran was only read once
  // that reply had ended, too late to stop anything. Now the poll loop never waits: each update gets in line here
  // and is handled in the order it came, one at a time, as before. Only the commands meant for that moment or that
  // change nothing (/stop, /help, /version: lib/commands.js answeredAtOnce) skip the line and are answered at once.
  // An album takes one place in line, when its first photo comes (see takeAlbumPhoto). Once the channel is stopped,
  // the bot shows no chat anything more: what still waits in line, or is on its way to its AI turn, is dropped without
  // being answered, and the log says so (droppedOnStop). A reply already running ends as it would have, without its
  // "typing…".
  let line = Promise.resolve();
  let stopped = false;
  const inLine = new Set(); // what waits in line and hasn't started: { chat }, for the log when the channel stops
  const botError = (err) => console.error("[telegram] bot error:", err?.message || err);
  /** Run fn now or after everything in line, counted in health() until it ends; its errors are logged, never thrown. */
  function handleUpdate(ctx, fn, { now = false } = {}) {
    _handlerActive++;
    const run = () => {
      if (stopped) { _handlerActive--; return; } // dropped: stop() said so in the log
      return Promise.resolve().then(fn).catch(botError).finally(() => { _handlerActive--; });
    };
    if (now) { run(); return; }
    const waiting = { chat: ctx.chat?.id };
    inLine.add(waiting);
    line = line.then(() => { inLine.delete(waiting); return run(); });
  }

  /**
   * Whether the channel has stopped, checked by whatever is on its way to its AI turn after each wait (a download, a
   * transcription, a call to Telegram, another reply in its chat). When it has, what came from chat `chatId` (`what`:
   * "a photo", "a voice message"...) is dropped: nothing more is said or shown to the chat, and the log says so.
   * `saved`: the message is already in the chat's history, where it stays (the person did send it), unanswered.
   */
  function droppedOnStop(chatId, what = "a message", { saved = false } = {}) {
    if (!stopped) return false;
    console.warn(saved
      ? `[telegram] the channel is stopped: ${what} from chat ${chatId} was not answered; it stays in the chat's history`
      : `[telegram] the channel is stopped: ${what} from chat ${chatId} dropped without an answer`);
    return true;
  }

  // "typing…" in a chat while its message is answered or waits for its turn: sent every typingEveryMs (Telegram shows
  // it for 5 s). stop() ends every one, and one still going finds the channel stopped and ends itself.
  const TYPING_EVERY_MS = opts.typingEveryMs || 4000;
  const typing = new Set(); // the end() of each, for stop()
  /** Keep "typing…" showing in ctx's chat until the returned end() is called (any number of times). */
  function keepTyping(ctx) {
    const timer = setInterval(() => {
      if (stopped) { end(); return; }
      ctx.sendChatAction("typing").catch(() => {});
    }, TYPING_EVERY_MS);
    function end() { clearInterval(timer); typing.delete(end); }
    typing.add(end);
    return end;
  }

  bot.use((ctx, next) => {
    const uid = ctx.update?.update_id;
    if (uid != null) {
      if (_seenUpdates.has(uid)) {
        console.warn(`[telegram] dropped duplicate update_id=${uid}`);
        return; // already processed — don't double-handle
      }
      _seenUpdates.add(uid);
      _seenOrder.push(uid);
      if (_seenOrder.length > 1000) _seenUpdates.delete(_seenOrder.shift());
    }
    if (stopped) {
      console.warn(`[telegram] the channel is stopped: update ${uid} from chat ${ctx.chat?.id} dropped without an answer`);
      return;
    }
    _updatesReceived++;
    _lastUpdateAt = Date.now();
    if (ctx.message?.media_group_id && ctx.message.photo) return takeAlbumPhoto(ctx);
    handleUpdate(ctx, () => next(), { now: answersAtOnce(ctx) });
  });

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
    return { data: buffer.toString("base64"), mediaType: contentType, buffer };
  }

  /**
   * Save a downloaded file to WORKSPACE_DIR/uploads so Claude can reach it
   * via Read/Bash. Returns the absolute path or null on failure.
   */
  function saveDocumentToDisk(buffer, fileName) {
    try {
      const uploadsDir = path.join(envConfig.WORKSPACE_DIR, "uploads");
      fs.mkdirSync(uploadsDir, { recursive: true });
      const safeName = (fileName || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(uploadsDir, `telegram-${Date.now()}-${safeName}`);
      fs.writeFileSync(filePath, buffer);
      return filePath;
    } catch (err) {
      console.error("[telegram] saveDocumentToDisk failed:", err.message);
      return null;
    }
  }

  /** The allowlist from config or Settings: chat ids (a private chat's id is its person's user id). */
  function allowedChatsNow() {
    const dbAllowlist = settingsStore.get("allowlist.telegram");
    return config.allowedChats?.length > 0 ? config.allowedChats : (dbAllowlist ? (typeof dbAllowlist === "string" ? JSON.parse(dbAllowlist) : dbAllowlist) : []);
  }

  /**
   * Whether the sender is the owner, for the owner's commands (/cron, /briefing, /webhook: lib/commands.js): their own
   * user id is on the allowlist (in a private chat that is the chat's id too). A listed group lets its members talk
   * to the bot, not manage it; with no allowlist anyone can talk to it, so nobody counts.
   */
  function senderIsOwner(ctx) {
    const list = allowedChatsNow().map(String);
    return list.length > 0 && ctx.from?.id != null && list.includes(String(ctx.from.id));
  }

  /**
   * Whether this chat may talk to the bot: the allowlist from config or Settings (empty lets every chat in).
   * Settings says to message the bot and read the chat ID in the Console, so a dropped chat says its ID, and with no
   * allowlist yet each chat says it once (to start one with) without filling the Console.
   */
  function chatAllowed(ctx) {
    const chatId = ctx.chat.id;
    const allowedChats = allowedChatsNow();
    if (allowedChats.length > 0) {
      if (!allowedChats.includes(String(chatId))) {
        console.warn(`[telegram] ignoring message from chat ${chatId} (${chatLabel(ctx.chat, ctx.from)}): not on the Telegram allowlist`);
        return false;
      }
    } else if (!chatsSeen.has(chatId)) {
      chatsSeen.add(chatId);
      console.log(`[telegram] message from chat ${chatId} (${chatLabel(ctx.chat, ctx.from)})`);
    }
    return true;
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

    // The channel can stop while an update is on its way to its AI turn: while its photo or file downloads, its voice
    // note is transcribed, or at any wait below. It is then dropped, as one still waiting in line is (droppedOnStop);
    // only a reply already running ends as it would have.
    if (droppedOnStop(chatId)) return;

    if (!chatAllowed(ctx)) return;

    if (!text?.trim()) return;

    const channelKey = getChannelKey(ctx);

    // Check for commands. Commands can either (a) return a plain reply
    // to echo back, or (b) return a __PLAYBOOK__ sentinel that's meant to
    // be fed to the AI as the user's next turn. We detect (b) and fall
    // through to the normal AI pipeline instead of sending the playbook
    // text back at the user.
    let aiPromptOverride = null;
    if (text.startsWith("/")) {
      const existingConvId = settingsStore.get(`channel_conv.${channelKey}`);
      const cmdResult = await processCommand(text, {
        settingsStore,
        convStore,
        conversationId: existingConvId,
        platform: "telegram",
        owner: senderIsOwner(ctx),
        // `db` was missing — /clear could not do its DB cleanup and silently
        // no-op'd, letting sessions accumulate huge transcripts.
        db,
      });
      if (droppedOnStop(chatId)) return;

      if (cmdResult.handled) {
        const playbook = extractPlaybookPrompt(cmdResult);
        if (playbook) {
          aiPromptOverride = playbook;
        } else {
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
    const savedUser = convStore.addMessage(convId, {
      role: "user",
      content: `[${username}]: ${text}${attachments.length ? ` [+${attachments.length} image(s)]` : ""}`,
    });

    // Which AI answers is the turn layer's to decide (ai/turn.js: this chat's own pick, else the default), and so is
    // saying what to set up when that AI isn't ready: its answer is the reply.

    // Ack reaction — let user know we're processing
    const ackEmoji = config.ackReaction ?? "👀";
    if (ackEmoji) {
      ctx.react?.(ackEmoji).catch?.(() => {});
    }

    // The native "typing..." indicator, kept alive below (keepTyping) while processing. No
    // "💭 Thinking..." placeholder message — we used to send one and edit
    // it with tool progress, but users found it noisy. Final reply is the
    // only bubble the user sees.
    await ctx.sendChatAction("typing").catch(() => {});
    if (droppedOnStop(chatId, "a message", { saved: true })) return;

    // Build full system prompt
    const history = convStore.getRecentMessages(convId, 15);
    const conv = convStore.get(convId);
    const systemParts = buildSystemPromptParts({
      settingsStore,
      db,
      conversationId: convId,
      messageCount: history.length,
      conversationPrompt: conv?.system_prompt,
      channelHint: `Keep responses concise for chat. You are in a Telegram conversation.
You can use these special markers in your response:
- [react: emoji] — adds a reaction to the user's message (e.g. [react: ✅])
- [buttons: ["Option A", "Option B"]] — sends inline buttons the user can tap
${sendFileHint("telegram")}`,
    });

    let fullResponse = "";
    // messageId: the message this turn answers (its pictures are kept on it, not on whatever came in later)
    const toolCtx = { db, settingsStore, conversationId: convId, messageId: savedUser?.id || null };

    // Idle watchdog: if the SDK goes 3 min without emitting an event we abort
    // and send the user an explicit message instead of hanging forever.
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

    // Streaming-segment state — each text block between tool boundaries
    // becomes its own Telegram message that edit-streams as tokens arrive.
    // Tool calls produce ephemeral status messages ("Running command…"
    // → "✓ Command done") so the user sees realtime progress instead of
    // a long silence. The DB still gets the full XML-wrapped transcript
    // so subsequent turns and the webapp see the complete history.
    let segmentMsgId = null;
    let segmentText = "";
    let lastSegmentEditAt = 0;
    const SEGMENT_EDIT_DEBOUNCE_MS = 900; // Telegram edit cap is ~1/sec/message
    const toolMsgById = new Map(); // tool_use_id → status message_id
    const sentSegments = []; // for closeSegment overflow tracking, debug only

    const editMessageSafe = async (msgId, html, opts = {}) => {
      try {
        await ctx.telegram.editMessageText(chatId, msgId, undefined, html, { parse_mode: "HTML", ...opts });
      } catch (e) {
        const code = e?.response?.error_code || e?.code;
        // 400 "message is not modified" → benign. 429 → fall through; the
        // next debounced edit will retry. Fallback strip-on-error in case
        // of malformed HTML.
        if (code === 400 && /not modified/i.test(e?.description || e?.message || "")) return;
        if (code === 400) {
          try { await ctx.telegram.editMessageText(chatId, msgId, undefined, html.replace(/<[^>]+>/g, ""), opts); } catch {}
        }
      }
    };

    const renderSegmentDisplay = (raw) => {
      // Strip [react:] / [buttons:] markers for display — they're parsed
      // post-hoc from the saved fullResponse, so the user shouldn't see
      // them mid-stream.
      const { cleanText } = parseReactions(raw);
      const stripped = cleanText
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
        .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return mdToTelegramHtml(stripped);
    };

    const flushSegmentEdit = async (final = false) => {
      if (!segmentMsgId || !segmentText) return;
      const now = Date.now();
      if (!final && now - lastSegmentEditAt < SEGMENT_EDIT_DEBOUNCE_MS) return;
      lastSegmentEditAt = now;
      const html = renderSegmentDisplay(segmentText.slice(0, 4096));
      if (!html) return; // empty after stripping markers — wait for more
      await editMessageSafe(segmentMsgId, html);
    };

    const closeSegment = async (extraOpts = null) => {
      if (!segmentMsgId) { segmentText = ""; return; }
      await flushSegmentEdit(true);
      // If the segment text overflowed, send remainder as new replies so
      // the user sees the full thing.
      if (segmentText.length > 4096) {
        for (let i = 4096; i < segmentText.length; i += 4096) {
          const html = renderSegmentDisplay(segmentText.slice(i, i + 4096));
          if (!html) continue;
          const chunks = splitMessage(html, 4096);
          for (const chunk of chunks) {
            await ctx.reply(chunk, { parse_mode: "HTML", ...(extraOpts || {}) })
              .catch(() => ctx.reply(chunk.replace(/<[^>]+>/g, ""), extraOpts || {}));
          }
        }
      } else if (extraOpts && segmentMsgId) {
        // Re-edit the final segment with the extras (e.g. inline_keyboard
        // for buttons attached to the last narration block).
        const html = renderSegmentDisplay(segmentText.slice(0, 4096));
        if (html) await editMessageSafe(segmentMsgId, html, extraOpts);
      }
      sentSegments.push(segmentText);
      segmentMsgId = null;
      segmentText = "";
    };

    const postToolStatus = async (event) => {
      try {
        const label = toolStatusLabel(event.name, event.input);
        const msg = await ctx.reply(`<i>⚙️ ${escapeHtml(label)}</i>`, { parse_mode: "HTML" });
        toolMsgById.set(event.id, msg.message_id);
      } catch { /* best-effort */ }
    };
    const markToolDone = async (id, name, input, result) => {
      const msgId = toolMsgById.get(id);
      if (!msgId) return;
      const resultStr = typeof result === "string" ? result : JSON.stringify(result || "");
      const isErr = /error|forbidden|not found|enotfound|command not found/i.test(resultStr);
      const label = toolDoneLabel(name, input || {}, isErr);
      const html = isErr ? `<i>❌ ${escapeHtml(label)}</i>` : `<i>✓ ${escapeHtml(label)}</i>`;
      await editMessageSafe(msgId, html);
      toolMsgById.delete(id);
    };

    // One turn at a time per chat. Telegram delivers messages as fast as
    // they are sent, and each one resolved the same conversation and resumed
    // the same Claude session id, so two processes appended to one transcript.
    // In a group chat with two people talking that happened constantly, and it
    // could leave the session corrupt enough that every later turn failed.
    // Follow-ups queue instead of racing: a quick correction is usually meant
    // to be read, not dropped.
    //
    // "typing…" shows until the turn has ended, or the dashboard's Stop takes it out of the queue (it then never
    // runs), or the channel stops (stop() ends it, also for one still waiting).
    const stopTyping = keepTyping(ctx);
    const turn = withConversationTurn(convId, async () => {
    // The AI this turn runs on, from the turn layer's route event (the backup model's, if it answered instead).
    let routed = null;
    try {
      // This may have waited behind another reply in this chat.
      if (droppedOnStop(chatId, "a message", { saved: true })) return;
      const workingMessages = history.map((m) => ({ role: m.role, content: m.content }));

      // Slash-command playbooks: keep the user's literal "/checkpoint" in
      // the DB / chat history, but swap the AI-visible last user turn for
      // the playbook body so the model acts on it.
      if (aiPromptOverride && workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") last.content = aiPromptOverride;
      }

      // Enrich last user message with image blocks if attachments present
      if (attachments.length > 0 && workingMessages.length > 0) {
        const last = workingMessages[workingMessages.length - 1];
        if (last.role === "user") {
          const contentBlocks = [];
          for (const att of attachments) contentBlocks.push(att);
          contentBlocks.push({ type: "text", text: typeof last.content === "string" ? last.content : text });
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
        liveSource: "telegram",
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
          if (!segmentMsgId) {
            try {
              const placeholder = await ctx.reply("…");
              segmentMsgId = placeholder.message_id;
            } catch { /* if reply fails just keep accumulating; we'll
                          fall back to a final batched send */ }
          }
          segmentText += event.content;
          await flushSegmentEdit(false);
        } else if (event.type === "tool_use") {
          // Narration ends here — finalize the visible segment and post
          // the tool status indicator.
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
        const { cleanText, reactions, buttons } = parseReactions(fullResponse);

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

        // Apply agent reactions to the user's original message.
        for (const emoji of reactions) {
          if (ctx.message?.message_id) {
            ctx.telegram.setMessageReaction?.(chatId, ctx.message.message_id, [{ type: "emoji", emoji }]).catch(() => {});
          }
        }

        // Close the final narration segment. If buttons were emitted,
        // attach them to the last segment via inline_keyboard, or — if
        // the model replied with buttons but no text — send a separate
        // "Choose:" message.
        const buttonOpts = buttons?.length > 0
          ? { reply_markup: { inline_keyboard: buttonsToKeyboard(buttons) } }
          : null;

        if (segmentMsgId || segmentText) {
          await closeSegment(buttonOpts);
        } else if (buttonOpts) {
          await ctx.reply("Choose:", buttonOpts);
        } else if (sentSegments.length === 0) {
          // Model produced only tool calls + nothing user-facing.
          // Surface a soft note so the chat doesn't look broken.
          await ctx.reply("⚠️ Done — no message body.").catch(() => {});
        }
      }
      // An error the turn reported (already in plain words: what went wrong, what to do), after whatever it said
      // before it: a spending limit or the turn ceiling can stop a reply halfway. Not again when the reply is the
      // error itself (the turn layer's "set this up first" answers).
      if (surfacedError && errorStillToSay(fullResponse, surfacedError)) {
        await ctx.reply(turnErrorNote(routed, surfacedError)).catch(() => {});
      } else if (!fullResponse && idleAborted) {
        await ctx.reply(idleNote(routed, IDLE_ABORT_MS)).catch(() => {});
      } else if (!fullResponse && !surfacedError) {
        await ctx.reply("⚠️ No response generated. Try rephrasing?").catch(() => {});
      }
    } catch (err) {
      console.error("[telegram] chat error:", err.message);
      const reason = idleAborted
        ? idleNote(routed, IDLE_ABORT_MS)
        : `⚠️ Error: ${err.message || "something went wrong"}. Try again.`;
      await ctx.reply(reason).catch(() => {});
    }
    }, {
      // Waiting behind the reply in progress: a "Queued" line on the dashboard too, whose Stop takes it out.
      live: { source: "telegram", prompt: text, onRemoved: stopTyping },
      onQueued: (ahead) => {
        ctx.reply(ahead === 1
          ? "⏳ Still working on your last message — yours is next."
          : `⏳ Queued (${ahead} ahead).`).catch(() => {});
      },
    });
    // Both timers end however the turn ends, also when it never ran (taken out of the queue).
    try { await turn; } finally {
      stopTyping();
      clearInterval(idleTimer);
    }
  }

  /** Whether an update is one of the commands answered at once (see "One update at a time" above), read as the text handler reads it. */
  function answersAtOnce(ctx) {
    if (typeof ctx.message?.text !== "string") return false;
    const text = messageText(ctx);
    return text != null && answeredAtOnce(text);
  }

  // --- Main text handler ---
  bot.on("text", async (ctx) => {
    const text = messageText(ctx);
    if (text == null) return;
    await handleMessage(ctx, text);
  });

  /**
   * What a text message says, as it is handled: with who it was forwarded from or the message it replies to, and the
   * bot's @handle taken out. null for a group message that isn't for the bot (telegram.mention_mode).
   */
  function messageText(ctx) {
    let text = ctx.message.text;

    // Detect forwarded messages — add context
    if (ctx.message.forward_from || ctx.message.forward_sender_name) {
      const from = ctx.message.forward_from?.first_name || ctx.message.forward_sender_name || "someone";
      text = `[Forwarded from ${from}]: ${text}`;
    }

    // Include replied-to message as context
    const repliedMsg = ctx.message.reply_to_message;
    if (repliedMsg && repliedMsg.text) {
      const repliedFrom = repliedMsg.from?.first_name || repliedMsg.from?.username || "someone";
      text = `[Replying to ${repliedFrom}: "${repliedMsg.text}"]\n\n${text}`;
    }

    // In groups: optionally require @mention or reply-to-bot. Toggleable via
    // telegram.mention_mode setting — "required" (default) keeps the prior
    // behavior; "off" lets allowlisted users chat without tagging the bot.
    // Always strip the bot's @handle from the text so the model never sees
    // it, regardless of mode.
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      const botUsername = ctx.botInfo?.username;
      const mentionMode = settingsStore.get("telegram.mention_mode") === "off" ? "off" : "required";
      if (mentionMode === "required") {
        const isMentioned = botUsername && text.includes(`@${botUsername}`);
        const isReply = repliedMsg?.from?.id === ctx.botInfo?.id;
        if (!isMentioned && !isReply) return null;
      }
      if (botUsername) text = text.replace(new RegExp(`@${botUsername}\\b`, "gi"), "").trim();
    }
    return text;
  }

  // --- Photo albums ---
  // Telegram sends an album as one message per photo, each with the album's media_group_id, one right after another.
  // They are answered as one message. The album takes its place in line when its first photo comes, and each photo's
  // download starts as it comes, side by side. The album is complete ALBUM_GAP_MS after its last photo came, however
  // long the downloads take (a far server can take longer than that for each); its turn then waits for them all.
  const ALBUM_GAP_MS = 500;
  const albums = new Map(); // media_group_id → { ctx, parts: Promise<image block|null>[], caption, timer, complete, close }

  /** A photo of an album, as it comes (not in line): its download starts, and the album waits ALBUM_GAP_MS for the next. */
  function takeAlbumPhoto(ctx) {
    // A chat off the allowlist is dropped before anything is downloaded, as a voice message is.
    if (!chatAllowed(ctx)) return;
    const groupId = ctx.message.media_group_id;
    let album = albums.get(groupId);
    if (!album) {
      album = { ctx, parts: [], caption: "", timer: null };
      album.complete = new Promise((resolve) => { album.close = resolve; });
      albums.set(groupId, album);
      handleUpdate(ctx, () => answerAlbum(album));
    }
    const photos = ctx.message.photo;
    album.parts.push(downloadTelegramFile(photos[photos.length - 1].file_id).then(
      ({ data, mediaType }) => ({ type: "image", source: { type: "base64", media_type: mediaType, data } }),
      (err) => { console.error("[telegram] photo download error:", err.message); return null; },
    ));
    if (ctx.message.caption) album.caption = ctx.message.caption;
    clearTimeout(album.timer);
    album.timer = setTimeout(() => { albums.delete(groupId); album.close(); }, ALBUM_GAP_MS);
  }

  /** An album's turn in line: once it is complete and every photo is downloaded, it is answered as one message. */
  async function answerAlbum(album) {
    await album.complete;
    const results = await Promise.all(album.parts);
    if (droppedOnStop(album.ctx.chat?.id, "an album")) return;
    const images = results.filter(Boolean);
    const failed = results.length - images.length;
    if (failed > 0) {
      await album.ctx.reply(failed === 1 ? "Failed to process image." : `Failed to process ${failed} of the ${results.length} images.`).catch(() => {});
    }
    if (images.length === 0) return;
    const text = album.caption
      || (images.length === 1 ? "Please analyze this image." : `Please analyze these ${images.length} images.`);
    await handleMessage(album.ctx, text, null, images);
  }

  // --- A photo on its own (an album's photos are taken in takeAlbumPhoto) ---
  // A chat off the allowlist is dropped before anything is downloaded, as a voice message is: a failed download would
  // otherwise answer it. So is one whose download ends after the channel stopped (handleMessage drops one that worked).
  bot.on("photo", async (ctx) => {
    if (!chatAllowed(ctx)) return;
    try {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const { data, mediaType } = await downloadTelegramFile(largest.file_id);
      const attachment = { type: "image", source: { type: "base64", media_type: mediaType, data } };
      const caption = ctx.message.caption || "";
      await handleMessage(ctx, caption || "Please analyze this image.", null, [attachment]);
    } catch (err) {
      console.error("[telegram] photo handler error:", err.message);
      if (droppedOnStop(ctx.chat.id, "a photo")) return;
      await ctx.reply("Failed to process image.").catch(() => {});
    }
  });

  // --- Document handler (files including images, PDFs, and generic files) ---
  // As a photo: a chat off the allowlist is dropped before anything is downloaded or saved, and a file whose download
  // ends after the channel stopped is dropped without being saved.
  bot.on("document", async (ctx) => {
    if (!chatAllowed(ctx)) return;
    try {
      const doc = ctx.message.document;
      const mime = doc.mime_type || "";
      const caption = ctx.message.caption || "";
      const sizeKb = Math.round((doc.file_size || 0) / 1024);
      const { data, mediaType, buffer } = await downloadTelegramFile(doc.file_id);
      if (droppedOnStop(ctx.chat.id, "a file")) return;

      if (mime.startsWith("image/")) {
        const attachment = { type: "image", source: { type: "base64", media_type: mediaType, data } };
        await handleMessage(ctx, caption || "Please analyze this image.", null, [attachment]);
      } else if (mime === "application/pdf") {
        // PDF: multimodal document block + save to disk so Claude's Read
        // tool can reach it if needed.
        const attachment = { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
        const savedPath = saveDocumentToDisk(buffer, doc.file_name);
        const pathNote = savedPath
          ? `\n\n[PDF attached: ${doc.file_name} (${sizeKb}KB) → ${savedPath}] — multimodal PDF block provided above; you can also Read this file directly at the path.`
          : "";
        await handleMessage(ctx, (caption || "Please analyze this PDF.") + pathNote, null, [attachment]);
      } else {
        // Generic file (txt/json/csv/docx/zip/etc.) — save to disk and
        // surface the path to Claude so it can Read the file. Previously
        // the bytes were thrown away after a one-line description.
        const savedPath = saveDocumentToDisk(buffer, doc.file_name);
        const note = savedPath
          ? `[Attached file saved: ${doc.file_name} (${mime || "unknown"}, ${sizeKb}KB) → ${savedPath}]\nYou can read this file with the Read tool at: ${savedPath}`
          : `[Sent file: ${doc.file_name} (${mime}) — failed to save to disk]`;
        const text = caption ? `${caption}\n\n${note}` : note;
        await handleMessage(ctx, text);
      }
    } catch (err) {
      console.error("[telegram] document handler error:", err.message);
      if (droppedOnStop(ctx.chat.id, "a file")) return;
      await ctx.reply("Failed to process file.").catch(() => {});
    }
  });

  // --- Voice messages and video notes (round videos), transcribed on this server (see voice/stt-handler.js) ---
  bot.on("voice", (ctx) => answerSpoken(ctx, ctx.message.voice, "voice message"));
  bot.on("video_note", (ctx) => answerSpoken(ctx, ctx.message.video_note, "video note"));

  /**
   * A voice message or video note (`what`): downloaded, transcribed, and answered as the words it says. A chat off the
   * allowlist is dropped before anything is downloaded or said back. Once the channel stops, nothing more is
   * transcribed (the paid Whisper API may be the transcriber) or said, not even that it failed: it is dropped.
   */
  async function answerSpoken(ctx, file, what) {
    if (!chatAllowed(ctx)) return;
    const dropped = () => droppedOnStop(ctx.chat.id, `a ${what}`);
    try {
      console.log(`[telegram] ${what}: ${file.duration}s, ${file.file_size} bytes`);

      // Download the audio (.ogg; a video note's .mp4) from Telegram
      const fileLink = await bot.telegram.getFileLink(file.file_id);
      const res = await fetch(fileLink.href);
      const audioBuffer = Buffer.from(await res.arrayBuffer());
      if (dropped()) return;

      // Transcribe
      await ctx.sendChatAction("typing").catch(() => {});
      if (dropped()) return;
      const result = await transcribeAudio(audioBuffer, "en", { settingsStore });
      if (dropped()) return;

      if (!result.transcript?.trim()) {
        await ctx.reply(`Couldn't understand the ${what}.`, {
          reply_to_message_id: ctx.message.message_id,
        });
        return;
      }

      console.log(`[telegram] transcribed ${what}: "${result.transcript.slice(0, 80)}..."`);
      await handleMessage(ctx, result.transcript, ctx.message.message_id);
    } catch (err) {
      console.error(`[telegram] ${what} handler error:`, err.message);
      if (dropped()) return;
      // Transcription that can't run says what to set up (Settings > Voice); anything else keeps the short note.
      await ctx.reply(sttProblem(err) || `Failed to process ${what}.`).catch(() => {});
    }
  }

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

  bot.catch(botError);

  // Check the token before polling starts, so a wrong one fails the channel with what to do about it (Settings shows
  // it). Only Telegram refusing it fails the channel: a timeout or network error must not hold startup up (see the
  // launch note below), so polling starts anyway and Telegraf asks again. The answer is kept for launch to use.
  try {
    bot.botInfo = await bot.telegram.callApi("getMe", {}, { signal: AbortSignal.timeout(opts.getMeTimeoutMs ?? 15_000) });
  } catch (err) {
    if ([401, 404].includes(err?.response?.error_code)) throw refused(TELEGRAM_TOKEN_REFUSED);
    console.warn(`[telegram] could not check the bot token (${err.message}); starting anyway`);
  }

  // Use polling (no webhook needed).
  //
  // NOTE: bot.launch() must NOT be awaited. Telegraf's promise resolves only
  // once polling is "ready", which on a flaky network can take >90s or never
  // resolve. If it never resolves, createTelegramBot() never returns and
  // ChannelManager never registers the bot — breaking every outbound tool
  // (tarsee_send_message, send_message) even though inbound still flows.
  // Worse, B starts channels serially, so a wedged Telegram also prevents
  // Discord, Email and WhatsApp from ever starting.
  //
  // On a cold boot we drop whatever queued while the container was down. When
  // the health monitor relaunches a STUCK poller those queued updates are real
  // messages the wedged poller failed to pull, so we deliver them instead.
  //
  // launch asks Telegram one more thing (deleteWebhook) before it starts polling, so the channel can be stopped before
  // there is any polling to stop. Polling then never starts: started, it would take every message while dropping it.
  const startPolling = bot.startPolling.bind(bot);
  bot.startPolling = (...args) => (stopped ? Promise.resolve() : startPolling(...args));
  bot.launch({ dropPendingUpdates: !opts.deliverPending }).catch((err) => {
    console.error("[telegram] bot.launch error (polling will retry):", err.message);
  });

  // Register the /commands dropdown with Telegram so typing "/" in a chat
  // pops up the native command suggestions. Derive it from the shared
  // command registry so new commands automatically show up here instead
  // of needing a hardcoded list to stay in sync.
  //
  // Telegram rules: name must match ^[a-z0-9_]{1,32}$, description must
  // be 3–256 chars, max 100 commands total. We filter + truncate rather
  // than silently dropping the whole set if one entry is out of spec.
  try {
    const tgCommands = getCommandList()
      .filter((c) => /^[a-z0-9_]{1,32}$/.test(c.name) && c.description)
      .map((c) => ({
        command: c.name,
        description: String(c.description).slice(0, 256),
      }))
      .slice(0, 100);
    await bot.telegram.setMyCommands(tgCommands);
    console.log(`[telegram] registered ${tgCommands.length} commands with Telegram`);
  } catch (err) {
    console.warn("[telegram] Failed to register commands:", err.message);
  }

  console.log(`[telegram] bot started`);

  return {
    /**
     * Stop polling. What still waits in line (and an album still coming) is dropped without being answered, and the
     * log says which chats it came from; a reply already running ends as it would have. No chat is shown "typing…"
     * any more. Twice is fine.
     */
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const end of [...typing]) end();
      for (const album of albums.values()) { clearTimeout(album.timer); album.close(); }
      albums.clear();
      if (inLine.size > 0) {
        const chats = [...new Set([...inLine].map((w) => w.chat))].join(", ");
        console.warn(`[telegram] the channel is stopped: ${inLine.size} message${inLine.size === 1 ? "" : "s"} still waiting in line dropped without an answer (chat ${chats})`);
        inLine.clear();
      }
      if (bot.polling) bot.stop("Tarsee shutdown"); // none yet: startPolling above won't start it now
    },
    /** Who it connected as, for Settings → Channels: @username, or null until Telegram has said. */
    get identity() {
      return bot.botInfo?.username ? `@${bot.botInfo.username}` : null;
    },
    /**
     * Poller health for the channel-health monitor.
     *  - updatesReceived: 0 means the poller has pulled NOTHING since launch
     *    (a genuine boot-race wedge — safe to relaunch).
     *  - handlerActive: updates in line or being handled now (a turn can run for
     *    minutes). >0 means the bot is busy, NOT stuck; don't relaunch.
     */
    health: () => ({
      updatesReceived: _updatesReceived,
      handlerActive: _handlerActive,
      lastUpdateAt: _lastUpdateAt,
    }),
    /** Send a message to a Telegram chat (outbound push). threadId: a forum topic. */
    sendMessage: async (chatId, text, { threadId = null } = {}) => {
      const html = mdToTelegramHtml(text);
      const where = threadId ? { message_thread_id: Number(threadId) } : {};
      await bot.telegram.sendMessage(chatId, html, { parse_mode: "HTML", ...where })
        .catch(() => bot.telegram.sendMessage(chatId, html.replace(/<[^>]+>/g, ""), where));
    },
    /**
     * Send a file as a document (the send_file tool). Streamed from disk; the bot API takes up to 50 MB. The file's
     * own name is passed, or Telegram calls it document.dat whatever it is. A caption Telegram can't parse as HTML is
     * sent again as plain text.
     */
    sendFile: async (chatId, filePath, caption, { threadId = null } = {}) => {
      if (!fs.existsSync(filePath)) throw new Error(`sendFile: file not found at ${filePath}`);
      const file = () => ({ source: fs.createReadStream(filePath), filename: path.basename(filePath) });
      const where = threadId ? { message_thread_id: Number(threadId) } : {};
      if (!caption) {
        await bot.telegram.sendDocument(chatId, file(), where);
        return;
      }
      const text = String(caption);
      try {
        await bot.telegram.sendDocument(chatId, file(), { ...where, caption: mdToTelegramHtml(text).slice(0, 1024), parse_mode: "HTML" });
      } catch (err) {
        if (!/parse entities|can't parse|caption/i.test(err?.message || "")) throw err;
        await bot.telegram.sendDocument(chatId, file(), { ...where, caption: text.slice(0, 1024) });
      }
    },
  };
}

const TELEGRAM_TOKEN_REFUSED = "Telegram refused the bot token. Copy it again from @BotFather: /mybots → your bot → API Token.";

/** A chat as people know it, for the Console: a group's title, else the person's @username or name. */
function chatLabel(chat = {}, from = {}) {
  if (chat.title) return chat.title;
  if (chat.username) return `@${chat.username}`;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  return name || (from?.username ? `@${from.username}` : from?.first_name) || "unknown";
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
  // 1. Extract code blocks first (protect from other transforms)
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const langTag = lang ? `<code class="language-${escapeHtml(lang)}">` : "";
    const langClose = lang ? "</code>" : "";
    codeBlocks.push(`<pre>${langTag}${escapeHtml(code.trim())}${langClose}</pre>`);
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  // 2. Detect markdown tables (lines with |) and wrap in <pre> with aligned columns
  text = text.replace(/((?:^|\n)\|.+\|(?:\n\|.+\|)+)/g, (table) => {
    const lines = table.trim().split("\n");
    // Parse all rows into cells
    const rows = lines
      .filter(line => !/^\|[\s\-:|]+\|$/.test(line)) // remove separator rows
      .map(line => line.replace(/^\||\|$/g, "").split("|").map(c => c.trim()));

    if (rows.length === 0) return table;

    // Calculate max width for each column
    const colCount = Math.max(...rows.map(r => r.length));
    const colWidths = Array(colCount).fill(0);
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        colWidths[i] = Math.max(colWidths[i], (row[i] || "").length);
      }
    }

    // Format rows with padding
    const formatted = rows.map((row, rowIdx) => {
      const cells = row.map((cell, i) => (cell || "").padEnd(colWidths[i]));
      const line = cells.join(" | ");
      return line;
    });

    // Insert separator after header
    if (formatted.length > 1) {
      const sep = colWidths.map(w => "-".repeat(w)).join("-+-");
      formatted.splice(1, 0, sep);
    }

    return `\n<pre>${escapeHtml(formatted.join("\n"))}</pre>\n`;
  });

  text = text
    // Inline code
    .replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`)
    // Bold (**text**)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    // Italic (*text*)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>")
    // Strikethrough (~~text~~)
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    // Links [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Headings (## text) → bold
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    // Blockquotes (> text) — merge consecutive lines into single blockquote
    .replace(/(^>\s?.+$(\n^>\s?.+$)*)/gm, (block) => {
      const lines = block.split("\n").map(l => l.replace(/^>\s?/, "")).join("\n");
      return `<blockquote>${lines}</blockquote>`;
    });

  // 3. Restore code blocks
  // NUL is deliberate here: it is the sentinel wrapping the placeholder token,
  // chosen because it cannot occur in the Telegram message text being escaped.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)]);

  return text;
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
