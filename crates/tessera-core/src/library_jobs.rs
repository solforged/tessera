use crate::library::*;
use crate::library_store::{enum_at, name};
use crate::notebook::now_ms;
use crate::storage::{not_found, validation};
use crate::{Notebook, Result};
use rusqlite::{OptionalExtension, params};

const JOB_COLUMNS: &str = "id, input_kind, input, name, target_source, state, attempts, error,
     next_attempt_at, source_id, snapshot_id, created_at, updated_at";
fn job_at(r: &rusqlite::Row<'_>) -> rusqlite::Result<IngestJob> {
    Ok(IngestJob {
        id: r.get(0)?,
        input_kind: enum_at(r, 1)?,
        input: r.get(2)?,
        name: r.get(3)?,
        target_source: r.get(4)?,
        state: enum_at(r, 5)?,
        attempts: r.get(6)?,
        error: r.get(7)?,
        next_attempt_at: r.get(8)?,
        source_id: r.get(9)?,
        snapshot_id: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}
impl Notebook {
    pub fn queue_ingest(
        &self,
        input_kind: IngestInput,
        input: &str,
        name_value: &str,
        target: Option<&str>,
    ) -> Result<IngestJob> {
        match input_kind {
            IngestInput::File => {
                self.object_path(input)?;
            }
            IngestInput::Url => {
                if !input.starts_with("http://") && !input.starts_with("https://") {
                    return Err(validation("Only HTTP and HTTPS source URLs are accepted."));
                }
            }
        }
        if let Some(target) = target
            && crate::library_store::source(&self.conn, target)?.is_none()
        {
            return Err(validation("The ingestion target is not an active source."));
        }
        let id = crate::notebook::new_ulid().to_string();
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO ingest_jobs(
                 id, input_kind, input, name, target_source, state, attempts, created_at, updated_at
             )
             VALUES (?1, ?2, ?3, ?4, ?5, 'queued', 0, ?6, ?6)",
            params![id, name(&input_kind), input, name_value, target, now],
        )?;
        self.ingest_job(&id)
    }
    pub fn ingest_job(&self, id: &str) -> Result<IngestJob> {
        let mut statement = self.conn.prepare_cached(&format!(
            "SELECT {JOB_COLUMNS}
             FROM ingest_jobs
             WHERE id = ?1"
        ))?;
        statement
            .query_row([id], job_at)
            .optional()?
            .ok_or_else(|| not_found(id))
    }
    pub fn ingest_jobs(&self, limit: usize) -> Result<Vec<IngestJob>> {
        let mut statement = self.conn.prepare_cached(&format!(
            "SELECT {JOB_COLUMNS}
             FROM ingest_jobs
             WHERE state != 'done' OR id IN (
                 SELECT id FROM ingest_jobs WHERE state = 'done'
                 ORDER BY created_at DESC, id DESC LIMIT ?1
             )
             ORDER BY created_at DESC, id DESC"
        ))?;
        Ok(statement
            .query_map([limit.min(10000) as i64], job_at)?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn retry_ingest(&self, id: &str) -> Result<IngestJob> {
        if self.conn.execute(
            "UPDATE ingest_jobs
             SET state = 'queued', attempts = 0, error = NULL,
                 next_attempt_at = NULL, updated_at = ?2
             WHERE id = ?1 AND state = 'failed'",
            params![id, now_ms()],
        )? == 0
        {
            return Err(validation("Only a failed ingestion job can be retried."));
        }
        self.ingest_job(id)
    }
    pub fn resume_ingest(&self) -> Result<()> {
        self.conn.execute(
            "UPDATE ingest_jobs
             SET state = 'queued', next_attempt_at = NULL, updated_at = ?1
             WHERE state = 'running'",
            [now_ms()],
        )?;
        Ok(())
    }
    pub fn claim_ingest(&mut self) -> Result<Option<IngestJob>> {
        let tx = self.conn.transaction()?;
        let now = now_ms();
        let id: Option<String> = tx
            .query_row(
                "SELECT id
                 FROM ingest_jobs
                 WHERE state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
                 ORDER BY created_at, id
                 LIMIT 1",
                [now],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = &id {
            tx.execute(
                "UPDATE ingest_jobs
                 SET state = 'running', attempts = attempts + 1, updated_at = ?2
                 WHERE id = ?1",
                params![id, now],
            )?;
        }
        tx.commit()?;
        id.map(|id| self.ingest_job(&id)).transpose()
    }
    pub fn next_ingest_at(&self) -> Result<Option<i64>> {
        Ok(self.conn.query_row(
            "SELECT MIN(COALESCE(next_attempt_at, 0))
             FROM ingest_jobs
             WHERE state = 'queued'",
            [],
            |r| r.get(0),
        )?)
    }
    pub fn finish_ingest(&self, id: &str, source: &str, snapshot: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE ingest_jobs
             SET state = 'done', error = NULL, next_attempt_at = NULL,
                 source_id = ?2, snapshot_id = ?3, updated_at = ?4
             WHERE id = ?1",
            params![id, source, snapshot, now_ms()],
        )?;
        Ok(())
    }
    pub fn fail_ingest(&self, id: &str, error: &str, retry_at: Option<i64>) -> Result<()> {
        self.conn.execute(
            "UPDATE ingest_jobs
             SET state = ?2, error = ?3, next_attempt_at = ?4, updated_at = ?5
             WHERE id = ?1",
            params![
                id,
                if retry_at.is_some() {
                    "queued"
                } else {
                    "failed"
                },
                error,
                retry_at,
                now_ms()
            ],
        )?;
        Ok(())
    }
}
