//! Port of `src/lib/slack-format.js`: text going in and out of Slack.
//!
//! In: Slack sends message text in its own markup (`<@U123>`, `<#C1|general>`, `<https://x|label>`, `&amp;`). The
//! agent reads plain words, so [`slack_text_to_plain`] unwraps it.
//!
//! Out: Slack draws standard markdown itself now (the `markdown_text` field on chat.postMessage / chat.update and the
//! markdown chunks of chat.startStream, tables and code fences included, since 2026-03). So unlike discord_format.rs
//! nothing is redrawn: the answer goes out as the model wrote it, minus Tarsee's own markers.

use std::sync::LazyLock;

use regex::{Captures, Regex};

use crate::lib::discord_format::js_text::{self, re};
use crate::lib::discord_format::split_message_fence_safe;
use crate::lib::reaction_parser::parse_reactions;
use crate::util::js::{trim, utf16_len};

/// Most markdown one message or stream takes: Slack's cap is 12,000; the rest is room for a closing fence.
pub const SLACK_MAX_MARKDOWN: usize = 11_000;

/// The private-use character that stands for the bot's own mention while the spacing around it is tidied.
const PLACEHOLDER: char = '\u{E000}';

static USER_MENTION: LazyLock<Regex> = LazyLock::new(|| re(r"<@([UW][A-Z0-9]+)(?:\|[^>]*)?>"));
static CHANNEL_LINK: LazyLock<Regex> = LazyLock::new(|| re(r"<#([CG][A-Z0-9]+)(?:\|([^>]*))?>"));
static SUBTEAM: LazyLock<Regex> = LazyLock::new(|| re(r"<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>"));
static SPECIAL_MENTION: LazyLock<Regex> = LazyLock::new(|| re(r"<!(here|channel|everyone)(?:\|[^>]*)?>"));
static LINK: LazyLock<Regex> = LazyLock::new(|| re(r"<((?:https?|mailto):[^|>]+)(?:\|([^>]*))?>"));
static MAILTO: LazyLock<Regex> = LazyLock::new(|| re(r"^mailto:"));

/// A person's name from their user id, or `None` (their id is shown then).
pub type UserName<'a> = &'a dyn Fn(&str) -> Option<String>;

/// Who is who, for [`slack_text_to_plain`].
#[derive(Default, Clone, Copy)]
pub struct PlainOptions<'a> {
    /// The bot's own user id: its mention is taken out.
    pub bot_user_id: Option<&'a str>,
    pub user_name: Option<UserName<'a>>,
}

/// The JS `.replace(/+(?=[,.!?;:])/g, "")`: a run of placeholders right before punctuation goes.
fn drop_before_punctuation(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != PLACEHOLDER {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && chars[i] == PLACEHOLDER {
            i += 1;
        }
        if !chars.get(i).is_some_and(|c| ",.!?;:".contains(*c)) {
            out.extend(&chars[start..i]);
        }
    }
    out
}

/// The JS `.replace(/^+|+$/gm, "")`: a run of placeholders at the start or end of a line goes. Lines end
/// where JavaScript's `m` flag ends them (`\n`, `\r`, U+2028, U+2029).
fn drop_at_line_ends(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != PLACEHOLDER {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && chars[i] == PLACEHOLDER {
            i += 1;
        }
        let at_start = start == 0 || js_text::is_line_terminator(chars[start - 1]);
        let at_end = i == chars.len() || js_text::is_line_terminator(chars[i]);
        if !at_start && !at_end {
            out.extend(&chars[start..i]);
        }
    }
    out
}

