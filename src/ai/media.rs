//! Port of `src/ai/media.js`: what a message's pictures, PDFs and voice notes become for the AI that answers it
//! (design 4.12).
//!
//! The turn layer calls [`adapt_media`] on the person's message before the engine runs, with caps from
//! `provider_registry` `caps_for()` for the model answering:
//!  - Pictures stay pictures for a model that sees (`caps.vision`), in a kind every engine here opens (PNG, JPEG,
//!    GIF, WebP). Claude Code sends them as image blocks; Codex takes image files, which the Codex engine writes
//!    with [`write_local_images`] and removes when the turn ends. A model that can't see gets the picture saved to
//!    the uploads folder and a note with its path.
//!  - PDFs stay PDFs where the model reads them itself (`caps.pdf`: Claude models on Claude Code). Anywhere else the
//!    PDF is saved to the uploads folder and its text goes into the message (whole pages, up to about 30,000
//!    characters), with the path and "use the tarsee_pdf_read tool for the rest".
//!  - Voice notes: no AI here takes sound as it is, so on every engine they become their transcript, from the local
//!    speech-to-text (`voice/stt_handler.rs` `transcribe_audio`, which only uses the paid Whisper API when the
//!    owner chose it). One that can't be transcribed is saved, and the note says why.
//!
//! Every picture is also kept with the chat (`lib/sent_files.rs` `note_media_blocks`) when `ctx.conversation_id` is
//! given, so the dashboard shows it on the person's message; a model that can't see is pointed at that same copy.
//!
//! Returns [`Adapted`] `{ text, media, content, saved, notes }`:
//!   text     the message's words, with each note, transcript or PDF text where the thing it replaced was
//!   media    what the model takes as it is: image and document blocks (base64), in the message's order
//!   content  a Claude Code user message's content: the media blocks then the text, or just the text when no
//!            media is kept
//!   saved    the files this put on disk or pointed at: [{ kind: "image" | "pdf" | "audio", name, size, path }]
//!   notes    the notes added, for the log

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::ai::engine::TargetCaps;
use crate::ai::provider_registry::Caps;
use crate::ai::turn_types::{ContentBlock, MediaBlock, MessageContent};
use crate::app::App;
use crate::db::settings::Settings;
use crate::env::Env;
use crate::lib::chat_files::{FileView, chat_files_for, latest_user_message_id};
use crate::lib::pdf_text::{PdfTextOptions, fit_pages, pdf_text};
use crate::lib::sent_files::{
    MediaBlockOptions, decode_base64_lenient, note_media_blocks, safe_file_name, tidy_kept_files, uploads_dir,
};
use crate::lib::turn_leftovers::os_tmpdir;
use crate::util::js::{now_ms, trim as js_trim, utf16_len};
use crate::util::node_path::to_namespaced;
use crate::voice::stt_handler::transcribe_audio;

pub use crate::lib::pdf_text::PDF_INLINE_CHARS;

/// All the PDF text one message carries inline, however many PDFs it has.
pub const PDF_INLINE_TOTAL_CHARS: usize = 60_000;

/// Picture kinds every engine here opens (Claude and OpenAI models alike).
const OPENABLE: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// The file ending for a kind of picture or sound.
fn ext(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/heic" => ".heic",
        "image/heif" => ".heif",
        "image/bmp" => ".bmp",
        "image/tiff" => ".tiff",
        "image/avif" => ".avif",
        "audio/wav" | "audio/x-wav" | "audio/wave" => ".wav",
        "audio/mpeg" | "audio/mp3" => ".mp3",
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => ".m4a",
        "audio/aac" => ".aac",
        "audio/ogg" => ".ogg",
        "audio/opus" => ".opus",
        "audio/webm" => ".webm",
        "audio/flac" => ".flac",
        _ => return None,
    })
}

/// A media type without its parameters, in lower case; "image/jpg" is "image/jpeg".
fn kind_of(t: Option<&str>) -> String {
    let lower = t.unwrap_or_default().to_lowercase();
    let k = js_trim(lower.split(';').next().unwrap_or_default());
    if k == "image/jpg" {
        "image/jpeg".to_string()
    } else {
        k.to_string()
    }
}

