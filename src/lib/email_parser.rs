//! Port of `src/lib/email-parser.js`: email parsing helpers — quote-strip, mention detection, reply-all detection,
//! thread-key extraction.
//!
//! All functions are pure. No network, no filesystem, no state.
//!
//! Design principle: quote-strip FIRST, then match. A quoted `@tarsee` from the earlier turn of a thread must NOT
//! re-trigger a reply on every subsequent reply.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;

use crate::lib::discord_format::js_text::re;
use crate::util::js::{is_whitespace, trim, utf16_len};

/// The mention keyword when none is configured.
pub const DEFAULT_MENTION_KEYWORD: &str = "tarsee";
/// The reply-all subject marker when none is configured.
pub const DEFAULT_REPLY_ALL_MARKER: &str = "[reply-all]";

// The two "On ... wrote:" patterns count characters with `.{10,200}`, and JavaScript counts UTF-16 units there: they
// run on `utf16_units`, where a character outside the basic plane is two.
static WROTE_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*(?i-u:on) .{10,200}(?i-u:wrote):\s*$"));
static ON_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*(?i-u:on) .{1,200}$"));
static AT_OR_COMMA: LazyLock<Regex> = LazyLock::new(|| re(r"\s(at|,)\s"));
static ORIGINAL_MESSAGE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*-{2,}\s*(?i-u:original message)\s*-{2,}\s*$"));
static FROM_HEADER: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*(?i-u:from):\s.+<.+@.+>"));
static SIGNATURE: LazyLock<Regex> = LazyLock::new(|| re(r"^-- \s*$"));
static QUOTED: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*>"));

/// The text with each character outside the basic plane written as two U+FFFF, so a counted `.{n,m}` counts UTF-16
/// units as JavaScript's does. U+FFFF is not whitespace, not a line terminator and in none of these patterns.
fn utf16_units(text: &str) -> Cow<'_, str> {
    if text.chars().all(|c| c.len_utf16() == 1) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        if c.len_utf16() == 2 {
            out.push_str("\u{FFFF}\u{FFFF}");
        } else {
            out.push(c);
        }
    }
    Cow::Owned(out)
}

/// Strip quoted text from an email reply body so only the user's new content remains. Handles the common
/// reply-quote markers:
///
///   - "On Wed, Apr 24, 2026 at 3:14 PM Alice <a@x.com> wrote:"   (Gmail, Apple Mail)
///   - "-----Original Message-----"                                (Outlook classic)
///   - "From: name <email>" block after content                   (Outlook forward)
///   - "-- " line on its own                                      (RFC 3676 signature)
///   - Lines starting with "> " or ">"                            (quoted)
///
/// Stops consumption at the first match of any of the above. Returns the trimmed head of the message — what the user
/// actually typed this turn. Give it the plain-text body (prefer the text/plain part).
pub fn strip_quoted_reply(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let normalized = text.replace("\r\n", "\n");
    let mut out: Vec<&str> = Vec::new();

    for line in normalized.split('\n') {
        let units = utf16_units(line);
        // "On <date>, <name> <addr?> wrote:" — Gmail / Apple Mail style
        if WROTE_LINE.is_match(&units) {
            break;
        }
        // Occasionally the "wrote:" wraps to the next line; catch the short variant
        if ON_LINE.is_match(&units) && AT_OR_COMMA.is_match(line) && utf16_len(line) < 160 && line.contains('@') {
            // Heuristic: looks like the start of a "On X, Y <a@b> wrote:" line that wrapped.
            // Peek ahead one line — if it's "wrote:", treat as quote boundary.
            // (We still break because the header alone strongly signals quoted content.)
            // This is loose on purpose; false negatives here just mean we keep more text
            // than strictly necessary, never fewer.
            // Don't break here by default — too loose — but dropping this line is fine.
            continue;
        }
        // Outlook "-----Original Message-----"
        if ORIGINAL_MESSAGE.is_match(line) {
            break;
        }
        // Forwarded header block: "From: <name> <email>" after some real content has been seen
        if !out.is_empty() && FROM_HEADER.is_match(line) {
            break;
        }
        // RFC 3676 signature delimiter — a line containing exactly "-- "
        if SIGNATURE.is_match(line) {
            break;
        }
        // Any line starting with ">" is a quoted line — drop it
        if QUOTED.is_match(line) {
            continue;
        }

        out.push(line);
    }

    trim(&out.join("\n")).to_string()
}

