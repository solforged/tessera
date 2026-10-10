//! LaunchServices file opens, queued until the notebook page and its service are ready.

use std::collections::VecDeque;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager, Url};

pub(crate) struct OpenedFiles(Mutex<Inbox>, reqwest::Client);

impl OpenedFiles {
    pub(crate) fn new(client: reqwest::Client) -> Self {
        Self(Mutex::default(), client)
    }
}

#[derive(Default)]
struct Inbox {
    files: VecDeque<PathBuf>,
    origin: Option<Url>,
    draining: bool,
    reports: Vec<Report>,
}

#[derive(Default, Serialize)]
struct Report {
    jobs: Vec<serde_json::Value>,
    errors: Vec<String>,
}

pub(crate) fn open(app: &AppHandle, urls: Vec<Url>) {
    let state = app.state::<OpenedFiles>();
    state
        .0
        .lock()
        .files
        .extend(urls.into_iter().filter_map(|url| url.to_file_path().ok()));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    drain(app);
}

pub(crate) fn loading(app: &AppHandle) {
    app.state::<OpenedFiles>().0.lock().origin = None;
}

pub(crate) fn ready(app: &AppHandle, origin: Url) {
    let state = app.state::<OpenedFiles>();
    let reports = {
        let mut inbox = state.0.lock();
        inbox.origin = Some(origin);
        std::mem::take(&mut inbox.reports)
    };
    for report in reports {
        deliver(app, report);
    }
    drain(app);
}

fn drain(app: &AppHandle) {
    let state = app.state::<OpenedFiles>();
    {
        let mut inbox = state.0.lock();
        if inbox.draining || inbox.origin.is_none() || inbox.files.is_empty() {
            return;
        }
        inbox.draining = true;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<OpenedFiles>();
        let client = &state.1;
        loop {
            let next = {
                let state = app.state::<OpenedFiles>();
                let mut inbox = state.0.lock();
                let next = inbox
                    .origin
                    .clone()
                    .and_then(|origin| inbox.files.pop_front().map(|file| (origin, file)));
                if next.is_none() {
                    inbox.draining = false;
                }
                next
            };
            let Some((origin, path)) = next else { return };
            let mut report = Report::default();
            match upload(client, &origin, &path).await {
                Ok(job) => report.jobs.push(job),
                Err(error) => {
                    let error = format!("{}: {error}", path.display());
                    crate::app::log(&error);
                    report.errors.push(error);
                }
            }
            deliver(&app, report);
        }
    });
}

async fn upload(
    client: &reqwest::Client,
    origin: &Url,
    path: &std::path::Path,
) -> Result<serde_json::Value, String> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "file has no name".to_string())?
        .to_string_lossy();
    let name = percent_encoding::utf8_percent_encode(&name, percent_encoding::NON_ALPHANUMERIC)
        .to_string();
    let url = origin
        .join("/api/library/uploads")
        .map_err(|error| error.to_string())?;
    let response = client
        .post(url)
        .header("Content-Type", "application/epub+zip")
        .header("X-Filename", name)
        .body(bytes)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "upload failed ({status}): {}",
            response.text().await.map_err(|error| error.to_string())?
        ));
    }
    response.json().await.map_err(|error| error.to_string())
}

fn deliver(app: &AppHandle, report: Report) {
    let state = app.state::<OpenedFiles>();
    let mut inbox = state.0.lock();
    if inbox.origin.is_some()
        && let Some(window) = app.get_webview_window("main")
        && let Ok(json) = serde_json::to_string(&report)
    {
        // The module may not have mounted yet; its startup hook drains this page-local queue.
        let script = format!(
            "(() => {{ const result = {json}; if (window.__tesseraOpenedFiles) window.__tesseraOpenedFiles(result); else (window.__tesseraPendingOpenedFiles ??= []).push(result); }})()"
        );
        if window.eval(script).is_ok() {
            return;
        }
    }
    inbox.reports.push(report);
}
