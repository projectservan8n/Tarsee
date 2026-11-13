//! Port of `src/ai/provider-registry.js`: every AI Tarsee can talk to, in one table.
//!
//! A provider is an account the owner chooses (the Claude plan, an Anthropic API key, the ChatGPT plan, an OpenAI
//! API key, OpenRouter, DeepSeek or a Local AI server). An engine is the agent harness that runs a turn on it:
//! Claude Code or Codex. The owner only ever picks a provider and a model; [`engine_for`] below picks the engine.
//!
//! Every other part of the turn path reads this table: which providers exist and which are switched on (shipped),
//! which one is active, what a tier word ("opus", "haiku") means on each provider, which engine runs a model, what a
//! model can take in (images, PDFs), how big its window is and what it costs.
//!
//! Rules this file keeps:
//!  - Hosts are code constants (`base_url`), one for every key provider on every engine it runs on, so no key is
//!    ever left to an engine's default host. Nothing here reads a host from a setting or an environment variable, so
//!    a stored key can only ever go to its own provider. Local AI is the one host the owner sets, and it lives in
//!    its own setting, never in this table. A turn reads its host through `engine_env::host_for`, the one way to get
//!    one (it adds Local AI's address and the test-only seam).
//!  - A provider is chosen by a setting or `TARSEE_AI_PROVIDER`, never because some provider's key happens to be in
//!    the environment.
//!  - `resolve_model_for` never hands a claude-* id to DeepSeek, ChatGPT, OpenAI or Local AI.
//!  - ChatGPT has no model list of its own here: the models a signed-in account may use are only known at runtime
//!    (`set_catalog_models("chatgpt-models", ..)`). Until that list is in, no model is named and Codex picks its own
//!    default.
//!  - Only shipped providers can be selected. A provider is switched on in the phase that lands its engine path.
//!
//! # What changes at run time
//!
//! The table itself ([`PROVIDERS`]) never changes. Two things the JS module kept in module-level variables do: the
//! runtime catalogs (`setCatalogModels`, `setLocalModels`) and the providers this install hides (`hideProviders`).
//! They are the state of a [`ProviderRegistry`], a service of the `App` ([`ProviderRegistry::of`]), so two apps (two
//! tests) never share them. Every function of the JS module that read them is a method of it, under its JS name:
//! `is_shipped`, `shipped_providers`, `active_provider_id`, `set_catalog_models`, `catalog_models`, `models_for`,
//! `resolve_model_for`, `context_tokens_for`, `set_local_models`, `efforts_for`, `caps_for`, `price_for`,
//! `claude_list_price`, `hide_providers`. Everything that reads only the table, the settings or the environment is
//! a plain function.
//!
//! The JS file's import cycle with `config/constants.js` does not exist here: `AI_PROVIDERS` lives in this file and
//! nothing re-exports it.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use parking_lot::RwLock;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::ai::engine_env;
use crate::app::App;
use crate::config::constants::{
    CLAUDE_MODELS, MODEL_TIERS, background_defaults, claude_model_by_id, get_recommended_model, resolve_model_alias,
    tier_of,
};
use crate::db::settings::Settings;
use crate::env::Env;
use crate::lib::model_picker::{EFFORT_IDS, parse_picker_id};
use crate::util::js;

/// The agent harness that runs a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Engine {
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "codex")]
    Codex,
}

impl Engine {
    /// The engine's id, as settings, the database and the API carry it: "claude-code" or "codex".
    pub const fn as_str(self) -> &'static str {
        match self {
            Engine::ClaudeCode => "claude-code",
            Engine::Codex => "codex",
        }
    }

    /// The engine with this id, or `None`.
    pub fn from_id(id: &str) -> Option<Engine> {
        match id {
            "claude-code" => Some(Engine::ClaudeCode),
            "codex" => Some(Engine::Codex),
            _ => None,
        }
    }
}

impl std::fmt::Display for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

const CLAUDE_CODE: Engine = Engine::ClaudeCode;
const CODEX: Engine = Engine::Codex;

/// What kind of account a provider is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    /// A plan that signs in (the Claude plan, the ChatGPT plan): it takes no API key.
    Subscription,
    /// An API key.
    Key,
    /// The owner's own server.
    Local,
}

impl ProviderKind {
    /// "subscription", "key" or "local".
    pub const fn as_str(self) -> &'static str {
        match self {
            ProviderKind::Subscription => "subscription",
            ProviderKind::Key => "key",
            ProviderKind::Local => "local",
        }
    }
}

impl std::fmt::Display for ProviderKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Extra words for the tiers, as /auto and crons may say them.
const TIER_ALIASES: &[(&str, &str)] = &[("top", "opus"), ("mid", "sonnet"), ("small", "haiku")];

/// Providers that must never be handed a claude-* model id.
const NO_CLAUDE_IDS: &[&str] = &["deepseek", "chatgpt", "openai", "local"];

/// Catalogs whose models are only known at runtime (filled by `set_catalog_models`).
const RUNTIME_CATALOGS: &[&str] = &["openrouter", "openai-models", "chatgpt-models", "local-models"];

/// `/^claude-/i`.
fn is_claude_id(id: &str) -> bool {
    id.as_bytes()
        .get(..7)
        .is_some_and(|start| start.eq_ignore_ascii_case(b"claude-"))
}

fn no_claude_ids(p: &Provider) -> bool {
    NO_CLAUDE_IDS.contains(&p.id)
}

// --- Prices ---
// USD per million tokens. OpenAI's are its list prices as OpenRouter passes them through
// (openrouter.ai/api/v1/models, read 2026-11-09; the base rate, before any long-prompt surcharge). DeepSeek's are
// its published peak rates (api-docs.deepseek.com, Models & Pricing, read 2026-11-09): cache-miss input is the
// cacheWrite rate, a cache hit the cacheRead one. A cost worked out from any of them is labelled "est.", and Phase 7
// checks them against each provider's own dashboard.

/// The hours of the week a provider charges its listed (peak) rates; any other time costs `off_peak_factor` of them.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakWindow {
    /// Days of the week in UTC, Sunday being 0.
    pub days: &'static [u32],
    /// From and to, in whole hours UTC; the end is not included.
    pub hours_utc: &'static [(u32, u32)],
    pub off_peak_factor: f64,
}

/// A model's price in the table, in USD per million tokens: `{ in, out, cacheRead, cacheWrite }`, and its peak
/// hours when the provider has them.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    #[serde(rename = "in")]
    pub input: f64,
    #[serde(rename = "out")]
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    #[serde(skip_serializing_if = "Option::is_none", skip_deserializing)]
    pub peak: Option<PeakWindow>,
}

impl ModelPrice {
    const fn flat(input: f64, output: f64, cache_read: f64, cache_write: f64) -> ModelPrice {
        ModelPrice {
            input,
            output,
            cache_read,
            cache_write,
            peak: None,
        }
    }
}

/// A model's price at a moment ([`ProviderRegistry::price_for`]), in USD per million tokens. `peak` is true or
/// false for a provider with peak hours (DeepSeek: off-peak is half price) and `None` otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    #[serde(rename = "in")]
    pub input: f64,
    #[serde(rename = "out")]
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub peak: Option<bool>,
}

impl From<Price> for ModelPrice {
    /// The rates alone: what the picker's wording (`price_hint`, `cost_tier`) reads.
    fn from(price: Price) -> ModelPrice {
        ModelPrice::flat(price.input, price.output, price.cache_read, price.cache_write)
    }
}

/// DeepSeek's peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday. The listed rates are the peak ones;
/// any other time costs half.
const DEEPSEEK_PEAK: PeakWindow = PeakWindow {
    days: &[1, 2, 3, 4, 5],
    hours_utc: &[(1, 4), (6, 10)],
    off_peak_factor: 0.5,
};

const DEEPSEEK_EFFORTS: &[&str] = &["low", "high", "max"];

/// One model a provider offers: a row of its table, or of a runtime catalog.
///
/// Serialised, it is a runtime catalog's row as the JS kept it (`{ id, label, vendor, context, efforts, vision, pdf,
/// price, tier, default, free }`, with `serverContext` and `maxContext` only where the server gave them).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub label: String,
    /// Who made it ("anthropic", "openai", "deepseek"); `None` when a runtime catalog does not say.
    pub vendor: Option<String>,
    /// The context window in tokens.
    pub context: Option<u64>,
    /// The effort levels it takes; `None` when its catalog does not say.
    pub efforts: Option<Vec<String>>,
    pub vision: Option<bool>,
    pub pdf: Option<bool>,
    pub price: Option<ModelPrice>,
    /// fable | opus | sonnet | haiku, where the catalog places it in one.
    pub tier: Option<String>,
    /// The Claude table's bare tier names ("opus"), which Claude Code resolves to the newest model in that tier.
    #[serde(skip_serializing_if = "is_false")]
    pub alias: bool,
    /// The catalog's own default model.
    pub default: bool,
    pub free: bool,
    /// Local AI: what its server said it gives the model (`set_local_models`); only there when it said it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_context: Option<u64>,
    /// Local AI: the most the model was trained for, when the server says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_context: Option<u64>,
    /// A shipped verification result (`{ engine, at, engineVersion, efforts?, checks? }`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<Value>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[allow(clippy::too_many_arguments)]
fn table_row(
    id: &str,
    label: &str,
    vendor: &str,
    context: u64,
    efforts: &[&str],
    vision: bool,
    pdf: bool,
    price: ModelPrice,
) -> ModelEntry {
    ModelEntry {
        id: id.to_string(),
        label: label.to_string(),
        vendor: Some(vendor.to_string()),
        context: Some(context),
        efforts: Some(efforts.iter().map(|e| e.to_string()).collect()),
        vision: Some(vision),
        pdf: Some(pdf),
        price: Some(price),
        tier: None,
        alias: false,
        default: false,
        free: false,
        server_context: None,
        max_context: None,
        verified: None,
    }
}

