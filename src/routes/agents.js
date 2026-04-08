import { Router } from "express";
import { getAgents, getAgent, upsertAgent, removeAgent } from "../lib/agent-registry.js";
import { listAgents, getAgentResult, stopAgent, getRecentTasks, spawnAgent, getAgentStatuses } from "../lib/subagents.js";

export const agentsRouter = Router();

// --- Registry (agent definitions) ---

agentsRouter.get("/registry", (_req, res) => {
  const agents = getAgents();
  const statuses = getAgentStatuses(agents.map(a => a.id));
  res.json({ agents, statuses });
});

agentsRouter.post("/registry", (req, res) => {
  try {
    const agent = upsertAgent(req.body);
    res.json(agent);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

agentsRouter.delete("/registry/:id", (req, res) => {
  removeAgent(req.params.id);
  res.json({ ok: true });
});

// --- Tasks (running + history) ---

agentsRouter.get("/tasks", (req, res) => {
  const running = listAgents();
  const db = req.app.get("db");
  const history = getRecentTasks(db, 20);
  res.json({ running, history });
});

agentsRouter.get("/tasks/:id", (req, res) => {
  const result = getAgentResult(req.params.id);
  if (!result) return res.status(404).json({ error: "Task not found" });
  res.json(result);
});

agentsRouter.post("/tasks/:id/stop", (req, res) => {
  const stopped = stopAgent(req.params.id);
  res.json({ ok: stopped });
});

agentsRouter.post("/tasks/spawn", (req, res) => {
  const { task, name, agentId } = req.body || {};
  if (!task) return res.status(400).json({ error: "Task is required" });

  try {
    const db = req.app.get("db");
    const settingsStore = req.app.get("settingsStore");
    const channelManager = req.app.get("channelManager");
    const result = spawnAgent({ task, name, agentId, settingsStore, db, channelManager });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
