//! Port of `test/no-native-dialogs.test.js`: no browser dialog in the dashboard: every question is our own
//! (`src/public/js/dialogs.js`, `TarseeDialog`). The browser's boxes are headed with the site's address, cannot be
//! styled, and block the whole tab.
//!
//! Every .js and .html file under src/public is read as code: comments, the words in strings and template literals,
//! and regular expressions are left out, and an HTML file's code is its inline scripts, its on...= handlers and its
//! javascript: links. In that code, any window.confirm, window.alert or window.prompt (or the same on self,
//! globalThis, top, parent or frames, with a dot, ?. or ["..."]) fails, and so does a bare call of confirm(, alert( or
//! prompt(, unless it calls a function of the file's own by that name (declared where the call can see it, say a
//! const confirm of a module's own), or it is a method's own definition.
//!
//! Positions are byte offsets. What is blanked keeps its length in bytes (a character becomes as many spaces as it
//! has bytes), so a position means the same place in the source, its code and its code with strings, as the Node
//! test's positions (UTF-16 units) did.

use std::collections::HashMap;
use std::path::Path;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;

use crate::support::files::public_dir;

const NAMES: &str = "confirm|alert|prompt";
const GLOBALS: &str = "window|self|globalThis|top|parent|frames";

/// JavaScript's `\s` (which, unlike Rust's whitespace, has U+FEFF and not U+0085).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// JavaScript's `[\w$]` (ASCII, as a regular expression without the u flag reads it).
fn ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

fn fancy(pattern: &str) -> FancyRegex {
    FancyRegex::new(pattern).unwrap_or_else(|e| panic!("{pattern}: {e}"))
}

/// Every match of a fancy regex: (start, the captures as text, by number).
fn fancy_matches(re: &FancyRegex, text: &str) -> Vec<(usize, Vec<Option<String>>)> {
    re.captures_iter(text)
        .map(|c| {
            let c = c.expect("a match");
            let start = c.get(0).expect("the match").start();
            let groups = (0..c.len()).map(|i| c.get(i).map(|m| m.as_str().to_string())).collect();
            (start, groups)
        })
        .collect()
}