static DEEPSEEK_MODELS: LazyLock<Arc<Vec<ModelEntry>>> = LazyLock::new(|| {
    let peak = |input, output, cache_read, cache_write| ModelPrice {
        peak: Some(DEEPSEEK_PEAK),
        ..ModelPrice::flat(input, output, cache_read, cache_write)
    };
    Arc::new(vec![
        table_row(
            "deepseek-flash",
            "DeepSeek Flash",
            "deepseek",
            1_000_000,
            DEEPSEEK_EFFORTS,
            true,
            false,
            peak(0.3, 1.2, 0.006, 0.3),
        ),
        table_row(
            "deepseek-v4-pro",
            "DeepSeek Pro",
            "deepseek",
            1_000_000,
            DEEPSEEK_EFFORTS,
            false,
            false,
            peak(1.32, 3.96, 0.044, 1.32),
        ),
    ])
});

/// The OpenAI API key's models. Once the key's own list is in (`set_catalog_models("openai-models", ..)`, from
/// GET /v1/models) only the rows it lists are offered. Codex sends no PDF blocks.
static OPENAI_MODELS: LazyLock<Arc<Vec<ModelEntry>>> = LazyLock::new(|| {
    Arc::new(vec![
        table_row(
            "gpt-6-astra",
            "GPT-6 Astra",
            "openai",
            1_050_000,
            EFFORT_IDS,
            true,
            false,
            ModelPrice::flat(10.0, 50.0, 1.0, 12.5),
        ),
        table_row(
            "gpt-6.1-sol",
            "GPT-6.1 Sol",
            "openai",
            1_050_000,
            EFFORT_IDS,
            true,
            false,
            ModelPrice::flat(2.0, 10.0, 0.1, 2.5),
        ),
        table_row(
            "gpt-6-luna",
            "GPT-6 Luna",
            "openai",
            1_050_000,
            EFFORT_IDS,
            true,
            false,
            ModelPrice::flat(0.1, 0.5, 0.01, 0.125),
        ),
        table_row(
            "gpt-5.5",
            "GPT-5.5",
            "openai",
            1_050_000,
            &["low", "medium", "high", "xhigh"],
            true,
            false,
            ModelPrice::flat(5.0, 30.0, 0.5, 5.0),
        ),
    ])
});

/// Claude's tier words stay tier words: the engine turns each into the newest model of the tier
/// (`lib/model_catalog.rs`).
const CLAUDE_TIERS: &[(&str, &str)] = &[
    ("fable", "fable"),
    ("opus", "opus"),
    ("sonnet", "sonnet"),
    ("haiku", "haiku"),
];

const OPENROUTER_OPUS: &str = "~anthropic/claude-opus-latest";
const OPENROUTER_SONNET: &str = "~anthropic/claude-sonnet-latest";
const OPENROUTER_HAIKU: &str = "~anthropic/claude-haiku-latest";

// --- Keys pasted into the wrong slot ---

/// A key shape that belongs to another provider, and what to say when it is pasted here.
#[derive(Debug)]
pub struct WrongSlot {
    pub re: Regex,
    pub message: &'static str,
}

impl WrongSlot {
    fn new(pattern: &str, message: &'static str) -> WrongSlot {
        WrongSlot {
            re: Regex::new(pattern).expect("a wrong-slot pattern"),
            message,
        }
    }

    /// Whether the key has this shape.
    pub fn matches(&self, key: &str) -> bool {
        self.re.is_match(key)
    }
}

// `(?i-u)` is JavaScript's `i` flag: letters match in either case, and only ASCII ones.
static CLAUDE_TOKEN: LazyLock<WrongSlot> = LazyLock::new(|| {
    WrongSlot::new(
        r"(?i-u)^sk-ant-oat",
        "This is a Claude sign-in token, not an API key. Create an API key in the Anthropic Console instead.",
    )
});
static ANTHROPIC_KEY: LazyLock<WrongSlot> = LazyLock::new(|| {
    WrongSlot::new(
        r"(?i-u)^sk-ant-",
        "This is an Anthropic key. Paste it in the Anthropic API key card.",
    )
});
static OPENROUTER_KEY: LazyLock<WrongSlot> = LazyLock::new(|| {
    WrongSlot::new(
        r"(?i-u)^sk-or-",
        "This is an OpenRouter key. Paste it in the OpenRouter card.",
    )
});
/// OpenAI's project, service-account and admin keys, and its legacy ones (48 characters with T3BlbkFJ in the
/// middle).
static OPENAI_KEY: LazyLock<WrongSlot> = LazyLock::new(|| {
    WrongSlot::new(
        r"(?i-u)^sk-(proj|svcacct|admin)-|^sk-[a-z0-9]{20}t3blbkfj[a-z0-9]{20}$",
        "This is an OpenAI key. Paste it in the OpenAI API key card.",
    )
});
/// DeepSeek's keys are sk- and 32 lowercase hex characters, a shape no OpenAI key has (so no `i` flag). Some other
/// OpenAI-compatible servers make keys of that shape too, hence "looks like".
static DEEPSEEK_KEY: LazyLock<WrongSlot> = LazyLock::new(|| {
    WrongSlot::new(
        r"^sk-[0-9a-f]{32}$",
        "This looks like a DeepSeek key. Paste it in the DeepSeek card.",
    )
});

/// The shape a provider's own keys have.
#[derive(Debug)]
pub struct KeyPattern(fancy_regex::Regex);

impl KeyPattern {
    fn new(pattern: &str) -> KeyPattern {
        KeyPattern(fancy_regex::Regex::new(pattern).expect("a key pattern"))
    }

    /// Whether the key has this shape.
    pub fn is_match(&self, key: &str) -> bool {
        self.0.is_match(key).unwrap_or(false)
    }

    /// The pattern's source.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

/// How a provider is tested (`test_probe`) or its balance read (`balance_probe`): a sign-in check
/// (`{ kind: "sign-in", check }`) or a request (`{ method, url | path, auth }`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Probe {
    /// "sign-in" for a plan; a request has none.
    pub kind: Option<&'static str>,
    /// Which sign-in check: "claude-credentials" or "codex-login-status".
    pub check: Option<&'static str>,
    pub method: Option<&'static str>,
    pub url: Option<&'static str>,
    /// Local AI: the path under the address the owner set.
    pub path: Option<&'static str>,
    /// "x-api-key", "bearer" or "bearer-optional".
    pub auth: Option<&'static str>,
}

impl Probe {
    const fn sign_in(check: &'static str) -> Probe {
        Probe {
            kind: Some("sign-in"),
            check: Some(check),
            method: None,
            url: None,
            path: None,
            auth: None,
        }
    }

    const fn get(url: &'static str, auth: &'static str) -> Probe {
        Probe {
            kind: None,
            check: None,
            method: Some("GET"),
            url: Some(url),
            path: None,
            auth: Some(auth),
        }
    }
}

/// A provider's own words for its failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ErrorHints {
    pub auth: Option<&'static str>,
    pub billing: Option<&'static str>,
    pub top_up_url: Option<&'static str>,
    /// Local AI: `{url}` stands for its address.
    pub unreachable: Option<&'static str>,
}

/// One provider's entry in the table.
#[derive(Debug)]
pub struct Provider {
    /// The public id, as `TARSEE_AI_PROVIDER`, /model, the API and the UI use it.
    pub id: &'static str,
    /// The id its settings are stored under (`ai.<storage_id>.*`): the Claude plan's is "claude-code".
    pub storage_id: &'static str,
    pub label: &'static str,
    /// The name `AI_PROVIDERS` has always shown for it, where that differs from the label.
    pub legacy_name: Option<&'static str>,
    pub kind: ProviderKind,
    /// Whether it is switched on.
    pub shipped: bool,
    pub engines: &'static [Engine],
    /// The environment variable its key may come from.
    pub env_key: Option<&'static str>,
    /// Local AI: the variable its server's address may come from.
    pub url_env: Option<&'static str>,
    pub key_noun: Option<&'static str>,
    pub key_pattern: Option<KeyPattern>,
    pub wrong_slot: Vec<&'static WrongSlot>,
    pub key_help_url: Option<&'static str>,
    pub console_url: Option<&'static str>,
    /// The host per engine. Read it with [`Provider::base_url`].
    pub base_urls: &'static [(Engine, &'static str)],
    /// OpenRouter: the attribution title it shows (`ai.openrouter.appTitle` overrides it).
    pub default_app_title: Option<&'static str>,
    /// "claude", "static", "openrouter", "openai-models", "chatgpt-models" or "local-models".
    pub catalog: &'static str,
    /// The models written in the table (the Claude table for the Claude providers). What a provider offers right
    /// now is [`ProviderRegistry::models_for`].
    pub models: Arc<Vec<ModelEntry>>,
    /// OpenRouter: the picker's Recommended section.
    pub recommended: &'static [&'static str],
    /// What each tier word means here. Read one with [`Provider::tier`].
    pub tiers: &'static [(&'static str, &'static str)],
    pub default_model: Option<&'static str>,
    pub background_model: Option<&'static str>,
    pub default_context: u64,
    pub test_probe: Probe,
    pub balance_probe: Option<Probe>,
    pub error_hints: ErrorHints,
}

impl Provider {
    /// The host this provider's key goes to on an engine (`baseUrl[engine]`), when the table names one.
    pub fn base_url(&self, engine: Engine) -> Option<&'static str> {
        self.base_urls.iter().find(|(e, _)| *e == engine).map(|(_, url)| *url)
    }

    /// The model a tier word means here (`tiers[tier]`).
    pub fn tier(&self, tier: &str) -> Option<&'static str> {
        tier_in(self.tiers, tier)
    }
}

