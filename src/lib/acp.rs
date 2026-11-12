//! Port of `src/lib/acp.js`: Agent Control Protocol (ACP) for Tarsee.
//! Provides session management, turn-based execution, and provenance tracking for IDE integrations and external
//! clients.
//!
//! The JS classes `ACPSession` and `ACPServer` are [`AcpSession`] and [`AcpServer`]. The JS kept every session in
//! one module-level map; here the sessions belong to the app's [`AcpServer`].

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};

use crate::app::App;
use crate::util::js::{iso_from_ms, now_ms};

const MAX_SESSIONS: usize = 100;

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// A message of an ACP session.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AcpMessage {
    pub role: String,
    pub content: String,
    /// When it was added, in milliseconds.
    pub ts: i64,
}

struct SessionState {
    last_activity: i64,
    turn_count: u64,
    messages: Vec<AcpMessage>,
    /// audit trail
    provenance: Vec<Value>,
    status: String,
    /// The engine session the next turn resumes (the JS route kept it on the session as `engineSession`).
    engine_session: Option<String>,
}

/// One client's session.
pub struct AcpSession {
    pub id: String,
    /// { clientName, clientVersion, userId }
    pub identity: Value,
    pub created_at: i64,
    state: Mutex<SessionState>,
    now: Clock,
}

impl AcpSession {
    /// A new session for a client that gave this identity (`{}` for none).
    pub fn new(identity: Value) -> AcpSession {
        Self::with_clock(identity, Arc::new(now_ms))
    }

    fn with_clock(identity: Value, now: Clock) -> AcpSession {
        let created_at = now();
        AcpSession {
            id: uuid::Uuid::new_v4().to_string(),
            identity,
            created_at,
            state: Mutex::new(SessionState {
                last_activity: created_at,
                turn_count: 0,
                messages: Vec::new(),
                provenance: Vec::new(),
                status: "active".to_string(),
                engine_session: None,
            }),
            now,
        }
    }

    /// Begins a turn; returns its number.
    pub fn start_turn(&self) -> u64 {
        let now = (self.now)();
        let mut state = self.state.lock();
        state.turn_count += 1;
        state.last_activity = now;
        let turn = state.turn_count;
        state
            .provenance
            .push(json!({ "type": "turn_start", "turn": turn, "ts": now }));
        turn
    }

    /// Ends the turn. `result`: what it answered (`None` or "" for a turn that ended without an answer).
    pub fn end_turn(&self, result: Option<&str>) {
        let now = (self.now)();
        let mut state = self.state.lock();
        state.last_activity = now;
        let turn = state.turn_count;
        let has_result = result.is_some_and(|r| !r.is_empty());
        state
            .provenance
            .push(json!({ "type": "turn_end", "turn": turn, "ts": now, "hasResult": has_result }));
    }

    pub fn add_message(&self, role: &str, content: &str) {
        let now = (self.now)();
        let mut state = self.state.lock();
        state.messages.push(AcpMessage {
            role: role.to_string(),
            content: content.to_string(),
            ts: now,
        });
        state.last_activity = now;
    }

    pub fn last_activity(&self) -> i64 {
        self.state.lock().last_activity
    }

    pub fn turn_count(&self) -> u64 {
        self.state.lock().turn_count
    }

    /// The session's messages, oldest first.
    pub fn messages(&self) -> Vec<AcpMessage> {
        self.state.lock().messages.clone()
    }

    /// The audit trail: a `turn_start` and a `turn_end` entry for each turn.
    pub fn provenance(&self) -> Vec<Value> {
        self.state.lock().provenance.clone()
    }

    /// "active", or "destroyed" once the server has let it go.
    pub fn status(&self) -> String {
        self.state.lock().status.clone()
    }

    /// The engine session the next turn resumes, when a turn has set one.
    pub fn engine_session(&self) -> Option<String> {
        self.state.lock().engine_session.clone()
    }

    pub fn set_engine_session(&self, handle: Option<&str>) {
        self.state.lock().engine_session = handle.map(String::from);
    }

    /// The session as the API sends it (`toJSON()`).
    pub fn to_json(&self) -> Value {
        let state = self.state.lock();
        json!({
            "id": self.id,
            "identity": self.identity,
            "createdAt": iso_from_ms(self.created_at),
            "lastActivity": iso_from_ms(state.last_activity),
            "turnCount": state.turn_count,
            "messageCount": state.messages.len(),
            "status": state.status,
        })
    }
}

struct RateWindow {
    count: u32,
    window_start: i64,
}

/// The ACP sessions of one app.
pub struct AcpServer {
    /// In the order they were created.
    sessions: Mutex<Vec<Arc<AcpSession>>>,
    /// sessionId -> {count, windowStart}
    rate_limits: Mutex<HashMap<String, RateWindow>>,
    now: Clock,
}

