//! Port of `test/model-picker-core.test.js`: the composer's model picker on the page
//! (`src/public/js/model-picker-core.js`, `ModelPickerCore`).
//!
//! Most of the Node file runs the page's rules on lists the server builds: the Claude-only list
//! (`buildPicker`, `src/lib/model-picker.js`, package A1) and the list with every AI (`getModelGroups`,
//! `src/lib/model-catalog.js`, package A4, over the provider registry of package A1). Those cases are ported once
//! those packages are merged, with the lists built by their Rust ports; they are named in
//! `docs/rust-port/reports/W1a.md`. Here are the cases that need only the browser file.

use serde_json::json;

use crate::support::Page;

async fn picker_core() -> Page {
    Page::with_scripts(&["model-picker-core.js"]).await
}

#[tokio::test]
async fn a_model_the_list_does_not_have_is_named_from_its_id() {
    let page = picker_core().await;
    // After package A1: P.modelName(PICKER, "claude-opus-6") is "Opus 6", PICKER built by lib::model_picker.
    assert_eq!(
        page.call("ModelPickerCore.modelName", json!([null, "claude-sonnet-5-5"]))
            .await,
        "Sonnet 5.5"
    );
    assert_eq!(
        page.call("ModelPickerCore.nameFromId", json!(["claude-haiku-4-5-20251001"]))
            .await,
        "Haiku 4.5"
    );
}

#[tokio::test]
async fn the_arrows_move_and_wrap_home_and_end_go_to_the_ends() {
    let page = picker_core().await;
    let next = |n: i64, i: i64, key: &'static str| {
        let page = &page;
        async move { page.call("ModelPickerCore.nextIndex", json!([n, i, key])).await }
    };
    assert_eq!(next(6, -1, "ArrowDown").await, 0);
    assert_eq!(next(6, 5, "ArrowDown").await, 0);
    assert_eq!(next(6, 0, "ArrowUp").await, 5);
    assert_eq!(next(6, 3, "Home").await, 0);
    assert_eq!(next(6, 3, "End").await, 5);
    assert_eq!(next(0, 0, "ArrowDown").await, -1);
}

#[tokio::test]
async fn what_a_change_of_pick_sends_only_what_changed_the_ai_included() {
    let page = picker_core().await;
    let change = |before: serde_json::Value, after: serde_json::Value| {
        let page = &page;
        async move { page.call("ModelPickerCore.pickChange", json!([before, after])).await }
    };
    let before = json!({ "provider": null, "model": null, "effort": "high" });
    assert_eq!(
        change(
            before.clone(),
            json!({ "provider": "deepseek", "model": "deepseek:deepseek-flash", "effort": "high" })
        )
        .await,
        json!({ "provider": "deepseek", "model": "deepseek:deepseek-flash" })
    );
    assert_eq!(
        change(
            before.clone(),
            json!({ "provider": null, "model": null, "effort": "low" })
        )
        .await,
        json!({ "effort": "low" })
    );
    assert_eq!(change(before.clone(), before.clone()).await, json!({}));
    assert_eq!(
        change(
            json!({ "provider": "deepseek", "model": "deepseek:deepseek-flash", "effort": null }),
            json!({ "provider": null, "model": null, "effort": null })
        )
        .await,
        json!({ "provider": null, "model": null }),
        "back to the default"
    );
    assert_eq!(
        change(
            json!(null),
            json!({ "provider": "chatgpt", "model": null, "effort": null })
        )
        .await,
        json!({ "provider": "chatgpt" }),
        "a new chat's first pick: what it has"
    );
}
