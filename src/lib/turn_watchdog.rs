//! Port of `src/lib/turn-watchdog.js`: the end of a turn that an HTTP caller is waiting on (the external API, ACP).
//!
//! The chat channels give up a turn that sends nothing for TARSEE_CHANNEL_IDLE_ABORT_MS (20 minutes when unset): an
//! AI that never answers (a Local AI server that hangs, a stalled connection) would otherwise hold the
//! conversation's lock and the engine's process for good, with nothing to stop it. A turn an HTTP caller waits on
//! gets the same limit.
//!
//! When the caller goes away before the answer is written, `left` says so; whether the turn stops then is the
//! route's choice. An ACP turn stops (`stop_on_leave`, the default): its session lives in memory, so nothing else
//! could reach the turn and nobody is left to read its answer. An external API turn runs on (`stop_on_leave:
//! false`), as a web chat turn does, because its reply is saved in the conversation, where the caller and the
//! dashboard read it later, and the dashboard's Stop can still reach it.
//!
//! ```ignore
//! let watch = watch_turn(app.env(), Some(caller_left), WatchOptions::default());
//!     // (or WatchOptions { armed: false, .. } and watch.touch() once the turn begins, for a turn that may first
//!     //  wait in its conversation's queue)
//! while let Some(event) = turn.next().await { watch.touch(); ... }     // the turn is given watch.signal()
//! watch.stop();
//! if watch.left() { ... nobody to answer }
//! if watch.idled() { ... answer 504 with idle_note(route, watch.idle_ms, plain) }
//! ```
//!
//! **The caller leaving.** The JS watched the response for its "close" event. An axum handler has no such event:
//! when the caller hangs up, the handler's future is dropped. So the route makes a `CancellationToken`, keeps its
//! `drop_guard()` in the handler for as long as the answer is unwritten (disarming it once it returns the answer),
//! and gives the token here as `caller_left`. The turn itself must then run where a dropped handler does not take
//! it along (a spawned task), or there would be nothing left to stop or to carry on.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::env::Env;

/// How long a turn may go without an event (the same variable as the chat channels'), in milliseconds.
pub fn idle_limit_ms(env: &Env) -> i64 {
    env.get("TARSEE_CHANNEL_IDLE_ABORT_MS")
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|ms| ms.is_finite() && *ms != 0.0)
        .map_or(20 * 60_000, |ms| ms as i64)
}

/// The options of [`watch_turn`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchOptions {
    /// How long the turn may go without a [`touch`](TurnWatch::touch) (default: [`idle_limit_ms`]).
    pub idle_ms: Option<i64>,
    /// The idle clock starts now (the default), or (false) at the first `touch()`.
    pub armed: bool,
    /// The caller leaving stops the turn (the default).
    pub stop_on_leave: bool,
}

impl Default for WatchOptions {
    fn default() -> Self {
        WatchOptions {
            idle_ms: None,
            armed: true,
            stop_on_leave: true,
        }
    }
}

struct Shared {
    signal: CancellationToken,
    idle_ms: i64,
    idled: AtomicBool,
    left: AtomicBool,
    stopped: AtomicBool,
    last: Mutex<Instant>,
    timer: Mutex<Option<JoinHandle<()>>>,
}

impl Shared {
    /// Starts the idle clock: a look every quarter of the limit (at least every 25 ms, at most every 15 s).
    fn arm(self: &Arc<Self>) {
        let every = Duration::from_millis((self.idle_ms / 4).clamp(25, 15_000) as u64);
        let idle = Duration::from_millis(self.idle_ms.max(0) as u64);
        let shared = Arc::downgrade(self);
        let task = tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                let Some(watch) = shared.upgrade() else { return };
                if watch.signal.is_cancelled() {
                    continue;
                }
                let quiet = watch.last.lock().elapsed();
                if quiet <= idle && watch.idle_ms >= 0 {
                    continue;
                }
                watch.idled.store(true, Ordering::SeqCst);
                watch.signal.cancel();
                return;
            }
        });
        *self.timer.lock() = Some(task);
    }
}

/// One turn being watched: what [`watch_turn`] returns.
pub struct TurnWatch {
    /// How long the turn may go without an event, in milliseconds.
    pub idle_ms: i64,
    shared: Arc<Shared>,
    leaving: Option<JoinHandle<()>>,
}

impl TurnWatch {
    /// Cancelled once the turn has been idle for `idle_ms`, or (with `stop_on_leave`) once the caller left before
    /// the answer was written. Give it to the turn.
    pub fn signal(&self) -> CancellationToken {
        self.shared.signal.clone()
    }

