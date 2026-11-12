//! Port of `src/routes/voice.js`: the voice routes, mounted at `/api/voice` behind sign-in and the CSRF check in
//! `server.rs`. Speech-to-text (Settings > Voice > Speech-to-text, and transcribing), Piper voices, Phonon, the engine
//! in use, text-to-speech and voice cloning.
//!
//! The Node router read the settings store from the Express app (`req.app.get("settingsStore")`); here it is the app
//! service `Arc<dyn Settings>` ([`settings_store`]). Uploads were parsed with busboy; here axum's multipart reader does
//! it, with the same field names, the same per-file limits, busboy's rule for what is a file and its 1 MB limit on a
//! field, and the same error answers.
//!
//! Express ran a handler to its end even when the client had gone; axum drops it at its next pause. So once a request
//! has been read, whatever it sets going (a sentence, a transcription, a clone, an install, a file written or removed)
//! runs in a task of its own ([`to_the_end`]), and the services it calls clean up after themselves the same way.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, DefaultBodyLimit, FromRequest, Multipart, RawQuery, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use futures::StreamExt;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::app::App;
use crate::config::constants::limits;
use crate::db::settings::{Settings, get_api_key};
use crate::error::{ApiError, ApiResult};
use crate::routes::skills::{express_json_body, unhandled_error};
use crate::util::js::{trim, truthy, utf16_len};
use crate::voice::clone_handler::{clone_voice, list_voice_profiles};
use crate::voice::engine_registry::{InitOptions, can_warm, get_tts_engine, init_tts_engine};
use crate::voice::phonon_engine::{
    DEFAULT_SPEED, DEFAULT_VOICE, SPEED_MAX, SPEED_MIN, VOICES, clamp_speed, clamp_speed_value, find_voice_value,
    js_string_or_empty, reset_phonon_availability,
};
use crate::voice::phonon_install::{InstallOptions, check_phonon_install, get_phonon_install_status, install_phonon};
use crate::voice::piper_engine::{delete_piper_voice, list_piper_voices, save_piper_voice};
use crate::voice::stt_handler::{SttError, SttResult, get_stt_models, stop_stt_worker, transcribe_audio, warm_stt};
use crate::voice::stt_install::{
    SttJobError, chosen_model, find_stt_model, get_stt_status, remove_stt_model, reset_stt_runtime,
    start_model_download, start_stt_install,
};
use crate::voice::tts_interface::{ClonedVoice, SynthOptions, TtsError, is_plain_name};
use crate::voice::whisper_models::WHISPER_MODEL_NAMES;

/// The settings store, where `server.rs` keeps it in the app (the Node `app.set("settingsStore", store)`): the
/// service `Arc<dyn Settings>`.
pub fn settings_store(app: &App) -> Option<Arc<dyn Settings>> {
    app.get::<Arc<dyn Settings>>().map(|s| (*s).clone())
}

pub fn router() -> Router<App> {
    let limiter = Arc::new(Limiter::new(Limits::default()));
    stt_routes(Router::new(), "/stt", limiter)
        .route("/stt-models", get(stt_models))
        .route("/stt-model", post(choose_stt_model))
        .route("/piper-voices", get(piper_voices))
        .route("/piper-upload", post(piper_upload))
        .route("/piper-voices/{id}", delete(remove_piper_voice))
        .route("/phonon", get(phonon))
        .route("/phonon/install", post(phonon_install))
        .route("/warm", post(warm))
        .route("/status", get(status))
        .route("/voices", get(voices))
        .route("/tts", post(tts))
        .route("/tts-stream", post(tts_stream))
        .route("/transcribe", post(transcribe))
        .route("/clone", post(clone))
        // busboy had no limit on the whole body, only on each file and field: the limits are applied where the body
        // is read.
        .layer(DefaultBodyLimit::disable())
}

/// Runs the rest of a request to its end in a task of its own, as Express ran a handler to its end even after the
/// client had gone: what it does to a worker, a file or the database happens either way.
async fn to_the_end(work: impl std::future::Future<Output = Response> + Send + 'static) -> Response {
    tokio::spawn(work)
        .await
        .unwrap_or_else(|err| ApiError::internal(format!("the request stopped ({err})")).into_response())
}

/// `decodeURIComponent(text)`: `%` and two hex digits, making UTF-8; anything else is an error.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            // `from_str_radix` would also take a sign ("%+1").
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A path parameter as Express gave it: the request path's piece `from_end` places from the end (0: the last),
/// decoded with `decodeURIComponent`. A piece that does not decode is the 400 Express's router answered.
fn path_param(uri: &Uri, from_end: usize) -> Result<String, ApiError> {
    let raw = uri.path().rsplit('/').nth(from_end).unwrap_or("");
    decode_uri_component(raw).ok_or_else(|| ApiError::bad_request(format!("Failed to decode param '{raw}'")))
}

