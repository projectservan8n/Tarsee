import crypto from "node:crypto";
import { chatStream } from "../ai/router.js";
import { buildSystemPrompt } from "./build-system-prompt.js";
import { getToolDefinitions, executeTool } from "./tools.js";

/**
 * Subagent manager — spawns background AI agents that run independently.
 * Each subagent gets its own conversation loop with tool access.
 */

const agents = new Map(); // taskId → { name, status, result, error, startedAt, completedAt, abortController }
const MAX_AGENTS = 10;
const MAX_TOOL_ROUNDS = 10;

/**
 * Spawn a new background subagent.
 */
export function spawnAgent({ task, name, settingsStore, db }) {
  if (agents.size >= MAX_AGENTS) {
    // Clean up completed agents
    for (const [id, a] of agents) {
      if (a.status !== "running") agents.delete(id);
    }
    if (agents.size >= MAX_AGENTS) {
      throw new Error(`Too many agents (max ${MAX_AGENTS}). Stop or wait for existing ones.`);
    }
  }

  const taskId = crypto.randomUUID().slice(0, 8);
  const controller = new AbortController();

  const agent = {
    id: taskId,
    name: name || `agent-${taskId}`,
    task,
    status: "running",
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    abortController: controller,
  };

  agents.set(taskId, agent);

  // Run in background
  runAgent(agent, { settingsStore, db, signal: controller.signal }).catch((err) => {
    agent.status = "failed";
    agent.error = err.message;
    agent.completedAt = new Date().toISOString();
    console.error(`[subagent:${agent.name}] failed: ${err.message}`);
  });

  return { taskId, name: agent.name };
}

/**
 * Run the subagent's AI loop.
 */
async function runAgent(agent, { settingsStore, db, signal }) {
  const activeProvider = settingsStore.getActiveProvider();
  if (!activeProvider?.provider || !activeProvider?.apiKey) {
    throw new Error("No AI provider configured");
  }

  const systemPrompt = buildSystemPrompt({
    settingsStore,
    db,
    conversationId: null,
    messageCount: 0,
    conversationPrompt: `You are a background subagent named "${agent.name}". Your task:\n\n${agent.task}\n\nWork independently using your tools. Be thorough and report your findings clearly. When done, provide a clear summary of results.`,
  });

  const tools = getToolDefinitions();
  const toolCtx = { db, settingsStore, conversationId: null };

  let messages = [{ role: "user", content: agent.task }];
  let fullResponse = "";

  console.log(`[subagent:${agent.name}] started: ${agent.task.slice(0, 100)}`);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) {
      agent.status = "stopped";
      agent.completedAt = new Date().toISOString();
      return;
    }

    const toolCalls = [];
    let roundText = "";
    let stopReason = "end_turn";

    const stream = chatStream({
      provider: activeProvider.provider,
      model: activeProvider.model,
      apiKey: activeProvider.apiKey,
      baseUrl: activeProvider.baseUrl,
      messages,
      systemPrompt,
      signal,
      tools,
    });

    for await (const event of stream) {
      if (event.type === "text") {
        roundText += event.content;
        fullResponse += event.content;
      } else if (event.type === "tool_use") {
        toolCalls.push({ id: event.id, name: event.name, input: event.input });
      } else if (event.type === "done") {
        stopReason = event.stopReason || "end_turn";
        break;
      }
    }

    if (toolCalls.length === 0 || stopReason !== "tool_use") break;

    // Build assistant content + execute tools
    const assistantContent = [];
    if (roundText) assistantContent.push({ type: "text", text: roundText });
    for (const tc of toolCalls) {
      assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults = [];
    for (const tc of toolCalls) {
      console.log(`[subagent:${agent.name}] tool: ${tc.name}`);
      const result = await executeTool(tc.name, tc.input, toolCtx);
      toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  agent.status = "completed";
  agent.result = fullResponse;
  agent.completedAt = new Date().toISOString();
  console.log(`[subagent:${agent.name}] completed (${fullResponse.length} chars)`);
}

/**
 * List all agents.
 */
export function listAgents() {
  return [...agents.values()].map((a) => ({
    id: a.id,
    name: a.name,
    status: a.status,
    task: a.task.slice(0, 100),
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    resultPreview: a.result?.slice(0, 200) || a.error || null,
  }));
}

/**
 * Get full result of an agent.
 */
export function getAgentResult(taskId) {
  const agent = agents.get(taskId);
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    task: agent.task,
    result: agent.result,
    error: agent.error,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
  };
}

/**
 * Stop a running agent.
 */
export function stopAgent(taskId) {
  const agent = agents.get(taskId);
  if (!agent) return false;
  if (agent.status === "running") {
    agent.abortController.abort();
    agent.status = "stopped";
    agent.completedAt = new Date().toISOString();
  }
  return true;
}
