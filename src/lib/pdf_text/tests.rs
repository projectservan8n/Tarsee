//! Tests of `lib::pdf_text`: the cases of `test/pdf-read.test.js` that exercise `lib/pdf-text.js` directly (the
//! built-in reader, the choice of reader, page ranges, the pdf_read tool called directly, downloads), and the
//! pieces of the hand-written reader the Node tests reached only through whole PDFs. Cases that need pdftotext or
//! the stand-in for it are in `tests/it/pdf_text.rs`.

use std::sync::Arc;

use axum::Router;
use axum::http::StatusCode;
use axum::http::header::LOCATION;
use axum::response::IntoResponse;
use axum::routing::get;
use parking_lot::Mutex;
use serde_json::json;

use super::*;
use crate::testkit::make_pdf::{Encode, PdfSpec, make_pdf};
use crate::testkit::{TestApp, test_app};

fn spec(pages: &[&str]) -> PdfSpec {
    PdfSpec::pages(pages)
}

fn pages_of(text: BuiltinText) -> Vec<String> {
    assert_eq!(text.error, None);
    text.pages
}

/// A page of about `n` characters of numbered sentences.
fn long_page(p: usize, n: usize) -> String {
    let mut s = String::new();
    let mut k = 1;
    while s.len() < n {
        s.push_str(&format!("Page {p} sentence {k} says something worth reading. "));
        k += 1;
    }
    s.trim().to_string()
}

/// A test app whose PDF reader never uses pdftotext, with an uploads folder in its workspace.
fn app() -> TestApp {
    let t = test_app();
    PdfReader::of(&t.app).set_pdftotext(None);
    std::fs::create_dir_all(t.config().workspace_dir.join("uploads")).unwrap();
    t
}

/// Write a PDF into the workspace's uploads folder and return its absolute path.
fn put(t: &TestApp, name: &str, bytes: &[u8]) -> PathBuf {
    let file = t.config().workspace_dir.join("uploads").join(name);
    std::fs::write(&file, bytes).unwrap();
    file
}

async fn pdf_read(t: &TestApp, input: Value) -> String {
    read_pdf_tool(&t.app, &input, None).await
}

// ---------------------------------------------------------------- the built-in PDF reader (no pdftotext)

#[test]
fn reads_each_pages_lines_in_order() {
    let r = builtin_pdf_text(&make_pdf(&spec(&[
        "Hello world\nSecond line (with parens)",
        "Page two text",
    ])));
    assert_eq!(r.error, None);
    assert_eq!(r.pages, ["Hello world\nSecond line (with parens)", "Page two text"]);
}

#[test]
fn reads_flate_compressed_content() {
    let r = builtin_pdf_text(&make_pdf(&PdfSpec {
        compress: true,
        ..spec(&["Compressed page one", "Compressed page two"])
    }));
    assert_eq!(pages_of(r), ["Compressed page one", "Compressed page two"]);
}

#[test]
fn reads_a_pdf_1_5_whose_pages_sit_in_a_compressed_object_stream() {
    let r = builtin_pdf_text(&make_pdf(&PdfSpec {
        obj_stm: true,
        compress: true,
        ..spec(&["Packed one", "Packed two"])
    }));
    assert_eq!(pages_of(r), ["Packed one", "Packed two"]);
}

#[test]
fn undoes_asciihex_and_ascii85_over_flate() {
    let hex = builtin_pdf_text(&make_pdf(&PdfSpec {
        encode: Some(Encode::Hex),
        ..spec(&["Hex encoded words", "Second hex page"])
    }));
    assert_eq!(pages_of(hex), ["Hex encoded words", "Second hex page"]);
    let a85 = ["Base eighty five words, quite a few of them to cross lines", "Page two"];
    let r = builtin_pdf_text(&make_pdf(&PdfSpec {
        encode: Some(Encode::A85),
        ..spec(&a85)
    }));
    assert_eq!(pages_of(r), a85);
}

#[test]
fn undoes_png_predictors_in_content_and_in_object_streams() {
    let pages = [
        "Predicted rows of text that run past sixteen bytes",
        "More predicted text",
    ];
    let r = builtin_pdf_text(&make_pdf(&PdfSpec {
        predictor: true,
        ..spec(&pages)
    }));
    assert_eq!(pages_of(r), pages);
    let r = builtin_pdf_text(&make_pdf(&PdfSpec {
        predictor: true,
        obj_stm: true,
        ..spec(&pages)
    }));
    assert_eq!(pages_of(r), pages);
    let r = builtin_pdf_text(&make_pdf(&PdfSpec {
        cid_font: true,
        encode: Some(Encode::A85),
        predictor: true,
        ..spec(&["Héllo Ñandú"])
    }));
    assert_eq!(pages_of(r), ["Héllo Ñandú"]);
}

#[test]
fn decodes_a_2_byte_font_through_its_to_unicode_map_accents_included() {
    let r = builtin_pdf_text(&make_pdf(&PdfSpec {
        cid_font: true,
        compress: true,
        ..spec(&["Héllo Ñandú world"])
    }));
    assert_eq!(pages_of(r), ["Héllo Ñandú world"]);
}

#[test]
fn turns_a_wide_tj_gap_into_a_space_and_a_narrow_one_into_nothing() {
    let r = builtin_pdf_text(&make_pdf(&PdfSpec {
        kerned: true,
        ..spec(&["Kerned words here"])
    }));
    assert_eq!(pages_of(r), ["Kerned words here"]);
}

#[test]
fn includes_text_drawn_from_a_form_xobject() {
    let r = builtin_pdf_text(&make_pdf(&PdfSpec {
        form_xobject: Some("Inside the form".into()),
        ..spec(&["Page body"])
    }));
    let pages = pages_of(r);
    assert!(pages[0].contains("Page body"), "{pages:?}");
    assert!(pages[0].contains("Inside the form"), "{pages:?}");
}

