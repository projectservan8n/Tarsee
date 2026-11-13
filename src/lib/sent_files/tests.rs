//! Port of the cases of `test/chat-files.test.js` that this package can hold: the copies in the uploads folder,
//! files people send in, and what GET /api/chat/file serves (here through a small router that does what the route
//! does; the route itself, with its sign-in check, is package R1's). The cases that drive the `send_file` tool
//! (package S3) are covered at the level of `note_sent_file`, which is all the tool calls here.

use std::collections::HashMap;

use axum::Router;
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::routing::get;

use super::*;
use crate::db::conversations::{ConversationStore, NewConversation, NewMessage, to_json};
use crate::error::ApiError;
use crate::lib::chat_files::{ChatFiles, chat_files_for, file_url, forget_chat_files, place_files_on_page};
use crate::lib::live_bus::{LiveBus, new_turn_id};
use crate::testkit::http::{self, TestResponse};
use crate::testkit::{TestApp, test_app};

struct Chat {
    t: TestApp,
    store: ConversationStore,
    bus: std::sync::Arc<LiveBus>,
    uploads: PathBuf,
    /// A folder outside the uploads folder, where the agent's own files are.
    outside: PathBuf,
}

fn chat() -> Chat {
    let t = test_app();
    let bus = LiveBus::init(&t.app);
    ChatFiles::init(&t.app).expect("the chat_files table");
    let store = ConversationStore::new(&t.app);
    let uploads = uploads_dir(t.config());
    let outside = t.path().join("deliverables");
    fs::create_dir_all(&outside).unwrap();
    Chat {
        t,
        store,
        bus,
        uploads,
        outside,
    }
}

impl Chat {
    fn write(&self, name: &str, body: &str) -> PathBuf {
        let p = self.outside.join(name);
        fs::write(&p, body).unwrap();
        p
    }

    fn conv(&self, title: &str) -> String {
        self.store.create(NewConversation::titled(title)).unwrap().id
    }

    fn say(&self, conv: &str, role: &str, content: &str) -> String {
        self.store.add_message(conv, NewMessage::new(role, content)).unwrap().id
    }

    fn files_events(&self, conv: &str) -> Vec<LiveEvent> {
        self.bus
            .recent_events(conv, 300)
            .into_iter()
            .filter(|e| e.r#type == "files")
            .collect()
    }

    fn sent(&self, conv: &str, path: &Path, caption: &str, via: &str) -> Option<NotedSentFile> {
        note_sent_file(
            &self.t.app,
            SentFile {
                abs_path: path,
                caption,
                conversation_id: Some(conv),
                via,
            },
        )
    }

    /// What routes/chat.js GET /file does, without the sign-in in front of it.
    fn router(&self) -> Router {
        async fn file(
            State(app): State<App>,
            method: Method,
            headers: HeaderMap,
            Query(query): Query<HashMap<String, String>>,
        ) -> Response {
            let found = query
                .get("p")
                .and_then(|p| viewable_path(p, &uploads_dir(app.config())));
            let Some(file) = found else {
                return ApiError::not_found("File not found").into_response();
            };
            let opts = SendOptions {
                save: query.get("dl").map(String::as_str) == Some("1"),
                ..SendOptions::default()
            };
            send_viewable(&method, &headers, &file, &opts).await
        }
        Router::new()
            .route("/api/chat/file", get(file))
            .with_state(self.t.app.clone())
    }

    async fn open(&self, path: &Path) -> TestResponse {
        http::get(&self.router(), &file_url(&path.to_string_lossy())).await
    }

    async fn open_with(&self, path: &Path, headers: &[(&str, &str)]) -> TestResponse {
        let mut request = http::request("GET", &file_url(&path.to_string_lossy()));
        for (name, value) in headers {
            request = request.header(name, value);
        }
        http::send(&self.router(), request).await
    }
}

fn base_name(p: &Path) -> String {
    p.file_name().unwrap().to_string_lossy().into_owned()
}

// ── What the agent sends into a chat is kept with that chat (the tool's cases, at the level of note_sent_file) ───

#[tokio::test]
async fn a_file_sent_during_a_turn_a_copy_in_the_uploads_folder_on_its_chat_with_the_turns_id_on_the_live_feed() {
    let c = chat();
    let telegram = c.conv("telegram:777");
    c.say(&telegram, "user", "give me the october report");
    let turn_id = new_turn_id();
    c.bus
        .publish(&telegram, "turn_start", json!({ "source": "telegram" }), Some(&turn_id));
    let report = c.write("October Report.html", "<h1>October</h1>");
    let noted = c.sent(&telegram, &report, "Here it is", "telegram").unwrap();

    let rows = chat_files_for(&c.t.app, &telegram);
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.from, "agent");
    assert_eq!(row.turn_id.as_deref(), Some(turn_id.as_str()));
    assert_eq!(row.via, "telegram");
    assert_eq!(row.caption, "Here it is");
    let kept = Path::new(&row.path);
    assert!(kept.starts_with(&c.uploads), "{}", row.path);
    let name = base_name(kept);
    let stamp = name
        .strip_prefix("sent-")
        .and_then(|rest| rest.strip_suffix("-October Report.html"))
        .unwrap_or_else(|| panic!("{name}"));
    assert!(stamp.len() == 13 && stamp.bytes().all(|b| b.is_ascii_digit()), "{name}");
    assert_eq!(fs::read_to_string(kept).unwrap(), "<h1>October</h1>");
    let events = c.files_events(&telegram);
    let evt = events.last().unwrap();
    assert_eq!(evt.turn_id.as_deref(), Some(turn_id.as_str()));
    assert_eq!(
        evt.payload,
        json!({ "from": "agent", "caption": "Here it is", "files": [
            { "id": row.id, "name": "October Report.html", "size": 16, "path": row.path },
        ] })
    );
    assert_eq!(noted.event.as_ref(), Some(evt));
    assert_eq!(noted.conversation_id, telegram);
    assert_eq!(
        to_json(&noted.file),
        json!({ "id": row.id, "name": "October Report.html", "size": 16, "path": row.path })
    );

