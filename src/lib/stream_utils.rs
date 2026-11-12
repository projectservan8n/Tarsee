//! Port of `src/lib/stream-utils.js`: the helpers for server-sent events, and a short random id.
//!
//! In Express a handler wrote to `res` for as long as it liked. In axum a handler returns a `Response`, and what is
//! written afterwards has to come from somewhere else. So [`init_sse`] gives two things: the `Response` to return
//! (its headers are the JS ones, and go out at once), and an [`SseStream`], which is what the JS code did with `res`
//! from then on: [`send_sse`] writes an event to it, [`SseStream::end`] finishes the response, and it knows when
//! the browser has gone. The route hands the `SseStream` to the task that runs the turn and returns the `Response`.
//!
//! The frames are written by hand (`event: <name>\ndata: <json>\n\n`), byte for byte what the JS wrote: axum's own
//! `Sse` type would add keep-alive comments the JS never sent (its keep-alive is a `heartbeat` event, sent by the
//! route) and does not set the JS headers.

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::body::Body;
use axum::http::header::{CACHE_CONTROL, CONNECTION, CONTENT_TYPE, HeaderName};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use rand::Rng;
use serde::Serialize;
use tokio::sync::mpsc;

enum Frame {
    Data(Bytes),
    End,
}

struct Inner {
    frames: mpsc::UnboundedSender<Frame>,
    ended: AtomicBool,
}

/// The writing end of a server-sent event response: what the JS did with `res` after `initSSE(res)`. Clones write
/// to the same response.
#[derive(Clone)]
pub struct SseStream {
    inner: Arc<Inner>,
}

impl SseStream {
    /// `res.writableEnded`: [`end`](Self::end) was called.
    pub fn writable_ended(&self) -> bool {
        self.inner.ended.load(Ordering::SeqCst)
    }

    /// `res.destroyed`: the connection is gone (the browser left, or the response was finished and sent).
    pub fn destroyed(&self) -> bool {
        self.inner.frames.is_closed()
    }

    /// `res.write(text)`: text as it is. Nothing once the response has ended or the connection is gone. What is
    /// written while the browser is slow waits in memory, as Node buffered it.
    pub fn write(&self, text: impl Into<String>) {
        if self.writable_ended() || self.destroyed() {
            return;
        }
        // (the socket may have gone meanwhile: nothing to do about it)
        let _ = self.inner.frames.send(Frame::Data(Bytes::from(text.into())));
    }

    /// `res.end()`: finishes the response. Doing it twice is harmless.
    pub fn end(&self) {
        if !self.inner.ended.swap(true, Ordering::SeqCst) {
            let _ = self.inner.frames.send(Frame::End);
        }
    }

    /// Waits for the connection to go (`res.on("close", ...)`): the browser left, or the finished response has
    /// been sent.
    pub async fn closed(&self) {
        self.inner.frames.closed().await;
    }
}

/// Sends a Server-Sent Event to the response. No-op once the socket is gone — the generator may keep emitting
/// after the client tab freezes / reloads, and we want those calls to fall through silently instead of failing.
/// `data` is written as JSON.
pub fn send_sse<T: Serialize + ?Sized>(res: &SseStream, event: &str, data: &T) {
    if res.writable_ended() || res.destroyed() {
        return;
    }
    if let Ok(json) = serde_json::to_string(data) {
        res.write(format!("event: {event}\ndata: {json}\n\n"));
    }
}

/// Sets up a Server-Sent Events response: the `Response` to return from the handler (status 200 and the SSE
/// headers, sent as soon as it is returned) and the stream to write its events to.
pub fn init_sse() -> (SseStream, Response) {
    let (frames, mut queued) = mpsc::unbounded_channel();
    let body = futures::stream::poll_fn(move |cx| {
        queued.poll_recv(cx).map(|frame| match frame {
            Some(Frame::Data(bytes)) => Some(Ok::<_, Infallible>(bytes)),
            Some(Frame::End) | None => None,
        })
    });
    let mut response = Response::new(Body::from_stream(body));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(CONNECTION, HeaderValue::from_static("keep-alive"));
    // Disable nginx buffering
    headers.insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    let stream = SseStream {
        inner: Arc::new(Inner {
            frames,
            ended: AtomicBool::new(false),
        }),
    };
    (stream, response)
}

