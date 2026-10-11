//! Replicating a notebook between devices: a hub orders changes, replicas
//! push theirs and pull the hub's. See `docs/sync.md`.
//!
//! Every change committed on a hub with replicas, or on a replica, records
//! its row-level effect on the applied tables as an SQLite session
//! changeset. Replicas apply the hub's changesets instead of replaying its
//! operations, and undo their own unconfirmed changes with the inverse of
//! theirs before doing so.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::session::{ConflictAction, ConflictType, Session, invert_strm};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::notebook::{new_ulid, now_ms};
use crate::operations::Extras;
use crate::replication::applied_tables;
use crate::storage::validation;
pub use crate::sync_library::{ReadingRow, SurfacingRow, UnloggedPull, UnloggedRows};
use crate::{Batch, ChangeStamp, Error, Notebook, Operation, Result, SCHEMA_VERSION};

#[path = "sync_driver.rs"]
mod driver;
pub use driver::{NotebookAccess, sync_import, sync_send, sync_with};
#[path = "sync_replica.rs"]
mod replica;
pub use replica::{KeptCopy, OfflineFiles, RejectedChange, ReplicaConflicts};

/// A change a replica sends to its hub: the batch as it was made there, its
/// stamp, and the text of each block it rewrites as it was before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushedChange {
    pub stamp: ChangeStamp,
    pub batch: Batch,
    #[serde(default)]
    pub bases: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum PushOutcome {
    /// Committed as hub change `seq`, possibly with conflicts resolved.
    Accepted { seq: i64 },
    /// Recorded as hub change `seq` without effect; the batch is kept as a
    /// rejected conflict.
    Rejected { seq: i64, error: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushReceipt {
    pub change_id: String,
    #[serde(flatten)]
    pub outcome: PushOutcome,
}

/// One hub change's effect, as an SQLite session changeset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PulledChange {
    pub seq: i64,
    #[serde(with = "base64_bytes")]
    pub patch: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pull {
    pub changes: Vec<PulledChange>,
    /// Library snapshots these changes attach or cite.
    pub snapshots: Vec<String>,
    /// The hub's latest change.
    pub hub_seq: i64,
    /// True when more changes follow the last one returned.
    pub more: bool,
}

/// What a new replica needs besides the database snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloneTicket {
    pub notebook_id: String,
    /// The device ID the hub registered for the new replica.
    pub device_id: String,
    /// The hub's latest change in the snapshot.
    pub seq: i64,
    pub schema_version: u32,
}

/// A library snapshot's rows, sent between devices as data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotContent {
    pub id: String,
    pub sha256: String,
    pub format: String,
    pub media_type: String,
    pub metadata: String,
    pub toc: String,
    pub passage_count: i64,
    pub text_length: i64,
    pub created_at: i64,
    pub passages: Vec<PassageRow>,
    pub resources: Vec<ResourceRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PassageRow {
    pub id: String,
    pub ordinal: i64,
    pub kind: String,
    pub level: Option<i64>,
    pub text: String,
    pub locator: String,
    pub anchor: Option<String>,
    pub resource: Option<String>,
    pub marks: String,
    pub start: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResourceRow {
    pub href: String,
    pub sha256: String,
    pub media_type: String,
}

/// A replica's unconfirmed changes and the snapshots they reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outbox {
    pub device_id: String,
    pub confirmed_seq: i64,
    pub changes: Vec<PushedChange>,
    pub snapshots: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrateReport {
    /// Hub changes applied here.
    pub applied: usize,
    /// Local changes the hub confirmed, accepted or rejected.
    pub confirmed: usize,
    /// Local changes still unconfirmed, applied again on the new state.
    pub replayed: usize,
    /// Local changes still unconfirmed that no longer apply here, with why.
    /// They stay in the outbox; the hub decides them on the next push.
    pub unapplied: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncReport {
    pub pushed: Vec<PushReceipt>,
    pub integrated: IntegrateReport,
    pub sent_snapshots: usize,
    pub received_snapshots: usize,
    /// Files sent to and fetched from the hub.
    pub sent_objects: usize,
    pub received_objects: usize,
    /// Files this replica wants that the hub does not have.
    pub unavailable_objects: Vec<String>,
    /// Reading positions and surfacings sent and taken from the hub.
    pub sent_rows: usize,
    pub received_rows: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncStatus {
    pub device_id: String,
    pub hub_url: String,
    pub hub_notebook_id: String,
    pub confirmed_seq: i64,
    pub pending: usize,
    pub unapplied: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplicaInfo {
    pub device_id: String,
    pub cursor: i64,
    pub cloned_at: i64,
    pub seen_at: i64,
    /// When the hub stopped keeping changes for it; it must be cloned again.
    pub retired_at: Option<i64>,
}

/// A copy of a hub notebook for a new replica that still holds the hub's own
/// state. [`ClonedSnapshot::finish`] removes that state. It needs no access to
/// the hub notebook, so a service can run it after releasing the notebook.
#[must_use = "a clone holds the hub's local state until it is finished"]
pub struct ClonedSnapshot {
    path: PathBuf,
    ticket: CloneTicket,
}

impl ClonedSnapshot {
    /// Remove the hub's local state from the copy and compact it.
    pub fn finish(self) -> Result<CloneTicket> {
        let snapshot = Connection::open(&self.path)?;
        snapshot.pragma_update(None, "journal_mode", "DELETE")?;
        // Deleting leaves free pages; VACUUM drops them so they are not sent.
        snapshot.execute_batch(
            "DELETE FROM sync_replicas; DELETE FROM change_patches; DELETE FROM sync_pending;
             DELETE FROM sync_hub; DELETE FROM ingest_jobs; DELETE FROM agent_changes;
             DELETE FROM sync_pins; DELETE FROM sync_devices; DELETE FROM editor_events;
             DELETE FROM sqlite_sequence WHERE name = 'editor_events'; VACUUM;",
        )?;
        Ok(self.ticket)
    }
}

/// Text one device kept beside a block another device also edited, or a
/// change the hub could not apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncConflict {
    pub id: String,
    pub kind: String,
    pub change_id: String,
    pub origin: String,
    pub block_id: Option<String>,
    pub text: Option<String>,
    pub batch: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub change_seq: i64,
}

/// The hub as a replica reaches it. [`Notebook`] implements it for a hub in
/// the same process; clients implement it over their transport.
pub trait Hub {
    fn push(&mut self, device: &str, changes: &[PushedChange]) -> Result<Vec<PushReceipt>>;
    /// Changes after `after`. `acknowledged` is the last hub change the
    /// replica has applied; the hub may forget patches up to it.
    fn pull(&mut self, device: &str, acknowledged: i64, after: i64) -> Result<Pull>;
    fn missing_snapshots(&mut self, ids: &[String]) -> Result<Vec<String>>;
    /// Content of the snapshots `ids` names, in order, from passage `from` of
    /// the first. A hub returns a bounded amount, so the last snapshot may
    /// stop partway; ask again for the rest.
    fn snapshot_content(&mut self, ids: &[String], from: i64) -> Result<Vec<SnapshotContent>>;
    fn store_snapshots(&mut self, content: &[SnapshotContent]) -> Result<()>;
    /// The files among `shas` the hub does not have.
    fn missing_objects(&mut self, shas: &[String]) -> Result<Vec<String>>;
    /// A file by hash, or `None` when the hub does not have it.
    fn object(&mut self, sha: &str) -> Result<Option<Vec<u8>>>;
    fn store_object(&mut self, sha: &str, bytes: &[u8]) -> Result<()>;
    /// Merge the replica's rows written outside the change log and return the
    /// hub's rows that arrived after `after`.
    fn exchange_rows(
        &mut self,
        device: &str,
        rows: &UnloggedRows,
        after: i64,
    ) -> Result<UnloggedPull>;
    /// Stop keeping patches for `device`, which is being cloned again.
    fn retire(&mut self, device: &str) -> Result<()>;
}

/// Hub changes per pull.
pub const PULL_LIMIT: usize = 500;
/// Patch bytes per pull, past the first change.
pub const PULL_BYTES: usize = 8 * 1024 * 1024;
/// Passage text per snapshot content response or upload, past the first
/// snapshot. JSON with passage locators and marks runs a few times larger.
pub const CONTENT_TEXT_LIMIT: i64 = 8 * 1024 * 1024;
/// Replica changes per push.
pub const PUSH_LIMIT: usize = 200;
/// A replica the hub has not heard from for this long is retired: the hub
/// stops keeping patches for it, and it has to be cloned again.
pub const RETIRE_AFTER_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const RETIRED: &str = "the hub retired this replica after 30 days without syncing; \
     changes it pushed are kept, but it has to be cloned again (tessera sync reclone)";

impl Hub for Notebook {
    fn push(&mut self, device: &str, changes: &[PushedChange]) -> Result<Vec<PushReceipt>> {
        self.sync_push(device, changes)
    }
    fn pull(&mut self, device: &str, acknowledged: i64, after: i64) -> Result<Pull> {
        self.sync_pull(device, acknowledged, after, PULL_LIMIT)
    }
    fn missing_snapshots(&mut self, ids: &[String]) -> Result<Vec<String>> {
        self.sync_missing_snapshots(ids)
    }
    fn snapshot_content(&mut self, ids: &[String], from: i64) -> Result<Vec<SnapshotContent>> {
        self.sync_snapshot_content(ids, from)
    }
    fn store_snapshots(&mut self, content: &[SnapshotContent]) -> Result<()> {
        self.sync_store_snapshots(content)
    }
    fn missing_objects(&mut self, shas: &[String]) -> Result<Vec<String>> {
        self.sync_missing_objects(shas)
    }
    fn object(&mut self, sha: &str) -> Result<Option<Vec<u8>>> {
        self.sync_object(sha)
    }
    fn store_object(&mut self, sha: &str, bytes: &[u8]) -> Result<()> {
        self.sync_store_object(sha, bytes)
    }
    fn exchange_rows(
        &mut self,
        device: &str,
        rows: &UnloggedRows,
        after: i64,
    ) -> Result<UnloggedPull> {
        self.sync_exchange_rows(device, rows, after)
    }
    fn retire(&mut self, device: &str) -> Result<()> {
        self.sync_retire(device)
    }
}

enum Role {
    Hub,
    Replica,
}

/// A commit in progress on a notebook that records patches.
pub(crate) struct Recording<'conn> {
    role: Role,
    session: Session<'conn>,
    bases: BTreeMap<String, String>,
}

fn role(conn: &Connection) -> Result<Option<Role>> {
    let (replica, hub): (bool, bool) = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_hub),
                EXISTS(SELECT 1 FROM sync_replicas WHERE retired_at IS NULL)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(if replica {
        Some(Role::Replica)
    } else if hub {
        Some(Role::Hub)
    } else {
        None
    })
}

/// Retire replicas the hub has not heard from in [`RETIRE_AFTER_MS`], then
/// forget the patches every remaining replica has applied.
pub(crate) fn prune(conn: &Connection, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE sync_replicas SET retired_at = ?1 WHERE retired_at IS NULL AND seen_at < ?1 - ?2",
        params![now, RETIRE_AFTER_MS],
    )?;
    conn.execute(
        "DELETE FROM change_patches WHERE seq <= COALESCE(
             (SELECT MIN(cursor) FROM sync_replicas WHERE retired_at IS NULL),
             (SELECT MAX(seq) FROM change_patches))",
        [],
    )?;
    Ok(())
}

