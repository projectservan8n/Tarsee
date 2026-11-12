//! Port of `src/config/env.js`: where Tarsee keeps its files, its port, sign-in and API token, and its timezone.
//!
//! The JS computed this once when the module was first imported and froze it. Here [`Config::load`] computes it once
//! from an [`Env`] (in `main`, or in a test with its own folders) and the result is held by the `App`.

use std::fs;
use std::path::{Path, PathBuf};

use rand::Rng;

use super::constants::get_recommended_model;
use crate::env::Env;
use crate::util::node_path::normalize;

/// The frozen configuration. Field names are the JS ones in snake_case (`config.STATE_DIR` is `config.state_dir`).
///
/// The folders are normalised (`a/../b`, a trailing separator: see `util::node_path`), also when they come from the
/// environment. Node normalised only the ones it joined itself, which let an oddly written `TARSEE_WORKSPACE_DIR`
/// defeat checks that compare paths.
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub state_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    /// The sign-in PIN; `None` when unset.
    pub setup_password: Option<String>,
    /// Stable token for REST and WebSocket API clients.
    pub api_token: String,
    /// Encrypts stored secrets; `None` stores them in plain text (acceptable for development only).
    pub encryption_key: Option<String>,
    /// "production" or "development" (the JS `NODE_ENV`; the variable keeps its name so existing deployments work).
    pub node_env: String,
    pub is_railway: bool,
    pub claude_workspace_dir: PathBuf,
    pub claude_default_model: String,
    /// IANA zone the agent reasons in for "today", "tomorrow at 9" and cron.
    pub timezone: String,
    /// The folder holding what ships with Tarsee besides the program: `public/` (the browser UI), `skills/`,
    /// `workspace-defaults/`, `i18n/` and `voice/` (the Python workers). New in the Rust version: the Node code found
    /// these next to its own source files. See [`resolve_assets_dir`].
    pub assets_dir: PathBuf,
}