impl Default for AcpServer {
    fn default() -> Self {
        Self::new()
    }
}

impl AcpServer {
    pub fn new() -> Self {
        Self::with_clock(now_ms)
    }

    /// A server that reads the time (milliseconds) from `now`, for tests.
    pub fn with_clock(now: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        AcpServer {
            sessions: Mutex::new(Vec::new()),
            rate_limits: Mutex::new(HashMap::new()),
            now: Arc::new(now),
        }
    }

    /// The app's ACP server, made on first use (`getACPServer()`).
    pub fn of(app: &App) -> Arc<AcpServer> {
        app.get_or_init(AcpServer::new)
    }

    pub fn create_session(&self, identity: Value) -> Arc<AcpSession> {
        let mut sessions = self.sessions.lock();
        if sessions.len() >= MAX_SESSIONS {
            // Evict oldest idle session
            let oldest = sessions
                .iter()
                .enumerate()
                .min_by_key(|(_, session)| session.last_activity())
                .map(|(at, _)| at);
            if let Some(at) = oldest {
                sessions.remove(at);
            }
        }
        let session = Arc::new(AcpSession::with_clock(identity, self.now.clone()));
        sessions.push(session.clone());
        session
    }

    pub fn get_session(&self, session_id: &str) -> Option<Arc<AcpSession>> {
        self.sessions.lock().iter().find(|s| s.id == session_id).cloned()
    }

    /// Lets a session go. True if there was one.
    pub fn destroy_session(&self, session_id: &str) -> bool {
        let mut sessions = self.sessions.lock();
        let Some(at) = sessions.iter().position(|s| s.id == session_id) else {
            return false;
        };
        let session = sessions.remove(at);
        session.state.lock().status = "destroyed".to_string();
        true
    }

    /// Every session as the API sends it, in the order they were created.
    pub fn list_sessions(&self) -> Vec<Value> {
        self.sessions.lock().iter().map(|s| s.to_json()).collect()
    }

    /// Counts a request of this session; false when it has made more than `max_per_minute` (the JS default: 30)
    /// within the current minute.
    pub fn check_rate_limit(&self, session_id: &str, max_per_minute: u32) -> bool {
        let now = (self.now)();
        let mut limits = self.rate_limits.lock();
        let window = limits.entry(session_id.to_string()).or_insert(RateWindow {
            count: 0,
            window_start: now,
        });
        if now - window.window_start > 60_000 {
            *window = RateWindow {
                count: 0,
                window_start: now,
            };
        }
        window.count += 1;
        window.count <= max_per_minute
    }
}

/// The app's ACP server, made on first use.
pub fn get_acp_server(app: &App) -> Arc<AcpServer> {
    AcpServer::of(app)
}

