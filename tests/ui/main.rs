//! Tests of the browser UI (`src/public/`): its files run in a real browser, and its files read as text.
//!
//! A test binary of its own, apart from `it`, so the rest of the suite never needs a browser. The harness is in
//! `support/`; each other module is the port of one Node test file (`test/chat-core.test.js` is `chat_core.rs`), and
//! `harness.rs` tests the harness itself.

mod support;

mod ai_settings_ui;
mod brand_icon;
mod channel_guides_core;
mod chat_core;
mod chat_files;
mod dialogs;
mod harness;
mod model_picker_core;
mod no_native_dialogs;
mod provider_guides_core;
mod usage_core;