fn recorder(conn: &Connection) -> Result<Session<'_>> {
    let mut session = Session::new(conn)?;
    for table in applied_tables() {
        session.attach(Some(table))?;
    }
    Ok(session)
}

/// Start recording a commit's patch, before it writes anything.
pub(crate) fn begin<'conn>(
    conn: &'conn Connection,
    batch: &Batch,
    extras: &Extras,
) -> Result<Option<Recording<'conn>>> {
    let Some(role) = role(conn)? else {
        return Ok(None);
    };
    let bases = match (&role, extras.bases) {
        (Role::Replica, Some(bases)) => bases.clone(),
        (Role::Replica, None) => bases_of(conn, &batch.operations)?,
        (Role::Hub, _) => BTreeMap::new(),
    };
    Ok(Some(Recording {
        role,
        session: recorder(conn)?,
        bases,
    }))
}

/// Store the commit's patch: in the hub's patch log, or in a replica's outbox.
pub(crate) fn finish(
    conn: &Connection,
    recording: Recording<'_>,
    seq: i64,
    stamp: &ChangeStamp,
    batch: &Batch,
    extras: &Extras,
) -> Result<()> {
    let Recording {
        role,
        mut session,
        bases,
    } = recording;
    let mut patch = Vec::new();
    session.changeset_strm(&mut patch)?;
    drop(session);
    match role {
        Role::Hub => {
            conn.execute(
                "INSERT INTO change_patches(seq, patch) VALUES (?1, ?2)",
                params![seq, patch],
            )?;
            // A replica that never syncs again must not keep every patch.
            prune(conn, now_ms())?;
        }
        Role::Replica => {
            let batch = extras.origin_batch.unwrap_or(batch);
            conn.execute(
                "INSERT INTO sync_pending(change_id, position, stamp, batch, bases, seq, patch)
                 VALUES (?1, (SELECT COALESCE(MAX(position), 0) + 1 FROM sync_pending), ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(change_id) DO UPDATE SET seq = excluded.seq, patch = excluded.patch",
                params![stamp.id, json(stamp), json(batch), json(&bases), seq, patch],
            )?;
        }
    }
    Ok(())
}

/// The text before this batch of every block whose text it replaces.
fn bases_of(conn: &Connection, operations: &[Operation]) -> Result<BTreeMap<String, String>> {
    let mut bases = BTreeMap::new();
    for operation in operations {
        if let Operation::EditText { id, .. } | Operation::Split { id, .. } = operation
            && !bases.contains_key(id)
            && let Some(text) = conn
                .query_row(
                    "SELECT text FROM blocks WHERE id = ?1 AND deletion_id IS NULL",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        {
            bases.insert(id.clone(), text);
        }
    }
    Ok(bases)
}

pub(crate) fn json(value: &impl Serialize) -> String {
    serde_json::to_string(value).expect("sync records serialize")
}

fn parse<T: for<'de> Deserialize<'de>>(text: &str) -> Result<T> {
    serde_json::from_str(text).map_err(|error| validation(format!("invalid sync record: {error}")))
}

/// Columns of applied tables written outside the change log. A row may differ
/// from a patch there without the notebook having diverged from its hub.
const UNLOGGED_COLUMNS: &[(&str, &str)] = &[
    ("sources", "last_read_at"),
    ("citations", "resurface_muted_at"),
];

/// Applies patches within one transaction, refusing any conflict that means
/// this notebook's state is not the state the patch was made from.
struct Patcher {
    /// Column positions of [`UNLOGGED_COLUMNS`] by table.
    unlogged: Arc<BTreeMap<String, Vec<usize>>>,
    /// Set when a patch left a foreign key unsatisfied. Undoing an
    /// unconfirmed change can do that briefly, for instance by removing a
    /// citation a surfacing names, so keys are checked once all are applied.
    dangling: Arc<std::sync::atomic::AtomicBool>,
}

impl Patcher {
    fn new(conn: &Connection) -> Result<Self> {
        let mut unlogged: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for (table, column) in UNLOGGED_COLUMNS {
            let position: i64 = conn.query_row(
                "SELECT cid FROM pragma_table_info(?1) WHERE name = ?2",
                [table, column],
                |row| row.get(0),
            )?;
            unlogged
                .entry((*table).to_owned())
                .or_default()
                .push(position as usize);
        }
        Ok(Self {
            unlogged: Arc::new(unlogged),
            dangling: Arc::default(),
        })
    }

    fn apply(&self, conn: &Connection, patch: &[u8]) -> Result<()> {
        let conflict = Arc::new(Mutex::new(None::<String>));
        let seen = conflict.clone();
        let unlogged = self.unlogged.clone();
        let dangling = self.dangling.clone();
        let mut input = patch;
        let result = conn.apply_strm(&mut input, None::<fn(&str) -> bool>, move |kind, item| {
            // A foreign-key conflict reports a count, not a row.
            if kind == ConflictType::SQLITE_CHANGESET_FOREIGN_KEY {
                dangling.store(true, std::sync::atomic::Ordering::Relaxed);
                return ConflictAction::SQLITE_CHANGESET_OMIT;
            }
            let Ok(op) = item.op() else {
                return ConflictAction::SQLITE_CHANGESET_ABORT;
            };
            if kind == ConflictType::SQLITE_CHANGESET_DATA
                && let Some(columns) = unlogged.get(op.table_name())
                && (0..op.number_of_columns() as usize).all(|column| {
                    match (item.old_value(column), item.conflict(column)) {
                        (Ok(old), Ok(current)) => old == current || columns.contains(&column),
                        _ => true,
                    }
                })
            {
                return ConflictAction::SQLITE_CHANGESET_REPLACE;
            }
            *seen.lock().expect("conflict note lock") =
                Some(format!("{kind:?} in {}", op.table_name()));
            ConflictAction::SQLITE_CHANGESET_ABORT
        });
        result.map_err(|error| {
            let detail = conflict
                .lock()
                .expect("conflict note lock")
                .take()
                .unwrap_or_else(|| error.to_string());
            diverged(&detail)
        })
    }

    /// Drop rows outside the change log that name records the patches
    /// removed, then require every foreign key to hold.
    fn finish(&self, conn: &Connection) -> Result<()> {
        if !self.dangling.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(());
        }
        conn.execute(
            "DELETE FROM highlight_surfacings WHERE citation_id NOT IN (SELECT id FROM citations)",
            [],
        )?;
        let violation: Option<String> = conn
            .query_row(
                "SELECT \"table\" FROM pragma_foreign_key_check LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match violation {
            Some(table) => Err(diverged(&format!("a missing reference in {table}"))),
            None => Ok(()),
        }
    }
}

fn diverged(detail: &str) -> Error {
    validation(format!(
        "this notebook no longer matches its hub ({detail}); clone it again"
    ))
}

fn invert(patch: &[u8]) -> Result<Vec<u8>> {
    let mut input = patch;
    let mut inverse = Vec::new();
    invert_strm(&mut input, &mut inverse)?;
    Ok(inverse)
}

/// Move the snapshots `ids` names from `fetch` to `store` in bounded pieces.
/// Each piece is stored as it arrives; a snapshot stored partway counts as
/// missing, so an interrupted transfer is finished by the next one.
fn transfer(
    ids: &[String],
    mut fetch: impl FnMut(&[String], i64) -> Result<Vec<SnapshotContent>>,
    mut store: impl FnMut(&[SnapshotContent]) -> Result<()>,
) -> Result<()> {
    let mut rest = ids;
    let mut from = 0;
    while !rest.is_empty() {
        let content = fetch(rest, from)?;
        let Some(last) = content.last() else {
            return Err(validation("no snapshot content arrived"));
        };
        if content.len() > rest.len() {
            return Err(validation(
                "more snapshot content arrived than was asked for",
            ));
        }
        store(&content)?;
        // Every snapshot but the last arrived whole; the last may go on.
        match last.passages.last() {
            Some(passage) if passage.ordinal + 1 < last.passage_count => {
                from = passage.ordinal + 1;
                rest = &rest[content.len() - 1..];
            }
            _ => {
                from = 0;
                rest = &rest[content.len()..];
            }
        }
    }
    Ok(())
}

fn latest_seq(conn: &Connection) -> Result<i64> {
    Ok(
        conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM changes", [], |row| {
            row.get(0)
        })?,
    )
}

