/**
 * Claude Code CLI REST API routes
 * Provides endpoints for executing tasks, managing sessions, etc.
 */

import express from "express";
import { ClaudeCodeWrapper } from "../lib/claude-code-wrapper.js";
import { sessionAuth, requireAuth } from "../middleware/auth.js";
import config from "../config/env.js";

const router = express.Router();

/**
 * POST /api/claude-code/execute
 * Execute a new task using Claude Code CLI
 */
router.post("/execute", sessionAuth, requireAuth, async (req, res) => {
  const { prompt, cwd, tools, allowedTools, model, maxTurns, permissionMode } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Missing required field: prompt" });
  }

  // Set up Server-Sent Events for streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

  const wrapper = new ClaudeCodeWrapper();
  let sessionId = null;

  try {
    const options = {
      cwd: cwd || config.CLAUDE_WORKSPACE_DIR,
      tools,
      allowedTools,
      model: model || config.CLAUDE_DEFAULT_MODEL,
      maxTurns: maxTurns || 10,
      permissionMode: permissionMode || "acceptEdits",
    };

    for await (const message of wrapper.executeTask(prompt, options)) {
      // Send message as Server-Sent Event
      res.write(`data: ${JSON.stringify(message)}\n\n`);

      // Track session ID from result message
      if (message.type === "result" && message.sessionId) {
        sessionId = message.sessionId;
      }
    }

    // Send final completion event
    res.write(`data: ${JSON.stringify({ type: "complete", sessionId })}\n\n`);
    res.end();
  } catch (error) {
    console.error("[claude-code-routes] Execute error:", error);
    res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
    res.end();
  }
});

/**
 * POST /api/claude-code/resume
 * Resume a previous session with a new prompt
 */
router.post("/resume", sessionAuth, requireAuth, async (req, res) => {
  const { sessionId, prompt, cwd, tools, allowedTools, model, maxTurns } = req.body;

  if (!sessionId || !prompt) {
    return res.status(400).json({ error: "Missing required fields: sessionId, prompt" });
  }

  // Set up Server-Sent Events for streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const wrapper = new ClaudeCodeWrapper();

  try {
    const options = {
      sessionId, // This tells the wrapper to resume the session
      cwd: cwd || config.CLAUDE_WORKSPACE_DIR,
      tools,
      allowedTools,
      model: model || config.CLAUDE_DEFAULT_MODEL,
      maxTurns: maxTurns || 10,
    };

    for await (const message of wrapper.executeTask(prompt, options)) {
      res.write(`data: ${JSON.stringify(message)}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: "complete", sessionId })}\n\n`);
    res.end();
  } catch (error) {
    console.error("[claude-code-routes] Resume error:", error);
    res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
    res.end();
  }
});

/**
 * GET /api/claude-code/sessions
 * List all sessions in the workspace
 */
router.get("/sessions", sessionAuth, requireAuth, async (req, res) => {
  const { projectDir } = req.query;

  const wrapper = new ClaudeCodeWrapper();

  try {
    const sessions = await wrapper.listSessions(projectDir || config.CLAUDE_WORKSPACE_DIR);
    res.json({
      sessions,
      projectDir: projectDir || config.CLAUDE_WORKSPACE_DIR,
    });
  } catch (error) {
    console.error("[claude-code-routes] List sessions error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/claude-code/sessions/:id
 * Get details of a specific session
 */
router.get("/sessions/:id", sessionAuth, requireAuth, async (req, res) => {
  const { id } = req.params;
  const { projectDir } = req.query;

  const wrapper = new ClaudeCodeWrapper();

  try {
    const messages = await wrapper.getSessionMessages(id, projectDir || config.CLAUDE_WORKSPACE_DIR);
    res.json({
      sessionId: id,
      messages,
      projectDir: projectDir || config.CLAUDE_WORKSPACE_DIR,
    });
  } catch (error) {
    console.error("[claude-code-routes] Get session error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/claude-code/status
 * Check Claude Code CLI status and configuration
 */
router.get("/status", sessionAuth, requireAuth, async (req, res) => {
  res.json({
    mode: config.CLAUDE_CLI_MODE,
    workspace: config.CLAUDE_WORKSPACE_DIR,
    defaultModel: config.CLAUDE_DEFAULT_MODEL,
    sessionDir: config.CLAUDE_SESSION_DIR,
    agentSdkInstalled: true, // If this route loads, SDK is installed
  });
});

export default router;
