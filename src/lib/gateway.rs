//! Port of `src/lib/gateway.js`: enhanced gateway features for Tarsee.
//! Connection pooling, presence tracking, flood guard, health snapshots, cross-device event broadcast +
//! short-horizon replay buffer.
//!
//! The JS kept WebSocket objects (`ws`) in its connection map and called `ws.readyState` and `ws.send(text)` on
//! them. Here a connection is anything that implements [`GatewaySocket`]; the WebSocket channel (package Z1)
//! implements it for its sockets.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::app::App;
use crate::util::js::{iso_from_ms, now_ms};

const MAX_EVENTS_PER_CONV: usize = 200;
const MAX_EVENT_AGE_MS: i64 = 10 * 60 * 1000; // 10 minutes
const MAX_CONV_LOGS: usize = 100; // LRU cap on tracked conversations

/// A connected client's socket, as the gateway uses it.
pub trait GatewaySocket: Send + Sync {
    /// `ws.readyState === 1`: the socket is open.
    fn is_open(&self) -> bool;
    /// `ws.send(text)`. The gateway ignores a failure.
    fn send(&self, text: &str) -> anyhow::Result<()>;
}

/// A connected client: clientId -> {ws, user, connectedAt, lastActivity}.
#[derive(Clone)]
pub struct Connection {
    pub ws: Arc<dyn GatewaySocket>,
    pub user: Option<String>,
    pub connected_at: i64,
    pub last_activity: i64,
}

/// A buffered cross-device event: {id, event, data, ts}.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GatewayEvent {
    pub id: u64,
    pub event: String,
    pub data: Value,
    pub ts: i64,
}

struct FloodWindow {
    count: u32,
    window_start: i64,
}

struct State {
    /// clientId -> the connection, in the order they connected
    connections: Vec<(String, Connection)>,
    /// userId -> {status, lastSeen}, in the order users were first seen
    presence: Map<String, Value>,
    /// clientId -> {count, windowStart}
    flood_guard: HashMap<String, FloodWindow>,
    health_cache: Option<(Value, i64)>,
    /// convId -> its events, in the order conversations were first seen
    event_log: Vec<(String, VecDeque<GatewayEvent>)>,
    next_event_id: u64,
}

/// The gateway of one app.
pub struct GatewayManager {
    state: Mutex<State>,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
    started: Instant,
}

impl Default for GatewayManager {
    fn default() -> Self {
        Self::new()
    }
}

impl GatewayManager {
    pub fn new() -> Self {
        Self::with_clock(now_ms)
    }

    /// A gateway that reads the time (milliseconds) from `now`, for tests.
    pub fn with_clock(now: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        GatewayManager {
            state: Mutex::new(State {
                connections: Vec::new(),
                presence: Map::new(),
                flood_guard: HashMap::new(),
                health_cache: None,
                event_log: Vec::new(),
                next_event_id: 1,
            }),
            now: Box::new(now),
            started: Instant::now(),
        }
    }

    /// The app's gateway, made on first use (`getGatewayManager()`).
    pub fn of(app: &App) -> Arc<GatewayManager> {
        app.get_or_init(GatewayManager::new)
    }

    pub fn add_connection(&self, client_id: &str, ws: Arc<dyn GatewaySocket>, user: Option<&str>) {
        let now = (self.now)();
        let connection = Connection {
            ws,
            user: user.filter(|u| !u.is_empty()).map(String::from),
            connected_at: now,
            last_activity: now,
        };
        {
            let mut state = self.state.lock();
            match state.connections.iter_mut().find(|(id, _)| id == client_id) {
                Some(existing) => existing.1 = connection,
                None => state.connections.push((client_id.to_string(), connection)),
            }
        }
        if let Some(user) = user.filter(|u| !u.is_empty()) {
            self.update_presence(user, "online");
        }
    }

    pub fn remove_connection(&self, client_id: &str) {
        let user = {
            let state = self.state.lock();
            state
                .connections
                .iter()
                .find(|(id, _)| id == client_id)
                .and_then(|(_, conn)| conn.user.clone())
        };
        if let Some(user) = user {
            self.update_presence(&user, "offline");
        }
        let mut state = self.state.lock();
        state.connections.retain(|(id, _)| id != client_id);
        state.flood_guard.remove(client_id);
    }

    /// Every connection now, in the order they connected (`gw.connections`).
    pub fn connections(&self) -> Vec<(String, Connection)> {
        self.state.lock().connections.clone()
    }

