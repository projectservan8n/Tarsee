//! JSON read as JavaScript's `JSON.parse` reads it, for the guards that decide on what a settings or config file
//! holds (`holds_login_key`, `settings_file_guard`).
//!
//! `serde_json` refuses some files `JSON.parse` reads: a lone surrogate escape ("\ud800"), a number beyond f64
//! ("1e400", which JavaScript reads as Infinity) and nesting past 128 levels. A guard that fell back to a text search on
//! those would decide differently from the Node version, in either direction. This reader accepts exactly the JSON
//! grammar `JSON.parse` accepts, at any depth (without recursion), keeps strings as UTF-16 code units (a lone
//! surrogate stays), lets a later duplicate member win as JavaScript does, and keeps only what the guards look at:
//! the top-level object's members and, one level down, a string's text or an object's member names.

use crate::util::js::number_to_string;

/// A JavaScript string: UTF-16 code units, a lone surrogate included.
pub(crate) type JsString = Vec<u16>;

/// A member's value, as far as the guards look at it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Value {
    Str(JsString),
    /// An object (not an array, not null) and its member names, each once, in the order they first appear.
    Object(Vec<JsString>),
    /// Anything else: an array, a number, true, false, null.
    Other,
}

/// The whole document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Document {
    /// A top-level object: its members, each name once at the place it first appeared, with its last value.
    Object(Vec<(JsString, Value)>),
    /// Any other top-level value.
    Other,
}

impl Document {
    /// The member's value (`json[name]`), when the document is an object that has it.
    pub(super) fn member(&self, name: &str) -> Option<&Value> {
        let Document::Object(members) = self else { return None };
        let wanted: JsString = name.encode_utf16().collect();
        members.iter().find(|(n, _)| *n == wanted).map(|(_, v)| v)
    }
}

/// Whether a JavaScript string has anything but whitespace in it (`s.trim() !== ""`).
pub(crate) fn is_blank(text: &[u16]) -> bool {
    text.iter()
        .all(|unit| char::from_u32(u32::from(*unit)).is_some_and(crate::util::js::is_whitespace))
}

/// A JavaScript string as Rust text (a lone surrogate becomes U+FFFD).
pub(crate) fn to_text(text: &[u16]) -> String {
    String::from_utf16_lossy(text)
}

/// `JSON.parse(text)`, as far as the guards need it; `None` where `JSON.parse` throws.
pub(super) fn parse(text: &str) -> Option<Document> {
    let mut p = Parser {
        t: text,
        s: text.as_bytes(),
        i: 0,
    };
    p.ws();
    let document = if p.peek() == Some(b'{') {
        Document::Object(p.top_members()?)
    } else {
        p.skip_value()?;
        Document::Other
    };
    p.ws();
    (p.i == p.s.len()).then_some(document)
}

