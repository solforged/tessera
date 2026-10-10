use crate::library::{ExportFormat, HighlightQuery, HighlightRow, SourceFormat};
use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, validation};
use crate::{Notebook, Reading, ReadingValue, Result};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fmt::Write;

pub(crate) type FieldReadings = BTreeMap<String, Vec<String>>;
pub(crate) fn field_readings(
    conn: &rusqlite::Connection,
    ids: &[String],
) -> Result<HashMap<String, FieldReadings>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let definitions = crate::fields::definitions(conn)?;
    let definitions = crate::fields::definition_map(&definitions);
    let mut result: HashMap<String, FieldReadings> = HashMap::new();
    let mut statement = conn.prepare_cached(concat!(
        "SELECT f.field_id, v.text, ",
        block_columns!("target"),
        ", f.owner_id
         FROM field_values f
         JOIN blocks v ON v.id = f.value_id
         LEFT JOIN links l ON l.source_id = v.id AND l.occurrence = 0
         LEFT JOIN blocks target ON target.id = l.target_id AND target.deletion_id IS NULL
         WHERE f.owner_id IN (SELECT value FROM json_each(?1)) AND v.deletion_id IS NULL
         ORDER BY f.owner_id, f.ordinal, v.id"
    ))?;
    let mut rows = statement.query([crate::library_store::json(ids)])?;
    while let Some(row) = rows.next()? {
        let field: String = row.get(0)?;
        let Some(definition) = definitions.get(field.as_str()) else {
            continue;
        };
        let text: String = row.get(1)?;
        let target = if row.get::<_, Option<String>>(2)?.is_some() {
            Some(block_at(row, 2)?)
        } else {
            None
        };
        if let Reading::Value {
            ok: true, value, ..
        } = crate::fields::reading(definition.kind, &field, &text, target.as_ref())
        {
            let value = match value {
                ReadingValue::Text(value) => value,
                ReadingValue::Number(_) => text,
                ReadingValue::Checkbox(_) => continue,
            };
            result
                .entry(row.get(12)?)
                .or_default()
                .entry(definition.name.to_lowercase())
                .or_default()
                .push(value);
        }
    }
    Ok(result)
}
fn person(name: &str) -> (String, String) {
    if let Some((family, given)) = name.split_once(',') {
        return (family.trim().into(), given.trim().into());
    }
    let name = name.trim();
    name.rsplit_once(' ').map_or_else(
        || (name.into(), String::new()),
        |(given, family)| (family.into(), given.into()),
    )
}
fn escape(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '{' | '}' | '\\' | '%' | '&' | '$' | '#' | '_' => {
                output.push('\\');
                output.push(c);
            }
            '^' => output.push_str("\\textasciicircum{}"),
            '~' => output.push_str("\\textasciitilde{}"),
            _ => output.push(c),
        }
    }
    output
}

type NoteChildren = HashMap<String, Vec<(String, String)>>;