// ── Speech-to-text: Settings > Voice > Speech-to-text ────────────────────

// Who may install: the owner, as for every Settings route. server.rs mounts /api/voice behind requireAuth (the owner's
// sign-in, or the owner's API token, which the dashboard itself sends) and CSRF (for a browser session). The
// installer's routes are also rate-limited, and run one job at a time (stt_install).

/// How many installer actions an address may start: `max` per `window`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max: usize,
    pub window: Duration,
}

impl Default for Limits {
    /// 20 per 10 minutes.
    fn default() -> Self {
        Limits {
            max: 20,
            window: Duration::from_secs(10 * 60),
        }
    }
}

/// A per-address sliding-window limit on starting installer jobs.
struct Limiter {
    limits: Limits,
    hits: Mutex<HashMap<String, Vec<Instant>>>,
}

impl Limiter {
    fn new(limits: Limits) -> Self {
        Limiter {
            limits,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Counts this try; a 429 that says how long to wait when the address is over its limit.
    fn check(&self, key: &str) -> Option<Response> {
        let t = Instant::now();
        let window = self.limits.window;
        let mut hits = self.hits.lock();
        let mut recent: Vec<Instant> = hits
            .get(key)
            .map(|at| at.iter().copied().filter(|at| t.duration_since(*at) < window).collect())
            .unwrap_or_default();
        if recent.len() >= self.limits.max {
            let left = (recent[0] + window).saturating_duration_since(t).as_millis();
            let retry = left.div_ceil(1000).max(1);
            hits.insert(key.to_string(), recent);
            let mut res = ApiError::too_many_requests(format!("Too many tries. Wait {retry} seconds, then try again."))
                .into_response();
            if let Ok(value) = HeaderValue::from_str(&retry.to_string()) {
                res.headers_mut().insert(header::RETRY_AFTER, value);
            }
            return Some(res);
        }
        recent.push(t);
        hits.insert(key.to_string(), recent);
        if hits.len() > 1000 {
            hits.retain(|_, v| v.last().is_some_and(|last| t.duration_since(*last) < window));
        }
        None
    }
}

/// Who is asking, as Express's `req.ip` saw it with "trust proxy" set to one hop: the address the proxy in front saw
/// (the last X-Forwarded-For entry), else the connection's own address.
fn client_key(req: &Request) -> String {
    let forwarded = req
        .headers()
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|v| trim(v).to_string())
        .rfind(|v| !v.is_empty());
    if let Some(ip) = forwarded {
        return ip;
    }
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip().to_string())
        .unwrap_or_else(|| "?".into())
}

fn send_job_error(err: SttJobError) -> Response {
    let status = err
        .status
        .unwrap_or(if err.code.as_deref() == Some("BUSY") { 409 } else { 500 });
    ApiError::with_body(status, json!({ "error": err.message, "code": err.code })).into_response()
}

/// /api/voice/stt/...: the status, Install faster-whisper, a model's Download and Delete, and warming the worker.
/// `limits`: how many installer actions an address may start (default 20 per 10 minutes).
pub fn create_stt_router(limits: Limits) -> Router<App> {
    stt_routes(Router::new(), "", Arc::new(Limiter::new(limits))).layer(DefaultBodyLimit::disable())
}

/// The speech-to-text routes under `base` ("" when mounted on their own). Under `/stt` itself, `POST` is the raw
/// transcription route (Express reached it once the nested router had no `POST /`).
fn stt_routes(router: Router<App>, base: &str, limiter: Arc<Limiter>) -> Router<App> {
    let at = |path: &str| format!("{base}{path}");
    let status = get(stt_status);
    let status = if base.is_empty() { status } else { status.post(raw_stt) };
    let (l1, l2, l3) = (limiter.clone(), limiter.clone(), limiter);
    router
        .route(if base.is_empty() { "/" } else { base }, status)
        .route(
            &at("/install"),
            post(move |state: State<App>, req: Request| {
                let l = l1.clone();
                async move { stt_install(state, l, req).await }
            }),
        )
        .route(
            &at("/models/{name}/download"),
            post(move |state: State<App>, req: Request| {
                let l = l2.clone();
                async move { model_download(state, l, req).await }
            }),
        )
        .route(
            &at("/models/{name}"),
            delete(move |state: State<App>, req: Request| {
                let l = l3.clone();
                async move { model_delete(state, l, req).await }
            }),
        )
        .route(&at("/warm"), post(stt_warm))
}

