//! Outgoing HTTP, behind one trait.
//!
//! The Node version called `fetch` and its tests swapped in a stub that recorded where each request went (that is
//! how they prove a key only ever travels to its own provider's host). [`Fetch`] is that seam: production uses
//! [`ReqwestFetch`], tests use `testkit::FakeFetch`. Code gets the client from `app.fetch()` or takes an
//! `Arc<dyn Fetch>`; it never builds its own HTTP client.
//!
//! ```ignore
//! let res = app.fetch().fetch(FetchRequest::post(url).bearer(&key).json(&body)).await?;
//! if !res.ok() { ... }
//! let data = res.json().await?;
//! ```
//!
//! To stop a request (the JS `AbortSignal`), race it against a `tokio_util::sync::CancellationToken` with
//! `tokio::select!`; dropping the future cancels the request.

use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use futures::stream::{self, BoxStream};
use serde_json::Value;

/// A request body arriving in pieces.
pub type ByteStream = BoxStream<'static, Result<Bytes, FetchError>>;

/// Why a request produced no response.
#[derive(Debug, Clone, thiserror::Error)]
pub enum FetchError {
    /// No answer within the request's timeout.
    #[error("the request timed out")]
    Timeout,
    /// The host could not be reached: DNS, refused connection, TLS (the JS `TypeError: fetch failed`).
    #[error("fetch failed: {0}")]
    Connect(String),
    /// The body could not be read or was not what was asked for (bad JSON, bad UTF-8, a cut connection).
    #[error("{0}")]
    Body(String),
    /// Anything else.
    #[error("{0}")]
    Other(String),
}

impl FetchError {
    pub fn is_timeout(&self) -> bool {
        matches!(self, FetchError::Timeout)
    }
}

/// One outgoing request. Build it with [`FetchRequest::get`], [`FetchRequest::post`] and the chained setters.
#[derive(Debug, Clone)]
pub struct FetchRequest {
    pub method: String,
    pub url: String,
    /// In the order they were added. Names are sent as given.
    pub headers: Vec<(String, String)>,
    pub body: Option<Bytes>,
    pub timeout: Option<Duration>,
    /// False to get a 3xx answer itself instead of following it (`redirect: "manual"`).
    pub follow_redirects: bool,
}

impl FetchRequest {
    pub fn new(method: impl Into<String>, url: impl Into<String>) -> Self {
        FetchRequest {
            method: method.into(),
            url: url.into(),
            headers: Vec::new(),
            body: None,
            timeout: None,
            follow_redirects: true,
        }
    }

    pub fn get(url: impl Into<String>) -> Self {
        Self::new("GET", url)
    }

    pub fn post(url: impl Into<String>) -> Self {
        Self::new("POST", url)
    }

    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// `Authorization: Bearer <token>`.
    pub fn bearer(self, token: &str) -> Self {
        self.header("authorization", format!("Bearer {token}"))
    }

    /// A JSON body, with `content-type: application/json` unless a content type was already set.
    pub fn json(mut self, body: &Value) -> Self {
        if self.header_value("content-type").is_none() {
            self.headers.push(("content-type".into(), "application/json".into()));
        }
        self.body = Some(Bytes::from(body.to_string()));
        self
    }