fn markdown_notes(output: &mut String, block: &str, children: &NoteChildren) {
    let mut pending = vec![];
    if let Some(notes) = children.get(block) {
        pending.extend(notes.iter().rev().map(|note| (note, 0)));
    }
    while let Some(((id, text), depth)) = pending.pop() {
        let nonblank = !text.trim().is_empty();
        if nonblank {
            output.push('\n');
            for (index, line) in text.lines().enumerate() {
                if depth == 0 {
                    writeln!(output, "{line}").expect("String write");
                } else if index == 0 {
                    writeln!(output, "{:width$}- {line}", "", width = depth * 2)
                        .expect("String write");
                } else {
                    writeln!(output, "{:width$}{line}", "", width = depth * 2 + 2)
                        .expect("String write");
                }
            }
        }
        if let Some(notes) = children.get(id) {
            let depth = depth + usize::from(nonblank);
            pending.extend(notes.iter().rev().map(|note| (note, depth)));
        }
    }
}
impl Notebook {
    /// Export every matching source, independently of the query's display limit.
    pub fn export_query(
        &self,
        query: &crate::library::LibraryQuery,
        format: ExportFormat,
    ) -> Result<String> {
        let ids: Vec<_> = self
            .library_rows(query, usize::MAX)?
            .rows
            .into_iter()
            .map(|row| row.page.id)
            .collect();
        // `export` treats an empty ID list as the whole library.
        if ids.is_empty() {
            return Ok(match format {
                ExportFormat::Bibtex | ExportFormat::Markdown => String::new(),
                ExportFormat::CslJson => "[]\n".into(),
            });
        }
        self.export(&ids, format)
    }
    pub fn export(&self, ids: &[String], format: ExportFormat) -> Result<String> {
        let all;
        let ids = if ids.is_empty() {
            all = self.active_source_ids()?;
            all.as_slice()
        } else {
            ids
        };
        if format == ExportFormat::Markdown {
            return self.export_markdown(ids);
        }
        let mut bib = String::new();
        let mut csl = vec![];
        let mut readings_by_source = field_readings(&self.conn, ids)?;
        for id in ids {
            let source = self.source(id)?;
            let key =
                source.source.citation_key.as_deref().ok_or_else(|| {
                    validation("Assign a citation key before exporting this source.")
                })?;
            let readings = readings_by_source.remove(id).unwrap_or_default();
            let first = |name: &str| {
                readings
                    .get(name)
                    .and_then(|v| v.first())
                    .map(String::as_str)
            };
            let mut fields: Vec<(&str, String)> = vec![("title", source.page.text.clone())];
            let mut item = serde_json::Map::new();
            item.insert("id".into(), json!(key));
            item.insert("title".into(), json!(source.page.text));
            item.insert("citation-label".into(), json!(source.source.siglum));
            let book = source.source.format == SourceFormat::Epub
                || source.source.format == SourceFormat::Record
                    && readings
                        .get("identifier")
                        .is_some_and(|ids| ids.iter().any(|id| id.starts_with("isbn:")));
            let mut has_doi = false;
            for role in ["author", "editor", "translator"] {
                if let Some(names) = readings.get(role).filter(|v| !v.is_empty()) {
                    let names: Vec<_> = names.iter().map(|n| person(n)).collect();
                    fields.push((
                        role,
                        names
                            .iter()
                            .map(|(family, given)| {
                                if given.is_empty() {
                                    family.clone()
                                } else {
                                    format!("{family}, {given}")
                                }
                            })
                            .collect::<Vec<_>>()
                            .join(" and "),
                    ));
                    item.insert(
                        role.into(),
                        Value::Array(
                            names
                                .iter()
                                .map(|(family, given)| {
                                    let mut person = serde_json::Map::new();
                                    person.insert("family".into(), json!(family));
                                    if !given.is_empty() {
                                        person.insert("given".into(), json!(given));
                                    }
                                    Value::Object(person)
                                })
                                .collect(),
                        ),
                    );
                }
            }
            if let Some(published) = first("published") {
                fields.push(("date", published.into()));
                if let Some(year) = published.get(..4) {
                    fields.push(("year", year.into()));
                }
                let parts: Vec<u32> = published
                    .split('-')
                    .filter_map(|p| p.parse().ok())
                    .collect();
                if !parts.is_empty() {
                    item.insert("issued".into(), json!({"date-parts":[parts]}));
                }
            }
            for (field, bib_name, csl_name) in [
                ("publisher", "publisher", "publisher"),
                ("site", "organization", "container-title"),
                ("url", "url", "URL"),
                ("language", "language", "language"),
            ] {
                if let Some(value) = first(field) {
                    fields.push((bib_name, value.into()));
                    item.insert(csl_name.into(), json!(value));
                }
            }
            if let Some(identifiers) = readings.get("identifier") {
                for id in identifiers
                    .iter()
                    .filter_map(|s| crate::fields::identifier(s))
                {
                    let (scheme, value) = id.split_once(':').expect("normalized identifier");
                    let (bib_name, csl_name) = match scheme {
                        "isbn" => ("isbn", "ISBN"),
                        "doi" => {
                            has_doi = true;
                            ("doi", "DOI")
                        }
                        "arxiv" => ("eprint", "archive_location"),
                        _ => continue,
                    };
                    if fields.iter().any(|(key, _)| *key == bib_name) {
                        continue;
                    }
                    fields.push((bib_name, value.into()));
                    item.insert(csl_name.into(), json!(value));
                    if scheme == "arxiv" {
                        fields.push(("archivePrefix", "arXiv".into()));
                        item.insert("archive".into(), json!("arXiv"));
                    }
                }
            }
            item.insert(
                "type".into(),
                json!(if book {
                    "book"
                } else if has_doi {
                    "article-journal"
                } else {
                    "webpage"
                }),
            );
            match format {
                ExportFormat::Bibtex => {
                    if !bib.is_empty() {
                        bib.push('\n');
                    }
                    bib.push_str(&format!(
                        "@{}{{{key},\n",
                        if book { "book" } else { "online" }
                    ));
                    for (name, value) in fields {
                        bib.push_str(&format!("  {name} = {{{}}},\n", escape(&value)));
                    }
                    bib.push_str("}\n");
                }
                ExportFormat::CslJson => csl.push(Value::Object(item)),
                ExportFormat::Markdown => unreachable!("Markdown is exported separately"),
            }
        }
        Ok(match format {
            ExportFormat::Bibtex => bib,
            ExportFormat::CslJson => format!(
                "{}\n",
                serde_json::to_string_pretty(&csl).expect("CSL serializes")
            ),
            ExportFormat::Markdown => unreachable!("Markdown is exported separately"),
        })
    }

