//! A fake of the download hosts (Hugging Face, GitHub and their CDNs) for the installers' tests: a [`Fetch`] that
//! serves fixed answers by exact URL and never touches the network. A file can come in slow chunks (so progress
//! moves), stop halfway (a dropped connection), redirect (as the real hosts do, to their CDNs), or answer an HTTP
//! error. The Node tests' `test/fakes/fake-download-host.js`.
//!
//! [`FakeFetch`](super::FakeFetch) answers by prefix with whole bodies; the installers also need a body that breaks
//! off in the middle, which is what this adds.
//!
//! ```ignore
//! let host = FakeDownloadHost::new([
//!     ("https://huggingface.co/x/resolve/rev/model.bin", Route::redirect("https://us.aws.cdn.hf.co/xet/abc")),
//!     ("https://us.aws.cdn.hf.co/xet/abc", Route::body(buf).chunk(1024).delay_ms(2)),
//!     ("https://api.github.com/...", Route::json(json!({...}))),
//!     ("https://github.com/...", Route::dynamic(move |_url, hit| if hit == 1 { Route::body(b.clone()).fail_at(100) } else { Route::body(b.clone()) })),
//! ]);
//! host.hits(url); host.requests();
//! ```

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use parking_lot::Mutex;
use serde_json::Value;

use crate::net::fetch::{Fetch, FetchError, FetchRequest, FetchResponse};

type DynamicRoute = Arc<dyn Fn(&str, usize) -> Route + Send + Sync>;

/// What the fake host answers for one URL.
#[derive(Clone)]
pub enum Route {
    /// A redirect (302 unless another status is given) to `to`.
    Redirect { to: String, status: u16 },
    /// A 200 with this body, sent `chunk` bytes at a time with `delay_ms` before each piece; with `fail_at`, the
    /// connection drops once that many bytes have gone out.
    Body {
        body: Bytes,
        chunk: usize,
        delay_ms: u64,
        fail_at: Option<usize>,
        /// The `content-length` header; the body's length when not set.
        content_length: Option<String>,
        headers: Vec<(String, String)>,
    },
    /// Another status, with a text body.
    Status {
        status: u16,
        text: String,
        headers: Vec<(String, String)>,
    },
    /// A 200 JSON answer.
    Json(Value),
    /// The request fails before any answer.
    Error(FetchError),
    /// Decided per request: the URL and how many times it has been asked for (1 the first time).
    Dynamic(DynamicRoute),
}

impl Route {
    pub fn body(body: impl Into<Bytes>) -> Self {
        Route::Body {
            body: body.into(),
            chunk: 64 * 1024,
            delay_ms: 0,
            fail_at: None,
            content_length: None,
            headers: Vec::new(),
        }
    }

    pub fn redirect(to: impl Into<String>) -> Self {
        Route::Redirect {
            to: to.into(),
            status: 302,
        }
    }

    pub fn json(value: Value) -> Self {
        Route::Json(value)
    }

    pub fn status(status: u16, text: impl Into<String>) -> Self {
        Route::Status {
            status,
            text: text.into(),
            headers: Vec::new(),
        }
    }

    pub fn dynamic(f: impl Fn(&str, usize) -> Route + Send + Sync + 'static) -> Self {
        Route::Dynamic(Arc::new(f))
    }

    /// The size of each piece of a body.
    pub fn chunk(mut self, size: usize) -> Self {
        if let Route::Body { chunk, .. } = &mut self {
            *chunk = size.max(1);
        }
        self
    }

    /// A pause before each piece of a body.
    pub fn delay_ms(mut self, ms: u64) -> Self {
        if let Route::Body { delay_ms, .. } = &mut self {
            *delay_ms = ms;
        }
        self
    }

    /// The connection drops once this many bytes of the body have been sent.
    pub fn fail_at(mut self, at: usize) -> Self {
        if let Route::Body { fail_at, .. } = &mut self {
            *fail_at = Some(at);
        }
        self
    }

    /// The `content-length` header to send instead of the body's own length.
    pub fn content_length(mut self, value: impl Into<String>) -> Self {
        if let Route::Body { content_length, .. } = &mut self {
            *content_length = Some(value.into());
        }
        self
    }

    /// Adds a response header to a body or status answer.
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        match &mut self {
            Route::Body { headers, .. } | Route::Status { headers, .. } => headers.push((name.into(), value.into())),
            _ => {}
        }
        self
    }
}

/// A request the fake host received.
#[derive(Debug, Clone)]
pub struct HostRequest {
    pub url: String,
    /// False when the caller asked to see redirects itself (`redirect: "manual"`).
    pub follow_redirects: bool,
    pub headers: Vec<(String, String)>,
}

impl HostRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Default)]
pub struct FakeDownloadHost {
    routes: Mutex<HashMap<String, Route>>,
    hits: Mutex<HashMap<String, usize>>,
    requests: Mutex<Vec<HostRequest>>,
}

impl FakeDownloadHost {
    pub fn new<K: Into<String>>(routes: impl IntoIterator<Item = (K, Route)>) -> Arc<Self> {
        Arc::new(FakeDownloadHost {
            routes: Mutex::new(routes.into_iter().map(|(k, v)| (k.into(), v)).collect()),
            ..Default::default()
        })
    }

    /// Adds or replaces the answer for a URL.
    pub fn route(&self, url: impl Into<String>, route: Route) {
        self.routes.lock().insert(url.into(), route);
    }

