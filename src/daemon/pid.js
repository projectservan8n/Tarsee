/**
 * PID file management for Tarsee daemon.
 */
import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";

const PID_FILE = path.join(config.STATE_DIR, "tarsee.pid");

export function writePid() {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (err) {
    console.warn("[daemon] failed to write PID file:", err.message);
  }
}

export function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim());
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

export function isRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

export function removePid() {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}
