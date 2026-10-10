//! Tessera for macOS: a window onto the notebook service that keeps the
//! service's launch agent on this app's build and installs signed updates.

#[cfg(target_os = "macos")]
mod agent;
#[cfg(target_os = "macos")]
mod app;
#[cfg(target_os = "macos")]
mod opened_files;
#[cfg(target_os = "macos")]
mod updates;

#[cfg(target_os = "macos")]
fn main() {
    app::run();
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("The Tessera desktop app is macOS-only; run `tessera serve` instead.");
    std::process::exit(1);
}
