import crypto from "node:crypto";
import { chatStream } from "../ai/router.js";
import { buildSystemPrompt } from "./build-system-prompt.js";
import { getToolDefinitions, executeTool } from "./tools.js";
import { getAgent, getAgentWorkspace } from "./agent-registry.js";
import fs from "node:fs";

/**
 * Subagent manager — spawns background AI agents that run independently.
 * Each agent can use a different model and system prompt based on its definition.
 */

const agents = new Map();
const taskQueue = new Map(); // agentId → [{ task, name, agentId, ctx, resolve }]
const MAX_AGENTS = 10;
const MAX_TOOL_ROUNDS = 15;

// Event listeners for agent state changes (UI updates)
const listeners = new Set();

export function onAgentEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(event, data) { for (const fn of listeners) fn(event, data); }

/**
 * Check if an agent type is currently busy.
 */
function isAgentBusy(agentId) {
  if (!agentId) return false;
  for (const a of agents.values()) {
    if (a.agentId === agentId && a.status === "running") return true;
  }
  return false;
}

/**
 * Process the next queued task for an agent type.
 */
function processQueue(agentId) {
  if (!agentId) return;
  const queue = taskQueue.get(agentId);
  if (!queue || queue.length === 0) return;
  if (isAgentBusy(agentId)) return; // still busy

  const next = queue.shift();
  if (queue.length === 0) taskQueue.delete(agentId);

  console.log(`[queue] Dequeuing task for ${agentId}: "${next.task.slice(0, 60)}..." (${queue.length} remaining)`);
  const result = startAgent(next);
  next.resolve?.(result);
}

/**
 * Spawn a new background subagent. Queues if agent type is busy.
 * @param {string} task - The task description
 * @param {string} [name] - Human-friendly name
 * @param {string} [agentId] - Agent definition ID (coder, researcher, etc.)
 * @param {object} ctx - { settingsStore, db, channelManager }
 */