/// `req.query[name] === "1"`: the parameter given once, with that value.
fn query_value(query: Option<&str>, name: &str) -> Option<String> {
    let values: Vec<String> = url::form_urlencoded::parse(query.unwrap_or("").as_bytes())
        .filter(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
        .collect();
    match values.as_slice() {
        [one] => Some(one.clone()),
        _ => None,
    }
}

/// GET /api/voice/stt[?refresh=1]: everything Settings shows (`stt_install::get_stt_status`).
async fn stt_status(State(app): State<App>, RawQuery(query): RawQuery) -> Response {
    let refresh = query_value(query.as_deref(), "refresh").as_deref() == Some("1");
    let store = settings_store(&app);
    Json(get_stt_status(&app, refresh, store.as_deref()).await).into_response()
}

/// POST /api/voice/stt/install: Install (or Try again) faster-whisper in the background; GET reports progress.
async fn stt_install(State(app): State<App>, limiter: Arc<Limiter>, req: Request) -> Response {
    if let Some(res) = limiter.check(&client_key(&req)) {
        return res;
    }
    match start_stt_install(&app, Default::default()) {
        Ok(started) => {
            // The worker picks up the new Python on the next recording.
            let (done, after) = (started.done, app.clone());
            tokio::spawn(async move {
                done.wait().await;
                stop_stt_worker(&after);
                reset_stt_runtime(&after);
            });
            (StatusCode::ACCEPTED, Json(json!({ "job": started.job }))).into_response()
        }
        Err(err) => send_job_error(err),
    }
}

/// POST /api/voice/stt/models/:name/download: download one model in the background.
async fn model_download(State(app): State<App>, limiter: Arc<Limiter>, req: Request) -> Response {
    if let Some(res) = limiter.check(&client_key(&req)) {
        return res;
    }
    let name = match path_param(req.uri(), 1) {
        Ok(name) => name,
        Err(err) => return err.into_response(),
    };
    match start_model_download(&app, &name, Default::default()) {
        Ok(started) => (StatusCode::ACCEPTED, Json(json!({ "job": started.job }))).into_response(),
        Err(err) => send_job_error(err),
    }
}

/// DELETE /api/voice/stt/models/:name: delete a downloaded model (never the one that comes with the image).
async fn model_delete(State(app): State<App>, limiter: Arc<Limiter>, req: Request) -> Response {
    if let Some(res) = limiter.check(&client_key(&req)) {
        return res;
    }
    let name = match path_param(req.uri(), 0) {
        Ok(name) => name,
        Err(err) => return err.into_response(),
    };
    // It may have the model open (Windows won't delete an open file).
    stop_stt_worker(&app);
    // A model is hundreds of MB: removed off the async runtime, and to its end whoever is still waiting.
    let removed = tokio::task::spawn_blocking(move || remove_stt_model(&app, &name)).await;
    match removed {
        Ok(Ok(deleted)) => Json(json!({
            "removed": deleted.removed.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
            "kept": deleted.kept.map(|p| p.to_string_lossy().into_owned()),
        }))
        .into_response(),
        Ok(Err(err)) => send_job_error(err),
        Err(err) => ApiError::internal(err.to_string()).into_response(),
    }
}

/// POST /api/voice/stt/warm: load faster-whisper and the model now (a call opening). `{ ok, model }` or
/// `{ ok: false, error }`.
async fn stt_warm(State(app): State<App>) -> Response {
    to_the_end(async move {
        let store = settings_store(&app);
        Json(warm_stt(&app, store.as_deref()).await).into_response()
    })
    .await
}

/// GET /api/voice/stt-models: the STT models: each one's size, whether it is downloaded, and where (GET
/// /api/voice/stt has everything).
async fn stt_models(State(app): State<App>) -> Json<Value> {
    let store = settings_store(&app);
    Json(json!({
        "models": get_stt_models(&app, store.as_deref()),
        "current": chosen_model(&app, store.as_deref()),
    }))
}

/// Reads a whole body, up to `max` bytes; `None` when it is longer.
async fn read_body(body: Body, max: usize) -> Result<Option<Bytes>, ApiError> {
    let mut stream = body.into_data_stream();
    let mut all: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| ApiError::bad_request(err.to_string()))?;
        if all.len().saturating_add(chunk.len()) > max {
            return Ok(None);
        }
        all.extend_from_slice(&chunk);
    }
    Ok(Some(Bytes::from(all)))
}

/// Reads a body to its end and keeps none of it.
async fn drain(body: Body) -> Result<(), ApiError> {
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        chunk.map_err(|err| ApiError::bad_request(err.to_string()))?;
    }
    Ok(())
}

/// The JSON body as `express.json()` gave it (`req.body || {}`).
async fn json_body(headers: &HeaderMap, body: Body) -> Result<Value, ApiError> {
    let Some(bytes) = read_body(body, limits::JSON_BODY_MAX_BYTES).await? else {
        return Err(ApiError::new(413, "request entity too large"));
    };
    Ok(express_json_body(headers, &bytes)?
        .filter(truthy)
        .unwrap_or_else(|| json!({})))
}

