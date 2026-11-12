//! Port of `test/discord-format.test.js`, then cases whose expected text was printed by the Node code
//! (`src/lib/discord-format.js`) for the same input.

use regex::Regex;

use super::*;
use crate::lib::reaction_parser::parse_reactions;
use crate::util::js::utf16_truncate;

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// How many lines of `text` start with ``` (the JS `(text.match(/^```/gm) || []).length`).
fn fence_lines(text: &str) -> usize {
    text.split('\n').filter(|l| l.starts_with("```")).count()
}

// displayWidth

#[test]
fn ascii_is_1_col_each() {
    assert_eq!(display_width("abc"), 3);
}

#[test]
fn cjk_is_2_cols() {
    assert_eq!(display_width("日本語"), 6);
}

#[test]
fn emoji_is_2_cols_length_is_2() {
    assert_eq!(utf16_len("😀"), 2);
    assert_eq!(display_width("😀"), 2);
}

#[test]
fn skin_tone_modifier_adds_nothing() {
    assert_eq!(display_width("👍🏽"), 2);
}

#[test]
fn zwj_family_is_2_cols_not_11() {
    assert_eq!(utf16_len("👨‍👩‍👧"), 8);
    assert_eq!(display_width("👨‍👩‍👧"), 2);
}

#[test]
fn vs16_promotes_ambiguous_glyph_to_2() {
    assert_eq!(display_width("✅"), 2);
}

#[test]
fn arrows_and_em_dash_stay_narrow() {
    assert_eq!(display_width("→\u{2014}·"), 3);
}

// Edge case 2: never touch tables inside a fence

#[test]
fn fenced_table_is_byte_identical() {
    let src = "before\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\nafter";
    assert_eq!(format_tables_for_discord(src), src);
}

#[test]
fn tilde_fence_also_protected() {
    let src = "~~~md\n| a | b |\n|---|---|\n| 1 | 2 |\n~~~";
    assert_eq!(format_tables_for_discord(src), src);
}

#[test]
fn unterminated_fence_swallows_the_rest() {
    let src = "```\n| a | b |\n|---|---|\n| 1 | 2 |";
    assert_eq!(format_tables_for_discord(src), src);
}

#[test]
fn table_outside_a_fence_still_transformed_when_a_fence_exists_earlier() {
    let src = "```js\nconst x=1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    let out = format_tables_for_discord(src);
    assert!(out.starts_with("```js\nconst x=1;\n```"), "leading fence preserved");
    assert!(!out.split('\n').any(|l| l == "| a | b |"), "table was rewritten");
}

// Edge case 3: escaped pipes

#[test]
fn escaped_pipe_does_not_split_a_column() {
    let tables = parse_md_tables("| a | b |\n|---|---|\n| x \\| y | z |");
    assert_eq!(tables[0].rows[0], s(&["x \\| y", "z"]));
}

#[test]
fn grid_mode_unescapes_a_fence_renders_literally_a_backslash_would_show() {
    let out = format_tables_for_discord("| a | b |\n|---|---|\n| x \\| y | z |");
    assert!(out.contains("x | y"), "{out}");
    assert!(!out.contains("\\|"), "backslash must not survive into the fence");
}

#[test]
fn list_mode_keeps_escaped_pipes_escaped_bare_double_pipe_would_become_a_spoiler() {
    let wide = format!("| Name | Note |\n|---|---|\n| {} | a \\|\\| b |", "w".repeat(45));
    let out = format_tables_for_discord(&wide);
    assert!(out.contains("\\|\\|"), "{out}");
}

// Edge case 4: ragged rows never throw

#[test]
fn short_row_is_padded() {
    let out = format_tables_for_discord("| a | b | c |\n|---|---|---|\n| 1 |");
    assert!(out.contains("```"), "{out}");
}

#[test]
fn long_row_is_kept_not_dropped() {
    let out = format_tables_for_discord("| a | b |\n|---|---|\n| 1 | 2 | 3 |");
    assert!(out.contains('3'), "extra cell survives as an extra column");
}

#[test]
fn header_and_separator_with_zero_rows_does_not_throw() {
    let out = format_tables_for_discord("| a | b |\n|---|---|");
    assert!(!out.is_empty());
}

/// The Node case also passed `null` and got `null` back; a Rust `&str` cannot be null.
#[test]
fn empty_string_non_string_are_safe() {
    assert_eq!(format_tables_for_discord(""), "");
}

// Edge case 5: alignment separator rows

#[test]
fn alignment_separator_row_is_consumed_and_respected() {
    let out = format_tables_for_discord("| L | R | C |\n|:---|---:|:-:|\n| a | b | c |\n| aaaa | bbbb | cccc |");
    assert!(!out.contains(":---"), "separator row must not survive");
    let right_r = Regex::new(r"^R\s|\sR$| {3}R").unwrap();
    assert!(
        out.split('\n').any(|l| right_r.is_match(l) || l.contains("   R")),
        "{out}"
    );
}

#[test]
fn separator_row_is_not_mistaken_for_a_data_row() {
    let tables = parse_md_tables("| a | b |\n| :-- | --: |\n| 1 | 2 |");
    assert_eq!(tables[0].rows.len(), 1);
    assert_eq!(tables[0].aligns, vec![Some(Align::Left), Some(Align::Right)]);
}

// Edge case 1: inline markdown inside cells

#[test]
fn grid_mode_strips_bold_code_em_they_render_literally_in_a_fence() {
    let out = format_tables_for_discord("| Task | State |\n|---|---|\n| **Deploy** | `done` |\n| *Audit* | ~~cut~~ |");
    let leftover = Regex::new(r"\*\*|`code`|~~").unwrap();
    assert!(!leftover.is_match(&out.replace("```", "")), "{out}");
    assert!(out.contains("Deploy"), "{out}");
}

