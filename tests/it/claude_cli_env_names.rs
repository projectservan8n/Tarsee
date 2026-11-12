//! Port of test/claude-cli-env-names.test.js. The Claude Code CLI reads its sign-in, key and host from environment
//! variables, and every one of them must be stripped from every non-plan engine's environment (engine_env.rs
//! AUTH_ENV_RE, design 4.5 R2). The CLI adds such variables from release to release, so this scans a CLI binary for
//! every CLAUDE_* name shaped like a credential, a host or a proxy and checks each one is either stripped or on the
//! reviewed list below. A CLI update that brings a new one fails here, naming it, until someone decides which side it
//! belongs on.
//!
//! The Node version scanned the CLI the Agent SDK installed in node_modules. The Rust build starts the `claude` on
//! the machine (design decision 2), so the scan runs on the binary named by TARSEE_TEST_CLAUDE_CLI; with none named it
//! has nothing to scan, as the JS skipped when the SDK's binary wasn't installed.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use regex::bytes::Regex as BytesRegex;
use tarsee::ai::engine_env::is_auth_env_name;
use tarsee::testkit::tmp_dir;

/// Names shaped like a credential, a host or a proxy. Deliberately wide: a false hit only costs a line below.
static SHAPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("TOKEN|KEY|OAUTH|AUTH|BASE_URL|_BASE$|_URL$|SECRET|PASS|CREDENTIAL|DESCRIPTOR|CERT|PROXY").unwrap()
});

