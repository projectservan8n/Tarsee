//! Port of `src/routes/files.js`: the file manager's API, mounted at /api/files (behind sign-in and CSRF, applied
//! in server.rs as server.js applied them).
//!
//! - GET  /ls?path=...        list a folder
//! - GET  /read?path=...      read a file (2 MB at most)
//! - POST /write              `{ path, content }`
//! - POST /mkdir              `{ path }`
//! - POST /delete             `{ path }`
//! - POST /rename             `{ path, newName }`
//! - GET  /download?path=...  the file itself, as an attachment
//!
//! The workspace ONLY.
//!
//! STATE_DIR used to be listed here as well. It is the workspace's parent and holds the Claude OAuth credentials,
//! the encryption key, the master API token, the live SQLite database and the hooks directory that gets imported
//! on every boot — so the file manager could read every credential the deployment owns and write code that would
//! execute on the next restart. Nothing in the UI ever needed to browse outside the workspace.
//!
//! The JSON bodies are read as `express.json` read them (application/json only; anything else is an empty body; a
//! byte order mark is dropped), with the server's 50 MB limit; the query as Express 5's simple parser read it (a
//! repeated `path` is a list, so it is not a path).
//!
//! Every file call takes the checked path in its literal form (`to_namespaced`), as Node's `fs` did: on Windows a
//! name such as `data.db.`, `...` or `nul` then means exactly what it says, not the file or device Windows would
//! otherwise turn it into.
//!
//! Two Node bugs are fixed here (see the package report): `delete` compared the root as text, so a workspace
//! written another way could be deleted whole; `rename` checked its target with a text prefix, so a file or the
//! whole workspace could be moved to a sibling or the parent folder. Roots are now compared as paths.

use std::path::{Path, PathBuf};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};

use crate::app::App;
use crate::config::constants::limits;
use crate::error::ApiError;
use crate::lib::safe_path::{
    SafePathError, fs_error_message, fs_error_message_two, is_inside, is_sensitive_path, node_dirname, node_join,
    nul_in_path, relative_path, safe_path, same_path, sanitize_filename,
};
use crate::util::js::{number_to_string, truthy};
use crate::util::node_path::to_namespaced;

pub fn router() -> Router<App> {
    Router::new()
        .route("/ls", get(ls))
        .route("/read", get(read))
        .route("/write", post(write))
        .route("/mkdir", post(mkdir))
        .route("/delete", post(delete))
        .route("/rename", post(rename))
        .route("/download", get(download))
}

type Answer = Result<Response, ApiError>;

fn ok(body: Value) -> Answer {
    Ok(axum::Json(body).into_response())
}

/// `ALLOWED_ROOTS`: `[config.WORKSPACE_DIR]`, the configuration's (normalised) workspace folder.
fn allowed_roots(app: &App) -> Vec<PathBuf> {
    vec![app.config().workspace_dir.clone()]
}

/// `safePath(value, ALLOWED_ROOTS)` for a value from the query or the body: anything but text is an invalid path.
fn resolve(app: &App, value: &Value) -> Result<PathBuf, ApiError> {
    let resolved = match value {
        Value::String(text) => safe_path(text, &allowed_roots(app)),
        _ => Err(SafePathError::InvalidPath),
    };
    resolved.map_err(|err| ApiError::bad_request(err.to_string()))
}

/// `req.query.path` as Express 5 read it: missing, the text, or (given more than once) a list.
fn query_path(req: &Request) -> Value {
    let values: Vec<String> = req
        .uri()
        .query()
        .map(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .filter(|(k, _)| k == "path")
                .map(|(_, v)| v.into_owned())
                .collect()
        })
        .unwrap_or_default();
    match values.len() {
        0 => Value::Null,
        1 => Value::String(values.into_iter().next().unwrap_or_default()),
        _ => Value::Array(values.into_iter().map(Value::String).collect()),
    }
}

/// `req.body || {}` after `express.json`: a JSON body when the request says it is JSON, else an empty one.
async fn json_body(req: Request) -> Result<Value, ApiError> {
    let content_type = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut parts = content_type.split(';');
    let is_json = parts
        .next()
        .is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json"));
    let charset = parts.find_map(|p| {
        let (k, v) = p.split_once('=')?;
        k.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| v.trim().trim_matches('"').to_lowercase())
    });
    if !is_json {
        // Not for express.json: the body stays unread and `req.body` is empty.
        return Ok(json!({}));
    }
    // body-parser checks the charset before it reads anything (RFC 7159: JSON is UTF-8, 16 or 32).
    let charset = charset.unwrap_or_else(|| "utf-8".into());
    if !charset.starts_with("utf-") || !matches!(charset.as_str(), "utf-8" | "utf-16" | "utf-16le" | "utf-16be") {
        return Err(ApiError::new(
            415,
            format!("unsupported charset \"{}\"", charset.to_uppercase()),
        ));
    }
    let bytes: Bytes = axum::body::to_bytes(req.into_body(), limits::JSON_BODY_MAX_BYTES)
        .await
        .map_err(|_| ApiError::new(413, "request entity too large"))?;
    let decoded = decode_body(&bytes, &charset);
    // iconv-lite drops a byte order mark.
    let text = decoded.strip_prefix('\u{FEFF}').unwrap_or(&decoded);
    if text.is_empty() {
        // special-case empty json body, as it's a common client-side mistake
        return Ok(json!({}));
    }
    // Strict, as body-parser was: only an object or an array.
    let first = text.chars().find(|c| !matches!(c, ' ' | '\t' | '\n' | '\r'));
    if !matches!(first, Some('{') | Some('[')) {
        let shown: String = text.chars().take(10).collect();
        let more = if text.chars().count() > 10 { "..." } else { "" };
        return Err(ApiError::bad_request(format!(
            "Unexpected token '{}', \"{shown}\"{more} is not valid JSON",
            first.unwrap_or(' ')
        )));
    }
    serde_json::from_str(&mend_lone_surrogates(text)).map_err(|err| ApiError::bad_request(err.to_string()))
}

