import { Router } from "express";
import {
  loadCronJobs,
  addCronJob,
  removeCronJob,
  getCronStatus,
  runCronJob,
} from "../lib/cron.js";

export const cronRouter = Router();

/**
 * GET /api/cron
 * List all cron jobs and their status.
 */
cronRouter.get("/", (_req, res) => {
  const status = getCronStatus();
  res.json(status);
});

/**
 * POST /api/cron
 * Create a new cron job.
 * Body: { schedule: string, prompt: string, channel?: string, enabled?: boolean }
 */
cronRouter.post("/", (req, res) => {
  const { schedule, prompt, channel, enabled } = req.body || {};

  if (!schedule || typeof schedule !== "string") {
    return res.status(400).json({ error: "schedule is required" });
  }
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "prompt is required" });
  }

  try {
    const job = addCronJob({
      schedule,
      prompt,
      channel: channel || "web:default",
      enabled: enabled !== false,
    });
    res.status(201).json(job);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/cron/:id/run
 * Manually trigger a cron job by ID.
 */
cronRouter.post("/:id/run", async (req, res) => {
  const { id } = req.params;
  const jobs = loadCronJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job) return res.status(404).json({ error: `Job not found: ${id}` });

  try {
    const result = await runCronJob(job);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/cron/:id
 * Remove a cron job by ID.
 */
cronRouter.delete("/:id", (req, res) => {
  const { id } = req.params;
  const removed = removeCronJob(id);
  if (!removed) return res.status(404).json({ error: `Job not found: ${id}` });
  res.json({ ok: true, id });
});
