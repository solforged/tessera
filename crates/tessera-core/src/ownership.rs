use std::fs::{File, TryLockError};
use std::io::{self, Read, Seek, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

const LOCK_FILE: &str = "service.lock";

#[derive(Deserialize, Serialize)]
struct Holder {
    pid: u32,
    port: Option<u16>,
}

/// The OS releases ownership when this handle closes, including after a crash.
/// Never unlink the file: doing so would let another owner lock a new inode.
pub struct NotebookOwnership {
    file: File,
}

impl NotebookOwnership {
    pub fn acquire(notebook: &Path, port: u16) -> io::Result<Self> {
        std::fs::create_dir_all(notebook).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("cannot create notebook {}: {error}", notebook.display()),
            )
        })?;
        let path = notebook.join(LOCK_FILE);
        let mut file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!(
                        "cannot open service ownership lock {}: {error}",
                        path.display()
                    ),
                )
            })?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                // Details are advisory, never the source of lock ownership.
                let holder = serde_json::from_reader::<_, Holder>((&mut file).take(512)).ok();
                let message = match holder {
                    Some(Holder {
                        pid,
                        port: Some(port),
                    }) => format!(
                        "notebook {} is already served by PID {pid} on port {port}",
                        notebook.display()
                    ),
                    Some(Holder { pid, port: None }) => format!(
                        "notebook {} is already served by PID {pid} (port not bound yet)",
                        notebook.display()
                    ),
                    None => format!(
                        "notebook {} is already served by another process (holder details unavailable)",
                        notebook.display()
                    ),
                };
                return Err(io::Error::new(io::ErrorKind::WouldBlock, message));
            }
            Err(TryLockError::Error(error)) => {
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "cannot lock service ownership file {}: {error}",
                        path.display()
                    ),
                ));
            }
        }
        let mut ownership = Self { file };
        ownership.record((port != 0).then_some(port))?;
        Ok(ownership)
    }

    pub fn record(&mut self, port: Option<u16>) -> io::Result<()> {
        self.file.rewind()?;
        self.file.set_len(0)?;
        serde_json::to_writer(
            &mut self.file,
            &Holder {
                pid: std::process::id(),
                port,
            },
        )?;
        self.file.write_all(b"\n")?;
        Ok(())
    }
}
