use rusqlite::{Row, params};
use serde::{Deserialize, Serialize};

use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, not_found, tag_tokens, validate_id, validation};
use crate::{Block, BlockKind, Notebook, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageReferences {
    pub total: usize,
    pub groups: Vec<ReferenceGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferenceGroup {
    pub page: Block,
    pub sources: Vec<ReferenceSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferenceSource {
    pub source: Block,
    pub targets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferenceCount {
    pub block_id: String,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnlinkedMentions {
    pub total: usize,
    pub rows: Vec<Mention>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mention {
    pub block: Block,
    pub page: Block,
    pub term: String,
}

// Start at the indexed target page, then the links_target index. The same
// visible target/source relation serves grouped references and badge counts.
macro_rules! page_links {
    () => {
        " , page_links AS MATERIALIZED (
            SELECT b.id AS source_id, b.page_id, t.id AS target_id,
                   MIN(l.occurrence) AS occurrence
            FROM blocks t JOIN links l ON l.target_id = t.id
            JOIN blocks b ON b.id = l.source_id JOIN blocks p ON p.id = b.page_id
            WHERE t.page_id = ?1 AND t.deletion_id IS NULL
              AND b.deletion_id IS NULL AND p.deletion_id IS NULL
              AND t.rowid NOT IN (SELECT rowid FROM hidden)
              AND b.rowid NOT IN (SELECT rowid FROM hidden)
            GROUP BY b.id, t.id
        ) "
    };
}

// A sign bit followed by the low 63 bits sorts signed ordinals correctly,
// including the negative ordinals produced by repeated prepends. ID breaks
// sibling ties; the slash-terminated ancestor path puts parents before children.
const PAGE_REFERENCES: &str = concat!(
    hidden_blocks!(),
    page_links!(),
    ", sources AS MATERIALIZED (
        SELECT source_id, page_id FROM page_links WHERE page_id != ?1 GROUP BY source_id
    ), newest AS (
        SELECT page_id, MAX(source_id) AS newest FROM sources GROUP BY page_id
    ), ancestry(source_id, parent_id, path) AS (
        SELECT s.source_id, b.parent_id,
               (CASE WHEN b.ordinal < 0 THEN '0' ELSE '1' END) ||
               printf('%016llx', b.ordinal & 9223372036854775807) || b.id || '/'
        FROM sources s JOIN blocks b ON b.id = s.source_id
        UNION ALL
        SELECT a.source_id, b.parent_id,
               (CASE WHEN b.ordinal < 0 THEN '0' ELSE '1' END) ||
               printf('%016llx', b.ordinal & 9223372036854775807) || b.id || '/' || a.path
        FROM ancestry a JOIN blocks b ON b.id = a.parent_id
    ), selected AS MATERIALIZED (
        SELECT s.source_id, s.page_id, n.newest, a.path
        FROM sources s JOIN newest n ON n.page_id = s.page_id
        JOIN ancestry a ON a.source_id = s.source_id AND a.parent_id IS NULL
        ORDER BY n.newest DESC, a.path LIMIT ?2
    ) SELECT root.kind, root.parent_id, (SELECT COUNT(*) FROM sources), ",
    block_columns!("b"),
    ", ",
    block_columns!("p"),
    ", l.target_id FROM blocks root
    LEFT JOIN selected s ON 1
    LEFT JOIN blocks b ON b.id = s.source_id
    LEFT JOIN blocks p ON p.id = s.page_id
    LEFT JOIN page_links l ON l.source_id = s.source_id
    WHERE root.id = ?1 AND root.deletion_id IS NULL
    ORDER BY s.newest DESC, s.path, l.occurrence"
);

const REFERENCE_COUNTS: &str = concat!(
    hidden_blocks!(),
    page_links!(),
    ", counts AS (
        SELECT target_id, COUNT(*) AS count FROM page_links
        WHERE source_id != target_id GROUP BY target_id
    ) SELECT root.kind, root.parent_id, c.target_id, c.count
      FROM blocks root LEFT JOIN counts c ON 1
      WHERE root.id = ?1 AND root.deletion_id IS NULL ORDER BY c.target_id"
);

fn check_page(row: Option<&Row<'_>>, id: &str) -> Result<()> {
    let row = row.ok_or_else(|| not_found(id))?;
    let kind: String = row.get(0)?;
    let parent: Option<String> = row.get(1)?;
    if kind == "block" || parent.is_some() {
        return Err(validation("not a titled atom"));
    }
    Ok(())
}

impl Notebook {
    /// External visible references into a page, grouped newest-page-first.
    /// Source order is outline preorder; the limit counts sources, not targets.
    pub fn page_references(&self, page_id: &str, limit: usize) -> Result<PageReferences> {
        validate_id(page_id)?;
        let mut statement = self.conn.prepare_cached(PAGE_REFERENCES)?;
        let mut cursor =
            statement.query(params![page_id, i64::try_from(limit).unwrap_or(i64::MAX)])?;
        let mut row = cursor.next()?;
        check_page(row, page_id)?;
        let mut result = PageReferences {
            total: 0,
            groups: Vec::new(),
        };
        while let Some(current) = row {
            result.total = current.get::<_, i64>(2)? as usize;
            if let Some(id) = current.get::<_, Option<String>>(3)? {
                let page_id: String = current.get(13)?;
                if result
                    .groups
                    .last()
                    .is_none_or(|group| group.page.id != page_id)
                {
                    result.groups.push(ReferenceGroup {
                        page: block_at(current, 13)?,
                        sources: Vec::new(),
                    });
                }
                let sources = &mut result.groups.last_mut().expect("source group").sources;
                if sources.last().is_none_or(|source| source.source.id != id) {
                    sources.push(ReferenceSource {
                        source: block_at(current, 3)?,
                        targets: Vec::new(),
                    });
                }
                sources
                    .last_mut()
                    .expect("reference source")
                    .targets
                    .push(current.get(23)?);
            }
            row = cursor.next()?;
        }
        Ok(result)
    }

    /// One query, counting distinct visible sources, including same-page sources
    /// but not a block's reference to itself. Rows are ordered by target ID.
    pub fn reference_counts(&self, page_id: &str) -> Result<Vec<ReferenceCount>> {
        validate_id(page_id)?;
        let mut statement = self.conn.prepare_cached(REFERENCE_COUNTS)?;
        let mut cursor = statement.query([page_id])?;
        let mut row = cursor.next()?;
        check_page(row, page_id)?;
        let mut result = Vec::new();
        while let Some(current) = row {
            if let Some(block_id) = current.get(2)? {
                result.push(ReferenceCount {
                    block_id,
                    count: current.get::<_, i64>(3)? as usize,
                });
            }
            row = cursor.next()?;
        }
        Ok(result)
    }

    /// FTS phrase candidates, confirmed against plain text with Unicode word
    /// boundaries. Stream every candidate so total stays exact even at limit 0;
    /// only the requested result rows retain their full blocks in memory.
    pub fn unlinked_mentions(&self, page_id: &str, limit: usize) -> Result<UnlinkedMentions> {
        let page = self.block(page_id)?;
        if page.parent_id.is_some() {
            return Err(validation("not a titled atom"));
        }
        let mut result = UnlinkedMentions {
            total: 0,
            rows: Vec::new(),
        };
        if page.kind == BlockKind::Journal || page.archived || page.text.to_lowercase() == "fields"
        {
            return Ok(result);
        }
        let mut terms = vec![page.text];
        terms.extend(self.page_aliases(page_id)?);
        terms.retain(|term| term.chars().count() >= 3 && term.chars().any(char::is_alphanumeric));
        if terms.is_empty() {
            return Ok(result);
        }
        let matched = terms
            .iter()
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" OR ");
        let folded: Vec<_> = terms.iter().map(|term| term.to_lowercase()).collect();
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            " SELECT ",
            block_columns!("b"),
            ", ",
            block_columns!("p"),
            " FROM blocks_fts JOIN blocks b ON b.rowid = blocks_fts.rowid
              JOIN blocks p ON p.id = b.page_id
              WHERE blocks_fts MATCH ?2 AND b.kind = 'block' AND b.page_id != ?1
                AND b.deletion_id IS NULL AND p.deletion_id IS NULL
                AND b.rowid NOT IN (SELECT rowid FROM hidden)
                AND NOT EXISTS (
                    SELECT 1 FROM links l JOIN blocks t ON t.id = l.target_id
                    WHERE l.source_id = b.id AND t.page_id = ?1
                )
              ORDER BY b.id DESC"
        ))?;
        let mut cursor = statement.query(params![page_id, matched])?;
        while let Some(row) = cursor.next()? {
            let text = row.get_ref(4)?.as_str().map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    4,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let plain = mention_text(text).to_lowercase();
            if let Some(index) = folded.iter().position(|term| whole_word(&plain, term)) {
                result.total += 1;
                if result.rows.len() < limit {
                    result.rows.push(Mention {
                        block: block_at(row, 0)?,
                        page: block_at(row, 10)?,
                        term: terms[index].clone(),
                    });
                }
            }
        }
        Ok(result)
    }
}

