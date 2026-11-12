//! The harness itself: what tests rely on it to do.

use serde_json::json;

use crate::support::Page;

#[tokio::test]
async fn a_page_loads_the_browser_files_and_runs_them() {
    let page = Page::with_scripts(&["chat-core.js"]).await;
    assert_eq!(page.eval("typeof ChatCore.chatName").await, json!("function"));
    assert_eq!(page.eval("1 + 1").await, json!(2));
    assert_eq!(
        page.call(
            "ChatCore.chatName",
            json!([{ "key": "web:default", "title": "Web Chat" }])
        )
        .await,
        json!("Main Session")
    );
}
