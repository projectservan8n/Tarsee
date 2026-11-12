//! Port of `src/routes/memory.js`: the memory routes (`/api/memory`, mounted behind sign-in and the CSRF check in
//! `server.rs`).

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::Json;
use serde_json::{Value, json};

use crate::app::App;
use crate::db::memory::MemoryStore;
use crate::error::{ApiError, ApiResult};
use crate::lib::workspace_files::jstext::{js_parse_int, js_string, js_trim};
use crate::routes::skills::{express_json_body, unhandled_error};
use crate::util::js::truthy;

pub fn router() -> Router<App> {
    Router::new()
        .route("/", get(list).post(add))
        .route(
            "/search",
            get(search).delete(|state| remove(state, Path("search".to_string()))),
        )
        .route("/{id}", delete(remove))
}

/// `req.query.<name>` as text: a name given twice was an array, which `parseInt` and the like read as its values
/// joined by commas.
fn query_param(query: &Option<String>, name: &str) -> Option<String> {
    let values: Vec<String> = url::form_urlencoded::parse(query.as_deref().unwrap_or_default().as_bytes())
        .filter(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values.join(","))
    }
}

/// `Math.min(parseInt(text) || fallback, max)`.
fn limit_of(text: Option<String>, fallback: i64, max: i64) -> i64 {
    let parsed = text.as_deref().and_then(js_parse_int).filter(|n| *n != 0);
    parsed.unwrap_or(fallback).min(max)
}

fn db_error(app: &App, err: rusqlite::Error) -> ApiError {
    unhandled_error(app, &err.to_string())
}

/// GET / — the memories, newest first. Optional `?category=` and `?limit=` (default 50, at most 200).
async fn list(State(app): State<App>, RawQuery(query): RawQuery) -> ApiResult {
    let store = MemoryStore::new(&app);
    let limit = limit_of(query_param(&query, "limit"), 50, 200);
    let category = query_param(&query, "category").filter(|c| !c.is_empty());
    let memories = store
        .list(limit, category.as_deref())
        .map_err(|e| db_error(&app, e))?;
    let total = store.count().map_err(|e| db_error(&app, e))?;
    Ok(Json(json!({ "memories": memories, "total": total })))
}

/// POST / — adds a memory. Body: `{ content, category?, conversationId? }`.
async fn add(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
    let body = express_json_body(&headers, &body)?.unwrap_or_else(|| json!({}));
    let content = match body.get("content") {
        Some(Value::String(text)) if !js_trim(text).is_empty() => js_trim(text).to_string(),
        _ => return Err(ApiError::bad_request("Content is required")),
    };
    let category = match body.get("category").filter(|c| truthy(c)) {
        Some(c) => js_string(Some(c)),
        None => "preference".to_string(),
    };
    let conversation_id = body
        .get("conversationId")
        .filter(|c| truthy(c))
        .map(|c| js_string(Some(c)));
    let memory = MemoryStore::new(&app)
        .add(&content, &category, conversation_id.as_deref())
        .map_err(|e| db_error(&app, e))?;
    Ok((StatusCode::CREATED, Json(memory)).into_response())
}

/// DELETE /:id — deletes a memory.
async fn remove(State(app): State<App>, Path(id): Path<String>) -> ApiResult {
    let deleted = MemoryStore::new(&app)
        .delete(&id)
        .map_err(|e| db_error(&app, e))?;
    if !deleted {
        return Err(ApiError::not_found("Memory not found"));
    }
    Ok(Json(json!({ "ok": true })))
}

