//! Port of the cases of `test/model-picker.test.js` that exercise `model-picker.js` alone.
//!
//! The composer's model picker: its list is Claude Code's own catalog (the account's cache or the one in the
//! installed CLI's build, the newer wins), the newest of each family on top in Claude Code's order, older ones under
//! More models newest first, a newer version than the catalog lists going on top by itself, the effort levels with
//! the CLI's Recommended one, Max's warning and Fable's note. Every entry is picked by its exact id.
//!
//! The cases that read Claude Code's files, resolve a family word, or go through the chat routes come with the
//! packages that hold `lib/model_catalog.rs`, the routes and the turn.

use serde_json::{Value, json};

use super::*;

fn effort(id: &str, name: &str, extra: Value) -> Value {
    let mut option = json!({"id": id, "name": name});
    if let (Some(option), Some(extra)) = (option.as_object_mut(), extra.as_object()) {
        option.extend(extra.clone());
    }
    option
}

fn rec() -> Value {
    json!({"badge": {"message": "Recommended", "variant": "neutral"}})
}

/// The five levels, `recommended` marked as the CLI marks it, Max carrying `max`.
fn levels(recommended: &str, max: Value) -> Value {
    let mark = |id: &str| if id == recommended { rec() } else { json!({}) };
    json!({
        "type": "effort",
        "description": "Higher effort means more thorough responses, but takes longer and uses your limits faster.",
        "effort_options": [
            effort("low", "Low", json!({})),
            effort("medium", "Medium", mark("medium")),
            effort("high", "High", mark("high")),
            effort("xhigh", "Extra", mark("xhigh")),
            effort("max", "Max", max),
        ],
    })
}

fn model_with(id: &str, name: &str, section: &str, family: &str, recommended: &str, max: Value, extra: Value) -> Value {
    let mut model = json!({
        "id": id, "name": name, "section": section,
        "thinking": levels(recommended, max),
        "runtime": {"family": family, "default_effort": recommended},
    });
    if let (Some(model), Some(extra)) = (model.as_object_mut(), extra.as_object()) {
        model.extend(extra.clone());
    }
    model
}

fn model(id: &str, name: &str, section: &str, family: &str, recommended: &str) -> Value {
    model_with(id, name, section, family, recommended, json!({}), json!({}))
}

/// Shaped like `<claude home>/cache/model-catalog/<org>-<account>-cc.json` (the order is the catalog's own).
fn catalog() -> Value {
    let mut opus_4_6 = model("claude-opus-4-6", "Opus 4.6", "overflow", "opus", "high");
    opus_4_6["thinking"] = json!({"type": "effort", "effort_options": [
        effort("low", "Low", json!({})), effort("medium", "Medium", json!({})), effort("high", "High", rec()),
        effort("max", "Max", json!({})),
    ]});
    json!({
        "models": [
            model_with("claude-opus-5-5", "Opus 5.5", "main", "opus", "medium",
                json!({"badge": {"message": "3.5× or more usage", "variant": "warning"}, "tooltip": {"content": "Claude thinks longer with Max effort."}}),
                json!({})),
            model_with("claude-fable-5-1", "Fable 5.1", "main", "fable", "high", json!({}),
                json!({"notice": {"text": "Fable is the most capable model and draws down usage much faster than Opus"}})),
            model("claude-sonnet-5-5", "Sonnet 5.5", "main", "sonnet", "medium"),
            model("claude-haiku-5-5", "Haiku 5.5", "main", "haiku", "medium"),
            {"id": "claude-haiku-4-5-20251001", "name": "Haiku 4.5", "section": "overflow", "thinking": {"type": "none"}, "runtime": {"family": "haiku"}},
            model("claude-sonnet-5", "Sonnet 5", "overflow", "sonnet", "high"),
            model("claude-opus-5", "Opus 5", "overflow", "opus", "high"),
            model("claude-fable-5", "Fable 5", "overflow", "fable", "high"),
            model("claude-opus-4-8", "Opus 4.8", "overflow", "opus", "high"),
            model("claude-opus-4-7", "Opus 4.7", "overflow", "opus", "xhigh"),
            opus_4_6,
            model("claude-sonnet-4-6", "Sonnet 4.6", "overflow", "sonnet", "high"),
        ],
        "provider_alias_targets": {
            "opus": {"default": "claude-opus-5-5"}, "fable": {"default": "claude-fable-5-1"},
            "sonnet": {"default": "claude-sonnet-5-5"}, "haiku": {"default": "claude-haiku-5-5"},
        },
    })
}

fn names(list: &[PickerEntry]) -> Vec<&str> {
    list.iter().map(|e| e.name.as_str()).collect()
}

fn recommended(entry: &PickerEntry) -> Vec<&str> {
    entry
        .efforts
        .iter()
        .filter(|e| e.recommended)
        .map(|e| e.id.as_str())
        .collect()
}

fn named<'a>(list: &'a [PickerEntry], name: &str) -> &'a PickerEntry {
    list.iter()
        .find(|e| e.name == name)
        .unwrap_or_else(|| panic!("no entry called {name}"))
}