fn has_data(b: &MediaBlock) -> bool {
    !b.source.data.is_empty()
}

fn picture(b: &ContentBlock) -> Option<&MediaBlock> {
    match b {
        ContentBlock::Image(block) if has_data(block) => Some(block),
        _ => None,
    }
}

/// The block's media type when it has one that is not empty (`b.source.media_type`, where JavaScript asked
/// whether it was truthy).
fn media_type(b: &MediaBlock) -> Option<&str> {
    b.source.media_type.as_deref().filter(|t| !t.is_empty())
}

fn pdf_block(b: &ContentBlock) -> Option<&MediaBlock> {
    match b {
        ContentBlock::Document(block)
            if has_data(block) && media_type(block).is_none_or(|t| kind_of(Some(t)) == "application/pdf") =>
        {
            Some(block)
        }
        _ => None,
    }
}

fn audio_block(b: &ContentBlock) -> Option<&MediaBlock> {
    match b {
        ContentBlock::Audio(block) if has_data(block) => Some(block),
        _ => None,
    }
}

fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

/// What the model answering can take as it is: `caps_for()`'s `vision` and `pdf`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MediaCaps {
    /// It sees pictures.
    pub vision: bool,
    /// It reads PDF blocks itself.
    pub pdf: bool,
}

impl From<Caps> for MediaCaps {
    fn from(caps: Caps) -> Self {
        MediaCaps {
            vision: caps.vision,
            pdf: caps.pdf,
        }
    }
}

impl From<TargetCaps> for MediaCaps {
    fn from(caps: TargetCaps) -> Self {
        MediaCaps {
            vision: caps.vision,
            pdf: caps.pdf,
        }
    }
}

/// A file [`adapt_media`] put on disk or pointed at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SavedMedia {
    /// "image", "pdf" or "audio".
    pub kind: &'static str,
    pub name: String,
    pub size: u64,
    #[serde(serialize_with = "path_as_text")]
    pub path: PathBuf,
}

fn path_as_text<S: serde::Serializer>(path: &Path, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&path.to_string_lossy())
}

/// What [`adapt_media`] gives back.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Adapted {
    /// The message's words, with each note, transcript or PDF text where the thing it replaced was.
    pub text: String,
    /// What the model takes as it is: image and document blocks (base64), in the message's order.
    pub media: Vec<ContentBlock>,
    /// A Claude Code user message's content: the media blocks then the text, or just the text when no media is
    /// kept.
    pub content: MessageContent,
    /// The files this put on disk or pointed at.
    pub saved: Vec<SavedMedia>,
    /// The notes added, for the log.
    pub notes: Vec<String>,
}

/// The file each block was saved to (or found kept as), so adapting the same message again (the turn layer's retry
/// or backup model) points at the same file instead of writing another copy.
///
/// The Node version remembered this by the block object itself (a `WeakMap`), which lived as long as the turn's
/// message did. Here the turn makes one of these and hands it to every [`adapt_media`] call for its message
/// (`MediaContext::saved_blocks`): a block is known again by its place in the message and its bytes.
#[derive(Debug, Clone, Default)]
pub struct SavedBlocks(Arc<Mutex<HashMap<(usize, [u8; 32]), SavedMedia>>>);

impl SavedBlocks {
    pub fn new() -> Self {
        Self::default()
    }

    fn key(index: usize, bytes: &[u8]) -> (usize, [u8; 32]) {
        (index, Sha256::digest(bytes).into())
    }
}

/// A PDF's text, one string per page, or why there is none: what a stand-in for the PDF reader answers.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PdfPages {
    pub pages: Vec<String>,
    pub error: Option<String>,
}

/// A stand-in for speech-to-text: `(audio, language, settings) -> the transcript`, or why there is none.
pub type TranscribeFn = Arc<
    dyn Fn(Bytes, String, Option<Arc<dyn Settings>>) -> BoxFuture<'static, Result<Option<String>, String>>
        + Send
        + Sync,
