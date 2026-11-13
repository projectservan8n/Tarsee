//! Port of the cases of test/codex-device-login.test.js that run a codex: the ChatGPT sign-in through Codex's own
//! device-code login (`ai/codex_device_login.rs`; design amendment A1, 4.14). Tarsee runs `codex login --device-auth`
//! with CODEX_HOME set, reads the link and one-time code off its output, and waits for auth.json plus
//! `codex login status`. The flow runs a fake codex (`testbin/fake_codex.rs`) through the same platform shim any
//! codex would get, so the spawning, the ANSI, the files in CODEX_HOME and killing the whole process tree are real.
//! The cases that start nothing (the parser, the messages, auth.json's shapes) are unit tests beside the module.
//! Every token is an obvious fake.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use tarsee::Env;
use tarsee::ai::codex_device_login::{
    DEVICE_CODE_DISABLED_MESSAGE, DEVICE_LOGIN_URL, DeviceLoginOpts, LoginCode, LoginMethod, LoginState,
    LoginStatusOpts, LogoutOpts, StartLoginError, cancel_device_login, get_device_login, login_status, logout,
    start_device_login,
};
use tarsee::testkit::{TestApp, test_app};
use tarsee::util::js::now_ms;

use crate::support::testbin;

/// Credentials a host might have set; none may reach the codex child.
pub(crate) const CANARIES: [&str; 7] = [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_BASE_URL",
    "ENCRYPTION_KEY",
    "ANTHROPIC_API_KEY",
    "TARSEE_PROVIDER_KEY",
];