    /// Record a cross-device event for `conv_id`. Assigns a monotonic id so reconnecting clients can replay
    /// anything they missed. `None` when there is no conversation id.
    pub fn append_event(&self, conv_id: &str, event: &str, data: Value) -> Option<GatewayEvent> {
        if conv_id.is_empty() {
            return None;
        }
        let now = (self.now)();
        let mut state = self.state.lock();
        let entry = GatewayEvent {
            id: state.next_event_id,
            event: event.to_string(),
            data,
            ts: now,
        };
        state.next_event_id += 1;
        let at = match state.event_log.iter().position(|(conv, _)| conv == conv_id) {
            Some(at) => at,
            None => {
                state.event_log.push((conv_id.to_string(), VecDeque::new()));
                // Cheap LRU: if we're tracking too many convs, drop the oldest.
                if state.event_log.len() > MAX_CONV_LOGS && state.event_log[0].0 != conv_id {
                    state.event_log.remove(0);
                }
                state.event_log.len() - 1
            }
        };
        let log = &mut state.event_log[at].1;
        log.push_back(entry.clone());
        // Trim by count and age.
        while log.len() > MAX_EVENTS_PER_CONV {
            log.pop_front();
        }
        let age_cutoff = now - MAX_EVENT_AGE_MS;
        while log.front().is_some_and(|oldest| oldest.ts < age_cutoff) {
            log.pop_front();
        }
        Some(entry)
    }

    /// Return buffered events for `conv_id` with id > `since_id` (or all recent if it is 0).
    pub fn replay(&self, conv_id: &str, since_id: u64) -> Vec<GatewayEvent> {
        let state = self.state.lock();
        let Some((_, log)) = state.event_log.iter().find(|(conv, _)| conv == conv_id) else {
            return Vec::new();
        };
        log.iter().filter(|e| e.id > since_id).cloned().collect()
    }

    /// The sockets that are open now. Nothing of the gateway is locked while they are written to.
    fn open_sockets(&self) -> Vec<Arc<dyn GatewaySocket>> {
        let state = self.state.lock();
        state
            .connections
            .iter()
            .map(|(_, conn)| conn.ws.clone())
            .filter(|ws| ws.is_open())
            .collect()
    }

    /// Broadcast a chat/sync event to every connected WS client. Buffers the event for short-horizon replay so
    /// clients that reconnect can catch up. The client's own SSE stream dedupes — no need to filter the sender.
    pub fn broadcast(&self, conv_id: Option<&str>, event: &str, data: Value) {
        let entry = self.append_event(conv_id.unwrap_or_default(), event, data.clone());
        let mut message = Map::new();
        message.insert("type".into(), json!("sync"));
        message.insert("convId".into(), json!(conv_id));
        message.insert("event".into(), json!(event));
        message.insert("data".into(), data);
        if let Some(entry) = entry {
            message.insert("eventId".into(), json!(entry.id));
        }
        let payload = Value::Object(message).to_string();
        for ws in self.open_sockets() {
            let _ = ws.send(&payload);
        }
    }

    pub fn update_presence(&self, user_id: &str, status: &str) {
        let last_seen = (self.now)();
        self.state
            .lock()
            .presence
            .insert(user_id.to_string(), json!({ "status": status, "lastSeen": last_seen }));
        let mut event = Map::new();
        event.insert("userId".into(), json!(user_id));
        event.insert("status".into(), json!(status));
        self.broadcast_presence(event);
    }

    /// Sends `{type: "presence", ...event}` to every open socket.
    pub fn broadcast_presence(&self, event: Map<String, Value>) {
        let mut message = Map::new();
        message.insert("type".into(), json!("presence"));
        message.extend(event);
        let payload = Value::Object(message).to_string();
        for ws in self.open_sockets() {
            let _ = ws.send(&payload);
        }
    }

    /// Counts a message from this client; true when it has sent more than `max_per_second` (the JS default: 10)
    /// within the current second.
    pub fn check_flood(&self, client_id: &str, max_per_second: u32) -> bool {
        let now = (self.now)();
        let mut state = self.state.lock();
        let guard = state.flood_guard.entry(client_id.to_string()).or_insert(FloodWindow {
            count: 0,
            window_start: now,
        });
        if now - guard.window_start > 1000 {
            *guard = FloodWindow {
                count: 0,
                window_start: now,
            };
        }
        guard.count += 1;
        guard.count > max_per_second
    }

