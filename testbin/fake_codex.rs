//! Role `codex`: a stand-in for the `codex` program, for the ChatGPT sign-in and the account's model list
//! (`tests/it/codex_device_login.rs`, `tests/it/codex_models.rs`). The port of
//! test/fixtures/fake-codex-login/fake-codex.mjs. A test starts it through a platform shim (a `.cmd` on Windows, a
//! shell script elsewhere), the way Tarsee starts any codex, so the tests exercise real child processes: spawning,
//! ANSI on stdout, files in CODEX_HOME, killing the whole process tree. What it prints copies the real program's
//! formats (codex-cli 0.167.0, captured into tests/fixtures/codex-login: device-auth.stdout.txt,
//! model-list.bundled.json, refresh-failed.stderr.txt).
//!
//! Commands (global `-c key=value` pairs before the command are skipped, as the real CLI accepts them):
//!
//! ```text
//!   login --device-auth   FAKE_CODEX_LOGIN picks the scenario:
//!                           success (default)  print the captured stdout, then write auth.json, say so, exit 0
//!                           hang               print the captured stdout and wait forever
//!                           disabled           the CLI's "device code login is not enabled" error, exit 1, no code
//!                           network            the CLI's "failed to request device code" error, exit 1, no code
//!                           fail-after-code    print the stdout, then "device auth failed with status 400", exit 1
//!                           auth-no-exit       print the stdout, write auth.json, keep running
//!                           exit-no-auth       print the stdout, exit 0 without writing auth.json
//!                           other-host         print the stdout with a different sign-in link
//!                           silent             print nothing and wait forever
//!                           warning-only       a WARNING line on stderr, then wait forever
//!                           stderr-error       an error line on stderr, then wait forever
//!                         FAKE_CODEX_DELAY_MS (default 300) is how long "the person" takes to sign in;
//!                         FAKE_CODEX_MINUTES is how long the code is said to last (the capture says 15).
//!   login status         from $CODEX_HOME/auth.json, on stderr as the real CLI does (FAKE_CODEX_STATUS: "hang"
//!                         never answers, "garbled" answers with words that say nothing)
//!   logout                deletes auth.json
//!   app-server            JSON-RPC over stdio (initialize, account/read, model/list); FAKE_CODEX_ACCOUNT
//!                         (chatgpt | none | apikey | expired) and FAKE_CODEX_MODELS pick it:
//!                           live            the account's own list, in two pages, cached in models_cache.json
//!                           fallback        the real program on a failed fetch: its error line, the bundled catalog
//!                           quiet-fallback  the bundled catalog with no error line and no cache
//!                           mismatch        the bundled catalog next to a cache of some other list
//!                           hang            never answers model/list
//!                           late            the live list, each answer FAKE_CODEX_DELAY_MS late
//!                           endless         the live list, with a nextCursor on every page
//!                           none-listed     a fetch that worked (a cache is written) and an empty list
//!                         FAKE_CODEX_RPC_NOISE=1 puts what a client must skip around every answer (a blank line, a
//!                         line that is not JSON, JSON that is no object, a notification, an answer to nothing asked,
//!                         a request of the server's own) and sends every answer twice.
//! ```
//!
//! Every run appends {argv, cwd, env names it can see, CODEX_HOME, RUST_LOG} to FAKE_CODEX_LOG when set (and the
//! app-server each request it was sent, as {request, id, params}, and each answer a client gave to the server's own
//! request, as {reply}), and the login and the app-server write their pid to FAKE_CODEX_PID_FILE when set, so a test
//! can check the process is gone after cancel or timeout.
//! Every token here is an obvious fake. (The last three login scenarios, FAKE_CODEX_MINUTES, the two status ones,
//! `late`, `endless`, `none-listed` and the noise are additions for the Rust tests.)

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};

const DEVICE_AUTH_STDOUT: &str = include_str!("../tests/fixtures/codex-login/device-auth.stdout.txt");
const MODEL_LIST_BUNDLED: &str = include_str!("../tests/fixtures/codex-login/model-list.bundled.json");
const REFRESH_FAILED_STDERR: &str = include_str!("../tests/fixtures/codex-login/refresh-failed.stderr.txt");

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn home() -> PathBuf {
    PathBuf::from(var("CODEX_HOME").unwrap_or_default())
}

fn auth_file() -> PathBuf {
    home().join("auth.json")
}