    // The dashboard's history has it on the reply of that turn (attached above), and opens it.
    c.say(&telegram, "assistant", "Here's the report");
    c.bus.publish(
        &telegram,
        "turn_end",
        json!({ "stopReason": "end_turn" }),
        Some(&turn_id),
    );
    let mut page: Vec<Value> = c.store.get_messages(&telegram).iter().map(to_json).collect();
    place_files_on_page(&c.t.app, &telegram, &mut page, true);
    let reply = page.last().unwrap();
    assert_eq!(reply["role"], "assistant");
    assert_eq!(
        reply["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| (f["name"].clone(), f["from"].clone(), f["gone"].clone()))
            .collect::<Vec<_>>(),
        [(json!("October Report.html"), json!("agent"), json!(false))]
    );
    let url = reply["files"][0]["url"].as_str().unwrap();
    let res = http::get(&c.router(), url).await;
    assert_eq!(res.status, 200);
    assert_eq!(
        res.header("content-type"),
        Some("text/plain; charset=utf-8"),
        "a web page is shown as text, never run"
    );
    assert!(res.header("content-security-policy").unwrap().starts_with("sandbox"));
    assert_eq!(res.text(), "<h1>October</h1>");
    let dl = http::get(&c.router(), &format!("{url}&dl=1")).await;
    assert!(
        dl.header("content-disposition")
            .unwrap()
            .starts_with("attachment; filename=\"October Report.html\"")
    );
}

#[tokio::test]
async fn a_file_sent_with_no_turn_at_work_is_a_row_after_the_latest_message_and_one_into_a_quiet_chat_leads_it() {
    let c = chat();
    let topic = c.conv("telegram:-1009:topic:4");
    c.say(&topic, "user", "anyone have the deck?");
    let deck = c.write("deck.pdf", "%PDF-1.4");
    let noted = c.sent(&topic, &deck, "", "telegram").unwrap();
    assert_eq!(noted.event.as_ref().unwrap().turn_id, None);
    let mut page: Vec<Value> = c.store.get_messages(&topic).iter().map(to_json).collect();
    place_files_on_page(&c.t.app, &topic, &mut page, true);
    assert_eq!(
        page.last().unwrap()["filesAfter"][0]["name"],
        "deck.pdf",
        "no turn of its own there: a row after its latest message"
    );

    // Into a chat with nothing said yet: before every message, only on a page that starts at the beginning.
    let quiet = c.conv("#quiet");
    c.sent(&quiet, &c.write("hello.txt", "hi"), "", "discord").unwrap();
    c.say(&quiet, "user", "thanks");
    let mut page: Vec<Value> = c.store.get_messages(&quiet).iter().map(to_json).collect();
    let lead = place_files_on_page(&c.t.app, &quiet, &mut page, true);
    assert_eq!(lead.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["hello.txt"]);

    // The files it emails: on the conversation it sent them from, said so.
    c.sent(
        &topic,
        &c.write("invoice.pdf", "%PDF-1.4"),
        "Emailed to sam@example.com",
        "email",
    )
    .unwrap();
    let last = chat_files_for(&c.t.app, &topic).pop().unwrap();
    assert_eq!(
        (last.name.as_str(), last.via.as_str(), last.caption.as_str()),
        ("invoice.pdf", "email", "Emailed to sam@example.com")
    );
}

#[test]
fn a_file_that_cannot_be_kept_keeps_nothing_and_fails_nothing() {
    let c = chat();
    let conv = c.conv("chat");
    assert_eq!(
        c.sent(&conv, &c.outside.join("never-written.zip"), "", "telegram"),
        None
    );
    assert_eq!(c.sent("", &c.write("a.txt", "x"), "", "telegram"), None);
    assert_eq!(c.sent(&conv, Path::new(""), "", "telegram"), None);
    let none = note_sent_file(
        &c.t.app,
        SentFile {
            abs_path: &c.write("b.txt", "x"),
            caption: "",
            conversation_id: None,
            via: "",
        },
    );
    assert_eq!(none, None);
    assert!(chat_files_for(&c.t.app, &conv).is_empty());
    assert!(c.files_events(&conv).is_empty());
}

#[test]
fn with_no_chat_files_table_the_copy_is_still_made_and_the_page_still_told() {
    let t = test_app();
    let bus = LiveBus::init(&t.app);
    let source = t.path().join("note.txt");
    fs::write(&source, "hello").unwrap();
    let noted = note_sent_file(
        &t.app,
        SentFile {
            abs_path: &source,
            caption: &"c".repeat(600),
            conversation_id: Some("conv-1"),
            via: "web",
        },
    )
    .unwrap();
    assert_eq!(noted.file.id, None);
    assert_eq!(noted.file.name, "note.txt");
    assert!(Path::new(&noted.file.path).starts_with(uploads_dir(t.config())));
    let evt = &bus.events_since("conv-1", 0, 10)[0];
    // No id on a file that has no row; the caption is cut to 500.
    assert_eq!(
        evt.payload,
        json!({ "from": "agent", "caption": "c".repeat(500), "files": [
            { "name": "note.txt", "size": 5, "path": noted.file.path },
        ] })
    );
}

// ── test/chat-files.test.js: "the history puts each file in its place" (the two cases that are not placeFiles) ───

#[test]
fn a_copy_tidied_away_is_marked_gone_clear_and_a_deleted_chat_take_their_rows() {
    let c = chat();
    let conv = c.conv("tidy");
    c.say(&conv, "user", "hi");
    let rows = record_chat_files(
        &c.t.app,
        &conv,
        &[KeptFile {
            name: "old.txt".into(),
            size: 2,
            path: c.uploads.join("sent-1000000000000-old.txt"),
        }],
        &RecordOptions::default(),
    );
    assert!(rows[0].gone);
    assert_eq!(forget_chat_files(&c.t.app, &conv), 1);
    let doomed = c.conv("doomed");
    c.say(&doomed, "user", "hi");
    c.sent(&doomed, &c.write("doomed.txt", "x"), "", "").unwrap();
    assert_eq!(chat_files_for(&c.t.app, &doomed).len(), 1);
    // (What DELETE /api/chat/conversations/:id does: the store's delete, then the files' rows.)
    assert!(c.store.delete(&doomed).unwrap());
    forget_chat_files(&c.t.app, &doomed);
    assert_eq!(chat_files_for(&c.t.app, &doomed).len(), 0);
}

#[test]
fn copies_over_30_days_old_are_cleared_out_as_new_ones_come_other_files_in_the_folder_are_left_alone() {
    let c = chat();
    fs::create_dir_all(&c.uploads).unwrap();
    let now = now_ms();
    let old = c.uploads.join(format!("sent-{}-old.pdf", now - 31 * 86_400_000));
    let fresh = c.uploads.join(format!("chat-{}-0-fresh.pdf", now - 86_400_000));
    let theirs = c.uploads.join("telegram-1000000000000-theirs.pdf");
    for f in [&old, &fresh, &theirs] {
        fs::write(f, "x").unwrap();
    }
    tidy_kept_files(&c.uploads, now);
    assert_eq!([&old, &fresh, &theirs].map(|f| f.exists()), [false, true, true]);
    // A folder that is not there is nothing to tidy.
    tidy_kept_files(&c.uploads.join("missing"), now);
}

#[test]
fn tidying_goes_by_the_time_in_the_name_and_stops_at_what_it_cannot_remove() {
    let c = chat();
    fs::create_dir_all(&c.uploads).unwrap();
    let now = 1_800_000_000_000;
    let just_inside = c.uploads.join(format!("sent-{}-edge.txt", now - 30 * 86_400_000));
    let just_over = c.uploads.join(format!("chat-{}-0-over.txt", now - 30 * 86_400_000 - 1));
    let short_stamp = c.uploads.join("sent-100000000000-short.txt");
    let zero = c.uploads.join("sent-0000000000000-zero.txt");
    for f in [&just_inside, &just_over, &short_stamp, &zero] {
        fs::write(f, "x").unwrap();
    }
    tidy_kept_files(&c.uploads, now);
    assert_eq!(
        [&just_inside, &just_over, &short_stamp, &zero].map(|f| f.exists()),
        [true, false, true, true]
    );
}

// ── test/chat-files.test.js: "files people send in show too" ─────────────────────────────────────────────────────

#[test]
fn an_upload_in_the_dashboards_chat_each_file_kept_on_its_message_the_page_told() {
    let c = chat();
    let web = c.conv("Web Chat");
    let id = c.say(&web, "user", "(sent 2 files)");
    let kept = keep_uploaded_files(
        &[
            UploadedFile {
                name: "../../a b.png".into(),
                buffer: b"png".to_vec(),
            },
            UploadedFile {
                name: "notes.md".into(),
                buffer: b"# hi".to_vec(),
            },
        ],
        &c.uploads,
        now_ms(),
    )
    .unwrap();
    assert_eq!(
        kept.iter().map(|k| k.path.parent().unwrap()).collect::<Vec<_>>(),
        [c.uploads.as_path(), c.uploads.as_path()],
        "never out of the folder, whatever the name"
    );
    assert_eq!(
        kept.iter().map(|k| k.name.as_str()).collect::<Vec<_>>(),
        ["a b.png", "notes.md"]
    );
    assert_eq!(kept.iter().map(|k| k.size).collect::<Vec<_>>(), [3, 4]);
    assert_eq!(fs::read_to_string(&kept[1].path).unwrap(), "# hi");
    let rows = note_received_files(
        &c.t.app,
        ReceivedFiles {
            conversation_id: &web,
            message_id: Some(&id),
            files: &kept,
            via: "web",
        },
    );
    let on_message: Vec<_> = chat_files_for(&c.t.app, &web)
        .into_iter()
        .filter(|r| r.message_id.as_deref() == Some(id.as_str()))
        .map(|r| r.from)
        .collect();
    assert_eq!(on_message, ["in", "in"]);
    let events = c.files_events(&web);
    let evt = events.last().unwrap();
    assert_eq!(evt.payload["from"], "in");
    assert_eq!(evt.payload["messageId"], id);
    assert_eq!(
        evt.payload["files"],
        json!([
            { "id": rows[0].id, "name": "a b.png", "size": 3, "path": rows[0].path },
            { "id": rows[1].id, "name": "notes.md", "size": 4, "path": rows[1].path },
        ])
    );
    assert_eq!(evt.turn_id, None);
    // Nothing for nothing.
    assert!(
        keep_uploaded_files(&[], &c.uploads.join("never-made"), 1)
            .unwrap()
            .is_empty()
    );
    assert!(!c.uploads.join("never-made").exists());
    assert!(
        note_received_files(
            &c.t.app,
            ReceivedFiles {
                conversation_id: &web,
                ..ReceivedFiles::default()
            }
        )
        .is_empty()
    );
}

#[test]
fn a_picture_a_channel_hands_the_agent_as_bytes_kept_on_the_persons_message_not_twice_a_pdf_is_left_to_its_note() {
    let c = chat();
    let conv = c.conv("telegram:888");
    let id = c.say(&conv, "user", "what is this?");
    // "png-bytes" in base64
    let png =
        json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "cG5nLWJ5dGVz" } });
    let pdf = json!({ "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": "JVBERg==" } });
    let rows = note_media_blocks(&c.t.app, &conv, &[png.clone(), pdf], MediaBlockOptions::default());
    assert_eq!(
        rows.iter()
            .map(|r| (r.name.as_str(), r.message_id.as_deref(), r.from.as_str()))
            .collect::<Vec<_>>(),
        [("image.png", Some(id.as_str()), "in")]
    );
    assert_eq!(fs::read_to_string(&rows[0].path).unwrap(), "png-bytes");
    assert!(
        note_media_blocks(
            &c.t.app,
            &conv,
            std::slice::from_ref(&png),
            MediaBlockOptions::default()
        )
        .is_empty(),
        "that message has its files already"
    );
    // A turn that waited behind another: its picture goes on the message it answers, not the one that came in since.
    let with_photo = c.say(&conv, "user", "[photo]");
    let later = c.say(&conv, "user", "what's this?");
    let kept = note_media_blocks(
        &c.t.app,
        &conv,
        std::slice::from_ref(&png),
        MediaBlockOptions {
            message_id: Some(&with_photo),
            ..MediaBlockOptions::default()
        },
    );
    assert_eq!(
        kept.iter().map(|r| r.message_id.as_deref()).collect::<Vec<_>>(),
        [Some(with_photo.as_str())]
    );
    assert_ne!(with_photo, later);
}

