//! test/tts-phonon.test.js: "TTS engine choice: Phonon is the default" and "TTS fallback: Edge TTS speaks when Phonon
//! fails", with fake engines; and the pieces those cases went through without naming.

use std::sync::atomic::{AtomicU32, Ordering};

use bytes::Bytes;
use serde_json::json;

use super::*;
use crate::testkit::{MemorySettings, TestApp, test_app};

/// A fake engine that records what happens to it.
struct FakeTts {
    name: String,
    available: bool,
    fail: Mutex<Option<TtsError>>,
    calls: Mutex<Vec<(String, Option<String>)>>,
    speeds: Mutex<Vec<f64>>,
    stopped: AtomicU32,
    /// The voice its loader was given: `None` until it is built.
    built_with_voice: Mutex<Option<Option<String>>>,
}

impl FakeTts {
    fn new(name: &str) -> Arc<FakeTts> {
        Self::with(name, true, None)
    }

    fn unavailable(name: &str) -> Arc<FakeTts> {
        Self::with(name, false, None)
    }

    fn failing(name: &str, err: TtsError) -> Arc<FakeTts> {
        Self::with(name, true, Some(err))
    }

    fn with(name: &str, available: bool, fail: Option<TtsError>) -> Arc<FakeTts> {
        Arc::new(FakeTts {
            name: name.to_string(),
            available,
            fail: Mutex::new(fail),
            calls: Mutex::new(Vec::new()),
            speeds: Mutex::new(Vec::new()),
            stopped: AtomicU32::new(0),
            built_with_voice: Mutex::new(None),
        })
    }

    fn calls(&self) -> Vec<(String, Option<String>)> {
        self.calls.lock().clone()
    }

    fn built_with(&self) -> Option<String> {
        self.built_with_voice
            .lock()
            .clone()
            .expect("the engine was never built")
    }
}

#[async_trait]
impl TtsEngine for FakeTts {
    fn name(&self) -> &str {
        &self.name
    }

    async fn is_available(&self) -> bool {
        self.available
    }

    fn set_speed(&self, speed: f64) {
        self.speeds.lock().push(speed);
    }

    async fn synthesize(
        &self,
        text: &str,
        voice_id: Option<&str>,
        _opts: &SynthOptions,
    ) -> Result<Synthesized, TtsError> {
        self.calls.lock().push((text.to_string(), voice_id.map(str::to_string)));
        if let Some(err) = self.fail.lock().clone() {
            return Err(err);
        }
        Ok(Synthesized {
            audio: Bytes::from(format!("{}:{text}", self.name)),
            content_type: "audio/wav".into(),
        })
    }

    fn stop(&self) {
        self.stopped.fetch_add(1, Ordering::SeqCst);
    }
}

fn store(values: &[(&str, Value)]) -> Arc<dyn Settings> {
    Arc::new(MemorySettings::from_pairs(
        values.iter().map(|(k, v)| (k.to_string(), v.clone())),
    ))
}

/// Loaders for every engine, recording which were consulted and with which voice.
fn loaders(map: &[(&str, &Arc<FakeTts>)]) -> (InitOptions, Arc<Mutex<Vec<String>>>) {
    let used = Arc::new(Mutex::new(Vec::new()));
    let mut out = HashMap::new();
    for name in ["piper", "elevenlabs", "edge-tts", "phonon"] {
        let engine = map.iter().find(|(n, _)| *n == name).map(|(_, e)| (*e).clone());
        let used = used.clone();
        let loader: EngineLoader = Arc::new(move |_settings, voice| {
            used.lock().push(name.to_string());
            let engine = engine.clone();
            async move {
                let Some(engine) = engine else { return Ok(None) };
                *engine.built_with_voice.lock() = Some(voice);
                Ok(Some(engine as Arc<dyn TtsEngine>))
            }
            .boxed()
        });
        out.insert(name.to_string(), loader);
    }
    (InitOptions { loaders: out }, used)
}

fn used(list: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    list.lock().clone()
}