/// A body read as raw audio, up to the voice sample limit. A JSON body is what the server's `express.json()` took
/// before the route read anything: it is parsed (and refused when it is not JSON) and leaves no audio at all.
async fn raw_audio(headers: &HeaderMap, body: Body, too_large: &str) -> Result<Bytes, ApiError> {
    if express_json_body(headers, b"{}")?.is_some() {
        json_body(headers, body).await?;
        return Ok(Bytes::new());
    }
    match read_body(body, limits::VOICE_SAMPLE_MAX_BYTES).await? {
        Some(audio) => Ok(audio),
        None => Err(ApiError::new(413, too_large)),
    }
}

/// POST /api/voice/stt-model: choose the STT model. One that isn't on disk yet starts downloading
/// (`{ downloading: true }`), unless another download or install is running (its row in Settings then has a Download
/// button).
async fn choose_stt_model(State(app): State<App>, headers: HeaderMap, body: Body) -> ApiResult {
    let body = json_body(&headers, body).await?;
    let model = match body.get("model") {
        Some(Value::String(m)) if WHISPER_MODEL_NAMES.contains(m) => m.clone(),
        _ => {
            return Err(ApiError::bad_request(format!(
                "Invalid model. Valid: {}",
                WHISPER_MODEL_NAMES.join(", ")
            )));
        }
    };
    let Some(store) = settings_store(&app) else {
        return Err(unhandled_error(
            &app,
            "Cannot read properties of undefined (reading 'set')",
        ));
    };
    store
        .set("voice.stt_model", json!(model))
        .map_err(|err| unhandled_error(&app, &err.to_string()))?;
    let mut downloading = false;
    if find_stt_model(&app, &model).is_none() {
        // Another job is running: Download is on the model's row.
        downloading = start_model_download(&app, &model, Default::default()).is_ok();
    }
    Ok(Json(json!({ "ok": true, "model": model, "downloading": downloading })))
}

// ── Piper voices ─────────────────────────────────────────────────────────

/// GET /api/voice/piper-voices: list uploaded Piper voice models.
async fn piper_voices(State(app): State<App>) -> Json<Value> {
    Json(json!({ "voices": list_piper_voices(app.env()) }))
}

/// busboy's limit on a field's value: what is past it is dropped.
const FIELD_SIZE: usize = 1024 * 1024;

/// The files and fields of a form that a route asked for, the last of a name winning.
struct Form {
    files: HashMap<String, Bytes>,
    fields: HashMap<String, String>,
}

/// How a form is read: which files and fields are kept, the most a file may hold, and what is said when one is
/// larger.
struct FormRules<'a> {
    files: &'a [&'a str],
    fields: &'a [&'a str],
    /// The limit applies to every file (busboy's limit listener was on each one), not only the kept ones.
    limit_all: bool,
    max_file: usize,
    too_large: &'a str,
}

/// The media type of a Content-Type, in lower case, without its parameters.
fn media_type(content_type: &str) -> String {
    trim(content_type.split(';').next().unwrap_or("")).to_ascii_lowercase()
}

/// Reads a form the way the busboy code did. A part is a file when it has a file name that is not empty, or when its
/// own Content-Type is application/octet-stream (busboy's rule); any other part is a field, and a field keeps its
/// first 1 MB. Only what `rules` asks for is kept; the rest is read and dropped. A request that is not a form fails
/// with busboy's words.
async fn read_form(app: &App, req: Request, rules: FormRules<'_>) -> Result<Form, ApiError> {
    let content_type = req
        .headers()
        .get(header::CONTENT_TYPE)
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
    let Some(content_type) = content_type else {
        return Err(ApiError::internal("Missing Content-Type"));
    };
    let media = media_type(&content_type);
    let mut form = Form {
        files: HashMap::new(),
        fields: HashMap::new(),
    };
    if media == "application/x-www-form-urlencoded" {
        // A form with no files: read to its end, as busboy did, then nothing in it is a file a route wants.
        drain(req.into_body()).await?;
        return Ok(form);
    }
    if media != "multipart/form-data" {
        return Err(ApiError::internal(format!("Unsupported content type: {content_type}")));
    }
    let mut multipart = Multipart::from_request(req, app)
        .await
        .map_err(|_| ApiError::internal("Multipart: Boundary not found"))?;
    let broken = |err: axum::extract::multipart::MultipartError| ApiError::internal(err.body_text());
    while let Some(mut field) = multipart.next_field().await.map_err(broken)? {
        let name = field.name().unwrap_or("").to_string();
        let octet_stream = field
            .content_type()
            .is_some_and(|t| media_type(t) == "application/octet-stream");
        let is_file = field.file_name().is_some_and(|n| !n.is_empty()) || octet_stream;
        let (keep, limit) = if is_file {
            let keep = rules.files.contains(&name.as_str());
            (keep, (keep || rules.limit_all).then_some(rules.max_file))
        } else {
            (rules.fields.contains(&name.as_str()), None)
        };
        let mut data: Vec<u8> = Vec::new();
        let mut size: usize = 0;
        while let Some(chunk) = field.chunk().await.map_err(broken)? {
            size = size.saturating_add(chunk.len());
            if limit.is_some_and(|max| size > max) {
                return Err(ApiError::new(413, rules.too_large));
            }
            if keep {
                let room = if is_file {
                    chunk.len()
                } else {
                    FIELD_SIZE.saturating_sub(data.len()).min(chunk.len())
                };
                data.extend_from_slice(&chunk[..room]);
            }
        }
        if !keep {
            continue;
        }
        if is_file {
            form.files.insert(name, Bytes::from(data));
        } else {
            form.fields.insert(name, String::from_utf8_lossy(&data).into_owned());
        }
    }
    Ok(form)
}

