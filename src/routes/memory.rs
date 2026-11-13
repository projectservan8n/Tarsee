//! Port of `src/routes/memory.js`: the memory routes (`/api/memory`, mounted behind sign-in and the CSRF check in
//! `server.rs`).

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use serde_json::{Value, json};

use crate::app::App;
use crate::db::memory::{JsDbError, MemoryStore};
use crate::error::{ApiError, ApiResult};
use crate::lib::workspace_files::jstext::js_parse_int;
use crate::routes::skills::{express_json_body, unhandled_error_named};
use crate::util::js::{trim, truthy};

pub fn router() -> Router<App> {
    Router::new()
        .route("/", get(list).post(add))
        .route(
            "/search",
            get(search).delete(|state| remove(state, Path("search".to_string()))),
        )
        .route("/{id}", delete(remove))
}

/// `req.query.<name>` as Express's query parser gave it: absent, one value, or an array when the name came more than
/// once.
#[derive(Debug, Clone, PartialEq, Eq)]
enum QueryValue {
    Absent,
    One(String),
    Many(Vec<String>),
}

impl QueryValue {
    /// `String(value)`: an array's values joined by commas (what `parseInt` read).
    fn as_text(&self) -> Option<String> {
        match self {
            QueryValue::Absent => None,
            QueryValue::One(v) => Some(v.clone()),
            QueryValue::Many(vs) => Some(vs.join(",")),
        }
    }

    /// The JS truthiness of the value: an empty string is false, an array always true.
    fn truthy(&self) -> bool {
        match self {
            QueryValue::Absent => false,
            QueryValue::One(v) => !v.is_empty(),
            QueryValue::Many(_) => true,
        }
    }
}

fn query_param(query: &Option<String>, name: &str) -> QueryValue {
    let mut values: Vec<String> = url::form_urlencoded::parse(query.as_deref().unwrap_or_default().as_bytes())
        .filter(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
        .collect();
    match values.len() {
        0 => QueryValue::Absent,
        1 => QueryValue::One(values.remove(0)),
        _ => QueryValue::Many(values),
    }
}

/// `Math.min(parseInt(text) || fallback, max)`.
fn limit_of(text: Option<String>, fallback: i64, max: i64) -> i64 {
    let parsed = text.as_deref().and_then(js_parse_int).filter(|n| *n != 0);
    parsed.unwrap_or(fallback).min(max)
}

/// A database error the route did not catch: the global error handler's 500.
fn db_error(app: &App, err: JsDbError) -> ApiError {
    unhandled_error_named(app, err.name, &err.message)
}

/// GET / — the memories, newest first. Optional `?category=` and `?limit=` (default 50, at most 200).
async fn list(State(app): State<App>, RawQuery(query): RawQuery) -> ApiResult {
    let store = MemoryStore::new(&app);
    let limit = limit_of(query_param(&query, "limit").as_text(), 50, 200);
    let category = match query_param(&query, "category") {
        QueryValue::One(c) if !c.is_empty() => Some(c),
        // An array was spread into the statement's parameters: one too many.
        QueryValue::Many(_) => {
            return Err(unhandled_error_named(
                &app,
                "RangeError",
                "Too many parameter values were provided",
            ));
        }
        _ => None,
    };
    let memories = store
        .list(limit, category.as_deref())
        .map_err(|e| db_error(&app, e.into()))?;
    let total = store.count().map_err(|e| db_error(&app, e.into()))?;
    Ok(Json(json!({ "memories": memories, "total": total })))
}

/// POST / — adds a memory. Body: `{ content, category?, conversationId? }`.
///
/// `category` and `conversationId` are bound as the JS bound whatever JSON was sent (a number is stored as "5.0",
/// an array gives its items), and the answer carries them as they were sent.
async fn add(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
    let body = express_json_body(&headers, &body)?.unwrap_or_else(|| json!({}));
    let content = match body.get("content") {
        Some(Value::String(text)) if !trim(text).is_empty() => trim(text).to_string(),
        _ => return Err(ApiError::bad_request("Content is required")),
    };
    let category = body
        .get("category")
        .filter(|c| truthy(c))
        .cloned()
        .unwrap_or_else(|| Value::String("preference".into()));
    let conversation_id = body
        .get("conversationId")
        .filter(|c| truthy(c))
        .cloned()
        .unwrap_or(Value::Null);
    let id = MemoryStore::new(&app)
        .add_js(&content, &category, &conversation_id)
        .map_err(|e| db_error(&app, e))?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "id": id, "category": category, "content": content })),
    )
        .into_response())
}

/// DELETE /:id — deletes a memory.
async fn remove(State(app): State<App>, Path(id): Path<String>) -> ApiResult {
    let deleted = MemoryStore::new(&app)
        .delete(&id)
        .map_err(|e| db_error(&app, e.into()))?;
    if !deleted {
        return Err(ApiError::not_found("Memory not found"));
    }
    Ok(Json(json!({ "ok": true })))
}

