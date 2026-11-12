//! Port of `src/lib/canvas.js`: the canvas (A2UI) server. Serves AI-generated HTML/CSS/JS pages from the workspace's
//! `canvas` folder, at `/canvas/<id>/`.
//!
//! The Express middleware becomes [`canvas_middleware`]: it takes a request and either answers it or hands it back
//! for the next handler. Whether the request is signed in comes from the caller (the session middleware's
//! `req.auth`, package B1), so `server.rs` wires it as:
//!
//! ```ignore
//! async fn canvas(State(app): State<App>, req: Request, next: Next) -> Response {
//!     let signed_in = /* req.auth?.authenticated */;
//!     match canvas::canvas_middleware(&app, signed_in, req).await {
//!         Ok(res) => res,
//!         Err(req) => next.run(req).await,
//!     }
//! }
//! ```

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::Serialize;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::app::App;
use crate::config::Config;
use crate::lib::workspace_files::jstext::{process_zone, read_dir_sorted};
use crate::util::js::{iso_from_ms, utf16_len};

/// The folder the canvases live in (`CANVAS_DIR`).
pub fn canvas_dir(config: &Config) -> PathBuf {
    config.workspace_dir.join("canvas")
}

/// What [`CanvasServer::serve`] wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServedCanvas {
    pub canvas_id: String,
    pub path: String,
    /// The page's length in UTF-16 units (`fullHtml.length`).
    pub size: usize,
}

/// One canvas folder (`list()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasInfo {
    pub id: String,
    pub has_index: bool,
    pub size: u64,
    /// When index.html last changed (ISO); absent when there is none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
}

/// Writes and reads the canvases.
#[derive(Debug, Clone)]
pub struct CanvasServer {
    dir: PathBuf,
}

impl CanvasServer {
    /// Makes the canvas folder if it is missing (`new CanvasServer()`).
    pub fn new(config: &Config) -> std::io::Result<Self> {
        let dir = canvas_dir(config);
        fs::create_dir_all(&dir)?;
        Ok(CanvasServer { dir })
    }

    /// `CanvasServer.create()`.
    pub fn create(config: &Config) -> std::io::Result<Self> {
        Self::new(config)
    }

    /// Writes a canvas page: the HTML, with the CSS in a <style> before it and the JS in a <script> after it.
    ///
    /// `None` is a value the caller did not give (`undefined`): without HTML the JS wrote "undefined" where the
    /// HTML goes when there is CSS or JS, and refused to write the file otherwise.
    pub fn serve(
        &self,
        canvas_id: &str,
        html: Option<&str>,
        css: Option<&str>,
        js: Option<&str>,
    ) -> std::io::Result<ServedCanvas> {
        let dir = self.dir.join(canvas_id);
        fs::create_dir_all(&dir)?;

        let css = css.filter(|c| !c.is_empty());
        let js = js.filter(|j| !j.is_empty());
        let mut full_html = match html {
            Some(h) => h.to_string(),
            None if css.is_some() || js.is_some() => "undefined".to_string(),
            None => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "The \"data\" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined",
                ));
            }
        };
        if let Some(css) = css {
            full_html = format!("<style>{css}</style>\n{full_html}");
        }
        if let Some(js) = js {
            full_html = format!("{full_html}\n<script>{js}</script>");
        }

        // Live-reload injection REMOVED. There is no /canvas-ws server anywhere in this codebase, so the socket fell
        // through the upgrade handler to the CHAT WebSocket (which only special-cases /terminal). Any chat frame then
        // hit `onmessage => location.reload()`, i.e. a reload loop. It was masked on Railway only because ws:// is
        // blocked as mixed content on an HTTPS page — "fixing" that to wss:// would have armed the loop instead of
        // curing it. Every canvas page was also opening a stray authenticated chat socket. If live reload is wanted
        // later, BOTH halves have to be built: a dedicated /canvas-ws branch in the upgrade handler plus a file-watch
        // broadcaster.

        fs::write(dir.join("index.html"), &full_html)?;
        Ok(ServedCanvas {
            canvas_id: canvas_id.to_string(),
            path: format!("/canvas/{canvas_id}/"),
            size: utf16_len(&full_html),
        })
    }

    /// Every canvas folder, with its index.html's size and time. Empty when the folder cannot be read.
    pub fn list(&self) -> Vec<CanvasInfo> {
        let Ok(entries) = read_dir_sorted(&self.dir) else {
            return Vec::new();
        };
        entries
            .into_iter()
            .filter(|d| d.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|d| {
                let id = d.file_name().to_string_lossy().into_owned();
                let meta = fs::metadata(self.dir.join(&id).join("index.html")).ok();
                CanvasInfo {
                    has_index: meta.is_some(),
                    size: meta.as_ref().map_or(0, |m| m.len()),
                    modified: meta.and_then(|m| m.modified().ok()).map(|t| iso_from_ms(ms_of(t))),
                    id,
                }
            })
            .collect()
    }

    /// A canvas's page, or `None`.
    pub fn get(&self, canvas_id: &str) -> Option<String> {
        fs::read(self.dir.join(canvas_id).join("index.html"))
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    }

    /// Deletes a canvas; false when there was nothing to delete or it could not be.
    pub fn delete(&self, canvas_id: &str) -> bool {
        let dir = self.dir.join(canvas_id);
        let removed = if dir.is_dir() {
            fs::remove_dir_all(&dir)
        } else {
            fs::remove_file(&dir)
        };
        removed.is_ok()
    }

    pub fn get_file_path(&self, canvas_id: &str, filename: &str) -> PathBuf {
        self.dir.join(canvas_id).join(filename)
    }
}

