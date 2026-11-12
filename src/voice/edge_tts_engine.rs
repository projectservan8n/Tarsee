//! Port of `src/voice/edge-tts-engine.js`: Microsoft's free text-to-speech service. No API key needed. No rate
//! limits. Good quality.
//!
//! The Node version used the npm library `node-edge-tts`, which speaks Edge's read-aloud WebSocket protocol. That
//! protocol is written out here. Tarsee's Node code pinned 1.2.10; by November 2026 the service answered that
//! version's address with HTTP 403 (checked by hand), and the library's 1.2.12 moved to a new address and a new
//! clock token. This port speaks 1.2.12's protocol, the one the service answers:
//!
//!   1. Connect to `wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1` with the query
//!      `Ocp-Apim-Subscription-Key=<token>&Sec-MS-GEC=<clock token>&Sec-MS-GEC-Version=2-<Chromium version>`, the
//!      Edge extension's Origin and a desktop Edge User-Agent ([`generate_sec_ms_gec_token_v2`] says how the clock
//!      token is made).
//!   2. Send the `speech.config` text message (the audio format), then the `ssml` message (the text, escaped, in a
//!      `<speak>` with the voice).
//!   3. Every binary message is a header (its length in the first two bytes, big-endian) and then audio; a text
//!      message with `Path:turn.end` ends the turn. Anything else (`turn.start`, `audio.metadata`) is ignored. The
//!      connection closing before the turn ends is an error at once.
//!
//! The library gave a request 10 seconds, the connection included; the engine gives each attempt 30 seconds in all
//! and tries three times.

use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message;

use super::speech_text::{collapse_spaces, js_trim, strip_emoji, strip_markdown};
use super::tts_interface::{SynthOptions, Synthesized, TtsEngine, TtsError, VoiceInfo};
use crate::util::js::now_ms;

const MAX_RETRIES: u32 = 3;
/// 30s per attempt: longer text needs more time.
const TTS_TIMEOUT: Duration = Duration::from_secs(30);

/// The voice used when none is set.
pub const DEFAULT_EDGE_VOICE: &str = "en-US-AndrewMultilingualNeural";

/// Where Edge's read-aloud service listens (node-edge-tts 1.2.12).
pub const EDGE_TTS_ENDPOINT: &str = "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1";

/// The Edge (Chromium) version the requests claim to come from.
pub const CHROMIUM_FULL_VERSION: &str = "143.0.3650.75";
/// The read-aloud extension's own token.
pub const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WINDOWS_FILE_TIME_EPOCH: i128 = 11_644_473_600;
const ORIGIN: &str = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";

/// The library's settings Tarsee never changed: the language tag of the `<speak>`, the audio format and the
/// prosody.
const LANG: &str = "zh-CN";
const OUTPUT_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";
const PROSODY: &str = "default";
/// The library's own limit on one request, the connection included.
const TURN_TIMEOUT: Duration = Duration::from_secs(10);

/// What the second token is salted with (the library keeps it in base64).
const TOKEN_PREFIX: &[u8] = b"Copyright (C) Microsoft Corporation. All rights reserved.";

/// The multipliers and offsets of the second token's 64-bit checksum.
const COEFFICIENTS: [(u32, u32); 14] = [
    (0xE82E91B1, 0xB32700D0),
    (0x44DE24C6, 0x88DFF51D),
    (0x3BEB65BC, 0x29514038),
    (0xC89C5933, 0xB328CBDF),
    (0x8D1EC211, 0xD405B4D5),
    (0x314EF5D5, 0x26E55F3C),
    (0xE92491B1, 0x607801C6),
    (0xF0A5B9D5, 0x82B2C1FB),
    (0x06064CF3, 0xFA51A3DA),
    (0xDA79FA60, 0x207CC464),
    (0xBED20560, 0x3C3C74F3),
    (0x89F9C9F8, 0xD2D14B61),
    (0x35FA38C6, 0xBB04A2C1),
    (0xCB49E3C6, 0xC5626167),
];

/// `Math.imul`, as bits.
fn mul(a: u32, b: u32) -> u32 {
    a.wrapping_mul(b)
}

fn rol16(x: u32) -> u32 {
    x.rotate_left(16)
}