#[test]
fn gives_an_empty_page_for_a_page_with_no_text_as_a_scanned_page_reads() {
    let r = builtin_pdf_text(&make_pdf(&spec(&["", "Words"])));
    assert_eq!(pages_of(r), ["", "Words"]);
}

#[test]
fn says_a_locked_pdf_is_locked() {
    let r = builtin_pdf_text(&make_pdf(&PdfSpec {
        encrypted: true,
        ..spec(&["Secret"])
    }));
    let error = r.error.unwrap();
    assert!(error.contains("locked") || error.contains("password"), "{error}");
    assert!(r.pages.is_empty());
}

#[test]
fn refuses_bytes_that_are_not_a_pdf_and_survives_a_cut_off_one() {
    let r = builtin_pdf_text(b"just some text, no pdf here");
    assert!(r.error.unwrap().to_lowercase().contains("isn't a pdf"));
    let whole = make_pdf(&PdfSpec {
        compress: true,
        ..spec(&["One", "Two"])
    });
    // Never panics, whatever it reads.
    let _ = builtin_pdf_text(&whole[..whole.len() / 2]);
    for cut in (10..whole.len()).step_by(37) {
        let _ = builtin_pdf_text(&whole[..cut]);
    }
}

// ---------------------------------------------------------------- pdfText picks the reader

#[tokio::test]
async fn falls_back_to_the_built_in_reader_when_pdftotext_is_not_installed() {
    let t = test_app();
    let reader = PdfReader::of(&t.app);
    reader.set_pdftotext(None);
    let r = reader
        .pdf_text(
            Bytes::from(make_pdf(&spec(&["Fallback works"]))),
            PdfTextOptions::default(),
        )
        .await;
    assert_eq!(r.reader, Some(ReaderKind::Builtin));
    assert_eq!(r.pages, ["Fallback works"]);
    assert_eq!(r.error, None);
}

#[tokio::test]
async fn falls_back_to_the_built_in_reader_when_pdftotext_cant_run() {
    let t = test_app();
    let reader = PdfReader::of(&t.app);
    reader.set_pdftotext(Some(t.path().join("no-such-pdftotext")));
    let r = reader
        .pdf_text(Bytes::from(make_pdf(&spec(&["Still read"]))), PdfTextOptions::default())
        .await;
    assert_eq!(r.reader, Some(ReaderKind::Builtin));
    assert_eq!(r.pages, ["Still read"]);
}

#[tokio::test]
async fn without_pdftotext_on_the_path_the_built_in_reader_is_used() {
    // The test app's environment has no PATH, so looking for pdftotext finds nothing.
    let t = test_app();
    let r = pdf_text(
        &t.app,
        Bytes::from(make_pdf(&spec(&["Looked for"]))),
        PdfTextOptions::default(),
    )
    .await;
    assert_eq!(r.reader, Some(ReaderKind::Builtin));
    assert_eq!(r.pages, ["Looked for"]);
}

#[tokio::test]
async fn not_a_pdf_has_no_reader_and_a_locked_one_says_why() {
    let t = test_app();
    let reader = PdfReader::of(&t.app);
    reader.set_pdftotext(None);
    let r = reader
        .pdf_text(Bytes::from_static(b"plain words"), PdfTextOptions::default())
        .await;
    assert_eq!(
        r,
        PdfTextResult {
            pages: vec![],
            reader: None,
            error: Some("this isn't a PDF".into())
        }
    );
    let locked = make_pdf(&PdfSpec {
        encrypted: true,
        ..spec(&["x"])
    });
    let r = reader.pdf_text(Bytes::from(locked), PdfTextOptions::default()).await;
    assert_eq!(r.reader, Some(ReaderKind::Builtin));
    assert!(r.pages.is_empty());
    assert!(r.error.unwrap().contains("password"));
}

#[tokio::test]
async fn a_pdf_read_before_comes_from_the_cache_and_the_cache_keeps_six() {
    let t = test_app();
    let reader = PdfReader::of(&t.app);
    reader.set_pdftotext(None);
    let first = make_pdf(&spec(&["Cached"]));
    reader
        .pdf_text(Bytes::from(first.clone()), PdfTextOptions::default())
        .await;
    assert_eq!(reader.cache.lock().len(), 1);
    for n in 0..6 {
        let other = make_pdf(&spec(&[&format!("Other {n}")]));
        reader.pdf_text(Bytes::from(other), PdfTextOptions::default()).await;
    }
    let cache = reader.cache.lock().clone();
    assert_eq!(cache.len(), CACHE_ENTRIES);
    let first_key = hex::encode(Sha256::digest(&first));
    assert!(cache.iter().all(|(k, _)| *k != first_key), "the oldest went first");
    // A hit moves to the newest place.
    let oldest = cache[0].0.clone();
    let again = make_pdf(&spec(&["Other 0"]));
    let r = reader.pdf_text(Bytes::from(again), PdfTextOptions::default()).await;
    assert_eq!(r.pages, ["Other 0"]);
    assert_eq!(reader.cache.lock().last().unwrap().0, oldest);
    // Choosing another pdftotext empties it.
    reader.set_pdftotext(None);
    assert!(reader.cache.lock().is_empty());
    reader.forget_pdftotext();
    assert!(matches!(*reader.pdftotext.lock(), Pdftotext::Unknown));
}

// ---------------------------------------------------------------- page ranges

#[test]
fn reads_n_n_m_and_n_against_the_page_count() {
    let range = |first, last| Ok(PageRange { first, last });
    assert_eq!(parse_page_range(&Value::Null, 9), range(1, 9));
    assert_eq!(parse_page_range(&json!("3"), 9), range(3, 3));
    assert_eq!(parse_page_range(&json!(4), 9), range(4, 4));
    assert_eq!(parse_page_range(&json!("2-5"), 9), range(2, 5));
    assert_eq!(parse_page_range(&json!(" 6 - "), 9), range(6, 9));
    assert_eq!(parse_page_range(&json!("7-40"), 9), range(7, 9));
    assert_eq!(parse_page_range(&json!("ALL"), 9), range(1, 9));
    assert_eq!(parse_page_range(&json!("   "), 9), range(1, 9));
}