/// What `engine_env` reads of a provider, from its registry entry. The JS handed `PROVIDERS[id]` itself to
/// `engine-env.js`; this is the one conversion between the two tables, for every caller.
pub fn engine_entry(p: &Provider) -> engine_env::ProviderEntry {
    let tier = |name: &str| p.tier(name).map(str::to_string);
    engine_env::ProviderEntry {
        id: p.id.to_string(),
        label: Some(p.label.to_string()),
        engines: Some(p.engines.iter().map(|e| e.as_str().to_string()).collect()),
        env_key: p.env_key.map(str::to_string),
        base_url: p
            .base_urls
            .iter()
            .map(|(engine, url)| (engine.as_str().to_string(), url.to_string()))
            .collect(),
        wrong_slot: p
            .wrong_slot
            .iter()
            .map(|slot| engine_env::WrongSlot {
                re: slot.re.clone(),
                message: slot.message.to_string(),
            })
            .collect(),
        models: p
            .models
            .iter()
            .map(|m| engine_env::EntryModel {
                id: m.id.clone(),
                context: m.context.map(|c| c as f64),
            })
            .collect(),
        tiers: engine_env::Tiers {
            fable: tier("fable"),
            opus: tier("opus"),
            sonnet: tier("sonnet"),
            haiku: tier("haiku"),
        },
        default_model: p.default_model.map(str::to_string),
    }
}

fn tier_in(tiers: &[(&'static str, &'static str)], tier: &str) -> Option<&'static str> {
    tiers.iter().find(|(t, _)| *t == tier).map(|(_, model)| *model)
}

/// The Claude model table (`config/constants.rs`) as registry rows.
static CLAUDE_ROWS: LazyLock<Arc<Vec<ModelEntry>>> = LazyLock::new(|| {
    Arc::new(
        CLAUDE_MODELS
            .iter()
            .map(|m| ModelEntry {
                id: m.id.to_string(),
                label: m.display_name.to_string(),
                vendor: Some("anthropic".to_string()),
                tier: Some(m.tier.to_string()),
                alias: m.alias,
                context: Some(context_from_label(m.context)),
                efforts: Some(EFFORT_IDS.iter().map(|e| e.to_string()).collect()),
                vision: Some(true),
                pdf: Some(true),
                price: None,
                default: false,
                free: false,
                server_context: None,
                max_context: None,
                verified: None,
            })
            .collect(),
    )
});

/// Every provider, by public id: `PROVIDERS.claude`, or [`ProviderTable::get`] for an id held in a variable.
pub struct ProviderTable {
    pub claude: Provider,
    pub anthropic: Provider,
    pub chatgpt: Provider,
    pub openai: Provider,
    pub openrouter: Provider,
    pub deepseek: Provider,
    pub local: Provider,
}

impl ProviderTable {
    /// The entry with exactly this public id (`PROVIDERS[id]`). [`get_provider`] also takes an alias and any case.
    pub fn get(&self, id: &str) -> Option<&Provider> {
        self.iter().find(|p| p.id == id)
    }

    /// Every entry, in table order (`Object.values(PROVIDERS)`).
    pub fn iter(&self) -> impl Iterator<Item = &Provider> {
        [
            &self.claude,
            &self.anthropic,
            &self.chatgpt,
            &self.openai,
            &self.openrouter,
            &self.deepseek,
            &self.local,
        ]
        .into_iter()
    }
}

/// Every provider, by public id. Nothing at runtime can change a host or a price.
pub static PROVIDERS: LazyLock<ProviderTable> = LazyLock::new(|| ProviderTable {
    claude: Provider {
        id: "claude",
        storage_id: "claude-code",
        label: "Claude plan",
        // The name AI_PROVIDERS has always shown for it.
        legacy_name: Some("Claude Code (Agent)"),
        kind: ProviderKind::Subscription,
        shipped: true,
        engines: &[CLAUDE_CODE],
        // Signs in with `claude auth login` in the Terminal, or the CLAUDE_CODE_OAUTH_TOKEN Railway variable from
        // `claude setup-token`. It takes no API key.
        env_key: None,
        url_env: None,
        key_noun: None,
        key_pattern: None,
        wrong_slot: vec![],
        key_help_url: None,
        console_url: Some("https://claude.ai/settings/usage"),
        base_urls: &[],
        default_app_title: None,
        catalog: "claude",
        models: CLAUDE_ROWS.clone(),
        recommended: &[],
        tiers: CLAUDE_TIERS,
        default_model: Some(get_recommended_model()),
        background_model: Some(background_defaults::MODEL),
        default_context: 1_000_000,
        test_probe: Probe::sign_in("claude-credentials"),
        balance_probe: None,
        // Only what happened: the card and the wizard put provider_status's fix (the command, then Check) after it.
        error_hints: ErrorHints {
            auth: Some("Claude's sign-in has expired."),
            ..ErrorHints::default()
        },
    },

    anthropic: Provider {
        id: "anthropic",
        storage_id: "anthropic",
        label: "Anthropic API key",
        legacy_name: None,
        kind: ProviderKind::Key,
        shipped: true,
        engines: &[CLAUDE_CODE],
        env_key: Some("ANTHROPIC_API_KEY"),
        url_env: None,
        key_noun: Some("an Anthropic API key"),
        // Anthropic documents the sk-ant- prefix only (personal and service-account keys are the newer kinds); a
        // Claude sign-in token (sk-ant-oat…) is caught first, by wrong_slot.
        key_pattern: Some(KeyPattern::new(r"^sk-ant-[A-Za-z0-9_-]{16,}$")),
        wrong_slot: vec![&CLAUDE_TOKEN, &OPENROUTER_KEY, &OPENAI_KEY],
        key_help_url: Some("https://platform.claude.com/settings/keys"),
        console_url: Some("https://platform.claude.com/settings/billing"),
        // Claude Code's own default host, named so nothing is left to a default.
        base_urls: &[(CLAUDE_CODE, "https://api.anthropic.com")],
        default_app_title: None,
        catalog: "claude",
        models: CLAUDE_ROWS.clone(),
        recommended: &[],
        tiers: CLAUDE_TIERS,
        default_model: Some(get_recommended_model()),
        background_model: Some(background_defaults::MODEL),
        default_context: 1_000_000,
        test_probe: Probe::get("https://api.anthropic.com/v1/models", "x-api-key"),
        balance_probe: None,
        error_hints: ErrorHints {
            auth: Some(
                "Your Anthropic key was rejected. Update it in Settings > AI or the Railway variable ANTHROPIC_API_KEY.",
            ),
            billing: Some("Your Anthropic credit has run out. Add credit in the Anthropic Console."),
            top_up_url: Some("https://platform.claude.com/settings/billing"),
            unreachable: None,
        },
    },

    chatgpt: Provider {
        id: "chatgpt",
        storage_id: "chatgpt",
        label: "ChatGPT plan",
        legacy_name: None,
        kind: ProviderKind::Subscription,
        shipped: true,
        engines: &[CODEX],
        // Signs in with Codex's own device code (codex login --device-auth). It takes no API key.
        env_key: None,
        url_env: None,
        key_noun: None,
        key_pattern: None,
        wrong_slot: vec![],
        key_help_url: None,
        console_url: Some("https://chatgpt.com/codex/settings/usage"),
        base_urls: &[],
        default_app_title: None,
        // The account's own models, read at runtime. None are written here: a free account and a paid one can use
        // different models.
        catalog: "chatgpt-models",
        models: Arc::new(vec![]),
        recommended: &[],
        tiers: &[],
        default_model: None,
        background_model: None,
        default_context: 200_000,
        test_probe: Probe::sign_in("codex-login-status"),
        balance_probe: None,
        // Only what happened: provider_status's fix (sign in again, or the Terminal's command) follows it on the
        // card.
        error_hints: ErrorHints {
            auth: Some("The ChatGPT sign-in has expired."),
            ..ErrorHints::default()
        },
    },

    openai: Provider {
        id: "openai",
        storage_id: "openai",
        label: "OpenAI API key",
        legacy_name: None,
        kind: ProviderKind::Key,
        shipped: true,
        engines: &[CODEX],
        env_key: Some("OPENAI_API_KEY"),
        url_env: None,
        key_noun: Some("an OpenAI API key"),
        key_pattern: Some(KeyPattern::new(r"^sk-(?!ant-|or-)[A-Za-z0-9_-]{16,}$")),
        wrong_slot: vec![&CLAUDE_TOKEN, &ANTHROPIC_KEY, &OPENROUTER_KEY, &DEEPSEEK_KEY],
        key_help_url: Some("https://platform.openai.com/api-keys"),
        console_url: Some("https://platform.openai.com/usage"),
        // Passed to Codex explicitly, so a config.toml can't move it (design 4.8).
        base_urls: &[(CODEX, "https://api.openai.com/v1")],
        default_app_title: None,
        catalog: "openai-models",
        models: OPENAI_MODELS.clone(),
        recommended: &[],
        tiers: &[
            ("fable", "gpt-6-astra"),
            ("opus", "gpt-6-astra"),
            ("sonnet", "gpt-6.1-sol"),
            ("haiku", "gpt-6-luna"),
        ],
        default_model: Some("gpt-6.1-sol"),
        background_model: Some("gpt-6-luna"),
        default_context: 400_000,
        test_probe: Probe::get("https://api.openai.com/v1/models", "bearer"),
        balance_probe: None,
        error_hints: ErrorHints {
            auth: Some(
                "Your OpenAI key was rejected. Update it in Settings > AI or the Railway variable OPENAI_API_KEY.",
            ),
            billing: Some("Your OpenAI project is out of credit or over its budget. Check it at platform.openai.com."),
            top_up_url: Some("https://platform.openai.com/settings/organization/billing/overview"),
            unreachable: None,
        },
    },

    openrouter: Provider {
        id: "openrouter",
        storage_id: "openrouter",
        label: "OpenRouter",
        legacy_name: None,
        kind: ProviderKind::Key,
        shipped: true,
        // anthropic/* runs on Claude Code, openai/* on Codex, any other maker on whichever engine passed
        // verification (engine_for).
        engines: &[CLAUDE_CODE, CODEX],
        env_key: Some("OPENROUTER_API_KEY"),
        url_env: None,
        key_noun: Some("an OpenRouter key"),
        key_pattern: Some(KeyPattern::new(r"^sk-or-v1-[A-Za-z0-9]{8,}$")),
        wrong_slot: vec![&CLAUDE_TOKEN, &ANTHROPIC_KEY, &OPENAI_KEY],
        key_help_url: Some("https://openrouter.ai/settings/keys"),
        console_url: Some("https://openrouter.ai/activity"),
        base_urls: &[
            (CLAUDE_CODE, "https://openrouter.ai/api"),
            (CODEX, "https://openrouter.ai/api/v1"),
        ],
        // The attribution title OpenRouter shows (ai.openrouter.appTitle overrides it).
        default_app_title: Some("Tarsee"),
        catalog: "openrouter",
        // The shipped verified results (models[].verified) land here from the Phase 7 sweep
        // (scripts/smoke-backends.mjs); the live list itself is the runtime catalog (lib/openrouter_catalog.rs).
        models: Arc::new(vec![]),
        // The picker's Recommended section: the default first, then the other tier models, then the shipped
        // verified ones. Anthropic's models run on Claude Code through OpenRouter's guaranteed /api/v1/messages, so
        // these need no verification first.
        recommended: &[OPENROUTER_SONNET, OPENROUTER_OPUS, OPENROUTER_HAIKU],
        // The owner can edit these (ai.openrouter.tiers). Fable takes Opus's slug, as on the other metered
        // providers.
        tiers: &[
            ("fable", OPENROUTER_OPUS),
            ("opus", OPENROUTER_OPUS),
            ("sonnet", OPENROUTER_SONNET),
            ("haiku", OPENROUTER_HAIKU),
        ],
        default_model: Some(OPENROUTER_SONNET),
        background_model: Some(OPENROUTER_HAIKU),
        default_context: 200_000,
        test_probe: Probe::get("https://openrouter.ai/api/v1/key", "bearer"),
        balance_probe: Some(Probe::get("https://openrouter.ai/api/v1/key", "bearer")),
        error_hints: ErrorHints {
            auth: Some(
                "Your OpenRouter key was rejected. Update it in Settings > AI or the Railway variable OPENROUTER_API_KEY.",
            ),
            billing: Some("Your OpenRouter key has hit its spending limit. Raise it at openrouter.ai/settings/keys."),
            top_up_url: Some("https://openrouter.ai/settings/keys"),
            unreachable: None,
        },
    },

    deepseek: Provider {
        id: "deepseek",
        storage_id: "deepseek",
        label: "DeepSeek",
        legacy_name: None,
        kind: ProviderKind::Key,
        shipped: true,
        // Claude Code against DeepSeek's Anthropic endpoint (DeepSeek documents it); Codex over its Responses API
        // only when verification picked it.
        engines: &[CLAUDE_CODE, CODEX],
        env_key: Some("DEEPSEEK_API_KEY"),
        url_env: None,
        key_noun: Some("a DeepSeek key"),
        key_pattern: Some(KeyPattern::new(r"^sk-[A-Za-z0-9]{16,}$")),
        wrong_slot: vec![&CLAUDE_TOKEN, &ANTHROPIC_KEY, &OPENROUTER_KEY, &OPENAI_KEY],
        key_help_url: Some("https://platform.deepseek.com/api_keys"),
        console_url: Some("https://platform.deepseek.com/usage"),
        base_urls: &[
            (CLAUDE_CODE, "https://api.deepseek.com/anthropic"),
            (CODEX, "https://api.deepseek.com"),
        ],
        default_app_title: None,
        catalog: "static",
        models: DEEPSEEK_MODELS.clone(),
        recommended: &[],
        tiers: &[
            ("fable", "deepseek-v4-pro"),
            ("opus", "deepseek-v4-pro"),
            ("sonnet", "deepseek-flash"),
            ("haiku", "deepseek-flash"),
        ],
        default_model: Some("deepseek-flash"),
        background_model: Some("deepseek-flash"),
        default_context: 1_000_000,
        test_probe: Probe::get("https://api.deepseek.com/user/balance", "bearer"),
        balance_probe: Some(Probe::get("https://api.deepseek.com/user/balance", "bearer")),
        error_hints: ErrorHints {
            auth: Some(
                "Your DeepSeek key was rejected. Update it in Settings > AI or the Railway variable DEEPSEEK_API_KEY.",
            ),
            billing: Some("Your DeepSeek balance is empty. Top up at platform.deepseek.com."),
            top_up_url: Some("https://platform.deepseek.com/top_up"),
            unreachable: None,
        },
    },

    local: Provider {
        id: "local",
        storage_id: "local",
        label: "Local AI",
        legacy_name: None,
        kind: ProviderKind::Local,
        shipped: true,
        engines: &[CODEX],
        // Optional: only if the owner's server wants one.
        env_key: Some("TARSEE_LOCAL_AI_KEY"),
        // The server's address: ai.local.baseUrl, else this variable. Never a constant here.
        url_env: Some("TARSEE_LOCAL_AI_URL"),
        key_noun: Some("a key"),
        key_pattern: None,
        // A key for another provider must not be sent to a host the owner typed in.
        wrong_slot: vec![
            &CLAUDE_TOKEN,
            &ANTHROPIC_KEY,
            &OPENROUTER_KEY,
            &OPENAI_KEY,
            &DEEPSEEK_KEY,
        ],
        key_help_url: None,
        console_url: None,
        base_urls: &[],
        default_app_title: None,
        catalog: "local-models",
        models: Arc::new(vec![]),
        recommended: &[],
        tiers: &[],
        default_model: None,
        background_model: None,
        // ai.local.context overrides it.
        default_context: 128_000,
        test_probe: Probe {
            kind: None,
            check: None,
            method: Some("GET"),
            url: None,
            path: Some("/models"),
            auth: Some("bearer-optional"),
        },
        balance_probe: None,
        error_hints: ErrorHints {
            auth: Some("Your Local AI turned down Tarsee's key. Check it in Settings > AI."),
            unreachable: Some("Can't reach your Local AI at {url}."),
            ..ErrorHints::default()
        },
    },
});