/// The body as text in its charset; bytes that do not decode become U+FFFD, as iconv-lite made them.
fn decode_body(bytes: &[u8], charset: &str) -> String {
    let utf16 = |big_endian: bool, bytes: &[u8]| {
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|c| match (c, big_endian) {
                ([a, b], false) => u16::from_le_bytes([*a, *b]),
                ([a, b], true) => u16::from_be_bytes([*a, *b]),
                _ => 0xFFFD,
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
    match charset {
        "utf-16be" => utf16(true, bytes),
        "utf-16le" => utf16(false, bytes),
        // "utf-16": the byte order mark says which; little-endian without one.
        "utf-16" => match bytes {
            [0xFE, 0xFF, rest @ ..] => utf16(true, rest),
            [0xFF, 0xFE, rest @ ..] => utf16(false, rest),
            _ => utf16(false, bytes),
        },
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// JSON text in which every `\uD800`-`\uDFFF` escape that is not half of a pair is written `�`. `JSON.parse`
/// accepted such a lone surrogate (and writing it out as UTF-8 gave U+FFFD); serde refuses it.
fn mend_lone_surrogates(json: &str) -> std::borrow::Cow<'_, str> {
    if !json.contains("\\u") {
        return std::borrow::Cow::Borrowed(json);
    }
    let bytes = json.as_bytes();
    let hex_at = |at: usize| -> Option<u16> {
        let digits = bytes.get(at..at + 4)?;
        u16::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()
    };
    let escape_at = |at: usize| -> Option<u16> {
        (bytes.get(at) == Some(&b'\\') && bytes.get(at + 1) == Some(&b'u'))
            .then(|| hex_at(at + 2))
            .flatten()
    };
    let mut out = String::with_capacity(json.len());
    let mut in_string = false;
    let mut i = 0;
    let mut copied = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if !in_string {
            if b == b'"' {
                in_string = true;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' => {
                in_string = false;
                i += 1;
            }
            b'\\' => match escape_at(i) {
                Some(0xD800..=0xDBFF) => {
                    let paired = escape_at(i + 6).is_some_and(|low| (0xDC00..=0xDFFF).contains(&low));
                    if paired {
                        i += 12;
                    } else {
                        out.push_str(&json[copied..i]);
                        out.push_str("\\uFFFD");
                        i += 6;
                        copied = i;
                    }
                }
                Some(0xDC00..=0xDFFF) => {
                    out.push_str(&json[copied..i]);
                    out.push_str("\\uFFFD");
                    i += 6;
                    copied = i;
                }
                _ => i += 2,
            },
            _ => i += 1,
        }
    }
    out.push_str(&json[copied.min(json.len())..]);
    std::borrow::Cow::Owned(out)
}

/// A body field (`const { path } = req.body`): missing when the body is not an object.
fn field<'a>(body: &'a Value, name: &str) -> &'a Value {
    body.get(name).unwrap_or(&Value::Null)
}

/// What Node's `fs` said, with status 500.
fn fs_failed(message: String) -> ApiError {
    ApiError::internal(message)
}

fn is_not_found(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::NotFound
}

/// Node's refusal of a path with a NUL in it, which came before the file call (a 500, as any error that is not
/// ENOENT).
fn refuse_nul(argument: &str, path: &Path) -> Result<(), ApiError> {
    match nul_in_path(argument, path) {
        Some(message) => Err(fs_failed(message)),
        None => Ok(()),
    }
}

/// `fs.mkdirSync(path, { recursive: true })`: nothing to do for a folder that is there; EEXIST when a file is,
/// ENOTDIR when a file stands where a folder on the way should be (what Node's own mkdirp answered; std's would
/// give other codes).
async fn make_dirs(path: &Path) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    match tokio::fs::metadata(to_namespaced(path)).await {
        Ok(meta) if meta.is_dir() => return Ok(()),
        Ok(_) => return Err(Error::from(ErrorKind::AlreadyExists)),
        Err(err) if err.kind() != ErrorKind::NotFound => return Err(err),
        Err(_) => {}
    }
    for ancestor in path.ancestors().skip(1) {
        match tokio::fs::metadata(to_namespaced(ancestor)).await {
            Ok(meta) if meta.is_dir() => break,
            Ok(_) => return Err(Error::from(ErrorKind::NotADirectory)),
            Err(err) if err.kind() == ErrorKind::NotFound => continue,
            Err(err) => return Err(err),
        }
    }
    tokio::fs::create_dir_all(to_namespaced(path)).await
}

/// GET /api/files/ls?path=... — list directory contents.
async fn ls(State(app): State<App>, req: Request) -> Answer {
    let asked = query_path(&req);
    let req_path = if truthy(&asked) { asked } else { json!(".") };
    let resolved = resolve(&app, &req_path)?;
    refuse_nul("path", &resolved)?;

    let listing = tokio::task::spawn_blocking(move || -> Result<Result<Vec<Value>, ApiError>, std::io::Error> {
        let literal = to_namespaced(&resolved);
        let stat = std::fs::metadata(&literal).map_err(|e| with_message(e, "stat", &resolved))?;
        if !stat.is_dir() {
            return Ok(Err(ApiError::bad_request("Not a directory")));
        }
        let mut entries: Vec<std::fs::DirEntry> = std::fs::read_dir(&literal)
            .map_err(|e| with_message(e, "scandir", &resolved))?
            .collect::<Result<_, _>>()
            .map_err(|e| with_message(e, "scandir", &resolved))?;
        // libuv's scandir sorted the names on Unix; Windows gives them in the folder's own order, as Node did.
        if cfg!(unix) {
            entries.sort_by_key(|e| e.file_name());
        }
        let mut items = Vec::with_capacity(entries.len());
        for entry in entries {
            let kind = entry.file_type().map_err(|e| with_message(e, "scandir", &resolved))?;
            let size = if kind.is_file() {
                let full = resolved.join(entry.file_name());
                let meta =
                    std::fs::metadata(literal.join(entry.file_name())).map_err(|e| with_message(e, "stat", &full))?;
                json!(meta.len())
            } else {
                Value::Null
            };
            items.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "isDirectory": kind.is_dir(),
                "isFile": kind.is_file(),
                "size": size,
            }));
        }
        Ok(Ok(items))
    })
    .await
    .map_err(|err| ApiError::internal(err.to_string()))?;

    match listing {
        Ok(Ok(items)) => ok(json!({ "path": req_path, "items": items })),
        Ok(Err(refused)) => Err(refused),
        Err(err) if is_not_found(&err) => Err(ApiError::not_found("Path not found")),
        Err(err) => Err(fs_failed(err.to_string())),
    }
}

/// An I/O error whose text is Node's message for it (the kind is kept, so "not found" is still known).
fn with_message(err: std::io::Error, syscall: &str, path: &Path) -> std::io::Error {
    std::io::Error::new(err.kind(), fs_error_message(&err, syscall, path))
}

