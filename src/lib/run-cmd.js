import childProcess from "node:child_process";
import { LIMITS } from "../config/constants.js";

/**
 * Runs a command with bounded output collection and timeout.
 *
 * @param {string} cmd - The command to run
 * @param {string[]} args - Command arguments
 * @param {object} [opts] - Options
 * @param {number} [opts.timeoutMs=120000] - Timeout in ms
 * @param {number} [opts.maxOutputBytes] - Max output size (default: LIMITS.CMD_OUTPUT_MAX_BYTES)
 * @param {object} [opts.env] - Environment variables
 * @returns {Promise<{code: number, output: string}>}
 */
export function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const maxBytes = opts.maxOutputBytes ?? LIMITS.CMD_OUTPUT_MAX_BYTES;

    const proc = childProcess.spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? process.env,
    });

    let out = "";
    let outBytes = 0;
    let truncated = false;

    const onData = (d) => {
      const chunk = d.toString("utf8");
      outBytes += d.length;
      if (outBytes <= maxBytes) {
        out += chunk;
      } else if (!truncated) {
        truncated = true;
        out += "\n... (output truncated at " + Math.round(maxBytes / 1024) + "KB)\n";
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }, 2_000);
      resolve({ code: 124, output: out + "\n[timeout after " + Math.round(timeoutMs / 1000) + "s]\n" });
    }, timeoutMs);

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, output: out });
    });
  });
}
