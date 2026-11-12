//! The harness for testing the browser files in a real browser.
//!
//! - [`Page`]: one test's tab. `Page::with_scripts(&["chat-core.js"])` opens a blank page that loads those files from
//!   `src/public/js/`; `Page::open(url)` opens any address. Then `eval`, `call`, `apply`, `wait_for`, `text`, `attr`,
//!   `click`, `type_text`, `press`, `set_files`, `cookie`, `grant`. Errors the page reports fail the test unless it
//!   takes them (`take_errors`).
//! - [`Site`]: what the browser loads, served over HTTP on a loopback port: `src/public/` as the server serves it,
//!   pages a test makes, and routes of a test's own (`Site::start(router)`).
//! - [`files`]: the browser files and other repository files, read as text by the tests that need no browser.
//!
//! One headless browser serves the whole test binary. It is found (`TARSEE_CHROMIUM_PATH`, else Playwright's
//! Chromium, else the system's Chrome, Chromium or Edge) and started on first use, through `tarsee-testbin`'s
//! `browser-guard` role, which stops it and removes its profile folder when the test binary ends, however it ends.

mod browser;
pub mod files;
mod page;
mod site;

#[allow(unused_imports)]
pub use page::{Page, WAIT_LIMIT, js_string, truthy};
#[allow(unused_imports)]
pub use site::Site;