/// One UTF-16 unit as JavaScript's `i` flag (without `u`) compares it: its upper case when that is one unit and does
/// not turn a non-ASCII letter into an ASCII one, else itself. A character outside the basic plane is two surrogate
/// units, each compared as it is, so it is returned as it is.
fn canonicalize(c: char) -> char {
    if c.len_utf16() == 2 {
        return c;
    }
    let mut upper = c.to_uppercase();
    match (upper.next(), upper.next()) {
        (Some(u), None) if u.len_utf16() == 1 && (c.is_ascii() || !u.is_ascii()) => u,
        _ => c,
    }
}

/// Where the keyword, compared as JavaScript's `i` flag compares, ends in `text` when it starts at `at`.
fn keyword_at(text: &[char], at: usize, keyword: &[char]) -> Option<usize> {
    let end = at + keyword.len();
    let found = text.get(at..end)?;
    found
        .iter()
        .zip(keyword)
        .all(|(&t, &k)| canonicalize(t) == canonicalize(k))
        .then_some(end)
}

/// The ASCII word characters of JavaScript's `\b` (no `u` flag).
fn is_word(c: Option<&char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
}

/// A `\b` between `text[at - 1]` and `text[at]`.
fn word_boundary(text: &[char], at: usize) -> bool {
    let before = at.checked_sub(1).and_then(|i| text.get(i));
    is_word(before) != is_word(text.get(at))
}

/// The keyword without one leading "@".
fn bare_keyword(keyword: &str) -> &str {
    keyword.strip_prefix('@').unwrap_or(keyword)
}

/// Whether the ASCII letters of `word` come next in `text` at `at` (any case), and where they end.
fn ascii_word_at(text: &[char], at: usize, word: &str) -> Option<usize> {
    let end = at + word.chars().count();
    let found = text.get(at..end)?;
    found
        .iter()
        .zip(word.chars())
        .all(|(t, w)| t.to_ascii_lowercase() == w)
        .then_some(end)
}

/// Detect whether the stripped body "mentions" the bot using the configured keyword: a case-insensitive
/// word-boundary match on `@<keyword>` (the JS `/(?:^|[^A-Za-z0-9._%+\-])@<keyword>\b/i`, the keyword taken
/// literally; the keyword is matched by hand because the `regex` crate folds case more widely than JavaScript does).
///
/// Importantly, this must NOT match when the keyword appears inside an email address like `foo@tarsee.example.com`.
/// The character immediately preceding `@` is checked against `[^A-Za-z0-9._%+\-]` to rule that out — if the
/// character before `@` looks like it could be part of an email local-part, we don't treat it as a mention.
///
/// `stripped` is the body after [`strip_quoted_reply`]; `keyword` is usually [`DEFAULT_MENTION_KEYWORD`], with or
/// without a leading "@".
pub fn has_mention(stripped: &str, keyword: &str) -> bool {
    if stripped.is_empty() {
        return false;
    }
    let kw: Vec<char> = bare_keyword(keyword).chars().collect();
    if kw.is_empty() {
        return false;
    }
    let text: Vec<char> = stripped.chars().collect();
    let local_part = |c: char| c.is_ascii_alphanumeric() || "._%+-".contains(c);
    (0..text.len()).any(|at| {
        text[at] == '@'
            && (at == 0 || !local_part(text[at - 1]))
            && keyword_at(&text, at + 1, &kw).is_some_and(|end| word_boundary(&text, end))
    })
}