>;
/// A stand-in for the PDF reader: `(bytes) -> its pages`, or a failure.
pub type PdfTextFn = Arc<dyn Fn(Bytes) -> BoxFuture<'static, Result<PdfPages, String>> + Send + Sync>;
/// A stand-in for `note_media_blocks`: `(conversation, blocks, message id, via) -> the kept rows`.
pub type NoteMediaBlocksFn = Arc<dyn Fn(&str, &[Value], Option<&str>, &str) -> Vec<FileView> + Send + Sync>;
/// A stand-in for `chat_files_for`: `(conversation) -> its files`.
pub type ChatFilesForFn = Arc<dyn Fn(&str) -> Vec<FileView> + Send + Sync>;

/// The options of [`adapt_media`] (all optional).
#[derive(Clone, Default)]
pub struct MediaContext {
    /// The model's name for the notes ("DeepSeek Pro"); default "This AI".
    pub label: Option<String>,
    /// Keep the pictures with this chat (`note_media_blocks`), with `message_id` and `via`; a file already kept
    /// with that message (the dashboard's upload) is pointed at instead of saved again.
    pub conversation_id: Option<String>,
    pub message_id: Option<String>,
    pub via: Option<String>,
    /// Where files are saved (default: the workspace's uploads folder).
    pub uploads_dir: Option<PathBuf>,
    /// For speech-to-text's choices.
    pub settings: Option<Arc<dyn Settings>>,
    /// Default: the local speech-to-text.
    pub transcribe: Option<TranscribeFn>,
    /// For speech-to-text (default "en").
    pub language: Option<String>,
    /// Swapped by tests.
    pub note_media_blocks: Option<NoteMediaBlocksFn>,
    /// Swapped by tests.
    pub chat_files_for: Option<ChatFilesForFn>,
    /// Swapped by tests.
    pub pdf_text: Option<PdfTextFn>,
    /// The time in saved files' names (default now).
    pub now: Option<i64>,
    /// What an earlier call for the same message saved, so a retry points at the same files (see [`SavedBlocks`]).
    pub saved_blocks: Option<SavedBlocks>,
}

/// A row to point at: a file saved before, kept with the chat, or just written.
struct Found {
    name: Option<String>,
    size: u64,
    path: PathBuf,
}

fn exists(path: &Path) -> bool {
    to_namespaced(path).exists()
}

/// The work of one [`adapt_media`] call: where files go and what was saved so far.
struct Saver<'a> {
    app: &'a App,
    ctx: &'a MediaContext,
    dir: PathBuf,
    now: i64,
    seq: usize,
    tidied: bool,
    /// The files kept with the person's message, looked up when first needed.
    copies: Option<Vec<FileView>>,
    saved: Vec<SavedMedia>,
}

