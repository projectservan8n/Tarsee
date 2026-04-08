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
import { memoryRouter } from "./routes/memory.js";
import { skillsRouter } from "./routes/skills.js";
import { setupWebSocket } from "./channels/websocket.js";
import { ChannelManager } from "./channels/manager.js";
import { initTTSEngine, stopTTSEngine } from "./voice/engine-registry.js";
import { SettingsStore } from "./db/settings.js";
import { AuditLog } from "./db/audit.js";
import { isEncryptionEnabled } from "./lib/vault.js";
import { logCapture } from "./lib/log-capture.js";
import { hookRegistry } from "./lib/hooks.js";
import { loadHooks } from "./lib/hook-loader.js";
import { loadPlugins } from "./lib/plugin-loader.js";
import { getSecurityManager } from "./lib/security-manager.js";
import { getGatewayManager } from "./lib/gateway.js";
import { canvasMiddleware } from "./lib/canvas.js";
import { acpRouter } from "./routes/acp.js";
import { cronRouter } from "./routes/cron.js";
import { agentsRouter } from "./routes/agents.js";

import { writePid, removePid } from "./daemon/pid.js";

// --- Install log capture early (before any console.log calls) ---
logCapture.install();
writePid();

// --- Enforce encryption in production ---
if (config.NODE_ENV === "production" && !isEncryptionEnabled()) {
  console.error("[tarsee] FATAL: ENCRYPTION_KEY environment variable is required in production.");
  console.error("[tarsee] Set a strong random key (e.g., openssl rand -hex 32) to encrypt credentials at rest.");
  process.exit(1);
}

if (isEncryptionEnabled()) {
  console.log("[tarsee] credential encryption: ENABLED");
} else {
  console.warn("[tarsee] credential encryption: DISABLED (set ENCRYPTION_KEY for production)");
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

// CSRF cookie on page loads — must be BEFORE express.static so it runs on index.html
const publicDir = path.join(__dirname, "public");
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/") && !req.path.match(/\.\w+$/)) {
    return generateCsrfCookie(req, res, next);
  }
  next();
});

// Canvas middleware (AI-generated UIs)
app.use(canvasMiddleware);

// Static files (WebUI) — no auth required for the shell, API calls are protected
// Short cache for CSS/JS (5min) so deploys take effect quickly; longer for images/fonts
app.use(express.static(publicDir, {
  maxAge: config.NODE_ENV === "production" ? "5m" : 0,
  setHeaders(res, filePath) {
    if (/\.(css|js|html)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    }
  }
}));

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
app.use("/api/memory", requireAuth, csrfProtect, memoryRouter);
app.use("/api/skills", requireAuth, csrfProtect, skillsRouter);
app.use("/api/acp", requireAuth, csrfProtect, acpRouter);
app.use("/api/cron", requireAuth, csrfProtect, cronRouter);
app.use("/api/agents", requireAuth, csrfProtect, agentsRouter);

// SPA fallback — serve index.html for client-side routes
// Express 5 requires named wildcard params (bare * is invalid)
app.get("/{*splat}", (_req, res) => {
  res.sendFile("index.html", { root: publicDir });
});

// Error handler (must be last)
app.use(errorHandler);

// --- HTTP server ---
const server = createServer(app);

// --- WebSocket ---
setupWebSocket(server, db, app);

// --- Start ---
server.listen(config.PORT, "0.0.0.0", () => {
  console.log(`[tarsee] listening on http://0.0.0.0:${config.PORT}`);
  console.log(`[tarsee] state:     ${config.STATE_DIR}`);
  console.log(`[tarsee] workspace: ${config.WORKSPACE_DIR}`);
  console.log(`[tarsee] database:  ${config.DB_PATH}`);
});

// --- Audit log + Settings ---
const auditLog = new AuditLog(db);
app.set("auditLog", auditLog);

// --- TTS Engine (lazy init) ---
const settingsStore = new SettingsStore(db, auditLog);
app.set("settingsStore", settingsStore);
settingsStore.logKeyStatus();
initTTSEngine(settingsStore).catch((err) => {
  console.warn("[tarsee] TTS engine init error:", err.message);
});

// --- Auth profiles ---
import { initAuthProfiles } from "./lib/auth-profiles.js";
initAuthProfiles(settingsStore);

// --- Agent registry ---
import { initAgentRegistry } from "./lib/agent-registry.js";
initAgentRegistry(settingsStore);