/// What [`is_reply_all`] looks at.
#[derive(Debug, Clone, Copy)]
pub struct ReplyAllCheck<'a> {
    /// The stripped body.
    pub stripped: &'a str,
    /// The full subject line.
    pub subject: &'a str,
    /// The mention keyword ([`DEFAULT_MENTION_KEYWORD`] by default).
    pub keyword: &'a str,
    /// The reply-all subject marker ([`DEFAULT_REPLY_ALL_MARKER`] by default).
    pub marker: &'a str,
}

impl Default for ReplyAllCheck<'_> {
    fn default() -> Self {
        ReplyAllCheck {
            stripped: "",
            subject: "",
            keyword: DEFAULT_MENTION_KEYWORD,
            marker: DEFAULT_REPLY_ALL_MARKER,
        }
    }
}

/// Detect whether this message is asking for a reply-all. Two triggers, either one is enough:
///
///   1. Subject contains the reply-all marker (default "[reply-all]").
///   2. Body (stripped) contains "@<keyword> reply-all" as a phrase (the JS `/@<keyword>\s+reply[\s-]?all\b/i`).
///
/// Reply-all is explicit opt-in only. Default reply behavior is always reply-to-sender.
pub fn is_reply_all(check: ReplyAllCheck<'_>) -> bool {
    if !check.subject.is_empty()
        && !check.marker.is_empty()
        && check.subject.to_lowercase().contains(&check.marker.to_lowercase())
    {
        return true;
    }
    if check.stripped.is_empty() {
        return false;
    }
    let kw: Vec<char> = bare_keyword(check.keyword).chars().collect();
    let text: Vec<char> = check.stripped.chars().collect();
    (0..text.len()).any(|at| {
        if text[at] != '@' {
            return false;
        }
        let Some(mut i) = keyword_at(&text, at + 1, &kw) else {
            return false;
        };
        // \s+ : at least one, and all of them (what follows starts with a letter)
        let spaces = text[i..].iter().take_while(|&&c| is_whitespace(c)).count();
        if spaces == 0 {
            return false;
        }
        i += spaces;
        let Some(mut i) = ascii_word_at(&text, i, "reply") else {
            return false;
        };
        // [\s-]? : "all" cannot start with either, so take it when it is there
        if text.get(i).is_some_and(|&c| is_whitespace(c) || c == '-') {
            i += 1;
        }
        ascii_word_at(&text, i, "all").is_some_and(|end| word_boundary(&text, end))
    })
}

/// The threading headers of a parsed inbound mail, as [`thread_key_from_headers`] reads them: its Message-ID and its
/// References chain (in header order, brackets kept). Package H3 fills it from the parsed mail.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThreadHeaders {
    pub message_id: Option<String>,
    pub references: Vec<String>,
}

/// Compute the thread key used to look up / create the conversation that this email belongs to. Convention:
///
///   - If `references` is non-empty, use the FIRST entry (root of the thread tree) — all replies in a thread share
///     the same root ref, so this gives us a stable per-thread key.
///   - Otherwise, use the current message's own `message_id` (this is the root of a fresh thread).
///
/// Message-ID brackets `<...>` are preserved if present — they're part of the canonical header form and help
/// distinguish between thread roots that happen to share local-parts. `None` when the headers are missing entirely.
pub fn thread_key_from_headers(headers: &ThreadHeaders) -> Option<String> {
    if let Some(root) = headers.references.first().filter(|r| !r.is_empty()) {
        return Some(trim(root).to_string());
    }
    headers
        .message_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .map(|id| trim(id).to_string())
}

