//! Port of `src/routes/skills.js`: the skills routes (`/api/skills`, mounted behind sign-in and the CSRF check in
//! `server.rs`).
//!
//! Express matched `GET`, `PUT` and `DELETE /:name` for any name, `install`, `uninstall` and `setup` included; axum
//! picks the fixed path first and would answer 405 there, so those three paths carry the `:name` handlers too.
//!
//! A skill name that reaches a folder (install, uninstall, setup, update, delete) must be one plain name; any other
//! is answered as a skill that does not exist. The Node version joined whatever it was given (`../x` left the skills
//! folders), and in Rust an absolute name would have replaced the folder altogether: `DELETE /api/skills/%2Fdata`
//! removed `/data`. The copies and deletes run off the async runtime (`spawn_blocking`).

use std::fs;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, routing::MethodRouter};
use serde_json::{Value, json};

use crate::app::App;
use crate::error::{ApiError, ApiResult};
use crate::lib::safe_path::fs_error_message;
use crate::lib::skills_engine::{
    SkillError, get_all_skills_with_status, get_custom_skills_dir, get_skill_content, install_skill, invalidate_cache,
    remove_entry, scan_skills, uninstall_skill,
};
use crate::lib::workspace_files::is_plain_name;
use crate::lib::workspace_files::jstext::{js_string, path_type_error};
use crate::util::js::truthy;
use crate::util::node_path::to_namespaced;

pub fn router() -> Router<App> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/install", by_name("install").post(install))
        .route("/uninstall", by_name("uninstall").post(uninstall))
        .route("/setup", by_name("setup").post(setup))
        .route("/{name}", get(get_one).put(update).delete(remove))
}

/// `GET`, `PUT` and `DELETE /:name` for a path that is also a fixed route.
fn by_name(name: &'static str) -> MethodRouter<App> {
    get(move |state| get_one(state, Path(name.to_string())))
        .put(move |state, headers, body| update(state, Path(name.to_string()), headers, body))
        .delete(move |state| remove(state, Path(name.to_string())))
}

/// Holds the file work requests start until a test lets it go (never present outside tests), so a test can leave a
/// request half way and see the work finish.
#[derive(Default)]
pub(crate) struct HeldWork {
    entered: std::sync::atomic::AtomicBool,
    released: parking_lot::Mutex<bool>,
    wake: parking_lot::Condvar,
}

impl HeldWork {
    fn wait(&self) {
        self.entered.store(true, std::sync::atomic::Ordering::SeqCst);
        let mut released = self.released.lock();
        while !*released {
            self.wake.wait(&mut released);
        }
    }

    /// Whether some work has started and is being held.
    #[cfg(test)]
    pub(crate) fn entered(&self) -> bool {
        self.entered.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn release(&self) {
        *self.released.lock() = true;
        self.wake.notify_all();
    }
}

/// Runs a request's file work, start to end, in a task of its own: Express ran a handler to its end even when the
/// browser went away, while axum drops a handler at its next `.await`, so work done in the handler itself could stop
/// half way (a skill half copied, a cache left stale). The task also keeps the blocking copies and deletes off the
/// async runtime. The handler only waits for the answer.
async fn in_own_task<T: Send + 'static>(
    app: &App,
    work: impl FnOnce(App) -> T + Send + 'static,
) -> Result<T, ApiError> {
    let worker = app.clone();
    let held = app.get::<HeldWork>();
    tokio::task::spawn_blocking(move || {
        if let Some(held) = held {
            held.wait();
        }
        work(worker)
    })
    .await
    .map_err(|err| unhandled_error(app, &err.to_string()))
}

/// GET / — every shipped skill with whether it is installed.
async fn list(State(app): State<App>) -> ApiResult {
    Ok(Json(json!({ "skills": get_all_skills_with_status(&app) })))
}

/// The installed skill's name from `{ name }`, as `installSkill(name)` received it.
fn name_arg(name: &Value) -> Result<String, String> {
    name.as_str()
        .map(String::from)
        .ok_or_else(|| path_type_error(Some(name)))
}

