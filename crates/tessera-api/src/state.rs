use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use parking_lot::Mutex;
use tessera_core::Workshop;
use tokio::sync::broadcast;

use crate::error::ApiError;
use crate::library::{self, Library};

/// Reads one stored file. The native service installs a reader that fetches a
/// missing file from the replica's hub; the browser reads the local store.
pub type ObjectReader = Arc<
    dyn Fn(
            Arc<Mutex<Workshop>>,
            String,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, ApiError>> + Send>>
        + Send
        + Sync,
>;

/// The workshop connection, its change wakeups, and the library worker.
#[derive(Clone)]
pub struct WorkshopState {
    pub workshop: Arc<Mutex<Workshop>>,
    pub changes: broadcast::Sender<i64>,
    pub library: Library,
    /// Read-only connections for [`crate::read`]; absent where the host has
    /// one connection.
    pub readers: Option<crate::Readers>,
    objects: ObjectReader,
}

impl WorkshopState {
    /// Open the library worker on an already wrapped workshop.
    pub fn from_workshop(workshop: Arc<Mutex<Workshop>>) -> Result<Self, String> {
        let changes = broadcast::channel(256).0;
        let library = Library::start(workshop.clone(), changes.clone(), library::extract)?;
        Ok(Self {
            workshop,
            changes,
            library,
            readers: None,
            objects: Arc::new(local_object),
        })
    }

    pub fn open(workshop: Workshop) -> Result<Self, String> {
        Self::from_workshop(Arc::new(Mutex::new(workshop)))
    }

    /// Assemble state when the library worker was already started, as tests do with a fake extractor.
    pub fn from_parts(
        workshop: Arc<Mutex<Workshop>>,
        changes: broadcast::Sender<i64>,
        library: Library,
    ) -> Self {
        Self {
            workshop,
            changes,
            library,
            readers: None,
            objects: Arc::new(local_object),
        }
    }

    pub fn with_readers(mut self, readers: Option<crate::Readers>) -> Self {
        self.readers = readers;
        self
    }

    pub fn with_objects(mut self, objects: ObjectReader) -> Self {
        self.objects = objects;
        self
    }

    pub(crate) async fn read_stored(&self, sha: String) -> Result<Vec<u8>, ApiError> {
        (self.objects)(self.workshop.clone(), sha).await
    }
}

fn local_object(
    workshop: Arc<Mutex<Workshop>>,
    sha: String,
) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, ApiError>> + Send>> {
    Box::pin(async move {
        // A missing file is not found. The native service replaces this reader
        // when a replica should fetch the file from its hub instead.
        match crate::run::read_workshop(&workshop, move |workshop| workshop.read_object(&sha)).await
        {
            Ok(bytes) => Ok(bytes),
            Err(crate::run::WorkshopError::Workshop(tessera_core::Error::NotFound { .. })) => {
                Err(ApiError::not_found())
            }
            Err(crate::run::WorkshopError::Workshop(tessera_core::Error::Io(error)))
                if error.kind() == std::io::ErrorKind::NotFound =>
            {
                Err(ApiError::not_found())
            }
            Err(crate::run::WorkshopError::Workshop(error)) => Err(error.into()),
            Err(crate::run::WorkshopError::Interrupted(error)) => Err(ApiError::internal(error)),
        }
    })
}

/// The workshop and commit notifications backing an embedded router.
pub struct EmbeddedHandles {
    pub workshop: Arc<Mutex<Workshop>>,
    pub changes: broadcast::Sender<i64>,
}