/// Slack message text → plain words the agent can read.
pub fn slack_text_to_plain(text: &str, opts: PlainOptions<'_>) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut s = text.to_string();
    // The bot's own mention goes, and only the spacing around it is tidied: everything else keeps its spacing
    // exactly, since people paste code (indentation, `./path`, `a ? b : c`) and that must reach the agent unchanged.
    // The id goes into the pattern as it is, as in the Node code (Slack ids are capital letters and digits). An id
    // that makes no pattern at all made the Node code throw; here the mention is then left in.
    let own = opts
        .bot_user_id
        .filter(|b| !b.is_empty())
        .and_then(|bot| Regex::new(&js_text::translate(&format!(r"[ \t]*<@{bot}(?:\|[^>]*)?>[ \t]*"))).ok());
    if let Some(own) = own {
        s = own.replace_all(&s, PLACEHOLDER.to_string().as_str()).into_owned();
        s = drop_before_punctuation(&s);
        s = drop_at_line_ends(&s);
        let run = Regex::new("\u{E000}+").expect("the placeholder pattern");
        s = run.replace_all(&s, " ").into_owned();
    }
    let s = USER_MENTION.replace_all(&s, |c: &Captures| {
        let id = &c[1];
        let name = opts.user_name.and_then(|f| f(id)).filter(|n| !n.is_empty());
        format!("@{}", name.as_deref().unwrap_or(id))
    });
    let s = CHANNEL_LINK.replace_all(&s, |c: &Captures| {
        let name = c.get(2).map(|g| g.as_str()).filter(|n| !n.is_empty());
        format!("#{}", name.unwrap_or(&c[1]))
    });
    let s = SUBTEAM.replace_all(&s, |c: &Captures| {
        c.get(1)
            .map(|g| g.as_str())
            .filter(|l| !l.is_empty())
            .unwrap_or("@group")
            .to_string()
    });
    let s = SPECIAL_MENTION.replace_all(&s, "@${1}");
    let s = LINK.replace_all(&s, |c: &Captures| {
        let url = &c[1];
        let label = c.get(2).map_or("", |g| g.as_str());
        let bare = MAILTO.replace(url, "");
        if label.is_empty() || label == url || label == bare {
            bare.into_owned()
        } else {
            format!("{label} ({bare})")
        }
    });
    let s = s.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
    trim(&s).to_string()
}

/// Whether Slack message text mentions this user (the bot). The id goes into the pattern as it is, as in the Node
/// code; one that makes no pattern (the Node code threw) mentions nobody.
pub fn mentions_user(text: &str, user_id: &str) -> bool {
    if text.is_empty() || user_id.is_empty() {
        return false;
    }
    Regex::new(&js_text::translate(&format!(r"<@{user_id}(?:\|[^>]*)?>")))
        .map(|r| r.is_match(text))
        .unwrap_or(false)
}

/// The emoji the model tends to react with, by Slack's name. reactions.add takes names, never the emoji itself.
fn emoji_name(emoji: &str) -> Option<&'static str> {
    Some(match emoji {
        "✅" => "white_check_mark",
        "✔️" | "✔" => "heavy_check_mark",
        "☑️" => "ballot_box_with_check",
        "👍" => "+1",
        "👎" => "-1",
        "👀" => "eyes",
        "❤️" | "❤" => "heart",
        "🎉" => "tada",
        "🔥" => "fire",
        "🚀" => "rocket",
        "😂" => "joy",
        "🙏" => "pray",
        "👏" => "clap",
        "🤔" => "thinking_face",
        "💯" => "100",
        "⚠️" | "⚠" => "warning",
        "❌" => "x",
        "✨" => "sparkles",
        "😊" => "blush",
        "😄" => "smile",
        "🙂" => "slightly_smiling_face",
        "😅" => "sweat_smile",
        "👌" => "ok_hand",
        "💪" => "muscle",
        "🙌" => "raised_hands",
        "🤖" => "robot_face",
        "📌" => "pushpin",
        "📝" => "memo",
        "⏳" => "hourglass_flowing_sand",
        "😢" => "cry",
        "😮" => "open_mouth",
        "🫡" => "saluting_face",
        "💡" => "bulb",
        "⭐" => "star",
        "😎" => "sunglasses",
        "🎯" => "dart",
        "🐒" => "monkey",
        "👋" => "wave",
        "🤝" => "handshake",
        "📎" => "paperclip",
        "📅" => "date",
        "🗓️" => "spiral_calendar_pad",
        "📊" => "bar_chart",
        "📈" => "chart_with_upwards_trend",
        "🧠" => "brain",
        "🛠️" => "hammer_and_wrench",
        "🔧" => "wrench",
        "🐛" => "bug",
        "🎊" => "confetti_ball",
        "🥳" => "partying_face",
        "😁" => "grin",
        "🤯" => "exploding_head",
        "😬" => "grimacing",
        "🙃" => "upside_down_face",
        "😴" => "sleeping",
        "☕" => "coffee",
        _ => return None,
    })
}