/// The public ids, as `TARSEE_AI_PROVIDER`, /model, the API and the UI use them.
pub const PROVIDER_IDS: &[&str] = &[
    "claude",
    "anthropic",
    "chatgpt",
    "openai",
    "openrouter",
    "deepseek",
    "local",
];

/// Other names accepted for a provider: the Claude plan's storage id.
pub const PROVIDER_ALIASES: &[(&str, &str)] = &[("claude-code", "claude")];

/// One entry of [`AI_PROVIDERS`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProvider {
    /// The id the provider's settings are stored under.
    pub id: &'static str,
    pub name: &'static str,
    pub env_key: Option<&'static str>,
    pub default_model: Option<&'static str>,
    /// Always `None`: no host is ever handed out.
    pub base_url: Option<&'static str>,
    pub no_key_required: bool,
}

/// The shipped providers, keyed by the id their settings are stored under.
#[derive(Debug)]
pub struct AiProviders(Vec<AiProvider>);

impl AiProviders {
    /// The entry stored under this id (`AI_PROVIDERS[id]`).
    pub fn get(&self, storage_id: &str) -> Option<&AiProvider> {
        self.0.iter().find(|p| p.id == storage_id)
    }

    /// Every entry, in table order (`Object.values(AI_PROVIDERS)`).
    pub fn iter(&self) -> impl Iterator<Item = &AiProvider> {
        self.0.iter()
    }

    /// The stored ids, in table order (`Object.keys(AI_PROVIDERS)`).
    pub fn keys(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.0.iter().map(|p| p.id)
    }
}

/// What `config/constants.js` re-exported as `AI_PROVIDERS`: the shipped providers, keyed by the id their settings
/// are stored under, in the shape that table has always had (the Claude plan as "claude-code", exactly as before). A
/// provider joins it when it is shipped.
pub static AI_PROVIDERS: LazyLock<AiProviders> = LazyLock::new(|| {
    AiProviders(
        PROVIDERS
            .iter()
            .filter(|p| p.shipped)
            .map(|p| AiProvider {
                id: p.storage_id,
                name: p.legacy_name.unwrap_or(p.label),
                env_key: p.env_key,
                default_model: p.default_model,
                base_url: None,
                no_key_required: p.kind != ProviderKind::Key,
            })
            .collect(),
    )
});

// --- Lookups ---

/// The public id for a provider id or alias ("claude-code" is the Claude plan), or `None`.
pub fn normalize_provider_id(id_or_alias: &str) -> Option<&'static str> {
    let k = js::trim(id_or_alias).to_lowercase();
    if k.is_empty() {
        return None;
    }
    if let Some(id) = PROVIDER_IDS.iter().find(|id| **id == k) {
        return Some(id);
    }
    PROVIDER_ALIASES
        .iter()
        .find(|(alias, _)| *alias == k)
        .map(|(_, id)| *id)
}

/// A provider's entry by id or alias, shipped or not; `None` when there is none.
pub fn get_provider(id_or_alias: &str) -> Option<&'static Provider> {
    let table: &'static ProviderTable = &PROVIDERS;
    table.get(normalize_provider_id(id_or_alias)?)
}

/// Whether Local AI is left out on this install: on Railway (`RAILWAY_PROJECT_ID`), which has no GPUs, a model
/// server would have to run somewhere else, so it isn't offered there, unless an address is already set
/// (`TARSEE_LOCAL_AI_URL`, say a model server the owner runs as another Railway service, or one saved in Settings >
/// AI), so a setup that works keeps working. Self-hosted installs (Docker on the owner's own machine, a local
/// build) always offer it.
pub fn local_ai_hidden_here(env: &Env, store: Option<&dyn Settings>) -> bool {
    if env_text(env, "RAILWAY_PROJECT_ID").is_none() {
        return false;
    }
    if env_text(env, "TARSEE_LOCAL_AI_URL").is_some() {
        return false;
    }
    let saved = store.and_then(|s| s.get("ai.local.baseUrl"));
    !matches!(saved, Some(Value::String(url)) if !js::trim(&url).is_empty())
}

// --- Which provider, and the keys-only switch ---