export function spawnAgent({ task, name, agentId, settingsStore, db, channelManager }) {
  // Clean up old completed agents (keep last 5 for result retrieval)
  const completed = [...agents.entries()].filter(([, a]) => a.status !== "running");
  if (completed.length > 5) {
    for (const [id] of completed.slice(0, completed.length - 5)) agents.delete(id);
  }

  // If this agent type is already busy, queue the task
  if (agentId && isAgentBusy(agentId)) {
    const queue = taskQueue.get(agentId) || [];
    const taskId = crypto.randomUUID().slice(0, 8);
    const agentDef = getAgent(agentId);

    const queuedAgent = {
      id: taskId,
      agentId,
      name: name || agentDef?.name || `agent-${taskId}`,
      icon: agentDef?.icon || "🤖",
      task,
      model: agentDef?.model || null,
      status: "queued",
      result: null,
      error: null,
      toolsUsed: 0,
      lastTool: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    agents.set(taskId, queuedAgent);
    persistTask(db, queuedAgent);

    queue.push({ task, name, agentId, settingsStore, db, channelManager, taskId });
    taskQueue.set(agentId, queue);

    const pos = queue.length;
    console.log(`[queue] ${agentDef?.name || agentId} is busy — queued task "${task.slice(0, 60)}..." (position ${pos})`);
    emit("queued", { id: taskId, name: queuedAgent.name, task, position: pos });

    return { taskId, name: queuedAgent.name, agentId, queued: true, position: pos };
  }

  return startAgent({ task, name, agentId, settingsStore, db, channelManager });
}

/**
 * Internal: actually start an agent (no queue check).
 */
function startAgent({ task, name, agentId, settingsStore, db, channelManager, taskId: existingTaskId }) {
  if (agents.size >= MAX_AGENTS) {
    throw new Error(`Too many agents (max ${MAX_AGENTS}). Stop or wait for existing ones.`);
  }

  const agentDef = agentId ? getAgent(agentId) : null;
  const taskId = existingTaskId || crypto.randomUUID().slice(0, 8);
  const controller = new AbortController();

  // Update existing queued agent or create new
  let agent = agents.get(taskId);
  if (agent) {
    agent.status = "running";
    agent.abortController = controller;
  } else {
    agent = {
      id: taskId,
      agentId: agentId || null,
      name: name || agentDef?.name || `agent-${taskId}`,
      icon: agentDef?.icon || "🤖",
      task,
      model: agentDef?.model || null,
      status: "running",
      result: null,
      error: null,
      toolsUsed: 0,
      lastTool: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      abortController: controller,
    };
    agents.set(taskId, agent);
  }

  emit("started", { id: taskId, name: agent.name, task });
  persistTask(db, agent);

  // Run in background — process queue when done
  runAgent(agent, { settingsStore, db, channelManager, signal: controller.signal })
    .catch((err) => {
      agent.status = "failed";
      agent.error = err.message;
      agent.completedAt = new Date().toISOString();
      persistTask(db, agent);
      emit("completed", { id: taskId, name: agent.name, status: "failed", error: err.message });
      console.error(`[agent:${agent.name}] failed: ${err.message}`);
    })
    .finally(() => {
      // Process next queued task for this agent type
      if (agentId) processQueue(agentId);
    });

  return { taskId, name: agent.name, agentId: agent.agentId };
}

/**
 * Persist agent task to SQLite.
 */
function persistTask(db, agent) {
  try {
    db?.prepare(`
      INSERT OR REPLACE INTO agent_tasks (id, agent_id, name, task, status, model, result, error, tools_used, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(agent.id, agent.agentId, agent.name, agent.task, agent.status, agent.model, agent.result, agent.error, agent.toolsUsed, agent.startedAt, agent.completedAt);
  } catch { /* ignore if table doesn't exist yet */ }
}

/**
 * Run the subagent's AI loop with its own model and prompt.
 */
async function runAgent(agent, { settingsStore, db, channelManager, signal }) {
  const agentDef = agent.agentId ? getAgent(agent.agentId) : null;

  // Agent-specific workspace with its own memory
  const agentWorkspace = agent.agentId ? getAgentWorkspace(agent.agentId) : null;
  let agentMemory = "";
  if (agentWorkspace) {
    try {
      const memPath = `${agentWorkspace}/MEMORY.md`;
      if (fs.existsSync(memPath)) agentMemory = fs.readFileSync(memPath, "utf8");
    } catch { /* ignore */ }
  }

  const agentContext = agentDef
    ? `${agentDef.prompt}\n\n${agentMemory ? `## Your Memory\n${agentMemory}\n` : ""}Your task:\n${agent.task}\n\nWork independently. Save important findings to your MEMORY.md. When done, provide a clear summary.`
    : `You are "${agent.name}". Your task:\n\n${agent.task}\n\nWork independently. Be thorough.`;

  const systemPrompt = buildSystemPrompt({
    settingsStore,
    db,
    conversationId: null,
    messageCount: 0,
    conversationPrompt: agentContext,
  });

  const tools = getToolDefinitions();
  const toolCtx = { db, settingsStore, conversationId: null, channelManager };

  let messages = [{ role: "user", content: agent.task }];
  let fullResponse = "";

  // Use agent-specific model
  const model = agentDef?.model || settingsStore.getActiveProvider()?.model;

  console.log(`[agent:${agent.name}] started (${model || "default"}): ${agent.task.slice(0, 80)}`);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) {
      agent.status = "stopped";
      agent.completedAt = new Date().toISOString();
      persistTask(db, agent);
      emit("completed", { id: agent.id, name: agent.name, status: "stopped" });
      return;
    }

    const toolCalls = [];
    let roundText = "";
    let stopReason = "end_turn";

    const stream = chatStream({
      provider: "claude-code",
      model,
      messages,
      systemPrompt,
      signal,
      tools,
      toolCtx,
    });

    for await (const event of stream) {
      if (event.type === "text") {
        roundText += event.content;
        fullResponse += event.content;
      } else if (event.type === "tool_use") {
        toolCalls.push({ id: event.id, name: event.name, input: event.input });
        agent.toolsUsed++;
        agent.lastTool = event.name;
        emit("progress", { id: agent.id, name: agent.name, toolsUsed: agent.toolsUsed, lastTool: event.name });
      } else if (event.type === "done") {
        stopReason = event.stopReason || "end_turn";
        break;
      }
    }

    if (toolCalls.length === 0 || stopReason !== "tool_use") break;

    const assistantContent = [];
    if (roundText) assistantContent.push({ type: "text", text: roundText });
    for (const tc of toolCalls) {
      assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults = [];
    for (const tc of toolCalls) {
      console.log(`[agent:${agent.name}] tool: ${tc.name}`);
      const result = await executeTool(tc.name, tc.input, toolCtx);
      toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  agent.status = "completed";
  agent.result = fullResponse;
  agent.completedAt = new Date().toISOString();
  persistTask(db, agent);
  emit("completed", { id: agent.id, name: agent.name, status: "completed", resultPreview: fullResponse.slice(0, 200) });

  // Save task summary to agent's persistent memory
  if (agentWorkspace && fullResponse) {
    try {
      const memPath = `${agentWorkspace}/MEMORY.md`;
      const date = new Date().toISOString().split("T")[0];
      const summary = `\n## ${date} — ${agent.task.slice(0, 80)}\n${fullResponse.slice(0, 500)}\n`;
      fs.appendFileSync(memPath, summary);
    } catch { /* ignore */ }
  }

  console.log(`[agent:${agent.name}] completed (${fullResponse.length} chars, ${agent.toolsUsed} tools)`);
}

export function listAgents() {
  return [...agents.values()].map((a) => ({
    id: a.id,
    agentId: a.agentId,
    name: a.name,
    icon: a.icon,
    model: a.model,
    status: a.status,
    task: a.task.slice(0, 100),
    toolsUsed: a.toolsUsed,
    lastTool: a.lastTool,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    resultPreview: a.result?.slice(0, 200) || a.error || null,
  }));
}

export function getAgentResult(taskId) {
  const agent = agents.get(taskId);
  if (!agent) return null;
  return {
    id: agent.id,
    agentId: agent.agentId,
    name: agent.name,
    icon: agent.icon,
    model: agent.model,
    status: agent.status,
    task: agent.task,
    result: agent.result,
    error: agent.error,
    toolsUsed: agent.toolsUsed,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
  };
}

export function stopAgent(taskId) {
  const agent = agents.get(taskId);
  if (!agent) return false;
  if (agent.status === "running") {
    agent.abortController.abort();
    agent.status = "stopped";
    agent.completedAt = new Date().toISOString();
    emit("completed", { id: taskId, name: agent.name, status: "stopped" });
  }
  return true;
}

/**
 * Get recent tasks from DB (for history).
 */
export function getRecentTasks(db, limit = 20) {
  try {
    return db?.prepare("SELECT * FROM agent_tasks ORDER BY started_at DESC LIMIT ?").all(limit) || [];
  } catch {
    return [];
  }
}
