import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { validateApiToken, validateSessionFromRequest } from "../middleware/auth.js";
import { chatStream } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { AuditLog } from "../db/audit.js";
import { WS_CODES } from "../config/constants.js";
import { processCommand } from "../lib/commands.js";
import { logCapture } from "../lib/log-capture.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";
import { handleTerminalConnection } from "../websocket/terminal-handler.js";

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
      // Terminal requires session auth only (no API token)
      const isAuthed = validateSessionFromRequest(req);
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

      // Handle chat
      if (msg.type === "chat") {
        await handleChat(ws, msg, convStore, settingsStore);
        return;
      }

      ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }));
    });

    ws.on("close", () => {
      clearTimeout(ws.authTimeout);
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

  if (!message || typeof message !== "string") {
    ws.send(JSON.stringify({ type: "error", message: "Message is required" }));
    return;
  }

  // Check for commands
  if (message.startsWith("/")) {
    const cmdResult = await processCommand(message, {
      settingsStore,
      convStore,
      conversationId,
    });

    if (cmdResult.handled) {
      ws.send(JSON.stringify({ type: "command", response: cmdResult.response }));
      return;
    }
  }

  // Get or create conversation
  let convId = conversationId;
  if (!convId) {
    const conv = convStore.create({ title: message.slice(0, 100) });
    convId = conv.id;
  }

  // Resolve provider
  const activeProvider = settingsStore.getActiveProvider();
  if (!activeProvider?.provider || !activeProvider?.apiKey) {
    ws.send(JSON.stringify({ type: "error", message: "No AI provider configured" }));
    return;
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
  const history = convStore.getRecentMessages(convId, 50);
  const conv = convStore.get(convId);

  // Build effective system prompt (parity with HTTP handler)
  const effectiveSystemPrompt = buildSystemPrompt({
    settingsStore,
    db: ws._tarsee_db,
    conversationId: convId,
    messageCount: history.length,
    conversationPrompt: conv?.system_prompt,
  });

  let fullResponse = "";
  let usage = {};
  const tools = getToolDefinitions();
  const toolCtx = { db: ws._tarsee_db, settingsStore, conversationId: convId };
  const MAX_TOOL_ROUNDS = 15;

  try {
    const controller = new AbortController();
    const onClose = () => controller.abort();
    ws.on("close", onClose);

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

      for await (const event of stream) {
        if (ws.readyState !== ws.OPEN) break;

        if (event.type === "text") {
          roundText += event.content;
          fullResponse += event.content;
          ws.send(JSON.stringify({ type: "text", content: event.content }));
        } else if (event.type === "tool_use") {
          toolCalls.push({ id: event.id, name: event.name, input: event.input });
          ws.send(JSON.stringify({ type: "tool_call", id: event.id, name: event.name, input: event.input }));
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
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "tool_result", id: tc.id, name: tc.name, result: result.slice(0, 500) }));
        }
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
        tokensIn: usage.input_tokens,
        tokensOut: usage.output_tokens,
      });
    }

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "done", conversationId: convId, usage }));
    }
  } catch (err) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: err.message }));
    }
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
