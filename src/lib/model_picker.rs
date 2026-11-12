//! Port of `src/lib/model-picker.js`.
//!
//! The composer's model picker, as Claude Code's own: it pulls the models Claude Code itself lists, so a new
//! release shows up without a code change. With every AI (design 4.11), the small rules the picker and /model share
//! sit at the end of this file: the effort clamp, the context and price wording, the cost tier, and the matching
//! /model uses for "deepseek pro" or "flash". `lib/model_catalog.rs` puts each AI's models together with them.
//!
//! Claude Code's picker is drawn from a model catalog the CLI keeps: for each model its name, a section ("main" for
//! the newest of each family, "overflow" for the older ones under More models), its effort levels with the
//! Recommended one and any warning (Max on Opus: "3.5x or more usage"), and a notice (Fable). The CLI fetches it for
//! the signed-in account and caches it in `~/.claude/cache/model-catalog/<org>-<account>-cc.json`, and every CLI build
//! carries a signed copy of its own. `lib/model_catalog.rs` reads both (the newer wins) and hands the models here;
//! this file turns them into the picker's list. Nothing here names a model: a new release reaches the list through
//! the CLI's catalog, or through Tarsee's own model table (a newer version of a family than the catalog lists goes on
//! top).
//!
//! Page-free and side-effect free, so the tests run it on catalogs of their own. The browser has its own half
//! (`src/public/js/model-picker-core.js`), which reads what this file produces: the JSON these types serialise to is
//! the JSON the Node version sent, key for key.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::ai::provider_registry::{ModelPrice, PeakWindow, js_trim};
use crate::util::js;

/// The families in the order Claude Code shows them.
pub const FAMILIES: &[&str] = &["opus", "fable", "sonnet", "haiku"];

/// Effort ids as the CLI takes them, and the words Claude Code shows.
pub const EFFORT_NAMES: &[(&str, &str)] = &[
    ("low", "Low"),
    ("medium", "Medium"),
    ("high", "High"),
    ("xhigh", "Extra"),
    ("max", "Max"),
];
pub const EFFORT_IDS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
/// What every effort is set to when a chat has none of its own (the `ai.defaultEffort` setting overrides it).
pub const TARSEE_DEFAULT_EFFORT: &str = "medium";

const EFFORT_NOTE: &str = "Higher effort means more thorough responses, but takes longer and uses your limits faster.";
const MAX_TIP: &str =
    "May use a great many tokens, take long and hit token limits. Use it sparingly, for the hardest tasks.";
/// Fable on a subscription: included up to a share of the weekly limit, then it wants usage credits. Without them
/// the turn falls back down the model ladder (the provider's fallbackModel). Never a default.
pub const FABLE_NOTE: &str = "Uses usage credits past your weekly allowance";
const FABLE_TIP: &str = "Fable is included up to part of the weekly plan limit. Past that it needs usage credits; without them Tarsee answers on the next model down.";

/// The word Claude Code shows for an effort id (`EFFORT_NAMES[id]`).
pub fn effort_name(id: &str) -> Option<&'static str> {
    EFFORT_NAMES.iter().find(|(key, _)| *key == id).map(|(_, name)| *name)
}

/// `s.charAt(0).toUpperCase() + s.slice(1)`. A first character outside the basic plane is left alone, as the JS
/// (which saw only half of it) left it.
fn cap(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) if first.len_utf16() == 1 => first.to_uppercase().chain(chars).collect(),
        _ => s.to_string(),
    }
}

/// The effort's name: Claude Code's word for it, else the id with a capital.
fn effort_label(id: &str) -> String {
    effort_name(id).map(String::from).unwrap_or_else(|| cap(id))
}

/// `String(value)` for a JSON value that JavaScript counts as true; `None` for one it counts as false
/// (`value ? String(value) : ...`, and `value || fallback` where the value is text).
fn truthy_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if !js::truthy(value) {
        return None;
    }
    Some(match value {
        Value::String(text) => text.clone(),
        Value::Number(n) => js_number_to_string(n.as_f64().unwrap_or(0.0)),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => truthy_text(Some(other)).unwrap_or_else(|| match other {
                    Value::Bool(_) => "false".to_string(),
                    Value::Number(_) => "0".to_string(),
                    _ => String::new(),
                }),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
        Value::Null => String::new(),
    })
}

/// A picker id taken apart: "claude-opus-5-5" as the id, the family, the version and the name "Opus 5.5".
#[derive(Debug, Clone, PartialEq)]
pub struct PickerId {
    pub id: String,
    pub family: String,
    /// Major and minor; no minor counts as 0. The major is a double, as `Number(...)` made it in the JS, so a
    /// major of any length still compares as it did there.
    pub version: (f64, u32),
    pub name: String,
}

static PICKER_ID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^claude-([a-z]+)-([0-9]+)(?:-([0-9]{1,2}))?(?:-([0-9]{8}))?$").expect("the picker id pattern")
});