    /// How the gateway and the process are doing, made at most every 30 seconds. `get_status` adds its fields
    /// (after `memory`, before `timestamp`).
    pub fn get_health_snapshot(&self, get_status: Option<&dyn Fn() -> Map<String, Value>>) -> Value {
        let now = (self.now)();
        {
            let state = self.state.lock();
            if let Some((cached, at)) = &state.health_cache
                && now - at < 30_000
            {
                return cached.clone();
            }
        }
        let (connections, online_users) = {
            let state = self.state.lock();
            let online = state
                .presence
                .values()
                .filter(|p| p.get("status").and_then(Value::as_str) == Some("online"))
                .count();
            (state.connections.len(), online)
        };
        let mut snapshot = Map::new();
        snapshot.insert("connections".into(), json!(connections));
        snapshot.insert("onlineUsers".into(), json!(online_users));
        // (the JS `process.uptime()`: here the time since the gateway was made, which is at boot)
        snapshot.insert("uptime".into(), json!(self.started.elapsed().as_secs()));
        snapshot.insert(
            "memory".into(),
            json!((rss_bytes().unwrap_or(0) as f64 / 1024.0 / 1024.0).round() as u64),
        );
        if let Some(get_status) = get_status {
            snapshot.extend(get_status());
        }
        snapshot.insert("timestamp".into(), json!(iso_from_ms(now)));
        let snapshot = Value::Object(snapshot);
        self.state.lock().health_cache = Some((snapshot.clone(), now));
        snapshot
    }

    pub fn get_connection_count(&self) -> usize {
        self.state.lock().connections.len()
    }

    /// userId -> {status, lastSeen}, as one JSON object.
    pub fn get_presence(&self) -> Value {
        Value::Object(self.state.lock().presence.clone())
    }
}

/// The app's gateway, made on first use.
pub fn get_gateway_manager(app: &App) -> Arc<GatewayManager> {
    GatewayManager::of(app)
}

/// The memory the process holds in RAM (the JS `process.memoryUsage().rss`), where the system says: Linux and
/// Windows. `None` elsewhere.
pub(crate) fn rss_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string("/proc/self/status").ok()?;
        let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
        let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
        Some(kb * 1024)
    }
    #[cfg(windows)]
    {
        windows_rss()
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        None
    }
}