#[test]
fn several_pictures_are_numbered_and_named_by_their_kind_into_the_folder_and_at_the_time_given() {
    let c = chat();
    let conv = c.conv("discord:1");
    c.say(&conv, "user", "two photos");
    let dir = c.t.path().join("elsewhere");
    let blocks = [
        json!({ "type": "image", "source": { "media_type": "IMAGE/JPEG", "data": "anBn" } }),
        json!({ "type": "image", "source": { "media_type": "image/x-unknown", "data": "eA==" } }),
        json!({ "type": "image", "source": { "media_type": "image/png", "data": "" } }),
        json!({ "type": "image" }),
        json!("not a block"),
    ];
    let rows = note_media_blocks(
        &c.t.app,
        &conv,
        &blocks,
        MediaBlockOptions {
            via: "discord",
            dir: Some(&dir),
            now: Some(1_793_000_000_000),
            ..MediaBlockOptions::default()
        },
    );
    assert_eq!(
        rows.iter()
            .map(|r| (r.name.as_str(), r.size, r.via.as_str()))
            .collect::<Vec<_>>(),
        [("image-1.jpg", 3, "discord"), ("image-2.png", 1, "discord")]
    );
    assert_eq!(
        rows.iter().map(|r| PathBuf::from(&r.path)).collect::<Vec<_>>(),
        [
            dir.join("chat-1793000000000-0-image-1.jpg"),
            dir.join("chat-1793000000000-1-image-2.png")
        ]
    );
    // No pictures, no conversation, or nobody's message to put them on: nothing.
    assert!(note_media_blocks(&c.t.app, &conv, &[], MediaBlockOptions::default()).is_empty());
    assert!(note_media_blocks(&c.t.app, "", &blocks, MediaBlockOptions::default()).is_empty());
    let silent = c.conv("silent");
    assert!(note_media_blocks(&c.t.app, &silent, &blocks, MediaBlockOptions::default()).is_empty());
}

// ── test/chat-files.test.js: "GET /api/chat/file: only the uploads folder" ───────────────────────────────────────

#[tokio::test]
async fn nothing_outside_it_no_way_out_of_it_no_link_out_of_it() {
    let c = chat();
    fs::create_dir_all(&c.uploads).unwrap();
    let secret = c.write("secret.txt", "secret");
    assert_eq!(c.open(&secret).await.status, 404);
    let way_out = c.uploads.join("..").join("..").join("deliverables").join("secret.txt");
    assert!(way_out.exists());
    assert_eq!(c.open(&way_out).await.status, 404);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&secret, c.uploads.join("link.txt")).unwrap();
        assert_eq!(c.open(&c.uploads.join("link.txt")).await.status, 404);
    }
    let folder = c.open(&c.uploads).await;
    assert_eq!(folder.status, 404, "nor the folder itself");
    assert_eq!(folder.json(), json!({ "error": "File not found" }));
    let inside = c.uploads.join("telegram-6-photo.jpg");
    fs::write(&inside, "jpg").unwrap();
    let ok = c.open(&inside).await;
    assert_eq!(ok.status, 200);
    assert_eq!(ok.header("content-type"), Some("image/jpeg"));
    assert!(
        ok.header("content-disposition")
            .unwrap()
            .starts_with("inline; filename=\"photo.jpg\"")
    );
    assert_eq!(ok.text(), "jpg");
}

#[tokio::test]
async fn a_kind_the_browser_cant_show_goes_as_a_download_a_pdf_without_the_sandbox_its_viewer_needs_to_run() {
    let c = chat();
    fs::create_dir_all(&c.uploads).unwrap();
    let zip = c.uploads.join("chat-1-0-bundle.zip");
    fs::write(&zip, "PK").unwrap();
    assert!(
        c.open(&zip)
            .await
            .header("content-disposition")
            .unwrap()
            .starts_with("attachment; filename=\"bundle.zip\"")
    );
    let pdf = c.uploads.join("chat-1-1-doc.pdf");
    fs::write(&pdf, "%PDF-1.4").unwrap();
    let res = c.open(&pdf).await;
    assert_eq!(res.header("content-type"), Some("application/pdf"));
    assert_eq!(res.header("content-security-policy"), None);
}

// ── Sending the file: what Express's sendFile did, now done here ─────────────────────────────────────────────────

fn etag_of(file: &Path) -> (String, String) {
    let stat = fs::metadata(file).unwrap();
    let since = stat.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap();
    let ms = ((since.as_nanos() + 500_000) / 1_000_000) as i64;
    let last_modified = DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    (format!("W/\"{:x}-{ms:x}\"", stat.len()), last_modified)
}