/// The JS default of `checkRateLimit`'s maxPerMinute.
pub const RATE_LIMIT_PER_MINUTE: u32 = 30;

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, Ordering};

    use super::*;
    use crate::testkit::test_app;

    fn clocked() -> (AcpServer, Arc<AtomicI64>) {
        let time = Arc::new(AtomicI64::new(1_794_472_200_000));
        let clock = time.clone();
        (AcpServer::with_clock(move || clock.load(Ordering::SeqCst)), time)
    }

    #[test]
    fn a_session_counts_its_turns_and_messages_and_keeps_an_audit_trail() {
        let (acp, time) = clocked();
        let session = acp.create_session(json!({ "clientName": "editor", "clientVersion": "1.2" }));
        assert_eq!(session.id.len(), 36);
        assert_eq!(
            session.to_json(),
            json!({
                "id": session.id,
                "identity": { "clientName": "editor", "clientVersion": "1.2" },
                "createdAt": "2026-11-12T08:30:00.000Z",
                "lastActivity": "2026-11-12T08:30:00.000Z",
                "turnCount": 0,
                "messageCount": 0,
                "status": "active",
            })
        );
        assert_eq!(
            session.to_json().as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "id",
                "identity",
                "createdAt",
                "lastActivity",
                "turnCount",
                "messageCount",
                "status"
            ]
        );

        time.fetch_add(1000, Ordering::SeqCst);
        assert_eq!(session.start_turn(), 1);
        session.add_message("user", "hello");
        time.fetch_add(2000, Ordering::SeqCst);
        session.add_message("assistant", "hi");
        session.end_turn(Some("hi"));
        assert_eq!(session.start_turn(), 2);
        session.end_turn(None);
        session.end_turn(Some(""));

        assert_eq!((session.turn_count(), session.last_activity()), (2, 1_794_472_203_000));
        assert_eq!(
            serde_json::to_value(session.messages()).unwrap(),
            json!([
                { "role": "user", "content": "hello", "ts": 1_794_472_201_000_i64 },
                { "role": "assistant", "content": "hi", "ts": 1_794_472_203_000_i64 },
            ])
        );
        assert_eq!(
            session.provenance(),
            [
                json!({ "type": "turn_start", "turn": 1, "ts": 1_794_472_201_000_i64 }),
                json!({ "type": "turn_end", "turn": 1, "ts": 1_794_472_203_000_i64, "hasResult": true }),
                json!({ "type": "turn_start", "turn": 2, "ts": 1_794_472_203_000_i64 }),
                json!({ "type": "turn_end", "turn": 2, "ts": 1_794_472_203_000_i64, "hasResult": false }),
                json!({ "type": "turn_end", "turn": 2, "ts": 1_794_472_203_000_i64, "hasResult": false }),
            ]
        );
        let shown = session.to_json();
        assert_eq!(
            (&shown["turnCount"], &shown["messageCount"], &shown["lastActivity"]),
            (&json!(2), &json!(2), &json!("2026-11-12T08:30:03.000Z"))
        );
        assert_eq!(session.engine_session(), None);
        session.set_engine_session(Some("claude:abc"));
        assert_eq!(session.engine_session().as_deref(), Some("claude:abc"));
        session.set_engine_session(None);
        assert_eq!(session.engine_session(), None);
        // A session made on its own (the JS `new ACPSession()`): no identity, the real clock.
        let alone = AcpSession::new(json!({}));
        assert_eq!(alone.to_json()["identity"], json!({}));
        assert_eq!(alone.status(), "active");
    }

    #[test]
    fn sessions_are_found_listed_and_destroyed() {
        let (acp, _) = clocked();
        let a = acp.create_session(json!({ "clientName": "a" }));
        let b = acp.create_session(json!({}));
        assert_eq!(acp.get_session(&a.id).unwrap().id, a.id);
        assert!(acp.get_session("nobody").is_none());
        assert_eq!(acp.list_sessions(), [a.to_json(), b.to_json()]);
        assert!(acp.destroy_session(&a.id));
        assert_eq!(a.status(), "destroyed");
        assert!(!acp.destroy_session(&a.id));
        assert!(acp.get_session(&a.id).is_none());
        assert_eq!(acp.list_sessions(), [b.to_json()]);
    }

    #[test]
    fn the_hundred_and_first_session_pushes_out_the_one_idle_longest() {
        let (acp, time) = clocked();
        let sessions: Vec<_> = (0..100)
            .map(|n| {
                time.fetch_add(1, Ordering::SeqCst);
                acp.create_session(json!({ "n": n }))
            })
            .collect();
        // The first one is used again, so the second is now the one idle longest.
        time.fetch_add(1, Ordering::SeqCst);
        sessions[0].add_message("user", "still here");
        let newest = acp.create_session(json!({ "n": 100 }));
        assert_eq!(acp.list_sessions().len(), 100);
        assert!(acp.get_session(&sessions[0].id).is_some());
        assert!(acp.get_session(&sessions[1].id).is_none(), "the one idle longest went");
        assert_eq!(sessions[1].status(), "active", "pushed out, not destroyed");
        assert!(acp.get_session(&newest.id).is_some());
        // Of several idle equally long, the one created first goes.
        let (acp, _) = clocked();
        let same: Vec<_> = (0..100).map(|n| acp.create_session(json!({ "n": n }))).collect();
        acp.create_session(json!({}));
        assert!(acp.get_session(&same[0].id).is_none());
        assert!(acp.get_session(&same[1].id).is_some());
    }

    #[test]
    fn a_session_may_ask_thirty_times_a_minute_by_default() {
        let (acp, time) = clocked();
        let allowed: Vec<bool> = (0..32)
            .map(|_| acp.check_rate_limit("s", RATE_LIMIT_PER_MINUTE))
            .collect();
        assert_eq!(allowed[..30], [true; 30]);
        assert_eq!(allowed[30..], [false, false]);
        assert!(
            acp.check_rate_limit("other", RATE_LIMIT_PER_MINUTE),
            "each session has its own count"
        );
        time.fetch_add(60_000, Ordering::SeqCst);
        assert!(
            !acp.check_rate_limit("s", RATE_LIMIT_PER_MINUTE),
            "the window is a full minute"
        );
        time.fetch_add(1, Ordering::SeqCst);
        assert!(acp.check_rate_limit("s", RATE_LIMIT_PER_MINUTE));
        assert!(acp.check_rate_limit("strict", 1));
        assert!(!acp.check_rate_limit("strict", 1));
    }

    #[test]
    fn the_apps_acp_server_is_made_once() {
        let t = test_app();
        let session = get_acp_server(&t.app).create_session(json!({}));
        assert!(AcpServer::of(&t.app).get_session(&session.id).is_some());
        assert!(get_acp_server(&test_app()).get_session(&session.id).is_none());
    }
}