/// A fake codex in `dir`, started the way a real install would start it: on Windows a `codex.cmd` shim (run through
/// cmd.exe), elsewhere a shell script that starts the program as its child. Either way the program under the shim is
/// a second process, so stopping "codex" has a tree to stop.
pub(crate) fn fake_codex_shim(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let program = testbin();
    if cfg!(windows) {
        let shim = dir.join("codex.cmd");
        std::fs::write(
            &shim,
            format!(
                "@echo off\r\nset \"TARSEE_TESTBIN_ROLE=codex\"\r\n\"{}\" %*\r\nexit /b %ERRORLEVEL%\r\n",
                program.display()
            ),
        )
        .unwrap();
        shim
    } else {
        let shim = dir.join("codex");
        std::fs::write(
            &shim,
            format!(
                "#!/bin/sh\nTARSEE_TESTBIN_ROLE=codex \"{}\" \"$@\"\n",
                program.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        shim
    }
}

/// A fresh case: its own app, its own CODEX_HOME (not yet created), log and pid files, and the server environment
/// the fake reads its scenario from.
pub(crate) struct Scenario {
    pub t: TestApp,
    pub dir: PathBuf,
    pub home: PathBuf,
    pub env: Env,
    pub codex_bin: PathBuf,
    log: PathBuf,
    pid_file: PathBuf,
}

pub(crate) fn scenario(vars: &[(&str, &str)]) -> Scenario {
    let t = test_app();
    let dir = t.path().join("case");
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("codex-calls.jsonl");
    let pid_file = dir.join("codex.pid");
    let env = Env::new();
    // A shell needs a PATH to find its own helpers; nothing else of the machine's environment goes in.
    if !cfg!(windows) {
        env.set("PATH", "/usr/bin:/bin");
    }
    for name in CANARIES {
        env.set(name, format!("sk-{}-{name}", "test-canary"));
    }
    env.set("CODEX_HOME", dir.join("wrong-home").to_string_lossy().to_string());
    env.set("FAKE_CODEX_LOG", log.to_string_lossy().to_string());
    env.set("FAKE_CODEX_PID_FILE", pid_file.to_string_lossy().to_string());
    for (name, value) in vars {
        env.set(*name, *value);
    }
    Scenario {
        codex_bin: fake_codex_shim(&dir.join("bin")),
        home: dir.join(".codex-home"),
        t,
        dir,
        env,
        log,
        pid_file,
    }
}

impl Scenario {
    /// Every run of the fake so far: `{argv, cwd, env, CODEX_HOME, RUST_LOG}`.
    pub fn calls(&self) -> Vec<Value> {
        self.log_lines()
            .into_iter()
            .filter(|l| l.get("argv").is_some())
            .collect()
    }

    /// Every line the fake wrote to its log.
    pub fn log_lines(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// The runs whose arguments include `word`.
    pub fn calls_with(&self, word: &str) -> Vec<Value> {
        self.calls()
            .into_iter()
            .filter(|c| c["argv"].as_array().unwrap().iter().any(|a| a == word))
            .collect()
    }

    pub fn pid(&self) -> u32 {
        std::fs::read_to_string(&self.pid_file)
            .expect("the fake wrote its pid")
            .trim()
            .parse()
            .unwrap()
    }

    /// The pid, once the fake has written it.
    pub async fn pid_when_written(&self) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Ok(text) = std::fs::read_to_string(&self.pid_file)
                && let Ok(pid) = text.trim().parse()
            {
                return pid;
            }
            assert!(Instant::now() < deadline, "the fake codex never started");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn start_opts(&self) -> DeviceLoginOpts {
        DeviceLoginOpts {
            codex_home: self.home.clone(),
            codex_bin: Some(self.codex_bin.clone()),
            env: Some(self.env.clone()),
            ..DeviceLoginOpts::default()
        }
    }

    fn status_opts(&self) -> LoginStatusOpts {
        LoginStatusOpts {
            codex_home: self.home.clone(),
            codex_bin: Some(self.codex_bin.clone()),
            env: Some(self.env.clone()),
            ..LoginStatusOpts::default()
        }
    }

    fn logout_opts(&self) -> LogoutOpts {
        LogoutOpts {
            codex_home: self.home.clone(),
            codex_bin: Some(self.codex_bin.clone()),
            env: Some(self.env.clone()),
        }
    }

    fn state(&self) -> Option<LoginState> {
        get_device_login(&self.t, &self.home).unwrap().map(|s| s.status)
    }

    async fn start_error(&self, opts: DeviceLoginOpts) -> (LoginCode, String) {
        match start_device_login(&self.t, &opts).await {
            Err(StartLoginError::Login(err)) => (err.code, err.message),
            Err(other) => panic!("not a login's own failure: {other:?}"),
            Ok(_) => panic!("the login started"),
        }
    }
}

/// Whether a process with this id is running.
pub(crate) fn is_alive(pid: u32) -> bool {
    if cfg!(windows) {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    } else {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    }
}

pub(crate) async fn gone_soon(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if !is_alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    !is_alive(pid)
}

fn b64(value: &Value) -> String {
    URL_SAFE_NO_PAD.encode(value.to_string())
}

fn jwt(claims: &Value) -> String {
    format!("{}.{}.sig-test-canary", b64(&json!({ "alg": "none" })), b64(claims))
}

struct ChatgptAuth<'a> {
    email: &'a str,
    plan: &'a str,
    last_refresh: &'a str,
    profile_only: bool,
}

impl Default for ChatgptAuth<'_> {
    fn default() -> Self {
        ChatgptAuth {
            email: "person@example.test",
            plan: "plus",
            last_refresh: "2026-11-01T10:00:00Z",
            profile_only: false,
        }
    }
}

fn write_chatgpt_auth(home: &Path, auth: ChatgptAuth<'_>) {
    std::fs::create_dir_all(home).unwrap();
    let claims = if auth.profile_only {
        json!({
            "https://api.openai.com/profile": { "email": auth.email },
            "https://api.openai.com/auth": { "chatgpt_plan_type": auth.plan },
        })
    } else {
        json!({
            "email": auth.email,
            "https://api.openai.com/auth": { "chatgpt_plan_type": auth.plan, "chatgpt_account_id": "acct-test" },
        })
    };
    let body = json!({
        "auth_mode": "chatgpt", "OPENAI_API_KEY": null,
        "tokens": {
            "id_token": jwt(&claims),
            "access_token": format!("at-{}", "test-canary-0001"),
            "refresh_token": format!("rt-{}", "test-canary-0001"),
            "account_id": "acct-test",
        },
        "last_refresh": auth.last_refresh,
    });
    std::fs::write(home.join("auth.json"), body.to_string()).unwrap();
}

fn write_api_key_auth(home: &Path) {
    std::fs::create_dir_all(home).unwrap();
    let key = format!("sk-{}", "test-canary-0000000000000000abcd");
    std::fs::write(
        home.join("auth.json"),
        json!({ "auth_mode": "apikey", "OPENAI_API_KEY": key }).to_string(),
    )
    .unwrap();
}

fn same_folder(a: &str, b: &Path) -> bool {
    Path::new(a).canonicalize().ok() == b.canonicalize().ok()
}

// --- startDeviceLogin with a fake codex ---

#[tokio::test]
async fn shows_the_link_and_code_then_signs_in_once_auth_json_is_there_and_codex_login_status_agrees() {
    let s = scenario(&[
        ("FAKE_CODEX_EMAIL", "someone@example.test"),
        ("FAKE_CODEX_PLAN", "free"),
    ]);
    let t0 = now_ms();
    let login = start_device_login(&s.t, &s.start_opts()).await.unwrap();
    assert_eq!(login.url, DEVICE_LOGIN_URL);
    assert_eq!(login.code, "TEST-12345");
    assert!(
        login.expires_at >= t0 + 15 * 60_000 - 1000 && login.expires_at <= now_ms() + 15 * 60_000,
        "expires 15 minutes out"
    );
    assert_eq!(s.state(), Some(LoginState::Waiting));

    let result = login.done().await;
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        json!({ "ok": true, "method": "chatgpt", "email": "someone@example.test", "plan": "free" })
    );
    assert!(s.home.join("auth.json").exists());
    let snap = get_device_login(&s.t, &s.home).unwrap().unwrap();
    assert_eq!(snap.status, LoginState::SignedIn);
    assert_eq!(snap.code.as_deref(), Some("TEST-12345"));
    assert_eq!(snap.email.as_deref(), Some("someone@example.test"));
    assert!(snap.finished_at.is_some_and(|at| at >= snap.started_at));
    assert!(
        !serde_json::to_string(&snap).unwrap().contains("canary"),
        "no token in the snapshot"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&s.home).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700, "home is owner-only");
    }
    let login_call = s.calls_with("--device-auth").into_iter().next();
    let status_call = s.calls_with("status").into_iter().next();
    assert!(
        login_call.is_some() && status_call.is_some(),
        "ran the login, then `codex login status`"
    );
    for c in [login_call.unwrap(), status_call.unwrap()] {
        assert!(
            same_folder(c["CODEX_HOME"].as_str().unwrap(), &s.home),
            "CODEX_HOME is the sign-in home, not the server's"
        );
        assert!(same_folder(c["cwd"].as_str().unwrap(), &s.home), "it runs in the home");
        let argv: Vec<&str> = c["argv"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(
            argv.contains(&"cli_auth_credentials_store=\"file\""),
            "credentials go to auth.json, never a keyring"
        );
        let names: Vec<String> = c["env"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap().to_uppercase())
            .collect();
        for k in CANARIES {
            assert!(!names.contains(&k.to_string()), "{k} must not reach codex");
        }
    }
}

