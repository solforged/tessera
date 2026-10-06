use crate::{AppState, error::ApiError, run};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{
        DefaultBodyLimit, Path, Query, State,
        rejection::{JsonRejection, PathRejection, QueryRejection},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use parking_lot::Mutex;
use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tessera_core::{Actor, Batch, Notebook, library::*};
use tokio::sync::{Notify, broadcast};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/library/jobs", post(queue).get(jobs))
        .route("/api/library/jobs/{id}", get(job))
        .route("/api/library/jobs/{id}/retry", post(retry))
        .route("/api/library/query", post(query))
        .route("/api/library/export", get(export).post(export_query))
        .route("/api/library/views", get(views))
        .route("/api/sources/{id}", get(source))
        .route("/api/sources/{id}/extracted", get(extracted))
        .route("/api/snapshots/{id}/passages", get(passages))
        .route("/api/snapshots/{id}/locate", get(locate))
        .route("/api/snapshots/{id}/resources/{*href}", get(resource))
        .route("/api/snapshots/{id}/position", post(position))
        .route("/api/passages/search", get(search))
        .route("/api/highlights/query", post(highlights))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .route(
            "/api/library/uploads",
            post(upload).layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
}
fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "validation", message)
}
#[derive(Deserialize)]
struct UploadQuery {
    target_source: Option<String>,
}
async fn upload(
    State(state): State<AppState>,
    query: Result<Query<UploadQuery>, QueryRejection>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<IngestJob>), ApiError> {
    let Query(query) = query.map_err(ApiError::from)?;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if !matches!(
        content_type,
        "application/epub+zip" | "application/octet-stream"
    ) {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "Upload an EPUB or an octet-stream file.",
        ));
    }
    let filename = headers
        .get("X-Filename")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| invalid("An upload requires the X-Filename header."))?;
    let filename = percent_encoding::percent_decode_str(filename)
        .decode_utf8()
        .map_err(|_| invalid("The filename is not valid UTF-8."))?
        .into_owned();
    let job = run(&state, move |n| {
        let sha = n.put_object(&body)?;
        n.queue_ingest(
            IngestInput::File,
            &sha,
            &filename,
            query.target_source.as_deref(),
        )
    })
    .await?;
    state.library.kick();
    Ok((StatusCode::CREATED, Json(job)))
}
#[derive(Deserialize)]
struct UrlJob {
    url: String,
    target_source: Option<String>,
}
async fn queue(
    State(state): State<AppState>,
    body: Result<Json<UrlJob>, JsonRejection>,
) -> Result<(StatusCode, Json<IngestJob>), ApiError> {
    let Json(body) = body.map_err(ApiError::from)?;
    let url = reqwest::Url::parse(&body.url)
        .map_err(|_| invalid("Enter an absolute HTTP or HTTPS URL."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid("Only HTTP and HTTPS source URLs are accepted."));
    }
    let job = run(&state, move |n| {
        n.queue_ingest(
            IngestInput::Url,
            url.as_str(),
            url.as_str(),
            body.target_source.as_deref(),
        )
    })
    .await?;
    state.library.kick();
    Ok((StatusCode::CREATED, Json(job)))
}
async fn jobs(
    State(state): State<AppState>,
    query: Result<Query<crate::Limit>, QueryRejection>,
) -> Result<Json<Vec<IngestJob>>, ApiError> {
    let Query(q) = query.map_err(ApiError::from)?;
    run(&state, move |n| n.ingest_jobs(q.limit)).await.map(Json)
}
async fn job(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<IngestJob>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |n| n.ingest_job(&id)).await.map(Json)
}
async fn retry(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<IngestJob>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let job = run(&state, move |n| n.retry_ingest(&id)).await?;
    state.library.kick();
    Ok(Json(job))
}
async fn query(
    State(state): State<AppState>,
    body: Result<Json<LibraryQuery>, JsonRejection>,
) -> Result<Json<LibraryResult>, ApiError> {
    let Json(q) = body.map_err(ApiError::from)?;
    run(&state, move |n| n.library(&q)).await.map(Json)
}
async fn views(State(state): State<AppState>) -> Result<Json<Vec<LibraryView>>, ApiError> {
    run(&state, move |n| n.library_views()).await.map(Json)
}
async fn source(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<SourceView>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |n| n.source(&id)).await.map(Json)
}
async fn extracted(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Vec<(String, Vec<String>)>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    run(&state, move |n| n.extracted_values(&id))
        .await
        .map(Json)
}
#[derive(Deserialize)]
struct PassageQuery {
    #[serde(default)]
    from: i64,
    #[serde(default = "crate::default_limit")]
    limit: usize,
}
async fn passages(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<PassageQuery>, QueryRejection>,
) -> Result<Json<PassagePage>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Query(q) = query.map_err(ApiError::from)?;
    run(&state, move |n| n.passages(&id, q.from, q.limit))
        .await
        .map(Json)
}
#[derive(Deserialize)]
struct LocateQuery {
    at: String,
}
async fn locate(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<LocateQuery>, QueryRejection>,
) -> Result<Json<Option<i64>>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Query(q) = query.map_err(ApiError::from)?;
    run(&state, move |n| n.locate(&id, &q.at)).await.map(Json)
}
async fn resource(
    State(state): State<AppState>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> Result<Response, ApiError> {
    let Path((id, href)) = path.map_err(ApiError::from)?;
    let data = run(&state, move |n| {
        let (sha, media_type) = n.snapshot_resource(&id, &href)?;
        if !media_type.starts_with("image/") {
            return Ok(None);
        }
        Ok(Some((n.read_object(&sha)?, media_type)))
    })
    .await?;
    let (bytes, media_type) = data.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "Only image resources may be served.",
        )
    })?;
    Ok((
        [
            (header::CONTENT_TYPE, media_type),
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable".into(),
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
        ],
        bytes,
    )
        .into_response())
}
#[derive(Deserialize)]
struct PositionBody {
    ordinal: i64,
    from: i64,
    to: i64,
}
async fn position(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
    body: Result<Json<PositionBody>, JsonRejection>,
) -> Result<Json<ReadingProgress>, ApiError> {
    let Path(id) = path.map_err(ApiError::from)?;
    let Json(body) = body.map_err(ApiError::from)?;
    let changes = state.changes.clone();
    run(&state, move |n| {
        let result = n.set_reading_position(&id, body.ordinal, (body.from, body.to))?;
        if let Some(seq) = result.seq {
            let _ = changes.send(seq);
        }
        Ok(result)
    })
    .await
    .map(Json)
}
#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    source: Option<String>,
    #[serde(default = "crate::default_limit")]
    limit: usize,
}
async fn search(
    State(state): State<AppState>,
    query: Result<Query<SearchQuery>, QueryRejection>,
) -> Result<Json<Vec<PassageHit>>, ApiError> {
    let Query(q) = query.map_err(ApiError::from)?;
    run(&state, move |n| {
        n.search_passages(&q.q, q.source.as_deref(), q.limit)
    })
    .await
    .map(Json)
}
async fn highlights(
    State(state): State<AppState>,
    body: Result<Json<HighlightQuery>, JsonRejection>,
) -> Result<Json<HighlightResult>, ApiError> {
    let Json(q) = body.map_err(ApiError::from)?;
    run(&state, move |n| n.highlights(&q)).await.map(Json)
}
#[derive(Deserialize)]
struct ExportQuery {
    format: ExportFormat,
    ids: Option<String>,
}
async fn export(
    State(state): State<AppState>,
    query: Result<Query<ExportQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(q) = query.map_err(ApiError::from)?;
    let ids: Vec<String> = q
        .ids
        .map(|ids| {
            ids.split(',')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let output = run(&state, move |n| n.export(&ids, q.format)).await?;
    Ok(export_response(q.format, output))
}
#[derive(Deserialize)]
struct ExportBody {
    format: ExportFormat,
    query: LibraryQuery,
}
async fn export_query(
    State(state): State<AppState>,
    body: Result<Json<ExportBody>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(body) = body.map_err(ApiError::from)?;
    let output = run(&state, move |n| n.export_query(&body.query, body.format)).await?;
    Ok(export_response(body.format, output))
}
fn export_response(format: ExportFormat, output: String) -> Response {
    let (media, filename) = match format {
        ExportFormat::Bibtex => ("application/x-bibtex", "tessera.bib"),
        ExportFormat::CslJson => ("application/vnd.citationstyles.csl+json", "tessera.json"),
    };
    (
        [
            (header::CONTENT_TYPE, media.to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        output,
    )
        .into_response()
}

type Extractor = fn(&[u8], Option<&str>, &str) -> Result<ExtractedDocument, String>;
pub(crate) fn extract(
    bytes: &[u8],
    media: Option<&str>,
    url: &str,
) -> Result<ExtractedDocument, String> {
    let format = tessera_ingest::detect(bytes, media, Some(url))
        .ok_or_else(|| "This file is not a supported EPUB or web article.".to_owned())?;
    let result = match format {
        SourceFormat::Epub => tessera_ingest::epub(bytes),
        SourceFormat::Article => {
            let html = std::str::from_utf8(bytes)
                .map_err(|_| "The article is not valid UTF-8.".to_owned())?;
            tessera_ingest::article(html, url)
        }
    };
    result.map_err(|e| format!("The source could not be extracted: {e}."))
}

/// Wakes the single persistent ingestion worker. Dropping its last handle stops it.
#[derive(Clone)]
pub struct Library(Arc<Control>);
struct Control {
    notify: Arc<Notify>,
    abort: tokio::task::AbortHandle,
}
impl Drop for Control {
    fn drop(&mut self) {
        self.abort.abort();
    }
}
impl Library {
    pub fn kick(&self) {
        self.0.notify.notify_one();
    }
    pub(crate) fn start(
        notebook: Arc<Mutex<Notebook>>,
        changes: broadcast::Sender<i64>,
        extractor: Extractor,
    ) -> Result<Self, String> {
        notebook.lock().resume_ingest().map_err(|e| e.to_string())?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(concat!("Tessera/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        let notify = Arc::new(Notify::new());
        let worker = Worker {
            notebook,
            changes,
            notify: notify.clone(),
            client,
            extractor,
        };
        let task = tokio::spawn(worker.run());
        Ok(Self(Arc::new(Control {
            notify,
            abort: task.abort_handle(),
        })))
    }
}
struct Worker {
    notebook: Arc<Mutex<Notebook>>,
    changes: broadcast::Sender<i64>,
    notify: Arc<Notify>,
    client: reqwest::Client,
    extractor: Extractor,
}
struct Failure {
    message: String,
    retryable: bool,
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self {
            message,
            retryable: false,
        }
    }
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after 1970")
        .as_millis() as i64
}
impl Worker {
    async fn access<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Notebook) -> tessera_core::Result<T> + Send + 'static,
    ) -> Result<T, String> {
        let notebook = self.notebook.clone();
        tokio::task::spawn_blocking(move || {
            let mut n = notebook.lock();
            f(&mut n).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("The ingestion task stopped: {e}."))?
    }
    async fn run(self) {
        loop {
            // A Notify permit is retained if a request arrives while a job is running.
            let job = match self.access(|n| n.claim_ingest()).await {
                Ok(job) => job,
                Err(error) => {
                    tracing::error!(%error, "ingest worker could not claim a job");
                    return;
                }
            };
            if let Some(job) = job {
                tracing::info!(job_id = %job.id, attempt = job.attempts, "ingest job started");
                if let Err(error) = self.process(&job).await {
                    tracing::warn!(job_id = %job.id, error = %error.message, "ingest job failed");
                    let delay = if error.retryable {
                        match job.attempts {
                            1 => Some(30_000),
                            2 => Some(120_000),
                            3 => Some(600_000),
                            _ => None,
                        }
                    } else {
                        None
                    };
                    let retry_at = delay.map(|delay| now_ms() + delay);
                    if let Err(error) = self
                        .access(move |n| n.fail_ingest(&job.id, &error.message, retry_at))
                        .await
                    {
                        tracing::error!(%error, "ingest worker could not record failure");
                        return;
                    }
                } else {
                    tracing::info!(job_id = %job.id, "ingest job finished");
                }
                continue;
            }
            let next = match self.access(|n| n.next_ingest_at()).await {
                Ok(next) => next,
                Err(error) => {
                    tracing::error!(%error, "ingest worker could not schedule next job");
                    return;
                }
            };
            let delay = next
                .map(|next| Duration::from_millis((next - now_ms()).max(0) as u64))
                .unwrap_or(Duration::from_secs(86400));
            tokio::select! {_=self.notify.notified()=>{},_=tokio::time::sleep(delay)=>{}}
        }
    }
    async fn fetch(
        &self,
        url: &str,
        cap: usize,
        image: bool,
    ) -> Result<(Vec<u8>, String), Failure> {
        let url = reqwest::Url::parse(url)
            .map_err(|_| Failure::from("The source URL is not valid.".to_owned()))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(Failure::from(
                "Only HTTP and HTTPS resources are accepted.".to_owned(),
            ));
        }
        let network = |error: reqwest::Error| Failure {
            message: format!("The source could not be downloaded: {error}."),
            retryable: true,
        };
        let mut response = self.client.get(url).send().await.map_err(network)?;
        let status = response.status();
        if !status.is_success() {
            return Err(Failure {
                message: format!("The source server returned HTTP {status}."),
                retryable: status.is_server_error(),
            });
        }
        let media = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("application/octet-stream")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_owned();
        if image && !media.starts_with("image/") {
            return Err(Failure::from("The resource is not an image.".to_owned()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > cap as u64)
        {
            return Err(Failure::from(
                "The source exceeds the download size limit.".to_owned(),
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network)? {
            if bytes.len() + chunk.len() > cap {
                return Err(Failure::from(
                    "The source exceeds the download size limit.".to_owned(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((bytes, media))
    }
    async fn process(&self, job: &IngestJob) -> Result<(), Failure> {
        let (bytes, media) = match job.input_kind {
            IngestInput::Url => self.fetch(&job.input, 32 * 1024 * 1024, false).await?,
            IngestInput::File => {
                let hash = job.input.clone();
                (
                    self.access(move |n| n.read_object(&hash)).await?,
                    String::new(),
                )
            }
        };
        let extractor = self.extractor;
        let url = job.name.clone();
        let notebook = self.notebook.clone();
        let (doc, sha) = tokio::task::spawn_blocking(move || {
            let sha = notebook
                .lock()
                .put_object(&bytes)
                .map_err(|e| e.to_string())?;
            let doc = extractor(&bytes, Some(&media), &url)?;
            Ok::<_, String>((doc, sha))
        })
        .await
        .map_err(|e| format!("The source parser stopped: {e}."))??;
        let mut resources = Vec::new();
        if doc.format == SourceFormat::Article {
            let mut seen = std::collections::HashSet::new();
            for href in doc
                .passages
                .iter()
                .filter(|p| p.kind == PassageKind::Image)
                .filter_map(|p| p.resource.as_deref())
                .filter(|href| seen.insert(*href))
                .take(60)
            {
                if let Ok((bytes, media)) = self.fetch(href, 10 * 1024 * 1024, true).await {
                    let hash = self.access(move |n| n.put_object(&bytes)).await?;
                    resources.push((href.to_owned(), hash, media));
                }
            }
        }
        let job = job.clone();
        let changes = self.changes.clone();
        self.access(move |n| {
            for resource in &doc.resources {
                resources.push((
                    resource.href.clone(),
                    n.put_object(&resource.bytes)?,
                    resource.media_type.clone(),
                ));
            }
            let snapshot = n.stage_snapshot(&doc, &sha, &resources)?;
            let plan =
                n.plan_ingest(&snapshot.id, job.target_source.as_deref(), Some(&job.name))?;
            if !plan.unchanged {
                let committed = n.apply(&Batch {
                    actor: Actor::Client {
                        name: "ingest".into(),
                    },
                    reason: None,
                    idempotency_key: Some(format!("ingest:{}", job.id)),
                    operations: plan.operations,
                })?;
                if !committed.replayed {
                    let _ = changes.send(committed.seq);
                }
            }
            n.finish_ingest(&job.id, &plan.source_id, &snapshot.id)
        })
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    fn constructed(_: &[u8], _: Option<&str>, _: &str) -> Result<ExtractedDocument, String> {
        Ok(ExtractedDocument {
            format: SourceFormat::Epub,
            media_type: "application/epub+zip".into(),
            metadata: ExtractedMetadata {
                title: Some("Worker book".into()),
                ..Default::default()
            },
            toc: vec![],
            passages: vec![ExtractedPassage {
                kind: PassageKind::Paragraph,
                level: None,
                text: "Readable evidence".into(),
                locator: "body#one".into(),
                anchor: None,
                resource: None,
                marks: vec![],
            }],
            resources: vec![
                ExtractedResource {
                    href: "cover.png".into(),
                    media_type: "image/png".into(),
                    bytes: b"image".to_vec(),
                },
                ExtractedResource {
                    href: "script.js".into(),
                    media_type: "text/javascript".into(),
                    bytes: b"script".to_vec(),
                },
            ],
        })
    }
    fn failed(_: &[u8], _: Option<&str>, _: &str) -> Result<ExtractedDocument, String> {
        Err("The file could not be extracted.".into())
    }
    fn state(notebook: Notebook, extractor: Extractor) -> AppState {
        let notebook = Arc::new(Mutex::new(notebook));
        let changes = broadcast::channel(32).0;
        let library = Library::start(notebook.clone(), changes.clone(), extractor).unwrap();
        AppState {
            notebook,
            changes,
            assets: None,
            library,
            port: crate::DEFAULT_PORT,
            backup: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
    async fn response(app: &Router, method: &str, path: &str, body: Vec<u8>) -> Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("Content-Type", "application/octet-stream")
                    .header("X-Filename", "worker%20book.epub")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    async fn value(response: Response) -> serde_json::Value {
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    }
    async fn done(state: &AppState, id: &str) -> IngestJob {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let job = state.notebook.lock().ingest_job(id).unwrap();
                if matches!(job.state, IngestJobState::Done | IngestJobState::Failed) {
                    return job;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("worker finished")
    }
    #[tokio::test]
    async fn uploads_run_attributed_jobs_and_serve_only_image_resources() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(Notebook::open(dir.path()).unwrap(), constructed);
        let mut changes = state.changes.subscribe();
        let app = routes().with_state(state.clone());
        let uploaded = response(
            &app,
            "POST",
            "/api/library/uploads",
            vec![42; 2 * 1024 * 1024 + 1],
        )
        .await;
        assert_eq!(uploaded.status(), StatusCode::CREATED);
        let uploaded = value(uploaded).await;
        let job = done(&state, uploaded["id"].as_str().unwrap()).await;
        assert_eq!(job.state, IngestJobState::Done);
        assert_eq!(job.name, "worker book.epub");
        let seq = changes.recv().await.unwrap();
        let source = state
            .notebook
            .lock()
            .source(job.source_id.as_ref().unwrap())
            .unwrap();
        assert_eq!(source.page.text, "Worker book");
        let events = state.notebook.lock().changes_since(seq - 1, 10).unwrap();
        assert_eq!(
            events[0].actor,
            Actor::Client {
                name: "ingest".into()
            }
        );
        let snapshot = job.snapshot_id.unwrap();
        let image = response(
            &app,
            "GET",
            &format!("/api/snapshots/{snapshot}/resources/cover.png"),
            vec![],
        )
        .await;
        assert_eq!(image.status(), StatusCode::OK);
        assert_eq!(image.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(image.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(
            image.headers()[header::CACHE_CONTROL],
            "private, max-age=31536000, immutable"
        );
        assert_eq!(
            response(
                &app,
                "GET",
                &format!("/api/snapshots/{snapshot}/resources/script.js"),
                vec![]
            )
            .await
            .status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        let export = response(&app, "GET", "/api/library/export?format=csl", vec![]).await;
        assert_eq!(export.status(), StatusCode::OK);
        assert_eq!(value(export).await[0]["title"], "Worker book");
        let position = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/snapshots/{snapshot}/position"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"ordinal":0,"from":0,"to":1}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let position = value(position).await;
        assert_eq!(position["progress"], 1.0);
        assert_eq!(
            changes.recv().await.unwrap(),
            position["seq"].as_i64().unwrap()
        );
    }
    #[tokio::test]
    async fn running_jobs_resume_and_failed_jobs_retry() {
        let dir = tempfile::tempdir().unwrap();
        let mut notebook = Notebook::open(dir.path()).unwrap();
        let hash = notebook.put_object(b"resume").unwrap();
        let job = notebook
            .queue_ingest(IngestInput::File, &hash, "resume.epub", None)
            .unwrap();
        notebook.claim_ingest().unwrap().unwrap();
        drop(notebook);
        let first = state(Notebook::open(dir.path()).unwrap(), failed);
        assert_eq!(done(&first, &job.id).await.state, IngestJobState::Failed);
        drop(first);
        let second = state(Notebook::open(dir.path()).unwrap(), constructed);
        let app = routes().with_state(second.clone());
        let retried = response(
            &app,
            "POST",
            &format!("/api/library/jobs/{}/retry", job.id),
            vec![],
        )
        .await;
        assert_eq!(retried.status(), StatusCode::OK);
        let completed = done(&second, &job.id).await;
        assert_eq!(completed.state, IngestJobState::Done);
        assert_eq!(completed.attempts, 1);
        assert_eq!(
            response(
                &app,
                "POST",
                &format!("/api/library/jobs/{}/retry", job.id),
                vec![]
            )
            .await
            .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    #[tokio::test]
    async fn url_failures_use_backoff_and_reject_non_http_schemes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/", get(|| async { StatusCode::SERVICE_UNAVAILABLE })),
            )
            .await
            .unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let state = state(Notebook::open(dir.path()).unwrap(), constructed);
        let app = routes().with_state(state.clone());
        let request = |url: String| {
            Request::builder()
                .method("POST")
                .uri("/api/library/jobs")
                .header("Content-Type", "application/json")
                .body(Body::from(serde_json::json!({"url":url}).to_string()))
                .unwrap()
        };
        assert_eq!(
            app.clone()
                .oneshot(request("file:///etc/passwd".into()))
                .await
                .unwrap()
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let job = value(
            app.oneshot(request(format!("http://{address}/")))
                .await
                .unwrap(),
        )
        .await;
        let id = job["id"].as_str().unwrap().to_owned();
        let queued = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let job = state.notebook.lock().ingest_job(&id).unwrap();
                if job.error.is_some() {
                    break job;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(queued.state, IngestJobState::Queued);
        assert_eq!(queued.attempts, 1);
        assert!(queued.error.unwrap().contains("503"));
        assert!(queued.next_attempt_at.unwrap() > now_ms() + 25_000);
        server.abort();
    }
    #[tokio::test]
    async fn library_views_and_query_exports_use_saved_queries() {
        let dir = tempfile::tempdir().unwrap();
        let mut notebook = Notebook::open(dir.path()).unwrap();
        let document = constructed(&[], None, "").unwrap();
        let hash = notebook.put_object(b"library view book").unwrap();
        let snapshot = notebook.stage_snapshot(&document, &hash, &[]).unwrap();
        let plan = notebook.plan_ingest(&snapshot.id, None, None).unwrap();
        notebook
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: plan.operations,
            })
            .unwrap();
        let view_id = ulid::Ulid::generate().to_string();
        notebook
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: vec![tessera_core::Operation::SaveLibraryView {
                    id: view_id.clone(),
                    base_revision: None,
                    name: "Reading list".into(),
                    query: LibraryQuery {
                        text: Some("Worker".into()),
                        limit: Some(0),
                        ..Default::default()
                    },
                }],
            })
            .unwrap();
        let state = state(notebook, constructed);
        let app = routes().with_state(state);
        let views = value(response(&app, "GET", "/api/library/views", vec![]).await).await;
        assert_eq!(views[0]["id"], view_id);
        let exported = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/library/export")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "format": "csl", "query": views[0]["query"] })
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(exported.status(), StatusCode::OK);
        assert_eq!(
            exported.headers()[header::CONTENT_DISPOSITION],
            "attachment; filename=\"tessera.json\""
        );
        assert_eq!(value(exported).await[0]["title"], "Worker book");
        let empty = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/library/export")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        r#"{"format":"csl","query":{"text":"does not match"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(value(empty).await, serde_json::json!([]));
    }

    #[tokio::test]
    async fn historical_snapshot_passages_return_their_own_contents() {
        let dir = tempfile::tempdir().unwrap();
        let mut notebook = Notebook::open(dir.path()).unwrap();
        let mut document = constructed(&[], None, "").unwrap();
        document.toc = vec![TocEntry {
            title: "Old opening".into(),
            locator: "body#one".into(),
            level: 1,
        }];
        let hash = notebook.put_object(b"old book").unwrap();
        let old = notebook.stage_snapshot(&document, &hash, &[]).unwrap();
        let plan = notebook.plan_ingest(&old.id, None, None).unwrap();
        let source = plan.source_id;
        notebook
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: plan.operations,
            })
            .unwrap();
        document.toc[0].title = "New opening".into();
        let hash = notebook.put_object(b"new book").unwrap();
        let new = notebook.stage_snapshot(&document, &hash, &[]).unwrap();
        let plan = notebook.plan_ingest(&new.id, Some(&source), None).unwrap();
        notebook
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: plan.operations,
            })
            .unwrap();
        assert_eq!(
            notebook.source(&source).unwrap().source.current_snapshot_id,
            Some(new.id)
        );
        let app = routes().with_state(state(notebook, constructed));
        let passages = response(
            &app,
            "GET",
            &format!("/api/snapshots/{}/passages", old.id),
            vec![],
        )
        .await;
        assert_eq!(passages.status(), StatusCode::OK);
        assert_eq!(value(passages).await["toc"][0]["title"], "Old opening");
    }
}
