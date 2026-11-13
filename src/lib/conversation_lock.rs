//! Port of `src/lib/conversation-lock.js`: per-conversation turn serialization.
//!
//! Every channel handler resolved a conversation, read its stored Claude session id, and started a turn — with
//! nothing stopping two messages in the same chat from doing that at once. Two concurrent turns then resumed the
//! SAME Claude Code session, which is not a supported thing to do: both processes append to one transcript .jsonl,
//! the second resume reads a file the first is still writing, replies interleave, and the session can be left
//! corrupt enough that every later turn in that chat fails.
//!
//! It is easy to hit without trying. Someone sends "check my calendar", then immediately "actually make it 3pm".
//! On a multi-minute turn, a group chat with two people talking does it constantly.
//!
//! So: at most one turn per conversation, others queue behind it in arrival order. Queueing rather than rejecting
//! matters because the follow-up message is usually a correction the user expects to be read.
//!
//! A turn that has to wait goes on the live timeline as "turn_queued" (the dashboard's "Queued · after the reply
//! above" line, no timer), when the caller says how (`opts.live`). When its slot comes, the provider claims that
//! turn id ([`claim_queued_turn`]) for its turn_start, so the same line becomes the working line. Its Stop takes it
//! out of the queue alone ([`remove_queued_turn`]): the turn running ahead goes on, and this one never runs.
//!
//! # How this differs from the JS underneath
//!
//! The JS chained promises, and a promise runs whether or not anyone awaits it. A Rust future runs only while it is
//! polled, and can be dropped half way (a task that is aborted, a `select!` that took the other arm). So the queue
//! here is explicit, and every way out gives the slot back:
//!
//! - **Arrival order is call order.** [`with_conversation_turn`] takes the turn's place in the queue (and puts its
//!   "Queued" line on the timeline) when it is *called*, before the future it returns is first polled.
//! - **A turn that fails, panics or is dropped lets the next one run.** The slot is held by a guard inside the
//!   future; it is given back when the turn returns, when it unwinds and when the future is dropped, waiting or
//!   running. A waiting turn that is dropped leaves the queue without disturbing the order of the others.
//! - **The JS `AsyncLocalStorage`** (which queued turn's slot is running now) is a tokio task-local. It is seen by
//!   everything the turn awaits, but not by a task the turn spawns: wrap that task in [`scope_queued_turn`].
//! - The module's own lock guards a few map operations and is never held while anything else is called: not the
//!   database, not the live timeline, not a callback.
//! - **A Stop and the slot can come at the same moment**, on two threads (in the JS one always came first). What
//!   a queued turn is (waiting, removed, begun, ended) is kept under one small lock and changed in one step, so
//!   the two always land in an order the JS had: the Stop first (the line ends "removed" and the turn never runs)
//!   or the slot first (the Stop is refused and the turn runs).
//!   A turn that was removed comes back (`Turn::QueueRemoved`) only once the Stop that removed it has finished:
//!   its line has ended on the timeline and `on_removed` has returned, as both had in the JS. So `on_removed` must
//!   not block: the slot is not passed on until it returns.
//! - **`on_queued` and `on_removed` are advisory**, as in the JS, which caught what they threw: one that panics is
//!   logged and the turn goes on.
//!
//! As in the JS, a turn that starts another turn *of its own conversation* queues it behind itself. Awaiting that
//! inner turn from inside the outer one would wait for ever (in both versions); nothing does.
//!
//! One thing the JS did is not copied. Its queue forgot a finished turn one tick of the event loop after the
//! caller's own code went on, so a turn started in the very same tick as the previous one's end (`await turn(a);
//! turn(b)` with nothing awaited in between) was still told "queued, 1 ahead" and got a "Queued" line, though it
//! waited for nothing. No caller does that, and there is no tick to count here: the slot is free the moment the
//! turn's future completes, and the next turn is simply not queued.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::{oneshot, watch};

use crate::app::{App, WeakApp};
use crate::lib::live_bus::{new_turn_id, publish};
use crate::util::js::utf16_truncate;

/// What [`with_conversation_turn`] gives back: what the turn returned, or word that it was taken out of the queue
/// before its slot came (the JS `QUEUE_REMOVED`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Turn<T> {
    Ran(T),
    QueueRemoved,
}

