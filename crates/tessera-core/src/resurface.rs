use crate::calendar::validate_civil_date;
use crate::library::{HighlightQuery, Surfacing};
use crate::notebook::now_ms;
use crate::reads::hidden_blocks;
use crate::storage::{not_found, validation};
use crate::{Notebook, Result};
use jiff::{Timestamp, civil::Date, tz::TimeZone};
use rusqlite::{TransactionBehavior, params};
use std::collections::HashMap;

// FNV-1a gives ties a stable order across processes and Rust releases.
fn shuffle_key(date: &str, citation: &str) -> u64 {
    date.bytes()
        .chain(citation.bytes())
        .fold(0xcbf29ce484222325, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        })
}

impl Notebook {
    /// Daily navigation state, independent of edits and the change stream.
    pub fn resurfacing(&mut self, date: &str, limit: usize) -> Result<Vec<Surfacing>> {
        validate_civil_date(date)?;
        let now = now_ms();
        let settings = self.settings_view(now)?;
        if date > settings.today.as_str() || limit == 0 {
            return Ok(vec![]);
        }
        let zone =
            TimeZone::get(&settings.time_zone).map_err(|error| validation(error.to_string()))?;
        let day: Date = date
            .parse()
            .map_err(|error: jiff::Error| validation(error.to_string()))?;
        let cutoff = day
            .checked_sub(jiff::Span::new().days(14))
            .map_err(|error| validation(error.to_string()))?
            .to_string();
        // Acquire the writer slot before deciding whether this date has picks.
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let recorded: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM highlight_surfacings WHERE date = ?1)",
            [date],
            |row| row.get(0),
        )?;
        if !recorded {
            let mut statement = tx.prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT c.id, changes.created_at,
                        (SELECT MAX(h.date) FROM highlight_surfacings h
                         WHERE h.citation_id = c.id AND h.date < ?1) AS last_shown
                 FROM citations c
                 JOIN blocks b ON b.id = c.block_id
                 JOIN changes ON changes.seq = c.created_seq
                 JOIN sources s ON s.block_id = (
                     SELECT a.source_id FROM source_snapshots a WHERE a.snapshot_id = c.snapshot_id
                     ORDER BY a.change_seq, a.rowid LIMIT 1
                 )
                 JOIN blocks source ON source.id = s.block_id
                 WHERE c.active = 1 AND c.resurface_muted_at IS NULL
                 AND b.deletion_id IS NULL AND b.id NOT IN (SELECT id FROM hidden)
                 AND s.active = 1 AND source.deletion_id IS NULL AND source.id NOT IN (SELECT id FROM hidden)
                 AND (last_shown IS NULL OR last_shown <= ?2)"
            ))?;
            let mut candidates = Vec::new();
            let mut rows = statement.query(params![date, cutoff])?;
            while let Some(row) = rows.next()? {
                let created: i64 = row.get(1)?;
                let created_day = Timestamp::from_millisecond(created)
                    .map_err(|error| validation(error.to_string()))?
                    .to_zoned(zone.clone())
                    .date();
                if created_day < day {
                    let id: String = row.get(0)?;
                    let last: Option<String> = row.get(2)?;
                    candidates.push((last, shuffle_key(date, &id), id));
                }
            }
            candidates.sort_unstable();
            for (_, _, id) in candidates.into_iter().take(limit) {
                tx.execute(
                    "INSERT INTO highlight_surfacings(citation_id, date, shown_at) VALUES (?1, ?2, ?3)",
                    params![id, date, now],
                )?;
            }
        }
        let picks = {
            let mut statement = tx.prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT h.citation_id, c.block_id, h.action FROM highlight_surfacings h
                 JOIN citations c ON c.id = h.citation_id
                 JOIN blocks b ON b.id = c.block_id
                 JOIN sources s ON s.block_id = (
                     SELECT a.source_id FROM source_snapshots a WHERE a.snapshot_id = c.snapshot_id
                     ORDER BY a.change_seq, a.rowid LIMIT 1
                 )
                 JOIN blocks source ON source.id = s.block_id
                 WHERE h.date = ?1 AND c.active = 1 AND c.resurface_muted_at IS NULL
                 AND b.deletion_id IS NULL AND b.id NOT IN (SELECT id FROM hidden)
                 AND s.active = 1 AND source.deletion_id IS NULL AND source.id NOT IN (SELECT id FROM hidden)
                 ORDER BY h.rowid LIMIT ?2"
            ))?;
            statement
                .query_map(params![date, limit.min(i64::MAX as usize) as i64], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.commit()?;
        if picks.is_empty() {
            return Ok(vec![]);
        }
        let blocks: Vec<_> = picks.iter().map(|(_, block, _)| block.clone()).collect();
        let mut highlights: HashMap<_, _> = self
            .highlight_rows(
                &HighlightQuery {
                    limit: Some(usize::MAX),
                    ..Default::default()
                },
                Some(&blocks),
            )?
            .rows
            .into_iter()
            .map(|row| (row.citation.id.clone(), row))
            .collect();
        Ok(picks
            .into_iter()
            .filter_map(|(id, _, action)| {
                highlights.remove(&id).map(|row| Surfacing { row, action })
            })
            .collect())
    }

    pub fn record_surfacing(&mut self, citation_id: &str, date: &str, action: &str) -> Result<()> {
        validate_civil_date(date)?;
        if !matches!(action, "kept" | "opened" | "muted") {
            return Err(validation("surfacing action must be kept, opened or muted"));
        }
        let now = now_ms();
        if date > self.today(now)?.as_str() {
            return Err(validation("cannot record a surfacing for a future date"));
        }
        let tx = self.conn.transaction()?;
        if tx.execute(
            "UPDATE highlight_surfacings SET action = ?3, acted_at = ?4
             WHERE citation_id = ?1 AND date = ?2",
            params![citation_id, date, action, now],
        )? == 0
        {
            return Err(not_found(citation_id));
        }
        if action == "muted" {
            tx.execute(
                "UPDATE citations SET resurface_muted_at = ?2 WHERE id = ?1",
                params![citation_id, now],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