/// A script's code with what is not code blanked out, every other character where it was (line breaks kept, so a
/// position is still its line): `.0` has comments, regular expressions and the words of strings and of template
/// literals (outside their `${...}`) blanked; `.1` keeps the strings' words (for `window["confirm"]`).
fn code_of(src: &str) -> (String, String) {
    let chars: Vec<(usize, char)> = src.char_indices().collect();
    let n = chars.len();
    let at = |i: usize| -> usize { chars.get(i).map_or(src.len(), |c| c.0) };
    let ch = |i: usize| -> Option<char> { chars.get(i).map(|c| c.1) };
    let mut code = src.as_bytes().to_vec();
    let mut with_strings = src.as_bytes().to_vec();
    // (From character a to character b.)
    let mut blank = |a: usize, b: usize, also_strings: bool| {
        for k in at(a)..at(b.min(n)) {
            if src.as_bytes()[k] == b'\n' {
                continue;
            }
            code[k] = b' ';
            if also_strings {
                with_strings[k] = b' ';
            }
        }
    };
    const BEFORE_A_VALUE: [&str; 14] = [
        "return",
        "typeof",
        "instanceof",
        "in",
        "of",
        "new",
        "delete",
        "void",
        "throw",
        "case",
        "do",
        "else",
        "yield",
        "await",
    ];
    // What code came last: a punctuator, "word" (a keyword a value may follow), or "value".
    let mut last = String::new();
    // Template literals whose ${...} we are in: the braces opened in each since its ${.
    let mut holes: Vec<i64> = Vec::new();
    let mut i = 0;

    // The words of a template literal from j: to its closing ` (a value) or to a ${ (code again, inside it).
    let template = |j: usize, last: &mut String, holes: &mut Vec<i64>, blank: &mut dyn FnMut(usize, usize, bool)| {
        let mut k = j;
        while k < n {
            if ch(k) == Some('\\') {
                k += 2;
                continue;
            }
            if ch(k) == Some('`') {
                blank(j, k, false);
                *last = "value".to_string();
                return k + 1;
            }
            if ch(k) == Some('$') && ch(k + 1) == Some('{') {
                blank(j, k, false);
                holes.push(0);
                *last = "(".to_string();
                return k + 2;
            }
            k += 1;
        }
        blank(j, n, false);
        n
    };

    while i < n {
        let c = ch(i).expect("a character");
        let d = ch(i + 1);
        if c == '/' && d == Some('/') {
            let end = src[at(i)..]
                .find('\n')
                .map_or(n, |e| chars.partition_point(|x| x.0 < at(i) + e));
            blank(i, end, true);
            i = end;
            continue;
        }
        if c == '/' && d == Some('*') {
            let end = src[at(i + 2).min(src.len())..]
                .find("*/")
                .map_or(n, |e| chars.partition_point(|x| x.0 < at(i + 2) + e) + 2);
            blank(i, end, true);
            i = end;
            continue;
        }
        if c == '\'' || c == '"' {
            let mut k = i + 1;
            while k < n && ch(k) != Some(c) && ch(k) != Some('\n') {
                k += if ch(k) == Some('\\') { 2 } else { 1 };
            }
            // (The words stay in with_strings.)
            blank(i + 1, k.min(n), false);
            i = k + 1;
            last = "value".to_string();
            continue;
        }
        if c == '`' {
            i = template(i + 1, &mut last, &mut holes, &mut blank);
            continue;
        }
        if c == '}' && holes.last() == Some(&0) {
            holes.pop();
            i = template(i + 1, &mut last, &mut holes, &mut blank);
            continue;
        }
        if c == '{' {
            if let Some(open) = holes.last_mut() {
                *open += 1;
            }
            last = "{".to_string();
            i += 1;
            continue;
        }
        if c == '}' {
            if let Some(open) = holes.last_mut() {
                *open -= 1;
            }
            last = "}".to_string();
            i += 1;
            continue;
        }
        if c == '/' {
            let punctuator = last.chars().count() == 1 && last.chars().all(|l| "(,=:[!&|?{};+-*%<>~^".contains(l));
            let regex_here = last.is_empty() || last == "word" || punctuator;
            if regex_here {
                let mut k = i + 1;
                let mut in_class = false;
                while k < n && ch(k) != Some('\n') {
                    match ch(k) {
                        Some('\\') => {
                            k += 2;
                            continue;
                        }
                        Some('[') => in_class = true,
                        Some(']') => in_class = false,
                        Some('/') if !in_class => break,
                        _ => {}
                    }
                    k += 1;
                }
                if k < n && ch(k) == Some('/') {
                    k += 1;
                    while k < n && ch(k).is_some_and(|f| f.is_ascii_alphabetic()) {
                        k += 1;
                    }
                    blank(i, k, true);
                    i = k;
                    last = "value".to_string();
                    continue;
                }
            }
            last = "/".to_string();
            i += 1;
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' || c == '$' {
            let mut k = i + 1;
            while k < n && ch(k).is_some_and(ident_char) {
                k += 1;
            }
            let word = &src[at(i)..at(k)];
            last = if BEFORE_A_VALUE.contains(&word) {
                "word"
            } else {
                "value"
            }
            .to_string();
            i = k;
            continue;
        }
        if c.is_ascii_digit() {
            let mut k = i + 1;
            while k < n && ch(k).is_some_and(|f| f.is_ascii_alphanumeric() || f == '_' || f == '.') {
                k += 1;
            }
            i = k;
            last = "value".to_string();
            continue;
        }
        if js_space(c) {
            i += 1;
            continue;
        }
        last = if c == ')' || c == ']' {
            "value".to_string()
        } else {
            c.to_string()
        };
        i += 1;
    }
    let text = |bytes: Vec<u8>| String::from_utf8(bytes).expect("blanked whole characters only");
    (text(code), text(with_strings))
}

