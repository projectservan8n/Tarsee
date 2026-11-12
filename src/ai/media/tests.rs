//! Port of `test/media.test.js`: adaptMedia (design 4.12): what a message's pictures, PDFs and voice notes become
//! for the AI that answers it, by what that model can take in (`provider_registry` `caps_for`). A model that can't
//! see gets the picture saved and a note with its path; a model without native PDFs gets the PDF's text inline plus
//! the saved path; a voice note becomes its transcript on every AI. The transcriber is a stub; the PDFs are built
//! by the test.
//!
//! On top of the Node cases, what the Node `adaptMedia` made of 25 messages is compared word for word
//! (`node-adapt-media.json`, made by `docs/rust-port/reports/S4-capture-media.mjs.txt`).

use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine as _;
use serde_json::{Value, json};

use super::*;
use crate::ai::provider_registry::ProviderRegistry;
use crate::db::conversations::{ConversationStore, NewConversation, NewMessage};
use crate::lib::chat_files::{ChatFiles, reset_chat_files};
use crate::lib::pdf_text::PdfReader;
use crate::lib::sent_files::{ReceivedFiles, UploadedFile, keep_uploaded_files, note_received_files};
use crate::testkit::make_pdf::{PdfSpec, make_pdf};
use crate::testkit::{MemorySettings, TestApp, test_app};
use crate::voice::stt_handler::{LocalTranscriber, SttResult, SttTestOverrides, set_for_tests as set_stt};

/// What the Node `adaptMedia` made of a set of messages.
const NODE_ADAPT_MEDIA: &str = include_str!("node-adapt-media.json");

// A 1x1 PNG.
const PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const AUDIO: &[u8] = b"RIFF fake wav bytes for the test";

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(PNG_BASE64).unwrap()
}
fn image() -> ContentBlock {
    ContentBlock::image("image/png", PNG_BASE64)
}
fn image_of(kind: &str) -> ContentBlock {
    ContentBlock::image(kind, PNG_BASE64)
}
fn pdf_of(bytes: &[u8]) -> ContentBlock {
    ContentBlock::document("application/pdf", b64(bytes))
}
fn audio() -> ContentBlock {
    ContentBlock::audio("audio/wav", b64(AUDIO))
}
fn text(t: &str) -> ContentBlock {
    ContentBlock::text(t)
}
fn blocks(list: Vec<ContentBlock>) -> MessageContent {
    MessageContent::Blocks(list)
}
fn pdf(pages: &[&str]) -> Vec<u8> {
    make_pdf(&PdfSpec::pages(pages))
}
fn compressed_pdf<S: AsRef<str>>(pages: &[S]) -> Vec<u8> {
    make_pdf(&PdfSpec {
        compress: true,
        ..PdfSpec::pages(pages)
    })
}

/// A test app that reads PDFs with the built-in reader, so the test reads the same everywhere.
fn app() -> TestApp {
    let t = test_app();
    PdfReader::of(&t.app).set_pdftotext(None);
    t
}

