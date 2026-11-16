//! Which workshop-wide data a commit changed, so a window refetches a list
//! only when that list can differ. A session records the commit's net row
//! changes: a derived row deleted and written back unchanged leaves no trace,
//! so plain typing names no topic. The browser build has no sessions and
//! records no topics, which a client reads as "anything may have changed".

use serde::{Deserialize, Serialize};

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod watch;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub(crate) use watch::watch;

/// Workshop-wide data that a change can alter. A client keys each list it
/// fetches on the topics that list reads.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum Topic {
    /// Field definitions, their entry counts and the types that use them.
    Fields,
    /// Types: members, field templates, card templates and presentation.
    Types,
    /// Pages and journals: titles, aliases, kinds, archiving and deletion.
    Pages,
    /// Positions, questions, criteria, assessments and relations.
    Inquiry,
    /// Tasks, their occurrences, work sessions and projects.
    Tasks,
    /// Cards, decks, card templates and reviews.
    Cards,
    /// Sources, snapshots, citations, metadata and library views.
    Library,
    /// Note states and revisits.
    Revisits,
    /// Saved views.
    Views,
    /// Sync state: a hub or replica has a change to send or serve.
    Sync,
}