/// "claude-opus-5-5" (or with a date, "claude-haiku-4-5-20251001") as { id, family, version, name: "Opus 5.5" }.
pub fn parse_picker_id(raw: &str) -> Option<PickerId> {
    let lower = raw.to_lowercase();
    let lower = lower.strip_suffix("[1m]").unwrap_or(&lower);
    let m = PICKER_ID_RE.captures(lower)?;
    let family = &m[1];
    let major = &m[2];
    // Number("05") is 5: the minor is written back as a number, the major as it was typed.
    let minor: Option<u32> = m.get(3).map(|digits| digits.as_str().parse().unwrap_or(0));
    let (id_minor, name_minor) = match minor {
        Some(minor) => (format!("-{minor}"), format!(".{minor}")),
        None => (String::new(), String::new()),
    };
    Some(PickerId {
        id: format!("claude-{family}-{major}{id_minor}"),
        family: family.to_string(),
        version: (major.parse().unwrap_or(f64::INFINITY), minor.unwrap_or(0)),
        name: format!("{} {major}{name_minor}", cap(family)),
    })
}

/// Which of two versions is the newer: `Greater` when `a` is.
fn newer(a: (f64, u32), b: (f64, u32)) -> Ordering {
    a.0.partial_cmp(&b.0).unwrap_or(Ordering::Equal).then(a.1.cmp(&b.1))
}

fn family_rank(family: &str) -> usize {
    FAMILIES.iter().position(|f| *f == family).unwrap_or(FAMILIES.len())
}

/// One effort level of a model, as the picker shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EffortRow {
    pub id: String,
    pub name: String,
    pub recommended: bool,
    pub badge: Option<EffortBadge>,
    pub tip: Option<String>,
}

/// The badge on an effort level ("3.5x or more usage" on Max).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EffortBadge {
    pub text: String,
    /// "warning" or "neutral".
    pub tone: &'static str,
}

/// The note under a model (Fable's usage credits).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PickerNote {
    pub text: String,
    pub tip: String,
}

/// One model in the picker's list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerEntry {
    pub id: String,
    pub family: String,
    pub name: String,
    pub description: Option<String>,
    /// "main" or "more".
    pub section: &'static str,
    pub efforts: Vec<EffortRow>,
    pub effort_note: Option<String>,
    pub default_effort: Option<String>,
    /// Only on Fable: absent, not null, on every other model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<PickerNote>,
    /// The family's word, when picking this entry should follow the newest of its family.
    pub alias: Option<String>,
}

/// The picker's list: `{ main, more, effortNote, defaultEffort, source, fetchedAt }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picker {
    pub main: Vec<PickerEntry>,
    pub more: Vec<PickerEntry>,
    pub effort_note: String,
    pub default_effort: String,
    pub source: Option<String>,
    pub fetched_at: Option<i64>,
}

/// An entry while the list is being put together: with its version and the catalog's notice, which the finished
/// list leaves out.
#[derive(Debug, Clone)]
struct Draft {
    id: String,
    family: String,
    version: (f64, u32),
    name: String,
    description: Option<String>,
    section: &'static str,
    efforts: Vec<EffortRow>,
    effort_note: Option<String>,
    default_effort: Option<String>,
    notice: Option<String>,
    note: Option<PickerNote>,
}

impl Draft {
    fn finish(self, section: &'static str, alias: Option<String>) -> PickerEntry {
        PickerEntry {
            id: self.id,
            family: self.family,
            name: self.name,
            description: self.description,
            section,
            efforts: self.efforts,
            effort_note: self.effort_note,
            default_effort: self.default_effort,
            note: self.note,
            alias,
        }
    }
}

/// One effort option from the catalog ({ id, name, badge: { message, variant }, tooltip: { content } }).
fn effort_from(option: &Value) -> Option<EffortRow> {
    let id = truthy_text(option.get("id")).unwrap_or_default().to_lowercase();
    if id.is_empty() {
        return None;
    }
    let badge = option.get("badge");
    let badge_text = truthy_text(badge.and_then(|b| b.get("message"))).unwrap_or_default();
    let recommended = badge_text.eq_ignore_ascii_case("recommended");
    let warning = badge.and_then(|b| b.get("variant")).and_then(Value::as_str) == Some("warning");
    Some(EffortRow {
        name: truthy_text(option.get("name")).unwrap_or_else(|| effort_label(&id)),
        id,
        recommended,
        badge: (!badge_text.is_empty() && !recommended).then_some(EffortBadge {
            text: badge_text,
            tone: if warning { "warning" } else { "neutral" },
        }),
        tip: truthy_text(option.get("tooltip").and_then(|t| t.get("content"))),
    })
}

/// The levels a model has no catalog entry for: Claude Code's five, Tarsee's default marked.
fn fallback_efforts(default_effort: &str) -> Vec<EffortRow> {
    EFFORT_IDS
        .iter()
        .map(|id| EffortRow {
            id: id.to_string(),
            name: effort_label(id),
            recommended: *id == default_effort,
            badge: None,
            tip: (*id == "max").then(|| MAX_TIP.to_string()),
        })
        .collect()
}

fn finish_entry(mut entry: Draft, default_effort: &str) -> Draft {
    // Medium is marked Recommended only where the CLI says so; with no word from the CLI, Tarsee's default is.
    if !entry.efforts.is_empty()
        && !entry.efforts.iter().any(|e| e.recommended)
        && let Some(default) = entry.efforts.iter_mut().find(|e| e.id == default_effort)
    {
        default.recommended = true;
    }
    if entry.family == "fable" {
        let tip = entry
            .notice
            .iter()
            .map(String::as_str)
            .chain([FABLE_TIP])
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(". ")
            .replace("..", ".");
        entry.note = Some(PickerNote {
            text: FABLE_NOTE.to_string(),
            tip,
        });
    }
    entry
}

