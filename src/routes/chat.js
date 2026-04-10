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
import { getGatewayManager } from "../lib/gateway.js";

/**
 * Broadcast an SSE-like event to all WebSocket clients except the originating one.
 * This enables cross-device realtime sync — your Mac sees what your PC is streaming.
 */
function broadcastToOthers(convId, eventType, data) {
  const gw = getGatewayManager();
  const msg = JSON.stringify({ type: "sync", convId, event: eventType, data });
  for (const [, conn] of gw.connections) {
    if (conn.ws?.readyState === 1) {
      try { conn.ws.send(msg); } catch { /* ignore */ }
    }
  }
}

/**
 * Classify message complexity for auto model routing.
 * Heuristic only — no AI calls.
 */
function classifyMessageModel(message) {
  const words = message.split(/\s+/).length;
  const lower = message.toLowerCase();

  // Opus signals: code, analysis, complex tasks
  const opusKeywords = ["debug", "fix", "implement", "refactor", "architect", "design pattern",
    "analyze", "complex", "explain how", "write a", "build", "create a", "deploy",
    "optimize", "migrate", "security", "performance", "!think", "!!"];
  const hasCode = message.includes("```") || /\b(function|const|import|class|def|async|await)\s/.test(message);
  if (hasCode || opusKeywords.some((k) => lower.includes(k))) return "claude-opus-4-6";

  // Haiku signals: short, simple
  if (words <= 12 && /^(hi|hello|hey|yes|no|ok|thanks|sure|yep|nah|what is|who is|when is|where is|how much|how many)/i.test(lower)) {
    return "claude-haiku-4-5";
  }

  // Default: Sonnet
  return "claude-sonnet-4-6";
}

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
chatRouter.get("/conversations/:id", (req, res) => {
  const conv = convStore.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });

  // Support ?limit=N and ?all=true for pagination
  const all = req.query.all === "true";
  const limit = all ? undefined : parseInt(req.query.limit, 10) || 50;
  const messages = limit ? convStore.getRecentMessages(req.params.id, limit) : convStore.getMessages(req.params.id);
  const totalMessages = convStore.messageCount ? convStore.messageCount(req.params.id) : messages.length;
  res.json({ ...conv, messages, totalMessages });
});

/**
 * DELETE /api/chat/conversations/:id
 */