impl Saver<'_> {
    fn save(&mut self, kind: &'static str, name: &str, buffer: &[u8]) -> std::io::Result<SavedMedia> {
        std::fs::create_dir_all(&self.dir)?;
        if !self.tidied {
            tidy_kept_files(&self.dir, self.now);
            self.tidied = true;
        }
        let safe = safe_file_name(name);
        let n = self.seq;
        self.seq += 1;
        let mut file = self.dir.join(format!("chat-{}-{n}-{safe}", self.now));
        let mut k: i64 = 1;
        while exists(&file) {
            file = self.dir.join(format!("chat-{}-{n}-{safe}", self.now.saturating_add(k)));
            k += 1;
        }
        // (The name came with the message: the file is written under exactly that name, whatever Windows would
        // make of it.)
        std::fs::write(to_namespaced(&file), buffer)?;
        let row = SavedMedia {
            kind,
            name: safe,
            size: buffer.len() as u64,
            path: file,
        };
        self.saved.push(row.clone());
        Ok(row)
    }

    fn point_at(&mut self, kind: &'static str, r: Found) -> SavedMedia {
        let name = r.name.filter(|name| !name.is_empty()).unwrap_or_else(|| {
            r.path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
        let row = SavedMedia {
            kind,
            name,
            size: r.size,
            path: r.path,
        };
        self.saved.push(row.clone());
        row
    }

    /// The file for a block: the one it was saved to before, the one kept with the chat, or a new one. Fails when
    /// it can't be saved.
    fn file_for(
        &mut self,
        index: usize,
        kind: &'static str,
        name: &str,
        bytes: &[u8],
        kept: Option<&FileView>,
    ) -> std::io::Result<SavedMedia> {
        let key = SavedBlocks::key(index, bytes);
        let before = self
            .ctx
            .saved_blocks
            .as_ref()
            .and_then(|known| known.0.lock().get(&key).cloned());
        let row = match (before, kept) {
            (Some(before), _) if exists(&before.path) => self.point_at(
                kind,
                Found {
                    name: Some(before.name),
                    size: before.size,
                    path: before.path,
                },
            ),
            (_, Some(kept)) if !kept.path.is_empty() && exists(Path::new(&kept.path)) => {
                self.point_at(kind, found_in(kept))
            }
            _ => {
                if self.copies.is_none() {
                    self.copies = Some(kept_copies(self.app, self.ctx));
                }
                let copy = find_copy(self.copies.as_deref().unwrap_or_default(), bytes);
                match copy {
                    Some(copy) => self.point_at(kind, copy),
                    None => self.save(kind, name, bytes)?,
                }
            }
        };
        if let Some(known) = &self.ctx.saved_blocks {
            known.0.lock().insert(key, row.clone());
        }
        Ok(row)
    }
}

fn found_in(r: &FileView) -> Found {
    Found {
        name: Some(r.name.clone()),
        size: u64::try_from(r.size).unwrap_or(0),
        path: PathBuf::from(&r.path),
    }
}

/// Adapt a message's content for a model. `content`: a string, or blocks (`{ type: "text", text }`,
/// `{ type: "image" | "document" | "audio", source: { type: "base64", media_type, data } }`). `caps`: `caps_for()`'s
/// `{ vision, pdf, ... }` (`None`: a model nothing is known about, so it sees no pictures and reads no PDFs).
/// `ctx`: see [`MediaContext`].
pub async fn adapt_media(app: &App, content: &MessageContent, caps: Option<MediaCaps>, ctx: &MediaContext) -> Adapted {
    let mut out = Adapted::default();
    let content = match content {
        MessageContent::Text(text) => {
            out.text = text.clone();
            out.content = MessageContent::Text(out.text.clone());
            return out;
        }
        MessageContent::Blocks(blocks) => blocks,
    };
    let label = ctx
        .label
        .as_deref()
        .map(js_trim)
        .filter(|label| !label.is_empty())
        .unwrap_or("This AI");
    let vision = caps.is_some_and(|caps| caps.vision);
    let native_pdf = caps.is_some_and(|caps| caps.pdf);
    let mut saver = Saver {
        app,
        ctx,
        dir: ctx.uploads_dir.clone().unwrap_or_else(|| uploads_dir(app.config())),
        now: ctx.now.unwrap_or_else(now_ms),
        seq: 0,
        tidied: false,
        copies: None,
        saved: Vec::new(),
    };

    let pictures: Vec<&MediaBlock> = content.iter().filter_map(picture).collect();
    let kept_with_chat = keep_with_chat(app, &pictures, ctx);
    let mut pdf_budget = PDF_INLINE_TOTAL_CHARS;
    let mut parts: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let mut note = |parts: &mut Vec<String>, t: String| {
        parts.push(t.clone());
        notes.push(t);
    };

    let mut pic = 0;
    for (index, block) in content.iter().enumerate() {
        if let ContentBlock::Text { text, .. } = block {
            if !text.is_empty() {
                parts.push(text.clone());
            }
            continue;
        }

        if let Some(image) = picture(block) {
            let kind = kind_of(Some(media_type(image).unwrap_or("image/png")));
            let kept = kept_with_chat.get(pic);
            pic += 1;
            if vision && OPENABLE.contains(&kind.as_str()) {
                out.media.push(ContentBlock::image(kind, image.source.data.clone()));
                continue;
            }
            let number = if pictures.len() > 1 {
                format!("-{pic}")
            } else {
                String::new()
            };
            let name = format!("image{number}{}", ext(&kind).unwrap_or(".png"));
            let bytes = decode_base64_lenient(&image.source.data);
            let location = match saver.file_for(index, "image", &name, &bytes, kept) {
                Ok(row) => Some(row.path),
                Err(err) => {
                    log::warn!("[media] a picture could not be saved: {err}");
                    None
                }
            };
            let saved = match &location {
                Some(path) => format!("so it was saved to {} instead", path.display()),
                None => "and it could not be saved".to_string(),
            };
            note(
                &mut parts,
                if vision {
                    format!("[Image attached ({kind}): {label} can't open this kind of image, {saved}.]")
                } else {
                    format!(
                        "[Image attached: {label} can't see images, {saved}. If the person asks about it, say you can't see pictures with this model; you can still work with the file.]"
                    )
                },
            );
            continue;
        }

        if let Some(pdf) = pdf_block(block) {
            if native_pdf {
                out.media
                    .push(ContentBlock::document("application/pdf", pdf.source.data.clone()));
                continue;
            }
            let bytes = Bytes::from(decode_base64_lenient(&pdf.source.data));
            let given = [
                pdf.extra.get("name"),
                pdf.extra.get("title"),
                pdf.source.extra.get("name"),
            ]
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .find(|v| !js_trim(v).is_empty());
            let name = match given {
                Some(given) if given.to_ascii_lowercase().ends_with(".pdf") => given.to_string(),
                Some(given) => format!("{given}.pdf"),
                None => "document.pdf".to_string(),
            };
            let location = match saver.file_for(index, "pdf", &name, &bytes, None) {
                Ok(row) => Some(row.path),
                Err(err) => {
                    log::warn!("[media] a PDF could not be saved: {err}");
                    None
                }
            };
            let at = match &location {
                Some(path) => format!("saved to {}", path.display()),
                None => "it could not be saved".to_string(),
            };
            let r = match &ctx.pdf_text {
                Some(read) => read(bytes.clone()).await.unwrap_or_else(|err| PdfPages {
                    pages: Vec::new(),
                    error: Some(err),
                }),
                None => {
                    let read = pdf_text(app, bytes.clone(), PdfTextOptions::default()).await;
                    PdfPages {
                        pages: read.pages,
                        error: read.error,
                    }
                }
            };
            let pages = r.pages;
            let total = pages.len();
            let cant = format!("{label} can't read PDF files directly");
            if total == 0 {
                let why = r
                    .error
                    .filter(|error| !error.is_empty())
                    .unwrap_or_else(|| "no pages were found in it".to_string());
                note(
                    &mut parts,
                    format!("[PDF attached, {at}. {cant}, and this one could not be read ({why}).]"),
                );
            } else if !pages.iter().any(|p| !js_trim(p).is_empty()) {
                note(
                    &mut parts,
                    format!(
                        "[PDF attached, {at} ({}). {cant}, and no text could be taken out of this one: it may be scanned pages (pictures of text). Work with the file at that path.]",
                        plural(total, "page")
                    ),
                );
            } else if pdf_budget < 2_000 {
                note(
                    &mut parts,
                    format!(
                        "[PDF attached, {at} ({}). {cant}; read it with the tarsee_pdf_read tool and that path.]",
                        plural(total, "page")
                    ),
                );
            } else {
                let fit = fit_pages(&pages, 1, PDF_INLINE_CHARS.min(pdf_budget));
                pdf_budget = pdf_budget.saturating_sub(utf16_len(&fit.text));
                let whole = fit.last == total && !fit.partial;
                let next = if fit.partial { fit.last } else { fit.last + 1 };
                let head = if whole {
                    format!(
                        "[PDF attached, {at} ({}). {cant}, so here is its text:]",
                        plural(total, "page")
                    )
                } else {
                    format!(
                        "[PDF attached, {at} ({total} pages). {cant}, so here is the text of pages 1-{} of {total}{}. For the rest, use the tarsee_pdf_read tool with that path and pages \"{next}-{total}\".]",
                        fit.last,
                        if fit.partial { " (cut short)" } else { "" }
                    )
                };
                note(&mut parts, format!("{head}\n<pdf-text>\n{}\n</pdf-text>", fit.text));
            }
            continue;
        }

        if let Some(audio) = audio_block(block) {
            let bytes = Bytes::from(decode_base64_lenient(&audio.source.data));
            let language = ctx
                .language
                .clone()
                .filter(|language| !language.is_empty())
                .unwrap_or_else(|| "en".to_string());
            let heard = match &ctx.transcribe {
                Some(transcribe) => transcribe(bytes.clone(), language, ctx.settings.clone()).await,
                None => transcribe_audio(app, &bytes, Some(&language), ctx.settings.as_deref())
                    .await
                    .map(|r| Some(r.transcript))
                    .map_err(|err| err.message),
            };
            match heard {
                Ok(transcript) => {
                    let transcript = transcript.unwrap_or_default();
                    let said = js_trim(&transcript);
                    note(
                        &mut parts,
                        if said.is_empty() {
                            "[Voice note: nothing could be made out in it.]".to_string()
                        } else {
                            format!("[Voice note transcript] {said}")
                        },
                    );
                }
                Err(err) => {
                    let name = format!(
                        "voice-note{}",
                        ext(&kind_of(audio.source.media_type.as_deref())).unwrap_or(".audio")
                    );
                    // (When it can't be saved either, the note says so by saying nothing of where.)
                    let location = saver
                        .file_for(index, "audio", &name, &bytes, None)
                        .ok()
                        .map(|row| row.path);
                    let message = if err.is_empty() { "speech-to-text failed" } else { &err };
                    let why = js_trim(message);
                    let why = why.strip_suffix('.').unwrap_or(why);
                    let saved = match &location {
                        Some(path) => format!(" It was saved to {}.", path.display()),
                        None => String::new(),
                    };
                    note(
                        &mut parts,
                        format!("[Voice note: it couldn't be transcribed ({why}).{saved}]"),
                    );
                }
            }
            continue;
        }
        // Anything else (a block kind no engine takes) is left out of the turn.
    }

    out.text = parts.join("\n\n");
    out.content = if out.media.is_empty() {
        MessageContent::Text(out.text.clone())
    } else {
        let mut blocks = out.media.clone();
        if !out.text.is_empty() {
            blocks.push(ContentBlock::text(out.text.clone()));
        }
        MessageContent::Blocks(blocks)
    };
    out.saved = saver.saved;
    out.notes = notes;
    out
}

/// Keep the message's pictures with its chat (once: `note_media_blocks` skips a message that has files already).
/// One row per picture, or none at all.
fn keep_with_chat(app: &App, pictures: &[&MediaBlock], ctx: &MediaContext) -> Vec<FileView> {
    let Some(conversation_id) = ctx.conversation_id.as_deref().filter(|id| !id.is_empty()) else {
        return Vec::new();
    };
    if pictures.is_empty() {
        return Vec::new();
    }
    let blocks: Vec<Value> = pictures
        .iter()
        .map(|b| {
            json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": kind_of(Some(media_type(b).unwrap_or("image/png"))),
                    "data": b.source.data,
                },
            })
        })
        .collect();
    let message_id = ctx.message_id.as_deref().filter(|id| !id.is_empty());
    let via = ctx.via.as_deref().unwrap_or_default();
    let rows = match &ctx.note_media_blocks {
        Some(keep) => keep(conversation_id, &blocks, message_id, via),
        None => note_media_blocks(
            app,
            conversation_id,
            &blocks,
            MediaBlockOptions {
                message_id,
                via,
                dir: None,
                now: None,
            },
        ),
    };
    if rows.len() == pictures.len() { rows } else { Vec::new() }
}