#[tokio::test]
async fn one_login_at_a_time_starting_again_while_one_waits_gives_the_same_code() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "hang")]);
    let a = start_device_login(&s.t, &s.start_opts()).await.unwrap();
    let b = start_device_login(&s.t, &s.start_opts()).await.unwrap();
    assert_eq!(b.code, a.code);
    assert!(b.is_same_login(&a));
    assert_eq!(s.calls_with("--device-auth").len(), 1, "codex started once");
    a.cancel().await;
    assert_eq!(b.done().await.code, Some(LoginCode::Cancelled), "both see it end");
}

#[tokio::test]
async fn cancel_kills_the_codex_process_tree_and_says_so() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "hang")]);
    let login = start_device_login(&s.t, &s.start_opts()).await.unwrap();
    let pid = s.pid();
    assert!(is_alive(pid), "codex is waiting for the person");
    login.cancel().await;
    let result = login.done().await;
    assert!(!result.ok);
    assert_eq!(result.code, Some(LoginCode::Cancelled));
    assert_eq!(result.error.as_deref(), Some("Sign-in was cancelled."));
    assert!(gone_soon(pid).await, "the codex process is gone (not just the shim)");
    assert_eq!(s.state(), Some(LoginState::Cancelled));
    let snap = get_device_login(&s.t, &s.home).unwrap().unwrap();
    assert_eq!(snap.error_code, Some(LoginCode::Cancelled));
    assert_eq!(snap.error.as_deref(), Some("Sign-in was cancelled."));
    login.cancel().await; // twice is harmless
}

#[tokio::test]
async fn cancel_device_login_by_home_does_the_same() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "hang")]);
    let login = start_device_login(&s.t, &s.start_opts()).await.unwrap();
    assert!(cancel_device_login(&s.t, &s.home).await.unwrap());
    assert_eq!(login.done().await.code, Some(LoginCode::Cancelled));
    assert!(gone_soon(s.pid()).await);
    assert!(
        !cancel_device_login(&s.t, &s.home).await.unwrap(),
        "nothing left to cancel"
    );
}

#[tokio::test]
async fn timeout_kills_the_codex_process_tree() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "hang")]);
    let t0 = now_ms();
    let login = start_device_login(
        &s.t,
        &DeviceLoginOpts {
            timeout: Duration::from_millis(1500),
            ..s.start_opts()
        },
    )
    .await
    .unwrap();
    assert!(
        login.expires_at <= t0 + 1500 + 1000,
        "expiresAt follows the shorter limit"
    );
    let result = login.done().await;
    assert!(!result.ok);
    assert_eq!(result.code, Some(LoginCode::Timeout));
    assert!(result.error.as_deref().unwrap().to_lowercase().contains("expired"));
    assert!(gone_soon(s.pid()).await);
    assert_eq!(s.state(), Some(LoginState::Expired));
}

#[tokio::test]
async fn an_old_sign_in_already_in_the_home_doesnt_count_as_the_new_one() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "hang")]);
    write_chatgpt_auth(&s.home, ChatgptAuth::default());
    let login = start_device_login(
        &s.t,
        &DeviceLoginOpts {
            poll: Duration::from_millis(50),
            ..s.start_opts()
        },
    )
    .await
    .unwrap();
    // (Nothing to wait on: the point is that a dozen looks at the old file change nothing.)
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(s.state(), Some(LoginState::Waiting));
    assert!(
        s.calls_with("status").is_empty(),
        "the old file was never even asked about"
    );
    login.cancel().await;
}

#[tokio::test]
async fn auth_json_appearing_is_enough_even_if_codex_hasnt_exited_codex_is_then_stopped() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "auth-no-exit"), ("FAKE_CODEX_DELAY_MS", "100")]);
    let login = start_device_login(
        &s.t,
        &DeviceLoginOpts {
            poll: Duration::from_millis(50),
            ..s.start_opts()
        },
    )
    .await
    .unwrap();
    let result = login.done().await;
    assert!(result.ok);
    assert_eq!(result.method, Some(LoginMethod::Chatgpt));
    assert!(gone_soon(s.pid()).await, "codex stopped after the sign-in landed");
}

#[tokio::test]
async fn device_code_sign_in_switched_off_start_fails_with_the_setting_to_turn_on() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "disabled")]);
    let (code, message) = s.start_error(s.start_opts()).await;
    assert_eq!(code, LoginCode::DeviceCodeDisabled);
    assert_eq!(message, DEVICE_CODE_DISABLED_MESSAGE);
    assert_eq!(s.state(), Some(LoginState::Failed));
    let snap = get_device_login(&s.t, &s.home).unwrap().unwrap();
    assert_eq!(snap.error_code, Some(LoginCode::DeviceCodeDisabled));
    assert_eq!(snap.error.as_deref(), Some(DEVICE_CODE_DISABLED_MESSAGE));
    assert!(snap.finished_at.is_some() && snap.url.is_none() && snap.code.is_none());
}

