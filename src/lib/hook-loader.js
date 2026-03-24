/**
 * Auto-discovers and loads hooks from workspace and built-in directories.
 */

import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { hookRegistry } from "./hooks.js";

export async function loadHooks() {
  // Load built-in hooks
  const builtinDir = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, "$1"), "..", "hooks");
  await loadFromDir(builtinDir, "builtin");

  // Load workspace hooks
  const workspaceDir = path.join(config.WORKSPACE_DIR, "hooks");
  await loadFromDir(workspaceDir, "workspace");
}

async function loadFromDir(dir, source) {
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      try {
        const filePath = path.join(dir, file);
        const mod = await import(`file://${filePath.split("\\").join("/")}`);
        if (mod.default) {
          const hook = mod.default;
          const events = hook.events || [];
          for (const event of events) {
            hookRegistry.register(event, hook.handler, { name: hook.name || file, source });
          }
        }
      } catch (err) {
        console.warn(`[hooks] failed to load ${file}:`, err.message);
      }
    }
  } catch { /* directory doesn't exist */ }
}