/// The engine in use is this very fake (not wrapped).
fn is(t: &TestApp, engine: &Arc<FakeTts>) -> bool {
    std::ptr::addr_eq(Arc::as_ptr(&get_tts_engine(t)), Arc::as_ptr(engine))
}

// ── TTS engine choice: Phonon is the default ─────────────────────────────

#[tokio::test]
async fn with_voice_engine_unset_phonon_is_used_with_edge_tts_behind_it() {
    let t = test_app();
    let phonon = FakeTts::new("phonon");
    let (edge, el) = (FakeTts::new("edge-tts"), FakeTts::new("elevenlabs"));
    let (opts, l) = loaders(&[("phonon", &phonon), ("edge-tts", &edge), ("elevenlabs", &el)]);
    init_tts_engine(&t, Some(store(&[])), opts).await;
    assert_eq!(engine_preference(Some(&*store(&[]))), "phonon");
    assert_eq!(get_tts_engine(&t).name(), "phonon");
    assert!(!is(&t, &phonon), "wrapped: a FallbackTtsEngine");
    assert_eq!(used(&l), ["phonon"], "Edge TTS is only built when it is needed");
}

#[tokio::test]
async fn phonon_is_the_default_for_everything_a_saved_elevenlabs_key_alone_doesn_t_make_the_paid_engine_speak() {
    let t = test_app();
    let with_key = store(&[("voice.elevenlabs.apiKey", json!("sk_test"))]);
    assert_eq!(engine_preference(Some(&*with_key)), "phonon", "a key is not a choice");
    t.env().set("ELEVENLABS_API_KEY", "sk_env");
    assert_eq!(
        get_api_key(&*store(&[]), t.env(), "elevenlabs").as_deref(),
        Some("sk_env")
    );
    assert_eq!(
        engine_preference(Some(&*store(&[]))),
        "phonon",
        "nor is one in the environment"
    );
    let elevenlabs = FakeTts::new("elevenlabs");
    let (phonon, edge) = (FakeTts::new("phonon"), FakeTts::new("edge-tts"));
    let (opts, l) = loaders(&[("phonon", &phonon), ("edge-tts", &edge), ("elevenlabs", &elevenlabs)]);
    init_tts_engine(&t, Some(with_key), opts).await;
    assert_eq!(get_tts_engine(&t).name(), "phonon");
    assert!(
        !used(&l).contains(&"elevenlabs".to_string()),
        "ElevenLabs isn't even built"
    );
    // Picking it in Settings > Voice is what makes it speak.
    let picked = store(&[
        ("voice.elevenlabs.apiKey", json!("sk_test")),
        ("voice.engine", json!("elevenlabs")),
    ]);
    assert_eq!(engine_preference(Some(&*picked)), "elevenlabs");
}

#[tokio::test]
async fn phonon_not_installed_yet_edge_tts_speaks_with_its_own_default_voice() {
    let t = test_app();
    let edge = FakeTts::new("edge-tts");
    let (phonon, el, piper) = (
        FakeTts::unavailable("phonon"),
        FakeTts::new("elevenlabs"),
        FakeTts::new("piper"),
    );
    let (opts, l) = loaders(&[
        ("phonon", &phonon),
        ("edge-tts", &edge),
        ("elevenlabs", &el),
        ("piper", &piper),
    ]);
    init_tts_engine(&t, Some(store(&[("voice.defaultVoiceId", json!("toby"))])), opts).await;
    assert!(is(&t, &edge));
    assert_eq!(used(&l), ["phonon", "edge-tts"]);
    assert_eq!(edge.built_with(), None, "a non-Edge voice id is not handed to Edge TTS");
}

#[tokio::test]
async fn phonon_not_installed_yet_edge_tts_keeps_an_edge_voice_the_user_picked() {
    let t = test_app();
    let edge = FakeTts::new("edge-tts");
    let (opts, _) = loaders(&[("edge-tts", &edge)]);
    init_tts_engine(
        &t,
        Some(store(&[("voice.defaultVoiceId", json!("en-GB-SoniaNeural"))])),
        opts,
    )
    .await;
    assert_eq!(edge.built_with().as_deref(), Some("en-GB-SoniaNeural"));
}