#[tokio::test]
async fn no_connection_to_openai_start_fails_with_that() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "network")]);
    let (code, message) = s.start_error(s.start_opts()).await;
    assert_eq!(code, LoginCode::Network);
    assert_eq!(
        message,
        "Couldn't reach OpenAI to start the sign-in. Check this server's internet connection and try again."
    );
}

#[tokio::test]
async fn codex_failing_after_showing_the_code_ends_the_wait_with_its_reason() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "fail-after-code"), ("FAKE_CODEX_DELAY_MS", "50")]);
    let login = start_device_login(&s.t, &s.start_opts()).await.unwrap();
    let result = login.done().await;
    assert!(!result.ok);
    assert_eq!(result.code, Some(LoginCode::Failed));
    assert_eq!(
        result.error.as_deref(),
        Some("Codex couldn't sign in: device auth failed with status 400 Bad Request")
    );
    assert_eq!(s.state(), Some(LoginState::Failed));
}

#[tokio::test]
async fn codex_exiting_cleanly_without_a_sign_in_isnt_taken_as_one() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "exit-no-auth"), ("FAKE_CODEX_DELAY_MS", "50")]);
    let login = start_device_login(&s.t, &s.start_opts()).await.unwrap();
    let result = login.done().await;
    assert!(!result.ok);
    assert_eq!(result.code, Some(LoginCode::NotConfirmed));
    assert_eq!(
        result.error.as_deref(),
        Some("Codex finished without signing in. Start again for a new code.")
    );
    assert_eq!(s.state(), Some(LoginState::Failed));
}

#[tokio::test]
async fn a_sign_in_link_to_any_other_site_is_refused_and_codex_is_stopped() {
    // (The JS test gave the start 1.5 s. The refusal comes as soon as the link and the code are read, so the limit
    // only says how long a busy machine may take to start the stand-in: it is left at its own 30 s.)
    let s = scenario(&[("FAKE_CODEX_LOGIN", "other-host")]);
    let (code, message) = s.start_error(s.start_opts()).await;
    assert_eq!(code, LoginCode::UnexpectedOutput);
    assert!(!message.contains("example.test"), "the other link is never passed on");
    assert!(gone_soon(s.pid()).await);
}

#[tokio::test]
async fn a_config_toml_that_could_redirect_the_sign_in_refuses_before_codex_starts() {
    let s = scenario(&[]);
    std::fs::create_dir_all(&s.home).unwrap();
    std::fs::write(
        s.home.join("config.toml"),
        "chatgpt_base_url = \"https://example.test/\"\n",
    )
    .unwrap();
    let (code, message) = s.start_error(s.start_opts()).await;
    assert_eq!(code, LoginCode::UnsafeConfig);
    assert!(message.contains("chatgpt_base_url"), "{message}");
    assert_eq!(s.calls().len(), 0, "codex never ran");
}

#[tokio::test]
async fn a_dotenv_in_the_home_codex_would_load_a_proxy_or_a_certificate_from_it_refuses_before_codex_starts() {
    let s = scenario(&[]);
    std::fs::create_dir_all(&s.home).unwrap();
    std::fs::write(s.home.join(".env"), "HTTPS_PROXY=http://127.0.0.1:9\n").unwrap();
    let (code, message) = s.start_error(s.start_opts()).await;
    assert_eq!(code, LoginCode::UnsafeConfig);
    assert!(message.contains(".env"), "{message}");
    assert!(!message.contains("127.0.0.1"));
    assert_eq!(s.calls().len(), 0, "codex never ran");
}

#[tokio::test]
async fn a_home_folder_that_cant_be_created_says_so_plainly_and_codex_never_runs() {
    let s = scenario(&[]);
    let blocker = s.dir.join("a-file");
    std::fs::write(&blocker, "not a folder").unwrap();
    let (code, message) = s
        .start_error(DeviceLoginOpts {
            codex_home: blocker.join(".codex-home"),
            ..s.start_opts()
        })
        .await;
    assert_eq!(code, LoginCode::HomeFailed);
    assert!(
        message.starts_with("Tarsee couldn't create the folder that keeps the ChatGPT sign-in ("),
        "{message}"
    );
    assert_eq!(s.calls().len(), 0);
}

#[tokio::test]
async fn no_codex_binary_says_so_plainly() {
    let s = scenario(&[]);
    let (code, message) = s
        .start_error(DeviceLoginOpts {
            codex_bin: Some(s.dir.join("no-such-codex")),
            ..s.start_opts()
        })
        .await;
    assert_eq!(code, LoginCode::CodexMissing);
    assert!(message.starts_with("Codex isn't installed here"), "{message}");
    assert!(!s.home.exists(), "nothing was made for a codex that isn't there");
}

