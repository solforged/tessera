//! The window, its menu, and startup: bring the launch agent onto this
//! build, then show the notebook the service serves.

use parking_lot::Mutex;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{
    AboutMetadata, HELP_SUBMENU_ID, Menu, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID,
};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::agent::{self, Agent};
use crate::updates;

const MAIN: &str = "main";

#[derive(Default)]
struct Shell {
    /// The service origin the window may show; other pages open in the browser.
    origin: Mutex<Option<Url>>,
    /// The splash text, replayed if it was set before the splash loaded.
    status: Mutex<Option<String>>,
    starting: AtomicBool,
    watching: AtomicBool,
    download: Mutex<Option<PathBuf>>,
    client: reqwest::Client,
}

/// Remembers a build that failed to start, so each launch does not retry it.
#[derive(Default, Deserialize, Serialize)]
struct State {
    failed: Option<String>,
}

impl State {
    fn path(app: &AppHandle) -> Option<PathBuf> {
        Some(app.path().app_data_dir().ok()?.join("state.json"))
    }

    fn load(app: &AppHandle) -> Self {
        Self::path(app)
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save(&self, app: &AppHandle) {
        let Some(path) = Self::path(app) else { return };
        let written = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&path, serde_json::to_vec(self).unwrap_or_default()));
        if let Err(error) = written {
            log(&format!("cannot save {}: {error}", path.display()));
        }
    }
}

pub fn logs() -> PathBuf {
    std::env::home_dir()
        .unwrap_or_default()
        .join("Library/Logs/tessera")
}

/// Append to `desktop.log` beside the service's `serve.log`.
pub fn log(message: &str) {
    let directory = logs();
    let _ = std::fs::create_dir_all(&directory);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("desktop.log"))
    {
        let _ = writeln!(file, "{} {message}", jiff::Timestamp::now());
    }
}

