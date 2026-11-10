import { Router } from "express";
import { ConversationStore } from "../db/conversations.js";
import { chatStream } from "../ai/router.js";
import { buildSystemPromptParts } from "../lib/build-system-prompt.js";
import { SettingsStore } from "../db/settings.js";
import { withConversationTurn, QUEUE_REMOVED } from "../lib/conversation-lock.js";
import { getProvider, isShipped, normalizeProviderId } from "../ai/provider-registry.js";
import { parseModelRef } from "../ai/model-ref.js";
import { watchTurn } from "../lib/turn-watchdog.js";
import { idleNote } from "../channels/turn-notes.js";

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
 * Body: { message: string, conversationId?: string, provider?: string, model?: string }
 *   provider  which AI answers (claude, anthropic, chatgpt, openai, openrouter, deepseek, local); default: the
 *             conversation's own pick, else the default AI
 *   model     a model of that AI, or a ref naming both ("deepseek:deepseek-flash", "openrouter:anthropic/claude-x")
 * Returns: { response, conversationId, provider, model }; when the AI couldn't answer (not set up, a sign-in that
 * ran out, a spending limit) 502 with { error, stopReason, conversationId, provider, model, response }.
 */
externalApiRouter.post("/message", async (req, res) => {
  const { message, conversationId: reqConvId, provider: reqProvider, model: reqModel } = req.body || {};

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }
  // The AI asked for, if any: one Tarsee knows and can use, and a model ref that agrees with it.
  let provider;
  if (reqProvider != null && reqProvider !== "") {
    provider = typeof reqProvider === "string" ? normalizeProviderId(reqProvider) : null;
    if (!provider) return res.status(400).json({ error: `Unknown AI provider ${JSON.stringify(reqProvider)}` });
    if (!isShipped(provider)) return res.status(400).json({ error: `This Tarsee can't use the ${getProvider(provider).label}` });
  }
  let model;
  if (reqModel != null && reqModel !== "") {
    if (typeof reqModel !== "string" || reqModel.length > 300) return res.status(400).json({ error: "model must be a model name or a provider:model ref" });
    const ref = parseModelRef(reqModel);
    if (ref.provider && provider && ref.provider !== provider) {
      return res.status(400).json({ error: `model ${JSON.stringify(reqModel)} belongs to ${ref.provider}, not ${provider}` });
    }
    if (ref.provider && !isShipped(ref.provider)) return res.status(400).json({ error: `This Tarsee can't use the ${getProvider(ref.provider).label}` });
    model = reqModel.trim();
  }

  try {
    // Get or create conversation
    let convId = reqConvId;
    if (convId && !convStore.get(convId)) return res.status(404).json({ error: "Conversation not found" });
    if (!convId) {
      const conv = convStore.create({ title: message.slice(0, 50) });
      convId = conv.id;
    }

    // Save user message
    convStore.addMessage(convId, { role: "user", content: message });

    // Get context (with each message's time: a fresh session is handed the recent conversation, ai/handoff.js)
    const messages = convStore.getRecentMessages(convId, 20);
    const history = messages.map((m) => ({ role: m.role, content: m.content, createdAt: m.created_at }));

    const store = req.app.get("settingsStore") || settingsStore;
    // buildSystemPromptParts takes a destructured options object, not (app, convId).
    // Passing req.app as the first arg means settingsStore + db come back
    // undefined and the MemoryStore constructor crashes with "Cannot read
    // properties of undefined (reading 'prepare')". executeTool expects the
    // real handles in toolCtx — not an { app } wrapper it never unwraps.
    const systemParts = buildSystemPromptParts({
      settingsStore: store,
      db: req.app.get("db"),
      conversationId: convId,
      channelManager: req.app.get("channelManager"),
      messageCount: history.length,
    });
    const toolCtx = {
      db: req.app.get("db"),
      settingsStore: store,
      channelManager: req.app.get("channelManager"),
      conversationId: convId,
    };

    // Stream and collect response. One turn per conversation at a time, like
    // every channel (lib/conversation-lock.js): two resumes of one session at
    // once corrupt it.
    let fullText = "";
    let error = null;
    let stopReason = null;
    let ran = { provider: null, model: null };
    let route = null;
    // A turn that goes quiet is stopped (lib/turn-watchdog.js), so the conversation's lock is let go. The idle clock
    // starts when the turn does, not while it waits behind another turn in this conversation. A caller that goes away
    // (a client or proxy timeout, a Shortcut sent to the background) doesn't stop it: like a web chat turn it runs to
    // the end, waiting its turn first if it was queued, and its whole reply is saved in the conversation, where
    // GET /api/v1/conversations/:id/messages and the dashboard read it. The dashboard's Stop still reaches it.
    const watch = watchTurn(res, { armed: false, stopOnLeave: false });
    const result = await withConversationTurn(convId, async () => {
      watch.touch();
      for await (const event of chatStream({
        provider,
        model,
        messages: history,
        systemParts,
        // The engine gives Tarsee's tools this context (db, settings,
        // channels) and the turn shows on the dashboard's live timeline.
        toolCtx,
        liveSource: "api",
        signal: watch.signal,
        sessionId: convStore.getSessionHandle(convId),
        onSessionId: (handle) => convStore.setSessionHandle(convId, handle),
      })) {
        watch.touch();
        if (event.type === "route") { route = event; ran = { provider: event.provider || null, model: event.model || null }; }
        else if (event.type === "text") fullText += event.content;
        else if (event.type === "error") error = event.message || "The AI stopped with an error";
        else if (event.type === "done") { stopReason = event.stopReason || "end_turn"; break; }
      }
    }, { live: { source: "api", prompt: message, model: model || null } }).finally(() => watch.stop());
    // Taken out of the queue from the dashboard before it began: no reply.
    if (result === QUEUE_REMOVED) return res.status(409).json({ error: "Removed from the queue before it began", conversationId: convId });

    // Save assistant message
    if (fullText) convStore.addMessage(convId, { role: "assistant", content: fullText, provider: ran.provider, model: ran.model });

    // The caller went away: the reply is saved above, and there is nobody to send it to.
    if (watch.left) return;
    if (watch.idled) {
      return res.status(504).json({
        error: idleNote(route, watch.idleMs, { plain: true }),
        stopReason: "idle",
        conversationId: convId,
        provider: ran.provider,
        model: ran.model,
        response: fullText,
      });
    }
    if (stopReason !== "end_turn") {
      return res.status(502).json({
        error: error || `The AI stopped (${stopReason || "no reply"})`,
        stopReason,
        conversationId: convId,
        provider: ran.provider,
        model: ran.model,
        response: fullText,
      });
    }
    res.json({ response: fullText, conversationId: convId, provider: ran.provider, model: ran.model });
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