/// The files kept with the person's message (the dashboard's uploads, pictures already noted).
fn kept_copies(app: &App, ctx: &MediaContext) -> Vec<FileView> {
    let Some(conversation_id) = ctx.conversation_id.as_deref().filter(|id| !id.is_empty()) else {
        return Vec::new();
    };
    let rows = match &ctx.chat_files_for {
        Some(files_for) => files_for(conversation_id),
        None => chat_files_for(app, conversation_id),
    };
    let message_id = match ctx.message_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => Some(id.to_string()),
        None if ctx.chat_files_for.is_some() => None,
        None => latest_user_message_id(app, conversation_id),
    };
    rows.into_iter()
        .filter(|r| {
            !r.path.is_empty()
                && r.from == "in"
                && message_id
                    .as_deref()
                    .is_none_or(|id| r.message_id.as_deref() == Some(id))
        })
        .collect()
}

/// A kept file with exactly these bytes, or `None`.
fn find_copy(copies: &[FileView], bytes: &[u8]) -> Option<Found> {
    let length = bytes.len() as u64;
    for r in copies {
        if r.size != 0 && u64::try_from(r.size).ok() != Some(length) {
            continue;
        }
        // gone: the next one
        let Ok(found) = std::fs::metadata(&r.path) else {
            continue;
        };
        if found.len() == length && std::fs::read(&r.path).is_ok_and(|kept| kept == bytes) {
            return Some(found_in(r));
        }
    }
    None
}