fn log(line: &Value) {
    if let Some(path) = var("FAKE_CODEX_LOG")
        && let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn write_pid() {
    if let Some(path) = var("FAKE_CODEX_PID_FILE") {
        let _ = std::fs::write(path, std::process::id().to_string());
    }
}

fn out(text: &str) {
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(text.as_bytes());
    let _ = stdout.flush();
}

fn err(text: &str) {
    let mut stderr = std::io::stderr();
    let _ = stderr.write_all(text.as_bytes());
    let _ = stderr.flush();
}

fn forever() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

fn delay() -> Duration {
    Duration::from_millis(var("FAKE_CODEX_DELAY_MS").and_then(|v| v.parse().ok()).unwrap_or(300))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn b64(value: &Value) -> String {
    URL_SAFE_NO_PAD.encode(value.to_string())
}

fn jwt(claims: &Value) -> String {
    format!(
        "{}.{}.sig-test-canary",
        b64(&json!({ "alg": "none", "typ": "JWT" })),
        b64(claims)
    )
}

fn write_chatgpt_auth() {
    let now = chrono::Utc::now().timestamp();
    let auth = json!({
        "chatgpt_plan_type": var("FAKE_CODEX_PLAN").unwrap_or_else(|| "free".into()),
        "chatgpt_account_id": "acct-test",
    });
    let id = jwt(&json!({
        "email": var("FAKE_CODEX_EMAIL").unwrap_or_else(|| "person@example.test".into()),
        "exp": now + 3600,
        "https://api.openai.com/auth": auth,
    }));
    let body = json!({
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": null,
        "tokens": {
            "id_token": id,
            "access_token": jwt(&json!({ "exp": now + 3600 })),
            "refresh_token": "rt-test-canary-0000",
            "account_id": "acct-test",
        },
        "last_refresh": now_iso(),
    });
    let _ = std::fs::write(auth_file(), serde_json::to_string_pretty(&body).unwrap_or_default());
}

fn read_auth() -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(auth_file()).ok()?).ok()
}

fn device_login() -> i32 {
    write_pid();
    let mode = var("FAKE_CODEX_LOGIN").unwrap_or_else(|| "success".into());
    match mode.as_str() {
        "disabled" => {
            err(
                "Error logging in: device code login is not enabled for this Codex server. Use the browser login or verify the server URL.\n",
            );
            return 1;
        }
        "network" => {
            err(
                "Error logging in: failed to request device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode)\n",
            );
            return 1;
        }
        "silent" => forever(),
        "warning-only" => {
            err("WARNING: proceeding, even though we could not update PATH\n");
            forever()
        }
        "stderr-error" => {
            err("WARNING: proceeding\nError logging in: the sign-in server said no\n");
            forever()
        }
        _ => {}
    }
    let mut text = DEVICE_AUTH_STDOUT.to_string();
    if mode == "other-host" {
        text = text.replace(
            "https://auth.openai.com/codex/device",
            "https://auth.example.test/codex/device",
        );
    }
    if let Some(minutes) = var("FAKE_CODEX_MINUTES") {
        text = text.replace("expires in 15 minutes", &format!("expires in {minutes} minutes"));
    }
    // Real output arrives in pieces; split it so the parser has to wait for the code.
    let cut = text.find("2. Enter").unwrap_or(text.len());
    out(&text[..cut]);
    std::thread::sleep(Duration::from_millis(50));
    out(&text[cut..]);
    if mode == "hang" || mode == "other-host" {
        forever();
    }
    std::thread::sleep(delay());
    if mode == "fail-after-code" {
        err("Error logging in: device auth failed with status 400 Bad Request\n");
        return 1;
    }
    if mode == "exit-no-auth" {
        return 0;
    }
    write_chatgpt_auth();
    if mode == "auth-no-exit" {
        forever();
    }
    err("Successfully logged in\n");
    0
}

