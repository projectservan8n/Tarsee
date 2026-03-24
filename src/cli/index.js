#!/usr/bin/env node
/**
 * Tarsee CLI — command-line interface for managing Tarsee.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0] || "start";

const COMMANDS = {
  start: { desc: "Start the Tarsee server", run: cmdStart },
  stop: { desc: "Stop a running Tarsee server", run: cmdStop },
  status: { desc: "Show server status", run: cmdStatus },
  doctor: { desc: "Run diagnostics", run: cmdDoctor },
  chat: { desc: "Send a one-shot message", run: cmdChat },
  interactive: { desc: "Interactive TUI chat mode", run: cmdInteractive },
  version: { desc: "Show version", run: cmdVersion },
  help: { desc: "Show help", run: cmdHelp },
};

async function main() {
  if (command === "help" || command === "--help" || command === "-h") return cmdHelp();
  if (command === "version" || command === "--version" || command === "-v") return cmdVersion();
  const cmd = COMMANDS[command];
  if (!cmd) {
    console.error(`Unknown command: ${command}`);
    cmdHelp();
    process.exit(1);
  }
  await cmd.run(args.slice(1));
}

async function cmdStart() {
  console.log("Starting Tarsee server...");
  await import("../server.js");
}

async function cmdStop() {
  const { readPid, isRunning } = await import("../daemon/pid.js");
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log("Tarsee is not running.");
    return;
  }
  try { process.kill(pid, "SIGTERM"); console.log(`Sent SIGTERM to PID ${pid}`); }
  catch (err) { console.error("Failed to stop:", err.message); }
}

async function cmdStatus() {
  const { readPid, isRunning } = await import("../daemon/pid.js");
  const pid = readPid();
  if (pid && isRunning(pid)) {
    console.log(`Tarsee is running (PID: ${pid})`);
    // Try to fetch status from API
    try {
      const port = process.env.PORT || 3000;
      const res = await fetch(`http://localhost:${port}/api/admin/status`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        console.log(`  Uptime: ${Math.floor(data.uptime / 60)}m`);
        console.log(`  Memory: ${data.memory?.rss}MB RSS`);
        console.log(`  Channels:`, JSON.stringify(data.channels));
      }
    } catch { console.log("  (Could not fetch live status)"); }
  } else {
    console.log("Tarsee is not running.");
  }
}

async function cmdDoctor() {
  const { runDoctor } = await import("./doctor.js");
  await runDoctor();
}

async function cmdChat(chatArgs) {
  const message = chatArgs.join(" ");
  if (!message) { console.error("Usage: tarsee chat <message>"); process.exit(1); }
  const port = process.env.PORT || 3000;
  const token = process.env.TARSEE_API_TOKEN || "";
  try {
    const res = await fetch(`http://localhost:${port}/api/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message, channelKey: "cli:default" }),
    });
    const text = await res.text();
    // Parse SSE events
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.content) process.stdout.write(data.content);
        } catch { /* skip non-JSON */ }
      }
    }
    console.log();
  } catch (err) {
    console.error("Error:", err.message);
    console.error("Is Tarsee running? Try: tarsee start");
  }
}

async function cmdInteractive() {
  const { startInteractive } = await import("./interactive.js");
  await startInteractive();
}

function cmdVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
    console.log(`Tarsee v${pkg.version || "1.0.0"}`);
  } catch { console.log("Tarsee v1.0.0"); }
}

function cmdHelp() {
  console.log("\nTarsee CLI\n");
  console.log("Usage: tarsee <command> [options]\n");
  console.log("Commands:");
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(14)} ${cmd.desc}`);
  }
  console.log();
}

main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