    fn export_markdown(&self, ids: &[String]) -> Result<String> {
        let mut readings = field_readings(&self.conn, ids)?;
        let mut highlights: HashMap<String, Vec<HighlightRow>> = HashMap::new();
        for row in self
            .highlights(&HighlightQuery {
                limit: Some(usize::MAX),
                ..Default::default()
            })?
            .rows
        {
            if ids.contains(&row.citation.source_id) {
                highlights
                    .entry(row.citation.source_id.clone())
                    .or_default()
                    .push(row);
            }
        }
        let blocks: Vec<_> = highlights
            .values()
            .flatten()
            .map(|row| &row.citation.block_id)
            .collect();
        let mut statement = self.conn.prepare_cached(
            "WITH RECURSIVE notes(id) AS (
                 SELECT value FROM json_each(?1)
                 UNION
                 SELECT b.id FROM blocks b JOIN notes ON b.parent_id = notes.id
                 WHERE b.deletion_id IS NULL
             )
             SELECT b.parent_id, b.id, b.text FROM notes
             JOIN blocks b ON b.id = notes.id
             WHERE b.parent_id IN (SELECT id FROM notes)
             ORDER BY b.parent_id, b.ordinal, b.id",
        )?;
        let mut children: NoteChildren = HashMap::new();
        let mut rows = statement.query([crate::library_store::json(&blocks)])?;
        while let Some(row) = rows.next()? {
            children
                .entry(row.get(0)?)
                .or_default()
                .push((row.get(1)?, row.get(2)?));
        }
        let mut sections = self.conn.prepare_cached(
            "SELECT MIN(p.ordinal), json_extract(e.value, '$.title')
             FROM snapshots s, json_each(s.toc) e
             JOIN passages p ON p.snapshot_id = s.id
                 AND (p.id = json_extract(e.value, '$.locator')
                     OR p.locator = json_extract(e.value, '$.locator')
                     OR p.anchor = json_extract(e.value, '$.locator'))
             WHERE s.id = ?1
             GROUP BY e.key
             ORDER BY MIN(p.ordinal), CAST(e.key AS INTEGER)",
        )?;
        let mut output = String::new();
        for id in ids {
            let source = self.source(id)?;
            let key =
                source.source.citation_key.as_deref().ok_or_else(|| {
                    validation("Assign a citation key before exporting this source.")
                })?;
            if !output.is_empty() {
                output.push_str("\n---\n\n");
            }
            writeln!(output, "# {}", source.page.text).expect("String write");
            let fields = readings.remove(id).unwrap_or_default();
            if let Some(creators) = fields.get("author").filter(|names| !names.is_empty()) {
                write!(output, "{} · ", creators.join(", ")).expect("String write");
            }
            if let Some(published) = fields.get("published").and_then(|values| values.first()) {
                write!(output, "{published} · ").expect("String write");
            }
            writeln!(output, "`{key}`").expect("String write");
            if let Some(url) = fields.get("url").and_then(|values| values.first()) {
                writeln!(output, "{url}").expect("String write");
            }
            output.push_str("\n## Highlights\n");
            let Some(mut rows) = highlights.remove(id) else {
                output.push_str("\n_No highlights._\n");
                continue;
            };
            let snapshot_order: HashMap<_, _> = source
                .snapshots
                .iter()
                .enumerate()
                .map(|(index, snapshot)| (snapshot.id.as_str(), index))
                .collect();
            rows.sort_by(|a, b| {
                let position = |row: &HighlightRow| {
                    (
                        Some(&row.citation.snapshot_id)
                            != source.source.current_snapshot_id.as_ref(),
                        snapshot_order.get(row.citation.snapshot_id.as_str()),
                        row.citation.ordinal,
                        row.citation.start.offset,
                    )
                };
                position(a)
                    .cmp(&position(b))
                    .then_with(|| a.citation.id.cmp(&b.citation.id))
            });
            let mut snapshot = None;
            let mut contents: Vec<(i64, String)> = vec![];
            let mut earlier = false;
            for row in rows {
                let citation = &row.citation;
                if !earlier
                    && Some(&citation.snapshot_id) != source.source.current_snapshot_id.as_ref()
                {
                    output.push_str("\n### Earlier snapshot\n");
                    earlier = true;
                }
                if snapshot.as_ref() != Some(&citation.snapshot_id) {
                    contents = sections
                        .query_map([&citation.snapshot_id], |row| {
                            Ok((row.get(0)?, row.get(1)?))
                        })?
                        .collect::<rusqlite::Result<_>>()?;
                    snapshot = Some(citation.snapshot_id.clone());
                }
                output.push('\n');
                for line in citation.quote.split('\n') {
                    if line.is_empty() {
                        output.push_str(">\n");
                    } else {
                        writeln!(output, "> {line}").expect("String write");
                    }
                }
                output.push_str("\n— ");
                if let Some((_, title)) = contents
                    .iter()
                    .rev()
                    .find(|(ordinal, _)| *ordinal <= citation.ordinal)
                {
                    output.push_str(title);
                } else {
                    write!(output, "¶ {}", citation.ordinal + 1).expect("String write");
                }
                writeln!(output, " · {}", self.today(row.created_at)?).expect("String write");
                markdown_notes(&mut output, &citation.block_id, &children);
            }
        }
        Ok(output)
    }
    fn active_source_ids(&self) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT s.block_id
             FROM sources s
             JOIN blocks b ON b.id = s.block_id
             WHERE s.active = 1 AND b.deletion_id IS NULL AND b.id NOT IN (SELECT id FROM hidden)
             ORDER BY b.title_key, b.id"
        ))?;
        Ok(statement
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }
}
