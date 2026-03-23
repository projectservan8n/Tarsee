import { Router } from "express";
import { chatStream, getAvailableProviders } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { initSSE, sendSSE } from "../lib/stream-utils.js";
import { LIMITS } from "../config/constants.js";
import { processCommand, getCommandList } from "../lib/commands.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";

export const chatRouter = Router();

// Lazy-init stores (set by server.js via setDb)
let convStore = null;
let settingsStore = null;

chatRouter.use((req, _res, next) => {
  if (!convStore) {
    convStore = new ConversationStore(req.app.get("db"));
    settingsStore = new SettingsStore(req.app.get("db"), req.app.get("auditLog"));
  }
  next();
});

/**
 * GET /api/chat/providers
 * List available AI providers.
 */
chatRouter.get("/providers", (_req, res) => {
  res.json({ providers: getAvailableProviders(settingsStore) });
});

/**
 * GET /api/chat/commands
 * List available chat commands.
 */
chatRouter.get("/commands", (_req, res) => {
  res.json({ commands: getCommandList() });
});

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
chatRouter.get("/conversations/:id", (req, res) => {
  const conv = convStore.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });

  const messages = convStore.getMessages(req.params.id);
  res.json({ ...conv, messages });
});

/**
 * DELETE /api/chat/conversations/:id
 */
chatRouter.delete("/conversations/:id", (req, res) => {
  const deleted = convStore.delete(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Conversation not found" });
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
 * POST /api/chat/send
 * Send a message and stream AI response via SSE.
 *
 * Body: { conversationId, message, provider?, model? }
 */
chatRouter.post("/send", async (req, res) => {
  const { conversationId, channelKey, message, provider: reqProvider, model: reqModel } = req.body || {};

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Message is required" });
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

  // Check for commands
  if (message.startsWith("/")) {
    const cmdResult = await processCommand(message, {
      settingsStore,
      convStore,
      conversationId: convId,
      channelManager: req.app.get("channelManager"),
      db: req.app.get("db"),
    });

    if (cmdResult.handled) {
      return res.json({
        command: true,
        response: cmdResult.response,
        conversationId: convId || null,
      });
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

  // Resolve provider
  const activeProvider = settingsStore.getActiveProvider();
  const providerId = reqProvider || activeProvider?.provider;
  const model = reqModel || activeProvider?.model;
  const apiKey = activeProvider?.apiKey;

  if (!providerId || !apiKey) {
    return res.status(400).json({ error: "No AI provider configured. Go to Settings to configure one." });
  }

  // Save user message
  convStore.addMessage(convId, { role: "user", content: message });

  // Get conversation history for context
  const history = convStore.getRecentMessages(convId, 50);
  const conv = convStore.get(convId);

  // Start SSE stream
  initSSE(res);

  // Send conversation ID (useful when auto-created)
  sendSSE(res, "conversation", { id: convId });

  // Build effective system prompt: identity + memory + skills + conversation-specific
  const effectiveSystemPrompt = buildSystemPrompt({
    settingsStore,
    db: req.app.get("db"),
    conversationId: convId,
    messageCount: history.length,
    conversationPrompt: conv?.system_prompt,
  });

  let fullResponse = "";
  let usage = {};

  try {
    const stream = chatStream({
      provider: providerId,
      model,
      apiKey,
      baseUrl: activeProvider?.baseUrl,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      systemPrompt: effectiveSystemPrompt,
      signal: req.signal,
    });

    for await (const event of stream) {
      if (event.type === "text") {
        fullResponse += event.content;
        sendSSE(res, "text", { content: event.content });
      } else if (event.type === "usage") {
        usage = event.usage;
      } else if (event.type === "done") {
        break;
      }
    }

    // Save assistant message
    if (fullResponse) {
      convStore.addMessage(convId, {
        role: "assistant",
        content: fullResponse,
        provider: providerId,
        model,
        tokensIn: usage.input_tokens,
        tokensOut: usage.output_tokens,
      });
    }

    // Auto-title if this is the first exchange
    if (convStore.messageCount(convId) <= 2) {
      const title = message.slice(0, LIMITS.MAX_CONVERSATION_TITLE);
      convStore.updateTitle(convId, title);
    }

    sendSSE(res, "done", { conversationId: convId, usage });
  } catch (err) {
    sendSSE(res, "error", { message: err.message });
  }

  res.end();
});