/// [`ProviderRegistry::active_provider_id`] with the test for "shipped" given by the caller: for tests (to prove
/// the order once more providers ship).
pub fn active_provider_id_with(
    store: Option<&dyn Settings>,
    env: &Env,
    is_shipped: impl Fn(&str) -> bool,
) -> &'static str {
    let chosen =
        non_empty(read_setting(store, "ai.activeProvider").as_ref()).or_else(|| env_text(env, "TARSEE_AI_PROVIDER"));
    let Some(chosen) = chosen else { return "claude" };
    match normalize_provider_id(&chosen) {
        Some(id) if is_shipped(id) => id,
        _ => "claude",
    }
}

/// Whether `TARSEE_KEYS_ONLY=1` locks "API keys only" on.
pub fn keys_only_locked(env: &Env) -> bool {
    env.get("TARSEE_KEYS_ONLY").is_some_and(|v| is_true_word(&v))
}

/// "API keys only": the `ai.keysOnly` setting, or locked on by `TARSEE_KEYS_ONLY=1`.
pub fn keys_only(store: Option<&dyn Settings>, env: &Env) -> bool {
    keys_only_locked(env) || read_setting(store, "ai.keysOnly").as_ref().is_some_and(truthy)
}

// --- Runtime catalogs ---

static EMPTY: LazyLock<Arc<Vec<ModelEntry>>> = LazyLock::new(|| Arc::new(Vec::new()));

/// What changes at run time: the runtime catalogs and the providers this install hides. One per `App`
/// ([`ProviderRegistry::of`]); a test can also make one of its own ([`ProviderRegistry::new`]).
#[derive(Default)]
pub struct ProviderRegistry {
    /// Providers this install doesn't offer, decided once at boot (`lib/boot_fixups.rs`): see
    /// [`local_ai_hidden_here`].
    hidden: RwLock<HashSet<&'static str>>,
    runtime_catalogs: RwLock<HashMap<&'static str, Arc<Vec<ModelEntry>>>>,
}

impl ProviderRegistry {
    /// A registry with nothing hidden and every runtime catalog empty.
    pub fn new() -> ProviderRegistry {
        ProviderRegistry::default()
    }

    /// The app's registry, made on first use.
    pub fn of(app: &App) -> Arc<ProviderRegistry> {
        app.get_or_init(ProviderRegistry::new)
    }

    /// Set the providers this install doesn't offer (replacing any set before).
    pub fn hide_providers(&self, ids: &[&str]) {
        let mut hidden = self.hidden.write();
        hidden.clear();
        hidden.extend(ids.iter().filter_map(|id| normalize_provider_id(id)));
    }

    /// Whether a provider is switched on: only these can be selected anywhere.
    pub fn is_shipped(&self, id_or_alias: &str) -> bool {
        get_provider(id_or_alias).is_some_and(|p| p.shipped && !self.hidden.read().contains(p.id))
    }