fn whole_word(text: &str, term: &str) -> bool {
    let word = |ch: char| ch.is_alphanumeric() || ch == '_';
    text.match_indices(term).any(|(start, _)| {
        text[..start].chars().next_back().is_none_or(|ch| !word(ch))
            && text[start + term.len()..]
                .chars()
                .next()
                .is_none_or(|ch| !word(ch))
    })
}

fn mention_text(text: &str) -> String {
    let mut spans: Vec<_> = tag_tokens(text).map(|token| token.span).collect();
    let mut cursor = 0;
    while cursor < text.len() {
        let rest = &text[cursor..];
        if rest.starts_with('\\') {
            cursor += 1;
            if let Some(ch) = text[cursor..].chars().next() {
                cursor += ch.len_utf8();
            }
        } else if let Some(end) = crate::card_text::protected_end(text, cursor) {
            spans.push(cursor..end);
            cursor = end;
        } else if rest.starts_with("https://") || rest.starts_with("http://") {
            let end = cursor
                + rest
                    .find(|ch: char| ch.is_whitespace() || matches!(ch, '<' | '>' | '"' | '\''))
                    .unwrap_or(rest.len());
            spans.push(cursor..end);
            cursor = end;
        } else {
            cursor += rest.chars().next().expect("in bounds").len_utf8();
        }
    }
    spans.sort_unstable_by_key(|span| span.start);
    let mut plain = String::with_capacity(text.len());
    cursor = 0;
    for span in spans {
        if span.start >= cursor {
            plain.push_str(&text[cursor..span.start]);
            plain.push('\0');
        }
        cursor = cursor.max(span.end);
    }
    plain.push_str(&text[cursor..]);
    plain
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_plans_use_target_page_and_link_indexes() {
        let directory = tempfile::tempdir().unwrap();
        let notebook = Notebook::open(directory.path()).unwrap();
        for (name, sql) in [
            ("page_references", PAGE_REFERENCES),
            ("reference_counts", REFERENCE_COUNTS),
        ] {
            let mut statement = notebook
                .conn
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap();
            let parameters = if name == "page_references" {
                vec![
                    rusqlite::types::Value::Text("00000000000000000000000001".into()),
                    10.into(),
                ]
            } else {
                vec![rusqlite::types::Value::Text(
                    "00000000000000000000000001".into(),
                )]
            };
            let plans = statement
                .query_map(rusqlite::params_from_iter(parameters), |row| {
                    row.get::<_, String>(3)
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            println!("{name}:\n{}", plans.join("\n"));
            assert!(
                plans
                    .iter()
                    .any(|line| line.contains("SEARCH t USING INDEX blocks_live_page"))
            );
            assert!(
                plans
                    .iter()
                    .any(|line| line.contains("SEARCH l USING INDEX links_target"))
            );
            for line in &plans {
                assert!(
                    !["SCAN blocks", "SCAN t ", "SCAN b ", "SCAN p ", "SCAN root "]
                        .iter()
                        .any(|scan| line.starts_with(scan) && !line.contains("USING")),
                    "{line}"
                );
            }
        }
    }
}
