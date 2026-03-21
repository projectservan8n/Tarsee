import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { validateApiToken } from "../middleware/auth.js";
import { chatStream } from "../ai/router.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { WS_CODES } from "../config/constants.js";

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
export function setupWebSocket(server, db) {
  const wss = new WebSocketServer({ noServer: true });
  const convStore = new ConversationStore(db);
  const settingsStore = new SettingsStore(db);

  // Handle HTTP upgrade
  server.on("upgrade", (req, socket, head) => {
    // Extract token from query param or subprotocol
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");

    if (token && validateApiToken(token)) {
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
        if (validateApiToken(msg.token)) {
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

  return wss;
}

async function handleChat(ws, msg, convStore, settingsStore) {
  const { conversationId, message } = msg;

  if (!message || typeof message !== "string") {
    ws.send(JSON.stringify({ type: "error", message: "Message is required" }));
    return;
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

  // Save user message
  convStore.addMessage(convId, { role: "user", content: message });

  // Get history
  const history = convStore.getRecentMessages(convId, 50);
  const conv = convStore.get(convId);

  let fullResponse = "";
  let usage = {};

  try {
    const controller = new AbortController();

    // Abort on disconnect
    const onClose = () => controller.abort();
    ws.on("close", onClose);

    const stream = chatStream({
      provider: activeProvider.provider,
      model: activeProvider.model,
      apiKey: activeProvider.apiKey,
      baseUrl: activeProvider.baseUrl,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      systemPrompt: conv?.system_prompt,
      signal: controller.signal,
    });

    for await (const event of stream) {
      if (ws.readyState !== ws.OPEN) break;

      if (event.type === "text") {
        fullResponse += event.content;
        ws.send(JSON.stringify({ type: "text", content: event.content }));
      } else if (event.type === "usage") {
        usage = event.usage;
      }
    }

    ws.removeListener("close", onClose);

    // Save assistant message
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