    /// The switched-on providers, in table order.
    pub fn shipped_providers(&self) -> Vec<&'static Provider> {
        let table: &'static ProviderTable = &PROVIDERS;
        let hidden = self.hidden.read();
        table.iter().filter(|p| p.shipped && !hidden.contains(p.id)).collect()
    }

    /// The provider a turn uses when nothing more specific is chosen: the `ai.activeProvider` setting, then
    /// `TARSEE_AI_PROVIDER`, then the Claude plan. The first of those that is set decides; when it names a provider
    /// that does not exist or is not shipped, the answer is the Claude plan. A provider's key being present in the
    /// environment never chooses it.
    pub fn active_provider_id(&self, store: Option<&dyn Settings>, env: &Env) -> &'static str {
        active_provider_id_with(store, env, |id| self.is_shipped(id))
    }

    /// Fill a catalog whose models are only known at runtime: "chatgpt-models" (the signed-in account's list),
    /// "openai-models" (what the key lists), "openrouter" (OpenRouter's public list) or "local-models" (the server's
    /// /models). An empty list empties it again. Each model is
    /// `{ id, label?, vendor?, context?, efforts?, vision?, pdf?, price?, tier?, default?, free? }`, prices in USD
    /// per million tokens. Entries without an id are skipped. Fails for any other catalog name.
    pub fn set_catalog_models(&self, name: &str, models: &[Value]) -> anyhow::Result<()> {
        let Some(name) = RUNTIME_CATALOGS.iter().copied().find(|n| *n == name) else {
            anyhow::bail!("Not a runtime model catalog: {name}");
        };
        let list: Vec<ModelEntry> = models.iter().filter_map(runtime_entry).collect();
        self.runtime_catalogs.write().insert(name, Arc::new(list));
        Ok(())
    }

    /// A runtime catalog's models (empty until it is filled).
    pub fn catalog_models(&self, name: &str) -> Arc<Vec<ModelEntry>> {
        self.runtime_catalogs
            .read()
            .get(name)
            .cloned()
            .unwrap_or_else(|| EMPTY.clone())
    }

    /// The models a provider offers right now.
    pub fn models_for(&self, id_or_alias: &str) -> Arc<Vec<ModelEntry>> {
        match get_provider(id_or_alias) {
            Some(p) => self.model_list(p),
            None => EMPTY.clone(),
        }
    }

    // --- Models ---

    /// The model id to run for a model or tier word on a provider.
    ///  - Tier words (fable, opus, sonnet, haiku, and top, mid, small) map through the provider's tiers, stepping
    ///    down to the next tier it has. Claude Code's "[1m]" suffix on one ("opus[1m]") doesn't change which tier it
    ///    is.
    ///  - A claude-* id on any other provider maps through its tier.
    ///  - An id the provider does not offer falls back to its default.
    ///  - The Claude providers behave as today: tier words stay tier words (with their "[1m]", which Claude Code
    ///    reads), ids in Tarsee's table or Claude Code's catalog are kept, partial names resolve.
    ///  - It never returns a claude-* id for deepseek, chatgpt, openai or local.
    ///
    /// `None` means no model is named (the engine's own default), or no such provider.
    ///
    /// `store` (optional) brings in the owner's choices: Local AI's model and context, OpenRouter's and Local AI's
    /// tier maps, and verified models.
    pub fn resolve_model_for(
        &self,
        id_or_alias: &str,
        model_or_tier: Option<&str>,
        store: Option<&dyn Settings>,
    ) -> Option<String> {
        let p = get_provider(id_or_alias)?;
        let raw = js::trim(model_or_tier.unwrap_or(""));
        if p.catalog == "claude" {
            return Some(resolve_claude(raw));
        }

        let out = if raw.is_empty() {
            self.default_for(p, store)
        } else if let Some(tier) = tier_word(strip_context_suffix(raw)) {
            self.resolve_tier(p, tier, store)
        } else if is_claude_id(raw) {
            match tier_of(raw) {
                Some(tier) => self.resolve_tier(p, tier, store),
                None => self.default_for(p, store),
            }
        } else {
            let id = strip_context_suffix(raw);
            if self.is_available(p, id, store) {
                Some(id.to_string())
            } else {
                self.default_for(p, store)
            }
        };
        let leaks_claude_id = |model: &str| no_claude_ids(p) && is_claude_id(model);
        out.filter(|model| !model.is_empty() && !leaks_claude_id(model))
    }

    /// A model's context window in tokens (the model's own; the caller applies the auto-compact window). Claude
    /// reads today's table as the context meter does, an unknown id counting as 1M. Local AI:
    /// [`local_context_tokens`] with the card's `ai.local.context` and what the server said about that model.
    /// `None` only for no such provider.
    pub fn context_tokens_for(
        &self,
        id_or_alias: &str,
        model: Option<&str>,
        store: Option<&dyn Settings>,
    ) -> Option<u64> {
        let p = get_provider(id_or_alias)?;
        if p.catalog == "claude" {
            let label = model
                .filter(|m| !m.is_empty())
                .and_then(claude_model_by_id)
                .map_or("1M", |meta| meta.context);
            return Some(context_from_label(label));
        }
        let row = self.find_model(p, model);
        if p.id == "local" {
            return Some(local_context_tokens(
                read_setting(store, "ai.local.context").as_ref(),
                row.as_ref().and_then(|r| r.server_context),
                row.as_ref().and_then(|r| r.max_context),
            ));
        }
        Some(
            row.and_then(|r| r.context)
                .filter(|c| *c > 0)
                .unwrap_or(p.default_context),
        )
    }

    /// Fill Local AI's catalog from its server's rows (`[{id, serverContext?, maxContext?}]`, or ids): each model's
    /// context by [`local_context_tokens`], with the server's own size kept beside it (serverContext), so a size the
    /// server reported is never mistaken for the card's.
    pub fn set_local_models(&self, rows: &[Value], store: Option<&dyn Settings>) {
        let own = read_setting(store, "ai.local.context");
        let models: Vec<Value> = rows
            .iter()
            .map(|r| {
                let id = if r.is_string() { Some(r) } else { r.get("id") };
                let field = |name: &str| r.get(name).filter(|v| !v.is_null());
                let label = field("label").filter(|l| js::truthy(l)).or(id);
                let server_context = positive_int(field("serverContext")).filter(|n| *n > 0);
                let max_context = positive_int(field("maxContext")).filter(|n| *n > 0);
                json!({
                    "id": id,
                    "label": label,
                    "context": local_context_tokens(own.as_ref(), server_context, max_context),
                    "serverContext": field("serverContext"),
                    "maxContext": field("maxContext"),
                })
            })
            .collect();
        self.set_catalog_models("local-models", &models)
            .expect("local-models is a runtime catalog");
    }

    /// The effort levels a model takes (Tarsee's ids, low to max); empty when none is sent.
    pub fn efforts_for(&self, id_or_alias: &str, model: Option<&str>, store: Option<&dyn Settings>) -> Vec<String> {
        let all = || EFFORT_IDS.iter().map(|e| e.to_string()).collect::<Vec<_>>();
        let Some(p) = get_provider(id_or_alias) else {
            return Vec::new();
        };
        if p.catalog == "claude" {
            return all();
        }
        let id = strip_context_suffix(js::trim(model.unwrap_or("")));
        let verified = (!id.is_empty())
            .then(|| verified_models(p.id, store).remove(id))
            .flatten();
        if let Some(efforts) = verified
            .as_ref()
            .and_then(|v| v.get("efforts"))
            .and_then(Value::as_array)
        {
            return efforts.iter().filter_map(Value::as_str).map(String::from).collect();
        }
        if p.id == "openrouter" {
            return if open_router_maker(id).as_deref() == Some("anthropic") {
                all()
            } else {
                Vec::new()
            };
        }
        if let Some(efforts) = self.find_model(p, Some(id)).and_then(|entry| entry.efforts) {
            return efforts;
        }
        match p.id {
            "deepseek" => DEEPSEEK_EFFORTS.iter().map(|e| e.to_string()).collect(),
            "chatgpt" | "openai" => all(),
            _ => Vec::new(),
        }
    }

    /// What a model on a provider can do: `{ vision, pdf, thinkingSummaries, nativeBudget, streaming }`.
    ///  - pdf: native PDF blocks, only on Claude Code with a Claude model (the Claude providers and OpenRouter
    ///    anthropic/*). Elsewhere the text is extracted instead.
    ///  - thinkingSummaries: the Claude providers, and Codex on OpenAI's own models.
    ///  - nativeBudget: the engine enforces a dollar ceiling itself (the Claude providers).
    ///  - streaming: replies arrive word by word (Claude Code), not a message at a time (Codex).
    pub fn caps_for(&self, id_or_alias: &str, model: Option<&str>, store: Option<&dyn Settings>) -> Option<Caps> {
        let p = get_provider(id_or_alias)?;
        if p.catalog == "claude" {
            return Some(Caps {
                vision: true,
                pdf: true,
                thinking_summaries: true,
                native_budget: true,
                streaming: true,
            });
        }
        let id = strip_context_suffix(js::trim(model.unwrap_or("")));
        let engine = engine_for(p.id, Some(id), store);
        let entry = self.find_model(p, Some(id));
        let maker = if p.id == "openrouter" {
            open_router_maker(id)
        } else {
            None
        };
        let maker = maker.as_deref();
        let vision_default = if p.id == "openrouter" {
            maker == Some("anthropic") || maker == Some("openai")
        } else {
            p.id == "chatgpt" || p.id == "openai"
        };
        let on_claude_code = engine == Some(CLAUDE_CODE);
        Some(Caps {
            vision: entry.as_ref().and_then(|e| e.vision).unwrap_or(vision_default),
            pdf: on_claude_code && entry.as_ref().and_then(|e| e.pdf).unwrap_or(maker == Some("anthropic")),
            thinking_summaries: p.id == "chatgpt" || p.id == "openai",
            native_budget: false,
            streaming: on_claude_code,
        })
    }

    /// A model's price at a moment, in USD per million tokens: `{ in, out, cacheRead, cacheWrite, peak }` where
    /// peak is true or false for a provider with peak hours (DeepSeek: off-peak is half price) and `None` otherwise.
    /// `None` when there is no per-token price: the plans ("Included in plan"), the Anthropic key (the engine
    /// reports the exact cost), or a model with no known price. Local AI is free unless the card sets
    /// `ai.local.price`. `at` is read as [`is_deep_seek_peak`] reads it: `None` (a turn still running) is now.
    pub fn price_for(
        &self,
        id_or_alias: &str,
        model: Option<&str>,
        at: Option<i64>,
        store: Option<&dyn Settings>,
    ) -> Option<Price> {
        self.price_at(id_or_alias, model, moment(at, js::now_ms()), store)
    }

    /// [`price_for`](Self::price_for) at a moment that is already known, in milliseconds since 1970.
    fn price_at(
        &self,
        id_or_alias: &str,
        model: Option<&str>,
        at_ms: i64,
        store: Option<&dyn Settings>,
    ) -> Option<Price> {
        let p = get_provider(id_or_alias)?;
        if p.kind == ProviderKind::Subscription || p.catalog == "claude" {
            return None;
        }
        if p.id == "local" {
            let own = normalize_price(read_json(store, "ai.local.price").as_ref())
                .unwrap_or(ModelPrice::flat(0.0, 0.0, 0.0, 0.0));
            return Some(Price {
                input: own.input,
                output: own.output,
                cache_read: own.cache_read,
                cache_write: own.cache_write,
                peak: None,
            });
        }
        let price = self.find_model(p, model)?.price?;
        let Some(window) = price.peak else {
            return Some(Price {
                input: price.input,
                output: price.output,
                cache_read: price.cache_read,
                cache_write: price.cache_write,
                peak: None,
            });
        };
        let peak = in_peak_window(&window, at_ms);
        let f = if peak { 1.0 } else { window.off_peak_factor };
        Some(Price {
            input: price.input * f,
            output: price.output * f,
            cache_read: price.cache_read * f,
            cache_write: price.cache_write * f,
            peak: Some(peak),
        })
    }

    /// Anthropic's list price for a Claude model, in USD per million tokens (`{ in, out, cacheRead, cacheWrite }`),
    /// read from OpenRouter's public catalog (loaded at boot and every few hours, no key needed), which lists
    /// Anthropic's models at Anthropic's prices: "claude-opus-4-7" is "anthropic/claude-opus-4.7" there. A tier word
    /// ("sonnet"), or a pinned id the catalog doesn't list, takes its family's newest there. `None` while the
    /// catalog isn't in. For an Anthropic key's turn that ended before its engine reported the exact cost
    /// (`spend::anthropic_list_cost`).
    pub fn claude_list_price(&self, model: &str) -> Option<ModelPrice> {
        static PINNED_VERSION: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"-([0-9]+)-([0-9]+)$").expect("the pinned version pattern"));
        let lower = js::trim(model).to_lowercase();
        let id = strip_context_suffix(&lower);
        if id.is_empty() {
            return None;
        }
        let list = self.catalog_models("openrouter");
        let priced = |slug: &str| list.iter().find(|m| m.id == slug && m.price.is_some())?.price;
        if is_claude_id(id)
            && let Some(exact) = priced(&format!("anthropic/{}", PINNED_VERSION.replace(id, "-$1.$2")))
        {
            return Some(exact);
        }
        let family = tier_word(id).or_else(|| tier_of(id))?;
        let prefix = format!("anthropic/claude-{family}-");
        let mut best: Option<(f64, ModelPrice)> = None;
        for m in list.iter() {
            let (Some(version), Some(price)) = (m.id.strip_prefix(&prefix).and_then(family_version), m.price) else {
                continue;
            };
            if best.is_none_or(|(newest, _)| version > newest) {
                best = Some((version, price));
            }
        }
        best.map(|(_, price)| price)
    }

    // --- Internals ---

    fn resolve_tier(&self, p: &'static Provider, tier: &str, store: Option<&dyn Settings>) -> Option<String> {
        // Local AI: the owner's map for this tier, else the one chosen model for every tier.
        if p.id == "local" {
            return owner_tiers(p, store)
                .remove(tier)
                .or_else(|| self.default_for(p, store));
        }
        self.pick_tier(p, tier, store).or_else(|| self.default_for(p, store))
    }

    fn pick_tier(&self, p: &'static Provider, tier: &str, store: Option<&dyn Settings>) -> Option<String> {
        let own = owner_tiers(p, store);
        let list = self.model_list(p);
        let maker = self.maker_tiers(p, store);
        for t in step_order(tier) {
            if let Some(mine) = own.get(t) {
                return Some(mine.clone());
            }
            let shipped: Option<String> = match &maker {
                Some(tiers) => tiers.get(t).cloned(),
                None => p.tier(t).map(String::from),
            };
            if let Some(shipped) = shipped.filter(|s| !s.is_empty())
                && self.is_available(p, &shipped, store)
            {
                return Some(shipped);
            }
            if let Some(listed) = list.iter().find(|m| m.tier.as_deref() == Some(t)) {
                return Some(listed.id.clone());
            }
        }
        None
    }

    /// OpenRouter's tiers when the owner's default model there (`ai.openrouter.model`) is another maker's than
    /// Anthropic's (design 4.11: the defaults follow the default model's maker): background work, crons, /auto and
    /// the built-in agents then stay with that maker instead of moving to Claude. The models are the default and the
    /// ones verified from its maker; the default is sonnet, the dearest of them (by the catalog's output price) opus
    /// and fable, the cheapest haiku. `None` keeps the shipped ~anthropic slugs: an Anthropic default, none, or one
    /// that can't run until it is verified.
    fn maker_tiers(&self, p: &'static Provider, store: Option<&dyn Settings>) -> Option<HashMap<&'static str, String>> {
        if p.id != "openrouter" {
            return None;
        }
        let chosen = non_empty(read_setting(store, "ai.openrouter.model").as_ref()).unwrap_or_default();
        let def = strip_context_suffix(&chosen);
        let maker = open_router_maker(def)?;
        if maker == "anthropic" || engine_for(p.id, Some(def), store).is_none() {
            return None;
        }
        let out = |id: &str| {
            self.find_model(p, Some(id))
                .and_then(|m| m.price)
                .map(|price| price.output)
                .filter(|rate| rate.is_finite())
        };
        let same: Vec<String> = verified_models(p.id, store)
            .keys()
            .filter(|id| id.as_str() != def && open_router_maker(id).as_deref() == Some(maker.as_str()))
            .cloned()
            .collect();
        let d = out(def);
        let priced: Vec<(String, f64)> = match d {
            Some(_) => same
                .into_iter()
                .filter_map(|id| out(&id).map(|rate| (id, rate)))
                .collect(),
            None => Vec::new(),
        };
        let d = d.unwrap_or(0.0);
        // The first of the dearest and the first of the cheapest, as the JS's stable sorts put them.
        let mut dearest: Option<&(String, f64)> = None;
        let mut cheapest: Option<&(String, f64)> = None;
        for candidate in &priced {
            if candidate.1 > d && dearest.is_none_or(|best| candidate.1 > best.1) {
                dearest = Some(candidate);
            }
            if candidate.1 < d && cheapest.is_none_or(|best| candidate.1 < best.1) {
                cheapest = Some(candidate);
            }
        }
        let dearest = dearest.map_or_else(|| def.to_string(), |(id, _)| id.clone());
        let cheapest = cheapest.map_or_else(|| def.to_string(), |(id, _)| id.clone());
        Some(HashMap::from([
            ("fable", dearest.clone()),
            ("opus", dearest),
            ("sonnet", def.to_string()),
            ("haiku", cheapest),
        ]))
    }

    fn default_for(&self, p: &'static Provider, store: Option<&dyn Settings>) -> Option<String> {
        if p.catalog == "claude" {
            return Some(get_recommended_model().to_string());
        }
        if p.id == "local"
            && let Some(chosen) = non_empty(read_setting(store, &format!("ai.{}.model", p.storage_id)).as_ref())
            && !is_claude_id(&chosen)
        {
            return Some(chosen);
        }
        let d = p.default_model;
        if let Some(d) = d
            && self.is_available(p, d, store)
        {
            return Some(d.to_string());
        }
        let list = self.model_list(p);
        if let Some(flagged) = list.iter().find(|m| m.default) {
            return Some(flagged.id.clone());
        }
        // The default is not on offer (a key that can't use it): step down from its tier.
        let tier = d.and_then(|d| MODEL_TIERS.iter().copied().find(|t| p.tier(t) == Some(d)));
        tier.and_then(|t| self.pick_tier(p, t, store))
            .or_else(|| list.first().map(|m| m.id.clone()))
    }

    /// The models a provider offers now: its table, its runtime catalog, or the table narrowed to what the key
    /// lists.
    fn model_list(&self, p: &'static Provider) -> Arc<Vec<ModelEntry>> {
        let list = match p.catalog {
            "claude" => return p.models.clone(),
            "static" => p.models.clone(),
            "openai-models" => {
                let live = self.catalog_models("openai-models");
                if live.is_empty() {
                    p.models.clone()
                } else {
                    let ids: HashSet<&str> = live.iter().map(|m| m.id.as_str()).collect();
                    Arc::new(
                        p.models
                            .iter()
                            .filter(|m| ids.contains(m.id.as_str()))
                            .cloned()
                            .collect(),
                    )
                }
            }
            catalog => self.catalog_models(catalog),
        };
        if no_claude_ids(p) && list.iter().any(|m| is_claude_id(&m.id)) {
            return Arc::new(list.iter().filter(|m| !is_claude_id(&m.id)).cloned().collect());
        }
        list
    }

    fn find_model(&self, p: &'static Provider, model: Option<&str>) -> Option<ModelEntry> {
        let id = strip_context_suffix(js::trim(model.unwrap_or("")));
        if id.is_empty() {
            return None;
        }
        self.model_list(p).iter().find(|m| m.id == id).cloned()
    }

    /// Whether a provider can be asked for this model id now.
    fn is_available(&self, p: &'static Provider, id: &str, store: Option<&dyn Settings>) -> bool {
        if id.is_empty() {
            return false;
        }
        if no_claude_ids(p) && is_claude_id(id) {
            return false;
        }
        if verified_models(p.id, store).contains_key(id) {
            return true;
        }
        let list = self.model_list(p);
        if list.iter().any(|m| m.id == id) {
            return true;
        }
        // Before OpenRouter's or the Local AI server's list is in, any id may be asked for (the engine says if it
        // is unknown). OpenRouter's "~" latest slugs are never in its list.
        match p.catalog {
            "openrouter" => list.is_empty() || id.starts_with('~'),
            "local-models" => list.is_empty(),
            _ => false,
        }
    }
}

