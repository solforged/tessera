//! The notebooks this computer knows, and switching the service between them. One service owns
//! one notebook, so a switch drains the service and restarts it on the chosen notebook at the same
//! ports. `GET /api/notebooks` lists them, `POST /api/notebooks/open` switches (creating an empty
//! notebook when asked), and `POST /api/notebooks/forget` drops one from the list without touching
//! its files.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{State, rejection::JsonRejection},
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tessera_core::{DATABASE_FILE, Notebook, NotebookOwnership};
use tokio::sync::watch;

use crate::{AppState, error::ApiError, paths, run};

/// The registry file and the notebook a service opens when none was named.
#[derive(Clone, Debug)]
pub struct Registry {
    pub path: PathBuf,
    pub default: PathBuf,
}

#[derive(Default, Deserialize, Serialize, PartialEq)]
pub(crate) struct Stored {
    /// The notebook last switched to by a service that follows the registry.
    #[serde(default)]
    pub(crate) current: Option<PathBuf>,
    #[serde(default)]
    pub(crate) notebooks: Vec<PathBuf>,
}

impl Registry {
    /// The XDG state registry and default workshop.
    pub fn platform() -> Option<Self> {
        Some(Self {
            path: paths::registry_file()?,
            default: paths::default_workshop()?,
        })
    }

    /// The workshop to open without `--workshop`: the last one switched to while it still holds
    /// a database, otherwise the default.
    pub fn startup(&self) -> PathBuf {
        match self.load() {
            Ok(Stored {
                current: Some(path),
                ..
            }) if path.join(DATABASE_FILE).is_file() => path,
            Ok(Stored {
                current: Some(path),
                ..
            }) => {
                tracing::warn!(path = %path.display(), "last workshop is gone; opening the default");
                self.default.clone()
            }
            Ok(_) => self.default.clone(),
            Err(error) => {
                tracing::warn!(%error, path = %self.path.display(), "cannot read the workshop list; opening the default");
                self.default.clone()
            }
        }
    }

    fn load(&self) -> io::Result<Stored> {
        let mut stored = self.load_raw()?;
        let count = stored.notebooks.len();
        stored.notebooks.retain(|path| {
            path == &self.default
                || Some(path) == stored.current.as_ref()
                || path.join(DATABASE_FILE).is_file()
        });
        if count != stored.notebooks.len() {
            self.save(&stored)?;
        }
        Ok(stored)
    }

    pub(crate) fn load_raw(&self) -> io::Result<Stored> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Stored::default()),
            Err(error) => Err(error),
        }
    }

    /// Replace the file atomically, so a crash leaves the old list or the new one.
    pub(crate) fn save(&self, stored: &Stored) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = self.path.with_extension("json.tmp");
        use std::io::Write;
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(stored)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &self.path)?;
        if let Some(parent) = self.path.parent() {
            std::fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    }
}

/// Switching state for a service started by `serve`. `remember` is set when the service follows
/// the registry rather than a `--workshop` argument, so a switch also changes what later starts open.
pub(crate) struct Switcher {
    registry: Registry,
    remember: bool,
    pub(crate) request: watch::Sender<Option<PathBuf>>,
    pub(crate) transition: Arc<tokio::sync::Mutex<()>>,
}

impl Switcher {
    pub(crate) fn new(
        registry: Registry,
        remember: bool,
        request: watch::Sender<Option<PathBuf>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            registry,
            remember,
            request,
            transition: Arc::new(tokio::sync::Mutex::new(())),
        })
    }
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/notebooks", get(list))
        .route("/api/notebooks/open", post(open))
        .route("/api/notebooks/forget", post(forget))
}

#[derive(Serialize)]
struct Entry {
    path: PathBuf,
    name: String,
    display_path: String,
    named: bool,
    current: bool,
    default: bool,
    /// False when the folder no longer holds a notebook database.
    available: bool,
}

#[derive(Serialize)]
struct Notebooks {
    notebooks: Vec<Entry>,
}

#[derive(Deserialize)]
struct OpenRequest {
    path: String,
    #[serde(default)]
    create: bool,
}

#[derive(Serialize)]
struct Opening {
    path: PathBuf,
}

#[derive(Deserialize)]
struct ForgetRequest {
    path: PathBuf,
}

fn switcher(state: &AppState) -> Result<Arc<Switcher>, ApiError> {
    state.switcher.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "This service cannot switch workshops.",
        )
    })
}

