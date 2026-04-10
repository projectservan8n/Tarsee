import { Router } from "express";
import { ConversationStore } from "../db/conversations.js";
import { chatStream } from "../ai/router.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { SettingsStore } from "../db/settings.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";

export const externalApiRouter = Router();

let convStore = null;
let settingsStore = null;

externalApiRouter.use((req, _res, next) => {
  if (!convStore) {
    convStore = new ConversationStore(req.app.get("db"));
    settingsStore = new SettingsStore(req.app.get("db"), req.app.get("auditLog"));
  }
  next();
});

/**
 * POST /api/v1/message
 * Simple REST API for sending a message and getting a response.
 * Auth: Bearer token (API token from login).
 * Body: { message: string, conversationId?: string }
 * Returns: { response: string, conversationId: string }
 */
externalApiRouter.post("/message", async (req, res) => {
  const { message, conversationId: reqConvId } = req.body || {};

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    // Get or create conversation
    let convId = reqConvId;
    if (!convId) {
      const conv = convStore.create({ title: message.slice(0, 50) });
      convId = conv.id;
    }

    // Save user message
    convStore.addMessage(convId, { role: "user", content: message });

    // Get context
    const messages = convStore.getRecentMessages(convId, 20);
    const history = messages.map(m => ({ role: m.role, content: m.content }));

    const model = settingsStore?.get("ai.claude-code.model") || "claude-sonnet-4-6";
    const systemPrompt = await buildSystemPrompt(req.app, convId);
    const toolDefs = getToolDefinitions(req.app);
    const toolCtx = { app: req.app, conversationId: convId };

    // Stream and collect response
    let fullText = "";
    for await (const event of chatStream({
      provider: "claude-code",
      model,
      messages: history,
      systemPrompt,
      tools: toolDefs,
      executeTool: (name, input) => executeTool(name, input, toolCtx),
      conversationId: convId,
      claudeSessionId: convStore.getClaudeSessionId(convId),
    })) {
      if (event.type === "text") fullText += event.content;
      else if (event.type === "session_id") convStore.setClaudeSessionId(convId, event.sessionId);
    }

    // Save assistant message
    convStore.addMessage(convId, { role: "assistant", content: fullText, model });

    res.json({ response: fullText, conversationId: convId });
  } catch (err) {
    console.error("[api/v1] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/conversations
 * List recent conversations.
 */
externalApiRouter.get("/conversations", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  res.json({ conversations: convStore.list(limit, 0) });
});

/**
 * GET /api/v1/conversations/:id/messages
 * Get messages for a conversation.
 */
externalApiRouter.get("/conversations/:id/messages", (req, res) => {
  const messages = convStore.getMessages(req.params.id);
  res.json({ messages });
});

/**
 * GET /api/v1/status
 * Quick health check with basic stats.
 */
externalApiRouter.get("/status", (req, res) => {
  const db = req.app.get("db");
  const msgCount = db.prepare("SELECT COUNT(*) as c FROM messages").get().c;
  const convCount = db.prepare("SELECT COUNT(*) as c FROM conversations").get().c;
  res.json({
    ok: true,
    uptime: process.uptime(),
    conversations: convCount,
    messages: msgCount,
  });
});