/// Credential-shaped CLAUDE_* names in the CLI that are deliberately NOT stripped, and why. Reviewed against Agent
/// SDK 0.3.142, and the names 0.3.319 added against that CLI (the CLI's own code was read for each one, and its own
/// lists of secrets to scrub, of hosts it sends a sign-in to, and of names that only look like secrets).
fn reviewed_not_stripped() -> BTreeMap<&'static str, &'static str> {
    BTreeMap::from([
        // Not environment variables at all.
        ("CLAUDE_AI_AUTHORIZE_URL", "a field of the CLI's OAuth settings object"),
        ("CLAUDE_AI_OAUTH_SCOPES", "an exported constant name"),
        ("CLAUDE_API_KEY", "placeholder text in the CLI's secrets screen"),
        ("CLAUDE_BASE", "an internal constant"),
        (
            "CLAUDE_CODE_ARG_KEY_SHAPE",
            "on the CLI's own list of names that only look like secrets",
        ),
        // Token counts and thresholds, not tokens.
        ("CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT", "a feature switch"),
        ("CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS", "a size limit"),
        ("CLAUDE_CODE_IDLE_TOKEN_THRESHOLD", "a size limit"),
        (
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
            "a size limit (engine-env sets it on gateway turns)",
        ),
        ("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "a size limit"),
        ("CLAUDE_CODE_RESUME_TOKEN_THRESHOLD", "a size limit"),
        ("CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS", "a size limit"),
        ("CLAUDE_CODE_TOTAL_TOKENS_REMINDER", "a size limit"),
        ("CLAUDE_CODE_TOTAL_TOKENS_REMINDER_AFTER_USER_TURN", "a size limit"),
        ("CLAUDE_CODE_TOTAL_TOKENS_REMINDER_BUDGET", "a size limit"),
        ("CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS", "a size limit"),
        // Timers and switches around a sign-in, not a sign-in.
        (
            "CLAUDE_CODE_AUTH_FAIL_EXIT_MS",
            "a timeout (on the CLI's own list of names that only look like secrets)",
        ),
        (
            "CLAUDE_CODE_DISABLE_AUTH_REFRESH_LOCK",
            "a switch for the lock around a sign-in refresh",
        ),
        // Set by the SDK or the CLI itself for its own children.
        (
            "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
            "set by the Agent SDK in the child it starts",
        ),
        (
            "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
            "set by the Agent SDK in the child it starts",
        ),
        (
            "CLAUDE_CODE_SDK_HAS_SESSIONS_OAUTH_REFRESH",
            "set by the Agent SDK in the child it starts",
        ),
        (
            "CLAUDE_CODE_MCP_SERVER_URL",
            "set by the CLI for an MCP headers helper it runs",
        ),
        ("CLAUDE_CODE_PROXY_URL", "set by the CLI for its proxy auth helper"),
        ("CLAUDE_CODE_PROXY_HOST", "set by the CLI for its proxy auth helper"),
        (
            "CLAUDE_CODE_PROXY_AUTHENTICATE",
            "set by the CLI for its proxy auth helper",
        ),
        ("CLAUDE_CODE_HOST_HTTP_PROXY_PORT", "the CLI's sandbox proxy port"),
        ("CLAUDE_CODE_HOST_SOCKS_PROXY_PORT", "the CLI's sandbox proxy port"),
        // The operator's own network, the same for every provider (like HTTPS_PROXY): not a provider's login,
        // billing or host.
        ("CLAUDE_CODE_HTTP_PROXY", "the operator's proxy"),
        ("CLAUDE_CODE_HTTPS_PROXY", "the operator's proxy"),
        ("CLAUDE_CODE_PROXY_RESOLVES_HOSTS", "the operator's proxy"),
        ("CLAUDE_CODE_SIMULATE_PROXY_USAGE", "a proxy test switch"),
        ("CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER", "the operator's proxy login"),
        ("CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS", "the operator's proxy login"),
        ("CLAUDE_CODE_CERT_STORE", "which CA certificates to trust"),
        ("CLAUDE_CODE_CLIENT_CERT", "the operator's mTLS client identity"),
        ("CLAUDE_CODE_CLIENT_KEY", "the operator's mTLS client identity"),
        (
            "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
            "the operator's mTLS client identity",
        ),
        (
            "CLAUDE_CODE_DISABLE_LOOPED_CROSS_CERT_DROP",
            "how CA certificates are read",
        ),
        (
            "CLAUDE_CODE_DISABLE_SELF_NAMED_CERT_DROP",
            "how CA certificates are read",
        ),
        ("CLAUDE_GATEWAY_PROXY_IS_EGRESS_BOUNDARY", "the operator's proxy"),
        // Set by a cloud session's launcher or runner for its git checkout and tools; no provider login, key or model
        // host.
        ("CLAUDE_CODE_AGENT_PROXY_GH_SHIM", "a cloud session's git proxy switch"),
        (
            "CLAUDE_CODE_AGENT_PROXY_GIT_CONFIG",
            "a cloud session's git proxy switch",
        ),
        (
            "CLAUDE_CODE_AGENT_PROXY_GIT_HOSTS",
            "the git hosts a cloud session's proxy governs",
        ),
        (
            "CLAUDE_RUNNER_GIT_MOUNT_URL",
            "the repository a cloud runner checks out",
        ),
        (
            "CLAUDE_RUNNER_PRIMARY_REPO_URL",
            "the repository a cloud runner checks out",
        ),
        ("CLAUDE_RUNNER_REPO_URL", "the repository a cloud runner checks out"),
        ("CLAUDE_RUNNER_USE_GIT_PROXY", "a cloud runner's git switch"),
        (
            "CLAUDE_CODE_WEBFETCH_USE_CCR_PROXY",
            "a cloud session's switch; only works with its own token, which is stripped",
        ),
        (
            "CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY",
            "a cloud session's switch; only works with its own token, which is stripped",
        ),
        // Where plugins, release notes and browser tab groups come from: not a provider's login, billing or model
        // host.
        ("CLAUDE_CODE_MARKETPLACE_URL", "where plugins come from"),
        ("CLAUDE_CODE_PLUGIN_ARCHIVE_URL", "where plugins come from"),
        ("CLAUDE_CODE_DEV_RAW_CHANGELOG_URL", "where the release notes come from"),
        ("CLAUDE_CHROME_TAB_GROUP_KEY", "a browser tab group id"),
        // Only matter with a CLAUDE_CODE_USE_* backend, which is stripped.
        (
            "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
            "needs CLAUDE_CODE_USE_ANTHROPIC_AWS",
        ),
        ("CLAUDE_CODE_SKIP_BEDROCK_AUTH", "needs CLAUDE_CODE_USE_BEDROCK"),
        ("CLAUDE_CODE_SKIP_FOUNDRY_AUTH", "needs CLAUDE_CODE_USE_FOUNDRY"),
        ("CLAUDE_CODE_SKIP_MANTLE_AUTH", "needs CLAUDE_CODE_USE_MANTLE"),
        ("CLAUDE_CODE_SKIP_VERTEX_AUTH", "needs CLAUDE_CODE_USE_VERTEX"),
        (
            "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
            "needs CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
        ),
    ])
}

/// The Claude sign-in and host variables the CLI was found to read; each must stay stripped.
const KNOWN_CREDENTIALS: [&str; 24] = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_OAUTH_CLIENT_ID",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_API_BASE_URL",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_CUSTOM_OAUTH_URL",
    "CLAUDE_LOCAL_OAUTH_API_BASE",
    "CLAUDE_LOCAL_OAUTH_APPS_BASE",
    "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
    "CLAUDE_TRUSTED_DEVICE_TOKEN",
    "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
    "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
    "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
    // Agent SDK 0.3.319.
    "CLAUDE_CODE_SESSIONS_OAUTH_TOKEN",
    "CLAUDE_CODE_GATEWAY_TOKEN",
    "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
    "CLAUDE_BRIDGE_OAUTH_TOKEN",
    "CLAUDE_BRIDGE_BASE_URL",
    "CLAUDE_CODE_ARTIFACTS_API_TOKEN",
    "CLAUDE_CODE_MEMORY_API_TOKEN",
    "CLAUDE_BG_CLAIM_AUTH",
];

