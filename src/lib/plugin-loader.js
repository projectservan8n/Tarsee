import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { pluginRegistry } from "./plugin-sdk.js";

export async function loadPlugins(ctx = {}) {
  const workspacePluginDir = path.join(config.WORKSPACE_DIR, "plugins");
  try {
    if (!fs.existsSync(workspacePluginDir)) return;
    const dirs = fs.readdirSync(workspacePluginDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const dir of dirs) {
      const indexPath = path.join(workspacePluginDir, dir.name, "index.js");
      if (!fs.existsSync(indexPath)) continue;
      try {
        const mod = await import(`file://${indexPath.split("\\").join("/")}`);
        const plugin = mod.default || mod;
        plugin._ctx = ctx;
        await pluginRegistry.register(plugin);
      } catch (err) {
        console.warn(`[plugins] failed to load ${dir.name}:`, err.message);
      }
    }
  } catch { /* no plugins dir */ }
}