/// Generates a short random ID of lower-case letters and digits. The JS default length: 12.
pub fn random_id(length: usize) -> String {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut bytes = vec![0u8; length];
    rand::rng().fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|byte| CHARS[usize::from(*byte) % CHARS.len()] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use http_body_util::BodyExt;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[tokio::test]
    async fn events_go_out_byte_for_byte_as_the_js_wrote_them_under_the_js_headers() {
        let (sse, response) = init_sse();
        assert_eq!(response.status(), StatusCode::OK);
        let headers: Vec<(&str, &str)> = response
            .headers()
            .iter()
            .map(|(name, value)| (name.as_str(), value.to_str().unwrap()))
            .collect();
        assert_eq!(
            headers,
            [
                ("content-type", "text/event-stream"),
                ("cache-control", "no-cache"),
                ("connection", "keep-alive"),
                ("x-accel-buffering", "no"),
            ]
        );
        send_sse(&sse, "conversation", &json!({ "id": "c1" }));
        send_sse(
            &sse,
            "text",
            &json!({ "content": "line one\nline two — ünï 🐒 \"quoted\"" }),
        );
        send_sse(
            &sse,
            "heartbeat",
            &json!({ "ts": 1_794_472_200_000_i64, "queued": true }),
        );
        send_sse(
            &sse,
            "done",
            &json!({ "conversationId": "c1", "usage": {}, "stopReason": null }),
        );
        assert!(!sse.writable_ended());
        sse.end();
        assert!(sse.writable_ended());
        // After the end nothing more is written, and ending twice is harmless.
        send_sse(&sse, "text", &json!({ "content": "too late" }));
        sse.write("raw, too late");
        sse.end();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            String::from_utf8(body.to_vec()).unwrap(),
            "event: conversation\ndata: {\"id\":\"c1\"}\n\n\
             event: text\ndata: {\"content\":\"line one\\nline two — ünï 🐒 \\\"quoted\\\"\"}\n\n\
             event: heartbeat\ndata: {\"ts\":1794472200000,\"queued\":true}\n\n\
             event: done\ndata: {\"conversationId\":\"c1\",\"usage\":{},\"stopReason\":null}\n\n"
        );
    }

    #[tokio::test]
    async fn writing_after_the_browser_has_gone_does_nothing_and_the_route_can_tell_it_went() {
        let (sse, response) = init_sse();
        let writer = sse.clone();
        assert!(!sse.destroyed());
        send_sse(&sse, "text", &json!({ "content": "seen" }));
        // The connection closes: hyper drops the response and its body.
        drop(response);
        sse.closed().await;
        assert!(sse.destroyed());
        assert!(!sse.writable_ended(), "the handler never ended it");
        send_sse(&writer, "text", &json!({ "content": "into the void" }));
        writer.write("raw");
        writer.end();
        assert!(writer.writable_ended());
    }

    #[tokio::test]
    async fn a_finished_response_is_closed_once_it_has_been_sent() {
        let (sse, response) = init_sse();
        send_sse(&sse, "done", &json!({}));
        sse.end();
        assert!(!sse.destroyed(), "not sent yet");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"event: done\ndata: {}\n\n");
        sse.closed().await;
        assert!(sse.destroyed());
    }

    #[tokio::test]
    async fn events_are_written_in_order_whichever_clone_writes_them() {
        let (sse, response) = init_sse();
        let other = sse.clone();
        let writing = tokio::spawn(async move {
            for n in 0..50 {
                send_sse(if n % 2 == 0 { &sse } else { &other }, "n", &n);
                tokio::task::yield_now().await;
            }
            other.end();
        });
        let body = response.into_body().collect().await.unwrap().to_bytes();
        writing.await.unwrap();
        let expected: String = (0..50).map(|n| format!("event: n\ndata: {n}\n\n")).collect();
        assert_eq!(String::from_utf8(body.to_vec()).unwrap(), expected);
    }

    /// What the browser's reader (`public/js/api.js`) gets on the wire from a real connection: the headers at once,
    /// each event as soon as it is written, and the end of the response when the handler ends it.
    #[tokio::test]
    async fn over_a_real_connection_the_headers_go_out_at_once_and_each_event_as_it_is_written() {
        let (go_on, mut wait) = tokio::sync::mpsc::unbounded_channel::<()>();
        let (sse, response) = init_sse();
        let response = Arc::new(std::sync::Mutex::new(Some(response)));
        let router = axum::Router::new().route(
            "/send",
            axum::routing::get(move || {
                let response = response.lock().unwrap().take();
                async move { response.expect("asked once") }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let writer = tokio::spawn(async move {
            send_sse(&sse, "conversation", &json!({ "id": "c1" }));
            // The second event is not written until the test has read the first.
            wait.recv().await;
            send_sse(&sse, "done", &json!({ "conversationId": "c1" }));
            sse.end();
        });

        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket
            .write_all(b"GET /send HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut seen = Vec::new();
        let mut chunk = [0u8; 1024];
        let has = |seen: &[u8], text: &str| String::from_utf8_lossy(seen).contains(text);
        while !has(&seen, "data: {\"id\":\"c1\"}\n\n") {
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0, "the connection closed early");
            seen.extend_from_slice(&chunk[..n]);
        }
        let so_far = String::from_utf8_lossy(&seen).to_lowercase();
        assert!(so_far.starts_with("http/1.1 200 ok\r\n"), "{so_far}");
        for header in [
            "content-type: text/event-stream\r\n",
            "cache-control: no-cache\r\n",
            "connection: keep-alive\r\n",
            "x-accel-buffering: no\r\n",
            "transfer-encoding: chunked\r\n",
        ] {
            assert!(so_far.contains(header), "{header:?} in {so_far}");
        }
        assert!(
            !so_far.contains("event: done"),
            "the first event came before the second was written"
        );
        go_on.send(()).unwrap();
        // The end of a chunked response.
        while !has(&seen, "\r\n0\r\n\r\n") {
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0, "the connection closed early");
            seen.extend_from_slice(&chunk[..n]);
        }
        assert!(has(&seen, "event: done\ndata: {\"conversationId\":\"c1\"}\n\n"));
        writer.await.unwrap();
        server.abort();
    }

    #[test]
    fn a_random_id_is_lower_case_letters_and_digits_of_the_length_asked_for() {
        let id = random_id(12);
        assert_eq!(id.len(), 12);
        assert!(id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()), "{id}");
        assert_eq!(random_id(0), "");
        assert_eq!(random_id(40).len(), 40);
        assert_ne!(random_id(24), random_id(24));
        // Over many, every character turns up.
        let many = random_id(5000);
        for c in "abcdefghijklmnopqrstuvwxyz0123456789".chars() {
            assert!(many.contains(c), "{c}");
        }
    }
}
