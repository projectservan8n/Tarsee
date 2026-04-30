import { Router } from "express";
import { chatStream, getAvailableProviders } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { initSSE, sendSSE } from "../lib/stream-utils.js";
import { LIMITS, CLAUDE_MODELS, CLAUDE_MODELS_BY_ID, resolveModelAlias } from "../config/constants.js";
import { snapshotForContextOverflow } from "../lib/auto-checkpoint.js";
import { processCommand, getCommandList, extractPlaybookPrompt } from "../lib/commands.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { trackActivity } from "../lib/session-reset.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";
import { getGatewayManager } from "../lib/gateway.js";
import { redactSecrets, redactDeep } from "../lib/redact.js";

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
 * Heuristic only — no AI calls. Returns a *tier* which gets resolved to
 * the latest concrete model in that tier from the central registry, so
 * when Anthropic ships a new Opus this routing picks it up automatically.
 */
function classifyMessageModel(message) {
  const words = message.split(/\s+/).length;
  const lower = message.toLowerCase();

  // Opus signals: code, analysis, complex tasks
  const opusKeywords = ["debug", "fix", "implement", "refactor", "architect", "design pattern",
    "analyze", "complex", "explain how", "write a", "build", "create a", "deploy",
    "optimize", "migrate", "security", "performance", "!think", "!!"];
  const hasCode = message.includes("```") || /\b(function|const|import|class|def|async|await)\s/.test(message);
  if (hasCode || opusKeywords.some((k) => lower.includes(k))) return resolveModelAlias("opus");

  // Haiku signals: short, simple
  if (words <= 12 && /^(hi|hello|hey|yes|no|ok|thanks|sure|yep|nah|what is|who is|when is|where is|how much|how many)/i.test(lower)) {
    return resolveModelAlias("haiku");
  }

  // Default: Sonnet tier
  return resolveModelAlias("sonnet");
}

