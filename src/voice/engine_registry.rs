//! Port of `src/voice/engine-registry.js`: which text-to-speech engine speaks, chosen from Settings > Voice, with
//! Phonon (the default) backed by Edge TTS.
//!
//! The Node module kept the engine in use in a module variable; here it is the app service [`TtsRegistry`]
//! ([`get_tts_engine`], [`set_tts_engine`], [`init_tts_engine`], [`stop_tts_engine`]).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::{Mutex, RwLock};
use regex::Regex;
use serde_json::Value;

use super::edge_tts_engine::EdgeTtsEngine;
use super::elevenlabs_engine::ElevenLabsTtsEngine;
use super::phonon_engine::{PhononOptions, PhononTtsEngine, SharedTask, js_number, js_string_or_empty, spawn_shared};
use super::piper_engine::PiperTtsEngine;
use super::tts_interface::{AudioStream, ClonedVoice, SynthOptions, Synthesized, TtsEngine, TtsError, VoiceInfo};
use super::tts_stub::StubTtsEngine;
use crate::app::App;
use crate::db::settings::{Settings, get_api_key};
use crate::util::js::{number_to_string, trim};

/// The engine in use, and how many inits have started (only the newest may choose).
pub struct TtsRegistry {
    current: RwLock<Arc<dyn TtsEngine>>,
    init_seq: AtomicU64,
}

impl TtsRegistry {
    fn of(app: &App) -> Arc<TtsRegistry> {
        app.get_or_init(|| TtsRegistry {
            current: RwLock::new(Arc::new(StubTtsEngine::new())),
            init_seq: AtomicU64::new(0),
        })
    }
}

/// The engine that speaks now: the stub (voice disabled) until one is chosen.
pub fn get_tts_engine(app: &App) -> Arc<dyn TtsEngine> {
    TtsRegistry::of(app).current.read().clone()
}

pub fn set_tts_engine(app: &App, engine: Arc<dyn TtsEngine>) {
    *TtsRegistry::of(app).current.write() = engine;
}

/// The engine used when voice.engine has never been set.
pub const DEFAULT_ENGINE: &str = "phonon";

/// The engine the user asked for: voice.engine, else Phonon, for everything that speaks (calls, read-aloud, voice
/// replies on channels). A saved ElevenLabs key is not a choice: the paid engine speaks only when picked in Settings >
/// Voice (or with "auto"). Installs from before Phonon that had a key and never picked an engine speak with Phonon now,
/// which is free and local; Settings > Voice already showed Phonon for them.
pub fn engine_preference(settings: Option<&dyn Settings>) -> String {
    if let Some(Value::String(v)) = settings.and_then(|s| s.get("voice.engine")) {
        let v = trim(&v);
        if !v.is_empty() {
            return v.to_string();
        }
    }
    DEFAULT_ENGINE.to_string()
}

/// "Auto" tries these in order. Phonon is only available once it is installed.
const AUTO_ORDER: &[&str] = &["phonon", "piper", "elevenlabs", "edge-tts"];

/// When the engine the user picked cannot start, this one is tried before the auto order. Edge TTS is free and always
/// there; ElevenLabs is never reached this way because it costs money.
fn preferred_fallback(name: &str) -> Option<&'static str> {
    match name {
        "phonon" => Some("edge-tts"),
        _ => None,
    }
}

/// What is tried after the picked engine and its preferred fallback both fail. Phonon (the default) never falls
/// through to ElevenLabs.
fn after_fallback(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "phonon" => Some(&["piper"]),
        _ => None,
    }
}

/// Engines that cost money: used when picked (or with "auto"), never as a stand-in for another engine that can't
/// start.
const PAID: &[&str] = &["elevenlabs"];

/// Edge TTS voice ids look like "en-US-AndrewMultilingualNeural" or "fil-PH-AngeloNeural".
static EDGE_VOICE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-z]{2,3}-[A-Z]{2}(?:-[A-Za-z]+)?-[A-Za-z0-9_]+Neural$").expect("the Edge voice pattern")
});