/// A catalog model ({ id, name, section, description, thinking, runtime, notice }) as a picker entry.
fn entry_from_catalog(model: &Value, default_effort: &str) -> Option<Draft> {
    let p = parse_picker_id(&truthy_text(model.get("id")).unwrap_or_default())?;
    let runtime = model.get("runtime");
    let thinking = model.get("thinking");
    let family = truthy_text(runtime.and_then(|r| r.get("family")))
        .unwrap_or_else(|| p.family.clone())
        .to_lowercase();
    let takes_effort = thinking.and_then(|t| t.get("type")).and_then(Value::as_str) == Some("effort");
    let efforts: Vec<EffortRow> = match thinking.and_then(|t| t.get("effort_options")).and_then(Value::as_array) {
        Some(options) if takes_effort => options.iter().filter_map(effort_from).collect(),
        _ => Vec::new(),
    };
    let effort_note = truthy_text(thinking.and_then(|t| t.get("description")))
        .or_else(|| (!efforts.is_empty()).then(|| EFFORT_NOTE.to_string()));
    let default = truthy_text(runtime.and_then(|r| r.get("default_effort")))
        .or_else(|| efforts.iter().find(|e| e.recommended).map(|e| e.id.clone()))
        .unwrap_or_default()
        .to_lowercase();
    Some(finish_entry(
        Draft {
            id: p.id,
            family,
            version: p.version,
            name: truthy_text(model.get("name")).unwrap_or(p.name),
            description: truthy_text(model.get("description")),
            section: if model.get("section").and_then(Value::as_str) == Some("main") {
                "main"
            } else {
                "more"
            },
            efforts,
            effort_note,
            default_effort: (!default.is_empty()).then_some(default),
            notice: truthy_text(model.get("notice").and_then(|n| n.get("text"))),
            note: None,
        },
        default_effort,
    ))
}

/// A model the catalog does not list (only an id is known): the levels of its family's newest, or the five.
fn entry_from_id(id: &str, template: Option<&Draft>, default_effort: &str) -> Option<Draft> {
    let p = parse_picker_id(id)?;
    let efforts = match template {
        Some(t) if !t.efforts.is_empty() => t
            .efforts
            .iter()
            .map(|e| EffortRow {
                recommended: false,
                ..e.clone()
            })
            .collect(),
        _ => fallback_efforts(default_effort),
    };
    let from_template =
        |pick: fn(&Draft) -> &Option<String>| template.and_then(|t| pick(t).clone()).filter(|text| !text.is_empty());
    Some(finish_entry(
        Draft {
            id: p.id,
            family: p.family,
            version: p.version,
            name: p.name,
            description: from_template(|t| &t.description),
            section: "main",
            efforts,
            effort_note: from_template(|t| &t.effort_note).or_else(|| Some(EFFORT_NOTE.to_string())),
            default_effort: from_template(|t| &t.default_effort),
            notice: from_template(|t| &t.notice),
            note: None,
        },
        default_effort,
    ))
}

/// What [`build_picker`] is given.
#[derive(Debug, Clone)]
pub struct PickerOptions<'a> {
    /// The CLI's catalog config (`{ models, provider_alias_targets }`), or `None`.
    pub catalog: Option<&'a Value>,
    /// Model ids known some other way (`lib/model_catalog.rs`: Tarsee's model table): used in full when there is no
    /// catalog, and otherwise only for a version newer than the catalog's newest of a family.
    pub known_ids: &'a [&'a str],
    /// The family words the CLI takes for "the newest": a main entry picks its family's word, so a chat stays on
    /// the newest when a new version comes out (Claude Code does the same).
    pub aliases: &'a [&'a str],
    pub source: Option<&'a str>,
    pub fetched_at: Option<i64>,
    pub default_effort: &'a str,
}

impl Default for PickerOptions<'_> {
    fn default() -> Self {
        PickerOptions {
            catalog: None,
            known_ids: &[],
            aliases: &[],
            source: None,
            fetched_at: None,
            default_effort: TARSEE_DEFAULT_EFFORT,
        }
    }
}

