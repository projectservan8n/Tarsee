import { createServer } from "node:http";
import express from "express";

import config from "./config/env.js";
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
import { setupWebSocket } from "./channels/websocket.js";
import { ChannelManager } from "./channels/manager.js";

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
app.use(express.static("src/public", { maxAge: config.NODE_ENV === "production" ? "1h" : 0 }));

// CSRF cookie on page loads
app.get("/", generateCsrfCookie);

// --- Routes ---
app.use(healthRouter);
app.use("/api/auth", rateLimitAuth, authRouter);
app.use("/api/chat", requireAuth, csrfProtect, chatRouter);
app.use("/api/voice", requireAuth, csrfProtect, voiceRouter);
app.use("/api/settings", requireAuth, csrfProtect, settingsRouter);
app.use("/api/admin", requireAuth, csrfProtect, adminRouter);

// SPA fallback — serve index.html for client-side routes
app.get("*", (_req, res) => {
  res.sendFile("index.html", { root: "src/public" });
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

// --- Channel Manager (lazy start) ---
const channelManager = new ChannelManager(db);
app.set("channelManager", channelManager);
channelManager.startAll().catch((err) => {
  console.warn("[opusclaw] channel startup error:", err.message);
});

// --- Graceful shutdown ---
function shutdown(signal) {
  console.log(`[opusclaw] ${signal} received, shutting down...`);
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
