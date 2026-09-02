import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { safePath, sanitizeFilename } from "../lib/safe-path.js";
import { LIMITS } from "../config/constants.js";

export const filesRouter = Router();

// The workspace ONLY.
//
// STATE_DIR used to be listed here as well. It is the workspace's parent and
// holds the Claude OAuth credentials, the encryption key, the master API token,
// the live SQLite database and the hooks directory that gets imported on every
// boot — so the file manager could read every credential the deployment owns
// and write code that would execute on the next restart. Nothing in the UI ever
// needed to browse outside the workspace.
const ALLOWED_ROOTS = [config.WORKSPACE_DIR];

/**
 * GET /api/files/ls?path=...
 * List directory contents.
 */
filesRouter.get("/ls", (req, res) => {
  const reqPath = req.query.path || ".";
  let resolved;

  try {
    resolved = safePath(reqPath, ALLOWED_ROOTS);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Not a directory" });
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const items = entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      size: entry.isFile() ? fs.statSync(path.join(resolved, entry.name)).size : null,
    }));

    res.json({ path: reqPath, items });
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "Path not found" });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/files/read?path=...
 * Read file content.
 */
filesRouter.get("/read", (req, res) => {
  const reqPath = req.query.path;
  if (!reqPath) return res.status(400).json({ error: "Path required" });

  let resolved;
  try {
    resolved = safePath(reqPath, ALLOWED_ROOTS);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return res.status(400).json({ error: "Not a file" });
    if (stat.size > LIMITS.FILE_READ_MAX_BYTES) {
      return res.status(413).json({ error: `File too large (${Math.round(stat.size / 1024)}KB, max ${LIMITS.FILE_READ_MAX_BYTES / 1024}KB)` });
    }

    const content = fs.readFileSync(resolved, "utf8");
    res.json({ path: reqPath, content, size: stat.size });
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "File not found" });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/files/write
 * Write file content.
 */
filesRouter.post("/write", (req, res) => {
  const { path: reqPath, content } = req.body || {};
  if (!reqPath) return res.status(400).json({ error: "Path required" });
  if (content === undefined) return res.status(400).json({ error: "Content required" });

  let resolved;
  try {
    resolved = safePath(reqPath, ALLOWED_ROOTS);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    res.json({ ok: true, path: reqPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/files/mkdir
 * Create directory.
 */
filesRouter.post("/mkdir", (req, res) => {
  const { path: reqPath } = req.body || {};
  if (!reqPath) return res.status(400).json({ error: "Path required" });

  let resolved;
  try {
    resolved = safePath(reqPath, ALLOWED_ROOTS);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    fs.mkdirSync(resolved, { recursive: true });
    res.json({ ok: true, path: reqPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/files/delete
 * Delete file or directory.
 */
filesRouter.post("/delete", (req, res) => {
  const { path: reqPath } = req.body || {};
  if (!reqPath) return res.status(400).json({ error: "Path required" });

  let resolved;
  try {
    resolved = safePath(reqPath, ALLOWED_ROOTS);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Prevent deleting root directories
  if (ALLOWED_ROOTS.includes(resolved)) {
    return res.status(400).json({ error: "Cannot delete root directory" });
  }

  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      fs.rmSync(resolved, { recursive: true });
    } else {
      fs.unlinkSync(resolved);
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "Path not found" });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/files/rename
 * Rename file or directory.
 */
filesRouter.post("/rename", (req, res) => {
  const { path: reqPath, newName } = req.body || {};
  if (!reqPath || !newName) return res.status(400).json({ error: "Path and newName required" });

  let resolved;
  try {
    resolved = safePath(reqPath, ALLOWED_ROOTS);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const sanitized = sanitizeFilename(newName);
  const newPath = path.join(path.dirname(resolved), sanitized);

  // Validate new path is still within allowed roots
  const isWithinRoots = ALLOWED_ROOTS.some((root) => newPath.startsWith(root));
  if (!isWithinRoots) {
    return res.status(400).json({ error: "New name resolves outside allowed directory" });
  }

  try {
    fs.renameSync(resolved, newPath);
    res.json({ ok: true, newPath: path.relative(ALLOWED_ROOTS[0], newPath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/files/download?path=...
 * Download a file.
 */
filesRouter.get("/download", (req, res) => {
  const reqPath = req.query.path;
  if (!reqPath) return res.status(400).json({ error: "Path required" });

  let resolved;
  try {
    resolved = safePath(reqPath, ALLOWED_ROOTS);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return res.status(400).json({ error: "Not a file" });

    const filename = sanitizeFilename(path.basename(resolved));
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", stat.size);
    fs.createReadStream(resolved).pipe(res);
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "File not found" });
    res.status(500).json({ error: err.message });
  }
});