/// POST /api/voice/piper-upload: upload a Piper voice model (.onnx + .onnx.json pair). Multipart form: 'onnx' file +
/// 'json' file + 'name' field.
async fn piper_upload(State(app): State<App>, req: Request) -> Response {
    let rules = FormRules {
        files: &["onnx", "json"],
        fields: &["name"],
        limit_all: true,
        // 200MB max
        max_file: 200 * 1024 * 1024,
        too_large: "File too large (max 200MB)",
    };
    let mut form = match read_form(&app, req, rules).await {
        Ok(form) => form,
        Err(err) => return err.into_response(),
    };
    let name = form
        .fields
        .get("name")
        .map(|v| trim(v).to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "custom-voice".into());
    let Some(onnx) = form.files.remove("onnx") else {
        return ApiError::bad_request("Missing .onnx file (field: 'onnx')").into_response();
    };
    let Some(json_file) = form.files.remove("json") else {
        return ApiError::bad_request("Missing .onnx.json file (field: 'json')").into_response();
    };
    // Up to 200 MB written: off the async runtime, and to its end whoever is still waiting.
    let env = app.env().clone();
    let saved = tokio::task::spawn_blocking(move || save_piper_voice(&env, &onnx, &json_file, &name)).await;
    match saved {
        Ok(Ok(saved)) => (StatusCode::CREATED, Json(json!(saved))).into_response(),
        Ok(Err(err)) => ApiError::internal(err.to_string()).into_response(),
        Err(err) => ApiError::internal(err.to_string()).into_response(),
    }
}

/// DELETE /api/voice/piper-voices/:id: delete a Piper voice model.
async fn remove_piper_voice(State(app): State<App>, uri: Uri) -> ApiResult {
    let id = path_param(&uri, 0)?;
    // Node joined the id unchecked ("../x" deleted outside the voices folder): only one plain name is taken.
    if !is_plain_name(&id) {
        return Err(ApiError::bad_request("Invalid voice id"));
    }
    let env = app.env().clone();
    let _ = tokio::task::spawn_blocking(move || delete_piper_voice(&env, &id)).await;
    Ok(Json(json!({ "ok": true })))
}

// ── Phonon ───────────────────────────────────────────────────────────────

/// A number as `JSON.stringify` writes it: 1, not 1.0.
fn json_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// GET /api/voice/phonon: Phonon's own settings for Settings -> Voice: its voices, the chosen voice and speed, the
/// bare-"P" peso option, and the install status (with progress while downloading).
async fn phonon(State(app): State<App>) -> Json<Value> {
    let store = settings_store(&app);
    let get = |key: &str| store.as_ref().and_then(|s| s.get(key));
    let bare_peso = get("voice.phonon.barePeso");
    let speed = match get("voice.phonon.speed") {
        None | Some(Value::Null) => clamp_speed(DEFAULT_SPEED),
        Some(v) => clamp_speed_value(&v),
    };
    Json(json!({
        "install": check_phonon_install(&app).await,
        "active": get_tts_engine(&app).name() == "phonon",
        "voices": VOICES,
        "voice": find_voice_value(get("voice.phonon.voice").as_ref()).map(|v| v.id).unwrap_or(DEFAULT_VOICE),
        "speed": json_number(speed),
        "speedMin": SPEED_MIN,
        "speedMax": SPEED_MAX,
        "barePeso": matches!(bare_peso, Some(Value::Bool(true))) || bare_peso.as_ref().and_then(Value::as_str) == Some("true"),
    }))
}