fn le32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// The library's `cs64Digest`: a 64-bit checksum of `data`, keyed by its sha256. The JavaScript worked in 32-bit
/// integers (`Math.imul`, `>>> 0`); every sum here wraps the same way.
fn cs64_digest(data: &[u8], sha: &[u8]) -> [u8; 8] {
    let key_a = le32(sha, 0) | 1;
    let key_b = le32(sha, 4) | 1;
    let factors = [mul(key_a, 0x82893933), mul(key_b, 0x82893933)];
    let mut terms: Vec<u32> = COEFFICIENTS
        .iter()
        .enumerate()
        .map(|(i, (coefficient, _))| mul(*coefficient, factors[i % 2]))
        .collect();
    let mut offsets: Vec<u32> = COEFFICIENTS.iter().map(|(_, offset)| *offset).collect();
    let mut padded = vec![0u8; (data.len() + 1).div_ceil(8) * 8];
    padded[1..=data.len()].copy_from_slice(data);
    for i in 0..padded.len() / 4 {
        let word = le32(&padded, i * 4);
        let even = i % 2 == 0;
        let mut term = mul(word, if even { key_a } else { key_b });
        let mut offset = mul(rol16(word), if even { 0xEF0569FB } else { 0xC31713DB });
        if i == 0 {
            term = term.wrapping_add(mul(0xF2F90B1A, factors[0]));
            offset = offset.wrapping_add(0x0B1A0000);
        }
        terms.push(term);
        offsets.push(offset);
    }
    let (mut swap_acc, mut swap_last, mut state, mut acc) = (0u32, 0u32, 0u32, 0u32);
    for i in (0..terms.len()).step_by(2) {
        let (x, y) = (terms[i], terms[i + 1]);
        let q = mul(rol16(offsets[i].wrapping_add(x)), 0x76F50F34);
        swap_acc = swap_acc.wrapping_add(mul(rol16(q), 0xC3EFEA97).wrapping_add(q));
        let q = mul(rol16(offsets[i + 1].wrapping_add(y)), 0x1881CE3C);
        swap_last = mul(rol16(q), 0x35BD1EC9).wrapping_add(q);
        swap_acc = swap_acc.wrapping_add(swap_last);
        state = mul(state, key_a).wrapping_add(x);
        for k in [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83] {
            state = mul(rol16(state), k);
        }
        acc = acc.wrapping_add(state);
        let mut t = mul(state, key_b).wrapping_add(y);
        t = mul(rol16(t), 0xA27416F5);
        t = mul(rol16(t), 0xD38396FF);
        state = mul(rol16(mul(rol16(t), 0x7C932B89)), 0xBFA49F69);
        acc = acc.wrapping_add(state);
    }
    let mut out = [0u8; 8];
    out[..4].copy_from_slice(&(swap_last ^ state).to_le_bytes());
    out[4..].copy_from_slice(&(swap_acc ^ acc).to_le_bytes());
    out
}

/// The `Sec-MS-GEC` token (version 2) for the moment `unix_seconds`: the time in Windows file-time seconds rounded
/// down to the 5 minutes, as ticks (100 ns), followed by the trusted client token; its sha256 (salted with
/// [`TOKEN_PREFIX`]) and a 64-bit checksum of it, both in upper-case hex: `<checksum>-<sha256>`.
pub fn generate_sec_ms_gec_token_v2(unix_seconds: f64) -> String {
    let epoch_seconds = unix_seconds.floor() as i128 + WINDOWS_FILE_TIME_EPOCH;
    let rounded = epoch_seconds - epoch_seconds % 300;
    let data = format!("{}{TRUSTED_CLIENT_TOKEN}", rounded * 10_000_000);
    let sha = Sha256::new()
        .chain_update(TOKEN_PREFIX)
        .chain_update(data.as_bytes())
        .finalize();
    let checksum = cs64_digest(data.as_bytes(), &sha);
    format!("{}-{}", hex::encode_upper(checksum), hex::encode_upper(sha))
}

/// The User-Agent of a desktop Edge of that version.
fn user_agent() -> String {
    let major = CHROMIUM_FULL_VERSION.split('.').next().unwrap_or("");
    format!(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36 Edg/{major}.0.0.0"
    )
}

/// The address with its query, for the moment `now_ms` (milliseconds since 1970).
pub fn connect_url(endpoint: &str, now_ms: i64) -> String {
    format!(
        "{endpoint}?Ocp-Apim-Subscription-Key={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version=2-{CHROMIUM_FULL_VERSION}",
        generate_sec_ms_gec_token_v2(now_ms as f64 / 1000.0)
    )
}

fn escape_xml(unsafe_text: &str) -> String {
    let mut out = String::with_capacity(unsafe_text.len());
    for c in unsafe_text.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
    out
}

/// The first message: the audio format, and which events to send back (`JSON.stringify` of the settings).
pub fn speech_config_message() -> String {
    let settings = serde_json::json!({
        "context": {
            "synthesis": {
                "audio": {
                    "metadataoptions": { "sentenceBoundaryEnabled": "false", "wordBoundaryEnabled": "true" },
                    "outputFormat": OUTPUT_FORMAT,
                }
            }
        }
    });
    format!("Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{settings}")
}

