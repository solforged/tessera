//! Note-only predicates and multi-heading grouping over the ordinary shared query.
use std::collections::{HashMap, HashSet};

use crate::aliases::fold;
use crate::reads::hidden_blocks;
use crate::storage::{validate_id, validation};
use crate::{NoteGroup, Notebook, Query, QueryRow, Reading, Result};

impl Query {
    pub(crate) fn selects_notes(&self) -> bool {
        self.note_kind.is_some()
            || !self.links.is_empty()
            || !self.from.is_empty()
            || !self.cites.is_empty()
    }
}

impl Notebook {
    pub(crate) fn note_candidates(&self, query: &Query) -> Result<Option<HashSet<String>>> {
        if !query.selects_notes() {
            return Ok(None);
        }
        let mut pages: HashMap<String, String> =
            self.conn
                .prepare_cached(concat!(hidden_blocks!(),
            "SELECT b.id, b.text FROM blocks b WHERE b.kind = 'page' AND b.deletion_id IS NULL
             AND b.rowid NOT IN (SELECT rowid FROM hidden)"))?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
        if let Some(kind) = &query.note_kind {
            let members: HashSet<_> = self
                .kind_notes(kind)?
                .notes
                .into_iter()
                .map(|note| note.id)
                .collect();
            pages.retain(|id, _| members.contains(id));
        }
        if let Some(text) = &query.text {
            let glosses = self.named_page_values("gloss", None)?;
            let words: Vec<_> = text.split_whitespace().map(fold).collect();
            pages.retain(|id, title| {
                let title = fold(title);
                let gloss = glosses
                    .get(id)
                    .map(|values| fold(&values.join(" ")))
                    .unwrap_or_default();
                words
                    .iter()
                    .all(|word| title.contains(word) || gloss.contains(word))
            });
        }
        let sources = if query.cites.is_empty() {
            None
        } else {
            Some(self.kind_notes("source")?)
        };
        for (terms, direction) in [
            (&query.links, "links"),
            (&query.from, "from"),
            (&query.cites, "cites"),
        ] {
            for term in terms {
                let mut ids: HashSet<String> = if validate_id(term).is_ok() {
                    HashSet::from([term.clone()])
                } else {
                    self.resolve_name(term)?
                        .into_iter()
                        .map(|matched| matched.page.id)
                        .collect()
                };
                if let Some(sources) = &sources
                    && direction == "cites"
                {
                    let key = fold(term);
                    for (id, summary) in &sources.summaries {
                        if let Some(source) = &summary.source
                            && (fold(&source.siglum) == key
                                || source
                                    .citation_key
                                    .as_ref()
                                    .is_some_and(|value| fold(value) == key))
                        {
                            ids.insert(id.clone());
                        }
                    }
                    ids.retain(|id| sources.summaries.contains_key(id));
                }
                // An ambiguous title or alias requires an explicit page selection; never union guesses.
                if ids.len() != 1 {
                    pages.clear();
                    continue;
                }
                let target = ids.into_iter().next().expect("one resolved target");
                let sql = match direction {
                    "links" => concat!(hidden_blocks!(), "SELECT DISTINCT b.page_id FROM links l JOIN blocks b ON b.id = l.source_id
                        WHERE l.target_id = ?1 AND b.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden)"),
                    "from" => concat!(hidden_blocks!(), "SELECT DISTINCT t.id FROM links l JOIN blocks b ON b.id = l.source_id
                        JOIN blocks t ON t.id = l.target_id WHERE b.page_id = ?1 AND t.kind = 'page'
                        AND b.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden)"),
                    _ => concat!(hidden_blocks!(), "SELECT DISTINCT b.page_id FROM blocks b WHERE b.deletion_id IS NULL
                        AND b.rowid NOT IN (SELECT rowid FROM hidden) AND (
                        EXISTS(SELECT 1 FROM links l WHERE l.source_id = b.id AND l.target_id = ?1)
                        OR EXISTS(SELECT 1 FROM citations c JOIN source_snapshots s ON s.snapshot_id = c.snapshot_id
                            WHERE c.block_id = b.id AND c.active = 1 AND s.source_id = ?1))"),
                };
                let matches: HashSet<String> = self
                    .conn
                    .prepare_cached(sql)?
                    .query_map([target], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                pages.retain(|id, _| matches.contains(id));
            }
        }
        Ok(Some(pages.into_keys().collect()))
    }

    pub(crate) fn note_groups(&self, query: &Query, rows: &[QueryRow]) -> Result<Vec<NoteGroup>> {
        let Some(view) = &query.note_view else {
            return Ok(Vec::new());
        };
        let grouping = view.grouping.as_str();
        if grouping == "letter" {
            return Ok(Vec::new());
        }
        let field = grouping.strip_prefix("field:");
        if !matches!(grouping, "source" | "link" | "created") && field.is_none() {
            return Err(validation("unknown note grouping"));
        }
        let ids: Vec<_> = rows.iter().map(|row| &row.block.block.id).collect();
        let selected = serde_json::to_string(&ids).expect("note ids serialize");
        let mut headings: HashMap<String, Vec<(String, String)>> = HashMap::new();
        let mut sigla = HashMap::new();
        if grouping == "source" || grouping == "link" {
            let sql = if grouping == "link" {
                concat!(hidden_blocks!(), "SELECT DISTINCT b.page_id, t.id, t.text FROM links l
                    JOIN blocks b ON b.id = l.source_id JOIN blocks t ON t.id = l.target_id
                    WHERE b.page_id IN (SELECT value FROM json_each(?1)) AND t.kind = 'page'
                    AND b.deletion_id IS NULL AND t.deletion_id IS NULL
                    AND b.rowid NOT IN (SELECT rowid FROM hidden) AND t.rowid NOT IN (SELECT rowid FROM hidden)")
            } else {
                concat!(
                    hidden_blocks!(),
                    "SELECT DISTINCT b.page_id, t.id, t.text FROM (
                    SELECT l.source_id AS block_id, l.target_id AS source_id FROM links l
                    UNION SELECT c.block_id, a.source_id FROM citations c
                    JOIN source_snapshots a ON a.snapshot_id = c.snapshot_id WHERE c.active = 1
                    ) refs JOIN blocks b ON b.id = refs.block_id
                    JOIN sources s ON s.block_id = refs.source_id AND s.active = 1
                    JOIN blocks t ON t.id = s.block_id
                    WHERE b.page_id IN (SELECT value FROM json_each(?1)) AND b.deletion_id IS NULL
                    AND t.deletion_id IS NULL AND b.rowid NOT IN (SELECT rowid FROM hidden)
                    AND t.rowid NOT IN (SELECT rowid FROM hidden)"
                )
            };
            let mut statement = self.conn.prepare_cached(sql)?;
            for row in statement.query_map([&selected], |row| {
                Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?))
            })? {
                let (id, target, title) = row?;
                headings.entry(id).or_default().push((target, title));
            }
            if grouping == "source" {
                sigla = self
                    .kind_notes("source")?
                    .summaries
                    .into_iter()
                    .filter_map(|(id, summary)| summary.source.map(|source| (id, source.siglum)))
                    .collect();
            }
        } else if grouping == "created" {
            let mut statement = self.conn.prepare_cached("SELECT id, strftime('%Y-%m', created_at / 1000, 'unixepoch') FROM blocks WHERE id IN (SELECT value FROM json_each(?1))")?;
            for row in statement.query_map([&selected], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })? {
                let (id, month) = row?;
                headings.insert(id, vec![(month.clone(), month)]);
            }
        }
        let mut groups: HashMap<String, NoteGroup> = HashMap::new();
        for row in rows {
            let id = &row.block.block.id;
            let values = if let Some(field) = field {
                row.values
                    .get(field)
                    .into_iter()
                    .flatten()
                    .map(|value| {
                        let title = match &value.reading {
                            Reading::Value { value, .. } => match value {
                                crate::ReadingValue::Text(value) => value.clone(),
                                crate::ReadingValue::Number(value) => value.to_string(),
                                crate::ReadingValue::Checkbox(value) => value.to_string(),
                            },
                            Reading::Problem { .. } => value.text.clone(),
                        };
                        (title.clone(), title)
                    })
                    .collect::<Vec<_>>()
            } else {
                headings.remove(id).unwrap_or_default()
            };
            let values = if values.is_empty() {
                vec![(String::new(), "None".into())]
            } else {
                values
            };
            for (key, title) in values {
                let group = groups.entry(key.clone()).or_insert_with(|| NoteGroup {
                    target: if !key.is_empty() && matches!(grouping, "source" | "link") {
                        Some(key.clone())
                    } else {
                        None
                    },
                    siglum: sigla.get(&key).cloned(),
                    key,
                    title,
                    note_ids: Vec::new(),
                });
                if group.note_ids.last() != Some(id) {
                    group.note_ids.push(id.clone());
                }
            }
        }
        let mut groups: Vec<_> = groups.into_values().collect();
        if grouping == "created" {
            groups.sort_by(|a, b| {
                a.key
                    .is_empty()
                    .cmp(&b.key.is_empty())
                    .then_with(|| b.key.cmp(&a.key))
            });
        } else {
            groups.sort_by_cached_key(|group| {
                (
                    group.key.is_empty(),
                    std::cmp::Reverse(group.note_ids.len()),
                    fold(&group.title),
                    group.key.clone(),
                )
            });
        }
        Ok(groups)
    }
}
