use std::path::{Component, Path};

use axum::{
    body::Body,
    extract::State,
    http::{Method, Uri, header},
    response::{IntoResponse, Response},
};

use crate::{AppState, error::ApiError};

#[cfg(feature = "embed-web")]
static WEB: include_dir::Dir<'_> = include_dir::include_dir!("$CARGO_MANIFEST_DIR/../../web/dist");

pub(crate) async fn serve(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
) -> Result<Response, ApiError> {
    if state.assets.is_none() && !cfg!(feature = "embed-web") {
        return Err(ApiError::not_found());
    }
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
    }) || uri.path().contains('%')
    {
        return Err(ApiError::not_found());
    }
    // Client routes have no extension. Missing scripts and other files must
    // stay 404s rather than receiving HTML with the wrong content type.
    let relative = if relative.extension().is_none() {
        Path::new("index.html")
    } else {
        relative
    };
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
    let (body, length) = if let Some(assets) = &state.assets {
        filesystem(assets, relative, &method).await?
    } else {
        embedded(relative, &method)?
    };
    let cache = if hashed_asset(relative) {
        "public, max-age=31536000, immutable"
    } else {
        "no-store"
    };
    Ok((
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::CONTENT_LENGTH, length.to_string()),
            (header::CACHE_CONTROL, cache.to_string()),
        ],
        body,
    )
        .into_response())
}

fn hashed_asset(path: &Path) -> bool {
    path.starts_with("assets")
        && path
            .file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.split_once('-').is_some_and(|(_, hash)| {
                    hash.len() >= 8
                        && hash
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                })
            })
}

async fn filesystem(
    root: &Path,
    relative: &Path,
    method: &Method,
) -> Result<(Body, u64), ApiError> {
    let root = tokio::fs::canonicalize(root).await.map_err(asset_error)?;
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
    if method == Method::HEAD {
        Ok((Body::empty(), metadata.len()))
    } else {
        let bytes = tokio::fs::read(&file).await.map_err(asset_error)?;
        let length = bytes.len() as u64;
        Ok((Body::from(bytes), length))
    }
}

#[cfg(feature = "embed-web")]
fn embedded(relative: &Path, method: &Method) -> Result<(Body, u64), ApiError> {
    let file = WEB.get_file(relative).ok_or_else(ApiError::not_found)?;
    let bytes = file.contents();
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes)
    };
    Ok((body, bytes.len() as u64))
}

#[cfg(not(feature = "embed-web"))]
fn embedded(_: &Path, _: &Method) -> Result<(Body, u64), ApiError> {
    Err(ApiError::not_found())
}

fn asset_error(error: std::io::Error) -> ApiError {
    match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => ApiError::not_found(),
        _ => ApiError::internal(error),
    }
}
