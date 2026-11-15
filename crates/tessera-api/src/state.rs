use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use parking_lot::Mutex;
use tessera_core::Notebook;
use tokio::sync::broadcast;

use crate::error::ApiError;
use crate::library::{self, Library};

/// Reads one stored file. The native service installs a reader that fetches a
/// missing file from the replica's hub; the browser reads the local store.
pub type ObjectReader = Arc<
    dyn Fn(
            Arc<Mutex<Notebook>>,
            String,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, ApiError>> + Send>>
        + Send
        + Sync,
>;

/// The workshop connection, its change wakeups, and the library worker.
#[derive(Clone)]
pub struct WorkshopState {
    pub notebook: Arc<Mutex<Notebook>>,
    pub changes: broadcast::Sender<i64>,
    pub library: Library,
    objects: ObjectReader,
}

impl WorkshopState {
    /// Open the library worker on an already wrapped notebook.
    pub fn from_notebook(notebook: Arc<Mutex<Notebook>>) -> Result<Self, String> {
        let changes = broadcast::channel(256).0;
        let library = Library::start(notebook.clone(), changes.clone(), library::extract)?;
        Ok(Self {
            notebook,
            changes,
            library,
            objects: Arc::new(local_object),
        })
    }

    pub fn open(notebook: Notebook) -> Result<Self, String> {
        Self::from_notebook(Arc::new(Mutex::new(notebook)))
    }

    /// Assemble state when the library worker was already started, as tests do with a fake extractor.
    pub fn from_parts(
        notebook: Arc<Mutex<Notebook>>,
        changes: broadcast::Sender<i64>,
        library: Library,
    ) -> Self {
        Self {
            notebook,
            changes,
            library,
            objects: Arc::new(local_object),
        }
    }

    pub fn with_objects(mut self, objects: ObjectReader) -> Self {
        self.objects = objects;
        self
    }

    pub(crate) async fn read_stored(&self, sha: String) -> Result<Vec<u8>, ApiError> {
        (self.objects)(self.notebook.clone(), sha).await
    }
}

fn local_object(
    notebook: Arc<Mutex<Notebook>>,
    sha: String,
) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, ApiError>> + Send>> {
    Box::pin(async move {
        // A missing file is not found. The native service replaces this reader
        // when a replica should fetch the file from its hub instead.
        match crate::run::read_notebook(&notebook, move |notebook| notebook.read_object(&sha)).await
        {
            Ok(bytes) => Ok(bytes),
            Err(crate::run::NotebookError::Workshop(tessera_core::Error::NotFound { .. })) => {
                Err(ApiError::not_found())
            }
            Err(crate::run::NotebookError::Workshop(tessera_core::Error::Io(error)))
                if error.kind() == std::io::ErrorKind::NotFound =>
            {
                Err(ApiError::not_found())
            }
            Err(crate::run::NotebookError::Workshop(error)) => Err(error.into()),
            Err(crate::run::NotebookError::Interrupted(error)) => Err(ApiError::internal(error)),
        }
    })
}

/// The notebook and commit notifications backing an embedded router.
pub struct EmbeddedHandles {
    pub notebook: Arc<Mutex<Notebook>>,
    pub changes: broadcast::Sender<i64>,
}