fn ms_of(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Escapes a string for safe interpolation into HTML text and attributes.
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// The Content-Security-Policy that locks a canvas response into an opaque origin.
///
/// Canvas HTML is written by the model, and the model reads untrusted input: inbound email, WhatsApp messages,
/// fetched web pages. A prompt injection that reaches create_canvas used to get script execution on Tarsee's own
/// origin — the page could call /api/auth/api-token, read the vault through /api/files, and exfiltrate the Claude
/// credentials, because the app-wide CSP allows 'unsafe-inline' and the chat embedded it with allow-same-origin.
///
/// The CSP `sandbox` directive applies to top-level navigations as well as frames, so it holds whether the canvas
/// is opened directly or embedded. No allow-same-origin: the page still renders and its own scripts still run, but
/// in a null origin with no access to Tarsee's cookies, storage, or same-origin API surface.
pub const CANVAS_CSP: &str = concat!(
    "sandbox allow-scripts allow-forms allow-modals allow-popups; ",
    "default-src 'self' data: blob:; ",
    "script-src 'self' 'unsafe-inline' data: blob: https://cdn.jsdelivr.net https://cdn.tailwindcss.com; ",
    "style-src 'self' 'unsafe-inline' data: https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdn.tailwindcss.com; ",
    "img-src 'self' data: blob:; ",
    "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; ",
    // No 'self' here: a canvas has no business calling Tarsee's own API.
    "connect-src https://cdn.jsdelivr.net https://cdn.tailwindcss.com; ",
    "object-src 'none'; ",
    "base-uri 'none'; ",
    "form-action 'none'"
);

fn apply_canvas_isolation(headers: &mut HeaderMap) {
    headers.insert("content-security-policy", HeaderValue::from_static(CANVAS_CSP));
    headers.insert("cross-origin-opener-policy", HeaderValue::from_static("same-origin"));
    headers.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
}

/// `res.status(status).send(text)`: an HTML answer.
fn html(status: StatusCode, text: impl Into<String>) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        text.into(),
    )
        .into_response()
}

const SIGN_IN_PAGE: &str = concat!(
    "<!DOCTYPE html><html><body style=\"background:#1a1a1a;color:#ececec;font-family:sans-serif;padding:40px\">",
    "<h1>Sign in required</h1><p>Log in to Tarsee to view this canvas.</p></body></html>"
);

