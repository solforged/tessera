//! The in-process notebook and the IPC commands the web interface's transport calls.

use std::collections::HashMap;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, header::CONTENT_TYPE},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager};
use tessera_core::{Notebook, NotebookOwnership, library::IngestJob};
use tessera_service::EmbeddedHandles;
use tokio::sync::{OnceCell, broadcast};
use tokio::task::AbortHandle;
use tower::ServiceExt;

/// The open notebook, shared by every activity this process creates.
struct Host {
    router: Router,
    handles: EmbeddedHandles,
    /// Change streams by the page's subscription id.
    streams: Mutex<HashMap<u32, AbortHandle>>,
    /// Held for the process lifetime so no second writer opens the notebook.
    _ownership: NotebookOwnership,
}

static HOST: OnceCell<Host> = OnceCell::const_new();

async fn host(app: &AppHandle) -> Result<&'static Host, String> {
    HOST.get_or_try_init(|| async {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("cannot find app storage: {error}"))?
            .join("notebook");
        let (notebook, ownership) = tokio::task::spawn_blocking(move || {
            let ownership =
                NotebookOwnership::acquire(&dir, 0).map_err(|error| error.to_string())?;
            let notebook = Notebook::open(&dir)
                .map_err(|error| format!("cannot open notebook {}: {error}", dir.display()))?;
            Ok::<_, String>((notebook, ownership))
        })
        .await
        .map_err(|error| error.to_string())??;
        let (router, handles) = tessera_service::embedded_router(notebook)?;
        Ok(Host {
            router,
            handles,
            streams: Mutex::default(),
            _ownership: ownership,
        })
    })
    .await
}

#[derive(Deserialize)]
struct NotebookRequest {
    method: String,
    /// Path and query, e.g. `/api/pages/…`.
    path: String,
    headers: Vec<(String, String)>,
    /// Base64, because Android's IPC carries only JSON and would expand bytes into a number array.
    body: Option<String>,
}

/// Dispatch a request to the same notebook handlers as the service. The reply is
/// the status (u16 BE), the content type's length (u16 BE), the content type, then the body.
#[tauri::command]
async fn notebook_request(app: AppHandle, request: NotebookRequest) -> Result<Response, String> {
    let host = host(&app).await?;
    let body = request
        .body
        .map(|body| STANDARD.decode(body))
        .transpose()
        .map_err(|error| format!("invalid request body: {error}"))?
        .unwrap_or_default();
    let mut builder = Request::builder()
        .method(request.method.as_str())
        .uri(request.path.as_str());
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let request = builder
        .body(Body::from(body))
        .map_err(|error| error.to_string())?;
    let response = host
        .router
        .clone()
        .oneshot(request)
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .map(|value| value.as_bytes().to_vec())
        .unwrap_or_default();
    let content_type_len = u16::try_from(content_type.len())
        .map_err(|_| "the response content type is too long".to_string())?;
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .map_err(|error| error.to_string())?;
    let mut reply = Vec::with_capacity(4 + content_type.len() + body.len());
    reply.extend_from_slice(&status.to_be_bytes());
    reply.extend_from_slice(&content_type_len.to_be_bytes());
    reply.extend_from_slice(&content_type);
    reply.extend_from_slice(&body);
    Ok(Response::new(reply))
}

#[derive(Default, Serialize)]
struct OpenedFiles {
    jobs: Vec<IngestJob>,
    errors: Vec<String>,
}

