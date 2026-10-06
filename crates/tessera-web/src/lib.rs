//! Browser-only notebook runtime. Native workspace builds intentionally have no exports.

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod browser;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub use browser::*;