impl<T> Turn<T> {
    /// What the turn returned, unless it was removed from the queue.
    pub fn ran(self) -> Option<T> {
        match self {
            Turn::Ran(value) => Some(value),
            Turn::QueueRemoved => None,
        }
    }

    /// `ran === QUEUE_REMOVED`.
    pub fn is_queue_removed(&self) -> bool {
        matches!(self, Turn::QueueRemoved)
    }
}

/// Called when the turn has to wait, with how many turns are ahead of it.
pub type OnQueued = Box<dyn FnOnce(usize) + Send>;
/// Called when the turn's Stop took it out of the queue.
pub type OnRemoved = Box<dyn FnOnce() + Send>;

/// How a turn that has to wait shows on the live timeline (`opts.live`).
#[derive(Default)]
pub struct LiveQueue {
    /// The conversation whose timeline it goes on (default: the conversation being locked).
    pub conversation_id: Option<String>,
    pub source: Option<String>,
    pub prompt: String,
    pub model: Option<String>,
    /// Its Stop took it out of the queue.
    pub on_removed: Option<OnRemoved>,
}

/// The options of [`with_conversation_turn`].
#[derive(Default)]
pub struct TurnOptions {
    /// Called when the turn has to wait, with how many turns are ahead of it. Use it to tell the user "hold on,
    /// still working on the last one" rather than looking hung.
    pub on_queued: Option<OnQueued>,
    /// When the turn has to wait, show it on the live timeline as queued.
    pub live: Option<LiveQueue>,
}

#[derive(Default)]
struct Flags {
    removed: bool,
    claimed: bool,
    ended: bool,
    slot: bool,
    noted: bool,
}

/// A turn that waited (or is waiting) for its slot, with its line on the live timeline.
pub struct QueuedTurn {
    /// The turn id its "Queued" line has.
    pub turn_id: String,
    /// The conversation whose timeline the line is on.
    pub live_conv: String,
    locks: Weak<ConversationLocks>,
    flags: Mutex<Flags>,
    on_removed: Mutex<Option<OnRemoved>>,
    /// True once a Stop that took the turn out has finished (its line ended on the timeline, its caller told).
    stop_done: watch::Sender<bool>,
}

impl QueuedTurn {
    /// Its line ends without the turn having begun (taken out, stopped, or nothing to run). `extra` is added to
    /// the turn_end event. Does nothing once the line has ended or a provider has claimed it.
    pub fn end(&self, stop_reason: &str, extra: Map<String, Value>) {
        {
            let mut flags = self.flags.lock();
            if flags.ended || flags.claimed {
                return;
            }
            flags.ended = true;
        }
        self.say_ended(stop_reason, extra);
    }

    /// The line's turn_end goes on the timeline. Only for the one caller that has just set `ended`.
    fn say_ended(&self, stop_reason: &str, extra: Map<String, Value>) {
        let Some(locks) = self.locks.upgrade() else {
            return;
        };
        locks.state.lock().waiting.remove(&self.turn_id);
        let mut payload = Map::new();
        payload.insert("stopReason".into(), json!(stop_reason));
        payload.extend(extra);
        if let Some(app) = locks.app.upgrade() {
            publish(
                &app,
                &self.live_conv,
                "turn_end",
                Value::Object(payload),
                Some(&self.turn_id),
            );
        }
    }

    /// Takes the turn out of the queue. False when it is not waiting any more.
    fn remove(&self) -> bool {
        {
            let mut flags = self.flags.lock();
            if flags.removed || flags.slot || flags.ended {
                return false;
            }
            // Removed and ended in one step, as in the JS, where nothing could come in between. If the slot came
            // between the two, the turn would find itself removed with its line still open, and its line would be
            // ended as "It could not start" before this Stop got to say "removed".
            flags.removed = true;
            flags.ended = true;
        }
        // The turn itself may get its slot while this is still at work, on another thread. It waits for this to
        // finish (see `with_conversation_turn`), however it finishes.
        struct Done<'a>(&'a watch::Sender<bool>);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.send_replace(true);
            }
        }
        let _done = Done(&self.stop_done);
        self.say_ended("removed", Map::new());
        let on_removed = self.on_removed.lock().take();
        if let Some(on_removed) = on_removed {
            advisory("on_removed", on_removed);
        }
        true
    }
}

