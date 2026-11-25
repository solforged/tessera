//! Run a workshop operation on a blocking thread natively, or inline in the browser worker.

#[cfg(native)]
#[path = "run_native.rs"]
mod imp;
#[cfg(browser)]
#[path = "run_browser.rs"]
mod imp;

use std::sync::Arc;
#[cfg(native)]
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::{Condvar, Mutex};
use tessera_core::{Reader, Workshop};

use crate::error::ApiError;
use crate::state::WorkshopState;

pub(crate) use imp::read_snapshot;
pub use imp::read_workshop;

/// How many reads can run at once beside the writer.
#[cfg(native)]
const READERS: usize = 3;

struct ReaderPool {
    idle: Mutex<Vec<(Reader, u64)>>,
    ready: Condvar,
    #[cfg(native)]
    generation: AtomicU64,
}

struct ReaderLease<'a> {
    pool: &'a ReaderPool,
    entry: Option<(Reader, u64)>,
}

impl std::ops::Deref for ReaderLease<'_> {
    type Target = Reader;

    fn deref(&self) -> &Self::Target {
        &self.entry.as_ref().expect("lease holds a reader").0
    }
}

impl Drop for ReaderLease<'_> {
    fn drop(&mut self) {
        if let Some(entry) = self.entry.take() {
            self.pool.idle.lock().push(entry);
            self.pool.ready.notify_one();
        }
    }
}

/// Read-only connections beside the workshop's writer, so a slow query or
/// page read does not hold up a save.
#[derive(Clone)]
pub struct Readers(Arc<ReaderPool>);

impl Readers {
    #[cfg(native)]
    pub fn open(workshop: &Workshop) -> tessera_core::Result<Self> {
        let readers = (0..READERS)
            .map(|_| workshop.reader().map(|reader| (reader, 0)))
            .collect::<tessera_core::Result<_>>()?;
        Ok(Self(Arc::new(ReaderPool {
            idle: Mutex::new(readers),
            ready: Condvar::new(),
            generation: AtomicU64::new(0),
        })))
    }

    #[cfg(native)]
    pub fn flush(&self) {
        let next = self.0.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let mut idle = self.0.idle.lock();
        for (reader, seen) in idle.iter_mut() {
            reader.flush();
            *seen = next;
        }
    }

    /// Take the next idle connection in FIFO wait order, flushing stale
    /// statements if a clone was installed while it was checked out.
    fn checkout(&self) -> ReaderLease<'_> {
        let mut idle = self.0.idle.lock();
        let (mut reader, mut seen) = loop {
            if let Some(entry) = idle.pop() {
                break entry;
            }
            self.0.ready.wait(&mut idle);
        };
        drop(idle);
        #[cfg(native)]
        {
            let generation = self.0.generation.load(Ordering::Acquire);
            if seen < generation {
                reader.flush();
                seen = generation;
            }
        }
        #[cfg(not(native))]
        let _ = (&mut reader, &mut seen);
        ReaderLease {
            pool: &self.0,
            entry: Some((reader, seen)),
        }
    }
}

/// Run a read on the calling thread against one snapshot of the workshop: on
/// an idle reader where the host opened [`Readers`], else on the writer's
/// connection. For blocking code that cannot await [`read`].
pub fn read_blocking<T>(
    workshop: &Mutex<Workshop>,
    readers: Option<&Readers>,
    operation: impl FnOnce(&Workshop) -> tessera_core::Result<T>,
) -> tessera_core::Result<T> {
    match readers {
        Some(readers) => readers.checkout().read(operation),
        None => operation(&workshop.lock()),
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
    read_snapshot(&state.workshop, state.readers.as_ref(), operation)
        .await
        .map_err(|error| match error {
            WorkshopError::Workshop(error) => ApiError::from(error),
            WorkshopError::Interrupted(error) => ApiError::internal(error),
        })
}

#[cfg(all(test, native))]
mod tests {
    use std::sync::{Arc, Barrier, mpsc};
    use std::time::Duration;

    use parking_lot::Mutex;
    use tessera_core::Workshop;

    use super::{Readers, read_blocking};

    #[test]
    fn slow_reader_does_not_block_concurrent_reads_on_idle_connections() {
        let dir = tempfile::tempdir().unwrap();
        let workshop = Arc::new(Mutex::new(Workshop::open(dir.path()).unwrap()));
        let readers = Readers::open(&workshop.lock()).unwrap();
        let entered = Arc::new(Barrier::new(2));
        let (release_tx, release_rx) = mpsc::channel::<()>();

        let slow_workshop = workshop.clone();
        let slow_readers = readers.clone();
        let slow_entered = entered.clone();
        let slow = std::thread::spawn(move || {
            read_blocking(&slow_workshop, Some(&slow_readers), |w| {
                let info = w.info()?;
                slow_entered.wait();
                release_rx.recv().unwrap();
                Ok(info.id)
            })
            .unwrap()
        });

        entered.wait();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let mut fast_handles = Vec::new();
        for _ in 0..8 {
            let w = workshop.clone();
            let r = readers.clone();
            let tx = done_tx.clone();
            fast_handles.push(std::thread::spawn(move || {
                for _ in 0..4 {
                    let roots = read_blocking(&w, Some(&r), |w| w.roots()).unwrap();
                    assert!(!roots.is_empty());
                }
                tx.send(()).unwrap();
            }));
        }
        drop(done_tx);

        // All 8 worker threads must finish using the 2 remaining readers while
        // the slow read is still parked.
        for _ in 0..8 {
            done_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("fast reads completed without waiting on the parked reader");
        }
        for handle in fast_handles {
            handle.join().unwrap();
        }

        // Read-only check_snapshot also succeeds on a query_only reader.
        let report = read_blocking(&workshop, Some(&readers), |w| w.check_snapshot()).unwrap();
        assert!(report.ok);

        release_tx.send(()).unwrap();
        assert!(!slow.join().unwrap().is_empty());
    }
}
