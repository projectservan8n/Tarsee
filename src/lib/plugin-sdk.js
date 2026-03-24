/**
 * Plugin SDK for Tarsee.
 * Provides a registry for plugins that extend Tarsee with new channels, tools, and hooks.
 */

class PluginRegistry {
  constructor() {
    this.plugins = new Map();
  }

  async register(plugin) {
    if (!plugin.name) throw new Error("Plugin must have a name");
    if (this.plugins.has(plugin.name)) {
      console.warn(`[plugins] replacing existing plugin: ${plugin.name}`);
      await this.unregister(plugin.name);
    }
    if (plugin.init) {
      try { await plugin.init(plugin._ctx || {}); }
      catch (err) { console.warn(`[plugins] ${plugin.name} init error:`, err.message); }
    }
    this.plugins.set(plugin.name, plugin);
    console.log(`[plugins] registered: ${plugin.name} v${plugin.version || "0.0.0"} (${plugin.type || "generic"})`);
  }

  get(name) {
    return this.plugins.get(name) || null;
  }

  list() {
    return [...this.plugins.values()].map((p) => ({
      name: p.name,
      version: p.version || "0.0.0",
      type: p.type || "generic",
      description: p.description || "",
    }));
  }

  async unregister(name) {
    const plugin = this.plugins.get(name);
    if (plugin?.destroy) {
      try { await plugin.destroy(); } catch { /* ignore */ }
    }
    this.plugins.delete(name);
  }

  getByType(type) {
    return [...this.plugins.values()].filter((p) => p.type === type);
  }
}

export const pluginRegistry = new PluginRegistry();
