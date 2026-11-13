//! Port of `src/lib/canvas.js`: the canvas (A2UI) server. Serves AI-generated HTML/CSS/JS pages from the workspace's
//! `canvas` folder, at `/canvas/<id>/`.
//!
//! The Express middleware is [`canvas_middleware`], an axum middleware: `server.rs` applies it where `server.js`
//! applied `canvasMiddleware` (after the session middleware, whose `req.auth` it reads as [`Auth`]):
//!
//! ```ignore
//! router.layer(axum::middleware::from_fn_with_state(app.clone(), canvas::canvas_middleware))
//! ```
//!
//! A file is sent as Express's `res.sendFile` (the send module) sent it: its type, `Cache-Control: public,
//! max-age=0`, a weak ETag of its size and time, Last-Modified, conditional and range requests. A page sent as text
//! carries the weak ETag Express made of its body.

use std::fs;
use std::io::SeekFrom;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sha1::{Digest, Sha1};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::app::App;
use crate::config::Config;
use crate::lib::safe_path::{is_inside, node_join, same_path};
use crate::lib::workspace_files::is_plain_name;
use crate::lib::workspace_files::jstext::{process_zone, read_dir_sorted};
use crate::middleware::auth::Auth;
use crate::util::js::{iso_from_ms, utf16_len};
use crate::util::node_path::to_namespaced;

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

fn invalid_id(canvas_id: &str) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        format!("Invalid canvas id: {canvas_id}"),
    )
}

/// Writes and reads the canvases.
///
/// A canvas id must be one plain name (no separators, not `.` or `..`, not absolute). The tools reduce ids to
/// `[a-z0-9-]` before they get here; the check keeps any other caller inside the canvas folder, which the JS's
/// `path.join` did not (`..` led out of it).
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
        if !is_plain_name(canvas_id) {
            return Err(invalid_id(canvas_id));
        }
        // The literal path: on Windows an id `nul` or `chart.` names a folder of that name.
        let dir = to_namespaced(&self.dir.join(canvas_id));
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
                let meta = fs::metadata(to_namespaced(&self.dir.join(&id).join("index.html"))).ok();
                CanvasInfo {
                    has_index: meta.is_some(),
                    size: meta.as_ref().map_or(0, |m| m.len()),
                    modified: meta.as_ref().map(|m| iso_from_ms(mtime_ms(m))),
                    id,
                }
            })
            .collect()
    }

    /// A canvas's page, or `None`.
    pub fn get(&self, canvas_id: &str) -> Option<String> {
        if !is_plain_name(canvas_id) {
            return None;
        }
        fs::read(to_namespaced(&self.dir.join(canvas_id).join("index.html")))
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    }

    /// Deletes a canvas (a folder with everything in it, or a file); false when there was nothing to delete or it
    /// could not be.
    pub fn delete(&self, canvas_id: &str) -> bool {
        if !is_plain_name(canvas_id) {
            return false;
        }
        let dir = to_namespaced(&self.dir.join(canvas_id));
        let is_dir = fs::symlink_metadata(&dir).map(|m| m.is_dir()).unwrap_or(false);
        let removed = if is_dir {
            fs::remove_dir_all(&dir)
        } else {
            fs::remove_file(&dir)
        };
        removed.is_ok()
    }

    /// `path.join(CANVAS_DIR, canvasId, filename)`, joined and tidied as Node did (an absolute piece stays under the
    /// canvas folder).
    pub fn get_file_path(&self, canvas_id: &str, filename: &str) -> PathBuf {
        PathBuf::from(node_join(&[&self.dir.to_string_lossy(), canvas_id, filename]))
    }
}

/// A file's modification time in whole milliseconds, as Node's `stat.mtime` Date held it (rounded).
fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| (d.as_nanos() as f64 / 1e6).round() as i64)
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

const SIGN_IN_PAGE: &str = concat!(
    "<!DOCTYPE html><html><body style=\"background:#1a1a1a;color:#ececec;font-family:sans-serif;padding:40px\">",
    "<h1>Sign in required</h1><p>Log in to Tarsee to view this canvas.</p></body></html>"
);

const HTML: &str = "text/html; charset=utf-8";
const JSON: &str = "application/json; charset=utf-8";

/// The request's method and headers, kept for answering after the request itself has moved on.
struct Asked {
    method: Method,
    headers: HeaderMap,
}

impl Asked {
    fn header(&self, name: header::HeaderName) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

    fn is_get_or_head(&self) -> bool {
        self.method == Method::GET || self.method == Method::HEAD
    }
}

/// What a canvas path came to: an answer, or the request for the next handler (the JS `next()`).
enum Outcome {
    Answer(Response),
    Next(Request),
}

/// Serves `/canvas/...`: the gallery at `/canvas/`, a canvas's files below it; any other path goes on.
///
/// Canvases are private. They routinely contain whatever the user asked the agent to visualise — revenue
/// dashboards, customer lists, internal process diagrams — and this runs before any auth, so /canvas/ used to
/// enumerate and serve every canvas ever generated to anyone who found the URL. It requires the same session or API
/// token the rest of the app does (`req.auth.authenticated`); the chat iframe is same-origin and sends the cookie
/// automatically.
///
/// Every answer from here on carries the canvas isolation headers, including what the next handler answers for a
/// folder (the JS set them on the response before handing it on).
pub async fn canvas_middleware(State(app): State<App>, req: Request, next: Next) -> Response {
    // `req.path`: the path as sent, not decoded.
    let path = req.uri().path().to_string();
    let Some(rest) = path.strip_prefix("/canvas/") else {
        return next.run(req).await;
    };
    let asked = Asked {
        method: req.method().clone(),
        headers: req.headers().clone(),
    };

    if !Auth::of(req.extensions()).authenticated {
        return express_send(
            &asked,
            StatusCode::UNAUTHORIZED,
            HTML,
            SIGN_IN_PAGE.into(),
            HeaderMap::new(),
        );
    }

    let mut res = match serve_canvas_path(&app, rest, &asked, req).await {
        Outcome::Answer(res) => res,
        Outcome::Next(req) => next.run(req).await,
    };
    apply_canvas_isolation(res.headers_mut());
    res
}

