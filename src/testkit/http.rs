//! Calls an axum `Router` directly, with no socket: what the Node tests did with `express()` on a random port and
//! `fetch`.
//!
//! ```ignore
//! let router = routes::memory::router().with_state(t.app.clone());
//! let res = http::get(&router, "/api/memory").await;
//! assert_eq!(res.status, 200);
//! assert_eq!(res.json()["memories"], json!([]));
//!
//! let res = http::send(&router, http::request("POST", "/x").header("cookie", cookie).json(&json!({"a": 1}))).await;
//! ```

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request};
use bytes::Bytes;
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

/// A response with its body already read.
#[derive(Debug, Clone)]
pub struct TestResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl TestResponse {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// The body as JSON; null when it is not JSON.
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    /// The first header with this name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

    /// Every `set-cookie` header, as sent.
    pub fn set_cookies(&self) -> Vec<String> {
        self.headers
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok().map(String::from))
            .collect()
    }

    /// The value of the cookie this response set under `name`, if it set one.
    pub fn cookie(&self, name: &str) -> Option<String> {
        self.set_cookies().iter().find_map(|line| {
            let pair = line.split(';').next()?;
            let (key, value) = pair.split_once('=')?;
            (key.trim() == name).then(|| value.trim().to_string())
        })
    }
}

/// A request being built: method, path, headers, then a body.
pub struct TestRequest {
    builder: axum::http::request::Builder,
    body: Body,
}

/// Starts a request, e.g. `request("DELETE", "/api/chat/abc")`.
pub fn request(method: &str, path: &str) -> TestRequest {
    TestRequest {
        builder: Request::builder().method(method).uri(path),
        body: Body::empty(),
    }
}

impl TestRequest {
    pub fn header(mut self, name: &str, value: impl AsRef<str>) -> Self {
        self.builder = self.builder.header(name, value.as_ref());
        self
    }

    /// A JSON body with `content-type: application/json`.
    pub fn json(mut self, body: &Value) -> Self {
        self.builder = self.builder.header("content-type", "application/json");
        self.body = Body::from(body.to_string());
        self
    }

    pub fn body(mut self, body: impl Into<Body>) -> Self {
        self.body = body.into();
        self
    }

    pub fn build(self) -> Request<Body> {
        self.builder.body(self.body).expect("the test request is not valid")
    }
}

impl From<TestRequest> for Request<Body> {
    fn from(request: TestRequest) -> Self {
        request.build()
    }
}

/// Sends a request to the router and reads the whole response.
pub async fn send(router: &Router, request: impl Into<Request<Body>>) -> TestResponse {
    let response = router
        .clone()
        .oneshot(request.into())
        .await
        .expect("a router never fails");
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .map(|b| b.to_bytes())
        .unwrap_or_default();
    TestResponse { status, headers, body }
}

pub async fn get(router: &Router, path: &str) -> TestResponse {
    send(router, request("GET", path)).await
}

pub async fn post_json(router: &Router, path: &str, body: &Value) -> TestResponse {
    send(router, request("POST", path).json(body)).await
}

pub async fn put_json(router: &Router, path: &str, body: &Value) -> TestResponse {
    send(router, request("PUT", path).json(body)).await
}

pub async fn delete(router: &Router, path: &str) -> TestResponse {
    send(router, request("DELETE", path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Json;
    use axum::http::header::SET_COOKIE;
    use axum::routing::{get as get_route, post};
    use serde_json::json;

    fn router() -> Router {
        Router::new()
            .route("/hello", get_route(|| async { Json(json!({"hi": true})) }))
            .route(
                "/echo",
                post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                    Json(json!({"got": body, "who": headers.get("x-who").and_then(|v| v.to_str().ok())}))
                }),
            )
            .route(
                "/login",
                post(|| async { ([(SET_COOKIE, "tarsee_session=abc123; Path=/; HttpOnly")], "in") }),
            )
    }

    #[tokio::test]
    async fn requests_reach_the_handlers_and_responses_read_back() {
        let router = router();
        let res = get(&router, "/hello").await;
        assert_eq!((res.status, res.json()), (200, json!({"hi": true})));

        let res = send(
            &router,
            request("POST", "/echo").header("x-who", "me").json(&json!({"n": 1})),
        )
        .await;
        assert_eq!(res.json(), json!({"got": {"n": 1}, "who": "me"}));
        assert_eq!(post_json(&router, "/echo", &json!([1])).await.json()["got"], json!([1]));

        let res = send(&router, request("POST", "/login")).await;
        assert_eq!(res.text(), "in");
        assert_eq!(res.cookie("tarsee_session").as_deref(), Some("abc123"));
        assert_eq!(res.cookie("other"), None);

        assert_eq!(get(&router, "/missing").await.status, 404);
        assert_eq!(delete(&router, "/hello").await.status, 405);
    }
}