/// One picture as Codex takes it: `{ type: "local_image", path }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LocalImage {
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(serialize_with = "path_as_text")]
    pub path: PathBuf,
}

/// What [`write_local_images`] wrote: `{ inputs: [{ type: "local_image", path }], dir, cleanup() }`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LocalImages {
    pub inputs: Vec<LocalImage>,
    /// The folder they are in; `None` when there were no pictures.
    pub dir: Option<PathBuf>,
}

impl LocalImages {
    /// Removes the folder; the turn calls it when it ends.
    pub fn cleanup(&self) {
        if let Some(folder) = &self.dir {
            // gone already
            let _ = std::fs::remove_dir_all(folder);
        }
    }
}

/// Codex takes pictures as files: write each image block in `media` to a new private folder (under `dir`, default
/// the system's temp folder, which `env` names). Returns `{ inputs: [{ type: "local_image", path }], dir,
/// cleanup() }`; `cleanup()` removes the folder, and the turn calls it when it ends.
pub fn write_local_images(env: &Env, media: &[ContentBlock], dir: Option<&Path>) -> std::io::Result<LocalImages> {
    let pictures: Vec<&MediaBlock> = media.iter().filter_map(picture).collect();
    if pictures.is_empty() {
        return Ok(LocalImages::default());
    }
    let dir = dir.map(Path::to_path_buf).unwrap_or_else(|| os_tmpdir(env));
    std::fs::create_dir_all(&dir)?;
    let folder = tempfile::Builder::new()
        .prefix("tarsee-images-")
        .rand_bytes(6)
        .tempdir_in(&dir)?
        .keep();
    let written = pictures
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let ending = ext(&kind_of(b.source.media_type.as_deref())).unwrap_or(".png");
            let file = folder.join(format!("image-{}{ending}", i + 1));
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut opened = options.open(&file)?;
            std::io::Write::write_all(&mut opened, &decode_base64_lenient(&b.source.data))?;
            Ok(LocalImage {
                kind: "local_image",
                path: file,
            })
        })
        .collect::<std::io::Result<Vec<LocalImage>>>();
    match written {
        Ok(inputs) => Ok(LocalImages {
            inputs,
            dir: Some(folder),
        }),
        Err(err) => {
            // best effort
            let _ = std::fs::remove_dir_all(&folder);
            Err(err)
        }
    }
}