async fn serve_canvas_path(app: &App, rest: &str, asked: &Asked, req: Request) -> Outcome {
    let dir = canvas_dir(app.config());
    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();

    // Gallery: /canvas/ with no ID lists every canvas.
    if parts.is_empty() {
        return Outcome::Answer(gallery(app, &dir, asked));
    }

    let canvas_id = parts[0];
    let filename = if parts.len() > 1 {
        parts[1..].join("/")
    } else {
        "index.html".to_string()
    };
    // `path.join(CANVAS_DIR, canvasId, filename)`: joined as text, so an absolute piece stays under the folder, and
    // tidied of `.` and `..`.
    let file_path = PathBuf::from(node_join(&[&dir.to_string_lossy(), canvas_id, &filename]));
    // Compared as paths: the JS compared text (`filePath.startsWith(CANVAS_DIR)`), which let `..` reach a sibling
    // folder whose name starts with "canvas" (workspace/canvas-old).
    if !(same_path(&dir, &file_path) || is_inside(&dir, &file_path)) {
        return Outcome::Answer(express_send(
            asked,
            StatusCode::FORBIDDEN,
            HTML,
            "Forbidden".into(),
            HeaderMap::new(),
        ));
    }

    // Every file call takes the literal path (as Node's did): on Windows `index.html.` is not `index.html`.
    let literal = to_namespaced(&file_path);
    if !literal.exists() {
        return Outcome::Answer(express_send(
            asked,
            StatusCode::NOT_FOUND,
            HTML,
            "Canvas not found".into(),
            HeaderMap::new(),
        ));
    }
    // The send module serves no path with a part that starts with a dot (longer than ".": `.git`, `.env`, and a
    // dotted folder above the workspace, such as `~/.tarsee`), which the error handler answered as a 404.
    if has_dot_part(&file_path) {
        return Outcome::Answer(not_found_json(asked));
    }
    if literal.is_dir() {
        // res.sendFile on a folder goes on to the next handler.
        return Outcome::Next(req);
    }
    Outcome::Answer(send_file(&file_path, &literal, asked).await)
}

/// The send module's `containsDotFile`: a part of the path, longer than one character, that starts with a dot.
fn has_dot_part(path: &Path) -> bool {
    path.components().any(|c| match c {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            name.len() > 1 && name.starts_with('.')
        }
        _ => false,
    })
}

fn not_found_json(asked: &Asked) -> Response {
    express_send(
        asked,
        StatusCode::NOT_FOUND,
        JSON,
        r#"{"error":"Not Found"}"#.into(),
        HeaderMap::new(),
    )
}

