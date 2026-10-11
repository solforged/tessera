//! Cmd+Shift+E opens the notebook's sheet when it is focused, or a reusable
//! floating capture page otherwise. The page completes through a cancelled
//! navigation, so the loopback service needs no privileged remote IPC access.

use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSRunningApplication,
    NSWindowCollectionBehavior, NSWorkspace,
};
use parking_lot::Mutex;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, PhysicalPosition, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::app::{self, MAIN};

pub const LABEL: &str = "capture";
const WIDTH: f64 = 600.0;
const HEIGHT: f64 = 340.0;
const OPEN_MAIN: &str = "window.dispatchEvent(new CustomEvent('tessera-quick-capture'))";
const OPEN_PANEL: &str = "window.dispatchEvent(new Event('tessera-quick-capture'))";
const DONE_URL: &str = "tessera-capture://done";
const BRIDGE: &str =
    "window.__tesseraCaptureDone = () => { window.location.href = 'tessera-capture://done'; };";

#[derive(Default)]
pub struct Capture {
    /// Some while shown, holding the process to give focus back to on
    /// completion. Repeated shortcuts must not overwrite the original app.
    return_to: Mutex<Option<Option<i32>>>,
}

pub fn register(app: &AppHandle) {
    let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyE);
    if let Err(error) = app
        .global_shortcut()
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                let handle = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    if let Err(error) = show(&handle) {
                        app::log(&format!("cannot show capture: {error}"));
                    }
                }) {
                    app::log(&format!("cannot dispatch capture shortcut: {error}"));
                }
            }
        })
    {
        // A shortcut claimed by another app must not prevent the notebook opening.
        app::log(&format!("cannot register Cmd+Shift+E: {error}"));
    }
}

/// File > New Capture always uses the notebook, including from a hidden window.
pub fn in_main(app: &AppHandle) {
    dismiss(app, false);
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.eval(OPEN_MAIN);
    }
}

fn show(app: &AppHandle) -> tauri::Result<()> {
    if let Some(main) = app.get_webview_window(MAIN)
        && main.is_visible()?
        && main.is_focused()?
    {
        return main.eval(OPEN_MAIN);
    }
    let Some(origin) = app::origin(app) else {
        if let Some(main) = app.get_webview_window(MAIN) {
            main.unminimize()?;
            main.show()?;
            main.set_focus()?;
        }
        return Ok(());
    };
    // Shortcut handlers are dispatched to the main thread before touching AppKit.
    let mtm = MainThreadMarker::new().expect("capture runs on the main thread");
    let native_app = NSApplication::sharedApplication(mtm);
    // The app in front before the shortcut, when it was not Tessera.
    let previous = (!native_app.isActive())
        .then(|| NSWorkspace::sharedWorkspace().frontmostApplication())
        .flatten()
        .map(|other| other.processIdentifier());
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => window(app, origin, &native_app)?,
    };
    position(app, &window)?;
    app.state::<Capture>()
        .return_to
        .lock()
        .get_or_insert(previous);
    if let Err(error) = window.show().and_then(|()| window.set_focus()) {
        dismiss(app, true);
        return Err(error);
    }
    // On the first load the page focuses itself; subsequent shows reuse its draft.
    window.eval(OPEN_PANEL)
}

fn dismiss(app: &AppHandle, restore: bool) {
    // Take before hiding: hiding can itself cause another Focused(false) event.
    let Some(return_to) = app.state::<Capture>().return_to.lock().take() else {
        return;
    };
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
    if restore && let Some(pid) = return_to {
        // Reactivate the app the shortcut came from so the notebook window stays
        // where it was; hiding Tessera is the fallback if that app has gone.
        #[allow(deprecated)]
        let activated = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .is_some_and(|other| {
                other.activateWithOptions(NSApplicationActivationOptions::empty())
            });
        if !activated {
            let _ = app.hide();
        }
    }
}