/// A voice id the fallback engine can use, or `None` for its own default. The id given to Phonon (a Phonon voice like
/// "toby") would make Edge TTS fail.
pub fn fallback_voice_for(engine_name: &str, voice_id: Option<&str>) -> Option<String> {
    let voice_id = voice_id.filter(|v| !v.is_empty())?;
    if engine_name == "edge-tts" && EDGE_VOICE.is_match(voice_id) {
        return Some(voice_id.to_string());
    }
    None
}

/// Phonon's speaking rate (voice.phonon.speed, 0.85 to 1.25). The other engines have no speed setting.
fn apply_voice_speed(settings: Option<&dyn Settings>, engine: &Arc<dyn TtsEngine>) {
    if engine.name() != "phonon" {
        return;
    }
    let sp = js_number(Some(
        &settings
            .and_then(|s| s.get("voice.phonon.speed"))
            .unwrap_or(Value::Null),
    ));
    if sp.is_finite() && sp > 0.0 {
        engine.set_speed(sp);
        log::info!("[voice] phonon speaking rate set to {}x", number_to_string(sp));
    }
}

/// Builds a named engine, as the test loaders did: `(settings, defaultVoice) => engine` (`None`: not available).
pub type EngineLoader = Arc<
    dyn Fn(Option<Arc<dyn Settings>>, Option<String>) -> BoxFuture<'static, anyhow::Result<Option<Arc<dyn TtsEngine>>>>
        + Send
        + Sync,
>;

/// The options of [`init_tts_engine`]: `loaders` replaces how named engines are built (tests).
#[derive(Clone, Default)]
pub struct InitOptions {
    pub loaders: HashMap<String, EngineLoader>,
}

/// A text setting as the JS read it (`store.get(key) || undefined`): a falsy value is none.
fn setting_text(settings: Option<&dyn Settings>, key: &str) -> Option<String> {
    let value = settings.and_then(|s| s.get(key));
    let text = js_string_or_empty(value.as_ref());
    (!text.is_empty()).then_some(text)
}

/// Initialize the TTS engine from settings. Called at boot and again whenever a voice.* setting changes.
///
/// voice.engine unset or "phonon": Phonon (the default), with Edge TTS speaking whenever Phonon is not installed yet or
/// fails. Another named engine: that engine, then the free ones of the auto order (ElevenLabs costs money, so it speaks
/// only when picked or with "auto"). "auto": Phonon when installed, then Piper, ElevenLabs, Edge TTS. Nothing
/// available: the stub (voice disabled).
pub async fn init_tts_engine(app: &App, settings: Option<Arc<dyn Settings>>, opts: InitOptions) {
    let registry = TtsRegistry::of(app);
    let seq = registry.init_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let store = settings.as_deref();
    let engine_pref = engine_preference(store);
    let default_voice = setting_text(store, "voice.defaultVoiceId");
    let loaders = Arc::new(opts.loaders);

    let choose = |engine: Arc<dyn TtsEngine>| {
        // Settings saves come in bursts (voice, speed, engine), each starting an init. Only the newest one may set
        // the engine, so an older init finishing late cannot undo a newer choice.
        if registry.init_seq.load(Ordering::SeqCst) != seq {
            return;
        }
        let previous = std::mem::replace(&mut *registry.current.write(), engine.clone());
        apply_voice_speed(store, &engine);
        if previous.name() == "phonon" && engine.name() != "phonon" {
            // Switched away from Phonon: let its warm worker go.
            previous.stop();
        }
    };

    let mut rest: Vec<&str> = AUTO_ORDER.to_vec();
    if engine_pref != "auto" {
        let engine = try_engine(
            app.clone(),
            engine_pref.clone(),
            settings.clone(),
            default_voice.clone(),
            loaders.clone(),
            false,
        )
        .await;
        if let Some(engine) = engine {
            return choose(engine);
        }
        let next = preferred_fallback(&engine_pref);
        if let Some(next) = next {
            let voice = fallback_voice_for(next, default_voice.as_deref());
            let fb = try_engine(
                app.clone(),
                next.to_string(),
                settings.clone(),
                voice,
                loaders.clone(),
                false,
            )
            .await;
            if let Some(fb) = fb {
                log::warn!("[voice] {engine_pref} is not available yet, {next} speaks instead");
                return choose(fb);
            }
        }
        log::warn!("[voice] Preferred engine \"{engine_pref}\" unavailable, falling back");
        rest = after_fallback(&engine_pref)
            .unwrap_or(AUTO_ORDER)
            .iter()
            .copied()
            .filter(|n| *n != engine_pref && Some(*n) != next && !PAID.contains(n))
            .collect();
    }

    for name in rest {
        let engine = try_engine(
            app.clone(),
            name.to_string(),
            settings.clone(),
            None,
            loaders.clone(),
            false,
        )
        .await;
        if let Some(engine) = engine {
            return choose(engine);
        }
    }

    log::warn!("[voice] No TTS engine available — voice disabled");
    choose(Arc::new(StubTtsEngine::new()));
}