static EMOJI_COLONS: LazyLock<Regex> = LazyLock::new(|| re(r"^:|:$"));
// Slack names: lower case letters, digits, _ + - and the ::skin-tone-N suffix.
static EMOJI_SLACK_NAME: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-z0-9_+'-]+(?:::skin-tone-[2-6])?$"));

/// A reaction the model asked for → the name reactions.add takes, or `None` when there is none.
pub fn slack_emoji_name(marker: &str) -> Option<String> {
    let s = trim(marker);
    if s.is_empty() {
        return None;
    }
    if let Some(name) = emoji_name(s) {
        return Some(name.to_string());
    }
    let bare = EMOJI_COLONS.replace_all(s, "");
    EMOJI_SLACK_NAME.is_match(&bare).then(|| bare.into_owned())
}

static TOOL_CALL: LazyLock<Regex> = LazyLock::new(|| re(r"<tool_call>[\s\S]*?<\/tool_call>"));
static TOOL_RESPONSE: LazyLock<Regex> = LazyLock::new(|| re(r"<tool_response>[\s\S]*?<\/tool_response>"));
static BLANK_RUNS: LazyLock<Regex> = LazyLock::new(|| re(r"\n{3,}"));

/// An answer as Slack shows it: [react: ...] markers and tool-call records out, no runs of blank lines.
pub fn display_for_slack(raw: &str) -> String {
    let clean = parse_reactions(raw).clean_text;
    let s = TOOL_CALL.replace_all(&clean, "");
    let s = TOOL_RESPONSE.replace_all(&s, "");
    let s = BLANK_RUNS.replace_all(&s, "\n\n");
    trim(&s).to_string()
}

/// Markdown in pieces Slack takes as one message each, never cutting a code fence in half. `max_len` counts UTF-16
/// units ([`SLACK_MAX_MARKDOWN`] by default in the Node code).
pub fn split_for_slack(text: &str, max_len: usize) -> Vec<String> {
    split_message_fence_safe(text, max_len)
        .into_iter()
        .filter(|piece| !piece.is_empty())
        .collect()
}

