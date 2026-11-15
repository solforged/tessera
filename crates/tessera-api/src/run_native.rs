use std::sync::Arc;

use parking_lot::Mutex;
use tessera_core::Workshop;

use super::{Readers, WorkshopError};

pub async fn read_workshop<T: Send + 'static>(
    workshop: &Arc<Mutex<Workshop>>,
    operation: impl FnOnce(&mut Workshop) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, WorkshopError> {
    let workshop = workshop.clone();
    tokio::task::spawn_blocking(move || {
        let mut workshop = workshop.lock();
        operation(&mut workshop).map_err(WorkshopError::Workshop)
    })
    .await
    .map_err(|error| WorkshopError::Interrupted(error.to_string()))?
}

pub async fn read_snapshot<T: Send + 'static>(
    workshop: &Arc<Mutex<Workshop>>,
    readers: Option<&Readers>,
    operation: impl FnOnce(&Workshop) -> tessera_core::Result<T> + Send + 'static,
) -> Result<T, WorkshopError> {
    let workshop = workshop.clone();
    let readers = readers.cloned();
    tokio::task::spawn_blocking(move || {
        match readers {
            Some(readers) => readers.free().read(operation),
            None => operation(&workshop.lock()),
        }
        .map_err(WorkshopError::Workshop)
    })
    .await
    .map_err(|error| WorkshopError::Interrupted(error.to_string()))?
}