/// GET /api/files/read?path=... — read file content.
async fn read(State(app): State<App>, req: Request) -> Answer {
    let req_path = query_path(&req);
    if !truthy(&req_path) {
        return Err(ApiError::bad_request("Path required"));
    }
    let resolved = resolve(&app, &req_path)?;
    refuse_nul("path", &resolved)?;
    let literal = to_namespaced(&resolved);

    let stat = match tokio::fs::metadata(&literal).await {
        Ok(stat) => stat,
        Err(err) if is_not_found(&err) => return Err(ApiError::not_found("File not found")),
        Err(err) => return Err(fs_failed(fs_error_message(&err, "stat", &resolved))),
    };
    if !stat.is_file() {
        return Err(ApiError::bad_request("Not a file"));
    }
    let max = limits::FILE_READ_MAX_BYTES as u64;
    if stat.len() > max {
        return Err(ApiError::new(
            413,
            format!(
                "File too large ({}KB, max {}KB)",
                (stat.len() as f64 / 1024.0).round(),
                max / 1024
            ),
        ));
    }
    let content = match tokio::fs::read(&literal).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(err) if is_not_found(&err) => return Err(ApiError::not_found("File not found")),
        Err(err) => return Err(fs_failed(fs_error_message(&err, "open", &resolved))),
    };
    ok(json!({ "path": req_path, "content": content, "size": stat.len() }))
}

/// `fs.writeFileSync`'s refusal of data that is not text.
fn not_text(content: &Value) -> String {
    let received = match content {
        Value::Null => "null".to_string(),
        Value::Bool(b) => format!("type boolean ({b})"),
        Value::Number(n) => format!("type number ({})", number_to_string(n.as_f64().unwrap_or(0.0))),
        Value::Array(_) => "an instance of Array".to_string(),
        Value::Object(_) => "an instance of Object".to_string(),
        Value::String(_) => String::new(),
    };
    format!(
        "The \"data\" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received {received}"
    )
}

/// POST /api/files/write — write file content.
async fn write(State(app): State<App>, req: Request) -> Answer {
    let body = json_body(req).await?;
    let req_path = field(&body, "path");
    if !truthy(req_path) {
        return Err(ApiError::bad_request("Path required"));
    }
    let Some(content) = body.get("content") else {
        return Err(ApiError::bad_request("Content required"));
    };
    let resolved = resolve(&app, req_path)?;

    // Ensure parent directory exists
    let parent = PathBuf::from(node_dirname(&resolved.to_string_lossy()));
    refuse_nul("path", &parent)?;
    if let Err(err) = make_dirs(&parent).await {
        return Err(fs_failed(fs_error_message(&err, "mkdir", &parent)));
    }
    let Value::String(text) = content else {
        return Err(fs_failed(not_text(content)));
    };
    refuse_nul("path", &resolved)?;
    let literal = to_namespaced(&resolved);
    if let Err(err) = tokio::fs::write(&literal, text.as_bytes()).await {
        // Writing to a folder: Windows says "access denied"; libuv said EISDIR, as Linux does.
        let on_folder = tokio::fs::metadata(&literal).await.is_ok_and(|m| m.is_dir());
        let err = if on_folder {
            std::io::Error::from(std::io::ErrorKind::IsADirectory)
        } else {
            err
        };
        return Err(fs_failed(fs_error_message(&err, "open", &resolved)));
    }
    ok(json!({ "ok": true, "path": req_path }))
}

/// POST /api/files/mkdir — create directory.
async fn mkdir(State(app): State<App>, req: Request) -> Answer {
    let body = json_body(req).await?;
    let req_path = field(&body, "path");
    if !truthy(req_path) {
        return Err(ApiError::bad_request("Path required"));
    }
    let resolved = resolve(&app, req_path)?;
    refuse_nul("path", &resolved)?;
    if let Err(err) = make_dirs(&resolved).await {
        return Err(fs_failed(fs_error_message(&err, "mkdir", &resolved)));
    }
    ok(json!({ "ok": true, "path": req_path }))
}

/// POST /api/files/delete — delete file or directory.
async fn delete(State(app): State<App>, req: Request) -> Answer {
    let body = json_body(req).await?;
    let req_path = field(&body, "path");
    if !truthy(req_path) {
        return Err(ApiError::bad_request("Path required"));
    }
    let resolved = resolve(&app, req_path)?;

    // Prevent deleting root directories. Compared as paths (Node compared text, so a workspace written another way,
    // with a trailing separator or `..`, could be deleted whole).
    if allowed_roots(&app).iter().any(|root| same_path(root, &resolved)) {
        return Err(ApiError::bad_request("Cannot delete root directory"));
    }
    refuse_nul("path", &resolved)?;
    let literal = to_namespaced(&resolved);

    let stat = match tokio::fs::metadata(&literal).await {
        Ok(stat) => stat,
        Err(err) if is_not_found(&err) => return Err(ApiError::not_found("Path not found")),
        Err(err) => return Err(fs_failed(fs_error_message(&err, "stat", &resolved))),
    };
    let removed = if stat.is_dir() {
        tokio::fs::remove_dir_all(&literal).await.map_err(|e| (e, "rm"))
    } else {
        tokio::fs::remove_file(&literal).await.map_err(|e| (e, "unlink"))
    };
    match removed {
        Ok(()) => ok(json!({ "ok": true })),
        Err((err, _)) if is_not_found(&err) => Err(ApiError::not_found("Path not found")),
        Err((err, syscall)) => Err(fs_failed(fs_error_message(&err, syscall, &resolved))),
    }
}