/// Serves `/canvas/...`: the gallery at `/canvas/`, a canvas's files below it. Answers `Ok(response)`, or hands the
/// request back (`Err(request)`, the JS `next()`) when it is not a canvas path or names a folder.
///
/// Canvases are private. They routinely contain whatever the user asked the agent to visualise — revenue
/// dashboards, customer lists, internal process diagrams — and this runs before any auth, so /canvas/ used to
/// enumerate and serve every canvas ever generated to anyone who found the URL. It requires the same session or API
/// token the rest of the app does (`signed_in`); the chat iframe is same-origin and sends the cookie automatically.
pub async fn canvas_middleware(app: &App, signed_in: bool, req: Request<Body>) -> Result<Response, Request<Body>> {
    // `req.path`: the path as sent, not decoded.
    let path = req.uri().path().to_string();
    let Some(rest) = path.strip_prefix("/canvas/") else {
        return Err(req);
    };

    if !signed_in {
        return Ok(html(StatusCode::UNAUTHORIZED, SIGN_IN_PAGE));
    }

    let mut res = match serve_canvas_path(app, rest.to_string(), req).await {
        Ok(res) => res,
        Err(req) => return Err(req),
    };
    apply_canvas_isolation(res.headers_mut());
    Ok(res)
}

async fn serve_canvas_path(app: &App, rest: String, req: Request<Body>) -> Result<Response, Request<Body>> {
    let dir = canvas_dir(app.config());
    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();

    // Gallery: /canvas/ with no ID lists every canvas.
    if parts.is_empty() {
        return Ok(gallery(app, &dir));
    }

    let canvas_id = parts[0];
    let filename = if parts.len() > 1 {
        parts[1..].join("/")
    } else {
        "index.html".to_string()
    };
    let base = normalize_path(&dir.to_string_lossy());
    let file_path = normalize_path(&format!(
        "{base}{}{canvas_id}{}{filename}",
        std::path::MAIN_SEPARATOR,
        std::path::MAIN_SEPARATOR
    ));
    if !file_path.starts_with(&base) {
        return Ok(html(StatusCode::FORBIDDEN, "Forbidden"));
    }
    let file_path = PathBuf::from(file_path);

    if !file_path.exists() {
        return Ok(html(StatusCode::NOT_FOUND, "Canvas not found"));
    }
    if file_path.is_dir() {
        // res.sendFile on a folder goes on to the next handler.
        return Err(req);
    }
    // A file whose name starts with a dot is not sent (the send module's default), which the error handler
    // answered as a 404.
    if file_path
        .file_name()
        .is_some_and(|n| n.to_string_lossy().starts_with('.'))
    {
        return Ok((
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({ "error": "Not Found" })),
        )
            .into_response());
    }
    Ok(send_file(&file_path, req).await)
}

