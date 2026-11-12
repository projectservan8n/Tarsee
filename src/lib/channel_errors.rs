//! Port of `src/lib/channel-errors.js`.
//!
//! A channel's platform refused its credential (a wrong token, a password the mail server won't take, a permission
//! left off in a developer portal). Trying again can't help until someone changes it in Settings, so the channel
//! manager doesn't retry it at boot (`channels/manager.rs`, `start_with_retry`); the message says what to change.

/// An error that means "the platform refused the credential" (the JS `Error` with `refused: true`). Its text is the
/// message, exactly as given.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct RefusedError {
    pub message: String,
}

impl RefusedError {
    /// Always true: the JS `err.refused`.
    pub fn refused(&self) -> bool {
        true
    }
}

/// `refused(message)`: the error a channel returns when its credential was turned down.
pub fn refused(message: impl Into<String>) -> RefusedError {
    RefusedError {
        message: message.into(),
    }
}

/// Whether an error is (or wraps) one made by [`refused`]: the JS `err?.refused`.
pub fn is_refused(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| cause.downcast_ref::<RefusedError>().is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_error_keeps_its_message_and_is_marked_refused() {
        let err = refused("The bot token was turned down. Paste a new one in Settings.");
        assert_eq!(err.to_string(), "The bot token was turned down. Paste a new one in Settings.");
        assert!(err.refused());
        let wrapped = anyhow::Error::new(err.clone());
        assert!(is_refused(&wrapped));
        assert!(is_refused(&wrapped.context("while starting telegram")));
        assert!(!is_refused(&anyhow::anyhow!("network down")));
    }
}