async fn current_path(state: &AppState) -> Result<PathBuf, ApiError> {
    run(state, |notebook| notebook.info().map(|info| info.path)).await
}

/// Paths are compared canonically; a missing folder keeps its spelling.
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn listing(registry: &Registry, current: &Path) -> io::Result<Notebooks> {
    let stored = registry.load()?;
    let default = canonical(&registry.default);
    // The default workshop lives in the workshops folder, so the registry names that folder itself and tests
    // never read the machine's own.
    let named_root = registry.default.parent().map(canonical);
    let mut paths = vec![default.clone()];
    for path in stored.notebooks.iter().map(|path| canonical(path)) {
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    // A workshop put in the workshops folder by hand or by a script is listed without being opened first.
    if let Some(root) = &named_root {
        let mut found: Vec<PathBuf> = match std::fs::read_dir(root) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.join(DATABASE_FILE).is_file())
                .map(|path| canonical(&path))
                .collect(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error),
        };
        found.sort();
        for path in found {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    if !paths.iter().any(|path| path == current) {
        paths.push(current.to_path_buf());
    }
    Ok(Notebooks {
        notebooks: paths
            .into_iter()
            .map(|path| Entry {
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.display().to_string()),
                current: path == current,
                default: path == default,
                available: path.join(DATABASE_FILE).is_file(),
                display_path: paths::display(&path),
                named: path.parent() == named_root.as_deref(),
                path,
            })
            .collect(),
    })
}

async fn list(State(state): State<AppState>) -> Result<Json<Notebooks>, ApiError> {
    let switcher = switcher(&state)?;
    let current = current_path(&state).await?;
    tokio::task::spawn_blocking(move || listing(&switcher.registry, &current))
        .await
        .map_err(ApiError::internal)?
        .map(Json)
        .map_err(ApiError::internal)
}

fn expand(path: &str) -> Result<PathBuf, ApiError> {
    let path = path.trim();
    if !path.is_empty()
        && !path.contains('/')
        && !path.starts_with(['~', '.'])
        && path.chars().count() <= 64
    {
        return paths::workshops_dir()
            .map(|directory| directory.join(path))
            .ok_or_else(|| ApiError::internal("no workshop directory"));
    }
    let expanded = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => dirs::home_dir()
            .ok_or_else(|| ApiError::internal("no home directory"))?
            .join(rest.trim_start_matches('/')),
        _ => PathBuf::from(path),
    };
    if !expanded.is_absolute() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_path",
            "Give a workshop name, such as reading, or a folder's full path, such as ~/Documents/reading.",
        ));
    }
    Ok(expanded)
}

/// Check the target can open before the current notebook stops: it exists (or may be created),
/// no other service owns it, and its database opens and migrates.
fn prepare(path: &Path, create: bool, current: &Path) -> Result<PathBuf, ApiError> {
    let conflict =
        |message: String| ApiError::new(StatusCode::CONFLICT, "invalid_notebook", message);
    if !path.join(DATABASE_FILE).is_file() {
        if !create {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "no_notebook",
                format!("{} holds no Tessera workshop.", path.display()),
            ));
        }
        if path.exists() {
            let mut entries = std::fs::read_dir(path).map_err(|error| {
                conflict(format!(
                    "{} is not a usable folder: {error}",
                    path.display()
                ))
            })?;
            if entries.next().is_some() {
                return Err(conflict(format!(
                    "{} already holds other files. Choose a new or empty folder.",
                    path.display()
                )));
            }
        }
    }
    std::fs::create_dir_all(path)
        .map_err(|error| conflict(format!("Cannot create {}: {error}", path.display())))?;
    let path = canonical(path);
    if path == current {
        return Err(conflict("That workshop is already open.".into()));
    }
    let ownership = NotebookOwnership::acquire(&path, 0).map_err(|error| {
        if error.kind() == io::ErrorKind::WouldBlock {
            ApiError::new(StatusCode::CONFLICT, "notebook_busy", error.to_string())
        } else {
            ApiError::internal(error)
        }
    })?;
    Notebook::open(&path).map_err(ApiError::from)?;
    drop(ownership);
    Ok(path)
}

