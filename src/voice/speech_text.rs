//! Port of `src/voice/speech-text.js`: text cleanup for the Phonon TTS engine.
//!
//! clean_speech_text: the same cleanup Edge TTS and Piper do before speaking: drop emoji, code, markdown links and
//! marks, and fold newlines into pauses.
//!
//! speak_pesos: Phonon's own text normalizer spells out dollars ("$5" becomes "5 dollars") but passes the peso sign
//! through untouched, and the model then garbles the amount. "PHP 2,500" fares no better: it is read letter by
//! letter before the number. Writing the currency out as a word first ("2,500 pesos") lets the normalizer read the
//! number properly.
//!
//! The JavaScript regexes are matched exactly: `\s` is JavaScript's whitespace ([`JS_SPACE`], which has U+FEFF and
//! not U+0085), `\d` and `\b` are ASCII, and `trim()` removes the same characters as `\s`.

use std::borrow::Cow;
use std::sync::LazyLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;

/// The characters JavaScript's `\s` matches and `trim()` removes, for use inside a character class.
pub const JS_SPACE: &str =
    "\t\n\u{0B}\u{0C}\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

/// Whether JavaScript counts `c` as whitespace (`\s`, `trim()`, `parseInt`): `util::js::is_whitespace`, kept under
/// this name for the code that already calls it.
pub fn is_js_space(c: char) -> bool {
    crate::util::js::is_whitespace(c)
}

/// `text.trim()`: `util::js::trim`, kept under this name for the code that already calls it.
pub fn js_trim(text: &str) -> &str {
    crate::util::js::trim(text)
}

// The same emoji class as edge-tts-engine.js. The ZWJ and variation selectors are bare members on purpose: this
// deletes every codepoint of a sequence rather than matching the sequence as one grapheme.
static EMOJI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"[\x{1F600}-\x{1F64F}\x{1F300}-\x{1F5FF}\x{1F680}-\x{1F6FF}\x{1F1E0}-\x{1F1FF}\x{2600}-\x{27BF}\x{FE00}-\x{FE0F}\x{1F900}-\x{1F9FF}\x{1FA00}-\x{1FA6F}\x{1FA70}-\x{1FAFF}\x{2702}-\x{27B0}\x{200D}\x{20E3}\x{FE0F}]",
    )
    .expect("the emoji pattern")
});
static SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("[{JS_SPACE}]{{2,}}")).expect("the spaces pattern"));
static CODE_BLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"```[\s\S]*?```").expect("the code block pattern"));
static INLINE_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`]+`").expect("the inline code pattern"));
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]+)\]\([^)]+\)").expect("the link pattern"));
static MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[*_~#>]").expect("the marks pattern"));
static PARAGRAPH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{2,}").expect("the paragraph pattern"));

/// Drops every emoji codepoint.
pub fn strip_emoji(text: &str) -> String {
    EMOJI.replace_all(text, "").into_owned()
}

/// Runs of two or more whitespace characters become one space (`.replace(/\s{2,}/g, " ")`).
pub fn collapse_spaces(text: &str) -> String {
    SPACES.replace_all(text, " ").into_owned()
}

/// The markdown half of the cleanup: code blocks and inline code go, links keep their text, marks go, paragraph
/// breaks become a pause, newlines a space, then spaces are collapsed and the ends trimmed.
pub fn strip_markdown(text: &str) -> String {
    let text = CODE_BLOCK.replace_all(text, "");
    let text = INLINE_CODE.replace_all(&text, "");
    let text = LINK.replace_all(&text, "$1");
    let text = MARKS.replace_all(&text, "");
    let text = PARAGRAPH.replace_all(&text, ". ");
    let text = text.replace('\n', " ");
    let text = SPACES.replace_all(&text, " ");
    js_trim(&text).to_string()
}

/// Text as Edge TTS, Piper and Phonon speak it: no emoji, no code, no markdown, newlines folded into pauses.
pub fn clean_speech_text(text: &str) -> String {
    strip_markdown(&strip_emoji(text))
}

// An amount that is never cut short ("12,500" is never read as "12"), then an optional scale word, then the word
// "pesos" when the writer already put it (it is swallowed so it is not said twice).
const AMOUNT: &str = r"([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)(?![0-9]|[.,][0-9])";
// `\b` after a word: the next character is not an ASCII word character.
const WORD_END: &str = r"(?![A-Za-z0-9_])";
// `\b` before a word: the previous character is not an ASCII word character.
const WORD_START: &str = r"(?<![A-Za-z0-9_])";

fn tail() -> String {
    format!("(?:[{JS_SPACE}]?(k|K|M|B|thousand|million|billion){WORD_END})?([{JS_SPACE}]*(?:pesos?|PHP){WORD_END})?")
}

static PESO_SIGN: LazyLock<FancyRegex> =
    LazyLock::new(|| FancyRegex::new(&format!("₱[{JS_SPACE}]?{AMOUNT}{}", tail())).expect("the peso sign pattern"));
static PESO_CODE: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!("{WORD_START}(?:PHP|Php|php)[{JS_SPACE}]?{AMOUNT}{}", tail())).expect("the PHP pattern")
});
// A bare "P" only when it is clearly money: thousands commas or two decimals ("P2,500", "P99.50"). Still opt-in,
// because "P" has other meanings.
static PESO_P: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!(
        r"{WORD_START}P([0-9]{{1,3}}(?:,[0-9]{{3}})+(?:\.[0-9]+)?|[0-9]+\.[0-9]{{2}})(?![0-9]|[.,][0-9]){}",
        tail()
    ))
    .expect("the bare P pattern")
});

