import crypto from "node:crypto";
import { chatStream } from "../ai/router.js";
import { buildSystemPrompt } from "./build-system-prompt.js";
import { getToolDefinitions, executeTool } from "./tools.js";
import { getAgent, getAgentWorkspace } from "./agent-registry.js";
import { ConversationStore } from "../db/conversations.js";
import fs from "node:fs";

/**
 * Subagent manager — spawns background AI agents that run independently.
 * Each agent has a persistent session, visible conversation, and task queue.
 */

const agents = new Map();
const taskQueue = new Map(); // agentId → [{ task, name, agentId, ctx, resolve }]
const agentSessions = new Map(); // agentId → { sessionId, lastActive }
const MAX_AGENTS = 10;
const MAX_TOOL_ROUNDS = 15;
const SESSION_IDLE_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours

// Event listeners for agent state changes (UI updates)
const listeners = new Set();

export function onAgentEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(event, data) { for (const fn of listeners) fn(event, data); }

// --- Persistent Sessions ---

function loadAgentSessions(settingsStore) {
  if (!settingsStore) return;
  try {
    const raw = settingsStore.get("agent.sessions");
    if (!raw) return;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    for (const [k, v] of Object.entries(parsed)) {
      agentSessions.set(k, v);
    }
  } catch { /* ignore */ }
}

function saveAgentSessions(settingsStore) {
  if (!settingsStore) return;
  try {
    const obj = Object.fromEntries(agentSessions);
    settingsStore.set("agent.sessions", JSON.stringify(obj));
  } catch { /* ignore */ }
}

function getAgentSessionId(agentId, settingsStore) {
  if (!agentId) return null;
  if (agentSessions.size === 0) loadAgentSessions(settingsStore);

  const session = agentSessions.get(agentId);
  if (!session?.sessionId) return null;

  // Check idle timeout
  if (Date.now() - (session.lastActive || 0) > SESSION_IDLE_TIMEOUT) {
    agentSessions.delete(agentId);
    saveAgentSessions(settingsStore);
    console.log(`[agent:${agentId}] session expired (idle >2hr)`);
    return null;
  }
  return session.sessionId;
}

function setAgentSessionId(agentId, sessionId, settingsStore) {
  if (!agentId || !sessionId) return;
  agentSessions.set(agentId, { sessionId, lastActive: Date.now() });
  saveAgentSessions(settingsStore);
}

// --- Agent Conversations (visible in sidebar) ---

function getOrCreateAgentConversation(agentId, db, settingsStore) {
  if (!agentId || !db || !settingsStore) return null;
  const channelKey = `channel_conv.agent:${agentId}`;
  let convId = settingsStore.get(channelKey);

  const convStore = new ConversationStore(db);
  if (convId && convStore.get(convId)) return { convStore, convId };

  // Create new conversation for this agent
  const agentDef = getAgent(agentId);
  const nick = agentDef?.nickname ? ` (${agentDef.nickname})` : "";
  const conv = convStore.create({ title: `${agentDef?.name || agentId}${nick}` });
  convId = conv.id;
  settingsStore.set(channelKey, convId);
  console.log(`[agent:${agentId}] created conversation: ${convId}`);
  return { convStore, convId };
}

// --- Queue ---

function isAgentBusy(agentId) {
  if (!agentId) return false;
  for (const a of agents.values()) {
    if (a.agentId === agentId && a.status === "running") return true;
  }
  return false;
}

function processQueue(agentId) {
  if (!agentId) return;
  const queue = taskQueue.get(agentId);
  if (!queue || queue.length === 0) return;
  if (isAgentBusy(agentId)) return;

  const next = queue.shift();
  if (queue.length === 0) taskQueue.delete(agentId);

  console.log(`[queue] Dequeuing task for ${agentId}: "${next.task.slice(0, 60)}..." (${queue.length} remaining)`);
  const result = startAgent(next);
  next.resolve?.(result);
}

// --- Spawn / Start ---

