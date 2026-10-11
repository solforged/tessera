//! How a replica on another device gets each table. See `docs/sync.md`.

/// The class of a table for sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Replication {
    /// Fixed when the notebook is created; a clone copies it.
    Identity,
    /// Written by applying changes, including the change log itself. A
    /// replica gets these rows by applying the same changes or pulling them.
    Applied,
    /// Rebuilt from other tables on each device; never sent.
    Derived,
    /// Immutable library content addressed by hash.
    Content,
    /// Written outside the change log; synced as last-writer-wins rows.
    Unlogged,
    /// This device's own state; never sent.
    Local,
}

/// Every table in a notebook database. FTS5's shadow tables follow their
/// virtual table.
pub const TABLES: &[(&str, Replication)] = &[
    ("notebook", Replication::Identity),
    ("changes", Replication::Applied),
    ("change_revisions", Replication::Applied),
    ("deletion_events", Replication::Applied),
    ("blocks", Replication::Applied),
    ("memberships", Replication::Applied),
    ("provisional_pages", Replication::Applied),
    ("fields", Replication::Applied),
    ("type_fields", Replication::Applied),
    ("views", Replication::Applied),
    ("settings", Replication::Applied),
    ("tasks", Replication::Applied),
    ("projects", Replication::Applied),
    ("task_occurrences", Replication::Applied),
    ("work_sessions", Replication::Applied),
    ("positions", Replication::Applied),
    ("questions", Replication::Applied),
    ("assessments", Replication::Applied),
    ("card_units", Replication::Applied),
    ("decks", Replication::Applied),
    ("task_views", Replication::Applied),
    ("review_sessions", Replication::Applied),
    ("review_events", Replication::Applied),
    ("sources", Replication::Applied),
    ("source_snapshots", Replication::Applied),
    ("citations", Replication::Applied),
    ("library_views", Replication::Applied),
    ("links", Replication::Derived),
    ("search_blocks", Replication::Derived),
    ("blocks_fts", Replication::Derived),
    ("field_values", Replication::Derived),
    ("passages_fts", Replication::Derived),
    ("snapshots", Replication::Content),
    ("passages", Replication::Content),
    ("snapshot_resources", Replication::Content),
    ("browser_objects", Replication::Content),
    ("reading_positions", Replication::Unlogged),
    ("highlight_surfacings", Replication::Unlogged),
    ("replica", Replication::Local),
    ("ingest_jobs", Replication::Local),
    ("agent_changes", Replication::Local),
];
