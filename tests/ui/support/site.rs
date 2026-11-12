//! A site for the browser to load: the browser files of `src/public/` over HTTP on a loopback port chosen by the
//! system, the way the server serves them, plus pages a test makes (a blank page that loads chosen scripts).

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};

use axum::Router;
use axum::extract::Path as UrlPath;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use tokio::sync::oneshot;
use tower_http::services::ServeDir;

use super::browser::runtime;
use super::files::public_dir;

/// A running test site. Dropping it stops it (the shared one runs until the test binary ends).
pub struct Site {
    base: String,
    pages: Arc<Mutex<Vec<String>>>,
    stop: Option<oneshot::Sender<()>>,
}

impl Site {
    /// The site every test shares: the browser files and the pages tests make.
    pub fn shared() -> &'static Site {
        static SHARED: OnceLock<Site> = OnceLock::new();
        SHARED.get_or_init(|| Site::start(Router::new()))
    }

    /// A site of the test's own: `routes` first (say, a stand-in for an API route the page calls), then everything
    /// the shared site has. It has its own address, so it is its own origin (its own cookies and storage).
    pub fn start(routes: Router) -> Site {
        let pages: Arc<Mutex<Vec<String>>> = Arc::default();
        let served = Arc::clone(&pages);
        let app = routes
            .route(
                "/__ui/page/{id}",
                get(move |UrlPath(id): UrlPath<usize>| {
                    let page = served.lock().expect("pages").get(id).cloned();
                    async move { html(page) }
                }),
            )
            .fallback_service(ServeDir::new(public_dir()));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port for the test site");
        listener.set_nonblocking(true).expect("a non-blocking listener");
        let addr: SocketAddr = listener.local_addr().expect("the test site's address");
        let (stop, stopped) = oneshot::channel::<()>();
        runtime().spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).expect("the test site's listener");
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await;
        });
        Site {
            base: format!("http://{addr}"),
            pages,
            stop: Some(stop),
        }
    }

    /// `http://127.0.0.1:<port>`.
    pub fn base(&self) -> &str {
        &self.base
    }

    /// The address of `path` (from the site's root: `/index.html`) on this site.
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// Serves `html` as a page of its own and gives its address.
    pub fn page(&self, html: impl Into<String>) -> String {
        let mut pages = self.pages.lock().expect("pages");
        pages.push(html.into());
        self.url(&format!("/__ui/page/{}", pages.len() - 1))
    }

    /// A blank page that loads `scripts` in order, in its head, as `index.html` loads them. A script is a file name in
    /// `src/public/js/` (`chat-core.js`) or a path from the site's root (`/sw-register.js`). `body` is the page's body.
    pub fn scripts_page(&self, scripts: &[&str], body: &str) -> String {
        let tags: String = scripts
            .iter()
            .map(|s| {
                let src = if s.starts_with('/') {
                    s.to_string()
                } else {
                    format!("/js/{s}")
                };
                format!("<script src=\"{src}\"></script>\n")
            })
            .collect();
        self.page(format!(
            "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Tarsee UI test</title>\n\
             {tags}</head>\n<body>{body}</body>\n</html>\n"
        ))
    }
}

impl Drop for Site {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

fn html(page: Option<String>) -> Response {
    match page {
        Some(page) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], page).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