impl std::fmt::Debug for QueuedTurn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QueuedTurn")
            .field("turn_id", &self.turn_id)
            .field("live_conv", &self.live_conv)
            .finish_non_exhaustive()
    }
}

tokio::task_local! {
    /// The queued turn whose slot is running now, for the provider that begins it (`claim_queued_turn`).
    static TURN_STORE: Arc<QueuedTurn>;
}

/// One conversation's queue. Absent from the map means idle.
struct Queue {
    /// The ticket whose slot it is: running, or just woken.
    holder: u64,
    /// The tickets waiting behind it, oldest first, each with the way to wake it.
    waiters: VecDeque<(u64, oneshot::Sender<()>)>,
}

#[derive(Default)]
struct State {
    next_ticket: u64,
    /// conversationId -> its queue. Its length (the holder and the waiters) is the JS `depth`.
    queues: HashMap<String, Queue>,
    /// turnId -> a turn still waiting for its slot, for `remove_queued_turn`.
    waiting: HashMap<String, Arc<QueuedTurn>>,
}

/// The conversation locks of one app (the JS module's `chains`, `depth` and `waiting` maps).
pub struct ConversationLocks {
    app: WeakApp,
    state: Mutex<State>,
}

/// A place in a conversation's queue. Dropping it leaves the queue: the slot goes to the next turn waiting, or a
/// turn that had not got its slot yet steps out of the line.
struct Slot {
    locks: Arc<ConversationLocks>,
    conv: String,
    ticket: u64,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut state = self.locks.state.lock();
        let Some(queue) = state.queues.get_mut(&self.conv) else {
            return;
        };
        if queue.holder != self.ticket {
            queue.waiters.retain(|(ticket, _)| *ticket != self.ticket);
            return;
        }
        while let Some((next, wake)) = queue.waiters.pop_front() {
            queue.holder = next;
            // (A waiter whose future is gone is on its way out of the line: pass it by.)
            if wake.send(()).is_ok() {
                return;
            }
        }
        // Last one out clears the map so it cannot grow without bound across the lifetime of a long-running
        // server.
        state.queues.remove(&self.conv);
    }
}

/// Ends a queued turn's line when its future goes away without the turn having begun: dropped while it waited, or
/// while it ran (a panic too) with no provider having claimed the line.
struct QueuedLine(Arc<QueuedTurn>);

impl Drop for QueuedLine {
    fn drop(&mut self) {
        let began = self.0.flags.lock().slot;
        if began {
            self.0.end("error", could_not_start());
        } else {
            self.0.end("removed", Map::new());
        }
    }
}

/// Calls a caller's callback that is advisory only: the JS wrapped these in `try { } catch { }`, so one that
/// fails must not stop the turn (or leave its place in the queue half taken).
fn advisory(what: &str, callback: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(callback)).is_err() {
        log::warn!("[conv-lock] {what} panicked; the turn goes on");
    }
}

fn could_not_start() -> Map<String, Value> {
    let mut extra = Map::new();
    extra.insert("error".into(), json!("It could not start"));
    extra
}

/// A turn's place in the queue, from the moment `with_conversation_turn` is called. The fields are in the order
/// they must be dropped in when the future is dropped before it was ever polled: the line ends, then the slot is
/// given back.
struct Arrival {
    line: Option<QueuedLine>,
    /// Fires when the slot is this turn's. `None`: the conversation was idle.
    wake: Option<oneshot::Receiver<()>>,
    slot: Slot,
}

impl ConversationLocks {
    /// The app's conversation locks, made on first use.
    pub fn of(app: &App) -> Arc<ConversationLocks> {
        app.get_or_init(|| ConversationLocks::new(app.downgrade()))
    }

    pub fn new(app: WeakApp) -> ConversationLocks {
        ConversationLocks {
            app,
            state: Mutex::new(State::default()),
        }
    }

    /// How many turns are queued or running for a conversation.
    pub fn queue_depth(&self, conv_id: &str) -> usize {
        let state = self.state.lock();
        state.queues.get(conv_id).map_or(0, |queue| 1 + queue.waiters.len())
    }

    /// Take a turn still waiting for its slot out of the queue (the Stop on its "Queued" line). False when it is
    /// not waiting: it began, ended, or is of another conversation.
    pub fn remove_queued_turn(&self, turn_id: &str, conversation_id: Option<&str>) -> bool {
        let queued = self.state.lock().waiting.get(turn_id).cloned();
        let Some(queued) = queued else {
            return false;
        };
        if conversation_id.is_some_and(|conv| !conv.is_empty() && conv != queued.live_conv) {
            return false;
        }
        queued.remove()
    }