    pub fn body(mut self, body: impl Into<Bytes>) -> Self {
        self.body = Some(body.into());
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn no_redirects(mut self) -> Self {
        self.follow_redirects = false;
        self
    }

    /// The first header with this name, whatever its case.
    pub fn header_value(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The body as text (empty when there is none), for tests that check what was sent.
    pub fn body_text(&self) -> String {
        self.body
            .as_ref()
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .unwrap_or_default()
    }
}

/// A response whose body has not been read yet. Read it once with [`bytes`](Self::bytes), [`text`](Self::text),
/// [`json`](Self::json) or [`into_stream`](Self::into_stream).
pub struct FetchResponse {
    pub status: u16,
    /// Names in lower case.
    pub headers: Vec<(String, String)>,
    /// The address that answered, after redirects.
    pub url: String,
    body: ByteStream,
}

impl FetchResponse {
    /// A response with its whole body in hand (tests, and small answers).
    pub fn new(status: u16, headers: Vec<(String, String)>, body: impl Into<Bytes>) -> Self {
        let body: Bytes = body.into();
        Self::from_stream(status, headers, stream::once(async move { Ok(body) }).boxed())
    }

    /// A response whose body arrives in pieces (server-sent events, downloads).
    pub fn from_stream(status: u16, headers: Vec<(String, String)>, body: ByteStream) -> Self {
        let headers = headers.into_iter().map(|(k, v)| (k.to_ascii_lowercase(), v)).collect();
        FetchResponse {
            status,
            headers,
            url: String::new(),
            body,
        }
    }

    /// A JSON response: `content-type: application/json` and the value as the body.
    pub fn json_body(status: u16, body: &Value) -> Self {
        Self::new(
            status,
            vec![("content-type".into(), "application/json".into())],
            body.to_string(),
        )
    }

    pub fn with_url(mut self, url: impl Into<String>) -> Self {
        self.url = url.into();
        self
    }

    /// Whether the status is 200 to 299 (`res.ok`).
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The first header with this name, whatever its case (`res.headers.get(name)`).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The whole body.
    pub async fn bytes(mut self) -> Result<Bytes, FetchError> {
        let mut all = Vec::new();
        while let Some(chunk) = self.body.next().await {
            all.extend_from_slice(&chunk?);
        }
        Ok(Bytes::from(all))
    }

    /// The whole body as text. Bytes that are not UTF-8 become U+FFFD, as in `res.text()`.
    pub async fn text(self) -> Result<String, FetchError> {
        Ok(String::from_utf8_lossy(&self.bytes().await?).into_owned())
    }

    /// The whole body as JSON (`res.json()`).
    pub async fn json(self) -> Result<Value, FetchError> {
        let bytes = self.bytes().await?;
        serde_json::from_slice(&bytes).map_err(|err| FetchError::Body(format!("the response is not JSON: {err}")))
    }

    /// The body as it arrives.
    pub fn into_stream(self) -> ByteStream {
        self.body
    }
}

impl std::fmt::Debug for FetchResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FetchResponse")
            .field("status", &self.status)
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

/// Something that can make HTTP requests.
#[async_trait]
pub trait Fetch: Send + Sync + 'static {
    /// Sends the request. An HTTP error status is still `Ok`: check [`FetchResponse::ok`].
    async fn fetch(&self, request: FetchRequest) -> Result<FetchResponse, FetchError>;
}

/// The real client.
pub struct ReqwestFetch {
    following: reqwest::Client,
    manual: reqwest::Client,
}

impl Default for ReqwestFetch {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestFetch {
    pub fn new() -> Self {
        let build = |policy: reqwest::redirect::Policy| {
            reqwest::Client::builder()
                .redirect(policy)
                .build()
                .expect("the HTTP client could not be built")
        };
        ReqwestFetch {
            following: build(reqwest::redirect::Policy::limited(20)),
            manual: build(reqwest::redirect::Policy::none()),
        }
    }
}

fn error_from(err: reqwest::Error) -> FetchError {
    if err.is_timeout() {
        FetchError::Timeout
    } else if err.is_connect() || err.is_request() {
        // The cause says more than reqwest's own wrapper line ("error sending request").
        let cause = std::error::Error::source(&err)
            .map(|s| s.to_string())
            .unwrap_or_else(|| err.to_string());
        FetchError::Connect(cause)
    } else if err.is_body() || err.is_decode() {
        FetchError::Body(err.to_string())
    } else {
        FetchError::Other(err.to_string())
    }
}

#[async_trait]
impl Fetch for ReqwestFetch {
    async fn fetch(&self, request: FetchRequest) -> Result<FetchResponse, FetchError> {
        let client = if request.follow_redirects {
            &self.following
        } else {
            &self.manual
        };
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| FetchError::Other(format!("not an HTTP method: {}", request.method)))?;
        let mut builder = client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        if let Some(timeout) = request.timeout {
            builder = builder.timeout(timeout);
        }
        let response = builder.send().await.map_err(error_from)?;
        let status = response.status().as_u16();
        let url = response.url().to_string();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect();
        let body = response.bytes_stream().map(|chunk| chunk.map_err(error_from)).boxed();
        Ok(FetchResponse::from_stream(status, headers, body).with_url(url))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_request_is_built_step_by_step() {
        let req = FetchRequest::post("https://api.example.test/v1/x")
            .bearer("tok")
            .json(&json!({"a": 1}))
            .timeout(Duration::from_secs(3))
            .no_redirects();
        assert_eq!(req.method, "POST");
        assert_eq!(req.header_value("Authorization"), Some("Bearer tok"));
        assert_eq!(req.header_value("Content-Type"), Some("application/json"));
        assert_eq!(req.body_text(), "{\"a\":1}");
        assert_eq!(req.timeout, Some(Duration::from_secs(3)));
        assert!(!req.follow_redirects);
        assert_eq!(FetchRequest::get("u").body_text(), "");
    }

