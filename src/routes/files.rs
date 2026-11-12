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
//! The JSON bodies are read as `express.json` read them (application/json only; anything else is an empty body),
//! with the server's 50 MB limit; the query as Express 5's simple parser read it (a repeated `path` is a list, so
//! it is not a path).

use std::path::{Path, PathBuf};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};

use crate::app::App;
use crate::config::constants::limits;
use crate::error::ApiError;
use crate::lib::safe_path::{
    SafePathError, fs_error_message, fs_error_message_two, join_path, normalize_path, relative_path, safe_path,
    sanitize_filename,
};
use crate::util::js::{number_to_string, truthy};

pub fn router() -> Router<App> {
    Router::new()
        .route("/ls", get(ls))
        .route("/read", get(read))
        .route("/write", post(write))
        .route("/mkdir", post(mkdir))
        .route("/delete", post(delete))
        .route("/rename", post(rename))
        .route("/download", get(download))
        .layer(DefaultBodyLimit::max(limits::JSON_BODY_MAX_BYTES))
}

type Answer = Result<Response, ApiError>;

fn ok(body: Value) -> Answer {
    Ok(axum::Json(body).into_response())
}

/// `ALLOWED_ROOTS`: `[config.WORKSPACE_DIR]`, as the text Node had. `delete` and `rename` compare paths with it as
/// text, so it must be what Node had: `TARSEE_WORKSPACE_DIR` as it was set, or else `path.join(STATE_DIR,
/// "workspace")`, which Node normalized (the Rust configuration joins without normalizing, so on Windows a state
/// folder written with `/` would otherwise never equal a resolved path).
fn allowed_roots(app: &App) -> Vec<PathBuf> {
    let root = match app.env().trimmed("TARSEE_WORKSPACE_DIR") {
        Some(raw) => PathBuf::from(raw),
        None => normalize_path(&app.config().state_dir.join("workspace")),
    };
    vec![root]
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
    let is_json = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json"));
    let bytes: Bytes = axum::body::to_bytes(req.into_body(), limits::JSON_BODY_MAX_BYTES)
        .await
        .map_err(|_| ApiError::new(413, "request entity too large"))?;
    if !is_json || bytes.is_empty() {
        return Ok(json!({}));
    }
    // Strict, as body-parser was: only an object or an array.
    let first = bytes.iter().find(|b| !b" \t\n\r".contains(b));
    if !matches!(first, Some(b'{') | Some(b'[')) {
        let shown = String::from_utf8_lossy(&bytes);
        return Err(ApiError::bad_request(format!(
            "Unexpected token '{}', \"{}\" is not valid JSON",
            shown.trim_start().chars().next().unwrap_or(' '),
            shown.chars().take(10).collect::<String>()
        )));
    }
    serde_json::from_slice(&bytes).map_err(|err| ApiError::bad_request(err.to_string()))
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

/// GET /api/files/ls?path=... — list directory contents.
async fn ls(State(app): State<App>, req: Request) -> Answer {
    let asked = query_path(&req);
    let req_path = if truthy(&asked) { asked } else { json!(".") };
    let resolved = resolve(&app, &req_path)?;

    let listing = tokio::task::spawn_blocking(move || -> Result<Result<Vec<Value>, ApiError>, std::io::Error> {
        let stat = std::fs::metadata(&resolved).map_err(|e| with_message(e, "stat", &resolved))?;
        if !stat.is_dir() {
            return Ok(Err(ApiError::bad_request("Not a directory")));
        }
        let mut entries: Vec<std::fs::DirEntry> = std::fs::read_dir(&resolved)
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
                let meta = std::fs::metadata(&full).map_err(|e| with_message(e, "stat", &full))?;
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

    let stat = match tokio::fs::metadata(&resolved).await {
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
    let content = match tokio::fs::read(&resolved).await {
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
    if let Some(parent) = resolved.parent()
        && let Err(err) = tokio::fs::create_dir_all(parent).await
    {
        return Err(fs_failed(fs_error_message(&err, "mkdir", parent)));
    }
    let Value::String(text) = content else {
        return Err(fs_failed(not_text(content)));
    };
    if let Err(err) = tokio::fs::write(&resolved, text.as_bytes()).await {
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
    if let Err(err) = tokio::fs::create_dir_all(&resolved).await {
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

    // Prevent deleting root directories (compared as text, as `ALLOWED_ROOTS.includes(resolved)` did)
    if allowed_roots(&app)
        .iter()
        .any(|root| root.as_os_str() == resolved.as_os_str())
    {
        return Err(ApiError::bad_request("Cannot delete root directory"));
    }

    let stat = match tokio::fs::metadata(&resolved).await {
        Ok(stat) => stat,
        Err(err) if is_not_found(&err) => return Err(ApiError::not_found("Path not found")),
        Err(err) => return Err(fs_failed(fs_error_message(&err, "stat", &resolved))),
    };
    let removed = if stat.is_dir() {
        tokio::fs::remove_dir_all(&resolved).await.map_err(|e| (e, "rm"))
    } else {
        tokio::fs::remove_file(&resolved).await.map_err(|e| (e, "unlink"))
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

    let sanitized = sanitize_filename(&js_string(new_name));
    let dir = resolved.parent().unwrap_or(&resolved);
    let new_path = join_path(dir, &sanitized);

    // Validate new path is still within allowed roots (a prefix of the text, as the JS checked)
    let roots = allowed_roots(&app);
    let new_text = new_path.to_string_lossy();
    if !roots
        .iter()
        .any(|root| new_text.starts_with(root.to_string_lossy().as_ref()))
    {
        return Err(ApiError::bad_request("New name resolves outside allowed directory"));
    }

    if let Err(err) = tokio::fs::rename(&resolved, &new_path).await {
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

    let stat = match tokio::fs::metadata(&resolved).await {
        Ok(stat) => stat,
        Err(err) if is_not_found(&err) => return Err(ApiError::not_found("File not found")),
        Err(err) => return Err(fs_failed(fs_error_message(&err, "stat", &resolved))),
    };
    if !stat.is_file() {
        return Err(ApiError::bad_request("Not a file"));
    }
    let file = match tokio::fs::File::open(&resolved).await {
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

    #[tokio::test]
    async fn a_workspace_set_by_its_own_variable_is_the_root_as_it_was_written() {
        let outer = crate::testkit::tmp_dir();
        // (Written normalized: the check compares text, so a root written another way would not match; see the
        // report on this package.)
        let own = normalize_path(&outer.path().join("own-ws"));
        std::fs::create_dir_all(&own).unwrap();
        let t = crate::testkit::test_app_with_env([("TARSEE_WORKSPACE_DIR", own.to_string_lossy().into_owned())]);
        let router = router().with_state(t.app.clone());
        std::fs::write(own.join("x.txt"), "x").unwrap();
        let res = http::get(&router, "/read?path=x.txt").await;
        assert_eq!(res.json()["content"], "x");
        let root = http::post_json(&router, "/delete", &json!({ "path": own.to_string_lossy() })).await;
        assert_eq!(root.json(), json!({"error": "Cannot delete root directory"}));
        assert_eq!(allowed_roots(&t.app), vec![own]);
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