// "PHP 8.3" is far more often the programming language than eight pesos: a one-digit amount with at most one
// decimal and no scale or "pesos" after it is left alone.
static LOOKS_LIKE_VERSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9](?:\.[0-9])?$").expect("the version pattern"));

fn peso_words(amount: &str, scale: Option<&str>) -> String {
    let scale = match scale {
        Some("k" | "K") => " thousand".to_string(),
        Some("M") => " million".to_string(),
        Some("B") => " billion".to_string(),
        Some(word) if !word.is_empty() => format!(" {word}"),
        _ => String::new(),
    };
    format!("{amount}{scale} pesos")
}

/// `text.replace(re, fn)`; a regex that gives up (it never should on these patterns) leaves the text as it is.
fn replace_with(re: &FancyRegex, text: &str, f: impl FnMut(&fancy_regex::Captures<'_, str>) -> String) -> String {
    match re.try_replacen(text, 0, f) {
        Ok(Cow::Borrowed(_)) => text.to_string(),
        Ok(Cow::Owned(out)) => out,
        Err(_) => text.to_string(),
    }
}

/// Options for [`speak_pesos`] and [`phonon_speech_text`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PesoOptions {
    /// Also read "P2,500" and "P99.50" as pesos.
    pub bare_peso: bool,
}

/// "₱12,500", "PHP 2,500" and "Php1.5M" become "12,500 pesos", "2,500 pesos" and "1.5 million pesos". With
/// `bare_peso`, "P2,500" and "P99.50" do too.
pub fn speak_pesos(text: &str, opts: PesoOptions) -> String {
    let group = |caps: &fancy_regex::Captures<'_, str>, i: usize| caps.get(i).map(|m| m.as_str().to_string());
    let out = replace_with(&PESO_SIGN, text, |caps| {
        peso_words(&group(caps, 1).unwrap_or_default(), group(caps, 2).as_deref())
    });
    let out = replace_with(&PESO_CODE, &out, |caps| {
        let amount = group(caps, 1).unwrap_or_default();
        let scale = group(caps, 2);
        let word = group(caps, 3);
        let empty = |v: &Option<String>| v.as_deref().is_none_or(str::is_empty);
        if empty(&scale) && empty(&word) && LOOKS_LIKE_VERSION.is_match(&amount) {
            group(caps, 0).unwrap_or_default()
        } else {
            peso_words(&amount, scale.as_deref())
        }
    });
    if opts.bare_peso {
        replace_with(&PESO_P, &out, |caps| {
            peso_words(&group(caps, 1).unwrap_or_default(), group(caps, 2).as_deref())
        })
    } else {
        out
    }
}