/// POST /install — installs a skill (copies it from the shipped ones into the workspace). Body: `{ name }`.
async fn install(State(app): State<App>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let body = express_json_body(&headers, &body)?.unwrap_or_else(|| json!({}));
    let name = body.get("name").cloned().unwrap_or(Value::Null);
    if !truthy(&name) {
        return Err(ApiError::bad_request("Skill name required"));
    }
    let skill = name_arg(&name).map_err(ApiError::bad_request)?;
    in_own_task(&app, move |app| install_skill(&app, &skill))
        .await?
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    Ok(Json(json!({ "ok": true, "name": name, "installed": true })))
}

/// POST /uninstall — removes an installed skill from the workspace. Body: `{ name }`.
async fn uninstall(State(app): State<App>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let body = express_json_body(&headers, &body)?.unwrap_or_else(|| json!({}));
    let name = body.get("name").cloned().unwrap_or(Value::Null);
    if !truthy(&name) {
        return Err(ApiError::bad_request("Skill name required"));
    }
    let skill = name_arg(&name).map_err(ApiError::bad_request)?;
    in_own_task(&app, move |app| uninstall_skill(&app, &skill))
        .await?
        .map_err(ApiError::bad_request)?;
    Ok(Json(json!({ "ok": true, "name": name, "installed": false })))
}

/// POST /setup — installs several skills at once (onboarding). Body: `{ install: string[] }`.
async fn setup(State(app): State<App>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let body = express_json_body(&headers, &body)?.unwrap_or_else(|| json!({}));
    let Some(Value::Array(names)) = body.get("install").cloned() else {
        return Err(ApiError::bad_request("install array required"));
    };
    let (installed, failed) = in_own_task(&app, move |app| {
        let mut installed = Vec::new();
        let mut failed = Vec::new();
        for name in names {
            let done = name.as_str().is_some_and(|n| install_skill(&app, n).is_ok());
            if done {
                installed.push(name);
            } else {
                failed.push(name);
            }
        }
        (installed, failed)
    })
    .await?;
    Ok(Json(json!({ "ok": true, "installed": installed, "failed": failed })))
}

/// GET /:name — an installed skill's whole SKILL.md.
async fn get_one(State(app): State<App>, Path(name): Path<String>) -> ApiResult {
    let skill = get_skill_content(&app, &name).ok_or_else(|| ApiError::not_found("Skill not found"))?;
    Ok(Json(serde_json::to_value(skill).unwrap_or(Value::Null)))
}

/// POST / — creates a custom skill. Body: `{ name, description, content }`.
async fn create(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
    let Some(body) = express_json_body(&headers, &body)? else {
        return Err(unhandled_error_named(
            &app,
            "TypeError",
            "Cannot destructure property 'name' of 'req.body' as it is undefined.",
        ));
    };
    let name = body.get("name").cloned().unwrap_or(Value::Null);
    let description = body.get("description");
    let content = body.get("content");

    if !truthy(&name) || !content.is_some_and(truthy) {
        return Err(ApiError::bad_request("Name and content are required"));
    }

    // RegExp.test turns the name into text first.
    let name_text = js_string(Some(&name));
    let valid = name_text
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name_text
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(ApiError::bad_request(
            "Invalid name. Use lowercase letters, numbers, and hyphens only.",
        ));
    }
    let Some(name) = name.as_str().map(String::from) else {
        return Err(unhandled_error_named(&app, "TypeError", &path_type_error(Some(&name))));
    };

    let description = match description {
        Some(d) if truthy(d) => js_string(Some(d)),
        _ => String::new(),
    };
    let md = format!(
        "---\nname: {name}\ndescription: {description}\n---\n\n{}",
        js_string(content)
    );
    let made = name.clone();
    in_own_task(&app, move |app| {
        // The pattern above makes the name one plain name; every call takes the literal path (on Windows a skill
        // named `nul` is a folder of that name, as Node made it).
        let skill_dir = get_custom_skills_dir(&app).join(&made);
        if to_namespaced(&skill_dir).exists() {
            return Err(ApiError::conflict("Skill already exists. Use PUT to update."));
        }
        fs::create_dir_all(to_namespaced(&skill_dir))
            .map_err(|e| ApiError::internal(fs_error_message(&e, "mkdir", &skill_dir)))?;
        let file = skill_dir.join("SKILL.md");
        fs::write(to_namespaced(&file), md).map_err(|e| ApiError::internal(fs_error_message(&e, "open", &file)))?;
        invalidate_cache(&app);
        Ok(())
    })
    .await??;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true, "name": name }))).into_response())
}

