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
    AppHandle, LogicalSize, Manager, PhysicalPosition, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::app::{self, MAIN};

pub const LABEL: &str = "capture";
const WIDTH: f64 = 600.0;
const MAX_HEIGHT: f64 = 560.0;
const OPEN_MAIN: &str = "window.dispatchEvent(new CustomEvent('tessera-quick-capture'))";
const OPEN_PANEL: &str = "window.dispatchEvent(new CustomEvent('tessera-quick-capture'))";
const DONE_URL: &str = "tessera-capture://done";
const BRIDGE: &str = "
    window.__tesseraCaptureDone = () => { window.location.href = 'tessera-capture://done'; };
    window.__tesseraCaptureOpen = targetJson => {
        window.location.href = 'tessera-capture://open?target=' + encodeURIComponent(targetJson);
    };
    window.__tesseraCaptureSize = height => {
        window.location.href = 'tessera-capture://size?height=' + height;
    };
";

#[derive(Default)]
pub struct Capture {
    /// Some while shown, holding the process to give focus back to on
    /// completion. Repeated shortcuts must not overwrite the original app.
    return_to: Mutex<Option<Option<i32>>>,
    /// Selected service text waits for the panel's mounted size bridge.
    pending_text: Mutex<Option<String>>,
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

/// File > Add to Today always uses the notebook, including from a hidden window.
pub fn in_main(app: &AppHandle) {
    dismiss(app, false);
    app::command(app, "shell.capture");
}

fn show(app: &AppHandle) -> tauri::Result<()> {
    if let Some(main) = app.get_webview_window(MAIN)
        && main.is_visible()?
        && main.is_focused()?
    {
        return main.eval(OPEN_MAIN);
    }
    show_panel(app)
}

/// Services always use the floating panel, even while the notebook is focused.
pub fn from_service(app: &AppHandle, text: String) -> tauri::Result<()> {
    *app.state::<Capture>().pending_text.lock() = Some(text);
    show_panel(app)
}

/// A service can launch Tessera before its notebook service has become ready.
pub fn ready(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let pending = handle.state::<Capture>().pending_text.lock().is_some();
        if pending && let Err(error) = show_panel(&handle) {
            app::log(&format!("cannot show service capture: {error}"));
        }
    }) {
        app::log(&format!("cannot dispatch service capture: {error}"));
    }
}

fn show_panel(app: &AppHandle) -> tauri::Result<()> {
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
    // The page reports its current content size before showing, including on
    // reuse. The first load waits for fonts so no oversized panel flashes open.
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

fn requested_page(url: &Url) -> Option<serde_json::Value> {
    if url.scheme() != "tessera-capture" || url.host_str() != Some("open") {
        return None;
    }
    let target = url.query_pairs().find(|(key, _)| key == "target")?.1;
    let target: serde_json::Value = serde_json::from_str(&target).ok()?;
    let object = target.as_object()?;
    (object.get("kind")?.as_str() == Some("page") && object.get("pageId")?.is_string())
        .then_some(target)
}

fn page_event(target: &serde_json::Value) -> String {
    format!("window.dispatchEvent(new CustomEvent('tessera-open', {{ detail: {target} }}))")
}

fn open_in_main(app: &AppHandle, target: serde_json::Value) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        // Take the return target before hiding so Focused(false) cannot restore
        // the previous app after we bring the created page forward.
        dismiss(&handle, false);
        let Some(window) = handle.get_webview_window(MAIN) else {
            return;
        };
        let result = (|| -> tauri::Result<()> {
            window.unminimize()?;
            window.show()?;
            window.set_focus()?;
            window.eval(page_event(&target))
        })();
        if let Err(error) = result {
            app::log(&format!("cannot open captured page: {error}"));
        }
    }) {
        app::log(&format!("cannot dispatch captured page: {error}"));
    }
}

fn requested_height(url: &Url) -> Option<f64> {
    if url.scheme() != "tessera-capture" || url.host_str() != Some("size") {
        return None;
    }
    let height = url.query_pairs().find(|(key, _)| key == "height")?.1;
    let height: f64 = height.parse().ok()?;
    (height.is_finite() && height > 0.0).then(|| height.ceil().min(MAX_HEIGHT))
}

fn resize(app: &AppHandle, height: f64) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(LABEL) else {
            return;
        };
        let result = (|| -> tauri::Result<()> {
            // Restore the physical top-left after resizing. AppKit's resize
            // origin policy must not move the panel as status rows come and go.
            let top_left = window.outer_position()?;
            window.set_size(LogicalSize::new(WIDTH, height))?;
            window.set_position(top_left)?;
            if handle.state::<Capture>().return_to.lock().is_some() && !window.is_visible()? {
                window.show()?;
                window.set_focus()?;
            }
            // The size bridge is called only after CaptureWindow has mounted
            // its listener. Taking first also prevents a resize/event loop.
            let text = handle.state::<Capture>().pending_text.lock().take();
            if let Some(text) = text {
                window.eval(service_event(&text))?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            app::log(&format!("cannot size capture: {error}"));
            dismiss(&handle, true);
        }
    }) {
        app::log(&format!("cannot dispatch capture size: {error}"));
    }
}

