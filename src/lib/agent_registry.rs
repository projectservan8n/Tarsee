//! Port of `src/lib/agent-registry.js`: the agent definitions (Coder, Researcher, Writer, Quick, and the owner's own).
//!
//! Each agent has an id, a name, a model, a system prompt, its allowed tools and a colour. They are kept in the
//! settings as "agents.registry" (JSON). The orchestrator (the main chat session) delegates tasks to them.
//!
//! Models are resolved by tier (opus/sonnet/haiku) from the central model registry, so the defaults always point at
//! the latest model in each tier without code changes when a new one ships.
//!
//! The JS kept the settings store it was given in a module variable (`initAgentRegistry(settingsStore)`); here it is
//! an [`AgentRegistry`] service in the [`App`]. Agents stay JSON objects: the owner's may carry any field, and the UI
//! reads them as they are stored.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::app::App;
use crate::config::constants::resolve_model_alias;
use crate::db::settings::Settings;
use crate::env::Env;
use crate::lib::workspace_files::is_plain_name;
use crate::lib::workspace_files::jstext::{js_string, path_type_error};
use crate::util::js::{truthy, utf16_truncate};
use crate::util::node_path;

const REGISTRY_KEY: &str = "agents.registry";

/// The four agents a new install starts with.
pub fn default_agents() -> Vec<Value> {
    vec![
        json!({
            "id": "coder",
            "name": "Coder",
            "nickname": "",
            "model": resolve_model_alias("opus"),
            "prompt": "You are a senior software engineer. Write clean, production-grade code. Debug thoroughly. Always test your work. Use Read, Write, Edit, Bash, Grep, Glob tools. Be concise — code speaks louder than explanations.",
            "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
            "color": "#4caf50",
            "icon": "ph ph-code",
            "status": "online",
        }),
        json!({
            "id": "researcher",
            "name": "Researcher",
            "nickname": "",
            "model": resolve_model_alias("sonnet"),
            "prompt": "You are a thorough researcher. Search the web, read documents, analyze data, and summarize findings. Be comprehensive but concise. Cite sources. Use web_fetch, web_search, Read tools.",
            "tools": ["Read", "Bash", "Glob", "Grep"],
            "color": "#2196f3",
            "icon": "ph ph-magnifying-glass",
            "status": "online",
        }),
        json!({
            "id": "writer",
            "name": "Writer",
            "nickname": "",
            "model": resolve_model_alias("sonnet"),
            "prompt": "You are a professional writer. Draft emails, documents, reports, and content. Match the user's tone and style. Be clear, concise, and compelling. Use Read and Write tools for file output.",
            "tools": ["Read", "Write", "Edit", "Bash"],
            "color": "#ff9800",
            "icon": "ph ph-pencil-line",
            "status": "online",
        }),
        json!({
            "id": "quick",
            "name": "Quick",
            "nickname": "",
            "model": resolve_model_alias("haiku"),
            "prompt": "You are a fast assistant for simple tasks. Answer quickly, format data, do calculations, lookups. Be extremely concise — one sentence when possible.",
            "tools": ["Read", "Bash", "Grep"],
            "color": "#9c27b0",
            "icon": "ph ph-lightning",
            "status": "online",
        }),
    ]
}

/// The settings store the agents are kept in.
pub struct AgentRegistry {
    settings: Arc<dyn Settings>,
}

/// The default agents of this app. The JS handed out its one `DEFAULT_AGENTS` array itself, so an upsert made while
/// the defaults stood in for a stored list changed them for the rest of the process; this keeps that per app.
struct DefaultAgents(Mutex<Vec<Value>>);

fn defaults(app: &App) -> Arc<DefaultAgents> {
    app.get_or_init(|| DefaultAgents(Mutex::new(default_agents())))
}

/// Starts the registry over a settings store (`initAgentRegistry(settingsStore)`): seeds the defaults when the stored
/// list is empty, then makes each agent's workspace folder. Fails, as the JS threw at boot, when an agent's id is not
/// text.
pub fn init_agent_registry(app: &App, settings: Arc<dyn Settings>) -> anyhow::Result<()> {
    app.set(AgentRegistry {
        settings: settings.clone(),
    });
    // Seed defaults if no agents exist.
    if get_agents(app).is_empty() {
        let seeded = defaults(app).0.lock().clone();
        settings.set(REGISTRY_KEY, Value::String(Value::Array(seeded).to_string()))?;
    }
    ensure_agent_workspaces(app)?;
    Ok(())
}