static HTML_STYLE: LazyLock<Regex> = LazyLock::new(|| re(r"<(?i-u:style)[^>]*>[\s\S]*?<\/(?i-u:style)>"));
static HTML_SCRIPT: LazyLock<Regex> = LazyLock::new(|| re(r"<(?i-u:script)[^>]*>[\s\S]*?<\/(?i-u:script)>"));
static HTML_BR: LazyLock<Regex> = LazyLock::new(|| re(r"<(?i-u:br)\s*\/?>"));
static HTML_BLOCK_END: LazyLock<Regex> = LazyLock::new(|| re(r"<\/(?i-u:p|div|li|tr|h[1-6])>"));
static HTML_TAG: LazyLock<Regex> = LazyLock::new(|| re(r"<[^>]+>"));
static HTML_ENTITIES: LazyLock<[(Regex, &'static str); 6]> = LazyLock::new(|| {
    [
        (re(r"&(?i-u:nbsp);"), " "),
        (re(r"&(?i-u:amp);"), "&"),
        (re(r"&(?i-u:lt);"), "<"),
        (re(r"&(?i-u:gt);"), ">"),
        (re(r"&(?i-u:quot);"), "\""),
        (re(r"&#39;"), "'"),
    ]
});
static BLANK_RUNS: LazyLock<Regex> = LazyLock::new(|| re(r"\n{3,}"));

/// Best-effort HTML → plain-text fallback for emails that have no text/plain part. Strips tags, decodes a handful of
/// common entities, collapses whitespace. Good enough for quote-strip + mention match — not meant to be a perfect
/// rendering.
pub fn html_to_text(html: &str) -> String {
    if html.is_empty() {
        return String::new();
    }
    let s = HTML_STYLE.replace_all(html, "");
    let s = HTML_SCRIPT.replace_all(&s, "");
    let s = HTML_BR.replace_all(&s, "\n");
    let s = HTML_BLOCK_END.replace_all(&s, "\n");
    let mut s = HTML_TAG.replace_all(&s, "").into_owned();
    for (entity, replacement) in HTML_ENTITIES.iter() {
        s = entity.replace_all(&s, regex::NoExpand(replacement)).into_owned();
    }
    let s = BLANK_RUNS.replace_all(&s, "\n\n");
    trim(&s).to_string()
}

#[cfg(test)]
mod tests {
    //! Port of the `src/lib/email-parser.js` half of `test/email-parser.test.js` (the threading half is in
    //! `email_threading.rs`), then cases whose expected values were printed by the Node code for the same input
    //! (generated, not typed).
    use super::*;

    // stripQuotedReply

    #[test]
    fn strip_quoted_reply_gmail_apple_style_quote_header_ends_the_body() {
        let body = [
            "@tarsee what do you think?",
            "",
            "On Wed, Apr 24, 2026 at 3:14 PM Alice <alice@example.com> wrote:",
            "> @tarsee earlier message from the thread",
            "> more quoted content",
        ]
        .join("\n");
        assert_eq!(strip_quoted_reply(&body), "@tarsee what do you think?");
    }

    #[test]
    fn strip_quoted_reply_outlook_original_message_separator() {
        let body = [
            "ok, go ahead.",
            "",
            "-----Original Message-----",
            "From: Alice <alice@example.com>",
            "Sent: Wednesday, April 24, 2026",
            "Subject: status",
            "",
            "original content here",
        ]
        .join("\n");
        assert_eq!(strip_quoted_reply(&body), "ok, go ahead.");
    }

    #[test]
    fn strip_quoted_reply_rfc_3676_signature_delimiter_ends_the_body() {
        let body = [
            "@tarsee please note",
            "",
            "-- ",
            "@tarsee  <- this in the sig should NOT be read as a mention",
            "Best, Alice",
        ]
        .join("\n");
        let stripped = strip_quoted_reply(&body);
        assert_eq!(stripped, "@tarsee please note");
        assert!(has_mention(&stripped, DEFAULT_MENTION_KEYWORD));
    }

    #[test]
    fn strip_quoted_reply_lines_starting_with_gt_are_dropped() {
        assert_eq!(
            strip_quoted_reply("> old content\n> more old content\nnew line"),
            "new line"
        );
    }

