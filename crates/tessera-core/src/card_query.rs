use rusqlite::{Connection, OptionalExtension, params};

use crate::card_store::card_at;
use crate::query::validate_source_query;
use crate::review_store::{review_event_at, review_pacing};
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
        let has_templates: bool =
            self.conn
                .query_row("SELECT EXISTS(SELECT 1 FROM card_templates)", [], |row| {
                    row.get(0)
                })?;
        let (day_start, day_end) = if has_templates {
            let (_, start, end) = crate::card_templates::local_day(&self.conn, now)?;
            (start, end)
        } else {
            (0, 0)
        };
        // Select and count units before limiting. Only the returned units need
        // grade evidence, and a count-only row preserves total for limit zero.
        let mut statement = self.conn.prepare_cached(concat!(
            review_pacing!(),
            ", queue AS MATERIALIZED (
                SELECT * FROM ranked WHERE ?4 = 'all'
                UNION ALL
                SELECT * FROM paced
                WHERE (?4 = 'due' AND due_at <= ?5) OR (?4 = 'new' AND is_new)
            ), selected AS MATERIALIZED (
                SELECT * FROM queue ORDER BY is_new, due_at,
                    CASE WHEN is_new AND new_per_day IS NOT NULL THEN new_position END, id LIMIT ?6
            ), grades AS (
                SELECT e.id AS event_id, e.card_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY e.card_id ORDER BY e.created_at DESC, e.change_seq DESC, e.event_order DESC, e.id DESC
                    ) AS position
                FROM effective_review_events e JOIN selected s ON s.id = e.card_id
                WHERE e.kind = 'grade'
            )
            SELECT c.id, c.source_block_id, c.key, c.kind, c.active,
                c.definition_revision, c.front, c.back, c.revision, c.schedule, c.held, ",
            block_columns!("b"),
            ", ",
            block_columns!("p"),
            ", e.id, e.card_id, e.session_id, e.kind, e.grade, e.shown_front,
                e.shown_back, e.definition_revision, e.scheduler_version,
                e.before_state, e.after_state, e.created_at, e.change_seq, totals.total,
                t.id, t.name, t.type_id, tp.text,
                (SELECT CAST(g.key AS INTEGER) FROM occlusions o, json_each(o.state, '$.groups') g
                 WHERE o.block_id = c.source_block_id AND c.key = 'occlusion:' || json_extract(g.value, '$.id'))
            FROM (SELECT COUNT(*) AS total FROM queue) totals
            LEFT JOIN selected s ON 1
            LEFT JOIN card_units c ON c.id = s.id
            LEFT JOIN blocks b ON b.id = c.source_block_id
            LEFT JOIN blocks p ON p.id = b.page_id
            LEFT JOIN grades g ON g.card_id = c.id AND g.position = 1
            LEFT JOIN review_events e ON e.id = g.event_id
            LEFT JOIN card_templates t ON c.key = 'tpl:' || t.id
            LEFT JOIN blocks tp ON tp.id = t.type_id
            ORDER BY s.is_new, s.due_at,
                CASE WHEN s.is_new AND s.new_per_day IS NOT NULL THEN s.new_position END, s.id"
        ))?;
        let mut cursor = statement.query(params![
            source_ids,
            day_start,
            day_end,
            selection,
            now,
            query.limit.unwrap_or(500) as i64,
        ])?;
        let mut rows = Vec::new();
        let mut total = 0;
        while let Some(row) = cursor.next()? {
            // Eleven card columns, two ten-column blocks, then thirteen event columns.
            total = row.get::<_, i64>(44)? as usize;
            if matches!(row.get_ref(0)?, rusqlite::types::ValueRef::Null) {
                continue;
            }
            let last_review = if matches!(row.get_ref(31)?, rusqlite::types::ValueRef::Null) {
                None
            } else {
                Some(review_event_at(row, 31)?)
            };
            let mut card = card_at(row, 0)?;
            card.occlusion_index = row.get::<_, Option<i64>>(49)?.map(|index| index as usize);
            if let Some(id) = row.get::<_, Option<String>>(45)? {
                card.template = Some(crate::CardTemplateProvenance {
                    id,
                    name: row.get(46)?,
                    type_id: row.get(47)?,
                    type_name: row.get(48)?,
                });
            }
            rows.push(CardRow {
                card,
                source: BlockInPage {
                    block: block_at(row, 11)?,
                    page: block_at(row, 21)?,
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