/// GET /search — `?q=search+term&limit=20` (at most 100).
async fn search(State(app): State<App>, RawQuery(query): RawQuery) -> ApiResult {
    let Some(q) = query_param(&query, "q").filter(|q| !q.is_empty()) else {
        return Err(ApiError::bad_request("Query param 'q' is required"));
    };
    let limit = limit_of(query_param(&query, "limit"), 20, 100);
    let memories = MemoryStore::new(&app)
        .search(&q, usize::try_from(limit).unwrap_or(0))
        .map_err(|e| db_error(&app, e))?;
    Ok(Json(json!({ "memories": memories })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::http::{self, request};
    use crate::testkit::{TestApp, test_app};

    fn app() -> (TestApp, Router) {
        let t = test_app();
        let router = router().with_state(t.app.clone());
        (t, router)
    }

    #[tokio::test]
    async fn memories_are_added_listed_searched_and_deleted() {
        let (t, router) = app();
        let res = http::post_json(&router, "/", &json!({"content": "  Likes green tea  ", "category": "taste"})).await;
        assert_eq!(res.status, 201);
        let made = res.json();
        assert_eq!(
            made.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id", "category", "content"]
        );
        assert_eq!((made["category"].clone(), made["content"].clone()), (json!("taste"), json!("Likes green tea")));
        let res = http::post_json(&router, "/", &json!({"content": "Uses Rust", "conversationId": "c1"})).await;
        assert_eq!(res.json()["category"], "preference");

        let res = http::get(&router, "/").await;
        assert_eq!(res.status, 200);
        assert_eq!(res.json()["total"], 2);
        let memories = res.json()["memories"].as_array().unwrap().clone();
        assert_eq!(memories.len(), 2);
        assert_eq!(
            memories[0].as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id", "category", "content", "source_conversation_id", "created_at", "updated_at"]
        );
        let res = http::get(&router, "/?category=taste&limit=abc").await;
        assert_eq!(res.json()["memories"].as_array().unwrap().len(), 1);
        assert_eq!(res.json()["total"], 2, "the total counts every memory");
        let res = http::get(&router, "/?limit=1").await;
        assert_eq!(res.json()["memories"].as_array().unwrap().len(), 1);

        let res = http::get(&router, "/search?q=green+TEA").await;
        assert_eq!(res.status, 200);
        let found = res.json()["memories"].as_array().unwrap().clone();
        assert_eq!(found.len(), 1);
        assert_eq!((found[0]["content"].clone(), found[0]["score"].clone()), (json!("Likes green tea"), json!(2)));

        let id = made["id"].as_str().unwrap();
        let res = http::delete(&router, &format!("/{id}")).await;
        assert_eq!((res.status, res.json()), (200, json!({"ok": true})));
        let res = http::delete(&router, &format!("/{id}")).await;
        assert_eq!((res.status, res.json()), (404, json!({"error": "Memory not found"})));
        let res = http::delete(&router, "/search").await;
        assert_eq!((res.status, res.json()), (404, json!({"error": "Memory not found"})));
        assert_eq!(MemoryStore::new(&t).count().unwrap(), 1);
    }

    #[tokio::test]
    async fn bad_requests_are_refused_as_before() {
        let (_t, router) = app();
        for body in [json!({}), json!({"content": "   "}), json!({"content": 5})] {
            let res = http::post_json(&router, "/", &body).await;
            assert_eq!((res.status, res.json()), (400, json!({"error": "Content is required"})));
        }
        let res = http::send(&router, request("POST", "/")).await;
        assert_eq!((res.status, res.json()), (400, json!({"error": "Content is required"})));
        for path in ["/search", "/search?q="] {
            let res = http::get(&router, path).await;
            assert_eq!(
                (res.status, res.json()),
                (400, json!({"error": "Query param 'q' is required"}))
            );
        }
    }

    #[test]
    fn limits_read_like_parse_int() {
        assert_eq!(limit_of(None, 50, 200), 50);
        assert_eq!(limit_of(Some("0".into()), 50, 200), 50);
        assert_eq!(limit_of(Some("500".into()), 50, 200), 200);
        assert_eq!(limit_of(Some("12abc".into()), 50, 200), 12);
        assert_eq!(limit_of(Some("-5".into()), 50, 200), -5);
        assert_eq!(query_param(&Some("limit=5&limit=7".into()), "limit").as_deref(), Some("5,7"));
        assert_eq!(query_param(&Some("q=a+b%21".into()), "q").as_deref(), Some("a b!"));
    }
}