/// The second message: the text to speak, with its voice.
pub fn ssml_message(request_id: &str, voice: &str, text: &str) -> String {
    format!(
        "X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" xmlns:mstts=\"https://www.w3.org/2001/mstts\" xml:lang=\"{LANG}\">
          <voice name=\"{voice}\">
            <prosody rate=\"{PROSODY}\" pitch=\"{PROSODY}\" volume=\"{PROSODY}\">
              {}
            </prosody>
          </voice>
        </speak>",
        escape_xml(text)
    )
}

/// The audio in a binary message: what follows its header, whose length is in the first two bytes.
pub fn audio_payload(data: &[u8]) -> Result<&[u8], TtsError> {
    if data.len() < 2 {
        return Err(TtsError::new("Invalid audio frame header"));
    }
    let offset = usize::from(u16::from_be_bytes([data[0], data[1]])) + 2;
    if offset > data.len() {
        return Err(TtsError::new("Invalid audio frame header length"));
    }
    Ok(&data[offset..])
}

fn random_hex(bytes: usize) -> String {
    use rand::Rng;
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

/// The connection error in the words the Node library (`ws`) used where they differ.
fn connect_error(err: tungstenite::Error) -> TtsError {
    match err {
        tungstenite::Error::Http(response) => {
            TtsError::new(format!("Unexpected server response: {}", response.status().as_u16()))
        }
        other => TtsError::new(other.to_string()),
    }
}

/// The Edge TTS engine.
pub struct EdgeTtsEngine {
    default_voice: String,
    endpoint: String,
    attempt_timeout: Duration,
    turn_timeout: Duration,
    retry_delay: Duration,
    clock: fn() -> i64,
}

impl EdgeTtsEngine {
    /// `voice`: the default voice (`None` or empty: Andrew).
    pub fn new(voice: Option<&str>) -> Self {
        EdgeTtsEngine {
            default_voice: voice
                .filter(|v| !v.is_empty())
                .unwrap_or(DEFAULT_EDGE_VOICE)
                .to_string(),
            endpoint: EDGE_TTS_ENDPOINT.to_string(),
            attempt_timeout: TTS_TIMEOUT,
            turn_timeout: TURN_TIMEOUT,
            retry_delay: Duration::from_millis(500),
            clock: now_ms,
        }
    }

    /// Talks to another address (a test's fake server).
    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = endpoint.into();
        self
    }

    /// Shorter limits for tests: each attempt in all, and one turn once connected.
    pub fn with_timeouts(mut self, attempt: Duration, turn: Duration) -> Self {
        self.attempt_timeout = attempt;
        self.turn_timeout = turn;
        self
    }

    /// The pause before the second attempt (twice that before the third).
    pub fn with_retry_delay(mut self, delay: Duration) -> Self {
        self.retry_delay = delay;
        self
    }

    /// The clock the `Sec-MS-GEC` token is made from (milliseconds since 1970).
    pub fn with_clock(mut self, clock: fn() -> i64) -> Self {
        self.clock = clock;
        self
    }

    /// One turn: connect, send the config and the text, collect the audio until `turn.end`. The library's limit
    /// (`turn_timeout`) covers the connection and then what is left of it the turn.
    async fn tts_once(&self, text: &str, voice: &str) -> Result<Vec<u8>, TtsError> {
        let started = tokio::time::Instant::now();
        let url = connect_url(&self.endpoint, (self.clock)());
        let mut request = url.as_str().into_client_request().map_err(connect_error)?;
        let headers = request.headers_mut();
        for (name, value) in [
            ("Pragma", "no-cache".to_string()),
            ("Cache-Control", "no-cache".to_string()),
            ("User-Agent", user_agent()),
            ("Accept-Encoding", "gzip, deflate, br, zstd".to_string()),
            ("Accept-Language", "en-US,en;q=0.9".to_string()),
            ("Origin", ORIGIN.to_string()),
        ] {
            if let Ok(value) = HeaderValue::from_str(&value) {
                headers.insert(name, value);
            }
        }
        // `wss://` goes through rustls with the webpki roots and the process's TLS backend (`net::install_crypto_provider`,
        // which `main` calls). No `permessage-deflate` is offered, though `ws` offered it: tungstenite cannot take
        // compressed frames, and the service answers without it (checked by hand against the real one).
        let connect = tokio_tungstenite::connect_async_tls_with_config(request, None, false, None);
        let (mut ws, _) = match tokio::time::timeout(self.turn_timeout, connect).await {
            Err(_) => return Err(TtsError::new("Timed out while connecting to Edge TTS")),
            Ok(connected) => connected.map_err(connect_error)?,
        };

        let turn = async {
            let mut audio = Vec::new();
            let sent = |err: tungstenite::Error| TtsError::new(err.to_string());
            ws.send(Message::Text(speech_config_message().into()))
                .await
                .map_err(sent)?;
            ws.send(Message::Text(ssml_message(&random_hex(16), voice, text).into()))
                .await
                .map_err(sent)?;
            loop {
                match ws.next().await {
                    Some(Ok(Message::Binary(data))) => audio.extend_from_slice(audio_payload(&data)?),
                    Some(Ok(Message::Text(message))) => {
                        if message.as_str().contains("Path:turn.end") {
                            return Ok::<Vec<u8>, TtsError>(audio);
                        }
                        // Path:audio.metadata (word boundaries for subtitles), Path:turn.start: not used.
                    }
                    Some(Ok(Message::Close(frame))) => {
                        // `ws` reports 1005 for a close without a status.
                        let code = frame.map(|f| u16::from(f.code)).unwrap_or(1005);
                        return Err(TtsError::new(format!("WebSocket closed before turn.end (code {code})")));
                    }
                    Some(Ok(_)) => {}
                    // Gone without a close frame: `ws` closes with 1006, and says nothing else.
                    Some(Err(tungstenite::Error::Protocol(
                        tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
                    )))
                    | Some(Err(tungstenite::Error::ConnectionClosed))
                    | None => {
                        return Err(TtsError::new("WebSocket closed before turn.end (code 1006)"));
                    }
                    Some(Err(err)) => return Err(TtsError::new(err.to_string())),
                }
            }
        };
        let left = self.turn_timeout.saturating_sub(started.elapsed());
        let audio = tokio::time::timeout(left, turn)
            .await
            .map_err(|_| TtsError::new("Timed out waiting for Edge TTS"))??;
        let _ = ws.close(None).await;
        Ok(audio)
    }
}

