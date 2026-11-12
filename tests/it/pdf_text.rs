//! The PDF reader with a pdftotext to run: the stand-in (`tarsee-testbin` as `pdftotext`) for how the program is
//! found, started and read, and the real poppler pdftotext when this machine has one (the Node tests' "when it is
//! installed" cases).

use std::path::{Path, PathBuf};
use std::time::Duration;

use bytes::Bytes;
use serde_json::{Value, json};
use tarsee::lib::pdf_text::{PdfReader, PdfTextOptions, ReaderKind, read_pdf_tool};
use tarsee::testkit::make_pdf::{PdfSpec, make_pdf};
use tarsee::testkit::{TestApp, test_app_with_env, tmp_dir};

use crate::support::testbin_as;

/// A test app whose PATH holds only a folder with the stand-in pdftotext in it, logging each run to `log`.
fn app_with_stand_in(extra: &[(&str, &str)]) -> (TestApp, tempfile::TempDir, PathBuf) {
    let bin = tmp_dir();
    testbin_as(bin.path(), "pdftotext");
    let log = bin.path().join("runs.log");
    let mut env = vec![
        ("PATH".to_string(), bin.path().to_string_lossy().into_owned()),
        ("TARSEE_TESTBIN_LOG".to_string(), log.to_string_lossy().into_owned()),
    ];
    env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    (test_app_with_env(env), bin, log)
}

/// The arguments of each run of the stand-in, oldest first.
fn runs(log: &Path) -> Vec<Vec<String>> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[tokio::test]
async fn pdftotext_on_the_path_reads_a_copy_split_into_pages_without_windows_line_ends() {
    let (t, _bin, log) = app_with_stand_in(&[("TARSEE_TESTBIN_PDFTOTEXT_PAGES", "First  page\nline two|Second")]);
    let pdf = make_pdf(&PdfSpec::pages(&["Ignored by the stand-in"]));
    let r = PdfReader::of(&t.app)
        .pdf_text(Bytes::from(pdf.clone()), PdfTextOptions::default())
        .await;
    assert_eq!(r.reader, Some(ReaderKind::Pdftotext));
    assert_eq!(r.error, None);
    let size = pdf.len();
    assert_eq!(
        r.pages,
        [
            format!("First page\nline two\n(read {size} bytes)"),
            format!("Second\n(read {size} bytes)")
        ]
    );
    let runs = runs(&log);
    assert_eq!(runs.len(), 2, "-v once, then the PDF: {runs:?}");
    assert_eq!(runs[0], ["-v"]);
    assert_eq!(&runs[1][..2], ["-enc", "UTF-8"]);
    assert_eq!(runs[1][3], "-");
    let copy = PathBuf::from(&runs[1][2]);
    assert_eq!(copy.file_name().unwrap(), "in.pdf");
    assert!(
        copy.parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("tarsee-pdf-")
    );
    assert!(!copy.exists(), "the temporary copy is removed");

    // The same bytes again come from the cache: no new run.
    let again = PdfReader::of(&t.app)
        .pdf_text(Bytes::from(pdf), PdfTextOptions::default())
        .await;
    assert_eq!(again, r);
    assert_eq!(crate::pdf_text::runs(&log).len(), 2);
}

#[tokio::test]
async fn a_pdf_on_disk_is_given_to_pdftotext_as_it_is() {
    let (t, _bin, log) = app_with_stand_in(&[]);
    let file = t.path().join("on disk.pdf");
    std::fs::write(&file, make_pdf(&PdfSpec::pages(&["x"]))).unwrap();
    let r = PdfReader::of(&t.app)
        .pdf_text(
            Bytes::from(std::fs::read(&file).unwrap()),
            PdfTextOptions {
                file: Some(file.clone()),
                ..PdfTextOptions::default()
            },
        )
        .await;
    assert_eq!(r.reader, Some(ReaderKind::Pdftotext));
    assert_eq!(runs(&log).last().unwrap()[2], file.to_string_lossy());
}