#[tokio::test]
async fn needs_a_home() {
    let s = scenario(&[]);
    let no_home = start_device_login(&s.t, &DeviceLoginOpts::default()).await.unwrap_err();
    assert!(matches!(no_home, StartLoginError::Type(_)), "{no_home:?}");
    assert!(login_status(&s.t, &LoginStatusOpts::default()).await.is_err());
    assert!(logout(&s.t, &LogoutOpts::default()).await.is_err());
    assert!(get_device_login(&s.t, Path::new("")).is_err());
    assert!(cancel_device_login(&s.t, Path::new("  ")).await.is_err());
    assert_eq!(
        no_home.to_string(),
        "codex: codexHome is required (engine-env homeFor('chatgpt', 'codex', { stateDir }))"
    );
}

// --- loginStatus: shapes, never a token ---

#[tokio::test]
async fn not_signed_in() {
    let s = scenario(&[]);
    let st = login_status(&s.t, &s.status_opts()).await.unwrap();
    assert_eq!(
        serde_json::to_value(&st).unwrap(),
        json!({ "signedIn": false, "method": null })
    );
    assert_eq!(s.calls().len(), 0, "a home that isn't there is not asked about");
    // The home there and empty: codex is asked, and says the same.
    std::fs::create_dir_all(&s.home).unwrap();
    let st = login_status(&s.t, &s.status_opts()).await.unwrap();
    assert_eq!(
        serde_json::to_value(&st).unwrap(),
        json!({ "signedIn": false, "method": null })
    );
    assert_eq!(s.calls_with("status").len(), 1);
}

#[tokio::test]
async fn chatgpt_email_and_plan_from_the_id_token_the_last_refresh_and_no_token() {
    let s = scenario(&[]);
    write_chatgpt_auth(
        &s.home,
        ChatgptAuth {
            email: "someone@example.test",
            plan: "free",
            last_refresh: "2026-11-02T03:04:05Z",
            ..ChatgptAuth::default()
        },
    );
    let st = login_status(&s.t, &s.status_opts()).await.unwrap();
    assert_eq!(
        serde_json::to_value(&st).unwrap(),
        json!({ "signedIn": true, "method": "chatgpt", "email": "someone@example.test", "plan": "free", "lastRefresh": "2026-11-02T03:04:05.000Z" })
    );
    assert!(!serde_json::to_string(&st).unwrap().contains("canary"));
    assert_eq!(s.calls_with("status").len(), 1, "codex itself was asked");
}

#[tokio::test]
async fn chatgpt_the_email_can_come_from_the_profile_claim() {
    let s = scenario(&[]);
    write_chatgpt_auth(
        &s.home,
        ChatgptAuth {
            email: "profile@example.test",
            profile_only: true,
            ..ChatgptAuth::default()
        },
    );
    let st = login_status(
        &s.t,
        &LoginStatusOpts {
            cli: false,
            ..s.status_opts()
        },
    )
    .await
    .unwrap();
    assert_eq!(st.email.as_deref(), Some("profile@example.test"));
}

#[tokio::test]
async fn api_key_method_api_and_not_even_the_masked_key_the_cli_prints() {
    let s = scenario(&[]);
    write_api_key_auth(&s.home);
    let st = login_status(&s.t, &s.status_opts()).await.unwrap();
    assert_eq!(
        serde_json::to_value(&st).unwrap(),
        json!({ "signedIn": true, "method": "api" })
    );
}

#[tokio::test]
async fn cli_false_reads_auth_json_only_nothing_spawned() {
    let s = scenario(&[]);
    write_chatgpt_auth(
        &s.home,
        ChatgptAuth {
            plan: "pro",
            ..ChatgptAuth::default()
        },
    );
    let st = login_status(
        &s.t,
        &LoginStatusOpts {
            cli: false,
            ..s.status_opts()
        },
    )
    .await
    .unwrap();
    assert!(st.signed_in);
    assert_eq!(st.method, Some(LoginMethod::Chatgpt));
    assert_eq!(st.plan.as_deref(), Some("pro"));
    assert_eq!(st.checked, None);
    assert_eq!(s.calls().len(), 0);
}

#[tokio::test]
async fn an_auth_json_the_cli_doesnt_accept_isnt_signed_in() {
    let s = scenario(&[]);
    std::fs::create_dir_all(&s.home).unwrap();
    std::fs::write(s.home.join("auth.json"), "{ torn").unwrap();
    let st = login_status(&s.t, &s.status_opts()).await.unwrap();
    assert_eq!(
        serde_json::to_value(&st).unwrap(),
        json!({ "signedIn": false, "method": null })
    );
}

#[tokio::test]
async fn codex_missing_falls_back_to_the_file_and_says_it_couldnt_check() {
    let s = scenario(&[]);
    write_chatgpt_auth(
        &s.home,
        ChatgptAuth {
            plan: "free",
            ..ChatgptAuth::default()
        },
    );
    let st = login_status(
        &s.t,
        &LoginStatusOpts {
            codex_bin: Some(s.dir.join("no-such-codex")),
            ..s.status_opts()
        },
    )
    .await
    .unwrap();
    assert!(st.signed_in);
    assert_eq!(st.method, Some(LoginMethod::Chatgpt));
    assert_eq!(st.checked, Some(false));
}

