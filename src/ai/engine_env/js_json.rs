//! JSON read as JavaScript's `JSON.parse` reads it, for the guards that decide on what a settings or config file
//! holds (`holds_login_key`, `settings_file_guard`).
//!
//! `serde_json` refuses some files `JSON.parse` reads: a lone surrogate escape ("\ud800"), a number beyond f64
//! ("1e400", which JavaScript reads as Infinity) and nesting past 128 levels. A guard that fell back to a text search on
//! those would decide differently from the Node version, in either direction. This reader accepts exactly the JSON
//! grammar `JSON.parse` accepts, at any depth (without recursion), keeps strings as UTF-16 code units (a lone
//! surrogate stays), lets a later duplicate member win as JavaScript does, and keeps only what the guards look at:
//! the top-level object's members and, one level down, a string's text or an object's member names.

/// A JavaScript string: UTF-16 code units, a lone surrogate included.
pub(super) type JsString = Vec<u16>;

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
pub(super) fn is_blank(text: &[u16]) -> bool {
    text.iter()
        .all(|unit| char::from_u32(u32::from(*unit)).is_some_and(crate::util::js::is_whitespace))
}

/// A JavaScript string as Rust text (a lone surrogate becomes U+FFFD).
pub(super) fn to_text(text: &[u16]) -> String {
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
}