fn gallery(app: &App, dir: &Path) -> Response {
    let Ok(entries) = fs::read_dir(dir) else {
        return html(StatusCode::INTERNAL_SERVER_ERROR, "Error loading gallery");
    };
    let mut canvases: Vec<(String, u64, SystemTime)> = Vec::new();
    let mut names: Vec<fs::DirEntry> = entries.filter_map(Result::ok).collect();
    names.sort_by(|a, b| a.file_name().as_encoded_bytes().cmp(b.file_name().as_encoded_bytes()));
    for d in names {
        let name = d.file_name().to_string_lossy().into_owned();
        let index = dir.join(&name).join("index.html");
        if !d.file_type().map(|t| t.is_dir()).unwrap_or(false) || !index.exists() {
            continue;
        }
        let Ok(meta) = fs::metadata(&index) else {
            return html(StatusCode::INTERNAL_SERVER_ERROR, "Error loading gallery");
        };
        canvases.push((name, meta.len(), meta.modified().unwrap_or(UNIX_EPOCH)));
    }
    // Newest first; a stable sort.
    canvases.sort_by_key(|c| std::cmp::Reverse(c.2));

    if canvases.is_empty() {
        return html(
            StatusCode::OK,
            "<!DOCTYPE html><html><head><title>Canvas Gallery</title><style>body{background:#1a1a1a;color:#ececec;font-family:Poppins,sans-serif;padding:40px;text-align:center}h1{color:#c45a35}p{color:#a8a8a0}</style></head><body><h1>Canvas Gallery</h1><p>No canvases yet. Ask Tarsee to create one!</p></body></html>",
        );
    }

    // Canvas names are folder names on disk and are model-controlled, so they must be escaped for text and
    // URL-encoded for the href — otherwise a canvas named `<img src=x onerror=...>` is stored XSS on this page.
    let zone = process_zone(app.env());
    let items: String = canvases
        .iter()
        .map(|(name, size, modified)| {
            // toLocaleDateString(): "11/12/2026", in the process's timezone.
            let date = DateTime::<Utc>::from(*modified)
                .with_timezone(&zone)
                .format("%-m/%-d/%Y")
                .to_string();
            format!(
                "<a href=\"/canvas/{}/\" style=\"display:block;background:#2b2a27;border-radius:8px;padding:16px;margin:8px 0;text-decoration:none;color:#ececec;border:1px solid #3a3935\"><strong>{}</strong><br><span style=\"color:#a8a8a0;font-size:12px\">{}KB &middot; {}</span></a>",
                encode_uri_component(name),
                escape_html(name),
                (*size as f64 / 1024.0 + 0.5).floor() as u64,
                escape_html(&date)
            )
        })
        .collect();
    html(
        StatusCode::OK,
        format!(
            "<!DOCTYPE html><html><head><title>Canvas Gallery</title><style>body{{background:#1a1a1a;color:#ececec;font-family:Poppins,sans-serif;padding:40px;max-width:600px;margin:0 auto}}h1{{color:#c45a35}}a:hover{{border-color:#c45a35!important}}</style></head><body><h1>Canvas Gallery</h1>{items}</body></html>"
        ),
    )
}