/// An HTML page's code, blanked like `code_of` except for its scripts: the inline `<script>`s (not those with a src),
/// its on...= handlers and its javascript: links. HTML comments are not code.
fn html_code(html: &str) -> String {
    let mut out: Vec<u8> = html.bytes().map(|b| if b == b'\n' { b'\n' } else { b' ' }).collect();
    let mut keep = |from: usize, text: &str| out[from..from + text.len()].copy_from_slice(text.as_bytes());
    let comment = Regex::new(r"<!--[\s\S]*?-->").expect("regex");
    let live = comment.replace_all(html, |m: &regex::Captures| {
        m[0].bytes()
            .map(|b| if b == b'\n' { '\n' } else { ' ' })
            .collect::<String>()
    });
    let live = live.as_ref();
    let script = Regex::new(r"(?i)<script(?-u:\b)([^>]*)>([\s\S]*?)</script\s*>").expect("regex");
    let has_src = Regex::new(r"(?i)(?-u:\b)src\s*=").expect("regex");
    let not_js =
        fancy(r#"(?i)(?<![A-Za-z0-9_])type\s*=\s*["']?(?!module|text/javascript|application/javascript)[^"'\s>]+"#);
    for m in script.captures_iter(live) {
        let attrs = &m[1];
        if has_src.is_match(attrs) || not_js.is_match(attrs).expect("a match") {
            continue;
        }
        let whole = m.get(0).expect("the match");
        keep(whole.start() + whole.as_str().find('>').expect("a tag") + 1, &m[2]);
    }
    let tag = Regex::new(r"(?i)<[a-z][^>]*>").expect("regex");
    let handler = Regex::new(r#"(?i)\s(on[a-z]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))"#).expect("regex");
    let js_link = fancy(r#"(?i)\s(?:href|src|action|formaction)\s*=\s*(["']?)\s*javascript:([^"'>]*)\1"#);
    for m in tag.find_iter(live) {
        for a in handler.captures_iter(m.as_str()) {
            let quoted = a.get(3).is_some() || a.get(4).is_some();
            let value = a.get(3).or(a.get(4)).or(a.get(5)).map_or("", |v| v.as_str());
            let whole = a.get(0).expect("the match");
            keep(
                m.start() + whole.start() + whole.len() - value.len() - usize::from(quoted),
                value,
            );
        }
        for (start, groups) in fancy_matches(&js_link, m.as_str()) {
            let whole = groups[0].as_deref().unwrap_or_default();
            // (indexOf: -1 when the match spelled it in capitals.)
            let at = whole.find("javascript:").map_or(-1, |i| i as i64);
            let from = (m.start() + start) as i64 + at + "javascript:".len() as i64;
            keep(from as usize, groups[2].as_deref().unwrap_or_default());
        }
    }
    String::from_utf8(out).expect("whole characters only")
}

/// The pairs of braces in code: (open, close) for each, by position.
fn blocks(code: &str) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    let mut open = Vec::new();
    for (k, b) in code.bytes().enumerate() {
        if b == b'{' {
            open.push(k);
        } else if b == b'}'
            && let Some(o) = open.pop()
        {
            pairs.push((o, k));
        }
    }
    pairs
}

/// The block a declaration at `at` is seen in: the innermost braces round it, or the whole file.
fn scope_at(pairs: &[(usize, usize)], at: usize, n: usize) -> (usize, usize) {
    let mut best = (0, n);
    for &(a, b) in pairs {
        if a < at && at < b && b - a < best.1 - best.0 {
            best = (a, b);
        }
    }
    best
}

/// The code just before position `at`, its trailing white space left off: the last character, and the identifier it
/// ends with.
fn before(code: &str, at: usize) -> (Option<char>, String) {
    let head = &code[..at];
    let trimmed = head.trim_end_matches(js_space);
    let last = trimmed.chars().next_back();
    let word_start = trimmed
        .char_indices()
        .rev()
        .take_while(|(_, c)| ident_char(*c))
        .last()
        .map_or(trimmed.len(), |(i, _)| i);
    (last, trimmed[word_start..].to_string())
}

/// A declaration of the file's own called confirm, alert or prompt, and the part of the code that sees it.
struct Own {
    name: String,
    from: usize,
    to: usize,
}

/// Where code declares a function, class, const, let, var or parameter of its own called confirm, alert or prompt.
fn own_names(code: &str) -> Vec<Own> {
    let pairs = blocks(code);
    let n = code.len();
    let close_of: HashMap<usize, usize> = pairs.iter().copied().collect();
    let mut found = Vec::new();
    let mut add = |found: &mut Vec<Own>, name: &str, at: usize| {
        let (from, to) = scope_at(&pairs, at, n);
        found.push(Own {
            name: name.to_string(),
            from,
            to,
        });
    };
    let declared = fancy(&format!(
        r"(?<![A-Za-z0-9_])(?:function\s*\*?|class|const|let|var)\s+({NAMES})(?![A-Za-z0-9_$])"
    ));
    for (start, groups) in fancy_matches(&declared, code) {
        let (whole, name) = (
            groups[0].as_deref().unwrap_or_default(),
            groups[1].as_deref().unwrap_or_default(),
        );
        add(&mut found, name, start + whole.len() - name.len());
    }
    // Destructured: const { confirm } = ..., const [alert] = ... (seen in the block round the const).
    let destructured = Regex::new(r"(?-u:\b)(?:const|let|var)\s*([{\[])([^}\]]*)[}\]]").expect("regex");
    let inside = fancy(&format!(r"(?<![A-Za-z0-9_$.])({NAMES})(?![A-Za-z0-9_$]|\s*:)"));
    for m in destructured.captures_iter(code) {
        let start = m.get(0).expect("the match").start();
        for (_, groups) in fancy_matches(&inside, &m[2]) {
            add(&mut found, groups[1].as_deref().unwrap_or_default(), start);
        }
    }
    // Parameters, seen in the body that follows: function f(confirm) { }, a method's m(alert) { }, catch (prompt) { },
    // (a, confirm) => { }; an arrow without braces, (alert) => ... or prompt => ..., in the block round it.
    let param = fancy(&format!(r"(?<![A-Za-z0-9_$.])({NAMES})(?![A-Za-z0-9_$])"));
    let parens = Regex::new(r"\(([^()]*)\)\s*(=>)?\s*(\{)?").expect("regex");
    let not_parameters =
        Regex::new(r"^(if|for|while|switch|with|return|typeof|void|await|yield|in|of|new)$").expect("regex");
    for m in parens.captures_iter(code) {
        let whole = m.get(0).expect("the match");
        let (arrow, brace) = (m.get(2).is_some(), m.get(3).is_some());
        if (!arrow && !brace) || !param.is_match(&m[1]).expect("a match") {
            continue;
        }
        let (_, word) = before(code, whole.start());
        // (if (x) {: no parameters)
        if !arrow && (word.is_empty() || not_parameters.is_match(&word)) {
            continue;
        }
        for (_, groups) in fancy_matches(&param, &m[1]) {
            let name = groups[1].as_deref().unwrap_or_default();
            if brace {
                let body = whole.end() - 1;
                found.push(Own {
                    name: name.to_string(),
                    from: body,
                    to: close_of.get(&body).copied().unwrap_or(n),
                });
            } else {
                add(&mut found, name, whole.start());
            }
        }
    }
    let bare_arrow = fancy(&format!(r"(?<![A-Za-z0-9_$.])({NAMES})\s*=>"));
    for (start, groups) in fancy_matches(&bare_arrow, code) {
        add(&mut found, groups[1].as_deref().unwrap_or_default(), start);
    }
    found
}

/// A browser dialog found in a script's code: where (a position in it), and what.
struct Hit {
    at: usize,
    what: String,
}

/// The browser's dialogs in a script's code.
fn native_dialogs(src: &str, html: bool) -> Vec<Hit> {
    let text = if html { html_code(src) } else { src.to_string() };
    let (code, with_strings) = code_of(&text);
    let mut hits = Vec::new();
    let dotted = fancy(&format!(
        r"(?<![A-Za-z0-9_])({GLOBALS})\s*(?:\?\.|\.)\s*({NAMES})(?![A-Za-z0-9_$])"
    ));
    for (start, groups) in fancy_matches(&dotted, &code) {
        let (global, name) = (
            groups[1].as_deref().unwrap_or_default(),
            groups[2].as_deref().unwrap_or_default(),
        );
        hits.push(Hit {
            at: start,
            what: format!("{global}.{name}"),
        });
    }
    let indexed = fancy(&format!(
        r#"(?<![A-Za-z0-9_])({GLOBALS})\s*(?:\?\.)?\s*\[\s*(["'`])({NAMES})\2\s*\]"#
    ));
    for (start, groups) in fancy_matches(&indexed, &with_strings) {
        let (global, name) = (
            groups[1].as_deref().unwrap_or_default(),
            groups[3].as_deref().unwrap_or_default(),
        );
        hits.push(Hit {
            at: start,
            what: format!(r#"{global}["{name}"]"#),
        });
    }
    let call = fancy(&format!(r"(?<![A-Za-z0-9_$#])({NAMES})\s*\("));
    let calls = fancy_matches(&call, &code);
    let own = if calls.is_empty() { Vec::new() } else { own_names(&code) };
    let own_definition = Regex::new(r"^(function|get|set|static|async)$").expect("regex");
    let bytes = code.as_bytes();
    for (at, groups) in calls {
        let (whole, name) = (
            groups[0].as_deref().unwrap_or_default(),
            groups[1].as_deref().unwrap_or_default(),
        );
        let (prev_char, prev_word) = before(&code, at);
        // A method of something (ui.confirm(), this.alert(), TarseeDialog.ask).
        if prev_char == Some('.') {
            continue;
        }
        // function* confirm(
        if prev_char == Some('*') {
            let star = code[..at].rfind('*');
            if star.is_some_and(|s| before(&code, s).1 == "function") {
                continue;
            }
        }
        // Its own definition.
        if own_definition.is_match(&prev_word) {
            continue;
        }
        // A method's definition: confirm(x) { ... } (the call's closing parenthesis, then a brace).
        let mut k = at + whole.len();
        let mut depth = 1;
        while k < bytes.len() && depth > 0 {
            match bytes[k] {
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ => {}
            }
            k += 1;
        }
        if code[k..].trim_start_matches(js_space).starts_with('{') {
            continue;
        }
        // The file's own function by that name.
        if own.iter().any(|o| o.name == name && o.from <= at && at <= o.to) {
            continue;
        }
        hits.push(Hit {
            at,
            what: format!("{name}("),
        });
    }
    hits.sort_by_key(|h| h.at);
    hits
}

fn line_of(src: &str, at: usize) -> usize {
    src[..at].matches('\n').count() + 1
}

/// Every .js, .mjs, .cjs, .html and .htm file under `dir`.
fn files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let script = Regex::new(r"(?i)\.(m?js|cjs|html?)$").expect("regex");
    let mut entries: Vec<_> = std::fs::read_dir(dir).expect("a folder").flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            files(&path, out);
        } else if script.is_match(&entry.file_name().to_string_lossy()) {
            out.push(path);
        }
    }
}

