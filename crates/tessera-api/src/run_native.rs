use std::sync::Arc;

use parking_lot::Mutex;
use tessera_core::Notebook;

use super::{NotebookError, Readers};

pub async fn read_notebook<T: Send + 'static>(
    notebook: &Arc<Mutex<Notebook>>,
    operation: impl FnOnce(&mut Notebook) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, NotebookError> {
    let notebook = notebook.clone();
    tokio::task::spawn_blocking(move || {
        let mut notebook = notebook.lock();
        operation(&mut notebook).map_err(NotebookError::Workshop)
    })
    .await
    .map_err(|error| NotebookError::Interrupted(error.to_string()))?
}

pub async fn read_snapshot<T: Send + 'static>(
    notebook: &Arc<Mutex<Notebook>>,
    readers: Option<&Readers>,
    operation: impl FnOnce(&Notebook) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, NotebookError> {
    let notebook = notebook.clone();
    let readers = readers.cloned();
    tokio::task::spawn_blocking(move || {
        match readers {
            Some(readers) => readers.free().read(operation),
            None => operation(&notebook.lock()),
        }
        .map_err(NotebookError::Workshop)
    })
    .await
    .map_err(|error| NotebookError::Interrupted(error.to_string()))?
}