    #[test]
    fn strip_quoted_reply_forwarded_from_header_block_stops_consumption() {
        let body = [
            "please handle this forward",
            "",
            "From: Bob <bob@example.com>",
            "To: Alice <alice@example.com>",
            "",
            "... original forwarded content ...",
        ]
        .join("\n");
        assert_eq!(strip_quoted_reply(&body), "please handle this forward");
    }

    #[test]
    fn strip_quoted_reply_crlf_line_endings_are_handled() {
        assert_eq!(
            strip_quoted_reply("line 1\r\nline 2\r\n> quoted\r\nline 3"),
            "line 1\nline 2\nline 3"
        );
    }

    /// The Node case also passed `null` and `undefined`; a Rust `&str` is never either.
    #[test]
    fn strip_quoted_reply_empty_null_input_safe() {
        assert_eq!(strip_quoted_reply(""), "");
    }

    // hasMention

    #[test]
    fn has_mention_direct_tarsee_with_word_boundary_matches() {
        assert!(has_mention("@tarsee hi there", DEFAULT_MENTION_KEYWORD));
        assert!(has_mention("hey @tarsee can you", DEFAULT_MENTION_KEYWORD));
        assert!(has_mention("can you @Tarsee respond?", DEFAULT_MENTION_KEYWORD)); // case insensitive
        assert!(has_mention("@TARSEE!", DEFAULT_MENTION_KEYWORD)); // uppercase
    }

    #[test]
    fn has_mention_email_address_looking_tarsee_is_not_a_mention() {
        // Standard bounce — Tarsee's address should not trigger a mention.
        assert!(!has_mention(
            "send it to alice@tarsee.example.com",
            DEFAULT_MENTION_KEYWORD
        ));
        assert!(!has_mention("cc: bot@tarsee.io", DEFAULT_MENTION_KEYWORD));
        // A username with a 'tarsee' substring inside a longer local-part.
        assert!(!has_mention("replied to btarsee@example.com", DEFAULT_MENTION_KEYWORD));
    }

    #[test]
    fn has_mention_tarsee_as_a_bare_word_no_at_does_not_match() {
        assert!(!has_mention("the tarsee animal is cute", DEFAULT_MENTION_KEYWORD));
        assert!(!has_mention("Tarsee, please", DEFAULT_MENTION_KEYWORD));
    }

    #[test]
    fn has_mention_custom_keyword_with_or_without_leading_at() {
        assert!(has_mention("@jarvis status?", "jarvis"));
        assert!(has_mention("@jarvis status?", "@jarvis")); // leading @ in keyword ok
        assert!(!has_mention("@tarsee yo", "jarvis")); // wrong keyword
    }

    #[test]
    fn has_mention_keyword_with_regex_metacharacters_is_escaped() {
        // Hypothetical operator using a bracket or dot in keyword — shouldn't regex-inject.
        assert!(has_mention("@bot.tarsee hi", "bot.tarsee"));
        assert!(!has_mention("@botxtarsee hi", "bot.tarsee")); // dot treated literally
    }

    /// The Node case also passed `null`; a Rust `&str` cannot be null.
    #[test]
    fn has_mention_empty_null_input_safe() {
        assert!(!has_mention("", DEFAULT_MENTION_KEYWORD));
        assert!(!has_mention("@tarsee hi", "")); // empty keyword
    }

    // isReplyAll

    #[test]
    fn is_reply_all_subject_marker_triggers_reply_all() {
        assert!(is_reply_all(ReplyAllCheck {
            stripped: "anything",
            subject: "[reply-all] status update",
            ..Default::default()
        }));
        // Case insensitive
        assert!(is_reply_all(ReplyAllCheck {
            stripped: "anything",
            subject: "[REPLY-ALL] status",
            ..Default::default()
        }));
    }

