//! Local replica state and in-place clone installation.
use super::CloneTicket;
use crate::storage::validation;
use crate::{DATABASE_FILE, Notebook, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct KeptCopy {
    pub id: String,
    pub of: String,
    pub page_id: String,
    pub page_title: String,
    pub text: String,
    pub origin: String,
    pub origin_name: Option<String>,
    pub mine: bool,
    pub created_at: i64,
}
#[derive(Debug, Serialize)]
pub struct RejectedChange {
    pub id: String,
    pub change_id: String,
    pub error: String,
    pub created_at: i64,
    pub origin: String,
    pub origin_name: Option<String>,
    pub mine: bool,
    pub page_id: Option<String>,
    pub page_title: Option<String>,
    pub texts: Vec<String>,
}
#[derive(Debug, Serialize)]
pub struct ReplicaConflicts {
    pub kept: Vec<KeptCopy>,
    pub rejected: Vec<RejectedChange>,
}
#[derive(Debug, Serialize)]
pub struct OfflineFiles {
    pub books: i64,
    pub bytes: u64,
}

impl Notebook {
    /// Detect edits and row writes that arrived while pairing was on the network.
    pub fn sync_generation(&self) -> Result<(i64, i64)> {
        Ok((
            self.editor_cursor()?,
            self.conn.query_row(
                "SELECT unlogged_seq FROM replica WHERE singleton = 1",
                [],
                |r| r.get(0),
            )?,
        ))
    }

    pub fn sync_has_content(&self) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT EXISTS(SELECT 1 FROM changes)", [], |r| r.get(0))?)
    }

    pub fn sync_replica_conflicts(&self) -> Result<ReplicaConflicts> {
        let device = self.device_id()?;
        let kept = self
            .conn
            .prepare(
                "SELECT c.id, c.block_id, b.page_id, p.text, b.text, c.origin,
                    CASE WHEN c.origin = ?1 THEN (SELECT device_name FROM sync_hub) ELSE d.name END,
                    c.origin = ?1, c.created_at
             FROM sync_conflicts c JOIN blocks b ON b.id = c.id
             JOIN blocks p ON p.id = b.page_id LEFT JOIN sync_replicas r ON r.device_id = c.origin
             LEFT JOIN sync_devices d ON d.id = r.paired_device
             WHERE c.kind = 'copy' AND c.settled_at IS NULL AND b.deletion_id IS NULL
             ORDER BY c.created_at DESC, c.id",
            )?
            .query_map([&device], |r| {
                Ok(KeptCopy {
                    id: r.get(0)?,
                    of: r.get(1)?,
                    page_id: r.get(2)?,
                    page_title: r.get(3)?,
                    text: r.get(4)?,
                    origin: r.get(5)?,
                    origin_name: r.get(6)?,
                    mine: r.get(7)?,
                    created_at: r.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let rows = self
            .conn
            .prepare(
                "SELECT c.id, c.change_id, c.error, c.created_at, c.origin,
                    CASE WHEN c.origin = ?1 THEN (SELECT device_name FROM sync_hub) ELSE d.name END,
                    c.origin = ?1, c.batch
             FROM sync_conflicts c
             LEFT JOIN sync_replicas r ON r.device_id = c.origin
             LEFT JOIN sync_devices d ON d.id = r.paired_device
             WHERE c.kind = 'rejected' AND c.settled_at IS NULL
             ORDER BY c.created_at DESC, c.id",
            )?
            .query_map([&device], |r| {
                Ok((
                    RejectedChange {
                        id: r.get(0)?,
                        change_id: r.get(1)?,
                        error: r.get(2)?,
                        created_at: r.get(3)?,
                        origin: r.get(4)?,
                        origin_name: r.get(5)?,
                        mine: r.get(6)?,
                        page_id: None,
                        page_title: None,
                        texts: Vec::new(),
                    },
                    r.get::<_, String>(7)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut page = self.conn.prepare_cached(
            "SELECT p.id, p.text FROM blocks b JOIN blocks p ON p.id = b.page_id
             WHERE b.id = ?1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL",
        )?;
        let mut rejected = Vec::with_capacity(rows.len());
        for (mut conflict, batch) in rows {
            let batch: serde_json::Value = super::parse(&batch)?;
            let mut seen = std::collections::HashSet::new();
            for operation in batch["operations"].as_array().into_iter().flatten() {
                let texts: &[&str] = match operation["op"].as_str() {
                    Some("create_page") => &["title"],
                    Some("insert" | "edit_text") => &["text"],
                    Some("split") => &["left", "right"],
                    _ => &[],
                };
                for field in texts {
                    if let Some(text) = operation[field].as_str()
                        && !text.trim().is_empty()
                        && seen.insert(text)
                    {
                        conflict.texts.push(text.to_owned());
                    }
                }
                if conflict.page_id.is_none() {
                    for field in [
                        "id",
                        "source_id",
                        "destination_id",
                        "parent_id",
                        "new_id",
                        "after",
                        "type_id",
                        "subject_id",
                    ] {
                        if let Some(id) = operation[field].as_str()
                            && let Some((id, title)) = page
                                .query_row([id], |r| {
                                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                                })
                                .optional()?
                        {
                            conflict.page_id = Some(id);
                            conflict.page_title = Some(title);
                            break;
                        }
                    }
                }
            }
            rejected.push(conflict);
        }
        Ok(ReplicaConflicts { kept, rejected })
    }

    pub fn sync_offline_files(&self) -> Result<OfflineFiles> {
        let books = self
            .conn
            .query_row("SELECT COUNT(*) FROM sync_pins", [], |r| r.get(0))?;
        let shas = self.conn.prepare(
            "SELECT s.sha256 FROM sync_pins p JOIN source_snapshots a ON a.source_id = p.source_id JOIN snapshots s ON s.id = a.snapshot_id
             UNION SELECT r.sha256 FROM sync_pins p JOIN source_snapshots a ON a.source_id = p.source_id JOIN snapshot_resources r ON r.snapshot_id = a.snapshot_id"
        )?.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut bytes = 0;
        for sha in shas {
            match std::fs::metadata(self.object_path(&sha)?) {
                Ok(file) => bytes += file.len(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(OfflineFiles { books, bytes })
    }

    /// Install a downloaded clone without changing the Arc or connection used by
    /// the library worker. SQLite backup replaces the DB atomically. The old DB
    /// is checkpointed into a separate recoverable file first; files stay put.
    pub fn sync_install_clone(
        &mut self,
        path: &Path,
        url: &str,
        ticket: &CloneTicket,
        suffix: &str,
        credentials: Option<&crate::sync_devices::HubCredentials>,
    ) -> Result<std::path::PathBuf> {
        super::check_schema(ticket.schema_version)?;
        let cloned = Connection::open(path)?;
        let id: String = cloned.query_row("SELECT id FROM notebook", [], |r| r.get(0))?;
        if id != ticket.notebook_id {
            return Err(validation("the snapshot is not the ticket's notebook"));
        }
        // Never overwrite a previous recovery copy; a same-second attempt gets `-2`, `-3`, …
        let stem = format!("{DATABASE_FILE}.{suffix}-{}", crate::now_ms() / 1000);
        let mut attempt = 1;
        let previous = loop {
            let previous = self.dir.join(match attempt {
                1 => stem.clone(),
                n => format!("{stem}-{n}"),
            });
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&previous)
            {
                Ok(_) => break previous,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => attempt += 1,
                Err(error) => return Err(error.into()),
            }
        };
        self.conn.backup("main", &previous, None)?;
        cloned.execute(
            "ATTACH DATABASE ?1 AS previous",
            [previous.to_string_lossy().as_ref()],
        )?;
        cloned.execute_batch(
            "DELETE FROM editor_events;
             INSERT INTO editor_events SELECT * FROM previous.editor_events;
             DELETE FROM sqlite_sequence WHERE name = 'editor_events';
             INSERT INTO sqlite_sequence(name, seq) SELECT 'editor_events', COALESCE(MAX(seq), 0) FROM editor_events;
             INSERT INTO editor_events(change_id, actor, reason, created_at, committed, restructured_pages, views)
             SELECT change_id, '{\"kind\":\"client\",\"name\":\"sync\"}', reason, created_at, committed,
                    (SELECT json_group_array(page) FROM (
                        SELECT value AS page FROM json_each(e.restructured_pages)
                        UNION SELECT b.page_id FROM json_each(e.committed, '$.revisions') r
                        JOIN previous.blocks b ON b.id = json_extract(r.value, '$.id'))), views
             FROM previous.editor_events e ORDER BY seq;
             DELETE FROM ingest_jobs; INSERT INTO ingest_jobs SELECT * FROM previous.ingest_jobs;
             INSERT OR IGNORE INTO sync_pins SELECT p.* FROM previous.sync_pins p JOIN sources s ON s.block_id = p.source_id WHERE s.active = 1;
             DETACH DATABASE previous;"
        )?;
        let seqs = cloned
            .prepare("SELECT seq FROM changes ORDER BY seq")?
            .query_map([], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for seq in seqs {
            crate::reads::record_editor_event(&cloned, seq, true)?;
        }
        cloned.execute(
            "UPDATE replica SET device_id = ?1 WHERE singleton = 1",
            [&ticket.device_id],
        )?;
        cloned.execute("INSERT INTO sync_hub(singleton, notebook_id, url, confirmed_seq, unlogged_cursor, unlogged_pushed) SELECT 1, ?1, ?2, ?3, unlogged_seq, unlogged_seq FROM replica WHERE singleton = 1", params![ticket.notebook_id, url, ticket.seq])?;
        if let Some(credentials) = credentials {
            cloned.execute(
                "UPDATE sync_hub SET key = ?1, hub_name = ?2, device_name = ?3, synced_at = ?4",
                params![
                    credentials.key,
                    credentials.hub_name,
                    credentials.device_name,
                    crate::now_ms()
                ],
            )?;
        }
        let backup = rusqlite::backup::Backup::new(&cloned, &mut self.conn)?;
        backup.run_to_completion(256, std::time::Duration::from_millis(1), None)?;
        drop(backup);
        // Flush cached statements compiled against the old database schema.
        self.conn.flush_prepared_statement_cache();
        Ok(previous)
    }
}
