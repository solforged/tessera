fn main() {
    // The app is Android-only; elsewhere the crate builds an empty library.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        tauri_build::build();
    }
}