#[test]
fn refuses_pages_that_are_not_there_or_not_page_numbers() {
    let err = |spec: Value| parse_page_range(&spec, 9).unwrap_err();
    assert!(err(json!("12")).contains("9 pages"));
    assert_eq!(err(json!("12")), "this PDF has 9 pages, so there is no page 12.");
    assert!(err(json!("0")).to_lowercase().contains("page"));
    assert!(err(json!("5-2")).to_lowercase().contains("page"));
    assert_eq!(
        err(json!("abc")),
        "\"abc\" isn't a page or a range of pages: use 3, 2-5, or 6- for page 6 to the end."
    );
    assert_eq!(
        err(json!("5-2")),
        "\"5-2\" isn't a range of pages: pages count from 1, e.g. 2-5."
    );
    assert_eq!(
        err(json!(2.5)),
        "\"2.5\" isn't a page or a range of pages: use 3, 2-5, or 6- for page 6 to the end."
    );
    assert_eq!(
        parse_page_range(&json!("2"), 1).unwrap_err(),
        "this PDF has 1 page, so there is no page 2."
    );
}

#[test]
fn fit_pages_stops_at_a_page_edge_and_cuts_only_a_first_page_too_long() {
    let pages: Vec<String> = vec!["a".repeat(30), "b".repeat(30), String::new()];
    let fit = fit_pages(&pages, 4, 100);
    assert_eq!(fit.last, 5);
    assert!(!fit.partial);
    assert_eq!(
        fit.text,
        format!(
            "--- Page 4 ---\n{}\n\n--- Page 5 ---\n{}",
            "a".repeat(30),
            "b".repeat(30)
        )
    );
    let all = fit_pages(&pages, 1, 1000);
    assert!(all.text.ends_with("--- Page 3 ---\n(no text on this page)"));
    let cut = fit_pages(&["x ".repeat(100)], 1, 30);
    assert!(cut.partial);
    assert_eq!(cut.last, 1);
    assert_eq!(cut.text, "--- Page 1 ---\nx x x x x x x\n…");
    let none = fit_pages(&[], 3, 10);
    assert_eq!((none.text.as_str(), none.last, none.partial), ("", 2, false));
}

// ---------------------------------------------------------------- pdf_read, called directly

#[tokio::test]
async fn reads_a_pdf_in_the_uploads_folder_by_a_workspace_relative_or_absolute_path() {
    let t = app();
    let file = put(&t, "report.pdf", &make_pdf(&spec(&["Hello world", "Page two text"])));
    for p in [json!("uploads/report.pdf"), json!(file.to_string_lossy())] {
        let out = pdf_read(&t, json!({ "path": p })).await;
        assert!(out.contains("report.pdf: pages 1-2 of 2"), "{out}");
        assert!(out.contains("--- Page 1 ---\nHello world"), "{out}");
        assert!(out.contains("--- Page 2 ---\nPage two text"), "{out}");
    }
    // The old names for the path still work.
    let out = pdf_read(&t, json!({ "source": "  uploads/report.pdf " })).await;
    assert!(out.starts_with("report.pdf: pages 1-2 of 2\n\n--- Page 1 ---"), "{out}");
}

#[tokio::test]
async fn reads_only_the_pages_asked_for() {
    let t = app();
    put(
        &t,
        "three.pdf",
        &make_pdf(&spec(&["First page", "Second page", "Third page"])),
    );
    let two = pdf_read(&t, json!({ "path": "uploads/three.pdf", "pages": "2" })).await;
    assert!(two.contains("pages 2-2 of 3"), "{two}");
    assert!(two.contains("Second page"));
    assert!(!two.contains("First page") && !two.contains("Third page"));
    let rest = pdf_read(&t, json!({ "path": "uploads/three.pdf", "pages": "2-" })).await;
    let second = rest.find("Second page").unwrap();
    assert!(rest[second..].contains("Third page"), "{rest}");
    let none = pdf_read(&t, json!({ "path": "uploads/three.pdf", "pages": "8" })).await;
    assert!(
        none.starts_with("pdf_read error: ") && none.contains("3 pages"),
        "{none}"
    );
}

#[tokio::test]
async fn stops_a_long_pdf_at_a_page_edge_and_says_which_pages_to_ask_for_next() {
    let t = app();
    let pages: Vec<String> = (1..=30).map(|p| long_page(p, 1000)).collect();
    put(
        &t,
        "long.pdf",
        &make_pdf(&PdfSpec {
            pages,
            compress: true,
            ..PdfSpec::default()
        }),
    );
    let out = pdf_read(&t, json!({ "path": "uploads/long.pdf" })).await;
    assert!(
        utf16_len(&out) < 12_000,
        "the default answer is {} characters, over what a tool result shows inline",
        utf16_len(&out)
    );
    let shown: usize = regex::Regex::new(r"pages 1-([0-9]+) of 30")
        .unwrap()
        .captures(&out)
        .and_then(|c| c[1].parse().ok())
        .unwrap();
    assert!((5..30).contains(&shown), "showed up to page {shown}");
    assert!(out.contains(&format!("--- Page {shown} ---")));
    assert!(!out.contains(&format!("--- Page {} ---", shown + 1)));
    assert!(
        out.contains(&format!("pages \"{}-30\"", shown + 1)),
        "it does not say which pages to ask for next"
    );
    let more = pdf_read(
        &t,
        json!({ "path": "uploads/long.pdf", "pages": format!("{}-", shown + 1), "max_chars": 50_000 }),
    )
    .await;
    assert!(more.contains(&format!("--- Page {} ---", shown + 1)));
    assert!(more.len() > out.len());
}