/// The body of a skill as it was written below its frontmatter. The parse keeps the blank line the write put after
/// the frontmatter, so writing the kept body back as it was read would add one blank line at each update (the Node
/// code did): that one line is taken off.
fn kept_body(content: &str) -> &str {
    content
        .strip_prefix("\r\n")
        .or_else(|| content.strip_prefix('\n'))
        .unwrap_or(content)
}

/// PUT /:name — updates a custom skill. Body: `{ description?, content? }`.
async fn update(State(app): State<App>, Path(name): Path<String>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let Some(body) = express_json_body(&headers, &body)? else {
        return Err(unhandled_error_named(
            &app,
            "TypeError",
            "Cannot destructure property 'description' of 'req.body' as it is undefined.",
        ));
    };
    let description = body.get("description").cloned();
    let content = body.get("content").cloned();

    in_own_task(&app, move |app| {
        let not_found = || ApiError::not_found("Custom skill not found (built-in skills are read-only)");
        if !is_plain_name(&name) {
            return Err(not_found());
        }
        let skill_path = get_custom_skills_dir(&app).join(&name).join("SKILL.md");
        if !to_namespaced(&skill_path).exists() {
            return Err(not_found());
        }

        let existing = get_skill_content(&app, &name);
        // A field left out keeps what is there; one sent as null becomes "null", as the JS template wrote it.
        let new_desc = match &description {
            Some(d) => js_string(Some(d)),
            None => existing.as_ref().map(|e| e.description.clone()).unwrap_or_default(),
        };
        let new_content = match &content {
            Some(c) => js_string(Some(c)),
            None => existing
                .as_ref()
                .map(|e| kept_body(&e.content).to_string())
                .unwrap_or_default(),
        };

        let md = format!("---\nname: {name}\ndescription: {new_desc}\n---\n\n{new_content}");
        fs::write(to_namespaced(&skill_path), md)
            .map_err(|e| ApiError::internal(fs_error_message(&e, "open", &skill_path)))?;
        invalidate_cache(&app);
        Ok(())
    })
    .await??;
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /:name — deletes a custom skill.
async fn remove(State(app): State<App>, Path(name): Path<String>) -> ApiResult {
    in_own_task(&app, move |app| {
        if !is_plain_name(&name) {
            return Err(ApiError::not_found("Skill not found"));
        }
        let skill_dir = get_custom_skills_dir(&app).join(&name);
        // The literal path: on Windows `...` is not the skills folder, nor `a.` the skill `a`.
        if !to_namespaced(&skill_dir).exists() {
            return Err(ApiError::not_found("Skill not found"));
        }

        // Prevent deleting built-in skills
        let built_in = scan_skills(&app)
            .iter()
            .find(|s| s.name == name)
            .is_some_and(|s| s.source == "built-in");
        if built_in {
            return Err(ApiError::forbidden("Cannot delete built-in skills"));
        }

        remove_entry(&skill_dir).map_err(ApiError::internal)?;
        invalidate_cache(&app);
        Ok(())
    })
    .await??;
    Ok(Json(json!({ "ok": true })))
}

impl From<SkillError> for ApiError {
    fn from(err: SkillError) -> Self {
        ApiError::bad_request(err.to_string())
    }
}

/// The request body as `express.json()` left it in `req.body`: parsed when the content type is JSON (an empty body
/// is `{}`), `None` (`undefined`) otherwise. A body that is not JSON is a 400, as body-parser answered (the message
/// is serde's, not V8's).
pub(crate) fn express_json_body(headers: &HeaderMap, body: &[u8]) -> Result<Option<Value>, ApiError> {
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"));
    if !is_json {
        return Ok(None);
    }
    if body.is_empty() {
        return Ok(Some(json!({})));
    }
    // body-parser's strict mode: only an object or an array.
    let first = body.iter().find(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r'));
    if !matches!(first, Some(b'{') | Some(b'[')) {
        return Err(ApiError::bad_request(format!(
            "Unexpected token '{}', \"{}\" is not valid JSON",
            first.map(|b| char::from(*b)).unwrap_or(' '),
            String::from_utf8_lossy(body)
        )));
    }
    serde_json::from_slice(body)
        .map(Some)
        .map_err(|err| ApiError::bad_request(err.to_string()))
}

/// An error the Node route did not catch, as the global error handler (`middleware/error-handler.js`) answered it:
/// a 500 that names no detail in production.
pub(crate) fn unhandled_error(app: &App, message: &str) -> ApiError {
    log::error!("[error] {}", crate::lib::redact::redact_secrets(message));
    internal_error_body(app, message)
}

/// [`unhandled_error`] for an error whose JavaScript class is known ("TypeError", "RangeError"): the logged stack
/// began `<name>: <message>`. The stack's lines themselves were the Node program's and have no counterpart.
pub(crate) fn unhandled_error_named(app: &App, name: &str, message: &str) -> ApiError {
    log::error!(
        "[error] {}",
        crate::lib::redact::redact_secrets(&format!("{name}: {message}"))
    );
    internal_error_body(app, message)
}

fn internal_error_body(app: &App, message: &str) -> ApiError {
    let mut body = json!({ "error": "Internal server error" });
    if app.env().get("NODE_ENV").as_deref() != Some("production") {
        body["detail"] = Value::String(crate::lib::redact::redact_secrets(message));
    }
    ApiError::with_body(500, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::http::{self, TestRequest, request};
    use crate::testkit::{TestApp, test_app};
    use std::time::{Duration, Instant};
    use tower::ServiceExt;

    /// Sends a request and leaves once its file work has started, as a browser that closes the page; then lets the
    /// work go on.
    async fn start_then_leave(t: &TestApp, router: &Router, req: TestRequest) {
        let held = t.app.set(HeldWork::default());
        let mut call = Box::pin(router.clone().oneshot(req.build()));
        let deadline = Instant::now() + Duration::from_secs(30);
        while !held.entered() {
            assert!(
                futures::poll!(call.as_mut()).is_pending(),
                "the request finished before its work began"
            );
            assert!(Instant::now() < deadline, "the request never reached its work");
            tokio::task::yield_now().await;
        }
        drop(call);
        t.app.remove::<HeldWork>();
        held.release();
    }

    /// Waits until `done` holds (the thing itself, not a fixed time), for at most 10 seconds: generous for work of
    /// milliseconds, and well inside the skills cache's 30, so a stale cache cannot pass for an invalidated one.
    async fn wait_for(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < deadline, "{what} never happened");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn app() -> (TestApp, Router) {
        let t = test_app();
        let router = router().with_state(t.app.clone());
        (t, router)
    }

    fn write_skill(t: &TestApp, folder: &str, text: &str) {
        let dir = get_custom_skills_dir(t).join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), text).unwrap();
    }

    #[tokio::test]
    async fn the_list_has_every_shipped_skill_with_its_install_state() {
        let (t, router) = app();
        install_skill(&t, "diagram").unwrap();
        let res = http::get(&router, "/").await;
        assert_eq!(res.status, 200);
        let skills = res.json()["skills"].as_array().unwrap().clone();
        assert!(skills.len() > 5);
        let diagram = skills.iter().find(|s| s["name"] == "diagram").unwrap();
        assert_eq!(
            diagram.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["name", "description", "source", "installed"]
        );
        assert_eq!(
            (diagram["source"].clone(), diagram["installed"].clone()),
            (json!("built-in"), json!(true))
        );
        assert!(
            skills
                .iter()
                .filter(|s| s["name"] != "diagram")
                .all(|s| s["installed"] == false)
        );
    }

    #[tokio::test]
    async fn install_and_uninstall_answer_and_refuse_as_before() {
        let (t, router) = app();
        let res = http::post_json(&router, "/install", &json!({"name": "diagram"})).await;
        assert_eq!(
            (res.status, res.json()),
            (200, json!({"ok": true, "name": "diagram", "installed": true}))
        );
        assert!(get_custom_skills_dir(&t).join("diagram").is_dir());

        let res = http::post_json(&router, "/install", &json!({})).await;
        assert_eq!((res.status, res.json()), (400, json!({"error": "Skill name required"})));
        let res = http::send(&router, request("POST", "/install")).await;
        assert_eq!((res.status, res.json()), (400, json!({"error": "Skill name required"})));
        let res = http::post_json(&router, "/install", &json!({"name": "nope"})).await;
        assert_eq!(
            (res.status, res.json()),
            (400, json!({"error": "Skill \"nope\" not found"}))
        );
        let res = http::post_json(&router, "/install", &json!({"name": 7})).await;
        assert_eq!(
            (res.status, res.json()),
            (
                400,
                json!({"error": "The \"path\" argument must be of type string. Received type number (7)"})
            )
        );

        let res = http::post_json(&router, "/uninstall", &json!({"name": "diagram"})).await;
        assert_eq!(
            (res.status, res.json()),
            (200, json!({"ok": true, "name": "diagram", "installed": false}))
        );
        assert!(!get_custom_skills_dir(&t).join("diagram").exists());
        let res = http::post_json(&router, "/uninstall", &json!({"name": ""})).await;
        assert_eq!((res.status, res.json()), (400, json!({"error": "Skill name required"})));
    }

    #[tokio::test]
    async fn setup_installs_each_and_says_which_failed() {
        let (t, router) = app();
        let res = http::post_json(&router, "/setup", &json!({"install": ["diagram", "nope", 3]})).await;
        assert_eq!(
            (res.status, res.json()),
            (
                200,
                json!({"ok": true, "installed": ["diagram"], "failed": ["nope", 3]})
            )
        );
        assert!(get_custom_skills_dir(&t).join("diagram").is_dir());
        let res = http::post_json(&router, "/setup", &json!({"install": "diagram"})).await;
        assert_eq!(
            (res.status, res.json()),
            (400, json!({"error": "install array required"}))
        );
    }

    #[tokio::test]
    async fn a_custom_skill_is_created_read_updated_and_deleted() {
        let (t, router) = app();
        let res = http::post_json(
            &router,
            "/",
            &json!({"name": "my-skill", "description": "Does a thing.", "content": "# Steps\n1. go"}),
        )
        .await;
        assert_eq!((res.status, res.json()), (201, json!({"ok": true, "name": "my-skill"})));
        let path = get_custom_skills_dir(&t).join("my-skill").join("SKILL.md");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "---\nname: my-skill\ndescription: Does a thing.\n---\n\n# Steps\n1. go"
        );

        let res = http::get(&router, "/my-skill").await;
        assert_eq!(
            (res.status, res.json()),
            (
                200,
                json!({
                    "name": "my-skill", "description": "Does a thing.", "source": "installed",
                    "content": "\n# Steps\n1. go",
                    "frontmatter": {"name": "my-skill", "description": "Does a thing."}
                })
            )
        );

        let res = http::post_json(&router, "/", &json!({"name": "my-skill", "content": "again"})).await;
        assert_eq!(
            (res.status, res.json()),
            (409, json!({"error": "Skill already exists. Use PUT to update."}))
        );

        let res = http::put_json(&router, "/my-skill", &json!({"content": "new body"})).await;
        assert_eq!((res.status, res.json()), (200, json!({"ok": true})));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "---\nname: my-skill\ndescription: Does a thing.\n---\n\nnew body"
        );
        let res = http::put_json(&router, "/my-skill", &json!({"description": null})).await;
        assert_eq!(res.status, 200);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "---\nname: my-skill\ndescription: null\n---\n\nnew body"
        );
        // Kept content stays as it is, however many times (the Node code added a blank line each time).
        for _ in 0..3 {
            http::put_json(&router, "/my-skill", &json!({"description": "again"})).await;
        }
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "---\nname: my-skill\ndescription: again\n---\n\nnew body"
        );
        let res = http::put_json(&router, "/other", &json!({})).await;
        assert_eq!(
            (res.status, res.json()),
            (
                404,
                json!({"error": "Custom skill not found (built-in skills are read-only)"})
            )
        );

        let res = http::delete(&router, "/my-skill").await;
        assert_eq!((res.status, res.json()), (200, json!({"ok": true})));
        assert!(!path.exists());
        let res = http::delete(&router, "/my-skill").await;
        assert_eq!((res.status, res.json()), (404, json!({"error": "Skill not found"})));
        let res = http::get(&router, "/my-skill").await;
        assert_eq!((res.status, res.json()), (404, json!({"error": "Skill not found"})));
    }

    #[tokio::test]
    async fn a_new_skill_needs_a_name_content_and_a_plain_name() {
        let (_t, router) = app();
        for body in [
            json!({"name": "x"}),
            json!({"content": "x"}),
            json!({"name": "", "content": "x"}),
        ] {
            let res = http::post_json(&router, "/", &body).await;
            assert_eq!(
                (res.status, res.json()),
                (400, json!({"error": "Name and content are required"}))
            );
        }
        for name in ["My-Skill", "-lead", "a_b", "a/b"] {
            let res = http::post_json(&router, "/", &json!({"name": name, "content": "x"})).await;
            assert_eq!(
                (res.status, res.json()),
                (
                    400,
                    json!({"error": "Invalid name. Use lowercase letters, numbers, and hyphens only."})
                ),
                "{name}"
            );
        }
        // No JSON body at all: the JS destructured undefined, which the error handler answered.
        let logs = crate::testkit::CapturedLogs::start();
        let res = http::send(&router, request("POST", "/")).await;
        assert_eq!(
            (res.status, res.json()),
            (
                500,
                json!({"error": "Internal server error",
                       "detail": "Cannot destructure property 'name' of 'req.body' as it is undefined."})
            )
        );
        assert_eq!(
            logs.errors(),
            ["[error] TypeError: Cannot destructure property 'name' of 'req.body' as it is undefined."]
        );
    }

    #[tokio::test]
    async fn the_fixed_paths_still_reach_a_skill_of_that_name() {
        let (t, router) = app();
        write_skill(&t, "setup", "---\nname: setup\ndescription: d\n---\nbody");
        let res = http::get(&router, "/setup").await;
        assert_eq!((res.status, res.json()["name"].clone()), (200, json!("setup")));
        let res = http::put_json(&router, "/setup", &json!({"content": "b2"})).await;
        assert_eq!(res.status, 200);
        let res = http::delete(&router, "/setup").await;
        assert_eq!(res.status, 200);
        assert_eq!(http::get(&router, "/install").await.status, 404);
    }

    /// Every way a request could name a folder outside the skills folders.
    fn names_that_are_not_one_plain_name(outside: &std::path::Path) -> Vec<String> {
        vec![
            outside.to_string_lossy().to_string(),
            "..".into(),
            ".".into(),
            "../escape".into(),
            "a/b".into(),
            "a\\b".into(),
        ]
    }

    #[tokio::test]
    async fn a_skill_name_that_is_a_path_reaches_nothing_outside_the_skills_folders() {
        let (t, router) = app();
        let outside = crate::testkit::tmp_dir();
        let victim = outside.path().join("victim");
        fs::create_dir_all(&victim).unwrap();
        fs::write(victim.join("SKILL.md"), "---\nname: victim\n---\nkeep me").unwrap();
        fs::write(t.path().join("escape"), "keep me too").unwrap();
        for name in names_that_are_not_one_plain_name(&victim) {
            let encoded: String = crate::lib::canvas::encode_uri_component(&name);
            // DELETE /:name answers as for a skill that does not exist.
            let res = http::delete(&router, &format!("/{encoded}")).await;
            assert_eq!(
                (res.status, res.json()),
                (404, json!({"error": "Skill not found"})),
                "{name}"
            );
            let res = http::put_json(&router, &format!("/{encoded}"), &json!({"content": "x"})).await;
            assert_eq!(
                (res.status, res.json()),
                (
                    404,
                    json!({"error": "Custom skill not found (built-in skills are read-only)"})
                ),
                "{name}"
            );
            let res = http::post_json(&router, "/install", &json!({"name": name})).await;
            assert_eq!(
                (res.status, res.json()),
                (400, json!({"error": format!("Skill \"{name}\" not found")})),
                "{name}"
            );
            let res = http::post_json(&router, "/uninstall", &json!({"name": name})).await;
            assert_eq!(
                (res.status, res.json()),
                (200, json!({"ok": true, "name": name, "installed": false})),
                "{name}"
            );
            let res = http::post_json(&router, "/setup", &json!({"install": [name]})).await;
            assert_eq!(res.json()["failed"], json!([name]), "{name}");
        }
        assert_eq!(
            fs::read_to_string(victim.join("SKILL.md")).unwrap(),
            "---\nname: victim\n---\nkeep me"
        );
        assert_eq!(fs::read_to_string(t.path().join("escape")).unwrap(), "keep me too");
        assert!(
            get_custom_skills_dir(&t).is_dir(),
            "the skills folder itself is still there"
        );
        assert!(t.config().bundled_skills_dir().join("diagram").is_dir());
        // `/setup` with "" no longer copies every shipped skill into the root of the skills folder.
        let res = http::post_json(&router, "/setup", &json!({"install": [""]})).await;
        assert_eq!(res.json()["failed"], json!([""]));
        assert!(!get_custom_skills_dir(&t).join("diagram").exists());
    }

    #[tokio::test]
    async fn a_skill_that_is_a_file_is_uninstalled_and_deleted() {
        let (t, router) = app();
        let loose = get_custom_skills_dir(&t).join("loose.md");
        fs::write(&loose, "x").unwrap();
        let res = http::post_json(&router, "/uninstall", &json!({"name": "loose.md"})).await;
        assert_eq!(
            (res.status, res.json()),
            (200, json!({"ok": true, "name": "loose.md", "installed": false}))
        );
        assert!(!loose.exists());
        fs::write(&loose, "x").unwrap();
        let res = http::delete(&router, "/loose.md").await;
        assert_eq!((res.status, res.json()), (200, json!({"ok": true})));
        assert!(!loose.exists());
    }

    #[tokio::test]
    async fn frontmatter_keys_come_back_in_javascript_object_order() {
        let (t, router) = app();
        write_skill(
            &t,
            "ordered",
            "---\nname: ordered\n2: two\n1: one\n__proto__: x\ndescription: d\n---\nbody",
        );
        let res = http::get(&router, "/ordered").await;
        // Checked against Node: number-like keys first, and no __proto__.
        assert_eq!(
            res.text(),
            r#"{"name":"ordered","description":"d","source":"installed","content":"body","frontmatter":{"1":"one","2":"two","name":"ordered","description":"d"}}"#
        );
    }

    #[tokio::test]
    async fn work_a_request_started_finishes_when_the_browser_leaves() {
        let (t, router) = app();
        let skills = get_custom_skills_dir(&t);

        start_then_leave(
            &t,
            &router,
            request("POST", "/install").json(&json!({"name": "diagram"})),
        )
        .await;
        wait_for("the install", || {
            get_all_skills_with_status(&t)
                .iter()
                .any(|s| s.name == "diagram" && s.installed)
        })
        .await;
        assert_eq!(
            fs::read_to_string(skills.join("diagram").join("SKILL.md")).unwrap(),
            fs::read_to_string(t.config().bundled_skills_dir().join("diagram").join("SKILL.md")).unwrap(),
            "copied whole"
        );

        let create = request("POST", "/").json(&json!({"name": "mine", "content": "body"}));
        start_then_leave(&t, &router, create).await;
        wait_for("the new skill", || scan_skills(&t).iter().any(|s| s.name == "mine")).await;

        let put = request("PUT", "/mine").json(&json!({"content": "changed"}));
        start_then_leave(&t, &router, put).await;
        wait_for("the update", || {
            get_skill_content(&t, "mine").is_some_and(|s| s.content == "\nchanged")
        })
        .await;

        start_then_leave(&t, &router, request("DELETE", "/mine")).await;
        wait_for("the delete", || {
            !skills.join("mine").exists() && scan_skills(&t).iter().all(|s| s.name != "mine")
        })
        .await;

        start_then_leave(
            &t,
            &router,
            request("POST", "/uninstall").json(&json!({"name": "diagram"})),
        )
        .await;
        wait_for("the uninstall", || {
            !skills.join("diagram").exists() && scan_skills(&t).iter().all(|s| s.name != "diagram")
        })
        .await;
    }

    #[tokio::test]
    async fn a_name_means_what_it_says_dots_spaces_and_device_names_included() {
        let (t, router) = app();
        let skills = get_custom_skills_dir(&t);
        for folder in ["a", "b"] {
            write_skill(&t, folder, &format!("---\nname: {folder}\n---\nkeep"));
        }
        install_skill(&t, "diagram").unwrap();
        // On Windows `a.` and `b ` would open `a` and `b`, `...` the skills folder itself, `nul` a device.
        for name in ["a.", "b ", "...", "nul"] {
            let encoded = crate::lib::canvas::encode_uri_component(name);
            let res = http::delete(&router, &format!("/{encoded}")).await;
            assert_eq!(
                (res.status, res.json()),
                (404, json!({"error": "Skill not found"})),
                "{name:?}"
            );
            let res = http::put_json(&router, &format!("/{encoded}"), &json!({"content": "x"})).await;
            assert_eq!(res.status, 404, "{name:?}");
        }
        let res = http::post_json(&router, "/install", &json!({"name": "diagram."})).await;
        assert_eq!(
            (res.status, res.json()),
            (400, json!({"error": "Skill \"diagram.\" not found"}))
        );
        let res = http::post_json(&router, "/uninstall", &json!({"name": "diagram."})).await;
        assert_eq!(res.status, 200);
        for (folder, text) in [("a", "keep"), ("b", "keep")] {
            assert!(
                fs::read_to_string(skills.join(folder).join("SKILL.md"))
                    .unwrap()
                    .ends_with(text),
                "{folder}"
            );
        }
        assert!(
            skills.join("diagram").join("SKILL.md").is_file(),
            "`diagram.` is not `diagram`"
        );

        // A skill may be named `nul`: it is a folder of that name, as Node made it.
        let res = http::post_json(&router, "/", &json!({"name": "nul", "content": "device-free"})).await;
        assert_eq!(res.status, 201);
        assert!(to_namespaced(&skills.join("nul").join("SKILL.md")).is_file());
        assert_eq!(http::get(&router, "/nul").await.json()["content"], "\ndevice-free");
        let res = http::delete(&router, "/nul").await;
        assert_eq!(res.status, 200);
        assert!(!to_namespaced(&skills.join("nul")).exists());
    }

    #[test]
    fn a_body_is_parsed_only_when_it_says_json() {
        let mut headers = HeaderMap::new();
        assert_eq!(express_json_body(&headers, b"{\"a\":1}").unwrap(), None);
        headers.insert(header::CONTENT_TYPE, "application/json; charset=utf-8".parse().unwrap());
        assert_eq!(express_json_body(&headers, b"").unwrap(), Some(json!({})));
        assert_eq!(express_json_body(&headers, b" [1]").unwrap(), Some(json!([1])));
        assert_eq!(
            express_json_body(&headers, b"\"x\"").unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            express_json_body(&headers, b"{oops").unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
    }
}