#[async_trait]
impl TtsEngine for EdgeTtsEngine {
    fn name(&self) -> &str {
        "edge-tts"
    }

    fn default_voice(&self) -> Option<String> {
        Some(self.default_voice.clone())
    }

    async fn is_available(&self) -> bool {
        // The Node version checked that the library could be loaded; the protocol is built in here.
        true
    }

    async fn synthesize(
        &self,
        text: &str,
        voice_id: Option<&str>,
        _opts: &SynthOptions,
    ) -> Result<Synthesized, TtsError> {
        if text.is_empty() {
            return Err(TtsError::new("Text is required"));
        }

        // Strip emojis: Edge TTS reads them aloud as descriptions. The class deliberately includes the ZWJ and
        // variation selectors as bare members: we are deleting every codepoint of a sequence, not matching the
        // sequence as one grapheme, so splitting it apart is the desired result.
        let text = js_trim(&collapse_spaces(&strip_emoji(text))).to_string();
        if text.is_empty() {
            return Err(TtsError::new("No speakable text after stripping emojis"));
        }

        // Strip markdown artifacts that sound bad when spoken.
        let text = strip_markdown(&text);
        if text.is_empty() {
            return Err(TtsError::new("No speakable text after cleanup"));
        }

        let voice = voice_id
            .filter(|v| !v.is_empty())
            .unwrap_or(&self.default_voice)
            .to_string();

        // Retry loop: the Edge TTS WebSocket can drop.
        let mut last_error = TtsError::new("Edge TTS failed after retries");
        for attempt in 1..=MAX_RETRIES {
            let result = match tokio::time::timeout(self.attempt_timeout, self.tts_once(&text, &voice)).await {
                Err(_) => Err(TtsError::new(format!(
                    "TTS timed out (attempt {attempt}/{MAX_RETRIES})"
                ))),
                Ok(Err(err)) => Err(err),
                Ok(Ok(audio)) if audio.len() < 100 => Err(TtsError::new("Generated audio too small — likely empty")),
                Ok(Ok(audio)) => Ok(audio),
            };
            match result {
                Ok(audio) => {
                    return Ok(Synthesized {
                        audio: Bytes::from(audio),
                        content_type: "audio/mpeg".into(),
                    });
                }
                Err(err) => {
                    log::warn!("[edge-tts] attempt {attempt}/{MAX_RETRIES} failed: {}", err.message);
                    last_error = err;
                    if attempt < MAX_RETRIES {
                        tokio::time::sleep(self.retry_delay * attempt).await;
                    }
                }
            }
        }
        Err(last_error)
    }