/// The engines Tarsee has: `name` built from the settings, or `None` when it has no such engine or is not set up.
fn builtin_engine(
    app: &App,
    name: &str,
    settings: Option<&dyn Settings>,
    default_voice: Option<String>,
) -> Option<Arc<dyn TtsEngine>> {
    match name {
        "elevenlabs" => {
            // `settingsStore?.getApiKey?.("elevenlabs")`: no store, no key from it (not even the environment's).
            let key = settings
                .and_then(|s| get_api_key(s, app.env(), "elevenlabs"))
                .or_else(|| setting_text(settings, "voice.elevenlabs.apiKey"))?;
            Some(Arc::new(ElevenLabsTtsEngine::new(
                app.fetch(),
                Some(key),
                None,
                Some(default_voice.unwrap_or_else(|| "wNl2YBRc8v5uIcq6gOxd".to_string())),
            )))
        }
        "piper" => Some(Arc::new(PiperTtsEngine::new(app.env(), default_voice.as_deref()))),
        "edge-tts" => Some(Arc::new(EdgeTtsEngine::new(default_voice.as_deref()))),
        "phonon" => {
            let bare = settings.and_then(|s| s.get("voice.phonon.barePeso"));
            let bare_peso =
                matches!(bare, Some(Value::Bool(true))) || bare.as_ref().and_then(Value::as_str) == Some("true");
            let voice = setting_text(settings, "voice.phonon.voice");
            Some(Arc::new(PhononTtsEngine::new(
                app,
                voice.as_deref(),
                PhononOptions { bare_peso },
            )))
        }
        _ => None,
    }
}

/// The line logged when an engine starts speaking.
fn active_log(name: &str, engine: &Arc<dyn TtsEngine>, default_voice: Option<&str>) -> String {
    match name {
        "elevenlabs" => format!("ElevenLabs TTS active (voice: {})", default_voice.unwrap_or("default")),
        "piper" => "Piper TTS active (local, ultra-fast)".into(),
        "edge-tts" => "Edge TTS active (Microsoft, free)".into(),
        "phonon" => format!(
            "Phonon TTS active (local 31M model by Gradium, voice: {}; Edge TTS is its fallback)",
            engine
                .default_voice()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "default".into())
        ),
        other => format!("{other} TTS active"),
    }
}