fn gallery(app: &App, dir: &Path, asked: &Asked) -> Response {
    let failed = || {
        express_send(
            asked,
            StatusCode::INTERNAL_SERVER_ERROR,
            HTML,
            "Error loading gallery".into(),
            HeaderMap::new(),
        )
    };
    let Ok(entries) = read_dir_sorted(dir) else {
        return failed();
    };
    let mut canvases: Vec<(String, u64, i64)> = Vec::new();
    for d in entries {
        let name = d.file_name().to_string_lossy().into_owned();
        let index = to_namespaced(&dir.join(&name).join("index.html"));
        if !d.file_type().map(|t| t.is_dir()).unwrap_or(false) || !index.exists() {
            continue;
        }
        let Ok(meta) = fs::metadata(&index) else {
            return failed();
        };
        canvases.push((name, meta.len(), mtime_ms(&meta)));
    }
    // Newest first, by the millisecond (Dates subtracted); a stable sort.
    canvases.sort_by_key(|c| std::cmp::Reverse(c.2));

    if canvases.is_empty() {
        return express_send(
            asked,
            StatusCode::OK,
            HTML,
            "<!DOCTYPE html><html><head><title>Canvas Gallery</title><style>body{background:#1a1a1a;color:#ececec;font-family:Poppins,sans-serif;padding:40px;text-align:center}h1{color:#c45a35}p{color:#a8a8a0}</style></head><body><h1>Canvas Gallery</h1><p>No canvases yet. Ask Tarsee to create one!</p></body></html>".into(),
            HeaderMap::new(),
        );
    }

    // Canvas names are folder names on disk and are model-controlled, so they must be escaped for text and
    // URL-encoded for the href — otherwise a canvas named `<img src=x onerror=...>` is stored XSS on this page.
    let zone = process_zone(app.env());
    let items: String = canvases
        .iter()
        .map(|(name, size, modified)| {
            // toLocaleDateString(): "11/12/2026", in the process's timezone.
            let date = DateTime::<Utc>::from_timestamp_millis(*modified)
                .unwrap_or_default()
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
    express_send(
        asked,
        StatusCode::OK,
        HTML,
        format!(
            "<!DOCTYPE html><html><head><title>Canvas Gallery</title><style>body{{background:#1a1a1a;color:#ececec;font-family:Poppins,sans-serif;padding:40px;max-width:600px;margin:0 auto}}h1{{color:#c45a35}}a:hover{{border-color:#c45a35!important}}</style></head><body><h1>Canvas Gallery</h1>{items}</body></html>"
        ),
        HeaderMap::new(),
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

/// The ETag Express put on a body it sent (`etag(body, { weak: true })`): `W/"<length in hex>-<SHA-1, base64, 27
/// characters>"`.
pub fn express_etag(body: &[u8]) -> String {
    let hash = base64::engine::general_purpose::STANDARD.encode(Sha1::digest(body));
    format!("W/\"{:x}-{}\"", body.len(), &hash[..27])
}

/// `res.status(status).send(body)` with this content type, as Express sent it: an ETag of the body (unless `extra`
/// already has one), a 304 for a GET or HEAD whose copy is still fresh (2xx answers only), no body for HEAD.
fn express_send(asked: &Asked, status: StatusCode, content_type: &str, body: String, extra: HeaderMap) -> Response {
    let mut headers = extra;
    if !headers.contains_key(header::ETAG) {
        headers.insert(header::ETAG, header_value(&express_etag(body.as_bytes())));
    }
    let fresh_ok = asked.is_get_or_head() && (status.is_success() || status == StatusCode::NOT_MODIFIED);
    if fresh_ok && is_fresh(asked, &headers) {
        return finish(StatusCode::NOT_MODIFIED, headers, Body::empty());
    }
    headers.insert(header::CONTENT_TYPE, header_value(content_type));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(body.len()));
    let body = if asked.method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(body)
    };
    finish(status, headers, body)
}

fn finish(status: StatusCode, headers: HeaderMap, body: Body) -> Response {
    let mut res = Response::new(body);
    *res.status_mut() = status;
    *res.headers_mut() = headers;
    res
}

/// The fresh module (2.0.0): whether the client's copy is current. If-None-Match decides when it is there; a
/// `Cache-Control: no-cache` request is never fresh.
fn is_fresh(asked: &Asked, res_headers: &HeaderMap) -> bool {
    let modified_since = asked.header(header::IF_MODIFIED_SINCE).filter(|v| !v.is_empty());
    let none_match = asked.header(header::IF_NONE_MATCH).filter(|v| !v.is_empty());
    if modified_since.is_none() && none_match.is_none() {
        return false;
    }
    if let Some(cache_control) = asked.header(header::CACHE_CONTROL)
        && NO_CACHE.is_match(cache_control)
    {
        return false;
    }
    let res_header = |name: header::HeaderName| res_headers.get(name).and_then(|v| v.to_str().ok());
    if let Some(none_match) = none_match {
        if none_match == "*" {
            return true;
        }
        let Some(etag) = res_header(header::ETAG) else {
            return false;
        };
        return parse_token_list(none_match)
            .iter()
            .any(|m| *m == etag || format!("W/{etag}") == *m || format!("W/{m}") == etag);
    }
    if let Some(modified_since) = modified_since {
        let last = res_header(header::LAST_MODIFIED).and_then(parse_http_date);
        let since = parse_http_date(modified_since);
        return matches!((last, since), (Some(last), Some(since)) if last <= since);
    }
    true
}

static NO_CACHE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(&format!(
        r"(?:^|,)[{}]*?no-cache[{}]*?(?:,|$)",
        crate::lib::workspace_files::jstext::JS_SPACE_CLASS,
        crate::lib::workspace_files::jstext::JS_SPACE_CLASS
    ))
    .expect("the no-cache pattern")
});

/// The fresh module's `parseTokenList`: comma-separated, spaces around each token dropped.
fn parse_token_list(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut list = Vec::new();
    let (mut start, mut end) = (0usize, 0usize);
    for (i, b) in bytes.iter().enumerate() {
        match b {
            b' ' => {
                if start == end {
                    start = i + 1;
                    end = i + 1;
                }
            }
            b',' => {
                list.push(&text[start..end]);
                start = i + 1;
                end = i + 1;
            }
            _ => end = i + 1,
        }
    }
    list.push(&text[start..end]);
    list
}

/// `Date.parse` of an HTTP date ("Thu, 12 Nov 2026 08:30:00 GMT"), in milliseconds.
fn parse_http_date(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc2822(text.trim())
        .ok()
        .map(|d| d.timestamp_millis())
        .or_else(|| crate::util::js::ms_from_iso(text))
}

/// `date.toUTCString()`.
fn http_date(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string()
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

/// Express's `setCharset(type, "utf-8")`: what `res.json` made of a content type already set.
fn with_utf8_charset(content_type: &str) -> String {
    let base = content_type.split(';').next().unwrap_or(content_type).trim();
    format!("{base}; charset=utf-8")
}

/// One byte range (`{ start, end }`, both included).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
}

/// What range-parser (1.2, `combine: true`) made of a Range header.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Ranges {
    /// Not a range header it could read (-2).
    Malformed,
    /// No range inside the file (-1).
    Unsatisfiable,
    Some(Vec<ByteRange>),
}