/// Text as Phonon should receive it. `bare_peso`: also read "P2,500" as pesos.
pub fn phonon_speech_text(text: &str, opts: PesoOptions) -> String {
    speak_pesos(&clean_speech_text(text), opts)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every expected value here is what the Node code gave for the same input.

    #[test]
    fn clean_speech_text_matches_node() {
        for (input, want) in [
            ("", ""),
            ("Hello 😀 world 👍🏽!", "Hello world !"),
            ("**bold** and _it_ ~x~ # head > quote", "bold and it x head quote"),
            ("a\n\nb\nc", "a. b c"),
            ("see [the docs](http://x.y) now", "see the docs now"),
            ("code ```js\nlet x = 1;\n``` after `inline` end", "code after end"),
            ("  spaced \u{a0} out\u{feff} ", "spaced out"),
            ("family 👨‍👩‍👧 flag 🇵🇭 keycap 1️⃣", "family flag keycap 1"),
            ("\u{85}nel\u{85}", "\u{85}nel\u{85}"),
            ("a\u{2028}b", "a\u{2028}b"),
            ("x\u{3000}\u{3000}y", "x y"),
            ("\u{a0}\u{a0}", ""),
            ("a\u{0b}b", "a\u{0b}b"),
            ("x\r\n\r\ny", "x y"),
            ("ok ✂ ✈ ☀ done", "ok done"),
            ("[a](b) [c] (d)", "a [c] (d)"),
            ("tab\t\tx", "tab x"),
        ] {
            assert_eq!(clean_speech_text(input), want, "{input:?}");
        }
    }

    #[test]
    fn speak_pesos_matches_node() {
        // (input, without bare P, with bare P)
        for (input, plain, bare) in [
            ("₱12,500", "12,500 pesos", "12,500 pesos"),
            ("₱ 5", "5 pesos", "5 pesos"),
            ("₱1.5M pesos", "1.5 million pesos", "1.5 million pesos"),
            ("PHP 2,500", "2,500 pesos", "2,500 pesos"),
            ("Php1.5M", "1.5 million pesos", "1.5 million pesos"),
            ("php 8", "php 8", "php 8"),
            ("PHP 8.3", "PHP 8.3", "PHP 8.3"),
            ("PHP 8.3 pesos", "8.3 pesos", "8.3 pesos"),
            ("PHP 8k", "8 thousand pesos", "8 thousand pesos"),
            ("PHP 12", "12 pesos", "12 pesos"),
            ("P2,500 and P99.50", "P2,500 and P99.50", "2,500 pesos and 99.50 pesos"),
            ("P5", "P5", "P5"),
            ("P2,500k", "P2,500k", "2,500 thousand pesos"),
            ("₱12,5", "₱12,5", "₱12,5"),
            (
                "₱1,234,567.89 thousand",
                "1,234,567.89 thousand pesos",
                "1,234,567.89 thousand pesos",
            ),
            ("₱100 peso", "100 pesos", "100 pesos"),
            ("HTTP 404", "HTTP 404", "HTTP 404"),
            ("xPHP 5", "xPHP 5", "xPHP 5"),
            ("₱12.", "12 pesos.", "12 pesos."),
            ("₱3,000.5,1", "₱3,000.5,1", "₱3,000.5,1"),
            ("PHP10 PHP", "10 pesos", "10 pesos"),
            ("₱5B", "5 billion pesos", "5 billion pesos"),
            ("₱5 billion", "5 billion pesos", "5 billion pesos"),
            ("₱5billion", "5 billion pesos", "5 billion pesos"),
            ("₱5 K", "5 thousand pesos", "5 thousand pesos"),
            ("P1,000 pesos", "P1,000 pesos", "1,000 pesos"),
            ("₱1,00", "₱1,00", "₱1,00"),
            ("₱12,500,", "12,500 pesos,", "12,500 pesos,"),
            ("AP2,500", "AP2,500", "AP2,500"),
            ("₱\u{a0}5", "5 pesos", "5 pesos"),
        ] {
            assert_eq!(speak_pesos(input, PesoOptions::default()), plain, "{input:?}");
            assert_eq!(
                speak_pesos(input, PesoOptions { bare_peso: true }),
                bare,
                "{input:?} (bare P)"
            );
        }
    }

    #[test]
    fn phonon_text_is_cleaned_then_given_pesos() {
        let text = "**₱5** 😀\n\nP2,500";
        assert_eq!(phonon_speech_text(text, PesoOptions::default()), "5 pesos . P2,500");
        assert_eq!(
            phonon_speech_text(text, PesoOptions { bare_peso: true }),
            "5 pesos . 2,500 pesos"
        );
    }

    #[test]
    fn trim_and_collapse_use_javascript_whitespace() {
        assert_eq!(js_trim("\u{feff} a \u{a0}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
        assert_eq!(collapse_spaces("a \t b\u{2028}c"), "a b\u{2028}c");
        assert_eq!(strip_emoji("hi 🐒!"), "hi !");
        // The regex class says the same as the foundation's whitespace, character by character.
        let class = Regex::new(&format!("^[{JS_SPACE}]$")).unwrap();
        for c in (0u32..0x1_0000).filter_map(char::from_u32) {
            assert_eq!(class.is_match(&c.to_string()), is_js_space(c), "U+{:04X}", c as u32);
        }
    }
}