    /// Put a turn that has to wait on the live timeline as queued.
    fn queue_live(self: &Arc<Self>, live: LiveQueue, conv_id: &str) -> Arc<QueuedTurn> {
        let live_conv = live
            .conversation_id
            .filter(|conv| !conv.is_empty())
            .unwrap_or_else(|| conv_id.to_string());
        let queued = Arc::new(QueuedTurn {
            turn_id: new_turn_id(),
            live_conv,
            locks: Arc::downgrade(self),
            flags: Mutex::new(Flags::default()),
            on_removed: Mutex::new(live.on_removed),
            stop_done: watch::Sender::new(false),
        });
        self.state.lock().waiting.insert(queued.turn_id.clone(), queued.clone());
        if let Some(app) = self.app.upgrade() {
            publish(
                &app,
                &queued.live_conv,
                "turn_queued",
                json!({
                    "source": live.source.filter(|s| !s.is_empty()),
                    "model": live.model.filter(|m| !m.is_empty()),
                    "prompt": utf16_truncate(&live.prompt, 300),
                }),
                Some(&queued.turn_id),
            );
        }
        queued
    }

    /// Takes the turn's place in the conversation's queue, now.
    fn arrive(self: &Arc<Self>, conv_id: &str, opts: TurnOptions) -> Arrival {
        let (ticket, ahead, wake) = {
            let mut state = self.state.lock();
            state.next_ticket += 1;
            let ticket = state.next_ticket;
            match state.queues.get_mut(conv_id) {
                Some(queue) => {
                    let (wake, woken) = oneshot::channel();
                    let ahead = 1 + queue.waiters.len();
                    queue.waiters.push_back((ticket, wake));
                    (ticket, ahead, Some(woken))
                }
                None => {
                    state.queues.insert(
                        conv_id.to_string(),
                        Queue {
                            holder: ticket,
                            waiters: VecDeque::new(),
                        },
                    );
                    (ticket, 0, None)
                }
            }
        };
        let slot = Slot {
            locks: self.clone(),
            conv: conv_id.to_string(),
            ticket,
        };
        let mut line = None;
        if wake.is_some() {
            if let Some(on_queued) = opts.on_queued {
                // depth includes this turn, so subtract it to get the number ahead.
                advisory("on_queued", move || on_queued(ahead));
            }
            if let Some(live) = opts.live {
                line = Some(QueuedLine(self.queue_live(live, conv_id)));
            }
        }
        Arrival { line, wake, slot }
    }

    /// Run `f` with exclusive access to a conversation's turn slot. See [`with_conversation_turn`].
    pub fn with_conversation_turn<T, E, F, Fut>(
        self: &Arc<Self>,
        conv_id: Option<&str>,
        opts: TurnOptions,
        f: F,
    ) -> impl Future<Output = Result<Turn<T>, E>> + use<T, E, F, Fut>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        let arrival = conv_id
            .filter(|conv| !conv.is_empty())
            .map(|conv| self.arrive(conv, opts));
        async move {
            let Some(Arrival { line, wake, slot }) = arrival else {
                return f().await.map(Turn::Ran);
            };
            // Declared in this order so that, on every way out, the line ends before the slot is given back.
            let _slot = slot;
            let line = line;
            if let Some(wake) = wake {
                // Wait for the turns ahead, however they ended.
                let _ = wake.await;
            }
            let Some(line) = line else {
                return f().await.map(Turn::Ran);
            };
            let queued = line.0.clone();
            let removed = {
                let mut flags = queued.flags.lock();
                flags.slot = true;
                flags.removed
            };
            if let Some(locks) = queued.locks.upgrade() {
                locks.state.lock().waiting.remove(&queued.turn_id);
            }
            if removed {
                // The Stop that took this turn out may still be at work on another thread. In the JS it had long
                // finished when the slot came: the line had ended, `on_removed` had been called, and only then
                // did the turn come back removed. Waiting for it here keeps that order for the caller and for the
                // timeline (the line ends before the next turn begins). The Stop waits for nothing of this turn's.
                let mut stop_done = queued.stop_done.subscribe();
                let _ = stop_done.wait_for(|done| *done).await;
                return Ok(Turn::QueueRemoved);
            }
            // Inside f the provider claims the queued turn id; if nothing does (the turn failed first, a command
            // answered without the model), the line ends.
            let result = TURN_STORE.scope(queued.clone(), async move { f().await }).await;
            match &result {
                Ok(_) => queued.end("ended", Map::new()),
                Err(_) => queued.end("error", could_not_start()),
            }
            result.map(Turn::Ran)
        }
    }
}