#[cfg(windows)]
fn windows_rss() -> Option<u64> {
    /// `PROCESS_MEMORY_COUNTERS` (psapi.h).
    #[repr(C)]
    #[derive(Default)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(process: isize, counters: *mut ProcessMemoryCounters, cb: u32) -> i32;
    }
    let mut counters = ProcessMemoryCounters::default();
    let size = std::mem::size_of::<ProcessMemoryCounters>() as u32;
    counters.cb = size;
    // SAFETY: `GetCurrentProcess` takes nothing and returns a pseudo-handle that needs no closing.
    // `K32GetProcessMemoryInfo` writes at most `size` bytes into `counters`, which is a live, writable value of
    // exactly that size, laid out as the Windows headers declare it.
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size) };
    (ok != 0).then_some(counters.working_set_size as u64)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

    use super::*;
    use crate::testkit::test_app;

    /// A socket that keeps what it was sent.
    #[derive(Default)]
    struct FakeSocket {
        closed: AtomicBool,
        broken: AtomicBool,
        sent: Mutex<Vec<String>>,
    }

    impl GatewaySocket for FakeSocket {
        fn is_open(&self) -> bool {
            !self.closed.load(Ordering::SeqCst)
        }

        fn send(&self, text: &str) -> anyhow::Result<()> {
            if self.broken.load(Ordering::SeqCst) {
                anyhow::bail!("socket gone");
            }
            self.sent.lock().push(text.to_string());
            Ok(())
        }
    }

    fn clocked() -> (GatewayManager, Arc<AtomicI64>) {
        let time = Arc::new(AtomicI64::new(1_794_472_200_000));
        let clock = time.clone();
        (GatewayManager::with_clock(move || clock.load(Ordering::SeqCst)), time)
    }

    #[test]
    fn a_broadcast_reaches_every_open_socket_and_is_kept_for_replay() {
        let (gw, _) = clocked();
        let (a, b, shut, broken) = (
            Arc::new(FakeSocket::default()),
            Arc::new(FakeSocket::default()),
            Arc::new(FakeSocket::default()),
            Arc::new(FakeSocket::default()),
        );
        shut.closed.store(true, Ordering::SeqCst);
        broken.broken.store(true, Ordering::SeqCst);
        gw.add_connection("a", a.clone(), None);
        gw.add_connection("broken", broken.clone(), None);
        gw.add_connection("shut", shut.clone(), None);
        gw.add_connection("b", b.clone(), None);
        assert_eq!(gw.get_connection_count(), 4);

        gw.broadcast(Some("c1"), "text", json!({ "content": "hi" }));
        gw.broadcast(
            Some("c1"),
            "done",
            json!({ "conversationId": "c1", "stopReason": null }),
        );
        // Byte for byte what the JS sent; a socket that fails is passed over, a closed one is not written to.
        let expected = [
            r#"{"type":"sync","convId":"c1","event":"text","data":{"content":"hi"},"eventId":1}"#,
            r#"{"type":"sync","convId":"c1","event":"done","data":{"conversationId":"c1","stopReason":null},"eventId":2}"#,
        ];
        assert_eq!(*a.sent.lock(), expected);
        assert_eq!(*b.sent.lock(), expected);
        assert!(shut.sent.lock().is_empty());

        assert_eq!(
            serde_json::to_value(gw.replay("c1", 0)).unwrap(),
            json!([
                { "id": 1, "event": "text", "data": { "content": "hi" }, "ts": 1_794_472_200_000_i64 },
                { "id": 2, "event": "done", "data": { "conversationId": "c1", "stopReason": null }, "ts": 1_794_472_200_000_i64 },
            ])
        );
        assert_eq!(gw.replay("c1", 1).iter().map(|e| e.id).collect::<Vec<_>>(), [2]);
        assert!(gw.replay("c1", 2).is_empty());
        assert!(gw.replay("nobody", 0).is_empty());

        // With no conversation the event is sent but not kept, and carries no eventId.
        gw.broadcast(None, "typing", json!({}));
        assert_eq!(
            a.sent.lock().last().unwrap(),
            r#"{"type":"sync","convId":null,"event":"typing","data":{}}"#
        );
        assert_eq!(gw.append_event("", "x", json!(1)), None);
        // Ids go on across conversations.
        assert_eq!(gw.append_event("c2", "x", json!(1)).unwrap().id, 3);
    }

    #[test]
    fn the_replay_buffer_keeps_200_events_ten_minutes_and_100_conversations() {
        let (gw, time) = clocked();
        for n in 0..250 {
            gw.append_event("busy", "text", json!(n));
        }
        let kept = gw.replay("busy", 0);
        assert_eq!(kept.len(), 200);
        assert_eq!((kept[0].data.clone(), kept[199].data.clone()), (json!(50), json!(249)));

        // Events over ten minutes old go when the next one comes.
        gw.append_event("slow", "text", json!("old"));
        time.fetch_add(10 * 60 * 1000, Ordering::SeqCst);
        gw.append_event("slow", "text", json!("at the edge"));
        assert_eq!(gw.replay("slow", 0).len(), 2, "ten minutes exactly is kept");
        time.fetch_add(1, Ordering::SeqCst);
        gw.append_event("slow", "text", json!("new"));
        assert_eq!(
            gw.replay("slow", 0).iter().map(|e| e.data.clone()).collect::<Vec<_>>(),
            [json!("at the edge"), json!("new")]
        );

        // The 101st conversation pushes out the one seen first.
        for n in 0..99 {
            gw.append_event(&format!("conv-{n}"), "text", json!(n));
        }
        assert_eq!(gw.replay("busy", 0).len(), 0, "the oldest conversation's log went");
        assert_eq!(gw.replay("slow", 0).len(), 2);
        assert_eq!(gw.replay("conv-98", 0).len(), 1);
    }

    #[test]
    fn presence_follows_connections_and_is_told_to_everyone() {
        let (gw, time) = clocked();
        let watcher = Arc::new(FakeSocket::default());
        gw.add_connection("w", watcher.clone(), None);
        assert_eq!(gw.get_presence(), json!({}));
        assert!(
            watcher.sent.lock().is_empty(),
            "a connection with no user is nobody's presence"
        );

        let phone = Arc::new(FakeSocket::default());
        gw.add_connection("p", phone.clone(), Some("owner"));
        assert_eq!(
            *watcher.sent.lock(),
            [r#"{"type":"presence","userId":"owner","status":"online"}"#]
        );
        assert_eq!(phone.sent.lock().len(), 1, "the new connection hears of itself too");
        assert_eq!(
            gw.get_presence(),
            json!({ "owner": { "status": "online", "lastSeen": 1_794_472_200_000_i64 } })
        );
        let listed = gw.connections();
        assert_eq!(listed.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["w", "p"]);
        assert_eq!(listed[1].1.user.as_deref(), Some("owner"));
        assert_eq!(listed[1].1.connected_at, 1_794_472_200_000);

        time.fetch_add(5000, Ordering::SeqCst);
        gw.remove_connection("p");
        assert_eq!(
            watcher.sent.lock().last().unwrap(),
            r#"{"type":"presence","userId":"owner","status":"offline"}"#
        );
        assert_eq!(
            gw.get_presence(),
            json!({ "owner": { "status": "offline", "lastSeen": 1_794_472_205_000_i64 } })
        );
        assert_eq!(gw.get_connection_count(), 1);
        gw.remove_connection("never-there");
        assert_eq!(gw.get_connection_count(), 1);

        let mut extra = Map::new();
        extra.insert("userId".into(), json!("guest"));
        extra.insert("typing".into(), json!(true));
        gw.broadcast_presence(extra);
        assert_eq!(
            watcher.sent.lock().last().unwrap(),
            r#"{"type":"presence","userId":"guest","typing":true}"#
        );
    }

    #[test]
    fn the_flood_guard_allows_ten_a_second_by_default_and_starts_again_after_the_second() {
        let (gw, time) = clocked();
        let flooded: Vec<bool> = (0..12).map(|_| gw.check_flood("c", 10)).collect();
        assert_eq!(flooded[..10], [false; 10]);
        assert_eq!(flooded[10..], [true, true]);
        assert!(!gw.check_flood("other", 10), "each client has its own count");
        time.fetch_add(1000, Ordering::SeqCst);
        assert!(gw.check_flood("c", 10), "the window is a full second");
        time.fetch_add(1, Ordering::SeqCst);
        assert!(!gw.check_flood("c", 10));
        assert!(gw.check_flood("strict", 0));
        // A client that leaves loses its count.
        let socket = Arc::new(FakeSocket::default());
        gw.add_connection("c", socket, None);
        for _ in 0..20 {
            gw.check_flood("c", 10);
        }
        gw.remove_connection("c");
        assert!(!gw.check_flood("c", 10));
    }

    #[test]
    fn the_health_snapshot_is_made_at_most_every_thirty_seconds() {
        let (gw, time) = clocked();
        gw.add_connection("a", Arc::new(FakeSocket::default()), Some("owner"));
        gw.add_connection("b", Arc::new(FakeSocket::default()), Some("guest"));
        gw.update_presence("guest", "away");
        let status = || {
            let mut status = Map::new();
            status.insert("channels".into(), json!(3));
            status
        };
        let first = gw.get_health_snapshot(Some(&status));
        assert_eq!(
            first.as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "connections",
                "onlineUsers",
                "uptime",
                "memory",
                "channels",
                "timestamp"
            ]
        );
        assert_eq!(first["connections"], 2);
        assert_eq!(first["onlineUsers"], 1);
        assert_eq!(first["channels"], 3);
        assert_eq!(first["timestamp"], "2026-11-12T08:30:00.000Z");
        assert!(first["uptime"].as_u64().unwrap() < 60);
        #[cfg(any(target_os = "linux", windows))]
        assert!(
            first["memory"].as_u64().unwrap() > 0,
            "the memory this process holds, in MB"
        );

        gw.remove_connection("b");
        time.fetch_add(29_999, Ordering::SeqCst);
        assert_eq!(
            gw.get_health_snapshot(None),
            first,
            "the same snapshot until 30 seconds are up"
        );
        time.fetch_add(1, Ordering::SeqCst);
        let later = gw.get_health_snapshot(None);
        assert_eq!(later["connections"], 1);
        assert_eq!(later.get("channels"), None);
        assert_eq!(later["timestamp"], "2026-11-12T08:30:30.000Z");
    }

    #[test]
    fn the_apps_gateway_is_made_once() {
        let t = test_app();
        let first = get_gateway_manager(&t.app);
        first.add_connection("a", Arc::new(FakeSocket::default()), None);
        assert_eq!(GatewayManager::of(&t.app).get_connection_count(), 1);
        assert_eq!(test_app().get_or_init(GatewayManager::new).get_connection_count(), 0);
    }
}
