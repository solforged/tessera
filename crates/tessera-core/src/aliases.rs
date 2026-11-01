use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
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

/// How a title target's name reached a page; see [`Notebook::page_by_name`].
pub(crate) enum Named {
    None,
    /// The page with this title, ignoring tags and case.
    Title(Block),
    /// The one page whose title or alias matches the name folded.
    Folded(Block),
    /// Every page the folded name matches, titles before aliases.
    Several(Vec<NameMatch>),
}

/// Folds an identity name for matching: ignore tags, case, diacritics and
/// apostrophes; punctuation becomes spaces, so `J. M. Keynes` matches `j m keynes`.
pub(crate) fn fold(value: &str) -> String {
    let value = crate::storage::identity_name(value);
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
        crate::storage::fold_title(&folded)
    }
}

/// Plan ordinary alias blocks against the current transaction, including an
/// absent definition. Merge uses deterministic IDs so replicas share identities.
pub(crate) fn plan_alias(
    conn: &Connection,
    page: &Block,
    name: &str,
    mut new_id: impl FnMut() -> String,
) -> Result<Vec<Operation>> {
    let key = fold(name);
    if key.is_empty() || key == fold(&page.text) {
        return Ok(Vec::new());
    }
    let definitions = crate::fields::definitions(conn)?;
    let mut operations = Vec::new();
    let field = if let Some(field) = definitions
        .iter()
        .find(|field| field.name.eq_ignore_ascii_case("aliases"))
    {
        field.id.clone()
    } else {
        let parent = crate::fields::page_id(conn)?
            .ok_or_else(|| validation("The Fields register is missing."))?;
        let after = conn
            .query_row(
                "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL
             ORDER BY ordinal DESC, id DESC LIMIT 1",
                [&parent],
                |row| row.get(0),
            )
            .optional()?;
        let id = new_id();
        operations.push(Operation::Insert {
            id: id.clone(),
            parent_id: parent,
            after,
            text: "aliases".into(),
            heading: None,
        });
        id
    };
    let entries = conn
        .prepare_cached(
            "SELECT id, text FROM blocks WHERE parent_id = ?1
         AND deletion_id IS NULL AND archived = 0 ORDER BY ordinal, id",
        )?
        .query_map([&page.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Inspect the blocks themselves: merge may have moved values in this
    // transaction, before the field-value index is derived.
    for (entry, text) in &entries {
        if crate::fields::reference(text) != Some(field.as_str()) {
            continue;
        }
        let values = conn.prepare_cached(
            "SELECT text FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL AND archived = 0",
        )?.query_map([entry], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if values.iter().any(|value| fold(value) == key) {
            return Ok(Vec::new());
        }
    }
    let entry = if let Some((id, _)) = entries
        .iter()
        .find(|(_, text)| crate::fields::reference(text) == Some(field.as_str()))
    {
        id.clone()
    } else {
        let id = new_id();
        let after = definitions
            .iter()
            .find(|field| field.name.eq_ignore_ascii_case("gloss"))
            .and_then(|gloss| {
                entries
                    .iter()
                    .find(|(_, text)| crate::fields::reference(text) == Some(gloss.id.as_str()))
            })
            .map(|(id, _)| id.clone());
        operations.push(Operation::Insert {
            id: id.clone(),
            parent_id: page.id.clone(),
            after,
            text: format!("[[{field}]]"),
            heading: None,
        });
        id
    };
    let after = conn
        .query_row(
            "SELECT id FROM blocks WHERE parent_id = ?1 AND deletion_id IS NULL
         ORDER BY ordinal DESC, id DESC LIMIT 1",
            [&entry],
            |row| row.get(0),
        )
        .optional()?;
    operations.push(Operation::Insert {
        id: new_id(),
        parent_id: entry,
        after,
        text: name.into(),
        heading: None,
    });
    Ok(operations)
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

    /// The page a title target names, found as a typed `[[Name]]` finds it:
    /// the page with that title, ignoring tags and case; else the one page
    /// whose title or alias matches it ignoring case, diacritics and
    /// punctuation. A name several pages share is refused, naming each page
    /// and its ID, so a caller creates a page only when this finds none.
    pub fn page_by_name(&self, name: &str) -> Result<Option<Block>> {
        match self.named_page(name)? {
            Named::None => Ok(None),
            Named::Title(page) | Named::Folded(page) => Ok(Some(page)),
            Named::Several(matches) => Err(self.ambiguous_name(name, &matches)?),
        }
    }

    /// [`Notebook::page_by_name`], saying how the name reached its page.
    /// The exact title wins, so pages whose titles differ only in
    /// punctuation each stay reachable by their own title.
    pub(crate) fn named_page(&self, name: &str) -> Result<Named> {
        match self.page_by_title(name)? {
            Some(page) => Ok(Named::Title(page)),
            None => self.folded_page(name),
        }
    }

    /// The folded half of [`Notebook::named_page`], for a caller that has
    /// already looked for the exact title; it never returns [`Named::Title`].
    pub(crate) fn folded_page(&self, name: &str) -> Result<Named> {
        let mut matches = self.resolve_name(name)?;
        Ok(match matches.len() {
            0 => Named::None,
            1 => Named::Folded(matches.remove(0).page),
            _ => Named::Several(matches),
        })
    }

    /// The pages a shared name could reach, as `Title (ID)` joined as prose.
    pub(crate) fn name_candidates(&self, matches: &[NameMatch]) -> Result<String> {
        let mut pages = Vec::with_capacity(matches.len());
        for matched in matches {
            pages.push(format!(
                "{} ({})",
                self.display_title(&matched.page.text)?,
                matched.page.id
            ));
        }
        let pages: Vec<&str> = pages.iter().map(String::as_str).collect();
        Ok(crate::agent::listed(&pages))
    }

    /// Refuses a title target several pages share, naming each one.
    pub(crate) fn ambiguous_name(&self, name: &str, matches: &[NameMatch]) -> Result<crate::Error> {
        Ok(validation(format!(
            "“{}” could name {}, which share that name or alias; give the ID of the one you mean",
            name.trim(),
            self.name_candidates(matches)?
        )))
    }

    /// Add an ordinary field value, creating the definition and entry in the same batch.
    pub fn add_alias(
        &mut self,
        page_id: &str,
        name: &str,
        actor: Actor,
    ) -> Result<Option<Committed>> {
        let page = self.alias_page(page_id)?;
        let operations = plan_alias(&self.conn, &page, name, || {
            crate::notebook::new_ulid().to_string()
        })?;
        if operations.is_empty() {
            return Ok(None);
        }
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
            return Err(validation("not a titled atom"));
        }
        Ok(page)
    }
}