#[tokio::test]
async fn a_first_page_longer_than_max_chars_is_cut_and_says_so() {
    let t = app();
    put(&t, "big.pdf", &make_pdf(&spec(&[&long_page(1, 3000), "Two"])));
    let out = pdf_read(&t, json!({ "path": "uploads/big.pdf", "max_chars": "1500.5" })).await;
    assert!(
        out.starts_with("big.pdf: pages 1-1 of 2\n\n--- Page 1 ---\nPage 1 sentence 1"),
        "{out}"
    );
    assert!(out.contains("…\n\n[Page 1 is longer than 1,500.5 characters and was cut off; ask again with a bigger max_chars (up to 50,000) to see more of it. Pages 2-2 are not shown yet. To read on, ask for pages \"2-2\".]"), "{out}");
    // Under the least (1,000) counts as the least; nonsense as the default.
    let least = pdf_read(&t, json!({ "path": "uploads/big.pdf", "max_chars": 10 })).await;
    assert!(least.contains("longer than 1,000 characters"), "{least}");
    let default = pdf_read(&t, json!({ "path": "uploads/big.pdf", "max_chars": "lots" })).await;
    assert!(default.contains("pages 1-2 of 2"), "{default}");
}

#[tokio::test]
async fn says_when_no_text_could_be_taken_out_scanned_pages() {
    let t = app();
    put(&t, "scan.pdf", &make_pdf(&spec(&["", ""])));
    let out = pdf_read(&t, json!({ "path": "uploads/scan.pdf" })).await;
    assert_eq!(
        out,
        "scan.pdf has 2 pages, but no text could be taken out of it: its pages are probably scanned (pictures of text), which this tool can't read."
    );
}

#[tokio::test]
async fn refuses_a_file_outside_the_workspace_a_protected_name_a_non_pdf_and_a_missing_file() {
    let t = app();
    let outside = t.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("doc.pdf"), make_pdf(&spec(&["Outside"]))).unwrap();
    let abs = pdf_read(&t, json!({ "path": outside.join("doc.pdf").to_string_lossy() })).await;
    assert!(
        abs.starts_with("pdf_read error: ") && abs.contains("outside the workspace"),
        "{abs}"
    );
    let rel = pdf_read(&t, json!({ "path": "../outside/doc.pdf" })).await;
    assert!(
        rel.starts_with("pdf_read error: ") && rel.contains("outside the workspace"),
        "{rel}"
    );

    std::fs::write(
        t.config().workspace_dir.join(".credentials.json"),
        make_pdf(&spec(&["Nope"])),
    )
    .unwrap();
    let protected = pdf_read(&t, json!({ "path": ".credentials.json" })).await;
    assert_eq!(
        protected,
        "pdf_read error: .credentials.json can't be read with this tool."
    );

    put(&t, "notes.txt", b"plain words");
    assert_eq!(
        pdf_read(&t, json!({ "path": "uploads/notes.txt" })).await,
        "pdf_read error: notes.txt isn't a PDF."
    );
    let missing = pdf_read(&t, json!({ "path": "uploads/missing.pdf" })).await;
    assert!(missing.starts_with("pdf_read error: there is no file at "), "{missing}");
    assert_eq!(
        pdf_read(&t, json!({})).await,
        "pdf_read error: 'path' is required: a PDF in the workspace (e.g. uploads/report.pdf) or a web address."
    );
    let folder = pdf_read(&t, json!({ "path": "uploads" })).await;
    assert!(folder.ends_with("uploads is a folder, not a PDF."), "{folder}");
}

#[cfg(unix)]
#[tokio::test]
async fn a_link_inside_the_workspace_that_leads_out_is_refused() {
    let t = app();
    let outside = t.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("doc.pdf"), make_pdf(&spec(&["Outside"]))).unwrap();
    std::os::unix::fs::symlink(
        outside.join("doc.pdf"),
        t.config().workspace_dir.join("uploads/link.pdf"),
    )
    .unwrap();
    let out = pdf_read(&t, json!({ "path": "uploads/link.pdf" })).await;
    assert!(out.contains("outside the workspace"), "{out}");
}

// ---------------------------------------------------------------- pdf_read from a web address

/// A local server like the Node test's: /doc.pdf, /hop (to /doc.pdf), /to-private (to 127.0.0.1), /huge, and
/// /loop (to itself).
struct Server {
    port: u16,
    hits: Arc<Mutex<Vec<String>>>,
    body: Vec<u8>,
}

async fn server() -> Server {
    let body = make_pdf(&spec(&["From the web"]));
    let hits: Arc<Mutex<Vec<String>>> = Arc::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let doc = body.clone();
    let seen = hits.clone();
    let router = Router::new()
        .route(
            "/doc.pdf",
            get(move || async move { ([("content-type", "application/pdf")], doc).into_response() }),
        )
        .route(
            "/hop",
            get(|| async { (StatusCode::FOUND, [(LOCATION, "/doc.pdf")]).into_response() }),
        )
        .route(
            "/to-private",
            get(move || async move {
                (
                    StatusCode::FOUND,
                    [(LOCATION, format!("http://127.0.0.1:{port}/doc.pdf"))],
                )
                    .into_response()
            }),
        )
        .route("/huge", get(|| async { vec![0x41u8; 4096].into_response() }))
        .route(
            "/loop",
            get(|| async { (StatusCode::MOVED_PERMANENTLY, [(LOCATION, "/loop")]).into_response() }),
        )
        .layer(axum::middleware::from_fn(
            move |req: axum::extract::Request, next: axum::middleware::Next| {
                let seen = seen.clone();
                async move {
                    seen.lock().push(req.uri().path().to_string());
                    next.run(req).await
                }
            },
        ));
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    Server { port, hits, body }
}

/// A lookup that answers 127.0.0.1 for pdfs.test only, the guarded one for everything else.
struct TestLookup;

#[async_trait]
impl Lookup for TestLookup {
    async fn lookup(&self, hostname: &str) -> Result<Vec<IpAddr>, LookupError> {
        if hostname != "pdfs.test" {
            return GuardedLookup::new(SystemLookup).lookup(hostname).await;
        }
        Ok(vec![IpAddr::from([127, 0, 0, 1])])
    }
}