/// `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` percent-encoded as UTF-8.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `path.join` with its lexical clean-up: `.` and empty parts dropped, `..` taking the part before it away (never
/// above the root), both separators read as separators on Windows.
fn normalize_path(path: &str) -> String {
    let sep = std::path::MAIN_SEPARATOR;
    let is_sep = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    // The root ("/", "C:\", "\\server\share\") is kept as it is.
    let (root, rest) = split_root(path, is_sep);
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split(is_sep) {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else if root.is_empty() {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    format!("{root}{}", parts.join(&sep.to_string()))
}

fn split_root(path: &str, is_sep: impl Fn(char) -> bool) -> (String, &str) {
    let sep = std::path::MAIN_SEPARATOR;
    if cfg!(windows) {
        let bytes = path.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            let rest = &path[2..];
            let trimmed = rest.trim_start_matches(&is_sep);
            let root = if trimmed.len() < rest.len() {
                format!("{}{sep}", &path[..2])
            } else {
                path[..2].to_string()
            };
            return (root, trimmed);
        }
    }
    let trimmed = path.trim_start_matches(&is_sep);
    if trimmed.len() < path.len() {
        (sep.to_string(), trimmed)
    } else {
        (String::new(), path)
    }
}

/// The Content-Type the send module gave a file (mime-types' `contentType(ext)`).
fn content_type_of(path: &Path) -> String {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let known = match ext.as_str() {
        "html" | "htm" => Some("text/html; charset=utf-8"),
        "js" | "mjs" => Some("text/javascript; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "json" => Some("application/json; charset=utf-8"),
        "txt" => Some("text/plain; charset=utf-8"),
        "md" => Some("text/markdown; charset=utf-8"),
        "csv" => Some("text/csv; charset=utf-8"),
        "svg" => Some("image/svg+xml"),
        "xml" => Some("application/xml"),
        "ico" => Some("image/vnd.microsoft.icon"),
        "wasm" => Some("application/wasm"),
        "" => Some("application/octet-stream"),
        _ => None,
    };
    if let Some(known) = known {
        return known.to_string();
    }
    match mime_guess::from_ext(&ext).first_raw() {
        Some(mime) if mime.starts_with("text/") => format!("{mime}; charset=utf-8"),
        Some(mime) => mime.to_string(),
        None => "application/octet-stream".to_string(),
    }
}

/// `res.sendFile(path)`: the file with its type, `Cache-Control: public, max-age=0`, a weak ETag of its size and
/// time, Last-Modified, and answers to conditional and range requests, whatever the method.
async fn send_file(path: &Path, req: Request<Body>) -> Response {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(_) => return html(StatusCode::NOT_FOUND, "Canvas not found"),
    };
    let modified_ms = meta.modified().map(ms_of).unwrap_or(0);
    let etag = format!("W/\"{:x}-{:x}\"", meta.len(), modified_ms);

    let (mut parts, body) = req.into_parts();
    if parts.method != Method::HEAD {
        parts.method = Method::GET;
    }
    // If-None-Match decides when it is there (as the `fresh` module does): a match is a 304, a miss is a full
    // answer whatever If-Modified-Since says.
    if let Some(wanted) = parts.headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) {
        let strip = |t: &str| t.trim().trim_start_matches("W/").to_string();
        let matches = wanted.trim() == "*" || wanted.split(',').any(|t| strip(t) == strip(&etag));
        if matches {
            let mut res = StatusCode::NOT_MODIFIED.into_response();
            res.headers_mut().insert(header::ETAG, header_value(&etag));
            return res;
        }
        parts.headers.remove(header::IF_MODIFIED_SINCE);
    }

    let req = Request::from_parts(parts, body);
    let mut res = match ServeFile::new(path).oneshot(req).await {
        Ok(res) => res.map(Body::new),
        Err(_) => return html(StatusCode::NOT_FOUND, "Canvas not found"),
    };
    let not_modified = res.status() == StatusCode::NOT_MODIFIED;
    let headers = res.headers_mut();
    if !not_modified {
        headers.insert(header::CONTENT_TYPE, header_value(&content_type_of(path)));
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=0"));
    headers.insert(header::ETAG, header_value(&etag));
    res
}

fn header_value(text: &str) -> HeaderValue {
    HeaderValue::from_str(text).unwrap_or_else(|_| HeaderValue::from_static(""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::http::TestResponse;
    use crate::testkit::{TestApp, test_app_with_env};
    use http_body_util::BodyExt;

    fn app() -> (TestApp, CanvasServer) {
        let t = test_app_with_env([("TZ", "UTC")]);
        let server = CanvasServer::create(t.config()).unwrap();
        (t, server)
    }

    async fn call(t: &TestApp, signed_in: bool, req: Request<Body>) -> Option<TestResponse> {
        let res = canvas_middleware(t, signed_in, req).await.ok()?;
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        Some(TestResponse { status, headers, body })
    }

    fn get(path: &str) -> Request<Body> {
        Request::builder().uri(path).body(Body::empty()).unwrap()
    }

    #[test]
    fn a_page_is_written_with_its_css_and_js_and_listed() {
        let (t, server) = app();
        let served = server
            .serve(
                "chart",
                Some("<h1>Sales</h1>"),
                Some("h1{color:red}"),
                Some("console.log(1)"),
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(&served).unwrap(),
            serde_json::json!({"canvasId": "chart", "path": "/canvas/chart/", "size": 75})
        );
        assert_eq!(
            server.get("chart").as_deref(),
            Some("<style>h1{color:red}</style>\n<h1>Sales</h1>\n<script>console.log(1)</script>")
        );
        server.serve("plain", Some("é🐒"), Some(""), None).unwrap();
        assert_eq!(server.get("plain").as_deref(), Some("é🐒"));
        assert_eq!(
            server.serve("x", None, None, None).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
        assert_eq!(
            server.serve("y", None, Some("a{}"), None).unwrap().size,
            utf16_len("<style>a{}</style>\nundefined")
        );
        fs::create_dir_all(canvas_dir(t.config()).join("empty")).unwrap();
        let list = server.list();
        let ids: Vec<&str> = list.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["chart", "empty", "plain", "x", "y"]);
        let empty = &list[1];
        assert_eq!(
            serde_json::to_value(empty).unwrap(),
            serde_json::json!({"id": "empty", "hasIndex": false, "size": 0})
        );
        assert!(list[0].has_index && list[0].modified.as_deref().unwrap().ends_with('Z'));
        assert!(server.delete("chart"));
        assert!(!server.delete("chart"));
        assert_eq!(server.get("chart"), None);
        assert_eq!(
            server.get_file_path("a", "b.css"),
            canvas_dir(t.config()).join("a").join("b.css")
        );
    }

    #[tokio::test]
    async fn only_canvas_paths_are_answered_and_only_when_signed_in() {
        let (t, server) = app();
        server.serve("c1", Some("<p>hi</p>"), None, None).unwrap();
        assert!(call(&t, true, get("/api/canvas/c1/")).await.is_none());
        assert!(call(&t, true, get("/canvas")).await.is_none());
        let res = call(&t, false, get("/canvas/c1/")).await.unwrap();
        assert_eq!(res.status, 401);
        assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(res.text(), SIGN_IN_PAGE);
        assert_eq!(res.header("content-security-policy"), None);
    }

    #[tokio::test]
    async fn a_canvas_is_sent_isolated_with_its_type_and_cache_headers() {
        let (t, server) = app();
        server.serve("c1", Some("<p>hi</p>"), None, None).unwrap();
        fs::write(canvas_dir(t.config()).join("c1").join("app.js"), "let a = 1;").unwrap();
        let res = call(&t, true, get("/canvas/c1/")).await.unwrap();
        assert_eq!(res.status, 200);
        assert_eq!(res.text(), "<p>hi</p>");
        assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(res.header("content-security-policy"), Some(CANVAS_CSP));
        assert_eq!(res.header("cross-origin-opener-policy"), Some("same-origin"));
        assert_eq!(res.header("cross-origin-resource-policy"), Some("same-origin"));
        assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(res.header("cache-control"), Some("public, max-age=0"));
        let etag = res.header("etag").unwrap().to_string();
        assert!(etag.starts_with("W/\"9-"), "{etag}");
        assert!(res.header("last-modified").is_some());

        let res = call(&t, true, get("/canvas/c1/app.js")).await.unwrap();
        assert_eq!(
            (res.status, res.header("content-type")),
            (200, Some("text/javascript; charset=utf-8"))
        );

        let again = Request::builder()
            .uri("/canvas/c1/index.html")
            .header("if-none-match", &etag)
            .body(Body::empty())
            .unwrap();
        let res = call(&t, true, again).await.unwrap();
        assert_eq!(res.status, 304);
        assert_eq!(res.header("content-security-policy"), Some(CANVAS_CSP));

        let post = Request::builder()
            .method("POST")
            .uri("/canvas/c1/")
            .body(Body::empty())
            .unwrap();
        assert_eq!(call(&t, true, post).await.unwrap().text(), "<p>hi</p>");
    }

    #[tokio::test]
    async fn missing_escaping_and_folders() {
        let (t, server) = app();
        server.serve("c1", Some("x"), None, None).unwrap();
        fs::create_dir_all(canvas_dir(t.config()).join("c1").join("sub")).unwrap();
        fs::write(canvas_dir(t.config()).join("c1").join(".env"), "SECRET=1").unwrap();
        let res = call(&t, true, get("/canvas/nope/")).await.unwrap();
        assert_eq!((res.status, res.text()), (404, "Canvas not found".to_string()));
        assert_eq!(res.header("content-security-policy"), Some(CANVAS_CSP));
        let res = call(&t, true, get("/canvas/c1/../../../secret")).await.unwrap();
        assert_eq!((res.status, res.text()), (403, "Forbidden".to_string()));
        assert!(
            call(&t, true, get("/canvas/c1/sub")).await.is_none(),
            "a folder goes on"
        );
        let res = call(&t, true, get("/canvas/c1/.env")).await.unwrap();
        assert_eq!(
            (res.status, res.json()),
            (404, serde_json::json!({"error": "Not Found"}))
        );
        let res = call(&t, true, get("/canvas/c1/../c1/index.html")).await.unwrap();
        assert_eq!((res.status, res.text()), (200, "x".to_string()));
    }

    #[tokio::test]
    async fn the_gallery_lists_canvases_newest_first_escaped() {
        let (t, server) = app();
        let res = call(&t, true, get("/canvas/")).await.unwrap();
        assert!(res.text().contains("No canvases yet. Ask Tarsee to create one!"));
        server.serve("older", Some(&"x".repeat(1600)), None, None).unwrap();
        server.serve("<img src=x>", Some("y"), None, None).ok();
        let older = fs::File::options()
            .write(true)
            .open(canvas_dir(t.config()).join("older").join("index.html"))
            .unwrap();
        let day = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_605_139_200);
        older.set_modified(day).unwrap();
        fs::create_dir_all(canvas_dir(t.config()).join("no-index")).unwrap();
        let res = call(&t, true, get("/canvas//")).await.unwrap();
        assert_eq!(res.status, 200);
        let page = res.text();
        assert!(page.contains("<a href=\"/canvas/older/\" style=\"display:block;background:#2b2a27;border-radius:8px;padding:16px;margin:8px 0;text-decoration:none;color:#ececec;border:1px solid #3a3935\"><strong>older</strong><br><span style=\"color:#a8a8a0;font-size:12px\">2KB &middot; 11/12/2020</span></a>"));
        assert!(!page.contains("no-index"));
        if cfg!(unix) {
            assert!(page.contains("href=\"/canvas/%3Cimg%20src%3Dx%3E/\""));
            assert!(page.contains("<strong>&lt;img src=x&gt;</strong>"));
            assert!(
                page.find("img src").unwrap() < page.find("older").unwrap(),
                "newest first"
            );
        }
    }

    #[tokio::test]
    async fn the_gallery_page_is_the_one_node_sent() {
        let (t, server) = app();
        server.serve("older", Some(&"x".repeat(1600)), None, None).unwrap();
        server.serve("b-new", Some("hi\n"), None, None).unwrap();
        fs::create_dir_all(canvas_dir(t.config()).join("no-index")).unwrap();
        let set = |name: &str, secs: u64| {
            fs::File::options()
                .write(true)
                .open(canvas_dir(t.config()).join(name).join("index.html"))
                .unwrap()
                .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs))
                .unwrap();
        };
        set("older", 1_794_441_600);
        set("b-new", 1_794_441_600 + 3600);
        // What the Node middleware sent for the same folder (TZ=UTC).
        let node = "<!DOCTYPE html><html><head><title>Canvas Gallery</title><style>body{background:#1a1a1a;color:#ececec;font-family:Poppins,sans-serif;padding:40px;max-width:600px;margin:0 auto}h1{color:#c45a35}a:hover{border-color:#c45a35!important}</style></head><body><h1>Canvas Gallery</h1><a href=\"/canvas/b-new/\" style=\"display:block;background:#2b2a27;border-radius:8px;padding:16px;margin:8px 0;text-decoration:none;color:#ececec;border:1px solid #3a3935\"><strong>b-new</strong><br><span style=\"color:#a8a8a0;font-size:12px\">0KB &middot; 11/12/2026</span></a><a href=\"/canvas/older/\" style=\"display:block;background:#2b2a27;border-radius:8px;padding:16px;margin:8px 0;text-decoration:none;color:#ececec;border:1px solid #3a3935\"><strong>older</strong><br><span style=\"color:#a8a8a0;font-size:12px\">2KB &middot; 11/12/2026</span></a></body></html>";
        let res = call(&t, true, get("/canvas/")).await.unwrap();
        assert_eq!(res.text(), node);
        assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
    }

    #[test]
    fn paths_are_cleaned_up_as_path_join_did() {
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(normalize_path("/a/b/../c/./d"), format!("{sep}a{sep}c{sep}d"));
        assert_eq!(normalize_path("/a/../../x"), format!("{sep}x"));
        assert_eq!(encode_uri_component("a b/é~"), "a%20b%2F%C3%A9~");
        assert_eq!(
            escape_html("<a href=\"x\">'&'</a>"),
            "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
        );
    }
}
