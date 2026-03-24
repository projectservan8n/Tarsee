/**
 * Enhanced gateway features for Tarsee.
 * Connection pooling, presence tracking, flood guard, health snapshots.
 */

export class GatewayManager {
  constructor() {
    this.connections = new Map(); // clientId -> {ws, user, connectedAt, lastActivity}
    this.presence = new Map(); // userId -> {status, lastSeen, channel}
    this.floodGuard = new Map(); // clientId -> {count, windowStart}
    this.healthCache = null;
    this.healthCacheTs = 0;
  }

  addConnection(clientId, ws, user = null) {
    this.connections.set(clientId, { ws, user, connectedAt: Date.now(), lastActivity: Date.now() });
    if (user) this.updatePresence(user, "online");
  }

  removeConnection(clientId) {
    const conn = this.connections.get(clientId);
    if (conn?.user) this.updatePresence(conn.user, "offline");
    this.connections.delete(clientId);
    this.floodGuard.delete(clientId);
  }

  updatePresence(userId, status) {
    this.presence.set(userId, { status, lastSeen: Date.now() });
    this.broadcastPresence({ userId, status });
  }

  broadcastPresence(event) {
    for (const [, conn] of this.connections) {
      if (conn.ws?.readyState === 1) {
        try { conn.ws.send(JSON.stringify({ type: "presence", ...event })); } catch { /* ignore */ }
      }
    }
  }

  checkFlood(clientId, maxPerSecond = 10) {
    const now = Date.now();
    let guard = this.floodGuard.get(clientId);
    if (!guard || now - guard.windowStart > 1000) {
      guard = { count: 0, windowStart: now };
      this.floodGuard.set(clientId, guard);
    }
    guard.count++;
    return guard.count > maxPerSecond;
  }

  getHealthSnapshot(getStatusFn) {
    const now = Date.now();
    if (this.healthCache && now - this.healthCacheTs < 30000) return this.healthCache;
    this.healthCache = {
      connections: this.connections.size,
      onlineUsers: [...this.presence.values()].filter((p) => p.status === "online").length,
      uptime: Math.floor(process.uptime()),
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
      ...(getStatusFn ? getStatusFn() : {}),
      timestamp: new Date().toISOString(),
    };
    this.healthCacheTs = now;
    return this.healthCache;
  }

  getConnectionCount() { return this.connections.size; }
  getPresence() { return Object.fromEntries(this.presence); }
}

let instance = null;
export function getGatewayManager() {
  if (!instance) instance = new GatewayManager();
  return instance;
}