fn test_lookup() -> FetchPdfOptions {
    FetchPdfOptions {
        lookup: Arc::new(TestLookup),
        ..FetchPdfOptions::default()
    }
}

#[tokio::test]
async fn refuses_a_loopback_or_private_address_and_sends_it_nothing() {
    let s = server().await;
    let t = app();
    let out = pdf_read(&t, json!({ "path": format!("http://127.0.0.1:{}/doc.pdf", s.port) })).await;
    assert_eq!(
        out,
        "pdf_read error: that address is on a private or local network (127.0.0.1), which this tool doesn't read from"
    );
    assert!(s.hits.lock().is_empty(), "a refused address was still asked");
    // A name that resolves to loopback is refused by the guarded lookup, before any connection.
    let out = pdf_read(&t, json!({ "path": format!("http://localhost:{}/doc.pdf", s.port) })).await;
    assert!(
        out.starts_with("pdf_read error: ") && out.contains("private or local"),
        "{out}"
    );
    assert!(s.hits.lock().is_empty());
}

#[test]
fn knows_the_private_loopback_and_link_local_ranges() {
    for ip in [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.9",
        "192.168.1.1",
        "169.254.169.254",
        "0.0.0.0",
        "100.64.0.1",
        "::1",
        "fd00::1",
        "fe80::1",
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
        "::",
    ] {
        assert!(is_private_address(ip), "{ip}");
    }
    for ip in ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "172.32.0.1"] {
        assert!(!is_private_address(ip), "{ip}");
    }
}

#[test]
fn ipv4_inside_ipv6_zones_brackets_and_non_addresses_follow_the_ipv4_rules() {
    for ip in [
        "64:ff9b::a00:1",
        "64:ff9b::10.0.0.1",
        "2002:a00:1::",
        "2002:c0a8:101::1",
        "::10.0.0.1",
        "[::1]",
        "fe80::1%eth0",
        "FE80::1",
        "ff02::1",
        "fec0::1",
        "2001:db8::1",
        "224.0.0.1",
        "198.18.0.1",
        "192.0.0.8",
        "not an address",
        "",
        "01.2.3.4",
        "1.2.3",
    ] {
        assert!(is_private_address(ip), "{ip}");
    }
    for ip in [
        "64:ff9b::808:808",
        "2002:808:808::",
        "::ffff:8.8.8.8",
        "[2606:4700::1]",
        "192.0.2.1",
    ] {
        assert!(!is_private_address(ip), "{ip}");
    }
    assert_eq!(expand6("1::"), Some(vec![1, 0, 0, 0, 0, 0, 0, 0]));
    assert_eq!(
        expand6("::ffff:1.2.3.4"),
        Some(vec![0, 0, 0, 0, 0, 0xffff, 0x102, 0x304])
    );
    assert_eq!(expand6("1:2:3:4:5:6:7:8:9"), None);
}

#[tokio::test]
async fn the_guarded_lookup_refuses_a_name_with_any_private_address() {
    struct Answers(Vec<IpAddr>);
    #[async_trait]
    impl Lookup for Answers {
        async fn lookup(&self, _: &str) -> Result<Vec<IpAddr>, LookupError> {
            Ok(self.0.clone())
        }
    }
    let public = IpAddr::from([93, 184, 216, 34]);
    let private = IpAddr::from([10, 0, 0, 1]);
    let ok = GuardedLookup::new(Answers(vec![public])).lookup("a.example").await;
    assert_eq!(ok, Ok(vec![public]));
    let mixed = GuardedLookup::new(Answers(vec![public, private]))
        .lookup("b.example")
        .await
        .unwrap_err();
    assert_eq!(mixed.code, "EPRIVATE");
    assert_eq!(
        mixed.message,
        "that address is on a private or local network (b.example), which this tool doesn't read from"
    );
    let none = GuardedLookup::new(Answers(vec![]))
        .lookup("c.example")
        .await
        .unwrap_err();
    assert_eq!(none.code, "EPRIVATE");
}

#[tokio::test]
async fn downloads_a_pdf_following_a_redirect() {
    let s = server().await;
    let buf = fetch_pdf(&format!("http://pdfs.test:{}/hop", s.port), test_lookup())
        .await
        .unwrap();
    assert_eq!(buf, s.body);
    assert_eq!(*s.hits.lock(), ["/hop", "/doc.pdf"]);
}

#[tokio::test]
async fn refuses_a_redirect_to_a_private_address() {
    let s = server().await;
    let err = fetch_pdf(&format!("http://pdfs.test:{}/to-private", s.port), test_lookup())
        .await
        .unwrap_err();
    assert!(err.0.contains("private") || err.0.contains("local"), "{err}");
    assert_eq!(*s.hits.lock(), ["/to-private"]);
}

#[tokio::test]
async fn refuses_a_download_over_the_size_cap() {
    let s = server().await;
    let err = fetch_pdf(
        &format!("http://pdfs.test:{}/huge", s.port),
        FetchPdfOptions {
            max_bytes: 1024,
            ..test_lookup()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.0, "the download is too big (over 1024 bytes)");
}

/// A port nothing listens on.
async fn free_port() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    listener.local_addr().unwrap().port()
}

