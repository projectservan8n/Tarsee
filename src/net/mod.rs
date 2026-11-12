//! Networking shared by the whole crate.

pub mod fetch;

pub use fetch::{Fetch, FetchError, FetchRequest, FetchResponse, ReqwestFetch};