#[tokio::test]
async fn a_whole_file_goes_out_with_its_headers_as_express_sent_them() {
    let c = chat();
    fs::create_dir_all(&c.uploads).unwrap();
    let file = c.uploads.join("sent-1793000000000-notes (final).txt");
    fs::write(&file, "0123456789").unwrap();
    let (etag, last_modified) = etag_of(&file);
    let res = c.open(&file).await;
    assert_eq!(res.status, 200);
    let headers: Vec<(String, String)> = res
        .headers
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_str().unwrap().to_string()))
        .collect();
    let expected = [
        ("content-type", "text/plain; charset=utf-8"),
        ("x-content-type-options", "nosniff"),
        ("content-disposition", "inline; filename=\"notes (final).txt\""),
        ("cache-control", "private, max-age=3600"),
        (
            "content-security-policy",
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'",
        ),
        ("accept-ranges", "bytes"),
        ("last-modified", last_modified.as_str()),
        ("etag", etag.as_str()),
        ("content-length", "10"),
    ];
    assert_eq!(
        headers,
        expected.map(|(name, value)| (name.to_string(), value.to_string()))
    );
    assert_eq!(res.text(), "0123456789");
    assert!(
        last_modified.ends_with(" GMT") && last_modified.len() == 29,
        "{last_modified}"
    );

    // HEAD: the headers, no body.
    let head = http::send(&c.router(), http::request("HEAD", &file_url(&file.to_string_lossy()))).await;
    assert_eq!(
        (head.status, head.header("content-length"), head.body.len()),
        (200, Some("10"), 0)
    );
}

#[tokio::test]
async fn a_range_gets_its_part_several_get_the_whole_file_and_one_that_cannot_be_met_gets_404() {
    let c = chat();
    fs::create_dir_all(&c.uploads).unwrap();
    let file = c.uploads.join("chat-1-0-clip.mp4");
    fs::write(&file, "0123456789").unwrap();
    let (etag, last_modified) = etag_of(&file);

    let part = |range: &'static str| {
        let c = &c;
        let file = &file;
        async move {
            let res = c.open_with(file, &[("range", range)]).await;
            (
                res.status,
                res.header("content-range").map(String::from),
                res.header("content-length").map(String::from),
                res.text(),
            )
        }
    };
    let got = |status: u16, range: Option<&str>, length: &str, body: &str| {
        (
            status,
            range.map(String::from),
            Some(length.to_string()),
            body.to_string(),
        )
    };
    assert_eq!(part("bytes=2-5").await, got(206, Some("bytes 2-5/10"), "4", "2345"));
    assert_eq!(part("bytes=7-").await, got(206, Some("bytes 7-9/10"), "3", "789"));
    assert_eq!(part("bytes=-3").await, got(206, Some("bytes 7-9/10"), "3", "789"));
    assert_eq!(part("bytes=0-0").await, got(206, Some("bytes 0-0/10"), "1", "0"));
    assert_eq!(part("bytes=4-99").await, got(206, Some("bytes 4-9/10"), "6", "456789"));
    assert_eq!(part("  bytes= 1 - 2 ").await, got(206, Some("bytes 1-2/10"), "2", "12"));
    // Overlapping and adjacent ranges are one range.
    assert_eq!(
        part("bytes=0-2,3-5,4-6").await,
        got(206, Some("bytes 0-6/10"), "7", "0123456")
    );
    // Several ranges, or what is no byte range: the whole file.
    assert_eq!(part("bytes=0-1,5-6").await, got(200, None, "10", "0123456789"));
    assert_eq!(part("lines=1-2").await, got(200, None, "10", "0123456789"));
    assert_eq!(part("bytes").await, got(200, None, "10", "0123456789"));
    // A range that cannot be met: the JS callback answered 404 with no body, the headers set so far kept.
    for unmet in ["bytes=10-", "bytes=20-30", "bytes=5-2", "bytes=-20", "bytes=a-b"] {
        let res = c.open_with(&file, &[("range", unmet)]).await;
        assert_eq!((res.status, res.body.len()), (404, 0), "{unmet}");
        assert_eq!(res.header("content-range"), Some("bytes */10"), "{unmet}");
        assert_eq!(res.header("content-type"), Some("video/mp4"), "{unmet}");
    }
    // If-Range: the range only of the version the browser has.
    let fresh = c.open_with(&file, &[("range", "bytes=0-1"), ("if-range", &etag)]).await;
    assert_eq!((fresh.status, fresh.text()), (206, "01".to_string()));
    let stale = c
        .open_with(&file, &[("range", "bytes=0-1"), ("if-range", "W/\"1-1\"")])
        .await;
    assert_eq!((stale.status, stale.text()), (200, "0123456789".to_string()));
    let dated = c
        .open_with(&file, &[("range", "bytes=0-1"), ("if-range", &last_modified)])
        .await;
    assert_eq!(dated.status, 206);
    let older = c
        .open_with(
            &file,
            &[("range", "bytes=0-1"), ("if-range", "Mon, 01 Jan 2001 00:00:00 GMT")],
        )
        .await;
    assert_eq!(older.status, 200);
    // An empty file has no first byte to give.
    let empty = c.uploads.join("chat-1-1-empty.txt");
    fs::write(&empty, "").unwrap();
    assert_eq!(c.open_with(&empty, &[("range", "bytes=0-")]).await.status, 404);
    assert_eq!(c.open(&empty).await.header("content-length"), Some("0"));
}

#[tokio::test]
async fn a_copy_the_browser_already_has_is_answered_304_and_a_precondition_that_fails_404() {
    let c = chat();
    fs::create_dir_all(&c.uploads).unwrap();
    let file = c.uploads.join("chat-1-0-photo.png");
    fs::write(&file, "png").unwrap();
    let (etag, last_modified) = etag_of(&file);
    let strong = etag.trim_start_matches("W/").to_string();

    let unchanged = c.open_with(&file, &[("if-none-match", &etag)]).await;
    assert_eq!((unchanged.status, unchanged.body.len()), (304, 0));
    assert_eq!(
        unchanged.header("content-type"),
        None,
        "the content headers are taken off"
    );
    // (axum itself writes "content-length: 0" on any answer with no body, this one included; Node sent none.)
    assert_eq!(unchanged.header("content-range"), None);
    assert_eq!(unchanged.header("etag"), Some(etag.as_str()));
    assert_eq!(unchanged.header("cache-control"), Some("private, max-age=3600"));

    let status = |headers: Vec<(&'static str, String)>| {
        let c = &c;
        let file = &file;
        async move {
            let headers: Vec<(&str, &str)> = headers.iter().map(|(name, value)| (*name, value.as_str())).collect();
            c.open_with(file, &headers).await.status
        }
    };
    assert_eq!(
        status(vec![("if-none-match", strong.clone())]).await,
        304,
        "weak and strong match"
    );
    assert_eq!(status(vec![("if-none-match", format!("\"x\", {etag}"))]).await, 304);
    assert_eq!(status(vec![("if-none-match", "*".to_string())]).await, 304);
    assert_eq!(status(vec![("if-none-match", "\"other\"".to_string())]).await, 200);
    assert_eq!(status(vec![("if-modified-since", last_modified.clone())]).await, 304);
    assert_eq!(
        status(vec![("if-modified-since", "Mon, 01 Jan 2001 00:00:00 GMT".to_string())]).await,
        200
    );
    assert_eq!(status(vec![("if-modified-since", "not a date".to_string())]).await, 200);
    // If-None-Match wins over If-Modified-Since; a reload (no-cache) always gets the file.
    assert_eq!(
        status(vec![
            ("if-none-match", "\"other\"".to_string()),
            ("if-modified-since", last_modified.clone())
        ])
        .await,
        200
    );
    assert_eq!(
        status(vec![
            ("if-none-match", etag.clone()),
            ("cache-control", "max-age=0, no-cache".to_string())
        ])
        .await,
        200
    );
    // Preconditions: the JS callback turned Express's 412 into 404.
    assert_eq!(status(vec![("if-match", etag.clone())]).await, 200);
    assert_eq!(status(vec![("if-match", "*".to_string())]).await, 200);
    assert_eq!(status(vec![("if-match", "\"other\"".to_string())]).await, 404);
    assert_eq!(status(vec![("if-unmodified-since", last_modified.clone())]).await, 200);
    assert_eq!(
        status(vec![(
            "if-unmodified-since",
            "Mon, 01 Jan 2001 00:00:00 GMT".to_string()
        )])
        .await,
        404
    );
}