static FENCE_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*(```+)(.*)$"));

/// The opening line of a code fence still open at the end of the text ("```js"), or `None` when none is.
pub fn open_fence(text: &str) -> Option<String> {
    let mut open: Option<String> = None;
    for line in text.split('\n') {
        let Some(m) = FENCE_LINE.captures(line) else { continue };
        open = match open {
            Some(_) => None,
            None => Some(format!("{}{}", &m[1], trim(&m[2]))),
        };
    }
    open
}

const MARKER_HEADS: [&str; 2] = ["[react:", "[remember:"];
static MARKER: LazyLock<Regex> = LazyLock::new(|| re(r"^\[(?i-u:react|remember):[^\]\n]*\]"));
const MAX_MARKER: usize = 300;

/// Takes the [react: ...] and [REMEMBER: ...] markers out of streamed text as it arrives. A Slack stream cannot take
/// back what it has sent, so a "[" that could still turn into a marker is held until it either closes (and is
/// dropped: the reaction is added and the memory saved from the full answer afterwards) or turns out to be ordinary
/// text, a link or a footnote, and is let through.
#[derive(Debug, Default, Clone)]
pub struct MarkerFilter {
    held: String,
}

impl MarkerFilter {
    pub fn new() -> Self {
        Self::default()
    }

    /// More text in; the part of it that is safe to show out.
    pub fn push(&mut self, delta: &str) -> String {
        let mut buf = std::mem::take(&mut self.held) + delta;
        let mut out = String::new();
        loop {
            let Some(i) = buf.find('[') else {
                out.push_str(&buf);
                return out;
            };
            out.push_str(&buf[..i]);
            buf.drain(..i);
            if let Some(whole) = MARKER.find(&buf) {
                buf.drain(..whole.end());
                continue;
            }
            let lower = buf.to_lowercase();
            let maybe = MARKER_HEADS
                .iter()
                .any(|h| h.starts_with(&lower) || (lower.starts_with(h) && !buf.contains([']', '\n'])));
            if maybe && utf16_len(&buf) < MAX_MARKER {
                self.held = buf;
                return out;
            }
            out.push('[');
            buf.drain(..1);
        }
    }

    /// The stream is over: whatever was held was never a marker.
    pub fn end(&mut self) -> String {
        std::mem::take(&mut self.held)
    }
}

/// The text with a code fence still open at its end closed, on a line of its own.
pub fn close_fence(text: &str) -> String {
    let Some(fence) = open_fence(text) else {
        return text.to_string();
    };
    let ticks = fence.len() - fence.trim_start_matches('`').len();
    format!(
        "{text}{}{}",
        if text.ends_with('\n') { "" } else { "\n" },
        &fence[..ticks]
    )
}

static THEME_SENTINEL: LazyLock<Regex> = LazyLock::new(|| re(r"^__SET_THEME__:[^|]*\|"));

/// A command reply without the web dashboard's sentinels ("__SET_THEME__:dark|Theme set..." → "Theme set...").
pub fn strip_command_sentinel(text: &str) -> String {
    THEME_SENTINEL.replace(text, "").into_owned()
}

#[cfg(test)]
mod tests {
    //! Port of `test/slack-format.test.js`, then cases whose expected values were printed by the Node code
    //! (`src/lib/slack-format.js`) for the same input (generated, not typed).
    use super::*;

    fn opts<'a>(bot: Option<&'a str>, names: Option<UserName<'a>>) -> PlainOptions<'a> {
        PlainOptions {
            bot_user_id: bot,
            user_name: names,
        }
    }

    // slackTextToPlain

    #[test]
    fn drops_the_bots_own_mention_and_keeps_the_words() {
        assert_eq!(
            slack_text_to_plain("<@UBOT> what's up?", opts(Some("UBOT"), None)),
            "what's up?"
        );
        assert_eq!(
            slack_text_to_plain("hey <@UBOT|tarsee>, help", opts(Some("UBOT"), None)),
            "hey, help"
        );
    }

    #[test]
    fn turns_other_peoples_mentions_into_names_it_can_read() {
        let names = |id: &str| (id == "U1").then(|| "alice".to_string());
        assert_eq!(
            slack_text_to_plain("ask <@U1> and <@U2>", opts(Some("UBOT"), Some(&names))),
            "ask @alice and @U2"
        );
    }

    #[test]
    fn turns_channel_links_special_mentions_and_user_groups_into_plain_words() {
        let none = PlainOptions::default();
        assert_eq!(slack_text_to_plain("see <#C123|general>", none), "see #general");
        assert_eq!(slack_text_to_plain("see <#C123>", none), "see #C123");
        assert_eq!(
            slack_text_to_plain("<!here> and <!channel> and <!everyone>", none),
            "@here and @channel and @everyone"
        );
        assert_eq!(slack_text_to_plain("<!subteam^S1|@ops> look", none), "@ops look");
    }

    #[test]
    fn unwraps_links_keeping_both_label_and_address_when_they_differ() {
        let none = PlainOptions::default();
        assert_eq!(slack_text_to_plain("<https://a.com>", none), "https://a.com");
        assert_eq!(
            slack_text_to_plain("<https://a.com|https://a.com>", none),
            "https://a.com"
        );
        assert_eq!(
            slack_text_to_plain("<https://a.com/x|the docs>", none),
            "the docs (https://a.com/x)"
        );
        assert_eq!(slack_text_to_plain("<mailto:a@b.co|a@b.co>", none), "a@b.co");
    }

    #[test]
    fn decodes_slacks_three_html_entities() {
        assert_eq!(
            slack_text_to_plain("a &lt;b&gt; &amp; c", PlainOptions::default()),
            "a <b> & c"
        );
    }

    #[test]
    fn never_changes_the_spacing_of_what_people_paste_indentation_paths_operators() {
        let none = PlainOptions::default();
        let bot = opts(Some("UBOT"), None);
        let py = "fix this:\n```\nif x:\n    if y:\n        z()\n```";
        assert_eq!(slack_text_to_plain(&format!("<@UBOT> {py}"), bot), py);
        assert_eq!(
            slack_text_to_plain("run rm -rf ./build && ls -la .", none),
            "run rm -rf ./build && ls -la ."
        );
        assert_eq!(slack_text_to_plain("a ? b : c", none), "a ? b : c");
        assert_eq!(
            slack_text_to_plain("key:  value  # two spaces", none),
            "key:  value  # two spaces"
        );
        assert_eq!(
            slack_text_to_plain("ask <@UBOT> now", bot),
            "ask now",
            "one space where the mention was"
        );
        assert_eq!(
            slack_text_to_plain("cc <@UBOTX> please", bot),
            "cc @UBOTX please",
            "a longer id that starts like the bot's is someone else"
        );
    }

    /// The Node case also passed `null`; a Rust `&str` cannot be null.
    #[test]
    fn handles_empty_input() {
        assert_eq!(slack_text_to_plain("", PlainOptions::default()), "");
    }

    // mentionsUser

    #[test]
    fn finds_a_mention_of_the_bot_with_or_without_a_label() {
        assert!(mentions_user("hi <@UBOT>", "UBOT"));
        assert!(mentions_user("hi <@UBOT|tarsee>", "UBOT"));
        assert!(!mentions_user("hi <@UOTHER>", "UBOT"));
        assert!(!mentions_user("hi @UBOT", "UBOT"));
        assert!(!mentions_user("", "UBOT"));
    }

    // slackEmojiName

    #[test]
    fn maps_common_emoji_to_slacks_names() {
        assert_eq!(slack_emoji_name("✅").as_deref(), Some("white_check_mark"));
        assert_eq!(slack_emoji_name("👍").as_deref(), Some("+1"));
        assert_eq!(slack_emoji_name("👀").as_deref(), Some("eyes"));
        assert_eq!(slack_emoji_name("❤️").as_deref(), Some("heart"));
        assert_eq!(slack_emoji_name("❤").as_deref(), Some("heart"));
    }

    #[test]
    fn accepts_names_as_slack_writes_them_with_or_without_colons() {
        assert_eq!(slack_emoji_name(":tada:").as_deref(), Some("tada"));
        assert_eq!(slack_emoji_name("rocket").as_deref(), Some("rocket"));
        assert_eq!(
            slack_emoji_name("thumbsup::skin-tone-3").as_deref(),
            Some("thumbsup::skin-tone-3")
        );
    }

    #[test]
    fn gives_null_for_something_it_cannot_name() {
        assert_eq!(slack_emoji_name("🦩🦩"), None);
        assert_eq!(slack_emoji_name(""), None);
        assert_eq!(slack_emoji_name("two words"), None);
    }

    // displayForSlack

    #[test]
    fn removes_reaction_markers_and_tool_records_keeps_markdown_as_written() {
        let raw = "Done [react: ✅]\n<tool_call>{\"name\":\"Bash\"}</tool_call>\n<tool_response>ok</tool_response>\n\n\n| a | b |\n|---|---|\n| 1 | 2 |";
        let out = display_for_slack(raw);
        assert!(!out.contains("[react"), "{out}");
        assert!(!out.contains("tool_call"), "{out}");
        assert!(!out.contains("tool_response"), "{out}");
        assert!(out.contains("| a | b |"), "tables stay as markdown: Slack draws them");
        assert!(!out.contains("\n\n\n"), "no runs of blank lines");
    }

    // splitForSlack

    #[test]
    fn keeps_short_text_whole() {
        assert_eq!(split_for_slack("hi", SLACK_MAX_MARKDOWN), vec!["hi"]);
    }

    #[test]
    fn splits_long_text_under_the_limit_without_breaking_a_code_fence() {
        let lines: Vec<String> = (0..400).map(|i| format!("const v{i} = {i};")).collect();
        let code = format!("```js\n{}\n```", lines.join("\n"));
        let pieces = split_for_slack(&code, 2000);
        assert!(pieces.len() > 1);
        for p in &pieces {
            assert!(utf16_len(p) <= 2000, "piece too long: {}", utf16_len(p));
            let fences = p.split('\n').filter(|l| l.starts_with("```")).count();
            assert_eq!(fences % 2, 0, "every piece opens and closes its fence");
        }
    }

    // openFence

    #[test]
    fn says_which_fence_is_still_open_at_the_end_of_the_text() {
        assert_eq!(open_fence("text"), None);
        assert_eq!(open_fence("```js\ncode\n```\nmore"), None);
        assert_eq!(open_fence("intro\n```python\nx = 1\n").as_deref(), Some("```python"));
        assert_eq!(open_fence("```\nplain").as_deref(), Some("```"));
    }

    // MarkerFilter

    fn run(deltas: &[&str]) -> String {
        let mut f = MarkerFilter::new();
        let mut out: String = deltas.iter().map(|d| f.push(d)).collect();
        out.push_str(&f.end());
        out
    }

    #[test]
    fn drops_a_reaction_marker_even_when_it_arrives_in_pieces() {
        let mut f = MarkerFilter::new();
        assert_eq!(f.push("Done [rea"), "Done ");
        assert_eq!(f.push("ct: ✅] next"), " next");
        assert_eq!(f.end(), "");
    }

    #[test]
    fn drops_memory_markers_in_any_case() {
        assert_eq!(
            run(&["Noted. [REMEMBER: likes tea]", " Anything else?"]),
            "Noted.  Anything else?"
        );
        assert_eq!(run(&["[remember: x]ok"]), "ok");
    }

    #[test]
    fn lets_ordinary_brackets_and_links_through_as_soon_as_they_cannot_be_a_marker() {
        let mut f = MarkerFilter::new();
        assert_eq!(f.push("see [li"), "see [li");
        assert_eq!(f.push("nk](https://a.com)"), "nk](https://a.com)");
        assert_eq!(run(&["[re", "ad more](x)"]), "[read more](x)");
        assert_eq!(run(&["a [1] b"]), "a [1] b");
    }

    #[test]
    fn gives_back_a_half_written_marker_at_the_end_as_plain_text() {
        assert_eq!(run(&["oops [rea"]), "oops [rea");
    }

    #[test]
    fn does_not_hold_text_forever_when_a_marker_never_closes() {
        let mut f = MarkerFilter::new();
        let out = f.push(&format!("[react: {}", "x".repeat(400)));
        assert!(!out.is_empty(), "released once it is too long to be a marker");
    }

    // stripCommandSentinel

    #[test]
    fn drops_the_web_only_theme_sentinel_and_keeps_the_words() {
        assert_eq!(
            strip_command_sentinel("__SET_THEME__:dark|Theme set to **dark**."),
            "Theme set to **dark**."
        );
        assert_eq!(strip_command_sentinel("plain reply"), "plain reply");
    }

    // Awkward input, against what the Node code printed.

    #[test]
    fn slack_text_to_plain_matches_the_node_output() {
        let names = |id: &str| match id {
            "U1" => Some("alice".to_string()),
            "U2" => Some(String::new()),
            "W3" => Some("bob".to_string()),
            _ => None,
        };
        for (i, (text, bot, expected)) in NODE_PLAIN.iter().enumerate() {
            assert_eq!(
                slack_text_to_plain(text, opts(*bot, Some(&names))),
                *expected,
                "case {i}: {text:?}"
            );
        }
    }

    #[test]
    fn slack_emoji_name_matches_the_node_output() {
        for (marker, expected) in NODE_EMOJI {
            assert_eq!(slack_emoji_name(marker).as_deref(), *expected, "{marker:?}");
        }
    }

    #[test]
    fn display_for_slack_matches_the_node_output() {
        for (raw, expected) in NODE_DISPLAY {
            assert_eq!(display_for_slack(raw), *expected, "{raw:?}");
        }
    }

    #[test]
    fn open_and_close_fence_match_the_node_output() {
        for (text, open, closed) in NODE_FENCES {
            assert_eq!(open_fence(text).as_deref(), *open, "{text:?}");
            assert_eq!(close_fence(text), *closed, "{text:?}");
        }
    }

    #[test]
    fn marker_filter_matches_the_node_output_push_by_push() {
        for (deltas, outs, end) in NODE_MARKERS {
            let mut f = MarkerFilter::new();
            let got: Vec<String> = deltas.iter().map(|d| f.push(d)).collect();
            assert_eq!(got, *outs, "{deltas:?}");
            assert_eq!(f.end(), *end, "{deltas:?}");
        }
    }

    #[test]
    fn strip_command_sentinel_matches_the_node_output() {
        for (text, expected) in NODE_SENTINEL {
            assert_eq!(strip_command_sentinel(text), *expected, "{text:?}");
        }
    }

    #[test]
    fn mentions_user_matches_the_node_output() {
        for (text, user, expected) in NODE_MENTIONS {
            assert_eq!(mentions_user(text, user), *expected, "{text:?} {user:?}");
        }
    }

    #[test]
    fn split_for_slack_matches_the_node_output() {
        for (text, max, expected) in NODE_SPLIT_FOR_SLACK {
            assert_eq!(split_for_slack(text, *max), *expected, "{text:?} at {max}");
        }
    }

    /// An id that makes no pattern made the Node code throw; here nothing is taken out and nobody is mentioned.
    #[test]
    fn an_id_that_is_no_pattern_does_not_fail() {
        assert_eq!(slack_text_to_plain("<@U(> hi", opts(Some("U("), None)), "<@U(> hi");
        assert!(!mentions_user("<@U(>", "U("));
        assert!(!mentions_user("<@U\\>", "U\\"));
    }

    /// Text, bot id, and what `slackTextToPlain` printed (names: U1 alice, U2 "", W3 bob), in the Node code.
    const NODE_PLAIN: &[(&str, Option<&str>, &str)] = &[
        ("<@UBOT>", Some("UBOT"), ""),
        ("<@UBOT>, can you?", Some("UBOT"), ", can you?"),
        ("hey <@UBOT>! and <@UBOT>?", Some("UBOT"), "hey! and?"),
        (
            "line one <@UBOT>\n<@UBOT> line two\r\n<@UBOT>\u{2028}end",
            Some("UBOT"),
            "line one\nline two\r\n\u{2028}end",
        ),
        ("<@UBOT><@UBOT> twice", Some("UBOT"), "twice"),
        ("a\t<@UBOT|tarsee>\tb", Some("UBOT"), "a b"),
        ("mid <@UBOT> <@UBOT> mid", Some("UBOT"), "mid mid"),
        ("keep \u{e000} placeholder", Some("UBOT"), "keep   placeholder"),
        ("keep \u{e000} placeholder", None, "keep \u{e000} placeholder"),
        ("<@U1> <@U2> <@W3> <@U9|someone>", Some("UBOT"), "@alice @U2 @bob @U9"),
        ("<#C1|> <#G2|private> <#C3>", None, "#C1 #private #C3"),
        (
            "<!subteam^S1> <!subteam^S2|> <!subteam^S3|@devs>",
            None,
            "@group @group @devs",
        ),
        (
            "<!here|here> <!channel> <!everyone|x> <!date^1|x>",
            None,
            "@here @channel @everyone <!date^1|x>",
        ),
        (
            "<https://a.com/x?y=1&amp;z=2|docs> <mailto:x@y.z> <mailto:x@y.z|mailto:x@y.z> <http://b|> <ftp://c>",
            None,
            "docs (https://a.com/x?y=1&z=2) x@y.z x@y.z http://b <ftp://c>",
        ),
        ("&amp;lt; &lt;&gt; &amp;amp;", None, "&lt; <> &amp;"),
        ("  \u{a0} padded \u{feff} ", None, "padded"),
        (
            "code:\n```\n  <@UBOT>  indented\n```",
            Some("UBOT"),
            "code:\n```\nindented\n```",
        ),
        ("<@UBOTX> is not the bot", Some("UBOT"), "@UBOTX is not the bot"),
        ("<@ubot> lower", Some("UBOT"), "<@ubot> lower"),
        ("😀 <@U1> 日本", None, "😀 @alice 日本"),
    ];

    /// Markers and what `slackEmojiName` printed, in the Node code.
    const NODE_EMOJI: &[(&str, Option<&str>)] = &[
        ("✅", Some("white_check_mark")),
        ("✔\u{fe0f}", Some("heavy_check_mark")),
        ("✔", Some("heavy_check_mark")),
        (" 👍 ", Some("+1")),
        (":+1:", Some("+1")),
        ("::", None),
        (":", None),
        ("thumbsup::skin-tone-1", None),
        ("thumbsup::skin-tone-6", Some("thumbsup::skin-tone-6")),
        ("Rocket", None),
        ("it's", Some("it's")),
        ("a:b", None),
        ("🗓\u{fe0f}", Some("spiral_calendar_pad")),
        ("🗓", None),
        ("🛠", None),
        ("x y", None),
        ("-", Some("-")),
        (":tada", Some("tada")),
        ("tada:", Some("tada")),
        ("\u{a0}eyes\u{a0}", Some("eyes")),
    ];

    /// Raw answers and what `displayForSlack` printed, in the Node code.
    const NODE_DISPLAY: &[(&str, &str)] = &[
        ("", ""),
        ("[react: 👍] hi", "hi"),
        ("a\n\n\n\nb\n\n\nc", "a\n\nb\n\nc"),
        (
            "x<tool_call>{\"a\":1}\n</tool_call>y<tool_response>\nok\n</tool_response>z",
            "xyz",
        ),
        ("<tool_call>unclosed", "<tool_call>unclosed"),
        ("<TOOL_CALL>x</TOOL_CALL>", "<TOOL_CALL>x</TOOL_CALL>"),
        ("a\r\n\r\n\r\nb", "a\r\n\r\n\r\nb"),
        ("[buttons: [\"a\"]] text [react:x]", "text"),
        ("  \n\n\n  spaced  \n\n\n  ", "spaced"),
    ];

    /// Text, then what `openFence` and `closeFence` printed, in the Node code.
    const NODE_FENCES: &[(&str, Option<&str>, &str)] = &[
        ("", None, ""),
        ("```", Some("```"), "```\n```"),
        ("```js", Some("```js"), "```js\n```"),
        ("  ```  py  ", Some("```py"), "  ```  py  \n```"),
        ("```\na\n```", None, "```\na\n```"),
        ("```js\n", Some("```js"), "```js\n```"),
        ("~~~\nx", None, "~~~\nx"),
        ("````\n```\n", None, "````\n```\n"),
        ("text ``` inline", None, "text ``` inline"),
        ("```a\n```b\n```c", Some("```c"), "```a\n```b\n```c\n```"),
        ("\u{a0}```x\u{a0}", Some("```x"), "\u{a0}```x\u{a0}\n```"),
        ("```\r\ncode\r\n", None, "```\r\ncode\r\n"),
        (
            "```js\ncode\n```\n```py\n",
            Some("```py"),
            "```js\ncode\n```\n```py\n```",
        ),
    ];

    /// Deltas pushed through one `MarkerFilter`: what each push gave, then what `end` gave, in the Node code.
    const NODE_MARKERS: &[(&[&str], &[&str], &str)] = &[
        (&["[", "react", ": x]", " after"], &["", "", "", " after"], ""),
        (&["see [", "R", "EMEMBER: y] z"], &["see ", "", " z"], ""),
        (&["[re", "member", "s"], &["", "", "[remembers"], ""),
        (&["[react:x\n", "y]"], &["[react:x\n", "y]"], ""),
        (&["[[react: a]]"], &["[]"], ""),
        (&["a[", "", "b"], &["a", "", "[b"], ""),
        (
            &["[REACT: 😀]", "[Remember: 日本]", "[react]"],
            &["", "", "[react]"],
            "",
        ),
        (
            &[
                "[react: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀",
            ],
            &[
                "",
                "[react: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀",
            ],
            "",
        ),
        (
            &["x [", "remember:", " no close"],
            &["x ", "", ""],
            "[remember: no close",
        ),
        (&["[r", "[react: q] done"], &["", "[r done"], ""),
        (&["[RE", "ACT", ":", "]"], &["", "", "", ""], ""),
    ];

    /// Text and what `stripCommandSentinel` printed, in the Node code.
    const NODE_SENTINEL: &[(&str, &str)] = &[
        ("__SET_THEME__:dark|Theme set", "Theme set"),
        ("__SET_THEME__:|x", "x"),
        ("x __SET_THEME__:dark|y", "x __SET_THEME__:dark|y"),
        ("__SET_THEME__:dark no bar", "__SET_THEME__:dark no bar"),
        ("__SET_THEME__:a|b|c", "b|c"),
    ];

    /// Text, user id, and what `mentionsUser` printed, in the Node code.
    const NODE_MENTIONS: &[(&str, &str, bool)] = &[
        ("<@UBOT>", "UBOT", true),
        ("<@UBOT|x>", "UBOT", true),
        ("<@UBOTX>", "UBOT", false),
        ("<@UBOT", "UBOT", false),
        ("x", "", false),
        ("<@U.B>", "U.B", true),
        ("<@UXB>", "U.B", true),
    ];

    /// Text, limit, and the pieces `splitForSlack` printed, in the Node code.
    const NODE_SPLIT_FOR_SLACK: &[(&str, usize, &[&str])] = &[
        ("", 100, &[]),
        (
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            10,
            &["aaaaaaaaaa", "aaaaaaaaaa", "aaaaaaaaaa"],
        ),
        ("😀😀😀😀😀😀😀😀", 5, &["😀😀😀😀😀", "😀😀😀"]),
    ];
}