/// Try to initialize a specific engine. Returns the engine if available, `None` otherwise. Phonon comes back wrapped,
/// with Edge TTS behind it for any sentence it fails.
fn try_engine(
    app: App,
    name: String,
    settings: Option<Arc<dyn Settings>>,
    default_voice: Option<String>,
    loaders: Arc<HashMap<String, EngineLoader>>,
    quiet: bool,
) -> BoxFuture<'static, Option<Arc<dyn TtsEngine>>> {
    async move {
        let built = match loaders.get(&name) {
            Some(make) => make(settings.clone(), default_voice.clone()).await,
            None => Ok(builtin_engine(&app, &name, settings.as_deref(), default_voice.clone())),
        };
        let engine = match built {
            Ok(Some(engine)) => engine,
            Ok(None) => return None,
            Err(err) => {
                log::warn!("[voice] Engine \"{name}\" failed: {err}");
                return None;
            }
        };
        if !engine.is_available().await {
            return None;
        }
        if !quiet {
            log::info!("[voice] {}", active_log(&name, &engine, default_voice.as_deref()));
        }
        let Some(fallback_name) = preferred_fallback(&name) else {
            return Some(engine);
        };
        let weak = app.downgrade();
        let make_fallback: FallbackMaker = Arc::new(move || {
            let (weak, settings, loaders, name) = (weak.clone(), settings.clone(), loaders.clone(), name.clone());
            async move {
                let app = weak.upgrade()?;
                let voice = fallback_voice_for(
                    fallback_name,
                    setting_text(settings.as_deref(), "voice.defaultVoiceId").as_deref(),
                );
                let fb = try_engine(app, fallback_name.to_string(), settings, voice, loaders, true).await;
                if fb.is_some() {
                    log::info!("[voice] {fallback_name} ready as {name}'s fallback");
                }
                fb
            }
            .boxed()
        });
        Some(Arc::new(FallbackTtsEngine::new(engine, make_fallback, fallback_name)) as Arc<dyn TtsEngine>)
    }
    .boxed()
}

/// The spare engine being built, shared by every sentence that waits for it.
type SpareBuild = SharedTask<Option<Arc<dyn TtsEngine>>>;

/// Builds the spare engine when it is first needed: `None` when it cannot start.
pub type FallbackMaker = Arc<dyn Fn() -> BoxFuture<'static, Option<Arc<dyn TtsEngine>>> + Send + Sync>;

/// An engine with a spare: a sentence the primary fails is spoken by the fallback (built on first need). After
/// [`FAILS_TO_TRIP`](FallbackTtsEngine::FAILS_TO_TRIP) failures in a row the primary is skipped for
/// [`TRIP`](FallbackTtsEngine::TRIP), so a broken install does not add a delay to every sentence; it is tried again
/// after that.
///
/// The fallback gets the request's voice id only when it is one of its own voices: a Phonon voice such as "toby" means
/// nothing to Edge TTS.
///
/// Each sentence runs to its end in a task of its own, as the JS promise did, so a caller that goes away still leaves
/// the failure count and the spare as they would have been.
pub struct FallbackTtsEngine {
    inner: Arc<FallbackInner>,
}

struct FallbackInner {
    primary: Arc<dyn TtsEngine>,
    make_fallback: FallbackMaker,
    fallback_name: String,
    fallback: Mutex<Option<SpareBuild>>,
    fails: Mutex<u32>,
    /// Measured on tokio's clock, so a test can let the pause pass.
    skip_until: Mutex<Option<tokio::time::Instant>>,
}

impl FallbackTtsEngine {
    pub const FAILS_TO_TRIP: u32 = 3;
    pub const TRIP: Duration = Duration::from_secs(5 * 60);

    pub fn new(primary: Arc<dyn TtsEngine>, make_fallback: FallbackMaker, fallback_name: &str) -> Self {
        FallbackTtsEngine {
            inner: Arc::new(FallbackInner {
                primary,
                make_fallback,
                fallback_name: fallback_name.to_string(),
                fallback: Mutex::new(None),
                fails: Mutex::new(0),
                skip_until: Mutex::new(None),
            }),
        }
    }

    /// The engine behind the spare.
    pub fn primary(&self) -> &Arc<dyn TtsEngine> {
        &self.inner.primary
    }
}

impl FallbackInner {
    async fn get_fallback(&self) -> Option<Arc<dyn TtsEngine>> {
        // Built in a task of its own (the JS promise): it finishes even when the sentence that asked for it is gone.
        let building = self
            .fallback
            .lock()
            .get_or_insert_with(|| spawn_shared((self.make_fallback)(), None))
            .clone();
        let fb = building.await;
        if fb.is_none() {
            // Try building it again next time.
            *self.fallback.lock() = None;
        }
        fb
    }

    async fn fallback_synth(
        &self,
        fb: &Arc<dyn TtsEngine>,
        text: &str,
        voice_id: Option<&str>,
    ) -> Result<Synthesized, TtsError> {
        let voice = fallback_voice_for(&self.fallback_name, voice_id);
        fb.synthesize(text, voice.as_deref(), &SynthOptions::default()).await
    }