    async fn list_voices(&self) -> Result<Vec<VoiceInfo>, TtsError> {
        Ok([
            // US English
            ("en-US-AndrewMultilingualNeural", "Andrew (US)"),
            ("en-US-AvaMultilingualNeural", "Ava (US)"),
            ("en-US-BrianMultilingualNeural", "Brian (US)"),
            ("en-US-EmmaMultilingualNeural", "Emma (US)"),
            ("en-US-ChristopherNeural", "Christopher (US)"),
            ("en-US-JennyNeural", "Jenny (US)"),
            ("en-US-GuyNeural", "Guy (US)"),
            ("en-US-AriaNeural", "Aria (US)"),
            ("en-US-DavisNeural", "Davis (US)"),
            // UK English
            ("en-GB-SoniaNeural", "Sonia (UK)"),
            ("en-GB-RyanNeural", "Ryan (UK)"),
            ("en-GB-LibbyNeural", "Libby (UK)"),
            // Australian
            ("en-AU-NatashaNeural", "Natasha (AU)"),
            ("en-AU-WilliamNeural", "William (AU)"),
            // Philippine
            ("en-PH-JamesNeural", "James (PH)"),
            ("en-PH-RosaNeural", "Rosa (PH)"),
            // Multilingual (multiple languages with same voice)
            ("en-US-AlloyMultilingualNeural", "Alloy (Multilingual)"),
            ("en-US-NovaMultilingualNeural", "Nova (Multilingual)"),
            ("en-US-ShimmerMultilingualNeural", "Shimmer (Multilingual)"),
        ]
        .into_iter()
        .map(|(id, name)| VoiceInfo::new(id, name))
        .collect())
    }
}

#[cfg(test)]
mod tests {
    //! The Node code had no tests of its own here (the library did the talking). These play Edge's side of the
    //! protocol on a local socket and check every message against what node-edge-tts 1.2.12 sends.

    use super::*;
    use parking_lot::Mutex;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

    /// What the library sends for "Tom & Jerry <3 'q' \"dq\"" with the default voice, the request id aside
    /// (node-edge-tts 1.2.12, `streamAudio`: the settings through `JSON.stringify`, the SSML template as written).
    const NODE_CONFIG: &str = "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}";
    const NODE_SSML_AFTER_ID: &str = "\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" xmlns:mstts=\"https://www.w3.org/2001/mstts\" xml:lang=\"zh-CN\">\n          <voice name=\"en-US-AndrewMultilingualNeural\">\n            <prosody rate=\"default\" pitch=\"default\" volume=\"default\">\n              Tom &amp; Jerry &lt;3 &apos;q&apos; &quot;dq&quot;\n            </prosody>\n          </voice>\n        </speak>";

    /// A moment and the token the library made for it (`generateSecMsGecToken_V2(1794472200.123)`).
    const FIXED_MS: i64 = 1_794_472_200_123;
    const FIXED_TOKEN: &str = "07073521B65B7503-3E9681857C93B70C671C514C3CE3AFC1C5EE48CB6D825AC3987768454BB94491";

    fn fixed_clock() -> i64 {
        FIXED_MS
    }

    #[derive(Clone)]
    enum Frame {
        Text(String),
        Binary(Vec<u8>),
        /// Close the connection with a close frame (no status).
        Close,
        /// Drop the connection without a close frame.
        Drop,
    }

    #[derive(Clone)]
    enum Plan {
        /// Read the two messages, then send these frames and wait.
        Reply(Vec<Frame>),
        /// Read the two messages and never answer.
        Silent,
        /// Turn the handshake away with this status.
        Refuse(u16),
        /// Take the connection and never answer the handshake.
        NoHandshake,
    }

    #[derive(Debug, Clone, Default)]
    struct Seen {
        uri: String,
        headers: Vec<(String, String)>,
        messages: Vec<String>,
    }