struct Parser<'a> {
    t: &'a str,
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    /// JSON's whitespace: tab, line feed, carriage return and space only.
    fn ws(&mut self) {
        while matches!(self.peek(), Some(b'\t' | b'\n' | b'\r' | b' ')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, byte: u8) -> Option<()> {
        (self.peek() == Some(byte)).then(|| self.i += 1)
    }

    fn top_members(&mut self) -> Option<Vec<(JsString, Value)>> {
        let mut members: Vec<(JsString, Value)> = Vec::new();
        self.eat(b'{')?;
        self.ws();
        if self.eat(b'}').is_some() {
            return Some(members);
        }
        loop {
            self.ws();
            let name = self.string()?;
            self.ws();
            self.eat(b':')?;
            let value = self.member_value()?;
            match members.iter_mut().find(|(n, _)| *n == name) {
                Some(slot) => slot.1 = value,
                None => members.push((name, value)),
            }
            self.ws();
            if self.eat(b',').is_some() {
                continue;
            }
            self.eat(b'}')?;
            return Some(members);
        }
    }

    fn member_value(&mut self) -> Option<Value> {
        self.ws();
        match self.peek()? {
            b'"' => Some(Value::Str(self.string()?)),
            b'{' => {
                self.i += 1;
                let mut names: Vec<JsString> = Vec::new();
                self.ws();
                if self.eat(b'}').is_some() {
                    return Some(Value::Object(names));
                }
                loop {
                    self.ws();
                    let name = self.string()?;
                    self.ws();
                    self.eat(b':')?;
                    self.skip_value()?;
                    if !names.contains(&name) {
                        names.push(name);
                    }
                    self.ws();
                    if self.eat(b',').is_some() {
                        continue;
                    }
                    self.eat(b'}')?;
                    return Some(Value::Object(names));
                }
            }
            _ => {
                self.skip_value()?;
                Some(Value::Other)
            }
        }
    }

    /// One value of any depth, checked and passed over without recursion.
    fn skip_value(&mut self) -> Option<()> {
        let mut open: Vec<u8> = Vec::new();
        loop {
            // A value is expected here.
            self.ws();
            match self.peek()? {
                b'{' => {
                    self.i += 1;
                    self.ws();
                    if self.eat(b'}').is_none() {
                        open.push(b'{');
                        self.string()?;
                        self.ws();
                        self.eat(b':')?;
                        continue;
                    }
                }
                b'[' => {
                    self.i += 1;
                    self.ws();
                    if self.eat(b']').is_none() {
                        open.push(b'[');
                        continue;
                    }
                }
                b'"' => {
                    self.string()?;
                }
                b't' => self.literal(b"true")?,
                b'f' => self.literal(b"false")?,
                b'n' => self.literal(b"null")?,
                b'-' | b'0'..=b'9' => self.number()?,
                _ => return None,
            }
            // A value is complete: close what it completes, or go on to the next one.
            loop {
                let Some(&container) = open.last() else {
                    return Some(());
                };
                self.ws();
                match self.peek()? {
                    b',' => {
                        self.i += 1;
                        if container == b'{' {
                            self.ws();
                            self.string()?;
                            self.ws();
                            self.eat(b':')?;
                        }
                        break;
                    }
                    b'}' if container == b'{' => {
                        self.i += 1;
                        open.pop();
                    }
                    b']' if container == b'[' => {
                        self.i += 1;
                        open.pop();
                    }
                    _ => return None,
                }
            }
        }
    }

    fn literal(&mut self, word: &[u8]) -> Option<()> {
        self.s[self.i..].starts_with(word).then(|| self.i += word.len())
    }

    /// `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`, of any size (JavaScript reads a huge one as Infinity).
    fn number(&mut self) -> Option<()> {
        self.eat(b'-');
        match self.peek()? {
            b'0' => self.i += 1,
            b'1'..=b'9' => self.digits(),
            _ => return None,
        }
        if self.eat(b'.').is_some() {
            self.peek().filter(u8::is_ascii_digit)?;
            self.digits();
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            self.peek().filter(u8::is_ascii_digit)?;
            self.digits();
        }
        Some(())
    }

    fn digits(&mut self) {
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.i += 1;
        }
    }

    /// A string, decoded to UTF-16 code units. Raw control characters are refused; escapes are JSON's eight and
    /// `\uXXXX`, whose code unit is kept as it is, a lone surrogate included.
    fn string(&mut self) -> Option<JsString> {
        self.eat(b'"')?;
        let mut out: JsString = Vec::new();
        loop {
            let byte = self.peek()?;
            match byte {
                b'"' => {
                    self.i += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.i += 1;
                    let unit = match self.peek()? {
                        b'"' => u16::from(b'"'),
                        b'\\' => u16::from(b'\\'),
                        b'/' => u16::from(b'/'),
                        b'b' => 0x08,
                        b'f' => 0x0C,
                        b'n' => u16::from(b'\n'),
                        b'r' => u16::from(b'\r'),
                        b't' => u16::from(b'\t'),
                        b'u' => {
                            let hex = std::str::from_utf8(self.s.get(self.i + 1..self.i + 5)?).ok()?;
                            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                                return None;
                            }
                            self.i += 4;
                            u16::from_str_radix(hex, 16).ok()?
                        }
                        _ => return None,
                    };
                    self.i += 1;
                    out.push(unit);
                }
                0x00..=0x1F => return None,
                _ => {
                    // One whole character of the text, as its UTF-16 units.
                    let c = self.t.get(self.i..)?.chars().next()?;
                    let mut units = [0u16; 2];
                    out.extend_from_slice(c.encode_utf16(&mut units));
                    self.i += c.len_utf8();
                }
            }
        }
    }
}

