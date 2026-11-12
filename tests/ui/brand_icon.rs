//! Port of the browser half of `test/brand-icon.test.js` ("brand icon: TarseeBrand on the page"):
//! `src/public/js/brand-icon.js` on a stand-in page (its icon links and pictures; no Settings section) whose server
//! answers GET /api/settings/brand-icon as the test says. The rest of that file (the PNG decoder, the icon set, the
//! routes) is the server's, ported with `src/lib/brand_icon.rs` (package B2).
//!
//! The Node test ran the file against an object standing in for the window, at https://app.example. Here it runs in
//! the browser on a site of the test's own; the page's own address stands where https://app.example stood (the
//! picture at an absolute address of the same site).

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::http::{StatusCode, Uri, header};
use axum::routing::get;
use serde_json::{Value, json};

use crate::support::files::public_dir;
use crate::support::{Page, Site};

/// The stand-in page's site, and what was asked of GET /api/settings/brand-icon.
struct Stand {
    site: Site,
    asked: Arc<Mutex<Vec<String>>>,
}

/// A site whose GET /api/settings/brand-icon answers `status` with `body`.
fn stand_in(status: StatusCode, body: Value) -> Stand {
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = Arc::clone(&asked);
    let photo = std::fs::read(public_dir().join("icon-16.png")).expect("a picture");
    let routes = Router::new()
        .route(
            "/api/settings/brand-icon",
            get(move |uri: Uri| {
                log.lock().expect("log").push(uri.path().to_string());
                let body = body.clone();
                async move { (status, axum::Json(body)) }
            }),
        )
        // (A picture of the page's that is not an icon.)
        .route(
            "/img/photo.png",
            get(move || {
                let photo = photo.clone();
                async move { ([(header::CONTENT_TYPE, "image/png")], photo) }
            }),
        );
    Stand {
        site: Site::start(routes),
        asked,
    }
}

/// The stand-in page: its icon links and pictures, and js/brand-icon.js. `signIn`: fire "tarsee:signed-in", as app.js
/// does once there is a session (after a listener notes every "tarsee:icon-changed").
async fn page(stand: &Stand, sign_in: bool) -> Page {
    let base = stand.site.base();
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>brand icon</title>
<link rel="icon" href="/icon-32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.json">
<link rel="stylesheet" href="/css/style.css">
<script src="/js/brand-icon.js"></script>
</head>
<body>
<img src="/icon-192.png">
<img src="{base}/icon-32.png?v=old">
<img src="/img/photo.png">
</body>
</html>
"#
    );
    let page = Page::open(&stand.site.page(html)).await;
    page.eval("window.heard = []; addEventListener('tarsee:icon-changed', (e) => heard.push(e.detail)); 0")
        .await;
    if sign_in {
        page.eval("dispatchEvent(new CustomEvent('tarsee:signed-in')); 0").await;
        // The page has had its answer once the browser has the whole response (its timing entry is there).
        page.wait_for(
            "performance.getEntriesByType('resource').some((e) => e.name.endsWith('/api/settings/brand-icon'))",
            "the answer to GET /api/settings/brand-icon",
        )
        .await;
    }
    page
}

/// The icon links' and pictures' addresses, in the order the Node test's stand-in page had them.
async fn addresses(page: &Page) -> Value {
    page.eval(
        r#"[
            ...[...document.querySelectorAll("link")].map((l) => l.getAttribute("href")),
            ...[...document.querySelectorAll("img")].map((i) => i.getAttribute("src")),
        ]"#,
    )
    .await
}

fn asked(stand: &Stand) -> Vec<String> {
    stand.asked.lock().expect("log").clone()
}

#[tokio::test]
async fn before_sign_in_nothing_is_asked_there_is_no_version_and_the_addresses_stay_as_they_are() {
    let stand = stand_in(StatusCode::OK, json!({ "custom": false, "version": "d1" }));
    let page = page(&stand, false).await;
    assert!(asked(&stand).is_empty());
    assert!(page.is_null("TarseeBrand.version").await);
    assert_eq!(
        page.call("TarseeBrand.src", json!(["/icon-32.png"])).await,
        "/icon-32.png"
    );
    assert_eq!(addresses(&page).await[0], "/icon-32.png");
    assert_eq!(
        page.eval("Object.isFrozen(TarseeBrand) && TarseeBrand.paths.includes('/favicon.ico')")
            .await,
        true
    );
}

#[tokio::test]
async fn signed_in_the_version_from_get_api_settings_brand_icon_on_every_icon_address_and_tarsee_icon_changed() {
    let stand = stand_in(
        StatusCode::OK,
        json!({ "custom": true, "version": "def456", "updatedAt": "2026-01-01T00:00:00.000Z" }),
    );
    let page = page(&stand, true).await;
    assert_eq!(asked(&stand), ["/api/settings/brand-icon"]);
    assert_eq!(page.eval("TarseeBrand.version").await, "def456");
    let src = |address: &'static str| {
        let page = &page;
        async move { page.call("TarseeBrand.src", json!([address])).await }
    };
    assert_eq!(src("/icon-32.png").await, "/icon-32.png?v=def456");
    assert_eq!(src("/icon-192.png?v=old").await, "/icon-192.png?v=def456");
    assert_eq!(src("/manifest.json").await, "/manifest.json?v=def456");
    assert_eq!(src("/js/app.js").await, "/js/app.js");
    assert_eq!(
        src("https://elsewhere.example/icon-32.png").await,
        "https://elsewhere.example/icon-32.png"
    );
    let base = stand.site.base();
    assert_eq!(
        addresses(&page).await,
        json!([
            "/icon-32.png?v=def456",
            "/apple-touch-icon.png?v=def456",
            "/manifest.json?v=def456",
            "/css/style.css",
            "/icon-192.png?v=def456",
            format!("{base}/icon-32.png?v=def456"),
            "/img/photo.png",
        ])
    );
    let changed = page.eval("heard").await;
    assert_eq!(changed.as_array().expect("events").len(), 1);
    assert_eq!(changed[0], json!({ "version": "def456", "initial": true }));
}

#[tokio::test]
async fn a_lapsed_session_401_no_version_and_the_page_is_left_as_it_is() {
    let stand = stand_in(StatusCode::UNAUTHORIZED, json!({ "error": "Unauthorized" }));
    let page = page(&stand, true).await;
    // (The browser reports the 401 itself, as it does any request refused.)
    let errors = page.take_errors().await;
    assert!(
        errors.iter().all(|e| e.contains("401")),
        "only the refused request: {errors:?}"
    );
    assert_eq!(asked(&stand).len(), 1);
    assert!(page.is_null("TarseeBrand.version").await);
    assert_eq!(addresses(&page).await[0], "/icon-32.png");
}