#[tokio::test]
async fn a_home_whose_config_codex_mustnt_load_a_dotenv_a_refused_config_toml_the_file_answers_codex_is_never_asked() {
    for (name, text) in [
        (".env", "HTTPS_PROXY=http://127.0.0.1:9\n"),
        ("config.toml", "chatgpt_base_url = \"https://example.test/\"\n"),
    ] {
        let s = scenario(&[]);
        write_chatgpt_auth(
            &s.home,
            ChatgptAuth {
                plan: "free",
                ..ChatgptAuth::default()
            },
        );
        std::fs::write(s.home.join(name), text).unwrap();
        let st = login_status(&s.t, &s.status_opts()).await.unwrap();
        assert!(st.signed_in, "{name}");
        assert_eq!(st.method, Some(LoginMethod::Chatgpt), "{name}");
        assert_eq!(st.checked, Some(false), "{name}: says it couldn't check");
        assert_eq!(s.calls().len(), 0, "{name}: codex never ran");
        // Sign-out still removes the sign-in, without running codex in that home.
        let out = logout(&s.t, &s.logout_opts()).await.unwrap();
        assert_eq!(serde_json::to_value(&out).unwrap(), json!({ "ok": true }), "{name}");
        assert!(!s.home.join("auth.json").exists(), "{name}");
        assert_eq!(s.calls().len(), 0, "{name}: codex logout never ran");
    }
}

#[tokio::test]
async fn logout_signs_out_and_stops_a_login_in_progress() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "hang")]);
    write_chatgpt_auth(&s.home, ChatgptAuth::default());
    let login = start_device_login(&s.t, &s.start_opts()).await.unwrap();
    let out = logout(&s.t, &s.logout_opts()).await.unwrap();
    assert_eq!(serde_json::to_value(&out).unwrap(), json!({ "ok": true }));
    assert_eq!(login.done().await.code, Some(LoginCode::Cancelled));
    assert!(!s.home.join("auth.json").exists());
    let st = login_status(&s.t, &s.status_opts()).await.unwrap();
    assert_eq!(
        serde_json::to_value(&st).unwrap(),
        json!({ "signedIn": false, "method": null })
    );
    assert!(!s.calls_with("logout").is_empty(), "used `codex logout`");
}

// --- loginStatus on a real codex (offline: `codex login status` only reads auth.json) ---
//
// The JS ran these on the binary the pinned @openai/codex package installed, and skipped them when it wasn't there.
// The Rust build has no such package: they run when a test run names a codex in TARSEE_TEST_CODEX
// (`cargo test --test it real_codex -- --ignored`), and say they were ignored otherwise.

fn real_codex() -> PathBuf {
    PathBuf::from(std::env::var_os("TARSEE_TEST_CODEX").expect("TARSEE_TEST_CODEX names the codex to ask"))
}

/// A real program needs the system's own variables (its DLLs, its temp folder); nothing with a credential in it.
fn real_env(s: &Scenario) -> Env {
    for name in [
        "SystemRoot",
        "SystemDrive",
        "TEMP",
        "TMP",
        "PATH",
        "HOME",
        "USERPROFILE",
    ] {
        if let Some(value) = std::env::var_os(name) {
            s.env.set(name, value.to_string_lossy().to_string());
        }
    }
    s.env.clone()
}

#[tokio::test]
#[ignore = "needs a real codex: set TARSEE_TEST_CODEX to its path"]
async fn real_codex_chatgpt_sign_in() {
    let s = scenario(&[]);
    write_chatgpt_auth(
        &s.home,
        ChatgptAuth {
            email: "someone@example.test",
            plan: "free",
            ..ChatgptAuth::default()
        },
    );
    let st = login_status(
        &s.t,
        &LoginStatusOpts {
            codex_bin: Some(real_codex()),
            env: Some(real_env(&s)),
            ..s.status_opts()
        },
    )
    .await
    .unwrap();
    assert!(st.signed_in);
    assert_eq!(st.method, Some(LoginMethod::Chatgpt));
    assert_eq!(st.email.as_deref(), Some("someone@example.test"));
    assert_eq!(st.plan.as_deref(), Some("free"));
    assert_eq!(st.checked, None, "the CLI answered");
}

