/**
 * Enhanced gateway features for Tarsee.
 * Connection pooling, presence tracking, flood guard, health snapshots,
 * cross-device event broadcast + short-horizon replay buffer.
 */

const MAX_EVENTS_PER_CONV = 200;
const MAX_EVENT_AGE_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONV_LOGS = 100; // LRU cap on tracked conversations

export class GatewayManager {
  constructor() {
    this.connections = new Map(); // clientId -> {ws, user, connectedAt, lastActivity}
    this.presence = new Map(); // userId -> {status, lastSeen, channel}
    this.floodGuard = new Map(); // clientId -> {count, windowStart}
    this.healthCache = null;
    this.healthCacheTs = 0;
    this.eventLog = new Map(); // convId -> [{id, event, data, ts}]
    this.nextEventId = 1;
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

  /**
   * Record a cross-device event for `convId`. Assigns a monotonic id so
   * reconnecting clients can replay anything they missed.
   */
  appendEvent(convId, event, data) {
    if (!convId) return null;
    const now = Date.now();
    const entry = { id: this.nextEventId++, event, data, ts: now };
    let log = this.eventLog.get(convId);
    if (!log) {
      log = [];
      this.eventLog.set(convId, log);
      // Cheap LRU: if we're tracking too many convs, drop the oldest.
      if (this.eventLog.size > MAX_CONV_LOGS) {
        const oldestKey = this.eventLog.keys().next().value;
        if (oldestKey && oldestKey !== convId) this.eventLog.delete(oldestKey);
      }
    }
    log.push(entry);
    // Trim by count and age.
    if (log.length > MAX_EVENTS_PER_CONV) log.splice(0, log.length - MAX_EVENTS_PER_CONV);
    const ageCutoff = now - MAX_EVENT_AGE_MS;
    while (log.length && log[0].ts < ageCutoff) log.shift();
    return entry;
  }

  /** Return buffered events for `convId` with id > sinceId (or all recent if omitted). */
  replay(convId, sinceId = 0) {
    const log = this.eventLog.get(convId);
    if (!log) return [];
    return sinceId > 0 ? log.filter((e) => e.id > sinceId) : log.slice();
  }

  /**
   * Broadcast a chat/sync event to every connected WS client. Buffers the
   * event for short-horizon replay so clients that reconnect can catch up.
   * The client's own SSE stream dedupes — no need to filter the sender.
   */
  broadcast(convId, event, data) {
    const entry = this.appendEvent(convId, event, data);
    const payload = JSON.stringify({
      type: "sync",
      convId,
      event,
      data,
      eventId: entry?.id,
    });
    for (const [, conn] of this.connections) {
      if (conn.ws?.readyState === 1) {
        try { conn.ws.send(payload); } catch { /* ignore */ }
      }
    }
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
