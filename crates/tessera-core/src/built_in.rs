//! Fields the app itself creates, named lowercase, and the built-in types that carry them.
//! Every surface that makes one of these fields takes its name, kind and Links to types from here.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};

use crate::FieldKind::{self, Date, Identifier, Instance, Number, Span, Text, Url};
use crate::library_ingest::Planner;
use crate::{Actor, Batch, CountsAs, Notebook, Operation, Result};

pub(crate) struct BuiltInField {
    pub name: &'static str,
    pub kind: FieldKind,
    /// Titles of the types a relation links to, filed only where those type pages exist.
    pub targets: &'static [&'static str],
    /// What its values count as; fixed, like its name.
    pub counts_as: Option<CountsAs>,
    /// A creator read only when a work has no other creator, as an editor is.
    pub fallback: bool,
}

const fn field(name: &'static str, kind: FieldKind) -> BuiltInField {
    BuiltInField {
        name,
        kind,
        targets: &[],
        counts_as: None,
        fallback: false,
    }
}

const fn person(
    name: &'static str,
    targets: &'static [&'static str],
    counts_as: CountsAs,
) -> BuiltInField {
    BuiltInField {
        name,
        kind: Instance,
        targets,
        counts_as: Some(counts_as),
        fallback: false,
    }
}

const CREATORS: &[&str] = &["Person", "Group"];

pub(crate) const FIELDS: &[BuiltInField] = &[
    person("author", CREATORS, CountsAs::Creator),
    BuiltInField {
        fallback: true,
        ..person("editor", CREATORS, CountsAs::Creator)
    },
    person("translator", CREATORS, CountsAs::Contributor),
    field("subtitle", Text),
    field("published", Date),
    field("first published", Date),
    field("publisher", Text),
    field("edition", Text),
    field("series", Text),
    field("number", Number),
    field("volume", Text),
    field("issue", Text),
    field("page range", Text),
    field("pages", Number),
    field("language", Text),
    field("original language", Text),
    field("identifier", Identifier),
    field("url", Url),
    field("site", Text),
    field("description", Text),
    field("cover", Text),
    field("siglum", Text),
    field("started", Date),
    field("finished", Date),
    BuiltInField {
        targets: &["Collection"],
        ..field("collections", Instance)
    },
    field("aliases", Text),
    field("sort as", Text),
    field("lived", Span),
    field("active", Span),
    BuiltInField {
        targets: &["Group"],
        ..field("affiliated with", Instance)
    },
    person("coined by", CREATORS, CountsAs::Originator),
    BuiltInField {
        counts_as: Some(CountsAs::Originator),
        ..field("coined in", Instance)
    },
    field("gist", Text),
    field("gloss", Text),
    field("work", Text),
    field("account", Text),
    field("project", Instance),
];

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Level {
    /// Always in the type's template; members without a value read as incomplete.
    Required,
    /// In the template a new type starts with; removable like any field.
    Expected,
}

/// The fields each built-in type starts with, by title key, in template order.
pub(crate) fn schema(type_key: &str) -> &'static [(&'static str, Level)] {
    use Level::{Expected, Required};
    match type_key {
        "person" => &[
            ("aliases", Expected),
            ("lived", Expected),
            ("affiliated with", Expected),
        ],
        "group" => &[("aliases", Expected), ("active", Expected)],
        "concept" => &[
            ("aliases", Expected),
            ("coined by", Expected),
            ("coined in", Expected),
        ],
        "book" => &[
            ("author", Required),
            ("editor", Expected),
            ("translator", Expected),
            ("published", Expected),
            ("publisher", Expected),
            ("identifier", Expected),
            ("language", Expected),
        ],
        "article" => &[
            ("author", Expected),
            ("site", Expected),
            ("published", Expected),
            ("url", Expected),
        ],
        _ => &[],
    }
}

/// The built-in field with this name, ignoring case and surrounding space.
pub(crate) fn field_named(name: &str) -> Option<&'static BuiltInField> {
    let name = name.trim();
    FIELDS
        .iter()
        .find(|field| field.name.eq_ignore_ascii_case(name))
}