#[tokio::test]
#[ignore = "needs a real codex: set TARSEE_TEST_CODEX to its path"]
async fn real_codex_api_key_sign_in_with_nothing_of_the_key_in_the_answer() {
    let s = scenario(&[]);
    write_api_key_auth(&s.home);
    let st = login_status(
        &s.t,
        &LoginStatusOpts {
            codex_bin: Some(real_codex()),
            env: Some(real_env(&s)),
            ..s.status_opts()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(&st).unwrap(),
        json!({ "signedIn": true, "method": "api" })
    );
}

#[tokio::test]
#[ignore = "needs a real codex: set TARSEE_TEST_CODEX to its path"]
async fn real_codex_nothing_signed_in() {
    let s = scenario(&[]);
    std::fs::create_dir_all(&s.home).unwrap();
    let st = login_status(
        &s.t,
        &LoginStatusOpts {
            codex_bin: Some(real_codex()),
            env: Some(real_env(&s)),
            ..s.status_opts()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(&st).unwrap(),
        json!({ "signedIn": false, "method": null })
    );
}

// --- What the Node suite left out: the start's own time limit, a start that is cancelled, callers that come and go ---

#[tokio::test]
async fn a_codex_that_shows_nothing_in_time_is_stopped_and_what_it_said_decides_the_message() {
    // (The three run together. The one whose words decide the message gets long enough for the stand-in to have
    // started and said its piece on a busy machine; the other two end the same whatever arrived.)
    async fn outcome(mode: &str, limit_ms: u64) -> (LoginCode, String, Scenario) {
        let s = scenario(&[("FAKE_CODEX_LOGIN", mode)]);
        let (code, message) = s
            .start_error(DeviceLoginOpts {
                start_timeout: Duration::from_millis(limit_ms),
                ..s.start_opts()
            })
            .await;
        assert!(gone_soon(s.pid()).await, "{mode}: codex was stopped");
        assert_eq!(s.state(), Some(LoginState::Failed), "{mode}");
        (code, message, s)
    }
    let (silent, warning, error) = tokio::join!(
        outcome("silent", 3000),
        outcome("warning-only", 3000),
        outcome("stderr-error", 12_000)
    );
    // Nothing at all, or only a warning: no code.
    for (code, message, _) in [&silent, &warning] {
        assert_eq!(*code, LoginCode::NoCode);
        assert_eq!(
            message,
            "Codex didn't show a sign-in code in time. Check this server's internet connection and try again."
        );
    }
    // An error on stderr: that error, without the warning before it.
    assert_eq!(error.0, LoginCode::Failed);
    assert_eq!(error.1, "Codex couldn't sign in: the sign-in server said no");
}

#[tokio::test]
async fn a_login_that_is_still_starting_can_be_cancelled_and_every_caller_waiting_for_it_hears_so() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "silent")]);
    let first = {
        let (app, opts) = (s.t.app.clone(), s.start_opts());
        tokio::spawn(async move { start_device_login(&app, &opts).await })
    };
    let pid = s.pid_when_written().await;
    assert_eq!(s.state(), Some(LoginState::Starting));
    let snap = serde_json::to_value(get_device_login(&s.t, &s.home).unwrap().unwrap()).unwrap();
    assert_eq!(
        snap.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["status", "startedAt"],
        "{snap}"
    );
    // A second caller joins the same start: codex is not started again.
    let second = {
        let (app, opts) = (s.t.app.clone(), s.start_opts());
        tokio::spawn(async move { start_device_login(&app, &opts).await })
    };
    assert!(cancel_device_login(&s.t, &s.home).await.unwrap());
    for caller in [first, second] {
        let err = caller.await.unwrap().unwrap_err();
        assert_eq!(err.code(), Some(LoginCode::Cancelled));
        assert_eq!(err.to_string(), "Sign-in was cancelled.");
    }
    assert_eq!(s.calls_with("--device-auth").len(), 1, "codex started once");
    assert!(gone_soon(pid).await, "the codex that was starting is gone");
    assert_eq!(s.state(), Some(LoginState::Cancelled));
    assert!(!cancel_device_login(&s.t, &s.home).await.unwrap());
}

#[tokio::test]
async fn a_login_goes_on_when_the_caller_that_started_it_has_gone_and_a_new_one_starts_after_it_ends() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "hang")]);
    // The caller gives up before codex has shown anything (a request that was closed).
    let caller = {
        let (app, opts) = (s.t.app.clone(), s.start_opts());
        tokio::spawn(async move { start_device_login(&app, &opts).await })
    };
    let pid = s.pid_when_written().await;
    caller.abort();
    let _ = caller.await;
    // The login still reaches its code, and the next caller gets it.
    let login = start_device_login(&s.t, &s.start_opts()).await.unwrap();
    assert_eq!(login.code, "TEST-12345");
    assert_eq!(s.calls_with("--device-auth").len(), 1, "the same codex");
    assert_eq!(s.pid(), pid);
    login.cancel().await;
    assert!(gone_soon(pid).await);
    // Ended: starting again is a new login with a new codex.
    let again = start_device_login(&s.t, &s.start_opts()).await.unwrap();
    assert!(!again.is_same_login(&login));
    assert_eq!(s.calls_with("--device-auth").len(), 2);
    assert_eq!(s.state(), Some(LoginState::Waiting));
    again.cancel().await;
    assert!(gone_soon(s.pid()).await);
}

#[tokio::test]
async fn an_old_sign_in_is_not_taken_for_a_new_one_when_codex_exits_cleanly_without_writing_one() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "exit-no-auth"), ("FAKE_CODEX_DELAY_MS", "50")]);
    write_chatgpt_auth(&s.home, ChatgptAuth::default());
    let login = start_device_login(&s.t, &s.start_opts()).await.unwrap();
    let result = login.done().await;
    // `codex login status` says ChatGPT (the old file is still there), but the file is the one from before.
    assert_eq!(s.calls_with("status").len(), 1);
    assert_eq!(result.code, Some(LoginCode::NotConfirmed), "{result:?}");
    assert_eq!(s.state(), Some(LoginState::Failed));
}

#[tokio::test]
async fn the_code_lasts_as_long_as_the_cli_says_when_that_is_shorter_than_the_limit() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "hang"), ("FAKE_CODEX_MINUTES", "10")]);
    let t0 = now_ms();
    let login = start_device_login(&s.t, &s.start_opts()).await.unwrap();
    assert!(
        login.expires_at >= t0 + 10 * 60_000 && login.expires_at <= now_ms() + 10 * 60_000,
        "ten minutes from the start, not the default fifteen"
    );
    let snap = get_device_login(&s.t, &s.home).unwrap().unwrap();
    assert_eq!(snap.expires_at, Some(login.expires_at));
    assert_eq!(snap.expires_at, Some(snap.started_at + 10 * 60_000));
    login.cancel().await;
}