#[test]
fn grid_column_width_is_measured_after_stripping_the_old_padding_bug() {
    let grid = to_ascii_grid(&s(&["h", "k"]), &[None, None], &[s(&["**xx**", "1"]), s(&["y", "2"])]);
    // "**xx**".length is 6; stripped it is 2 -> the column must be 2 wide, so the second column starts at index 4
    // ("xx" + 2-space gap).
    assert_eq!(grid.lines[0], "h   k");
    assert_eq!(grid.lines[2], "xx  1");
    assert_eq!(grid.lines[3], "y   2");
}

#[test]
fn snake_case_survives_the_italic_stripper() {
    let out = format_tables_for_discord("| Col | T |\n|---|---|\n| user_id_v2 | int |\n| _em_ | x |");
    assert!(out.contains("user_id_v2"), "{out}");
    let em_line = Regex::new(r"(?m)^em(?-u:\b)").unwrap();
    assert!(em_line.is_match(&out), "real _italics_ still stripped: {out}");
}

#[test]
fn list_mode_preserves_bold_inside_cells() {
    let out = format_tables_for_discord(&format!("| Day | Note |\n|---|---|\n| Mon | **{}** |", "x".repeat(40)));
    assert!(out.contains(&format!("**{}**", "x".repeat(40))), "{out}");
}

// Edge case 6: emoji / CJK padding

#[test]
fn emoji_column_stays_aligned() {
    let out = format_tables_for_discord("| S | N |\n|---|---|\n| ✅ | ok |\n| ab | no |");
    let rows: Vec<&str> = out
        .split('\n')
        .filter(|l| l.contains("ok") || l.contains("no"))
        .collect();
    let first_cell = |l: &str| l.split("  ").next().unwrap_or("").to_string();
    assert_eq!(display_width(&first_cell(rows[0])), display_width(&first_cell(rows[1])));
}

#[test]
fn cjk_column_stays_aligned() {
    let out = format_tables_for_discord("| K | N |\n|---|---|\n| 日本 | a |\n| abcd | b |");
    let word = Regex::new(r"(?-u:\b)a(?-u:\b)|(?-u:\b)b(?-u:\b)").unwrap();
    let lines: Vec<&str> = out.split('\n').filter(|l| word.is_match(l)).collect();
    let col0: Vec<&str> = lines.iter().map(|l| &l[..l.rfind("  ").unwrap_or(0)]).collect();
    assert_eq!(display_width(col0[0]), display_width(col0[1]), "{col0:?}");
}

// Mode selection at the 40-col threshold

#[test]
fn narrow_table_becomes_a_fenced_grid() {
    let out = format_tables_for_discord("| Env | Status |\n|---|---|\n| prod | green |\n| dev | amber |");
    assert!(out.starts_with("```"), "{out}");
    let lines: Vec<&str> = out.split('\n').collect();
    let width = lines[1..lines.len() - 1]
        .iter()
        .map(|l| display_width(l))
        .max()
        .unwrap();
    assert!(width <= MAX_GRID_WIDTH, "width {width}");
}

#[test]
fn wide_table_becomes_a_list_no_fence() {
    let out = format_tables_for_discord(
        "| Project | Owner | Notes |\n|---|---|---|\n| Migration of the billing system | Sam | needs sign-off from finance before Friday |",
    );
    assert!(!out.contains("```"), "{out}");
    assert!(out.starts_with("**Migration of the billing system**"), "{out}");
}

#[test]
fn huge_narrow_table_becomes_a_list_because_a_fence_over_1900_chars_cannot_survive_splitting() {
    let rows: Vec<String> = (0..300).map(|i| format!("| r{i} | {i} |")).collect();
    let out = format_tables_for_discord(&format!("| Key | N |\n|---|---|\n{}", rows.join("\n")));
    assert!(!out.contains("```"), "must NOT emit a fence it cannot keep intact");
    assert!(out.contains("**r299**"), "{out}");
}

// Edge case 8: idempotency

fn assert_idempotent(src: &str) {
    let once = format_tables_for_discord(src);
    assert_eq!(format_tables_for_discord(&once), once);
    assert_eq!(format_tables_for_discord(&format_tables_for_discord(&once)), once);
}

#[test]
fn idempotent_narrow() {
    assert_idempotent("| Env | Status |\n|---|---|\n| prod | green |");
}

#[test]
fn idempotent_wide() {
    assert_idempotent(
        "| Project | Owner | Notes |\n|---|---|---|\n| Migration of billing | Sam | needs finance sign-off Friday |",
    );
}

#[test]
fn idempotent_mixed_prose() {
    assert_idempotent("Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nOutro with a | pipe.");
}

// Surrounding text untouched

#[test]
fn prose_before_after_is_preserved_exactly() {
    let out = format_tables_for_discord("Hello **world**.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nBye _now_.");
    assert!(out.starts_with("Hello **world**.\n\n"), "{out}");
    assert!(out.ends_with("\n\nBye _now_."), "{out}");
}

#[test]
fn text_with_no_table_is_returned_identical() {
    let src = "just prose | with a pipe\nand another | line";
    assert_eq!(format_tables_for_discord(src), src);
}

#[test]
fn indented_table_nested_under_a_bullet_is_handled_indent_preserved() {
    let out = format_tables_for_discord("- Results:\n  | a | b |\n  |---|---|\n  | 1 | 2 |");
    assert!(out.starts_with("- Results:\n"), "{out}");
    assert!(out.split('\n').nth(1).unwrap().starts_with("  "), "{out}");
}

#[test]
fn two_tables_in_one_message_both_transform() {
    let out = format_tables_for_discord("| a | b |\n|---|---|\n| 1 | 2 |\n\ntext\n\n| c | d |\n|---|---|\n| 3 | 4 |");
    assert_eq!(out.matches("```").count(), 4);
}

#[test]
fn matched_inline_code_in_a_cell_is_unwrapped_so_no_fence_conflict() {
    let out = format_tables_for_discord("| a | b |\n|---|---|\n| ```x``` | 2 |");
    assert_eq!(out.split('\n').next().unwrap(), "```");
    assert!(out.contains('x'), "{out}");
}