    async fn synthesize(
        &self,
        text: &str,
        voice_id: Option<&str>,
        opts: &SynthOptions,
    ) -> Result<Synthesized, TtsError> {
        let skipping = self
            .skip_until
            .lock()
            .is_some_and(|until| tokio::time::Instant::now() < until);
        if !skipping {
            match self.primary.synthesize(text, voice_id, opts).await {
                Ok(out) => {
                    *self.fails.lock() = 0;
                    return Ok(out);
                }
                Err(err) => {
                    // Nothing to say: no engine would do better.
                    if err.has_code("EMPTY_TEXT") {
                        return Err(err);
                    }
                    let tripped = {
                        let mut fails = self.fails.lock();
                        *fails += 1;
                        let tripped = *fails >= FallbackTtsEngine::FAILS_TO_TRIP;
                        if tripped {
                            *fails = 0;
                        }
                        tripped
                    };
                    if tripped {
                        *self.skip_until.lock() = Some(tokio::time::Instant::now() + FallbackTtsEngine::TRIP);
                        log::warn!(
                            "[voice] {} failed {} times in a row, using {} for {} min",
                            self.primary.name(),
                            FallbackTtsEngine::FAILS_TO_TRIP,
                            self.fallback_name,
                            FallbackTtsEngine::TRIP.as_secs() / 60
                        );
                    }
                    log::warn!(
                        "[voice] {} synth failed ({}), speaking with {}",
                        self.primary.name(),
                        err.message,
                        self.fallback_name
                    );
                    let Some(fb) = self.get_fallback().await else {
                        return Err(err);
                    };
                    return self.fallback_synth(&fb, text, voice_id).await;
                }
            }
        }
        match self.get_fallback().await {
            None => self.primary.synthesize(text, voice_id, opts).await,
            Some(fb) => self.fallback_synth(&fb, text, voice_id).await,
        }
    }
}

#[async_trait]
impl TtsEngine for FallbackTtsEngine {
    fn name(&self) -> &str {
        self.inner.primary.name()
    }

    fn default_voice(&self) -> Option<String> {
        self.inner.primary.default_voice()
    }

    async fn synthesize(
        &self,
        text: &str,
        voice_id: Option<&str>,
        opts: &SynthOptions,
    ) -> Result<Synthesized, TtsError> {
        let inner = self.inner.clone();
        let (text, voice_id, opts) = (text.to_string(), voice_id.map(str::to_string), opts.clone());
        tokio::spawn(async move { inner.synthesize(&text, voice_id.as_deref(), &opts).await })
            .await
            .unwrap_or_else(|err| Err(TtsError::new(format!("the voice stopped ({err})"))))
    }

    async fn is_available(&self) -> bool {
        self.inner.primary.is_available().await
    }

    async fn list_voices(&self) -> Result<Vec<VoiceInfo>, TtsError> {
        self.inner.primary.list_voices().await
    }

    async fn clone_voice(&self, audio_sample: &[u8], name: &str) -> Result<ClonedVoice, TtsError> {
        self.inner.primary.clone_voice(audio_sample, name).await
    }

    fn can_stream(&self) -> bool {
        false
    }

    async fn synthesize_stream(&self, _text: &str, _voice_id: Option<&str>) -> Result<AudioStream, TtsError> {
        Err(TtsError::new("Not implemented"))
    }

    fn set_speed(&self, speed: f64) {
        self.inner.primary.set_speed(speed);
    }

    async fn warm(&self) -> Result<(), TtsError> {
        self.inner.primary.warm().await
    }

    fn stop(&self) {
        self.inner.primary.stop();
    }
}

pub fn stop_tts_engine(app: &App) {
    get_tts_engine(app).stop();
}

/// Whether the engine has a worker to start ahead of the first reply (the JS `typeof engine.warm === "function"`):
/// Phonon, alone or behind its Edge TTS spare.
pub fn can_warm(engine: &Arc<dyn TtsEngine>) -> bool {
    engine.name() == "phonon"
}

#[cfg(test)]
mod tests;