#[tokio::test]
async fn each_app_keeps_its_own_logins() {
    let s = scenario(&[("FAKE_CODEX_LOGIN", "hang")]);
    let other = test_app();
    let login = start_device_login(&s.t, &s.start_opts()).await.unwrap();
    assert_eq!(get_device_login(&other, &s.home).unwrap(), None);
    assert!(!cancel_device_login(&other, &s.home).await.unwrap());
    assert_eq!(s.state(), Some(LoginState::Waiting));
    login.cancel().await;
}

#[tokio::test]
async fn a_status_check_that_hangs_or_says_nothing_readable_falls_back_to_the_file() {
    let s = scenario(&[("FAKE_CODEX_STATUS", "hang")]);
    write_chatgpt_auth(&s.home, ChatgptAuth::default());
    let started = Instant::now();
    let st = login_status(
        &s.t,
        &LoginStatusOpts {
            timeout: Duration::from_millis(500),
            ..s.status_opts()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(&st).unwrap(),
        json!({ "signedIn": true, "method": "chatgpt", "email": "person@example.test", "plan": "plus", "lastRefresh": "2026-11-01T10:00:00.000Z", "checked": false })
    );
    assert!(started.elapsed() < Duration::from_secs(10));
    s.env.set("FAKE_CODEX_STATUS", "garbled");
    let st = login_status(&s.t, &s.status_opts()).await.unwrap();
    assert_eq!(st.checked, Some(false));
    assert!(st.signed_in);
    // What codex says wins over the file when it can be read: the file reads as an API-key login, codex says
    // ChatGPT (the fake looks at the tokens first), and the file's details are then not its to give.
    s.env.remove("FAKE_CODEX_STATUS");
    std::fs::write(
        s.home.join("auth.json"),
        json!({ "auth_mode": "apikey", "OPENAI_API_KEY": "k", "tokens": { "access_token": "a" } }).to_string(),
    )
    .unwrap();
    let st = login_status(&s.t, &s.status_opts()).await.unwrap();
    assert_eq!(
        serde_json::to_value(&st).unwrap(),
        json!({ "signedIn": true, "method": "chatgpt" })
    );
}

#[tokio::test]
async fn logout_with_no_home_or_no_codex_still_ends_signed_out_and_says_when_it_cant() {
    let s = scenario(&[]);
    // No home at all: nothing to do.
    let out = logout(&s.t, &s.logout_opts()).await.unwrap();
    assert_eq!(serde_json::to_value(&out).unwrap(), json!({ "ok": true }));
    assert_eq!(s.calls().len(), 0);
    // No codex: the file is removed all the same.
    write_api_key_auth(&s.home);
    let out = logout(
        &s.t,
        &LogoutOpts {
            codex_bin: Some(s.dir.join("no-such-codex")),
            ..s.logout_opts()
        },
    )
    .await
    .unwrap();
    assert!(out.ok && !s.home.join("auth.json").exists());
    // Something that can't be removed as a file: said plainly.
    std::fs::create_dir(s.home.join("auth.json")).unwrap();
    let out = logout(&s.t, &s.logout_opts()).await.unwrap();
    assert_eq!(
        serde_json::to_value(&out).unwrap(),
        json!({ "ok": false, "error": "Couldn't remove the saved ChatGPT sign-in (ERR_FS_EISDIR)." })
    );
}

/// Waits until `ready` says so (a file appearing, a process starting): on the thing itself, with a limit.
async fn until(what: &str, ready: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !ready() {
        assert!(Instant::now() < deadline, "still waiting: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_sign_out_that_has_begun_finishes_when_its_caller_has_gone() {
    // `codex logout` takes a while and then fails to remove the file: Tarsee removes it itself afterwards.
    let s = scenario(&[("FAKE_CODEX_LOGOUT_MS", "600"), ("FAKE_CODEX_LOGOUT", "keep")]);
    write_chatgpt_auth(&s.home, ChatgptAuth::default());
    let caller = {
        let (app, opts) = (s.t.app.clone(), s.logout_opts());
        tokio::spawn(async move { logout(&app, &opts).await })
    };
    until("codex logout to start", || !s.calls_with("logout").is_empty()).await;
    assert!(s.home.join("auth.json").exists(), "codex is still at it");
    // The caller leaves (a request whose client went away).
    caller.abort();
    let _ = caller.await;
    until("the sign-in file to go", || !s.home.join("auth.json").exists()).await;
}

#[tokio::test]
async fn a_status_check_whose_caller_has_gone_still_stops_the_codex_it_started_at_its_time_limit() {
    let s = scenario(&[("FAKE_CODEX_STATUS", "hang")]);
    write_chatgpt_auth(&s.home, ChatgptAuth::default());
    let caller = {
        let app = s.t.app.clone();
        let opts = LoginStatusOpts {
            timeout: Duration::from_millis(1500),
            ..s.status_opts()
        };
        tokio::spawn(async move { login_status(&app, &opts).await })
    };
    let pid = s.pid_when_written().await;
    caller.abort();
    let _ = caller.await;
    assert!(gone_soon(pid).await, "the codex that was asked is not left running");
}