impl Config {
    /// Reads the configuration from the environment, creating the folders, the default workspace files and the API
    /// token file on the way, exactly as the JS module did on import.
    pub fn load(env: &Env) -> Config {
        let port = env
            .get("PORT")
            .or_else(|| env.get("TARSEE_PORT"))
            .and_then(|p| parse_int_prefix(&p))
            .unwrap_or(3000);

        let state_dir = normalize(&resolve_state_dir(env));
        let workspace_dir = normalize(
            &env.trimmed("TARSEE_WORKSPACE_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| state_dir.join("workspace")),
        );
        let data_dir = normalize(
            &env.trimmed("TARSEE_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| state_dir.join("data")),
        );

        let skills_dir = workspace_dir.join("skills");
        let memory_dir = workspace_dir.join("memory");
        for dir in [&state_dir, &workspace_dir, &data_dir, &skills_dir, &memory_dir] {
            // Best-effort: may fail in a read-only container before the volume is mounted.
            let _ = create_private_dir(dir);
        }

        for (name, content) in DEFAULT_FILES {
            let path = workspace_dir.join(name);
            if !path.exists() && write_private_file(&path, content).is_ok() {
                log::info!("[config] Created default {name}");
            }
        }

        let is_railway = env.is_set("RAILWAY_PROJECT_ID");
        if is_railway {
            if state_dir.starts_with("/data") {
                log::info!("[config] Railway volume mounted at /data — data will persist across deploys");
            } else {
                log::warn!("[config] WARNING: Railway volume NOT mounted! Data will be LOST on redeploy.");
                log::warn!(
                    "[config] Go to Railway dashboard → your service → Settings → Add Volume → mount path: /data"
                );
            }
        }

        let api_token = resolve_api_token(env, &state_dir);
        let db_path = data_dir.join("tarsee.db");
        let claude_workspace_dir = normalize(
            &env.trimmed("CLAUDE_WORKSPACE_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| workspace_dir.clone()),
        );
        let claude_default_model = env
            .trimmed("CLAUDE_DEFAULT_MODEL")
            .unwrap_or_else(|| get_recommended_model().to_string());

        Config {
            port,
            state_dir,
            workspace_dir,
            data_dir,
            db_path,
            setup_password: env.trimmed("SETUP_PASSWORD"),
            api_token,
            encryption_key: env.trimmed("ENCRYPTION_KEY"),
            node_env: env
                .get("NODE_ENV")
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "development".to_string()),
            is_railway,
            claude_workspace_dir,
            claude_default_model,
            timezone: resolve_timezone(env),
            assets_dir: resolve_assets_dir(env),
        }
    }

    pub fn is_production(&self) -> bool {
        self.node_env == "production"
    }

    pub fn skills_dir(&self) -> PathBuf {
        self.workspace_dir.join("skills")
    }

    pub fn memory_dir(&self) -> PathBuf {
        self.workspace_dir.join("memory")
    }

    /// The browser UI files (the Node `src/public`).
    pub fn public_dir(&self) -> PathBuf {
        self.assets_dir.join("public")
    }

    /// The skills that ship with Tarsee (the Node `src/skills`), copied into the workspace when installed.
    pub fn bundled_skills_dir(&self) -> PathBuf {
        self.assets_dir.join("skills")
    }

    /// The shipped versions of the workspace files (the Node `src/workspace-defaults`).
    pub fn workspace_defaults_dir(&self) -> PathBuf {
        self.assets_dir.join("workspace-defaults")
    }

    /// The translations (the Node `src/i18n`).
    pub fn i18n_dir(&self) -> PathBuf {
        self.assets_dir.join("i18n")
    }

    /// The Python speech workers (`stt_worker.py`, `phonon_worker.py`; the Node `src/voice`).
    pub fn voice_scripts_dir(&self) -> PathBuf {
        self.assets_dir.join("voice")
    }
}

/// `Number.parseInt(text, 10)` for a port: leading whitespace, then digits; anything after them is ignored.
fn parse_int_prefix(text: &str) -> Option<u16> {
    let digits: String = text.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// The user's home folder (`os.homedir()`): the environment's own variable first, so a test can point it somewhere.
pub fn home_dir(env: &Env) -> PathBuf {
    let from_env = if cfg!(windows) {
        env.trimmed("USERPROFILE")
    } else {
        env.trimmed("HOME")
    };
    from_env
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `TARSEE_STATE_DIR`, else Railway's volume at /data when it is there, else `~/.tarsee`.
fn resolve_state_dir(env: &Env) -> PathBuf {
    if let Some(dir) = env.trimmed("TARSEE_STATE_DIR") {
        return PathBuf::from(dir);
    }
    if env.is_set("RAILWAY_PROJECT_ID") {
        let volume = Path::new("/data");
        // A stat, not an access check (permissions may differ), then our own folder to confirm it is writable.
        let usable =
            fs::metadata(volume).map(|m| m.is_dir()).unwrap_or(false) && fs::create_dir_all("/data/tarsee").is_ok();
        if usable {
            return PathBuf::from("/data/tarsee");
        }
        log::warn!("[tarsee] /data not accessible — using ephemeral storage");
    }
    home_dir(env).join(".tarsee")
}

/// Where the shipped files are: `TARSEE_ASSETS_DIR` when set; else an `assets` folder beside the program (how a
/// release is laid out); else the source tree this program was built from (a development build and the tests).
pub fn resolve_assets_dir(env: &Env) -> PathBuf {
    if let Some(dir) = env.trimmed("TARSEE_ASSETS_DIR") {
        return PathBuf::from(dir);
    }
    let beside_program = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("assets")));
    if let Some(dir) = beside_program.filter(|dir| dir.is_dir()) {
        return dir;
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join(ASSETS_IN_SOURCE_TREE)
}

/// The assets folder inside the repository. While the Node sources are still in place this is `src`, where the
/// Node version kept `public/`, `skills/` and the rest.
const ASSETS_IN_SOURCE_TREE: &str = "src";

/// `TARSEE_API_TOKEN`, else the token saved in `api.token`, else a new one (saved for next time).
fn resolve_api_token(env: &Env, state_dir: &Path) -> String {
    if let Some(token) = env.trimmed("TARSEE_API_TOKEN") {
        return token;
    }
    let token_path = state_dir.join("api.token");
    if let Ok(existing) = fs::read_to_string(&token_path) {
        let existing = existing.trim();
        if !existing.is_empty() {
            return existing.to_string();
        }
    }
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let generated = hex::encode(bytes);
    if let Err(err) = write_private_file(&token_path, &generated) {
        log::warn!("[config] Could not persist API token: {err}");
    }
    generated
}

/// `TARSEE_TIMEZONE`, else the host's zone; UTC when the zone is unknown, so one bad setting cannot break every
/// date for the life of the process.
fn resolve_timezone(env: &Env) -> String {
    let candidate = env
        .trimmed("TARSEE_TIMEZONE")
        .or_else(|| iana_time_zone::get_timezone().ok());
    let Some(candidate) = candidate else {
        return "UTC".to_string();
    };
    if candidate.parse::<chrono_tz::Tz>().is_ok() {
        return candidate;
    }
    log::warn!(
        "[config] Unknown timezone {} — falling back to UTC",
        serde_json::Value::String(candidate)
    );
    "UTC".to_string()
}

/// Creates a folder (and its parents) that only the owner can open (mode 0700 where the system has modes).
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

/// Writes a file that only the owner can read (mode 0600 where the system has modes). The mode applies when the
/// file is created, as with Node's `writeFileSync(..., { mode })`.
pub fn write_private_file(path: &Path, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(content.as_bytes())
}

/// The workspace identity files created on first boot, with their first contents.
pub const DEFAULT_FILES: &[(&str, &str)] = &[
    (
        "SOUL.md",
        r#"# Soul & Personality

You are Tarsee, a helpful AI assistant.
Be concise, direct, and helpful. Adapt your communication style to match the user.

<!-- Edit this file to change your bot's personality and behavior -->
"#,
    ),
    (
        "USER.md",
        r#"# About the User

<!-- Preferences and info about your human go here -->
<!-- This gets injected into every conversation so the bot knows you -->
"#,
    ),
    (
        "MEMORY.md",
        r#"# Long-Term Memory

<!-- Curated memories are stored here -->
<!-- Use /remember in chat or edit this file directly -->
"#,
    ),
    (
        "AGENTS.md",
        r#"# Agent Rules & Conventions

<!-- Define rules, workspace conventions, and how the agent should behave -->
<!-- This is always injected into the system prompt -->

## Approvals
- Anything hard to undo outside this chat needs the owner's go first: a new Discord channel or webhook, a credential, money, DNS, anything about Tarsee itself. Ask in one line and wait.
- When a tool asks who approved (approved_by), give who said go, in their words.

## Keys: check the vault every time
- Before any task that needs a key, token, password or login, check the vault yourself (the key list in your prompt, or tarsee_list_keys). Never ask the owner for a key, or say you don't have one, before checking.
- Only when the key isn't in the vault, ask the owner for it in one line.
- Every vault key named in capitals is already in your environment: a script reads it by name (os.environ["OPENAI_API_KEY"], process.env.OPENAI_API_KEY). Never paste a key's value into a command, a file or a chat.
"#,
    ),
    (
        "IDENTITY.md",
        r#"# Identity

- **Name:** Tarsee
- **Emoji:** 🐒
- **Creature:** Tarsier
- **Vibe:** Sees everything, forgets nothing

<!-- Metadata about the agent — parsed as key-value pairs -->
"#,
    ),
    (
        "TOOLS.md",
        r#"# Tools & Capabilities

<!-- Available tools, local setup notes, capabilities -->
<!-- This is injected into the system prompt so the bot knows what it can do -->

## Discord admin (channels, webhooks)
- Make, edit or list Discord channels and webhooks with tarsee_discord_admin. Never call Discord's API from the shell and never pull DISCORD_BOT_TOKEN from the vault for it: Tarsee's own bot does the work.
- Get the go first and pass who said it, in their words, as approved_by. A new webhook is a credential, so it needs the owner's go.
- create_webhook saves the URL in the vault (save_as_key) and shows only a masked URL. Never paste the full URL into a chat, a commit or a command.
- Nothing in the tool deletes. Deleting a channel or a webhook is for the owner to do by hand in Discord.

## Railway (projects, variables, redeploys)
- List projects, services and variable names, set a variable or redeploy with tarsee_railway. Never call Railway's API from the shell and never put a Railway token or a secret value in a command: Tarsee reads the token from the vault itself (RAILWAY_API_TOKEN, an account or workspace token).
- For anything secret, pass set_variable from_key (the vault key name), never value. The value is never shown, only a masked form.
- Get the go first and pass who said it, in their words, as approved_by. Putting a secret into a service is handing out a credential, so it needs the owner's go.
- On Railway, leaving out project means Tarsee's own project and service. Redeploying Tarsee's own service restarts it and ends the turn. Nothing in the tool deletes: deleting a variable or a service is for the owner to do by hand in Railway.
"#,
    ),
    (
        "HEARTBEAT.md",
        r#"# Heartbeat Tasks

<!-- Periodic tasks the bot checks every ~30 minutes -->
<!-- Leave empty to skip heartbeat runs (saves tokens) -->
<!-- Use HEARTBEAT_OK as response to suppress output -->
"#,
    ),
    (
        "BOOT.md",
        r#"# Boot Checklist

<!-- Runs once on every server restart -->
<!-- Leave empty to skip boot runs -->
"#,
    ),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::tmp_dir;

    fn env_in(dir: &Path) -> Env {
        Env::from_pairs([("TARSEE_STATE_DIR", dir.to_string_lossy().to_string())])
    }

    #[test]
    fn defaults_come_from_the_state_dir() {
        let dir = tmp_dir();
        let config = Config::load(&env_in(dir.path()));
        assert_eq!(config.port, 3000);
        assert_eq!(config.state_dir, dir.path());
        assert_eq!(config.workspace_dir, dir.path().join("workspace"));
        assert_eq!(config.data_dir, dir.path().join("data"));
        assert_eq!(config.db_path, dir.path().join("data").join("tarsee.db"));
        assert_eq!(config.claude_workspace_dir, config.workspace_dir);
        assert_eq!(config.claude_default_model, "sonnet");
        assert_eq!(config.node_env, "development");
        assert!(!config.is_production());
        assert!(!config.is_railway);
        assert_eq!(config.setup_password, None);
        assert_eq!(config.encryption_key, None);
    }

    #[test]
    fn the_folders_and_default_files_are_created_once_and_never_overwritten() {
        let dir = tmp_dir();
        let env = env_in(dir.path());
        let config = Config::load(&env);
        assert!(config.skills_dir().is_dir());
        assert!(config.memory_dir().is_dir());
        for (name, content) in DEFAULT_FILES {
            assert_eq!(
                &fs::read_to_string(config.workspace_dir.join(name)).unwrap(),
                content,
                "{name}"
            );
        }
        fs::write(config.workspace_dir.join("SOUL.md"), "mine").unwrap();
        Config::load(&env);
        assert_eq!(
            fs::read_to_string(config.workspace_dir.join("SOUL.md")).unwrap(),
            "mine"
        );
    }

    #[test]
    fn the_api_token_is_generated_once_then_read_back() {
        let dir = tmp_dir();
        let env = env_in(dir.path());
        let first = Config::load(&env).api_token;
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(fs::read_to_string(dir.path().join("api.token")).unwrap(), first);
        assert_eq!(Config::load(&env).api_token, first);
        env.set("TARSEE_API_TOKEN", "  from-env  ");
        assert_eq!(Config::load(&env).api_token, "from-env");
    }

    #[test]
    fn the_environment_overrides_each_setting() {
        let dir = tmp_dir();
        let env = env_in(dir.path());
        let ws = dir.path().join("elsewhere");
        env.set("TARSEE_WORKSPACE_DIR", ws.to_string_lossy().to_string());
        env.set("PORT", "8080");
        env.set("TARSEE_PORT", "9090");
        env.set("SETUP_PASSWORD", " 1234 ");
        env.set("ENCRYPTION_KEY", "k");
        env.set("NODE_ENV", "production");
        env.set("CLAUDE_DEFAULT_MODEL", "opus");
        env.set("RAILWAY_PROJECT_ID", "p");
        let config = Config::load(&env);
        assert_eq!(config.port, 8080);
        assert_eq!(config.workspace_dir, ws);
        assert_eq!(config.setup_password.as_deref(), Some("1234"));
        assert_eq!(config.encryption_key.as_deref(), Some("k"));
        assert!(config.is_production());
        assert_eq!(config.claude_default_model, "opus");
        assert!(config.is_railway);
    }

    #[test]
    fn tarsee_port_is_used_when_port_is_unset() {
        let dir = tmp_dir();
        let env = env_in(dir.path());
        env.set("TARSEE_PORT", "4100");
        assert_eq!(Config::load(&env).port, 4100);
    }

    #[test]
    fn an_unknown_timezone_falls_back_to_utc() {
        let dir = tmp_dir();
        let env = env_in(dir.path());
        env.set("TARSEE_TIMEZONE", "Europe/Berlin");
        assert_eq!(Config::load(&env).timezone, "Europe/Berlin");
        env.set("TARSEE_TIMEZONE", "Mars/Olympus_Mons");
        assert_eq!(Config::load(&env).timezone, "UTC");
    }

    #[test]
    fn the_shipped_files_are_found_in_the_source_tree_or_where_the_environment_says() {
        let dir = tmp_dir();
        let env = env_in(dir.path());
        let config = Config::load(&env);
        assert!(
            config.public_dir().join("index.html").is_file(),
            "{:?}",
            config.public_dir()
        );
        assert!(config.bundled_skills_dir().is_dir());
        assert!(config.workspace_defaults_dir().join("SOUL.md").is_file());
        assert!(config.i18n_dir().join("en.json").is_file());
        assert!(config.voice_scripts_dir().join("stt_worker.py").is_file());
        env.set(
            "TARSEE_ASSETS_DIR",
            dir.path().join("elsewhere").to_string_lossy().to_string(),
        );
        assert_eq!(Config::load(&env).assets_dir, dir.path().join("elsewhere"));
    }

    #[test]
    fn folders_from_the_environment_are_normalised() {
        let dir = tmp_dir();
        let env = env_in(dir.path());
        let odd = format!("{}/workspace/../ws/", dir.path().to_string_lossy());
        env.set("TARSEE_WORKSPACE_DIR", odd);
        let config = Config::load(&env);
        assert_eq!(config.workspace_dir, dir.path().join("ws"));
        assert_eq!(config.claude_workspace_dir, dir.path().join("ws"));
        assert_eq!(config.skills_dir(), dir.path().join("ws").join("skills"));
    }

    #[test]
    fn the_home_folder_comes_from_the_given_environment() {
        let name = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let env = Env::from_pairs([(name, "/somewhere/home")]);
        assert_eq!(home_dir(&env), PathBuf::from("/somewhere/home"));
    }
}