/// The models verified on a provider: the shipped results, with the owner's own
/// (`ai.<id>.verified`, JSON `{ model: { engine, at, engineVersion, efforts?, checks? } }`) on top. Entries naming
/// an engine the provider does not have are dropped.
pub fn verified_models(id_or_alias: &str, store: Option<&dyn Settings>) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(p) = get_provider(id_or_alias) else {
        return out;
    };
    if p.catalog != "claude" {
        for m in p.models.iter() {
            if let Some(verified) = &m.verified {
                out.insert(m.id.clone(), verified.clone());
            }
        }
    }
    if let Some(Value::Object(own)) = read_json(store, &format!("ai.{}.verified", p.id)) {
        for (id, v) in own {
            let engine = v.get("engine").and_then(Value::as_str).and_then(Engine::from_id);
            if v.is_object() && engine.is_some_and(|e| p.engines.contains(&e)) {
                out.insert(id, v);
            }
        }
    }
    out
}

/// Whether a model name is a tier word (fable, opus, sonnet, haiku, top, mid, small; "[1m]" or not), not a model
/// id.
pub fn is_tier_word(raw: &str) -> bool {
    tier_word(strip_context_suffix(js::trim(raw))).is_some()
}

/// The engine that runs a model on a provider:
///  - claude, anthropic: Claude Code.
///  - chatgpt, openai, local: Codex.
///  - deepseek: the engine it was verified on, else Claude Code.
///  - openrouter: the engine it was verified on; else anthropic/* on Claude Code and openai/* on Codex; else
///    `None`, meaning it must be verified first.
pub fn engine_for(id_or_alias: &str, model: Option<&str>, store: Option<&dyn Settings>) -> Option<Engine> {
    let p = get_provider(id_or_alias)?;
    if p.engines.len() == 1 {
        return Some(p.engines[0]);
    }
    let id = strip_context_suffix(js::trim(model.unwrap_or("")));
    let verified = (!id.is_empty())
        .then(|| verified_models(p.id, store).remove(id))
        .flatten();
    if let Some(verified) = verified {
        return verified.get("engine").and_then(Value::as_str).and_then(Engine::from_id);
    }
    if p.id == "openrouter" {
        return match open_router_maker(id).as_deref() {
            Some("anthropic") => Some(CLAUDE_CODE),
            Some("openai") => Some(CODEX),
            _ => None,
        };
    }
    Some(p.engines[0])
}

/// Who made a model: the slug's maker on OpenRouter (without the "~"), otherwise the provider id; `None` for no
/// such provider. Always a name a session handle can carry (lower case letters, digits, ".", "-" and "_"):
/// `session_handle` uses this very function, so a session is tied to its maker by one rule.
pub fn vendor_for(id_or_alias: &str, model: Option<&str>) -> Option<String> {
    let p = get_provider(id_or_alias)?;
    if p.id == "openrouter" {
        let maker: String = open_router_maker(js::trim(model.unwrap_or("")))
            .unwrap_or_default()
            .chars()
            .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
            .collect();
        return Some(if maker.is_empty() { p.id.to_string() } else { maker });
    }
    Some(p.id.to_string())
}

/// Local AI's context, by one rule: when the server said how much it gives the model (`server_context`:
/// llama-server's n_ctx, LM Studio's loaded context, Ollama's), the smaller of that and the owner's setting (`own`:
/// the card's `ai.local.context`); otherwise the owner's setting, then 128K. Never more than the model was trained
/// for (`max_context`), when the server says that.
pub fn local_context_tokens(own: Option<&Value>, server_context: Option<u64>, max_context: Option<u64>) -> u64 {
    let mine = positive_int(own).filter(|n| *n > 0);
    let server = server_context.filter(|n| *n > 0);
    let table: &'static ProviderTable = &PROVIDERS;
    let n = match (server, mine) {
        (Some(server), Some(mine)) => mine.min(server),
        (server, mine) => server.or(mine).unwrap_or(table.local.default_context),
    };
    match max_context.filter(|max| *max > 0) {
        Some(max) => n.min(max),
        None => n,
    }
}

/// What a model on a provider can do ([`ProviderRegistry::caps_for`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    pub vision: bool,
    pub pdf: bool,
    pub thinking_summaries: bool,
    pub native_budget: bool,
    pub streaming: bool,
}

/// Whether a moment falls in DeepSeek's peak hours (01:00-04:00 and 06:00-10:00 UTC, Monday to Friday). A moment
/// is milliseconds since 1970 (what `now_ms()` and the stored timestamps hold; an ISO string goes through
/// `util::js::ms_from_iso`); `None`, or a moment no date can hold, means now.
pub fn is_deep_seek_peak(at: Option<i64>) -> bool {
    in_peak_window(&DEEPSEEK_PEAK, moment(at, js::now_ms()))
}

/// Whether a pasted key fits a provider's slot ([`check_key_slot`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeySlotCheck {
    pub ok: bool,
    /// Why not, in words for the owner; `None` when it fits.
    pub message: Option<String>,
}

/// Whether a pasted key fits a provider's slot: `{ ok, message }`. Catches a Claude sign-in token pasted as an API
/// key and keys pasted into another provider's card.
pub fn check_key_slot(id_or_alias: &str, key: &str) -> KeySlotCheck {
    let refuse = |message: String| KeySlotCheck {
        ok: false,
        message: Some(message),
    };
    let Some(p) = get_provider(id_or_alias) else {
        return refuse("Tarsee doesn't know that AI.".to_string());
    };
    if p.kind == ProviderKind::Subscription {
        return refuse(format!("The {} signs in; it takes no API key.", p.label));
    }
    let k = strip_one_quote_each_side(js::trim(key));
    if k.is_empty() {
        return refuse("Paste a key first.".to_string());
    }
    if let Some(wrong) = p.wrong_slot.iter().find(|w| w.matches(k)) {
        return refuse(wrong.message.to_string());
    }
    if let Some(pattern) = &p.key_pattern
        && !pattern.is_match(k)
    {
        return refuse(format!("This doesn't look like {}.", p.key_noun.unwrap_or("a key")));
    }
    KeySlotCheck {
        ok: true,
        message: None,
    }
}

// --- Internals ---