    #[test]
    fn is_reply_all_body_phrase_tarsee_reply_all_triggers_reply_all() {
        assert!(is_reply_all(ReplyAllCheck {
            stripped: "@tarsee reply-all please",
            subject: "status",
            ..Default::default()
        }));
        assert!(is_reply_all(ReplyAllCheck {
            stripped: "@tarsee reply all please",
            subject: "status",
            ..Default::default()
        }));
    }

    #[test]
    fn is_reply_all_default_mention_only_is_not_reply_all() {
        assert!(!is_reply_all(ReplyAllCheck {
            stripped: "@tarsee status?",
            subject: "status",
            ..Default::default()
        }));
    }

    #[test]
    fn is_reply_all_custom_keyword_and_marker() {
        assert!(is_reply_all(ReplyAllCheck {
            stripped: "@jarvis reply-all now",
            subject: "whatever",
            keyword: "jarvis",
            ..Default::default()
        }));
        assert!(is_reply_all(ReplyAllCheck {
            stripped: "no mention here",
            subject: "[share-all] update",
            marker: "[share-all]",
            ..Default::default()
        }));
    }

    // threadKeyFromHeaders

    #[test]
    fn thread_key_from_headers_references_0_wins_when_present() {
        let key = thread_key_from_headers(&ThreadHeaders {
            message_id: Some("<current@example.com>".into()),
            references: vec!["<root@example.com>".into(), "<middle@example.com>".into()],
        });
        assert_eq!(key.as_deref(), Some("<root@example.com>"));
    }

    #[test]
    fn thread_key_from_headers_falls_back_to_message_id_for_a_fresh_thread() {
        let key = thread_key_from_headers(&ThreadHeaders {
            message_id: Some("<new-thread@example.com>".into()),
            references: vec![],
        });
        assert_eq!(key.as_deref(), Some("<new-thread@example.com>"));
    }

    /// The Node case called it with no argument, `{}`, and nulls; all three are the empty headers here.
    #[test]
    fn thread_key_from_headers_null_safe() {
        assert_eq!(thread_key_from_headers(&ThreadHeaders::default()), None);
    }

    // htmlToText

    #[test]
    fn html_to_text_strips_tags_decodes_common_entities_preserves_line_structure() {
        let html = "<p>hi <b>@tarsee</b></p><p>please &amp; review</p><script>alert(1)</script>";
        let text = html_to_text(html);
        assert!(text.contains("hi @tarsee"), "{text}");
        assert!(text.contains("please & review"), "{text}");
        assert!(
            !text.contains('<') && !text.contains('>') && !text.contains("script"),
            "{text}"
        );
    }

    /// The Node case also passed `null`; a Rust `&str` cannot be null.
    #[test]
    fn html_to_text_empty_safe() {
        assert_eq!(html_to_text(""), "");
    }

    // Awkward input, against what the Node code printed.

    #[test]
    fn strip_quoted_reply_matches_the_node_output() {
        for (i, (body, expected)) in NODE_STRIP.iter().enumerate() {
            assert_eq!(strip_quoted_reply(body), *expected, "case {i}: {body:?}");
        }
    }

    #[test]
    fn has_mention_matches_the_node_output_including_case_folding() {
        for (text, keyword, expected) in NODE_MENTION {
            assert_eq!(has_mention(text, keyword), *expected, "{text:?} {keyword:?}");
        }
    }

    #[test]
    fn is_reply_all_matches_the_node_output() {
        for (stripped, subject, keyword, marker, expected) in NODE_REPLY_ALL {
            let check = ReplyAllCheck {
                stripped,
                subject,
                keyword,
                marker,
            };
            assert_eq!(is_reply_all(check), *expected, "{check:?}");
        }
    }

    #[test]
    fn thread_key_from_headers_matches_the_node_output() {
        for (id, refs, expected) in NODE_THREAD_KEY {
            let headers = ThreadHeaders {
                message_id: id.map(str::to_string),
                references: refs.iter().map(|r| r.to_string()).collect(),
            };
            assert_eq!(thread_key_from_headers(&headers).as_deref(), *expected, "{headers:?}");
        }
    }

