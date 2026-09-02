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

    // Live-reload injection REMOVED. There is no /canvas-ws server anywhere in
    // this codebase, so the socket fell through the upgrade handler to the CHAT
    // WebSocket (websocket.js only special-cases /terminal). Any chat frame then
    // hit `onmessage => location.reload()`, i.e. a reload loop. It was masked on
    // Railway only because ws:// is blocked as mixed content on an HTTPS page —
    // "fixing" that to wss:// would have armed the loop instead of curing it.
    // Every canvas page was also opening a stray authenticated chat socket.
    // If live reload is wanted later, BOTH halves have to be built: a dedicated
    // /canvas-ws branch in the upgrade handler plus a file-watch broadcaster.

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
/** Escape a string for safe interpolation into HTML text/attribute context. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Lock a canvas response into an opaque origin.
 *
 * Canvas HTML is written by the model, and the model reads untrusted input:
 * inbound email, WhatsApp messages, fetched web pages. A prompt injection that
 * reaches create_canvas used to get script execution on Tarsee's own origin —
 * the page could call /api/auth/api-token, read the vault through /api/files,
 * and exfiltrate the Claude credentials, because the app-wide CSP allows
 * 'unsafe-inline' and the chat embedded it with allow-same-origin.
 *
 * The CSP `sandbox` directive applies to top-level navigations as well as
 * frames, so it holds whether the canvas is opened directly or embedded. No
 * allow-same-origin: the page still renders and its own scripts still run, but
 * in a null origin with no access to Tarsee's cookies, storage, or same-origin
 * API surface.
 */
function applyCanvasIsolation(res) {
  res.set("Content-Security-Policy", [
    "sandbox allow-scripts allow-forms allow-modals allow-popups",
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' data: blob: https://cdn.jsdelivr.net https://cdn.tailwindcss.com",
    "style-src 'self' 'unsafe-inline' data: https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdn.tailwindcss.com",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
    // No 'self' here: a canvas has no business calling Tarsee's own API.
    "connect-src https://cdn.jsdelivr.net https://cdn.tailwindcss.com",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "));
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Cross-Origin-Resource-Policy", "same-origin");
  res.set("X-Content-Type-Options", "nosniff");
}

export function canvasMiddleware(req, res, next) {
  if (!req.path.startsWith("/canvas/")) return next();

  // Canvases are private. They routinely contain whatever the user asked the
  // agent to visualise — revenue dashboards, customer lists, internal process
  // diagrams — and this middleware is mounted before any auth, so /canvas/
  // used to enumerate and serve every canvas ever generated to anyone who
  // found the URL. Require the same session or API token the rest of the app
  // does; the chat iframe is same-origin and sends the cookie automatically.
  if (!req.auth?.authenticated) {
    return res.status(401).type("html").send(
      "<!DOCTYPE html><html><body style=\"background:#1a1a1a;color:#ececec;font-family:sans-serif;padding:40px\">"
      + "<h1>Sign in required</h1><p>Log in to Tarsee to view this canvas.</p></body></html>",
    );
  }

  applyCanvasIsolation(res);
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

      // Canvas names are directory names on disk and are model-controlled, so
      // they must be escaped for text and URL-encoded for the href — otherwise
      // a canvas named `<img src=x onerror=...>` is stored XSS on this page.
      const items = canvases.map(c => `<a href="/canvas/${encodeURIComponent(c.name)}/" style="display:block;background:#2b2a27;border-radius:8px;padding:16px;margin:8px 0;text-decoration:none;color:#ececec;border:1px solid #3a3935"><strong>${escapeHtml(c.name)}</strong><br><span style="color:#a8a8a0;font-size:12px">${Math.round(c.size/1024)}KB &middot; ${escapeHtml(c.modified.toLocaleDateString())}</span></a>`).join("");
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