/// Renaming a built-in field is refused; changing only its case is not, so older names can become lowercase.
pub(crate) fn rename_problem(current: &str, next: &str) -> Option<String> {
    let field = field_named(current)?;
    (!field.name.eq_ignore_ascii_case(next.trim()))
        .then(|| format!("{} is built in and cannot be renamed.", field.name))
}

/// Where a field's values go in a work's creator readings.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum CreatorTier {
    Creator,
    /// Creators read only when a work has none of the first tier, as editors are.
    Fallback,
    Contributor,
}

/// A definition's creator tier and its rank within it: author first, then other fields in Fields page order.
pub(crate) fn creator_tier(
    definition: &crate::FieldDefinition,
    position: usize,
) -> Option<(CreatorTier, usize)> {
    let tier = match definition.counts_as? {
        CountsAs::Creator if field_named(&definition.name).is_some_and(|field| field.fallback) => {
            CreatorTier::Fallback
        }
        CountsAs::Creator => CreatorTier::Creator,
        CountsAs::Contributor => CreatorTier::Contributor,
        CountsAs::Originator => return None,
    };
    let author = definition.name.trim().eq_ignore_ascii_case("author");
    Some((tier, if author { 0 } else { position + 1 }))
}

/// The fields in `template` that a type titled `title` requires, as `(field id, name)` in template order.
pub(crate) fn required_fields(
    conn: &Connection,
    title: &str,
    template: &[String],
) -> Result<Vec<(String, &'static str)>> {
    let required: Vec<&str> = schema(&title.trim().to_lowercase())
        .iter()
        .filter(|(_, level)| *level == Level::Required)
        .map(|(name, _)| *name)
        .collect();
    if required.is_empty() {
        return Ok(vec![]);
    }
    let mut name = conn.prepare_cached(
        "SELECT text FROM blocks WHERE id = ?1 AND deletion_id IS NULL AND archived = 0",
    )?;
    let mut fields = vec![];
    for id in template {
        let Some(text) = name
            .query_row([id], |row| row.get::<_, String>(0))
            .optional()?
        else {
            continue;
        };
        if let Some(required) = required
            .iter()
            .find(|required| required.eq_ignore_ascii_case(text.trim()))
        {
            fields.push((id.clone(), *required));
        }
    }
    Ok(fields)
}

/// A template change may reorder a required field but not drop it, such as “Books require author.”
pub(crate) fn removal_problem(
    conn: &Connection,
    type_id: &str,
    title: &str,
    next: &[String],
) -> Result<Option<String>> {
    let current = crate::query::template(conn, type_id)?;
    let Some((_, name)) = required_fields(conn, title, &current)?
        .into_iter()
        .find(|(id, _)| !next.contains(id))
    else {
        return Ok(None);
    };
    let (plural, _) = crate::query::presentation(conn, type_id)?;
    let plural = plural.unwrap_or_else(|| crate::notes::auto_plural(title.trim()));
    let mut letters = plural.chars();
    let plural: String = letters
        .next()
        .map(|first| first.to_uppercase().chain(letters).collect())
        .unwrap_or_default();
    Ok(Some(format!("{plural} require {name}.")))
}