// --- The whole document ----------------------------------------------------------------------------------------------
//
// For the files whose values are read, not only their names (package A3): a Codex home's auth.json and
// models_cache.json, a sign-in token's claims, and a Claude Code settings file that is written back without its
// credential entries. The same grammar and the same strings as above, with every value kept.

/// A JSON document as JavaScript holds it after `JSON.parse`: a number is a double (one beyond f64 is an infinity),
/// a string is UTF-16 code units, and an object's members are each there once, at the place the name first appeared,
/// with the last value given for it.
#[derive(Debug, PartialEq)]
pub(crate) enum Json {
    Null,
    Bool(bool),
    Number(f64),
    Str(JsString),
    Array(Vec<Json>),
    Object(Vec<(JsString, Json)>),
}

impl Json {
    /// An object's own member (`json[name]`); `None` for anything that is not an object, or has no such member.
    pub(crate) fn get(&self, name: &str) -> Option<&Json> {
        let Json::Object(members) = self else { return None };
        let wanted: JsString = name.encode_utf16().collect();
        members.iter().find(|(n, _)| *n == wanted).map(|(_, v)| v)
    }

    /// The text of a string (`typeof v === "string"`), a lone surrogate written as U+FFFD.
    pub(crate) fn as_text(&self) -> Option<String> {
        match self {
            Json::Str(units) => Some(to_text(units)),
            _ => None,
        }
    }

    /// The code units of a string.
    pub(crate) fn as_units(&self) -> Option<&[u16]> {
        match self {
            Json::Str(units) => Some(units),
            _ => None,
        }
    }

    pub(crate) fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(items) => Some(items),
            _ => None,
        }
    }

    /// An object that is not an array and not null (`v && typeof v === "object" && !Array.isArray(v)`).
    pub(crate) fn is_object(&self) -> bool {
        matches!(self, Json::Object(_))
    }

    /// JavaScript's truthiness: false for null, false, 0, NaN and "".
    pub(crate) fn truthy(&self) -> bool {
        match self {
            Json::Null => false,
            Json::Bool(b) => *b,
            Json::Number(n) => *n != 0.0 && !n.is_nan(),
            Json::Str(units) => !units.is_empty(),
            Json::Array(_) | Json::Object(_) => true,
        }
    }

    /// Moves this value's children into `into`, leaving it with none.
    fn take_children(&mut self, into: &mut Vec<Json>) {
        match self {
            Json::Array(items) => into.append(items),
            Json::Object(members) => into.extend(members.drain(..).map(|(_, value)| value)),
            _ => {}
        }
    }
}

impl Drop for Json {
    /// Without recursion: a document may be nested as deep as its text is long.
    fn drop(&mut self) {
        let mut pending = Vec::new();
        self.take_children(&mut pending);
        while let Some(mut child) = pending.pop() {
            child.take_children(&mut pending);
        }
    }
}

/// An array or object still being read.
enum Open {
    Array(Vec<Json>),
    /// The members so far, where each name is among them, and the name whose value comes next.
    Object(
        Vec<(JsString, Json)>,
        std::collections::HashMap<JsString, usize>,
        JsString,
    ),
}

/// `JSON.parse(text)`, whole; `None` where `JSON.parse` throws. Reads any depth without recursion.
pub(crate) fn parse_document(text: &str) -> Option<Json> {
    let mut p = Parser {
        t: text,
        s: text.as_bytes(),
        i: 0,
    };
    let document = p.document()?;
    p.ws();
    (p.i == p.s.len()).then_some(document)
}