/// Makes the workspace folder of every agent, `<state>/agents/<id>/`, with a MEMORY.md and a SOUL.md if missing. A
/// folder that cannot be made is skipped, and so is an id that is not one plain name (the JS joined it as it was, so
/// `../x` reached outside the agents folder). An id that is not text is an error, as the JS's `path.join` threw.
pub fn ensure_agent_workspaces(app: &App) -> anyhow::Result<()> {
    let base = get_agents_base_dir(app.env());
    for agent in get_agents(app) {
        if agent.get("isOrchestrator").is_some_and(truthy) {
            continue;
        }
        let id = match agent.get("id") {
            Some(Value::String(id)) => id.clone(),
            other => anyhow::bail!(path_type_error(other)),
        };
        if !is_plain_name(&id) {
            continue;
        }
        // The literal path: on Windows an id `nul` or `coder.` names a folder of that name.
        let dir = node_path::to_namespaced(&base.join(&id));
        let made = std::fs::create_dir_all(&dir).and_then(|()| {
            let name = js_string(agent.get("name"));
            let mem = dir.join("MEMORY.md");
            if !mem.exists() {
                std::fs::write(
                    &mem,
                    format!("# {name} Memory\n\nTask history and learned knowledge.\n"),
                )?;
            }
            let soul = dir.join("SOUL.md");
            if !soul.exists() {
                std::fs::write(&soul, format!("# {name}\n\n{}\n", js_string(agent.get("prompt"))))?;
            }
            Ok(())
        });
        // A folder that cannot be made is skipped.
        let _ = made;
    }
    Ok(())
}

/// Where the agents' workspaces are: `$TARSEE_STATE_DIR/agents`, else `$HOME/agents`, else `/data/tarsee/agents`.
pub fn get_agents_base_dir(env: &Env) -> PathBuf {
    let base = env
        .get("TARSEE_STATE_DIR")
        .filter(|v| !v.is_empty())
        .or_else(|| env.get("HOME").filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "/data/tarsee".to_string());
    node_path::join(Path::new(&base), "agents")
}

/// One agent's workspace folder; `None` for an id that is not one plain name (which would lead out of the agents
/// folder).
pub fn get_agent_workspace(env: &Env, agent_id: &str) -> Option<PathBuf> {
    is_plain_name(agent_id).then(|| get_agents_base_dir(env).join(agent_id))
}

/// Every agent definition: the stored list without the old orchestrator entry (the main chat agent IS the
/// orchestrator), or the defaults when nothing usable is stored or the registry was never started.
pub fn get_agents(app: &App) -> Vec<Value> {
    agents_and_source(app).0
}

/// The agents, and whether they are this app's defaults (not a stored list).
fn agents_and_source(app: &App) -> (Vec<Value>, bool) {
    let fallback = || (defaults(app).0.lock().clone(), true);
    let Some(registry) = app.get::<AgentRegistry>() else {
        return fallback();
    };
    let raw = registry.settings.get(REGISTRY_KEY);
    let Some(raw) = raw.filter(truthy) else {
        return fallback();
    };
    let agents = match raw {
        Value::String(text) => match serde_json::from_str::<Value>(&text) {
            Ok(parsed) => parsed,
            Err(_) => return fallback(),
        },
        other => other,
    };
    let Value::Array(list) = agents else {
        return fallback();
    };
    // `a.isOrchestrator` on a null entry threw, which gave the defaults.
    if list.iter().any(Value::is_null) {
        return fallback();
    }
    let list = list
        .into_iter()
        .filter(|a| !a.get("isOrchestrator").is_some_and(truthy))
        .collect();
    (list, false)
}

/// An agent by id, or by nickname whatever its case.
pub fn get_agent(app: &App, id_or_nickname: &str) -> Option<Value> {
    let wanted = id_or_nickname.to_lowercase();
    get_agents(app).into_iter().find(|a| {
        a.get("id").and_then(Value::as_str) == Some(id_or_nickname)
            || a.get("nickname")
                .and_then(Value::as_str)
                .is_some_and(|n| !n.is_empty() && n.to_lowercase() == wanted)
    })
}