/// POST /api/voice/phonon/install: start (or retry) the Phonon download in the background and return the status at
/// once; GET /api/voice/phonon reports progress. When it finishes, the TTS engine is re-initialised so Phonon takes
/// over from Edge TTS. On a computer with no usable Python, the owner's click (a browser session) also downloads
/// Tarsee's own Python, the one speech-to-text uses too.
async fn phonon_install(State(app): State<App>) -> Response {
    to_the_end(async move {
        // Re-check the runtime rather than trust an old answer.
        reset_phonon_availability(&app);
        let status = check_phonon_install(&app).await;
        if status.state == "installed" || status.state == "installing" {
            return Json(status).into_response();
        }
        let store = settings_store(&app);
        let after = app.downgrade();
        let opts = InstallOptions {
            on_installed: Some(Arc::new(move || {
                let (after, store) = (after.clone(), store.clone());
                Box::pin(async move {
                    if let Some(app) = after.upgrade() {
                        init_tts_engine(&app, store, InitOptions::default()).await;
                    }
                    Ok(())
                })
            })),
            allow_python_download: true,
            ..Default::default()
        };
        let run = install_phonon(&app, opts);
        tokio::spawn(async move {
            if let Err(err) = run.await {
                log::warn!("[phonon] install failed: {}", err.message);
            }
        });
        (StatusCode::ACCEPTED, Json(get_phonon_install_status(&app))).into_response()
    })
    .await
}

// ── The engine ───────────────────────────────────────────────────────────

/// POST /api/voice/warm: start a local engine's worker ahead of the first reply (voice mode opening). A no-op for
/// engines without one.
async fn warm(State(app): State<App>) -> Response {
    to_the_end(async move {
        let engine = get_tts_engine(&app);
        if !can_warm(&engine) {
            return Json(json!({ "ok": true, "engine": engine.name(), "warmed": false })).into_response();
        }
        match engine.warm().await {
            Ok(()) => Json(json!({ "ok": true, "engine": engine.name(), "warmed": true })),
            Err(err) => Json(json!({ "ok": false, "engine": engine.name(), "error": err.message })),
        }
        .into_response()
    })
    .await
}

/// GET /api/voice/status: check voice engine status.
async fn status(State(app): State<App>) -> ApiResult {
    let engine = get_tts_engine(&app);
    let available = engine.is_available().await;
    let voices = engine
        .list_voices()
        .await
        .map_err(|err| unhandled_error(&app, &err.message))?;
    let store = settings_store(&app);
    // `!!sStore?.getApiKey?.("openai")`: no store, no key.
    let key = store.as_deref().and_then(|s| get_api_key(s, app.env(), "openai"));
    let whisper = if key.is_some() { "key set" } else { "no key" };
    Ok(Json(json!({
        "tts": { "engine": engine.name(), "available": available },
        "stt": { "whisper": whisper },
        "voices": voices,
    })))
}

/// GET /api/voice/voices: list available voices (built-in + cloned).
async fn voices(State(app): State<App>) -> ApiResult {
    let engine = get_tts_engine(&app);
    let built_in = engine
        .list_voices()
        .await
        .map_err(|err| unhandled_error(&app, &err.message))?;
    let cloned = list_voice_profiles(app.db()).map_err(|err| unhandled_error(&app, &err.to_string()))?;
    let mut all: Vec<Value> = built_in.iter().map(|v| json!(v)).collect();
    all.extend(
        cloned
            .into_iter()
            .map(|v| json!({ "id": v.id, "name": v.name, "isClone": true, "engine": v.engine })),
    );
    Ok(Json(json!({ "voices": all })))
}

/// `voiceId` from a request body: text when it is set (a JS truthy value).
fn voice_id_of(body: &Value) -> Option<String> {
    let text = js_string_or_empty(body.get("voiceId"));
    (!text.is_empty()).then_some(text)
}

fn audio_response(audio: Bytes, content_type: &str) -> Response {
    let content_type = if content_type.is_empty() {
        "audio/wav"
    } else {
        content_type
    };
    let length = audio.len().to_string();
    let mut res = audio.into_response();
    let headers = res.headers_mut();
    if let Ok(value) = HeaderValue::from_str(content_type) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    if let Ok(value) = HeaderValue::from_str(&length) {
        headers.insert(header::CONTENT_LENGTH, value);
    }
    res
}