static INBOX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Kotlin has already copied URI-granted streams into this private, atomic inbox.
#[tauri::command]
async fn take_opened_files(app: AppHandle) -> Result<OpenedFiles, String> {
    let _guard = INBOX.lock().await;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("inbox");
    let mut files = match tokio::fs::read_dir(directory).await {
        Ok(files) => files,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(OpenedFiles::default());
        }
        Err(error) => return Err(format!("cannot read the import inbox: {error}")),
    };
    let host = host(&app).await?;
    let mut result = OpenedFiles::default();
    while let Some(file) = files
        .next_entry()
        .await
        .map_err(|error| error.to_string())?
    {
        let path = file.path();
        let filename = file.file_name();
        let filename = filename.to_string_lossy();
        if filename.ends_with(".error") {
            result.errors.push(
                tokio::fs::read_to_string(&path)
                    .await
                    .map_err(|error| error.to_string())?,
            );
        } else if path
            .extension()
            .and_then(std::ffi::OsStr::to_str)
            .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
        {
            let name = filename
                .split_once('_')
                .map_or(filename.as_ref(), |(_, name)| name);
            match upload_opened_file(host, &path, name).await {
                Ok(job) => result.jobs.push(job),
                Err(error) => result.errors.push(format!("{name}: {error}")),
            }
        } else {
            // A .part stream is still being copied, and must not be consumed yet.
            continue;
        }
        if let Err(error) = tokio::fs::remove_file(&path).await {
            result
                .errors
                .push(format!("cannot clear the import inbox: {error}"));
        }
    }
    Ok(result)
}

async fn upload_opened_file(
    host: &Host,
    path: &std::path::Path,
    name: &str,
) -> Result<IngestJob, String> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| error.to_string())?;
    let filename =
        percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC).to_string();
    let request = Request::builder()
        .method("POST")
        .uri("/api/library/uploads")
        .header(CONTENT_TYPE, "application/epub+zip")
        .header("X-Filename", filename)
        .body(Body::from(bytes))
        .map_err(|error| error.to_string())?;
    let response = host
        .router
        .clone()
        .oneshot(request)
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "upload failed ({status}): {}",
            String::from_utf8_lossy(&body)
        ));
    }
    serde_json::from_slice(&body).map_err(|error| error.to_string())
}
/// Deliver committed changes after `after` in cursor order until the page closes
/// the stream; the command returns then, or fails if the stream cannot continue.
#[tauri::command]
async fn stream_changes(
    app: AppHandle,
    id: u32,
    after: i64,
    channel: Channel<String>,
) -> Result<(), String> {
    let host = host(&app).await?;
    // Subscribe before catching up. A commit in either phase is observed by
    // history, the receiver, or both; the cursor removes the overlap.
    let receiver = host.handles.changes.subscribe();
    let task = tokio::spawn(deliver(host, receiver, after, channel));
    let abort = task.abort_handle();
    let task_id = abort.id();
    if let Some(previous) = host.streams.lock().insert(id, abort) {
        previous.abort();
    }
    let result = task.await;
    {
        let mut streams = host.streams.lock();
        if streams.get(&id).is_some_and(|abort| abort.id() == task_id) {
            streams.remove(&id);
        }
    }
    match result {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn close_changes(id: u32) {
    if let Some(host) = HOST.get()
        && let Some(stream) = host.streams.lock().remove(&id)
    {
        stream.abort();
    }
}

async fn deliver(
    host: &'static Host,
    mut receiver: broadcast::Receiver<i64>,
    mut after: i64,
    channel: Channel<String>,
) -> Result<(), String> {
    catch_up(host, &mut after, &channel).await?;
    loop {
        match receiver.recv().await {
            Ok(seq) if seq <= after => continue,
            Err(broadcast::error::RecvError::Closed) => return Ok(()),
            // Notifications may overflow, but committed notebook history never does.
            Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
        }
        catch_up(host, &mut after, &channel).await?;
    }
}

async fn catch_up(
    host: &'static Host,
    after: &mut i64,
    channel: &Channel<String>,
) -> Result<(), String> {
    loop {
        let cursor = *after;
        let notebook = host.handles.notebook.clone();
        let changes =
            tokio::task::spawn_blocking(move || notebook.lock().changes_since(cursor, 100))
                .await
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())?;
        if changes.is_empty() {
            return Ok(());
        }
        for change in changes {
            if change.seq > *after {
                let json = serde_json::to_string(&change).map_err(|error| error.to_string())?;
                channel.send(json).map_err(|error| error.to_string())?;
                *after = change.seq;
            }
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            notebook_request,
            stream_changes,
            close_changes,
            take_opened_files
        ])
        .on_page_load(|_, payload| {
            // A reloaded page cannot receive its old streams' changes.
            if matches!(payload.event(), PageLoadEvent::Started)
                && let Some(host) = HOST.get()
            {
                for (_, stream) in host.streams.lock().drain() {
                    stream.abort();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Tessera could not start");
}