#[tokio::test]
async fn a_file_that_has_gone_is_404_with_no_body() {
    let c = chat();
    let gone = send_viewable(
        &Method::GET,
        &HeaderMap::new(),
        &c.uploads.join("chat-1-0-gone.txt"),
        &SendOptions::default(),
    )
    .await;
    assert_eq!(gone.status(), StatusCode::NOT_FOUND);
    assert_eq!(gone.headers().get("content-length"), None);
    fs::create_dir_all(&c.uploads).unwrap();
    let folder = send_viewable(&Method::GET, &HeaderMap::new(), &c.uploads, &SendOptions::default()).await;
    assert_eq!(folder.status(), StatusCode::NOT_FOUND);
    // Another cache policy, when the route asks for one.
    let file = c.uploads.join("chat-1-0-a.txt");
    fs::write(&file, "a").unwrap();
    let opts = SendOptions {
        cache: "no-store".into(),
        save: true,
    };
    let res = send_viewable(&Method::GET, &HeaderMap::new(), &file, &opts).await;
    assert_eq!(res.headers().get("cache-control").unwrap(), "no-store");
    assert_eq!(
        res.headers().get("content-disposition").unwrap(),
        "attachment; filename=\"a.txt\""
    );
}

// ── The helpers the Node tests reached only through the tool and the route ───────────────────────────────────────

