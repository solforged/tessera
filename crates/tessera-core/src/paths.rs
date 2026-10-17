//! Where Tessera keeps things on a desktop computer. Every platform follows the XDG base
//! directories, so a Mac uses `~/.local/share/tessera` rather than `~/Library`:
//!
//! - data (`$XDG_DATA_HOME/tessera`): `workshops/<name>/` and `backups/<workshop id>/`.
//! - state (`$XDG_STATE_HOME/tessera`): `workshops.json`, the agent settings and `logs/`.
//! - cache (`$XDG_CACHE_HOME/tessera`): downloads that can be fetched again.
//!
//! A base variable counts only when it holds an absolute path, as the XDG specification asks.

use std::path::{Path, PathBuf};

const APP: &str = "tessera";

/// The folder a workshop gets when it was created by name and when none was chosen.
pub const DEFAULT_WORKSHOP: &str = "main";

fn base(variable: &str, fallback: &[&str]) -> Option<PathBuf> {
    if let Some(value) = std::env::var_os(variable) {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            return Some(path.join(APP));
        }
    }
    let mut path = dirs::home_dir()?;
    path.extend(fallback);
    Some(path.join(APP))
}

/// `$XDG_DATA_HOME/tessera`, by default `~/.local/share/tessera`.
pub fn data_dir() -> Option<PathBuf> {
    base("XDG_DATA_HOME", &[".local", "share"])
}

/// `$XDG_STATE_HOME/tessera`, by default `~/.local/state/tessera`.
pub fn state_dir() -> Option<PathBuf> {
    base("XDG_STATE_HOME", &[".local", "state"])
}

/// `$XDG_CACHE_HOME/tessera`, by default `~/.cache/tessera`.
pub fn cache_dir() -> Option<PathBuf> {
    base("XDG_CACHE_HOME", &[".cache"])
}

/// The folder that holds workshops created by name.
pub fn workshops_dir() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("workshops"))
}

/// The workshop a service opens when none was named and none was switched to.
pub fn default_workshop() -> Option<PathBuf> {
    workshops_dir().map(|dir| dir.join(DEFAULT_WORKSHOP))
}

/// The backup store: one folder per workshop id, wherever the workshop itself lives.
pub fn backups_dir() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("backups"))
}

/// The list of workshops this computer knows and the one last switched to.
pub fn registry_file() -> Option<PathBuf> {
    state_dir().map(|dir| dir.join("workshops.json"))
}

/// Service and app logs.
pub fn logs_dir() -> Option<PathBuf> {
    state_dir().map(|dir| dir.join("logs"))
}

/// `path` with the home directory written as `~`, for showing a location to a person. Listed paths are
/// canonical, so a home reached through a symlink (`/tmp` on macOS) is matched in its canonical form too.
pub fn display(path: &Path) -> String {
    let rest = dirs::home_dir().and_then(|home| {
        let canonical = std::fs::canonicalize(&home).unwrap_or_else(|_| home.clone());
        [home, canonical]
            .iter()
            .find_map(|home| path.strip_prefix(home).ok().map(Path::to_path_buf))
    });
    match rest {
        Some(rest) if rest.as_os_str().is_empty() => "~".to_owned(),
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}