#[test]
fn an_unmatched_backtick_run_in_a_cell_forces_a_longer_fence() {
    let out = format_tables_for_discord("| a | b |\n|---|---|\n| ``` | 2 |");
    let opener = out.split('\n').next().unwrap();
    assert!(opener.len() >= 4, "fence must outrun the content: {opener:?}");
    assert!(trim_end(&out).ends_with(opener), "closing fence must match");
}

// splitMessageFenceSafe

#[test]
fn short_text_returned_as_one_chunk() {
    assert_eq!(split_message_fence_safe("hi", 2000), vec!["hi"]);
}

#[test]
fn fences_are_balanced_in_every_chunk() {
    let body: Vec<String> = (0..400).map(|i| format!("row {i} ....................")).collect();
    let chunks = split_message_fence_safe(&format!("```\n{}\n```", body.join("\n")), 2000);
    assert!(chunks.len() > 1, "should have split");
    for (i, c) in chunks.iter().enumerate() {
        let n = fence_lines(c);
        assert_eq!(n % 2, 0, "chunk {i} has {n} fence markers:\n{}", utf16_truncate(c, 120));
        assert!(utf16_len(c) <= 2000, "chunk {i} is {}", utf16_len(c));
    }
}

#[test]
fn language_tag_is_carried_across_the_boundary() {
    let body: Vec<String> = (0..400).map(|i| format!("line {i} ....................")).collect();
    let chunks = split_message_fence_safe(&format!("```ansi\n{}\n```", body.join("\n")), 2000);
    assert!(chunks[1].starts_with("```ansi"), "{}", utf16_truncate(&chunks[1], 40));
}

#[test]
fn never_cleaves_a_fence_marker_the_originals_worst_case() {
    let chunks = split_message_fence_safe(&format!("```\n{}\n```", "x".repeat(1994)), 2000);
    let half = Regex::new(r"(^|[^`])``($|[^`])").unwrap();
    for c in &chunks {
        assert!(
            !half.is_match(c),
            "half marker in: {}",
            crate::util::js::utf16_tail(c, 10)
        );
    }
}

/// The Node case looked for lone surrogates in the chunks. A Rust string cannot hold one, so what is checked is the
/// thing that matters: every emoji arrives whole, none dropped.
#[test]
fn no_lone_surrogates_on_a_hard_cut() {
    let chunks = split_message_fence_safe(&format!("{}{}", "x".repeat(1999), "😀".repeat(50)), 2000);
    assert!(chunks.len() > 1);
    assert_eq!(chunks.concat().matches('😀').count(), 50);
    assert_eq!(chunks.concat().matches('x').count(), 1999);
    // The Node code's hard cut took 2000 code points, so its first piece was 2001 UTF-16 units ([2001, 98]), which
    // Discord refuses. Fixed in the Rust version: the cut counts units and falls between characters.
    assert_eq!(chunks.iter().map(|c| utf16_len(c)).collect::<Vec<_>>(), vec![1999, 100]);
}

#[test]
fn continuation_chunks_do_not_start_with_a_blank_line() {
    let src: Vec<String> = (0..300).map(|i| format!("line {i}")).collect();
    let chunks = split_message_fence_safe(&src.join("\n"), 500);
    for c in &chunks[1..] {
        assert!(!c.starts_with('\n'), "{:?}", utf16_truncate(c, 8));
    }
}

#[test]
fn no_chunk_exceeds_max_len_nothing_is_lost() {
    let src: Vec<String> = (0..200).map(|i| format!("line {i} abcdefghij")).collect();
    let src = src.join("\n");
    let chunks = split_message_fence_safe(&src, 400);
    for c in &chunks {
        assert!(utf16_len(c) <= 400, "{}", utf16_len(c));
    }
    assert_eq!(chunks.join("\n").replace('\n', ""), src.replace('\n', ""));
}

#[test]
fn dangling_fence_in_the_input_is_closed_on_output() {
    let chunks = split_message_fence_safe(&format!("```\n{}", "y".repeat(3000)), 2000);
    let last = chunks.last().unwrap();
    assert!(
        trim_end(last).ends_with("```"),
        "{}",
        crate::util::js::utf16_tail(last, 20)
    );
}

// a real failing example (names changed)
const REAL: &str = "| Day | Before | After | |\n\
|---|---|---|---|\n\
| Tue 28 | 37.2h | **6.4h** | Website launch only |\n\
| Wed 29 | 29.5h | **15.7h** | Launch crunch, alone |\n\
| Sat 1 Aug | \u{2014} | 7.0h | Support rota |";

const REAL_EXPECTED: &str = "**Tue 28** · Before 37.2h → After **6.4h** \u{2014} Website launch only\n\
**Wed 29** · Before 29.5h → After **15.7h** \u{2014} Launch crunch, alone\n\
**Sat 1 Aug** · After 7.0h \u{2014} Support rota";

#[test]
fn the_real_table_renders_exactly_as_specified() {
    assert_eq!(format_tables_for_discord(REAL), REAL_EXPECTED);
}

#[test]
fn the_real_table_is_idempotent() {
    assert_eq!(format_tables_for_discord(REAL_EXPECTED), REAL_EXPECTED);
}

#[test]
fn the_real_table_picks_list_mode_because_its_grid_is_wider_than_40_cols() {
    let tables = parse_md_tables(REAL);
    let t = &tables[0];
    assert!(to_ascii_grid(&t.headers, &t.aligns, &t.rows).width > MAX_GRID_WIDTH);
}

#[test]
fn a_fence_opened_near_the_end_of_a_piece_never_pushes_that_piece_past_2000_characters() {
    for n in 1985..=2000 {
        let text = format!("{}\n```js\n{}```\nend", "a".repeat(n), "const x = 1;\n".repeat(40));
        let pieces = split_message_fence_safe(&text, 2000);
        for p in &pieces {
            assert!(utf16_len(p) <= 2000, "prose of {n}: a piece of {}", utf16_len(p));
            assert_eq!(fence_lines(p) % 2, 0, "prose of {n}: every fence closed in its piece");
        }
    }
}

