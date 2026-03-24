/**
 * Agent Control Protocol (ACP) for Tarsee.
 * Provides session management, turn-based execution, and provenance tracking
 * for IDE integrations and external clients.
 */
import crypto from "node:crypto";

const sessions = new Map();
const MAX_SESSIONS = 100;

export class ACPSession {
  constructor(identity = {}) {
    this.id = crypto.randomUUID();
    this.identity = identity; // { clientName, clientVersion, userId }
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.turnCount = 0;
    this.messages = [];
    this.provenance = []; // audit trail
    this.status = "active";
  }

  startTurn() {
    this.turnCount++;
    this.lastActivity = Date.now();
    this.provenance.push({ type: "turn_start", turn: this.turnCount, ts: Date.now() });
    return this.turnCount;
  }

  endTurn(result) {
    this.lastActivity = Date.now();
    this.provenance.push({ type: "turn_end", turn: this.turnCount, ts: Date.now(), hasResult: !!result });
  }

  addMessage(role, content) {
    this.messages.push({ role, content, ts: Date.now() });
    this.lastActivity = Date.now();
  }

  toJSON() {
    return {
      id: this.id,
      identity: this.identity,
      createdAt: new Date(this.createdAt).toISOString(),
      lastActivity: new Date(this.lastActivity).toISOString(),
      turnCount: this.turnCount,
      messageCount: this.messages.length,
      status: this.status,
    };
  }
}

export class ACPServer {
  constructor() {
    this.rateLimits = new Map(); // sessionId -> {count, windowStart}
  }

  createSession(identity = {}) {
    if (sessions.size >= MAX_SESSIONS) {
      // Evict oldest idle session
      let oldest = null;
      for (const [id, s] of sessions) {
        if (!oldest || s.lastActivity < oldest.lastActivity) oldest = s;
      }
      if (oldest) sessions.delete(oldest.id);
    }
    const session = new ACPSession(identity);
    sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId) {
    return sessions.get(sessionId) || null;
  }

  destroySession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      session.status = "destroyed";
      sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  listSessions() {
    return [...sessions.values()].map((s) => s.toJSON());
  }

  checkRateLimit(sessionId, maxPerMinute = 30) {
    const now = Date.now();
    let rl = this.rateLimits.get(sessionId);
    if (!rl || now - rl.windowStart > 60000) {
      rl = { count: 0, windowStart: now };
      this.rateLimits.set(sessionId, rl);
    }
    rl.count++;
    return rl.count <= maxPerMinute;
  }
}

let instance = null;
export function getACPServer() {
  if (!instance) instance = new ACPServer();
  return instance;
}
