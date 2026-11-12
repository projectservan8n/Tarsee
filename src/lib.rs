//! Tarsee: AI gateway and chat platform with voice calls, multi-provider support and channel integrations.
//!
//! This crate is the Rust port of the Node.js server. The folders mirror the Node layout one to one
//! (`src/ai/turn.js` is `src/ai/turn.rs`), so anything known about the old code still says where to look.
//! `docs/rust-port/DESIGN.md` explains the few places the two differ and why.

pub mod ai;
pub mod app;
pub mod channels;
pub mod cli;
pub mod config;
pub mod daemon;
pub mod db;
pub mod env;
pub mod error;
pub mod hooks;
// The Node folder `src/lib/` keeps its name, so `src/lib/tools.js` is `src/lib/tools.rs`. The path is spelled out
// because `mod lib;` inside `lib.rs` could otherwise mean this file.
#[path = "lib/mod.rs"]
pub mod lib;
pub mod middleware;
pub mod net;
pub mod routes;
pub mod server;
pub mod testkit;
pub mod util;
pub mod voice;
pub mod websocket;

pub use app::{App, WeakApp};
pub use config::Config;
pub use db::Db;
pub use env::Env;
pub use error::{ApiError, ApiResult};

/// The version in `Cargo.toml`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