/// `displayForDiscord` belongs to `channels/discord.js` (package H1); it is reactions out, tool records out, blank
/// runs squeezed, then [`format_for_discord`], which is what this case is about. Written out here with the same steps.
#[test]
fn a_reply_whose_table_grows_when_drawn_reaches_discord_whole_drawn_first_then_split() {
    let display_for_discord = |raw: &str| {
        let clean = parse_reactions(raw).clean_text;
        let clean = Regex::new(r"<tool_call>(?s:.)*?</tool_call>")
            .unwrap()
            .replace_all(&clean, "");
        let clean = Regex::new(r"<tool_response>(?s:.)*?</tool_response>")
            .unwrap()
            .replace_all(&clean, "");
        let clean = Regex::new(r"\n{3,}").unwrap().replace_all(&clean, "\n\n");
        format_for_discord(trim(&clean))
    };
    let rows: Vec<String> = (0..20)
        .map(|i| format!("| Row {} | lead {i} | closed {i} | {} | note {i} |", i + 1, i * 7))
        .collect();
    let reply = format!(
        "Here is the summary.\n\n| Name | Lead | Closed | Score | Note |\n|---|---|---|---|---|\n{}\n\nThat is all.",
        rows.join("\n")
    );
    let pieces = split_message_fence_safe(&display_for_discord(&reply), 2000);
    let all = pieces.join("\n");
    assert!(pieces.iter().all(|p| utf16_len(p) <= 2000));
    assert!(all.contains("Row 20"));
    assert!(all.contains("That is all."));
}

// The JavaScript pattern translation itself.

#[test]
fn javascript_patterns_keep_their_javascript_meaning() {
    // \s is JavaScript's set: U+FEFF in, U+0085 out.
    assert!(js_text::re(r"^\s$").is_match("\u{FEFF}"));
    assert!(!js_text::re(r"^\s$").is_match("\u{85}"));
    // . stops at all four line terminators.
    for t in ["\n", "\r", "\u{2028}", "\u{2029}"] {
        assert!(!js_text::re(r"^.$").is_match(t), "{t:?}");
    }
    assert!(js_text::re(r"^.$").is_match("\u{85}"));
    // \d and \w are ASCII.
    assert!(!js_text::re(r"\d").is_match("٣"));
    assert!(!js_text::re(r"\w").is_match("é"));
    // [\s\S] is any character, [ inside a class is literal.
    assert!(js_text::re(r"^[\s\S]$").is_match("\n"));
    assert!(js_text::re(r"^[[\]]+$").is_match("[]"));
}

/// The `\s` of the translated patterns is the foundation's JavaScript whitespace, character for character.
#[test]
fn the_pattern_whitespace_is_the_foundations_javascript_whitespace() {
    let ws = js_text::re(r"^\s$");
    let not_ws = js_text::re(r"^\S$");
    for c in (0..=0x10FFFFu32).filter_map(char::from_u32) {
        let text = c.to_string();
        assert_eq!(ws.is_match(&text), is_whitespace(c), "U+{:04X}", c as u32);
        assert_eq!(not_ws.is_match(&text), !is_whitespace(c), "U+{:04X}", c as u32);
    }
}

// ---------------------------------------------------------------------------
// Awkward input. Every expected value below was printed by the Node code (src/lib/discord-format.js) for the
// same input (generated, not typed).
// ---------------------------------------------------------------------------

