use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::library::SourceFormat;
use crate::library_store::{json, source_at, source_columns, source_siglum};
use crate::reads::hidden_blocks;
use crate::{NoteEntry, Notebook, Result, SeeTarget};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SummaryField {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSummary {
    pub siglum: String,
    pub citation_key: Option<String>,
    pub format: SourceFormat,
    pub authors: Vec<String>,
    pub publisher: Option<String>,
    pub published: Option<String>,
    pub highlights: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteSummary {
    pub preview: Option<String>,
    pub field: Option<SummaryField>,
    /// Nonempty visible prose descendants, excluding headings and field subtrees.
    pub block_count: usize,
    /// Nonempty visible descendants; an archived subtree cannot make a queue row With text.
    pub text_blocks: usize,
    /// The first three prose blocks, kept separate from a standfirst preview.
    pub prose_excerpt: Vec<String>,
    /// Distinct visible referring blocks, matching the ordinary backlinks read, not citations.
    pub backlinks: usize,
    pub referenced_from: Vec<SeeTarget>,
    pub source: Option<SourceSummary>,
}

impl Notebook {
    /// One set-based read per kind of apparatus, never a page or backlink read per row.
    pub(crate) fn index_summaries(
        &self,
        notes: &[NoteEntry],
        type_id: Option<&str>,
    ) -> Result<HashMap<String, NoteSummary>> {
        if notes.is_empty() {
            return Ok(HashMap::new());
        }
        let ids: Vec<_> = notes.iter().map(|note| note.id.clone()).collect();
        let selected = json(&ids);
        let mut summaries: HashMap<_, _> = notes
            .iter()
            .map(|note| (note.id.clone(), NoteSummary::default()))
            .collect();
        let definitions = crate::fields::definitions(&self.conn)?;
        let definition_ids: HashSet<_> =
            definitions.iter().map(|field| field.id.as_str()).collect();
        let mut readings = crate::library_export::field_readings(&self.conn, &ids)?;
        let template = type_id
            .map(|id| crate::query::template(&self.conn, id))
            .transpose()?
            .unwrap_or_default();
        let standfirsts: Vec<_> = definitions
            .iter()
            .filter(|field| field.role == crate::FieldRole::Standfirst)
            .map(|field| field.name.to_lowercase())
            .collect();
        let template: Vec<_> = template
            .iter()
            .filter_map(|id| definitions.iter().find(|field| &field.id == id))
            .filter(|field| field.role != crate::FieldRole::Standfirst)
            .map(|field| (field, field.name.to_lowercase()))
            .collect();
        for note in notes {
            let summary = summaries.get_mut(&note.id).expect("selected note");
            if let Some(fields) = readings.get(&note.id) {
                summary.preview = standfirsts.iter().find_map(|name| {
                    fields
                        .get(name)?
                        .iter()
                        .find(|value| !value.trim().is_empty())
                        .cloned()
                });
                summary.field = template.iter().find_map(|(definition, name)| {
                    let value = fields
                        .get(name)?
                        .iter()
                        .find(|value| !value.trim().is_empty())?;
                    Some(SummaryField {
                        name: definition.name.clone(),
                        value: value.clone(),
                    })
                });
            }
        }
        // Preorder paths preserve outline order. Field ancestry is carried in Rust so an empty
        // field entry (which has no field_values row) and all its descendants are excluded too.
        let mut statement = self.conn.prepare_cached(
            "WITH RECURSIVE below(page, id, parent, text, heading, visible, path) AS (
                 SELECT b.page_id, b.id, b.parent_id, b.text, b.heading, b.archived = 0,
                        printf('%d%016x', b.ordinal >= 0, b.ordinal) || b.id
                 FROM blocks b WHERE b.parent_id IN (SELECT value FROM json_each(?1))
                   AND b.deletion_id IS NULL
                 UNION ALL
                 SELECT b.page_id, b.id, b.parent_id, b.text, b.heading,
                        s.visible AND b.archived = 0, s.path || '/' || printf('%d%016x', b.ordinal >= 0, b.ordinal) || b.id
                 FROM blocks b JOIN below s ON b.parent_id = s.id WHERE b.deletion_id IS NULL
             ) SELECT page, id, parent, text, heading, visible FROM below ORDER BY page, path",
        )?;
        let mut rows = statement.query([&selected])?;
        let mut field_blocks = HashSet::new();
        while let Some(row) = rows.next()? {
            let page: String = row.get(0)?;
            let id: String = row.get(1)?;
            let parent: String = row.get(2)?;
            let text: String = row.get(3)?;
            let heading: Option<i64> = row.get(4)?;
            let visible: bool = row.get(5)?;
            let field = field_blocks.contains(&parent)
                || crate::fields::reference(&text).is_some_and(|id| definition_ids.contains(id));
            if field {
                field_blocks.insert(id);
            }
            let summary = summaries.get_mut(&page).expect("selected subtree");
            let prose = visible && !field && heading.is_none() && !text.trim().is_empty();
            if prose {
                summary.block_count += 1;
            }
            if visible && !text.trim().is_empty() {
                summary.text_blocks += 1;
                if summary.preview.is_none() && !field && heading.is_none() {
                    summary.preview = Some(text.clone());
                }
            }
            if prose && summary.prose_excerpt.len() < 3 {
                summary.prose_excerpt.push(text);
            }
        }
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT DISTINCT l.target_id, b.id, p.id, p.text FROM links l
             JOIN blocks b ON b.id = l.source_id JOIN blocks p ON p.id = b.page_id
             WHERE l.target_id IN (SELECT value FROM json_each(?1))
               AND b.deletion_id IS NULL AND p.deletion_id IS NULL
               AND b.rowid NOT IN (SELECT rowid FROM hidden)
             ORDER BY l.target_id, p.title_key, p.id, b.id"
        ))?;
        let mut rows = statement.query([&selected])?;
        while let Some(row) = rows.next()? {
            let target: String = row.get(0)?;
            let page: String = row.get(2)?;
            let summary = summaries
                .get_mut(&target)
                .expect("selected backlink target");
            summary.backlinks += 1;
            if !summary
                .referenced_from
                .iter()
                .any(|target| target.id == page)
            {
                summary.referenced_from.push(SeeTarget {
                    id: page,
                    title: row.get(3)?,
                });
            }
        }
        let mut highlight_counts: HashMap<String, usize> = HashMap::new();
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT s.block_id, COUNT(*) FROM citations c JOIN blocks b ON b.id = c.block_id
             JOIN blocks p ON p.id = b.page_id JOIN sources s ON s.block_id = (
                 SELECT a.source_id FROM source_snapshots a WHERE a.snapshot_id = c.snapshot_id
                 ORDER BY a.change_seq, a.rowid LIMIT 1)
             WHERE s.block_id IN (SELECT value FROM json_each(?1)) AND c.active = 1
               AND b.deletion_id IS NULL AND p.deletion_id IS NULL
               AND b.rowid NOT IN (SELECT rowid FROM hidden) GROUP BY s.block_id"
        ))?;
        for row in statement.query_map([&selected], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
        })? {
            let (id, count) = row?;
            highlight_counts.insert(id, count);
        }
        let mut statement = self.conn.prepare_cached(concat!(
            "SELECT ",
            source_columns!(),
            ", b.text FROM sources s JOIN blocks b ON b.id = s.block_id
             WHERE s.active = 1 AND s.block_id IN (SELECT value FROM json_each(?1))"
        ))?;
        let mut rows = statement.query([&selected])?;
        while let Some(row) = rows.next()? {
            let mut source = source_at(row)?;
            let fields = readings.remove(&source.block_id).unwrap_or_default();
            source_siglum(&mut source, &row.get::<_, String>(10)?, &fields);
            let first = |name: &str| fields.get(name).and_then(|values| values.first()).cloned();
            let summary = summaries
                .get_mut(&source.block_id)
                .expect("selected source");
            summary.source = Some(SourceSummary {
                siglum: source.siglum,
                citation_key: source.citation_key,
                format: source.format,
                authors: fields.get("author").cloned().unwrap_or_default(),
                publisher: first("publisher"),
                published: first("published"),
                highlights: highlight_counts
                    .remove(&source.block_id)
                    .unwrap_or_default(),
            });
        }
        Ok(summaries)
    }
}
