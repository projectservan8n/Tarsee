//! Port of `src/lib/claude-transcript.js`: Claude Code transcript (.jsonl) locator + size helpers.
//!
//! Claude Code persists each session's full transcript to
//!   `<claude home>/projects/<slugified-cwd>/<session-id>.jsonl`
//! and re-reads it on every `resume`. That file — not our own `messages` table — is what actually refills the
//! model's context window each turn, so it is the real driver of context bloat and bloat-induced hangs.
//!
//! Which claude home. Every provider that runs on Claude Code has its own (design 4.5 R1, `ai/engine_env.rs`
//! `home_for`):
//!
//! ```text
//!   the Claude plan                     ~/.claude (on Railway entrypoint.sh symlinks /home/node/.claude to the
//!                                       volume, /data/tarsee/.claude-code-home)
//!   anthropic, deepseek, openrouter     <state dir>/.claude-home-<id>
//! ```
//!
//! Those homes are named here explicitly. CLAUDE_CONFIG_DIR is not read: every turn strips it from the engine's
//! environment (AUTH_ENV_RE), so the plan's sessions never land there, and a key home is set per turn, never
//! globally.
//!
//! A stored session handle ("deepseek/cc/deepseek:<id>", `ai/session_handle.rs`) names its provider, so its
//! transcript is looked up in that provider's home only; a bare id is the plan's, or any home's when no provider is
//! known. Codex sessions have no Claude transcript.
//!
//! The slug replaces path separators, whitespace and dots with "-" (verified against real ~/.claude/projects
//! entries). Because that rule has changed across Claude Code versions, we fall back to scanning the projects
//! directory for the session file rather than trusting the slug blindly.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::ai::context_limits::js_number;
use crate::ai::engine_env::{CLAUDE_CODE, HomeOpts, home_for};
use crate::ai::provider_registry::{Engine, PROVIDER_IDS, get_provider, normalize_provider_id};
use crate::ai::session_handle;
use crate::app::App;
use crate::config::env::home_dir;
use crate::env::Env;
use crate::lib::model_picker::js_to_fixed;
use crate::lib::safe_path::{node_dirname, node_join, node_resolve};
use crate::util::js;
use crate::util::node_path::to_namespaced;

/// `path.join(base, piece)`, worked out on the text as Node did: a piece that is a path of its own (the slug of a
/// Windows folder, a name with a drive in it) is still only more names under `base`, never a path that replaces it.
pub(crate) fn join_path(base: &Path, piece: &str) -> PathBuf {
    PathBuf::from(node_join(&[&base.to_string_lossy(), piece]))
}

/// Bytes-per-MB, so the intent is obvious at the call sites.
const MB: f64 = 1_048_576.0;

/// Default cap before a session is considered too bloated to resume.
///
/// The Mac build uses 3 MB, but its default model has a 200k window. This build's default (the `opus` alias) has a
/// 1M window, so 3 MB would abandon sessions that are still perfectly healthy. 8 MB is the equivalent headroom.
pub const DEFAULT_SESSION_JSONL_MAX_MB: f64 = 8.0;

/// The cap before a session is considered too bloated to resume (the JS constant `SESSION_JSONL_MAX_MB`):
/// `Number(env.TARSEE_SESSION_JSONL_MAX_MB) || 8`.
pub fn session_jsonl_max_mb(env: &Env) -> f64 {
    let own = env
        .get("TARSEE_SESSION_JSONL_MAX_MB")
        .map_or(f64::NAN, |raw| js_number(&raw));
    if own.is_nan() || own == 0.0 {
        DEFAULT_SESSION_JSONL_MAX_MB
    } else {
        own
    }
}

/// The providers with a Claude Code home of their own: every one that runs on Claude Code except the plan.
fn key_home_providers() -> impl Iterator<Item = &'static str> {
    PROVIDER_IDS
        .iter()
        .copied()
        .filter(|id| *id != "claude" && get_provider(id).is_some_and(|p| p.engines.contains(&Engine::ClaudeCode)))
}

