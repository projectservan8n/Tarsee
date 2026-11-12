//! Port of `src/lib/log-capture.js`: keeps the last 500 log lines in memory and passes new ones to whoever is
//! listening (the dashboard's console, over WebSocket).
//!
//! The Node version wrapped `console.log/warn/error`. Here the crate logs through the `log` macros
//! (`log::info!` for `console.log`, `log::warn!`, `log::error!`), and [`install`] makes this the logger: a line goes
//! to stdout (info) or stderr (warn, error) exactly as written, and into the buffer.
//!
//! This is the one process-wide value in the crate: a process has one stdout. Tests that need a log of their own
//! make a [`LogCapture`] and call [`LogCapture::capture`] directly.

use std::collections::VecDeque;
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::broadcast;

/// Keep the last 500 log entries in memory.
pub const MAX_BUFFER: usize = 500;

/// One captured line: `{ ts, level, text }`, with `level` one of "log", "warn", "error" as in the JS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogEntry {
    /// Milliseconds since the Unix epoch.
    pub ts: i64,
    pub level: &'static str,
    pub text: String,
}

pub struct LogCapture {
    buffer: Mutex<VecDeque<LogEntry>>,
    sender: broadcast::Sender<LogEntry>,
}

impl Default for LogCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl LogCapture {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(256);
        LogCapture {
            buffer: Mutex::new(VecDeque::with_capacity(MAX_BUFFER)),
            sender,
        }
    }

    /// Records a line and passes it to every subscriber. `level` is "log", "warn" or "error".
    pub fn capture(&self, level: &'static str, text: impl Into<String>) {
        let entry = LogEntry {
            ts: chrono::Utc::now().timestamp_millis(),
            level,
            text: text.into(),
        };
        {
            let mut buffer = self.buffer.lock();
            buffer.push_back(entry.clone());
            if buffer.len() > MAX_BUFFER {
                buffer.pop_front();
            }
        }
        // No subscriber is not an error.
        let _ = self.sender.send(entry);
    }

    /// New entries as they are captured. A subscriber that falls more than 256 entries behind skips ahead.
    pub fn subscribe(&self) -> broadcast::Receiver<LogEntry> {
        self.sender.subscribe()
    }

    /// The most recent entries, oldest first: the last `count`, or all of them for `None` or 0.
    pub fn recent(&self, count: Option<usize>) -> Vec<LogEntry> {
        let buffer = self.buffer.lock();
        match count {
            Some(n) if n > 0 => buffer.iter().skip(buffer.len().saturating_sub(n)).cloned().collect(),
            _ => buffer.iter().cloned().collect(),
        }
    }

    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }
}

static LOG_CAPTURE: OnceLock<LogCapture> = OnceLock::new();

/// The process's log capture (the JS `logCapture` singleton).
pub fn log_capture() -> &'static LogCapture {
    LOG_CAPTURE.get_or_init(LogCapture::new)
}

struct Logger;

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let text = record.args().to_string();
        let level = match record.level() {
            log::Level::Error => "error",
            log::Level::Warn => "warn",
            _ => "log",
        };
        // A closed stdout or stderr must not take the server down, so the results are ignored.
        use std::io::Write;
        if level == "log" {
            let _ = writeln!(std::io::stdout().lock(), "{text}");
        } else {
            let _ = writeln!(std::io::stderr().lock(), "{text}");
        }
        log_capture().capture(level, text);
    }

    fn flush(&self) {}
}

/// Makes this the process's logger. Call once at startup, before anything logs; a second call does nothing.
pub fn install() {
    if log::set_logger(&Logger).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_returns_the_last_entries_oldest_first() {
        let capture = LogCapture::new();
        for i in 0..5 {
            capture.capture("log", format!("line {i}"));
        }
        let all = capture.recent(None);
        assert_eq!(all.len(), 5);
        assert_eq!(all[0].text, "line 0");
        let last_two: Vec<String> = capture.recent(Some(2)).into_iter().map(|e| e.text).collect();
        assert_eq!(last_two, ["line 3", "line 4"]);
        assert_eq!(capture.recent(Some(0)).len(), 5);
        assert_eq!(capture.recent(Some(99)).len(), 5);
    }

    #[test]
    fn the_buffer_keeps_only_the_newest_500() {
        let capture = LogCapture::new();
        for i in 0..(MAX_BUFFER + 20) {
            capture.capture("warn", format!("{i}"));
        }
        let all = capture.recent(None);
        assert_eq!(all.len(), MAX_BUFFER);
        assert_eq!(all[0].text, "20");
        assert_eq!(all.last().unwrap().text, (MAX_BUFFER + 19).to_string());
    }

    #[test]
    fn subscribers_get_new_entries_and_are_counted() {
        let capture = LogCapture::new();
        assert_eq!(capture.subscriber_count(), 0);
        let mut rx = capture.subscribe();
        assert_eq!(capture.subscriber_count(), 1);
        capture.capture("error", "boom");
        let entry = rx.try_recv().unwrap();
        assert_eq!((entry.level, entry.text.as_str()), ("error", "boom"));
        assert!(entry.ts > 0);
        drop(rx);
        assert_eq!(capture.subscriber_count(), 0);
        capture.capture("log", "nobody listening is fine");
    }

    #[test]
    fn an_entry_serialises_as_the_dashboard_expects() {
        let entry = LogEntry {
            ts: 5,
            level: "warn",
            text: "careful".into(),
        };
        assert_eq!(
            serde_json::to_value(entry).unwrap(),
            serde_json::json!({"ts": 5, "level": "warn", "text": "careful"})
        );
    }
}