impl Parser<'_> {
    fn document(&mut self) -> Option<Json> {
        let mut open: Vec<Open> = Vec::new();
        loop {
            // A value is expected here.
            self.ws();
            let mut value = match self.peek()? {
                b'{' => {
                    self.i += 1;
                    self.ws();
                    if self.eat(b'}').is_some() {
                        Json::Object(Vec::new())
                    } else {
                        let name = self.string()?;
                        self.ws();
                        self.eat(b':')?;
                        open.push(Open::Object(Vec::new(), std::collections::HashMap::new(), name));
                        continue;
                    }
                }
                b'[' => {
                    self.i += 1;
                    self.ws();
                    if self.eat(b']').is_some() {
                        Json::Array(Vec::new())
                    } else {
                        open.push(Open::Array(Vec::new()));
                        continue;
                    }
                }
                b'"' => Json::Str(self.string()?),
                b't' => {
                    self.literal(b"true")?;
                    Json::Bool(true)
                }
                b'f' => {
                    self.literal(b"false")?;
                    Json::Bool(false)
                }
                b'n' => {
                    self.literal(b"null")?;
                    Json::Null
                }
                b'-' | b'0'..=b'9' => {
                    let start = self.i;
                    self.number()?;
                    // Rust reads a decimal as JavaScript does: to the nearest double, an infinity past the largest.
                    Json::Number(self.t.get(start..self.i)?.parse().ok()?)
                }
                _ => return None,
            };
            // A value is complete: put it where it belongs, closing what it completes.
            loop {
                let Some(container) = open.last_mut() else {
                    return Some(value);
                };
                match container {
                    Open::Array(items) => items.push(value),
                    Open::Object(members, places, name) => {
                        let name = std::mem::take(name);
                        match places.get(&name) {
                            Some(&at) => members[at].1 = value,
                            None => {
                                places.insert(name.clone(), members.len());
                                members.push((name, value));
                            }
                        }
                    }
                }
                self.ws();
                let next = self.peek()?;
                self.i += 1;
                match (container, next) {
                    (Open::Array(_), b',') => break,
                    (Open::Object(_, _, name), b',') => {
                        self.ws();
                        *name = self.string()?;
                        self.ws();
                        self.eat(b':')?;
                        break;
                    }
                    (Open::Array(_), b']') | (Open::Object(..), b'}') => {
                        value = match open.pop()? {
                            Open::Array(items) => Json::Array(items),
                            Open::Object(members, _, _) => Json::Object(members),
                        };
                    }
                    _ => return None,
                }
            }
        }
    }
}

/// Whether a member's name is an array index ("0", "7", "42": a whole number below 2^32 - 1 written plainly), which
/// a JavaScript object keeps before its other members, in number order.
fn array_index(name: &[u16]) -> Option<u32> {
    let digits: Option<String> = name
        .iter()
        .map(|unit| u8::try_from(*unit).ok().filter(u8::is_ascii_digit).map(char::from))
        .collect();
    let digits = digits.filter(|d| !d.is_empty() && (d == "0" || !d.starts_with('0')))?;
    digits.parse::<u32>().ok().filter(|n| *n < u32::MAX)
}

/// An object's members in the order JavaScript walks them (`Object.keys`, `JSON.stringify`): array indexes first,
/// ascending, then the rest as they were first written.
pub(crate) fn members_in_js_order(members: &[(JsString, Json)]) -> Vec<&(JsString, Json)> {
    let mut indexed: Vec<(u32, &(JsString, Json))> = members
        .iter()
        .filter_map(|member| Some((array_index(&member.0)?, member)))
        .collect();
    indexed.sort_by_key(|(index, _)| *index);
    indexed
        .into_iter()
        .map(|(_, member)| member)
        .chain(members.iter().filter(|member| array_index(&member.0).is_none()))
        .collect()
}

/// A string as `JSON.stringify` quotes it: `"` and `\` escaped, control characters as their short escape or
/// `\u00xx`, a lone surrogate as `\udxxx`, everything else as it is.
fn quote(units: &[u16], out: &mut String) {
    out.push('"');
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{C}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if u32::from(c) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            Ok(c) => out.push(c),
            Err(lone) => out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate())),
        }
    }
    out.push('"');
}

/// The deepest nesting [`stringify_pretty`] writes. Node's own `JSON.stringify` runs out of stack a little further
/// down (some 1,700 objects deep on Node 22), and the caller then fails the same way.
pub(crate) const MAX_STRINGIFY_DEPTH: usize = 1_700;

