fn main() {
    // The app runs on Android and iOS; elsewhere the crate builds an empty library.
    if matches!(
        std::env::var("CARGO_CFG_TARGET_OS").as_deref(),
        Ok("android" | "ios")
    ) {
        tauri_build::build();
    }
}
