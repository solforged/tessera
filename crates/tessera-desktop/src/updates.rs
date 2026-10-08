//! Signed updates from the latest GitHub release. The new bundle replaces
//! this one only when the user agrees to restart; the restarted app then
//! moves the service onto it with a backup first.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::agent;
use crate::app::{log, previous_cli};

static CHECKING: AtomicBool = AtomicBool::new(false);
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Only an app bundle can replace itself; a development binary or a window
/// pointed at another service never updates.
pub fn enabled() -> bool {
    std::env::var_os("TESSERA_DESKTOP_URL").is_none()
        && std::env::current_exe()
            .is_ok_and(|path| path.to_string_lossy().contains(".app/Contents/MacOS/"))
}

pub async fn schedule(app: AppHandle) {
    tokio::time::sleep(Duration::from_secs(60)).await;
    loop {
        check(&app, false).await;
        tokio::time::sleep(INTERVAL).await;
    }
}

pub async fn check(app: &AppHandle, interactive: bool) {
    if !enabled() {
        if interactive {
            message(
                app,
                MessageDialogKind::Info,
                "Updates are off",
                "This copy of Tessera is not running from Tessera.app, so it does not update itself.",
            )
            .await;
        }
        return;
    }
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let result = update(app, interactive).await;
    CHECKING.store(false, Ordering::SeqCst);
    if let Err(error) = result {
        log(&format!("update: {error}"));
        if interactive {
            message(
                app,
                MessageDialogKind::Error,
                "Couldn’t check for updates",
                &error,
            )
            .await;
        }
    }
}

async fn update(app: &AppHandle, interactive: bool) -> Result<(), String> {
    let found = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let Some(update) = found else {
        if interactive {
            message(
                app,
                MessageDialogKind::Info,
                "Tessera is up to date",
                &format!("Version {} is the newest.", agent::VERSION),
            )
            .await;
        }
        return Ok(());
    };
    log(&format!("downloading {}", update.version));
    let bytes = update
        .download(|_, _| (), || ())
        .await
        .map_err(|error| error.to_string())?;
    let dialog = app
        .dialog()
        .message(
            "Restart now to finish updating. Tessera backs up the notebook before the new version opens it.",
        )
        .title(format!("Tessera {} is ready", update.version))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Restart Now".into(),
            "Later".into(),
        ));
    let restart = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
        .await
        .unwrap_or(false);
    if !restart {
        return Ok(());
    }
    keep_previous(app)?;
    update.install(&bytes).map_err(|error| error.to_string())?;
    log(&format!("installed {}; restarting", update.version));
    app.restart();
}

/// Copy this build's `tessera` aside: the update replaces the whole bundle,
/// and the restarted app rolls the service back to this copy if the new one
/// does not start.
fn keep_previous(app: &AppHandle) -> Result<(), String> {
    let bundled = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .with_file_name("tessera");
    let previous = previous_cli(app).ok_or("no app data directory")?;
    let staged = previous.with_extension("next");
    std::fs::create_dir_all(previous.parent().ok_or("no parent directory")?)
        .and_then(|()| std::fs::copy(&bundled, &staged))
        .and_then(|_| std::fs::rename(&staged, &previous))
        .map_err(|error| format!("cannot keep the current build for rollback: {error}"))
}

async fn message(app: &AppHandle, kind: MessageDialogKind, title: &str, text: &str) {
    let dialog = app.dialog().message(text).title(title).kind(kind);
    let _ = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show()).await;
}