/// Adds an agent, or merges the given fields into the one with its id. Returns the given agent.
pub fn upsert_agent(app: &App, agent: Value) -> anyhow::Result<Value> {
    let has = |key: &str| agent.get(key).is_some_and(truthy);
    if !has("id") || !has("name") || !has("model") {
        anyhow::bail!("Agent must have id, name, and model");
    }
    let (mut agents, from_defaults) = agents_and_source(app);
    match agents.iter().position(|a| a.get("id") == agent.get("id")) {
        Some(index) => {
            let mut merged: Map<String, Value> = agents[index].as_object().cloned().unwrap_or_default();
            if let Some(fields) = agent.as_object() {
                for (key, value) in fields {
                    merged.insert(key.clone(), value.clone());
                }
            }
            agents[index] = Value::Object(merged);
        }
        None => agents.push(agent.clone()),
    }
    if from_defaults {
        *defaults(app).0.lock() = agents.clone();
    }
    save(app, agents)?;
    Ok(agent)
}

/// Removes an agent definition.
pub fn remove_agent(app: &App, id: &str) -> anyhow::Result<bool> {
    let agents: Vec<Value> = get_agents(app)
        .into_iter()
        .filter(|a| a.get("id").and_then(Value::as_str) != Some(id))
        .collect();
    save(app, agents)?;
    Ok(true)
}

fn save(app: &App, agents: Vec<Value>) -> anyhow::Result<()> {
    if let Some(registry) = app.get::<AgentRegistry>() {
        registry
            .settings
            .set(REGISTRY_KEY, Value::String(Value::Array(agents).to_string()))?;
    }
    Ok(())
}

