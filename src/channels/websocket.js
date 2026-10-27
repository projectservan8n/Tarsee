import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { validateApiToken, validateSessionFromRequest } from "../middleware/auth.js";
import { chatStream } from "../ai/router.js";
import { onEvent, eventsSince, eventsForTurn, activeTurnFor, activeTurnList, queuedTurnList, recentEvents } from "../lib/live-bus.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { AuditLog } from "../db/audit.js";
import { WS_CODES } from "../config/constants.js";
import { processCommand, extractPlaybookPrompt } from "../lib/commands.js";
import { logCapture } from "../lib/log-capture.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { handleTerminalConnection } from "../websocket/terminal-handler.js";

// See the note in telegram.js: finite by design — this build has no PTY
// heartbeat to fall back on, so an unbounded idle window can wedge a turn.
const IDLE_ABORT_MS = Number(process.env.TARSEE_CHANNEL_IDLE_ABORT_MS) || 20 * 60_000;
import { getGatewayManager } from "../lib/gateway.js";
import { redactSecrets, redactDeep } from "../lib/redact.js";

/**
 * Sets up WebSocket server on the existing HTTP server.
 * Handles real-time chat over WebSocket.
 *
 * Protocol:
 *   Client → Server:
 *     { type: "auth", token: "..." }
 *     { type: "chat", conversationId?: "...", message: "..." }
 *     { type: "ping" }
 *
 *   Server → Client:
 *     { type: "auth_ok" }
 *     { type: "auth_error", error: "..." }
 *     { type: "text", content: "..." }
 *     { type: "done", conversationId: "...", usage: {...} }
 *     { type: "error", message: "..." }
 *     { type: "pong" }
 */