/// Inputs and the text `formatForDiscord` printed for each, in the Node code.
const NODE_FORMAT_FOR_DISCORD: &[(&str, &str)] = &[
    ("", ""),
    ("no pipes here > or quotes", "no pipes here > or quotes"),
    (
        "- a\n  - b\n    - c | d\n\n1. x\n2. y",
        "- a\n  - b\n    - c | d\n\n1. x\n2. y",
    ),
    (
        "- item\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n- next",
        "- item\n  ```\n  a  b\n  -  -\n  1  2\n  ```\n- next",
    ),
    (
        "| a | b |\n|---|---|\n| `x` | ``y`` |\n| ```` | z |",
        "`````\na     b\n----  -\nx     y\n````  z\n`````",
    ),
    (
        "| Name | Link |\n|---|---|\n| doc | [the (draft) doc](https://x.com/a_(b)) |",
        "```\nName  Link\n----  ----------------\ndoc   the (draft) doc)\n```",
    ),
    (
        "| Name | Link |\n|---|---|\n| doc | [the (draft) doc](https://x.com/a_(b)) needs a sign-off from the finance team before the end of Friday |",
        "**doc** · Link [the (draft) doc](https://x.com/a_(b)) needs a sign-off from the finance team before the end of Friday",
    ),
    (
        "| **_x_** | ***y*** |\n|---|---|\n| __z__ | *w* _v_ |\n| ___q___ | **a *b* c** |",
        "```\nx  y\n-  -----\nz  w v\nq  a b c\n```",
    ),
    (
        "| aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | b |\n|---|---|\n| c | d |",
        "**c** · b d",
    ),
    (
        "| 名前 | 状態 |\n|:-:|--:|\n| 東京 | ✅ |\n| 👨\u{200d}👩\u{200d}👧 family | ⚠\u{fe0f} |\n| ok | ⚠ |",
        "```\n  名前     状態\n---------  ----\n  東京       ✅\n👨\u{200d}👩\u{200d}👧 family    ⚠\u{fe0f}\n   ok         ⚠\n```",
    ),
    (
        "| item | cost |\n|---|---|\n| a | $1,200 |\n| b | 30% |\n| c | -5kg |\n| d | ~ 7 |",
        "```\nitem    cost\n----  ------\na     $1,200\nb        30%\nc       -5kg\nd        ~ 7\n```",
    ),
    (
        "| item | cost |\n|---|---|\n| a | $1,200 |\n| b | n/a |",
        "```\nitem  cost\n----  ------\na     $1,200\nb     n/a\n```",
    ),
    (
        "| a | b | |\n|---|---|---|\n| 1 | 2 | |\n| 3 | | |",
        "```\na  b\n-  -\n1  2\n3\n```",
    ),
    (
        "| a | b |\n|---|---|\n| x _b_c y | _a_ _b_ |\n| _esc_ | snake_case_ |\n| _x_1 | (_y_) |",
        "```\na         b\n--------  -----------\nx _b_c y  a b\nesc       snake_case_\n_x_1      (y)\n```",
    ),
    (
        "| a | b |\n|---|---|\n| *not* | [x](y) |\n| a\\b | |pipe| |",
        "```\na    b\n---  -  ----\nnot  x\na\\b     pipe\n```",
    ),
    (
        "| a | b |\n|---|---|\n| ||secret|| | ~~old~~ |",
        "```\na  b\n-  -  ------  ---\n      secret  old\n```",
    ),
    (
        "| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n",
        "```\na  b\n-  -\n1  2\n```\n",
    ),
    (
        "| a\u{a0}| b |\n|---|---|\n| \u{feff}1 | 2\u{85} |",
        "```\na  b\n-  --\n1  2\u{85}\n```",
    ),
    (
        "| Day | From | To | Note |\n|---|---|---|---|\n| Mon | n/a | 5 | needs a sign-off from the finance team before the end of Friday |\n| **Tue** | 3 | 4 | — |\n| Wed | - | 9 | TBD |\n| | 1 | 2 | none |",
        "**Mon** · To 5 · Note needs a sign-off from the finance team before the end of Friday\n**Tue** · From 3 → To 4\n**Wed** · To 9\nFrom 1 → To 2",
    ),
    ("| only |\n|---|\n| a |\n| **b** |", "```\nonly\n----\na\nb\n```"),
    (
        "| only |\n|---|\n| wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww |\n| |",
        "- wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww\n- ",
    ),
    (
        "| Key | | Value |\n|---|---|---|\n| a | x | needs a sign-off from the finance team before the end of Friday |",
        "**a** — x · Value needs a sign-off from the finance team before the end of Friday",
    ),
    (
        "intro\n\u{0}MDT0\u{0}\n| a | b |\n|---|---|\n| 1 | 2 |",
        "intro\n\n```\na  b\n-  -\n1  2\n```",
    ),
    (
        "````\n```\n| a | b |\n|---|---|\n```\n````\n| c | d |\n|---|---|\n| 3 | 4 |",
        "````\n```\n| a | b |\n|---|---|\n```\n````\n```\nc  d\n-  -\n3  4\n```",
    ),
    (
        "a | b\n--- | ---\n1 | 2\nnot | a row?",
        "```\na    b\n---  ------\n1    2\nnot  a row?\n```",
    ),
    ("| a | b |\n| : --- : | ---: |\n| 1 | 2 |", "```\na  b\n-  -\n1  2\n```"),
    ("| a |\n|---|---|---|\n| 1 |", "| a |\n|---|---|---|\n| 1 |"),
    (
        "| a | b |\n|---|---|\n| 1 | 2 |\n|---|---|\n| 3 | 4 |",
        "```\na  b\n-  -\n1  2\n```\n|---|---|\n| 3 | 4 |",
    ),
    (
        "| a | b |\n|---|---|\n| 1 | 2 |\nafter | text\n\n| c |\n|---|\n| 3 |",
        "```\na  b\n-  -\n1  2\n```\nafter | text\n\n```\nc\n-\n3\n```",
    ),
    (
        "| A | B |\n|---|---|\n| x | y |\nno pipe line\n| p | q |",
        "```\nA  B\n-  -\nx  y\n```\nno pipe line\n| p | q |",
    ),
    (
        "| Before | After |\n|---|---|\n| 1 | 2 |",
        "```\nBefore  After\n------  -----\n     1      2\n```",
    ),
    (
        "| Item | Before | After |\n|---|---|---|\n| Long item name number one | was here | is now there for sure |",
        "**Long item name number one** · Before was here → After is now there for sure",
    ),
    (
        "| Item | Previous | Current |\n|---|---|---|\n| Long item name number one | was here | is now there for sure |",
        "**Long item name number one** · Previous was here → Current is now there for sure",
    ),
    (
        "| Item | BEFORE | ſtart | After |\n|---|---|---|---|\n| Long item name number one | 1 | 2 | is now there for sure ok |",
        "**Long item name number one** · BEFORE 1 · ſtart 2 · After is now there for sure ok",
    ),
    ("> a\n>\n> b", "> a\n> \u{200b}\n> b"),
    (">no space\n> \n>\n> ok", "> no space\n> \u{200b}\n> ok"),
    ("x\n>\ny", "x\n>\ny"),
    (">>> big\n> q", ">>> big\n> q"),
    ("> a\n```\n>\n```\n> b", "> a\n```\n>\n```\n> b"),
    (">\n> start\n>", "> start"),
    ("  >indented\n  >\n  > more", "  > indented\n  > \u{200b}\n  > more"),
    (
        ">\t\ttab\n>\u{a0}nbsp\n>\u{feff}bom",
        ">\t\ttab\n>\u{a0}nbsp\n>\u{feff}bom",
    ),
    ("> a\n>\n>\n>\n> b\n\n>\n\n> c", "> a\n> \u{200b}\n> b\n\n>\n\n> c"),
    ("> **bold**\n>- list\n>> nested", "> **bold**\n> - list\n>> nested"),
    (
        "> quote with table\n| a | b |\n|---|---|\n| 1 | 2 |\n>\n> end",
        "> quote with table\n```\na  b\n-  -\n1  2\n```\n> end",
    ),
    ("text with > inside and >> and a>b", "text with > inside and >> and a>b"),
];

/// Inputs and what `stripInlineMd` printed for each, in the Node code.
const NODE_STRIP_INLINE_MD: &[(&str, &str)] = &[
    ("**a** __b__ ***c*** ___d___", "a b c d"),
    ("`x` ``y`` ```z```", "x y z"),
    ("*it* _it_ snake_case _x_y", "it it snake_case _x_y"),
    ("a _b_ c _d_e_ f", "a b c _d_e_ f"),
    ("_lead_ and (_paren_)", "lead and (paren)"),
    ("_not_ *not*", "not not"),
    ("[link](http://a.b/(c)) ![img](x.png)", "link) img"),
    ("||spoil|| ~~strike~~", "spoil strike"),
    ("a|b \\ # ~", "a|b \\ # ~"),
    ("  many   spaces\n\nand\tlines  ", "many spaces and lines"),
    ("**unclosed *mixed _all", "*unclosed mixed _all"),
    ("`a`b`c`", "abc"),
    ("____", "____"),
    ("**", "**"),
    ("_é_ _ü_x", "é _ü_x"),
    ("x_y_z", "x_y_z"),
    ("_a_\n_b_", "a b"),
    ("\u{a0}nbsp\u{a0}", "nbsp"),
    ("\u{feff}bom", "bom"),
    ("a\u{85}b", "a\u{85}b"),
];

