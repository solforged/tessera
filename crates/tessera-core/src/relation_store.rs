//! Authored relation kinds with endpoints derived from links and ancestry.
use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};

use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, validate_id, validation};
use crate::{
    BlockCapabilities, BlockInPage, Notebook, RelationEndpoint, RelationInfo, RelationKind,
    RelationQuery, RelationRow, Result,
};

pub(crate) fn guard_other(conn: &Connection, id: &str, capability: &str) -> Result<()> {
    let active: bool = conn
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM relations WHERE block_id = ?1 AND active = 1)",
        )?
        .query_row([id], |row| row.get(0))?;
    if active {
        return Err(validation(format!(
            "A relation cannot also be {capability}."
        )));
    }
    Ok(())
}

pub(crate) fn set(conn: &Connection, id: &str, relation: Option<RelationKind>) -> Result<bool> {
    let Some(kind) = relation else {
        return Ok(conn
            .prepare_cached("UPDATE relations SET active = 0 WHERE block_id = ?1 AND active = 1")?
            .execute([id])?
            != 0);
    };
    let (ordinary, incompatible): (bool, bool) = conn
        .prepare_cached(
            "SELECT kind = 'block',
             EXISTS(SELECT 1 FROM positions WHERE block_id = b.id AND active = 1)
             OR EXISTS(SELECT 1 FROM questions WHERE block_id = b.id AND active = 1)
             OR EXISTS(SELECT 1 FROM assessments WHERE block_id = b.id AND active = 1)
             FROM blocks b WHERE id = ?1",
        )?
        .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    if incompatible {
        return Err(validation(
            "A relation cannot also be a perspective, question or answer.",
        ));
    }
    if !ordinary {
        return Err(validation("Make an ordinary block a relation."));
    }
    Ok(conn
        .prepare_cached(
            "INSERT INTO relations(block_id, active, kind) VALUES (?1, 1, ?2)
             ON CONFLICT(block_id) DO UPDATE SET active = 1, kind = excluded.kind
             WHERE relations.active = 0 OR relations.kind != excluded.kind",
        )?
        .execute(params![id, kind.as_str()])?
        != 0)
}