    #[test]
    fn json_keeps_a_content_type_that_was_already_set() {
        let req = FetchRequest::post("u")
            .header("Content-Type", "application/vnd.api+json")
            .json(&json!({}));
        assert_eq!(req.headers.len(), 1);
    }

    #[tokio::test]
    async fn a_response_reads_as_text_json_or_bytes() {
        let res = FetchResponse::json_body(201, &json!({"ok": true}));
        assert!(res.ok());
        assert_eq!(res.header("Content-Type"), Some("application/json"));
        assert_eq!(res.json().await.unwrap(), json!({"ok": true}));

        let res = FetchResponse::new(404, vec![("X-Why".into(), "gone".into())], "nope");
        assert!(!res.ok());
        assert_eq!(res.header("x-why"), Some("gone"));
        assert_eq!(res.text().await.unwrap(), "nope");

        let err = FetchResponse::new(200, vec![], "not json").json().await.unwrap_err();
        assert!(matches!(err, FetchError::Body(_)));
    }

    #[tokio::test]
    async fn a_streamed_body_arrives_in_its_pieces_and_joins_up() {
        let pieces = vec![Ok(Bytes::from("data: a\n\n")), Ok(Bytes::from("data: b\n\n"))];
        let res = FetchResponse::from_stream(200, vec![], stream::iter(pieces.clone()).boxed());
        let got: Vec<Bytes> = res.into_stream().map(Result::unwrap).collect().await;
        assert_eq!(got.len(), 2);
        let res = FetchResponse::from_stream(200, vec![], stream::iter(pieces).boxed());
        assert_eq!(res.text().await.unwrap(), "data: a\n\ndata: b\n\n");
    }

    #[tokio::test]
    async fn a_broken_body_is_an_error() {
        let pieces = vec![Ok(Bytes::from("half")), Err(FetchError::Body("connection cut".into()))];
        let res = FetchResponse::from_stream(200, vec![], stream::iter(pieces).boxed());
        assert_eq!(res.text().await.unwrap_err().to_string(), "connection cut");
    }

    #[tokio::test]
    async fn the_real_client_talks_to_a_real_server() {
        use axum::routing::{get, post};
        let router = axum::Router::new()
            .route("/hello", get(|| async { "hi" }))
            .route(
                "/echo",
                post(|headers: axum::http::HeaderMap, body: String| async move {
                    format!(
                        "{}|{}",
                        headers.get("x-test").and_then(|v| v.to_str().ok()).unwrap_or(""),
                        body
                    )
                }),
            )
            .route(
                "/moved",
                get(|| async { axum::response::Redirect::temporary("/hello") }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let client = ReqwestFetch::new();
        let res = client.fetch(FetchRequest::get(format!("{base}/hello"))).await.unwrap();
        assert_eq!((res.status, res.url.clone()), (200, format!("{base}/hello")));
        assert_eq!(res.text().await.unwrap(), "hi");

        let res = client
            .fetch(
                FetchRequest::post(format!("{base}/echo"))
                    .header("X-Test", "t")
                    .body("payload"),
            )
            .await
            .unwrap();
        assert_eq!(res.text().await.unwrap(), "t|payload");

        let followed = client.fetch(FetchRequest::get(format!("{base}/moved"))).await.unwrap();
        assert_eq!(followed.status, 200);
        let manual = client
            .fetch(FetchRequest::get(format!("{base}/moved")).no_redirects())
            .await
            .unwrap();
        assert_eq!(manual.status, 307);
        assert_eq!(manual.header("location"), Some("/hello"));

        let missing = client.fetch(FetchRequest::get(format!("{base}/nope"))).await.unwrap();
        assert_eq!(missing.status, 404);
    }

    #[tokio::test]
    async fn an_unreachable_host_is_a_connect_error() {
        // Port 1 on loopback: nothing listens there.
        let err = ReqwestFetch::new()
            .fetch(FetchRequest::get("http://127.0.0.1:1/").timeout(Duration::from_secs(5)))
            .await
            .unwrap_err();
        assert!(matches!(err, FetchError::Connect(_) | FetchError::Timeout), "{err:?}");
    }
}
