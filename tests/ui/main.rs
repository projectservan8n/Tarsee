//! Tests of the browser UI (`src/public/`): its files run in a real browser, and its files read as text.
//!
//! A test binary of its own, apart from `it`, so the rest of the suite never needs a browser. The harness is in
//! `support/`; each other module is the port of one Node test file (`test/chat-core.test.js` is `chat_core.rs`).

mod support;

mod channel_guides_core;
mod chat_core;
mod dialogs;
mod harness;
mod usage_core;