impl Notebook {
    /// Brings built-in fields to their current shape as one synced change: lowercase names, Links to types
    /// where those type pages exist, and required fields in their types' templates. It never changes a
    /// field's kind, which stays a reviewed interpretation, and does nothing once everything is in place.
    pub(crate) fn ensure_built_in_fields(&mut self) -> Result<()> {
        // A stripped sync clone has history but no local editor cursor yet; it runs this after adoption.
        let awaiting_adoption: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM changes) AND NOT EXISTS(SELECT 1 FROM editor_events)",
            [],
            |row| row.get(0),
        )?;
        if awaiting_adoption || crate::fields::page_id(&self.conn)?.is_none() {
            return Ok(());
        }
        let definitions = crate::fields::definitions(&self.conn)?;
        let mut revisions: HashMap<String, i64> = HashMap::new();
        let mut operations = vec![];
        for definition in definitions.iter().filter(|definition| !definition.archived) {
            let Some(field) = field_named(&definition.name) else {
                continue;
            };
            let revision = revisions
                .entry(definition.id.clone())
                .or_insert(definition.revision);
            if definition.name != field.name {
                operations.push(Operation::EditText {
                    id: definition.id.clone(),
                    base_revision: *revision,
                    text: field.name.into(),
                });
                *revision += 1;
            }
            if definition.kind == Instance && definition.targets.is_empty() {
                let targets = field
                    .targets
                    .iter()
                    .filter_map(|title| self.page_by_title(title).transpose())
                    .map(|page| page.map(|page| page.id))
                    .collect::<Result<Vec<_>>>()?;
                if !targets.is_empty() {
                    operations.push(Operation::SetFieldTargets {
                        id: definition.id.clone(),
                        base_revision: *revision,
                        targets,
                    });
                    *revision += 1;
                }
            }
        }
        let mut planner = Planner::new(self)?;
        let mut added_creators = false;
        for key in ["book", "article", "person", "group", "concept"] {
            let required: Vec<_> = schema(key)
                .iter()
                .filter(|(_, level)| *level == Level::Required)
                .collect();
            let Some(page) = (if required.is_empty() {
                None
            } else {
                self.page_by_title(key)?
            }) else {
                continue;
            };
            let template: Vec<String> = self
                .conn
                .prepare("SELECT field_id FROM type_fields WHERE type_id = ?1 ORDER BY position")?
                .query_map([&page.id], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut fields = template.clone();
            for (name, _) in required {
                let field = field_named(name).expect("schemas name built-in fields");
                let id = planner.field(field.name, field.kind);
                if !fields.contains(&id) {
                    fields.push(id);
                }
            }
            if fields != template {
                planner.operations.push(Operation::SetTypeFields {
                    type_id: page.id,
                    base_revision: page.revision,
                    fields,
                });
                added_creators |= matches!(key, "book" | "article");
            }
        }
        // The creator filing backfill has already run and found no creator fields; the ones added here
        // have no values to file, so it is done, and need not record that as a change of its own next time.
        let filed: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key = 'library_creator_targets' AND value = 'true')",
            [],
            |row| row.get(0),
        )?;
        if added_creators && !filed {
            planner.operations.push(Operation::SetSetting {
                key: "library_creator_targets".into(),
                value: "true".into(),
                base_revision: None,
            });
        }
        operations.extend(planner.operations);
        if operations.is_empty() {
            return Ok(());
        }
        self.apply(&Batch {
            actor: Actor::Client {
                name: "Built-in fields".into(),
            },
            reason: None,
            idempotency_key: None,
            operations,
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_lowercase_unique_and_schemas_name_known_fields() {
        let mut seen = std::collections::HashSet::new();
        for field in FIELDS {
            assert_eq!(field.name, field.name.to_lowercase());
            assert!(seen.insert(field.name), "{} repeats", field.name);
        }
        for key in ["person", "group", "concept", "book", "article"] {
            for (name, _) in schema(key) {
                assert!(field_named(name).is_some(), "{name} is not built in");
            }
        }
    }

    #[test]
    fn built_in_fields_change_case_but_not_name() {
        assert_eq!(rename_problem("Author", "author"), None);
        assert_eq!(
            rename_problem("author", "by").as_deref(),
            Some("author is built in and cannot be renamed.")
        );
        assert_eq!(rename_problem("mood", "feeling"), None);
    }

    #[test]
    fn only_book_requires_a_field() {
        for key in ["person", "group", "concept", "article"] {
            assert!(
                schema(key)
                    .iter()
                    .all(|(_, level)| *level != Level::Required)
            );
        }
        assert_eq!(
            schema("book")
                .iter()
                .filter(|(_, level)| *level == Level::Required)
                .map(|(name, _)| *name)
                .collect::<Vec<_>>(),
            ["author"]
        );
    }
}