fn parse_range(size: u64, text: &str) -> Ranges {
    let Some(eq) = text.find('=') else {
        return Ranges::Malformed;
    };
    let int = |part: &str| crate::lib::workspace_files::jstext::js_parse_int_decimal(part);
    let size = size as i64;
    let mut ranges: Vec<(i64, i64, usize)> = Vec::new();
    for (index, spec) in text[eq + 1..].split(',').enumerate() {
        let mut bounds = spec.split('-');
        let start = int(bounds.next().unwrap_or(""));
        let end = int(bounds.next().unwrap_or(""));
        let (start, end) = match (start, end) {
            // -nnn
            (None, Some(end)) => (size - end, size - 1),
            // nnn-
            (Some(start), None) => (start, size - 1),
            (Some(start), Some(end)) => (start, end.min(size - 1)),
            (None, None) => continue,
        };
        let end = end.min(size - 1);
        if start > end || start < 0 {
            continue;
        }
        ranges.push((start, end, index));
    }
    if ranges.is_empty() {
        return Ranges::Unsatisfiable;
    }
    // combineRanges: overlapping or adjacent ranges merge; the result is in the order of the first of each.
    ranges.sort_by_key(|r| r.0);
    let mut combined: Vec<(i64, i64, usize)> = Vec::new();
    for range in ranges {
        match combined.last_mut() {
            Some(current) if range.0 <= current.1 + 1 => {
                if range.1 > current.1 {
                    current.1 = range.1;
                    current.2 = current.2.min(range.2);
                }
            }
            _ => combined.push(range),
        }
    }
    combined.sort_by_key(|r| r.2);
    Ranges::Some(
        combined
            .into_iter()
            .map(|(start, end, _)| ByteRange {
                start: start as u64,
                end: end as u64,
            })
            .collect(),
    )
}

/// `res.sendFile(path)`, as the send module answered: the file with its type and caching headers; 304 for a fresh
/// copy; 412 for a failed If-Match or If-Unmodified-Since; 206 for one byte range (several, or a stale If-Range, get
/// the whole file); 416 for a range outside the file; no body for HEAD. The errors reached the global error handler,
/// whose JSON kept the file's content type.
/// `path` names the file (its type comes from its extension); `literal` is the same path in the form the system
/// takes literally, which every file call uses.
async fn send_file(path: &Path, literal: &Path, asked: &Asked) -> Response {
    let meta = match fs::metadata(literal) {
        Ok(meta) => meta,
        Err(_) => return not_found_json(asked),
    };
    let size = meta.len();
    let modified = mtime_ms(&meta);
    let content_type = content_type_of(path);

    let mut headers = HeaderMap::new();
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=0"));
    headers.insert(header::LAST_MODIFIED, header_value(&http_date(modified)));
    headers.insert(header::ETAG, header_value(&format!("W/\"{size:x}-{modified:x}\"")));
    headers.insert(header::CONTENT_TYPE, header_value(&content_type));

    let error = |status: StatusCode, message: &str, mut headers: HeaderMap| {
        headers.remove(header::CONTENT_TYPE);
        express_send(
            asked,
            status,
            &with_utf8_charset(&content_type),
            format!(r#"{{"error":"{message}"}}"#),
            headers,
        )
    };

    // Conditional GET.
    let conditional = [
        header::IF_MATCH,
        header::IF_UNMODIFIED_SINCE,
        header::IF_NONE_MATCH,
        header::IF_MODIFIED_SINCE,
    ]
    .iter()
    .any(|name| asked.header(name.clone()).is_some_and(|v| !v.is_empty()));
    if conditional {
        if precondition_failed(asked, &headers) {
            return error(StatusCode::PRECONDITION_FAILED, "Precondition Failed", headers);
        }
        if is_fresh(asked, &headers) {
            headers.remove(header::CONTENT_TYPE);
            return finish(StatusCode::NOT_MODIFIED, headers, Body::empty());
        }
    }

    let mut status = StatusCode::OK;
    let (mut offset, mut len) = (0u64, size);
    if let Some(range) = asked.header(header::RANGE).filter(|r| BYTES_RANGE.is_match(r)) {
        let mut ranges = parse_range(size, range);
        if !range_fresh(asked, &headers) {
            ranges = Ranges::Malformed;
        }
        match ranges {
            Ranges::Unsatisfiable => {
                headers.insert(header::CONTENT_RANGE, header_value(&format!("bytes */{size}")));
                return error(StatusCode::RANGE_NOT_SATISFIABLE, "Range Not Satisfiable", headers);
            }
            Ranges::Some(list) if list.len() == 1 => {
                status = StatusCode::PARTIAL_CONTENT;
                headers.insert(
                    header::CONTENT_RANGE,
                    header_value(&format!("bytes {}-{}/{size}", list[0].start, list[0].end)),
                );
                offset = list[0].start;
                len = list[0].end - list[0].start + 1;
            }
            _ => {}
        }
    }
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    if asked.method == Method::HEAD {
        return finish(status, headers, Body::empty());
    }
    let body = match tokio::fs::File::open(literal).await {
        Ok(mut file) => {
            if file.seek(SeekFrom::Start(offset)).await.is_err() {
                return not_found_json(asked);
            }
            Body::from_stream(tokio_util::io::ReaderStream::new(file.take(len)))
        }
        Err(_) => return not_found_json(asked),
    };
    finish(status, headers, body)
}

static BYTES_RANGE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"^ *bytes=").expect("the range pattern"));

/// send's `isPreconditionFailure`.
fn precondition_failed(asked: &Asked, res_headers: &HeaderMap) -> bool {
    let etag = res_headers.get(header::ETAG).and_then(|v| v.to_str().ok());
    if let Some(wanted) = asked.header(header::IF_MATCH).filter(|v| !v.is_empty()) {
        let Some(etag) = etag else { return true };
        return wanted != "*"
            && parse_token_list(wanted)
                .iter()
                .all(|m| *m != etag && format!("W/{etag}") != *m && format!("W/{m}") != etag);
    }
    if let Some(since) = asked.header(header::IF_UNMODIFIED_SINCE).and_then(parse_http_date) {
        let last = res_headers
            .get(header::LAST_MODIFIED)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_http_date);
        return last.is_none_or(|last| last > since);
    }
    false
}

