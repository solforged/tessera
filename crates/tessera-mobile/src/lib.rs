//! Tessera for Android and iOS. The notebook runs in this app's process, in
//! app-private storage, and the web interface reaches its API over Tauri IPC
//! rather than a network socket that other apps on the device could connect to.

#[cfg(any(target_os = "android", target_os = "ios"))]
mod host;

#[cfg(any(target_os = "android", target_os = "ios"))]
#[allow(unsafe_code)]
#[tauri::mobile_entry_point]
pub fn run() {
    host::run();
}