static FOLDERS: AtomicUsize = AtomicUsize::new(0);
/// A fresh uploads folder for one test.
fn fresh_uploads(t: &TestApp) -> PathBuf {
    let dir = t
        .path()
        .join(format!("uploads-{}", FOLDERS.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
fn inside(dir: &Path, p: &Path) -> bool {
    p.starts_with(dir) && p != dir
}
fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// `capsFor(provider, model)`.
fn caps_for(t: &TestApp, provider: &str, model: &str) -> Option<MediaCaps> {
    ProviderRegistry::of(&t.app)
        .caps_for(provider, Some(model), None)
        .map(MediaCaps::from)
}

fn ctx(label: &str, uploads: &Path) -> MediaContext {
    MediaContext {
        label: Some(label.to_string()),
        uploads_dir: Some(uploads.to_path_buf()),
        ..Default::default()
    }
}

/// A transcriber that answers this.
fn transcriber(answer: Result<&'static str, &'static str>) -> TranscribeFn {
    Arc::new(move |_audio, _language, _settings| {
        Box::pin(async move { answer.map(|said| Some(said.to_string())).map_err(String::from) })
    })
}

fn path_text(p: &Path) -> String {
    p.display().to_string()
}

// --- adaptMedia: PDFs ------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_pdf_on_deepseek_becomes_inline_text_plus_a_path() {
    let t = app();
    let caps = caps_for(&t, "deepseek", "deepseek-flash");
    assert!(!caps.unwrap().pdf);
    let uploads = fresh_uploads(&t);
    let bytes = compressed_pdf(&["Quarterly revenue grew nine percent", "Costs held flat"]);
    let r = adapt_media(
        &t.app,
        &blocks(vec![pdf_of(&bytes), text("What does it say?")]),
        caps,
        &ctx("DeepSeek Flash", &uploads),
    )
    .await;

    assert!(r.media.is_empty(), "a PDF block went to a model that can't take one");
    assert_eq!(r.saved.len(), 1);
    assert_eq!(r.saved[0].kind, "pdf");
    assert!(
        inside(&uploads, &r.saved[0].path),
        "saved outside the uploads folder: {}",
        r.saved[0].path.display()
    );
    assert_eq!(std::fs::read(&r.saved[0].path).unwrap(), bytes);
    assert!(
        r.text.contains(&path_text(&r.saved[0].path)),
        "the note does not give the saved path"
    );
    assert!(r.text.contains("DeepSeek Flash can't read PDF"));
    assert!(r.text.contains("Quarterly revenue grew nine percent"));
    assert!(r.text.contains("Costs held flat"));
    assert!(
        r.text.ends_with("What does it say?"),
        "the person's own words come after the note"
    );
    assert_eq!(
        r.content,
        MessageContent::Text(r.text.clone()),
        "with nothing kept, the message is plain text"
    );
    assert_eq!(r.saved[0].size, bytes.len() as u64);
    assert_eq!(r.saved[0].name, "document.pdf");
}

#[tokio::test]
async fn a_long_pdf_is_cut_at_about_30_000_characters_and_points_at_tarsee_pdf_read_for_the_rest() {
    let t = app();
    let pages: Vec<String> = (0..40)
        .map(|i| format!("Page {}. {}", i + 1, "Long words keep going on this page. ".repeat(40)))
        .collect();
    let r = adapt_media(
        &t.app,
        &blocks(vec![pdf_of(&compressed_pdf(&pages))]),
        caps_for(&t, "deepseek", "deepseek-flash"),
        &ctx("DeepSeek Flash", &fresh_uploads(&t)),
    )
    .await;
    assert!(
        r.text.len() < PDF_INLINE_CHARS + 2_000,
        "inlined {} characters",
        r.text.len()
    );
    assert!(
        r.text.len() as f64 > PDF_INLINE_CHARS as f64 * 0.8,
        "inlined only {} characters",
        r.text.len()
    );
    assert!(r.text.contains("tarsee_pdf_read"));
    let from = r.text.find("pages 1-").expect("it does not say how far the text goes") + "pages 1-".len();
    let digits: String = r.text[from..].chars().take_while(char::is_ascii_digit).collect();
    assert!(r.text[from + digits.len()..].starts_with(" of 40"));
    let last: usize = digits.parse().unwrap();
    assert!(last > 1 && last < 40, "it does not say how far the text goes");
    assert!(
        r.text.contains(&format!("pages \"{}-40\"", last + 1)),
        "it does not say which pages are left"
    );
}

#[tokio::test]
async fn a_pdf_with_no_text_in_it_scanned_pages_says_so_and_gives_the_path() {
    let t = app();
    let r = adapt_media(
        &t.app,
        &blocks(vec![pdf_of(&pdf(&[""]))]),
        caps_for(&t, "deepseek", "deepseek-flash"),
        &ctx("DeepSeek Flash", &fresh_uploads(&t)),
    )
    .await;
    assert!(r.text.to_lowercase().contains("no text could be taken out"));
    assert!(r.text.contains(&path_text(&r.saved[0].path)));
}

#[tokio::test]
async fn a_pdf_on_the_claude_plan_stays_a_native_pdf() {
    let t = app();
    let uploads = fresh_uploads(&t);
    let bytes = pdf(&["Native"]);
    let r = adapt_media(
        &t.app,
        &blocks(vec![pdf_of(&bytes), text("Read this")]),
        caps_for(&t, "claude", "opus"),
        &ctx("Claude", &uploads),
    )
    .await;
    assert_eq!(r.media.len(), 1);
    assert_eq!(r.media[0], pdf_of(&bytes));
    assert_eq!(r.text, "Read this");
    assert!(r.saved.is_empty());
    assert!(listing(&uploads).is_empty());
    assert_eq!(r.content, blocks(vec![r.media[0].clone(), text("Read this")]));
}

// --- adaptMedia: pictures --------------------------------------------------------------------------------------------

#[tokio::test]
async fn an_image_on_deepseek_v4_pro_becomes_the_saved_path_note() {
    let t = app();
    let caps = caps_for(&t, "deepseek", "deepseek-v4-pro");
    assert!(!caps.unwrap().vision);
    let uploads = fresh_uploads(&t);
    let r = adapt_media(
        &t.app,
        &blocks(vec![image(), text("What is this?")]),
        caps,
        &ctx("DeepSeek Pro", &uploads),
    )
    .await;
    assert!(r.media.is_empty());
    assert_eq!(r.saved.len(), 1);
    assert_eq!(r.saved[0].kind, "image");
    assert!(path_text(&r.saved[0].path).ends_with(".png"));
    assert!(inside(&uploads, &r.saved[0].path));
    assert_eq!(std::fs::read(&r.saved[0].path).unwrap(), png());
    assert!(r.text.contains("DeepSeek Pro can't see images"));
    assert!(r.text.contains(&path_text(&r.saved[0].path)));
    assert!(r.text.ends_with("What is this?"));
}

#[tokio::test]
async fn an_image_on_a_model_that_sees_stays_a_picture() {
    let t = app();
    let uploads = fresh_uploads(&t);
    let r = adapt_media(
        &t.app,
        &blocks(vec![image(), text("Look")]),
        caps_for(&t, "deepseek", "deepseek-flash"),
        &ctx("DeepSeek Flash", &uploads),
    )
    .await;
    assert_eq!(r.media, vec![image()]);
    assert!(r.saved.is_empty());
    assert_eq!(r.text, "Look");
    assert!(listing(&uploads).is_empty());
}

#[tokio::test]
async fn a_kind_of_picture_the_model_cant_open_is_saved_with_a_note() {
    let t = app();
    let r = adapt_media(
        &t.app,
        &blocks(vec![image_of("image/heic")]),
        caps_for(&t, "claude", "opus"),
        &ctx("Claude", &fresh_uploads(&t)),
    )
    .await;
    assert!(r.media.is_empty());
    assert!(path_text(&r.saved[0].path).ends_with(".heic"));
    assert!(r.text.contains("can't open"));
}

#[tokio::test]
async fn codex_gets_the_pictures_it_sees_as_image_files_removed_afterwards() {
    let t = app();
    let caps = caps_for(&t, "openai", "gpt-6.1-sol");
    assert!(caps.unwrap().vision);
    let r = adapt_media(
        &t.app,
        &blocks(vec![image(), image_of("image/jpeg"), text("Compare")]),
        caps,
        &ctx("GPT-6.1 Sol", &fresh_uploads(&t)),
    )
    .await;
    assert_eq!(r.media.len(), 2);
    let images_dir = t.path().join("codex-images");
    let files = write_local_images(t.env(), &r.media, Some(&images_dir)).unwrap();
    assert_eq!(files.inputs.len(), 2);
    assert_eq!(
        files.inputs.iter().map(|x| x.kind).collect::<Vec<_>>(),
        ["local_image", "local_image"]
    );
    assert!(path_text(&files.inputs[0].path).ends_with("image-1.png"));
    assert!(path_text(&files.inputs[1].path).ends_with("image-2.jpg"));
    for x in &files.inputs {
        assert_eq!(std::fs::read(&x.path).unwrap(), png());
    }
    // A private folder of its own, named as the Node version named it.
    let folder = files.dir.clone().unwrap();
    assert_eq!(folder.parent(), Some(images_dir.as_path()));
    let name = folder.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        name.starts_with("tarsee-images-") && name.len() == "tarsee-images-".len() + 6,
        "{name}"
    );
    assert_eq!(
        serde_json::to_value(&files.inputs[0]).unwrap(),
        json!({"type": "local_image", "path": path_text(&files.inputs[0].path)})
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&files.inputs[0].path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(std::fs::metadata(&folder).unwrap().permissions().mode() & 0o777, 0o700);
    }
    files.cleanup();
    for x in &files.inputs {
        assert!(!x.path.exists(), "a temp image was left behind");
    }
    assert!(!folder.exists());
    files.cleanup(); // twice is harmless

    // Nothing to write: no folder is made, and there is nothing to clean up.
    let none = write_local_images(t.env(), &[text("no pictures"), pdf_of(b"%PDF-")], Some(&images_dir)).unwrap();
    assert_eq!(none, LocalImages::default());
    none.cleanup();
    assert!(listing(&images_dir).is_empty());
    // By default they go under the system's temp folder, as the environment names it.
    t.env().set("TEMP", path_text(&t.path().join("temp")));
    t.env().set("TMPDIR", path_text(&t.path().join("temp")));
    let by_default = write_local_images(t.env(), &[image()], None).unwrap();
    assert!(by_default.dir.as_ref().unwrap().starts_with(t.path().join("temp")));
    by_default.cleanup();
}

#[tokio::test]
async fn keeps_the_chats_pictures_with_the_conversation_note_media_blocks_and_points_at_that_copy() {
    let t = app();
    let uploads = fresh_uploads(&t);
    let kept = uploads.join("chat-1-0-image.png");
    std::fs::write(&kept, png()).unwrap();
    // What note_media_blocks was asked: the conversation, the blocks, the message, where it came from.
    type Asked = (String, Vec<Value>, Option<String>, String);
    let calls: Arc<Mutex<Vec<Asked>>> = Arc::default();
    let (seen, kept_path) = (calls.clone(), path_text(&kept));
    let note_media_blocks: NoteMediaBlocksFn = Arc::new(move |conv, blocks, message_id, via| {
        seen.lock().push((
            conv.to_string(),
            blocks.to_vec(),
            message_id.map(String::from),
            via.to_string(),
        ));
        vec![FileView {
            path: kept_path.clone(),
            name: "image.png".into(),
            size: 70,
            ..Default::default()
        }]
    });
    let r = adapt_media(
        &t.app,
        &blocks(vec![image()]),
        caps_for(&t, "deepseek", "deepseek-v4-pro"),
        &MediaContext {
            conversation_id: Some("conv-1".into()),
            message_id: Some("msg-9".into()),
            via: Some("telegram".into()),
            note_media_blocks: Some(note_media_blocks),
            ..ctx("DeepSeek Pro", &uploads)
        },
    )
    .await;
    let calls = calls.lock();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "conv-1");
    assert_eq!(calls[0].2.as_deref(), Some("msg-9"));
    assert_eq!(calls[0].3, "telegram");
    assert_eq!(
        calls[0].1,
        vec![json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": PNG_BASE64}})]
    );
    assert!(
        r.text.contains(&path_text(&kept)),
        "the note does not point at the copy kept with the chat"
    );
    assert_eq!(listing(&uploads), ["chat-1-0-image.png"], "a second copy was written");
    assert_eq!(
        r.saved,
        vec![SavedMedia {
            kind: "image",
            name: "image.png".into(),
            size: 70,
            path: kept
        }]
    );
}

#[tokio::test]
async fn points_at_the_copy_already_kept_with_the_persons_message_instead_of_saving_another() {
    // The dashboard kept the upload with the message, or the turn layer already called note_media_blocks.
    let t = app();
    let uploads = fresh_uploads(&t);
    let kept_pdf = uploads.join("chat-1-0-report.pdf");
    let kept_pic = uploads.join("chat-1-1-image.png");
    let bytes = pdf(&["Kept already"]);
    std::fs::write(&kept_pdf, &bytes).unwrap();
    std::fs::write(&kept_pic, png()).unwrap();
    let row = |message: &str, name: &str, size: usize, path: &Path| FileView {
        from: "in".into(),
        message_id: Some(message.into()),
        name: name.into(),
        size: size as i64,
        path: path_text(path),
        ..Default::default()
    };
    let rows = vec![
        row("msg-1", "report.pdf", bytes.len(), &kept_pdf),
        row("msg-1", "image.png", png().len(), &kept_pic),
        row("msg-0", "other.png", png().len(), &uploads.join("nope.png")),
        // The agent's own file with the same bytes is not the person's.
        FileView {
            from: "agent".into(),
            ..row("msg-1", "sent.png", png().len(), &kept_pic)
        },
    ];
    let chat_files_for: ChatFilesForFn = Arc::new(move |conv| if conv == "conv-3" { rows.clone() } else { Vec::new() });
    let none: NoteMediaBlocksFn = Arc::new(|_, _, _, _| Vec::new());
    let r = adapt_media(
        &t.app,
        &blocks(vec![pdf_of(&bytes), image(), text("Both")]),
        caps_for(&t, "deepseek", "deepseek-v4-pro"),
        &MediaContext {
            conversation_id: Some("conv-3".into()),
            message_id: Some("msg-1".into()),
            note_media_blocks: Some(none),
            chat_files_for: Some(chat_files_for),
            ..ctx("DeepSeek Pro", &uploads)
        },
    )
    .await;
    assert!(
        r.text.contains(&path_text(&kept_pdf)),
        "the PDF note does not point at the kept copy"
    );
    assert!(
        r.text.contains(&path_text(&kept_pic)),
        "the picture note does not point at the kept copy"
    );
    assert!(r.text.contains("Kept already"));
    assert_eq!(
        listing(&uploads),
        ["chat-1-0-report.pdf", "chat-1-1-image.png"],
        "a second copy was written"
    );
    assert_eq!(
        r.saved.iter().map(|s| (s.kind, s.name.as_str())).collect::<Vec<_>>(),
        [("pdf", "report.pdf"), ("image", "image.png")]
    );
}

#[tokio::test]
async fn finds_the_dashboards_kept_upload_in_the_real_chat_files_table() {
    let t = app();
    ChatFiles::init(&t.app).expect("the chat_files table");
    let convs = ConversationStore::new(&t.app);
    let conv = convs.create(NewConversation::titled("media")).unwrap();
    let msg = convs
        .add_message(&conv.id, NewMessage::new("user", "see attached"))
        .unwrap();
    let bytes = pdf(&["Uploaded on the dashboard"]);
    let uploads = uploads_dir(t.config());
    let kept = keep_uploaded_files(
        &[UploadedFile {
            name: "plan.pdf".into(),
            buffer: bytes.clone(),
        }],
        &uploads,
        now_ms(),
    )
    .unwrap();
    note_received_files(
        &t.app,
        ReceivedFiles {
            conversation_id: &conv.id,
            message_id: Some(&msg.id),
            files: &kept,
            via: "web",
        },
    );
    let before = listing(&uploads).len();

    let r = adapt_media(
        &t.app,
        &blocks(vec![pdf_of(&bytes), text("see attached")]),
        caps_for(&t, "deepseek", "deepseek-flash"),
        &MediaContext {
            label: Some("DeepSeek Flash".into()),
            conversation_id: Some(conv.id.clone()),
            message_id: Some(msg.id.clone()),
            ..Default::default()
        },
    )
    .await;
    assert!(
        r.text.contains(&path_text(&kept[0].path)),
        "the note does not point at the dashboard's copy"
    );
    assert!(r.text.contains("Uploaded on the dashboard"));
    assert_eq!(listing(&uploads).len(), before, "a second copy was written");
    assert_eq!(chat_files_for(&t.app, &conv.id).len(), 1);

    // With no message named, the latest one the person sent is the one whose files count.
    let again = adapt_media(
        &t.app,
        &blocks(vec![pdf_of(&bytes)]),
        caps_for(&t, "deepseek", "deepseek-flash"),
        &MediaContext {
            conversation_id: Some(conv.id.clone()),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(again.saved[0].path, kept[0].path);
    assert_eq!(listing(&uploads).len(), before);
    reset_chat_files(&t.app);
}

#[tokio::test]
async fn adapting_the_same_message_again_a_retry_reuses_what_it_saved_the_first_time() {
    let t = app();
    let uploads = fresh_uploads(&t);
    let content = blocks(vec![pdf_of(&pdf(&["Once only"])), image(), audio()]);
    // (The turn makes one of these for its message; the Node version knew a block again by the object itself.)
    let cx = MediaContext {
        transcribe: Some(transcriber(Err("no speech-to-text"))),
        saved_blocks: Some(SavedBlocks::new()),
        ..ctx("DeepSeek Pro", &uploads)
    };
    let caps = caps_for(&t, "deepseek", "deepseek-v4-pro");
    let first = adapt_media(&t.app, &content, caps, &cx).await;
    let second = adapt_media(&t.app, &content, caps, &cx).await;
    assert_eq!(first.saved.len(), 3);
    assert_eq!(
        second.saved.iter().map(|s| &s.path).collect::<Vec<_>>(),
        first.saved.iter().map(|s| &s.path).collect::<Vec<_>>()
    );
    assert_eq!(second.saved, first.saved);
    assert_eq!(second.text, first.text);
    assert_eq!(listing(&uploads).len(), 3);

    // A file that is gone is written again; and without the turn's memory every call writes its own.
    std::fs::remove_file(&first.saved[1].path).unwrap();
    let third = adapt_media(&t.app, &content, caps, &cx).await;
    assert_eq!(third.saved[0].path, first.saved[0].path);
    assert!(third.saved[1].path.exists());
    assert_eq!(listing(&uploads).len(), 3);
    let forgetful = MediaContext {
        saved_blocks: None,
        ..cx.clone()
    };
    adapt_media(&t.app, &content, caps, &forgetful).await;
    assert_eq!(listing(&uploads).len(), 6);
}

#[tokio::test]
async fn still_shows_a_seeing_models_pictures_in_the_chat() {
    let t = app();
    let calls: Arc<Mutex<Vec<usize>>> = Arc::default();
    let seen = calls.clone();
    let note_media_blocks: NoteMediaBlocksFn = Arc::new(move |_, blocks, _, _| {
        seen.lock().push(blocks.len());
        Vec::new()
    });
    let r = adapt_media(
        &t.app,
        &blocks(vec![image()]),
        caps_for(&t, "claude", "opus"),
        &MediaContext {
            conversation_id: Some("conv-2".into()),
            note_media_blocks: Some(note_media_blocks),
            ..ctx("Claude", &fresh_uploads(&t))
        },
    )
    .await;
    assert_eq!(*calls.lock(), [1]);
    assert_eq!(r.media.len(), 1);
}

// --- adaptMedia: voice notes -----------------------------------------------------------------------------------------

type Heard = Arc<Mutex<Vec<(Vec<u8>, String, Option<Arc<dyn Settings>>)>>>;

/// A transcriber that notes what it was handed.
fn listening(heard: &Heard, says: &'static str) -> TranscribeFn {
    let heard = heard.clone();
    Arc::new(move |audio, language, settings| {
        heard.lock().push((audio.to_vec(), language, settings));
        Box::pin(async move { Ok(Some(says.to_string())) })
    })
}

#[tokio::test]
async fn audio_becomes_a_transcript_transcriber_stubbed() {
    let t = app();
    let heard: Heard = Arc::default();
    let settings: Arc<dyn Settings> = Arc::new(MemorySettings::default());
    let uploads = fresh_uploads(&t);
    let r = adapt_media(
        &t.app,
        &blocks(vec![audio(), text("(voice)")]),
        caps_for(&t, "deepseek", "deepseek-flash"),
        &MediaContext {
            transcribe: Some(listening(&heard, " remind me at five ")),
            settings: Some(settings.clone()),
            ..ctx("DeepSeek Flash", &uploads)
        },
    )
    .await;
    let heard = heard.lock();
    assert_eq!(heard.len(), 1);
    assert_eq!(heard[0].0, AUDIO);
    assert_eq!(heard[0].1, "en");
    assert!(Arc::ptr_eq(heard[0].2.as_ref().unwrap(), &settings));
    assert_eq!(r.text, "[Voice note transcript] remind me at five\n\n(voice)");
    assert!(r.media.is_empty());
    assert!(r.saved.is_empty());
    assert!(listing(&uploads).is_empty());
}

#[tokio::test]
async fn is_transcribed_on_the_claude_plan_too_no_ai_takes_audio_as_it_is() {
    let t = app();
    let r = adapt_media(
        &t.app,
        &blocks(vec![audio()]),
        caps_for(&t, "claude", "opus"),
        &MediaContext {
            transcribe: Some(transcriber(Ok("hello"))),
            ..ctx("Claude", &fresh_uploads(&t))
        },
    )
    .await;
    assert_eq!(r.text, "[Voice note transcript] hello");
    assert!(r.media.is_empty());
}

#[tokio::test]
async fn uses_the_local_speech_to_text_by_default() {
    let t = app();
    let local = LocalTranscriber {
        available: LocalTranscriber::available(true).available,
        transcribe: Some(Arc::new(|audio| {
            Box::pin(async move {
                Ok(SttResult {
                    transcript: format!("heard {} bytes", audio.len()),
                    language: "en".into(),
                    provider: "local".into(),
                })
            })
        })),
    };
    set_stt(
        &t.app,
        SttTestOverrides {
            local: Some(local),
            ..Default::default()
        },
    );
    let settings: Arc<dyn Settings> = Arc::new(MemorySettings::default());
    let r = adapt_media(
        &t.app,
        &blocks(vec![audio()]),
        caps_for(&t, "deepseek", "deepseek-flash"),
        &MediaContext {
            settings: Some(settings),
            ..ctx("DeepSeek Flash", &fresh_uploads(&t))
        },
    )
    .await;
    assert_eq!(r.text, format!("[Voice note transcript] heard {} bytes", AUDIO.len()));
    set_stt(&t.app, SttTestOverrides::default());
}

/// The Node case handed the store over under either of two names (`settingsStore`, or the turn layer's `store`);
/// here there is one name for it, and the language the turn names goes with it.
#[tokio::test]
async fn hands_speech_to_text_the_turns_settings_store_and_language() {
    let t = app();
    let store: Arc<dyn Settings> = Arc::new(MemorySettings::default());
    let heard: Heard = Arc::default();
    let cx = |settings: Option<Arc<dyn Settings>>, language: Option<&str>| MediaContext {
        uploads_dir: Some(fresh_uploads(&t)),
        transcribe: Some(listening(&heard, "ok")),
        settings,
        language: language.map(String::from),
        ..Default::default()
    };
    let caps = caps_for(&t, "deepseek", "deepseek-flash");
    adapt_media(&t.app, &blocks(vec![audio()]), caps, &cx(Some(store.clone()), None)).await;
    adapt_media(
        &t.app,
        &blocks(vec![audio()]),
        caps,
        &cx(Some(store.clone()), Some("tl")),
    )
    .await;
    adapt_media(&t.app, &blocks(vec![audio()]), caps, &cx(None, Some(""))).await;
    let heard = heard.lock();
    assert!(Arc::ptr_eq(heard[0].2.as_ref().unwrap(), &store));
    assert!(Arc::ptr_eq(heard[1].2.as_ref().unwrap(), &store));
    assert!(heard[2].2.is_none());
    assert_eq!(
        heard.iter().map(|h| h.1.as_str()).collect::<Vec<_>>(),
        ["en", "tl", "en"]
    );
}

#[tokio::test]
async fn audio_that_cant_be_transcribed_is_saved_with_a_note_saying_why() {
    let t = app();
    let uploads = fresh_uploads(&t);
    let r = adapt_media(
        &t.app,
        &blocks(vec![audio()]),
        caps_for(&t, "deepseek", "deepseek-flash"),
        &MediaContext {
            transcribe: Some(transcriber(Err(
                "Speech-to-text is unavailable: local transcription is not installed",
            ))),
            ..ctx("DeepSeek Flash", &uploads)
        },
    )
    .await;
    assert_eq!(r.saved.len(), 1);
    assert_eq!(r.saved[0].kind, "audio");
    assert_eq!(std::fs::read(&r.saved[0].path).unwrap(), AUDIO);
    assert!(r.text.contains("couldn't be transcribed"));
    assert!(r.text.contains("not installed"));
    assert!(r.text.contains(&path_text(&r.saved[0].path)));
}

#[tokio::test]
async fn the_real_speech_to_text_says_why_when_nothing_is_installed() {
    // (The words the owner reads when local transcription is not set up reach the model as they are.)
    let t = app();
    set_stt(
        &t.app,
        SttTestOverrides {
            local: Some(LocalTranscriber::available(false)),
            ..Default::default()
        },
    );
    let r = adapt_media(
        &t.app,
        &blocks(vec![audio()]),
        None,
        &MediaContext {
            uploads_dir: Some(fresh_uploads(&t)),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(
        r.text,
        format!(
            "[Voice note: it couldn't be transcribed (Speech-to-text is unavailable: local transcription (faster-whisper) is not installed on this server. Install it in Settings > Voice > Speech-to-text (one click), or choose the paid \"OpenAI Whisper API\" there). It was saved to {}.]",
            r.saved[0].path.display()
        )
    );
}

#[tokio::test]
async fn an_empty_transcript_says_nothing_could_be_made_out() {
    let t = app();
    let r = adapt_media(
        &t.app,
        &blocks(vec![audio()]),
        caps_for(&t, "deepseek", "deepseek-flash"),
        &MediaContext {
            transcribe: Some(transcriber(Ok("  "))),
            ..ctx("DeepSeek Flash", &fresh_uploads(&t))
        },
    )
    .await;
    assert!(r.text.to_lowercase().contains("nothing could be made out"));
}

// --- adaptMedia: plain messages --------------------------------------------------------------------------------------

#[tokio::test]
async fn passes_plain_text_through() {
    let t = app();
    let r = adapt_media(
        &t.app,
        &MessageContent::Text("just words".into()),
        caps_for(&t, "deepseek", "deepseek-flash"),
        &MediaContext::default(),
    )
    .await;
    assert_eq!(r.text, "just words");
    assert_eq!(r.content, MessageContent::Text("just words".into()));
    assert!(r.media.is_empty());
}

#[tokio::test]
async fn treats_a_model_it_knows_nothing_about_as_seeing_no_pictures_and_reading_no_pdfs() {
    let t = app();
    let r = adapt_media(
        &t.app,
        &blocks(vec![image(), pdf_of(&pdf(&["Unknown caps"]))]),
        None,
        &MediaContext {
            uploads_dir: Some(fresh_uploads(&t)),
            ..Default::default()
        },
    )
    .await;
    assert!(r.media.is_empty());
    assert_eq!(r.saved.len(), 2);
    assert!(r.text.contains("This AI can't see images"));
    assert!(r.text.contains("Unknown caps"));
}

#[tokio::test]
async fn saves_into_the_workspaces_uploads_folder_by_default() {
    let t = app();
    let r = adapt_media(
        &t.app,
        &blocks(vec![image()]),
        caps_for(&t, "deepseek", "deepseek-v4-pro"),
        &MediaContext {
            label: Some("DeepSeek Pro".into()),
            ..Default::default()
        },
    )
    .await;
    assert!(
        inside(&t.config().workspace_dir.join("uploads"), &r.saved[0].path),
        "{}",
        r.saved[0].path.display()
    );
}

// --- What the Node adaptMedia made of the same messages ----------------------------------------------------------------

/// A block from the capture's description of it.
fn described(d: &Value) -> ContentBlock {
    if let Some(words) = d.get("text") {
        return ContentBlock::from_value(json!({"type": "text", "text": words}));
    }
    if let Some(raw) = d.get("raw") {
        return ContentBlock::from_value(raw.clone());
    }
    let mut source = serde_json::Map::new();
    source.insert("type".into(), json!("base64"));
    let (kind, bytes) = if let Some(spec) = d.get("pdf") {
        // (Long pages are named by their count, so the capture stays small.)
        let pages: Vec<String> = if let Some(n) = spec.get("longPages").and_then(Value::as_u64) {
            (0..n)
                .map(|i| format!("Page {}. {}", i + 1, "Long words keep going on this page. ".repeat(40)))
                .collect()
        } else if let Some(n) = spec.get("longFirstPage").and_then(Value::as_u64) {
            vec![
                format!("First. {}", "A very long page goes on and on here. ".repeat(n as usize)),
                "Second".to_string(),
            ]
        } else {
            spec["pages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|page| page.as_str().unwrap().to_string())
                .collect()
        };
        source.insert("media_type".into(), json!("application/pdf"));
        let made = make_pdf(&PdfSpec {
            compress: spec["compress"] == true,
            ..PdfSpec::pages(&pages)
        });
        ("document", made)
    } else if let Some(words) = d.get("notPdf") {
        source.insert("media_type".into(), json!("application/pdf"));
        ("document", words.as_str().unwrap().as_bytes().to_vec())
    } else if let Some(of) = d.get("image") {
        if !of.is_null() {
            source.insert("media_type".into(), of.clone());
        }
        ("image", png())
    } else {
        let of = &d["audio"];
        if !of.is_null() {
            source.insert("media_type".into(), of.clone());
        }
        ("audio", AUDIO.to_vec())
    };
    source.insert("data".into(), json!(b64(&bytes)));
    if let Some(name) = d.get("sourceName") {
        source.insert("name".into(), name.clone());
    }
    let mut block = serde_json::Map::new();
    block.insert("type".into(), json!(kind));
    block.insert("source".into(), Value::Object(source));
    for key in ["name", "title"] {
        if let Some(value) = d.get(key) {
            block.insert(key.into(), value.clone());
        }
    }
    ContentBlock::from_value(Value::Object(block))
}

/// A text against the capture's: the text itself, or (a long one) its ends, its length and its SHA-256.
fn assert_same_text(ours: &str, node: &Value, what: &str) {
    match node {
        Value::String(node) => assert_eq!(ours, node, "{what}"),
        brief => {
            let units: Vec<u16> = ours.encode_utf16().collect();
            assert_eq!(units.len(), brief["length"], "{what}: {ours:.600}");
            assert_eq!(String::from_utf16_lossy(&units[..500]), brief["head"], "{what}");
            assert_eq!(
                String::from_utf16_lossy(&units[units.len() - 300..]),
                brief["tail"],
                "{what}"
            );
            assert_eq!(hex::encode(Sha256::digest(ours.as_bytes())), brief["sha256"], "{what}");
        }
    }
}

#[tokio::test]
async fn every_message_becomes_what_the_node_version_made_of_it() {
    let cases: Vec<Value> = serde_json::from_str(NODE_ADAPT_MEDIA).unwrap();
    assert_eq!(cases.len(), 25);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let t = app();
        let uploads = fresh_uploads(&t);
        let content = match &case["content"] {
            Value::String(words) => MessageContent::Text(words.clone()),
            list => MessageContent::Blocks(list.as_array().unwrap().iter().map(described).collect()),
        };
        let caps = case["caps"].as_object().map(|caps| MediaCaps {
            vision: caps["vision"] == true,
            pdf: caps["pdf"] == true,
        });
        let given = &case["ctx"];
        let transcribe: Option<TranscribeFn> = if let Some(error) = given.get("transcribeError") {
            let error = error.as_str().unwrap().to_string();
            Some(Arc::new(move |_, _, _| {
                let error = error.clone();
                Box::pin(async move { Err(error) })
            }))
        } else if let Some(transcript) = given.get("transcript") {
            let transcript = transcript.as_str().map(String::from);
            Some(Arc::new(move |_, _, _| {
                let transcript = transcript.clone();
                Box::pin(async move { Ok(transcript) })
            }))
        } else {
            None
        };
        let cx = MediaContext {
            label: given.get("label").and_then(Value::as_str).map(String::from),
            uploads_dir: Some(uploads.clone()),
            now: Some(1_794_472_200_123),
            transcribe,
            ..Default::default()
        };
        let r = adapt_media(&t.app, &content, caps, &cx).await;

        // Paths as the capture has them: the folder as "<dir>/".
        let folder = format!("{}{}", uploads.display(), std::path::MAIN_SEPARATOR);
        let scrub = |text: &str| text.replace(&folder, "<dir>/");
        let node = &case["result"];
        assert_same_text(&scrub(&r.text), &node["text"], name);
        let notes = node["notes"].as_array().unwrap();
        assert_eq!(r.notes.len(), notes.len(), "{name}");
        for (ours, node) in r.notes.iter().zip(notes) {
            assert_same_text(&scrub(ours), node, name);
        }
        let media: Vec<Value> = r
            .media
            .iter()
            .map(|block| match block {
                ContentBlock::Image(media) | ContentBlock::Document(media) => json!({
                    "type": block.block_type(),
                    "media_type": media.source.media_type,
                    "bytes": decode_base64_lenient(&media.source.data).len(),
                }),
                other => panic!("{name}: not a media block: {other:?}"),
            })
            .collect();
        assert_eq!(Value::Array(media), node["media"], "{name}");
        match &r.content {
            MessageContent::Text(words) => {
                assert_eq!(node["contentIsText"], true, "{name}");
                assert_eq!(words, &r.text, "{name}");
            }
            MessageContent::Blocks(list) => {
                let kinds: Vec<&str> = list.iter().map(ContentBlock::block_type).collect();
                assert_eq!(json!(kinds), node["contentBlocks"], "{name}");
            }
        }
        // (A compressed PDF is not the same bytes as the one Node made: its deflate is another library's. So a
        // PDF's size is checked against the file, and the others' against the capture as well.)
        let same_bytes = |kind: &str| kind != "pdf";
        let saved: Vec<Value> = r
            .saved
            .iter()
            .map(|s| {
                assert_eq!(s.size, std::fs::metadata(&s.path).unwrap().len(), "{name}");
                let size = same_bytes(s.kind).then_some(s.size);
                json!({"kind": s.kind, "name": s.name, "size": size, "path": scrub(&s.path.display().to_string())})
            })
            .collect();
        let mut node_saved = node["saved"].clone();
        for row in node_saved.as_array_mut().unwrap() {
            if !same_bytes(row["kind"].as_str().unwrap()) {
                row["size"] = Value::Null;
            }
        }
        assert_eq!(Value::Array(saved), node_saved, "{name}");
        assert_eq!(json!(listing(&uploads)), node["files"], "{name}");
    }
}

#[tokio::test]
async fn a_file_that_cant_be_saved_is_said_so_in_the_note() {
    let t = app();
    // A file is where the uploads folder would be.
    let blocked = t.path().join("not-a-folder");
    std::fs::write(&blocked, "x").unwrap();
    let cx = MediaContext {
        uploads_dir: Some(blocked.clone()),
        transcribe: Some(transcriber(Err("no speech-to-text."))),
        ..Default::default()
    };
    let r = adapt_media(
        &t.app,
        &blocks(vec![image(), pdf_of(&pdf(&["Still read"])), audio()]),
        None,
        &cx,
    )
    .await;
    assert_eq!(
        r.text,
        "[Image attached: This AI can't see images, and it could not be saved. If the person asks about it, say you can't see pictures with this model; you can still work with the file.]\n\n[PDF attached, it could not be saved (1 page). This AI can't read PDF files directly, so here is its text:]\n<pdf-text>\n--- Page 1 ---\nStill read\n</pdf-text>\n\n[Voice note: it couldn't be transcribed (no speech-to-text).]"
    );
    assert!(r.saved.is_empty());
    assert_eq!(std::fs::read_to_string(&blocked).unwrap(), "x");
}

#[tokio::test]
async fn two_files_saved_in_the_same_millisecond_get_names_of_their_own() {
    let t = app();
    let uploads = fresh_uploads(&t);
    let cx = MediaContext {
        now: Some(1_794_472_200_123),
        ..ctx("X", &uploads)
    };
    let content = blocks(vec![image()]);
    let first = adapt_media(&t.app, &content, None, &cx).await;
    let second = adapt_media(&t.app, &content, None, &cx).await;
    assert_ne!(first.saved[0].path, second.saved[0].path);
    assert_eq!(
        listing(&uploads),
        ["chat-1794472200123-0-image.png", "chat-1794472200124-0-image.png"]
    );
}

#[tokio::test]
async fn copies_over_30_days_old_are_cleared_out_when_a_file_is_saved() {
    let t = app();
    let uploads = fresh_uploads(&t);
    let now = 1_794_472_200_123_i64;
    let old = uploads.join(format!("chat-{}-0-old.png", now - 31 * 86_400_000));
    let recent = uploads.join(format!("sent-{}-recent.png", now - 29 * 86_400_000));
    std::fs::write(&old, "x").unwrap();
    std::fs::write(&recent, "x").unwrap();
    let cx = MediaContext {
        now: Some(now),
        ..ctx("X", &uploads)
    };
    adapt_media(&t.app, &blocks(vec![image()]), None, &cx).await;
    assert!(!old.exists());
    assert!(recent.exists());
}

#[test]
fn caps_come_from_either_kind_of_caps() {
    let caps = Caps {
        vision: true,
        pdf: false,
        thinking_summaries: true,
        native_budget: true,
        streaming: true,
    };
    assert_eq!(
        MediaCaps::from(caps),
        MediaCaps {
            vision: true,
            pdf: false
        }
    );
    let target = TargetCaps {
        pdf: true,
        ..Default::default()
    };
    assert_eq!(
        MediaCaps::from(target),
        MediaCaps {
            vision: false,
            pdf: true
        }
    );
    assert_eq!(PDF_INLINE_CHARS, 30_000);
    assert_eq!(PDF_INLINE_TOTAL_CHARS, 60_000);
}
