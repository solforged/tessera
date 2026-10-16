//! Library files and rows written outside the change log, between a hub and
//! its replicas. See "Objects" and "State outside the log" in `docs/sync.md`.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::library_store::{sha256_hex, validate_sha};
use crate::storage::{not_found, validation};
use crate::sync::Outbox;
use crate::{Notebook, Result};

/// A reading position as it travels between devices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadingRow {
    pub snapshot_id: String,
    pub passage_ordinal: i64,
    pub updated_at: i64,
    pub hlc: i64,
    pub device: String,
}

/// A highlight shown on a day, and what was done with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SurfacingRow {
    pub citation_id: String,
    pub date: String,
    pub shown_at: i64,
    pub action: Option<String>,
    pub acted_at: Option<i64>,
    pub hlc: i64,
    pub device: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnloggedRows {
    pub positions: Vec<ReadingRow>,
    pub surfacings: Vec<SurfacingRow>,
}

impl UnloggedRows {
    pub fn len(&self) -> usize {
        self.positions.len() + self.surfacings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The hub's rows that arrived after a replica's cursor, and the new cursor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnloggedPull {
    pub rows: UnloggedRows,
    pub seq: i64,
}

const COVER_PREFIX: &str = "/api/library/covers/";

/// Hashes of uploaded covers that `text` links to.
fn cover_hashes(text: &str) -> impl Iterator<Item = String> + '_ {
    text.match_indices(COVER_PREFIX).filter_map(|(start, _)| {
        let sha = text.get(start + COVER_PREFIX.len()..start + COVER_PREFIX.len() + 64)?;
        validate_sha(sha).ok().map(|()| sha.to_owned())
    })
}

/// Give a merged row its place in this notebook's arrival order, and keep the
/// clock ahead of every clock it has seen.
fn arrival(conn: &Connection, hlc: i64) -> Result<i64> {
    Ok(conn.query_row(
        "UPDATE replica SET clock = MAX(clock, ?1), unlogged_seq = unlogged_seq + 1
         WHERE singleton = 1 RETURNING unlogged_seq",
        [hlc],
        |row| row.get(0),
    )?)
}

/// Merge rows from another device: the later clock wins a reading position,
/// and a surfacing's action. Rows naming records this notebook lacks are
/// skipped. Returns how many rows changed here.
fn merge(conn: &Connection, rows: &UnloggedRows) -> Result<usize> {
    let mut changed = 0;
    for row in &rows.positions {
        let present: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM snapshots WHERE id = ?1)",
            [&row.snapshot_id],
            |r| r.get(0),
        )?;
        let local: Option<(i64, String)> = conn
            .query_row(
                "SELECT hlc, device FROM reading_positions WHERE snapshot_id = ?1",
                [&row.snapshot_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if !present || local.is_some_and(|(hlc, device)| (row.hlc, &row.device) <= (hlc, &device)) {
            continue;
        }
        let seq = arrival(conn, row.hlc)?;
        conn.execute(
            "INSERT INTO reading_positions (snapshot_id, passage_ordinal, updated_at, hlc, device, sync_seq)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(snapshot_id) DO UPDATE
             SET passage_ordinal = excluded.passage_ordinal, updated_at = excluded.updated_at,
                 hlc = excluded.hlc, device = excluded.device, sync_seq = excluded.sync_seq",
            params![row.snapshot_id, row.passage_ordinal, row.updated_at, row.hlc, row.device, seq],
        )?;
        changed += 1;
    }
    for row in &rows.surfacings {
        let present: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM citations WHERE id = ?1)",
            [&row.citation_id],
            |r| r.get(0),
        )?;
        if !present {
            continue;
        }
        let local: Option<(i64, String)> = conn
            .query_row(
                "SELECT hlc, device FROM highlight_surfacings WHERE citation_id = ?1 AND date = ?2",
                [&row.citation_id, &row.date],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match local {
            None => {
                let seq = arrival(conn, row.hlc)?;
                insert_surfacing(conn, row, seq)?;
            }
            Some((hlc, device)) if row.hlc > 0 && (row.hlc, &row.device) > (hlc, &device) => {
                let seq = arrival(conn, row.hlc)?;
                conn.execute(
                    "UPDATE highlight_surfacings SET action = ?3, acted_at = ?4, hlc = ?5, device = ?6, sync_seq = ?7
                     WHERE citation_id = ?1 AND date = ?2",
                    params![row.citation_id, row.date, row.action, row.acted_at, row.hlc, row.device, seq],
                )?;
            }
            Some(_) => continue,
        }
        changed += 1;
    }
    Ok(changed)
}

