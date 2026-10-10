//! Tessera for Android. The notebook runs in this app's process, in app-private
//! storage, and the web interface reaches its API over Tauri IPC rather than a
//! network socket that other apps on the device could connect to.

#[cfg(target_os = "android")]
mod host;

#[cfg(target_os = "android")]
#[allow(unsafe_code)]
#[tauri::mobile_entry_point]
pub fn run() {
    host::run();
}
