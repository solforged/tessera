use rusqlite::{Connection, OptionalExtension, params};

use crate::card_store::card_at;
use crate::query::validate_source_query;
use crate::reads::hidden_blocks;
use crate::review_store::review_event_at;
use crate::storage::{block_at, block_columns, not_found, validate_id, validation};
use crate::{
    BlockInPage, CardQuery, CardQueryResult, CardRow, CardSelection, Deck, Notebook, Result,
};

fn validate_limit(query: &CardQuery) -> Result<()> {
    if query.limit.is_some_and(|limit| limit > 2000) {
        return Err(validation("card query limit must not exceed 2000"));
    }
    Ok(())
}

pub(crate) fn validate(conn: &Connection, query: &CardQuery) -> Result<()> {
    validate_limit(query)?;
    if let Some(source) = &query.source {
        validate_source_query(conn, source)?;
    }
    Ok(())
}

fn stored_deck(row: &rusqlite::Row<'_>) -> rusqlite::Result<Deck> {
    let json: String = row.get(2)?;
    let query = serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(Deck {
        id: row.get(0)?,
        name: row.get(1)?,
        query,
        revision: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

impl Notebook {
    pub fn card_query(&self, query: &CardQuery, now: i64) -> Result<CardQueryResult> {
        validate_limit(query)?;
        let source_ids = if let Some(source) = &query.source {
            let sources = self.query_all_sources(source)?;
            let ids: Vec<_> = sources
                .rows
                .into_iter()
                .map(|row| row.block.block.id)
                .collect();
            if ids.is_empty() {
                return Ok(CardQueryResult {
                    rows: Vec::new(),
                    total: 0,
                });
            }
            Some(serde_json::to_string(&ids).expect("source IDs serialize"))
        } else {
            None
        };
        let selection = match query.selection {
            CardSelection::Due => "due",
            CardSelection::New => "new",
            CardSelection::All => "all",
        };
        // Select and count units before limiting. Only the returned units need
        // grade evidence, and a count-only row preserves total for limit zero.
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            ", eligible AS MATERIALIZED (
                SELECT c.id,
                    json_extract(c.schedule, '$.last_reviewed_at') IS NULL AS is_new,
                    json_extract(c.schedule, '$.due_at') AS due_at
                FROM card_units c
                JOIN blocks b ON b.id = c.source_block_id
                JOIN blocks p ON p.id = b.page_id
                WHERE c.active = 1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL
                    AND b.rowid NOT IN (SELECT rowid FROM hidden)
                    AND (?1 = 'all'
                        OR (?1 = 'due' AND json_extract(c.schedule, '$.due_at') <= ?2)
                        OR (?1 = 'new' AND json_extract(c.schedule, '$.last_reviewed_at') IS NULL))
                    AND (?3 IS NULL OR c.source_block_id IN (SELECT value FROM json_each(?3)))
            ), selected AS MATERIALIZED (
                SELECT * FROM eligible ORDER BY is_new, due_at, id LIMIT ?4
            ), grades AS (
                SELECT e.rowid AS event_rowid, e.card_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY e.card_id ORDER BY e.created_at DESC, e.rowid DESC
                    ) AS position
                FROM review_events e JOIN selected s ON s.id = e.card_id
                WHERE e.kind = 'grade'
            )
            SELECT c.id, c.source_block_id, c.key, c.kind, c.active,
                c.definition_revision, c.front, c.back, c.revision, c.schedule, ",
            block_columns!("b"),
            ", ",
            block_columns!("p"),
            ", e.id, e.card_id, e.session_id, e.kind, e.grade, e.shown_front,
                e.shown_back, e.definition_revision, e.scheduler_version,
                e.before_state, e.after_state, e.created_at, e.change_seq, totals.total
            FROM (SELECT COUNT(*) AS total FROM eligible) totals
            LEFT JOIN selected s ON 1
            LEFT JOIN card_units c ON c.id = s.id
            LEFT JOIN blocks b ON b.id = c.source_block_id
            LEFT JOIN blocks p ON p.id = b.page_id
            LEFT JOIN grades g ON g.card_id = c.id AND g.position = 1
            LEFT JOIN review_events e ON e.rowid = g.event_rowid
            ORDER BY s.is_new, s.due_at, s.id"
        ))?;
        let mut cursor = statement.query(params![
            selection,
            now,
            source_ids,
            query.limit.unwrap_or(500) as i64,
        ])?;
        let mut rows = Vec::new();
        let mut total = 0;
        while let Some(row) = cursor.next()? {
            // Ten card columns, two ten-column blocks, then thirteen event columns.
            total = row.get::<_, i64>(43)? as usize;
            if matches!(row.get_ref(0)?, rusqlite::types::ValueRef::Null) {
                continue;
            }
            let last_review = if matches!(row.get_ref(30)?, rusqlite::types::ValueRef::Null) {
                None
            } else {
                Some(review_event_at(row, 30)?)
            };
            rows.push(CardRow {
                card: card_at(row, 0)?,
                source: BlockInPage {
                    block: block_at(row, 10)?,
                    page: block_at(row, 20)?,
                },
                last_review,
            });
        }
        Ok(CardQueryResult { rows, total })
    }

    pub fn decks(&self) -> Result<Vec<Deck>> {
        let mut decks = self
            .conn
            .prepare_cached("SELECT id, name, query, revision, created_at, updated_at FROM decks")?
            .query_map([], stored_deck)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        decks.sort_by_cached_key(|deck| (deck.name.to_lowercase(), deck.id.clone()));
        Ok(decks)
    }

    pub fn deck(&self, id: &str) -> Result<Deck> {
        validate_id(id)?;
        self.conn
            .prepare_cached(
                "SELECT id, name, query, revision, created_at, updated_at FROM decks WHERE id = ?1",
            )?
            .query_row([id], stored_deck)
            .optional()?
            .ok_or_else(|| not_found(id))
    }
}