// Resolve the registry's human-readable context size ("1M", "200K") to a
// concrete token count for the live context meter. Unknown models fall back
// to 1M so the bar shows *something* rather than dividing by zero.
function contextTokensForModel(modelId) {
  const meta = modelId && CLAUDE_MODELS_BY_ID[modelId];
  const c = (meta && meta.context) || "1M";
  if (c === "200K") return 200_000;
  if (c === "1M") return 1_000_000;
  const m = String(c).match(/^(\d+)\s*(K|M)$/i);
  if (!m) return 1_000_000;
  return Number(m[1]) * (m[2].toUpperCase() === "M" ? 1_000_000 : 1_000);
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
 * GET /api/chat/models
 * List every Claude model Tarsee knows about, straight from the central
 * registry. The Settings dropdown calls this on load so adding a new
 * model in constants.js is enough to make it show up in the UI.
 */
chatRouter.get("/models", (_req, res) => {
  res.json({ models: CLAUDE_MODELS });
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

  res.json({ ...conv, messages, totalMessages, recap });
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

  // Build user content blocks for the AI when attachments are present.
  // aiPromptOverride (populated upstream if the user typed a __PLAYBOOK__
  // command like /checkpoint) wins over the literal message text — the
  // stored convStore entry above keeps the original "/checkpoint" so
  // history UI stays readable, but the AI sees the playbook body.
  let userContentForAI = aiPromptOverride || cleanMessage;
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
    channelManager: req.app.get("channelManager"),
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

  // --- Claude Code provider: runs its own agentic loop ---
  if (providerId === "claude-code") {
    const controller = new AbortController();
    // If a previous stream is still active for this conversation, abort it
    // before replacing — prevents two streams writing to the same convo and
    // the old stream's cleanup clobbering the new one.
    const previous = activeRequests.get(convId);
    if (previous && previous !== controller) {
      try { previous.abort(); } catch {}
    }
    activeRequests.set(convId, controller);
    // Tab freeze / OS sleep / Wi-Fi blip will close the SSE socket while
    // the model is still producing. Don't abort the generator on socket
    // close — let it run to completion so the assistant message persists
    // and `broadcastToOthers` keeps populating the gateway buffer for
    // sync.resume on reconnect. The only legitimate aborter is the
    // "new message replaces this turn" path above (lines 498-501).
    let clientDetached = false;
    res.on("close", () => {
      clientDetached = true;
    });

    // Heartbeat + idle watchdog. Emits a `heartbeat` SSE event every 15s
    // so proxies don't buffer the response to death (skipped once the
    // client detaches — there's no socket to feed). Idle abort still
    // fires if the SDK produces no events for 3 minutes — that's a
    // stuck-model guard, unrelated to the client connection.
    let lastEventAt = Date.now();
    const HEARTBEAT_MS = 15_000;
    const IDLE_ABORT_MS = 3 * 60_000;
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
        sendSSE(res, "error", { message: "Claude Code stopped responding (3 min idle). Try again." });
        sendSSE(res, "done", { conversationId: convId });
        if (!res.writableEnded) res.end();
      }
    }, HEARTBEAT_MS);

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
        // Strip invalid Unicode surrogates that break JSON
        if (typeof content === "string") content = content.replace(/[\uD800-\uDFFF]/g, "");
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

      // Loop prevention: track recent tool calls to detect stuck patterns
      const toolHistory = []; // { name, detail, isError }
      const MAX_TOOL_CALLS = 50; // absolute max tools per message
      let totalToolCalls = 0;

      const detectLoop = () => {
        if (toolHistory.length < 3) return false;
        const last3 = toolHistory.slice(-3);
        // Same tool + same error 3x in a row = stuck
        if (last3.every(t => t.isError && t.name === last3[0].name)) return `${last3[0].name} failed 3 times in a row`;
        // Same tool + same input 3x in a row = stuck
        if (last3.every(t => t.detail === last3[0].detail && t.name === last3[0].name)) return `${last3[0].name} called 3 times with same input`;
        // Too many total tool calls
        if (totalToolCalls >= MAX_TOOL_CALLS) return `exceeded ${MAX_TOOL_CALLS} tool calls`;
        // 5 consecutive errors (any tool)
        const last5 = toolHistory.slice(-5);
        if (last5.length >= 5 && last5.every(t => t.isError)) return "5 consecutive tool errors";
        return false;
      };

      for await (const event of stream) {
        lastEventAt = Date.now();
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
          const timelineItem = { type: "tool", name: label, detail: detail.slice(0, 200), input: detail.slice(0, 500), output: "", status: "running" };
          if (isTodo && Array.isArray(inp.todos)) timelineItem.todos = inp.todos;
          timeline.push(timelineItem);
          totalToolCalls++;
          toolHistory.push({ name: event.name, detail: detail.slice(0, 100), isError: false });
          sendSSE(res, "tool_call", { id: event.id, name: event.name, input: safeInput });
          broadcastToOthers(convId, "tool_call", { id: event.id, name: event.name, input: safeInput });
          auditLog?.log({ action: "tool.call", target: event.name, actor: "claude", ip: reqIp, detail: detail.slice(0, 200) });
        } else if (event.type === "tool_result") {
          // Redact stdout/stderr from tools before it goes anywhere user-
          // visible or persistent. Bash runs that print env vars, Read of
          // .env files, etc. — this is the highest-volume leak vector.
          // Loop-detection still uses the raw `event.result` string for
          // its error-keyword scan, since redaction never adds tokens
          // that match the error patterns.
          const safeResult = redactStr(event.result || "");
          if (lastToolIdx >= 0 && timeline[lastToolIdx]) {
            timeline[lastToolIdx].status = "done";
            timeline[lastToolIdx].output = safeResult.slice(0, 2000);
          }
          // Track errors for loop detection
          const resultStr = event.result || "";
          const isErr = resultStr.includes("Error") || resultStr.includes("error") || resultStr.includes("Forbidden") || resultStr.includes("ENOTFOUND") || resultStr.includes("not found") || resultStr.includes("command not found");
          if (toolHistory.length > 0) toolHistory[toolHistory.length - 1].isError = isErr;

          // Check for loops — abort if stuck
          const loopReason = detectLoop();
          if (loopReason) {
            console.warn(`[loop-guard] Aborting: ${loopReason} (${totalToolCalls} total tool calls)`);
            sendSSE(res, "text", { content: `\n\n**Loop detected — stopped automatically.** (${loopReason})\n\nI was repeating the same failing operation. Let me know what you'd like me to try differently.` });
            fullResponse += `\n\n**Loop detected — stopped automatically.** (${loopReason})`;
            controller.abort();
            break;
          }

          sendSSE(res, "tool_result", { id: event.id, name: event.name, result: safeResult });
          broadcastToOthers(convId, "tool_result", { id: event.id, name: event.name, result: safeResult });
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
      const contextTokens = contextTokensForModel(model);
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
      sendSSE(res, "done", { conversationId: convId, usage, model, contextTokens, checkpointed });
      broadcastToOthers(convId, "done", { conversationId: convId });
    } catch (err) {
      const isOverflow = /prompt is too long|context_length_exceeded|input length|too many tokens/i.test(err.message || "");
      if (isOverflow) {
        try {
          const path = snapshotForContextOverflow(req.app.get("db"), settingsStore, "auto: overflow error");
          sendSSE(res, "context_overflow", { checkpointPath: path, message: err.message });
        } catch (e) {
          console.warn("[chat] overflow snapshot failed:", e?.message);
        }
      }
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
    return;
  }

  // Heartbeat + idle abort for non-Claude-Code providers too. Same
  // tab-survival contract as the Claude Code path: socket close does
  // NOT abort; only the 3-min stuck-model watchdog does.
  let lastEventAt2 = Date.now();
  const HEARTBEAT_MS = 15_000;
  const IDLE_ABORT_MS = 3 * 60_000;
  const genericController = new AbortController();
  let clientDetached2 = false;
  res.on("close", () => {
    clientDetached2 = true;
  });
  const hb2 = setInterval(() => {
    if (res.writableEnded || clientDetached2) {
      if (Date.now() - lastEventAt2 > IDLE_ABORT_MS) {
        clearInterval(hb2);
        try { genericController.abort(); } catch {}
      }
      return;
    }
    sendSSE(res, "heartbeat", { ts: Date.now() });
    if (Date.now() - lastEventAt2 > IDLE_ABORT_MS) {
      clearInterval(hb2);
      try { genericController.abort(); } catch {}
      sendSSE(res, "error", { message: "Model stopped responding (3 min idle). Try again." });
      sendSSE(res, "done", { conversationId: convId });
      if (!res.writableEnded) res.end();
    }
  }, HEARTBEAT_MS);

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
        signal: genericController.signal,
        tools,
      });

      for await (const event of stream) {
        lastEventAt2 = Date.now();
        if (event.type === "text") {
          roundText += event.content;
          fullResponse += event.content;
          sendSSE(res, "text", { content: event.content });
        } else if (event.type === "thinking") {
          sendSSE(res, "thinking", { status: event.status });
        } else if (event.type === "tool_use") {
          toolCalls.push({ id: event.id, name: event.name, input: event.input });
          // Notify client about tool call (input redacted before broadcast)
          sendSSE(res, "tool_call", { id: event.id, name: event.name, input: redactObj(event.input) });
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
        // Notify client about tool result. The model still gets the raw
        // result above (for accurate context), but the UI/timeline/log
        // sees a redacted copy.
        sendSSE(res, "tool_result", { id: tc.id, name: tc.name, result: redactStr(result).slice(0, 500) });
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

    const contextTokens = contextTokensForModel(model);
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
    sendSSE(res, "done", { conversationId: convId, usage, model, contextTokens, checkpointed });
  } catch (err) {
    const isOverflow = /prompt is too long|context_length_exceeded|input length|too many tokens/i.test(err.message || "");
    if (isOverflow) {
      try {
        const path = snapshotForContextOverflow(req.app.get("db"), settingsStore, "auto: overflow error");
        if (!res.writableEnded) sendSSE(res, "context_overflow", { checkpointPath: path, message: err.message });
      } catch (e) {
        console.warn("[chat] overflow snapshot failed:", e?.message);
      }
    }
    if (!res.writableEnded) sendSSE(res, "error", { message: err.message });
  } finally {
    clearInterval(hb2);
    if (!res.writableEnded) res.end();
  }
});
