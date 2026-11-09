import { Router } from "express";
import { chatStream } from "../ai/router.js";
import { stopTurns } from "../ai/turn.js";
import { contextTokensFor } from "../ai/provider-registry.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { initSSE, sendSSE } from "../lib/stream-utils.js";
import { LIMITS, tierOf } from "../config/constants.js";
import { modelsHandlers } from "./models.js";
import { snapshotForContextOverflow } from "../lib/auto-checkpoint.js";
import { processCommand, getCommandList, extractPlaybookPrompt } from "../lib/commands.js";
import { buildSystemPromptParts, sendFileHint } from "../lib/build-system-prompt.js";
import { trackActivity } from "../lib/session-reset.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { getGatewayManager } from "../lib/gateway.js";
import { redactSecrets, redactDeep } from "../lib/redact.js";
import { messageTools, slimMessage } from "../lib/message-tools.js";   // a reply's tools; history without their inputs and outputs
import { summarizeToolInput } from "../lib/tool-steps.js";
import { latestSeq, activeTurnFor, recentClientMsgIds, hasClientMsgId, publish } from "../lib/live-bus.js";
import { withConversationTurn, queueDepth, currentQueuedTurn, removeQueuedTurn, QUEUE_REMOVED } from "../lib/conversation-lock.js";
import { createLoopGuard } from "../lib/loop-guard.js";
import { effectiveContextWindow } from "../ai/context-limits.js";
import { placeFilesOnPage, forgetChatFiles } from "../lib/chat-files.js";   // the chat's files, kept with it
import { keepUploadedFiles, noteReceivedFiles, viewablePath, sendViewable } from "../lib/sent-files.js";

/**
 * Broadcast an SSE-like event to all connected WebSocket clients and record
 * it in the gateway's replay buffer. The originating client dedupes against
 * its own SSE stream via an `isStreaming` guard on the same conversation,
 * so we don't need to filter the sender here — doing so would skip the
 * gateway's buffer entry for the sender's own reconnects.
 */
function broadcastToOthers(convId, eventType, data) {
  getGatewayManager().broadcast(convId, eventType, data);
}

/**
 * Classify message complexity for auto model routing.
 * Heuristic only — no AI calls. Returns a *tier* word (opus, sonnet, haiku),
 * which the turn layer maps to the chat's AI's own model of that tier
 * (provider-registry.js resolveModelFor): on the Claude plan the newest Opus,
 * on DeepSeek its Pro model, and so on.
 */
function classifyMessageModel(message) {
  const words = message.split(/\s+/).length;
  const lower = message.toLowerCase();

  // Opus signals: code, analysis, complex tasks
  const opusKeywords = ["debug", "fix", "implement", "refactor", "architect", "design pattern",
    "analyze", "complex", "explain how", "write a", "build", "create a", "deploy",
    "optimize", "migrate", "security", "performance", "!think", "!!"];
  const hasCode = message.includes("```") || /\b(function|const|import|class|def|async|await)\s/.test(message);
  if (hasCode || opusKeywords.some((k) => lower.includes(k))) return "opus";

  // Haiku signals: short, simple
  if (words <= 12 && /^(hi|hello|hey|yes|no|ok|thanks|sure|yep|nah|what is|who is|when is|where is|how much|how many)/i.test(lower)) {
    return "haiku";
  }

  // Default: Sonnet tier
  return "sonnet";
}

// The model's context window in tokens, for the live context meter: the
// provider registry's figure (contextTokensFor; an unknown Claude model counts
// as 1M, so the bar shows *something* rather than dividing by zero). The meter
// measures against the auto-compact window when that is smaller (180k by
// default, ai/context-limits.js): that is where the engine summarizes the
// older part, so a full bar means "about to be summarized", not 15% of 1M.
function contextWindowFor(provider, model) {
  let n = null;
  try { n = contextTokensFor(provider || "claude", model, settingsStore); } catch { n = null; }
  return effectiveContextWindow(n || 1_000_000);
}

// Sum the prompt-side fields of an Anthropic usage object — this is what
// counts against the context window. cache_read and cache_creation tokens
// are part of the prompt the model sees, so they fill the window even
// though they don't bill at the same rate as fresh input.
function promptTokensFromUsage(u) {
  if (!u) return 0;
  return (u.input_tokens || 0)
    + (u.cache_read_input_tokens || 0)
    + (u.cache_creation_input_tokens || 0);
}

// Threshold at which we proactively snapshot before the next turn might
// trip "prompt is too long". Conservative enough that even a long reply
// won't push us over. Applied after each completed turn.
const CONTEXT_AUTOSAVE_PCT = 95;

export const chatRouter = Router();

// Lazy-init stores (set by server.js via setDb)
let convStore = null;
let settingsStore = null;
let auditLog = null;

chatRouter.use((req, _res, next) => {
  if (!convStore) {
    convStore = new ConversationStore(req.app.get("db"));
    settingsStore = new SettingsStore(req.app.get("db"), req.app.get("auditLog"));
    auditLog = req.app.get("auditLog");
  }
  next();
});

