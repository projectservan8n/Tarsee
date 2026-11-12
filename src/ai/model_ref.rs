//! Port of `src/ai/model-ref.js`: a model on a provider, written as one string.
//!
//! ```text
//!   "deepseek:deepseek-flash"                 DeepSeek's Flash
//!   "openrouter:deepseek/deepseek-chat:free"  a free model on OpenRouter
//!   "local:llama3.1:8b"                       a model on the owner's Local AI
//!   "sonnet"                                  a bare model (the provider comes from elsewhere)
//! ```
//!
//! OpenRouter and Ollama ids carry colons of their own, so a ref splits on the FIRST colon only, and only when what
//! is in front of it is a provider id or alias the registry knows ("claude-code" is the Claude plan). Anything else
//! is a bare model, colons and all: "deepseek/x:free" and "llama3.1:8b" have no provider.
//!
//! Used for the backup model (`ai.backupModel`), /model and the external API.

use serde::Serialize;

use super::provider_registry::normalize_provider_id;

/// A ref taken apart: `{ provider, model }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelRef {
    /// The provider's public id, or `None` for a bare model.
    pub provider: Option<&'static str>,
    /// `None` when a ref names only a provider ("openrouter:" means that provider's default).
    pub model: Option<String>,
}

impl ModelRef {
    /// The ref as one string, as [`parse_model_ref`] reads it back (`formatModelRef({ provider, model })`).
    pub fn format(&self) -> anyhow::Result<String> {
        format_model_ref(self.provider, self.model.as_deref())
    }
}

/// "provider:model" as `{ provider, model }`. provider is the public id, or `None` for a bare model; model is
/// `None` when a ref names only a provider ("openrouter:" means that provider's default).
pub fn parse_model_ref(text: &str) -> ModelRef {
    let s = text.trim();
    if s.is_empty() {
        return ModelRef {
            provider: None,
            model: None,
        };
    }
    if let Some((before, after)) = s.split_once(':')
        && !before.is_empty()
        && let Some(provider) = normalize_provider_id(before)
    {
        let model = after.trim();
        return ModelRef {
            provider: Some(provider),
            model: (!model.is_empty()).then(|| model.to_string()),
        };
    }
    ModelRef {
        provider: None,
        model: Some(s.to_string()),
    }
}

/// The ref for a provider and model, as [`parse_model_ref`] reads it back:
/// `format_model_ref(Some("openrouter"), Some("deepseek/x:free"))`. No provider gives the bare model; no model
/// gives "provider:". A provider the registry does not know is an error, and so is a bare model that would read
/// back as a provider's ("deepseek:7b", a Local AI model's name, would mean DeepSeek's API): name its provider
/// instead.
pub fn format_model_ref(provider: Option<&str>, model: Option<&str>) -> anyhow::Result<String> {
    let m = model.unwrap_or("").trim();
    let Some(provider) = provider.filter(|p| !p.is_empty()) else {
        if let Some(reads_as) = parse_model_ref(m).provider {
            anyhow::bail!("\"{m}\" would read back as a {reads_as} model: name its provider");
        }
        return Ok(m.to_string());
    };
    let Some(id) = normalize_provider_id(provider) else {
        anyhow::bail!("Unknown provider: {provider}");
    };
    Ok(format!("{id}:{m}"))
}

#[cfg(test)]
mod tests {
    //! Port of `test/model-ref.test.js`.
    //!
    //! A model ref names a model on a provider: "deepseek:deepseek-flash",
    //! "openrouter:deepseek/deepseek-chat:free", or a bare "sonnet". OpenRouter and Ollama ids carry colons of their
    //! own, so a ref splits on the FIRST colon only, and only when what is in front of it is a provider Tarsee knows.
    use super::*;

    const PROVIDERS: [&str; 7] = [
        "claude",
        "anthropic",
        "chatgpt",
        "openai",
        "openrouter",
        "deepseek",
        "local",
    ];

    fn parsed(provider: Option<&'static str>, model: Option<&str>) -> ModelRef {
        ModelRef {
            provider,
            model: model.map(String::from),
        }
    }

    // --- parseModelRef ---

    #[test]
    fn keeps_the_colons_inside_an_openrouter_id() {
        assert_eq!(
            parse_model_ref("openrouter:deepseek/x:free"),
            parsed(Some("openrouter"), Some("deepseek/x:free"))
        );
        assert_eq!(
            parse_model_ref("openrouter:deepseek/deepseek-chat-v3.1:free"),
            parsed(Some("openrouter"), Some("deepseek/deepseek-chat-v3.1:free"))
        );
    }

    #[test]
    fn treats_a_model_with_no_provider_in_front_as_bare() {
        assert_eq!(
            parse_model_ref("deepseek/x:free"),
            parsed(None, Some("deepseek/x:free"))
        );
        assert_eq!(parse_model_ref("sonnet"), parsed(None, Some("sonnet")));
        assert_eq!(
            parse_model_ref("~anthropic/claude-sonnet-latest"),
            parsed(None, Some("~anthropic/claude-sonnet-latest"))
        );
    }

    #[test]
    fn treats_an_unknown_prefix_as_part_of_a_bare_model() {
        assert_eq!(parse_model_ref("llama3.1:8b"), parsed(None, Some("llama3.1:8b")));
        assert_eq!(parse_model_ref("gemini:pro"), parsed(None, Some("gemini:pro")));
        assert_eq!(parse_model_ref("deepseek-r1:7b"), parsed(None, Some("deepseek-r1:7b")));
        assert_eq!(parse_model_ref(":sonnet"), parsed(None, Some(":sonnet")));
    }