/// The picker's list: `{ main: [...], more: [...], effortNote, source, fetchedAt, defaultEffort }`.
pub fn build_picker(options: &PickerOptions<'_>) -> Picker {
    let default_effort = options.default_effort;
    // Insertion order matters (the JS used a Map): the catalog's own order decides ties.
    let mut by_id: Vec<Draft> = Vec::new();
    let known_family = |family: &str| FAMILIES.contains(&family);
    let models = options.catalog.and_then(|c| c.get("models")).and_then(Value::as_array);
    for model in models.into_iter().flatten() {
        if let Some(entry) = entry_from_catalog(model, default_effort)
            && known_family(&entry.family)
            && !by_id.iter().any(|e| e.id == entry.id)
        {
            by_id.push(entry);
        }
    }
    let from_catalog = !by_id.is_empty();
    if !from_catalog {
        // No catalog: every known id of the four families; the newest of each goes on top.
        for id in options.known_ids {
            if let Some(mut entry) = entry_from_id(id, None, default_effort)
                && known_family(&entry.family)
                && !by_id.iter().any(|e| e.id == entry.id)
            {
                entry.section = "more";
                by_id.push(entry);
            }
        }
    }

    // The newest of each family: the catalog's main entry, unless a newer version of it is known (a release the
    // catalog has not caught up with yet).
    let mut top: Vec<Option<Draft>> = vec![None; FAMILIES.len()];
    for entry in &by_id {
        let slot = &mut top[family_rank(&entry.family)];
        let beats = slot
            .as_ref()
            .is_none_or(|cur| newer(entry.version, cur.version) == Ordering::Greater);
        if beats && (!from_catalog || entry.section == "main") {
            *slot = Some(entry.clone());
        }
    }
    for (rank, family) in FAMILIES.iter().enumerate() {
        if top[rank].is_none() {
            // The first of the newest, as a stable sort by version, newest first, would put it.
            let mut newest: Option<&Draft> = None;
            for entry in by_id.iter().filter(|e| e.family == *family) {
                if newest.is_none_or(|n| newer(entry.version, n.version) == Ordering::Greater) {
                    newest = Some(entry);
                }
            }
            top[rank] = newest.cloned();
        }
    }
    if from_catalog {
        for id in options.known_ids {
            let Some(p) = parse_picker_id(id) else { continue };
            if !known_family(&p.family) || by_id.iter().any(|e| e.id == p.id) {
                continue;
            }
            let rank = family_rank(&p.family);
            if let Some(cur) = &top[rank]
                && newer(p.version, cur.version) != Ordering::Greater
            {
                continue;
            }
            let Some(entry) = entry_from_id(&p.id, top[rank].as_ref(), default_effort) else {
                continue;
            };
            by_id.push(entry.clone());
            top[rank] = Some(entry);
        }
    }

    let targets = options.catalog.and_then(|c| c.get("provider_alias_targets"));
    let main: Vec<(Draft, Option<String>)> = top
        .into_iter()
        .flatten()
        .map(|entry| {
            let target = targets
                .and_then(|t| t.get(&entry.family))
                .and_then(|t| truthy_text(t.get("default")))
                .and_then(|id| parse_picker_id(&id))
                .map(|p| p.id);
            // The family's word follows the newest; when the CLI would send it to an older one, the entry keeps its
            // own id.
            let follows = options.aliases.contains(&entry.family.as_str())
                && target.as_ref().is_none_or(|target| *target == entry.id);
            let alias = follows.then(|| entry.family.clone());
            (entry, alias)
        })
        .collect();
    let main_ids: HashSet<&str> = main.iter().map(|(e, _)| e.id.as_str()).collect();
    let mut more: Vec<Draft> = by_id
        .iter()
        .filter(|e| !main_ids.contains(e.id.as_str()))
        .cloned()
        .collect();
    more.sort_by(|a, b| newer(b.version, a.version).then_with(|| family_rank(&a.family).cmp(&family_rank(&b.family))));

    let effort_note = main
        .iter()
        .find_map(|(e, _)| e.effort_note.clone().filter(|note| !note.is_empty()))
        .unwrap_or_else(|| EFFORT_NOTE.to_string());
    Picker {
        main: main.into_iter().map(|(e, alias)| e.finish("main", alias)).collect(),
        more: more.into_iter().map(|e| e.finish("more", None)).collect(),
        effort_note,
        default_effort: default_effort.to_string(),
        source: if from_catalog {
            options.source.map(String::from)
        } else {
            Some("known models".to_string())
        },
        fetched_at: if from_catalog { options.fetched_at } else { None },
    }
}

/* ------------------------------------------------------------------ the catalog inside the CLI's own build */

pub const CATALOG_MARKER: &str = r#"{$schema:"https://downloads.claude.ai/model-catalog/"#;

/// Where the object that starts at `start` ends (the index after its closing brace), strings skipped. `None` if it
/// never closes. Indexes are byte offsets into `text`.
pub fn literal_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    // May go below zero (a text that starts with a closing brace), as the JS counter did.
    let mut depth = 0i64;
    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'"' || c == b'\'' {
            i += 1;
            while i < bytes.len() && bytes[i] != c {
                if bytes[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            continue;
        }
        if c == b'{' || c == b'[' {
            depth += 1;
        } else if c == b'}' || c == b']' {
            depth -= 1;
            if depth == 0 {
                return Some(i + 1);
            }
        }
        i += 1;
    }
    None
}

/// JavaScript's `\s`.
fn is_js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

fn is_ascii_digit(unit: u16) -> bool {
    (0x30..=0x39).contains(&unit)
}

/// JavaScript's `[\w$]`.
fn is_word(unit: u16) -> bool {
    is_ascii_digit(unit)
        || (0x41..=0x5A).contains(&unit)
        || (0x61..=0x7A).contains(&unit)
        || unit == u16::from(b'_')
        || unit == u16::from(b'$')
}

/// How many units at the start of `window` are a number as a build writes one (`1e6`, `.5`, `-3.`): the JS
/// `/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i`. 0 when there is none.
fn number_len(window: &[u16]) -> usize {
    let at = |i: usize| window.get(i).copied();
    let digits_from = |mut i: usize| {
        while at(i).is_some_and(is_ascii_digit) {
            i += 1;
        }
        i
    };
    let mut i = 0;
    if at(i) == Some(u16::from(b'-')) {
        i += 1;
    }
    let whole_end = digits_from(i);
    if whole_end > i {
        i = whole_end;
        if at(i) == Some(u16::from(b'.')) {
            i = digits_from(i + 1);
        }
    } else if at(i) == Some(u16::from(b'.')) && at(i + 1).is_some_and(is_ascii_digit) {
        i = digits_from(i + 1);
    } else {
        return 0;
    }
    if matches!(at(i), Some(e) if e == u16::from(b'e') || e == u16::from(b'E')) {
        let mut j = i + 1;
        if matches!(at(j), Some(sign) if sign == u16::from(b'+') || sign == u16::from(b'-')) {
            j += 1;
        }
        let exponent_end = digits_from(j);
        if exponent_end > j {
            i = exponent_end;
        }
    }
    i
}