/// Run `f` with exclusive access to a conversation's turn slot.
///
/// Serializes per conversation only: different chats still run in parallel, so one slow turn in a Telegram group
/// never blocks Discord. With no conversation id (`None` or "") `f` simply runs.
///
/// The returned future settles with whatever `f` returns — callers keep their own error handling. A failure does
/// not poison the queue: the next queued turn still runs. `f` returns a `Result` so that a turn which waited and
/// then failed before anything began can end its "Queued" line as failed.
///
/// The turn's place in the queue is taken when this is called (see the module notes); the future must then be
/// awaited or dropped. `opts.on_queued` is called, before this returns, when the turn has to wait.
///
/// (The JS argument order was `(convId, fn, opts)`; the closure is last here.)
pub fn with_conversation_turn<T, E, F, Fut>(
    app: &App,
    conv_id: Option<&str>,
    opts: TurnOptions,
    f: F,
) -> impl Future<Output = Result<Turn<T>, E>> + use<T, E, F, Fut>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    ConversationLocks::of(app).with_conversation_turn(conv_id, opts, f)
}

/// How many turns are queued or running for a conversation.
pub fn queue_depth(app: &App, conv_id: &str) -> usize {
    ConversationLocks::of(app).queue_depth(conv_id)
}

/// Take a turn still waiting for its slot out of the queue (the Stop on its "Queued" line). False when it is not
/// waiting: it began, ended, or is of another conversation.
pub fn remove_queued_turn(app: &App, turn_id: &str, conversation_id: Option<&str>) -> bool {
    ConversationLocks::of(app).remove_queued_turn(turn_id, conversation_id)
}

/// The provider beginning a turn in a slot that waited in the queue: the turn id its "Queued" line has, once (a
/// second turn in the same slot gets its own). `None` when this turn did not wait, or for another conversation.
pub fn claim_queued_turn(live_conv_id: Option<&str>) -> Option<String> {
    let queued = current_queued_turn()?;
    let mut flags = queued.flags.lock();
    if flags.claimed || flags.ended || live_conv_id.is_some_and(|conv| !conv.is_empty() && conv != queued.live_conv) {
        return None;
    }
    flags.claimed = true;
    Some(queued.turn_id.clone())
}

/// Whether the turn beginning now in conversation `conv_id` waited behind another one of it: true once per waiting
/// slot (the provider puts a note on that prompt), false for a turn that never waited, for a second turn in the
/// same slot, and for any other conversation's turn started from inside it.
pub fn take_queued_note(conv_id: &str) -> bool {
    let Some(queued) = current_queued_turn() else {
        return false;
    };
    let mut flags = queued.flags.lock();
    if flags.noted || conv_id.is_empty() || queued.live_conv != conv_id {
        return false;
    }
    flags.noted = true;
    true
}

/// The queued turn whose slot is running now (the caller's own, inside its `f`), or `None`.
pub fn current_queued_turn() -> Option<Arc<QueuedTurn>> {
    TURN_STORE.try_with(|queued| queued.clone()).ok()
}

/// Runs `future` as part of the queued turn `queued` (what [`current_queued_turn`] gave): for a task spawned from
/// inside a turn, which would otherwise not see whose slot it runs in. With `None` the future runs as it is.
pub async fn scope_queued_turn<Fut: Future>(queued: Option<Arc<QueuedTurn>>, future: Fut) -> Fut::Output {
    match queued {
        Some(queued) => TURN_STORE.scope(queued, future).await,
        None => future.await,
    }
}

/// Test hook: drop all state (`_resetConversationLocks`). Turns already queued or running finish among themselves;
/// turns that arrive afterwards do not see them.
pub fn reset_conversation_locks(app: &App) {
    app.remove::<ConversationLocks>();
}

#[cfg(test)]
mod tests;