#[tokio::test]
async fn never_falls_back_to_elevenlabs_it_costs_money_even_with_phonon_and_edge_both_gone() {
    let t = test_app();
    let el = FakeTts::new("elevenlabs");
    let (opts, l) = loaders(&[("elevenlabs", &el)]);
    init_tts_engine(&t, Some(store(&[])), opts).await;
    assert_eq!(get_tts_engine(&t).name(), "stub");
    assert!(
        !used(&l).contains(&"elevenlabs".to_string()),
        "consulted: {:?}",
        used(&l)
    );
}

#[tokio::test]
async fn a_picked_engine_that_can_t_start_never_falls_through_to_elevenlabs_even_with_its_key_saved() {
    let t = test_app();
    for pick in ["piper", "edge-tts"] {
        let picked = FakeTts::unavailable(pick);
        let el = FakeTts::new("elevenlabs");
        let edge = FakeTts::with("edge-tts", pick != "edge-tts", None);
        let mut map = vec![(pick, &picked), ("elevenlabs", &el)];
        if pick != "edge-tts" {
            map.push(("edge-tts", &edge));
        } else {
            map[0] = ("edge-tts", &edge);
        }
        let (opts, l) = loaders(&map);
        let settings = store(&[
            ("voice.engine", json!(pick)),
            ("voice.elevenlabs.apiKey", json!("sk_test")),
        ]);
        init_tts_engine(&t, Some(settings), opts).await;
        assert_ne!(get_tts_engine(&t).name(), "elevenlabs", "{pick} picked");
        assert!(
            !used(&l).contains(&"elevenlabs".to_string()),
            "{pick}: consulted {:?}",
            used(&l)
        );
    }
}

#[tokio::test]
async fn an_explicit_engine_choice_is_respected_phonon_is_never_built() {
    let t = test_app();
    for pick in ["edge-tts", "elevenlabs", "piper"] {
        let picked = FakeTts::new(pick);
        let phonon = FakeTts::new("phonon");
        let (opts, l) = loaders(&[(pick, &picked), ("phonon", &phonon)]);
        let settings = store(&[("voice.engine", json!(pick)), ("voice.defaultVoiceId", json!("v1"))]);
        init_tts_engine(&t, Some(settings), opts).await;
        assert!(is(&t, &picked), "{pick}");
        assert_eq!(used(&l), [pick]);
        assert_eq!(picked.built_with().as_deref(), Some("v1"));
    }
}

#[tokio::test]
async fn auto_phonon_first_when_installed_then_the_old_order() {
    let t = test_app();
    let (phonon, piper) = (FakeTts::new("phonon"), FakeTts::new("piper"));
    let (opts, _) = loaders(&[("phonon", &phonon), ("piper", &piper)]);
    init_tts_engine(&t, Some(store(&[("voice.engine", json!("auto"))])), opts).await;
    assert_eq!(get_tts_engine(&t).name(), "phonon");

    let el = FakeTts::new("elevenlabs");
    let (phonon, edge) = (FakeTts::unavailable("phonon"), FakeTts::new("edge-tts"));
    let (opts, l) = loaders(&[("phonon", &phonon), ("elevenlabs", &el), ("edge-tts", &edge)]);
    init_tts_engine(&t, Some(store(&[("voice.engine", json!("auto"))])), opts).await;
    assert!(is(&t, &el));
    assert_eq!(used(&l), ["phonon", "piper", "elevenlabs"]);
}

#[tokio::test]
async fn phonon_gets_its_own_speed_setting() {
    let t = test_app();
    let phonon = FakeTts::new("phonon");
    let (opts, _) = loaders(&[("phonon", &phonon)]);
    init_tts_engine(&t, Some(store(&[("voice.phonon.speed", json!("1.1"))])), opts).await;
    assert_eq!(*phonon.speeds.lock(), [1.1]);
}

