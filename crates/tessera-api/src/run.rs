//! Run a workshop operation on a blocking thread natively, or inline in the browser worker.

#[cfg(native)]
#[path = "run_native.rs"]
mod imp;
#[cfg(browser)]
#[path = "run_browser.rs"]
mod imp;

use std::sync::Arc;

use parking_lot::{Mutex, MutexGuard};
use tessera_core::{Reader, Workshop};

use crate::error::ApiError;
use crate::state::WorkshopState;

pub use imp::read_workshop;

/// How many reads can run at once beside the writer.
#[cfg(native)]
const READERS: usize = 3;

/// Read-only connections beside the workshop's writer, so a slow query or
/// page read does not hold up a save.
#[derive(Clone)]
pub struct Readers(Arc<Vec<Mutex<Reader>>>);

impl Readers {
    #[cfg(native)]
    pub fn open(workshop: &Workshop) -> tessera_core::Result<Self> {
        let readers = (0..READERS)
            .map(|_| workshop.reader().map(Mutex::new))
            .collect::<tessera_core::Result<_>>()?;
        Ok(Self(Arc::new(readers)))
    }

    /// An idle connection, or the first one once it is free.
    #[cfg_attr(browser, allow(dead_code))]
    fn free(&self) -> MutexGuard<'_, Reader> {
        self.0
            .iter()
            .find_map(Mutex::try_lock)
            .unwrap_or_else(|| self.0[0].lock())
    }
}

/// A workshop read failed, or the blocking task was dropped.
pub enum WorkshopError {
    Workshop(tessera_core::Error),
    Interrupted(String),
}

impl std::fmt::Display for WorkshopError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Workshop(error) => write!(formatter, "{error}"),
            Self::Interrupted(error) => write!(formatter, "{error}"),
        }
    }
}

/// Run on a blocking runtime thread natively, or inline in the browser worker.
pub async fn run<T: Send + 'static>(
    workshop: &Arc<Mutex<Workshop>>,
    operation: impl FnOnce(&mut Workshop) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    read_workshop(workshop, operation)
        .await
        .map_err(|error| match error {
            WorkshopError::Workshop(error) => ApiError::from(error),
            WorkshopError::Interrupted(error) => ApiError::internal(error),
        })
}

/// Run a read against one snapshot of the workshop. Where the host opened
/// [`Readers`], it does not wait for the writer; elsewhere it takes its turn
/// on the one connection.
pub async fn read<T: Send + 'static>(
    state: &WorkshopState,
    operation: impl FnOnce(&Workshop) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    imp::read_snapshot(&state.workshop, state.readers.as_ref(), operation)
        .await
        .map_err(|error| match error {
            WorkshopError::Workshop(error) => ApiError::from(error),
            WorkshopError::Interrupted(error) => ApiError::internal(error),
        })
}
