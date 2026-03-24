/**
 * Event-driven hook system for Tarsee.
 * Allows registering handlers for various lifecycle events.
 */

class HookRegistry {
  constructor() {
    this.hooks = new Map(); // event -> [{name, handler, priority, source}]
  }

  register(event, handler, { name = "anonymous", priority = 10, source = "code" } = {}) {
    if (!this.hooks.has(event)) this.hooks.set(event, []);
    this.hooks.get(event).push({ name, handler, priority, source });
    this.hooks.get(event).sort((a, b) => a.priority - b.priority);
    console.log(`[hooks] registered: ${name} on ${event}`);
  }

  async emit(event, data = {}) {
    const handlers = this.hooks.get(event) || [];
    const results = [];
    for (const h of handlers) {
      try {
        const result = await Promise.race([
          h.handler(data),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Hook timeout")), 5000)),
        ]);
        results.push({ name: h.name, result });
      } catch (err) {
        console.warn(`[hooks] ${h.name} error on ${event}:`, err.message);
        results.push({ name: h.name, error: err.message });
      }
    }
    return results;
  }

  unregister(name) {
    for (const [event, handlers] of this.hooks) {
      this.hooks.set(event, handlers.filter((h) => h.name !== name));
    }
  }

  list() {
    const result = [];
    for (const [event, handlers] of this.hooks) {
      for (const h of handlers) {
        result.push({ event, name: h.name, priority: h.priority, source: h.source });
      }
    }
    return result;
  }

  getEvents() {
    return [...this.hooks.keys()];
  }
}

// Singleton instance
export const hookRegistry = new HookRegistry();

// Supported events
export const HOOK_EVENTS = [
  "message:received",
  "message:before_send",
  "message:after_send",
  "tool:before_execute",
  "tool:after_execute",
  "session:start",
  "session:end",
  "boot:ready",
  "heartbeat:tick",
  "memory:saved",
  "agent:spawned",
];