/// GET /search — `?q=search+term&limit=20` (at most 100).
async fn search(State(app): State<App>, RawQuery(query): RawQuery) -> ApiResult {
    let q = query_param(&query, "q");
    if !q.truthy() {
        return Err(ApiError::bad_request("Query param 'q' is required"));
    }
    let QueryValue::One(q) = q else {
        // `?q=a&q=b` is an array, which has no toLowerCase.
        return Err(unhandled_error_named(
            &app,
            "TypeError",
            "query.toLowerCase is not a function",
        ));
    };
    let limit = limit_of(query_param(&query, "limit").as_text(), 20, 100);
    let memories = MemoryStore::new(&app)
        .search(&q, limit)
        .map_err(|e| db_error(&app, e.into()))?;
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
        let res = http::post_json(
            &router,
            "/",
            &json!({"content": "  Likes green tea  ", "category": "taste"}),
        )
        .await;
        assert_eq!(res.status, 201);
        let made = res.json();
        assert_eq!(
            made.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id", "category", "content"]
        );
        assert_eq!(
            (made["category"].clone(), made["content"].clone()),
            (json!("taste"), json!("Likes green tea"))
        );
        let res = http::post_json(&router, "/", &json!({"content": "Uses Rust", "conversationId": "c1"})).await;
        assert_eq!(res.json()["category"], "preference");

        let res = http::get(&router, "/").await;
        assert_eq!(res.status, 200);
        assert_eq!(res.json()["total"], 2);
        let memories = res.json()["memories"].as_array().unwrap().clone();
        assert_eq!(memories.len(), 2);
        assert_eq!(
            memories[0].as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "id",
                "category",
                "content",
                "source_conversation_id",
                "created_at",
                "updated_at"
            ]
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
        assert_eq!(
            (found[0]["content"].clone(), found[0]["score"].clone()),
            (json!("Likes green tea"), json!(2))
        );

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
    async fn values_that_are_not_text_are_bound_or_refused_as_node_did() {
        let (t, router) = app();
        let res = http::post_json(&router, "/", &json!({"content": "n", "category": 5})).await;
        assert_eq!(res.status, 201);
        assert_eq!(res.json()["category"], 5, "the answer carries what was sent");
        let id = res.json()["id"].as_str().unwrap().to_string();
        assert_eq!(MemoryStore::new(&t).get(&id).unwrap().unwrap().category, "5.0");

        let cases = [
            (
                json!({"content": "n", "category": true}),
                "SQLite3 can only bind numbers, strings, bigints, buffers, and null",
            ),
            (
                json!({"content": "n", "category": {"a": 1}}),
                "Too few parameter values were provided",
            ),
            (
                json!({"content": "n", "category": [1, 2]}),
                "Too many parameter values were provided",
            ),
            (
                json!({"content": "n", "conversationId": true}),
                "SQLite3 can only bind numbers, strings, bigints, buffers, and null",
            ),
        ];
        for (body, detail) in cases {
            let res = http::post_json(&router, "/", &body).await;
            assert_eq!(
                (res.status, res.json()),
                (500, json!({"error": "Internal server error", "detail": detail})),
                "{body}"
            );
        }
        let logs = crate::testkit::CapturedLogs::start();
        let res = http::get(&router, "/search?q=a&q=b").await;
        assert_eq!(
            (res.status, res.json()),
            (
                500,
                json!({"error": "Internal server error", "detail": "query.toLowerCase is not a function"})
            )
        );
        assert_eq!(
            logs.errors(),
            ["[error] TypeError: query.toLowerCase is not a function"]
        );
        let res = http::get(&router, "/?category=a&category=b").await;
        assert_eq!(
            (res.status, res.json()),
            (
                500,
                json!({"error": "Internal server error", "detail": "Too many parameter values were provided"})
            )
        );
        assert_eq!(
            http::get(&router, "/?category=").await.json()["memories"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn a_negative_search_limit_leaves_results_off_the_end() {
        let (t, router) = app();
        let store = MemoryStore::new(&t);
        for content in ["tea one", "tea two", "tea three"] {
            store.add(content, "fact", None).unwrap();
        }
        let res = http::get(&router, "/search?q=tea&limit=-1").await;
        assert_eq!(res.json()["memories"].as_array().unwrap().len(), 2);
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
        assert_eq!(
            query_param(&Some("limit=5&limit=7".into()), "limit")
                .as_text()
                .as_deref(),
            Some("5,7")
        );
        assert_eq!(
            query_param(&Some("q=a+b%21".into()), "q").as_text().as_deref(),
            Some("a b!")
        );
    }
}