/// Where the updater keeps the outgoing build's `tessera`, for rollback.
pub fn previous_cli(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("previous/tessera"))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Shell::default())
        .menu(menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "check-updates" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { updates::check(&app, true).await });
            }
            "reload" => {
                if let Some(window) = app.get_webview_window(MAIN) {
                    let _ = window.reload();
                }
            }
            "undo" => history(app, false),
            "redo" => history(app, true),
            "show-log" => show_log(app.clone()),
            _ => (),
        })
        .on_window_event(|window, event| {
            // Closing hides, so the page and its unsent edits stay warm; Quit exits.
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == MAIN
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![retry, show_log])
        .setup(|app| {
            window(app.handle())?;
            tauri::async_runtime::spawn(start(app.handle().clone()));
            if updates::enabled() {
                tauri::async_runtime::spawn(updates::schedule(app.handle().clone()));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("cannot start Tessera")
        .run(|app, event| {
            if let RunEvent::Reopen { .. } = event
                && let Some(window) = app.get_webview_window(MAIN)
            {
                let _ = window.show();
                let _ = window.set_focus();
            }
        });
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let about = AboutMetadata {
        name: Some("Tessera".into()),
        version: Some(agent::identity(agent::VERSION, agent::BUILD)),
        copyright: app.config().bundle.copyright.clone(),
        ..AboutMetadata::default()
    };
    let separator = || PredefinedMenuItem::separator(app);
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "Tessera",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &MenuItem::with_id(
                        app,
                        "check-updates",
                        "Check for Updates…",
                        true,
                        None::<&str>,
                    )?,
                    &separator()?,
                    &PredefinedMenuItem::services(app, None)?,
                    &separator()?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &separator()?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&PredefinedMenuItem::close_window(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &MenuItem::with_id(app, "undo", "Undo", true, Some("CmdOrCtrl+Z"))?,
                    &MenuItem::with_id(app, "redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?,
                    &separator()?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?,
                    &separator()?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                ],
            )?,
            &Submenu::with_id_and_items(
                app,
                WINDOW_SUBMENU_ID,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &separator()?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
            &Submenu::with_id_and_items(
                app,
                HELP_SUBMENU_ID,
                "Help",
                true,
                &[&MenuItem::with_id(
                    app,
                    "show-log",
                    "Show Service Log",
                    true,
                    None::<&str>,
                )?],
            )?,
        ],
    )
}

/// Undo or Redo chosen from the menu. The page handles ⌘Z itself, so a
/// key press only reaches the menu when the page left it alone; replay it as
/// the page's own key event, and fall back to WebKit's undo for plain text
/// fields. The predefined items sent `undo:` straight to WebKit, which edits
/// the editor's DOM behind its back.
fn history(app: &AppHandle, redo: bool) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let script = format!(
        "(() => {{ const redo = {redo}; \
         const target = document.activeElement || document.body; \
         const event = new KeyboardEvent('keydown', {{ key: redo ? 'Z' : 'z', code: 'KeyZ', \
         metaKey: true, shiftKey: redo, bubbles: true, cancelable: true }}); \
         if (target.dispatchEvent(event)) document.execCommand(redo ? 'redo' : 'undo'); }})()"
    );
    let _ = window.eval(script);
}

fn window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let navigation = app.clone();
    let popup = app.clone();
    let download = app.clone();
    let loaded = app.clone();
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Tessera")
        .inner_size(1360.0, 860.0)
        .min_inner_size(640.0, 420.0)
        // The page takes dropped files itself (EPUB uploads); Tauri's handler
        // would swallow the drop before the DOM saw it.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if allowed(&navigation, url) {
                return true;
            }
            open_external(&navigation, url);
            false
        })
        .on_new_window(move |url, _| {
            open_external(&popup, &url);
            NewWindowResponse::Deny
        })
        .on_download(move |_, event| {
            let shell = download.state::<Shell>();
            match event {
                // WebKit already picked a free name in Downloads; remember it to reveal.
                DownloadEvent::Requested { destination, .. } => {
                    *shell.download.lock() = Some(destination.clone());
                }
                DownloadEvent::Finished { success, .. } => {
                    let path = shell.download.lock().take();
                    if let (true, Some(path)) = (success, path) {
                        let _ = download.opener().reveal_item_in_dir(path);
                    }
                }
                _ => (),
            }
            true
        })
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished && payload.url().scheme() == "tauri" {
                let status = loaded.state::<Shell>().status.lock().clone();
                if let (Some(script), Some(window)) = (status, loaded.get_webview_window(MAIN)) {
                    let _ = window.eval(script);
                }
            }
        })
        .build()
}

fn allowed(app: &AppHandle, url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" => true,
        _ => app
            .state::<Shell>()
            .origin
            .lock()
            .as_ref()
            .is_some_and(|origin| origin.origin() == url.origin()),
    }
}

fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// Show startup progress, or a failure with its details, on the splash page.
fn status(app: &AppHandle, title: &str, note: &str, detail: &str) {
    let script = format!(
        "window.showStatus({}, {}, {})",
        serde_json::Value::from(title),
        serde_json::Value::from(note),
        serde_json::Value::from(detail)
    );
    *app.state::<Shell>().status.lock() = Some(script.clone());
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.eval(script);
    }
}

#[tauri::command]
fn retry(app: AppHandle) {
    tauri::async_runtime::spawn(start(app));
}

#[tauri::command]
fn show_log(app: AppHandle) {
    let log = logs().join("serve.log");
    if app
        .opener()
        .open_path(log.to_string_lossy(), None::<&str>)
        .is_err()
    {
        let _ = app.opener().reveal_item_in_dir(logs());
    }
}

async fn start(app: AppHandle) {
    let shell = app.state::<Shell>();
    if shell.starting.swap(true, Ordering::SeqCst) {
        return;
    }
    status(&app, "Starting Tessera…", "", "");
    let prepared = prepare(&app).await;
    shell.starting.store(false, Ordering::SeqCst);
    let url = match prepared {
        Ok(url) => url,
        Err(detail) => {
            log(&detail);
            status(
                &app,
                "Tessera couldn’t start",
                "The notebook service did not answer. Nothing in the notebook was changed without a backup.",
                &detail,
            );
            return;
        }
    };
    *shell.origin.lock() = Some(url.clone());
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.navigate(url.clone());
    }
    if !shell.watching.swap(true, Ordering::SeqCst) {
        tauri::async_runtime::spawn(watch(app.clone(), url));
    }
}