    impl Seen {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }
    }

    struct FakeEdge {
        endpoint: String,
        seen: Arc<Mutex<Vec<Seen>>>,
        connections: Arc<AtomicUsize>,
    }

    /// A binary audio message as the service sends it: the header's length in two bytes, the header, the audio.
    fn audio_frame(audio: &[u8]) -> Vec<u8> {
        let header = b"X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nX-StreamId:1\r\nPath:audio\r\n";
        let mut out = (header.len() as u16).to_be_bytes().to_vec();
        out.extend_from_slice(header);
        out.extend_from_slice(audio);
        out
    }

    fn turn_end() -> Frame {
        Frame::Text("X-RequestId:abc\r\nPath:turn.end\r\n\r\n{}".into())
    }

    /// Edge's side: each connection (numbered from 1) follows `plan(n)`.
    #[allow(clippy::result_large_err)] // the handshake callback's error type is tungstenite's own
    async fn fake_edge(plan: impl Fn(usize) -> Plan + Send + Sync + 'static) -> FakeEdge {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "ws://{}/tts/cognitiveservices/websocket/v1",
            listener.local_addr().unwrap()
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let plan = Arc::new(plan);
        let (seen2, connections2) = (seen.clone(), connections.clone());
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else { return };
                let n = connections2.fetch_add(1, Ordering::SeqCst) + 1;
                let plan = plan(n);
                let seen = seen2.clone();
                tokio::spawn(async move {
                    if let Plan::NoHandshake = plan {
                        // Hold the socket, say nothing.
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        drop(tcp);
                        return;
                    }
                    let record = Arc::new(Mutex::new(Seen::default()));
                    let r = record.clone();
                    let refuse = if let Plan::Refuse(status) = plan {
                        Some(status)
                    } else {
                        None
                    };
                    let callback = move |req: &Request, res: Response| -> Result<Response, ErrorResponse> {
                        let mut r = r.lock();
                        r.uri = req.uri().to_string();
                        r.headers = req
                            .headers()
                            .iter()
                            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                            .collect();
                        match refuse {
                            Some(status) => Err(tungstenite::http::Response::builder()
                                .status(status)
                                .body(Some("no".into()))
                                .unwrap()),
                            None => Ok(res),
                        }
                    };
                    let accepted = tokio_tungstenite::accept_hdr_async(tcp, callback).await;
                    let Ok(mut ws) = accepted else {
                        seen.lock().push(record.lock().clone());
                        return;
                    };
                    while record.lock().messages.len() < 2 {
                        match ws.next().await {
                            Some(Ok(Message::Text(t))) => record.lock().messages.push(t.as_str().to_string()),
                            Some(Ok(_)) => {}
                            _ => break,
                        }
                    }
                    seen.lock().push(record.lock().clone());
                    match plan {
                        Plan::Reply(frames) => {
                            for frame in frames {
                                let sent = match frame {
                                    Frame::Text(t) => ws.send(Message::Text(t.into())).await,
                                    Frame::Binary(b) => ws.send(Message::Binary(b.into())).await,
                                    Frame::Close => {
                                        let _ = ws.close(None).await;
                                        return;
                                    }
                                    Frame::Drop => return,
                                };
                                if sent.is_err() {
                                    return;
                                }
                            }
                            while let Some(Ok(_)) = ws.next().await {}
                        }
                        Plan::Silent => while let Some(Ok(_)) = ws.next().await {},
                        Plan::Refuse(_) | Plan::NoHandshake => {}
                    }
                });
            }
        });
        FakeEdge {
            endpoint,
            seen,
            connections,
        }
    }

    fn engine(fake: &FakeEdge) -> EdgeTtsEngine {
        EdgeTtsEngine::new(None)
            .with_endpoint(fake.endpoint.clone())
            .with_clock(fixed_clock)
            .with_retry_delay(Duration::from_millis(1))
    }

    async fn speak(engine: &EdgeTtsEngine, text: &str) -> Result<Synthesized, TtsError> {
        engine.synthesize(text, None, &SynthOptions::default()).await
    }

    #[tokio::test]
    async fn a_turn_sends_what_the_library_sends_and_gives_the_audio_of_every_binary_message() {
        let first = vec![1u8; 150];
        let second = vec![2u8; 80];
        let fake = fake_edge({
            let (first, second) = (first.clone(), second.clone());
            move |_| {
                Plan::Reply(vec![
                    Frame::Text("X-RequestId:abc\r\nPath:turn.start\r\n\r\n{}".into()),
                    Frame::Binary(audio_frame(&first)),
                    Frame::Text("X-RequestId:abc\r\nPath:audio.metadata\r\n\r\n{\"Metadata\":[]}".into()),
                    Frame::Binary(audio_frame(&[])),
                    Frame::Binary(audio_frame(&second)),
                    turn_end(),
                ])
            }
        })
        .await;
        let out = speak(&engine(&fake), "Tom & Jerry <3 'q' \"dq\"").await.unwrap();
        assert_eq!(out.content_type, "audio/mpeg");
        assert_eq!(out.audio.to_vec(), [first, second].concat());

        let seen = fake.seen.lock()[0].clone();
        assert_eq!(
            seen.uri,
            format!(
                "/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=6A5AA1D4EAFF4E9FB37E23D68491D6F4&Sec-MS-GEC={FIXED_TOKEN}&Sec-MS-GEC-Version=2-143.0.3650.75"
            )
        );
        assert_eq!(
            seen.header("origin"),
            Some("chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
        );
        assert_eq!(
            seen.header("user-agent"),
            Some(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
            )
        );
        assert_eq!(seen.header("pragma"), Some("no-cache"));
        assert_eq!(seen.header("cache-control"), Some("no-cache"));
        assert_eq!(seen.header("accept-encoding"), Some("gzip, deflate, br, zstd"));
        assert_eq!(seen.header("accept-language"), Some("en-US,en;q=0.9"));
        assert_eq!(
            seen.header("sec-websocket-extensions"),
            None,
            "no permessage-deflate: tungstenite cannot read compressed frames"
        );
        assert_eq!(seen.messages[0], NODE_CONFIG);
        let ssml = &seen.messages[1];
        let id = ssml
            .strip_prefix("X-RequestId:")
            .and_then(|rest| rest.split("\r\n").next())
            .unwrap();
        assert!(id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit()), "{id}");
        assert_eq!(&ssml[format!("X-RequestId:{id}").len()..], NODE_SSML_AFTER_ID);
        assert_eq!(fake.connections.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_voice_asked_for_is_used_else_the_default() {
        let fake = fake_edge(|_| Plan::Reply(vec![Frame::Binary(audio_frame(&[9u8; 120])), turn_end()])).await;
        let edge = engine(&fake);
        edge.synthesize("hello", Some("en-GB-RyanNeural"), &SynthOptions::default())
            .await
            .unwrap();
        edge.synthesize("hello", Some(""), &SynthOptions::default())
            .await
            .unwrap();
        let custom = EdgeTtsEngine::new(Some("en-PH-RosaNeural"))
            .with_endpoint(fake.endpoint.clone())
            .with_clock(fixed_clock);
        custom
            .synthesize("hello", None, &SynthOptions::default())
            .await
            .unwrap();
        let seen = fake.seen.lock().clone();
        assert!(seen[0].messages[1].contains("<voice name=\"en-GB-RyanNeural\">"));
        assert!(seen[1].messages[1].contains("<voice name=\"en-US-AndrewMultilingualNeural\">"));
        assert!(seen[2].messages[1].contains("<voice name=\"en-PH-RosaNeural\">"));
        assert_eq!(custom.default_voice().as_deref(), Some("en-PH-RosaNeural"));
        assert_eq!(
            EdgeTtsEngine::new(Some("")).default_voice().as_deref(),
            Some(DEFAULT_EDGE_VOICE)
        );
    }

    #[tokio::test]
    async fn a_connection_that_closes_before_the_turn_ends_fails_at_once_and_is_tried_again() {
        let fake = fake_edge(|n| {
            if n == 1 {
                Plan::Reply(vec![Frame::Binary(audio_frame(&[1u8; 200])), Frame::Close])
            } else {
                Plan::Reply(vec![Frame::Binary(audio_frame(&[3u8; 120])), turn_end()])
            }
        })
        .await;
        let started = std::time::Instant::now();
        let out = speak(&engine(&fake), "hello").await.unwrap();
        assert_eq!(
            out.audio.to_vec(),
            vec![3u8; 120],
            "nothing of the dropped attempt is kept"
        );
        assert_eq!(fake.connections.load(Ordering::SeqCst), 2);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "no waiting out the 10 seconds"
        );
    }

    #[tokio::test]
    async fn a_close_or_a_drop_before_the_turn_ends_says_how_it_closed() {
        let closes = fake_edge(|_| Plan::Reply(vec![Frame::Binary(audio_frame(&[1u8; 200])), Frame::Close])).await;
        assert_eq!(
            speak(&engine(&closes), "hello").await.unwrap_err().message,
            "WebSocket closed before turn.end (code 1005)"
        );
        let drops = fake_edge(|_| Plan::Reply(vec![Frame::Binary(audio_frame(&[1u8; 200])), Frame::Drop])).await;
        assert_eq!(
            speak(&engine(&drops), "hello").await.unwrap_err().message,
            "WebSocket closed before turn.end (code 1006)"
        );
    }

    #[tokio::test]
    async fn a_damaged_audio_frame_ends_the_turn() {
        let short = fake_edge(|_| Plan::Reply(vec![Frame::Binary(vec![0]), turn_end()])).await;
        assert_eq!(
            speak(&engine(&short), "hello").await.unwrap_err().message,
            "Invalid audio frame header"
        );
        let long = fake_edge(|_| Plan::Reply(vec![Frame::Binary(vec![0, 9, 1, 2]), turn_end()])).await;
        assert_eq!(
            speak(&engine(&long), "hello").await.unwrap_err().message,
            "Invalid audio frame header length"
        );
    }

    #[tokio::test]
    async fn audio_too_small_fails_after_three_attempts() {
        let fake = fake_edge(|_| Plan::Reply(vec![Frame::Binary(audio_frame(&[1u8; 99])), turn_end()])).await;
        let err = speak(&engine(&fake), "hello").await.unwrap_err();
        assert_eq!(err.message, "Generated audio too small — likely empty");
        assert_eq!(fake.connections.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_silent_service_runs_out_the_request_or_the_attempt() {
        let fake = fake_edge(|_| Plan::Silent).await;
        let err = speak(
            &engine(&fake).with_timeouts(Duration::from_secs(10), Duration::from_millis(100)),
            "hello",
        )
        .await
        .unwrap_err();
        assert_eq!(err.message, "Timed out waiting for Edge TTS", "the library's own limit");
        let err = speak(
            &engine(&fake).with_timeouts(Duration::from_millis(100), Duration::from_secs(10)),
            "hello",
        )
        .await
        .unwrap_err();
        assert_eq!(err.message, "TTS timed out (attempt 3/3)");
        assert_eq!(fake.connections.load(Ordering::SeqCst), 6);

        let mute = fake_edge(|_| Plan::NoHandshake).await;
        let err = speak(
            &engine(&mute).with_timeouts(Duration::from_secs(10), Duration::from_millis(100)),
            "hello",
        )
        .await
        .unwrap_err();
        assert_eq!(err.message, "Timed out while connecting to Edge TTS");
    }

    #[tokio::test]
    async fn a_refused_handshake_says_what_the_server_answered() {
        let fake = fake_edge(|_| Plan::Refuse(403)).await;
        let err = speak(&engine(&fake), "hello").await.unwrap_err();
        assert_eq!(err.message, "Unexpected server response: 403");
        assert_eq!(fake.connections.load(Ordering::SeqCst), 3);
        // Nothing listening at all.
        let edge = EdgeTtsEngine::new(None)
            .with_endpoint("ws://127.0.0.1:1/x")
            .with_timeouts(Duration::from_millis(300), Duration::from_millis(300))
            .with_retry_delay(Duration::from_millis(1));
        assert!(speak(&edge, "hello").await.is_err());
    }

    #[tokio::test]
    async fn text_with_nothing_to_say_is_refused_before_connecting() {
        let fake = fake_edge(|_| Plan::Silent).await;
        let edge = engine(&fake);
        assert_eq!(speak(&edge, "").await.unwrap_err().message, "Text is required");
        assert_eq!(
            speak(&edge, "😀 👍🏽 ").await.unwrap_err().message,
            "No speakable text after stripping emojis"
        );
        assert_eq!(
            speak(&edge, "```\ncode\n``` **").await.unwrap_err().message,
            "No speakable text after cleanup"
        );
        assert_eq!(fake.connections.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn markdown_and_emoji_are_not_spoken() {
        let fake = fake_edge(|_| Plan::Reply(vec![Frame::Binary(audio_frame(&[1u8; 100])), turn_end()])).await;
        speak(&engine(&fake), "**Hi** 😀 see [docs](http://x)\n\nok `x`")
            .await
            .unwrap();
        let ssml = fake.seen.lock()[0].messages[1].clone();
        // The paragraph break goes with the first collapse of spaces, before the markdown step, as in Node.
        assert!(ssml.contains("\n              Hi see docs ok\n"), "{ssml}");
    }

    #[test]
    fn the_clock_token_matches_the_library() {
        // Values from node-edge-tts 1.2.12's generateSecMsGecToken_V2 for these moments (in seconds).
        let token = |ms: i64| generate_sec_ms_gec_token_v2(ms as f64 / 1000.0);
        assert_eq!(token(FIXED_MS), FIXED_TOKEN);
        assert_eq!(token(1_794_472_499_999), FIXED_TOKEN, "the same 5 minutes");
        assert_eq!(
            token(1_794_472_500_000),
            "42CD87A913DD203F-25325919676A732A78141D2AE5AFCB6EDD531AE091B9CFB7815DFC4D6FFCBFDD"
        );
        assert_eq!(
            token(1_700_000_000_000),
            "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2"
        );
        assert_eq!(
            token(0),
            "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6"
        );
        assert_eq!(
            connect_url(EDGE_TTS_ENDPOINT, FIXED_MS),
            format!(
                "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=6A5AA1D4EAFF4E9FB37E23D68491D6F4&Sec-MS-GEC={FIXED_TOKEN}&Sec-MS-GEC-Version=2-143.0.3650.75"
            )
        );
        // The salt is the library's base64 text, decoded.
        use base64::Engine;
        let salt = base64::engine::general_purpose::STANDARD
            .decode("Q29weXJpZ2h0IChDKSBNaWNyb3NvZnQgQ29ycG9yYXRpb24uIEFsbCByaWdodHMgcmVzZXJ2ZWQu")
            .unwrap();
        assert_eq!(salt, TOKEN_PREFIX);
    }

    #[test]
    fn the_audio_is_what_follows_its_header() {
        assert_eq!(audio_payload(&audio_frame(b"MP3DATA")).unwrap(), b"MP3DATA");
        assert_eq!(audio_payload(&[0, 0]).unwrap(), b"");
        assert_eq!(audio_payload(&[0, 1, 7]).unwrap(), b"");
        assert!(audio_payload(&[]).is_err());
        assert!(audio_payload(&[0, 2, 7]).is_err());
        assert_eq!(
            escape_xml("<a href=\"x\">'&'</a>"),
            "&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;"
        );
    }

    #[tokio::test]
    async fn it_lists_its_voices_and_is_always_available() {
        let edge = EdgeTtsEngine::new(None);
        assert_eq!(edge.name(), "edge-tts");
        assert!(edge.is_available().await);
        let voices = edge.list_voices().await.unwrap();
        assert_eq!(voices.len(), 19);
        assert_eq!(
            voices[0],
            VoiceInfo::new("en-US-AndrewMultilingualNeural", "Andrew (US)")
        );
        assert!(voices.iter().any(|v| v.id == "en-PH-JamesNeural"));
        assert!(voices.iter().all(|v| !v.is_clone));
    }
}