/// A JavaScript object literal as the CLI's build writes it (`{id:"x",n:1e6,on:!0,off:!1,none:void 0}`) as JSON
/// text. Read as data, never run. Fails on anything that is not plain data (a call, a variable).
pub fn js_literal_to_json(src: &str) -> anyhow::Result<String> {
    // In UTF-16 units, as the JS walked it, so the position in the error is the same one.
    let src: Vec<u16> = src.encode_utf16().collect();
    let n = src.len();
    let unit = |c: char| c as u16;
    let mut out: Vec<u16> = Vec::with_capacity(n + n / 8);
    let push_str = |out: &mut Vec<u16>, text: &str| out.extend(text.encode_utf16());
    let mut i = 0;
    while i < n {
        let c = src[i];
        if c == unit('"') || c == unit('\'') {
            let mut s: Vec<u16> = Vec::new();
            let mut j = i + 1;
            while j < n && src[j] != c {
                if src[j] == unit('\\') {
                    match src.get(j + 1).copied() {
                        Some(e) if e == unit('x') => {
                            push_str(&mut s, "\\u00");
                            s.extend(&src[(j + 2).min(n)..(j + 4).min(n)]);
                            j += 3;
                        }
                        Some(e) if e == unit('\'') => {
                            s.push(e);
                            j += 1;
                        }
                        Some(e) if e == unit('\n') => j += 1,
                        Some(e) => {
                            s.push(unit('\\'));
                            s.push(e);
                            j += 1;
                        }
                        None => {
                            push_str(&mut s, "\\undefined");
                            j += 1;
                        }
                    }
                } else if src[j] == unit('"') {
                    push_str(&mut s, "\\\"");
                } else {
                    s.push(src[j]);
                }
                j += 1;
            }
            out.push(unit('"'));
            out.extend(s);
            out.push(unit('"'));
            i = j + 1;
            continue;
        }
        if c == unit('!') && matches!(src.get(i + 1), Some(d) if *d == unit('0') || *d == unit('1')) {
            push_str(&mut out, if src[i + 1] == unit('0') { "true" } else { "false" });
            i += 2;
            continue;
        }
        let len = number_len(&src[i..(i + 40).min(n)]);
        if len > 0 {
            let mut t = String::from_utf16_lossy(&src[i..i + len]);
            if t.starts_with('.') || t.starts_with("-.") {
                t = t.replacen('.', "0.", 1);
            }
            if t.ends_with('.') {
                t.push('0');
            }
            push_str(&mut out, &t);
            i += len;
            continue;
        }
        let starts_word = (0x41..=0x5A).contains(&c) || (0x61..=0x7A).contains(&c) || c == unit('_') || c == unit('$');
        if starts_word {
            let mut j = i;
            while j < n && is_word(src[j]) {
                j += 1;
            }
            let word = String::from_utf16_lossy(&src[i..j]);
            let mut k = j;
            while k < n && is_js_space(src[k]) {
                k += 1;
            }
            if src.get(k) == Some(&unit(':')) {
                push_str(&mut out, &Value::String(word).to_string());
                i = j;
                continue;
            }
            match word.as_str() {
                "true" | "false" | "null" => {
                    push_str(&mut out, &word);
                    i = j;
                }
                "void" => {
                    k = j;
                    while k < n && (is_js_space(src[k]) || is_ascii_digit(src[k])) {
                        k += 1;
                    }
                    push_str(&mut out, "null");
                    i = k;
                }
                "undefined" => {
                    push_str(&mut out, "null");
                    i = j;
                }
                _ => anyhow::bail!("not plain data at {i}: {word}"),
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    Ok(String::from_utf16_lossy(&out))
}

/// The model catalog a CLI build carries.
#[derive(Debug, Clone, PartialEq)]
pub struct BuildCatalog {
    /// When it was issued, in milliseconds since 1970; `None` when the build gives no readable date.
    pub issued_at: Option<i64>,
    pub version: Option<Value>,
    /// The Claude Code surface's config (`{ id: "cc", models, ... }`).
    pub config: Value,
}

/// The model catalog a CLI build carries, from the text around its marker: `{ issuedAt, config }` for the Claude
/// Code surface ("cc"), or `None`. Fails when what follows the marker is not plain data or not JSON.
pub fn catalog_from_build_text(text: &str) -> anyhow::Result<Option<BuildCatalog>> {
    let Some(at) = text.find(CATALOG_MARKER) else {
        return Ok(None);
    };
    let Some(end) = literal_end(text, at) else {
        return Ok(None);
    };
    let doc: Value = serde_json::from_str(&js_literal_to_json(&text[at..end])?)?;
    let config = doc
        .get("surfaces")
        .and_then(|s| s.get("cc"))
        .and_then(|cc| cc.get("model_selector_config"))
        .and_then(Value::as_array)
        .and_then(|configs| {
            configs
                .iter()
                .find(|c| c.get("id").and_then(Value::as_str) == Some("cc"))
        });
    let Some(config) = config else { return Ok(None) };
    let models = config.get("models").and_then(Value::as_array);
    if models.is_none_or(|models| models.is_empty()) {
        return Ok(None);
    }
    Ok(Some(BuildCatalog {
        issued_at: doc
            .get("issued_at")
            .and_then(Value::as_str)
            .and_then(js::ms_from_iso)
            .filter(|ms| *ms != 0),
        version: doc.get("version").filter(|v| js::truthy(v)).cloned(),
        config: config.clone(),
    }))
}

/* ------------------------------------------------------------------ every AI's models (design 4.11) */

/// The note on a model Codex runs: its replies arrive whole, one message at a time, not word by word.
pub const MESSAGE_AT_A_TIME: &str = "Replies appear a message at a time";
/// What a model that must be verified before it can be used says instead of being pickable.
pub const VERIFY_FIRST: &str = "Verify it in Settings > AI first";

fn effort_rank(id: &str) -> usize {
    EFFORT_IDS.iter().position(|e| *e == id).unwrap_or(EFFORT_IDS.len())
}

/// The level a model runs at, from the levels it has: the one asked for, else the nearest one it has below (as
/// Claude Code does), else its lowest. Nothing asked for is the default (Medium). `None` when the model takes no
/// level at all.
pub fn clamp_effort<S: AsRef<str>>(levels: &[S], want: Option<&str>) -> Option<String> {
    clamp_effort_or(levels, want, None)
}

/// [`clamp_effort`] with the level to use when none is asked for (the JS `fallback` argument).
pub fn clamp_effort_or<S: AsRef<str>>(levels: &[S], want: Option<&str>, fallback: Option<&str>) -> Option<String> {
    let mut have: Vec<String> = Vec::new();
    for level in levels {
        let level = level.as_ref();
        if level.is_empty() {
            continue;
        }
        let level = level.to_lowercase();
        if !have.contains(&level) {
            have.push(level);
        }
    }
    if have.is_empty() {
        return None;
    }
    have.sort_by_key(|id| effort_rank(id));
    let wanted = [want, fallback]
        .into_iter()
        .flatten()
        .find(|w| !w.is_empty())
        .unwrap_or(TARSEE_DEFAULT_EFFORT)
        .to_lowercase();
    if have.contains(&wanted) {
        return Some(wanted);
    }
    if let Some(rank) = EFFORT_IDS.iter().position(|e| *e == wanted) {
        for id in EFFORT_IDS[..=rank].iter().rev() {
            if have.iter().any(|h| h == id) {
                return Some(id.to_string());
            }
        }
    }
    have.into_iter().next()
}

/// The effort rows a picker shows for a model's levels: names, the one it runs at by default marked Recommended.
pub fn effort_rows<S: AsRef<str>>(levels: &[S], default_effort: &str) -> Vec<EffortRow> {
    let ids: Vec<String> = levels
        .iter()
        .map(|l| l.as_ref().to_lowercase())
        .filter(|id| !id.is_empty())
        .collect();
    let recommended = clamp_effort(&ids, Some(default_effort));
    ids.into_iter()
        .map(|id| EffortRow {
            name: effort_label(&id),
            recommended: recommended.as_deref() == Some(id.as_str()),
            badge: None,
            tip: (id == "max").then(|| MAX_TIP.to_string()),
            id,
        })
        .collect()
}

/// A context window in words a person reads: 1000000 as "1M", 400000 as "400K", 1500000 as "1.5M".
pub fn context_label(tokens: Option<u64>) -> Option<String> {
    let n = tokens.filter(|n| *n > 0)? as f64;
    if n >= 1_000_000.0 {
        let millions: f64 = js_to_fixed(n / 1_000_000.0, 1).parse().unwrap_or(0.0);
        return Some(format!("{}M", js_number_to_string(millions)));
    }
    Some(format!("{}K", js_number_to_string((n / 1_000.0 + 0.5).floor())))
}

fn usd(n: f64) -> String {
    format!(
        "${}",
        if n >= 10.0 {
            js_to_fixed(n, 0)
        } else {
            js_to_fixed(n, 2)
        }
    )
}

/// A model's list price as one line: "$0.15 in · $0.60 out per million tokens, est.". `None` without a price.
pub fn price_hint(price: Option<&ModelPrice>) -> Option<String> {
    let price = price?;
    if price.input == 0.0 && price.output == 0.0 {
        return Some("Free".to_string());
    }
    Some(format!(
        "{} in · {} out per million tokens, est.",
        usd(price.input),
        usd(price.output)
    ))
}

/// A rough cost tier for a metered model, from its price in USD per million tokens, weighted three tokens in for
/// one out (a chat's usual mix): "$" under $0.50, "$$" under $5, "$$$" above. `None` with no price, or when it is
/// free.
pub fn cost_tier(price: Option<&ModelPrice>) -> Option<&'static str> {
    let price = price?;
    // A model with peak hours (DeepSeek: peak rates for 35 hours of the week, half price the rest) is tiered at its
    // week-average price, which is what a chat that runs at any hour pays; the hint still gives the peak figures.
    let factor = week_average_factor(price.peak.as_ref());
    let blended = ((price.input * 3.0 + price.output) / 4.0) * factor;
    if blended <= 0.0 {
        return None;
    }
    Some(if blended < 0.5 {
        "$"
    } else if blended < 5.0 {
        "$$"
    } else {
        "$$$"
    })
}

/// What a peak-priced rate averages to over a week, as a factor of the peak rate (the registry's DeepSeek window).
/// 1 for a price with no peak hours.
pub fn week_average_factor(peak: Option<&PeakWindow>) -> f64 {
    let Some(peak) = peak else { return 1.0 };
    let off = peak.off_peak_factor;
    if !off.is_finite() || off <= 0.0 {
        return 1.0;
    }
    let hours_per_day: f64 = peak
        .hours_utc
        .iter()
        .map(|(from, to)| (f64::from(*to).min(24.0) - f64::from(*from).max(0.0)).max(0.0))
        .sum();
    let share = ((peak.days.len() as f64 * hours_per_day) / (7.0 * 24.0)).min(1.0);
    share + (1.0 - share) * off
}

/// A Claude family's cost tier when there is no per-token price to go by (Anthropic reports the exact cost after
/// each reply).
pub fn family_cost_tier(family: &str) -> Option<&'static str> {
    match family.to_lowercase().as_str() {
        "haiku" => Some("$$"),
        "sonnet" | "opus" | "fable" => Some("$$$"),
        _ => None,
    }
}

static FAMILY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[/-])(fable|opus|sonnet|haiku)(?:-|$)").expect("the family pattern"));