/// Put the launch agent on this app's build if it is not already, and return
/// the service URL.
async fn prepare(app: &AppHandle) -> Result<Url, String> {
    if let Ok(url) = std::env::var("TESSERA_DESKTOP_URL") {
        return Url::parse(&url).map_err(|error| format!("TESSERA_DESKTOP_URL: {error}"));
    }
    let shell = app.state::<Shell>();
    let bundled = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .with_file_name("tessera");
    if !bundled.exists() {
        return Err(format!(
            "{} is missing; reinstall Tessera.",
            bundled.display()
        ));
    }
    let agent = Agent::read();
    let port = agent.port();
    let url =
        Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(|error| error.to_string())?;
    let ours = agent::identity(agent::VERSION, agent::BUILD);
    let running = agent::probe(&shell.client, port).await;
    if agent.runs(&bundled) && running.as_deref() == Some(ours.as_str()) {
        return Ok(url);
    }
    let mut state = State::load(app);
    if running.is_some() && state.failed.as_deref() == Some(ours.as_str()) {
        log(&format!(
            "{ours} failed to start before; staying on {}",
            running.as_deref().unwrap_or_default()
        ));
        return Ok(url);
    }
    status(
        app,
        if running.is_some() {
            "Updating Tessera…"
        } else {
            "Starting Tessera…"
        },
        "Backing up the notebook before this version opens it.",
        "",
    );
    // Roll back to the agent's other executable, or to the copy the updater
    // kept of the build it replaced inside this app.
    let rollback = agent
        .program
        .clone()
        .filter(|program| !agent.runs(&bundled) && program.exists())
        .or_else(|| previous_cli(app).filter(|path| path.exists()));
    log(&format!(
        "activating {ours} (was {}), rollback {:?}",
        running.as_deref().unwrap_or("not running"),
        rollback
    ));
    let activated = tauri::async_runtime::spawn_blocking(move || {
        agent::activate(&bundled, &agent, rollback.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?;
    match activated {
        Ok(()) => {
            if state.failed.take().is_some() {
                state.save(app);
            }
            Ok(url)
        }
        Err(detail) => {
            log(&detail);
            state.failed = Some(ours);
            state.save(app);
            if agent::probe(&shell.client, port).await.is_none() {
                return Err(detail);
            }
            app.dialog()
                .message(format!(
                    "Tessera {} could not start its notebook service, so the previous version is running. The notebook was restored from the backup taken just before.\n\n{}",
                    agent::VERSION,
                    tail(&detail, 1200)
                ))
                .title("Update didn’t start")
                .kind(MessageDialogKind::Warning)
                .show(|_| ());
            Ok(url)
        }
    }
}

fn tail(text: &str, limit: usize) -> &str {
    let start = text.len().saturating_sub(limit);
    let start = (start..text.len())
        .find(|&index| text.is_char_boundary(index))
        .unwrap_or(text.len());
    &text[start..]
}

/// Reload the page when another build starts serving, e.g. after `scripts/ship`
/// or a rollback, so the page and the service never disagree.
async fn watch(app: AppHandle, url: Url) {
    let port = url.port_or_known_default().unwrap_or(agent::DEFAULT_PORT);
    let client = app.state::<Shell>().client.clone();
    let mut shown = agent::probe(&client, port).await;
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let Some(serving) = agent::probe(&client, port).await else {
            continue;
        };
        if shown.as_ref().is_some_and(|shown| *shown != serving) {
            log(&format!("service is now {serving}; reloading"));
            if let Some(window) = app.get_webview_window(MAIN) {
                let _ = window.navigate(url.clone());
            }
        }
        shown = Some(serving);
    }
}
