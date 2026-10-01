use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

/// JSON error envelope: `{"error": {"code", "message"}}`.
pub(crate) struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn internal(error: impl std::fmt::Display) -> Self {
        eprintln!("tessera-service: {error}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "The notebook operation failed. See the server log for details.",
        )
    }

    pub(crate) fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "Not found.")
    }

    pub(crate) fn method_not_allowed() -> Self {
        Self::new(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
            "This endpoint does not support that HTTP method.",
        )
    }
}

impl From<tessera_core::Error> for ApiError {
    fn from(error: tessera_core::Error) -> Self {
        Self::internal(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        #[derive(Serialize)]
        struct ErrorBody {
            code: &'static str,
            message: String,
        }
        #[derive(Serialize)]
        struct Envelope {
            error: ErrorBody,
        }
        (
            self.status,
            Json(Envelope {
                error: ErrorBody {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}