/// Strings and their `displayWidth`, in the Node code.
const NODE_DISPLAY_WIDTH: &[(&str, usize)] = &[
    ("", 0),
    ("abc", 3),
    ("日本", 4),
    ("😀", 2),
    ("👍\u{1f3fd}", 2),
    ("👨\u{200d}👩\u{200d}👧", 2),
    ("✅", 2),
    ("✔", 1),
    ("✔\u{fe0f}", 2),
    ("⚠", 1),
    ("⚠\u{fe0f}", 2),
    ("→—·", 3),
    ("🇦🇺", 2),
    ("é", 1),
    ("\u{200b}", 0),
    ("한국어", 6),
    ("ｆｕｌｌ", 8),
    ("←\u{fe0f}", 2),
    ("a\u{200d}b", 1),
    ("⭐x", 3),
];

/// Inputs, the limit, and the pieces `splitMessageFenceSafe` printed, in the Node code. Four inputs of the first
/// version of this table, where the Node code broke (pieces over the limit with emoji, CRLF fences), are in
/// `node_bugs_fixed_*` below, with what the Rust version makes instead.
const NODE_SPLIT: &[(&str, usize, &[&str])] = &[
    (
        "日本語のテキスト0\n日本語のテキスト1\n日本語のテキスト2\n日本語のテキスト3\n日本語のテキスト4\n日本語のテキスト5\n日本語のテキスト6\n日本語のテキスト7\n日本語のテキスト8\n日本語のテキスト9\n日本語のテキスト10\n日本語のテキスト11",
        30,
        &[
            "日本語のテキスト0\n日本語のテキスト1\n日本語のテキスト2",
            "日本語のテキスト3\n日本語のテキスト4\n日本語のテキスト5",
            "日本語のテキスト6\n日本語のテキスト7\n日本語のテキスト8",
            "日本語のテキスト9\n日本語のテキスト10",
            "日本語のテキスト11",
        ],
    ),
    (
        "```py\nprint(\"😀 0\")\nprint(\"😀 1\")\nprint(\"😀 2\")\nprint(\"😀 3\")\nprint(\"😀 4\")\nprint(\"😀 5\")\nprint(\"😀 6\")\nprint(\"😀 7\")\nprint(\"😀 8\")\nprint(\"😀 9\")\n```",
        40,
        &[
            "```py\nprint(\"😀 0\")\nprint(\"😀 1\")\n```",
            "```py\nprint(\"😀 2\")\nprint(\"😀 3\")\n```",
            "```py\nprint(\"😀 4\")\nprint(\"😀 5\")\n```",
            "```py\nprint(\"😀 6\")\nprint(\"😀 7\")\n```",
            "```py\nprint(\"😀 8\")\nprint(\"😀 9\")\n```",
        ],
    ),
    (
        "~~~\nl0 xxxxx\nl1 xxxxx\nl2 xxxxx\nl3 xxxxx\nl4 xxxxx\nl5 xxxxx\nl6 xxxxx\nl7 xxxxx\nl8 xxxxx\nl9 xxxxx\n~~~\nafter",
        30,
        &[
            "~~~\nl0 xxxxx\nl1 xxxxx\n~~~",
            "~~~\nl2 xxxxx\nl3 xxxxx\n~~~",
            "~~~\nl4 xxxxx\nl5 xxxxx\n~~~",
            "~~~\nl6 xxxxx\nl7 xxxxx\n~~~",
            "~~~\nl8 xxxxx\nl9 xxxxx\n~~~",
            "after",
        ],
    ),
    ("a\n\n\n\nb\n\n\n\nc\n\n\n\nd", 6, &["a\n\n\n\nb", "\n\n\nc\n\n", "\nd"]),
    (
        "  ```js\nl0 xxxxxx\nl1 xxxxxx\nl2 xxxxxx\nl3 xxxxxx\nl4 xxxxxx\nl5 xxxxxx\nl6 xxxxxx\nl7 xxxxxx\n  ```\ntail",
        30,
        &[
            "  ```js\nl0 xxxxxx\n```",
            "```js\nl1 xxxxxx\nl2 xxxxxx\n```",
            "```js\nl3 xxxxxx\nl4 xxxxxx\n```",
            "```js\nl5 xxxxxx\nl6 xxxxxx\n```",
            "```js\nl7 xxxxxx\n  ```\ntail",
        ],
    ),
    ("xxxxxxxxxx", 10, &["xxxxxxxxxx"]),
    ("xxxxxxxxxx", 3, &["xxx", "xxx", "xxx", "x"]),
    (
        "```js\naaaaaaaaaaaaaaaaaaaa\n```",
        12,
        &[
            "```js\naa\n```",
            "```js\naa\n```",
            "```js\naa\n```",
            "```js\naa\n```",
            "```js\naa\n```",
            "```js\naa\n```",
            "```js\naa\n```",
            "```js\naa\n```",
            "```js\naa\n```",
            "```js\naa\n```",
            "```js\n``\n```",
            "```js\n`",
        ],
    ),
    (
        "```\n```\n```\n```\nl0 xxxxx\nl1 xxxxx\nl2 xxxxx\nl3 xxxxx\nl4 xxxxx",
        12,
        &["l0 xxxxx", "l1 xxxxx", "l2 xxxxx", "l3 xxxxx", "l4 xxxxx"],
    ),
    (
        "intro\n```\nl0 xxxx\nl1 xxxx\nl2 xxxx\nl3 xxxx\n```\n```\nl0 xxxx\nl1 xxxx\nl2 xxxx\nl3 xxxx\n```",
        25,
        &[
            "intro\n```\nl0 xxxx\n```",
            "```\nl1 xxxx\nl2 xxxx\n```",
            "```\nl3 xxxx\n```\n```\n```",
            "```\nl0 xxxx\nl1 xxxx\n```",
            "```\nl2 xxxx\nl3 xxxx\n```",
        ],
    ),
    ("", 5, &[""]),
    ("\n\n\n", 2, &[]),
    (
        "one ``` inline\nl0 xxxxx\nl1 xxxxx\nl2 xxxxx\nl3 xxxxx\nl4 xxxxx",
        15,
        &[
            "one ``` inline",
            "l0 xxxxx",
            "l1 xxxxx",
            "l2 xxxxx",
            "l3 xxxxx",
            "l4 xxxxx",
        ],
    ),
    (
        "````\n```\ninner\n```\nl0 xxxx\nl1 xxxx\nl2 xxxx\nl3 xxxx\n````",
        20,
        &[
            "````\n```\ninner\n````",
            "````\nl0 xxxx\n````",
            "````\nl1 xxxx\n````",
            "````\nl2 xxxx\n````",
            "````\nl3 xxxx\n````",
        ],
    ),
];