// ---------------------------------------------------------------- no browser dialogs in src/public

#[test]
fn no_js_or_html_file_calls_the_browsers_confirm_alert_or_prompt() {
    let public = public_dir();
    let mut paths = Vec::new();
    files(public, &mut paths);
    let mut found = Vec::new();
    let mut seen = 0;
    for path in &paths {
        let src = std::fs::read_to_string(path).expect("a file");
        seen += 1;
        let html = Regex::new(r"(?i)\.html?$")
            .expect("regex")
            .is_match(&path.to_string_lossy());
        let relative = path
            .strip_prefix(public)
            .expect("under public")
            .to_string_lossy()
            .replace('\\', "/");
        for hit in native_dialogs(&src, html) {
            found.push(format!("src/public/{relative}:{}: {}", line_of(&src, hit.at), hit.what));
        }
    }
    assert!(seen > 15, "looked at {seen} files");
    assert!(
        found.is_empty(),
        "Ask with TarseeDialog.ask() or TarseeDialog.askText() (src/public/js/dialogs.js) instead of:\n  {}",
        found.join("\n  ")
    );
}

#[test]
fn our_own_questions_are_there_to_use_js_dialogs_js_puts_tarseedialog_on_the_window() {
    let src = std::fs::read_to_string(public_dir().join("js/dialogs.js")).expect("dialogs.js");
    assert!(
        Regex::new(r"G\.TarseeDialog = Object\.freeze\(\{\s*ask:")
            .expect("regex")
            .is_match(&src)
    );
    assert!(native_dialogs(&src, false).is_empty());
}