    /// How many times this URL was asked for (0 when never: the JS `undefined`).
    pub fn hits(&self, url: &str) -> usize {
        self.hits.lock().get(url).copied().unwrap_or(0)
    }

    /// Every request, oldest first.
    pub fn requests(&self) -> Vec<HostRequest> {
        self.requests.lock().clone()
    }
}

fn body_stream(body: Bytes, chunk: usize, delay_ms: u64, fail_at: Option<usize>) -> crate::net::fetch::ByteStream {
    // (sent, finished)
    futures::stream::unfold((0usize, false), move |(sent, finished)| {
        let body = body.clone();
        async move {
            if finished {
                return None;
            }
            if delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            if let Some(at) = fail_at
                && sent >= at
            {
                // What a client sees when the other side closes mid-body.
                return Some((Err(FetchError::Body("other side closed".into())), (sent, true)));
            }
            if sent >= body.len() {
                return None;
            }
            let end = body.len().min(sent + chunk).min(fail_at.unwrap_or(usize::MAX));
            Some((Ok(body.slice(sent..end)), (end, false)))
        }
    })
    .boxed()
}

#[async_trait]
impl Fetch for FakeDownloadHost {
    async fn fetch(&self, request: FetchRequest) -> Result<FetchResponse, FetchError> {
        let url = request.url.clone();
        self.requests.lock().push(HostRequest {
            url: url.clone(),
            follow_redirects: request.follow_redirects,
            headers: request.headers.clone(),
        });
        let hit = {
            let mut hits = self.hits.lock();
            let n = hits.entry(url.clone()).or_insert(0);
            *n += 1;
            *n
        };
        let mut route = self.routes.lock().get(&url).cloned();
        if let Some(Route::Dynamic(f)) = route {
            route = Some(f(&url, hit));
        }
        let response = match route {
            None => FetchResponse::new(404, vec![], "Not Found"),
            Some(Route::Error(err)) => return Err(err),
            Some(Route::Redirect { to, status }) => FetchResponse::new(status, vec![("location".into(), to)], ""),
            Some(Route::Status { status, text, headers }) => FetchResponse::new(status, headers, text),
            Some(Route::Json(value)) => FetchResponse::json_body(200, &value),
            Some(Route::Body {
                body,
                chunk,
                delay_ms,
                fail_at,
                content_length,
                headers,
            }) => {
                let mut all = vec![(
                    "content-length".to_string(),
                    content_length.unwrap_or_else(|| body.len().to_string()),
                )];
                for (name, value) in headers {
                    all.retain(|(k, _)| !k.eq_ignore_ascii_case(&name));
                    all.push((name, value));
                }
                FetchResponse::from_stream(200, all, body_stream(body, chunk, delay_ms, fail_at))
            }
            Some(Route::Dynamic(_)) => FetchResponse::new(404, vec![], "Not Found"),
        };
        Ok(response.with_url(url))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn it_serves_chunks_redirects_errors_and_counts_hits() {
        let host = FakeDownloadHost::new([
            ("https://h.test/a", Route::body(vec![1u8; 10]).chunk(4)),
            ("https://h.test/r", Route::redirect("https://h.test/a")),
            ("https://h.test/j", Route::json(json!({"ok": true}))),
            ("https://h.test/s", Route::status(403, "no").header("x-why", "rate")),
            ("https://h.test/cut", Route::body(vec![2u8; 10]).chunk(3).fail_at(5)),
            (
                "https://h.test/d",
                Route::dynamic(|_, hit| Route::status(if hit == 1 { 500 } else { 200 }, "")),
            ),
        ]);
        let pieces: Vec<_> = host
            .fetch(FetchRequest::get("https://h.test/a"))
            .await
            .unwrap()
            .into_stream()
            .collect()
            .await;
        assert_eq!(
            pieces.iter().map(|p| p.as_ref().unwrap().len()).collect::<Vec<_>>(),
            [4, 4, 2]
        );

        let res = host
            .fetch(FetchRequest::get("https://h.test/r").no_redirects())
            .await
            .unwrap();
        assert_eq!((res.status, res.header("location")), (302, Some("https://h.test/a")));
        assert!(!host.requests()[1].follow_redirects);

        let res = host.fetch(FetchRequest::get("https://h.test/j")).await.unwrap();
        assert_eq!(res.json().await.unwrap(), json!({"ok": true}));
        let res = host.fetch(FetchRequest::get("https://h.test/s")).await.unwrap();
        assert_eq!((res.status, res.header("x-why")), (403, Some("rate")));

        let res = host.fetch(FetchRequest::get("https://h.test/cut")).await.unwrap();
        assert_eq!(res.header("content-length"), Some("10"));
        let pieces: Vec<_> = res.into_stream().collect().await;
        assert_eq!(pieces.len(), 3);
        assert_eq!(pieces[0].as_ref().unwrap().len() + pieces[1].as_ref().unwrap().len(), 5);
        assert!(matches!(pieces[2], Err(FetchError::Body(_))));

        assert_eq!(
            host.fetch(FetchRequest::get("https://h.test/d")).await.unwrap().status,
            500
        );
        assert_eq!(
            host.fetch(FetchRequest::get("https://h.test/d")).await.unwrap().status,
            200
        );
        assert_eq!(
            host.fetch(FetchRequest::get("https://h.test/none"))
                .await
                .unwrap()
                .status,
            404
        );
        assert_eq!(
            (host.hits("https://h.test/d"), host.hits("https://h.test/never")),
            (2, 0)
        );
    }
}
