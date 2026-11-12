//! The log lines a test wrote, for tests that check what was logged (the Node tests replaced `console.warn` for a
//! moment and collected what it was called with).
//!
//! ```ignore
//! let logs = CapturedLogs::start();
//! code_that_warns();
//! assert_eq!(logs.warnings(), ["[workspace] AGENTS.md is 20KB, ..."]);
//! ```
//!
//! Capturing is per thread: a test sees the lines logged on its own thread, never another test's. That covers
//! synchronous code and `#[tokio::test]` (whose runtime runs every task on the test's thread); a line logged on another
//! thread is not seen. The first `start` makes a capturing logger the process's logger for the test binary; nothing
//! else in the tests installs one.

use std::cell::RefCell;

use log::{Level, LevelFilter, Log, Metadata, Record};

thread_local! {
    static ACTIVE: RefCell<Option<Vec<(Level, String)>>> = const { RefCell::new(None) };
}

struct ThreadLogger;

impl Log for ThreadLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= Level::Info
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        ACTIVE.with(|active| {
            if let Some(lines) = active.borrow_mut().as_mut() {
                lines.push((record.level(), record.args().to_string()));
            }
        });
    }

    fn flush(&self) {}
}

static LOGGER: ThreadLogger = ThreadLogger;

/// Collects what this thread logs until it is dropped.
pub struct CapturedLogs {
    _not_send: std::marker::PhantomData<*const ()>,
}

impl CapturedLogs {
    /// Starts collecting this thread's log lines (and forgets any collected before).
    pub fn start() -> Self {
        if log::set_logger(&LOGGER).is_ok() {
            log::set_max_level(LevelFilter::Info);
        }
        ACTIVE.with(|active| *active.borrow_mut() = Some(Vec::new()));
        CapturedLogs {
            _not_send: std::marker::PhantomData,
        }
    }

    /// Every line so far, oldest first.
    pub fn lines(&self) -> Vec<String> {
        self.collected(|_| true)
    }

    /// The `log::info!` lines (the JS `console.log`).
    pub fn infos(&self) -> Vec<String> {
        self.collected(|level| level == Level::Info)
    }

    /// The `log::warn!` lines (the JS `console.warn`).
    pub fn warnings(&self) -> Vec<String> {
        self.collected(|level| level == Level::Warn)
    }

    /// The `log::error!` lines (the JS `console.error`).
    pub fn errors(&self) -> Vec<String> {
        self.collected(|level| level == Level::Error)
    }

    fn collected(&self, keep: impl Fn(Level) -> bool) -> Vec<String> {
        ACTIVE.with(|active| {
            active
                .borrow()
                .as_ref()
                .map(|lines| {
                    lines
                        .iter()
                        .filter(|(level, _)| keep(*level))
                        .map(|(_, text)| text.clone())
                        .collect()
                })
                .unwrap_or_default()
        })
    }
}

impl Drop for CapturedLogs {
    fn drop(&mut self) {
        ACTIVE.with(|active| *active.borrow_mut() = None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_test_sees_its_own_lines_by_level() {
        let logs = CapturedLogs::start();
        log::info!("[t] one");
        log::warn!("[t] two");
        log::error!("[t] three");
        log::debug!("[t] not kept");
        assert_eq!(logs.lines(), ["[t] one", "[t] two", "[t] three"]);
        assert_eq!(logs.infos(), ["[t] one"]);
        assert_eq!(logs.warnings(), ["[t] two"]);
        assert_eq!(logs.errors(), ["[t] three"]);
        std::thread::spawn(|| log::info!("[t] another thread")).join().unwrap();
        assert_eq!(logs.lines().len(), 3);
        drop(logs);
        log::info!("[t] after");
        assert!(CapturedLogs::start().lines().is_empty());
    }
}