#[tokio::test]
async fn a_failing_pdftotext_leaves_the_pdf_to_the_built_in_reader() {
    let (t, _bin, _log) = app_with_stand_in(&[
        ("TARSEE_TESTBIN_EXIT", "1"),
        ("TARSEE_TESTBIN_STDERR", "Syntax Warning: odd\nI/O Error: broken\n"),
    ]);
    let r = PdfReader::of(&t.app)
        .pdf_text(
            Bytes::from(make_pdf(&PdfSpec::pages(&["Read anyway"]))),
            PdfTextOptions::default(),
        )
        .await;
    assert_eq!(r.reader, Some(ReaderKind::Builtin));
    assert_eq!(r.pages, ["Read anyway"]);
}

#[tokio::test]
async fn a_pdftotext_that_takes_too_long_is_stopped_and_the_built_in_reader_reads() {
    let (t, _bin, _log) = app_with_stand_in(&[("TARSEE_TESTBIN_SLEEP_MS", "20000")]);
    let reader = PdfReader::of(&t.app);
    // (-v would sleep too: the stand-in is named for this run directly.)
    reader.set_pdftotext(Some(_bin.path().join(if cfg!(windows) {
        "pdftotext.exe"
    } else {
        "pdftotext"
    })));
    let started = std::time::Instant::now();
    let r = reader
        .pdf_text(
            Bytes::from(make_pdf(&PdfSpec::pages(&["Too slow"]))),
            PdfTextOptions {
                timeout: Duration::from_millis(300),
                ..PdfTextOptions::default()
            },
        )
        .await;
    assert_eq!(r.reader, Some(ReaderKind::Builtin));
    assert_eq!(r.pages, ["Too slow"]);
    assert!(started.elapsed() < Duration::from_secs(15), "it waited for the program");
}

/// execFile stopped the program the moment its output passed `maxBuffer`. Reading stderr to the end first would
/// leave it blocked on a full pipe, with stderr open, until the time limit.
#[tokio::test]
async fn a_pdftotext_that_writes_too_much_is_stopped_at_once() {
    let (t, bin, _log) = app_with_stand_in(&[("TARSEE_TESTBIN_PDFTOTEXT_FLOOD", "8000000")]);
    let reader = PdfReader::of(&t.app);
    reader.set_pdftotext(Some(bin.path().join(if cfg!(windows) {
        "pdftotext.exe"
    } else {
        "pdftotext"
    })));
    reader.set_max_buffer_for_tests(64 * 1024);
    let started = std::time::Instant::now();
    let r = reader
        .pdf_text(
            Bytes::from(make_pdf(&PdfSpec::pages(&["Too much"]))),
            PdfTextOptions {
                timeout: Duration::from_secs(45),
                ..PdfTextOptions::default()
            },
        )
        .await;
    assert_eq!(r.reader, Some(ReaderKind::Builtin));
    assert_eq!(r.pages, ["Too much"]);
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "it waited {:?} for the program",
        started.elapsed()
    );
}

/// The program is looked for on the app's own PATH as libuv looked: `.com` and `.exe` on Windows (a `.cmd` or
/// `.bat` is not run), an executable file elsewhere. Nothing comes from the server's real environment.
#[tokio::test]
async fn pdftotext_is_looked_for_as_libuv_looked_for_it() {
    let bin = tmp_dir();
    let script = bin
        .path()
        .join(if cfg!(windows) { "pdftotext.cmd" } else { "pdftotext" });
    std::fs::write(&script, "not a program").unwrap();
    // Windows: a variable written "Path" is the same variable.
    let t = test_app_with_env([(
        if cfg!(windows) { "Path" } else { "PATH" },
        bin.path().to_string_lossy().into_owned(),
    )]);
    let r = PdfReader::of(&t.app)
        .pdf_text(
            Bytes::from(make_pdf(&PdfSpec::pages(&["Not run"]))),
            PdfTextOptions::default(),
        )
        .await;
    assert_eq!(
        r.reader,
        Some(ReaderKind::Builtin),
        "the .cmd (or a file that may not run) was taken"
    );
    // The stand-in itself is found the same way, through "Path".
    testbin_as(bin.path(), "pdftotext");
    PdfReader::of(&t.app).forget_pdftotext();
    let r = PdfReader::of(&t.app)
        .pdf_text(
            Bytes::from(make_pdf(&PdfSpec::pages(&["Run"]))),
            PdfTextOptions::default(),
        )
        .await;
    assert_eq!(r.reader, Some(ReaderKind::Pdftotext));
}