fn insert_surfacing(conn: &Connection, row: &SurfacingRow, seq: i64) -> Result<usize> {
    Ok(conn.execute(
        "INSERT OR IGNORE INTO highlight_surfacings(citation_id, date, shown_at, action, acted_at, hlc, device, sync_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![row.citation_id, row.date, row.shown_at, row.action, row.acted_at, row.hlc, row.device, seq],
    )?)
}

/// Rows that arrived after `after`, optionally only those `device` wrote.
fn rows_since(conn: &Connection, after: i64, device: Option<&str>) -> Result<UnloggedRows> {
    let positions = conn
        .prepare(
            "SELECT snapshot_id, passage_ordinal, updated_at, hlc, device FROM reading_positions
             WHERE sync_seq > ?1 AND (?2 IS NULL OR device = ?2) ORDER BY sync_seq",
        )?
        .query_map(params![after, device], |row| {
            Ok(ReadingRow {
                snapshot_id: row.get(0)?,
                passage_ordinal: row.get(1)?,
                updated_at: row.get(2)?,
                hlc: row.get(3)?,
                device: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let surfacings = conn
        .prepare(
            "SELECT citation_id, date, shown_at, action, acted_at, hlc, device FROM highlight_surfacings
             WHERE sync_seq > ?1 AND (?2 IS NULL OR device = ?2) ORDER BY sync_seq",
        )?
        .query_map(params![after, device], surfacing_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(UnloggedRows {
        positions,
        surfacings,
    })
}

fn surfacing_row(row: &rusqlite::Row) -> rusqlite::Result<SurfacingRow> {
    Ok(SurfacingRow {
        citation_id: row.get(0)?,
        date: row.get(1)?,
        shown_at: row.get(2)?,
        action: row.get(3)?,
        acted_at: row.get(4)?,
        hlc: row.get(5)?,
        device: row.get(6)?,
    })
}

/// Surfacings of citations that unconfirmed local changes created.
pub(crate) fn pending_surfacings(conn: &Connection) -> Result<Vec<SurfacingRow>> {
    Ok(conn
        .prepare(
            "SELECT h.citation_id, h.date, h.shown_at, h.action, h.acted_at, h.hlc, h.device
             FROM highlight_surfacings h JOIN citations c ON c.id = h.citation_id
             WHERE c.created_seq IN (SELECT seq FROM sync_pending WHERE seq IS NOT NULL)",
        )?
        .query_map([], surfacing_row)?
        .collect::<rusqlite::Result<_>>()?)
}

/// Put back surfacings whose citations are present again.
pub(crate) fn restore_surfacings(conn: &Connection, rows: &[SurfacingRow]) -> Result<()> {
    for row in rows {
        let present: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM citations WHERE id = ?1)",
            [&row.citation_id],
            |r| r.get(0),
        )?;
        if present {
            let seq = arrival(conn, row.hlc)?;
            insert_surfacing(conn, row, seq)?;
        }
    }
    Ok(())
}

/// Bring the columns that mirror rows outside the log up to those rows: when
/// a source was last read, and when a highlight was muted.
pub(crate) fn reconcile(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE sources SET last_read_at = read.at
         FROM (SELECT a.source_id, MAX(r.updated_at) AS at FROM reading_positions r
               JOIN source_snapshots a ON a.snapshot_id = r.snapshot_id GROUP BY a.source_id) AS read
         WHERE sources.block_id = read.source_id
         AND (sources.last_read_at IS NULL OR sources.last_read_at < read.at)",
        [],
    )?;
    conn.execute(
        "UPDATE citations SET resurface_muted_at = muted.at
         FROM (SELECT citation_id, MIN(acted_at) AS at FROM highlight_surfacings
               WHERE action = 'muted' GROUP BY citation_id) AS muted
         WHERE citations.id = muted.citation_id AND citations.resurface_muted_at IS NULL",
        [],
    )?;
    Ok(())
}

impl Notebook {
    fn has_object(&self, sha: &str) -> Result<bool> {
        Ok(self.object_path(sha)?.exists())
    }

    /// The files among `shas` this notebook does not have.
    pub fn sync_missing_objects(&self, shas: &[String]) -> Result<Vec<String>> {
        let mut missing = Vec::new();
        for sha in shas {
            if !self.has_object(sha)? {
                missing.push(sha.clone());
            }
        }
        Ok(missing)
    }

    /// A file by hash, or `None` when this notebook does not have it.
    pub fn sync_object(&self, sha: &str) -> Result<Option<Vec<u8>>> {
        if !self.has_object(sha)? {
            return Ok(None);
        }
        self.read_object(sha).map(Some)
    }

    /// Keep a file another device sent, refusing bytes that do not match
    /// their hash.
    pub fn sync_store_object(&self, sha: &str, bytes: &[u8]) -> Result<()> {
        validate_sha(sha)?;
        if sha256_hex(bytes) != sha {
            return Err(validation(format!(
                "the bytes sent for {sha} have another hash"
            )));
        }
        self.put_object(bytes)?;
        Ok(())
    }

    /// Files an outbox's changes need on the hub: the original files and
    /// images of the snapshots they attach or cite, uploaded covers they link
    /// to and the images they attach to blocks. Only files this device has are
    /// listed.
    pub(crate) fn sync_outbox_objects(&self, outbox: &Outbox) -> Result<Vec<String>> {
        let mut shas = BTreeSet::new();
        for snapshot in &outbox.snapshots {
            let mut statement = self.conn.prepare_cached(
                "SELECT sha256 FROM snapshots WHERE id = ?1
                 UNION SELECT sha256 FROM snapshot_resources WHERE snapshot_id = ?1",
            )?;
            for sha in statement.query_map([snapshot], |row| row.get::<_, String>(0))? {
                shas.insert(sha?);
            }
        }
        for change in &outbox.changes {
            let operations =
                serde_json::to_string(&change.batch.operations).expect("operations serialize");
            shas.extend(cover_hashes(&operations));
            for operation in &change.batch.operations {
                if let crate::Operation::SetImage {
                    image: Some(image), ..
                } = operation
                {
                    shas.insert(image.sha256.clone());
                }
            }
        }
        let mut present = Vec::with_capacity(shas.len());
        for sha in shas {
            if self.has_object(&sha)? {
                present.push(sha);
            }
        }
        Ok(present)
    }

    /// Files this replica keeps and does not have yet: every cover, every
    /// image block's file, and the original files and images of pinned
    /// sources. Other books' files are fetched when they are opened.
    pub fn sync_wanted_objects(&self) -> Result<Vec<String>> {
        self.require_replica()?;
        let mut shas: BTreeSet<String> = self
            .conn
            .prepare(
                "SELECT r.sha256 FROM snapshots s JOIN snapshot_resources r
                 ON r.snapshot_id = s.id AND r.href = json_extract(s.metadata, '$.cover')
                 UNION
                 SELECT s.sha256 FROM sync_pins p JOIN source_snapshots a ON a.source_id = p.source_id
                 JOIN snapshots s ON s.id = a.snapshot_id
                 UNION
                 SELECT r.sha256 FROM sync_pins p JOIN source_snapshots a ON a.source_id = p.source_id
                 JOIN snapshot_resources r ON r.snapshot_id = a.snapshot_id
                 UNION SELECT sha256 FROM images WHERE active = 1",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut statement = self
            .conn
            .prepare("SELECT text FROM blocks WHERE deletion_id IS NULL AND instr(text, ?1) > 0")?;
        for text in statement.query_map([COVER_PREFIX], |row| row.get::<_, String>(0))? {
            shas.extend(cover_hashes(&text?));
        }
        let shas: Vec<String> = shas.into_iter().collect();
        self.sync_missing_objects(&shas)
    }

    /// Keep a source's files on this replica without waiting for it to be
    /// opened. They arrive with the next sync.
    pub fn sync_pin(&mut self, source_id: &str) -> Result<()> {
        self.require_replica()?;
        let active: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sources WHERE block_id = ?1 AND active = 1)",
            [source_id],
            |row| row.get(0),
        )?;
        if !active {
            return Err(not_found(source_id));
        }
        self.conn.execute(
            "INSERT OR IGNORE INTO sync_pins(source_id, pinned_at) VALUES (?1, ?2)",
            params![source_id, crate::notebook::now_ms()],
        )?;
        Ok(())
    }

    /// Stop keeping a source's files ahead of time. Files already here stay.
    pub fn sync_unpin(&mut self, source_id: &str) -> Result<()> {
        self.require_replica()?;
        self.conn
            .execute("DELETE FROM sync_pins WHERE source_id = ?1", [source_id])?;
        Ok(())
    }

    /// Pinned sources, oldest pin first.
    pub fn sync_pins(&self) -> Result<Vec<String>> {
        Ok(self
            .conn
            .prepare("SELECT source_id FROM sync_pins ORDER BY pinned_at, source_id")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Hub side: merge a replica's rows and return the rows that arrived here
    /// after `after`, with this notebook's latest arrival as the new cursor.
    pub fn sync_exchange_rows(
        &mut self,
        device: &str,
        rows: &UnloggedRows,
        after: i64,
    ) -> Result<UnloggedPull> {
        self.known_replica(device)?;
        let tx = self.conn.transaction()?;
        merge(&tx, rows)?;
        reconcile(&tx)?;
        let pull = UnloggedPull {
            rows: rows_since(&tx, after, None)?,
            seq: tx.query_row(
                "SELECT unlogged_seq FROM replica WHERE singleton = 1",
                [],
                |row| row.get(0),
            )?,
        };
        tx.commit()?;
        Ok(pull)
    }

    /// Capture the row push and its high-water mark while holding the notebook.
    pub(crate) fn sync_unlogged_outbox(&self) -> Result<(String, UnloggedRows, i64, i64)> {
        let status = self.require_replica()?;
        let (cursor, pushed, latest): (i64, i64, i64) = self.conn.query_row(
            "SELECT h.unlogged_cursor, h.unlogged_pushed, r.unlogged_seq
             FROM sync_hub h, replica r WHERE h.singleton = 1 AND r.singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let own = rows_since(&self.conn, pushed, Some(&status.device_id))?;
        Ok((status.device_id, own, cursor, latest))
    }

    pub(crate) fn sync_import_rows(&self) -> Result<UnloggedRows> {
        rows_since(&self.conn, 0, None)
    }

    pub(crate) fn sync_integrate_rows(
        &mut self,
        pull: &UnloggedPull,
        latest: i64,
        receive: bool,
    ) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let received = merge(&tx, &pull.rows)?;
        tx.execute(
            "UPDATE sync_hub SET unlogged_pushed = ?1 WHERE singleton = 1",
            [latest],
        )?;
        if receive {
            tx.execute(
                "UPDATE sync_hub SET unlogged_cursor = ?1 WHERE singleton = 1",
                [pull.seq],
            )?;
        }
        reconcile(&tx)?;
        tx.commit()?;
        Ok(received)
    }
}