/// A Claude family named in an id or a slug ("claude-sonnet-5-5", "~anthropic/claude-haiku-latest"), or `None`.
pub fn family_of(id: &str) -> Option<&'static str> {
    let lower = id.to_lowercase();
    let found = FAMILY_RE.captures(&lower)?.get(1)?.as_str().to_string();
    FAMILIES.iter().copied().find(|f| *f == found)
}

/// A name for a model known only by its id: "~anthropic/claude-sonnet-latest" as "Claude Sonnet (latest)".
pub fn name_from_slug(id: &str) -> String {
    let s = id.strip_prefix('~').unwrap_or(id);
    let tail = s.rsplit_once('/').map_or(s, |(_, tail)| tail);
    let cut = tail.len().saturating_sub("-latest".len());
    let latest = tail.is_char_boundary(cut) && tail[cut..].eq_ignore_ascii_case("-latest");
    let stem = if latest { &tail[..cut] } else { tail };
    let words: Vec<String> = stem
        .split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            if w.starts_with(|c: char| c.is_ascii_digit()) {
                w.to_string()
            } else {
                cap(w)
            }
        })
        .collect();
    let name = if words.is_empty() {
        s.to_string()
    } else {
        words.join(" ")
    };
    if latest { format!("{name} (latest)") } else { name }
}

