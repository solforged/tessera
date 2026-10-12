//! How a replica on another device gets each table. See `docs/sync.md`.

/// The class of a table for sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Replication {
    /// Fixed when the notebook is created; a clone copies it.
    Identity,
    /// Written only by applying changes, including the change log itself and
    /// what applying derives from text. Each change's effect on these tables
    /// travels to replicas as its patch.
    Applied,
    /// Maintained by SQLite triggers from other tables; each device's
    /// triggers keep its own copy current.
    Indexed,
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
    ("links", Replication::Applied),
    ("memberships", Replication::Applied),
    ("provisional_pages", Replication::Applied),
    ("fields", Replication::Applied),
    ("field_targets", Replication::Applied),
    ("type_fields", Replication::Applied),
    ("type_presentation", Replication::Applied),
    ("subject_criteria", Replication::Applied),
    ("field_values", Replication::Applied),
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
    ("card_templates", Replication::Applied),
    ("decks", Replication::Applied),
    ("task_views", Replication::Applied),
    ("review_sessions", Replication::Applied),
    ("review_events", Replication::Applied),
    ("sources", Replication::Applied),
    ("source_snapshots", Replication::Applied),
    ("citations", Replication::Applied),
    ("library_views", Replication::Applied),
    ("id_aliases", Replication::Applied),
    ("sync_conflicts", Replication::Applied),
    ("search_blocks", Replication::Indexed),
    ("blocks_fts", Replication::Indexed),
    ("passages_fts", Replication::Indexed),
    ("snapshots", Replication::Content),
    ("passages", Replication::Content),
    ("snapshot_resources", Replication::Content),
    ("browser_objects", Replication::Content),
    ("reading_positions", Replication::Unlogged),
    ("highlight_surfacings", Replication::Unlogged),
    ("replica", Replication::Local),
    ("ingest_jobs", Replication::Local),
    ("agent_changes", Replication::Local),
    ("sync_replicas", Replication::Local),
    ("change_patches", Replication::Local),
    ("sync_hub", Replication::Local),
    ("sync_pending", Replication::Local),
    ("sync_pins", Replication::Local),
    ("sync_devices", Replication::Local),
    ("editor_events", Replication::Local),
];

/// The tables whose rows a change patch carries.
pub fn applied_tables() -> impl Iterator<Item = &'static str> {
    TABLES
        .iter()
        .filter(|(_, class)| *class == Replication::Applied)
        .map(|(name, _)| *name)
}