#[tokio::test]
async fn refuses_too_many_redirects_a_bad_status_and_what_is_not_http() {
    let s = server().await;
    let err = fetch_pdf(&format!("http://pdfs.test:{}/loop", s.port), test_lookup())
        .await
        .unwrap_err();
    assert_eq!(err.0, "the address redirected too many times");
    assert_eq!(s.hits.lock().len(), 4, "the first ask and three redirects");
    let err = fetch_pdf(&format!("http://pdfs.test:{}/nope", s.port), test_lookup())
        .await
        .unwrap_err();
    assert_eq!(err.0, "the address answered HTTP 404");
    assert_eq!(
        fetch_pdf("ftp://x/y", test_lookup()).await.unwrap_err().0,
        "only http and https addresses can be read"
    );
    assert_eq!(
        fetch_pdf("not a url", test_lookup()).await.unwrap_err().0,
        "that isn't a web address"
    );
    let err = fetch_pdf("http://[fd00::1]/x", test_lookup()).await.unwrap_err();
    assert_eq!(
        err.0,
        "that address is on a private or local network (fd00::1), which this tool doesn't read from"
    );
    let err = fetch_pdf(&format!("http://pdfs.test:{}/x", free_port().await), test_lookup())
        .await
        .unwrap_err();
    assert!(err.0.starts_with("connect ECONNREFUSED pdfs.test:"), "{err}");
}

#[test]
fn a_downloaded_pdf_is_named_after_its_address() {
    assert_eq!(
        url_file_name("https://example.org/files/My%20Report%20(v2).pdf"),
        "My Report (v2).pdf"
    );
    assert_eq!(url_file_name("https://example.org/a/b%C3%A9?x=1"), "b_");
    assert_eq!(url_file_name("https://example.org/"), "document.pdf");
    assert_eq!(url_file_name("https://example.org/%E0%A4%A"), "document.pdf");
    assert_eq!(url_file_name("https://example.org/a%2Fb.pdf"), "a_b.pdf");
    let long = format!("https://example.org/{}.pdf", "x".repeat(200));
    assert_eq!(url_file_name(&long).len(), 120);
}

#[tokio::test]
async fn a_blocked_address_is_refused_before_it_is_fetched() {
    let t = app();
    let out = pdf_read(&t, json!({ "url": "http://93.184.216.34/x.pdf" })).await;
    assert_eq!(
        out,
        "pdf_read error: that address is blocked (Raw IP address: 93.184.216.34 — likely phishing or C2)."
    );
}

// ---------------------------------------------------------------- the hand-written pieces

/// The zlib stream Node's `deflateSync` makes of "Hello there, this is some text to compress. " x 20.
const NODE_DEFLATED: &str = "789cf348cdc9c95728c9482d4ad55128c9c82c56c82c5628cecf4d552849ad285128c95748cecf2d284a2d2ed653f018553baa76542d456a0183663b38";
/// The same as raw deflate (`deflateRawSync`).
const NODE_RAW: &str =
    "f348cdc9c95728c9482d4ad55128c9c82c56c82c5628cecf4d552849ad285128c95748cecf2d284a2d2ed653f018553baa76542d456a01";

#[test]
fn inflate_reads_what_node_read_whole_cut_off_raw_or_trailed() {
    let d = hex::decode(NODE_DEFLATED).unwrap();
    let raw = hex::decode(NODE_RAW).unwrap();
    let len = |b: &[u8]| inflate(b).map(|o| o.len());
    // What Node's three tries gave for each (lengths of the output, None for null).
    assert_eq!(len(&d), Some(880));
    assert_eq!(len(&[d.clone(), b"garbage".to_vec()].concat()), Some(880));
    assert_eq!(len(&[d.clone(), d.clone()].concat()), Some(880));
    assert_eq!(len(&d[..d.len() / 2]), Some(27));
    assert_eq!(len(&d[..d.len() - 4]), Some(880));
    let mut bad = d.clone();
    *bad.last_mut().unwrap() ^= 1;
    assert_eq!(len(&bad), None);
    assert_eq!(len(&raw), Some(880));
    assert_eq!(len(&raw[..raw.len() / 2]), Some(26));
    assert_eq!(len(&[]), Some(0));
    assert_eq!(len(&d[..2]), Some(0));
    assert_eq!(len(b"not compressed at all"), None);
    assert_eq!(len(&[0x78]), Some(0));
    assert!(inflate(&d).unwrap().starts_with(b"Hello there, this is some text"));
}

#[test]
fn values_parse_as_the_js_parsed_them() {
    let parse = |s: &str, refs: bool| parse_value(s.as_bytes(), 0, refs, 0).ok();
    assert_eq!(parse("  12 0 R ", true), Some((V::Ref(12.0), 8)));
    assert_eq!(parse("12 0 R", false), Some((V::Num(12.0), 2)));
    assert_eq!(parse("12 0 Rx", true), Some((V::Num(12.0), 2)));
    assert_eq!(parse("-.5", false), Some((V::Num(-0.5), 3)));
    assert_eq!(parse("1.", false), Some((V::Num(1.0), 2)));
    assert_eq!(parse("- x", false), Some((V::Kw("-".into()), 1)));
    assert_eq!(parse("/A#42c#2", false), Some((V::Name("/ABc#2".into()), 8)));
    assert_eq!(
        parse("(a\\(b\\)c\\101\\\nd(e)f)", false),
        Some((V::Str(b"a(b)cAd(e)f".to_vec()), 20))
    );
    assert_eq!(parse("<48 6 9>", false), Some((V::Str(b"Hi".to_vec()), 8)));
    assert_eq!(parse("<486", false), Some((V::Str(vec![0x48, 0x60]), 5)));
    assert_eq!(parse("true", false), Some((V::Bool(true), 4)));
    assert_eq!(parse("null", false), Some((V::Null, 4)));
    assert_eq!(
        parse("[1 /X (s)]", false).map(|(v, _)| v),
        Some(V::Arr(vec![V::Num(1.0), V::Name("/X".into()), V::Str(b"s".to_vec())]))
    );
    let dict = parse("<< /A 1 2 /B [ ] % note\n /C << /D null >> >>", true).unwrap().0;
    assert_eq!(prop(Some(&dict), "A"), Some(&V::Num(1.0)));
    assert_eq!(prop(Some(&dict), "B"), Some(&V::Arr(vec![])));
    assert_eq!(prop(prop(Some(&dict), "C"), "D"), None, "null reads as missing");
    assert_eq!(parse(")", false), None);
    assert_eq!(parse("<< /A 1", false), None);
    let deep = format!("{}{}", "[".repeat(70), "]".repeat(70));
    assert_eq!(parse(&deep, false), None, "nested too deep");
}