chatRouter.delete("/conversations/:id", (req, res) => {
  const convId = req.params.id;
  const deleted = convStore.delete(convId);
  if (!deleted) return res.status(404).json({ error: "Conversation not found" });

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
 * Clear the Claude Code session ID so the next message starts a fresh session.
 */
chatRouter.post("/conversations/:id/reset-session", (req, res) => {
  const conv = convStore.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  convStore.setClaudeSessionId(req.params.id, null);
  res.json({ ok: true });
});

// Store active AbortControllers per conversation for /stop
const activeRequests = new Map(); // convId → AbortController

/**
 * POST /api/chat/stop
 * Stop the current generation for a conversation.
 */
chatRouter.post("/stop", (req, res) => {
  const { conversationId } = req.body || {};
  const controller = activeRequests.get(conversationId);
  if (controller) {
    controller.abort();
    activeRequests.delete(conversationId);
    return res.json({ ok: true, stopped: true });
  }
  res.json({ ok: true, stopped: false });
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
      // Playbook: send steps to AI instead of displaying as command response
      if (cmdResult.response?.startsWith("__PLAYBOOK__")) {
        // Override the message with the playbook prompt, fall through to AI
        req.body.message = cmdResult.response.replace("__PLAYBOOK__\n", "");
        message = req.body.message;
      } else {
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

  // Resolve provider
  const activeProvider = settingsStore.getActiveProvider();
  const providerId = reqProvider || activeProvider?.provider;
  let model = reqModel || activeProvider?.model;
  const apiKey = activeProvider?.apiKey;

  // Auto model routing — classify message complexity
  const autoRoute = settingsStore.get("ai.autoRoute") === true;
  if (autoRoute && !reqModel) {
    model = classifyMessageModel(message);
  }

  if (!providerId || !activeProvider?.ready) {
    return res.status(400).json({ error: "No AI provider configured. Go to Settings to configure one." });
  }

  // Strip voice mode prefix before saving
  let cleanMessage = message.startsWith("[voice] ") ? message.slice(8) : message;

  // Per-message thinking effort prefix: "!think do this" or "!! do this"
  const thinkMatch = cleanMessage.match(/^(?:!think\s+|!!\s*)(.*)/s);
  if (thinkMatch) {
    cleanMessage = thinkMatch[1];
    if (!reqEffort) reqEffort = "max"; // !think = max effort for this message
  }

  // Save user message (text only — no base64 blobs in DB)
  convStore.addMessage(convId, { role: "user", content: cleanMessage });
  broadcastToOthers(convId, "user_message", { content: cleanMessage, conversationId: convId });

  // Build user content blocks for the AI when attachments are present
  let userContentForAI = cleanMessage;
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
      } else if (att.type === "pdf" || att.mediaType === "application/pdf") {
        // PDF — pass as document block (Anthropic API supports this natively)
        contentBlocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: att.data },
        });
      } else {
        // Generic file — save to disk so Claude can Read it
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const config = (await import("../config/env.js")).default;
          const uploadsDir = path.default.join(config.WORKSPACE_DIR, "uploads");
          fs.default.mkdirSync(uploadsDir, { recursive: true });
          const safeName = (att.name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
          const filePath = path.default.join(uploadsDir, `${Date.now()}-${safeName}`);
          fs.default.writeFileSync(filePath, Buffer.from(att.data, "base64"));
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

  // Tell frontend which model was selected (useful for auto-routing)
  if (autoRoute && !reqModel) {
    sendSSE(res, "model_selected", { model });
  }

  // Detect voice mode — Claude responds normally (tables, formatting, etc.)
  // The TTS pipeline strips non-speakable content before reading aloud.
  const isVoiceMode = message.startsWith("[voice]");
  const voiceHint = isVoiceMode
    ? "\n\n[VOICE MODE] Response shown visually AND read aloud. TTS limit: 2 short sentences max before any table/code. Tables are shown but NOT spoken. Structure: brief spoken intro (under 200 chars) → then table/details."
    : "";

  // Build effective system prompt: identity + memory + skills + conversation-specific
  const effectiveSystemPrompt = buildSystemPrompt({
    settingsStore,
    db: req.app.get("db"),
    conversationId: convId,
    messageCount: history.length,
    conversationPrompt: conv?.system_prompt,
  }) + voiceHint;

  let fullResponse = "";
  let currentTextChunk = "";
  const timeline = []; // Track timeline for persistence: [{type:"text",text:""},{type:"tool",name:"",detail:"",input:"",output:"",status:"done"}]
  let lastToolIdx = -1;
  let usage = {};
  const tools = getToolDefinitions();
  const toolCtx = { db: req.app.get("db"), settingsStore, conversationId: convId, channelManager: req.app.get("channelManager") };
  const MAX_TOOL_ROUNDS = 15;

  // --- Claude Code provider: runs its own agentic loop ---
  if (providerId === "claude-code") {
    const controller = new AbortController();
    activeRequests.set(convId, controller);
    // Abort if client disconnects the SSE stream
    res.on("close", () => { if (!res.writableEnded) { controller.abort(); } activeRequests.delete(convId); });

    try {
      const existingSessionId = convStore.getClaudeSessionId(convId);
      const mod = await import("../ai/providers/claude-code.js");
      // Build messages with image blocks for the last user message
      const ccMessages = history.map((m) => {
        // Extract plain text from timeline JSON for AI context
        let content = m.content;
        if (content?.startsWith('{"__timeline":true')) {
          try { content = JSON.parse(content).text || content; } catch {}
        }
        return { role: m.role, content };
      });
      if (userContentForAI !== message && ccMessages.length > 0) {
        const last = ccMessages[ccMessages.length - 1];
        if (last.role === "user") last.content = userContentForAI;
      }
      // Resolve effort: per-request > session setting > default
      const effort = reqEffort || settingsStore.get(`session.${convId}.effort`) || undefined;

      const stream = mod.chat({
        messages: ccMessages,
        model,
        systemPrompt: effectiveSystemPrompt,
        signal: controller.signal,
        sessionId: existingSessionId,
        onSessionId: (sid) => convStore.setClaudeSessionId(convId, sid),
        toolCtx,
        effort,
      });

      for await (const event of stream) {
        if (event.type === "text") {
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
          if (event.name === "Bash") detail = inp.command || "";
          else if (event.name === "Read") { detail = inp.file_path || ""; label = "Read"; }
          else if (event.name === "Write") { detail = inp.file_path || ""; label = "Write"; }
          else if (event.name === "Edit") { detail = inp.file_path || ""; label = "Edit"; }
          else if (event.name === "TodoWrite") { label = "Update Todos"; detail = ""; }
          else detail = inp.command || inp.file_path || inp.url || inp.query || JSON.stringify(inp).slice(0, 80);
          lastToolIdx = timeline.length;
          const timelineItem = { type: "tool", name: label, detail: String(detail).slice(0, 200), input: String(detail).slice(0, 500), output: "", status: "running" };
          if (event.name === "TodoWrite" && Array.isArray(inp.todos)) timelineItem.todos = inp.todos;
          timeline.push(timelineItem);
          sendSSE(res, "tool_call", { id: event.id, name: event.name, input: event.input });
          broadcastToOthers(convId, "tool_call", { id: event.id, name: event.name, input: event.input });
          auditLog?.log({ action: "tool.call", target: event.name, actor: "claude", ip: req.ip, detail: String(detail).slice(0, 200) });
        } else if (event.type === "tool_result") {
          if (lastToolIdx >= 0 && timeline[lastToolIdx]) {
            timeline[lastToolIdx].status = "done";
            timeline[lastToolIdx].output = (event.result || "").slice(0, 2000);
          }
          sendSSE(res, "tool_result", { id: event.id, name: event.name, result: event.result });
          broadcastToOthers(convId, "tool_result", { id: event.id, name: event.name, result: event.result });
        } else if (event.type === "usage") {
          usage = { ...usage, ...event.usage };
        } else if (event.type === "error") {
          sendSSE(res, "error", { message: event.message });
        } else if (event.type === "done") {
          break;
        }
      }
      // Flush remaining text
      if (currentTextChunk.trim()) {
        const last = timeline[timeline.length - 1];
        if (last?.type === "text") { last.text = currentTextChunk; }
        else { timeline.push({ type: "text", text: currentTextChunk }); }
      }

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
      broadcastToOthers(convId, "done", { conversationId: convId });
    } catch (err) {
      if (!controller.signal.aborted) {
        sendSSE(res, "error", { message: err.message });
      }
    }
    activeRequests.delete(convId);
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
        } else if (event.type === "thinking") {
          sendSSE(res, "thinking", { status: event.status });
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
