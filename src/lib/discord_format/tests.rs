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
    assert!(out.split('\n').any(|l| right_r.is_match(l) || l.contains("   R")), "{out}");
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
    let rows: Vec<&str> = out.split('\n').filter(|l| l.contains("ok") || l.contains("no")).collect();
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
    let width = lines[1..lines.len() - 1].iter().map(|l| display_width(l)).max().unwrap();
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
    assert!(js_text::trim_end(&out).ends_with(opener), "closing fence must match");
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
        assert!(!half.is_match(c), "half marker in: {}", crate::util::js::utf16_tail(c, 10));
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
    assert!(js_text::trim_end(last).ends_with("```"), "{}", crate::util::js::utf16_tail(last, 20));
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
        let clean = Regex::new(r"<tool_call>(?s:.)*?</tool_call>").unwrap().replace_all(&clean, "");
        let clean = Regex::new(r"<tool_response>(?s:.)*?</tool_response>").unwrap().replace_all(&clean, "");
        let clean = Regex::new(r"\n{3,}").unwrap().replace_all(&clean, "\n\n");
        format_for_discord(js_text::trim(&clean))
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
    assert_eq!(js_text::trim("\u{FEFF} x \u{85}"), "x \u{85}");
}
