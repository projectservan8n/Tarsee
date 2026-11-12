//! The error an HTTP handler returns: a status and a JSON body, `{"error": "..."}` unless a handler builds its own.
//!
//! ```ignore
//! async fn handler(State(app): State<App>) -> ApiResult {
//!     let conv = store.get(&id).ok_or_else(|| ApiError::not_found("Conversation not found"))?;
//!     Ok(Json(json!({ "conversation": conv })))
//! }
//! ```
//!
//! An `anyhow::Error` turns into a 500 through `middleware::error_handler` (which redacts secrets from the message),
//! so `?` works on fallible calls inside a handler.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    pub status: StatusCode,
    pub body: Value,
}

/// What a JSON handler returns.
pub type ApiResult<T = Json<Value>> = Result<T, ApiError>;

impl ApiError {
    /// `res.status(status).json({ error: message })`. A status outside 100 to 999 becomes 500.
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self::with_body(status, json!({ "error": message.into() }))
    }

    /// `res.status(status).json(body)` for a body with more than an error message.
    pub fn with_body(status: u16, body: Value) -> Self {
        ApiError {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            body,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(401, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(403, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, message)
    }

    pub fn too_many_requests(message: impl Into<String>) -> Self {
        Self::new(429, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, message)
    }

    /// The `error` text of the body, when it has one.
    pub fn message(&self) -> Option<&str> {
        self.body.get("error").and_then(Value::as_str)
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.message() {
            Some(message) => write!(f, "{} {}", self.status.as_u16(), message),
            None => write!(f, "{} {}", self.status.as_u16(), self.body),
        }
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_is_a_status_and_an_error_message() {
        let err = ApiError::not_found("Conversation not found");
        assert_eq!(err.status, StatusCode::NOT_FOUND);
        assert_eq!(err.body, json!({"error": "Conversation not found"}));
        assert_eq!(err.message(), Some("Conversation not found"));
        assert_eq!(err.to_string(), "404 Conversation not found");
        assert_eq!(ApiError::new(7, "x").status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn it_becomes_a_json_response() {
        let res = ApiError::with_body(429, json!({"error": "slow down", "retryAfter": 30})).into_response();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(res.headers().get("content-type").unwrap(), "application/json");
        let body = http_body_util::BodyExt::collect(res.into_body())
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"error": "slow down", "retryAfter": 30})
        );
    }
}
