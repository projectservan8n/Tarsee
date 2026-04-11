/**
 * Canvas/A2UI server for Tarsee.
 * Serves AI-generated HTML/CSS/JS UIs from a canvas directory.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import config from "../config/env.js";

const CANVAS_DIR = path.join(config.WORKSPACE_DIR, "canvas");

export class CanvasServer {
  constructor() {
    fs.mkdirSync(CANVAS_DIR, { recursive: true });
  }

  serve(canvasId, html, css, js) {
    const dir = path.join(CANVAS_DIR, canvasId);
    fs.mkdirSync(dir, { recursive: true });

    let fullHtml = html;
    if (css) fullHtml = `<style>${css}</style>\n${fullHtml}`;
    if (js) fullHtml = `${fullHtml}\n<script>${js}</script>`;

    // Inject live reload script
    fullHtml += `\n<script>(function(){const ws=new WebSocket("ws://"+location.host+"/canvas-ws");ws.onmessage=()=>location.reload();})()</script>`;

    fs.writeFileSync(path.join(dir, "index.html"), fullHtml);
    return { canvasId, path: `/canvas/${canvasId}/`, size: fullHtml.length };
  }

  list() {
    try {
      return fs.readdirSync(CANVAS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const indexPath = path.join(CANVAS_DIR, d.name, "index.html");
          const exists = fs.existsSync(indexPath);
          const stat = exists ? fs.statSync(indexPath) : null;
          return { id: d.name, hasIndex: exists, size: stat?.size || 0, modified: stat?.mtime?.toISOString() };
        });
    } catch { return []; }
  }

  get(canvasId) {
    const indexPath = path.join(CANVAS_DIR, canvasId, "index.html");
    try { return fs.readFileSync(indexPath, "utf8"); }
    catch { return null; }
  }

  delete(canvasId) {
    const dir = path.join(CANVAS_DIR, canvasId);
    try { fs.rmSync(dir, { recursive: true }); return true; }
    catch { return false; }
  }

  getFilePath(canvasId, filename) {
    return path.join(CANVAS_DIR, canvasId, filename);
  }

  static create() {
    return new CanvasServer();
  }
}

// Express middleware to serve canvas files
export function canvasMiddleware(req, res, next) {
  if (!req.path.startsWith("/canvas/")) return next();
  const parts = req.path.replace("/canvas/", "").split("/").filter(Boolean);

  // Gallery: /canvas/ with no ID → list all canvases
  if (parts.length === 0) {
    try {
      const canvases = fs.readdirSync(CANVAS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(CANVAS_DIR, d.name, "index.html")))
        .map(d => {
          const stat = fs.statSync(path.join(CANVAS_DIR, d.name, "index.html"));
          return { name: d.name, size: stat.size, modified: stat.mtime };
        })
        .sort((a, b) => b.modified - a.modified);

      if (canvases.length === 0) {
        return res.send(`<!DOCTYPE html><html><head><title>Canvas Gallery</title><style>body{background:#1a1a1a;color:#ececec;font-family:Poppins,sans-serif;padding:40px;text-align:center}h1{color:#c45a35}p{color:#a8a8a0}</style></head><body><h1>Canvas Gallery</h1><p>No canvases yet. Ask Tarsee to create one!</p></body></html>`);
      }

      const items = canvases.map(c => `<a href="/canvas/${c.name}/" style="display:block;background:#2b2a27;border-radius:8px;padding:16px;margin:8px 0;text-decoration:none;color:#ececec;border:1px solid #3a3935"><strong>${c.name}</strong><br><span style="color:#a8a8a0;font-size:12px">${Math.round(c.size/1024)}KB &middot; ${c.modified.toLocaleDateString()}</span></a>`).join("");
      return res.send(`<!DOCTYPE html><html><head><title>Canvas Gallery</title><style>body{background:#1a1a1a;color:#ececec;font-family:Poppins,sans-serif;padding:40px;max-width:600px;margin:0 auto}h1{color:#c45a35}a:hover{border-color:#c45a35!important}</style></head><body><h1>Canvas Gallery</h1>${items}</body></html>`);
    } catch {
      return res.status(500).send("Error loading gallery");
    }
  }

  const canvasId = parts[0];
  const filename = parts.slice(1).join("/") || "index.html";
  const filePath = path.join(CANVAS_DIR, canvasId, filename);

  if (!filePath.startsWith(CANVAS_DIR)) return res.status(403).send("Forbidden");

  try {
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).send("Canvas not found");
    }
  } catch { next(); }
}
