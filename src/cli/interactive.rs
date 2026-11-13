//! Port of `src/cli/interactive.js`: `tarsee interactive`, a simple chat in the terminal with a running Tarsee.
//!
//! Each line typed is sent to the server's `/api/chat/send` and the reply is printed as it comes back. `/exit` or
//! `/quit`, the end of input (Ctrl+D) or Ctrl+C ends it.

use std::io::Write;
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

use crate::env::Env;
use crate::net::fetch::{Fetch, FetchError, FetchRequest};
use crate::util::js::{trim, truthy};

const PROMPT: &str = "you > ";

/// Runs the chat on the terminal (stdin and stdout) until it is ended.
pub async fn start_interactive(env: &Env, fetch: Arc<dyn Fetch>) -> std::io::Result<()> {
    let input = tokio::io::BufReader::new(tokio::io::stdin());
    tokio::select! {
        done = run(env, fetch, input, std::io::stdout()) => done,
        _ = tokio::signal::ctrl_c() => {
            let mut out = std::io::stdout();
            write!(out, "\nGoodbye!\n")?;
            out.flush()
        }
    }
}

/// The chat over any input and output (the terminal, or a test's).
pub async fn run<R, W>(env: &Env, fetch: Arc<dyn Fetch>, input: R, mut out: W) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: Write,
{
    let port = env
        .get("PORT")
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "3000".into());
    let token = env.get("TARSEE_API_TOKEN").unwrap_or_default();

    write!(out, "\n  Tarsee Interactive Mode\n")?;
    write!(out, "  Type your message and press Enter. Ctrl+C to exit.\n\n")?;
    write!(out, "{PROMPT}")?;
    out.flush()?;

    let mut lines = input.lines();
    while let Some(line) = lines.next_line().await? {
        let msg = trim(&line);
        if msg.is_empty() {
            write!(out, "{PROMPT}")?;
            out.flush()?;
            continue;
        }
        if msg == "/exit" || msg == "/quit" {
            break;
        }

        write!(out, "ai  > ")?;
        out.flush()?;
        let request = FetchRequest::post(format!("http://localhost:{port}/api/chat/send"))
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {token}"))
            .json(&json!({ "message": msg, "channelKey": "cli:interactive" }));
        let reply = match fetch.fetch(request).await {
            Ok(res) => res.text().await,
            Err(err) => Err(err),
        };
        match reply {
            Ok(text) => {
                for event in text.split('\n') {
                    let Some(data) = event.strip_prefix("data: ") else {
                        continue;
                    };
                    // A line that is not JSON is skipped.
                    let Ok(data) = serde_json::from_str::<Value>(data) else {
                        continue;
                    };
                    // process.stdout.write threw for anything but text, and the event was skipped.
                    if let Some(Value::String(content)) = data.get("content").filter(|c| truthy(c)) {
                        write!(out, "{content}")?;
                        out.flush()?;
                    }
                }
                write!(out, "\n\n")?;
            }
            Err(err) => write!(out, "Error: {}\n\n", error_message(&err))?,
        }
        write!(out, "{PROMPT}")?;
        out.flush()?;
    }

    write!(out, "\nGoodbye!\n")?;
    out.flush()
}

/// `err.message` as Node's fetch gave it: "fetch failed" when the server could not be reached.
fn error_message(err: &FetchError) -> String {
    match err {
        FetchError::Connect(_) => "fetch failed".into(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{Answer, FakeFetch};

    async fn chat(env: &Env, fetch: Arc<FakeFetch>, typed: &str) -> String {
        let mut out = Vec::new();
        run(env, fetch, typed.as_bytes(), &mut out).await.unwrap();
        String::from_utf8(out).unwrap()
    }

    #[tokio::test]
    async fn each_line_is_sent_and_the_reply_printed() {
        let env = Env::from_pairs([("TARSEE_API_TOKEN", "tok")]);
        let fetch = FakeFetch::new();
        fetch.respond(
            "http://localhost:3000/api/chat/send",
            Answer::sse([
                "event: start\ndata: {\"type\":\"start\"}\n\n",
                "data: {\"content\":\"Hel\"}\n\ndata: {\"content\":123}\n\ndata: {\"content\":{\"a\":1}}\n\ndata: {\"content\":\"lo!\"}\n\ndata: not json\n\ndata: {\"done\":true}\n\n",
            ]),
        );
        let shown = chat(&env, fetch.clone(), "  \n  hi there \n/quit\nnot sent\n").await;
        assert_eq!(
            shown,
            "\n  Tarsee Interactive Mode\n  Type your message and press Enter. Ctrl+C to exit.\n\nyou > you > ai  > Hello!\n\nyou > \nGoodbye!\n"
        );
        let calls = fetch.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].method, "POST");
        assert_eq!(calls[0].header("authorization"), Some("Bearer tok"));
        assert_eq!(calls[0].header("content-type"), Some("application/json"));
        assert_eq!(
            calls[0].json(),
            json!({"message": "hi there", "channelKey": "cli:interactive"})
        );
    }

    #[tokio::test]
    async fn an_unreachable_server_is_an_error_line_and_the_end_of_input_ends_it() {
        let env = Env::from_pairs([("PORT", "4100")]);
        let fetch = FakeFetch::new();
        let shown = chat(&env, fetch.clone(), "hello").await;
        assert_eq!(
            shown,
            "\n  Tarsee Interactive Mode\n  Type your message and press Enter. Ctrl+C to exit.\n\nyou > ai  > Error: fetch failed\n\nyou > \nGoodbye!\n"
        );
        assert_eq!(fetch.calls()[0].url, "http://localhost:4100/api/chat/send");
        assert_eq!(fetch.calls()[0].header("authorization"), Some("Bearer "));
    }
}