#[test]
fn the_cmap_and_glyph_names_read_as_the_js_read_them() {
    let cmap = parse_cmap(
        b"2 beginbfchar\n<01> <0041>\n<0002> <D83DDE00>\nendbfchar\n2 beginbfrange\n<0010> <0012> <0061>\n<0020> <0021> [<0058> <>]\nendbfrange",
    );
    assert_eq!(cmap_lookup(&cmap, 1), Some(vec![0x41]));
    assert_eq!(cmap_lookup(&cmap, 2), Some(vec![0xD83D, 0xDE00]));
    assert_eq!(cmap_lookup(&cmap, 0x11), Some(vec![0x62]));
    assert_eq!(cmap_lookup(&cmap, 0x20), Some(vec![0x58]));
    assert_eq!(cmap_lookup(&cmap, 0x21), Some(vec![]));
    assert_eq!(cmap_lookup(&cmap, 0x13), None);
    let wrap = parse_cmap(b"beginbfrange <00> <05> <FFFE> endbfrange");
    assert_eq!(
        cmap_lookup(&wrap, 3),
        Some(vec![0x0001]),
        "a unit past FFFF wraps, as fromCharCode did"
    );

    let g = |n: &str| glyph_text(n).map(|u| String::from_utf16_lossy(&u));
    assert_eq!(g("quoteright").as_deref(), Some("’"));
    assert_eq!(g("sfthyphen").as_deref(), Some(""));
    assert_eq!(g("Q").as_deref(), Some("Q"));
    assert_eq!(g("uni00E900E8").as_deref(), Some("éè"));
    assert_eq!(g("u1F412").as_deref(), Some("\u{1F412}"));
    assert_eq!(g("u110000"), None);
    assert_eq!(g("eacute").as_deref(), Some("é"));
    assert_eq!(g("Ntilde").as_deref(), Some("Ñ"));
    assert_eq!(
        g("qacute").as_deref(),
        Some("q\u{301}"),
        "no composed form: the letter and the accent"
    );
    assert_eq!(g("nosuchglyph"), None);
    assert_eq!(WIN_ANSI[0x80], 0x20AC);
    assert_eq!(WIN_ANSI[0x9F], 0x0178);
    assert_eq!(WIN_ANSI[0xE9], 0xE9);
}

#[test]
fn a_font_with_differences_reads_through_its_own_encoding() {
    // A simple font whose Differences put "eacute" at 0x41 and "fi" at 0x42.
    let content = "BT /F1 12 Tf (AB) Tj ET";
    let pdf = format!(
        "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] >> endobj\n3 0 obj << /Type /Page /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n4 0 obj << /Type /Font /Subtype /Type1 /Encoding << /Differences [65 /eacute /fi] >> >> endobj\n5 0 obj << /Length {} >>\nstream\n{content}\nendstream endobj\ntrailer << /Root 1 0 R >>\n",
        content.len()
    );
    assert_eq!(pages_of(builtin_pdf_text(pdf.as_bytes())), ["éfi"]);
}

#[test]
fn a_damaged_file_without_a_page_tree_still_gives_its_pages_by_number() {
    let pdf = b"%PDF-1.4\n9 0 obj << /Type /Page /Contents 8 0 R >> endobj\n8 0 obj << /Length 22 >>\nstream\nBT (second) Tj ET     \nendstream endobj\n3 0 obj << /Type /Page /Contents 4 0 R >> endobj\n4 0 obj << >>\nstream\nBT (first) Tj ET\nendstream endobj\n";
    assert_eq!(pages_of(builtin_pdf_text(pdf)), ["first", "second"]);
    assert_eq!(
        builtin_pdf_text(b"%PDF-1.4\n1 0 obj << /Type /Font >> endobj\n")
            .error
            .as_deref(),
        Some("no pages were found in it")
    );
}

#[test]
fn text_moves_lines_and_inline_pictures_in_a_content_stream() {
    let doc = PdfDoc::new(b"%PDF-1.4\n").unwrap();
    let run = |s: &str| String::from_utf16_lossy(&doc.run(s.as_bytes(), None, 0).unwrap());
    assert_eq!(run("BT 72 700 Td (one) Tj 0 -14 Td (two) Tj ET"), "one\ntwo");
    assert_eq!(run("BT 72 700 Td (one) Tj 30 0 Td (two) Tj ET"), "one two");
    assert_eq!(run("BT 14 TL (a) Tj T* (b) ' 1 2 (c) \" ET"), "a\nb\nc");
    assert_eq!(run("BT 1 0 0 1 10 10 Tm (x) Tj 1 0 0 1 10 40 Tm (y) Tj ET"), "x\ny");
    assert_eq!(run("BT (a) Tj BI /W 1 ID \x00EI\x01 EI (b) Tj ET"), "ab");
    assert_eq!(run("BT [(a) -100 (b) -300 (c)] TJ ET"), "ab c");
    assert_eq!(run("BT (end) Tj ) junk ] ( more) Tj"), "end more");
}

#[test]
fn ascii85_and_predictor_edge_cases() {
    assert_eq!(ascii85(b"<~9jqo^~>"), b"Man ");
    assert_eq!(ascii85(b"z9`"), vec![0, 0, 0, 0, b'M']);
    assert_eq!(ascii85(b"9j qo\n^"), b"Man ");
    assert_eq!(ascii_hex(b"48 69 7>ff"), b"Hip");
    let parms = V::Dict(HashMap::from([
        ("Predictor".to_string(), V::Num(12.0)),
        ("Columns".to_string(), V::Num(-16.0)),
    ]));
    assert!(
        predict(vec![0; 10], Some(&parms)).is_err(),
        "a negative row length fails, as Buffer.alloc threw"
    );
    let zero = V::Dict(HashMap::from([
        ("Predictor".to_string(), V::Num(12.0)),
        ("Columns".to_string(), V::Num(0.01)),
        ("BitsPerComponent".to_string(), V::Num(-8.0)),
    ]));
    assert_eq!(predict(vec![1, 2, 3], Some(&zero)).unwrap(), Vec::<u8>::new());
    assert_eq!(predict(vec![1, 2, 3], None).unwrap(), vec![1, 2, 3]);
}