/// pdftotext opens a file by its name the ordinary way, which on Windows would read `a.pdf.` as `a.pdf`. A file
/// whose name Windows would rewrite is handed over as a copy instead.
#[tokio::test]
async fn a_file_whose_name_windows_would_rewrite_reaches_pdftotext_as_a_copy() {
    let (t, _bin, log) = app_with_stand_in(&[]);
    let uploads = t.config().workspace_dir.join("uploads");
    std::fs::create_dir_all(&uploads).unwrap();
    let odd = uploads.join("odd.pdf.");
    std::fs::write(
        tarsee::util::node_path::to_namespaced(&odd),
        make_pdf(&PdfSpec::pages(&["x"])),
    )
    .unwrap();
    let out = read_pdf_tool(&t.app, &json!({ "path": "uploads/odd.pdf." }), None).await;
    assert!(out.starts_with("odd.pdf.: pages 1-2 of 2"), "{out}");
    let given = PathBuf::from(&runs(&log).last().unwrap()[2]);
    if cfg!(windows) {
        assert_eq!(given.file_name().unwrap(), "in.pdf");
    } else {
        assert_eq!(given, odd);
    }
}

// ---------------------------------------------------------------- the real pdftotext, when it is installed

/// pdftotext on this machine, if there is one where poppler or Git for Windows put it.
fn find_pdftotext() -> Option<PathBuf> {
    [
        "/usr/bin/pdftotext",
        "/usr/local/bin/pdftotext",
        "/opt/homebrew/bin/pdftotext",
        "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
}

/// A test app that uses the real pdftotext (its folder on the PATH), or `None` to skip.
fn app_with_poppler() -> Option<TestApp> {
    let Some(bin) = find_pdftotext() else {
        eprintln!("pdftotext is not installed here: skipped");
        return None;
    };
    let dir = bin.parent().unwrap().to_string_lossy().into_owned();
    let t = test_app_with_env([("PATH", dir)]);
    PdfReader::of(&t.app).set_pdftotext(Some(bin));
    Some(t)
}

#[tokio::test]
async fn uses_pdftotext_when_it_is_installed() {
    let Some(t) = app_with_poppler() else { return };
    let r = PdfReader::of(&t.app)
        .pdf_text(
            Bytes::from(make_pdf(&PdfSpec {
                compress: true,
                ..PdfSpec::pages(&["Read by poppler", "Second page"])
            })),
            PdfTextOptions::default(),
        )
        .await;
    assert_eq!(r.reader, Some(ReaderKind::Pdftotext));
    assert_eq!(r.pages.len(), 2);
    assert!(r.pages[0].contains("Read by poppler"), "{:?}", r.pages);
    assert!(r.pages[1].contains("Second page"), "{:?}", r.pages);
    assert!(
        !r.pages.join("").contains('\r'),
        "Windows line ends are kept out of the text"
    );
}

#[tokio::test]
async fn reads_the_file_itself_with_pdftotext_when_it_is_installed() {
    let Some(t) = app_with_poppler() else { return };
    let uploads = t.config().workspace_dir.join("uploads");
    std::fs::create_dir_all(&uploads).unwrap();
    std::fs::write(
        uploads.join("poppler's.pdf"),
        make_pdf(&PdfSpec {
            compress: true,
            ..PdfSpec::pages(&["Read in place", "By poppler"])
        }),
    )
    .unwrap();
    let input: Value = json!({ "path": "uploads/poppler's.pdf", "pages": "2" });
    let out = read_pdf_tool(&t.app, &input, None).await;
    assert!(out.contains("poppler's.pdf: pages 2-2 of 2"), "{out}");
    assert!(out.contains("--- Page 2 ---\nBy poppler"), "{out}");
}