fn service_event(text: &str) -> String {
    let detail = serde_json::json!({ "kind": "note", "text": text });
    format!(
        "window.dispatchEvent(new CustomEvent('tessera-quick-capture', {{ detail: {detail} }}))"
    )
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
        .inner_size(WIDTH, MAX_HEIGHT)
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
            if url.scheme() == "tessera-capture" && url.host_str() == Some("open") {
                if let Some(target) = requested_page(url) {
                    open_in_main(&navigation, target);
                }
                return false;
            }
            if url.scheme() == "tessera-capture" && url.host_str() == Some("size") {
                if let Some(height) = requested_height(url) {
                    resize(&navigation, height);
                }
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
/// a logical coordinate system. Anchor the top edge of the maximum-height panel
/// at one third of the work area, independently of its current content height.
fn panel_position(x: f64, y: f64, width: f64, height: f64, scale: f64) -> PhysicalPosition<f64> {
    PhysicalPosition::new(
        x + ((width - WIDTH * scale) / 2.0).max(0.0),
        y + (height / 3.0 - MAX_HEIGHT * scale / 2.0).max(0.0),
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
    fn size_navigation_uses_positive_logical_heights_up_to_cap() {
        for (height, expected) in [("114", 114.0), ("114.2", 115.0), ("900", MAX_HEIGHT)] {
            let url = Url::parse(&format!("tessera-capture://size?height={height}")).unwrap();
            assert_eq!(requested_height(&url), Some(expected));
        }
        assert!(BRIDGE.contains("tessera-capture://size?height="));
    }

    #[test]
    fn size_navigation_rejects_invalid_heights_and_other_targets() {
        for value in ["0", "-1", "NaN", "inf", "text", ""] {
            let url = Url::parse(&format!("tessera-capture://size?height={value}")).unwrap();
            assert_eq!(requested_height(&url), None);
        }
        assert_eq!(requested_height(&Url::parse(DONE_URL).unwrap()), None);
        assert_eq!(
            requested_height(&Url::parse("https://size?height=114").unwrap()),
            None,
        );
    }

    #[test]
    fn panel_uses_cursor_monitors_physical_origin_and_scale() {
        assert_eq!(
            panel_position(-2560.0, 40.0, 2560.0, 1400.0, 2.0),
            PhysicalPosition::new(-1880.0, 40.0),
        );
        assert_eq!(
            panel_position(1920.0, -900.0, 1200.0, 900.0, 1.0),
            PhysicalPosition::new(2220.0, -880.0),
        );
    }

    #[test]
    fn panel_does_not_start_outside_small_work_area() {
        assert_eq!(
            panel_position(0.0, 30.0, 500.0, 400.0, 1.0),
            PhysicalPosition::new(0.0, 30.0),
        );
    }

    #[test]
    fn service_selection_is_json_not_executable_script() {
        let text = "a 'quote', \"double quote\", \\ slash\n雪 </script>";
        let script = service_event(text);
        let detail = script
            .strip_prefix(
                "window.dispatchEvent(new CustomEvent('tessera-quick-capture', { detail: ",
            )
            .unwrap()
            .strip_suffix(" }))")
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(detail).unwrap(),
            serde_json::json!({ "kind": "note", "text": text }),
        );
    }

    #[test]
    fn page_navigation_preserves_json_without_executable_script() {
        let target = serde_json::json!({
            "kind": "page",
            "pageId": "'); window.bad = true; // \"quote\" \\ slash\n雪 &+?# </script>",
            "focus": "title",
        });
        let mut url = Url::parse("tessera-capture://open").unwrap();
        url.query_pairs_mut()
            .append_pair("target", &target.to_string());
        let parsed = requested_page(&url).unwrap();
        assert_eq!(parsed, target);
        let script = page_event(&parsed);
        let detail = script
            .strip_prefix("window.dispatchEvent(new CustomEvent('tessera-open', { detail: ")
            .unwrap()
            .strip_suffix(" }))")
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(detail).unwrap(),
            target
        );
    }

    #[test]
    fn page_navigation_rejects_invalid_json_and_non_page_targets() {
        for target in [
            "",
            "{",
            "null",
            "true",
            "1",
            "\"page\"",
            "[]",
            "{}",
            r#"{"kind":"page"}"#,
            r#"{"pageId":"p"}"#,
            r#"{"kind":"journal","pageId":"p"}"#,
            r#"{"kind":1,"pageId":"p"}"#,
            r#"{"kind":"page","pageId":null}"#,
            r#"{"kind":"page","pageId":1}"#,
            r#"{"kind":"page","pageId":[]}"#,
        ] {
            let mut url = Url::parse("tessera-capture://open").unwrap();
            url.query_pairs_mut().append_pair("target", target);
            assert_eq!(requested_page(&url), None, "{target}");
        }
        assert_eq!(
            requested_page(&Url::parse("tessera-capture://open").unwrap()),
            None,
        );
        for address in [
            "https://open",
            "tessera-capture://done",
            "tessera-capture://size",
        ] {
            let mut url = Url::parse(address).unwrap();
            url.query_pairs_mut()
                .append_pair("target", r#"{"kind":"page","pageId":"p"}"#);
            assert_eq!(requested_page(&url), None, "{address}");
        }
    }
}