/// Tarsee offers no family words in the list: the bundled CLI would take one to an older model.
fn picker(catalog: Option<&Value>, known_ids: &[&str]) -> Picker {
    build_picker(&PickerOptions {
        catalog,
        known_ids,
        ..PickerOptions::default()
    })
}

fn from_catalog() -> Picker {
    let catalog = catalog();
    build_picker(&PickerOptions {
        catalog: Some(&catalog),
        source: Some("test"),
        fetched_at: Some(1),
        ..PickerOptions::default()
    })
}

// --- model picker: the list from Claude Code's catalog ---

#[test]
fn the_newest_of_each_family_on_top_in_claude_codes_order_opus_fable_sonnet_haiku() {
    let p = from_catalog();
    assert_eq!(names(&p.main), ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
    assert!(
        p.main.iter().all(|e| e.alias.is_none()),
        "every entry is picked by its exact id"
    );
    assert_eq!((p.source.as_deref(), p.fetched_at), (Some("test"), Some(1)));
}

#[test]
fn the_older_ones_under_more_models_newest_first() {
    let p = from_catalog();
    assert_eq!(
        names(&p.more),
        [
            "Opus 5",
            "Fable 5",
            "Sonnet 5",
            "Opus 4.8",
            "Opus 4.7",
            "Opus 4.6",
            "Sonnet 4.6",
            "Haiku 4.5"
        ]
    );
    assert!(
        p.more.iter().all(|e| e.alias.is_none()),
        "an older one is picked by its own id"
    );
    assert_eq!(
        named(&p.more, "Haiku 4.5").id,
        "claude-haiku-4-5",
        "a dated id is folded into its base id"
    );
}

#[test]
fn the_effort_levels_as_claude_code_names_them_with_the_clis_recommended_one_per_model() {
    let p = from_catalog();
    let opus = &p.main[0];
    assert_eq!(
        opus.efforts.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
        ["Low", "Medium", "High", "Extra", "Max"]
    );
    assert_eq!(recommended(opus), ["medium"]);
    assert_eq!(recommended(&p.main[1]), ["high"], "Fable: High is the CLI's own");
    assert_eq!(recommended(named(&p.more, "Opus 4.7")), ["xhigh"]);
    assert_eq!(
        p.effort_note,
        "Higher effort means more thorough responses, but takes longer and uses your limits faster."
    );
}

#[test]
fn max_carries_its_warning_where_the_cli_gives_one() {
    let p = from_catalog();
    let max = |entry: &PickerEntry| entry.efforts.iter().find(|e| e.id == "max").cloned().unwrap();
    assert_eq!(
        max(&p.main[0]).badge,
        Some(EffortBadge {
            text: "3.5× or more usage".to_string(),
            tone: "warning"
        })
    );
    assert_eq!(
        max(&p.main[0]).tip.as_deref(),
        Some("Claude thinks longer with Max effort.")
    );
    assert_eq!(max(&p.main[2]).badge, None);
}

#[test]
fn fable_carries_the_usage_credits_note_and_every_fable_does() {
    let p = from_catalog();
    let note = p.main[1].note.as_ref().unwrap();
    assert_eq!(note.text, FABLE_NOTE);
    assert!(note.tip.contains("draws down usage much faster than Opus"));
    assert_eq!(named(&p.more, "Fable 5").note.as_ref().unwrap().text, FABLE_NOTE);
    assert_eq!(p.main[0].note, None);
    // On every other model the note is absent from the JSON, not null.
    assert!(serde_json::to_value(&p.main[0]).unwrap().get("note").is_none());
}

#[test]
fn no_levels_where_the_model_has_no_effort() {
    let p = from_catalog();
    assert!(named(&p.more, "Haiku 4.5").efforts.is_empty());
}

#[test]
fn no_word_from_the_cli_on_which_level_tarsees_default_medium_is_the_recommended_one() {
    let bare = json!({"models": [{
        "id": "claude-sonnet-5-5", "name": "Sonnet 5.5", "section": "main",
        "thinking": {"type": "effort", "effort_options": [
            effort("low", "Low", json!({})), effort("medium", "Medium", json!({})), effort("high", "High", json!({})),
        ]},
    }]});
    let q = picker(Some(&bare), &[]);
    assert_eq!(recommended(&q.main[0]), ["medium"]);
}

// --- model picker: a new model shows up by itself ---

#[test]
fn a_newer_catalog_the_new_one_on_top_the_one_it_replaced_under_more_models() {
    let mut next = catalog();
    let models = next["models"].as_array_mut().unwrap();
    for m in models.iter_mut() {
        if m["id"] == "claude-sonnet-5-5" {
            m["section"] = json!("overflow");
        }
    }
    models.insert(0, model("claude-sonnet-6", "Sonnet 6", "main", "sonnet", "medium"));
    next["provider_alias_targets"]["sonnet"] = json!({"default": "claude-sonnet-6"});
    let p = picker(Some(&next), &[]);
    assert_eq!(names(&p.main), ["Opus 5.5", "Fable 5.1", "Sonnet 6", "Haiku 5.5"]);
    assert_eq!(p.main[2].id, "claude-sonnet-6");
    assert_eq!(p.more[0].name, "Sonnet 5.5", "newest first");
}

#[test]
fn a_version_known_here_that_the_catalog_does_not_list_yet_on_top_with_its_familys_levels() {
    let catalog = catalog();
    let p = picker(Some(&catalog), &["claude-opus-6", "claude-opus-4-1", "claude-mythos-5"]);
    assert_eq!(names(&p.main), ["Opus 6", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
    assert_eq!(p.main[0].id, "claude-opus-6");
    assert_eq!(
        p.main[0].efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        ["low", "medium", "high", "xhigh", "max"]
    );
    assert_eq!(p.more[0].name, "Opus 5.5");
    assert!(
        !names(&p.more).contains(&"Opus 4.1"),
        "an older one the catalog does not offer stays out"
    );
    assert!(
        !p.main.iter().chain(&p.more).any(|e| e.family == "mythos"),
        "only the four families"
    );
}

#[test]
fn no_catalog_at_all_the_models_known_here_the_newest_of_each_family_on_top() {
    let p = picker(
        None,
        &[
            "claude-opus-5-5",
            "claude-opus-5",
            "claude-sonnet-5-5",
            "claude-haiku-4-5",
            "claude-haiku-5-5",
            "claude-fable-5-1",
            "claude-sonnet-4-6",
        ],
    );
    assert_eq!(names(&p.main), ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
    assert_eq!(names(&p.more), ["Opus 5", "Sonnet 4.6", "Haiku 4.5"]);
    assert_eq!(recommended(&p.main[2]), ["medium"]);
    assert_eq!(p.source.as_deref(), Some("known models"));
    assert_eq!(p.fetched_at, None);
}

#[test]
fn names_come_from_the_ids_when_nothing_else_gives_one() {
    assert_eq!(parse_picker_id("claude-opus-5-5").unwrap().name, "Opus 5.5");
    assert_eq!(parse_picker_id("claude-sonnet-6").unwrap().name, "Sonnet 6");
    assert_eq!(
        parse_picker_id("claude-haiku-4-5-20251001").unwrap().id,
        "claude-haiku-4-5"
    );
    assert_eq!(parse_picker_id("gpt-5"), None);
}

// --- model picker: the catalog inside the CLI's build ---

const BUILD: &str = r#"var a=1;function l(e){return e}var py={$schema:"https://downloads.claude.ai/model-catalog/v1/schema.json",schema_version:1,version:2902,issued_at:"2026-10-23T00:57:07Z",surfaces:{cc:{model_selector_config:[{id:"cc",models:[{id:"claude-opus-5-5",name:"Opus 5.5",section:"main",quick_select:!0,hidden:!1,runtime:{max_input_tokens:1e6,family:"opus",default_effort:"medium"},thinking:{type:"effort",effort_options:[{id:"medium",name:"Medium",badge:{message:"Recommended",variant:"neutral"}},{id:"max",name:"Max",tooltip:{content:"Uses \xD7 more, it's \"a lot\""}}]}},{id:"claude-sonnet-5",name:"Sonnet 5",section:"overflow",x:void 0,y:.5}]}]}}},zz=2;"#;

#[test]
fn reads_the_object_literal_as_data() {
    let text = &BUILD[BUILD.find("{$schema").unwrap()..];
    let end = literal_end(text, 0).unwrap();
    let doc: Value = serde_json::from_str(&js_literal_to_json(&text[..end]).unwrap()).unwrap();
    assert_eq!(doc["version"], 2902);
    let m = &doc["surfaces"]["cc"]["model_selector_config"][0]["models"];
    assert_eq!(m[0]["quick_select"], true);
    assert_eq!(m[0]["hidden"], false);
    assert_eq!(m[0]["runtime"]["max_input_tokens"].as_f64(), Some(1e6));
    assert_eq!(
        m[0]["thinking"]["effort_options"][1]["tooltip"]["content"],
        "Uses × more, it's \"a lot\""
    );
    assert_eq!(m[1]["x"], Value::Null);
    assert_eq!(m[1]["y"], 0.5);
}

#[test]
fn never_runs_anything_a_call_or_a_variable_is_refused() {
    let call = js_literal_to_json("{a:process.exit(1)}").unwrap_err();
    assert_eq!(call.to_string(), "not plain data at 3: process");
    let variable = js_literal_to_json("{a:b}").unwrap_err();
    assert_eq!(variable.to_string(), "not plain data at 3: b");
}

#[test]
fn finds_claude_codes_surface_in_the_builds_text() {
    let c = catalog_from_build_text(BUILD).unwrap().unwrap();
    assert_eq!(c.issued_at, js::ms_from_iso("2026-10-23T00:57:07Z"));
    assert_eq!(c.version, Some(json!(2902)));
    let ids: Vec<&str> = c.config["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["claude-opus-5-5", "claude-sonnet-5"]);
    assert_eq!(catalog_from_build_text("no catalog here").unwrap(), None);
}

// --- What the JS suite left to other files, or did not test ---

#[test]
fn the_whole_list_is_the_json_the_node_version_sent() {
    // What `JSON.stringify(buildPicker({ catalog, knownIds: ["claude-opus-6"], aliases: { opus: true, haiku: true },
    // source: "test", fetchedAt: 1 }))` gave for a catalog of two models, key for key and in the same order.
    let catalog = json!({
        "models": [
            model_with("claude-fable-5-1", "Fable 5.1", "main", "fable", "high", json!({}),
                json!({"description": "Most capable", "notice": {"text": "Draws down usage faster."}})),
            {"id": "claude-haiku-4-5-20251001", "name": "Haiku 4.5", "section": "main", "thinking": {"type": "none"}, "runtime": {"family": "haiku"}},
        ],
        "provider_alias_targets": {"haiku": {"default": "claude-haiku-4-5"}},
    });
    let p = build_picker(&PickerOptions {
        catalog: Some(&catalog),
        known_ids: &["claude-opus-6"],
        aliases: &["opus", "haiku"],
        source: Some("test"),
        fetched_at: Some(1),
        ..PickerOptions::default()
    });
    let want = r#"{"main":[{"id":"claude-opus-6","family":"opus","name":"Opus 6","description":null,"section":"main","efforts":[{"id":"low","name":"Low","recommended":false,"badge":null,"tip":null},{"id":"medium","name":"Medium","recommended":true,"badge":null,"tip":null},{"id":"high","name":"High","recommended":false,"badge":null,"tip":null},{"id":"xhigh","name":"Extra","recommended":false,"badge":null,"tip":null},{"id":"max","name":"Max","recommended":false,"badge":null,"tip":"May use a great many tokens, take long and hit token limits. Use it sparingly, for the hardest tasks."}],"effortNote":"Higher effort means more thorough responses, but takes longer and uses your limits faster.","defaultEffort":null,"alias":"opus"},{"id":"claude-fable-5-1","family":"fable","name":"Fable 5.1","description":"Most capable","section":"main","efforts":[{"id":"low","name":"Low","recommended":false,"badge":null,"tip":null},{"id":"medium","name":"Medium","recommended":false,"badge":null,"tip":null},{"id":"high","name":"High","recommended":true,"badge":null,"tip":null},{"id":"xhigh","name":"Extra","recommended":false,"badge":null,"tip":null},{"id":"max","name":"Max","recommended":false,"badge":null,"tip":null}],"effortNote":"Higher effort means more thorough responses, but takes longer and uses your limits faster.","defaultEffort":"high","note":{"text":"Uses usage credits past your weekly allowance","tip":"Draws down usage faster. Fable is included up to part of the weekly plan limit. Past that it needs usage credits; without them Tarsee answers on the next model down."},"alias":null},{"id":"claude-haiku-4-5","family":"haiku","name":"Haiku 4.5","description":null,"section":"main","efforts":[],"effortNote":null,"defaultEffort":null,"alias":"haiku"}],"more":[],"effortNote":"Higher effort means more thorough responses, but takes longer and uses your limits faster.","defaultEffort":"medium","source":"test","fetchedAt":1}"#;
    assert_eq!(serde_json::to_string(&p).unwrap(), want);
}

#[test]
fn a_family_word_is_offered_only_where_the_cli_would_send_it_to_that_very_model() {
    let mut catalog = catalog();
    catalog["provider_alias_targets"]["opus"] = json!({"default": "claude-opus-4-8"});
    let p = build_picker(&PickerOptions {
        catalog: Some(&catalog),
        aliases: &["opus", "sonnet"],
        ..PickerOptions::default()
    });
    let alias = |name: &str| named(&p.main, name).alias.as_deref();
    assert_eq!(alias("Opus 5.5"), None, "the CLI would send the word to an older Opus");
    assert_eq!(alias("Sonnet 5.5"), Some("sonnet"));
    assert_eq!(alias("Haiku 5.5"), None, "not a word the CLI was said to take");
}

#[test]
fn picker_ids_are_read_as_javascript_read_them() {
    let id = |raw: &str| parse_picker_id(raw).map(|p| (p.id, p.family, p.version, p.name));
    let parsed = |id: &str, family: &str, version: (f64, u32), name: &str| {
        Some((id.to_string(), family.to_string(), version, name.to_string()))
    };
    assert_eq!(
        id("CLAUDE-OPUS-5-5[1M]"),
        parsed("claude-opus-5-5", "opus", (5.0, 5), "Opus 5.5")
    );
    // The minor is written back as a number, the major as it was typed.
    assert_eq!(
        id("claude-opus-05-07"),
        parsed("claude-opus-05-7", "opus", (5.0, 7), "Opus 05.7")
    );
    // Eight digits after the major are a date, not a minor.
    assert_eq!(
        id("claude-opus-4-20251001"),
        parsed("claude-opus-4", "opus", (4.0, 0), "Opus 4")
    );
    assert_eq!(
        id("claude-opus-20251001"),
        parsed("claude-opus-20251001", "opus", (20251001.0, 0), "Opus 20251001")
    );
    // A major of any length is still a number, as it was in the JS.
    assert_eq!(
        id("claude-opus-99999999999999999999-1"),
        parsed(
            "claude-opus-99999999999999999999-1",
            "opus",
            (1e20, 1),
            "Opus 99999999999999999999.1"
        )
    );
    for not in [
        "",
        "claude-opus",
        "claude-opus-",
        "claude--5",
        "claude-opus-4-5-6",
        "claude-opus-4-123",
        " claude-opus-5",
        "claude-opus-5\n",
        "claude-3-5-sonnet-20241022",
        "anthropic/claude-opus-5",
    ] {
        assert_eq!(id(not), None, "{not:?}");
    }
}

#[test]
fn a_literal_ends_where_its_brace_closes_strings_skipped() {
    assert_eq!(literal_end("{a:{b:[1,2]}}x", 0), Some(13));
    assert_eq!(literal_end("x{a:'}'}y", 1), Some(8));
    assert_eq!(literal_end(r#"{"a":"\"}"}"#, 0), Some(11));
    assert_eq!(literal_end("{a:1", 0), None);
    assert_eq!(
        literal_end("}{", 0),
        None,
        "a closing brace first never comes back to zero"
    );
    assert_eq!(literal_end("{}", 5), None);
    assert_eq!(literal_end("é{}", 2), Some(4), "positions are bytes of the text");
}

#[test]
fn a_builds_literal_becomes_json_text() {
    let json = |src: &str| js_literal_to_json(src).unwrap();
    assert_eq!(
        json("{n:-.5,m:5.,k:-3.25e-7,j:1E3}"),
        r#"{"n":-0.5,"m":5.0,"k":-3.25e-7,"j":1E3}"#
    );
    assert_eq!(
        json("{a:!0,b:!1,c:void 0,d:undefined,e:null,f:true,g:false}"),
        r#"{"a":true,"b":false,"c":null,"d":null,"e":null,"f":true,"g":false}"#
    );
    assert_eq!(
        json(r#"{a:"x\ty",b:'it\'s',c:"q\"q",d:'d"d'}"#),
        r#"{"a":"x\ty","b":"it's","c":"q\"q","d":"d\"d"}"#
    );
    assert_eq!(json("{a :1, b\n:2}"), "{\"a\" :1, \"b\"\n:2}");
    // A \x escape, which JSON does not have, becomes a \u one.
    assert_eq!(json(r#"{a:"\xe9é😀"}"#), [r#"{"a":""#, r"\", r#"u00e9é😀"}"#].concat());
    assert_eq!(json("{a:void 0 ,b:void 12345}"), r#"{"a":null,"b":null}"#);
    assert_eq!(
        json(r#"{"quoted":1,'single':2,$x:3,_y:4}"#),
        r#"{"quoted":1,"single":2,"$x":3,"_y":4}"#
    );
    // The position in the error counts as JavaScript counts: the tarsier is two units.
    assert_eq!(
        js_literal_to_json("{a:'🐒', b:c}").unwrap_err().to_string(),
        "not plain data at 11: c"
    );
}

#[test]
fn a_build_with_no_claude_code_surface_or_no_models_has_no_catalog() {
    let other_surface = BUILD.replace(r#"id:"cc",models"#, r#"id:"ccd",models"#);
    assert_eq!(catalog_from_build_text(&other_surface).unwrap(), None);
    let no_models = BUILD.replace(
        r#"models:[{id:"claude-opus-5-5""#,
        r#"models:[],was:[{id:"claude-opus-5-5""#,
    );
    assert_eq!(catalog_from_build_text(&no_models).unwrap(), None);
    let cut = &BUILD[..BUILD.len() - 30];
    assert_eq!(catalog_from_build_text(cut).unwrap(), None, "the literal never closes");
    let undated = BUILD
        .replace("version:2902", "version:0")
        .replace(r#"issued_at:"2026-10-23T00:57:07Z""#, r#"issued_at:"nonsense""#);
    let c = catalog_from_build_text(&undated).unwrap().unwrap();
    assert_eq!((c.issued_at, c.version), (None, None));
    // Something that is not plain data after the marker is an error, as the JS threw.
    let code = BUILD.replace("x:void 0", "x:run()");
    assert!(
        catalog_from_build_text(&code)
            .unwrap_err()
            .to_string()
            .starts_with("not plain data at ")
    );
}

#[test]
fn an_effort_is_clamped_to_one_the_model_has() {
    let all = ["low", "medium", "high", "xhigh", "max"];
    assert_eq!(clamp_effort(&all, Some("xhigh")).as_deref(), Some("xhigh"));
    assert_eq!(
        clamp_effort(&all, None).as_deref(),
        Some("medium"),
        "nothing asked for is the default"
    );
    assert_eq!(clamp_effort(&all, Some("")).as_deref(), Some("medium"));
    // The nearest one below, as Claude Code does; else its lowest.
    assert_eq!(
        clamp_effort(&["low", "high", "max"], Some("xhigh")).as_deref(),
        Some("high")
    );
    assert_eq!(
        clamp_effort(&["low", "high", "max"], Some("medium")).as_deref(),
        Some("low")
    );
    assert_eq!(clamp_effort(&["high", "xhigh"], Some("low")).as_deref(), Some("high"));
    assert_eq!(clamp_effort(&["max", "low"], Some("MAX")).as_deref(), Some("max"));
    assert_eq!(clamp_effort(&["LOW", "High"], Some("medium")).as_deref(), Some("low"));
    // A level Tarsee doesn't know ranks last; asked for by name it is still taken.
    assert_eq!(clamp_effort(&["turbo", "low"], Some("turbo")).as_deref(), Some("turbo"));
    assert_eq!(clamp_effort(&["turbo", "low"], Some("bogus")).as_deref(), Some("low"));
    assert_eq!(clamp_effort(&["turbo"], Some("high")).as_deref(), Some("turbo"));
    assert_eq!(
        clamp_effort(&[] as &[&str], Some("high")),
        None,
        "a model that takes no level"
    );
    assert_eq!(clamp_effort(&["", ""], Some("high")), None);
    // The fallback is what "nothing asked for" means.
    assert_eq!(clamp_effort_or(&all, None, Some("high")).as_deref(), Some("high"));
    assert_eq!(clamp_effort_or(&all, Some("low"), Some("high")).as_deref(), Some("low"));
    assert_eq!(clamp_effort_or(&all, None, Some("")).as_deref(), Some("medium"));
}

#[test]
fn effort_rows_name_the_levels_and_mark_the_one_a_model_runs_at_by_default() {
    let rows = effort_rows(&["low", "high", "max"], "medium");
    assert_eq!(
        serde_json::to_value(&rows).unwrap(),
        json!([
            {"id": "low", "name": "Low", "recommended": true, "badge": null, "tip": null},
            {"id": "high", "name": "High", "recommended": false, "badge": null, "tip": null},
            {"id": "max", "name": "Max", "recommended": false, "badge": null,
             "tip": "May use a great many tokens, take long and hit token limits. Use it sparingly, for the hardest tasks."},
        ])
    );
    let odd = effort_rows(&["XHIGH", "", "turbo"], "xhigh");
    assert_eq!(
        odd.iter()
            .map(|e| (e.id.as_str(), e.name.as_str(), e.recommended))
            .collect::<Vec<_>>(),
        [("xhigh", "Extra", true), ("turbo", "Turbo", false)]
    );
    assert!(effort_rows(&[] as &[&str], "medium").is_empty());
    assert_eq!(effort_name("xhigh"), Some("Extra"));
    assert_eq!(effort_name("turbo"), None);
}

#[test]
fn a_context_window_reads_as_a_person_reads_it() {
    let label = |n: u64| context_label(Some(n));
    assert_eq!(label(1_000_000).as_deref(), Some("1M"));
    assert_eq!(label(400_000).as_deref(), Some("400K"));
    assert_eq!(label(1_500_000).as_deref(), Some("1.5M"));
    assert_eq!(label(1_050_000).as_deref(), Some("1.1M"));
    assert_eq!(label(1_049_999).as_deref(), Some("1M"));
    // A tie goes up, as toFixed sends it (1.25 and 1.45 are written "1.3" and "1.4": the second is below the half).
    assert_eq!(label(1_250_000).as_deref(), Some("1.3M"));
    assert_eq!(label(1_450_000).as_deref(), Some("1.4M"));
    assert_eq!(label(10_250_000).as_deref(), Some("10.3M"));
    assert_eq!(label(131_072).as_deref(), Some("131K"));
    assert_eq!(label(999_500).as_deref(), Some("1000K"));
    assert_eq!(label(1_500).as_deref(), Some("2K"));
    assert_eq!(label(499).as_deref(), Some("0K"));
    assert_eq!(label(0), None);
    assert_eq!(context_label(None), None);
}

fn price(input: f64, output: f64) -> ModelPrice {
    ModelPrice {
        input,
        output,
        cache_read: input,
        cache_write: input,
        peak: None,
    }
}

#[test]
fn a_price_reads_as_one_line_and_as_a_cost_tier() {
    let hint = |input: f64, output: f64| price_hint(Some(&price(input, output)));
    assert_eq!(
        hint(0.15, 0.6).as_deref(),
        Some("$0.15 in · $0.60 out per million tokens, est.")
    );
    assert_eq!(
        hint(10.0, 50.0).as_deref(),
        Some("$10 in · $50 out per million tokens, est.")
    );
    assert_eq!(
        hint(0.006, 12.5).as_deref(),
        Some("$0.01 in · $13 out per million tokens, est.")
    );
    assert_eq!(
        hint(9.995, 10.5).as_deref(),
        Some("$9.99 in · $11 out per million tokens, est.")
    );
    assert_eq!(
        hint(0.125, 0.375).as_deref(),
        Some("$0.13 in · $0.38 out per million tokens, est.")
    );
    assert_eq!(hint(0.0, 0.0).as_deref(), Some("Free"));
    assert_eq!(price_hint(None), None);

    let tier = |input: f64, output: f64| cost_tier(Some(&price(input, output)));
    assert_eq!(tier(0.1, 0.5), Some("$"));
    assert_eq!(tier(0.5, 0.5), Some("$$"), "exactly 50 cents is the middle tier");
    assert_eq!(tier(2.0, 10.0), Some("$$"));
    assert_eq!(tier(5.0, 5.0), Some("$$$"));
    assert_eq!(tier(10.0, 50.0), Some("$$$"));
    assert_eq!(tier(0.0, 0.0), None, "free has no tier");
    assert_eq!(cost_tier(None), None);
}

#[test]
fn a_model_with_peak_hours_is_tiered_at_its_week_average_price() {
    static WEEKDAYS: [u32; 5] = [1, 2, 3, 4, 5];
    static HOURS: [(u32, u32); 2] = [(1, 4), (6, 10)];
    let deepseek = PeakWindow {
        days: &WEEKDAYS,
        hours_utc: &HOURS,
        off_peak_factor: 0.5,
    };
    // 35 peak hours of 168: 35/168 + (133/168) / 2.
    assert_eq!(week_average_factor(Some(&deepseek)), 0.6041666666666666);
    assert_eq!(week_average_factor(None), 1.0);
    // DeepSeek Flash: $0.30 in, $1.20 out at peak is $0.525 blended, the middle tier; over the week it is $0.32.
    let flat = price(0.3, 1.2);
    let peaked = ModelPrice {
        peak: Some(deepseek),
        ..flat
    };
    assert_eq!(cost_tier(Some(&flat)), Some("$$"));
    assert_eq!(cost_tier(Some(&peaked)), Some("$"));
    assert_eq!(
        price_hint(Some(&peaked)).as_deref(),
        Some("$0.30 in · $1.20 out per million tokens, est."),
        "the hint still gives the peak figures"
    );

    static ALL_WEEK: [u32; 7] = [0, 1, 2, 3, 4, 5, 6];
    static ALL_DAY: [(u32, u32); 1] = [(0, 24)];
    static LATE: [(u32, u32); 2] = [(22, 30), (5, 3)];
    static TWO_DAYS: [u32; 2] = [1, 2];
    let window = |days: &'static [u32], hours_utc: &'static [(u32, u32)], off_peak_factor: f64| PeakWindow {
        days,
        hours_utc,
        off_peak_factor,
    };
    assert_eq!(week_average_factor(Some(&window(&ALL_WEEK, &ALL_DAY, 0.5))), 1.0);
    assert_eq!(
        week_average_factor(Some(&window(&WEEKDAYS, &HOURS, 0.0))),
        1.0,
        "no off-peak factor is no peak"
    );
    // Hours past midnight stop at 24, and a window that ends before it starts counts for nothing.
    assert_eq!(
        week_average_factor(Some(&window(&TWO_DAYS, &LATE, 0.25))),
        0.26785714285714285
    );
}

#[test]
fn a_claude_family_is_read_from_an_id_and_has_a_tier_of_its_own() {
    assert_eq!(family_of("claude-sonnet-5-5"), Some("sonnet"));
    assert_eq!(family_of("~anthropic/claude-haiku-latest"), Some("haiku"));
    assert_eq!(family_of("Claude-Haiku-4-5-20251001"), Some("haiku"));
    assert_eq!(family_of("opus"), Some("opus"));
    assert_eq!(
        family_of("sonnet/haiku-1"),
        Some("haiku"),
        "the first place a family stands as a whole word"
    );
    for not in ["", "myopus-5", "claude-opusx-5", "fable_5", "gpt-6-luna", "mythos"] {
        assert_eq!(family_of(not), None, "{not}");
    }
    assert_eq!(family_cost_tier("haiku"), Some("$$"));
    for family in ["sonnet", "OPUS", "Fable"] {
        assert_eq!(family_cost_tier(family), Some("$$$"), "{family}");
    }
    assert_eq!(family_cost_tier("mythos"), None);
    assert_eq!(family_cost_tier(""), None);
}

#[test]
fn a_model_known_only_by_its_id_gets_a_name_from_it() {
    assert_eq!(
        name_from_slug("~anthropic/claude-sonnet-latest"),
        "Claude Sonnet (latest)"
    );
    assert_eq!(name_from_slug("anthropic/claude-opus-4.7"), "Claude Opus 4.7");
    assert_eq!(name_from_slug("deepseek/deepseek-chat:free"), "Deepseek Chat:free");
    assert_eq!(name_from_slug("a/b/c-d_e"), "C D E");
    assert_eq!(name_from_slug("3d-model_v2"), "3d Model V2");
    assert_eq!(name_from_slug("x-LATEST"), "X (latest)");
    assert_eq!(name_from_slug("-latest"), "-latest (latest)");
    assert_eq!(name_from_slug("--"), "--");
    assert_eq!(name_from_slug("~"), "");
    assert_eq!(name_from_slug("été-model"), "Été Model");
    assert_eq!(name_from_slug("🐒-x"), "🐒 X");
    // A first letter outside the basic plane keeps its case: the JS, which saw only half of it, left it alone.
    assert_eq!(name_from_slug("𐐨x-y"), "𐐨x Y");
}

fn choices() -> Vec<Value> {
    vec![
        json!({"provider": "claude", "id": "claude-opus-4-6", "name": "Claude Opus 4.6", "ref": "claude:claude-opus-4-6"}),
        json!({"provider": "chatgpt", "id": "gpt-6-luna", "name": "GPT-6 Luna", "ref": "chatgpt:gpt-6-luna"}),
        json!({"provider": "openai", "id": "gpt-6-luna", "name": "GPT-6 Luna", "ref": "openai:gpt-6-luna"}),
        json!({"provider": "openai", "id": "gpt-6.1-sol", "name": "GPT-6.1 Sol", "ref": "openai:gpt-6.1-sol"}),
        json!({"provider": "deepseek", "id": "deepseek-flash", "name": "DeepSeek Flash", "ref": "deepseek:deepseek-flash"}),
        json!({"provider": "deepseek", "id": "deepseek-v4-pro", "name": "DeepSeek Pro", "ref": "deepseek:deepseek-v4-pro"}),
        json!({"provider": "openrouter", "id": "~deepseek/deepseek-flash-latest", "name": "DeepSeek: DeepSeek Flash (latest)"}),
        json!({"provider": "openrouter", "id": "~anthropic/claude-sonnet-latest", "name": "Anthropic: Claude Sonnet Latest"}),
        json!({"provider": "deepseek", "id": "deepseek-flash", "name": "a second row for the same model"}),
    ]
}

#[test]
fn what_someone_typed_is_matched_to_the_models_that_fit_it_best() {
    let choices = choices();
    let matched = |query: &str, prefer: Option<&str>| {
        let found = match_models(&choices, query, prefer);
        let refs: Vec<String> = found
            .matches
            .iter()
            .map(|c| format!("{}:{}", c.provider(), c.id()))
            .collect();
        (refs, found.score)
    };
    let one = |r: &str, score: u32| (vec![r.to_string()], score);
    // Its exact id, name or ref.
    assert_eq!(matched("deepseek-flash", None), one("deepseek:deepseek-flash", 100));
    assert_eq!(matched(" DeepSeek Pro ", None), one("deepseek:deepseek-v4-pro", 100));
    assert_eq!(matched("OPENAI:GPT-6.1-SOL", None), one("openai:gpt-6.1-sol", 100));
    // The last part of a slug.
    assert_eq!(
        matched("claude-sonnet-latest", None),
        one("openrouter:~anthropic/claude-sonnet-latest", 90)
    );
    // Every word typed is a word of the id or the name.
    assert_eq!(
        matched("deepseek pro", None),
        one("deepseek:deepseek-v4-pro", 100),
        "its name, in any case"
    );
    assert_eq!(matched("pro deepseek", None), one("deepseek:deepseek-v4-pro", 70));
    assert_eq!(matched("opus 4.6", None), one("claude:claude-opus-4-6", 70));
    assert_eq!(
        matched("flash", None),
        (
            vec![
                "deepseek:deepseek-flash".to_string(),
                "openrouter:~deepseek/deepseek-flash-latest".to_string()
            ],
            70
        )
    );
    // The start of a word, then any piece.
    assert_eq!(
        matched("son", None),
        one("openrouter:~anthropic/claude-sonnet-latest", 50)
    );
    assert_eq!(matched("eeps", None).1, 30);
    assert_eq!(matched("nothing-like-this", None), (vec![], 0));
    assert_eq!(matched("", None), (vec![], 0));
    // The same model on two AIs goes to the default AI when it is one of them.
    let both = vec!["chatgpt:gpt-6-luna".to_string(), "openai:gpt-6-luna".to_string()];
    assert_eq!(matched("luna", None), (both.clone(), 70));
    assert_eq!(matched("luna", Some("openai")), one("openai:gpt-6-luna", 70));
    assert_eq!(matched("luna", Some("deepseek")), (both, 70));
    // Different models that fit equally stay choices to list, whatever the default AI.
    assert_eq!(matched("flash", Some("deepseek")).0.len(), 2);
}

#[test]
fn numbers_are_written_as_javascript_writes_them() {
    // toFixed: a tie goes up.
    assert_eq!(js_to_fixed(1.25, 1), "1.3");
    assert_eq!(js_to_fixed(0.125, 2), "0.13");
    assert_eq!(js_to_fixed(2.5, 0), "3");
    assert_eq!(
        js_to_fixed(1.005, 2),
        "1.00",
        "1.005 is a little below the half as a double"
    );
    assert_eq!(js_to_fixed(9.999, 2), "10.00");
    assert_eq!(js_to_fixed(0.0, 2), "0.00");
    assert_eq!(js_to_fixed(0.0004, 2), "0.00");
    assert_eq!(js_to_fixed(1234.5, 0), "1235");
    assert_eq!(js_to_fixed(-1.25, 1), "-1.3");
    // toPrecision, read back as a number.
    assert_eq!(js_to_precision(0.0699, 3), 0.0699);
    assert_eq!(js_to_precision(1.125, 3), 1.13);
    assert_eq!(js_to_precision(999.5, 3), 1000.0);
    assert_eq!(js_to_precision(0.000123456, 3), 0.000123);
    assert_eq!(js_to_precision(2.0, 3), 2.0);
    // String(number).
    assert_eq!(js_number_to_string(2.0), "2");
    assert_eq!(js_number_to_string(0.5), "0.5");
    assert_eq!(js_number_to_string(0.0699), "0.0699");
    assert_eq!(js_number_to_string(1234.5), "1234.5");
    assert_eq!(js_number_to_string(-0.25), "-0.25");
    assert_eq!(js_number_to_string(1e21), "1e+21");
    assert_eq!(js_number_to_string(1e-7), "1e-7");
    assert_eq!(js_number_to_string(1.5e-7), "1.5e-7");
    assert_eq!(js_number_to_string(0.000001), "0.000001");
    assert_eq!(js_number_to_string(123456789012345680000.0), "123456789012345680000");
    assert_eq!(js_number_to_string(0.1 + 0.2), "0.30000000000000004");
    assert_eq!(js_number_to_string(f64::NAN), "NaN");
    assert_eq!(js_number_to_string(-0.0), "0");
}