fn resolve_claude(raw: &str) -> String {
    if raw.is_empty() {
        return get_recommended_model().to_string();
    }
    // "opus[1m]" is a Claude Code alias of its own: the tier, kept with its suffix as today.
    let bare = strip_context_suffix(raw);
    if let Some(tier) = tier_word(bare) {
        let model = resolve_model_alias(tier).unwrap_or(tier);
        return format!("{model}{}", if bare == raw { "" } else { "[1m]" });
    }
    if let Some(known) = resolve_model_alias(raw) {
        return known.to_string();
    }
    // A release Claude Code's catalog lists before Tarsee's table does.
    if parse_picker_id(raw).is_some() {
        return raw.to_string();
    }
    get_recommended_model().to_string()
}

fn tier_word(raw: &str) -> Option<&'static str> {
    let w = raw.to_lowercase();
    if let Some((_, tier)) = TIER_ALIASES.iter().find(|(alias, _)| *alias == w) {
        return Some(tier);
    }
    MODEL_TIERS.iter().copied().find(|t| *t == w)
}

/// The tiers from the asked one down, then up: a provider without the asked tier answers with the next one below.
fn step_order(tier: &str) -> Vec<&'static str> {
    let Some(i) = MODEL_TIERS.iter().position(|t| *t == tier) else {
        return MODEL_TIERS.to_vec();
    };
    MODEL_TIERS[i..]
        .iter()
        .chain(MODEL_TIERS[..i].iter().rev())
        .copied()
        .collect()
}

/// The owner's own tier map (`ai.<id>.tiers`): OpenRouter and Local AI only.
fn owner_tiers(p: &Provider, store: Option<&dyn Settings>) -> HashMap<&'static str, String> {
    let mut out = HashMap::new();
    if p.id != "openrouter" && p.id != "local" {
        return out;
    }
    let Some(Value::Object(own)) = read_json(store, &format!("ai.{}.tiers", p.id)) else {
        return out;
    };
    for tier in MODEL_TIERS {
        if let Some(model) = non_empty(own.get(*tier))
            && !(no_claude_ids(p) && is_claude_id(&model))
        {
            out.insert(*tier, model);
        }
    }
    out
}

/// "~anthropic/claude-sonnet-latest" -> "anthropic"; `None` for an id without a maker.
fn open_router_maker(slug: &str) -> Option<String> {
    let s = slug.strip_prefix('~').unwrap_or(slug);
    match s.find('/') {
        Some(i) if i > 0 => Some(s[..i].to_lowercase()),
        _ => None,
    }
}

/// Claude Code's "[1m]" context suffix is the engine's business, not part of the model id.
fn strip_context_suffix(id: &str) -> &str {
    let cut = id.len().saturating_sub(4);
    if id.len() >= 4 && id.is_char_boundary(cut) && id[cut..].eq_ignore_ascii_case("[1m]") {
        &id[..cut]
    } else {
        id
    }
}

/// "1M" / "200K" (the Claude table's context labels) in tokens; anything unreadable counts as 1M, as the context
/// meter does.
fn context_from_label(label: &str) -> u64 {
    static LABEL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(&format!("^([0-9]+){JS_SPACE}*([KkMm])$")).expect("the context label pattern"));
    match LABEL.captures(label) {
        Some(m) => {
            let unit = if m[2].eq_ignore_ascii_case("m") {
                1_000_000.0
            } else {
                1_000.0
            };
            let tokens = m[1].parse::<f64>().unwrap_or(f64::INFINITY) * unit;
            if tokens.is_finite() { tokens as u64 } else { u64::MAX }
        }
        None => 1_000_000,
    }
}

/// JavaScript's `\s`, as a character class.
const JS_SPACE: &str =
    r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

/// The moment to use: the one given when a date can hold it, else `now`. `new Date(null)` is 1970-01-01, an
/// off-peak Thursday: a missing moment is now, not that.
fn moment(at: Option<i64>, now: i64) -> i64 {
    // The furthest a JavaScript Date reaches either side of 1970.
    const DATE_RANGE_MS: i64 = 8_640_000_000_000_000;
    match at {
        Some(ms) if (-DATE_RANGE_MS..=DATE_RANGE_MS).contains(&ms) => ms,
        _ => now,
    }
}

fn in_peak_window(spec: &PeakWindow, at_ms: i64) -> bool {
    const DAY_MS: i64 = 86_400_000;
    // 1970-01-01 was a Thursday; Sunday is 0, as getUTCDay() counts.
    let weekday = (at_ms.div_euclid(DAY_MS) + 4).rem_euclid(7) as u32;
    if !spec.days.contains(&weekday) {
        return false;
    }
    let mins = (at_ms.rem_euclid(DAY_MS) / 60_000) as u32;
    spec.hours_utc
        .iter()
        .any(|(from, to)| mins >= from * 60 && mins < to * 60)
}

/// The version after "anthropic/claude-<family>-" ("4.7", "5") as one number, newer being bigger; `None` when what
/// follows is not a version.
fn family_version(rest: &str) -> Option<f64> {
    let (major, minor) = rest.split_once('.').unwrap_or((rest, ""));
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
    if !digits(major) || (rest.contains('.') && !digits(minor)) {
        return None;
    }
    let number = |text: &str| text.parse::<f64>().unwrap_or(0.0);
    Some(number(major) * 1000.0 + if minor.is_empty() { 0.0 } else { number(minor) })
}

/// One model of a runtime catalog, from what it was given; `None` for an entry without an id.
fn runtime_entry(m: &Value) -> Option<ModelEntry> {
    let id = js::trim(m.get("id")?.as_str()?);
    if id.is_empty() {
        return None;
    }
    let flag = |name: &str| m.get(name).and_then(Value::as_bool);
    Some(ModelEntry {
        id: id.to_string(),
        label: non_empty(m.get("label")).unwrap_or_else(|| id.to_string()),
        vendor: non_empty(m.get("vendor")),
        context: positive_int(m.get("context")),
        efforts: m
            .get("efforts")
            .and_then(Value::as_array)
            .map(|efforts| efforts.iter().filter_map(Value::as_str).map(String::from).collect()),
        vision: flag("vision"),
        pdf: flag("pdf"),
        price: normalize_price(m.get("price")),
        tier: m
            .get("tier")
            .and_then(Value::as_str)
            .filter(|t| MODEL_TIERS.contains(t))
            .map(String::from),
        alias: false,
        default: flag("default") == Some(true),
        free: flag("free") == Some(true),
        // Local AI: what its server said (set_local_models); only there when it said it.
        server_context: positive_int(m.get("serverContext")).filter(|n| *n > 0),
        max_context: positive_int(m.get("maxContext")).filter(|n| *n > 0),
        verified: None,
    })
}

/// `{ in, out, cacheRead?, cacheWrite? }` with numbers; a missing cache rate counts as the input rate.
fn normalize_price(p: Option<&Value>) -> Option<ModelPrice> {
    let p = p.filter(|p| p.is_object())?;
    let num = |name: &str| -> Option<f64> {
        let n = match p.get(name)? {
            Value::Number(n) => n.as_f64()?,
            Value::String(text) if !js::trim(text).is_empty() => js_to_number(text),
            _ => return None,
        };
        (n.is_finite() && n >= 0.0).then_some(n)
    };
    let input = num("in")?;
    let output = num("out")?;
    Some(ModelPrice::flat(
        input,
        output,
        num("cacheRead").unwrap_or(input),
        num("cacheWrite").unwrap_or(input),
    ))
}

/// `String(env.NAME || "").trim()`, or `None` when nothing is left.
fn env_text(env: &Env, name: &str) -> Option<String> {
    let value = env.get(name)?;
    let text = js::trim(&value);
    (!text.is_empty()).then(|| text.to_string())
}

/// `store?.get?.(key) ?? null`.
fn read_setting(store: Option<&dyn Settings>, key: &str) -> Option<Value> {
    store?.get(key).filter(|v| !v.is_null())
}

/// A setting that holds JSON: the settings store hands it back parsed, a plain string is parsed here.
fn read_json(store: Option<&dyn Settings>, key: &str) -> Option<Value> {
    match read_setting(store, key)? {
        Value::String(text) => serde_json::from_str(&text).ok(),
        v @ (Value::Object(_) | Value::Array(_)) => Some(v),
        _ => None,
    }
}

/// The text of a string that is not blank, trimmed.
fn non_empty(v: Option<&Value>) -> Option<String> {
    let text = js::trim(v?.as_str()?);
    (!text.is_empty()).then(|| text.to_string())
}

/// A count above zero from a number or a string of one, rounded as `Math.round` rounds (a half goes up). A value
/// between 0 and one half is 0, as in the JS: callers that need "above zero" check it.
pub(crate) fn positive_int(v: Option<&Value>) -> Option<u64> {
    let n = match v? {
        Value::Number(n) => n.as_f64()?,
        Value::String(text) => js_to_number(text),
        _ => return None,
    };
    (n.is_finite() && n > 0.0).then(|| (n + 0.5).floor() as u64)
}

/// `Number(text)`: JavaScript's reading of a string as a number. Blank is 0; anything that is not a number is NaN.
pub(crate) fn js_to_number(text: &str) -> f64 {
    static DECIMAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").expect("the decimal pattern")
    });
    let text = js::trim(text);
    if text.is_empty() {
        return 0.0;
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        if let Some(digits) = prefixes.iter().find_map(|p| text.strip_prefix(p)) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |n, c| {
                n * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    if DECIMAL.is_match(text) {
        text.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

const TRUE_WORDS: &[&str] = &["1", "true", "yes", "on"];

fn is_true_word(text: &str) -> bool {
    TRUE_WORDS.contains(&js::trim(text).to_lowercase().as_str())
}

/// `v === true || v === 1`, or one of the words for yes.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() == Some(1.0),
        Value::String(text) => is_true_word(text),
        _ => false,
    }
}

/// `text.replace(/^["']|["']$/g, "")`: one quote off the start and one off the end, whichever kind each is.
pub(crate) fn strip_one_quote_each_side(text: &str) -> &str {
    let is_quote = |c: char| c == '"' || c == '\'';
    let text = text.strip_prefix(is_quote).unwrap_or(text);
    text.strip_suffix(is_quote).unwrap_or(text)
}

#[cfg(test)]
mod tests;