/// What someone typed, or a model's id or name, made comparable: lower case, Claude Code's "[1m]" off the end,
/// no space around it.
fn norm_word(s: &str) -> String {
    let lower = s.to_lowercase();
    js_trim(lower.strip_suffix("[1m]").unwrap_or(&lower)).to_string()
}

fn tokens_of(s: &str) -> Vec<String> {
    norm_word(s)
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|t| !t.is_empty())
        .map(String::from)
        .collect()
}

/// A model `/model` can be matched against: an entry of any AI's list.
pub trait ModelChoice {
    /// The AI it is on (the provider's public id).
    fn provider(&self) -> &str;
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    /// Its ref ("deepseek:deepseek-flash"), when the entry carries one.
    fn model_ref(&self) -> Option<&str> {
        None
    }
}

/// An entry held as JSON: `{ provider, id, name, ref? }`.
impl ModelChoice for Value {
    fn provider(&self) -> &str {
        self.get("provider").and_then(Value::as_str).unwrap_or("")
    }
    fn id(&self) -> &str {
        self.get("id").and_then(Value::as_str).unwrap_or("")
    }
    fn name(&self) -> &str {
        self.get("name").and_then(Value::as_str).unwrap_or("")
    }
    fn model_ref(&self) -> Option<&str> {
        self.get("ref").and_then(Value::as_str)
    }
}

/// How well a model fits what someone typed: 100 its exact id or name, down to 30 a piece of either; 0 not at all.
fn fit<C: ModelChoice + ?Sized>(choice: &C, q: &str, q_tokens: &[String]) -> u32 {
    let id = norm_word(choice.id());
    let name = norm_word(choice.name());
    if q.is_empty() {
        return 0;
    }
    if id == q || name == q || norm_word(choice.model_ref().unwrap_or("")) == q {
        return 100;
    }
    if id.strip_prefix('~').unwrap_or(&id).rsplit('/').next() == Some(q) {
        return 90;
    }
    let hay: Vec<String> = tokens_of(&id).into_iter().chain(tokens_of(&name)).collect();
    if !q_tokens.is_empty() && q_tokens.iter().all(|t| hay.contains(t)) {
        return 70;
    }
    if !q_tokens.is_empty() && q_tokens.iter().all(|t| hay.iter().any(|h| h.starts_with(t.as_str()))) {
        return 50;
    }
    if id.contains(q) || name.contains(q) {
        return 30;
    }
    0
}

/// What [`match_models`] found: the best-fitting choices, and how well they fit (0 when nothing does).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelMatches<'a, C> {
    pub matches: Vec<&'a C>,
    pub score: u32,
}

