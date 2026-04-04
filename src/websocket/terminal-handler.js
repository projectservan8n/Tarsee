/**
 * WebSocket Terminal Handler
 * Provides a web-based terminal for running commands on the Tarsee server.
 * Useful for Claude CLI authentication and other admin tasks.
 */

import os from "node:os";
import config from "../config/env.js";

// Lazy-load node-pty — it's a native module that may fail to compile on some platforms
let pty = null;
try {
  pty = await import("node-pty");
} catch (err) {
  console.warn("[terminal] node-pty unavailable — terminal feature disabled:", err.message);
}

const terminals = new Map();

export function handleTerminalConnection(ws, req, { auditLog }) {
  if (!pty) {
    ws.send(JSON.stringify({ type: "error", message: "Terminal unavailable: node-pty failed to load on this platform" }));
    ws.close(1011, "node-pty unavailable");
    return;
  }

  // Auth is already handled at upgrade level
  const terminalId = generateTerminalId();

  console.log(`[terminal] New terminal session: ${terminalId}`);

  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  auditLog?.log({
    action: "terminal.connect",
    actor: "session-user",
    ip: clientIp,
    detail: JSON.stringify({ terminalId }),
  });

  // Spawn shell based on OS
  const shell = os.platform() === "win32" ? "powershell.exe" : "bash";
  const cwd = config.CLAUDE_WORKSPACE_DIR || process.cwd();

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, [], {
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