// ---------------------------------------------------------------- the guard itself

fn hit(src: &str) -> Vec<String> {
    native_dialogs(src, false).into_iter().map(|h| h.what).collect()
}

fn hit_html(src: &str) -> Vec<String> {
    native_dialogs(src, true).into_iter().map(|h| h.what).collect()
}

#[test]
fn catches_the_browsers_dialogs_called_or_not_in_every_spelling() {
    assert_eq!(
        hit(r#"if (!window.confirm("Regenerate the webhook secret?")) return;"#),
        ["window.confirm"]
    );
    assert_eq!(hit(r#"const name = prompt("File name:");"#), ["prompt("]);
    assert_eq!(hit("alert(1); window.alert(2);"), ["alert(", "window.alert"]);
    assert_eq!(hit(r#"if (!confirm(`Delete skill "${name}"?`)) return;"#), ["confirm("]);
    assert_eq!(
        hit("globalThis.prompt('a'); self.alert('b'); top.confirm('c'); parent.alert('d');"),
        ["globalThis.prompt", "self.alert", "top.confirm", "parent.alert"]
    );
    assert_eq!(
        hit("window?.confirm('x'); window . alert ('y');"),
        ["window.confirm", "window.alert"]
    );
    assert_eq!(
        hit(r#"window['confirm']('x'); window["prompt"]('y');"#),
        [r#"window["confirm"]"#, r#"window["prompt"]"#]
    );
    assert_eq!(
        hit("const ask = window.confirm; (0, window.alert)('x');"),
        ["window.confirm", "window.alert"]
    );
    assert_eq!(
        hit("x = a / b; if (y) confirm('z'); const re = /q/g;"),
        ["confirm("],
        "a division before is not a regular expression"
    );
    assert_eq!(hit("const t = `${confirm('in a template hole')}`;"), ["confirm("]);
}

#[test]
fn catches_them_in_a_pages_inline_scripts_handlers_and_javascript_links() {
    assert_eq!(
        hit_html(r#"<button onclick="return confirm('Delete?')">x</button>"#),
        ["confirm("]
    );
    assert_eq!(hit_html("<script>\n  window.alert('hi');\n</script>"), ["window.alert"]);
    assert_eq!(hit_html(r#"<a href="javascript:prompt(1)">x</a>"#), ["prompt("]);
    assert_eq!(hit_html("<body onload=alert(1)>"), ["alert("]);
}

#[test]
fn leaves_alone_our_own_functions_named_confirm_methods_comments_strings_and_regular_expressions() {
    let none: [&str; 0] = [];
    // A function of its own, inside a setup, called from its form.
    assert_eq!(
        hit(
            "function setup() {\n  form.addEventListener('submit', (e) => { e.preventDefault(); confirm(); });\n  function confirm() { return 1; }\n}"
        ),
        none
    );
    // A const arrow of its own in a method.
    assert_eq!(
        hit(
            "const Live = {\n  async post(item) {\n    const confirm = (id) => id;\n    onDone(() => confirm(item.id));\n  },\n};"
        ),
        none
    );
    assert_eq!(
        hit(
            "ui.confirm = make('button'); this.confirm = null; obj.alert(x); rl.prompt(); TarseeDialog.ask({ title: 'confirm()?' });"
        ),
        none
    );
    assert_eq!(
        hit(
            "class Board { confirm(what) { return what; } async prompt() {} static alert(x) {} get confirmed() { return 1; } }"
        ),
        none
    );
    assert_eq!(hit("const o = { confirm(x) { return x; }, alert: () => 1 };"), none);
    assert_eq!(
        hit(
            "// if (!confirm('old way')) return;\n/* window.alert('no') */\nconst s = \"alert('a string')\", t = 'prompt(1)';"
        ),
        none
    );
    assert_eq!(
        hit("const u = `the words alert(${1}) and confirm( in a template`;"),
        none
    );
    assert_eq!(
        hit(r#"if (/confirm\(|alert\(/.test(src)) x(); s.replace(/prompt\("/g, '');"#),
        none
    );
    assert_eq!(hit("const { confirm } = helpers; confirm('ours');"), none);
    assert_eq!(hit("function ask(confirm) { return confirm('ours'); }"), none);
    assert_eq!(hit("myconfirm('x'); reconfirm('y'); _alert('z'); #prompt;"), none);
    assert_eq!(
        hit_html(
            "<p>Please confirm (twice) or prompt(nothing)</p>\n<!-- <button onclick=\"alert(1)\"> -->\n<script src=\"/js/x.js\"></script>"
        ),
        none
    );
}

#[test]
fn our_own_name_only_counts_where_it_can_be_seen_a_bare_confirm_elsewhere_in_the_file_is_the_browsers() {
    assert_eq!(
        hit("function a() { function confirm() {} confirm(); }\nfunction b() { if (!confirm('sure?')) return; }"),
        ["confirm("]
    );
    assert_eq!(
        hit("const Live = { post() { const confirm = () => 1; confirm(); }, other() { confirm('x'); } };"),
        ["confirm("]
    );
}