/// POST /api/voice/tts: text-to-speech. Returns audio. Body: `{ text: string, voiceId?: string }`.
async fn tts(State(app): State<App>, headers: HeaderMap, body: Body) -> Response {
    let body = match json_body(&headers, body).await {
        Ok(body) => body,
        Err(err) => return err.into_response(),
    };
    let text = match body.get("text") {
        Some(Value::String(t)) if !t.is_empty() => t.clone(),
        _ => return ApiError::bad_request("Text is required").into_response(),
    };
    let length = utf16_len(&text);
    if length > 5000 {
        return ApiError::bad_request("Text too long (max 5000 characters)").into_response();
    }
    let voice_id = voice_id_of(&body);

    to_the_end(async move {
        let mut engine = get_tts_engine(&app);
        // If engine is still stub, try to re-init (key may have been added after startup)
        if engine.name() == "stub" {
            log::info!("[tts] engine is stub, attempting re-init...");
            init_tts_engine(&app, settings_store(&app), InitOptions::default()).await;
            engine = get_tts_engine(&app);
            log::info!("[tts] after re-init: engine={}", engine.name());
        }
        if engine.name() == "stub" {
            return ApiError::new(
                501,
                "No TTS engine available. Add your ElevenLabs API key in Settings > Voice, or select Edge TTS (free).",
            )
            .into_response();
        }

        log::info!(
            "[tts] engine={}, voiceId={}, textLen={length}",
            engine.name(),
            voice_id.as_deref().unwrap_or("default")
        );
        match engine
            .synthesize(&text, voice_id.as_deref(), &SynthOptions::default())
            .await
        {
            Ok(out) => audio_response(out.audio, &out.content_type),
            Err(err) => {
                log::error!("[tts] error: {}", err.message);
                ApiError::new(err.status.unwrap_or(500), err.message).into_response()
            }
        }
    })
    .await
}

/// POST /api/voice/tts-stream: streaming TTS: returns audio as it's generated for lower latency.
async fn tts_stream(State(app): State<App>, headers: HeaderMap, body: Body) -> Response {
    let body = match json_body(&headers, body).await {
        Ok(body) => body,
        Err(err) => return err.into_response(),
    };
    // Only `!text` was checked: the engine was handed whatever value came.
    let given = body.get("text").cloned().unwrap_or(Value::Null);
    if !truthy(&given) {
        return ApiError::bad_request("Text is required").into_response();
    }
    let voice_id = voice_id_of(&body);

    to_the_end(async move {
        let mut engine = get_tts_engine(&app);
        // Re-init if engine is stub (key may have been added after startup)
        if engine.name() == "stub" {
            init_tts_engine(&app, settings_store(&app), InitOptions::default()).await;
            engine = get_tts_engine(&app);
        }
        let failed = |message: String| {
            log::error!("[tts-stream] error: {message}");
            ApiError::internal(message).into_response()
        };
        // Phonon (and anything else) read a value that is not text as `String(value)`; Edge TTS's and Piper's first
        // step on it was a string method, which threw.
        let text = match &given {
            Value::String(text) => text.clone(),
            _ if matches!(engine.name(), "edge-tts" | "piper") => {
                return failed("text.replace is not a function".into());
            }
            other => js_string_or_empty(Some(other)),
        };

        if !engine.can_stream() {
            // Fallback to non-streaming
            return match engine
                .synthesize(&text, voice_id.as_deref(), &SynthOptions::default())
                .await
            {
                Ok(out) => audio_response(out.audio, &out.content_type),
                Err(err) => failed(err.message),
            };
        }
        match engine.synthesize_stream(&text, voice_id.as_deref()).await {
            Ok(audio) => {
                let stream = audio
                    .stream
                    .map(|chunk| chunk.map_err(|err| std::io::Error::other(err.to_string())));
                let mut res = Body::from_stream(stream).into_response();
                let headers = res.headers_mut();
                if let Ok(value) = HeaderValue::from_str(&audio.content_type) {
                    headers.insert(header::CONTENT_TYPE, value);
                }
                headers.insert(header::TRANSFER_ENCODING, HeaderValue::from_static("chunked"));
                res
            }
            Err(err) => failed(err.message),
        }
    })
    .await
}

// ── Speech-to-text ───────────────────────────────────────────────────────

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn stt_answer(result: Result<SttResult, SttError>) -> Response {
    match result {
        Ok(r) => Json(json!({ "text": r.transcript, "language": r.language, "provider": r.provider })).into_response(),
        Err(err) => ApiError::new(err.status.unwrap_or(500), err.message).into_response(),
    }
}

/// Transcribes in a task of its own: the recording is written, transcribed and removed whoever is still waiting.
async fn transcribe_to_the_end(app: App, audio: Bytes, language: String) -> Response {
    to_the_end(async move {
        let store = settings_store(&app);
        stt_answer(transcribe_audio(&app, &audio, Some(&language), store.as_deref()).await)
    })
    .await
}

/// POST /api/voice/stt: speech-to-text (server-side fallback). Expects raw audio in request body.
async fn raw_stt(State(app): State<App>, headers: HeaderMap, body: Body) -> Response {
    let audio = match raw_audio(&headers, body, "Audio too large").await {
        Ok(audio) => audio,
        Err(err) => return err.into_response(),
    };
    let language = header_text(&headers, "x-language").unwrap_or_else(|| "en-US".into());
    transcribe_to_the_end(app, audio, language).await
}

fn content_type(req: &Request) -> String {
    req.headers()
        .get(header::CONTENT_TYPE)
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .unwrap_or_default()
}

