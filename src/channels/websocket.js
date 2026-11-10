import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { validateApiToken, validateSessionFromRequest, liveSessionId, isLiveSession } from "../middleware/auth.js";
import { chatStream } from "../ai/router.js";
import { onEvent, eventsSince, eventsForTurn, activeTurnFor, activeTurnList, queuedTurnList, recentEvents } from "../lib/live-bus.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { AuditLog } from "../db/audit.js";
import { WS_CODES } from "../config/constants.js";
import { processCommand, extractPlaybookPrompt } from "../lib/commands.js";
import { logCapture } from "../lib/log-capture.js";
import { buildSystemPromptParts, sendFileHint } from "../lib/build-system-prompt.js";
import { withConversationTurn, QUEUE_REMOVED } from "../lib/conversation-lock.js";
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
    // The owner's sign-in, if the upgrade came with one: the owner's commands need it (handleChat), the API token
    // alone isn't enough. Checked again at each command, so signing out or running out ends it for this socket too.
    const signInId = liveSessionId(req);

    if (isAuthed) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAuthenticated = true;
        ws._signInId = signInId;
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
      // The dashboard ("web") only with the owner's sign-in still on, from the upgrade; the API token alone (?token=
      // or the auth message) is "api", which commands.js doesn't take for the owner (/cron, /briefing, /webhook).
      platform: isLiveSession(ws._signInId) ? "web" : "api",
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

  // (Which AI answers, and whether it is set up, is the turn layer's: ai/turn.js. One that isn't set up answers
  // with what to fix, as on every channel.)

  // Save user message (text only — no base64 blobs in DB)
  const savedUser = convStore.addMessage(convId, { role: "user", content: message });
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
        // A voice note: the turn layer turns it into its transcript for every AI (ai/media.js)
        contentBlocks.push({
          type: "audio",
          source: { type: "base64", media_type: att.mediaType || "audio/wav", data: att.data },
        });
      } else if (att.type === "pdf" || att.mediaType === "application/pdf") {
        contentBlocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: att.data },
        });
      } else {
        contentBlocks.push({
          type: "text",
          text: `[Attached file: ${att.name || "file"} (${att.mediaType || "application/octet-stream"})]`,
        });
      }
    }
    contentBlocks.push({ type: "text", text: aiPromptOverride || message });
    userContentForAI = contentBlocks;
  }

  // Get history
  const history = convStore.getRecentMessages(convId, 20);
  const conv = convStore.get(convId);

  // Build the system prompt (parity with the HTTP handler): the stable part, then this turn's own
  const promptParts = buildSystemPromptParts({
    settingsStore,
    db: ws._tarsee_db,
    channelManager: ws._tarsee_channelManager,
    conversationId: convId,
    messageCount: history.length,
    conversationPrompt: conv?.system_prompt,
    channelHint: sendFileHint("web"),
  });
  const systemParts = { stable: promptParts.stable, volatile: promptParts.volatile };

  // dashboard: a file the agent hands over goes to this chat; messageId: the message answered (its pictures are kept with it)
  const toolCtx = { db: ws._tarsee_db, settingsStore, conversationId: convId, channelManager: ws._tarsee_channelManager, dashboard: true, messageId: savedUser?.id || null };

  // Taken out of the queue (the Stop on its "Queued" line) before it began: this message is done, with no reply.
  let ended = false;
  const endRemoved = () => {
    if (ended) return;
    ended = true;
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "done", conversationId: convId, stopReason: "stopped" }));
  };

  // One turn per conversation at a time, whichever channel sent it (lib/conversation-lock.js): two resumes of one
  // session at once corrupt it.
  const ran = await withConversationTurn(convId, async () => {
    let fullResponse = "";
    let usage = {};
    // The AI this turn runs on, from the turn layer's route event (the backup model's, if it answered instead).
    let routed = null;
    // How the turn layer said the turn ended (its one done): sent on in this socket's done, so the tab that pressed
    // Stop shows the reply as stopped, not finished.
    let endReason = null;

    // Heartbeat + idle abort for parity with the HTTP SSE path.
    let lastEventAt = Date.now();
    let idleAborted = false;
    const controller = new AbortController();
    ws._currentAbort = controller; // expose for /stop
    const onClose = () => controller.abort();
    ws.on("close", onClose);
    const hb = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return clearInterval(hb);
      try { ws.send(JSON.stringify({ type: "heartbeat", ts: Date.now() })); } catch {}
      if (Date.now() - lastEventAt > IDLE_ABORT_MS) {
        idleAborted = true;
        clearInterval(hb);
        try { controller.abort(); } catch {}
      }
    }, 15_000);

    try {
      const existingSessionId = convStore.getSessionHandle(convId);
      // The chat's messages for the AI, with their times (the handoff to a new session leaves out what was cleared).
      const aiMessages = history.map((m) => {
        let content = m.content;
        if (content?.startsWith('{"__timeline":true')) {
          try { content = JSON.parse(content).text || content; } catch {}
        }
        return { role: m.role, content, createdAt: m.created_at };
      });
      // The AI sees the attachments and a playbook's body in place of the literal "/checkpoint".
      if (userContentForAI !== message && aiMessages.length > 0) {
        const last = aiMessages[aiMessages.length - 1];
        if (last.role === "user") last.content = userContentForAI;
      }
      const stream = chatStream({
        liveSource: "web",
        liveConversationId: convId,
        messages: aiMessages,
        systemParts,
        signal: controller.signal,
        sessionId: existingSessionId,
        onSessionId: (handle) => convStore.setSessionHandle(convId, handle),
        toolCtx,
        // Summaries of its thinking for the live view. (A voice call's turns go through POST /api/chat/send, which
        // asks for none: a spoken reply is waited for.)
        thinkingSummaries: true,
      });

      const gw = getGatewayManager();
      for await (const event of stream) {
        if (ws.readyState !== ws.OPEN) break;
        lastEventAt = Date.now();
        if (event.type === "route") {
          routed = event;
          ws.send(JSON.stringify({ type: "model_selected", provider: event.provider, model: event.model, label: event.label, effort: event.effort || null, backup: !!event.backup }));
        } else if (event.type === "text") {
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
          endReason = event.stopReason || null;
          break;
        }
      }

      if (idleAborted && ws.readyState === ws.OPEN) {
        const minutes = Math.max(1, Math.round(IDLE_ABORT_MS / 60_000));
        ws.send(JSON.stringify({ type: "error", message: `${routed?.label || "The AI"} stopped responding (${minutes} min idle). Try again.` }));
      }

      if (fullResponse) {
        fullResponse = extractAndSaveMemories(fullResponse, ws._tarsee_db, convId);
        convStore.addMessage(convId, {
          role: "assistant",
          content: fullResponse,
          provider: routed?.provider || null,
          model: routed?.model || null,
          tokensIn: (usage.input_tokens || 0)
          + (usage.cache_read_input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0) || null,
          tokensOut: usage.output_tokens,
        });
      }

      // "stopped" is the page's word for a turn Stop ended (a message taken out of the queue says it too).
      const stopReason = endReason === "aborted" ? "stopped" : endReason;
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "done", conversationId: convId, usage, provider: routed?.provider || null, model: routed?.model || null, stopReason }));
      }
      gw.broadcast(convId, "done", { conversationId: convId, stopReason });
    } catch (err) {
      if (ws.readyState === ws.OPEN) {
        const minutes = Math.max(1, Math.round(IDLE_ABORT_MS / 60_000));
        const message = idleAborted
          ? `${routed?.label || "The AI"} stopped responding (${minutes} min idle). Try again.`
          : err.message;
        ws.send(JSON.stringify({ type: "error", message }));
      }
    } finally {
      clearInterval(hb);
      ws.removeListener("close", onClose);
      if (ws._currentAbort === controller) ws._currentAbort = null;
    }
  }, { live: { source: "web", prompt: message, onRemoved: endRemoved } });
  if (ran === QUEUE_REMOVED) endRemoved();
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