fn login_status() -> i32 {
    match var("FAKE_CODEX_STATUS").as_deref() {
        Some("hang") => forever(),
        Some("garbled") => {
            err("Something else entirely\n");
            return 0;
        }
        _ => {}
    }
    let auth = read_auth();
    let truthy = |name: &str| {
        auth.as_ref()
            .and_then(|a| a.get(name))
            .is_some_and(|v| !v.is_null() && v != &json!(false) && v != &json!("") && v != &json!(0))
    };
    if truthy("tokens") {
        err("Logged in using ChatGPT\n");
        return 0;
    }
    if truthy("OPENAI_API_KEY") {
        let key = auth
            .as_ref()
            .and_then(|a| a.get("OPENAI_API_KEY"))
            .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string))
            .unwrap_or_default();
        let chars: Vec<char> = key.chars().collect();
        let first: String = chars.iter().take(8).collect();
        let last: String = chars[chars.len().saturating_sub(5)..].iter().collect();
        err(&format!(
            "API key configured - {first}***{last}\nAuthentication is checked when you send a request.\n"
        ));
        return 0;
    }
    err("Not logged in\n");
    1
}

fn logout() -> i32 {
    if !auth_file().exists() {
        err("Not logged in\n");
        return 0;
    }
    let _ = std::fs::remove_file(auth_file());
    err("Successfully logged out\n");
    0
}

// --- app-server --------------------------------------------------------------------------------------------------

/// An account's own list: ids the bundled catalog doesn't have, so a test can tell the two apart.
fn live_models() -> Vec<Value> {
    let model = |id: &str, name: &str, efforts: &[&str], default: bool, modalities: &[&str], hidden: bool| {
        json!({
            "id": id, "model": id, "upgrade": null, "upgradeInfo": null, "availabilityNux": null, "displayName": name,
            "description": format!("{name} for tests."), "modelSpecialty": null, "hidden": hidden,
            "supportedReasoningEfforts": efforts.iter().map(|e| json!({ "reasoningEffort": e, "description": e })).collect::<Vec<_>>(),
            "defaultReasoningEffort": efforts[0], "inputModalities": modalities, "supportsPersonality": false,
            "additionalSpeedTiers": [], "serviceTiers": [], "isDefault": default,
        })
    };
    vec![
        model(
            "test-free-small",
            "Test Free Small",
            &["medium", "low", "high"],
            true,
            &["text", "image"],
            false,
        ),
        model("test-free-mini", "Test Free Mini", &["low"], false, &["text"], false),
        model(
            "test-free-hidden",
            "Test Hidden",
            &["low"],
            false,
            &["text", "image"],
            true,
        ),
    ]
}