/// Where to look (the JS `opts` of every function here): `provider` for a raw id, and the three places
/// [`provider_homes`] reads. Everything left out takes the app's own.
#[derive(Debug, Clone, Copy, Default)]
pub struct TranscriptOpts<'a> {
    /// The provider a raw (bare) id belongs to; without one it is looked for in every home.
    pub provider: Option<&'a str>,
    /// Default `config.state_dir`. An empty path means no state folder (the JS `null`): no key homes.
    pub state_dir: Option<&'a Path>,
    /// Default the user's home folder (`os.homedir()`).
    pub home_dir: Option<&'a Path>,
    /// Default the app's environment (`process.env`): HOME and TARSEE_STATE_DIR.
    pub env: Option<&'a Env>,
}

/// A Claude Code home and the provider whose sessions it holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderHome {
    pub provider: &'static str,
    pub home: PathBuf,
}

/// A home's transcript store: `<home>/projects`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRoot {
    pub provider: &'static str,
    pub root: PathBuf,
}

fn not_empty(path: &Path) -> bool {
    !path.as_os_str().is_empty()
}

/// Every Claude Code home, each with the provider whose sessions it holds, the plan's first: `[{ provider, home }]`.
///
/// The plan has a LIST of candidates, not one path: inside this container HOME is not what you would expect. The
/// Dockerfile declares no USER, so the ENTRYPOINT runs as root with HOME=/root, and `gosu node` drops the uid
/// WITHOUT rewriting HOME. Meanwhile entrypoint.sh symlinks /home/node/.claude to the persistent volume at
/// /data/tarsee/.claude-code-home. So the home folder/$HOME can point at /root while the real transcripts live under
/// /home/node — or directly on the volume. Rather than bet on one of those, probe all of them. The key homes are
/// where `engine_env.rs` puts them, under the state folder.
///
/// opts: `state_dir` (default `config.state_dir`), `home_dir` (default the user's home folder), `env` (default the
/// app's: HOME and TARSEE_STATE_DIR).
pub fn provider_homes(app: &App, opts: &TranscriptOpts<'_>) -> Vec<ProviderHome> {
    let env = opts.env.unwrap_or(app.env());
    let state_dir = opts.state_dir.unwrap_or(&app.config().state_dir).to_path_buf();
    let state_dir = Some(state_dir).filter(|dir| not_empty(dir));
    let home = opts
        .home_dir
        .filter(|dir| not_empty(dir))
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home_dir(app.env()));
    let from_env = |name: &str| env.get(name).filter(|value| !value.is_empty()).map(PathBuf::from);

    let plan: Vec<PathBuf> = [
        from_env("HOME").map(|dir| join_path(&dir, ".claude")),
        Some(PathBuf::from("/home/node/.claude")),
        Some(home)
            .filter(|dir| not_empty(dir))
            .map(|dir| join_path(&dir, ".claude")),
        from_env("TARSEE_STATE_DIR").map(|dir| join_path(&dir, ".claude-code-home")),
        state_dir.as_ref().map(|dir| join_path(dir, ".claude-code-home")),
    ]
    .into_iter()
    .flatten()
    .collect();

    let mut homes: Vec<ProviderHome> = plan
        .into_iter()
        .map(|home| ProviderHome {
            provider: "claude",
            home,
        })
        .collect();
    if let Some(state_dir) = &state_dir {
        let key_opts = HomeOpts {
            state_dir: Some(state_dir.clone()),
            home_dir: None,
        };
        // (A state folder that is only spaces has no key homes; the JS threw there.)
        homes.extend(key_home_providers().filter_map(|id| {
            let home = home_for(id, CLAUDE_CODE, app.env(), &key_opts).ok()?;
            Some(ProviderHome { provider: id, home })
        }));
    }

    // (path.resolve, on the text alone: two spellings of one folder are one home.)
    let cwd = std::env::current_dir().unwrap_or_default();
    let mut seen = HashSet::new();
    homes.retain(|h| seen.insert(node_resolve(&[&cwd.to_string_lossy(), &h.home.to_string_lossy()])));
    homes
}

/// Every home's transcript store: `[{ provider, root }]` where root is `<home>/projects`.
pub fn projects_roots_by_provider(app: &App, opts: &TranscriptOpts<'_>) -> Vec<ProviderRoot> {
    provider_homes(app, opts)
        .into_iter()
        .map(|h| ProviderRoot {
            provider: h.provider,
            root: join_path(&h.home, "projects"),
        })
        .collect()
}