fn done(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || dismiss(&handle, true)) {
        app::log(&format!("cannot dismiss capture: {error}"));
    }
}

fn capture_url(mut origin: Url) -> Url {
    origin.set_path("/");
    origin.set_query(Some("capture"));
    origin.set_fragment(None);
    origin
}

fn window(
    app: &AppHandle,
    origin: Url,
    native_app: &NSApplication,
) -> tauri::Result<WebviewWindow> {
    let navigation = app.clone();
    let popup = app.clone();
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(capture_url(origin)))
        .title("New Capture")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .focused(false)
        .initialization_script(BRIDGE)
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if url.as_str() == DONE_URL {
                done(&navigation);
                return false;
            }
            if app::allowed(&navigation, url) {
                return true;
            }
            app::open_external(&navigation, url);
            false
        })
        .on_new_window(move |url, _| {
            app::open_external(&popup, &url);
            NewWindowResponse::Deny
        })
        .on_download(|_, _| false)
        .build()?;
    // Borrow the native window safely from AppKit's owned list, rather than
    // dereferencing Tauri's raw pointer (the workspace forbids unsafe code).
    let pointer = window.ns_window()?;
    for native in native_app.windows() {
        if std::ptr::eq(&*native, pointer.cast()) {
            native.setExcludedFromWindowsMenu(true);
            let mut behavior = native.collectionBehavior();
            behavior.remove(
                NSWindowCollectionBehavior::FullScreenPrimary
                    | NSWindowCollectionBehavior::FullScreenNone,
            );
            behavior.insert(NSWindowCollectionBehavior::FullScreenAuxiliary);
            native.setCollectionBehavior(behavior);
            break;
        }
    }
    let events = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Focused(false) => done(&events),
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            done(&events);
        }
        _ => (),
    });
    Ok(window)
}

fn position(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    let cursor = app.cursor_position()?;
    let monitor = match app.monitor_from_point(cursor.x, cursor.y)? {
        Some(monitor) => Some(monitor),
        None => app.primary_monitor()?,
    };
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        window.set_position(panel_position(
            area.position.x as f64,
            area.position.y as f64,
            area.size.width as f64,
            area.size.height as f64,
            monitor.scale_factor(),
        ))?;
    }
    Ok(())
}

/// Keep screen origins in physical coordinates: mixed-DPI displays do not share
/// a logical coordinate system. Centre the panel at one third of the work area.
fn panel_position(x: f64, y: f64, width: f64, height: f64, scale: f64) -> PhysicalPosition<f64> {
    PhysicalPosition::new(
        x + ((width - WIDTH * scale) / 2.0).max(0.0),
        y + (height / 3.0 - HEIGHT * scale / 2.0).max(0.0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_uses_service_origin_with_only_capture_query() {
        let url = Url::parse("http://127.0.0.1:12345/old?other=1#anchor").unwrap();
        assert_eq!(capture_url(url).as_str(), "http://127.0.0.1:12345/?capture");
    }

    #[test]
    fn completion_navigation_matches_bridge() {
        assert_eq!(Url::parse(DONE_URL).unwrap().as_str(), DONE_URL);
        assert!(BRIDGE.contains(DONE_URL));
    }

    #[test]
    fn panel_uses_cursor_monitors_physical_origin_and_scale() {
        assert_eq!(
            panel_position(-2560.0, 40.0, 2560.0, 1400.0, 2.0),
            PhysicalPosition::new(-1880.0, 40.0 + 1400.0 / 3.0 - 340.0),
        );
        assert_eq!(
            panel_position(1920.0, -900.0, 1200.0, 900.0, 1.0),
            PhysicalPosition::new(2220.0, -770.0),
        );
    }

    #[test]
    fn panel_does_not_start_outside_small_work_area() {
        assert_eq!(
            panel_position(0.0, 30.0, 500.0, 400.0, 1.0),
            PhysicalPosition::new(0.0, 30.0),
        );
    }
}