fn app_server() -> i32 {
    write_pid();
    let account_mode = var("FAKE_CODEX_ACCOUNT").unwrap_or_else(|| "chatgpt".into());
    let models_mode = var("FAKE_CODEX_MODELS").unwrap_or_else(|| "live".into());
    let noise = var("FAKE_CODEX_RPC_NOISE").is_some();
    let mut server_requests = 0u32;
    let mut send = |message: Value| {
        if noise {
            server_requests += 1;
            out("\n");
            out("this line is not JSON\n");
            out("42\n");
            out(&format!("{}\n", json!({ "method": "thread/started", "params": {} })));
            out(&format!(
                "{}\n",
                json!({ "id": 987_654, "result": { "nobody": "asked" } })
            ));
            out(&format!(
                "{}\n",
                json!({ "id": format!("srv-{server_requests}"), "method": "approval/request", "params": {} })
            ));
        }
        out(&format!("{message}\n"));
        if noise {
            out(&format!("{message}\n"));
        }
    };
    let bundled = || serde_json::from_str::<Value>(MODEL_LIST_BUNDLED).unwrap_or(Value::Null);
    let cache = home().join("models_cache.json");

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(m) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = m.get("id").cloned();
        let method = m.get("method").and_then(Value::as_str);
        let params = m.get("params").cloned().unwrap_or(Value::Null);
        if let Some(method) = method {
            log(&json!({ "request": method, "id": id, "params": params }));
        }
        let reply = |result: Value| json!({ "id": id, "result": result });
        match method {
            Some("initialize") => {
                let name = params
                    .pointer("/clientInfo/name")
                    .and_then(Value::as_str)
                    .unwrap_or("undefined");
                send(reply(json!({
                    "userAgent": format!("{name}/0.167.0 (fake)"),
                    "codexHome": home().to_string_lossy(),
                    "platformFamily": "unix",
                    "platformOs": "linux",
                })));
            }
            Some("initialized") => {}
            Some("account/read") => {
                if account_mode == "expired" {
                    send(json!({ "id": id, "error": {
                        "code": -32603,
                        "message": "Your access token could not be refreshed. Please log out and sign in again.",
                    } }));
                    continue;
                }
                let account = match account_mode.as_str() {
                    "chatgpt" => json!({
                        "type": "chatgpt",
                        "email": var("FAKE_CODEX_EMAIL").unwrap_or_else(|| "person@example.test".into()),
                        "planType": "free",
                    }),
                    "apikey" => json!({ "type": "apiKey" }),
                    _ => Value::Null,
                };
                send(reply(
                    json!({ "account": account, "requiresOpenaiAuth": true, "workspaceRouting": null }),
                ));
            }
            Some("model/list") => match models_mode.as_str() {
                "hang" => {}
                "fallback" => {
                    // What the real program does when the account's fetch fails: log it, answer with its bundled
                    // catalog.
                    err(REFRESH_FAILED_STDERR);
                    send(reply(bundled()));
                }
                // No log line, no cache.
                "quiet-fallback" => send(reply(bundled())),
                "none-listed" => {
                    // The account's fetch worked, and lists nothing this client may show.
                    let _ = std::fs::write(
                        &cache,
                        json!({ "fetched_at": now_iso(), "client_version": "0.167.0", "models": [{ "slug": "test-free-hidden", "visibility": "hide" }] })
                            .to_string(),
                    );
                    send(reply(json!({ "data": [], "nextCursor": null })));
                }
                "mismatch" => {
                    // A cache from some other answer (another account's, say) next to the bundled catalog.
                    let _ = std::fs::write(
                        &cache,
                        json!({ "fetched_at": now_iso(), "client_version": "0.167.0", "models": [{ "slug": "test-other-account" }] })
                            .to_string(),
                    );
                    send(reply(bundled()));
                }
                _ => {
                    if models_mode == "late" {
                        std::thread::sleep(delay());
                    }
                    let all = live_models();
                    let cursor = params.get("cursor").is_some_and(|c| !c.is_null() && c != &json!(""));
                    if !cursor {
                        // The account's fetch succeeded: the real program caches it in CODEX_HOME, keyed to the
                        // account.
                        let models: Vec<Value> = all
                            .iter()
                            .map(|x| {
                                json!({
                                    "slug": x["id"],
                                    "display_name": x["displayName"],
                                    "visibility": if x["hidden"] == json!(true) { "hide" } else { "list" },
                                })
                            })
                            .collect();
                        let _ = std::fs::write(
                            &cache,
                            json!({
                                "fetched_at": now_iso(), "etag": "W/\"test\"", "client_version": "0.167.0",
                                "identity": { "account": "acct-test" }, "models": models,
                            })
                            .to_string(),
                        );
                    }
                    // Two pages, so the caller has to follow nextCursor.
                    let include_hidden = params.get("includeHidden") == Some(&json!(true));
                    let visible: Vec<Value> = all
                        .into_iter()
                        .filter(|x| include_hidden || x["hidden"] != json!(true))
                        .collect();
                    if models_mode == "endless" {
                        send(reply(json!({ "data": visible, "nextCursor": "more" })));
                    } else if !cursor {
                        send(reply(json!({ "data": &visible[..1], "nextCursor": "page-2" })));
                    } else {
                        send(reply(json!({ "data": &visible[1..], "nextCursor": null })));
                    }
                }
            },
            Some(other) => {
                if id.is_some() {
                    send(
                        json!({ "id": id, "error": { "code": -32601, "message": format!("unknown method {other}") } }),
                    );
                }
            }
            // No method: an answer to a request of the server's own.
            None => log(&json!({ "reply": m })),
        }
    }
    0
}

pub fn main() -> i32 {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut rest: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        if argv[i] == "-c" || argv[i] == "--config" {
            i += 2;
            continue;
        }
        rest.push(&argv[i]);
        i += 1;
    }

    log(&json!({
        "argv": argv,
        "cwd": std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        "env": std::env::vars_os().map(|(k, _)| k.to_string_lossy().into_owned()).collect::<Vec<_>>(),
        "CODEX_HOME": var("CODEX_HOME").unwrap_or_default(),
        "RUST_LOG": std::env::var("RUST_LOG").ok(),
    }));

    match (rest.first().copied(), rest.get(1).copied()) {
        (Some("login"), _) if rest.contains(&"--device-auth") => device_login(),
        (Some("login"), Some("status")) => login_status(),
        (Some("logout"), _) => logout(),
        (Some("app-server"), _) => app_server(),
        _ => {
            err(&format!("fake codex: unknown command {}\n", rest.join(" ")));
            2
        }
    }
}
