import { createServer } from "node:http";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import config from "./config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { LIMITS } from "./config/constants.js";
import { securityHeaders, csrfProtect, generateCsrfCookie } from "./middleware/security.js";
import { sessionAuth, requireAuth, rateLimitAuth, initSessionStore } from "./middleware/auth.js";
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
import { webhookRouter } from "./routes/webhooks.js";
import { whapiRouter } from "./routes/whapi.js";
import { analyticsRouter } from "./routes/analytics.js";
import { externalApiRouter } from "./routes/external-api.js";
import { pushRouter } from "./routes/push.js";

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
// --- Billing guard -------------------------------------------------------
// Tarsee authenticates with a Claude SUBSCRIPTION (`claude login`, credentials
// on the volume). If ANTHROPIC_API_KEY is present, the CLI and the Agent SDK
// will silently prefer API-key auth, moving every turn onto metered per-token
// billing with no visible change in behaviour. Checked at BOOT rather than
// inside the provider, because the provider is imported lazily on the first
// turn — by which point nobody is reading the log.
if (process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "[tarsee] WARNING: ANTHROPIC_API_KEY is set. Claude may authenticate with that key "
    + "instead of your Claude subscription, which bills PER TOKEN rather than against your "
    + "plan. Tarsee expects subscription auth via `claude login`. Unset ANTHROPIC_API_KEY "
    + "unless you have deliberately chosen metered API billing.",
  );
}

const db = initDb(config.DB_PATH);
// Hydrate login sessions from disk so a restart/deploy doesn't sign everyone
// out. Must run before any route that calls requireAuth.
initSessionStore(db);

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
app.use("/api/memory", requireAuth, csrfProtect, memoryRouter);
app.use("/api/skills", requireAuth, csrfProtect, skillsRouter);
app.use("/api/acp", requireAuth, csrfProtect, acpRouter);
app.use("/api/webhooks", webhookRouter); // Token auth, no session/CSRF needed
app.use("/api/channels/whapi", whapiRouter); // Per-channel secret in URL, no session/CSRF
app.use("/api/analytics", requireAuth, csrfProtect, analyticsRouter);
app.use("/api/push", requireAuth, csrfProtect, pushRouter);
app.use("/api/v1", requireAuth, externalApiRouter); // Bearer token auth, no CSRF needed for API clients

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

// --- Web Push (VAPID + subscription store) ---
// Initialized before any route handler needs it. Generates a VAPID key
// pair on first boot and persists to settings. Routes are declared
// below (in external-api.js since they also serve the public key to
// anonymous clients for subscribe flow).
import { initPush } from "./lib/push.js";
try {
  initPush(db, auditLog);
} catch (err) {
  console.warn("[tarsee] push init error:", err.message);
}

// --- Auto-install high-leverage skills on first boot ---
// ultrareview + fewer-permission-prompts are the two Claude Code v2.1.111
// skills we want available out of the box. They live in src/skills/ (ship
// with the image) but must be copied to workspace/skills/ to be active
// (skills-engine only scans the workspace dir). Idempotent — skips if
// already installed, so re-deploys don't clobber user modifications.
import { installSkill, scanSkills as _scanSkills } from "./lib/skills-engine.js";
try {
  const installed = new Set(_scanSkills().map((s) => s.name));
  const defaultSkills = ["ultrareview", "fewer-permission-prompts"];
  for (const name of defaultSkills) {
    if (!installed.has(name)) {
      try {
        installSkill(name);
        console.log(`[tarsee] installed default skill: ${name}`);
      } catch (err) {
        console.warn(`[tarsee] failed to install ${name}:`, err.message);
      }
    }
  }
} catch (err) {
  console.warn("[tarsee] default-skill bootstrap error:", err.message);
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
// DON'T wipe session ids on boot by default — that is what made conversations
// "forget" after every deploy/restart, which on Railway is EVERY deploy since
// the container is replaced. The MCP server is passed fresh in queryOptions on
// every spawn (including resumes), so a resumed session already registers the
// current tools; clearing was unnecessary and broke cross-deploy continuity.
// Bloated sessions are handled separately by the transcript cap in the
// provider, so preserving the id here cannot resurrect a hang-prone session.
// Set TARSEE_CLEAR_SESSIONS_ON_BOOT=1 to restore the old wipe.
if (process.env.TARSEE_CLEAR_SESSIONS_ON_BOOT === "1") {
  convStore.clearAllSessions();
  console.log("[boot] cleared all claude session ids (TARSEE_CLEAR_SESSIONS_ON_BOOT=1)");
} else {
  console.log("[boot] preserving claude session ids — conversations will resume across this restart");
}

// --- Boot context: save/restore conversation context across redeploys ---
import { saveBootContext } from "./lib/boot-context.js";
// Save context every 5 minutes so it's fresh if server crashes
setInterval(() => saveBootContext(db), 5 * 60 * 1000);
saveBootContext(db); // Initial save on boot
startSessionReset({ db, settingsStore, convStore });

// --- OAuth: Let the Claude Code SDK handle its own token refresh ---
// Our custom oauth-refresh.js was fighting with the Mac's Claude Code
// over the same refresh token, causing mutual logouts. The SDK handles
// credential refresh internally when it makes API calls.
// import { startOAuthRefresh } from "./lib/oauth-refresh.js";
// startOAuthRefresh();

// --- Auto-summarize idle conversations ---
import { startAutoSummarize, stopAutoSummarize } from "./lib/auto-summarize.js";
startAutoSummarize(db);

// --- Auto-checkpoint ---
// Every 6h (gated by activity), write a deterministic CHECKPOINT.md so
// an unplanned restart can still pick up where we left off. Manual
// /checkpoint still produces a richer AI-synthesized handoff on demand.
import { startAutoCheckpoint, stopAutoCheckpoint } from "./lib/auto-checkpoint.js";
startAutoCheckpoint({ db });

// --- Retention sweep ---
// Daily at 03:00 — prunes conversations idle > 14d (archiving a one-line
// summary first) and checkpoint files older than 30d / over 50-file cap.
// Keeps the SQLite DB from ballooning once Tarsee has been running for a
// few weeks on Railway.
import { startRetention, stopRetention } from "./lib/retention.js";
startRetention({ db });

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
// MUST stay unawaited, and MUST stay below server.listen(). The retry ladder in
// _startWithRetry backs off up to ~152s per channel in the worst case, while
// railway.toml sets healthcheckTimeout=60 — awaiting this would fail the deploy
// healthcheck before the first channel finished retrying.
channelManager.startAll().catch((err) => {
  console.warn("[tarsee] channel startup error:", err.message);
});

// Watchdog: auto-recover a Telegram poller that wedged at boot. Matters more
// on Railway than on a workstation — there is no console here to restart a
// dead channel by hand, so without this it stays dead until the next deploy.
import { startChannelHealth, stopChannelHealth } from "./lib/channel-health.js";
startChannelHealth({ channelManager, db });

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

// --- Agents use lazy wake-up: first real task creates their session ---
// No boot wake-up needed. Agents show "Offline" until their first task,
// then "Online" once they have a session. Sessions persist across tasks.

// --- Graceful shutdown ---
function shutdown(signal) {
  console.log(`[tarsee] ${signal} received, shutting down...`);
  stopTTSEngine();
  stopHeartbeat();
  saveBootContext(db); // Persist context before shutdown
  stopAutoSummarize();
  stopAutoCheckpoint();
  stopRetention();
  stopSessionReset();
  stopCronScheduler();
  stopChannelHealth();
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