#[test]
fn a_kept_copy_is_a_link_or_a_copy_named_by_its_time_and_a_file_already_in_the_folder_is_used_as_it_is() {
    let c = chat();
    let source = c.write("Q3 report (final) ñ.pdf", "%PDF");
    let first = keep_sent_file(&source, &c.uploads, 1_793_000_000_000).unwrap();
    assert_eq!(first.name, "Q3 report (final) _.pdf");
    assert_eq!(first.size, 4);
    assert_eq!(first.path, c.uploads.join("sent-1793000000000-Q3 report (final) _.pdf"));
    assert_eq!(fs::read_to_string(&first.path).unwrap(), "%PDF");
    // two in the same millisecond
    let second = keep_sent_file(&source, &c.uploads, 1_793_000_000_000).unwrap();
    assert_eq!(
        second.path,
        c.uploads.join("sent-1793000000001-Q3 report (final) _.pdf")
    );
    let third = keep_sent_file(&source, &c.uploads, 1_793_000_000_000).unwrap();
    assert_eq!(third.path, c.uploads.join("sent-1793000000002-Q3 report (final) _.pdf"));
    // Already in the uploads folder (what a channel saved, or a copy kept before): no second copy.
    let theirs = c.uploads.join("telegram-1793000000000-photo.jpg");
    fs::write(&theirs, "jpg").unwrap();
    let before = fs::read_dir(&c.uploads).unwrap().count();
    let same = keep_sent_file(&theirs, &c.uploads, 1_793_000_000_999).unwrap();
    assert_eq!((same.name.as_str(), same.size), ("photo.jpg", 3));
    assert_eq!(same.path, real_path(&theirs).unwrap());
    assert_eq!(fs::read_dir(&c.uploads).unwrap().count(), before);
    // The path is an ordinary one, as Node's realpath gave (no \\?\ in front on Windows).
    assert!(!same.path.to_string_lossy().starts_with(r"\\?\"));
    assert!(keep_sent_file(&c.outside.join("missing.txt"), &c.uploads, 1).is_err());
    // The copy outlives the original.
    fs::remove_file(&source).unwrap();
    assert_eq!(fs::read_to_string(&first.path).unwrap(), "%PDF");
    assert_eq!(
        to_json(&first),
        json!({ "name": "Q3 report (final) _.pdf", "size": 4, "path": first.path.to_string_lossy() })
    );
}

#[test]
fn names_are_made_safe_and_shown_as_the_node_version_did() {
    let bs = '\\';
    let safe = [
        ("../../a b.png", "a b.png"),
        (&format!("C:{bs}x{bs}y{bs}résumé (1).pdf"), "r_sum_ (1).pdf"),
        ("...hidden", "hidden"),
        ("", "file"),
        ("a/b/", "file"),
        ("  spaced  .txt", "spaced  .txt"),
        ("naïve🐒.txt", "na_ve_.txt"),
        (".env", "env"),
        ("a\tb\nc.txt", "a_b_c.txt"),
        ("..", "file"),
        ("a..b", "a..b"),
        (" . ", "."),
    ];
    for (name, expected) in safe {
        assert_eq!(safe_file_name(name), expected, "{name:?}");
    }
    assert_eq!(
        safe_file_name(&format!("{}.pdf", "x".repeat(200))),
        format!("{}.pdf", "x".repeat(116)),
        "the last 120 characters"
    );

    let shown = [
        ("/w/uploads/sent-1793000000000-Report.pdf", "Report.pdf"),
        ("/w/uploads/chat-1793000000000-2-notes.md", "notes.md"),
        ("telegram-6-photo.jpg", "photo.jpg"),
        ("/w/uploads/plain.txt", "plain.txt"),
        ("", "file"),
        ("/w/uploads/sent-1-", "file"),
        ("/w/dir/", "dir"),
        ("/w/uploads/chat-12-34-56-x.txt", "56-x.txt"),
        ("/w/uploads/SENT-1-x.txt", "SENT-1-x.txt"),
    ];
    for (path, expected) in shown {
        assert_eq!(shown_name(path), expected, "{path:?}");
    }
    #[cfg(windows)]
    assert_eq!(shown_name(r"C:\w\uploads\email-3-12-deck.pptx"), "deck.pptx");

    assert_eq!(
        disposition_name("/w/uploads/sent-1-Q3 report (final).pdf"),
        "Q3 report (final).pdf"
    );
    assert_eq!(disposition_name("/w/uploads/chat-1-0-naïve \"x\".txt"), "na_ve _x_.txt");
    assert_eq!(disposition_name("/w/uploads/sent-1-"), "file");
}

#[test]
fn each_kind_of_file_goes_out_as_what_it_is_as_text_or_as_a_download() {
    let kind = |file: &str| {
        let k = view_kind(file);
        (k.r#type, k.download)
    };
    assert_eq!(kind("a.PNG"), ("image/png", false));
    assert_eq!(kind("b.html"), ("text/plain; charset=utf-8", false));
    assert_eq!(kind("c.zip"), ("application/octet-stream", true));
    assert_eq!(kind(".env"), ("application/octet-stream", true));
    assert_eq!(kind("x.env"), ("text/plain; charset=utf-8", false));
    assert_eq!(kind("noext"), ("application/octet-stream", true));
    assert_eq!(kind("d.Mp4"), ("video/mp4", false));
    assert_eq!(kind("e.svg"), ("text/plain; charset=utf-8", false));
    assert_eq!(kind("f."), ("application/octet-stream", true));
    assert_eq!(kind("g.tar.gz"), ("application/octet-stream", true));
    assert_eq!(kind("/w/up.loads/file"), ("application/octet-stream", true));
    assert_eq!(kind("/w/uploads/voice.OPUS"), ("audio/ogg", false));
    assert_eq!(
        to_json(&view_kind("a.pdf")),
        json!({ "type": "application/pdf", "download": false })
    );
}

#[test]
fn base64_is_read_as_node_read_it() {
    let read = |text: &str| String::from_utf8_lossy(&decode_base64_lenient(text)).into_owned();
    assert_eq!(read("cG5nLWJ5dGVz"), "png-bytes");
    assert_eq!(read("cG5n LWJ5\ndGVz"), "png-bytes", "whitespace is passed over");
    assert_eq!(read("cG5nLWJ5dGVz=="), "png-bytes");
    assert_eq!(read("cG5nLWJ5dGV"), "png-byte", "no padding needed");
    assert_eq!(read("cG5n*LWJ5dGVz"), "png-bytes", "nor anything that is not base64");
    assert_eq!(read("cG5n=LWJ5"), "png", "the end at the first =");
    assert_eq!(read("c"), "");
    assert_eq!(decode_base64_lenient("_-8="), [0xff, 0xef], "the URL alphabet too");
}

#[test]
fn only_a_file_inside_the_uploads_folder_may_be_looked_at() {
    let c = chat();
    fs::create_dir_all(c.uploads.join("sub")).unwrap();
    let inside = c.uploads.join("sub").join("chat-1-0-a.txt");
    fs::write(&inside, "a").unwrap();
    let real = real_path(&inside).unwrap();
    let text = |p: &Path| p.to_string_lossy().into_owned();
    assert_eq!(viewable_path(&text(&inside), &c.uploads), Some(real.clone()));
    // "." and ".." are taken out before anything is looked up.
    let roundabout = c
        .uploads
        .join("sub")
        .join("..")
        .join(".")
        .join("sub")
        .join("chat-1-0-a.txt");
    assert_eq!(viewable_path(&text(&roundabout), &c.uploads), Some(real));
    assert_eq!(viewable_path("", &c.uploads), None);
    assert_eq!(viewable_path(&format!("{}\0", text(&inside)), &c.uploads), None);
    assert_eq!(viewable_path(&text(&c.uploads), &c.uploads), None, "the folder itself");
    assert_eq!(
        viewable_path(&text(&c.uploads.join("sub")), &c.uploads),
        None,
        "a folder in it"
    );
    assert_eq!(viewable_path(&text(&c.uploads.join("missing.txt")), &c.uploads), None);
    assert_eq!(viewable_path(&text(&c.write("out.txt", "x")), &c.uploads), None);
    assert_eq!(viewable_path(&text(&inside), &c.uploads.join("missing")), None);
    // A folder whose name only starts like the uploads folder's is not inside it.
    let lookalike = c.t.config().workspace_dir.join("uploads-other");
    fs::create_dir_all(&lookalike).unwrap();
    fs::write(lookalike.join("b.txt"), "b").unwrap();
    assert_eq!(viewable_path(&text(&lookalike.join("b.txt")), &c.uploads), None);
}

// ── Fix round 1 ──────────────────────────────────────────────────────────────────────────────────────────────────

/// The names in a folder, sorted.
fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(to_namespaced(dir))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// "Joining paths" and "File names on Windows": whatever a person calls a file, its copy is one plain name inside
/// the uploads folder, and on every system it is the name that was asked for. (Each line was read off Node.)
#[test]
fn an_upload_called_anything_at_all_is_kept_under_one_plain_name_in_the_folder() {
    let c = chat();
    let called = [
        ("C:\\Windows\\win.ini", "win.ini"),
        ("/etc/passwd", "passwd"),
        ("\\\\server\\share\\x.txt", "x.txt"),
        ("..", "file"),
        ("a.", "a."),
        ("b ", "b"),
        ("...", "file"),
        ("nul", "nul"),
        ("nul.txt", "nul.txt"),
        ("con", "con"),
        ("a:b.txt", "a_b.txt"),
        ("", "file"),
        ("ok.txt", "ok.txt"),
    ];
    let files: Vec<UploadedFile> = called
        .iter()
        .map(|(name, _)| UploadedFile {
            name: (*name).to_string(),
            buffer: b"x".to_vec(),
        })
        .collect();
    let kept = keep_uploaded_files(&files, &c.uploads, 1_793_000_000_000).unwrap();
    let mut on_disk = Vec::new();
    for (i, ((_, name), kept)) in called.iter().zip(&kept).enumerate() {
        let file = format!("chat-1793000000000-{i}-{name}");
        assert_eq!(kept.name, *name);
        assert_eq!(kept.path, c.uploads.join(&file));
        assert_eq!(kept.size, 1);
        on_disk.push(file);
    }
    on_disk.sort();
    // Exactly these names are in the folder, and nothing was written anywhere else: `a.` is a file called `a.`
    // (Windows left to itself would call it `a`), and `nul` is a file, not the null device.
    assert_eq!(names_in(&c.uploads), on_disk);
    assert_eq!(
        names_in(&c.t.config().workspace_dir)
            .iter()
            .filter(|n| *n == "uploads")
            .count(),
        1
    );
    assert!(!c.t.path().join("win.ini").exists() && !c.outside.join("passwd").exists());
    // Each is the file the page is then given, under the name it was kept by.
    for kept in &kept {
        let seen = viewable_path(&kept.path.to_string_lossy(), &c.uploads);
        assert_eq!(seen.as_deref(), Some(kept.path.as_path()), "{}", kept.name);
        assert_eq!(fs::read(to_namespaced(&kept.path)).unwrap(), b"x");
    }
}

/// The second guard of "Joining paths": `safe_file_name` gives one plain name, and should a name ever reach the join
/// that is not one, the copy is still a file in the folder and nowhere else.
#[test]
fn a_kept_copys_path_is_in_the_folder_whatever_name_reaches_the_join() {
    let dir = Path::new("uploads");
    let in_dir = |file: &str| dir.join(file);
    assert_eq!(kept_path(dir, "chat-5-0-", "notes.txt"), in_dir("chat-5-0-notes.txt"));
    // (With the time in front of it, ".." is only two dots in a name.)
    assert_eq!(kept_path(dir, "sent-5-", ".."), in_dir("sent-5-.."));
    for not_plain in [
        "",
        "/etc/passwd",
        "C:\\Windows\\win.ini",
        "C:win.ini",
        "\\\\server\\share\\x",
        "a/b",
        "a\\b",
        "..\\..\\x",
        "../x",
        "a\0b",
    ] {
        assert_eq!(
            kept_path(dir, "chat-5-0-", not_plain),
            in_dir("chat-5-0-file"),
            "{not_plain:?}"
        );
    }
}

/// The path of a file the agent sends comes from the model. One that only reads as a file because of what Windows
/// does to names is no file, as in Node (ENOENT), on every system.
#[test]
fn a_sent_file_must_be_there_under_the_very_name_given() {
    let c = chat();
    c.write("secret.txt", "secret");
    for not_there in [
        "nul",
        "...",
        "secret.txt.",
        "secret.txt ",
        "missing",
        "con",
        "secret.txt\\..\\nul",
    ] {
        let path = c.outside.join(not_there);
        assert!(
            keep_sent_file(&path, &c.uploads, 1_793_000_000_500).is_err(),
            "{not_there:?} was kept"
        );
        assert_eq!(c.sent("conv", &path, "", "telegram"), None, "{not_there:?}");
    }
    assert!(
        !c.uploads.exists() || names_in(&c.uploads).is_empty(),
        "nothing was copied"
    );

    // A file whose own name ends in a dot is that file, and its copy has that name.
    let dotted = c.outside.join("report.");
    fs::write(to_namespaced(&dotted), "r").unwrap();
    let kept = keep_sent_file(&dotted, &c.uploads, 1_793_000_000_900).unwrap();
    assert_eq!((kept.name.as_str(), kept.size), ("report.", 1));
    assert_eq!(kept.path, c.uploads.join("sent-1793000000900-report."));
    assert_eq!(names_in(&c.uploads), ["sent-1793000000900-report."]);
    assert_eq!(fs::read_to_string(to_namespaced(&kept.path)).unwrap(), "r");
    // A way round to a real file is the real file.
    let round = c.outside.join("x").join("..").join(".").join("secret.txt");
    let kept = keep_sent_file(&round, &c.uploads, 1_793_000_001_000).unwrap();
    assert_eq!(kept.path, c.uploads.join("sent-1793000001000-secret.txt"));
}

#[test]
fn tidying_removes_the_copy_it_names_and_not_what_windows_would_make_of_the_name() {
    let c = chat();
    fs::create_dir_all(&c.uploads).unwrap();
    let now = 1_793_000_000_000;
    let old = now - 31 * 86_400_000;
    let dotted = c.uploads.join(format!("sent-{old}-old."));
    let plain = c.uploads.join(format!("sent-{}-old", now - 86_400_000));
    let fresh_dotted = c.uploads.join(format!("chat-{}-0-new.", now - 1000));
    for f in [&dotted, &plain, &fresh_dotted] {
        fs::write(to_namespaced(f), "x").unwrap();
    }
    tidy_kept_files(&c.uploads, now);
    assert_eq!(
        names_in(&c.uploads),
        [
            format!("chat-{}-0-new.", now - 1000),
            format!("sent-{}-old", now - 86_400_000)
        ]
    );
}

/// Review finding M10, and the spellings the Node version refused or kept as written (each line was read off Node
/// on Windows; elsewhere the same names are simply other files, or none).
#[test]
fn a_file_is_looked_up_under_the_name_as_written_and_no_other_spelling_of_it() {
    let c = chat();
    fs::create_dir_all(c.uploads.join("sub")).unwrap();
    let inside = c.uploads.join("sub").join("chat-1-0-a.txt");
    fs::write(&inside, "a").unwrap();
    let text = |p: &Path| p.to_string_lossy().into_owned();
    let view = |p: &str| viewable_path(p, &c.uploads);
    let written = text(&inside);
    assert_eq!(view(&written), Some(inside.clone()));
    // Names that only Windows reads as this file, or as something else altogether.
    assert_eq!(view(&format!("{written}.")), None, "a trailing dot");
    assert_eq!(view(&format!("{written} ")), None, "a trailing space");
    assert_eq!(view(&text(&c.uploads.join("nul"))), None);
    assert_eq!(view(&text(&c.uploads.join("..."))), None);
    assert_eq!(view(&text(&c.uploads.join("sub").join("..."))), None);
    assert_eq!(view(&text(&c.uploads.join("con"))), None);
    // A file that really has such a name is that file.
    let dotted = c.uploads.join("chat-1-1-a.");
    fs::write(to_namespaced(&dotted), "dotted").unwrap();
    assert_eq!(view(&text(&dotted)), Some(dotted.clone()));
    assert_eq!(
        view(&text(&c.uploads.join("chat-1-1-a"))),
        None,
        "and not the name without the dot"
    );

    #[cfg(windows)]
    {
        // Another case of a name inside the folder: the path as written (Node gave it back so).
        let upper = written.replace("\\sub\\", "\\SUB\\");
        assert_eq!(view(&upper), Some(PathBuf::from(&upper)));
        let upper_file = written.replace("chat-1-0-a.txt", "CHAT-1-0-A.TXT");
        assert_eq!(view(&upper_file), Some(PathBuf::from(&upper_file)));
        // Forward slashes are the same path.
        assert_eq!(view(&written.replace('\\', "/")), Some(inside.clone()));
        // Another spelling of the folder itself is not the folder: Node compared the two as text.
        assert_eq!(view(&format!("\\\\?\\{written}")), None, "a \\\\?\\ in front");
        assert_eq!(view(&format!("\\\\.\\{written}")), None, "a \\\\.\\ in front");
        let lower_drive = format!("{}{}", written[..1].to_lowercase(), &written[1..]);
        assert_ne!(
            lower_drive, written,
            "the test folder is on a drive with a capital letter"
        );
        assert_eq!(view(&lower_drive), None, "the drive's letter in the other case");
        let other_case_folder = written.replace("\\uploads\\", "\\UPLOADS\\");
        assert_eq!(view(&other_case_folder), None, "the uploads folder in another case");
        // The file's other stream is the path as written (and goes out as a download: no known kind).
        let stream = format!("{written}::$DATA");
        assert_eq!(view(&stream), Some(PathBuf::from(&stream)));
        assert_eq!(view_kind(&stream).r#type, "application/octet-stream");
    }
}

/// A link is followed, as `fs.realpathSync` followed it: one that leads out of the folder is refused, one that
/// stays inside gives the real file. On Windows the link is a junction, which needs no special right to make.
#[test]
fn a_link_in_the_folder_is_followed_to_where_it_leads() {
    let c = chat();
    fs::create_dir_all(c.uploads.join("sub")).unwrap();
    let inside = c.uploads.join("sub").join("chat-1-0-a.txt");
    fs::write(&inside, "a").unwrap();
    c.write("secret.txt", "secret");
    let link = |from: &Path, to: &Path| {
        #[cfg(unix)]
        std::os::unix::fs::symlink(to, from).unwrap();
        #[cfg(windows)]
        {
            let made = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(from)
                .arg(to)
                .output()
                .unwrap();
            assert!(made.status.success(), "a junction could not be made: {made:?}");
        }
    };
    link(&c.uploads.join("out"), &c.outside);
    link(&c.uploads.join("in"), &c.uploads.join("sub"));
    let text = |p: &Path| p.to_string_lossy().into_owned();
    assert!(c.uploads.join("out").join("secret.txt").exists(), "the link works");
    assert_eq!(
        viewable_path(&text(&c.uploads.join("out").join("secret.txt")), &c.uploads),
        None
    );
    assert_eq!(
        viewable_path(&text(&c.uploads.join("in").join("chat-1-0-a.txt")), &c.uploads),
        Some(inside.clone())
    );
    assert_eq!(real_path(&c.uploads.join("in")).unwrap(), c.uploads.join("sub"));
    assert_eq!(real_path(&c.uploads.join("out")).unwrap(), c.outside);
    // Past a link, ".." is the folder the link is in (taken out as text before anything is followed).
    assert_eq!(
        real_path(&c.uploads.join("out").join("..").join("sub")).unwrap(),
        c.uploads.join("sub")
    );
    // A file the agent sends through a link into the folder is already in it; through one out of it, it is copied.
    let through = keep_sent_file(&c.uploads.join("in").join("chat-1-0-a.txt"), &c.uploads, 5).unwrap();
    assert_eq!((through.name.as_str(), through.path), ("a.txt", inside));
    let copied = keep_sent_file(&c.uploads.join("out").join("secret.txt"), &c.uploads, 1_793_000_000_000).unwrap();
    assert_eq!(copied.path, c.uploads.join("sent-1793000000000-secret.txt"));
}

/// Review finding M9: Express's `send` refused a path with ".." in it whatever came before; the JS callback made
/// that a 404. The route checks first (`viewable_path`); this is the second guard.
#[tokio::test]
async fn sending_refuses_a_path_with_dot_dot_in_it_whatever_the_route_checked() {
    let c = chat();
    fs::create_dir_all(&c.uploads).unwrap();
    let secret = c.write("secret.txt", "secret");
    let inside = c.uploads.join("chat-1-0-a.txt");
    fs::write(&inside, "a").unwrap();
    let send = |file: PathBuf| async move {
        let res = send_viewable(&Method::GET, &HeaderMap::new(), &file, &SendOptions::default()).await;
        let status = res.status().as_u16();
        let kind = res
            .headers()
            .get("content-type")
            .map(|v| v.to_str().unwrap().to_string());
        let body = http_body_util::BodyExt::collect(res.into_body())
            .await
            .unwrap()
            .to_bytes();
        (status, kind, String::from_utf8_lossy(&body).into_owned())
    };
    let text_kind = Some("text/plain; charset=utf-8".to_string());
    assert_eq!(
        send(secret.clone()).await,
        (200, text_kind.clone(), "secret".to_string())
    );
    for up in [
        c.uploads.join("..").join("..").join("deliverables").join("secret.txt"),
        c.uploads.join("sub").join("..").join("chat-1-0-a.txt"),
        PathBuf::from(format!("{}/../uploads/chat-1-0-a.txt", c.uploads.display())),
        PathBuf::from(".."),
    ] {
        assert_eq!(send(up.clone()).await.0, 404, "{}", up.display());
    }
    assert_eq!(
        send(c.uploads.join("..")).await,
        (404, Some("application/octet-stream".to_string()), String::new())
    );
    // Dots that are part of a name are a name.
    let dotty = c.uploads.join("chat-1-0-a..b.txt");
    fs::write(&dotty, "dots").unwrap();
    assert_eq!(send(dotty).await, (200, text_kind.clone(), "dots".to_string()));
    // And the file opened is the file named: no other file answers for a trailing dot, nor a device for `nul`.
    assert_eq!(send(PathBuf::from(format!("{}.", inside.display()))).await.0, 404);
    assert_eq!(send(c.uploads.join("nul")).await.0, 404);
    assert!(
        has_up_segment("a\\..\\b") && has_up_segment("../b") && has_up_segment("a/..") && !has_up_segment("a/..b/c.")
    );
}

/// Review finding M7: the pattern replaces UTF-16 units, so an emoji is two "_" (each line was read off Node).
#[test]
fn a_download_name_has_one_underscore_for_each_utf16_unit_it_may_not_hold() {
    assert_eq!(disposition_name("/w/uploads/chat-1-0-a🐒.txt"), "a__.txt");
    assert_eq!(disposition_name("🐒-1-x"), "__-1-x");
    assert_eq!(disposition_name("/w/uploads/sent-1-ñ é.pdf"), "_ _.pdf");
    // A kept name folds a run of them into one.
    assert_eq!(safe_file_name("a🐒🐒b.txt"), "a_b.txt");
    assert_eq!(safe_file_name("🐒"), "_");
}

// ── The same work from async code: off the runtime's threads, and to its end whoever waits ───────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_async_twins_do_the_same_work() {
    let c = chat();
    let conv = c.conv("telegram:1");
    let said = c.say(&conv, "user", "here");
    // An upload.
    let files = vec![
        UploadedFile {
            name: "../a b.png".into(),
            buffer: b"png".to_vec(),
        },
        UploadedFile {
            name: "nul".into(),
            buffer: Vec::new(),
        },
    ];
    let kept = keep_uploaded_files_async(files.clone(), &c.uploads, 1_793_000_000_000)
        .await
        .unwrap();
    assert_eq!(
        kept.iter().map(|k| (k.name.as_str(), k.size)).collect::<Vec<_>>(),
        [("a b.png", 3), ("nul", 0)]
    );
    assert_eq!(kept[0].path, c.uploads.join("chat-1793000000000-0-a b.png"));
    assert_eq!(fs::read(&kept[0].path).unwrap(), b"png");
    // A file the agent sent: the copy, the row, the event.
    let report = c.write("report.txt", "r");
    let noted = note_sent_file_async(
        &c.t.app,
        SentFile {
            abs_path: &report,
            caption: "Here",
            conversation_id: Some(&conv),
            via: "telegram",
        },
    )
    .await
    .unwrap();
    assert_eq!(noted.file.name, "report.txt");
    assert_eq!(c.files_events(&conv).last(), noted.event.as_ref());
    assert_eq!(chat_files_for(&c.t.app, &conv).len(), 1);
    let none = SentFile {
        abs_path: &c.outside.join("missing"),
        caption: "",
        conversation_id: Some(&conv),
        via: "",
    };
    assert_eq!(note_sent_file_async(&c.t.app, none).await, None);
    let copy = keep_sent_file_async(&report, &c.uploads, 1_793_000_000_777)
        .await
        .unwrap();
    assert_eq!(copy.path, c.uploads.join("sent-1793000000777-report.txt"));
    assert!(
        keep_sent_file_async(&c.outside.join("nul"), &c.uploads, 1)
            .await
            .is_err()
    );
    // Pictures handed to the agent as bytes.
    let png = json!({ "type": "image", "source": { "media_type": "image/png", "data": "cG5nLWJ5dGVz" } });
    let rows = note_media_blocks_async(
        &c.t.app,
        &conv,
        std::slice::from_ref(&png),
        MediaBlockOptions {
            via: "telegram",
            now: Some(1_793_000_000_001),
            ..MediaBlockOptions::default()
        },
    )
    .await;
    assert_eq!(
        rows.iter()
            .map(|r| (r.name.as_str(), r.message_id.as_deref(), r.via.as_str()))
            .collect::<Vec<_>>(),
        [("image.png", Some(said.as_str()), "telegram")]
    );
    assert_eq!(
        PathBuf::from(&rows[0].path),
        c.uploads.join("chat-1793000000001-0-image.png")
    );
    assert!(
        note_media_blocks_async(&c.t.app, &conv, &[png], MediaBlockOptions::default())
            .await
            .is_empty()
    );
    // Tidying.
    let old = c.uploads.join("sent-1000000000000-old.txt");
    fs::write(&old, "x").unwrap();
    tidy_kept_files_async(&c.uploads, now_ms()).await;
    assert!(!old.exists());
}

/// "A promise runs whether or not anyone waits for it": a caller that goes away (its request was dropped) half way
/// does not leave a file half kept. Node's call was synchronous: once begun it finished.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_is_kept_to_the_end_even_when_the_caller_stops_waiting() {
    let c = chat();
    let conv = c.conv("telegram:2");
    let report = c.write("big.bin", &"x".repeat(200_000));
    {
        let keeping = note_sent_file_async(
            &c.t.app,
            SentFile {
                abs_path: &report,
                caption: "",
                conversation_id: Some(&conv),
                via: "telegram",
            },
        );
        tokio::pin!(keeping);
        // Begun, and then nobody waits for it.
        let _ = futures::poll!(keeping.as_mut());
    }
    let wait = async {
        while c.files_events(&conv).is_empty() {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(20), wait)
        .await
        .expect("the file was kept and told to the timeline");
    let rows = chat_files_for(&c.t.app, &conv);
    assert_eq!(rows.len(), 1);
    assert_eq!(fs::metadata(&rows[0].path).unwrap().len(), 200_000);

    let files = vec![UploadedFile {
        name: "upload.bin".into(),
        buffer: vec![7u8; 300_000],
    }];
    {
        let keeping = keep_uploaded_files_async(files, &c.uploads, 1_793_000_000_000);
        tokio::pin!(keeping);
        let _ = futures::poll!(keeping.as_mut());
    }
    let kept = c.uploads.join("chat-1793000000000-0-upload.bin");
    let wait = async {
        while fs::metadata(&kept).map(|m| m.len()).unwrap_or(0) != 300_000 {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(20), wait)
        .await
        .expect("the upload was written whole");
}
