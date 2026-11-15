use std::sync::Arc;

use parking_lot::Mutex;
use tessera_core::Workshop;

use super::{Readers, WorkshopError};

pub async fn read_workshop<T: Send + 'static>(
    workshop: &Arc<Mutex<Workshop>>,
    operation: impl FnOnce(&mut Workshop) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, WorkshopError> {
    operation(&mut workshop.lock()).map_err(WorkshopError::Workshop)
}

/// The browser's file system gives the workshop one connection, so a read
/// takes its turn on it.
pub async fn read_snapshot<T: Send + 'static>(
    workshop: &Arc<Mutex<Workshop>>,
    _readers: Option<&Readers>,
    operation: impl FnOnce(&Workshop) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, WorkshopError> {
    operation(&workshop.lock()).map_err(WorkshopError::Workshop)
}