export function setupWebSocket(server, db, app) {
  const wss = new WebSocketServer({ noServer: true });

  // ── Live timeline fan-out ─────────────────────────────────────────────
  // Every published event goes to sockets subscribed to that conversation
  // ("live.event", full payload) and, in compact form, to sockets watching
  // all activity ("live.activity": turn start/end, tool starts/ends and
  // message previews, for "working" indicators across every channel).
  const ACTIVITY_TYPES = new Set(["turn_queued", "turn_start", "turn_end"]);
  onEvent((evt) => {
    let full = null;
    let compact = null;
    for (const ws of wss.clients) {
      if (ws.readyState !== 1 || !ws.isAuthenticated) continue;
      try {
        if (ws._liveSubs?.has(evt.conversationId)) {
          full ||= JSON.stringify({ type: "live.event", event: evt });
          ws.send(full);
        }
        // (Of the steps, only tools: the sidebar's "working" labels need nothing else, and a usage step comes every few seconds.)
        if (ws._liveActivity && (ACTIVITY_TYPES.has(evt.type) || (evt.type === "step" && (evt.payload?.kind === "tool_start" || evt.payload?.kind === "tool_end")) || evt.type === "message")) {
          compact ||= JSON.stringify({ type: "live.activity", event: {
            seq: evt.seq, conversationId: evt.conversationId, turnId: evt.turnId, type: evt.type, createdAt: evt.createdAt,
            payload: evt.type === "message"
              ? { role: evt.payload?.role, preview: String(evt.payload?.content || "").slice(0, 140) }
              : evt.type === "step"
                ? { kind: evt.payload?.kind, id: evt.payload?.id, name: evt.payload?.name, summary: evt.payload?.summary, ok: evt.payload?.ok }
                : evt.payload,
          } });
          ws.send(compact);
        }
      } catch { /* dead socket: close handler cleans up */ }
    }
  });
  const terminalWss = new WebSocketServer({ noServer: true });
  const convStore = new ConversationStore(db);
  const settingsStore = new SettingsStore(db);
  const auditLog = new AuditLog(db);

  // Handle HTTP upgrade
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    // Route to terminal WebSocket if path is /terminal
    if (pathname === "/terminal") {
      // Terminal auth: session cookie OR API token via query param
      const token = url.searchParams.get("token");
      const isAuthed = validateSessionFromRequest(req) || (token && validateApiToken(token));
      if (!isAuthed) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        terminalWss.emit("connection", ws, req);
      });
      return;
    }

    // Default chat WebSocket
    // Extract token from query param or subprotocol
    const token = url.searchParams.get("token");

    // Auth via query token or session cookie
    const isAuthed = (token && validateApiToken(token)) || validateSessionFromRequest(req);

    if (isAuthed) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAuthenticated = true;
        wss.emit("connection", ws, req);
      });
    } else {
      // Allow connection but require auth message
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAuthenticated = false;
        wss.emit("connection", ws, req);

        // Give 10 seconds to authenticate
        ws.authTimeout = setTimeout(() => {
          if (!ws.isAuthenticated) {
            ws.close(WS_CODES.AUTH_FAILED, "Authentication timeout");
          }
        }, 10_000);
      });
    }
  });

  wss.on("connection", (ws) => {
    // Attach context for console commands
    ws._tarsee_db = db;
    ws._tarsee_channelManager = app?.get?.("channelManager") || null;

    // Register this connection with the gateway so cross-device broadcasts
    // (chat sync, typing indicators) actually reach other open tabs/devices.
    // Without this, GatewayManager.connections is empty and broadcastToOthers()
    // is silently a no-op.
    const gw = getGatewayManager();
    const clientId = crypto.randomUUID();
    ws._tarsee_clientId = clientId;
    if (ws.isAuthenticated) {
      gw.addConnection(clientId, ws);
    }

    // If already authenticated via session/token at upgrade, send auth_ok immediately
    if (ws.isAuthenticated) {
      ws.send(JSON.stringify({ type: "auth_ok" }));
    }

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      // Handle auth
      if (msg.type === "auth") {
        if (ws.isAuthenticated) {
          // Already authenticated via session cookie
          ws.send(JSON.stringify({ type: "auth_ok" }));
        } else if (validateApiToken(msg.token)) {
          ws.isAuthenticated = true;
          clearTimeout(ws.authTimeout);
          // Late-auth path: register with gateway now that we trust them.
          if (ws._tarsee_clientId) {
            getGatewayManager().addConnection(ws._tarsee_clientId, ws);
          }
          ws.send(JSON.stringify({ type: "auth_ok" }));
        } else {
          ws.send(JSON.stringify({ type: "auth_error", error: "Invalid token" }));
          ws.close(WS_CODES.AUTH_FAILED, "Invalid token");
        }
        return;
      }

      // Require auth for everything else
      if (!ws.isAuthenticated) {
        ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
        return;
      }

      // Handle ping
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      // Handle console subscribe
      if (msg.type === "console.subscribe") {
        logCapture.subscribe(ws);
        // Send recent history
        const recent = logCapture.recent(100);
        ws.send(JSON.stringify({ type: "console.history", entries: recent }));
        return;
      }

      // Handle console unsubscribe
      if (msg.type === "console.unsubscribe") {
        logCapture.unsubscribe(ws);
        return;
      }

      // Handle console command execution
      if (msg.type === "console.exec") {
        await handleConsoleExec(ws, msg);
        return;
      }

      // Handle stop (abort current task)
      if (msg.type === "stop") {
        if (ws._currentAbort) {
          ws._currentAbort.abort();
          ws._currentAbort = null;
          ws.send(JSON.stringify({ type: "stopped" }));
        }
        return;
      }

      // Handle typing indicator broadcast
      if (msg.type === "typing") {
        const gw = getGatewayManager();
        for (const [, conn] of gw.connections) {
          if (conn.ws !== ws && conn.ws?.readyState === 1) {
            try { conn.ws.send(JSON.stringify({ type: "typing", channel: msg.channel || "web" })); } catch { /* ignore */ }
          }
        }
        return;
      }

      // Live timeline: subscribe to one conversation from a sequence number.
      // The reply carries everything after sinceSeq PLUS every event of the
      // turn in progress (so a device opened mid-turn sees the whole turn so
      // far, not just what happens next). convId is a conversation id or a
      // background job's ("cron:<id>", "heartbeat", "boot").
      if (msg.type === "live.subscribe" && typeof msg.convId === "string" && msg.convId.length <= 200) {
        ws._liveSubs ||= new Set();
        // One page follows a handful of chats; a socket asking for hundreds
        // is a bug or abuse, and each id costs a lookup on every event.
        if (ws._liveSubs.size >= 50 && !ws._liveSubs.has(msg.convId)) {
          ws._liveSubs.delete(ws._liveSubs.values().next().value);
        }
        ws._liveSubs.add(msg.convId);
        const since = Number(msg.sinceSeq) || 0;
        // tail: a background job's view (cron, heartbeat) opened fresh wants
        // its recent runs, not the oldest 1000 events since seq 0.
        let events = msg.tail && !since ? recentEvents(msg.convId, 300) : eventsSince(msg.convId, since, 1000);
        const turn = activeTurnFor(msg.convId);
        // (and of each turn waiting behind it: its "Queued" line)
        const open = [turn?.turnId, ...queuedTurnList(msg.convId).map((t) => t.turnId)].filter(Boolean);
        if (open.length) {
          const have = new Set(events.map((e) => e.seq));
          const turnEvents = open.flatMap((id) => eventsForTurn(id)).filter((e) => !have.has(e.seq) && (have.add(e.seq), true));
          events = [...turnEvents, ...events].sort((a, b) => a.seq - b.seq);
        }
        try { ws.send(JSON.stringify({ type: "live.backlog", convId: msg.convId, events, activeTurn: turn })); } catch {}
        return;
      }
      if (msg.type === "live.unsubscribe" && msg.convId) {
        ws._liveSubs?.delete(msg.convId);
        return;
      }
      if (msg.type === "live.activity.subscribe") {
        ws._liveActivity = true;
        try { ws.send(JSON.stringify({ type: "live.activity.snapshot", turns: activeTurnList(), queued: queuedTurnList() })); } catch {}
        return;
      }

      // Resume sync: replay buffered events for a conversation newer than
      // lastEventId. Clients call this after reconnecting (phone unlock,
      // network drop, bfcache restore) so they can catch up on tool calls /
      // streaming text that happened while their WS was dead.
      if (msg.type === "sync.resume") {
        const gw = getGatewayManager();
        const events = gw.replay(msg.convId, Number(msg.lastEventId) || 0);
        for (const e of events) {
          try {
            ws.send(JSON.stringify({
              type: "sync",
              convId: msg.convId,
              event: e.event,
              data: e.data,
              eventId: e.id,
              replay: true,
            }));
          } catch { /* ignore */ }
        }
        try { ws.send(JSON.stringify({ type: "sync.resumed", convId: msg.convId, count: events.length })); } catch {}
        return;
      }

      // Handle chat (with queueing)
      if (msg.type === "chat") {
        if (ws._chatBusy) {
          if (!ws._chatQueue) ws._chatQueue = [];
          ws._chatQueue.push(msg);
          ws.send(JSON.stringify({ type: "queued", position: ws._chatQueue.length }));
          return;
        }
        ws._chatBusy = true;
        const drainQueue = async () => {
          try {
            await handleChat(ws, msg, convStore, settingsStore);
          } finally {
            ws._chatBusy = false;
            // Process next queued message
            if (ws._chatQueue?.length > 0) {
              const next = ws._chatQueue.shift();
              ws._chatBusy = true;
              msg = next; // reuse variable for next iteration
              await drainQueue();
            }
          }
        };
        await drainQueue();
        return;
      }

      ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }));
    });

    ws.on("close", () => {
      clearTimeout(ws.authTimeout);
      // Drop from gateway so broadcasts stop trying to send to a dead socket.
      if (ws._tarsee_clientId) {
        getGatewayManager().removeConnection(ws._tarsee_clientId);
      }
    });
  });

  // Terminal WebSocket connections
  terminalWss.on("connection", (ws, req) => {
    handleTerminalConnection(ws, req, {
      sessionAuth: validateSessionFromRequest,
      auditLog,
    });
  });

  return wss;
}