static CLAUDE_NAME: LazyLock<BytesRegex> = LazyLock::new(|| BytesRegex::new("CLAUDE_[A-Z0-9_]+").unwrap());

fn is_name_byte(b: u8) -> bool {
    b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'
}

/// Every CLAUDE_* name in a (large) binary, read in chunks so the whole file is never in memory at once. A name
/// starting in the overlap is read whole by the next chunk; one cut off at the end isn't a name.
fn claude_names(file: &Path, chunk: usize, overlap: usize) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let mut f = std::fs::File::open(file).unwrap();
    let size = f.metadata().unwrap().len() as usize;
    let mut buf = vec![0u8; chunk + overlap];
    let mut pos = 0;
    while pos < size {
        f.seek(SeekFrom::Start(pos as u64)).unwrap();
        let mut n = 0;
        while n < buf.len() {
            let got = f.read(&mut buf[n..]).unwrap();
            if got == 0 {
                break;
            }
            n += got;
        }
        let text = &buf[..n];
        let last = pos + chunk >= size;
        for m in CLAUDE_NAME.find_iter(text) {
            // `(?<![A-Z0-9_])`: not the tail of a longer name.
            if m.start() > 0 && is_name_byte(text[m.start() - 1]) {
                continue;
            }
            if m.start() >= chunk || (!last && m.end() >= n) {
                continue;
            }
            names.insert(String::from_utf8_lossy(m.as_bytes()).into_owned());
        }
        pos += chunk;
    }
    names
}

#[test]
fn every_credential_shaped_claude_name_the_cli_knows_is_stripped_or_reviewed_as_not_a_provider_credential() {
    let Some(cli) = std::env::var_os("TARSEE_TEST_CLAUDE_CLI") else {
        return; // no CLI binary named for this run
    };
    let cli = Path::new(&cli);
    let reviewed = reviewed_not_stripped();
    let names: Vec<String> = claude_names(cli, 16 * 1024 * 1024, 512)
        .into_iter()
        .filter(|n| SHAPE.is_match(n))
        .collect();
    assert!(
        names.len() > 20,
        "found only {} names in {}: is this the CLI?",
        names.len(),
        cli.display()
    );
    let unreviewed: Vec<&String> = names
        .iter()
        .filter(|n| !is_auth_env_name(n) && !reviewed.contains_key(n.as_str()))
        .collect();
    assert!(
        unreviewed.is_empty(),
        "{}'s CLI reads credential-shaped variables nobody has classified: {unreviewed:?}. For each, read what the CLI \
         does with it: if it chooses a login, a key, billing or a host, add it to AUTH_ENV_RE in src/ai/engine_env.rs \
         (and design 4.5 R2); otherwise add it to reviewed_not_stripped() here with the reason.",
        cli.display()
    );
    for n in KNOWN_CREDENTIALS {
        assert!(
            names.iter().any(|x| x == n),
            "{n} is gone from the CLI: check what replaced it"
        );
    }
}

#[test]
fn the_reviewed_list_never_shadows_a_name_that_is_stripped() {
    for n in reviewed_not_stripped().keys() {
        assert!(!is_auth_env_name(n), "{n} is stripped; drop it from the reviewed list");
    }
    for n in KNOWN_CREDENTIALS {
        assert!(is_auth_env_name(n), "{n} must be stripped");
    }
}

#[test]
fn the_scan_finds_every_name_once_across_chunk_edges_and_never_the_tail_of_a_longer_one() {
    let tmp = tmp_dir();
    let file = tmp.path().join("cli.bin");
    let mut bytes = Vec::new();
    for i in 0..40 {
        bytes.extend_from_slice(b"\x00\x01junk");
        bytes.extend_from_slice(format!("CLAUDE_NAME_{i}_TOKEN").as_bytes());
        bytes.extend_from_slice(&vec![b'.'; i * 3]);
    }
    bytes.extend_from_slice(b"XCLAUDE_NOT_A_NAME ");
    bytes.extend_from_slice(b"CLAUDE_AT_THE_END");
    // (A name that ends exactly at the end of the file across a chunk edge is dropped, as the JS scan dropped it.)
    bytes.extend_from_slice(b"\x00\x00");
    std::fs::write(&file, &bytes).unwrap();
    for chunk in [32, 50, 64, 4096] {
        let names = claude_names(&file, chunk, 40);
        for i in 0..40 {
            assert!(names.contains(&format!("CLAUDE_NAME_{i}_TOKEN")), "chunk {chunk}: {i}");
        }
        assert!(names.contains("CLAUDE_AT_THE_END"), "chunk {chunk}");
        assert!(!names.contains("CLAUDE_NOT_A_NAME"), "chunk {chunk}");
        assert!(
            names
                .iter()
                .all(|n| n.starts_with("CLAUDE_NAME_") || n == "CLAUDE_AT_THE_END"),
            "chunk {chunk}: no cut-off pieces: {names:?}"
        );
    }
}
