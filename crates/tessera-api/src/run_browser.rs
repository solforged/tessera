use std::sync::Arc;

use parking_lot::Mutex;
use tessera_core::Notebook;

use super::{NotebookError, Readers};

pub async fn read_notebook<T: Send + 'static>(
    notebook: &Arc<Mutex<Notebook>>,
    operation: impl FnOnce(&mut Notebook) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, NotebookError> {
    operation(&mut notebook.lock()).map_err(NotebookError::Workshop)
}

/// The browser's file system gives the workshop one connection, so a read
/// takes its turn on it.
pub async fn read_snapshot<T: Send + 'static>(
    notebook: &Arc<Mutex<Notebook>>,
    _readers: Option<&Readers>,
    operation: impl FnOnce(&Notebook) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, NotebookError> {
    operation(&notebook.lock()).map_err(NotebookError::Workshop)
}
