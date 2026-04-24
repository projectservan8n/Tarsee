import fs from "node:fs";
import path from "node:path";
import { resolveModelAlias } from "../config/constants.js";

/**
 * Agent Registry — manages agent definitions (Coder, Researcher, Writer, etc.)
 *
 * Each agent has: id, name, model, system prompt, allowed tools, color.
 * Stored in settings DB as "agents.registry" JSON.
 * The orchestrator (main Claude session) uses these to delegate tasks.
 *
 * Models are resolved by tier (opus/sonnet/haiku) from the central
 * CLAUDE_MODELS registry, so the defaults always point at the latest
 * model in each tier without code changes when a new one ships.
 */

const DEFAULT_AGENTS = [
  {
    id: "coder",
    name: "Coder",
    nickname: "",
    model: resolveModelAlias("opus"),
    prompt: "You are a senior software engineer. Write clean, production-grade code. Debug thoroughly. Always test your work. Use Read, Write, Edit, Bash, Grep, Glob tools. Be concise — code speaks louder than explanations.",
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    color: "#4caf50",
    icon: "ph ph-code",
    status: "online",
  },
  {
    id: "researcher",
    name: "Researcher",
    nickname: "",
    model: resolveModelAlias("sonnet"),
    prompt: "You are a thorough researcher. Search the web, read documents, analyze data, and summarize findings. Be comprehensive but concise. Cite sources. Use web_fetch, web_search, Read tools.",
    tools: ["Read", "Bash", "Glob", "Grep"],
    color: "#2196f3",
    icon: "ph ph-magnifying-glass",
    status: "online",
  },
  {
    id: "writer",
    name: "Writer",
    nickname: "",
    model: resolveModelAlias("sonnet"),
    prompt: "You are a professional writer. Draft emails, documents, reports, and content. Match the user's tone and style. Be clear, concise, and compelling. Use Read and Write tools for file output.",
    tools: ["Read", "Write", "Edit", "Bash"],
    color: "#ff9800",
    icon: "ph ph-pencil-line",
    status: "online",
  },
  {
    id: "quick",
    name: "Quick",
    nickname: "",
    model: resolveModelAlias("haiku"),
    prompt: "You are a fast assistant for simple tasks. Answer quickly, format data, do calculations, lookups. Be extremely concise — one sentence when possible.",
    tools: ["Read", "Bash", "Grep"],
    color: "#9c27b0",
    icon: "ph ph-lightning",
    status: "online",
  },
];

let _settingsStore = null;

export function initAgentRegistry(settingsStore) {
  _settingsStore = settingsStore;
  // Seed defaults if no agents exist
  const existing = getAgents();
  if (existing.length === 0) {
    _settingsStore.set("agents.registry", JSON.stringify(DEFAULT_AGENTS));
  }

  // Create workspace dirs for each agent
  ensureAgentWorkspaces();
}

/**
 * Create workspace directories for all agents.
 * Each agent gets: /data/tarsee/agents/{id}/ with MEMORY.md, SOUL.md
 */
export function ensureAgentWorkspaces() {
  const baseDir = getAgentsBaseDir();
  for (const agent of getAgents()) {
    if (agent.isOrchestrator) continue;
    const agentDir = path.join(baseDir, agent.id);
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const memPath = path.join(agentDir, "MEMORY.md");
      if (!fs.existsSync(memPath)) {
        fs.writeFileSync(memPath, `# ${agent.name} Memory\n\nTask history and learned knowledge.\n`);
      }
      const soulPath = path.join(agentDir, "SOUL.md");
      if (!fs.existsSync(soulPath)) {
        fs.writeFileSync(soulPath, `# ${agent.name}\n\n${agent.prompt}\n`);
      }
    } catch { /* ignore */ }
  }
}

/**
 * Get the base directory for agent workspaces.
 */
export function getAgentsBaseDir() {
  return path.join(process.env.TARSEE_STATE_DIR || process.env.HOME || "/data/tarsee", "agents");
}

/**
 * Get workspace directory for a specific agent.
 */
export function getAgentWorkspace(agentId) {
  return path.join(getAgentsBaseDir(), agentId);
}

/**
 * Get all agent definitions.
 */
export function getAgents() {
  if (!_settingsStore) return DEFAULT_AGENTS;
  try {
    const raw = _settingsStore.get("agents.registry");
    if (!raw) return DEFAULT_AGENTS;
    const agents = typeof raw === "string" ? JSON.parse(raw) : raw;
    // Filter out legacy orchestrator entry — main chat agent IS the orchestrator
    return Array.isArray(agents) ? agents.filter(a => !a.isOrchestrator) : DEFAULT_AGENTS;
  } catch {
    return DEFAULT_AGENTS;
  }
}

/**
 * Get a single agent by ID or nickname.
 */
export function getAgent(idOrNickname) {
  const agents = getAgents();
  return agents.find(a => a.id === idOrNickname || (a.nickname && a.nickname.toLowerCase() === idOrNickname.toLowerCase())) || null;
}

/**
 * Add or update an agent definition.
 */
export function upsertAgent(agent) {
  if (!agent.id || !agent.name || !agent.model) {
    throw new Error("Agent must have id, name, and model");
  }
  const agents = getAgents();
  const idx = agents.findIndex(a => a.id === agent.id);
  if (idx >= 0) {
    agents[idx] = { ...agents[idx], ...agent };
  } else {
    agents.push(agent);
  }
  _settingsStore?.set("agents.registry", JSON.stringify(agents));
  return agent;
}

/**
 * Remove an agent definition.
 */
export function removeAgent(id) {
  const agents = getAgents().filter(a => a.id !== id);
  _settingsStore?.set("agents.registry", JSON.stringify(agents));
  return true;
}

/**
 * Get a brief summary of available agents (for system prompt injection).
 */
export function getAgentsSummary() {
  const agents = getAgents();
  return agents.map(a => {
    const nick = a.nickname ? ` aka "${a.nickname}"` : "";
    return `- ${a.icon || "🤖"} ${a.name}${nick} (${a.id}): ${a.model} — ${a.prompt.slice(0, 60)}`;
  }).join("\n");
}
