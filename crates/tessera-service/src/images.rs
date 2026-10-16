use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use tessera_core::{ImageRef, image_type};

use crate::{AppState, error::ApiError, run};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/images", post(upload))
        .route("/api/images/{sha}", get(image))
        .layer(DefaultBodyLimit::max(20 * 1024 * 1024))
}

async fn upload(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<(StatusCode, Json<ImageRef>), ApiError> {
    let image = run(&state, move |n| n.put_image(&body)).await?;
    Ok((StatusCode::CREATED, Json(image)))
}

async fn image(
    State(state): State<AppState>,
    Path(sha): Path<String>,
) -> Result<Response, ApiError> {
    if sha.len() != 64
        || !sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ApiError::not_found());
    }
    let bytes = crate::library::object(&state, sha).await?;
    let media = image_type(&bytes).ok_or_else(ApiError::not_found)?;
    Ok((
        [
            (header::CONTENT_TYPE, media),
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable",
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}

#[cfg(all(test, not(all(target_arch = "wasm32", target_os = "unknown"))))]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn uploads_sniff_images_enforce_limit_and_serve_immutable_private_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let (app, handles) =
            crate::embedded_router(tessera_core::Notebook::open(dir.path()).unwrap()).unwrap();
        let bytes = b"GIF89a\x01\0\x01\0\x80\0\0\0\0\0\xff\xff\xff!\xf9\x04\x01\0\0\0\0,\0\0\0\0\x01\0\x01\0\0\x02\x02D\x01\0;";
        let uploaded = app
            .clone()
            .oneshot(
                Request::post("/api/images")
                    .header(header::CONTENT_TYPE, "text/plain")
                    .body(Body::from(bytes.as_slice()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(uploaded.status(), StatusCode::CREATED);
        let image: ImageRef =
            serde_json::from_slice(&to_bytes(uploaded.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(
            (image.media_type.as_str(), image.width, image.height),
            ("image/gif", 1, 1)
        );
        let response = app
            .clone()
            .oneshot(
                Request::get(format!("/api/images/{}", image.sha256))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/gif");
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, max-age=31536000, immutable"
        );
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .as_ref(),
            bytes
        );
        let rejected = app
            .clone()
            .oneshot(
                Request::post("/api/images")
                    .body(Body::from("<svg/>"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let rejected: serde_json::Value =
            serde_json::from_slice(&to_bytes(rejected.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert!(
            rejected
                .to_string()
                .contains("Choose a PNG, JPEG, WebP or GIF image.")
        );
        let large = app
            .clone()
            .oneshot(
                Request::post("/api/images")
                    .body(Body::from(vec![0; 20 * 1024 * 1024 + 1]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(large.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let mut several_mib = bytes.to_vec();
        several_mib.resize(4 * 1024 * 1024, 0);
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::post("/api/images")
                        .body(Body::from(several_mib))
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::CREATED
        );
        let sha = handles.notebook.lock().put_object(b"not an image").unwrap();
        for sha in [sha, "0".repeat(64)] {
            assert_eq!(
                app.clone()
                    .oneshot(
                        Request::get(format!("/api/images/{sha}"))
                            .body(Body::empty())
                            .unwrap()
                    )
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
    }
}