/// `String(value)`.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(0.0)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(items) => items
            .iter()
            .map(|v| if v.is_null() { String::new() } else { js_string(v) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// POST /api/files/rename — rename file or directory.
async fn rename(State(app): State<App>, req: Request) -> Answer {
    let body = json_body(req).await?;
    let req_path = field(&body, "path");
    let new_name = field(&body, "newName");
    if !truthy(req_path) || !truthy(new_name) {
        return Err(ApiError::bad_request("Path and newName required"));
    }
    let resolved = resolve(&app, req_path)?;

    // `path.join(path.dirname(resolved), sanitized)`: the name may still hold `/` and `..`.
    let sanitized = sanitize_filename(&js_string(new_name));
    let dir = node_dirname(&resolved.to_string_lossy());
    let new_path = PathBuf::from(node_join(&[&dir, &sanitized]));

    // Validate new path is still within allowed roots: strictly inside one, compared as paths (Node checked a text
    // prefix without a separator, so `ws-old` passed for `ws`, and the workspace itself could be moved out).
    let roots = allowed_roots(&app);
    if !roots.iter().any(|root| is_inside(root, &new_path)) {
        return Err(ApiError::bad_request("New name resolves outside allowed directory"));
    }
    // Not in the Node version: a protected name (a credential, a database, an NTFS stream) is never a target either.
    if is_sensitive_path(&new_path) {
        return Err(ApiError::bad_request(SafePathError::NotAccessible.to_string()));
    }

    refuse_nul("oldPath", &resolved)?;
    refuse_nul("newPath", &new_path)?;
    let (from, to) = (to_namespaced(&resolved), to_namespaced(&new_path));
    // libuv renamed with MoveFileExW, which refuses to replace a folder (EPERM); std's rename replaces an empty one.
    if cfg!(windows) && tokio::fs::metadata(&to).await.is_ok_and(|m| m.is_dir()) {
        // ERROR_ACCESS_DENIED, which libuv called EPERM
        let denied = std::io::Error::from_raw_os_error(5);
        return Err(fs_failed(fs_error_message_two(&denied, "rename", &resolved, &new_path)));
    }
    if let Err(err) = tokio::fs::rename(&from, &to).await {
        // Folder onto a folder that is not empty: MoveFileExW said "access denied" (EPERM) here too.
        let err = if err.raw_os_error() == Some(145) && cfg!(windows) {
            std::io::Error::from_raw_os_error(5)
        } else {
            err
        };
        return Err(fs_failed(fs_error_message_two(&err, "rename", &resolved, &new_path)));
    }
    ok(json!({ "ok": true, "newPath": relative_path(&roots[0], &new_path) }))
}

/// GET /api/files/download?path=... — download a file.
async fn download(State(app): State<App>, req: Request) -> Answer {
    let req_path = query_path(&req);
    if !truthy(&req_path) {
        return Err(ApiError::bad_request("Path required"));
    }
    let resolved = resolve(&app, &req_path)?;
    refuse_nul("path", &resolved)?;
    let literal = to_namespaced(&resolved);

    let stat = match tokio::fs::metadata(&literal).await {
        Ok(stat) => stat,
        Err(err) if is_not_found(&err) => return Err(ApiError::not_found("File not found")),
        Err(err) => return Err(fs_failed(fs_error_message(&err, "stat", &resolved))),
    };
    if !stat.is_file() {
        return Err(ApiError::bad_request("Not a file"));
    }
    let file = match tokio::fs::File::open(&literal).await {
        Ok(file) => file,
        Err(err) if is_not_found(&err) => return Err(ApiError::not_found("File not found")),
        Err(err) => return Err(fs_failed(fs_error_message(&err, "open", &resolved))),
    };

    let name = resolved
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let filename = sanitize_filename(&name);
    let mut headers = HeaderMap::new();
    let disposition = format!("attachment; filename=\"{filename}\"");
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition).unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(stat.len()));
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(file));
    Ok((StatusCode::OK, headers, body).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::http::{self, request};
    use crate::testkit::{TestApp, test_app};

    fn site() -> (TestApp, Router) {
        let t = test_app();
        let router = router().with_state(t.app.clone());
        (t, router)
    }

    fn ws(t: &TestApp) -> PathBuf {
        t.config().workspace_dir.clone()
    }

    fn q(path: &str) -> String {
        url::form_urlencoded::byte_serialize(path.as_bytes()).collect()
    }

    #[tokio::test]
    async fn ls_lists_a_folder_of_the_workspace() {
        let (t, router) = site();
        std::fs::create_dir_all(ws(&t).join("proj/sub")).unwrap();
        std::fs::write(ws(&t).join("proj/a.txt"), "hello").unwrap();
        let res = http::get(&router, "/ls?path=proj").await;
        assert_eq!(res.status, 200);
        let mut items = res.json()["items"].as_array().unwrap().clone();
        items.sort_by_key(|i| i["name"].as_str().unwrap().to_string());
        assert_eq!(res.json()["path"], "proj", "the path as it was asked for");
        assert_eq!(
            Value::Array(items),
            json!([
                { "name": "a.txt", "isDirectory": false, "isFile": true, "size": 5 },
                { "name": "sub", "isDirectory": true, "isFile": false, "size": null },
            ])
        );
        // No path: the workspace itself, shown as ".".
        let root = http::get(&router, "/ls").await;
        assert_eq!(root.status, 200);
        assert_eq!(root.json()["path"], ".");
        assert!(
            root.json()["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|i| i["name"] == "proj")
        );
        assert_eq!(http::get(&router, "/ls?path=").await.json()["path"], ".");
    }

    #[tokio::test]
    async fn ls_refuses_what_is_outside_missing_or_not_a_folder() {
        let (t, router) = site();
        std::fs::write(ws(&t).join("f.txt"), "x").unwrap();
        let outside = http::get(&router, "/ls?path=..").await;
        assert_eq!(
            (outside.status, outside.json()),
            (400, json!({"error": "Path outside allowed directories"}))
        );
        let missing = http::get(&router, "/ls?path=nope").await;
        assert_eq!(
            (missing.status, missing.json()),
            (404, json!({"error": "Path not found"}))
        );
        let file = http::get(&router, "/ls?path=f.txt").await;
        assert_eq!((file.status, file.json()), (400, json!({"error": "Not a directory"})));
        let twice = http::get(&router, "/ls?path=a&path=b").await;
        assert_eq!((twice.status, twice.json()), (400, json!({"error": "Invalid path"})));
        let protected = http::get(&router, "/ls?path=.codex").await;
        assert_eq!(
            (protected.status, protected.json()),
            (400, json!({"error": "Path is not accessible"}))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ls_names_come_sorted_as_libuv_sorted_them() {
        let (t, router) = site();
        let dir = ws(&t).join("s");
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["b", "A", "a", "_"] {
            std::fs::write(dir.join(name), "").unwrap();
        }
        let res = http::get(&router, "/ls?path=s").await;
        let names: Vec<String> = res.json()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, ["A", "_", "a", "b"]);
    }

    #[tokio::test]
    async fn read_gives_the_text_and_its_size() {
        let (t, router) = site();
        std::fs::write(ws(&t).join("note.md"), "héllo\n").unwrap();
        let res = http::get(&router, "/read?path=note.md").await;
        assert_eq!(
            (res.status, res.json()),
            (200, json!({ "path": "note.md", "content": "héllo\n", "size": 7 }))
        );
        // Bytes that are not UTF-8 read as U+FFFD, as Node's utf8 decoding did.
        std::fs::write(ws(&t).join("bin"), [b'a', 0xff, b'b']).unwrap();
        assert_eq!(
            http::get(&router, "/read?path=bin").await.json()["content"],
            "a\u{fffd}b"
        );
    }

    #[tokio::test]
    async fn read_refuses_no_path_a_folder_a_missing_file_and_a_big_one() {
        let (t, router) = site();
        assert_eq!(
            http::get(&router, "/read").await.json(),
            json!({"error": "Path required"})
        );
        assert_eq!(http::get(&router, "/read?path=").await.status, 400);
        std::fs::create_dir_all(ws(&t).join("d")).unwrap();
        let folder = http::get(&router, "/read?path=d").await;
        assert_eq!((folder.status, folder.json()), (400, json!({"error": "Not a file"})));
        let missing = http::get(&router, "/read?path=missing.txt").await;
        assert_eq!(
            (missing.status, missing.json()),
            (404, json!({"error": "File not found"}))
        );
        std::fs::write(ws(&t).join("big.txt"), vec![b'x'; 2 * 1024 * 1024 + 600]).unwrap();
        let big = http::get(&router, "/read?path=big.txt").await;
        assert_eq!(
            (big.status, big.json()),
            (413, json!({"error": "File too large (2049KB, max 2048KB)"}))
        );
        let traversal = http::get(&router, &format!("/read?path={}", q("../api.token"))).await;
        assert_eq!(traversal.json(), json!({"error": "Path outside allowed directories"}));
    }

    #[tokio::test]
    async fn write_makes_the_folders_and_writes_the_text() {
        let (t, router) = site();
        let res = http::post_json(
            &router,
            "/write",
            &json!({ "path": "a/b/c.txt", "content": "hi there" }),
        )
        .await;
        assert_eq!(
            (res.status, res.json()),
            (200, json!({ "ok": true, "path": "a/b/c.txt" }))
        );
        assert_eq!(std::fs::read_to_string(ws(&t).join("a/b/c.txt")).unwrap(), "hi there");
        let empty = http::post_json(&router, "/write", &json!({ "path": "empty.txt", "content": "" })).await;
        assert_eq!(empty.status, 200);
        assert_eq!(std::fs::read_to_string(ws(&t).join("empty.txt")).unwrap(), "");
    }

    #[tokio::test]
    async fn write_refuses_what_node_refused() {
        let (t, router) = site();
        let post = |body: Value| {
            let router = router.clone();
            async move { http::post_json(&router, "/write", &body).await }
        };
        assert_eq!(
            post(json!({ "content": "x" })).await.json(),
            json!({"error": "Path required"})
        );
        assert_eq!(
            post(json!({ "path": "x.txt" })).await.json(),
            json!({"error": "Content required"})
        );
        assert_eq!(
            post(json!({ "path": 5, "content": "x" })).await.json(),
            json!({"error": "Invalid path"})
        );
        assert_eq!(
            post(json!({ "path": "../x.txt", "content": "x" })).await.json(),
            json!({"error": "Path outside allowed directories"})
        );
        assert_eq!(
            post(json!({ "path": "data/tarsee.db", "content": "x" })).await.json(),
            json!({"error": "Path is not accessible"})
        );
        // Content that is not text: the folders are made, then the write fails as writeFileSync failed.
        let res = post(json!({ "path": "made/n.txt", "content": 5 })).await;
        assert_eq!(res.status, 500);
        assert_eq!(
            res.json()["error"],
            "The \"data\" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received type number (5)"
        );
        assert!(ws(&t).join("made").is_dir());
        assert!(!ws(&t).join("made/n.txt").exists());
        let null = post(json!({ "path": "n.txt", "content": null })).await;
        assert!(null.json()["error"].as_str().unwrap().ends_with("Received null"));
        // A body that is not JSON is an empty body; JSON that is not an object or array is refused.
        let form = http::send(
            &router,
            request("POST", "/write")
                .header("content-type", "text/plain")
                .body("path=x"),
        )
        .await;
        assert_eq!((form.status, form.json()), (400, json!({"error": "Path required"})));
        let bare = http::send(
            &router,
            request("POST", "/write")
                .header("content-type", "application/json")
                .body("\"x\""),
        )
        .await;
        assert_eq!(bare.status, 400);
        let broken = http::send(
            &router,
            request("POST", "/write")
                .header("content-type", "application/json")
                .body("{\"path\":"),
        )
        .await;
        assert_eq!(broken.status, 400);
        assert!(broken.json()["error"].is_string());
    }

    #[tokio::test]
    async fn a_body_over_the_limit_is_413() {
        let (_t, router) = site();
        let big = vec![b' '; limits::JSON_BODY_MAX_BYTES + 1];
        let res = http::send(
            &router,
            request("POST", "/write")
                .header("content-type", "application/json")
                .body(big),
        )
        .await;
        assert_eq!(
            (res.status, res.json()),
            (413, json!({"error": "request entity too large"}))
        );
    }

    #[tokio::test]
    async fn mkdir_makes_a_folder_and_its_parents() {
        let (t, router) = site();
        let res = http::post_json(&router, "/mkdir", &json!({ "path": "x/y/z" })).await;
        assert_eq!((res.status, res.json()), (200, json!({ "ok": true, "path": "x/y/z" })));
        assert!(ws(&t).join("x/y/z").is_dir());
        assert_eq!(
            http::post_json(&router, "/mkdir", &json!({ "path": "x/y/z" }))
                .await
                .status,
            200
        );
        assert_eq!(
            http::post_json(&router, "/mkdir", &json!({})).await.json(),
            json!({"error": "Path required"})
        );
        std::fs::write(ws(&t).join("file"), "").unwrap();
        let clash = http::post_json(&router, "/mkdir", &json!({ "path": "file" })).await;
        assert_eq!(clash.status, 500);
        assert!(
            clash.json()["error"].as_str().unwrap().contains("mkdir"),
            "{}",
            clash.json()
        );
    }

    #[tokio::test]
    async fn delete_removes_a_file_or_a_whole_folder_but_never_the_workspace() {
        let (t, router) = site();
        std::fs::create_dir_all(ws(&t).join("dir/inner")).unwrap();
        std::fs::write(ws(&t).join("dir/inner/f.txt"), "x").unwrap();
        std::fs::write(ws(&t).join("lone.txt"), "x").unwrap();
        let post = |body: Value| {
            let router = router.clone();
            async move { http::post_json(&router, "/delete", &body).await }
        };
        assert_eq!(post(json!({ "path": "lone.txt" })).await.json(), json!({ "ok": true }));
        assert!(!ws(&t).join("lone.txt").exists());
        assert_eq!(post(json!({ "path": "dir" })).await.json(), json!({ "ok": true }));
        assert!(!ws(&t).join("dir").exists());
        let missing = post(json!({ "path": "dir" })).await;
        assert_eq!(
            (missing.status, missing.json()),
            (404, json!({"error": "Path not found"}))
        );
        let root = post(json!({ "path": ws(&t).to_string_lossy() })).await;
        assert_eq!(
            (root.status, root.json()),
            (400, json!({"error": "Cannot delete root directory"}))
        );
        assert!(ws(&t).is_dir());
        assert_eq!(
            post(json!({ "path": "" })).await.json(),
            json!({"error": "Path required"})
        );
    }

    #[tokio::test]
    async fn rename_keeps_the_new_name_safe_and_in_the_folder() {
        let (t, router) = site();
        std::fs::create_dir_all(ws(&t).join("docs")).unwrap();
        std::fs::write(ws(&t).join("docs/old.txt"), "x").unwrap();
        let post = |body: Value| {
            let router = router.clone();
            async move { http::post_json(&router, "/rename", &body).await }
        };
        let res = post(json!({ "path": "docs/old.txt", "newName": "new \"name\".txt" })).await;
        assert_eq!(res.status, 200);
        let want = format!("docs{}new__name_.txt", std::path::MAIN_SEPARATOR);
        assert_eq!(res.json(), json!({ "ok": true, "newPath": want }));
        assert!(ws(&t).join("docs/new__name_.txt").exists());
        assert_eq!(
            post(json!({ "path": "docs/new__name_.txt" })).await.json(),
            json!({"error": "Path and newName required"})
        );
        // A new name that climbs out of the workspace is refused.
        std::fs::write(ws(&t).join("top.txt"), "x").unwrap();
        let out = post(json!({ "path": "top.txt", "newName": "../escaped.txt" })).await;
        assert_eq!(
            (out.status, out.json()),
            (400, json!({"error": "New name resolves outside allowed directory"}))
        );
        assert!(ws(&t).join("top.txt").exists());
        // A number is a name too (String(newName)).
        let numbered = post(json!({ "path": "top.txt", "newName": 42 })).await;
        assert_eq!(numbered.json(), json!({ "ok": true, "newPath": "42" }));
        let missing = post(json!({ "path": "nope.txt", "newName": "x" })).await;
        assert_eq!(missing.status, 500);
        assert!(
            missing.json()["error"]
                .as_str()
                .unwrap()
                .starts_with("ENOENT: no such file or directory, rename '")
        );
    }

    #[tokio::test]
    async fn download_sends_the_file_as_an_attachment() {
        let (t, router) = site();
        std::fs::write(ws(&t).join("My Report (v2) é.txt"), "contents here").unwrap();
        let res = http::get(&router, &format!("/download?path={}", q("My Report (v2) é.txt"))).await;
        assert_eq!(res.status, 200);
        assert_eq!(res.text(), "contents here");
        assert_eq!(
            res.header("content-disposition"),
            Some("attachment; filename=\"My_Report_(v2)__.txt\"")
        );
        assert_eq!(res.header("content-length"), Some("13"));
        assert_eq!(res.header("content-type"), None);
        assert_eq!(
            http::get(&router, "/download").await.json(),
            json!({"error": "Path required"})
        );
        let missing = http::get(&router, "/download?path=gone.bin").await;
        assert_eq!(
            (missing.status, missing.json()),
            (404, json!({"error": "File not found"}))
        );
        std::fs::create_dir_all(ws(&t).join("d")).unwrap();
        assert_eq!(
            http::get(&router, "/download?path=d").await.json(),
            json!({"error": "Not a file"})
        );
        let secret = http::get(&router, &format!("/download?path={}", q("sub/.credentials.json"))).await;
        assert_eq!(
            (secret.status, secret.json()),
            (400, json!({"error": "Path is not accessible"}))
        );
    }

    /// Fixed in the Rust version: Node compared the root as text, so with `TARSEE_WORKSPACE_DIR` ending in a
    /// separator, written with `/`, or holding `..`, `{"path": "."}` deleted the whole workspace. Now the roots come
    /// from the configuration and are compared as paths, whatever the spelling.
    #[tokio::test]
    async fn the_workspace_is_never_deleted_however_its_variable_is_written() {
        let outer = crate::testkit::tmp_dir();
        let own = crate::util::node_path::normalize(&outer.path().join("own-ws"));
        let text = own.to_string_lossy().into_owned();
        let spellings = [
            text.clone(),
            format!("{text}{}", std::path::MAIN_SEPARATOR),
            text.replace('\\', "/"),
            format!(
                "{text}{}..{}own-ws",
                std::path::MAIN_SEPARATOR,
                std::path::MAIN_SEPARATOR
            ),
            format!("  {text}  "),
        ];
        for spelling in spellings {
            std::fs::create_dir_all(own.join("sub")).unwrap();
            std::fs::write(own.join("x.txt"), "x").unwrap();
            let t = crate::testkit::test_app_with_env([("TARSEE_WORKSPACE_DIR", spelling.clone())]);
            let router = router().with_state(t.app.clone());
            assert_eq!(
                http::get(&router, "/read?path=x.txt").await.json()["content"],
                "x",
                "{spelling}"
            );
            for path in [
                json!("."),
                json!("./."),
                json!("sub/.."),
                json!(text),
                json!(format!("{text}{}", std::path::MAIN_SEPARATOR)),
                json!(text.replace('\\', "/")),
                json!(format!("{text}{}.", std::path::MAIN_SEPARATOR)),
            ] {
                let res = http::post_json(&router, "/delete", &json!({ "path": path })).await;
                assert_eq!(
                    (res.status, res.json()),
                    (400, json!({"error": "Cannot delete root directory"})),
                    "{spelling} / {path}"
                );
            }
            // Nor moved out of itself.
            let res = http::post_json(&router, "/rename", &json!({ "path": ".", "newName": "own-ws-old" })).await;
            assert_eq!(
                res.json(),
                json!({"error": "New name resolves outside allowed directory"}),
                "{spelling}"
            );
            assert!(own.join("x.txt").exists(), "{spelling}");
            assert!(same_path(&allowed_roots(&t.app)[0], &own), "{spelling}");
        }
    }

    /// Windows turns `...`, `. ` and `.. ` into the folder itself, `a.txt.` into `a.txt` and `nul` into a device,
    /// unless a path is handed over literally. Node's `fs` always did that, so each name meant itself: these are
    /// Node's answers, and the files around stay as they were.
    #[tokio::test]
    async fn names_windows_would_rewrite_are_taken_literally() {
        let (t, router) = site();
        std::fs::create_dir_all(ws(&t).join("sub")).unwrap();
        std::fs::write(ws(&t).join("sub/kept.txt"), "kept").unwrap();
        std::fs::write(ws(&t).join("a.txt"), "original").unwrap();
        std::fs::write(ws(&t).join("data.db"), "secret").unwrap();
        let post = |path: &'static str, body: Value| {
            let router = router.clone();
            async move { http::post_json(&router, path, &body).await }
        };
        for name in ["...", ". ", ".. ", "sub/...", "a.txt.", "a.txt ", "nul", "con", "a. "] {
            let res = post("/delete", json!({ "path": name })).await;
            assert_eq!(
                (res.status, res.json()),
                (404, json!({"error": "Path not found"})),
                "delete {name:?}"
            );
        }
        assert_eq!(std::fs::read_to_string(ws(&t).join("sub/kept.txt")).unwrap(), "kept");
        assert_eq!(std::fs::read_to_string(ws(&t).join("a.txt")).unwrap(), "original");
        for name in ["data.db.", "DATA.DB ", "a.txt.", "nul", "con"] {
            let read = http::get(&router, &format!("/read?path={}", q(name))).await;
            assert_eq!(
                (read.status, read.json()),
                (404, json!({"error": "File not found"})),
                "read {name:?}"
            );
            let down = http::get(&router, &format!("/download?path={}", q(name))).await;
            assert_eq!(down.status, 404, "download {name:?}");
        }
        assert_eq!(http::get(&router, "/ls?path=nul").await.status, 404);
        // A write to `a.txt.` makes a file of that name; `a.txt` is untouched. `nul` and `...` are files too.
        for name in ["a.txt.", "nul", "...", "a. "] {
            let res = post("/write", json!({ "path": name, "content": "new" })).await;
            assert_eq!(res.status, 200, "write {name:?}: {}", res.text());
            let read = http::get(&router, &format!("/read?path={}", q(name))).await;
            assert_eq!(read.json()["content"], "new", "{name:?}");
        }
        assert_eq!(std::fs::read_to_string(ws(&t).join("a.txt")).unwrap(), "original");
        let res = post("/mkdir", json!({ "path": "dots..." })).await;
        assert_eq!(res.status, 200);
        let res = post("/rename", json!({ "path": "a.txt.", "newName": "...." })).await;
        assert_eq!(res.status, 200, "{}", res.text());
        // Deleting `a.txt.` removes that file, not `a.txt`.
        assert_eq!(
            post("/delete", json!({ "path": "nul" })).await.json(),
            json!({"ok": true})
        );
        assert_eq!(std::fs::read_to_string(ws(&t).join("a.txt")).unwrap(), "original");
        assert!(ws(&t).join("sub").is_dir() && ws(&t).is_dir());
    }

    /// Fixed in the Rust version: `rename` checked its target with a text prefix without a separator, so a file
    /// (or the whole workspace) could be moved into a sibling such as `ws-old` or into the parent folder.
    #[tokio::test]
    async fn a_rename_target_must_be_inside_the_workspace() {
        let (t, router) = site();
        let parent = ws(&t).parent().unwrap().to_path_buf();
        std::fs::create_dir_all(ws(&t).join("sub")).unwrap();
        std::fs::write(ws(&t).join("sub/b.txt"), "b").unwrap();
        let post = |body: Value| {
            let router = router.clone();
            async move { http::post_json(&router, "/rename", &body).await }
        };
        for body in [
            json!({ "path": ".", "newName": "workspace-old" }),
            json!({ "path": "sub/b.txt", "newName": "../../workspace-oldfile.txt" }),
            json!({ "path": "sub/b.txt", "newName": "../../x.txt" }),
            json!({ "path": "sub", "newName": "../.." }),
        ] {
            let res = post(body.clone()).await;
            assert_eq!(
                (res.status, res.json()),
                (400, json!({"error": "New name resolves outside allowed directory"})),
                "{body}"
            );
        }
        assert!(ws(&t).join("sub/b.txt").exists());
        assert!(!parent.join("workspace-old").exists() && !parent.join("x.txt").exists());
        // Moving within the workspace with `/` in the name still works, as it did.
        let res = post(json!({ "path": "sub/b.txt", "newName": "../moved.txt" })).await;
        assert_eq!(res.json(), json!({ "ok": true, "newPath": "moved.txt" }));
        // A protected name is not a target either (not in the Node version).
        std::fs::write(ws(&t).join("c.txt"), "c").unwrap();
        let res = post(json!({ "path": "c.txt", "newName": "vault.json" })).await;
        assert_eq!(
            (res.status, res.json()),
            (400, json!({"error": "Path is not accessible"}))
        );
    }

    /// Fixed in the Rust version (Windows): a `:` after the drive names an NTFS stream, which got around the `.db`
    /// protection (`data.db::$DATA` is the database).
    #[cfg(windows)]
    #[tokio::test]
    async fn a_stream_name_is_refused() {
        let (t, router) = site();
        std::fs::write(ws(&t).join("data.db"), "secret").unwrap();
        std::fs::write(ws(&t).join("a.txt"), "a").unwrap();
        for name in ["data.db::$DATA", "a.txt::$DATA", "a.txt:hidden"] {
            let res = http::get(&router, &format!("/read?path={}", q(name))).await;
            assert_eq!(
                (res.status, res.json()),
                (400, json!({"error": "Path is not accessible"})),
                "{name}"
            );
        }
        let res = http::post_json(&router, "/write", &json!({ "path": "a.txt:hidden", "content": "x" })).await;
        assert_eq!(res.status, 400);
        let res = http::post_json(&router, "/rename", &json!({ "path": "a.txt", "newName": "b:s" })).await;
        assert_eq!(
            (res.status, res.json()),
            (400, json!({"error": "Path is not accessible"}))
        );
    }

    #[tokio::test]
    async fn json_bodies_are_read_as_express_json_read_them() {
        let (t, router) = site();
        let send = |body: Vec<u8>, content_type: &'static str| {
            let router = router.clone();
            async move {
                http::send(
                    &router,
                    request("POST", "/write")
                        .header("content-type", content_type)
                        .body(body),
                )
                .await
            }
        };
        // A byte order mark is dropped.
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(br#"{"path":"bom.txt","content":"b"}"#);
        assert_eq!(send(bom, "application/json").await.status, 200);
        assert_eq!(std::fs::read_to_string(ws(&t).join("bom.txt")).unwrap(), "b");
        // A lone surrogate is accepted, and written out as U+FFFD (what UTF-8 made of it in Node). (`|` stands for
        // a backslash in these texts.)
        let json_text = |s: &str| s.replace('|', "\\");
        let lone = json_text(r#"{"path":"lone.txt","content":"a|ud800b|udc00c|ud83d|ude00"}"#).into_bytes();
        assert_eq!(send(lone, "application/json; charset=utf-8").await.status, 200);
        assert_eq!(
            std::fs::read_to_string(ws(&t).join("lone.txt")).unwrap(),
            "a\u{FFFD}b\u{FFFD}c\u{1F600}"
        );
        // An escaped backslash before a `u` is not an escape.
        let not_escape = br#"{"path":"bs.txt","content":"\\ud800"}"#.to_vec();
        assert_eq!(send(not_escape, "application/json").await.status, 200);
        assert_eq!(std::fs::read_to_string(ws(&t).join("bs.txt")).unwrap(), "\\ud800");
        // UTF-16 is read too; another charset is refused before the body is read.
        let utf16: Vec<u8> = r#"{"path":"w.txt","content":"é"}"#.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(send(utf16, "application/json; charset=utf-16le").await.status, 200);
        assert_eq!(std::fs::read_to_string(ws(&t).join("w.txt")).unwrap(), "é");
        let latin = send(b"{}".to_vec(), "application/json; charset=latin1").await;
        assert_eq!(
            (latin.status, latin.json()),
            (415, json!({"error": "unsupported charset \"LATIN1\""}))
        );
        // Only a byte order mark: an empty body.
        let only_bom = send(vec![0xEF, 0xBB, 0xBF], "application/json").await;
        assert_eq!(
            (only_bom.status, only_bom.json()),
            (400, json!({"error": "Path required"}))
        );
        let mended = |s: &str| mend_lone_surrogates(&json_text(s)).into_owned();
        assert_eq!(mended(r#"["|ud800", "x"]"#), json_text(r#"["|uFFFD", "x"]"#));
        assert_eq!(mended(r#"{"a":"|uDC00"}"#), json_text(r#"{"a":"|uFFFD"}"#));
        assert_eq!(mended(r#"["|ud83d|ude00"]"#), json_text(r#"["|ud83d|ude00"]"#));
        assert_eq!(mended(r#"["||ud800"]"#), json_text(r#"["||ud800"]"#));
    }

    #[tokio::test]
    async fn file_errors_are_nodes() {
        let (t, router) = site();
        std::fs::create_dir_all(ws(&t).join("dir/inner")).unwrap();
        std::fs::write(ws(&t).join("dir/inner/f"), "f").unwrap();
        std::fs::write(ws(&t).join("file"), "f").unwrap();
        let post = |path: &'static str, body: Value| {
            let router = router.clone();
            async move { http::post_json(&router, path, &body).await }
        };
        let w = |p: &str| ws(&t).join(p).display().to_string();
        // Writing to a folder: EISDIR (Windows itself says "access denied").
        let res = post("/write", json!({ "path": "dir", "content": "x" })).await;
        assert_eq!(
            (res.status, res.json()),
            (
                500,
                json!({"error": format!("EISDIR: illegal operation on a directory, open '{}'", w("dir"))})
            )
        );
        // A folder where a file is: EEXIST; a file on the way: ENOTDIR (what Node's own mkdirp said).
        let res = post("/mkdir", json!({ "path": "file" })).await;
        assert_eq!(
            res.json(),
            json!({"error": format!("EEXIST: file already exists, mkdir '{}'", w("file"))})
        );
        let res = post("/mkdir", json!({ "path": "file/sub" })).await;
        let sub = ws(&t).join("file").join("sub");
        assert_eq!(
            res.json(),
            json!({"error": format!("ENOTDIR: not a directory, mkdir '{}'", sub.display())})
        );
        let res = post("/write", json!({ "path": "file/x.txt", "content": "x" })).await;
        assert_eq!(
            res.json(),
            json!({"error": format!("EEXIST: file already exists, mkdir '{}'", w("file"))})
        );
        // A NUL in the path, refused before any file call.
        let res = http::get(&router, "/read?path=a%00b").await;
        let nul = ws(&t).join("a\0b");
        assert_eq!(res.status, 500);
        assert_eq!(
            res.json(),
            json!({"error": crate::lib::safe_path::nul_in_path("path", &nul).unwrap()})
        );
        let res = post("/rename", json!({ "path": "file", "newName": "x\u{0}y" })).await;
        // (sanitizeFilename turns the NUL into "_" first, so the rename goes through, as in Node.)
        assert_eq!(res.json(), json!({"ok": true, "newPath": "x_y"}));
        // A folder onto a folder: libuv's MoveFileExW refused (EPERM); std's rename would replace an empty one.
        std::fs::create_dir_all(ws(&t).join("empty")).unwrap();
        let res = post("/rename", json!({ "path": "dir", "newName": "empty" })).await;
        if cfg!(windows) {
            assert_eq!(
                res.json(),
                json!({"error": format!("EPERM: operation not permitted, rename '{}' -> '{}'", w("dir"), w("empty"))})
            );
            assert!(ws(&t).join("dir/inner/f").exists());
        } else {
            assert_eq!(res.json(), json!({"ok": true, "newPath": "empty"}));
        }
    }

    #[tokio::test]
    async fn only_the_workspace_is_reachable_not_the_state_folder_around_it() {
        let (t, router) = site();
        std::fs::write(t.path().join("notes.txt"), "outside").unwrap();
        let abs = t.path().join("notes.txt");
        let res = http::get(&router, &format!("/read?path={}", q(&abs.to_string_lossy()))).await;
        assert_eq!(
            (res.status, res.json()),
            (400, json!({"error": "Path outside allowed directories"}))
        );
    }
}