    #[test]
    fn html_to_text_matches_the_node_output() {
        for (html, expected) in NODE_HTML {
            assert_eq!(html_to_text(html), *expected, "{html:?}");
        }
    }

    /// Bodies and what `stripQuotedReply` printed, in the Node code.
    const NODE_STRIP: &[(&str, &str)] = &[
        ("hello\nOn Mon, Jan 1 Bob <b@x.io> wrote:\n> q", "hello"),
        ("hello\non mon, 2026-01-01 at 10:00 someone WROTE:  \n> q", "hello"),
        ("hi\nOn short wrote:\nmore", "hi\nOn short wrote:\nmore"),
        ("hi\nOn 😀😀😀😀😀wrote:\nmore", "hi"),
        ("hi\nOn 😀😀😀😀wrote:\nmore", "hi\nOn 😀😀😀😀wrote:\nmore"),
        (
            "hi\nOn xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxwrote:\nmore",
            "hi\nOn xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxwrote:\nmore",
        ),
        (
            "hi\nOn Mon, Jan 1, 2026 at 9:00 AM Alice <alice@example.com>\nwrote:\n> old",
            "hi\nwrote:",
        ),
        (
            "hi\nOn Mon, Jan 1 2026 Alice\nkeep",
            "hi\nOn Mon, Jan 1 2026 Alice\nkeep",
        ),
        ("body\n---Original Message---\nold", "body"),
        ("body\n  -- original message --  \nold", "body"),
        ("From: Bob <b@x.io>\nfirst line", "From: Bob <b@x.io>\nfirst line"),
        ("x\nfrom:   Bob <b@x.io>\ny", "x"),
        ("x\nFrom: no brackets b@x.io\ny", "x\nFrom: no brackets b@x.io\ny"),
        ("sig\n-- \nname", "sig"),
        ("sig\n--\nkept", "sig\n--\nkept"),
        ("sig\n--  \t\nname", "sig"),
        ("  > quoted\n\t>also\nkeep > this", "keep > this"),
        ("\r\n\r\n  padded  \r\n\r\n", "padded"),
        ("a\rb\r\nc", "a\rb\nc"),
        ("\u{a0}lead\u{feff}", "lead"),
        ("On Mon, Jan 1 Bob <b@x.io> wrote:", ""),
        ("ſ\nOn x,y wrote:", "ſ\nOn x,y wrote:"),
        (
            "Ön Mon, Jan 1 Bob <b@x.io> wrote:\nkept",
            "Ön Mon, Jan 1 Bob <b@x.io> wrote:\nkept",
        ),
    ];

    /// Text, keyword, and what `hasMention` printed, in the Node code.
    const NODE_MENTION: &[(&str, &str, bool)] = &[
        ("@tarsee", "tarsee", true),
        ("x@tarsee", "tarsee", false),
        (" @tarsee_x", "tarsee", false),
        ("(@tarsee)", "tarsee", true),
        ("@tarsee.", "tarsee", true),
        ("-@tarsee", "tarsee", false),
        ("%@tarsee", "tarsee", false),
        ("é@tarsee", "tarsee", true),
        ("😀@tarsee", "tarsee", true),
        ("@TARSEE", "tarsee", true),
        ("@tarſee", "tarsee", false),
        ("@tarsee", "TARſEE", false),
        ("@Key", "key", false),
        ("@key", "Key", false),
        ("@café!", "CAFÉ", false),
        ("@CAFÉ!", "café", false),
        ("@straße", "STRASSE", false),
        ("@ΣΟΦΙΑ", "σοφια", false),
        ("@ΣΟΦΙΑ", "σοφιας", false),
        ("@bot-1 hi", "bot-1", true),
        ("@bot-1x", "bot-1", false),
        ("@tarseé", "tarse", true),
        ("@tarsee😀", "tarsee", true),
        ("@😀 hi", "😀", false),
        ("@a+b", "a+b", true),
        ("@a b", "a b", true),
        ("@@tarsee", "tarsee", true),
        ("@tarsee", "@", false),
        ("\n@tarsee", "tarsee", true),
        ("@tarsee", "@@tarsee", false),
        ("@ıd", "ID", false),
        ("@id", "İD", false),
    ];