#[test]
fn format_for_discord_matches_the_node_output_on_awkward_input() {
    for (i, (input, expected)) in NODE_FORMAT_FOR_DISCORD.iter().enumerate() {
        assert_eq!(format_for_discord(input), *expected, "case {i}: {input:?}");
    }
}

#[test]
fn strip_inline_md_matches_the_node_output_on_awkward_input() {
    for (i, (input, expected)) in NODE_STRIP_INLINE_MD.iter().enumerate() {
        assert_eq!(strip_inline_md(input), *expected, "case {i}: {input:?}");
    }
}

#[test]
fn display_width_matches_the_node_output() {
    for (input, expected) in NODE_DISPLAY_WIDTH {
        assert_eq!(display_width(input), *expected, "{input:?}");
    }
}

#[test]
fn split_matches_the_node_output_with_emoji_cjk_and_fences_at_the_cut_points() {
    for (i, (input, max, expected)) in NODE_SPLIT.iter().enumerate() {
        assert_eq!(
            split_message_fence_safe(input, *max),
            *expected,
            "case {i}: {input:?} at {max}"
        );
    }
}

#[test]
fn labeled_lines_match_the_node_output() {
    let rows = |r: &[&[&str]]| r.iter().map(|row| s(row)).collect::<Vec<_>>();
    assert_eq!(
        to_labeled_lines(
            &s(&["Day", "Before", "After", ""]),
            &[None, None, None, None],
            &rows(&[&["Tue", "1", "2", "x"], &["", "", "", ""], &["**B**", "—", "3", ""]]),
            ""
        ),
        s(&["**Tue** · Before 1 → After 2 — x", "**B** · After 3"])
    );
    assert_eq!(
        to_labeled_lines(&s(&["A", "B"]), &[], &rows(&[&["x", "y"], &["z"]]), "• "),
        s(&["• **x** · B y", "**z**"])
    );
    assert_eq!(
        to_labeled_lines(&s(&["Only"]), &[], &rows(&[&["a"], &[""], &["**b**"]]), "- "),
        s(&["- a", "- ", "- b"])
    );
    assert_eq!(
        to_labeled_lines(&s(&["", "", ""]), &[], &rows(&[&["a", "b", "c"]]), ""),
        s(&["**a** — b — c"])
    );
}

#[test]
fn ascii_grid_matches_the_node_output_with_explicit_alignment() {
    let grid = to_ascii_grid(
        &s(&["Name", "Qty", "Note"]),
        &[Some(Align::Center), None, Some(Align::Right)],
        &[s(&["a", "1", "x"]), s(&["**bb**", "22", ""]), s(&["c"])],
    );
    assert_eq!(
        grid,
        AsciiGrid {
            lines: s(&[
                "Name  Qty  Note",
                "----  ---  ----",
                " a      1     x",
                " bb    22",
                " c"
            ]),
            width: 15,
        }
    );
}

/// A fence whose reopening line leaves no room in a piece made the Node code loop until it ran out of memory
/// (`RangeError: Invalid array length`). Here the line is cut one character at a time instead, and nothing is lost.
#[test]
fn a_budget_of_nothing_still_ends_and_keeps_every_character() {
    let input = format!("  \n```\n  \n```\n{}", "z".repeat(8));
    let chunks = split_message_fence_safe(&input, 6);
    assert_eq!(chunks.concat().matches('z').count(), 8);
}

// ---------------------------------------------------------------------------
// Node bugs fixed in the Rust version (docs/rust-port/reports/E1.md, "Node bugs fixed in the Rust version").
// ---------------------------------------------------------------------------

/// The Node code's hard cut took `budget` code points, so emoji made pieces over the limit: it printed
/// `[42, 18]` units at 21 for the first input, `[25, 19]` at 20 for the second, `[42, 34]` at 25 for the third.
#[test]
fn node_bugs_fixed_no_piece_is_over_the_limit_with_emoji_at_the_cut() {
    let cases: &[(&str, usize, &[&str])] = &[
        (
            "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀",
            21,
            &["😀😀😀😀😀😀😀😀😀😀", "😀😀😀😀😀😀😀😀😀😀", "😀😀😀😀😀😀😀😀😀😀"],
        ),
        (
            "ab😀ab😀ab😀ab😀ab😀ab😀ab😀ab😀ab😀ab😀ab😀ab😀",
            20,
            &["ab😀ab😀ab😀ab😀ab😀", "ab😀ab😀ab😀ab😀ab😀", "ab😀ab😀"],
        ),
        (
            "```\n😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀",
            25,
            &[
                "```\n😀😀😀😀😀😀😀😀\n```",
                "```\n😀😀😀😀😀😀😀😀\n```",
                "```\n😀😀😀😀😀😀😀😀\n```",
                "```\n😀😀😀😀😀😀\n```",
            ],
        ),
    ];
    for (input, max, expected) in cases {
        let pieces = split_message_fence_safe(input, *max);
        assert_eq!(pieces, *expected, "{input:?} at {max}");
        assert!(pieces.iter().all(|p| utf16_len(p) <= *max));
    }
}

