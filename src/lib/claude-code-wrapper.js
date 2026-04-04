/**
 * Claude Code CLI Wrapper
 * Uses the official Agent SDK to spawn Claude Code CLI with subscription auth.
 * Provides a clean interface for Tarsee to interact with Claude.
 */

import { query, listSessions } from "@anthropic-ai/claude-agent-sdk";
import config from "../config/env.js";

export class ClaudeCodeWrapper {
  constructor(options = {}) {
    this.defaultCwd = options.cwd || config.CLAUDE_WORKSPACE_DIR || process.cwd();
    this.defaultModel = options.model || config.CLAUDE_DEFAULT_MODEL || "claude-sonnet-4-6";
  }

  /**
   * Execute a task using Claude Code CLI
   * @param {string} prompt - The user's prompt
   * @param {object} options - Execution options
   * @param {string} [options.cwd] - Working directory
   * @param {string} [options.model] - Model to use
   * @param {string[]} [options.tools] - Available tools
   * @param {string[]} [options.allowedTools] - Pre-approved tools
   * @param {string} [options.permissionMode] - Permission mode (acceptEdits, requireConfirm)
   * @param {number} [options.maxTurns] - Maximum conversation turns
   * @param {string} [options.sessionId] - Session ID to resume
   * @yields {object} - Message objects from Claude
   */
  async* executeTask(prompt, options = {}) {
    const cwd = options.cwd || this.defaultCwd;
    const model = options.model || this.defaultModel;
    const tools = options.tools || ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];
    const allowedTools = options.allowedTools || ["Read", "Edit"];
    const permissionMode = options.permissionMode || "acceptEdits";
    const maxTurns = options.maxTurns || 10;

    console.log(`[claude-wrapper] Executing task in ${cwd}`);
    console.log(`[claude-wrapper] Model: ${model}, Max turns: ${maxTurns}`);
    console.log(`[claude-wrapper] Tools: ${tools.join(", ")}`);
    console.log(`[claude-wrapper] Allowed tools: ${allowedTools.join(", ")}`);

    const queryOptions = {
      cwd,
      model,
      tools,
      allowedTools,
      permissionMode,
      maxTurns,
    };

    // Add session resumption if provided
    if (options.sessionId) {
      queryOptions.resume = options.sessionId;
      console.log(`[claude-wrapper] Resuming session: ${options.sessionId}`);
    }

    try {
      for await (const message of query({ prompt, options: queryOptions })) {
        // Forward all message types to the caller
        yield message;

        // Log important events
        if (message.type === "result") {
          console.log(`[claude-wrapper] Task complete. Usage:`, message.usage);
          console.log(`[claude-wrapper] Session ID: ${message.sessionId}`);
        } else if (message.type === "error") {
          console.error(`[claude-wrapper] Error:`, message.error);
        } else if (message.type === "tool_use_summary") {
          console.log(`[claude-wrapper] Tool: ${message.tool}, Status: ${message.status}`);
        }
      }
    } catch (error) {
      console.error(`[claude-wrapper] Exception:`, error);
      yield {
        type: "error",
        error: error.message,
        stack: error.stack,
      };
    }
  }

  /**
   * List all sessions in a project directory
   * @param {string} projectDir - Project directory path
   * @returns {Promise<Array>} - Array of session objects
   */
  async listSessions(projectDir) {
    try {
      const sessions = await listSessions({ dir: projectDir || this.defaultCwd });
      console.log(`[claude-wrapper] Found ${sessions.length} sessions`);
      return sessions;
    } catch (error) {
      console.error(`[claude-wrapper] Failed to list sessions:`, error);
      return [];
    }
  }

  /**
   * Get messages from a specific session
   * Note: Session message retrieval is handled internally by the SDK during resumption
   * @param {string} sessionId - Session ID
   * @returns {Promise<object>} - Session info
   */
  async getSessionInfo(sessionId) {
    try {
      const sessions = await this.listSessions(this.defaultCwd);
      const session = sessions.find(s => s.id === sessionId);
      if (session) {
        console.log(`[claude-wrapper] Found session ${sessionId}`);
        return session;
      }
      console.log(`[claude-wrapper] Session ${sessionId} not found`);
      return null;
    } catch (error) {
      console.error(`[claude-wrapper] Failed to get session info:`, error);
      return null;
    }
  }

  /**
   * Resume a previous session with a new prompt
   * @param {string} sessionId - Session ID to resume
   * @param {string} prompt - New prompt to continue with
   * @param {object} options - Additional options (same as executeTask)
   * @yields {object} - Message objects from Claude
   */
  async* resumeSession(sessionId, prompt, options = {}) {
    console.log(`[claude-wrapper] Resuming session ${sessionId} with new prompt`);
    yield* this.executeTask(prompt, { ...options, sessionId });
  }
}

/**
 * Singleton instance for convenience
 */
export const claudeWrapper = new ClaudeCodeWrapper();
