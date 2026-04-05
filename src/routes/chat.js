import { Router } from "express";
import { chatStream, getAvailableProviders } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { initSSE, sendSSE } from "../lib/stream-utils.js";
import { LIMITS } from "../config/constants.js";
import { processCommand, getCommandList } from "../lib/commands.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { trackActivity } from "../lib/session-reset.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";

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
  res.json({ providers: getAvailableProviders() });
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
 * POST /api/chat/conversations/:id/reset-session
 * Clear the Claude Code session ID so the next message starts a fresh session.
 */
chatRouter.post("/conversations/:id/reset-session", (req, res) => {
  const conv = convStore.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  convStore.setClaudeSessionId(req.params.id, null);
  res.json({ ok: true });
});

/**
 * POST /api/chat/send
 * Send a message and stream AI response via SSE.
 *
 * Body: { conversationId, message, provider?, model? }
 */
chatRouter.post("/send", async (req, res) => {
  const { conversationId, channelKey, message, attachments, provider: reqProvider, model: reqModel } = req.body || {};

  // Track activity for idle session reset
  trackActivity();

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

  if (!providerId || !activeProvider?.ready) {
    return res.status(400).json({ error: "No AI provider configured. Go to Settings to configure one." });
  }

  // Save user message (text only — no base64 blobs in DB)
  convStore.addMessage(convId, { role: "user", content: message });

  // Build user content blocks for the AI when attachments are present
  let userContentForAI = message;
  if (Array.isArray(attachments) && attachments.length > 0) {
    const contentBlocks = [];
    for (const att of attachments) {
      if (att.type === "image") {
        contentBlocks.push({
          type: "image",
          source: { type: "base64", media_type: att.mediaType || "image/png", data: att.data },
        });
      } else if (att.type === "audio") {
        // Pass audio as a document-style block (provider will adapt)
        contentBlocks.push({
          type: "audio",
          source: { type: "base64", media_type: att.mediaType || "audio/wav", data: att.data },
        });
      } else {
        // Generic file — include as text description for now
        contentBlocks.push({
          type: "text",
          text: `[Attached file: ${att.name || "file"} (${att.mediaType || "application/octet-stream"})]`,
        });
      }
    }
    contentBlocks.push({ type: "text", text: message });
    userContentForAI = contentBlocks;
  }

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
  const tools = getToolDefinitions();
  const toolCtx = { db: req.app.get("db"), settingsStore, conversationId: convId, channelManager: req.app.get("channelManager") };
  const MAX_TOOL_ROUNDS = 15;

  // --- Claude Code provider: runs its own agentic loop ---
  if (providerId === "claude-code") {
    try {
      const existingSessionId = convStore.getClaudeSessionId(convId);
      const mod = await import("../ai/providers/claude-code.js");
      const stream = mod.chat({
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        model,
        systemPrompt: effectiveSystemPrompt,
        signal: req.signal,
        sessionId: existingSessionId,
        onSessionId: (sid) => convStore.setClaudeSessionId(convId, sid),
        toolCtx,
      });

      for await (const event of stream) {
        if (event.type === "text") {
          fullResponse += event.content;
          sendSSE(res, "text", { content: event.content });
        } else if (event.type === "tool_use") {
          sendSSE(res, "tool_call", { id: event.id, name: event.name, input: event.input });
        } else if (event.type === "tool_result") {
          sendSSE(res, "tool_result", { id: event.id, name: event.name, result: event.result });
        } else if (event.type === "usage") {
          usage = { ...usage, ...event.usage };
        } else if (event.type === "error") {
          sendSSE(res, "error", { message: event.message });
        } else if (event.type === "done") {
          break;
        }
      }

      if (fullResponse) {
        fullResponse = extractAndSaveMemories(fullResponse, req.app.get("db"), convId);
        convStore.addMessage(convId, {
          role: "assistant",
          content: fullResponse,
          provider: providerId,
          model,
          tokensIn: usage.input_tokens,
          tokensOut: usage.output_tokens,
        });
      }
      if (convStore.messageCount(convId) <= 2) {
        convStore.updateTitle(convId, message.slice(0, LIMITS.MAX_CONVERSATION_TITLE));
      }
      sendSSE(res, "done", { conversationId: convId, usage });
    } catch (err) {
      sendSSE(res, "error", { message: err.message });
    }
    res.end();
    return;
  }

  try {
    // Build the working message array (may grow with tool results)
    // Replace the last user message content with the attachment-enriched version
    let workingMessages = history.map((m) => ({ role: m.role, content: m.content }));
    if (workingMessages.length > 0 && workingMessages[workingMessages.length - 1].role === "user") {
      workingMessages[workingMessages.length - 1].content = userContentForAI;
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const toolCalls = [];
      let roundText = "";
      let stopReason = "end_turn";

      const stream = chatStream({
        provider: providerId,
        model,
        apiKey,
        baseUrl: activeProvider?.baseUrl,
        messages: workingMessages,
        systemPrompt: effectiveSystemPrompt,
        signal: req.signal,
        tools,
      });

      for await (const event of stream) {
        if (event.type === "text") {
          roundText += event.content;
          fullResponse += event.content;
          sendSSE(res, "text", { content: event.content });
        } else if (event.type === "tool_use") {
          toolCalls.push({ id: event.id, name: event.name, input: event.input });
          // Notify client about tool call
          sendSSE(res, "tool_call", { id: event.id, name: event.name, input: event.input });
        } else if (event.type === "usage") {
          usage = { ...usage, ...event.usage };
        } else if (event.type === "done") {
          stopReason = event.stopReason || "end_turn";
          break;
        }
      }

      // If no tool calls, we're done
      if (toolCalls.length === 0 || stopReason !== "tool_use") break;

      // Build the assistant message with text + tool_use blocks
      const assistantContent = [];
      if (roundText) assistantContent.push({ type: "text", text: roundText });
      for (const tc of toolCalls) {
        assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      workingMessages.push({ role: "assistant", content: assistantContent });

      // Execute each tool and build tool_result blocks
      const toolResults = [];
      for (const tc of toolCalls) {
        console.log(`[tools] executing: ${tc.name}(${JSON.stringify(tc.input).slice(0, 100)})`);
        const result = await executeTool(tc.name, tc.input, toolCtx);
        toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
        // Notify client about tool result
        sendSSE(res, "tool_result", { id: tc.id, name: tc.name, result: result.slice(0, 500) });
      }
      workingMessages.push({ role: "user", content: toolResults });
    }

    // Extract [REMEMBER: ...] markers and auto-save memories
    if (fullResponse) {
      fullResponse = extractAndSaveMemories(fullResponse, req.app.get("db"), convId);
    }

    // Save assistant message (with markers stripped)
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
