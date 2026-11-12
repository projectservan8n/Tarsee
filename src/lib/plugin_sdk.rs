//! Port of `src/lib/plugin-sdk.js`: the registry of plugins that extend Tarsee with new channels, tools and hooks.
//!
//! A Node plugin was a JavaScript object loaded from the workspace; a plugin here is Rust code that implements
//! [`Plugin`] and is registered in code (docs/rust-port/DESIGN.md, decision 5). The registry was a module singleton
//! (`pluginRegistry`); here it is a service in the [`App`] ([`PluginRegistry::of`]).

use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde::Serialize;

use crate::app::App;

/// A plugin. Only the name is required.
#[async_trait]
pub trait Plugin: Send + Sync + 'static {
    fn name(&self) -> String;

    fn version(&self) -> Option<String> {
        None
    }

    /// What kind of plugin it is (the JS `type`: "channel", "tool", ...).
    fn kind(&self) -> Option<String> {
        None
    }

    fn description(&self) -> Option<String> {
        None
    }

    /// Runs when the plugin is registered (`plugin.init(ctx)`). A failure is logged; the plugin stays registered.
    async fn init(&self, _app: &App) -> anyhow::Result<()> {
        Ok(())
    }

    /// Runs when the plugin is unregistered or replaced. A failure is ignored.
    async fn destroy(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

/// A plugin as `list()` shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PluginInfo {
    pub name: String,
    pub version: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub description: String,
}

/// `value || fallback` for an optional text.
fn or(value: Option<String>, fallback: &str) -> String {
    value.filter(|v| !v.is_empty()).unwrap_or_else(|| fallback.to_string())
}

/// The registered plugins, in registration order (a replaced plugin moves to the end).
#[derive(Default)]
pub struct PluginRegistry {
    plugins: Mutex<Vec<(String, Arc<dyn Plugin>)>>,
}

impl PluginRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// The app's registry (`pluginRegistry`), made on first use.
    pub fn of(app: &App) -> Arc<PluginRegistry> {
        app.get_or_init(PluginRegistry::new)
    }

    /// Registers a plugin: one of the same name is replaced (and destroyed first), then the new one is initialised.
    pub async fn register(&self, app: &App, plugin: Arc<dyn Plugin>) -> anyhow::Result<()> {
        let name = plugin.name();
        if name.is_empty() {
            anyhow::bail!("Plugin must have a name");
        }
        if self.get(&name).is_some() {
            log::warn!("[plugins] replacing existing plugin: {name}");
            self.unregister(&name).await;
        }
        if let Err(err) = plugin.init(app).await {
            log::warn!("[plugins] {name} init error: {err}");
        }
        log::info!(
            "[plugins] registered: {name} v{} ({})",
            or(plugin.version(), "0.0.0"),
            or(plugin.kind(), "generic")
        );
        let mut plugins = self.plugins.lock();
        plugins.retain(|(n, _)| *n != name);
        plugins.push((name, plugin));
        Ok(())
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Plugin>> {
        self.plugins
            .lock()
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, p)| p.clone())
    }

    pub fn list(&self) -> Vec<PluginInfo> {
        self.plugins
            .lock()
            .iter()
            .map(|(_, p)| PluginInfo {
                name: p.name(),
                version: or(p.version(), "0.0.0"),
                kind: or(p.kind(), "generic"),
                description: or(p.description(), ""),
            })
            .collect()
    }

    /// Destroys and removes a plugin.
    pub async fn unregister(&self, name: &str) {
        let plugin = self.get(name);
        if let Some(plugin) = plugin {
            // A failure to clean up is ignored.
            let _ = plugin.destroy().await;
        }
        self.plugins.lock().retain(|(n, _)| n != name);
    }

    /// The plugins of a kind. A plugin that names no kind matches none (not even "generic", which `list` shows).
    pub fn get_by_type(&self, kind: &str) -> Vec<Arc<dyn Plugin>> {
        self.plugins
            .lock()
            .iter()
            .filter(|(_, p)| p.kind().as_deref() == Some(kind))
            .map(|(_, p)| p.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{CapturedLogs, test_app};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestPlugin {
        name: &'static str,
        version: Option<&'static str>,
        kind: Option<&'static str>,
        fail_init: bool,
        inits: AtomicUsize,
        destroys: AtomicUsize,
    }

    impl TestPlugin {
        fn new(name: &'static str) -> Self {
            TestPlugin {
                name,
                version: None,
                kind: None,
                fail_init: false,
                inits: AtomicUsize::new(0),
                destroys: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl Plugin for TestPlugin {
        fn name(&self) -> String {
            self.name.into()
        }
        fn version(&self) -> Option<String> {
            self.version.map(String::from)
        }
        fn kind(&self) -> Option<String> {
            self.kind.map(String::from)
        }
        async fn init(&self, app: &App) -> anyhow::Result<()> {
            assert!(app.config().workspace_dir.exists());
            self.inits.fetch_add(1, Ordering::SeqCst);
            if self.fail_init {
                anyhow::bail!("no config");
            }
            Ok(())
        }
        async fn destroy(&self) -> anyhow::Result<()> {
            self.destroys.fetch_add(1, Ordering::SeqCst);
            anyhow::bail!("ignored")
        }
    }

    #[tokio::test]
    async fn plugins_register_list_replace_and_unregister() {
        let t = test_app();
        let registry = PluginRegistry::of(&t);
        let logs = CapturedLogs::start();

        let first = Arc::new(TestPlugin {
            version: Some("1.2.0"),
            kind: Some("channel"),
            ..TestPlugin::new("sms")
        });
        registry.register(&t, first.clone()).await.unwrap();
        let other = Arc::new(TestPlugin {
            fail_init: true,
            ..TestPlugin::new("weather")
        });
        registry.register(&t, other.clone()).await.unwrap();
        assert_eq!(
            serde_json::to_value(registry.list()).unwrap(),
            serde_json::json!([
                {"name": "sms", "version": "1.2.0", "type": "channel", "description": ""},
                {"name": "weather", "version": "0.0.0", "type": "generic", "description": ""},
            ])
        );
        assert_eq!(registry.get_by_type("channel").len(), 1);
        assert!(registry.get_by_type("generic").is_empty());
        assert_eq!(registry.get("weather").unwrap().name(), "weather");

        let replacement = Arc::new(TestPlugin::new("sms"));
        registry.register(&t, replacement.clone()).await.unwrap();
        assert_eq!(first.destroys.load(Ordering::SeqCst), 1);
        assert_eq!(
            registry.list().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            ["weather", "sms"]
        );

        registry.unregister("weather").await;
        assert_eq!(other.destroys.load(Ordering::SeqCst), 1);
        assert!(registry.get("weather").is_none());
        registry.unregister("nothing").await;

        assert_eq!(
            logs.lines(),
            [
                "[plugins] registered: sms v1.2.0 (channel)",
                "[plugins] weather init error: no config",
                "[plugins] registered: weather v0.0.0 (generic)",
                "[plugins] replacing existing plugin: sms",
                "[plugins] registered: sms v0.0.0 (generic)",
            ]
        );
        let nameless = registry.register(&t, Arc::new(TestPlugin::new(""))).await;
        assert_eq!(nameless.unwrap_err().to_string(), "Plugin must have a name");
    }
}