async function handleChat(ws, msg, convStore, settingsStore) {
  const { conversationId, message, attachments } = msg;
  // Tool inputs and outputs shown on screens are redacted unless turned off (as routes/chat.js does).
  const redactOn = settingsStore?.get?.("ui.redactSecrets") !== false;

  if (!message || typeof message !== "string") {
    ws.send(JSON.stringify({ type: "error", message: "Message is required" }));
    return;
  }

  // Check for commands. __PLAYBOOK__ commands (like /checkpoint) get
  // their response fed to the AI as the user's turn instead of echoed.
  let aiPromptOverride = null;
  if (message.startsWith("/")) {
    const cmdResult = await processCommand(message, {
      settingsStore,
      convStore,
      conversationId,
      platform: "web", // was missing — platform-gated commands misrouted
      // handleChat is a top-level function — the `db` handle from
      // setupWebSocket() is NOT in scope here, so reach it via the store.
      db: convStore?.db,
    });

    if (cmdResult.handled) {
      const playbook = extractPlaybookPrompt(cmdResult);
      if (playbook) {
        aiPromptOverride = playbook;
      } else {
        ws.send(JSON.stringify({ type: "command", response: cmdResult.response }));
        return;
      }
    }
  }

  // Get or create conversation.
  //
  // A client-supplied id must be checked before use. messages.conversation_id
  // is a NOT NULL foreign key and `foreign_keys = ON`, so inserting against a
  // deleted conversation throws SQLITE_CONSTRAINT out of this async handler —
  // an unhandled rejection that kills the process. Two tabs open on one
  // conversation, delete in the first, send from the second, and the whole
  // server goes down; any authenticated client could also do it on purpose.
  let convId = conversationId;
  if (convId && !convStore.get(convId)) {
    ws.send(JSON.stringify({
      type: "error",
      message: "That conversation no longer exists. Start a new one.",
      code: "conversation_not_found",
    }));
    return;
  }
  if (!convId) {
    const conv = convStore.create({ title: message.slice(0, 100) });
    convId = conv.id;
  }

  // Resolve provider
  const activeProvider = settingsStore.getActiveProvider();
  if (!activeProvider?.provider || !activeProvider?.ready) {
    ws.send(JSON.stringify({ type: "error", message: "No AI provider configured" }));
    return;
  }

  // Save user message (text only — no base64 blobs in DB)
  convStore.addMessage(convId, { role: "user", content: message });
  // Mirror to other devices viewing this conversation.
  getGatewayManager().broadcast(convId, "user_message", { content: message, conversationId: convId });

  // Build user content blocks for the AI when attachments are present.
  // If a slash command returned a __PLAYBOOK__ sentinel, use the playbook
  // as the AI-visible user turn while the stored /checkpoint stays in the
  // conversation history as-typed.
  let userContentForAI = aiPromptOverride || message;
  if (Array.isArray(attachments) && attachments.length > 0) {
    const contentBlocks = [];
    for (const att of attachments) {
      if (att.type === "image") {
        contentBlocks.push({
          type: "image",
          source: { type: "base64", media_type: att.mediaType || "image/png", data: att.data },
        });
      } else if (att.type === "audio") {
        contentBlocks.push({
          type: "audio",
          source: { type: "base64", media_type: att.mediaType || "audio/wav", data: att.data },
        });
      } else {
        contentBlocks.push({
          type: "text",
          text: `[Attached file: ${att.name || "file"} (${att.mediaType || "application/octet-stream"})]`,
        });
      }
    }
    contentBlocks.push({ type: "text", text: message });
    userContentForAI = contentBlocks;
  }

  // Get history
  const history = convStore.getRecentMessages(convId, 20);
  const conv = convStore.get(convId);

  // Voice mode — respond normally, TTS strips non-speakable content
  const isVoiceMode = message.startsWith("[voice]");
  const voiceHint = isVoiceMode
    ? "[VOICE MODE] Response shown visually AND read aloud. TTS limit: 2 short sentences max before any table/code. Tables shown but NOT spoken. Structure: brief intro (under 200 chars) → then details."
    : "";

  // Build effective system prompt (parity with HTTP handler)
  const effectiveSystemPrompt = buildSystemPrompt({
    settingsStore,
    db: ws._tarsee_db,
    channelManager: ws._tarsee_channelManager,
    conversationId: convId,
    messageCount: history.length,
    conversationPrompt: conv?.system_prompt,
    channelHint: voiceHint,
  });

  let fullResponse = "";
  let usage = {};
  const tools = getToolDefinitions();
  const toolCtx = { db: ws._tarsee_db, settingsStore, conversationId: convId, channelManager: ws._tarsee_channelManager, dashboard: true };
  const MAX_TOOL_ROUNDS = 15;
  const providerId = activeProvider.provider;

  // --- Claude Code provider: runs its own agentic loop ---
  if (providerId === "claude-code") {
    // Heartbeat + 3-min idle abort for parity with the HTTP SSE path.
    let lastEventAt = Date.now();
    let idleAborted = false;
    const hb = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return clearInterval(hb);
      try { ws.send(JSON.stringify({ type: "heartbeat", ts: Date.now() })); } catch {}
      if (Date.now() - lastEventAt > IDLE_ABORT_MS) {
        idleAborted = true;
        clearInterval(hb);
        try { ws._currentAbort?.abort(); } catch {}
      }
    }, 15_000);

    try {
      const controller = new AbortController();
      ws._currentAbort = controller; // expose for /stop
      const onClose = () => controller.abort();
      ws.on("close", onClose);

      const existingSessionId = convStore.getClaudeSessionId(convId);
      const mod = await import("../ai/providers/claude-code.js");
      const ccMessages = history.map((m) => ({ role: m.role, content: m.content }));
      // Apply playbook override to the last user turn so the AI sees the
      // playbook body instead of the literal "/checkpoint" token.
      if (aiPromptOverride && ccMessages.length > 0) {
        const last = ccMessages[ccMessages.length - 1];
        if (last.role === "user") last.content = aiPromptOverride;
      }
      const stream = mod.chat({
        liveSource: "web",
        messages: ccMessages,
        model: activeProvider.model,
        systemPrompt: effectiveSystemPrompt,
        signal: controller.signal,
        sessionId: existingSessionId,
        onSessionId: (sid) => convStore.setClaudeSessionId(convId, sid),
        toolCtx,
      });

      const gw = getGatewayManager();
      for await (const event of stream) {
        if (ws.readyState !== ws.OPEN) break;
        lastEventAt = Date.now();
        if (event.type === "text") {
          fullResponse += event.content;
          ws.send(JSON.stringify({ type: "text", content: event.content }));
          gw.broadcast(convId, "text", { content: event.content });
        } else if (event.type === "thinking") {
          ws.send(JSON.stringify({ type: "thinking", status: event.status }));
          gw.broadcast(convId, "thinking", { status: event.status });
        } else if (event.type === "tool_use") {
          // Redacted before it reaches any screen or the replay buffer, as
          // routes/chat.js does (ui.redactSecrets = false turns it off).
          const input = redactOn ? redactDeep(event.input) : event.input;
          ws.send(JSON.stringify({ type: "tool_call", id: event.id, name: event.name, input }));
          gw.broadcast(convId, "tool_call", { id: event.id, name: event.name, input });
        } else if (event.type === "tool_result") {
          const result = redactOn ? redactSecrets(String(event.result ?? "")) : event.result;
          ws.send(JSON.stringify({ type: "tool_result", id: event.id, name: event.name, result }));
          gw.broadcast(convId, "tool_result", { id: event.id, name: event.name, result });
        } else if (event.type === "usage") {
          usage = { ...usage, ...event.usage };
        } else if (event.type === "error") {
          ws.send(JSON.stringify({ type: "error", message: event.message }));
        } else if (event.type === "done") {
          break;
        }
      }

      ws.removeListener("close", onClose);
      ws._currentAbort = null;

      if (fullResponse) {
        fullResponse = extractAndSaveMemories(fullResponse, ws._tarsee_db, convId);
        convStore.addMessage(convId, {
          role: "assistant",
          content: fullResponse,
          provider: providerId,
          model: activeProvider.model,
          tokensIn: (usage.input_tokens || 0)
          + (usage.cache_read_input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0) || null,
          tokensOut: usage.output_tokens,
        });
      }

      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "done", conversationId: convId, usage }));
      }
      gw.broadcast(convId, "done", { conversationId: convId });
    } catch (err) {
      if (ws.readyState === ws.OPEN) {
        const message = idleAborted
          ? "Claude Code stopped responding (3 min idle). Try again."
          : err.message;
        ws.send(JSON.stringify({ type: "error", message }));
      }
    } finally {
      clearInterval(hb);
    }
    return;
  }

  // Heartbeat + 3-min idle abort for the generic provider branch too.
  let lastEventAt2 = Date.now();
  let idleAborted2 = false;
  const hb2 = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return clearInterval(hb2);
    try { ws.send(JSON.stringify({ type: "heartbeat", ts: Date.now() })); } catch {}
    if (Date.now() - lastEventAt2 > IDLE_ABORT_MS) {
      idleAborted2 = true;
      clearInterval(hb2);
    }
  }, 15_000);

  try {
    const controller = new AbortController();
    const onClose = () => controller.abort();
    ws.on("close", onClose);
    // Abort the stream if the idle watchdog fires.
    const idleWatch = setInterval(() => {
      if (idleAborted2) { try { controller.abort(); } catch {} clearInterval(idleWatch); }
    }, 5_000);

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
        provider: activeProvider.provider,
        model: activeProvider.model,
        apiKey: activeProvider.apiKey,
        baseUrl: activeProvider.baseUrl,
        messages: workingMessages,
        systemPrompt: effectiveSystemPrompt,
        signal: controller.signal,
        tools,
      });

      const gw = getGatewayManager();
      for await (const event of stream) {
        if (ws.readyState !== ws.OPEN) break;
        lastEventAt2 = Date.now();

        if (event.type === "text") {
          roundText += event.content;
          fullResponse += event.content;
          ws.send(JSON.stringify({ type: "text", content: event.content }));
          gw.broadcast(convId, "text", { content: event.content });
        } else if (event.type === "tool_use") {
          toolCalls.push({ id: event.id, name: event.name, input: event.input });
          const shown = redactOn ? redactDeep(event.input) : event.input;
          ws.send(JSON.stringify({ type: "tool_call", id: event.id, name: event.name, input: shown }));
          gw.broadcast(convId, "tool_call", { id: event.id, name: event.name, input: shown });
        } else if (event.type === "usage") {
          usage = { ...usage, ...event.usage };
        } else if (event.type === "done") {
          stopReason = event.stopReason || "end_turn";
          break;
        }
      }

      if (toolCalls.length === 0 || stopReason !== "tool_use") break;

      // Build assistant message with tool_use blocks
      const assistantContent = [];
      if (roundText) assistantContent.push({ type: "text", text: roundText });
      for (const tc of toolCalls) {
        assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      workingMessages.push({ role: "assistant", content: assistantContent });

      // Execute tools and build results
      const toolResults = [];
      for (const tc of toolCalls) {
        console.log(`[tools] executing: ${tc.name}(${JSON.stringify(tc.input).slice(0, 100)})`);
        const result = await executeTool(tc.name, tc.input, toolCtx);
        toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
        const short = result.slice(0, 500);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "tool_result", id: tc.id, name: tc.name, result: short }));
        }
        gw.broadcast(convId, "tool_result", { id: tc.id, name: tc.name, result: short });
      }
      workingMessages.push({ role: "user", content: toolResults });
    }

    ws.removeListener("close", onClose);

    // Extract [REMEMBER: ...] markers and auto-save memories
    if (fullResponse) {
      fullResponse = extractAndSaveMemories(fullResponse, ws._tarsee_db, convId);
    }

    // Save assistant message (with markers stripped)
    if (fullResponse) {
      convStore.addMessage(convId, {
        role: "assistant",
        content: fullResponse,
        provider: activeProvider.provider,
        model: activeProvider.model,
        tokensIn: (usage.input_tokens || 0)
          + (usage.cache_read_input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0) || null,
        tokensOut: usage.output_tokens,
      });
    }

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "done", conversationId: convId, usage }));
    }
    getGatewayManager().broadcast(convId, "done", { conversationId: convId });
  } catch (err) {
    if (ws.readyState === ws.OPEN) {
      const message = idleAborted2
        ? "Model stopped responding (3 min idle). Try again."
        : err.message;
      ws.send(JSON.stringify({ type: "error", message }));
    }
  } finally {
    clearInterval(hb2);
  }
}

/**
 * Execute a debug command from the console UI.
 */
async function handleConsoleExec(ws, msg) {
  const { command, args } = msg;
  if (!command) {
    ws.send(JSON.stringify({ type: "console.error", message: "Command required" }));
    return;
  }

  try {
    const { ALLOWED_COMMANDS } = await import("../routes/debug.js");
    const cmd = ALLOWED_COMMANDS[command];

    if (!cmd) {
      ws.send(JSON.stringify({
        type: "console.error",
        command,
        message: `Unknown command: ${command}. Available: ${Object.keys(ALLOWED_COMMANDS).join(", ")}`,
      }));
      return;
    }

    // Build context — channelManager comes from the app if available
    const ctx = {
      db: ws._tarsee_db,
      channelManager: ws._tarsee_channelManager,
    };

    const output = await cmd.run(args, ctx);
    ws.send(JSON.stringify({ type: "console.result", command, output }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "console.error", command, message: err.message }));
  }
}