    #[test]
    fn splits_on_a_known_provider_id() {
        assert_eq!(
            parse_model_ref("deepseek:deepseek-flash"),
            parsed(Some("deepseek"), Some("deepseek-flash"))
        );
        assert_eq!(
            parse_model_ref("local:llama3.1:8b"),
            parsed(Some("local"), Some("llama3.1:8b"))
        );
        assert_eq!(
            parse_model_ref("chatgpt:gpt-6-luna"),
            parsed(Some("chatgpt"), Some("gpt-6-luna"))
        );
        for id in PROVIDERS {
            assert_eq!(parse_model_ref(&format!("{id}:m")).provider, Some(id), "{id}");
        }
    }

    #[test]
    fn reads_the_claude_code_alias_as_the_claude_plan_and_ignores_the_prefixs_case() {
        assert_eq!(
            parse_model_ref("claude-code:sonnet"),
            parsed(Some("claude"), Some("sonnet"))
        );
        assert_eq!(
            parse_model_ref("OpenRouter:anthropic/claude-sonnet-5"),
            parsed(Some("openrouter"), Some("anthropic/claude-sonnet-5"))
        );
    }

    #[test]
    fn gives_a_provider_with_no_model_a_null_model_the_providers_default() {
        assert_eq!(parse_model_ref("openrouter:"), parsed(Some("openrouter"), None));
        assert_eq!(parse_model_ref("deepseek:   "), parsed(Some("deepseek"), None));
    }

    #[test]
    fn trims_and_gives_nothing_for_nothing() {
        assert_eq!(
            parse_model_ref("  deepseek:deepseek-flash  "),
            parsed(Some("deepseek"), Some("deepseek-flash"))
        );
        // The JS also took undefined and null here; a `&str` is never either.
        for empty in ["", "   "] {
            assert_eq!(parse_model_ref(empty), parsed(None, None), "{empty:?}");
        }
    }

    #[test]
    fn does_not_take_a_bare_provider_name_for_a_provider() {
        assert_eq!(parse_model_ref("openrouter"), parsed(None, Some("openrouter")));
    }

    // --- formatModelRef ---

    #[test]
    fn writes_provider_model_with_the_public_id() {
        assert_eq!(
            format_model_ref(Some("openrouter"), Some("deepseek/x:free")).unwrap(),
            "openrouter:deepseek/x:free"
        );
        assert_eq!(
            format_model_ref(Some("claude-code"), Some("sonnet")).unwrap(),
            "claude:sonnet"
        );
        assert_eq!(
            parsed(Some("deepseek"), Some("deepseek-flash")).format().unwrap(),
            "deepseek:deepseek-flash"
        );
    }

    #[test]
    fn writes_a_bare_model_when_there_is_no_provider_and_provider_colon_when_there_is_no_model() {
        assert_eq!(format_model_ref(None, Some("sonnet")).unwrap(), "sonnet");
        assert_eq!(parsed(None, Some("sonnet")).format().unwrap(), "sonnet");
        assert_eq!(format_model_ref(Some("openrouter"), None).unwrap(), "openrouter:");
        assert_eq!(format_model_ref(None, None).unwrap(), "");
        assert_eq!(format_model_ref(Some(""), Some("sonnet")).unwrap(), "sonnet");
    }

    #[test]
    fn refuses_a_provider_tarsee_does_not_know() {
        let err = format_model_ref(Some("gemini"), Some("pro")).unwrap_err();
        assert_eq!(err.to_string(), "Unknown provider: gemini");
    }

    #[test]
    fn refuses_a_bare_model_that_would_read_back_as_another_providers_a_local_model_named_deepseek_7b() {
        for model in [
            "deepseek:7b",
            "openai:latest",
            "claude-code:x",
            "OpenRouter:y",
            " local:z ",
        ] {
            let err = format_model_ref(None, Some(model)).unwrap_err().to_string();
            assert!(err.contains("provider"), "{model}: {err}");
            let err = parsed(None, Some(model)).format().unwrap_err().to_string();
            assert!(err.contains("provider"), "{model}: {err}");
        }
        assert_eq!(
            format_model_ref(None, Some("deepseek:7b")).unwrap_err().to_string(),
            "\"deepseek:7b\" would read back as a deepseek model: name its provider"
        );
        // Named with its provider, the same model round-trips.
        assert_eq!(
            parse_model_ref(&format_model_ref(Some("local"), Some("deepseek:7b")).unwrap()),
            parsed(Some("local"), Some("deepseek:7b"))
        );
    }

    #[test]
    fn round_trips_a_bare_model_whenever_it_writes_one() {
        for model in [
            "sonnet",
            "llama3.1:8b",
            "deepseek-r1:7b",
            "gemini:pro",
            "deepseek/x:free",
            ":odd",
            "",
        ] {
            let text = format_model_ref(None, Some(model)).unwrap();
            let want = (!model.is_empty()).then_some(model);
            assert_eq!(parse_model_ref(&text), parsed(None, want), "{model}");
        }
    }

    #[test]
    fn round_trips_through_parse_model_ref() {
        let models = [
            Some("sonnet"),
            Some("deepseek/x:free"),
            Some("llama3.1:8b"),
            Some("~anthropic/claude-sonnet-latest"),
            Some("a:b:c"),
            None,
        ];
        for provider in PROVIDERS {
            for model in models {
                let text = format_model_ref(Some(provider), model).unwrap();
                assert_eq!(
                    parse_model_ref(&text),
                    parsed(Some(provider), model),
                    "{provider} {model:?}"
                );
            }
        }
    }

    #[test]
    fn a_ref_serialises_as_the_javascript_object() {
        assert_eq!(
            serde_json::to_string(&parse_model_ref("claude-code:sonnet")).unwrap(),
            r#"{"provider":"claude","model":"sonnet"}"#
        );
    }
}