/**
 * GET /api/chat/file?p=<path>[&dl=1]
 * A chat's file, to look at in the page or (dl=1) to save. Only files inside the workspace's uploads folder: what
 * the channels saved, the dashboard's uploads, and the copies kept of what the agent sent (lib/sent-files.js).
 */
chatRouter.get("/file", (req, res) => {
  const file = viewablePath(req.query.p);
  if (!file) return res.status(404).json({ error: "File not found" });
  sendViewable(res, file, { save: req.query.dl === "1" });
});

/**
 * GET /api/chat/commands
 * List available chat commands.
 */
chatRouter.get("/commands", (_req, res) => {
  res.json({ commands: getCommandList() });
});

/**
 * GET /api/chat/models
 * GET /api/chat/conversations/:id/picker
 * PUT /api/chat/conversations/:id/picker  { provider?, model?, effort? }
 * The composer's picker at the addresses the page has always used, served by
 * the same handlers as /api/models (routes/models.js): every AI that is ready,
 * with its models, and a chat's own AI, model and effort (null: the default).
 * A chat's next turn, on any channel, runs on its pick (ai/turn.js resolveTarget).
 */
chatRouter.get("/models", modelsHandlers.list);
chatRouter.get("/conversations/:id/picker", modelsHandlers.getPick);
chatRouter.put("/conversations/:id/picker", modelsHandlers.putPick);

/**
 * GET /api/chat/channels
 * List all channels (web, discord, telegram, slack) with their conversations.
 */
chatRouter.get("/channels", (req, res) => {
  const channelSettings = settingsStore.getByPrefix("channel_conv.");
  const channels = [];

  for (const { key, value: convId } of channelSettings) {
    const channelKey = key.replace("channel_conv.", "");
    const [platform] = channelKey.split(":");
    const conv = convStore.get(convId);
    if (!conv) continue;

    channels.push({
      key: channelKey,
      platform,
      title: conv.title || channelKey,
      conversationId: convId,
      updatedAt: conv.updated_at,
    });
  }

  // Sort by most recently active
  channels.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  res.json({ channels });
});

/**
 * GET /api/chat/conversations
 * List conversations (kept for backward compat).
 */
chatRouter.get("/conversations", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  res.json({ conversations: convStore.list(limit, offset) });
});

/**
 * GET /api/chat/search?q=keyword
 * Full-text search across all messages.
 */
chatRouter.get("/search", (req, res) => {
  const q = req.query.q;
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  if (!q || !q.trim()) return res.json({ results: [] });
  res.json({ results: convStore.search(q, limit) });
});

/**
 * POST /api/chat/conversations
 * Create a new conversation.
 */
chatRouter.post("/conversations", (req, res) => {
  const { title, provider, model, systemPrompt } = req.body || {};
  const conv = convStore.create({ title, provider, model, systemPrompt });
  res.status(201).json(conv);
});

/**
 * GET /api/chat/conversations/:id
 * Get conversation with messages.
 */
chatRouter.get("/conversations/:id", async (req, res) => {
  const conv = convStore.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });

  // Support ?limit=N and ?all=true for pagination
  const all = req.query.all === "true";
  const limit = all ? undefined : parseInt(req.query.limit, 10) || 50;
  const messages = limit ? convStore.getRecentMessages(req.params.id, limit) : convStore.getMessages(req.params.id);
  const totalMessages = convStore.messageCount ? convStore.messageCount(req.params.id) : messages.length;

  // Session recap — if the convo has been idle long enough, include a
  // short "last time we..." summary so the client can show a dismissible
  // card above the first message. Null if nothing stale enough.
  let recap = null;
  try {
    recap = await convStore.getSessionRecap(req.params.id, 30);
  } catch (err) {
    // Defensive — recap is optional, never block conversation load on it.
    console.warn("[chat] getSessionRecap failed:", err?.message);
  }

  // Slim payload: each reply's words plus a compact list of the tools it
  // used. A reply's tool inputs and outputs can run to megabytes, and a
  // device opening a long chat downloaded all of it; they are fetched one
  // reply at a time when someone opens its steps (route below). The live
  // timeline's position comes too, so the page follows on from exactly here.
  // ?raw=true returns the stored messages as they are.
  const out = req.query.raw === "true" ? messages : messages.map(slimMessage);
  // The chat's files, each in its place (lib/chat-files.js placeFiles): on the message it came with, on the agent's
  // reply for the files its turn sent, or as a row of its own after a message (filesAfter; leadFiles before them all).
  const { leadFiles } = placeFilesOnPage(req.params.id, out, { complete: out.length >= totalMessages });
  res.json({
    ...conv,
    messages: out,
    totalMessages,
    leadFiles,
    recap,
    liveSeq: latestSeq(req.params.id),
    activeTurn: activeTurnFor(req.params.id),
    deliveredClientIds: recentClientMsgIds(req.params.id),
  });
});

