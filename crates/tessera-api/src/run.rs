//! Run a workshop operation on a blocking thread natively, or inline in the browser worker.

#[cfg(native)]
#[path = "run_native.rs"]
mod imp;
#[cfg(browser)]
#[path = "run_browser.rs"]
mod imp;

use std::sync::Arc;

use parking_lot::Mutex;
use tessera_core::Notebook;

use crate::error::ApiError;

pub use imp::read_notebook;

/// A workshop read failed, or the blocking task was dropped.
pub enum NotebookError {
    Workshop(tessera_core::Error),
    Interrupted(String),
}

impl std::fmt::Display for NotebookError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Workshop(error) => write!(formatter, "{error}"),
            Self::Interrupted(error) => write!(formatter, "{error}"),
        }
    }
}

/// Run on a blocking runtime thread natively, or inline in the browser worker.
pub async fn run<T: Send + 'static>(
    notebook: &Arc<Mutex<Notebook>>,
    operation: impl FnOnce(&mut Notebook) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    read_notebook(notebook, operation)
        .await
        .map_err(|error| match error {
            NotebookError::Workshop(error) => ApiError::from(error),
            NotebookError::Interrupted(error) => ApiError::internal(error),
        })
}
