//! Portable workshop HTTP API. The loopback service, the phone and the browser worker
//! share these routes; native-only hosting stays in `tessera-service`.

mod capabilities;
mod changes;
mod check;
mod error;
mod history;
pub mod library;
mod limits;
mod pages;
mod queries;
mod run;
mod state;
mod workshop;

pub use changes::{CHANGES_PAGE_SIZE, ChangeSink, FollowError, StreamStop, follow_changes};
pub use error::{ApiError, ApiFailure, ConflictDetails};
pub use history::editor_receipt;
pub use library::Library;
pub use run::{Readers, read, read_blocking, run};
pub use state::{EmbeddedHandles, ObjectReader, WorkshopState};
pub use workshop::{embedded_router, workshop_routes};

pub mod images;