#[test]
fn tidy_and_split_clean_text_as_the_js_did() {
    assert_eq!(tidy("  a \t\u{a0} b\u{1}c \n\n\n\n d  \u{feff}"), "a bc\n\nd");
    assert_eq!(split_pdftotext("one\r\ntwo\x0Cthree\r\x0C \n"), ["one\ntwo", "three"]);
    assert_eq!(split_pdftotext(""), [""]);
    assert!(is_pdf(b"junk %PDF-1.7"));
    let mut late = vec![b' '; 1020];
    late.extend_from_slice(b"%PDF-");
    assert!(!is_pdf(&late));
}

#[test]
fn numbers_and_strings_convert_as_javascript_converts_them() {
    assert_eq!(js_number(Some(&json!(" 12 "))), 12.0);
    assert_eq!(js_number(Some(&json!(""))), 0.0);
    assert_eq!(js_number(Some(&json!("0x10"))), 16.0);
    assert!(js_number(Some(&json!("12px"))).is_nan());
    assert!(js_number(None).is_nan());
    assert_eq!(js_number(Some(&json!([7]))), 7.0);
    assert_eq!(js_string(&json!([1, null, "a"])), "1,,a");
    assert_eq!(en_us(50_000.0), "50,000");
    assert_eq!(en_us(1_500.5), "1,500.5");
    assert_eq!(en_us(1_234_567.0), "1,234,567");
    assert_eq!(en_us(999.0), "999");
}

/// Node's own answers (`isPrivateAddress` run on each), for every spelling of an address the guard may see: the
/// edges of each range, IPv4 inside IPv6 in every form, zones, brackets, and text that is not an address.
#[test]
fn private_addresses_answer_as_node_answered_for_every_spelling() {
    let node: &[(&str, bool)] = &[
        ("0.0.0.0", true),
        ("1.1.1.1", false),
        ("8.8.8.8", false),
        ("9.255.255.255", false),
        ("10.0.0.0", true),
        ("11.0.0.1", false),
        ("100.63.255.255", false),
        ("100.64.0.0", true),
        ("100.127.255.255", true),
        ("100.128.0.0", false),
        ("126.255.255.255", false),
        ("127.0.0.1", true),
        ("128.0.0.1", false),
        ("169.253.1.1", false),
        ("169.254.0.1", true),
        ("169.255.0.1", false),
        ("172.15.255.255", false),
        ("172.16.0.0", true),
        ("172.31.255.255", true),
        ("172.32.0.0", false),
        ("192.0.0.1", true),
        ("192.0.1.1", false),
        ("192.0.2.1", false),
        ("192.167.1.1", false),
        ("192.168.0.1", true),
        ("192.169.0.1", false),
        ("198.17.0.1", false),
        ("198.18.0.1", true),
        ("198.19.255.1", true),
        ("198.20.0.1", false),
        ("223.255.255.255", false),
        ("224.0.0.0", true),
        ("239.1.1.1", true),
        ("255.255.255.255", true),
        ("01.1.1.1", true),
        ("1.1.1", true),
        ("1.1.1.1.1", true),
        ("256.1.1.1", true),
        (" 8.8.8.8 ", false),
        ("[8.8.8.8]", false),
        ("::", true),
        ("::1", true),
        ("::2", true),
        ("::0.0.0.2", true),
        ("::ffff:0:0", true),
        ("::ffff:8.8.8.8", false),
        ("::ffff:10.0.0.1", true),
        ("::ffff:808:808", false),
        ("::ffff:a00:1", true),
        ("::8.8.8.8", false),
        ("::10.1.1.1", true),
        ("0:0:0:0:0:ffff:7f00:1", true),
        ("0:0:0:0:0:0:0:1", true),
        ("64:ff9b::8.8.8.8", false),
        ("64:ff9b::10.0.0.1", true),
        ("64:ff9b::1:808:808", false),
        ("64:ff9b:1::a00:1", false),
        ("2002:808:808::1", false),
        ("2002:a00:1::1", true),
        ("2002:7f00:1::", true),
        ("2001:db8::1", true),
        ("2001:db9::1", false),
        ("2001::1", false),
        ("2606:4700:4700::1111", false),
        ("fc00::1", true),
        ("fdff::1", true),
        ("fe00::1", false),
        ("fe80::1", true),
        ("febf::1", true),
        ("fec0::1", true),
        ("feff::1", true),
        ("ff00::1", true),
        ("ff02::1", true),
        ("fe80::1%eth0", true),
        ("fe80::1%25eth0", true),
        ("FE80::ABCD", true),
        ("[::1]", true),
        ("[2606:4700::1]", false),
        ("1:2:3:4:5:6:7:8", false),
        ("1:2:3:4:5:6:7:8:9", true),
        ("1::2::3", true),
        (":::1", true),
        ("::ffff:1.2.3", true),
        ("::ffff:1.2.3.4.5", true),
        ("1:2:3:4:5:6:1.2.3.4", false),
        ("1::1.2.3.4", false),
        ("g::1", true),
        ("", true),
        ("not an ip", true),
        ("localhost", true),
        ("::ffff:127.0.0.1", true),
        ("::ffff:7f00:0001", true),
        ("0::ffff:7f00:1", true),
        ("::0:ffff:7f00:1", true),
        ("1:0:0:0:0:ffff:7f00:1", false),
    ];
    for (ip, want) in node {
        assert_eq!(is_private_address(ip), *want, "{ip:?}");
    }
}