export function spawnAgent({ task, name, agentId, settingsStore, db, channelManager }) {
  // Clean up old completed agents (keep last 5)
  const completed = [...agents.entries()].filter(([, a]) => a.status !== "running" && a.status !== "queued");
  if (completed.length > 5) {
    for (const [id] of completed.slice(0, completed.length - 5)) agents.delete(id);
  }

  // If this agent type is already busy, queue the task
  if (agentId && isAgentBusy(agentId)) {
    const queue = taskQueue.get(agentId) || [];
    const taskId = crypto.randomUUID().slice(0, 8);
    const agentDef = getAgent(agentId);

    const queuedAgent = {
      id: taskId, agentId,
      name: name || agentDef?.name || `agent-${taskId}`,
      icon: agentDef?.icon || "🤖",
      task, model: agentDef?.model || null,
      status: "queued", result: null, error: null,
      toolsUsed: 0, lastTool: null,
      startedAt: new Date().toISOString(), completedAt: null,
    };
    agents.set(taskId, queuedAgent);
    persistTask(db, queuedAgent);

    // Log to agent conversation
    const ac = getOrCreateAgentConversation(agentId, db, settingsStore);
    if (ac) ac.convStore.addMessage(ac.convId, { role: "user", content: `[Queued] ${task}` });

    queue.push({ task, name, agentId, settingsStore, db, channelManager, taskId });
    taskQueue.set(agentId, queue);

    const pos = queue.length;
    console.log(`[queue] ${agentDef?.name || agentId} busy — queued "${task.slice(0, 60)}..." (pos ${pos})`);
    emit("queued", { id: taskId, name: queuedAgent.name, task, position: pos });

    return { taskId, name: queuedAgent.name, agentId, queued: true, position: pos };
  }

  return startAgent({ task, name, agentId, settingsStore, db, channelManager });
}

function startAgent({ task, name, agentId, settingsStore, db, channelManager, taskId: existingTaskId }) {
  if (agents.size >= MAX_AGENTS) {
    throw new Error(`Too many agents (max ${MAX_AGENTS}). Stop or wait for existing ones.`);
  }

  const agentDef = agentId ? getAgent(agentId) : null;
  const taskId = existingTaskId || crypto.randomUUID().slice(0, 8);
  const controller = new AbortController();

  let agent = agents.get(taskId);
  if (agent) {
    agent.status = "running";
    agent.abortController = controller;
  } else {
    agent = {
      id: taskId, agentId: agentId || null,
      name: name || agentDef?.name || `agent-${taskId}`,
      icon: agentDef?.icon || "🤖",
      task, model: agentDef?.model || null,
      status: "running", result: null, error: null,
      toolsUsed: 0, lastTool: null,
      startedAt: new Date().toISOString(), completedAt: null,
      abortController: controller,
    };
    agents.set(taskId, agent);
  }

  emit("started", { id: taskId, name: agent.name, task });
  persistTask(db, agent);

  // Log task to agent conversation
  const ac = getOrCreateAgentConversation(agentId, db, settingsStore);
  if (ac) ac.convStore.addMessage(ac.convId, { role: "user", content: `[Task] ${task}` });

  // Run in background
  runAgent(agent, { settingsStore, db, channelManager, signal: controller.signal })
    .catch((err) => {
      agent.status = "failed";
      agent.error = err.message;
      agent.completedAt = new Date().toISOString();
      persistTask(db, agent);
      emit("completed", { id: taskId, name: agent.name, status: "failed", error: err.message });
      console.error(`[agent:${agent.name}] failed: ${err.message}`);
      // Log failure to conversation
      if (ac) ac.convStore.addMessage(ac.convId, { role: "assistant", content: `[Failed] ${err.message}`, provider: "claude-code", model: agent.model });
    })
    .finally(() => {
      if (agentId) processQueue(agentId);
    });

  return { taskId, name: agent.name, agentId: agent.agentId };
}

// --- Persistence ---