    /// The turn was given up for going quiet.
    pub fn idled(&self) -> bool {
        self.shared.idled.load(Ordering::SeqCst)
    }

    /// The caller went away before the answer was written.
    pub fn left(&self) -> bool {
        self.shared.left.load(Ordering::SeqCst)
    }

    /// The turn showed a sign of life. With `armed: false`, the first one starts the idle clock.
    pub fn touch(&self) {
        *self.shared.last.lock() = Instant::now();
        if self.shared.timer.lock().is_none() && !self.shared.stopped.load(Ordering::SeqCst) {
            self.shared.arm();
        }
    }

    /// The turn is over: nothing is watched any more. (`idled` and `left` keep what they said.)
    pub fn stop(&self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        if let Some(timer) = self.shared.timer.lock().as_ref() {
            timer.abort();
        }
        if let Some(leaving) = &self.leaving {
            leaving.abort();
        }
    }
}

impl Drop for TurnWatch {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Watch one turn. `caller_left`: a token the route cancels when the caller goes away before the answer was
/// written (see the module notes); `None` when there is no caller to lose.
///
/// The returned [`TurnWatch`] has the signal that stops the turn, `idled()` and `left()` to say which happened,
/// `touch()` and `stop()`. The idle clock starts now, or with `armed: false` at the first `touch()`. Must be called
/// inside a tokio runtime; the watching ends at `stop()`, or when the `TurnWatch` is dropped.
pub fn watch_turn(env: &Env, caller_left: Option<CancellationToken>, opts: WatchOptions) -> TurnWatch {
    let idle_ms = opts.idle_ms.unwrap_or_else(|| idle_limit_ms(env));
    let shared = Arc::new(Shared {
        signal: CancellationToken::new(),
        idle_ms,
        idled: AtomicBool::new(false),
        left: AtomicBool::new(false),
        stopped: AtomicBool::new(false),
        last: Mutex::new(Instant::now()),
        timer: Mutex::new(None),
    });
    let leaving = caller_left.map(|caller_left| {
        let shared = shared.clone();
        tokio::spawn(async move {
            caller_left.cancelled().await;
            if shared.signal.is_cancelled() {
                return;
            }
            shared.left.store(true, Ordering::SeqCst);
            if opts.stop_on_leave {
                shared.signal.cancel();
            }
        })
    });
    if opts.armed {
        shared.arm();
    }
    TurnWatch {
        idle_ms,
        shared,
        leaving,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(idle: Option<&str>) -> Env {
        match idle {
            Some(value) => Env::from_pairs([("TARSEE_CHANNEL_IDLE_ABORT_MS", value)]),
            None => Env::new(),
        }
    }

    fn ms(ms: u64) -> Duration {
        Duration::from_millis(ms)
    }

    #[test]
    fn the_idle_limit_is_the_channels_variable_or_twenty_minutes() {
        assert_eq!(idle_limit_ms(&env(None)), 1_200_000);
        assert_eq!(idle_limit_ms(&env(Some("90000"))), 90_000);
        assert_eq!(idle_limit_ms(&env(Some(" 5000 "))), 5000);
        assert_eq!(idle_limit_ms(&env(Some("1e3"))), 1000);
        for unset in ["", "0", "soon", "  "] {
            assert_eq!(idle_limit_ms(&env(Some(unset))), 1_200_000, "{unset:?}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_turn_that_goes_quiet_is_stopped_and_one_that_keeps_showing_life_is_not() {
        let opts = WatchOptions {
            idle_ms: Some(1000),
            ..WatchOptions::default()
        };
        let watch = watch_turn(&env(None), None, opts);
        assert_eq!(watch.idle_ms, 1000);
        let signal = watch.signal();
        // Events every 900 ms for a while: never idle for a whole second.
        for _ in 0..10 {
            tokio::time::sleep(ms(900)).await;
            watch.touch();
        }
        assert!(!signal.is_cancelled() && !watch.idled());
        // Then silence. It is looked at every quarter of the limit, so it is noticed within 1250 ms.
        tokio::time::sleep(ms(1000)).await;
        // (the look that falls on this very moment has been taken)
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert!(!signal.is_cancelled(), "a second exactly is not over the limit");
        tokio::time::sleep(ms(251)).await;
        assert!(signal.is_cancelled());
        assert!(watch.idled());
        assert!(!watch.left());
    }

    #[tokio::test(start_paused = true)]
    async fn the_default_limit_comes_from_the_environment() {
        let watch = watch_turn(&env(Some("400")), None, WatchOptions::default());
        assert_eq!(watch.idle_ms, 400);
        tokio::time::sleep(ms(399)).await;
        assert!(!watch.idled());
        tokio::time::sleep(ms(102)).await;
        assert!(watch.idled(), "noticed at the next look, a quarter of the limit later");
        // Unset: twenty minutes.
        let long = watch_turn(&env(None), None, WatchOptions::default());
        tokio::time::sleep(Duration::from_secs(20 * 60)).await;
        assert!(!long.idled());
        tokio::time::sleep(Duration::from_secs(16)).await;
        assert!(long.idled(), "looked at every 15 seconds at most");
    }

    #[tokio::test(start_paused = true)]
    async fn a_turn_that_first_waits_in_the_queue_is_not_timed_until_it_begins() {
        let opts = WatchOptions {
            idle_ms: Some(1000),
            armed: false,
            stop_on_leave: false,
        };
        let watch = watch_turn(&env(None), None, opts);
        tokio::time::sleep(Duration::from_secs(3600)).await;
        assert!(!watch.idled(), "waiting behind another turn is not being idle");
        watch.touch();
        tokio::time::sleep(ms(900)).await;
        assert!(!watch.idled());
        tokio::time::sleep(ms(400)).await;
        assert!(watch.idled());
        assert!(watch.signal().is_cancelled());
    }

    #[tokio::test(start_paused = true)]
    async fn a_caller_that_leaves_stops_the_turn_unless_the_route_says_it_runs_on() {
        // ACP: nobody else could reach the turn.
        let gone = CancellationToken::new();
        let watch = watch_turn(&env(None), Some(gone.clone()), WatchOptions::default());
        tokio::task::yield_now().await;
        assert!(!watch.left());
        gone.cancel();
        watch.signal().cancelled().await;
        assert!(watch.left());
        assert!(!watch.idled());

        // The external API: the reply is saved, so the turn runs on.
        let gone = CancellationToken::new();
        let opts = WatchOptions {
            stop_on_leave: false,
            ..WatchOptions::default()
        };
        let watch = watch_turn(&env(None), Some(gone.clone()), opts);
        gone.cancel();
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert!(watch.left());
        assert!(!watch.signal().is_cancelled());
        // It is still given up if it then goes quiet.
        tokio::time::sleep(Duration::from_secs(21 * 60)).await;
        assert!(watch.idled());
        assert!(watch.signal().is_cancelled());
    }

    #[tokio::test(start_paused = true)]
    async fn a_caller_that_leaves_after_the_turn_was_given_up_for_being_quiet_did_not_leave_it() {
        let gone = CancellationToken::new();
        let opts = WatchOptions {
            idle_ms: Some(100),
            ..WatchOptions::default()
        };
        let watch = watch_turn(&env(None), Some(gone.clone()), opts);
        tokio::time::sleep(ms(200)).await;
        assert!(watch.idled());
        gone.cancel();
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert!(!watch.left(), "the 504 is still written to it");
    }

    #[tokio::test(start_paused = true)]
    async fn once_stopped_nothing_is_watched_any_more() {
        let gone = CancellationToken::new();
        let opts = WatchOptions {
            idle_ms: Some(100),
            ..WatchOptions::default()
        };
        let watch = watch_turn(&env(None), Some(gone.clone()), opts);
        watch.stop();
        gone.cancel();
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(!watch.idled() && !watch.left() && !watch.signal().is_cancelled());
        // A touch after the stop does not start the clock again.
        let opts = WatchOptions {
            idle_ms: Some(100),
            armed: false,
            ..WatchOptions::default()
        };
        let late = watch_turn(&env(None), None, opts);
        late.stop();
        late.touch();
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(!late.idled());
        // Dropping the watch ends its tasks too: the signal it gave out is never cancelled afterwards.
        let opts = WatchOptions {
            idle_ms: Some(100),
            ..WatchOptions::default()
        };
        let dropped = watch_turn(&env(None), Some(CancellationToken::new()), opts);
        let signal = dropped.signal();
        drop(dropped);
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(!signal.is_cancelled());
    }

    #[tokio::test(start_paused = true)]
    async fn a_very_short_limit_is_looked_at_every_25_milliseconds() {
        let opts = WatchOptions {
            idle_ms: Some(10),
            ..WatchOptions::default()
        };
        let watch = watch_turn(&env(None), None, opts);
        tokio::time::sleep(ms(24)).await;
        assert!(!watch.idled());
        tokio::time::sleep(ms(2)).await;
        assert!(watch.idled());
    }
}
