/**
 * Audit log for credential access and sensitive operations.
 * Every read/write of secrets is logged for compliance and forensics.
 */
export class AuditLog {
  constructor(db) {
    this.db = db;
    this._insertStmt = db.prepare(`
      INSERT INTO audit_log (action, target, actor, ip, detail)
      VALUES (?, ?, ?, ?, ?)
    `);
    this._queryStmt = db.prepare(`
      SELECT * FROM audit_log
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    this._countStmt = db.prepare(`SELECT COUNT(*) as count FROM audit_log`);
  }

  /**
   * Log a credential or sensitive action.
   * @param {object} entry
   * @param {string} entry.action - e.g. "credential.read", "credential.write", "credential.delete", "auth.login", "auth.logout"
   * @param {string} entry.target - What was accessed (e.g. "ai.anthropic.apiKey")
   * @param {string} [entry.actor] - Who did it (user id, session, IP)
   * @param {string} [entry.ip] - Request IP
   * @param {string} [entry.detail] - Extra context (never include the actual secret!)
   */
  log({ action, target, actor, ip, detail }) {
    try {
      this._insertStmt.run(
        action,
        target || null,
        actor || "system",
        ip || null,
        detail || null
      );
    } catch (err) {
      // Audit logging should never crash the app
      console.error("[audit] failed to write log:", err.message);
    }
  }

  /**
   * Query audit logs.
   * @param {number} limit
   * @param {number} offset
   * @returns {Array<object>}
   */
  query(limit = 100, offset = 0) {
    return this._queryStmt.all(Math.min(limit, 1000), offset);
  }

  /**
   * Get total count of audit entries.
   */
  count() {
    return this._countStmt.get().count;
  }
}
