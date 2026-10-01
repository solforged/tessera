use axum::{
    Json,
    extract::rejection::{JsonRejection, PathRejection, QueryRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

/// JSON error envelope with optional structured conflict or validation details.
pub(crate) struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    details: Option<serde_json::Value>,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            details: None,
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
        let message = error.to_string();
        match error {
            tessera_core::Error::Conflict {
                op_index,
                id,
                expected,
                found,
            } => Self {
                status: StatusCode::CONFLICT,
                code: "conflict",
                message,
                details: Some(
                    serde_json::json!({ "op_index": op_index, "id": id, "expected": expected, "found": found }),
                ),
            },
            tessera_core::Error::NotFound { op_index, .. } => Self {
                status: StatusCode::NOT_FOUND,
                code: "not_found",
                message,
                details: op_index.map(|index| serde_json::json!({ "op_index": index })),
            },
            tessera_core::Error::Validation { op_index, .. } => Self {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "validation",
                message,
                details: op_index.map(|index| serde_json::json!({ "op_index": index })),
            },
            other => Self::internal(other),
        }
    }
}

impl From<JsonRejection> for ApiError {
    fn from(error: JsonRejection) -> Self {
        Self::new(error.status(), "invalid_json", error.body_text())
    }
}

impl From<QueryRejection> for ApiError {
    fn from(error: QueryRejection) -> Self {
        Self::new(error.status(), "invalid_query", error.body_text())
    }
}

impl From<PathRejection> for ApiError {
    fn from(error: PathRejection) -> Self {
        Self::new(error.status(), "invalid_path", error.body_text())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        #[derive(Serialize)]
        struct ErrorBody {
            code: &'static str,
            message: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            details: Option<serde_json::Value>,
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
                    details: self.details,
                },
            }),
        )
            .into_response()
    }
}