/// The Claude plan's transcript roots (`<home>/projects`), most specific first. The key providers' homes are in
/// [`projects_roots_by_provider`].
pub fn projects_roots(app: &App, opts: &TranscriptOpts<'_>) -> Vec<PathBuf> {
    projects_roots_by_provider(app, opts)
        .into_iter()
        .filter(|r| r.provider == "claude")
        .map(|r| r.root)
        .collect()
}

/// The Claude plan's candidate home directories (the `.claude` dirs themselves, not their `projects/` subdir):
/// where its sign-in and model catalog live. Never a key provider's home.
pub fn claude_homes(app: &App, opts: &TranscriptOpts<'_>) -> Vec<PathBuf> {
    projects_roots(app, opts)
        .into_iter()
        .map(|root| PathBuf::from(node_dirname(&root.to_string_lossy())))
        .collect()
}

/// First candidate root that actually exists on disk (or the first candidate).
pub fn projects_root(app: &App) -> PathBuf {
    let roots = projects_roots(app, &TranscriptOpts::default());
    roots
        .iter()
        .find(|root| to_namespaced(root).exists())
        .or(roots.first())
        .cloned()
        .unwrap_or_else(|| PathBuf::from("/home/node/.claude/projects"))
}

/// Slugify a working directory the way Claude Code names its project dirs: each run of whitespace, "/" and "."
/// becomes one "-".
pub fn slugify_cwd(dir: &str) -> String {
    let mut out = String::with_capacity(dir.len());
    let mut in_run = false;
    for c in dir.chars() {
        if js::is_whitespace(c) || c == '/' || c == '.' {
            if !in_run {
                out.push('-');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// Where to look for a session: the raw id and the roots, from a stored handle or a raw id. A tagged handle names
/// its provider (a Codex one has no transcript: no roots); a bare id with `opts.provider` is that provider's; a bare
/// id without one is looked for in every home, the plan's first.
fn place_session(app: &App, session_id: &str, opts: &TranscriptOpts<'_>) -> (Option<String>, Vec<PathBuf>) {
    let Some(parsed) = session_handle::parse(session_id) else {
        return (None, Vec::new());
    };
    // (A raw id is a file name here: nothing with a path separator in it.)
    if parsed.raw_id.contains(['\\', '/']) {
        return (None, Vec::new());
    }
    if parsed.tagged && parsed.engine != Engine::ClaudeCode {
        return (Some(parsed.raw_id), Vec::new());
    }
    let named = if parsed.tagged {
        Some(parsed.provider.as_str())
    } else {
        opts.provider
    };
    let provider = named.and_then(normalize_provider_id);
    let roots = projects_roots_by_provider(app, opts)
        .into_iter()
        .filter(|r| provider.is_none_or(|id| r.provider == id))
        .map(|r| r.root)
        .collect();
    (Some(parsed.raw_id), roots)
}

/// Absolute path to a session's transcript, or `None` if it cannot be found. `session_id`: a stored handle or a raw
/// id (see `place_session`). opts: `provider` (for a raw id), `state_dir`, `home_dir`, `env` ([`provider_homes`]).
/// Tries the slug first, then falls back to scanning every project dir — the scan keeps this working if Claude Code
/// changes its slug rule.
pub fn transcript_path(app: &App, session_id: &str, opts: &TranscriptOpts<'_>) -> Option<PathBuf> {
    if session_id.is_empty() {
        return None;
    }
    let (raw_id, roots) = place_session(app, session_id, opts);
    let raw_id = raw_id.filter(|id| !id.is_empty())?;
    let file = format!("{raw_id}.jsonl");
    let workspace = &app.config().claude_workspace_dir;
    let cwd = if not_empty(workspace) {
        workspace.clone()
    } else {
        std::env::current_dir().unwrap_or_default()
    };
    let slug = slugify_cwd(&cwd.to_string_lossy());

    for root in roots {
        // Fast path: the slug we expect. Joined as text, the way Node's path.join did: the slug of a Windows folder
        // still holds its drive ("C:\work"), and must stay a name under the root, never a path of its own.
        // Every check goes to the system in the literal form, as Node's did: the id is a name from outside, and
        // Windows would otherwise read "nul.jsonl" as a device and drop a folder name's trailing dots.
        let direct = join_path(&join_path(&root, &slug), &file);
        if to_namespaced(&direct).exists() {
            return Some(direct);
        }

        // Fallback: scan the project dirs. Keeps working if Claude Code changes its slug rule, which it has done
        // before.
        let Ok(entries) = std::fs::read_dir(to_namespaced(&root)) else {
            continue; // root does not exist yet
        };
        // In name order, as Node's readdir gave them (libuv sorts): when two folders hold the file, the same one wins.
        let mut folders: Vec<std::ffi::OsString> = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .map(|entry| entry.file_name())
            .collect();
        folders.sort_by(|a, b| a.as_encoded_bytes().cmp(b.as_encoded_bytes()));
        for folder in folders {
            let candidate = join_path(&join_path(&root, &folder.to_string_lossy()), &file);
            if to_namespaced(&candidate).exists() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Transcript size in MB (1 decimal), or `None` when there is no transcript. opts: as [`transcript_path`]'s.
pub fn transcript_size_mb(app: &App, session_id: &str, opts: &TranscriptOpts<'_>) -> Option<f64> {
    let path = transcript_path(app, session_id, opts)?;
    let size = std::fs::metadata(to_namespaced(&path)).ok()?.len();
    js_to_fixed(size as f64 / MB, 1).parse().ok()
}

/// True when a session's transcript has grown past the cap and should be abandoned rather than resumed. Returns
/// false when there is no transcript (nothing to reset) so a brand-new session is never flagged. `cap_mb`: default
/// [`session_jsonl_max_mb`] of the app's environment.
pub fn is_transcript_over_cap(app: &App, session_id: &str, cap_mb: Option<f64>, opts: &TranscriptOpts<'_>) -> bool {
    let cap = cap_mb.unwrap_or_else(|| session_jsonl_max_mb(app.env()));
    transcript_size_mb(app, session_id, opts).is_some_and(|mb| mb > cap)
}

#[cfg(test)]
mod tests {
    //! The Node suite tested this file through test/usage-providers.test.js ("each provider's Claude Code home"),
    //! which belongs to the usage package; its three cases are ported here, with the functions it left untested.
    use super::*;
    use crate::testkit::{TestApp, test_app, test_app_with_env};

    fn write_transcript(home: &Path, session: &str, slug: &str, bytes: usize) -> PathBuf {
        let dir = home.join("projects").join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{session}.jsonl"));
        std::fs::write(&file, vec![b'x'; bytes]).unwrap();
        file
    }

    /// The test app's own folders: its state folder, and the home folder inside it.
    fn dirs(t: &TestApp) -> (PathBuf, PathBuf) {
        (t.config().state_dir.clone(), t.path().join("home"))
    }

    fn homes_of(homes: &[ProviderHome], id: &str) -> Vec<PathBuf> {
        homes
            .iter()
            .filter(|h| h.provider == id)
            .map(|h| h.home.clone())
            .collect()
    }

    #[test]
    fn lists_the_plans_home_and_a_home_for_every_key_provider_that_runs_on_claude_code_from_the_state_folder() {
        let t = test_app();
        let (state, home) = dirs(&t);
        let env = Env::from_pairs([("HOME", home.to_string_lossy().to_string())]);
        let homes = provider_homes(
            &t,
            &TranscriptOpts {
                state_dir: Some(&state),
                home_dir: Some(&home),
                env: Some(&env),
                ..TranscriptOpts::default()
            },
        );
        let plan = homes_of(&homes, "claude");
        assert!(plan.contains(&home.join(".claude")), "the plan's ~/.claude");
        assert!(
            plan.contains(&state.join(".claude-code-home")),
            "and its folder on the volume"
        );
        for id in ["anthropic", "deepseek", "openrouter"] {
            assert_eq!(
                homes_of(&homes, id),
                vec![state.join(format!(".claude-home-{id}"))],
                "{id}"
            );
        }
        for id in ["chatgpt", "openai", "local"] {
            assert!(homes_of(&homes, id).is_empty(), "{id} never runs on Claude Code");
        }
        // The plan's first, then the key providers in the registry's order; HOME and the home folder are one place.
        let order: Vec<&str> = homes.iter().map(|h| h.provider).collect();
        assert_eq!(
            order,
            ["claude", "claude", "claude", "anthropic", "openrouter", "deepseek"]
        );
        assert_eq!(plan[1], PathBuf::from("/home/node/.claude"));
    }

    #[test]
    fn no_longer_follows_claude_config_dir_which_every_turn_now_strips_the_plans_roots_are_its_own_homes_only() {
        let t = test_app();
        let (_, home) = dirs(&t);
        let elsewhere = t.path().join("somewhere-else");
        t.env()
            .set("CLAUDE_CONFIG_DIR", elsewhere.to_string_lossy().to_string());
        let roots = projects_roots(&t, &TranscriptOpts::default());
        assert!(!roots.iter().any(|r| r.starts_with(&elsewhere)), "{roots:?}");
        assert!(roots.contains(&home.join(".claude").join("projects")));
        assert!(
            !claude_homes(&t, &TranscriptOpts::default())
                .iter()
                .any(|h| h.to_string_lossy().contains(".claude-home-")),
            "a key home never counts as the plan's (its credentials, its model catalog)"
        );
    }

    #[test]
    fn finds_a_sessions_transcript_in_its_own_providers_home_from_a_stored_handle_or_a_raw_id() {
        let t = test_app();
        let (state, home) = dirs(&t);
        let none = TranscriptOpts::default();
        // (Another workspace's folder, so the scan finds it, not the slug.)
        let want = write_transcript(&state.join(".claude-home-deepseek"), "ds-find", "-srv-other", 40);
        write_transcript(&home.join(".claude"), "plan-find", "-srv-other", 40);
        assert_eq!(
            transcript_path(&t, "deepseek/cc/deepseek:ds-find", &none).as_ref(),
            Some(&want),
            "a tagged handle is untagged and looked up in its home"
        );
        let of = |provider: &'static str| TranscriptOpts {
            provider: Some(provider),
            ..TranscriptOpts::default()
        };
        assert_eq!(transcript_path(&t, "ds-find", &of("deepseek")).as_ref(), Some(&want));
        assert_eq!(
            transcript_path(&t, "ds-find", &of("claude")),
            None,
            "not in another provider's home"
        );
        assert_eq!(transcript_path(&t, "anthropic/cc/anthropic:ds-find", &none), None);
        assert_eq!(
            transcript_path(&t, "openai/cx/openai:ds-find", &none),
            None,
            "a Codex session has no Claude transcript"
        );
        let plan = transcript_path(&t, "plan-find", &none).expect("a bare id is the plan's");
        assert!(plan.ends_with("plan-find.jsonl"));
        assert_eq!(transcript_size_mb(&t, "deepseek/cc/deepseek:ds-find", &none), Some(0.0));
        // A bare id with no provider named is looked for in every home.
        assert_eq!(transcript_path(&t, "ds-find", &none).as_ref(), Some(&want));
        // The plan's storage id is the plan; a name the registry doesn't know narrows nothing, as in the JS.
        assert!(transcript_path(&t, "plan-find", &of("claude-code")).is_some());
        assert_eq!(transcript_path(&t, "ds-find", &of("gemini")).as_ref(), Some(&want));
    }

    // --- What the Node suite left untested ---

    #[test]
    fn the_slug_is_tried_first_and_the_scan_finds_what_the_slug_misses() {
        let t = test_app();
        let (_, home) = dirs(&t);
        let none = TranscriptOpts::default();
        let slug = slugify_cwd(&t.config().claude_workspace_dir.to_string_lossy());
        let by_scan = write_transcript(&home.join(".claude"), "both", "-zz-other", 10);
        assert_eq!(transcript_path(&t, "both", &none).as_ref(), Some(&by_scan));
        // The slug of a folder on Windows keeps its drive and backslashes: it can only ever be a name under the root.
        if !slug.contains(['\\', ':']) {
            let by_slug = write_transcript(&home.join(".claude"), "both", &slug, 10);
            assert_eq!(transcript_path(&t, "both", &none).as_ref(), Some(&by_slug));
        }
        // The same session in two folders the slug doesn't name: the first by name, as Node's sorted listing gave.
        for folder in ["-m", "-b", "-x"] {
            write_transcript(&home.join(".claude"), "twice", folder, 10);
        }
        assert_eq!(
            transcript_path(&t, "twice", &none),
            Some(home.join(".claude").join("projects").join("-b").join("twice.jsonl"))
        );
        // A file where a project folder should be is skipped; a missing root is no error.
        std::fs::write(home.join(".claude").join("projects").join("stray.jsonl"), "x").unwrap();
        assert_eq!(transcript_path(&t, "stray", &none), None);
        assert_eq!(transcript_path(&t, "nowhere", &none), None);
    }

    #[test]
    fn a_session_id_is_only_ever_a_file_name_under_a_projects_folder() {
        let t = test_app();
        let (_, home) = dirs(&t);
        let none = TranscriptOpts::default();
        // A file outside every projects folder, named as a session would be.
        let outside = t.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.jsonl"), "x").unwrap();
        write_transcript(&home.join(".claude"), "real", "-p", 10);
        let absolute = outside.join("secret").to_string_lossy().into_owned();
        for id in [
            absolute.as_str(),
            // From <home>/.claude/projects/-p, four steps up is the folder that holds "outside".
            "../../../../outside/secret",
            "..\\..\\..\\..\\outside\\secret",
            "deepseek/cc/deepseek:../../x",
            "deepseek/cc/deepseek:..\\x",
            "",
            "   ",
            "has space",
        ] {
            assert_eq!(transcript_path(&t, id, &none), None, "{id:?}");
            assert_eq!(transcript_size_mb(&t, id, &none), None, "{id:?}");
            assert!(!is_transcript_over_cap(&t, id, Some(-1.0), &none), "{id:?}");
        }
        // A device name is a file name like any other (Windows would open the device for "nul.jsonl").
        for device in ["nul", "con", "aux", "NUL"] {
            assert_eq!(transcript_path(&t, device, &none), None, "{device}");
        }
        // A drive-relative name (Windows) stays a name under the project folder: it never replaces the path.
        let drive = outside.to_string_lossy().chars().take(2).collect::<String>();
        if drive.ends_with(':') {
            assert_eq!(transcript_path(&t, &format!("{drive}secret"), &none), None);
        }
        assert!(transcript_path(&t, "real", &none).is_some());
    }

    #[test]
    fn the_size_is_megabytes_to_one_decimal_and_the_cap_is_past_it_only() {
        let t = test_app();
        let (_, home) = dirs(&t);
        let none = TranscriptOpts::default();
        // 1.25 MB is written "1.3" by toFixed (a tie goes up), 1.24 MB "1.2".
        write_transcript(&home.join(".claude"), "tie", "-p", 1_310_720);
        write_transcript(&home.join(".claude"), "under", "-p", 1_300_234);
        write_transcript(&home.join(".claude"), "small", "-p", 52_428);
        assert_eq!(transcript_size_mb(&t, "tie", &none), Some(1.3));
        assert_eq!(transcript_size_mb(&t, "under", &none), Some(1.2));
        assert_eq!(transcript_size_mb(&t, "small", &none), Some(0.0));
        assert_eq!(transcript_size_mb(&t, "missing", &none), None);
        assert!(is_transcript_over_cap(&t, "tie", Some(1.2), &none));
        assert!(
            !is_transcript_over_cap(&t, "tie", Some(1.3), &none),
            "at the cap is not over it"
        );
        assert!(
            !is_transcript_over_cap(&t, "tie", None, &none),
            "the default cap is 8 MB"
        );
        assert!(
            !is_transcript_over_cap(&t, "missing", Some(0.0), &none),
            "no transcript, nothing to reset"
        );
        t.env().set("TARSEE_SESSION_JSONL_MAX_MB", "1");
        assert!(
            is_transcript_over_cap(&t, "tie", None, &none),
            "the cap from the environment"
        );
    }

    #[test]
    fn the_cap_is_the_environments_number_or_eight() {
        let cap = |value: Option<&str>| {
            let env = Env::new();
            if let Some(value) = value {
                env.set("TARSEE_SESSION_JSONL_MAX_MB", value);
            }
            session_jsonl_max_mb(&env)
        };
        assert_eq!(cap(None), 8.0);
        assert_eq!(cap(Some("")), 8.0);
        assert_eq!(cap(Some("0")), 8.0);
        assert_eq!(cap(Some("abc")), 8.0);
        assert_eq!(cap(Some("3")), 3.0);
        assert_eq!(cap(Some(" 2.5 ")), 2.5);
        assert_eq!(cap(Some("-1")), -1.0);
        assert_eq!(DEFAULT_SESSION_JSONL_MAX_MB, 8.0);
    }

    #[test]
    fn the_slug_turns_each_run_of_separators_spaces_and_dots_into_one_dash() {
        assert_eq!(slugify_cwd("/srv/work"), "-srv-work");
        assert_eq!(slugify_cwd("/data/tarsee/workspace"), "-data-tarsee-workspace");
        assert_eq!(slugify_cwd("/home/a.b/my project/"), "-home-a-b-my-project-");
        assert_eq!(slugify_cwd("a/./b"), "a-b");
        assert_eq!(slugify_cwd("a\u{FEFF}b\u{0085}c"), "a-b\u{0085}c");
        // Backslashes and the drive's colon are not touched.
        assert_eq!(slugify_cwd("C:\\work\\my.app"), "C:\\work\\my-app");
        assert_eq!(slugify_cwd(""), "");
    }

    #[test]
    fn the_plans_candidates_come_from_home_the_home_folder_and_both_state_folders_once_each() {
        let t = test_app_with_env([("TARSEE_SESSION_JSONL_MAX_MB", "4")]);
        let (state, home) = dirs(&t);
        // The app's own environment: HOME is the test home, TARSEE_STATE_DIR the state folder.
        let own = claude_homes(&t, &TranscriptOpts::default());
        let want = vec![
            home.join(".claude"),
            PathBuf::from("/home/node/.claude"),
            state.join(".claude-code-home"),
        ];
        assert_eq!(
            own, want,
            "HOME and the home folder are one; so are the two state folders"
        );
        // Another HOME and another TARSEE_STATE_DIR are two more candidates, in the JS order.
        let other = t.path().join("other");
        let env = Env::from_pairs([
            ("HOME", other.join("h").to_string_lossy().to_string()),
            ("TARSEE_STATE_DIR", other.join("s").to_string_lossy().to_string()),
        ]);
        let homes = provider_homes(
            &t,
            &TranscriptOpts {
                env: Some(&env),
                ..TranscriptOpts::default()
            },
        );
        assert_eq!(
            homes_of(&homes, "claude"),
            vec![
                other.join("h").join(".claude"),
                PathBuf::from("/home/node/.claude"),
                home.join(".claude"),
                other.join("s").join(".claude-code-home"),
                state.join(".claude-code-home"),
            ]
        );
        // No state folder at all: the plan's candidates only, no key homes.
        let bare = provider_homes(
            &t,
            &TranscriptOpts {
                state_dir: Some(Path::new("")),
                env: Some(&Env::new()),
                ..TranscriptOpts::default()
            },
        );
        assert_eq!(
            bare.iter().map(|h| h.provider).collect::<Vec<_>>(),
            ["claude", "claude"]
        );
        assert_eq!(bare[1].home, home.join(".claude"));
        assert_eq!(session_jsonl_max_mb(t.env()), 4.0);
    }

    #[test]
    fn the_projects_root_is_the_first_that_exists_else_the_first_candidate() {
        let t = test_app();
        let (state, home) = dirs(&t);
        // Nothing exists yet: the first candidate (HOME's).
        assert_eq!(projects_root(&t), home.join(".claude").join("projects"));
        std::fs::create_dir_all(state.join(".claude-code-home").join("projects")).unwrap();
        assert_eq!(projects_root(&t), state.join(".claude-code-home").join("projects"));
        std::fs::create_dir_all(home.join(".claude").join("projects")).unwrap();
        assert_eq!(projects_root(&t), home.join(".claude").join("projects"));
    }
}
