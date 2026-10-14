use std::collections::HashMap;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

use crate::library_ingest::Planner;
use crate::storage::validation;
use crate::{Actor, Batch, Block, BlockKind, Committed, FieldKind, Notebook, Operation, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NameMatch {
    pub page: Block,
    pub alias: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Completion {
    #[serde(flatten)]
    pub block: Block,
    pub alias: Option<String>,
}

/// Folds a name for matching: no case, diacritics or apostrophes, and any other run of
/// spaces or punctuation becomes one space, so `J. M. Keynes` matches `j m keynes`.
pub(crate) fn fold(value: &str) -> String {
    let mut folded = String::with_capacity(value.len());
    let mut space = false;
    for character in value.nfd().filter(|c| !is_combining_mark(*c)) {
        if matches!(character, '\'' | '\u{2019}') {
            continue;
        }
        if !character.is_alphanumeric() {
            space = !folded.is_empty();
        } else {
            if space {
                folded.push(' ');
                space = false;
            }
            folded.push(character);
        }
    }
    if folded.is_ascii() {
        folded.make_ascii_lowercase();
        folded
    } else {
        folded.to_lowercase()
    }
}

impl Notebook {
    /// Alternate names written as top-level Aliases field values, in outline order.
    pub fn page_aliases(&self, page_id: &str) -> Result<Vec<String>> {
        self.alias_page(page_id)?;
        Ok(self
            .named_page_values("aliases", Some(page_id))?
            .remove(page_id)
            .unwrap_or_default())
    }

    pub(crate) fn aliases_by_page(&self) -> Result<HashMap<String, Vec<String>>> {
        self.named_page_values("aliases", None)
    }

    pub(crate) fn named_page_values(
        &self,
        name: &str,
        page_id: Option<&str>,
    ) -> Result<HashMap<String, Vec<String>>> {
        let mut statement = self.conn.prepare_cached(
            "SELECT p.id, v.text FROM field_values f
             JOIN blocks p ON p.id = f.owner_id
             JOIN blocks e ON e.id = f.entry_id AND e.parent_id = p.id
             JOIN blocks v ON v.id = f.value_id
             JOIN blocks d ON d.id = f.field_id
             JOIN blocks fp ON fp.id = d.parent_id
             WHERE p.parent_id IS NULL AND p.kind = 'page'
               AND p.deletion_id IS NULL AND p.archived = 0
               AND e.deletion_id IS NULL AND e.archived = 0
               AND v.deletion_id IS NULL AND v.archived = 0
               AND d.deletion_id IS NULL AND d.archived = 0 AND lower(d.text) = ?1
               AND fp.kind = 'page' AND fp.title_key = 'fields' AND fp.deletion_id IS NULL
               AND (?2 IS NULL OR p.id = ?2)
             ORDER BY p.id, e.ordinal, e.id, v.ordinal, v.id",
        )?;
        let mut cursor = statement.query(params![name, page_id])?;
        let mut values: HashMap<String, Vec<String>> = HashMap::new();
        while let Some(row) = cursor.next()? {
            let text: String = row.get(1)?;
            if name != "aliases" || !text.trim().is_empty() {
                values.entry(row.get(0)?).or_default().push(text);
            }
        }
        Ok(values)
    }

    /// All live pages with this whole title or alias; title matches precede aliases.
    pub fn resolve_name(&self, name: &str) -> Result<Vec<NameMatch>> {
        let name = fold(name);
        if name.is_empty() {
            return Ok(Vec::new());
        }
        let mut aliases = self.aliases_by_page()?;
        let mut statement = self.conn.prepare_cached(
            "SELECT id, text FROM blocks WHERE parent_id IS NULL AND kind = 'page'
             AND deletion_id IS NULL AND archived = 0 ORDER BY title_key, id",
        )?;
        let mut cursor = statement.query([])?;
        let mut matches = Vec::new();
        while let Some(row) = cursor.next()? {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let alias = if fold(&title) == name {
                None
            } else if let Some(alias) = aliases
                .remove(&id)
                .unwrap_or_default()
                .into_iter()
                .find(|alias| fold(alias) == name)
            {
                Some(alias)
            } else {
                continue;
            };
            matches.push(NameMatch {
                page: self.block(&id)?,
                alias,
            });
        }
        matches.sort_by_key(|matched| matched.alias.is_some());
        Ok(matches)
    }

    /// Add an ordinary field value, creating the definition and entry in the same batch.
    pub fn add_alias(
        &mut self,
        page_id: &str,
        name: &str,
        actor: Actor,
    ) -> Result<Option<Committed>> {
        let page = self.alias_page(page_id)?;
        let key = fold(name);
        if key.is_empty()
            || key == fold(&page.text)
            || self
                .named_page_values("aliases", Some(page_id))?
                .get(page_id)
                .is_some_and(|aliases| aliases.iter().any(|alias| fold(alias) == key))
        {
            return Ok(None);
        }
        let mut planner = Planner::new(self)?;
        let field = planner.field("aliases", FieldKind::Text);
        let definitions = crate::fields::definitions(&self.conn)?;
        let gloss = definitions
            .iter()
            .find(|definition| definition.name.eq_ignore_ascii_case("gloss"));
        let entries = self
            .conn
            .prepare_cached(
                "SELECT id, text FROM blocks WHERE parent_id = ?1
                 AND deletion_id IS NULL AND archived = 0 ORDER BY ordinal, id",
            )?
            .query_map([page_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let entry = entries
            .iter()
            .find(|(_, text)| crate::fields::reference(text) == Some(field.as_str()));
        let entry_id = if let Some((id, _)) = entry {
            id.clone()
        } else {
            let id = crate::notebook::new_ulid().to_string();
            let after = gloss.and_then(|gloss| {
                entries
                    .iter()
                    .find(|(_, text)| crate::fields::reference(text) == Some(gloss.id.as_str()))
                    .map(|(id, _)| id.clone())
            });
            planner.operations.push(Operation::Insert {
                id: id.clone(),
                parent_id: page_id.into(),
                after,
                text: format!("[[{field}]]"),
                heading: None,
            });
            id
        };
        let after = self
            .conn
            .query_row(
                "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL
             ORDER BY ordinal DESC, id DESC LIMIT 1",
                [&entry_id],
                |row| row.get(0),
            )
            .optional()?;
        planner.operations.push(Operation::Insert {
            id: crate::notebook::new_ulid().to_string(),
            parent_id: entry_id,
            after,
            text: name.into(),
            heading: None,
        });
        let operations = planner.operations;
        self.apply(&Batch {
            actor,
            reason: None,
            idempotency_key: None,
            operations,
        })
        .map(Some)
    }

    /// Populate an empty built-in type's template from its schema without changing existing templates.
    pub fn apply_starting_template(
        &mut self,
        type_id: &str,
        actor: Actor,
    ) -> Result<Option<Committed>> {
        let page = self.alias_page(type_id)?;
        let labels: Vec<(&str, FieldKind)> = crate::built_in::schema(&fold(&page.text))
            .iter()
            .map(|(name, _)| {
                let field =
                    crate::built_in::field_named(name).expect("schemas name built-in fields");
                (field.name, field.kind)
            })
            .collect();
        if labels.is_empty() {
            return Ok(None);
        }
        let has_fields: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM type_fields WHERE type_id = ?1)",
            [type_id],
            |row| row.get(0),
        )?;
        if has_fields {
            return Ok(None);
        }
        let mut planner = Planner::new(self)?;
        let fields = labels
            .iter()
            .map(|(name, kind)| planner.field(name, *kind))
            .collect();
        planner.operations.push(Operation::SetTypeFields {
            type_id: type_id.into(),
            base_revision: page.revision,
            fields,
        });
        let operations = planner.operations;
        self.apply(&Batch {
            actor,
            reason: None,
            idempotency_key: None,
            operations,
        })
        .map(Some)
    }

    fn alias_page(&self, id: &str) -> Result<Block> {
        let page = self.block(id)?;
        if page.kind != BlockKind::Page || page.parent_id.is_some() {
            return Err(validation("not a page"));
        }
        Ok(page)
    }
}