async fn open(
    State(state): State<AppState>,
    body: Result<Json<OpenRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<Opening>), ApiError> {
    let Json(request) = body.map_err(ApiError::from)?;
    let switcher = switcher(&state)?;
    let guard = switcher.transition.clone().try_lock_owned().map_err(|_| {
        ApiError::new(
            StatusCode::CONFLICT,
            "switching",
            "Another workshop is already opening.",
        )
    })?;
    if switcher.request.borrow().is_some() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "switching",
            "Another workshop is already opening.",
        ));
    }
    let target = expand(&request.path)?;
    let current = current_path(&state).await?;
    let worker = Arc::clone(&switcher);
    let path = tokio::task::spawn_blocking(move || {
        // A cancelled request must not let another transition overtake this one.
        let _guard = guard;
        let path = prepare(&target, request.create, &current)?;
        let mut stored = worker.registry.load().map_err(ApiError::internal)?;
        // Keep the notebook being left on the list, so the switcher can come back to it.
        for known in [current, path.clone()] {
            if !stored.notebooks.contains(&known) {
                stored.notebooks.push(known);
            }
        }
        if worker.remember {
            stored.current = Some(path.clone());
        }
        worker.registry.save(&stored).map_err(ApiError::internal)?;
        tracing::info!(path = %path.display(), "switching workshop");
        worker.request.send_replace(Some(path.clone()));
        Ok::<_, ApiError>(path)
    })
    .await
    .map_err(ApiError::internal)??;
    Ok((StatusCode::ACCEPTED, Json(Opening { path })))
}

async fn forget(
    State(state): State<AppState>,
    body: Result<Json<ForgetRequest>, JsonRejection>,
) -> Result<Json<Notebooks>, ApiError> {
    let Json(request) = body.map_err(ApiError::from)?;
    let switcher = switcher(&state)?;
    let current = current_path(&state).await?;
    tokio::task::spawn_blocking(move || {
        let registry = &switcher.registry;
        let path = canonical(&request.path);
        if path == current || path == canonical(&registry.default) {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "invalid_notebook",
                "The open workshop and the default workshop stay on the list.",
            ));
        }
        let mut stored = registry.load().map_err(ApiError::internal)?;
        stored
            .notebooks
            .retain(|known| known != &request.path && canonical(known) != path);
        if stored
            .current
            .as_ref()
            .is_some_and(|known| canonical(known) == path)
        {
            stored.current = None;
        }
        registry.save(&stored).map_err(ApiError::internal)?;
        listing(registry, &current).map_err(ApiError::internal)
    })
    .await
    .map_err(ApiError::internal)?
    .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loading_prunes_missing_entries_but_keeps_current_and_default() {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry {
            path: root.path().join("workshops.json"),
            default: root.path().join("main"),
        };
        let current = root.path().join("current");
        let available = root.path().join("available");
        std::fs::create_dir(&available).unwrap();
        std::fs::write(available.join(DATABASE_FILE), b"database").unwrap();
        registry
            .save(&Stored {
                current: Some(current.clone()),
                notebooks: vec![
                    registry.default.clone(),
                    current.clone(),
                    available.clone(),
                    root.path().join("gone"),
                ],
            })
            .unwrap();
        let listed = listing(&registry, &current).unwrap();
        assert_eq!(listed.notebooks.len(), 3);
        assert!(
            listed
                .notebooks
                .iter()
                .any(|entry| entry.current && !entry.available)
        );
        assert!(
            listed
                .notebooks
                .iter()
                .any(|entry| entry.default && !entry.available)
        );
        assert!(
            listed
                .notebooks
                .iter()
                .any(|entry| entry.path == canonical(&available) && entry.available)
        );
        assert_eq!(registry.load_raw().unwrap().notebooks.len(), 3);
    }

    #[test]
    fn names_have_a_bounded_plain_component_and_paths_stay_absolute() {
        let root = paths::workshops_dir().unwrap();
        assert_eq!(expand("reading").ok(), Some(root.join("reading")));
        assert_eq!(
            expand(&"é".repeat(64)).ok(),
            Some(root.join("é".repeat(64)))
        );
        for invalid in [
            "",
            " ",
            ".",
            "..",
            ".hidden",
            "./reading",
            "folder/reading",
            "~other",
        ] {
            assert!(expand(invalid).is_err(), "{invalid:?}");
        }
        assert!(expand(&"a".repeat(65)).is_err());
        assert_eq!(
            expand("/tmp/reading").ok(),
            Some(PathBuf::from("/tmp/reading"))
        );
        assert_eq!(
            expand("~/Workshops/reading").ok(),
            Some(dirs::home_dir().unwrap().join("Workshops/reading"))
        );
    }
}
