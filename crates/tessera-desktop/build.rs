fn main() {
    // The app is macOS-only; elsewhere the crate builds a stub that says so.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        tauri_build::build();
    }
}