/// send's `isRangeFresh`: an If-Range holding an ETag must hold this one; one holding a date must not be older
/// than the file.
fn range_fresh(asked: &Asked, res_headers: &HeaderMap) -> bool {
    let Some(if_range) = asked.header(header::IF_RANGE).filter(|v| !v.is_empty()) else {
        return true;
    };
    let res_header = |name: header::HeaderName| res_headers.get(name).and_then(|v| v.to_str().ok());
    if if_range.contains('"') {
        return res_header(header::ETAG).is_some_and(|etag| if_range.contains(etag));
    }
    let last = res_header(header::LAST_MODIFIED).and_then(parse_http_date);
    matches!((last, parse_http_date(if_range)), (Some(last), Some(since)) if last <= since)
}

fn header_value(text: &str) -> HeaderValue {
    HeaderValue::from_str(text).unwrap_or_else(|_| HeaderValue::from_static(""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::http::{self, TestResponse, request};
    use crate::testkit::{TestApp, test_app_with_env, tmp_dir};
    use axum::Router;
    use std::time::{Duration, SystemTime};

    fn app() -> (TestApp, CanvasServer) {
        let t = test_app_with_env([("TZ", "UTC")]);
        let server = CanvasServer::create(t.config()).unwrap();
        (t, server)
    }

    /// The canvas middleware in front of a handler that answers "next", with the session middleware's verdict.
    fn router(t: &TestApp, signed_in: bool) -> Router {
        Router::new()
            .fallback(|| async { "next" })
            .layer(axum::middleware::from_fn_with_state(t.app.clone(), canvas_middleware))
            .layer(axum::middleware::from_fn(
                move |mut req: Request, next: Next| async move {
                    req.extensions_mut().insert(Auth {
                        authenticated: signed_in,
                        ..Auth::default()
                    });
                    next.run(req).await
                },
            ))
    }

    async fn get(t: &TestApp, path: &str) -> TestResponse {
        http::get(&router(t, true), path).await
    }

    async fn get_with(t: &TestApp, path: &str, headers: &[(&str, &str)]) -> TestResponse {
        let mut req = request("GET", path);
        for (name, value) in headers {
            req = req.header(name, value);
        }
        http::send(&router(t, true), req).await
    }

    fn set_time(path: &Path, at: SystemTime) {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(at)
            .unwrap();
    }

    const DAY: u64 = 1_794_441_600; // 2026-11-12T00:00:00Z

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
        assert_eq!(
            serde_json::to_value(&list[1]).unwrap(),
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

    #[test]
    fn a_canvas_id_must_be_one_plain_name() {
        let (t, server) = app();
        let outside = tmp_dir();
        let absolute = outside.path().join("victim");
        fs::create_dir_all(&absolute).unwrap();
        fs::write(absolute.join("index.html"), "keep me").unwrap();
        let absolute = absolute.to_string_lossy().to_string();
        for id in [absolute.as_str(), "..", ".", "a/b", "a\\b", ""] {
            assert_eq!(
                server.serve(id, Some("x"), None, None).unwrap_err().to_string(),
                format!("Invalid canvas id: {id}")
            );
            assert_eq!(server.get(id), None, "{id}");
            assert!(!server.delete(id), "{id}");
        }
        assert_eq!(
            fs::read_to_string(outside.path().join("victim").join("index.html")).unwrap(),
            "keep me"
        );
        // A file path is joined as Node joined it: an absolute piece stays under the canvas folder.
        assert!(
            server
                .get_file_path(&absolute, "x")
                .starts_with(crate::util::node_path::normalize(&canvas_dir(t.config())))
        );
    }

    #[tokio::test]
    async fn only_canvas_paths_are_answered_and_only_when_signed_in() {
        let (t, server) = app();
        server.serve("c1", Some("<p>hi</p>"), None, None).unwrap();
        assert_eq!(get(&t, "/api/canvas/c1/").await.text(), "next");
        assert_eq!(get(&t, "/canvas").await.text(), "next");
        let res = http::get(&router(&t, false), "/canvas/c1/").await;
        assert_eq!(res.status, 401);
        assert_eq!(res.header("content-type"), Some(HTML));
        assert_eq!(res.text(), SIGN_IN_PAGE);
        assert_eq!(res.header("etag").unwrap(), express_etag(SIGN_IN_PAGE.as_bytes()));
        assert_eq!(res.header("content-security-policy"), None);
    }

    #[tokio::test]
    async fn a_canvas_is_sent_isolated_with_its_type_and_cache_headers() {
        let (t, server) = app();
        server.serve("c1", Some("<p>hi</p>"), None, None).unwrap();
        let index = canvas_dir(t.config()).join("c1").join("index.html");
        set_time(&index, UNIX_EPOCH + Duration::from_millis(DAY * 1000 + 123));
        fs::write(canvas_dir(t.config()).join("c1").join("app.js"), "let a = 1;").unwrap();
        let res = get(&t, "/canvas/c1/").await;
        assert_eq!(res.status, 200);
        assert_eq!(res.text(), "<p>hi</p>");
        assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(res.header("content-security-policy"), Some(CANVAS_CSP));
        assert_eq!(res.header("cross-origin-opener-policy"), Some("same-origin"));
        assert_eq!(res.header("cross-origin-resource-policy"), Some("same-origin"));
        assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(res.header("cache-control"), Some("public, max-age=0"));
        assert_eq!(res.header("accept-ranges"), Some("bytes"));
        assert_eq!(res.header("content-length"), Some("9"));
        let etag = format!("W/\"9-{:x}\"", DAY * 1000 + 123);
        assert_eq!(res.header("etag"), Some(etag.as_str()));
        assert_eq!(res.header("last-modified"), Some("Thu, 12 Nov 2026 00:00:00 GMT"));

        let res = get(&t, "/canvas/c1/app.js").await;
        assert_eq!(
            (res.status, res.header("content-type")),
            (200, Some("text/javascript; charset=utf-8"))
        );

        // A fresh copy: 304, with the caching headers, without the content ones.
        let res = get_with(&t, "/canvas/c1/index.html", &[("if-none-match", &etag)]).await;
        assert_eq!(res.status, 304);
        assert!(res.body.is_empty());
        assert_eq!(res.header("etag"), Some(etag.as_str()));
        assert_eq!(res.header("cache-control"), Some("public, max-age=0"));
        assert_eq!(res.header("accept-ranges"), Some("bytes"));
        assert_eq!(res.header("last-modified"), Some("Thu, 12 Nov 2026 00:00:00 GMT"));
        assert_eq!(res.header("content-type"), None);
        assert_eq!(res.header("content-security-policy"), Some(CANVAS_CSP));
        let res = get_with(
            &t,
            "/canvas/c1/",
            &[("if-modified-since", "Fri, 13 Nov 2026 00:00:00 GMT")],
        )
        .await;
        assert_eq!(res.status, 304);
        // A reload asks past the cache.
        let res = get_with(
            &t,
            "/canvas/c1/",
            &[("if-none-match", &etag), ("cache-control", "no-cache")],
        )
        .await;
        assert_eq!((res.status, res.text()), (200, "<p>hi</p>".to_string()));
        // If-None-Match decides over If-Modified-Since.
        let res = get_with(
            &t,
            "/canvas/c1/",
            &[
                ("if-none-match", "W/\"other\""),
                ("if-modified-since", "Fri, 13 Nov 2026 00:00:00 GMT"),
            ],
        )
        .await;
        assert_eq!(res.status, 200);
        let res = get_with(&t, "/canvas/c1/", &[("if-match", "\"nope\"")]).await;
        assert_eq!(res.status, 412);
        assert_eq!(res.text(), r#"{"error":"Precondition Failed"}"#);
        assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(res.header("etag"), Some(etag.as_str()));

        let post = request("POST", "/canvas/c1/");
        assert_eq!(http::send(&router(&t, true), post).await.text(), "<p>hi</p>");
        let head = http::send(&router(&t, true), request("HEAD", "/canvas/c1/")).await;
        assert_eq!(
            (head.status, head.body.len(), head.header("content-length")),
            (200, 0, Some("9"))
        );
    }

    #[tokio::test]
    async fn byte_ranges_are_served_as_the_send_module_served_them() {
        let (t, server) = app();
        server.serve("c1", Some("<p>hi</p>"), None, None).unwrap();
        let range = |r: &'static str| {
            let t = &t;
            async move { get_with(t, "/canvas/c1/", &[("range", r)]).await }
        };
        let res = range("bytes=0-1").await;
        assert_eq!((res.status, res.text()), (206, "<p".to_string()));
        assert_eq!(res.header("content-range"), Some("bytes 0-1/9"));
        assert_eq!(res.header("content-length"), Some("2"));
        assert_eq!(range("bytes=-2").await.text(), "p>");
        assert_eq!(range("bytes=5-").await.text(), "</p>");
        let joined = range("bytes=0-1,1-3").await;
        assert_eq!((joined.status, joined.text()), (206, "<p>h".to_string()));
        // Several ranges, or a header that is not bytes=, give the whole file.
        assert_eq!(range("bytes=0-1,4-5").await.status, 200);
        assert_eq!(range("items=0-1").await.status, 200);
        let res = range("bytes=100-").await;
        assert_eq!(res.status, 416);
        assert_eq!(res.text(), r#"{"error":"Range Not Satisfiable"}"#);
        assert_eq!(res.header("content-range"), Some("bytes */9"));
        let stale = get_with(
            &t,
            "/canvas/c1/",
            &[("range", "bytes=0-1"), ("if-range", "Thu, 01 Jan 1970 00:00:00 GMT")],
        )
        .await;
        assert_eq!(stale.status, 200);
    }

    #[test]
    fn ranges_parse_as_range_parser_parsed_them() {
        // Checked against range-parser 1.2.1 with { combine: true } on a 9-byte file.
        let r = |start, end| ByteRange { start, end };
        assert_eq!(parse_range(9, "bytes=0-1"), Ranges::Some(vec![r(0, 1)]));
        assert_eq!(parse_range(9, "bytes=5-"), Ranges::Some(vec![r(5, 8)]));
        assert_eq!(parse_range(9, "bytes=-2"), Ranges::Some(vec![r(7, 8)]));
        assert_eq!(parse_range(9, "bytes=0-1,4-5"), Ranges::Some(vec![r(0, 1), r(4, 5)]));
        assert_eq!(parse_range(9, "bytes=0-1,1-3"), Ranges::Some(vec![r(0, 3)]));
        assert_eq!(parse_range(9, "bytes=100-"), Ranges::Unsatisfiable);
        assert_eq!(parse_range(9, "bytes=x"), Ranges::Unsatisfiable);
        assert_eq!(parse_range(9, "bytes=3-1,0-0"), Ranges::Some(vec![r(0, 0)]));
        assert_eq!(parse_range(9, "bytes= 2 - 4"), Ranges::Some(vec![r(2, 4)]));
        assert_eq!(parse_range(9, "nothing"), Ranges::Malformed);
        assert_eq!(parse_token_list(" a , b,,c "), ["a", "b", "", "c"]);
    }

    #[test]
    fn a_page_sent_as_text_carries_the_etag_express_made() {
        // Checked against the etag module.
        assert_eq!(
            express_etag(b"Canvas not found"),
            "W/\"10-KPUmzB1vZGbLgUG4gdwHQkMLYFE\""
        );
        assert_eq!(express_etag(b""), "W/\"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk\"");
        assert_eq!(express_etag("é🐒".as_bytes()), "W/\"6-SfZF+hdEG/kNWp1ZTEESZXnTOyc\"");
        assert_eq!(
            express_etag(br#"{"error":"Not Found"}"#),
            "W/\"15-5KajTCx0AJD0xogoSeOjjV2M8K0\""
        );
    }

    #[tokio::test]
    async fn missing_escaping_dot_names_and_folders() {
        let (t, server) = app();
        server.serve("c1", Some("x"), None, None).unwrap();
        let canvases = canvas_dir(t.config());
        fs::create_dir_all(canvases.join("c1").join("sub")).unwrap();
        fs::create_dir_all(canvases.join("c1").join(".git")).unwrap();
        fs::write(canvases.join("c1").join(".git").join("config"), "secret").unwrap();
        fs::write(canvases.join("c1").join(".env"), "SECRET=1").unwrap();
        fs::create_dir_all(canvases.join(".hid")).unwrap();
        fs::write(canvases.join(".hid").join("index.html"), "hidden").unwrap();
        let sibling = t.config().workspace_dir.join("canvas-old");
        fs::create_dir_all(&sibling).unwrap();
        fs::write(sibling.join("x.html"), "old").unwrap();

        let res = get(&t, "/canvas/nope/").await;
        assert_eq!((res.status, res.text()), (404, "Canvas not found".to_string()));
        assert_eq!(res.header("etag").unwrap(), express_etag(b"Canvas not found"));
        assert_eq!(res.header("content-security-policy"), Some(CANVAS_CSP));
        let res = get(&t, "/canvas/c1/../../../secret").await;
        assert_eq!((res.status, res.text()), (403, "Forbidden".to_string()));
        // `..` to a sibling folder whose name starts with "canvas": the JS's text check let it through.
        let res = get(&t, "/canvas/../canvas-old/x.html").await;
        assert_eq!((res.status, res.text()), (403, "Forbidden".to_string()));
        // A folder goes on to the next handler, which answers with the canvas isolation headers on.
        let res = get(&t, "/canvas/c1/sub").await;
        assert_eq!(res.text(), "next");
        assert_eq!(res.header("content-security-policy"), Some(CANVAS_CSP));
        assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
        // Any dot-named part: a 404 from the error handler.
        for path in [
            "/canvas/c1/.env",
            "/canvas/c1/.git/config",
            "/canvas/.hid/",
            "/canvas/.hid/index.html",
        ] {
            let res = get(&t, path).await;
            assert_eq!(
                (res.status, res.json()),
                (404, serde_json::json!({"error": "Not Found"})),
                "{path}"
            );
            assert_eq!(res.header("content-type"), Some(JSON));
        }
        let res = get(&t, "/canvas/c1/../c1/index.html").await;
        assert_eq!((res.status, res.text()), (200, "x".to_string()));
        let res = get(&t, "/canvas/c1/C:/x").await;
        assert_eq!(res.status, 404);
    }

    #[tokio::test]
    async fn a_canvas_name_means_what_it_says_dots_spaces_and_device_names_included() {
        let (t, server) = app();
        server.serve("c1", Some("first"), None, None).unwrap();
        // On Windows `c1.` and `c1 ` would open `c1`, `index.html.` the page itself, `...` the canvas folder.
        for path in [
            "/canvas/c1./",
            "/canvas/c1%20/",
            "/canvas/c1/index.html.",
            "/canvas/.../",
            "/canvas/nul/",
        ] {
            let res = get(&t, path).await;
            assert_eq!(
                (res.status, res.text()),
                (404, "Canvas not found".to_string()),
                "{path}"
            );
        }
        for id in ["c1.", "c1 "] {
            assert_eq!(server.get(id), None, "{id:?}");
            assert!(!server.delete(id), "{id:?}");
        }
        assert_eq!(server.get("c1").as_deref(), Some("first"));
        // A canvas may be named `nul`: a folder of that name, written, read, served and deleted as such.
        server.serve("nul", Some("not a device"), None, None).unwrap();
        assert_eq!(server.get("nul").as_deref(), Some("not a device"));
        assert_eq!(get(&t, "/canvas/nul/").await.text(), "not a device");
        assert!(server.delete("nul"));
        assert_eq!(server.get("nul"), None);
        assert_eq!(server.get("c1").as_deref(), Some("first"));
    }

    #[tokio::test]
    async fn under_a_dotted_folder_every_canvas_file_is_refused_as_node_refused_it() {
        let dir = tmp_dir();
        let ws = dir.path().join(".dotted").join("ws");
        let t = test_app_with_env([("TZ", "UTC"), ("TARSEE_WORKSPACE_DIR", ws.to_string_lossy().as_ref())]);
        CanvasServer::create(t.config())
            .unwrap()
            .serve("c1", Some("x"), None, None)
            .unwrap();
        for path in ["/canvas/c1/", "/canvas/c1/index.html"] {
            let res = get(&t, path).await;
            assert_eq!(
                (res.status, res.json()),
                (404, serde_json::json!({"error": "Not Found"})),
                "{path}"
            );
        }
        assert_eq!(get(&t, "/canvas/").await.status, 200, "the gallery is not a file");
    }

    #[tokio::test]
    async fn the_gallery_lists_canvases_newest_first_escaped() {
        let (t, server) = app();
        let res = get(&t, "/canvas/").await;
        assert!(res.text().contains("No canvases yet. Ask Tarsee to create one!"));
        server.serve("older", Some(&"x".repeat(1600)), None, None).unwrap();
        server.serve("<img src=x>", Some("y"), None, None).ok();
        set_time(
            &canvas_dir(t.config()).join("older").join("index.html"),
            UNIX_EPOCH + Duration::from_secs(1_605_139_200),
        );
        fs::create_dir_all(canvas_dir(t.config()).join("no-index")).unwrap();
        let res = get(&t, "/canvas//").await;
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
        // Its ETag is Express's, and a fresh copy is a 304.
        let etag = res.header("etag").unwrap().to_string();
        assert_eq!(etag, express_etag(page.as_bytes()));
        let again = get_with(&t, "/canvas/", &[("if-none-match", &etag)]).await;
        assert_eq!((again.status, again.body.len()), (304, 0));
    }

    #[tokio::test]
    async fn canvases_changed_in_the_same_millisecond_keep_their_name_order() {
        let (t, server) = app();
        server.serve("a-first", Some("a"), None, None).unwrap();
        server.serve("b-second", Some("b"), None, None).unwrap();
        let base = UNIX_EPOCH + Duration::from_millis(DAY * 1000);
        set_time(
            &canvas_dir(t.config()).join("a-first").join("index.html"),
            base + Duration::from_micros(100),
        );
        set_time(
            &canvas_dir(t.config()).join("b-second").join("index.html"),
            base + Duration::from_micros(400),
        );
        let page = get(&t, "/canvas/").await.text();
        assert!(page.find("a-first").unwrap() < page.find("b-second").unwrap(), "{page}");
    }

    #[tokio::test]
    async fn the_gallery_page_is_the_one_node_sent() {
        let (t, server) = app();
        server.serve("older", Some(&"x".repeat(1600)), None, None).unwrap();
        server.serve("b-new", Some("hi\n"), None, None).unwrap();
        fs::create_dir_all(canvas_dir(t.config()).join("no-index")).unwrap();
        let set = |name: &str, secs: u64| {
            set_time(
                &canvas_dir(t.config()).join(name).join("index.html"),
                UNIX_EPOCH + Duration::from_secs(secs),
            );
        };
        set("older", DAY);
        set("b-new", DAY + 3600);
        // What the Node middleware sent for the same folder (TZ=UTC).
        let node = "<!DOCTYPE html><html><head><title>Canvas Gallery</title><style>body{background:#1a1a1a;color:#ececec;font-family:Poppins,sans-serif;padding:40px;max-width:600px;margin:0 auto}h1{color:#c45a35}a:hover{border-color:#c45a35!important}</style></head><body><h1>Canvas Gallery</h1><a href=\"/canvas/b-new/\" style=\"display:block;background:#2b2a27;border-radius:8px;padding:16px;margin:8px 0;text-decoration:none;color:#ececec;border:1px solid #3a3935\"><strong>b-new</strong><br><span style=\"color:#a8a8a0;font-size:12px\">0KB &middot; 11/12/2026</span></a><a href=\"/canvas/older/\" style=\"display:block;background:#2b2a27;border-radius:8px;padding:16px;margin:8px 0;text-decoration:none;color:#ececec;border:1px solid #3a3935\"><strong>older</strong><br><span style=\"color:#a8a8a0;font-size:12px\">2KB &middot; 11/12/2026</span></a></body></html>";
        let res = get(&t, "/canvas/").await;
        assert_eq!(res.text(), node);
        assert_eq!(res.header("content-type"), Some(HTML));
    }

    #[test]
    fn helpers_match_node() {
        assert_eq!(encode_uri_component("a b/é~"), "a%20b%2F%C3%A9~");
        assert_eq!(
            escape_html("<a href=\"x\">'&'</a>"),
            "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
        );
        assert!(has_dot_part(Path::new("/w/.tarsee/canvas/c1/index.html")));
        assert!(!has_dot_part(Path::new("/w/tarsee/canvas/c1/index.html")));
        assert!(!has_dot_part(Path::new("/w/./canvas/c1/index.html")));
        assert_eq!(with_utf8_charset("image/png"), "image/png; charset=utf-8");
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
    }

    #[cfg(windows)]
    #[test]
    fn a_unc_workspace_keeps_its_root() {
        let base = PathBuf::from(r"\\server\share\ws\canvas");
        let file = PathBuf::from(node_join(&[&base.to_string_lossy(), "c1", "index.html"]));
        assert!(is_inside(&base, &file), "{file:?}");
        assert_eq!(file, PathBuf::from(r"\\server\share\ws\canvas\c1\index.html"));
    }
}