// --- Migrate DB memories to MEMORY.md (one-time) ---
import { MemoryStore } from "./db/memory.js";
try {
  const memoryStore = new MemoryStore(db);
  memoryStore.syncToMemoryFile();
} catch (err) {
  console.warn("[tarsee] memory sync error:", err.message);
}

// --- Boot runner (BOOT.md on every restart) ---
import { runBootChecklist } from "./lib/boot-runner.js";
runBootChecklist({ db, settingsStore }).catch((err) => {
  console.warn("[tarsee] boot runner error:", err.message);
});

// --- Heartbeat system ---
import { startHeartbeat, stopHeartbeat } from "./lib/heartbeat.js";
startHeartbeat({ db, settingsStore });

// --- Session reset system ---
import { startSessionReset, stopSessionReset } from "./lib/session-reset.js";
import { ConversationStore } from "./db/conversations.js";
const convStore = new ConversationStore(db);
convStore.clearAllSessions(); // Force fresh MCP tool registration on boot
startSessionReset({ db, settingsStore, convStore });

// --- OAuth token auto-refresh (keeps subscription auth alive 24/7) ---
import { startOAuthRefresh } from "./lib/oauth-refresh.js";
startOAuthRefresh();

// --- Cron scheduler ---
import { initCron, startCronScheduler, stopCronScheduler } from "./lib/cron.js";
initCron({ db, settingsStore, convStore });
startCronScheduler();

// --- Channel Manager (lazy start) ---
const channelManager = new ChannelManager(db);
app.set("channelManager", channelManager);
// Wire into cron so scheduled tasks can send to channels
import { setCronChannelManager } from "./lib/cron.js";
setCronChannelManager(channelManager);
channelManager.startAll().catch((err) => {
  console.warn("[tarsee] channel startup error:", err.message);
});

// --- Security manager ---
const securityManager = getSecurityManager(settingsStore);
app.set("securityManager", securityManager);

// --- Gateway manager ---
const gatewayManager = getGatewayManager();
app.set("gatewayManager", gatewayManager);

// --- Hooks system ---
loadHooks().then(() => {
  console.log("[tarsee] hooks loaded:", hookRegistry.list().length);
}).catch((err) => {
  console.warn("[tarsee] hook loading error:", err.message);
});

// --- Plugin system ---
loadPlugins({ db, settingsStore, hookRegistry }).then(() => {
  console.log("[tarsee] plugins loaded");
}).catch((err) => {
  console.warn("[tarsee] plugin loading error:", err.message);
});

// --- Emit boot:ready hook ---
setTimeout(() => hookRegistry.emit("boot:ready"), 2000);

// --- Wake up all agents (one at a time, wait for completion) ---
import { spawnAgent, getAgentResult } from "./lib/subagents.js";
import { getAgents } from "./lib/agent-registry.js";
setTimeout(async () => {
  const agents = getAgents();
  console.log(`[agents] Waking up ${agents.length} agents (sequential)...`);
  for (const agentDef of agents) {
    try {
      const nick = agentDef.nickname ? ` (${agentDef.nickname})` : "";
      const result = spawnAgent({
        task: `You are ${agentDef.name}${nick}. Respond ONLY with: "${agentDef.nickname || agentDef.name} online." Nothing else.`,
        name: `${agentDef.name} boot`,
        agentId: agentDef.id,
        settingsStore,
        db,
        channelManager,
      });
      // Wait for this agent to finish before spawning the next (max 60s)
      const start = Date.now();
      while (Date.now() - start < 60_000) {
        const status = getAgentResult(result.taskId);
        if (status && status.status !== "running" && status.status !== "queued") break;
        await new Promise(r => setTimeout(r, 2000));
      }
      console.log(`[agents] ${agentDef.nickname || agentDef.name} is online`);
    } catch (err) {
      console.warn(`[agents] Failed to wake ${agentDef.name}: ${err.message}`);
    }
  }
  console.log(`[agents] All ${agents.length} agents online`);
}, 8000); // 8s after boot (after boot checklist finishes)

// --- Graceful shutdown ---
function shutdown(signal) {
  console.log(`[tarsee] ${signal} received, shutting down...`);
  stopTTSEngine();
  stopHeartbeat();
  stopSessionReset();
  stopCronScheduler();
  channelManager.stopAll();
  server.close(() => {
    removePid();
    db.close();
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app, server, db };
