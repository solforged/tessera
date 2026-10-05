use crate::library::{ExportFormat, SourceFormat};
use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, validation};
use crate::{Notebook, Reading, ReadingValue, Result};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

pub(crate) type FieldReadings = BTreeMap<String, Vec<String>>;
pub(crate) fn field_readings(
    notebook: &Notebook,
    ids: &[String],
) -> Result<HashMap<String, FieldReadings>> {
    let definitions = crate::fields::definitions(&notebook.conn)?;
    let definitions = crate::fields::definition_map(&definitions);
    let mut result: HashMap<String, FieldReadings> = HashMap::new();
    let mut statement = notebook.conn.prepare_cached(concat!(
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
            ok: true,
            value: ReadingValue::Text(value),
            ..
        } = crate::fields::reading(definition.kind, &field, &text, target.as_ref())
        {
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
impl Notebook {
    pub fn export(&self, ids: &[String], format: ExportFormat) -> Result<String> {
        let all;
        let ids = if ids.is_empty() {
            all = self.active_source_ids()?;
            all.as_slice()
        } else {
            ids
        };
        let mut bib = String::new();
        let mut csl = vec![];
        let mut readings_by_source = field_readings(self, ids)?;
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
            let book = source.source.format == SourceFormat::Epub;
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
            }
        }
        Ok(match format {
            ExportFormat::Bibtex => bib,
            ExportFormat::CslJson => format!(
                "{}\n",
                serde_json::to_string_pretty(&csl).expect("CSL serializes")
            ),
        })
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