#[tokio::test]
async fn switching_from_phonon_to_another_engine_lets_the_phonon_worker_go() {
    let t = test_app();
    let phonon = FakeTts::new("phonon");
    let edge = FakeTts::new("edge-tts");
    let s = Arc::new(MemorySettings::new());
    let both = || loaders(&[("phonon", &phonon), ("edge-tts", &edge)]).0;
    init_tts_engine(&t, Some(s.clone()), both()).await;
    init_tts_engine(&t, Some(s.clone()), both()).await; // Phonon to Phonon: kept
    assert_eq!(phonon.stopped.load(Ordering::SeqCst), 0);
    s.set("voice.engine", json!("edge-tts")).unwrap();
    init_tts_engine(&t, Some(s.clone()), both()).await;
    assert!(is(&t, &edge));
    assert_eq!(phonon.stopped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn the_newest_init_wins_when_several_overlap_a_burst_of_settings_saves() {
    let t = test_app();
    let (release_slow, slow) = tokio::sync::oneshot::channel::<()>();
    let slow = Arc::new(Mutex::new(Some(slow)));
    let old = FakeTts::new("piper");
    let newer = FakeTts::new("edge-tts");
    let old_engine = old.clone();
    let slow_piper: EngineLoader = Arc::new(move |_s, _v| {
        let (slow, old) = (slow.lock().take(), old_engine.clone());
        async move {
            if let Some(slow) = slow {
                let _ = slow.await;
            }
            Ok(Some(old as Arc<dyn TtsEngine>))
        }
        .boxed()
    });
    let first_opts = InitOptions {
        loaders: HashMap::from([("piper".to_string(), slow_piper)]),
    };
    let mut first = Box::pin(init_tts_engine(
        &t,
        Some(store(&[("voice.engine", json!("piper"))])),
        first_opts,
    ));
    // It starts (and takes its turn number) before the second, as the JS call did, then waits on the slow loader.
    assert!(futures::poll!(&mut first).is_pending());
    let (opts, _) = loaders(&[("edge-tts", &newer)]);
    init_tts_engine(&t, Some(store(&[("voice.engine", json!("edge-tts"))])), opts).await;
    release_slow.send(()).unwrap();
    first.await;
    assert!(is(&t, &newer));
}

// ── TTS fallback: Edge TTS speaks when Phonon fails ──────────────────────

fn toby() -> Arc<dyn Settings> {
    store(&[("voice.phonon.voice", json!("toby"))])
}

fn text(out: &Synthesized) -> String {
    String::from_utf8_lossy(&out.audio).into_owned()
}

#[tokio::test]
async fn a_failed_phonon_sentence_is_spoken_by_edge_tts_without_phonon_s_voice_id() {
    let t = test_app();
    let phonon = FakeTts::failing("phonon", TtsError::new("worker died"));
    let edge = FakeTts::new("edge-tts");
    let (opts, _) = loaders(&[("phonon", &phonon), ("edge-tts", &edge)]);
    init_tts_engine(&t, Some(toby()), opts).await;
    let out = get_tts_engine(&t)
        .synthesize("Hello there.", Some("toby"), &SynthOptions::default())
        .await
        .unwrap();
    assert_eq!(text(&out), "edge-tts:Hello there.");
    assert_eq!(edge.calls()[0].1, None, "Edge would fail on the voice \"toby\"");
    assert_eq!(
        get_tts_engine(&t).name(),
        "phonon",
        "still Phonon: it is tried again next time"
    );
}

#[tokio::test]
async fn an_edge_voice_id_is_passed_through_to_edge_tts() {
    let t = test_app();
    let edge = FakeTts::new("edge-tts");
    let phonon = FakeTts::failing("phonon", TtsError::new("x"));
    let (opts, _) = loaders(&[("phonon", &phonon), ("edge-tts", &edge)]);
    init_tts_engine(&t, Some(toby()), opts).await;
    get_tts_engine(&t)
        .synthesize("Hi", Some("en-US-AvaMultilingualNeural"), &SynthOptions::default())
        .await
        .unwrap();
    assert_eq!(edge.calls()[0].1.as_deref(), Some("en-US-AvaMultilingualNeural"));
}

#[tokio::test]
async fn the_fallback_is_built_with_the_user_s_edge_voice_only_when_it_is_one() {
    let t = test_app();
    for (saved, want) in [
        ("en-PH-RosaNeural", Some("en-PH-RosaNeural")),
        ("toby", None),
        ("wNl2YBRc8v5uIcq6gOxd", None),
    ] {
        let edge = FakeTts::new("edge-tts");
        let phonon = FakeTts::failing("phonon", TtsError::new("x"));
        let (opts, _) = loaders(&[("phonon", &phonon), ("edge-tts", &edge)]);
        init_tts_engine(&t, Some(store(&[("voice.defaultVoiceId", json!(saved))])), opts).await;
        get_tts_engine(&t)
            .synthesize("Hi", None, &SynthOptions::default())
            .await
            .unwrap();
        assert_eq!(edge.built_with().as_deref(), want, "voice.defaultVoiceId={saved}");
    }
}

#[tokio::test(start_paused = true)]
async fn after_three_failures_in_a_row_phonon_is_skipped_for_a_while_then_tried_again() {
    let t = test_app();
    let phonon = FakeTts::failing("phonon", TtsError::new("stuck"));
    let edge = FakeTts::new("edge-tts");
    let (opts, _) = loaders(&[("phonon", &phonon), ("edge-tts", &edge)]);
    init_tts_engine(&t, Some(toby()), opts).await;
    let tts = get_tts_engine(&t);
    for i in 0..5 {
        tts.synthesize(&format!("line {i}"), None, &SynthOptions::default())
            .await
            .unwrap();
    }
    assert_eq!(phonon.calls().len(), 3);
    assert_eq!(edge.calls().len(), 5);
    // The pause is over.
    tokio::time::advance(FallbackTtsEngine::TRIP + Duration::from_millis(1)).await;
    *phonon.fail.lock() = None;
    let back = tts.synthesize("back", None, &SynthOptions::default()).await.unwrap();
    assert_eq!(text(&back), "phonon:back");
}

#[tokio::test]
async fn nothing_to_say_is_not_a_failure_no_fallback() {
    let t = test_app();
    let phonon = FakeTts::failing(
        "phonon",
        TtsError::new("No speakable text after cleanup").code("EMPTY_TEXT"),
    );
    let edge = FakeTts::new("edge-tts");
    let (opts, _) = loaders(&[("phonon", &phonon), ("edge-tts", &edge)]);
    init_tts_engine(&t, Some(toby()), opts).await;
    let err = get_tts_engine(&t)
        .synthesize("```code```", None, &SynthOptions::default())
        .await
        .unwrap_err();
    assert!(err.message.contains("No speakable text"));
    assert_eq!(edge.calls().len(), 0);
}

#[tokio::test]
async fn with_edge_tts_missing_too_the_phonon_error_comes_through() {
    let t = test_app();
    let phonon = FakeTts::failing("phonon", TtsError::new("worker died"));
    let (opts, _) = loaders(&[("phonon", &phonon)]);
    init_tts_engine(&t, Some(toby()), opts).await;
    let err = get_tts_engine(&t)
        .synthesize("Hello", None, &SynthOptions::default())
        .await
        .unwrap_err();
    assert!(err.message.contains("worker died"));
}

#[test]
fn fallback_voice_for_only_keeps_edge_voice_ids() {
    assert_eq!(
        fallback_voice_for("edge-tts", Some("en-US-AndrewMultilingualNeural")).as_deref(),
        Some("en-US-AndrewMultilingualNeural")
    );
    assert_eq!(
        fallback_voice_for("edge-tts", Some("fil-PH-AngeloNeural")).as_deref(),
        Some("fil-PH-AngeloNeural")
    );
    assert_eq!(fallback_voice_for("edge-tts", Some("toby")), None);
    assert_eq!(fallback_voice_for("edge-tts", Some("phonon:toby")), None);
    assert_eq!(fallback_voice_for("edge-tts", None), None);
}

// ── Added ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn without_loaders_the_real_engines_are_built_from_the_settings() {
    let t = test_app();
    // Edge TTS is always there.
    init_tts_engine(
        &t,
        Some(store(&[("voice.engine", json!("edge-tts"))])),
        InitOptions::default(),
    )
    .await;
    assert_eq!(get_tts_engine(&t).name(), "edge-tts");
    // ElevenLabs with no key can't start: the free ones of the auto order speak (Phonon isn't installed, Piper isn't
    // on this PATH).
    init_tts_engine(
        &t,
        Some(store(&[("voice.engine", json!("elevenlabs"))])),
        InitOptions::default(),
    )
    .await;
    assert_eq!(get_tts_engine(&t).name(), "edge-tts");
    // With the key saved (and ElevenLabs taking it) it speaks.
    t.fetch.respond(
        "https://api.elevenlabs.io/v1/user",
        crate::testkit::Answer::json(200, json!({})),
    );
    let settings = store(&[
        ("voice.engine", json!("elevenlabs")),
        ("ai.elevenlabs.apiKey", json!(" 'k-test' ")),
    ]);
    init_tts_engine(&t, Some(settings), InitOptions::default()).await;
    assert_eq!(get_tts_engine(&t).name(), "elevenlabs");
    let asked = t.fetch.calls_to("https://api.elevenlabs.io/v1/user");
    assert_eq!(asked[0].header("xi-api-key"), Some("k-test"), "the key, cleaned");
    // Phonon, not installed: Edge TTS speaks instead.
    init_tts_engine(&t, Some(store(&[])), InitOptions::default()).await;
    assert_eq!(get_tts_engine(&t).name(), "edge-tts");
}

#[tokio::test]
async fn elevenlabs_takes_its_key_from_the_settings_store_and_never_without_one() {
    let t = test_app();
    t.env().set("ELEVENLABS_API_KEY", " \"k-env\" ");
    t.fetch.respond(
        "https://api.elevenlabs.io/v1/user",
        crate::testkit::Answer::json(200, json!({})),
    );
    let pick = || store(&[("voice.engine", json!("elevenlabs"))]);
    // With a store, the environment's key counts (`getApiKey`), cleaned of its quotes.
    init_tts_engine(&t, Some(pick()), InitOptions::default()).await;
    assert_eq!(get_tts_engine(&t).name(), "elevenlabs");
    let asked = t.fetch.calls_to("https://api.elevenlabs.io/v1/user");
    assert_eq!(asked[0].header("xi-api-key"), Some("k-env"));
    // With no store there is no key at all (`settingsStore?.getApiKey?.()`): ElevenLabs is not built.
    assert!(builtin_engine(&t, "elevenlabs", None, None).is_none());
    assert!(builtin_engine(&t, "elevenlabs", Some(&*pick()), None).is_some());
}

#[tokio::test]
async fn the_registry_starts_with_the_stub_and_stops_the_engine_in_use() {
    let t = test_app();
    assert_eq!(get_tts_engine(&t).name(), "stub");
    let phonon = FakeTts::new("phonon");
    set_tts_engine(&t, phonon.clone());
    assert!(is(&t, &phonon));
    assert!(can_warm(&get_tts_engine(&t)));
    stop_tts_engine(&t);
    assert_eq!(phonon.stopped.load(Ordering::SeqCst), 1);
    set_tts_engine(&t, FakeTts::new("edge-tts"));
    assert!(!can_warm(&get_tts_engine(&t)));
}

#[test]
fn the_preference_is_trimmed_and_only_text_counts() {
    assert_eq!(engine_preference(None), "phonon");
    assert_eq!(
        engine_preference(Some(&*store(&[("voice.engine", json!("  piper "))]))),
        "piper"
    );
    assert_eq!(
        engine_preference(Some(&*store(&[("voice.engine", json!("   "))]))),
        "phonon"
    );
    assert_eq!(
        engine_preference(Some(&*store(&[("voice.engine", json!(3))]))),
        "phonon"
    );
}
