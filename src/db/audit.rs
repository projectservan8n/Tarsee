//! Port of `src/db/audit.js`: audit log for credential access and sensitive operations.
//! Every read/write of secrets is logged for compliance and forensics.

use std::sync::Arc;

use rusqlite::params;

use super::{Db, Row};
use crate::app::App;

/// One line for the audit log.
///
/// ```ignore
/// audit.log(AuditEntry::new("auth.login").actor("user").ip(ip));
/// ```
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuditEntry {
    /// e.g. "credential.read", "credential.write", "credential.delete", "auth.login", "auth.logout"
    pub action: String,
    /// What was accessed (e.g. "ai.anthropic.apiKey")
    pub target: Option<String>,
    /// Who did it (user id, session, IP). "system" when not given.
    pub actor: Option<String>,
    /// Request IP
    pub ip: Option<String>,
    /// Extra context (never include the actual secret!)
    pub detail: Option<String>,
}

impl AuditEntry {
    pub fn new(action: impl Into<String>) -> Self {
        AuditEntry {
            action: action.into(),
            ..Default::default()
        }
    }

    pub fn target(mut self, target: impl Into<String>) -> Self {
        self.target = Some(target.into());
        self
    }

    pub fn actor(mut self, actor: impl Into<String>) -> Self {
        self.actor = Some(actor.into());
        self
    }

    /// The request's address, when it has one (`ip: req.ip`).
    pub fn ip(mut self, ip: impl Into<Option<String>>) -> Self {
        self.ip = ip.into();
        self
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

/// The JS `value || null`: an empty text counts as not given.
fn given(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|text| !text.is_empty())
}

pub struct AuditLog {
    db: Db,
}

impl AuditLog {
    pub fn new(db: Db) -> Self {
        AuditLog { db }
    }

    /// Creates the app's audit log and stores it (`app.set("auditLog", new AuditLog(db))`). Code that logs looks it
    /// up with `app.get::<AuditLog>()` and does without when there is none, as the JS did (`auditLog?.log(...)`).
    pub fn init(app: &App) -> Arc<AuditLog> {
        app.set(AuditLog::new(app.db().clone()))
    }

    /// Log a credential or sensitive action.
    pub fn log(&self, entry: AuditEntry) {
        let written = self.db.with(|conn| {
            super::run(
                conn,
                "
      INSERT INTO audit_log (action, target, actor, ip, detail)
      VALUES (?, ?, ?, ?, ?)
    ",
                params![
                    entry.action,
                    given(&entry.target),
                    given(&entry.actor).unwrap_or("system"),
                    given(&entry.ip),
                    given(&entry.detail),
                ],
            )
        });
        if let Err(err) = written {
            // Audit logging should never crash the app
            log::error!("[audit] failed to write log: {err}");
        }
    }

    /// Query audit logs, newest first: at most `limit` rows (100 when `None`, never more than 1000) after skipping
    /// `offset`.
    pub fn query(&self, limit: Option<i64>, offset: Option<i64>) -> rusqlite::Result<Vec<Row>> {
        self.db.with(|conn| {
            super::all(
                conn,
                "
      SELECT * FROM audit_log
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    ",
                params![limit.unwrap_or(100).min(1000), offset.unwrap_or(0)],
            )
        })
    }

    /// Get total count of audit entries.
    pub fn count(&self) -> rusqlite::Result<i64> {
        self.db
            .with(|conn| conn.query_row("SELECT COUNT(*) as count FROM audit_log", [], |row| row.get(0)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::test_app;
    use serde_json::{Value, json};

    #[test]
    fn an_entry_is_written_with_the_node_defaults() {
        let t = test_app();
        let audit = AuditLog::init(&t);
        audit.log(
            AuditEntry::new("auth.login_failed")
                .actor("user")
                .ip("203.0.113.23".to_string()),
        );
        audit.log(AuditEntry::new("boot"));
        // Empty texts count as not given, as with the JS `target || null` and `actor || "system"`.
        audit.log(AuditEntry {
            action: "credential.write".into(),
            target: Some("ai.openai.apiKey".into()),
            actor: Some(String::new()),
            ip: Some(String::new()),
            detail: Some("Credential stored (encrypted)".into()),
        });

        let rows = t
            .db()
            .with(|c| {
                crate::db::all(
                    c,
                    "SELECT action, target, actor, ip, detail FROM audit_log ORDER BY id",
                    [],
                )
            })
            .unwrap();
        assert_eq!(
            Value::Array(rows.into_iter().map(Value::Object).collect()),
            json!([
                // The row Node wrote for a failed sign-in.
                { "action": "auth.login_failed", "target": null, "actor": "user", "ip": "203.0.113.23", "detail": null },
                { "action": "boot", "target": null, "actor": "system", "ip": null, "detail": null },
                { "action": "credential.write", "target": "ai.openai.apiKey", "actor": "system", "ip": null, "detail": "Credential stored (encrypted)" },
            ])
        );
        assert_eq!(audit.count().unwrap(), 3);
        assert!(t.app.get::<AuditLog>().is_some());
    }

    #[test]
    fn query_returns_whole_rows_newest_first_within_the_limits() {
        let t = test_app();
        let audit = AuditLog::new(t.db().clone());
        for (n, at) in ["2026-01-01 00:00:01", "2026-01-01 00:00:02", "2026-01-01 00:00:03"]
            .iter()
            .enumerate()
        {
            t.db()
                .with(|c| {
                    c.execute(
                        "INSERT INTO audit_log (action, created_at) VALUES (?, ?)",
                        params![format!("a{n}"), at],
                    )
                })
                .unwrap();
        }
        let actions = |rows: Vec<Row>| {
            rows.iter()
                .map(|r| r["action"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };

        let all = audit.query(None, None).unwrap();
        assert_eq!(
            all[0].keys().collect::<Vec<_>>(),
            ["id", "action", "target", "actor", "ip", "detail", "created_at"]
        );
        assert_eq!(all[0]["actor"], "system");
        assert_eq!(actions(all), ["a2", "a1", "a0"]);
        assert_eq!(actions(audit.query(Some(2), None).unwrap()), ["a2", "a1"]);
        assert_eq!(actions(audit.query(Some(2), Some(2)).unwrap()), ["a0"]);
        assert_eq!(actions(audit.query(Some(5000), Some(1)).unwrap()), ["a1", "a0"]);
    }

    #[test]
    fn the_limit_is_never_more_than_a_thousand() {
        let t = test_app();
        let audit = AuditLog::new(t.db().clone());
        t.db()
            .with(|c| {
                c.execute_batch(
                    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1005)
                     INSERT INTO audit_log (action) SELECT 'bulk' FROM n",
                )
            })
            .unwrap();
        assert_eq!(audit.count().unwrap(), 1005);
        assert_eq!(audit.query(Some(5000), None).unwrap().len(), 1000);
        assert_eq!(audit.query(None, None).unwrap().len(), 100);
    }

    #[test]
    fn a_failed_write_never_reaches_the_caller() {
        let t = test_app();
        let audit = AuditLog::new(t.db().clone());
        t.db().with(|c| c.execute_batch("DROP TABLE audit_log")).unwrap();
        audit.log(AuditEntry::new("auth.login"));
        assert!(audit.count().is_err());
    }
}