/// Where no reopened fence fits (a limit of a few characters), the Node code looped until it ran out of memory; the
/// pieces are now cut at the limit, so none is over it, and nothing is lost.
#[test]
fn node_bugs_fixed_a_limit_too_small_for_a_fence_still_keeps_every_piece_within_it() {
    for (input, max) in [
        ("a\n```\n\n\n```\nb", 6usize),
        ("  \n```\n  \n```\nzzzzzzzz", 6),
        ("```js\n😀😀😀", 5),
    ] {
        let pieces = split_message_fence_safe(input, max);
        assert!(
            pieces.iter().all(|p| utf16_len(p) <= max),
            "{input:?} at {max}: {pieces:?}"
        );
        let letters = |s: &str| s.chars().filter(|c| c.is_alphabetic() || *c == '😀').count();
        assert!(
            pieces.iter().map(|p| letters(p)).sum::<usize>() >= letters(input),
            "{input:?}: {pieces:?}"
        );
    }
    // A character wider than the limit is a piece of its own: the one thing that cannot fit.
    assert_eq!(split_message_fence_safe("😀😀", 1), vec!["😀", "😀"]);
}

/// The Node code did not see a fence line that ends in "\r" (CRLF text), so it split the block without closing and
/// reopening it: it printed `["```\r\ncode line\r\nl0 xxxxxxxx", "l1 xxxxxxxx\nl2 xxxxxxxx", ...]`.
#[test]
fn node_bugs_fixed_crlf_fences_are_fences_when_splitting() {
    let input =
        "```\r\ncode line\r\nl0 xxxxxxxx\nl1 xxxxxxxx\nl2 xxxxxxxx\nl3 xxxxxxxx\nl4 xxxxxxxx\nl5 xxxxxxxx\r\n```\r\n";
    assert_eq!(
        split_message_fence_safe(input, 30),
        vec![
            "```\r\ncode line\r\n```",
            "```\nl0 xxxxxxxx\n```",
            "```\nl1 xxxxxxxx\n```",
            "```\nl2 xxxxxxxx\n```",
            "```\nl3 xxxxxxxx\n```",
            "```\nl4 xxxxxxxx\n```",
            "```\nl5 xxxxxxxx\r\n```\r\n",
        ]
    );
    // The language tag is carried over without the "\r".
    let lines: String = (0..20).map(|i| format!("let v{i} = {i};\r\n")).collect();
    let pieces = split_message_fence_safe(&format!("```rust\r\n{lines}```\r\nafter"), 60);
    assert!(pieces.len() > 2);
    for p in &pieces {
        assert!(utf16_len(p) <= 60);
        assert_eq!(fence_lines(p) % 2, 0, "{p:?}");
    }
    assert!(pieces[1].starts_with("```rust\n"), "{:?}", pieces[1]);
}

/// The same fix keeps a table or a quote inside a CRLF fence as it was (the Node code redrew the table inside the
/// block).
#[test]
fn node_bugs_fixed_a_table_inside_a_crlf_fence_is_left_alone() {
    let table = "```\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n```";
    assert_eq!(format_tables_for_discord(table), table);
    let quote = "```\r\n>quoted code\r\n>\r\n```\r\n>outside";
    assert_eq!(
        format_quotes_for_discord(quote),
        "```\r\n>quoted code\r\n>\r\n```\r\n> outside"
    );
}

/// Generated replies (emoji, flags, ZWJ families, CJK, long words, code blocks, CRLF or LF) at many limits: no piece
/// is ever over the limit, every piece closes the fences it opens, and no character of the text is lost.
#[test]
fn no_piece_is_over_the_limit_and_fences_stay_balanced_on_generated_replies() {
    let mut seed: u64 = 0x5eed_e1;
    let mut next = |n: u64| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) % n
    };
    let words = [
        "word",
        "日本語",
        "😀",
        "🇵🇭",
        "👨‍👩‍👧",
        "é",
        "テキスト",
        "x",
        "🐒🐒🐒",
        "a-b",
    ];
    let content = |s: &str| -> String {
        s.split('\n')
            .filter(|l| !trim_start(l).starts_with("```"))
            .flat_map(|l| l.chars())
            .filter(|c| !is_whitespace(*c))
            .collect()
    };
    for round in 0..400 {
        let eol = if next(2) == 0 { "\n" } else { "\r\n" };
        let mut lines: Vec<String> = Vec::new();
        let mut in_fence = false;
        for _ in 0..next(40) + 1 {
            match next(10) {
                0 if !in_fence => {
                    lines.push(format!("```{}", ["", "js", "py"][next(3) as usize]));
                    in_fence = true;
                }
                0 => {
                    lines.push("```".into());
                    in_fence = false;
                }
                1 => lines.push(words[next(10) as usize].repeat(next(60) as usize + 1)),
                _ => {
                    let n = next(8) + 1;
                    lines.push((0..n).map(|_| words[next(10) as usize]).collect::<Vec<_>>().join(" "));
                }
            }
        }
        // A text that fits is returned as it is, so the generated one closes its block (a dangling fence in the
        // input is `dangling_fence_in_the_input_is_closed_on_output`).
        if in_fence {
            lines.push("```".into());
        }
        let text = lines.join(eol);
        let max = [20usize, 25, 33, 40, 64, 100, 2000][next(7) as usize];
        let pieces = split_message_fence_safe(&text, max);
        for p in &pieces {
            assert!(
                utf16_len(p) <= max,
                "round {round}: a piece of {} at {max}: {p:?}",
                utf16_len(p)
            );
            assert_eq!(fence_lines(p) % 2, 0, "round {round}: unbalanced at {max}: {p:?}");
        }
        assert_eq!(content(&pieces.join("\n")), content(&text), "round {round} at {max}");
    }
}