/// The models that best fit what someone typed (/model's "flash", "deepseek pro", "opus 4.6"), from choices
/// `[{ provider, id, name, ref?, selectable? }]`. Only the best-fitting ones come back: one is a clear answer,
/// several are choices to list. The same model on two AIs (GPT-6 Luna on the ChatGPT plan and an OpenAI key) goes
/// to `prefer_provider`, the default AI, when it is one of them. Returns `{ matches, score }`.
pub fn match_models<'a, C: ModelChoice>(
    choices: &'a [C],
    query: &str,
    prefer_provider: Option<&str>,
) -> ModelMatches<'a, C> {
    let q = norm_word(query);
    let q_tokens = tokens_of(&q);
    let mut best = 0;
    let mut matches: Vec<&C> = Vec::new();
    let mut seen: HashSet<(&str, &str)> = HashSet::new();
    for choice in choices {
        if !seen.insert((choice.provider(), choice.id())) {
            continue;
        }
        let score = fit(choice, &q, &q_tokens);
        if score == 0 {
            continue;
        }
        if score > best {
            best = score;
            matches = vec![choice];
        } else if score == best {
            matches.push(choice);
        }
    }
    if matches.len() > 1
        && let Some(prefer) = prefer_provider.filter(|p| !p.is_empty())
        && matches.iter().map(|m| norm_word(m.id())).collect::<HashSet<_>>().len() == 1
    {
        let mine: Vec<&C> = matches.iter().copied().filter(|m| m.provider() == prefer).collect();
        if mine.len() == 1 {
            matches = mine;
        }
    }
    ModelMatches { matches, score: best }
}

/* ------------------------------------------------------------------ numbers as JavaScript writes them */

/// The digits of a finite number above zero, exactly: `(digits, exponent)` with the value being
/// `d.ddd... x 10^exponent`. A double's decimal expansion ends within 767 digits, so nothing here is rounded.
fn exact_digits(x: f64) -> (Vec<u8>, i32) {
    let text = format!("{x:.800e}");
    let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
    let digits = mantissa.bytes().filter(u8::is_ascii_digit).map(|d| d - b'0').collect();
    (digits, exponent.parse().unwrap_or(0))
}

/// Adds one to a number written as digits; true when it grew a digit ("99" to "100").
fn increment(digits: &mut Vec<u8>) -> bool {
    for digit in digits.iter_mut().rev() {
        if *digit == 9 {
            *digit = 0;
        } else {
            *digit += 1;
            return false;
        }
    }
    digits.insert(0, 1);
    true
}

/// `x.toFixed(digits)` for a finite number below 1e21: a tie goes up, where Rust's own formatting rounds it to
/// even (JavaScript writes 1.25 as "1.3", `format!("{:.1}")` as "1.2").
pub(crate) fn js_to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return js_number_to_string(x);
    }
    let negative = x < 0.0;
    let x = x.abs();
    let (exact, exponent) = if x == 0.0 { (vec![0], 0) } else { exact_digits(x) };
    // The digits with the decimal point after the first `whole` of them.
    let (mut all, whole): (Vec<u8>, usize) = if exponent >= 0 {
        (exact, exponent as usize + 1)
    } else {
        let mut padded = vec![0u8; exponent.unsigned_abs() as usize];
        padded.extend(exact);
        (padded, 1)
    };
    let keep = whole + digits;
    if all.len() <= keep {
        all.resize(keep + 1, 0);
    }
    let round_up = all[keep] >= 5;
    all.truncate(keep);
    let mut whole = whole;
    if round_up && increment(&mut all) {
        whole += 1;
    }
    let text: String = all.iter().map(|d| char::from(b'0' + d)).collect();
    let (int_part, frac_part) = text.split_at(whole);
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    out.push_str(int_part);
    if digits > 0 {
        out.push('.');
        out.push_str(frac_part);
    }
    out
}

/// `Number(x.toPrecision(digits))`: a finite number rounded to so many significant digits, a tie going up.
pub(crate) fn js_to_precision(x: f64, digits: usize) -> f64 {
    if !x.is_finite() || x == 0.0 || digits == 0 {
        return x;
    }
    let (mut exact, mut exponent) = exact_digits(x.abs());
    if exact.len() <= digits {
        exact.resize(digits + 1, 0);
    }
    let round_up = exact[digits] >= 5;
    exact.truncate(digits);
    if round_up && increment(&mut exact) {
        exact.truncate(digits);
        exponent += 1;
    }
    let mantissa: String = exact.iter().map(|d| char::from(b'0' + d)).collect();
    let text = format!(
        "{}{}.{}e{}",
        if x < 0.0 { "-" } else { "" },
        &mantissa[..1],
        &mantissa[1..],
        exponent
    );
    text.parse().unwrap_or(x)
}

/// `String(x)` for a number, as JavaScript writes it: the shortest digits that read back the same, "1e-7" below a
/// millionth and "1e+21" from there up.
pub(crate) fn js_number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }
    let text = format!("{:e}", x.abs());
    let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    // The value is 0.digits x 10^n.
    let n = exponent.parse::<i32>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat(n.unsigned_abs() as usize))
    } else {
        let sign = if n - 1 < 0 { '-' } else { '+' };
        let power = (n - 1).abs();
        if k == 1 {
            format!("{digits}e{sign}{power}")
        } else {
            format!("{}.{}e{sign}{power}", &digits[..1], &digits[1..])
        }
    };
    if x < 0.0 { format!("-{body}") } else { body }
}

#[cfg(test)]
mod tests;