/**
 * GET /api/chat/conversations/:id/messages/:messageId/tools
 * The tools one reply used, with their input and output (redacted, capped):
 * what the chat shows when a step under "Used 12 tools" is opened. History
 * comes slim, so this is fetched per reply, only when someone looks.
 */
chatRouter.get("/conversations/:id/messages/:messageId/tools", (req, res) => {
  const row = req.app.get("db")
    .prepare("SELECT content FROM messages WHERE id = ? AND conversation_id = ? AND role = 'assistant'")
    .get(req.params.messageId, req.params.id);
  if (!row) return res.status(404).json({ error: "Message not found" });
  res.json({ tools: messageTools(row.content) });
});

/**
 * DELETE /api/chat/conversations/:id
 */
chatRouter.delete("/conversations/:id", (req, res) => {
  const convId = req.params.id;
  const deleted = convStore.delete(convId);
  if (!deleted) return res.status(404).json({ error: "Conversation not found" });
  forgetChatFiles(convId);   // (its files' rows; the copies are tidied with the uploads folder)

  // Clean up channel_conv mappings that pointed to this conversation
  try {
    const allSettings = settingsStore.getByPrefix("channel_conv.");
    for (const s of allSettings) {
      if (s.value === convId) {
        settingsStore.set(s.key, null);
      }
    }
  } catch { /* ignore cleanup errors */ }

  res.json({ ok: true });
});

/**
 * PATCH /api/chat/conversations/:id
 * Update conversation title or settings.
 */
chatRouter.patch("/conversations/:id", (req, res) => {
  const conv = convStore.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });

  const { title, provider, model, systemPrompt } = req.body || {};
  if (title) convStore.updateTitle(req.params.id, title.slice(0, LIMITS.MAX_CONVERSATION_TITLE));
  if (provider || model || systemPrompt !== undefined) {
    convStore.update(req.params.id, { provider, model, systemPrompt });
  }

  res.json(convStore.get(req.params.id));
});

/**
 * POST /api/chat/conversations/:id/reset-session
 * Clear the chat's session so the next message starts a fresh one, and note when
 * (session.<id>.clearedAt): the recent conversation a fresh session is handed
 * (ai/handoff.js) never brings back what came before the reset.
 */
chatRouter.post("/conversations/:id/reset-session", (req, res) => {
  const conv = convStore.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  convStore.setSessionHandle(req.params.id, null);
  settingsStore.set(`session.${req.params.id}.clearedAt`, new Date().toISOString());
  res.json({ ok: true });
});

// Store active AbortControllers per conversation for /stop
const activeRequests = new Map(); // convId → AbortController
// Bumped by /stop so web turns still waiting in the conversation's queue
// (lib/conversation-lock.js) know not to run.
const stopEpoch = new Map();  // convId -> number

/**
 * POST /api/chat/stop  { conversationId, turnId? }
 * Stop the current generation for a conversation, and anything sent from the
 * dashboard that is still waiting behind it.
 * With the turnId of a turn still waiting in the queue (the Stop on its
 * "Queued" line), that turn leaves the queue and nothing else changes; if it
 * began meanwhile, it is stopped as the running turn; if it already ended,
 * nothing happens.
 */
chatRouter.post("/stop", async (req, res) => {
  const { conversationId, turnId } = req.body || {};
  if (!conversationId || typeof conversationId !== "string") return res.json({ ok: true, stopped: false });
  if (typeof turnId === "string" && turnId) {
    if (removeQueuedTurn(turnId, conversationId)) return res.json({ ok: true, stopped: true, removed: true });
    if (activeTurnFor(conversationId)?.turnId !== turnId) return res.json({ ok: true, stopped: false });
  }
  // Only a conversation with turns running or waiting has anything to cancel,
  // so the map holds real chats, not every string ever posted here.
  if (queueDepth(conversationId) > 0) stopEpoch.set(conversationId, (stopEpoch.get(conversationId) || 0) + 1);
  let stopped = false;
  const controller = activeRequests.get(conversationId);
  if (controller) {
    controller.abort();
    activeRequests.delete(conversationId);
    stopped = true;
  }
  // A turn another channel started in this chat (Telegram, Discord, a cron's
  // run), which the dashboard shows at work too (ai/turn.js).
  if (stopTurns(conversationId) > 0) stopped = true;
  res.json({ ok: true, stopped });
});

/**
 * POST /api/chat/send
 * Send a message and stream AI response via SSE.
 *
 * Body: { conversationId, message, provider?, model? }
 */