/// POST /api/voice/transcribe: transcribe audio with the chosen speech-to-text (multipart form with an 'audio' file,
/// or the audio as the body). Returns `{ text, language, provider }`.
async fn transcribe(State(app): State<App>, req: Request) -> Response {
    let headers = req.headers().clone();
    let audio = if content_type(&req).contains("multipart/form-data") {
        let rules = FormRules {
            files: &["audio"],
            fields: &[],
            limit_all: false,
            max_file: limits::VOICE_SAMPLE_MAX_BYTES,
            too_large: "Audio too large",
        };
        match read_form(&app, req, rules).await {
            Ok(mut form) => match form.files.remove("audio") {
                Some(audio) => audio,
                None => return ApiError::bad_request("No audio file provided").into_response(),
            },
            Err(err) => return err.into_response(),
        }
    } else {
        // Raw body fallback
        match raw_audio(&headers, req.into_body(), "Audio too large").await {
            Ok(audio) => audio,
            Err(err) => return err.into_response(),
        }
    };
    if audio.is_empty() {
        return ApiError::bad_request("Empty audio").into_response();
    }

    // Speech-to-text as chosen in Settings > Voice: local faster-whisper, or the paid OpenAI Whisper API only when
    // chosen. When nothing can transcribe, the error's status and message say why and what to change.
    let language = header_text(&headers, "x-language").unwrap_or_else(|| "en".into());
    transcribe_to_the_end(app, audio, language).await
}

// ── Voice cloning ────────────────────────────────────────────────────────

const SAMPLE_TOO_LARGE: &str = "Audio sample too large (max 25MB)";

fn cloned_answer(result: Result<ClonedVoice, TtsError>) -> Response {
    match result {
        Ok(made) => (StatusCode::CREATED, Json(json!(made))).into_response(),
        Err(err) => ApiError::new(err.status.unwrap_or(500), err.message).into_response(),
    }
}

/// Clones in a task of its own: the voice is made and its profile saved whoever is still waiting.
async fn clone_to_the_end(app: App, audio: Bytes, name: String, log_failure: bool) -> Response {
    to_the_end(async move {
        let result = clone_voice(&app, &audio, &name).await;
        if log_failure && let Err(err) = &result {
            log::error!("[voice] clone error: {}", err.message);
        }
        cloned_answer(result)
    })
    .await
}

/// POST /api/voice/clone: clone a voice from an audio sample. Accepts multipart form (web UI) or raw binary (API
/// clients).
async fn clone(State(app): State<App>, RawQuery(query): RawQuery, req: Request) -> Response {
    // Multipart form data (from web UI: FormData with 'audio' file + 'name' field)
    if content_type(&req).contains("multipart/form-data") {
        let rules = FormRules {
            files: &["audio"],
            fields: &["name"],
            limit_all: false,
            max_file: limits::VOICE_SAMPLE_MAX_BYTES,
            too_large: SAMPLE_TOO_LARGE,
        };
        let form = read_form(&app, req, rules).await.and_then(|mut form| {
            let audio = form
                .files
                .remove("audio")
                .ok_or_else(|| ApiError::bad_request("No audio file provided"))?;
            let name = form
                .fields
                .get("name")
                .map(|v| trim(v).to_string())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "Custom Voice".into());
            Ok((audio, name))
        });
        let (audio, name) = match form {
            Ok(form) => form,
            Err(err) => {
                log::error!("[voice] clone error: {}", err.message().unwrap_or(""));
                return err.into_response();
            }
        };
        log::info!("[voice] clone request: name=\"{name}\" audioSize={} bytes", audio.len());
        return clone_to_the_end(app, audio, name, true).await;
    }

    // Raw binary fallback (API clients: Content-Type: application/octet-stream)
    // The name: X-Voice-Name, else ?name=, else "Custom Voice". A name given twice in the query was an array, which is
    // no name at all (the clone is then refused).
    let from_query = || {
        let q = query.as_deref().unwrap_or("");
        let given: Vec<String> = url::form_urlencoded::parse(q.as_bytes())
            .filter(|(k, _)| k == "name")
            .map(|(_, v)| v.into_owned())
            .collect();
        match given.len() {
            0 => None,
            1 => given.into_iter().next().filter(|n| !n.is_empty()),
            _ => Some(String::new()),
        }
    };
    let headers = req.headers().clone();
    let name = header_text(&headers, "x-voice-name")
        .or_else(from_query)
        .unwrap_or_else(|| "Custom Voice".into());
    let audio = match raw_audio(&headers, req.into_body(), SAMPLE_TOO_LARGE).await {
        Ok(audio) => audio,
        Err(err) => return err.into_response(),
    };
    clone_to_the_end(app, audio, name, false).await
}

#[cfg(test)]
mod tests;
