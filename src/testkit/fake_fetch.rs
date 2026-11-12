//! A stubbed HTTP client: answers by URL prefix and records every request.
//!
//! ```ignore
//! let t = test_app();
//! t.fetch.respond("https://api.openai.com/v1/models", Answer::json(200, json!({"data": []})));
//! t.fetch.respond_with("https://openrouter.ai/", |req| Answer::json(401, json!({"error": req.url.clone()})));
//! // ... run the code under test ...
//! let calls = t.fetch.calls();
//! assert_eq!(calls[0].header("authorization"), Some("Bearer sk-test"));
//! ```
//!
//! The newest stub whose prefix matches wins, so a test can override an earlier, broader one. A request with no
//! stub fails like a dead network: `fetch failed: no stub for <url>`.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use futures::stream;
use parking_lot::Mutex;
use serde_json::Value;

use crate::net::fetch::{Fetch, FetchError, FetchRequest, FetchResponse};

/// What a stub gives back.
#[derive(Debug, Clone)]
pub enum Answer {
    /// A response. The body arrives in these pieces (one piece for an ordinary answer).
    Response {
        status: u16,
        headers: Vec<(String, String)>,
        chunks: Vec<Bytes>,
    },
    /// The request fails before any response.
    Error(FetchError),
    /// No answer ever: the request waits out its timeout (then fails with `Timeout`), or waits forever without one.
    Hang,
}

impl Answer {
    /// A JSON answer.
    pub fn json(status: u16, body: Value) -> Self {
        Answer::Response {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            chunks: vec![Bytes::from(body.to_string())],
        }
    }

    /// A plain text answer.
    pub fn text(status: u16, body: impl Into<String>) -> Self {
        Answer::Response {
            status,
            headers: vec![("content-type".into(), "text/plain".into())],
            chunks: vec![Bytes::from(body.into())],
        }
    }

    /// An answer with these bytes and this content type.
    pub fn bytes(status: u16, content_type: &str, body: impl Into<Bytes>) -> Self {
        Answer::Response {
            status,
            headers: vec![("content-type".into(), content_type.into())],
            chunks: vec![body.into()],
        }
    }

    /// A 200 `text/event-stream` answer whose body arrives in exactly these pieces.
    pub fn sse<S: Into<String>>(chunks: impl IntoIterator<Item = S>) -> Self {
        Answer::Response {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            chunks: chunks.into_iter().map(|c| Bytes::from(c.into())).collect(),
        }
    }

    /// The request fails to connect (`TypeError: fetch failed`).
    pub fn connect_error(message: impl Into<String>) -> Self {
        Answer::Error(FetchError::Connect(message.into()))
    }

    /// Adds a response header. Does nothing to an error or a hang.
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        if let Answer::Response { headers, .. } = &mut self {
            headers.push((name.into(), value.into()));
        }
        self
    }
}

/// A request the fake client was asked to make.
#[derive(Debug, Clone)]
pub struct FetchCall {
    pub url: String,
    pub method: String,
    /// Names in lower case, as the Node tests recorded them.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl FetchCall {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The body as JSON; null when it is not JSON.
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

type Responder = Arc<dyn Fn(&FetchRequest) -> Answer + Send + Sync>;

#[derive(Default)]
pub struct FakeFetch {
    /// Newest first.
    responders: Mutex<Vec<(String, Responder)>>,
    calls: Mutex<Vec<FetchCall>>,
}

impl FakeFetch {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Answers every request whose URL starts with `prefix` with `answer`.
    pub fn respond(&self, prefix: impl Into<String>, answer: Answer) {
        self.respond_with(prefix, move |_| answer.clone());
    }

    /// Answers every request whose URL starts with `prefix` with what `responder` returns for it.
    pub fn respond_with(
        &self,
        prefix: impl Into<String>,
        responder: impl Fn(&FetchRequest) -> Answer + Send + Sync + 'static,
    ) {
        self.responders.lock().insert(0, (prefix.into(), Arc::new(responder)));
    }

    /// Every request so far, oldest first.
    pub fn calls(&self) -> Vec<FetchCall> {
        self.calls.lock().clone()
    }

    /// The requests whose URL starts with `prefix`.
    pub fn calls_to(&self, prefix: &str) -> Vec<FetchCall> {
        self.calls
            .lock()
            .iter()
            .filter(|c| c.url.starts_with(prefix))
            .cloned()
            .collect()
    }

    /// Forgets the recorded requests; the stubs stay.
    pub fn clear_calls(&self) {
        self.calls.lock().clear();
    }