/// `JSON.stringify(value, null, 2)`: numbers as JavaScript writes them (1.0 is "1", an infinity is "null"), each
/// object's members in JavaScript's order. `None` where JavaScript throws "Maximum call stack size exceeded" (a
/// document nested past [`MAX_STRINGIFY_DEPTH`]).
pub(crate) fn stringify_pretty(value: &Json) -> Option<String> {
    /// A container being written: its members still to come (an array's have no names), and how it closes.
    struct Level<'a> {
        members: std::vec::IntoIter<(Option<&'a JsString>, &'a Json)>,
        written: usize,
        close: char,
    }
    let mut out = String::new();
    let mut levels: Vec<Level<'_>> = Vec::new();
    let mut next: Option<&Json> = Some(value);
    loop {
        if let Some(value) = next.take() {
            let members: Vec<(Option<&JsString>, &Json)> = match value {
                Json::Array(items) => items.iter().map(|item| (None, item)).collect(),
                Json::Object(members) => members_in_js_order(members)
                    .into_iter()
                    .map(|(name, item)| (Some(name), item))
                    .collect(),
                _ => Vec::new(),
            };
            match value {
                Json::Null => out.push_str("null"),
                Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
                Json::Number(n) if n.is_finite() => out.push_str(&number_to_string(*n)),
                Json::Number(_) => out.push_str("null"),
                Json::Str(units) => quote(units, &mut out),
                Json::Array(_) if members.is_empty() => out.push_str("[]"),
                Json::Object(_) if members.is_empty() => out.push_str("{}"),
                Json::Array(_) | Json::Object(_) => {
                    if levels.len() >= MAX_STRINGIFY_DEPTH {
                        return None;
                    }
                    let is_array = matches!(value, Json::Array(_));
                    out.push(if is_array { '[' } else { '{' });
                    levels.push(Level {
                        members: members.into_iter(),
                        written: 0,
                        close: if is_array { ']' } else { '}' },
                    });
                }
            }
        }
        // The next member of the innermost container, or its end.
        let depth = levels.len();
        let Some(level) = levels.last_mut() else {
            return Some(out);
        };
        match level.members.next() {
            Some((name, item)) => {
                if level.written > 0 {
                    out.push(',');
                }
                level.written += 1;
                out.push('\n');
                out.push_str(&"  ".repeat(depth));
                if let Some(name) = name {
                    quote(name, &mut out);
                    out.push_str(": ");
                }
                next = Some(item);
            }
            None => {
                let close = level.close;
                levels.pop();
                out.push('\n');
                out.push_str(&"  ".repeat(depth - 1));
                out.push(close);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn js(text: &str) -> JsString {
        text.encode_utf16().collect()
    }

    #[test]
    fn it_reads_what_json_parse_reads_and_serde_refuses() {
        let lone = parse(r#"{"x":"\ud800","primary\u0041piKey":"sk-k"}"#).unwrap();
        assert_eq!(lone.member("primaryApiKey"), Some(&Value::Str(js("sk-k"))));
        assert_eq!(lone.member("x"), Some(&Value::Str(vec![0xD800])));
        assert!(parse(r#"{"x":1e400,"y":-1e-999,"z":0.5E+3}"#).is_some());
        let deep = format!("{{\"a\":{}1{}}}", "[".repeat(100_000), "]".repeat(100_000));
        assert_eq!(parse(&deep).unwrap().member("a"), Some(&Value::Other));
    }

    #[test]
    fn a_later_duplicate_wins_in_the_first_ones_place_and_an_objects_names_are_listed_once() {
        let doc = parse(r#"{"a":"1","env":{"B":1,"A":2,"B":3},"a":"2","env2":[]}"#).unwrap();
        let Document::Object(members) = &doc else { panic!() };
        let names: Vec<String> = members.iter().map(|(n, _)| to_text(n)).collect();
        assert_eq!(names, ["a", "env", "env2"]);
        assert_eq!(doc.member("a"), Some(&Value::Str(js("2"))));
        assert_eq!(doc.member("env"), Some(&Value::Object(vec![js("B"), js("A")])));
        assert_eq!(doc.member("env2"), Some(&Value::Other));
        assert_eq!(parse("[1,{\"a\":2}]"), Some(Document::Other));
        assert_eq!(parse(" null "), Some(Document::Other));
    }

    #[test]
    fn it_refuses_what_json_parse_refuses() {
        for bad in [
            "",
            "{",
            "{\"a\":1,}",
            "[1,]",
            "{\"a\" 1}",
            "{'a':1}",
            "{\"a\":01}",
            "{\"a\":1.}",
            "{\"a\":.5}",
            "{\"a\":+1}",
            "{\"a\":1e}",
            "{\"a\":\"\t\"}",
            "{\"a\":\"\\x\"}",
            "{\"a\":\"\\u12g4\"}",
            "{\"a\":tru}",
            "{\"a\":NaN}",
            "{\"a\":Infinity}",
            "{} x",
            "\u{FEFF}{}",
            "{\"a\":1}\u{A0}",
            "// c\n{}",
        ] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
        assert!(parse(" \t\r\n{ \"a\" : [ ] , \"b\" : { } } \n").is_some());
    }

    #[test]
    fn blank_is_javascripts_trim_on_code_units() {
        assert!(is_blank(&js(" \u{FEFF}\u{3000}\t")));
        assert!(is_blank(&[]));
        assert!(!is_blank(&js("\u{85}")));
        assert!(!is_blank(&[0xD800]));
        assert!(!is_blank(&js(" k ")));
    }

    // --- The whole document ---

    #[test]
    fn the_whole_document_is_read_with_every_value_as_javascript_holds_it() {
        let doc = parse_document(
            r#" {"s":"a\u00e9\ud83d\udc12","half":"\ud800x","n":-1.5e2,"huge":1e400,"neg":-1e999,"zero":-0,
                 "t":true,"f":false,"z":null,"list":[1,"two",[],{}],"o":{"k":"v"},"s":"again"} "#,
        )
        .unwrap();
        assert_eq!(
            doc.get("s").unwrap().as_text().as_deref(),
            Some("again"),
            "a later duplicate wins"
        );
        assert_eq!(
            doc.get("half").unwrap().as_units(),
            Some(&[0xD800, u16::from(b'x')][..])
        );
        assert_eq!(doc.get("half").unwrap().as_text().as_deref(), Some("\u{FFFD}x"));
        assert_eq!(doc.get("n"), Some(&Json::Number(-150.0)));
        assert_eq!(doc.get("huge"), Some(&Json::Number(f64::INFINITY)));
        assert_eq!(doc.get("neg"), Some(&Json::Number(f64::NEG_INFINITY)));
        assert!(matches!(doc.get("zero"), Some(Json::Number(z)) if *z == 0.0 && z.is_sign_negative()));
        assert_eq!(doc.get("t"), Some(&Json::Bool(true)));
        assert_eq!(doc.get("z"), Some(&Json::Null));
        assert_eq!(doc.get("list").unwrap().as_array().unwrap().len(), 4);
        assert_eq!(doc.get("o").unwrap().get("k").unwrap().as_text().as_deref(), Some("v"));
        assert!(doc.get("o").unwrap().is_object() && !doc.get("list").unwrap().is_object());
        assert_eq!(doc.get("missing"), None);
        assert_eq!(
            doc.get("list").unwrap().get("0"),
            None,
            "an array has no members by name here"
        );
        // The first place of a name is kept, with its last value.
        let Json::Object(members) = &doc else { panic!() };
        assert_eq!(to_text(&members[0].0), "s");
        // Not an object at the top: any value.
        assert_eq!(parse_document("[1]"), Some(Json::Array(vec![Json::Number(1.0)])));
        assert_eq!(parse_document(" \"x\" "), Some(Json::Str(js("x"))));
        assert_eq!(parse_document("null"), Some(Json::Null));
    }

    #[test]
    fn the_whole_document_reader_refuses_what_json_parse_refuses_and_agrees_with_the_shallow_one() {
        for bad in [
            "",
            "{",
            "{\"a\":1,}",
            "[1,]",
            "[1 2]",
            "{\"a\" 1}",
            "{'a':1}",
            "{\"a\":01}",
            "{\"a\":1.}",
            "{\"a\":.5}",
            "{\"a\":+1}",
            "{\"a\":1e}",
            "{\"a\":\"\t\"}",
            "{\"a\":\"\\x\"}",
            "{\"a\":\"\\u12g4\"}",
            "{\"a\":tru}",
            "{\"a\":NaN}",
            "{\"a\":Infinity}",
            "{} x",
            "\u{FEFF}{}",
            "{\"a\":1}\u{A0}",
            "// c\n{}",
            "[}",
            "{]",
            "{\"a\":[}",
            "[{\"a\":1]",
            "1 2",
            "-",
            "\"open",
        ] {
            assert_eq!(parse_document(bad), None, "{bad:?}");
            assert_eq!(parse(bad), None, "{bad:?}");
        }
        for good in [
            " \t\r\n{ \"a\" : [ ] , \"b\" : { } } \n",
            "0",
            "-0.0e-0",
            "[[],[[]],{\"a\":{\"b\":[null]}}]",
            "\"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u0041\"",
        ] {
            assert!(parse_document(good).is_some(), "{good:?}");
            assert!(parse(good).is_some(), "{good:?}");
        }
    }

    #[test]
    fn truthiness_is_javascripts() {
        let truthy = |text: &str| parse_document(text).unwrap().truthy();
        for yes in ["true", "1", "-1", "1e400", "\"0\"", "\" \"", "[]", "{}"] {
            assert!(truthy(yes), "{yes}");
        }
        for no in ["false", "null", "0", "-0", "0.0", "\"\""] {
            assert!(!truthy(no), "{no}");
        }
    }

    #[test]
    fn a_document_of_any_depth_is_read_and_dropped_without_running_out_of_stack() {
        let depth = 300_000;
        let arrays = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        let objects = format!("{}1{}", "{\"a\":".repeat(depth), "}".repeat(depth));
        for text in [arrays, objects] {
            let doc = parse_document(&text).expect("read");
            assert!(doc.truthy());
            assert_eq!(stringify_pretty(&doc), None, "too deep to write, as in JavaScript");
            drop(doc);
        }
        // A deep value that a later duplicate replaces is dropped the same way.
        let replaced = format!("{{\"a\":{}{},\"a\":1}}", "[".repeat(depth), "]".repeat(depth));
        assert_eq!(parse_document(&replaced).unwrap().get("a"), Some(&Json::Number(1.0)));
        // The deepest that is written, and one more.
        let nested = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
        assert!(stringify_pretty(&parse_document(&nested(MAX_STRINGIFY_DEPTH + 1)).unwrap()).is_some());
        assert!(stringify_pretty(&parse_document(&nested(MAX_STRINGIFY_DEPTH + 2)).unwrap()).is_none());
    }

    #[test]
    fn it_is_written_as_json_stringify_with_two_spaces_writes_it() {
        // Node: JSON.stringify(JSON.parse(text), null, 2) for each text.
        let cases = [
            ("{}", "{}"),
            ("[]", "[]"),
            ("[[],{}]", "[\n  [],\n  {}\n]"),
            (
                "\"a\\\"\\\\\\/\\b\\f\\n\\r\\t\\u0001\\u001f\\u007f\"",
                "\"a\\\"\\\\/\\b\\f\\n\\r\\t\\u0001\\u001f\u{7f}\"",
            ),
            ("\"\\ud83d\\udc12 \\udc12 \\ud83d\"", "\"\u{1F412} \\udc12 \\ud83d\""),
            (
                "[1.0,1e21,1e-7,0.1,-0,1e400,123456789012345678901234567890,5e-324]",
                "[\n  1,\n  1e+21,\n  1e-7,\n  0.1,\n  0,\n  null,\n  1.2345678901234568e+29,\n  5e-324\n]",
            ),
            (
                "{\"b\":1,\"2\":2,\"a\":{\"10\":1,\"9\":2,\"01\":3,\"4294967295\":4,\"4294967294\":5},\"1\":[true,false,null]}",
                "{\n  \"1\": [\n    true,\n    false,\n    null\n  ],\n  \"2\": 2,\n  \"b\": 1,\n  \"a\": {\n    \"9\": 2,\n    \"10\": 1,\n    \"4294967294\": 5,\n    \"01\": 3,\n    \"4294967295\": 4\n  }\n}",
            ),
            ("{\"a\":1,\"b\":2,\"a\":3}", "{\n  \"a\": 3,\n  \"b\": 2\n}"),
            (
                "{\"\\u2028\":\"\\u2029\",\"é\":\"\\u00e9\"}",
                "{\n  \"\u{2028}\": \"\u{2029}\",\n  \"é\": \"é\"\n}",
            ),
        ];
        for (text, want) in cases {
            let doc = parse_document(text).unwrap_or_else(|| panic!("{text} is JSON"));
            assert_eq!(stringify_pretty(&doc).as_deref(), Some(want), "{text}");
        }
    }
}
