//! Networking shared by the whole crate.

pub mod fetch;

pub use fetch::{Fetch, FetchError, FetchRequest, FetchResponse, ReqwestFetch};

/// Chooses the cryptography library that TLS uses, for the whole process. Several of Tarsee's dependencies bring
/// `rustls`, and between them both of its backends are compiled in; `rustls` then refuses to pick one by itself and
/// panics on the first `wss://` or `https://` connection made through it directly (a secure WebSocket: Slack's
/// Socket Mode, Edge's read-aloud service). Called first thing in `main`, and by the test app; calling it again
/// does nothing.
pub fn install_crypto_provider() {
    // An error only means a provider is already installed, which is what is wanted.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}