function persistTask(db, agent) {
  try {
    db?.prepare(`
      INSERT OR REPLACE INTO agent_tasks (id, agent_id, name, task, status, model, result, error, tools_used, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(agent.id, agent.agentId, agent.name, agent.task, agent.status, agent.model, agent.result, agent.error, agent.toolsUsed, agent.startedAt, agent.completedAt);
  } catch { /* ignore */ }
}

// --- Agent Runner ---

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

  const nick = agentDef?.nickname ? ` (${agentDef.nickname})` : "";
  const agentContext = agentDef
    ? `You are ${agentDef.name}${nick} — NOT Tarsee, NOT Nico. You are your own agent.\n\n${agentDef.prompt}\n\n${agentMemory ? `## Your Memory\n${agentMemory}\n` : ""}Your task:\n${agent.task}\n\nWork independently. Save important findings to your MEMORY.md. When done, provide a clear summary.`
    : `You are "${agent.name}". Your task:\n\n${agent.task}\n\nWork independently. Be thorough.`;

  const systemPrompt = buildSystemPrompt({
    settingsStore, db,
    conversationId: null,
    messageCount: 0,
    conversationPrompt: agentContext,
  });

  const tools = getToolDefinitions();
  const toolCtx = { db, settingsStore, conversationId: null, channelManager };

  let messages = [{ role: "user", content: agent.task }];
  let fullResponse = "";

  const model = agentDef?.model || settingsStore.getActiveProvider()?.model;

  // Persistent session — resume if available
  const existingSessionId = getAgentSessionId(agent.agentId, settingsStore);

  console.log(`[agent:${agent.name}] started (${model || "default"}, session: ${existingSessionId || "new"}): ${agent.task.slice(0, 80)}`);

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
      sessionId: existingSessionId || undefined,
      onSessionId: (sid) => {
        setAgentSessionId(agent.agentId, sid, settingsStore);
      },
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

  // Log result to agent conversation
  const ac = getOrCreateAgentConversation(agent.agentId, db, settingsStore);
  if (ac) {
    ac.convStore.addMessage(ac.convId, {
      role: "assistant",
      content: fullResponse || "(no output)",
      provider: "claude-code",
      model: agent.model,
    });
  }

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

// --- Public API ---

export function listAgents() {
  return [...agents.values()].map((a) => ({
    id: a.id, agentId: a.agentId, name: a.name, icon: a.icon,
    model: a.model, status: a.status, task: a.task.slice(0, 100),
    toolsUsed: a.toolsUsed, lastTool: a.lastTool,
    startedAt: a.startedAt, completedAt: a.completedAt,
    resultPreview: a.result?.slice(0, 200) || a.error || null,
  }));
}

export function getAgentResult(taskId) {
  const agent = agents.get(taskId);
  if (!agent) return null;
  return {
    id: agent.id, agentId: agent.agentId, name: agent.name, icon: agent.icon,
    model: agent.model, status: agent.status, task: agent.task,
    result: agent.result, error: agent.error, toolsUsed: agent.toolsUsed,
    startedAt: agent.startedAt, completedAt: agent.completedAt,
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

export function getRecentTasks(db, limit = 20) {
  try {
    return db?.prepare("SELECT * FROM agent_tasks ORDER BY started_at DESC LIMIT ?").all(limit) || [];
  } catch { return []; }
}

/**
 * Check if an agent has an active (non-expired) session.
 */
export function isAgentOnline(agentId) {
  const session = agentSessions.get(agentId);
  if (!session?.sessionId) return false;
  if (Date.now() - (session.lastActive || 0) > SESSION_IDLE_TIMEOUT) return false;
  return true;
}

/**
 * Get online status for all agent IDs.
 */
export function getAgentStatuses(agentIds) {
  const statuses = {};
  for (const id of agentIds) {
    const busy = isAgentBusy(id);
    statuses[id] = busy ? "working" : isAgentOnline(id) ? "online" : "offline";
  }
  return statuses;
}