    /// Forgets the stubs and the recorded requests.
    pub fn reset(&self) {
        self.responders.lock().clear();
        self.calls.lock().clear();
    }
}

#[async_trait]
impl Fetch for FakeFetch {
    async fn fetch(&self, request: FetchRequest) -> Result<FetchResponse, FetchError> {
        self.calls.lock().push(FetchCall {
            url: request.url.clone(),
            method: request.method.clone(),
            headers: request
                .headers
                .iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
                .collect(),
            body: request.body_text(),
        });
        let responder = self
            .responders
            .lock()
            .iter()
            .find(|(prefix, _)| request.url.starts_with(prefix.as_str()))
            .map(|(_, r)| r.clone());
        let Some(responder) = responder else {
            return Err(FetchError::Connect(format!("no stub for {}", request.url)));
        };
        match responder(&request) {
            Answer::Response {
                status,
                headers,
                chunks,
            } => {
                let body = stream::iter(chunks.into_iter().map(Ok)).boxed();
                Ok(FetchResponse::from_stream(status, headers, body).with_url(request.url))
            }
            Answer::Error(err) => Err(err),
            Answer::Hang => match request.timeout {
                Some(timeout) => {
                    tokio::time::sleep(timeout).await;
                    Err(FetchError::Timeout)
                }
                None => {
                    tokio::time::sleep(Duration::from_secs(u64::from(u32::MAX))).await;
                    Err(FetchError::Timeout)
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn the_newest_matching_stub_answers_and_every_request_is_recorded() {
        let fetch = FakeFetch::new();
        fetch.respond("https://api.test/", Answer::json(200, json!({"which": "broad"})));
        fetch.respond(
            "https://api.test/v1/models",
            Answer::json(200, json!({"which": "narrow"})).header("X-Extra", "1"),
        );

        let res = fetch
            .fetch(FetchRequest::get("https://api.test/v1/models?x=1").header("Authorization", "Bearer k"))
            .await
            .unwrap();
        assert_eq!(res.header("x-extra"), Some("1"));
        assert_eq!(res.url, "https://api.test/v1/models?x=1");
        assert_eq!(res.json().await.unwrap()["which"], "narrow");
        let res = fetch
            .fetch(FetchRequest::post("https://api.test/other").json(&json!({"n": 1})))
            .await
            .unwrap();
        assert_eq!(res.json().await.unwrap()["which"], "broad");

        let calls = fetch.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            (calls[0].method.as_str(), calls[0].header("authorization")),
            ("GET", Some("Bearer k"))
        );
        assert_eq!(calls[1].json(), json!({"n": 1}));
        assert_eq!(fetch.calls_to("https://api.test/v1/").len(), 1);
        fetch.clear_calls();
        assert!(fetch.calls().is_empty());
    }

    #[tokio::test]
    async fn a_responder_sees_the_request() {
        let fetch = FakeFetch::new();
        fetch.respond_with("https://x.test/", |req| {
            if req.header_value("x-key").is_some() {
                Answer::text(200, "in")
            } else {
                Answer::text(401, "out")
            }
        });
        assert_eq!(
            fetch.fetch(FetchRequest::get("https://x.test/a")).await.unwrap().status,
            401
        );
        assert_eq!(
            fetch
                .fetch(FetchRequest::get("https://x.test/a").header("X-Key", "1"))
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "in"
        );
    }

    #[tokio::test]
    async fn errors_streams_and_hangs() {
        let fetch = FakeFetch::new();
        fetch.respond(
            "https://down.test/",
            Answer::connect_error("getaddrinfo ENOTFOUND down.test"),
        );
        fetch.respond("https://sse.test/", Answer::sse(["data: 1\n\n", "data: 2\n\n"]));
        fetch.respond("https://slow.test/", Answer::Hang);

        assert_eq!(
            fetch
                .fetch(FetchRequest::get("https://down.test/"))
                .await
                .unwrap_err()
                .to_string(),
            "fetch failed: getaddrinfo ENOTFOUND down.test"
        );
        let pieces: Vec<_> = fetch
            .fetch(FetchRequest::get("https://sse.test/"))
            .await
            .unwrap()
            .into_stream()
            .collect()
            .await;
        assert_eq!(pieces.len(), 2);
        let slow = fetch
            .fetch(FetchRequest::get("https://slow.test/").timeout(Duration::from_millis(20)))
            .await
            .unwrap_err();
        assert!(slow.is_timeout());

        fetch.reset();
        assert!(fetch.fetch(FetchRequest::get("https://sse.test/")).await.is_err());
        assert_eq!(fetch.calls().len(), 1);
    }
}
