import { createServer } from "node:http";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import config from "./config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { LIMITS } from "./config/constants.js";
import { securityHeaders, csrfProtect, generateCsrfCookie } from "./middleware/security.js";
import { sessionAuth, requireAuth, rateLimitAuth } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { initDb } from "./db/sqlite.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth-routes.js";
import { chatRouter } from "./routes/chat.js";
import { voiceRouter } from "./routes/voice.js";
import { settingsRouter } from "./routes/settings.js";
import { adminRouter } from "./routes/admin.js";
import { filesRouter } from "./routes/files.js";
import { debugRouter } from "./routes/debug.js";
import { backupRouter } from "./routes/backup.js";
import { setupWebSocket } from "./channels/websocket.js";
import { ChannelManager } from "./channels/manager.js";
import { initTTSEngine, stopTTSEngine } from "./voice/engine-registry.js";
import { SettingsStore } from "./db/settings.js";
import { AuditLog } from "./db/audit.js";
import { isEncryptionEnabled } from "./lib/vault.js";

// --- Enforce encryption in production ---
if (config.NODE_ENV === "production" && !isEncryptionEnabled()) {
  console.error("[opusclaw] FATAL: ENCRYPTION_KEY environment variable is required in production.");
  console.error("[opusclaw] Set a strong random key (e.g., openssl rand -hex 32) to encrypt credentials at rest.");
  process.exit(1);
}

if (isEncryptionEnabled()) {
  console.log("[opusclaw] credential encryption: ENABLED");
} else {
  console.warn("[opusclaw] credential encryption: DISABLED (set ENCRYPTION_KEY for production)");
}

// --- Initialize database ---
const db = initDb(config.DB_PATH);

// --- Express app ---
const app = express();
app.disable("x-powered-by");

// Make db available to route handlers via app.get("db")
app.set("db", db);

// Global middleware
app.use(securityHeaders);
app.use(express.json({ limit: LIMITS.JSON_BODY_MAX }));
app.use(sessionAuth);

// Static files (WebUI) — no auth required for the shell, API calls are protected
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir, { maxAge: config.NODE_ENV === "production" ? "1h" : 0 }));

// CSRF cookie on page loads
app.get("/", generateCsrfCookie);

// --- Routes ---
app.use(healthRouter);
app.use("/api/auth", rateLimitAuth, authRouter);
app.use("/api/chat", requireAuth, csrfProtect, chatRouter);
app.use("/api/voice", requireAuth, csrfProtect, voiceRouter);
app.use("/api/settings", requireAuth, csrfProtect, settingsRouter);
app.use("/api/admin", requireAuth, csrfProtect, adminRouter);
app.use("/api/files", requireAuth, csrfProtect, filesRouter);
app.use("/api/debug", requireAuth, csrfProtect, debugRouter);
app.use("/api/backup", requireAuth, csrfProtect, backupRouter);

// SPA fallback — serve index.html for client-side routes
app.get("*", (_req, res) => {
  res.sendFile("index.html", { root: publicDir });
});

// Error handler (must be last)
app.use(errorHandler);

// --- HTTP server ---
const server = createServer(app);

// --- WebSocket ---
setupWebSocket(server, db);

// --- Start ---
server.listen(config.PORT, "0.0.0.0", () => {
  console.log(`[opusclaw] listening on http://0.0.0.0:${config.PORT}`);
  console.log(`[opusclaw] state:     ${config.STATE_DIR}`);
  console.log(`[opusclaw] workspace: ${config.WORKSPACE_DIR}`);
  console.log(`[opusclaw] database:  ${config.DB_PATH}`);
});

// --- Audit log + Settings ---
const auditLog = new AuditLog(db);
app.set("auditLog", auditLog);

// --- TTS Engine (lazy init) ---
const settingsStore = new SettingsStore(db, auditLog);
initTTSEngine(settingsStore).catch((err) => {
  console.warn("[opusclaw] TTS engine init error:", err.message);
});

// --- Channel Manager (lazy start) ---
const channelManager = new ChannelManager(db);
app.set("channelManager", channelManager);
channelManager.startAll().catch((err) => {
  console.warn("[opusclaw] channel startup error:", err.message);
});

// --- Graceful shutdown ---
function shutdown(signal) {
  console.log(`[opusclaw] ${signal} received, shutting down...`);
  stopTTSEngine();
  channelManager.stopAll();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app, server, db };