/// A brief list of the agents, for the system prompt.
pub fn get_agents_summary(app: &App) -> String {
    get_agents(app)
        .iter()
        .map(|a| {
            let nick = match a.get("nickname").filter(|n| truthy(n)) {
                Some(n) => format!(" aka \"{}\"", js_string(Some(n))),
                None => String::new(),
            };
            let icon = a
                .get("icon")
                .filter(|i| truthy(i))
                .map(|i| js_string(Some(i)))
                .unwrap_or_else(|| "🤖".into());
            format!(
                "- {icon} {}{nick} ({}): {} — {}",
                js_string(a.get("name")),
                js_string(a.get("id")),
                js_string(a.get("model")),
                utf16_truncate(&js_string(a.get("prompt")), 60)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{MemorySettings, TestApp, test_app};

    fn started(stored: Option<Value>) -> (TestApp, Arc<MemorySettings>) {
        let t = test_app();
        let settings = Arc::new(MemorySettings::new());
        if let Some(value) = stored {
            settings.set(REGISTRY_KEY, value).unwrap();
        }
        init_agent_registry(&t, settings.clone()).unwrap();
        (t, settings)
    }

    fn ids(agents: &[Value]) -> Vec<&str> {
        agents.iter().map(|a| a["id"].as_str().unwrap_or("?")).collect()
    }

    #[test]
    fn the_defaults_name_the_latest_model_of_each_tier() {
        let agents = default_agents();
        assert_eq!(ids(&agents), ["coder", "researcher", "writer", "quick"]);
        assert_eq!(agents[0]["model"], "opus");
        assert_eq!(agents[1]["model"], "sonnet");
        assert_eq!(agents[3]["model"], "haiku");
        assert_eq!(
            agents[0].as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "id", "name", "nickname", "model", "prompt", "tools", "color", "icon", "status"
            ]
        );
    }

    #[test]
    fn without_the_registry_the_defaults_are_the_agents() {
        let t = test_app();
        assert_eq!(ids(&get_agents(&t)), ["coder", "researcher", "writer", "quick"]);
        assert_eq!(get_agent(&t, "writer").unwrap()["name"], "Writer");
        // Without a store the JS changed its defaults in place: the new agent stays for the rest of the process.
        upsert_agent(&t, json!({"id": "x", "name": "X", "model": "m"})).unwrap();
        assert_eq!(ids(&get_agents(&t)), ["coder", "researcher", "writer", "quick", "x"]);
        upsert_agent(&t, json!({"id": "coder", "name": "Dev", "model": "m"})).unwrap();
        assert_eq!(get_agent(&t, "coder").unwrap()["name"], "Dev");
        // Removing builds a new list, which without a store goes nowhere.
        remove_agent(&t, "x").unwrap();
        assert_eq!(get_agents(&t).len(), 5);
        // Another app has its own defaults.
        assert_eq!(get_agents(&test_app()).len(), 4);
    }

    #[test]
    fn an_upsert_while_the_defaults_stand_in_also_changes_them() {
        let (t, settings) = started(None);
        upsert_agent(&t, json!({"id": "ops", "name": "Ops", "model": "m"})).unwrap();
        let stored: Value = serde_json::from_str(settings.get(REGISTRY_KEY).unwrap().as_str().unwrap()).unwrap();
        assert_eq!(stored.as_array().unwrap().len(), 5);
        // The stored list is gone; the defaults that stand in for it kept the new agent, as in the JS.
        settings.delete(REGISTRY_KEY);
        assert_eq!(ids(&get_agents(&t)), ["coder", "researcher", "writer", "quick", "ops"]);
    }

    #[test]
    fn an_agent_whose_id_is_not_text_stops_the_start_as_the_js_threw() {
        let t = test_app();
        let settings = Arc::new(MemorySettings::new());
        settings
            .set(
                REGISTRY_KEY,
                json!([{"id": "ops", "name": "Ops"}, {"id": 5, "name": "Five"}]),
            )
            .unwrap();
        let err = init_agent_registry(&t, settings).unwrap_err();
        assert_eq!(
            err.to_string(),
            "The \"path\" argument must be of type string. Received type number (5)"
        );
        assert!(
            get_agents_base_dir(t.env()).join("ops").is_dir(),
            "the agents before it got their folder"
        );
        let missing = Arc::new(MemorySettings::from_pairs([(REGISTRY_KEY, json!([{"name": "No id"}]))]));
        assert_eq!(
            init_agent_registry(&test_app(), missing).unwrap_err().to_string(),
            "The \"path\" argument must be of type string. Received undefined"
        );
    }

    #[test]
    fn an_id_that_is_not_one_plain_name_gets_no_folder() {
        let outside = crate::testkit::tmp_dir();
        let absolute = outside.path().join("abs-agent");
        let absolute = absolute.to_string_lossy().to_string();
        let (t, _) = started(Some(json!([
            {"id": "../escaped", "name": "Up"},
            {"id": absolute.clone(), "name": "Abs"},
            {"id": "a/b", "name": "Nested"},
            {"id": "fine", "name": "Fine"},
        ])));
        let base = get_agents_base_dir(t.env());
        assert!(base.join("fine").join("SOUL.md").is_file());
        assert!(!base.join("a").exists());
        assert!(!t.path().join("escaped").exists());
        assert!(!outside.path().join("abs-agent").exists());
        assert_eq!(get_agent_workspace(t.env(), &absolute), None);
        assert_eq!(get_agent_workspace(t.env(), ".."), None);
        assert_eq!(get_agent_workspace(t.env(), "fine"), Some(base.join("fine")));
    }

    #[test]
    fn starting_seeds_only_an_empty_list_and_makes_each_workspace() {
        let (t, settings) = started(None);
        assert_eq!(
            settings.get(REGISTRY_KEY),
            None,
            "the defaults stand in; nothing is written"
        );
        let base = get_agents_base_dir(t.env());
        assert_eq!(base, t.path().join("agents"));
        assert_eq!(
            std::fs::read_to_string(base.join("coder").join("MEMORY.md")).unwrap(),
            "# Coder Memory\n\nTask history and learned knowledge.\n"
        );
        assert!(
            std::fs::read_to_string(base.join("quick").join("SOUL.md"))
                .unwrap()
                .starts_with("# Quick\n\nYou are a fast assistant")
        );

        let (_t, settings) = started(Some(json!("[]")));
        let seeded = settings.get(REGISTRY_KEY).unwrap();
        let seeded: Value = serde_json::from_str(seeded.as_str().unwrap()).unwrap();
        assert_eq!(seeded, Value::Array(default_agents()));
    }

    #[test]
    fn the_stored_list_is_read_as_text_or_json_without_the_orchestrator() {
        let stored = json!([
            {"id": "main", "name": "Main", "isOrchestrator": true},
            {"id": "ops", "name": "Ops", "nickname": "Opsie", "model": "m", "prompt": "Run things."},
        ]);
        let (t, _) = started(Some(Value::String(stored.to_string())));
        assert_eq!(ids(&get_agents(&t)), ["ops"]);
        assert_eq!(get_agent(&t, "OPSIE").unwrap()["id"], "ops");
        assert_eq!(get_agent(&t, "ops").unwrap()["name"], "Ops");
        assert!(get_agent(&t, "main").is_none());
        let (t, _) = started(Some(stored));
        assert_eq!(ids(&get_agents(&t)), ["ops"]);
        for broken in [json!("not json"), json!({"id": "x"}), json!([null]), json!(0)] {
            let (t, _) = started(Some(broken.clone()));
            assert_eq!(get_agents(&t).len(), 4, "{broken}");
        }
    }

    #[test]
    fn agents_are_added_merged_and_removed() {
        let (t, settings) = started(None);
        assert_eq!(
            upsert_agent(&t, json!({"id": "coder", "name": "Coder"}))
                .unwrap_err()
                .to_string(),
            "Agent must have id, name, and model"
        );
        upsert_agent(&t, json!({"id": "coder", "name": "Dev", "model": "fable", "extra": 1})).unwrap();
        let coder = get_agent(&t, "coder").unwrap();
        assert_eq!(
            (coder["name"].clone(), coder["model"].clone(), coder["extra"].clone()),
            (json!("Dev"), json!("fable"), json!(1))
        );
        assert_eq!(coder["color"], "#4caf50", "the other fields stay");
        upsert_agent(&t, json!({"id": "ops", "name": "Ops", "model": "m"})).unwrap();
        assert_eq!(ids(&get_agents(&t)), ["coder", "researcher", "writer", "quick", "ops"]);
        assert!(
            settings.get(REGISTRY_KEY).unwrap().is_string(),
            "saved as JSON text, as the JS did"
        );
        assert!(remove_agent(&t, "researcher").unwrap());
        assert_eq!(ids(&get_agents(&t)), ["coder", "writer", "quick", "ops"]);
    }

    #[test]
    fn an_agent_folder_name_means_what_it_says() {
        let (t, _) = started(Some(json!([
            {"id": "coder", "name": "Coder", "prompt": "First."},
            {"id": "coder.", "name": "Dotted", "prompt": "Second."},
            {"id": "nul", "name": "Device", "prompt": "Third."},
        ])));
        let base = get_agents_base_dir(t.env());
        // On Windows `coder.` would have been `coder`, and `nul` a device.
        let soul =
            |id: &str| std::fs::read_to_string(node_path::to_namespaced(&base.join(id).join("SOUL.md"))).unwrap();
        assert_eq!(soul("coder"), "# Coder\n\nFirst.\n");
        assert_eq!(soul("coder."), "# Dotted\n\nSecond.\n");
        assert_eq!(soul("nul"), "# Device\n\nThird.\n");
    }

    #[test]
    fn the_summary_is_one_line_an_agent() {
        let (t, _) = started(Some(json!([
            {"id": "ops", "name": "Ops", "nickname": "Opsie", "model": "m", "prompt": "x".repeat(70), "icon": "ph ph-gear"},
            {"id": "q", "name": "Q", "model": "haiku", "prompt": "Be quick."},
        ])));
        assert_eq!(
            get_agents_summary(&t),
            format!(
                "- ph ph-gear Ops aka \"Opsie\" (ops): m — {}\n- 🤖 Q (q): haiku — Be quick.",
                "x".repeat(60)
            )
        );
    }

    #[test]
    fn the_base_folder_follows_the_environment() {
        let env = Env::from_pairs([("HOME", "/home/someone")]);
        assert_eq!(get_agents_base_dir(&env), PathBuf::from("/home/someone").join("agents"));
        env.set("TARSEE_STATE_DIR", "/srv/tarsee");
        assert_eq!(
            get_agent_workspace(&env, "coder"),
            Some(PathBuf::from("/srv/tarsee").join("agents").join("coder"))
        );
        // Joined and tidied as path.join did.
        env.set("TARSEE_STATE_DIR", "/srv/x/../tarsee//");
        assert_eq!(get_agents_base_dir(&env), PathBuf::from("/srv/tarsee").join("agents"));
        assert_eq!(
            get_agents_base_dir(&Env::new()),
            PathBuf::from("/data/tarsee").join("agents")
        );
    }
}
