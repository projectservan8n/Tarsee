/**
 * WebSocket Terminal Handler
 * Provides a web-based terminal for running commands on the Tarsee server.
 * Useful for Claude CLI authentication and other admin tasks.
 */

import os from "node:os";
import config from "../config/env.js";
import { liveSessionId, signInEnded, signInKey } from "../middleware/auth.js";

// Lazy-load node-pty — it's a native module that may fail to compile on some platforms
let pty = null;
try {
  pty = await import("node-pty");
} catch (err) {
  console.warn("[terminal] node-pty unavailable — terminal feature disabled:", err.message);
}

const terminals = new Map();

/**
 * Why a /terminal connection may not have a shell, or null when it may. The Terminal is a full shell as the server's
 * user, so it takes the owner's live sign-in to the dashboard (the tarsee_session cookie, as owner-only commands do),
 * never the API token alone (?token= or a Bearer header): every API client gets the token, and the AI's shell can
 * read it (api.token in the state folder). The dashboard's Terminal page sends the cookie with its upgrade.
 */
export function terminalRefusal(req) {
  if (liveSessionId(req)) return null;
  return signInEnded(req)
    ? "Your sign-in has run out. Sign in to the dashboard again; this Terminal connects once you have."
    : "The Terminal needs you signed in to the dashboard. Sign in there; this Terminal connects once you have.";
}

/** Tells the page why, in its terminal, and closes (1008: refused). The page tries again every few seconds. */
function refuseTerminal(ws, why) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "data", data: `\r\n\x1b[31m[${why}]\x1b[0m\r\n` }));
    ws.send(JSON.stringify({ type: "error", message: why }));
  }
  ws.close(1008, "Sign-in required");
}

/**
 * A /terminal WebSocket: a shell for the owner's live sign-in (terminalRefusal), ended at the next key once that
 * sign-in ends. `pty` is node-pty (tests hand in a stand-in). The log names the client's place as the sign-in limit
 * counts it (signInKey), never a raw X-Forwarded-For.
 */
export function handleTerminalConnection(ws, req, { auditLog, pty: ptyModule = pty } = {}) {
  const place = signInKey(req);
  const refusal = terminalRefusal(req);
  if (refusal) {
    auditLog?.log({ action: "terminal.refused", actor: "unknown", ip: place, detail: JSON.stringify({ reason: "no live sign-in" }) });
    refuseTerminal(ws, refusal);
    return;
  }

  if (!ptyModule) {
    ws.send(JSON.stringify({ type: "error", message: "Terminal unavailable: node-pty failed to load on this platform" }));
    ws.close(1011, "node-pty unavailable");
    return;
  }

  const terminalId = generateTerminalId();

  console.log(`[terminal] New terminal session: ${terminalId}`);

  auditLog?.log({
    action: "terminal.connect",
    actor: "session-user",
    ip: place,
    detail: JSON.stringify({ terminalId }),
  });

  // Spawn shell based on OS
  const shell = os.platform() === "win32" ? "powershell.exe" : "bash";
  const cwd = config.CLAUDE_WORKSPACE_DIR || process.cwd();

  let ptyProcess;
  try {
    ptyProcess = ptyModule.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 30,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });
  } catch (err) {
    console.error("[terminal] Failed to spawn PTY:", err);
    ws.send(JSON.stringify({ type: "error", message: `Failed to spawn shell: ${err.message}` }));
    ws.close(1011, "PTY spawn failed");
    return;
  }

  terminals.set(terminalId, ptyProcess);

  // Send initial terminal ID
  ws.send(JSON.stringify({ type: "connected", terminalId, shell, cwd }));

  // Forward PTY output to WebSocket
  ptyProcess.onData((data) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "data", data }));
    }
  });

  // Handle PTY exit
  ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`[terminal] Terminal ${terminalId} exited: code=${exitCode}, signal=${signal}`);
    terminals.delete(terminalId);

    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "exit", exitCode, signal }));
      ws.close(1000, "Terminal process exited");
    }

    auditLog?.log({
      action: "terminal.exit",
      actor: "session-user",
      detail: JSON.stringify({ terminalId, exitCode, signal }),
    });
  });

  // Handle WebSocket messages
  ws.on("message", (message) => {
    try {
      const msg = JSON.parse(message);

      // Signed out, or the sign-in ran out, since the shell opened: it ends here, before the key reaches it.
      if ((msg.type === "input" || msg.type === "resize") && !liveSessionId(req)) {
        auditLog?.log({ action: "terminal.ended", actor: "session-user", ip: place, detail: JSON.stringify({ terminalId, reason: "sign-in ended" }) });
        terminals.delete(terminalId);
        try { ptyProcess.kill(); } catch { /* already gone */ }
        refuseTerminal(ws, terminalRefusal(req) || "Your sign-in has ended.");
        return;
      }

      if (msg.type === "input") {
        // User input - write to PTY
        ptyProcess.write(msg.data);
      } else if (msg.type === "resize") {
        // Terminal resize
        const { cols, rows } = msg;
        if (cols && rows) {
          ptyProcess.resize(cols, rows);
        }
      } else if (msg.type === "ping") {
        // Keepalive
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch (error) {
      console.error(`[terminal] Error handling message:`, error);
    }
  });

  // Handle WebSocket close
  ws.on("close", () => {
    console.log(`[terminal] WebSocket closed for ${terminalId}`);

    // Kill PTY process
    if (terminals.has(terminalId)) {
      try {
        ptyProcess.kill();
      } catch (error) {
        console.error(`[terminal] Error killing PTY:`, error);
      }
      terminals.delete(terminalId);
    }

    auditLog?.log({
      action: "terminal.disconnect",
      actor: "session-user",
      detail: JSON.stringify({ terminalId }),
    });
  });

  // Handle WebSocket errors
  ws.on("error", (error) => {
    console.error(`[terminal] WebSocket error for ${terminalId}:`, error);
  });
}

function generateTerminalId() {
  return `term-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get active terminal count (for monitoring)
 */
export function getActiveTerminalCount() {
  return terminals.size;
}

/**
 * Clean up all terminals (for graceful shutdown)
 */
export function cleanupAllTerminals() {
  for (const [id, ptyProcess] of terminals.entries()) {
    try {
      console.log(`[terminal] Cleaning up terminal: ${id}`);
      ptyProcess.kill();
    } catch (error) {
      console.error(`[terminal] Error cleaning up ${id}:`, error);
    }
  }
  terminals.clear();
}
