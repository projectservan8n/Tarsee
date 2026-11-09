/**
 * ACP (Agent Control Protocol) HTTP routes for Tarsee.
 */
import { Router } from "express";
import { getACPServer } from "../lib/acp.js";
import { chatStream } from "../ai/router.js";
import { buildSystemPromptParts } from "../lib/build-system-prompt.js";
import { SettingsStore } from "../db/settings.js";

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

  const { message } = req.body || {};
  if (!message || typeof message !== "string") return res.status(400).json({ error: "Message required" });

  session.startTurn();
  session.addMessage("user", message);

  const systemParts = buildSystemPromptParts({ settingsStore, db: req.app.get("db"), messageCount: session.messages.length, channelHint: `ACP session: ${session.identity.clientName || "unknown"}` });
  const toolCtx = { db: req.app.get("db"), settingsStore, conversationId: null, channelManager: req.app.get("channelManager") };
  // The session's messages, with their times; the engine resumes the session's own AI session when it can, and a
  // fresh one is handed the recent conversation (ai/turn.js).
  const messages = session.messages.map((m) => ({ role: m.role, content: m.content, createdAt: m.ts }));

  let fullResponse = "";
  let error = null;
  let stopReason = null;
  let ran = { provider: null, model: null };
  try {
    // One turn on the default AI: the engine runs its tools itself.
    for await (const event of chatStream({
      messages,
      systemParts,
      toolCtx,
      liveSource: "acp",
      sessionId: session.engineSession || null,
      onSessionId: (handle) => { session.engineSession = handle; },
    })) {
      if (event.type === "route") ran = { provider: event.provider || null, model: event.model || null };
      else if (event.type === "text") fullResponse += event.content;
      else if (event.type === "error") error = event.message || "The AI stopped with an error";
      else if (event.type === "done") { stopReason = event.stopReason || "end_turn"; break; }
    }
  } catch (err) {
    session.endTurn(null);
    return res.status(500).json({ error: err.message });
  }

  if (stopReason !== "end_turn") {
    // Not answered (the AI isn't set up, a sign-in ran out, a spending limit): the turn ends without a result.
    session.endTurn(null);
    return res.status(503).json({ error: error || `The AI stopped (${stopReason || "no reply"})`, stopReason, provider: ran.provider, model: ran.model, session: session.toJSON() });
  }
  session.addMessage("assistant", fullResponse);
  session.endTurn(fullResponse);
  res.json({ turn: session.turnCount, response: fullResponse, provider: ran.provider, model: ran.model, session: session.toJSON() });
});