    /// Body, subject, keyword, marker, and what `isReplyAll` printed, in the Node code.
    const NODE_REPLY_ALL: &[(&str, &str, &str, &str, bool)] = &[
        ("@tarsee reply-all", "", "tarsee", "[reply-all]", true),
        ("@tarsee  reply all", "", "tarsee", "[reply-all]", true),
        ("@tarsee reply  all", "", "tarsee", "[reply-all]", false),
        ("@tarsee replyall", "", "tarsee", "[reply-all]", true),
        ("@tarsee\treply-allx", "", "tarsee", "[reply-all]", false),
        ("@tarsee reply--all", "", "tarsee", "[reply-all]", false),
        ("@TARSEE REPLY-ALL!", "", "tarsee", "[reply-all]", true),
        ("@tarsee\u{a0}reply\u{a0}all", "", "tarsee", "[reply-all]", true),
        ("@tarseereply all", "", "tarsee", "[reply-all]", false),
        ("x@tarsee reply all", "", "tarsee", "[reply-all]", true),
        ("@ reply all", "", "", "[reply-all]", true),
        ("@ reply all", "", "@", "[reply-all]", true),
        ("", "Re: [Reply-All] x", "tarsee", "[reply-all]", true),
        ("", "subject", "tarsee", "", false),
        ("@jarvis reply_all", "", "jarvis", "[reply-all]", false),
        ("no", "İ marker", "tarsee", "i̇ marker", true),
        ("@tarsee reply all_", "", "tarsee", "[reply-all]", false),
    ];

    /// Message-ID, References, and what `threadKeyFromHeaders` printed, in the Node code.
    const NODE_THREAD_KEY: &[(Option<&str>, &[&str], Option<&str>)] = &[
        (None, &[], None),
        (Some(""), &[], None),
        (Some("  <a@b>  "), &[], Some("<a@b>")),
        (Some("<a@b>"), &[""], Some("<a@b>")),
        (Some("<a@b>"), &["  <root@x>\t"], Some("<root@x>")),
        (Some("<a@b>"), &["   "], Some("")),
        (None, &["<r@x>", "<s@x>"], Some("<r@x>")),
        (Some("\u{feff}<a@b>\u{85}"), &[], Some("<a@b>\u{85}")),
    ];

    /// HTML and what `htmlToText` printed, in the Node code.
    const NODE_HTML: &[(&str, &str)] = &[
        ("<p>a</p><p>b</p>", "a\nb"),
        ("<STYLE type=x>p{}</STYLE>text<Script>bad()</SCRIPT>", "text"),
        ("a<br>b<BR/>c<br  />d<br\n>e", "a\nb\nc\nd\ne"),
        ("<div>x</div><li>y</LI><tr>z</tr><h1>h</h1><h7>n</h7>", "x\ny\nz\nh\nn"),
        ("&NBSP;&Amp;&lt;&GT;&quot;&#39;&#039;&apos;", "&<>\"'&#039;&apos;"),
        ("&amp;lt;b&amp;gt;", "<b>"),
        ("<p>1</p>\n\n\n\n<p>2</p>", "1\n\n2"),
        ("a < b and c > d", "a  d"),
        ("<a href=\"x\">link</a> <img src=y>", "link"),
        ("<ſtyle>x</ſtyle>", "x"),
        ("  \u{a0}<b>bold</b>\u{feff} ", "bold"),
        ("<style>unclosed", "unclosed"),
        ("<!-- comment --> after", "after"),
    ];
}
