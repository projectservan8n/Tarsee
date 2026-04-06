/**
 * ACP (Agent Control Protocol) HTTP routes for Tarsee.
 */
import { Router } from "express";
import { getACPServer } from "../lib/acp.js";
import { chatStream } from "../ai/router.js";
import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { SettingsStore } from "../db/settings.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";

export const acpRouter = Router();

let settingsStore = null;

acpRouter.use((req, _res, next) => {
  if (!settingsStore) settingsStore = new SettingsStore(req.app.get("db"), req.app.get("auditLog"));
  next();
});

// Create session
acpRouter.post("/session", (req, res) => {
  const acp = getACPServer();
  const session = acp.createSession(req.body?.identity || {});
  res.status(201).json(session.toJSON());
});

// List sessions
acpRouter.get("/sessions", (_req, res) => {
  const acp = getACPServer();
  res.json({ sessions: acp.listSessions() });
});

// Get session status
acpRouter.get("/session/:id/status", (req, res) => {
  const acp = getACPServer();
  const session = acp.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session.toJSON());
});

// Destroy session
acpRouter.delete("/session/:id", (req, res) => {
  const acp = getACPServer();
  const destroyed = acp.destroySession(req.params.id);
  if (!destroyed) return res.status(404).json({ error: "Session not found" });
  res.json({ ok: true });
});

// Execute a turn
acpRouter.post("/session/:id/turn", async (req, res) => {
  const acp = getACPServer();
  const session = acp.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  if (!acp.checkRateLimit(session.id)) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  session.startTurn();
  session.addMessage("user", message);

  const activeProvider = settingsStore.getActiveProvider();
  if (!activeProvider?.ready) {
    return res.status(400).json({ error: "No AI provider configured" });
  }

  const systemPrompt = buildSystemPrompt({ settingsStore, db: req.app.get("db"), messageCount: session.messages.length, channelHint: `ACP session: ${session.identity.clientName || "unknown"}` });
  const tools = getToolDefinitions();
  const toolCtx = { db: req.app.get("db"), settingsStore };

  let fullResponse = "";
  let workingMessages = session.messages.map((m) => ({ role: m.role, content: m.content }));

  try {
    for (let round = 0; round < 10; round++) {
      const toolCalls = [];
      let roundText = "", stopReason = "end_turn";
      const toolCtx = { db: req.app.get("db"), settingsStore, conversationId: null, channelManager: req.app.get("channelManager") };
      const stream = chatStream({ provider: activeProvider.provider, model: activeProvider.model, messages: workingMessages, systemPrompt, tools, toolCtx });
      for await (const event of stream) {
        if (event.type === "text") { roundText += event.content; fullResponse += event.content; }
        else if (event.type === "tool_use") toolCalls.push({ id: event.id, name: event.name, input: event.input });
        else if (event.type === "done") { stopReason = event.stopReason || "end_turn"; break; }
      }
      if (toolCalls.length === 0 || stopReason !== "tool_use") break;
      const ac = []; if (roundText) ac.push({ type: "text", text: roundText });
      for (const tc of toolCalls) ac.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      workingMessages.push({ role: "assistant", content: ac });
      const tr = [];
      for (const tc of toolCalls) { tr.push({ type: "tool_result", tool_use_id: tc.id, content: await executeTool(tc.name, tc.input, toolCtx) }); }
      workingMessages.push({ role: "user", content: tr });
    }

    session.addMessage("assistant", fullResponse);
    session.endTurn(fullResponse);
    res.json({ turn: session.turnCount, response: fullResponse, session: session.toJSON() });
  } catch (err) {
    session.endTurn(null);
    res.status(500).json({ error: err.message });
  }
});