chatRouter.post("/send", async (req, res) => {
  let { conversationId, channelKey, message, attachments, provider: reqProvider, model: reqModel, effort: reqEffort } = req.body || {};

  // Track activity for idle session reset
  trackActivity();

  // A file on its own is a valid message.
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (typeof message !== "string" || (!message.trim() && !hasAttachments)) {
    return res.status(400).json({ error: "Message is required" });
  }
  if (!message.trim()) {
    message = attachments.length === 1
      ? `(sent a file: ${String(attachments[0]?.name || attachments[0]?.type || "file").slice(0, 120)})`
      : `(sent ${attachments.length} files)`;
  }
  if (message.length > LIMITS.MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: "Message too long" });
  }

  // Resolve conversation from channelKey or conversationId
  let convId = conversationId;

  if (channelKey && !convId) {
    // Channel-based: resolve conversation from channel key (same pattern as Discord/Telegram/Slack bots)
    convId = settingsStore.get(`channel_conv.${channelKey}`);
    if (convId && !convStore.get(convId)) convId = null; // stale reference

    if (!convId) {
      // Auto-create conversation for this channel
      const conv = convStore.create({ title: channelKey === "web:default" ? "Web Chat" : channelKey });
      convId = conv.id;
      settingsStore.set(`channel_conv.${channelKey}`, convId);
    }
  }

  // Retry dedupe: a device that lost the response re-sends with the same
  // clientMsgId (the tab's own id for the message). If that message already
  // landed, don't save or run it twice.
  const clientMsgId = typeof req.body?.clientMsgId === "string" ? req.body.clientMsgId.slice(0, 64) : null;
  if (clientMsgId && convId && hasClientMsgId(convId, clientMsgId)) {
    return res.status(409).json({ duplicate: true, conversationId: convId });
  }

  // Check for commands. __PLAYBOOK__ sentinel responses get fed to the AI
  // as the user's turn instead of echoed; we keep the original /command
  // text as the user-visible message in the conversation so the chat
  // history doesn't show a wall of playbook prose.
  let aiPromptOverride = null;
  if (message.startsWith("/")) {
    const cmdResult = await processCommand(message, {
      settingsStore,
      convStore,
      conversationId: convId,
      channelManager: req.app.get("channelManager"),
      db: req.app.get("db"),
    });

    if (cmdResult.handled) {
      const playbook = extractPlaybookPrompt(cmdResult);
      if (playbook) {
        aiPromptOverride = playbook;
      } else {
        // /clear and /new wipe the conversation: tell every open device.
        if (convId && /^\/(clear|new)\b/i.test(message)) publish(convId, "cleared", {});
        return res.json({
          command: true,
          response: cmdResult.response,
          conversationId: convId || null,
        });
      }
    }
  }

  // Get or create conversation (fallback for non-channel requests)
  if (!convId) {
    const conv = convStore.create({ title: message.slice(0, 100) });
    convId = conv.id;
  } else {
    const conv = convStore.get(convId);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
  }

  // Which AI answers is the turn layer's to work out (ai/turn.js): the provider and model the request names, else
  // the chat's own pick, else the default AI. Auto-routing names a tier (opus, sonnet, haiku), which each AI maps
  // to a model of its own. A chat given a model of its own in the picker keeps it.
  const autoRoute = settingsStore.get("ai.autoRoute") === true && !settingsStore.get(`session.${convId}.model`);
  const routedTier = autoRoute && !reqModel ? classifyMessageModel(message) : null;
  const askedModel = reqModel || routedTier || undefined;
  const askedProvider = reqProvider || undefined;

  // Strip voice mode prefix before saving
  let cleanMessage = message.startsWith("[voice] ") ? message.slice(8) : message;

  // Per-message thinking effort prefix: "!think do this" or "!! do this"
  const thinkMatch = cleanMessage.match(/^(?:!think\s+|!!\s*)(.*)/s);
  if (thinkMatch) {
    cleanMessage = thinkMatch[1];
    if (!reqEffort) reqEffort = "max"; // !think = max effort for this message
  }

  // Refuse what cannot be sent BEFORE the message is saved: a saved message
  // carries the tab's clientMsgId, and a retry of one refused here would then
  // be answered "duplicate" and never run.
  if (Array.isArray(attachments) && attachments.length > 0) {
    // Defend against OOM: cap attachment count and per-attachment decoded size.
    if (attachments.length > 10) {
      return res.status(413).json({ error: "Too many attachments (max 10)" });
    }
    let totalBytes = 0;
    for (const att of attachments) {
      const b64 = typeof att?.data === "string" ? att.data : "";
      // Approximate decoded size from base64 length (each 4 chars → 3 bytes)
      const approxBytes = Math.floor((b64.length * 3) / 4);
      if (approxBytes > LIMITS.UPLOAD_MAX_BYTES) {
        return res.status(413).json({
          error: `Attachment too large (max ${LIMITS.UPLOAD_MAX_BYTES} bytes per file)`,
        });
      }
      totalBytes += approxBytes;
    }
    if (totalBytes > LIMITS.UPLOAD_MAX_BYTES * 2) {
      return res.status(413).json({ error: "Total attachment size too large" });
    }
  }

  // Save user message (text only — no base64 blobs in DB)
  const savedUser = convStore.addMessage(convId, { role: "user", content: cleanMessage, clientMsgId: clientMsgId || undefined });
  // A new web chat ("New chat", created under its channel key) is named after
  // its first message as soon as it is sent. Waiting for the reply was not
  // enough: a second message queued meanwhile pushed the count past the
  // first-exchange check below, and the chat stayed "New chat".
  if (channelKey && channelKey.startsWith("web:") && channelKey !== "web:default" && convStore.get(convId)?.title === channelKey) {
    convStore.updateTitle(convId, cleanMessage.slice(0, LIMITS.MAX_CONVERSATION_TITLE));
  }
  broadcastToOthers(convId, "user_message", { content: cleanMessage, conversationId: convId });

  // Build user content blocks for the AI when attachments are present.
  // aiPromptOverride (populated upstream if the user typed a __PLAYBOOK__
  // command like /checkpoint) wins over the literal message text — the
  // stored convStore entry above keeps the original "/checkpoint" so
  // history UI stays readable, but the AI sees the playbook body.
  let userContentForAI = aiPromptOverride || cleanMessage;
  if (Array.isArray(attachments) && attachments.length > 0) {
    // A copy of each file, kept with the chat on this message (lib/chat-files.js), so the dashboard's chat shows them
    // after a reload and on every device. The agent gets them as before (pictures, PDFs and sounds as themselves; any
    // other file from that copy on disk).
    let kept = [];
    try {
      const files = attachments
        .filter((a) => typeof a?.data === "string" && a.data)
        .map((a) => ({ name: a.name || a.type || "file", buffer: Buffer.from(a.data, "base64") }))
        .filter((f) => f.buffer.length);
      if (files.length === attachments.length) {
        kept = keepUploadedFiles(files);
        noteReceivedFiles({ conversationId: convId, messageId: savedUser?.id, files: kept, via: "web" });
      }
    } catch (err) {
      console.warn(`[chat] the files sent could not be kept with the chat: ${err.message}`);
      kept = [];
    }
    const contentBlocks = [];
    for (const [i, att] of attachments.entries()) {
      if (att.type === "image") {
        contentBlocks.push({
          type: "image",
          source: { type: "base64", media_type: att.mediaType || "image/png", data: att.data },
        });
      } else if (att.type === "audio") {
        // A voice note: the turn layer turns it into its transcript for every AI (ai/media.js)
        contentBlocks.push({
          type: "audio",
          source: { type: "base64", media_type: att.mediaType || "audio/wav", data: att.data },
        });
      } else if (att.type === "pdf" || att.mediaType === "application/pdf") {
        // PDF — as a document block: read natively where the model can, else its text goes in (ai/media.js)
        contentBlocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: att.data },
        });
      } else {
        // Generic file — on disk so the agent can read it (the copy kept with the chat, or one written now)
        try {
          let filePath = kept[i]?.path;
          if (!filePath) {
            const fs = await import("node:fs");
            const path = await import("node:path");
            const config = (await import("../config/env.js")).default;
            const uploadsDir = path.default.join(config.WORKSPACE_DIR, "uploads");
            fs.default.mkdirSync(uploadsDir, { recursive: true });
            const safeName = (att.name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
            filePath = path.default.join(uploadsDir, `${Date.now()}-${safeName}`);
            fs.default.writeFileSync(filePath, Buffer.from(att.data, "base64"));
          }
          contentBlocks.push({
            type: "text",
            text: `[Attached file saved: ${att.name || "file"} → ${filePath}]\nYou can read this file with the Read tool at: ${filePath}`,
          });
        } catch (err) {
          contentBlocks.push({
            type: "text",
            text: `[Attached file: ${att.name || "file"} (${att.mediaType || "application/octet-stream"}) — failed to save: ${err.message}]`,
          });
        }
      }
    }
    contentBlocks.push({ type: "text", text: message });
    userContentForAI = contentBlocks;
  }

  // Get conversation history for context
  const history = convStore.getRecentMessages(convId, 20);
  const conv = convStore.get(convId);

  // Start SSE stream
  initSSE(res);

  // Send conversation ID (useful when auto-created)
  sendSSE(res, "conversation", { id: convId });

  // Detect voice mode — the AI responds normally (tables, formatting, etc.)
  // The TTS pipeline strips non-speakable content before reading aloud.
  const isVoiceMode = message.startsWith("[voice]");
  const voiceHint = isVoiceMode
    ? "\n\n[VOICE MODE] Response shown visually AND read aloud. TTS limit: 2 short sentences max before any table/code. Tables are shown but NOT spoken. Structure: brief spoken intro (under 200 chars) → then table/details."
    : "";

  // Build the system prompt: identity + memory + skills + conversation-specific (stable), the day's log and the
  // other per-turn parts (volatile). Voice mode is this message's own, so it goes with the volatile part.
  const promptParts = buildSystemPromptParts({
    settingsStore,
    db: req.app.get("db"),
    channelManager: req.app.get("channelManager"),
    conversationId: convId,
    messageCount: history.length,
    conversationPrompt: conv?.system_prompt,
    channelHint: sendFileHint("web"),
  });
  const systemParts = { stable: promptParts.stable, volatile: promptParts.volatile + voiceHint };

  let fullResponse = "";
  let currentTextChunk = "";
  const timeline = []; // Track timeline for persistence: [{type:"text",text:""},{type:"tool",name:"",detail:"",input:"",output:"",status:"done"}]
  let lastToolIdx = -1;
  let usage = {};
  // dashboard: a file the agent hands over goes to this chat, whatever channel it is; messageId: the message answered
  const toolCtx = { db: req.app.get("db"), settingsStore, conversationId: convId, channelManager: req.app.get("channelManager"), dashboard: true, messageId: savedUser?.id || null };
  // Snapshot of `req.ip` — read once now, because once the socket closes
  // the `req.ip` getter pulls from a destroyed socket and may return
  // undefined. Audit log calls after `res.close` use this instead.
  const reqIp = req.ip;

  // Tool-call redaction toggle. Default ON: every tool input/output sent
  // to the timeline / DB / broadcast gets pattern-matched for secrets
  // (sk-..., AKIA..., DATABASE_URL=…, etc). Set `ui.redactSecrets = false`
  // in settings to expose values for debugging.
  const redactOn = settingsStore.get("ui.redactSecrets") !== false;
  const redactStr = redactOn ? redactSecrets : (s) => s;
  const redactObj = redactOn ? redactDeep : (v) => v;

  // Queue behind any turn already running in this conversation, from any
  // channel, instead of cancelling it (a message sent mid-reply used to
  // abort the reply). The user message is already saved and on the live
  // timeline, so every device shows it at once; the reply follows when the
  // turn ahead finishes. Socket close never cancels a turn, so a queued
  // message still runs even if the tab that sent it is gone.
  const epochAtEnqueue = stopEpoch.get(convId) || 0;
  const waitingBehind = queueDepth(convId) > 0;
  if (waitingBehind) sendSSE(res, "queued", { conversationId: convId });
  const waitBeat = waitingBehind
    ? setInterval(() => { if (!res.writableEnded) sendSSE(res, "heartbeat", { ts: Date.now(), queued: true }); }, 15_000)
    : null;
  // While it waits it shows as "Queued · after the reply above" on every device (lib/conversation-lock.js),
  // and becomes the working line when it begins; its own Stop takes it out of the queue alone.
  const endWaiting = () => {
    if (waitBeat) clearInterval(waitBeat);
    sendSSE(res, "done", { conversationId: convId, stopReason: "stopped" });
    if (!res.writableEnded) res.end();
  };
  const ran = await withConversationTurn(convId, async () => {
    if (waitBeat) clearInterval(waitBeat);
    if ((stopEpoch.get(convId) || 0) !== epochAtEnqueue) {
      // Stop was pressed while this message waited: don't run it.
      currentQueuedTurn()?.end("aborted");
      endWaiting();
      return;
    }
    const controller = new AbortController();
    activeRequests.set(convId, controller);
    // Tab freeze / OS sleep / Wi-Fi blip will close the SSE socket while
    // the model is still producing. Don't abort the generator on socket
    // close — let it run to completion so the assistant message persists
    // and every device keeps following it on the live timeline. Only
    // /stop and the idle watchdog below end a turn early.
    let clientDetached = false;
    res.on("close", () => {
      clientDetached = true;
    });

    // The AI this turn runs on, from the turn layer's route event (the backup model's, if it answered instead).
    let routed = null;

    // Heartbeat + idle watchdog. Emits a `heartbeat` SSE event every 15s
    // so proxies don't buffer the response to death (skipped once the
    // client detaches — there's no socket to feed). Idle abort still
    // fires if the engine produces no events for a long while — that's a
    // stuck-model guard, unrelated to the client connection.
    let lastEventAt = Date.now();
    const HEARTBEAT_MS = 15_000;
    // Idle abort: how long a turn may go with NO stream event before we give up.
    // Was a hard 3 minutes, which killed legitimate long research/tool turns.
    // Now configurable, but deliberately FINITE — the Mac build sets this to
    // ~2e9 (23 days), which is only safe there because its PTY pool has a
    // heartbeat + dead-socket detector. This build has neither, so an infinite
    // value would wedge a turn forever with no console to kill it from.
    const IDLE_ABORT_MS = Number(process.env.TARSEE_CHANNEL_IDLE_ABORT_MS) || 20 * 60_000;
    const hb = setInterval(() => {
      if (res.writableEnded || clientDetached) {
        if (Date.now() - lastEventAt > IDLE_ABORT_MS) {
          clearInterval(hb);
          try { controller.abort(); } catch {}
        }
        return;
      }
      sendSSE(res, "heartbeat", { ts: Date.now() });
      if (Date.now() - lastEventAt > IDLE_ABORT_MS) {
        clearInterval(hb);
        try { controller.abort(); } catch {}
        const minutes = Math.max(1, Math.round(IDLE_ABORT_MS / 60_000));
        sendSSE(res, "error", { message: `${routed?.label || "The AI"} stopped responding (${minutes} min idle). Try again.` });
        sendSSE(res, "done", { conversationId: convId });
        if (!res.writableEnded) res.end();
      }
    }, HEARTBEAT_MS);

    try {
      const existingSessionId = convStore.getSessionHandle(convId);
      // The chat's messages for the AI, with their times (the handoff to a new session leaves out what was cleared).
      const aiMessages = history.map((m) => {
        // Extract plain text from timeline JSON for AI context
        let content = m.content;
        if (content?.startsWith('{"__timeline":true')) {
          try { content = JSON.parse(content).text || content; } catch {}
        }
        // Strip invalid Unicode surrogates that break JSON
        if (typeof content === "string") content = content.replace(/[\uD800-\uDFFF]/g, "");
        return { role: m.role, content, createdAt: m.created_at };
      });
      if (userContentForAI !== message && aiMessages.length > 0) {
        const last = aiMessages[aiMessages.length - 1];
        if (last.role === "user") last.content = userContentForAI;
      }

      const stream = chatStream({
        provider: askedProvider,
        model: askedModel,
        // This message's own effort (!think, or the request's); the chat's own and the default are the turn layer's.
        effort: reqEffort || undefined,
        messages: aiMessages,
        systemParts,
        signal: controller.signal,
        sessionId: existingSessionId,
        onSessionId: (handle) => convStore.setSessionHandle(convId, handle),
        toolCtx,
        // Publish this turn to the live timeline (other devices watch it).
        liveConversationId: convId,
        liveSource: "web",
        // Summaries of its thinking for the live view, but not for voice mode: they make the first words
        // come about 3s later, and a spoken reply is waited for.
        thinkingSummaries: !/^\[voice\]/i.test(String(message || "")),
      });

      // How the turn layer said the turn ended (its one done): sent on in this request's own done, so the tab that
      // pressed Stop shows the reply as stopped, not finished.
      let endReason = null;
      // Loop prevention: a turn stuck repeating itself is stopped (lib/loop-guard.js).
      const loopGuard = createLoopGuard();
      const toolIdxById = new Map(); // tool_use id -> its index in `timeline`
      let overflowSaved = false;

      for await (const event of stream) {
        lastEventAt = Date.now();
        if (event.type === "route") {
          routed = event;
          // The composer shows the AI and model this turn runs on (auto-routing's pick, a backup that answered).
          sendSSE(res, "model_selected", {
            model: event.model,
            tier: tierOf(event.model) || routedTier || null,
            provider: event.provider,
            label: event.label,
            effort: event.effort || null,
            streaming: event.streaming,
            backup: !!event.backup,
          });
        } else if (event.type === "text") {
          fullResponse += event.content;
          currentTextChunk += event.content;
          sendSSE(res, "text", { content: event.content });
          broadcastToOthers(convId, "text", { content: event.content });
        } else if (event.type === "thinking") {
          sendSSE(res, "thinking", { status: event.status });
          broadcastToOthers(convId, "thinking", { status: event.status });
        } else if (event.type === "tool_use") {
          // Flush text to timeline
          if (currentTextChunk.trim()) {
            const last = timeline[timeline.length - 1];
            if (last?.type === "text") { last.text = currentTextChunk; }
            else { timeline.push({ type: "text", text: currentTextChunk }); }
          }
          currentTextChunk = "";
          const inp = event.input || {};
          let detail = "";
          let label = event.name;
          const isTodo = event.name === "TodoWrite" || event.name === "todowrite" || event.name === "todo_write";
          if (event.name === "Bash") detail = inp.command || "";
          else if (event.name === "Read") { detail = inp.file_path || ""; label = "Read"; }
          else if (event.name === "Write") { detail = inp.file_path || ""; label = "Write"; }
          else if (event.name === "Edit") { detail = inp.file_path || ""; label = "Edit"; }
          else if (isTodo) { label = "Update Todos"; detail = ""; }
          else detail = inp.command || inp.file_path || inp.url || inp.query || JSON.stringify(inp).slice(0, 80);
          // Pattern-redact secrets before they enter the timeline / SSE / WS
          // broadcast. Bash command lines and inline tool inputs are the
          // common leak vectors (e.g. `curl -H "Authorization: Bearer …"`).
          // TodoWrite items are user-authored content, not secrets — pass
          // through unchanged.
          detail = redactStr(String(detail));
          const safeInput = isTodo ? event.input : redactObj(event.input);
          lastToolIdx = timeline.length;
          if (event.id) toolIdxById.set(event.id, lastToolIdx);
          // summary: the step's one line in the chat (Bash's own description, a file's name), never the raw command.
          const timelineItem = { type: "tool", name: label, summary: redactStr(summarizeToolInput(event.name, inp)), detail: detail.slice(0, 200), input: detail.slice(0, 500), output: "", status: "running" };
          if (isTodo && Array.isArray(inp.todos)) timelineItem.todos = inp.todos;
          timeline.push(timelineItem);
          loopGuard.onCall(event.id, event.name, event.input);
          sendSSE(res, "tool_call", { id: event.id, name: event.name, input: safeInput });
          broadcastToOthers(convId, "tool_call", { id: event.id, name: event.name, input: safeInput });
          auditLog?.log({ action: "tool.call", target: event.name, actor: routed?.provider || "ai", ip: reqIp, detail: detail.slice(0, 200) });
        } else if (event.type === "tool_result") {
          // Redact stdout/stderr from tools before it goes anywhere user-
          // visible or persistent. Bash runs that print env vars, Read of
          // .env files, etc. — this is the highest-volume leak vector.
          const safeResult = redactStr(event.result || "");
          // Matched by the tool's id: tools can run side by side, so the
          // result is not always the last tool's.
          const idx = toolIdxById.has(event.id) ? toolIdxById.get(event.id) : lastToolIdx;
          if (idx >= 0 && timeline[idx]) {
            timeline[idx].status = event.ok === false ? "error" : "done";
            timeline[idx].output = safeResult.slice(0, 2000);
          }
          // Check for loops (the result's own error flag, on the call it answers) — abort if stuck
          loopGuard.onResult(event.id, event.ok);
          const loopReason = loopGuard.check();
          if (loopReason) {
            console.warn(`[loop-guard] Aborting: ${loopReason} (${loopGuard.count} total tool calls)`);
            sendSSE(res, "text", { content: `\n\n**Loop detected — stopped automatically.** (${loopReason})\n\nI was repeating the same failing operation. Let me know what you'd like me to try differently.` });
            fullResponse += `\n\n**Loop detected — stopped automatically.** (${loopReason})`;
            controller.abort();
            break;
          }

          const toolName = timeline[idx]?.name || event.name || "tool";
          sendSSE(res, "tool_result", { id: event.id, name: toolName, result: safeResult });
          broadcastToOthers(convId, "tool_result", { id: event.id, name: toolName, result: safeResult });
        } else if (event.type === "usage") {
          usage = { ...usage, ...event.usage };
        } else if (event.type === "error") {
          // The conversation outgrew the model's window: save a checkpoint so the next session can pick up from it.
          if (!overflowSaved && /prompt is too long|context_length_exceeded|input length|too many tokens/i.test(event.message || "")) {
            overflowSaved = true;
            try {
              const path = snapshotForContextOverflow(req.app.get("db"), settingsStore, "auto: overflow error");
              sendSSE(res, "context_overflow", { checkpointPath: path, message: event.message });
            } catch (e) {
              console.warn("[chat] overflow snapshot failed:", e?.message);
            }
          }
          sendSSE(res, "error", { message: event.message });
        } else if (event.type === "done") {
          endReason = event.stopReason || null;
          break;
        }
      }
      // Flush remaining text
      if (currentTextChunk.trim()) {
        const last = timeline[timeline.length - 1];
        if (last?.type === "text") { last.text = currentTextChunk; }
        else { timeline.push({ type: "text", text: currentTextChunk }); }
      }

      const provider = routed?.provider || null;
      const model = routed?.model || null;
      if (fullResponse || timeline.some(t => t.type === "tool")) {
        fullResponse = fullResponse ? extractAndSaveMemories(fullResponse, req.app.get("db"), convId) : "";
        // Save with timeline metadata if tools were used
        const hasTools = timeline.some(t => t.type === "tool");
        const content = hasTools
          ? JSON.stringify({ __timeline: true, items: timeline, text: fullResponse })
          : fullResponse;
        convStore.addMessage(convId, {
          role: "assistant",
          content,
          provider,
          model,
          tokensIn: (usage.input_tokens || 0)
          + (usage.cache_read_input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0) || null,
          tokensOut: usage.output_tokens,
        });
      }
      if (convStore.messageCount(convId) <= 2) {
        convStore.updateTitle(convId, message.slice(0, LIMITS.MAX_CONVERSATION_TITLE));
      }
      const contextTokens = contextWindowFor(provider, model);
      const promptTokens = promptTokensFromUsage(usage);
      const pct = contextTokens ? (promptTokens / contextTokens) * 100 : 0;
      let checkpointed = false;
      if (pct >= CONTEXT_AUTOSAVE_PCT) {
        try {
          const path = snapshotForContextOverflow(req.app.get("db"), settingsStore, `auto: ${Math.round(pct)}% threshold`);
          checkpointed = !!path;
        } catch (e) {
          console.warn("[chat] threshold snapshot failed:", e?.message);
        }
      }
      // "stopped" is the page's word for a turn Stop ended (a queued turn taken out of the queue says it too).
      const stopReason = endReason === "aborted" ? "stopped" : endReason;
      sendSSE(res, "done", { conversationId: convId, usage, model, provider, contextTokens, checkpointed, stopReason });
      broadcastToOthers(convId, "done", { conversationId: convId, stopReason });
    } catch (err) {
      if (!controller.signal.aborted) {
        sendSSE(res, "error", { message: err.message });
      }
    } finally {
      clearInterval(hb);
      if (activeRequests.get(convId) === controller) {
        activeRequests.delete(convId);
      }
      if (!res.writableEnded) res.end();
    }
  }, {
    live: {
      source: "web",
      prompt: message,
      model: askedModel || null,
      // Its Stop took it out of the queue: this request is done now, not when the turn ahead ends.
      onRemoved: endWaiting,
    },
  });
  if (ran === QUEUE_REMOVED && !res.writableEnded) endWaiting();
});
