//! Fields the app itself creates, named lowercase, and the built-in types that carry them.
//! Every surface that makes one of these fields takes its name, kind and Links to types from here.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};

use crate::FieldKind::{self, Choice, Date, Identifier, Instance, Number, Span, Text, Url};
use crate::fields::SOURCE_TARGET;
use crate::library_ingest::Planner;
use crate::{Actor, Batch, CountsAs, Notebook, Operation, Result};

pub(crate) struct BuiltInField {
    pub name: &'static str,
    pub kind: FieldKind,
    /// Titles of the types a relation links to, filed only where those type pages exist, or
    /// [`SOURCE_TARGET`] for sources, which every notebook can link to.
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
        targets: &[SOURCE_TARGET],
        counts_as: Some(CountsAs::Originator),
        ..field("coined in", Instance)
    },
    field("gist", Text),
    field("gloss", Text),
    BuiltInField {
        targets: &[SOURCE_TARGET],
        ..field("work", Instance)
    },
    field("account", Text),
    field("status", Choice),
    field("scheduled", Date),
    field("deadline", Date),
    field("priority", Choice),
    field("repeat", Text),
    BuiltInField {
        targets: &["project"],
        ..field("project", Instance)
    },
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
        "task" => &[
            ("status", Required),
            ("scheduled", Expected),
            ("deadline", Expected),
            ("priority", Expected),
            ("repeat", Expected),
            ("project", Expected),
        ],
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

/// Task-backed definitions have fixed formats; Project retains its existing relation entries.
pub(crate) fn task_field(name: &str) -> Option<&'static BuiltInField> {
    field_named(name).filter(|field| schema("task").iter().any(|(name, _)| *name == field.name))
}

pub(crate) fn task_options(name: &str) -> &'static [&'static str] {
    match field_named(name).map(|field| field.name) {
        Some("status") => &["todo", "doing", "waiting", "done", "cancelled"],
        Some("priority") => &["high", "medium", "low"],
        _ => &[],
    }
}

/// The Links to a built-in relation files: Sources, and those of its types whose pages exist.
pub(crate) fn targets(conn: &Connection, field: &BuiltInField) -> Result<Vec<String>> {
    let mut page = conn.prepare_cached(
        "SELECT id FROM blocks WHERE kind = 'page' AND title_key = ?1 AND deletion_id IS NULL AND archived = 0",
    )?;
    let mut targets = Vec::with_capacity(field.targets.len());
    for &title in field.targets {
        if title == SOURCE_TARGET {
            targets.push(title.to_owned());
        } else if let Some(id) = page
            .query_row([crate::storage::title_key(title)], |row| row.get(0))
            .optional()?
        {
            targets.push(id);
        }
    }
    Ok(targets)
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
    let required: Vec<&str> = schema(&crate::storage::title_key(title.trim()))
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
        let operations = self.built_in_field_operations()?;
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

    pub(crate) fn task_fields_need_ensure(&self) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM settings WHERE key = 'task_field_template' AND value = 'true')
             OR (SELECT COUNT(*) FROM blocks d JOIN blocks p ON p.id = d.parent_id
                 WHERE p.title_key = 'fields' AND p.deletion_id IS NULL AND d.deletion_id IS NULL
                 AND lower(d.text) IN ('status','scheduled','deadline','priority','repeat','project')) < 6
             OR NOT EXISTS(SELECT 1 FROM type_fields tf JOIN blocks t ON t.id = tf.type_id
                 JOIN blocks d ON d.id = tf.field_id WHERE t.title_key = 'task'
                 AND t.deletion_id IS NULL AND lower(d.text) = 'status' AND d.deletion_id IS NULL)",
            [], |row| row.get(0),
        )?)
    }

    fn built_in_field_operations(&self) -> Result<Vec<Operation>> {
        // A stripped sync clone has history but no local editor cursor yet; it runs this after adoption.
        let awaiting_adoption: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM changes) AND NOT EXISTS(SELECT 1 FROM editor_events)",
            [],
            |row| row.get(0),
        )?;
        if awaiting_adoption || crate::fields::page_id(&self.conn)?.is_none() {
            return Ok(Vec::new());
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
                let targets = targets(&self.conn, field)?;
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
        let task_needed = self.page_by_title("Task")?.is_some()
            || self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE active = 1)",
                [],
                |row| row.get::<_, bool>(0),
            )?;
        let task_page = if task_needed {
            Some(planner.page("Task")?)
        } else {
            None
        };
        let project_page = if task_needed {
            Some(planner.page("Project")?)
        } else {
            None
        };
        let task_seeded: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key = 'task_field_template' AND value = 'true')",
            [], |row| row.get(0),
        )?;
        // Definitions exist even in a workshop with only appointments.
        for (name, _) in schema("task").iter().filter(|_| task_needed) {
            let field = field_named(name).expect("task schema names built-in fields");
            planner.field(field.name, field.kind);
        }
        if let Some(project) = definitions
            .iter()
            .find(|field| field.name.eq_ignore_ascii_case("project"))
            && project.kind == Instance
            && project.targets.is_empty()
            && self.page_by_title("Project")?.is_none()
            && let Some(project_page) = project_page
        {
            planner.operations.push(Operation::SetFieldTargets {
                id: project.id.clone(),
                base_revision: *revisions.get(&project.id).unwrap_or(&project.revision),
                targets: vec![project_page.0],
            });
        }
        for key in ["book", "article", "person", "group", "concept", "task"] {
            let required: Vec<_> = schema(key)
                .iter()
                .filter(|(_, level)| *level == Level::Required || key == "task" && !task_seeded)
                .collect();
            let page = if key == "task" {
                let Some(page) = task_page.clone() else {
                    continue;
                };
                page
            } else if let Some(page) = if required.is_empty() {
                None
            } else {
                self.page_by_title(key)?
            } {
                (page.id, page.revision)
            } else {
                continue;
            };
            let template: Vec<String> = self
                .conn
                .prepare("SELECT field_id FROM type_fields WHERE type_id = ?1 ORDER BY position")?
                .query_map([&page.0], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut fields: Vec<_> = template
                .iter()
                .filter(|id| {
                    key != "task"
                        || definitions
                            .iter()
                            .any(|field| field.id == **id && !field.archived)
                })
                .cloned()
                .collect();
            for (name, _) in required {
                let field = field_named(name).expect("schemas name built-in fields");
                let id = planner.field(field.name, field.kind);
                if !fields.contains(&id) {
                    fields.push(id);
                }
            }
            if fields != template {
                planner.operations.push(Operation::SetTypeFields {
                    type_id: page.0,
                    base_revision: page.1,
                    fields,
                });
                added_creators |= matches!(key, "book" | "article");
            }
        }
        if task_needed && !task_seeded {
            planner.operations.push(Operation::SetSetting {
                key: "task_field_template".into(),
                value: "true".into(),
                base_revision: None,
            });
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
        Ok(operations)
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