impl Notebook {
    // Hub side.

    /// Register a new replica and copy this notebook to `destination` for it.
    /// Finish the copy to remove this device's local state.
    pub fn sync_clone(&mut self, destination: &Path) -> Result<ClonedSnapshot> {
        self.sync_clone_for_device(destination, None)
    }

    /// Clone for a paired device, binding its replica ID to that device's key.
    pub fn sync_clone_for_device(
        &mut self,
        destination: &Path,
        paired_device: Option<&str>,
    ) -> Result<ClonedSnapshot> {
        if let Some(device) = paired_device {
            self.sync_require_device(device)?;
        }
        if self.sync_status()?.is_some() {
            return Err(validation("a replica cannot be cloned; clone its hub"));
        }
        let device_id = new_ulid().to_string();
        let seq = latest_seq(&self.conn)?;
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO sync_replicas(device_id, cursor, cloned_at, seen_at, paired_device)
             VALUES (?1, ?2, ?3, ?3, ?4)",
            params![device_id, seq, now, paired_device],
        )?;
        let mut snapshot = Connection::open(destination)?;
        {
            let backup = rusqlite::backup::Backup::new(&self.conn, &mut snapshot)?;
            backup.run_to_completion(256, std::time::Duration::from_millis(0), None)?;
        }
        Ok(ClonedSnapshot {
            path: destination.to_owned(),
            ticket: CloneTicket {
                notebook_id: self.info()?.id,
                device_id,
                seq,
                schema_version: SCHEMA_VERSION,
            },
        })
    }

    /// Replicas cloned from this notebook.
    pub fn sync_replicas(&self) -> Result<Vec<ReplicaInfo>> {
        Ok(self
            .conn
            .prepare(
                "SELECT device_id, cursor, cloned_at, seen_at, retired_at FROM sync_replicas ORDER BY cloned_at",
            )?
            .query_map([], |row| {
                Ok(ReplicaInfo {
                    device_id: row.get(0)?,
                    cursor: row.get(1)?,
                    cloned_at: row.get(2)?,
                    seen_at: row.get(3)?,
                    retired_at: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub(crate) fn known_replica(&self, device: &str) -> Result<()> {
        let known: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_replicas WHERE device_id = ?1)",
            [device],
            |row| row.get(0),
        )?;
        if known {
            Ok(())
        } else {
            Err(validation(format!(
                "device {device} is not a replica of this notebook; clone it again"
            )))
        }
    }

    /// Apply a replica's changes in order. Each is accepted, possibly with
    /// conflicts resolved, or recorded as rejected. A retired replica can
    /// still push, so changes made before it was retired are not lost.
    pub fn sync_push(
        &mut self,
        device: &str,
        changes: &[PushedChange],
    ) -> Result<Vec<PushReceipt>> {
        self.known_replica(device)?;
        // Before applying: each commit retires replicas not seen lately.
        self.conn.execute(
            "UPDATE sync_replicas SET seen_at = ?2 WHERE device_id = ?1 AND retired_at IS NULL",
            params![device, now_ms()],
        )?;
        changes
            .iter()
            .map(|change| {
                if change.stamp.origin != device {
                    return Err(validation("a replica pushes only its own changes"));
                }
                let outcome = self.apply_replicated(change, true)?;
                Ok(PushReceipt {
                    change_id: change.stamp.id.clone(),
                    outcome,
                })
            })
            .collect()
    }

    /// Up to `limit` changes after `after`, as patches. Pulling also tells the
    /// hub this replica is alive and has applied `acknowledged`.
    pub fn sync_pull(
        &mut self,
        device: &str,
        acknowledged: i64,
        after: i64,
        limit: usize,
    ) -> Result<Pull> {
        self.known_replica(device)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let retired: bool = tx.query_row(
            "SELECT retired_at IS NOT NULL FROM sync_replicas WHERE device_id = ?1",
            [device],
            |row| row.get(0),
        )?;
        if retired {
            return Err(validation(RETIRED));
        }
        let now = now_ms();
        tx.execute(
            "UPDATE sync_replicas SET cursor = MAX(cursor, ?2), seen_at = ?3 WHERE device_id = ?1",
            params![device, acknowledged, now],
        )?;
        prune(&tx, now)?;
        tx.commit()?;
        let hub_seq = latest_seq(&self.conn)?;
        let rows: Vec<(i64, Option<Vec<u8>>)> = self
            .conn
            .prepare(
                "SELECT c.seq, p.patch FROM changes c LEFT JOIN change_patches p ON p.seq = c.seq
                 WHERE c.seq > ?1 ORDER BY c.seq LIMIT ?2",
            )?
            .query_map(params![after, limit as i64], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut changes = Vec::with_capacity(rows.len());
        let mut bytes = 0;
        for (seq, patch) in rows {
            let patch = patch.ok_or_else(|| {
                validation(format!(
                    "the hub no longer has change {seq} for this device; clone it again"
                ))
            })?;
            if !changes.is_empty() && bytes + patch.len() > PULL_BYTES {
                break;
            }
            bytes += patch.len();
            changes.push(PulledChange { seq, patch });
        }
        let last = changes.last().map_or(after, |change| change.seq);
        let snapshots = self
            .conn
            .prepare(
                "SELECT snapshot_id FROM source_snapshots WHERE change_seq > ?1 AND change_seq <= ?2
                 UNION SELECT snapshot_id FROM citations WHERE created_seq > ?1 AND created_seq <= ?2",
            )?
            .query_map(params![after, last], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Pull {
            changes,
            snapshots,
            hub_seq,
            more: last < hub_seq,
        })
    }

    /// The snapshots among `ids` this notebook does not have, or has only some
    /// passages of because a transfer stopped partway.
    pub fn sync_missing_snapshots(&self, ids: &[String]) -> Result<Vec<String>> {
        let mut complete = self.conn.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM snapshots s WHERE s.id = ?1
                 AND s.passage_count = (SELECT COUNT(*) FROM passages p WHERE p.snapshot_id = s.id))",
        )?;
        let mut missing = Vec::new();
        for id in ids {
            if !complete.query_row([id], |row| row.get::<_, bool>(0))? {
                missing.push(id.clone());
            }
        }
        Ok(missing)
    }

    /// Content of the snapshots `ids` names, in order, from passage `from` of
    /// the first. It holds at least one passage and stops once the passage
    /// text passes [`CONTENT_TEXT_LIMIT`], so the last snapshot may stop
    /// partway; ask again from the passage after the last one sent.
    pub fn sync_snapshot_content(&self, ids: &[String], from: i64) -> Result<Vec<SnapshotContent>> {
        let mut content = Vec::new();
        let mut text = 0;
        for (index, id) in ids.iter().enumerate() {
            if text > CONTENT_TEXT_LIMIT as usize {
                break;
            }
            let mut snapshot = self
                .conn
                .query_row(
                    "SELECT id, sha256, format, media_type, metadata, toc, passage_count, text_length, created_at
                     FROM snapshots WHERE id = ?1",
                    [id],
                    |row| {
                        Ok(SnapshotContent {
                            id: row.get(0)?,
                            sha256: row.get(1)?,
                            format: row.get(2)?,
                            media_type: row.get(3)?,
                            metadata: row.get(4)?,
                            toc: row.get(5)?,
                            passage_count: row.get(6)?,
                            text_length: row.get(7)?,
                            created_at: row.get(8)?,
                            passages: Vec::new(),
                            resources: Vec::new(),
                        })
                    },
                )
                .optional()?
                .ok_or_else(|| crate::storage::not_found(id))?;
            let mut passages = self.conn.prepare_cached(
                "SELECT id, ordinal, kind, level, text, locator, anchor, resource, marks, start
                 FROM passages WHERE snapshot_id = ?1 AND ordinal >= ?2 ORDER BY ordinal",
            )?;
            let mut rows = passages.query(params![id, if index == 0 { from } else { 0 }])?;
            while let Some(row) = rows.next()? {
                let passage = PassageRow {
                    id: row.get(0)?,
                    ordinal: row.get(1)?,
                    kind: row.get(2)?,
                    level: row.get(3)?,
                    text: row.get(4)?,
                    locator: row.get(5)?,
                    anchor: row.get(6)?,
                    resource: row.get(7)?,
                    marks: row.get(8)?,
                    start: row.get(9)?,
                };
                text += passage.text.len();
                snapshot.passages.push(passage);
                if text > CONTENT_TEXT_LIMIT as usize {
                    break;
                }
            }
            snapshot.resources = self
                .conn
                .prepare_cached(
                    "SELECT href, sha256, media_type FROM snapshot_resources
                     WHERE snapshot_id = ?1 ORDER BY href",
                )?
                .query_map([id], |row| {
                    Ok(ResourceRow {
                        href: row.get(0)?,
                        sha256: row.get(1)?,
                        media_type: row.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            content.push(snapshot);
        }
        Ok(content)
    }

    /// Store snapshots, or pieces of them, that another device extracted.
    /// Rows already here are kept, so pieces can arrive more than once. A
    /// snapshot whose file this notebook holds under another ID is skipped.
    pub fn sync_store_snapshots(&mut self, content: &[SnapshotContent]) -> Result<()> {
        let tx = self.conn.transaction()?;
        for snapshot in content {
            let elsewhere: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM snapshots WHERE sha256 = ?2 AND id <> ?1)",
                params![snapshot.id, snapshot.sha256],
                |row| row.get(0),
            )?;
            if elsewhere {
                continue;
            }
            tx.execute(
                "INSERT OR IGNORE INTO snapshots(id, sha256, format, media_type, metadata, toc, passage_count, text_length, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![snapshot.id, snapshot.sha256, snapshot.format, snapshot.media_type,
                    snapshot.metadata, snapshot.toc, snapshot.passage_count, snapshot.text_length,
                    snapshot.created_at],
            )?;
            let mut passage = tx.prepare_cached(
                "INSERT OR IGNORE INTO passages(id, snapshot_id, ordinal, kind, level, text, locator, anchor, resource, marks, start)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )?;
            for row in &snapshot.passages {
                passage.execute(params![
                    row.id,
                    snapshot.id,
                    row.ordinal,
                    row.kind,
                    row.level,
                    row.text,
                    row.locator,
                    row.anchor,
                    row.resource,
                    row.marks,
                    row.start
                ])?;
            }
            let mut resource = tx.prepare_cached(
                "INSERT OR IGNORE INTO snapshot_resources(snapshot_id, href, sha256, media_type) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for row in &snapshot.resources {
                resource.execute(params![snapshot.id, row.href, row.sha256, row.media_type])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // Replica side.

    /// Make this freshly cloned notebook a replica of the hub at `hub_url`.
    pub fn sync_adopt(&mut self, hub_url: &str, ticket: &CloneTicket) -> Result<()> {
        if ticket.schema_version != SCHEMA_VERSION {
            return Err(validation(format!(
                "the hub uses schema {} and this build uses {SCHEMA_VERSION}; run the same Tessera version on both",
                ticket.schema_version
            )));
        }
        if self.info()?.id != ticket.notebook_id {
            return Err(validation("the snapshot is not the ticket's notebook"));
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE replica SET device_id = ?1 WHERE singleton = 1",
            [&ticket.device_id],
        )?;
        // The clone holds every row outside the log the hub had numbered.
        tx.execute(
            "INSERT INTO sync_hub(singleton, notebook_id, url, confirmed_seq, unlogged_cursor, unlogged_pushed)
             SELECT 1, ?1, ?2, ?3, unlogged_seq, unlogged_seq FROM replica WHERE singleton = 1",
            params![ticket.notebook_id, hub_url, ticket.seq],
        )?;
        tx.execute_batch(
            "INSERT INTO editor_events(seq, change_id, actor, reason, created_at, committed, restructured_pages, views)
             SELECT seq, change_id, actor, reason, created_at, committed, restructured_pages, views FROM changes ORDER BY seq;"
        )?;
        tx.commit()?;
        Ok(())
    }

    /// This notebook's hub and outbox, when it is a replica.
    pub fn sync_status(&self) -> Result<Option<SyncStatus>> {
        let Some((hub_notebook_id, hub_url, confirmed_seq)) = self
            .conn
            .query_row(
                "SELECT notebook_id, url, confirmed_seq FROM sync_hub WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
        else {
            return Ok(None);
        };
        let (pending, unapplied): (i64, i64) = self.conn.query_row(
            "SELECT COUNT(*), COUNT(*) FILTER (WHERE patch IS NULL) FROM sync_pending",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(Some(SyncStatus {
            device_id: self.device_id()?,
            hub_url,
            hub_notebook_id,
            confirmed_seq,
            pending: pending as usize,
            unapplied: unapplied as usize,
        }))
    }

    pub(crate) fn require_replica(&self) -> Result<SyncStatus> {
        self.sync_status()?
            .ok_or_else(|| validation("this notebook is not a replica; clone it from a hub first"))
    }

    /// The changes to push and the snapshots they reference.
    pub fn sync_outbox(&self) -> Result<Outbox> {
        let status = self.require_replica()?;
        let changes: Vec<PushedChange> = self
            .conn
            .prepare("SELECT stamp, batch, bases FROM sync_pending ORDER BY position")?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .map(|row| {
                let (stamp, batch, bases) = row?;
                Ok(PushedChange {
                    stamp: parse(&stamp)?,
                    batch: parse(&batch)?,
                    bases: parse(&bases)?,
                })
            })
            .collect::<Result<_>>()?;
        let snapshots: BTreeSet<String> = changes
            .iter()
            .flat_map(|change| &change.batch.operations)
            .filter_map(|operation| match operation {
                Operation::AttachSnapshot { snapshot_id, .. }
                | Operation::Cite { snapshot_id, .. } => Some(snapshot_id.clone()),
                _ => None,
            })
            .collect();
        Ok(Outbox {
            device_id: status.device_id,
            confirmed_seq: status.confirmed_seq,
            changes,
            snapshots: snapshots.into_iter().collect(),
        })
    }

    /// Bring this replica up to the hub: undo unconfirmed local changes,
    /// apply the hub's changes, then apply again the local changes the hub
    /// has not seen yet.
    pub fn sync_integrate(&mut self, pulled: &[PulledChange]) -> Result<IntegrateReport> {
        self.require_replica()?;
        let mut report = IntegrateReport::default();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let applied: Vec<Vec<u8>> = tx
            .prepare(
                "SELECT patch FROM sync_pending WHERE patch IS NOT NULL ORDER BY position DESC",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        // Undoing a change can remove a citation a surfacing names; keep those
        // surfacings to restore once the change is applied again.
        let surfacings = crate::sync_library::pending_surfacings(&tx)?;
        // Remember invalidations for tentative effects that may disappear.
        let pending_seqs = tx
            .prepare("SELECT seq FROM sync_pending WHERE seq IS NOT NULL")?
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for seq in pending_seqs {
            crate::reads::record_editor_event(&tx, seq, true)?;
        }
        let patcher = Patcher::new(&tx)?;
        for patch in &applied {
            patcher.apply(&tx, &invert(patch)?)?;
        }
        tx.execute("UPDATE sync_pending SET seq = NULL, patch = NULL", [])?;
        for change in pulled {
            patcher.apply(&tx, &change.patch)?;
        }
        for change in pulled {
            crate::reads::record_editor_event(&tx, change.seq, true)?;
        }
        patcher.finish(&tx)?;
        if let Some(last) = pulled.last() {
            tx.execute(
                "UPDATE sync_hub SET confirmed_seq = ?1 WHERE singleton = 1",
                [last.seq],
            )?;
        }
        report.applied = pulled.len();
        report.confirmed = tx.execute(
            "DELETE FROM sync_pending WHERE change_id IN (SELECT change_id FROM changes WHERE change_id IS NOT NULL)",
            [],
        )?;
        tx.commit()?;
        let remaining = self.sync_outbox()?.changes;
        for change in &remaining {
            match self.apply_replicated(change, false) {
                Ok(outcome) => {
                    report.replayed += 1;
                    let PushOutcome::Accepted { seq } = outcome else {
                        unreachable!()
                    };
                    self.conn.execute("DELETE FROM editor_events WHERE seq = (SELECT MAX(seq) FROM editor_events)", [])?;
                    crate::reads::record_editor_event(&self.conn, seq, true)?;
                }
                Err(error) if crate::sync_apply::rejectable(&error) => {
                    report
                        .unapplied
                        .push((change.stamp.id.clone(), error.to_string()));
                }
                Err(error) => return Err(error),
            }
        }
        crate::sync_library::restore_surfacings(&self.conn, &surfacings)?;
        crate::sync_library::reconcile(&self.conn)?;
        Ok(report)
    }

    /// Push this replica's changes to `hub` and bring it up to the hub.
    pub fn sync_with(&mut self, hub: &mut dyn Hub) -> Result<SyncReport> {
        sync_with(self, hub)
    }

    /// Send `hub` everything this replica has that the hub has not seen: the
    /// snapshots and files its changes need, the changes, and its reading
    /// positions and surfacings. A retired replica can still send.
    pub fn sync_send(&mut self, hub: &mut dyn Hub) -> Result<SyncReport> {
        sync_send(self, hub)
    }

    /// Hub side: stop keeping patches for `device`, which is being cloned
    /// again. It can still push.
    pub fn sync_retire(&mut self, device: &str) -> Result<()> {
        self.known_replica(device)?;
        let tx = self.conn.transaction()?;
        let now = now_ms();
        tx.execute(
            "UPDATE sync_replicas SET retired_at = ?2 WHERE device_id = ?1 AND retired_at IS NULL",
            params![device, now],
        )?;
        prune(&tx, now)?;
        tx.commit()?;
        Ok(())
    }

    /// Kept conflict text and rejected changes, newest first.
    pub fn sync_conflicts(&self) -> Result<Vec<SyncConflict>> {
        Ok(self
            .conn
            .prepare(
                "SELECT id, kind, change_id, origin, block_id, text, batch, error, created_at, change_seq
                 FROM sync_conflicts ORDER BY change_seq DESC, id",
            )?
            .query_map([], |row| {
                Ok(SyncConflict {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    change_id: row.get(2)?,
                    origin: row.get(3)?,
                    block_id: row.get(4)?,
                    text: row.get(5)?,
                    batch: row.get(6)?,
                    error: row.get(7)?,
                    created_at: row.get(8)?,
                    change_seq: row.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }
}

/// The error a hub's sync request fails with when the replica runs another
/// schema.
pub fn check_schema(version: u32) -> Result<()> {
    if version == SCHEMA_VERSION {
        Ok(())
    } else {
        Err(Error::Validation {
            message: format!(
                "this hub uses schema {SCHEMA_VERSION} and the replica uses {version}; run the same Tessera version on both"
            ),
            op_index: None,
        })
    }
}

mod base64_bytes {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        STANDARD.decode(text).map_err(serde::de::Error::custom)
    }
}