fn kind_at(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<RelationKind> {
    let value = row.get_ref(index)?.as_str().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    match value {
        "supports" => Ok(RelationKind::Supports),
        "disputes" => Ok(RelationKind::Disputes),
        "qualifies" => Ok(RelationKind::Qualifies),
        "answers" => Ok(RelationKind::Answers),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

// One ancestry walk for the requested edges, including inactive ancestors only
// as traversal steps. A closer question never shadows an attributed source.
pub(crate) fn derive(
    conn: &Connection,
    ids: Option<&[String]>,
) -> Result<HashMap<String, RelationInfo>> {
    let mut statement = conn.prepare_cached(concat!(
        hidden_blocks!(),
        ", candidates AS (
            SELECT b.id, b.parent_id, b.page_id, r.kind,
                (SELECT target_id FROM links WHERE source_id = b.id ORDER BY occurrence LIMIT 1) AS first_id
            FROM relations r JOIN blocks b ON b.id = r.block_id
            WHERE r.active = 1 AND (?1 IS NULL OR b.id IN (SELECT value FROM json_each(?1)))
        ), ancestors(edge, id, depth) AS (
            SELECT id, parent_id, 0 FROM candidates WHERE parent_id IS NOT NULL
            UNION ALL
            SELECT a.edge, b.parent_id, a.depth + 1 FROM ancestors a JOIN blocks b ON b.id = a.id
            WHERE b.parent_id IS NOT NULL
        ), owners AS (
            SELECT c.id, COALESCE(
                (SELECT a.id FROM ancestors a JOIN blocks b ON b.id = a.id
                 WHERE a.edge = c.id AND b.deletion_id IS NULL
                   AND (EXISTS(SELECT 1 FROM positions WHERE block_id = a.id AND active = 1)
                     OR EXISTS(SELECT 1 FROM assessments WHERE block_id = a.id AND active = 1))
                 ORDER BY a.depth LIMIT 1),
                (SELECT a.id FROM ancestors a JOIN blocks b ON b.id = a.id
                 JOIN questions q ON q.block_id = a.id AND q.active = 1
                 WHERE a.edge = c.id AND b.deletion_id IS NULL ORDER BY a.depth LIMIT 1),
                c.page_id) AS source_id FROM candidates c
        ) SELECT c.id, c.kind, o.source_id, target.id,
            CASE
                WHEN c.first_id IS NULL THEN 'Choose a target for this relation.'
                WHEN raw.id IS NULL OR raw.deletion_id IS NOT NULL OR root.deletion_id IS NOT NULL
                    THEN 'The relation target is deleted.'
                WHEN target.id IS NULL THEN 'The relation target is not available.'
                WHEN c.kind = 'answers' AND NOT EXISTS(
                    SELECT 1 FROM questions WHERE block_id = target.id AND active = 1)
                    THEN 'An answers relation needs a question as its target.'
            END
        FROM candidates c JOIN owners o ON o.id = c.id
        LEFT JOIN blocks raw ON raw.id = c.first_id
        LEFT JOIN blocks root ON root.id = raw.page_id
        LEFT JOIN blocks target ON target.id = raw.id AND target.kind IN ('block', 'page')
            AND target.deletion_id IS NULL AND root.deletion_id IS NULL
            AND target.rowid NOT IN (SELECT rowid FROM hidden)"
    ))?;
    Ok(statement
        .query_map(
            [ids.map(|ids| serde_json::to_string(ids).expect("block IDs serialize"))],
            |row| {
                Ok((
                    row.get(0)?,
                    RelationInfo {
                        kind: kind_at(row, 1)?,
                        source_id: row.get(2)?,
                        target_id: row.get(3)?,
                        problem: row.get(4)?,
                    },
                ))
            },
        )?
        .collect::<rusqlite::Result<_>>()?)
}

pub(crate) fn hydrate(
    conn: &Connection,
    mut capabilities: Vec<BlockCapabilities>,
) -> Result<Vec<BlockCapabilities>> {
    if capabilities.is_empty() {
        return Ok(capabilities);
    }
    let ids: Vec<_> = capabilities
        .iter()
        .map(|cap| cap.block_id.clone())
        .collect();
    let mut relations = derive(conn, Some(&ids))?;
    for capability in &mut capabilities {
        capability.relation = relations.remove(&capability.block_id);
        capability.merge_protected |= capability.relation.is_some();
    }
    Ok(capabilities)
}

// Capture both sides before and after edits, moves and capability changes so
// receipts refresh the old endpoints as well as the newly derived ones.
pub(crate) fn affected(conn: &Connection, id: &str, into: &mut HashSet<String>) -> Result<()> {
    let ids = conn
        .prepare_cached(
            "WITH RECURSIVE subtree(id) AS (
                SELECT id FROM blocks WHERE id = ?1
                UNION ALL SELECT b.id FROM blocks b JOIN subtree s ON b.parent_id = s.id
             ) SELECT r.block_id FROM subtree s JOIN relations r ON r.block_id = s.id
               WHERE r.active = 1
               UNION
               SELECT r.block_id FROM subtree s JOIN links l ON l.target_id = s.id
               JOIN relations r ON r.block_id = l.source_id
               WHERE r.active = 1 AND l.occurrence = (
                   SELECT MIN(occurrence) FROM links WHERE source_id = r.block_id)",
        )?
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    if !ids.is_empty() {
        for (edge, info) in derive(conn, Some(&ids))? {
            into.insert(edge);
            into.insert(info.source_id);
            into.extend(info.target_id);
        }
    }
    Ok(())
}

impl Notebook {
    pub fn relations(&self, query: &RelationQuery) -> Result<Vec<RelationRow>> {
        if query.kind.is_none()
            && query.source.is_none()
            && query.target.is_none()
            && query.source_holder.is_none()
            && query.target_holder.is_none()
            && query.subject.is_none()
        {
            return Err(validation(
                "Choose a relation kind, source, target, holder or subject.",
            ));
        }
        for id in [
            &query.source,
            &query.target,
            &query.source_holder,
            &query.target_holder,
            &query.subject,
        ]
        .into_iter()
        .flatten()
        {
            validate_id(id)?;
        }
        let mut infos = derive(&self.conn, None)?;
        infos.retain(|_, info| {
            query.kind.is_none_or(|kind| kind == info.kind)
                && query
                    .source
                    .as_ref()
                    .is_none_or(|source| source == &info.source_id)
                && query
                    .target
                    .as_ref()
                    .is_none_or(|target| Some(target) == info.target_id.as_ref())
        });
        if infos.is_empty() {
            return Ok(Vec::new());
        }
        let mut endpoint_ids = HashSet::new();
        for info in infos.values() {
            endpoint_ids.insert(info.source_id.clone());
            endpoint_ids.extend(info.target_id.iter().cloned());
        }
        let endpoint_ids: Vec<_> = endpoint_ids.into_iter().collect();
        let positions = crate::position_store::derive(&self.conn, Some(&endpoint_ids))?;
        let holder_matches = |filter: &Option<String>, endpoint: Option<&str>| {
            filter.as_deref().is_none_or(|holder| {
                endpoint.is_some_and(|id| {
                    id == holder
                        || positions
                            .get(id)
                            .and_then(|position| position.holder_id.as_deref())
                            == Some(holder)
                })
            })
        };
        infos.retain(|_, info| {
            holder_matches(&query.source_holder, Some(&info.source_id))
                && holder_matches(&query.target_holder, info.target_id.as_deref())
        });
        if let Some(subject) = &query.subject {
            // A perspective filed under an inline question still belongs to that question's page.
            let subjects: Vec<_> = positions
                .values()
                .map(|position| position.subject_id.clone())
                .collect();
            let pages: HashMap<String, String> = self
                .conn
                .prepare_cached(
                    "SELECT id, page_id FROM blocks WHERE id IN (SELECT value FROM json_each(?1))",
                )?
                .query_map(
                    [serde_json::to_string(&subjects).expect("IDs serialize")],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?
                .collect::<rusqlite::Result<_>>()?;
            let filed = |id: Option<&str>| {
                id.and_then(|id| positions.get(id)).is_some_and(|position| {
                    pages
                        .get(&position.subject_id)
                        .unwrap_or(&position.subject_id)
                        == subject
                })
            };
            infos
                .retain(|_, info| filed(Some(&info.source_id)) && filed(info.target_id.as_deref()));
        }
        if infos.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<_> = infos.keys().chain(endpoint_ids.iter()).collect();
        let blocks: HashMap<String, BlockInPage> = self
            .conn
            .prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT ",
                block_columns!("b"),
                ", ",
                block_columns!("p"),
                " FROM blocks b JOIN blocks p ON p.id = b.page_id
                  WHERE b.id IN (SELECT value FROM json_each(?1))
                    AND b.deletion_id IS NULL AND p.deletion_id IS NULL
                    AND b.rowid NOT IN (SELECT rowid FROM hidden)"
            ))?
            .query_map(
                [serde_json::to_string(&ids).expect("IDs serialize")],
                |row| {
                    let block = block_at(row, 0)?;
                    Ok((
                        block.id.clone(),
                        BlockInPage {
                            block,
                            page: block_at(row, 10)?,
                        },
                    ))
                },
            )?
            .collect::<rusqlite::Result<_>>()?;
        let endpoint = |id: &str| {
            let block = blocks.get(id)?.clone();
            let holder_id = positions
                .get(id)
                .and_then(|position| position.holder_id.clone());
            Some(RelationEndpoint { block, holder_id })
        };
        let mut rows = Vec::new();
        for (id, info) in infos {
            let Some(block) = blocks.get(&id) else {
                continue;
            };
            let Some(source) = endpoint(&info.source_id) else {
                continue;
            };
            let target = info.target_id.as_deref().and_then(endpoint);
            rows.push(RelationRow {
                block: block.clone(),
                kind: info.kind,
                source,
                target,
                problem: info.problem,
            });
        }
        rows.sort_unstable_by(|left, right| {
            (&left.block.page.id, &left.block.block.id)
                .cmp(&(&right.block.page.id, &right.block.block.id))
        });
        if let Some(limit) = query.limit {
            rows.truncate(limit as usize);
        }
        Ok(rows)
    }
}
