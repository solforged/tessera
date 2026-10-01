use std::path::{Component, Path};

use axum::{
    body::Body,
    extract::State,
    http::{Method, Uri, header},
    response::{IntoResponse, Response},
};

use crate::{AppState, error::ApiError};

pub(crate) async fn serve(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> Result<Response, ApiError> {
    let Some(assets) = &state.assets else {
        return Err(ApiError::not_found());
    };
    if uri.path() == "/api" || uri.path().starts_with("/api/") {
        return Err(ApiError::not_found());
    }
    if method != Method::GET && method != Method::HEAD {
        return Err(ApiError::method_not_allowed());
    }
    let relative = if uri.path() == "/" {
        Path::new("index.html")
    } else {
        Path::new(uri.path().trim_start_matches('/'))
    };
    // Vite's emitted asset names need no URL decoding. Reject dotfiles and
    // traversal rather than accidentally exposing a notebook or source tree.
    if relative.components().any(|component| match component {
        Component::Normal(name) => name.to_string_lossy().starts_with('.'),
        _ => true,
    }) {
        return Err(ApiError::not_found());
    }
    let mime = match relative
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        _ => return Err(ApiError::not_found()),
    };
    let root = tokio::fs::canonicalize(assets.as_path())
        .await
        .map_err(asset_error)?;
    let file = tokio::fs::canonicalize(root.join(relative))
        .await
        .map_err(asset_error)?;
    if !file.starts_with(&root) {
        return Err(ApiError::not_found());
    }
    let metadata = tokio::fs::metadata(&file).await.map_err(asset_error)?;
    if !metadata.is_file() {
        return Err(ApiError::not_found());
    }
    let (body, length) = if method == Method::HEAD {
        (Body::empty(), metadata.len())
    } else {
        let bytes = tokio::fs::read(&file).await.map_err(asset_error)?;
        let length = bytes.len() as u64;
        (Body::from(bytes), length)
    };
    Ok((
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::CONTENT_LENGTH, length.to_string()),
        ],
        body,
    )
        .into_response())
}

fn asset_error(error: std::io::Error) -> ApiError {
    match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => ApiError::not_found(),
        _ => ApiError::internal(error),
    }
}
