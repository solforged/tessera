use crate::library::*;
use crate::library_store::{enum_at, json_at, source};
use crate::storage::{not_found, validation};
use crate::{FieldKind, Notebook, Operation, Result};
use rusqlite::{OptionalExtension, params};
use std::collections::{HashMap, HashSet};

pub(crate) const TITLE_STOP_WORDS: &[&str] = &[
    "a", "an", "the", "on", "of", "in", "and", "to", "for", "de", "la", "le", "der", "die", "das",
];

fn person_title(name: &str) -> String {
    name.split_once(',').map_or_else(
        || name.trim().to_owned(),
        |(family, given)| {
            format!("{} {}", given.trim(), family.trim())
                .trim()
                .to_owned()
        },
    )
}
fn combined_creator(name: &str) -> bool {
    name.contains(['/', ';', '&'])
        || name
            .split_whitespace()
            .any(|word| word.eq_ignore_ascii_case("and"))
}

fn creator_title(creator: &ExtractedCreator) -> String {
    if creator.kind == CreatorKind::Person
        && creator.create_page
        && !combined_creator(&creator.name)
    {
        person_title(&creator.name)
    } else {
        creator.name.trim().to_owned()
    }
}
fn metadata_values(metadata: &ExtractedMetadata) -> Vec<(&'static str, FieldKind, Vec<String>)> {
    let mut values = vec![];
    for (role, label) in [
        (CreatorRole::Author, "author"),
        (CreatorRole::Editor, "editor"),
        (CreatorRole::Translator, "translator"),
    ] {
        values.push((
            label,
            FieldKind::Instance,
            metadata
                .creators
                .iter()
                .filter(|c| c.role == role)
                .map(creator_title)
                .filter(|s| !s.is_empty())
                .collect(),
        ));
    }
    for (label, kind, value) in [
        ("subtitle", FieldKind::Text, &metadata.subtitle),
        ("published", FieldKind::Date, &metadata.published),
        ("publisher", FieldKind::Text, &metadata.publisher),
        ("site", FieldKind::Text, &metadata.site),
        ("volume", FieldKind::Text, &metadata.volume),
        ("issue", FieldKind::Text, &metadata.issue),
        ("page range", FieldKind::Text, &metadata.page_range),
        ("language", FieldKind::Text, &metadata.language),
    ] {
        values.push((
            label,
            kind,
            value
                .iter()
                .filter(|s| !s.trim().is_empty())
                .map(|value| {
                    if label == "language" {
                        normalize_language_name(value).to_owned()
                    } else {
                        value.clone()
                    }
                })
                .collect(),
        ));
    }
    values.push((
        "identifier",
        FieldKind::Identifier,
        metadata
            .identifiers
            .iter()
            .filter_map(|id| crate::fields::identifier(id))
            .collect(),
    ));
    values.push((
        "url",
        FieldKind::Url,
        metadata.url.iter().cloned().collect(),
    ));
    if let Some(cover) = metadata
        .cover
        .as_ref()
        .filter(|s| s.starts_with("/api/library/covers/"))
    {
        values.push(("cover", FieldKind::Text, vec![cover.clone()]));
    }
    values
}
pub(crate) fn fold(value: &str) -> String {
    deunicode::deunicode(value)
        .to_ascii_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}
pub(crate) fn family_name(name: &str) -> &str {
    name.split_once(',').map_or_else(
        || name.split_whitespace().last().unwrap_or("anon"),
        |(family, _)| family,
    )
}
pub(crate) fn suffix(mut n: usize) -> String {
    let mut bytes = vec![];
    loop {
        bytes.push(b'a' + (n % 26) as u8);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    bytes.reverse();
    String::from_utf8(bytes).expect("ASCII suffix")
}
fn citation_key(notebook: &Notebook, metadata: &ExtractedMetadata, title: &str) -> Result<String> {
    let creator = metadata
        .creators
        .iter()
        .find(|c| c.role == CreatorRole::Author)
        .or_else(|| {
            metadata
                .creators
                .iter()
                .find(|c| c.role == CreatorRole::Editor)
        });
    let family = creator
        .map(|c| family_name(&c.name))
        // A site name such as `www.karpathy.github.io` keys as `karpathy`.
        .or(metadata.site.as_deref().map(|site| {
            let site = site.strip_prefix("www.").unwrap_or(site);
            if site.contains(' ') {
                site
            } else {
                site.split('.').next().unwrap_or(site)
            }
        }))
        .unwrap_or("anon");
    let mut family = fold(family);
    if family.is_empty() || !family.as_bytes()[0].is_ascii_alphabetic() {
        family.insert_str(0, "anon");
    }
    let year = metadata
        .published
        .as_deref()
        .and_then(|s| s.get(..4))
        .unwrap_or("nd");
    let word = title
        .split_whitespace()
        .map(fold)
        .find(|w| !w.is_empty() && !TITLE_STOP_WORDS.contains(&w.as_str()))
        .unwrap_or_default();
    let mut base = format!("{family}{}{word}", fold(year));
    base.truncate(base.len().min(56));
    let mut key = base.clone();
    let mut n = 0;
    while notebook.conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sources
             WHERE active = 1 AND citation_key = ?1 COLLATE NOCASE
         )",
        [&key],
        |r| r.get::<_, bool>(0),
    )? {
        key = format!("{base}{}", suffix(n));
        n += 1;
    }
    Ok(key)
}

pub(crate) struct Planner<'a> {
    notebook: &'a Notebook,
    pub(crate) operations: Vec<Operation>,
    pages: HashMap<String, (String, i64)>,
    fields: HashMap<String, crate::FieldDefinition>,
    definition_after: Option<String>,
    fields_page: String,
    filed_creators: HashSet<String>,
}
impl<'a> Planner<'a> {
    pub(crate) fn new(notebook: &'a Notebook) -> Result<Self> {
        let fields_page = crate::fields::page_id(&notebook.conn)?
            .ok_or_else(|| validation("The Fields register is missing."))?;
        let fields = crate::fields::definitions(&notebook.conn)?
            .into_iter()
            .map(|f| (f.name.to_lowercase(), f))
            .collect();
        let definition_after = notebook
            .conn
            .query_row(
                "SELECT id
                 FROM blocks
                 WHERE parent_id = ?1 AND deletion_id IS NULL
                 ORDER BY ordinal DESC, id DESC
                 LIMIT 1",
                [&fields_page],
                |r| r.get(0),
            )
            .optional()?;
        Ok(Self {
            notebook,
            operations: vec![],
            pages: HashMap::new(),
            fields,
            definition_after,
            fields_page,
            filed_creators: HashSet::new(),
        })
    }
    pub(crate) fn page(&mut self, title: &str) -> Result<(String, i64)> {
        let key = crate::storage::title_key(title);
        if let Some(page) = self.pages.get(&key) {
            return Ok(page.clone());
        }
        let page = if let Some(page) = self.notebook.page_by_title(title)? {
            (page.id, page.revision)
        } else {
            let id = crate::notebook::new_ulid().to_string();
            self.operations.push(Operation::CreatePage {
                id: id.clone(),
                title: title.into(),
            });
            (id, 1)
        };
        self.pages.insert(key, page.clone());
        Ok(page)
    }
    pub(crate) fn field(&mut self, label: &str, kind: FieldKind) -> String {
        let key = label.to_lowercase();
        if let Some(field) = self.fields.get(&key) {
            return field.id.clone();
        }
        let id = if crate::built_in::task_field(label).is_some() {
            crate::notebook::derived_id(&["task-field", &self.fields_page, &key])
        } else {
            crate::notebook::new_ulid().to_string()
        };
        self.operations.push(Operation::Insert {
            id: id.clone(),
            parent_id: self.fields_page.clone(),
            after: self.definition_after.clone(),
            text: label.into(),
            heading: None,
        });
        self.definition_after = Some(id.clone());
        self.operations.push(Operation::SetFieldKind {
            id: id.clone(),
            base_revision: 1,
            kind,
        });
        // A built-in relation links to its types where those pages already exist; it never creates them.
        let targets: Vec<String> = crate::built_in::field_named(label)
            .filter(|_| kind == FieldKind::Instance)
            .map_or(&[][..], |field| field.targets)
            .iter()
            .filter_map(|&title| {
                if title == crate::fields::SOURCE_TARGET {
                    return Some(title.to_owned());
                }
                self.pages
                    .get(&crate::storage::title_key(title))
                    .map(|page| page.0.clone())
                    .or_else(|| {
                        self.notebook
                            .page_by_title(title)
                            .ok()
                            .flatten()
                            .map(|page| page.id)
                    })
            })
            .collect();
        if !targets.is_empty() {
            self.operations.push(Operation::SetFieldTargets {
                id: id.clone(),
                base_revision: 2,
                targets: targets.clone(),
            });
        }
        self.fields.insert(
            key,
            crate::FieldDefinition {
                id: id.clone(),
                name: label.into(),
                kind,
                hide: crate::FieldHide::Never,
                role: crate::FieldRole::Attribute,
                counts_as: crate::built_in::field_named(label).and_then(|field| field.counts_as),
                archived: false,
                revision: if targets.is_empty() { 2 } else { 3 },
                options: vec![],
                targets,
                built_in: crate::built_in::field_named(label).is_some(),
            },
        );
        id
    }
    fn creator_targets(&mut self) -> Result<Vec<String>> {
        Ok(vec![self.page("Person")?.0, self.page("Group")?.0])
    }

    fn constrain_creator_field(&mut self, label: &str) -> Result<()> {
        let key = label.to_lowercase();
        if !self
            .fields
            .get(&key)
            .is_some_and(|field| field.kind == FieldKind::Instance && field.targets.is_empty())
        {
            return Ok(());
        }
        let targets = self.creator_targets()?;
        let field = self.fields.get_mut(&key).expect("creator field exists");
        self.operations.push(Operation::SetFieldTargets {
            id: field.id.clone(),
            base_revision: field.revision,
            targets: targets.clone(),
        });
        field.targets = targets;
        field.revision += 1;
        Ok(())
    }

    fn file_creator(&mut self, id: &str, revision: i64, kind: CreatorKind) -> Result<()> {
        if self.filed_creators.contains(id) {
            return Ok(());
        }
        let typed: bool = self.notebook.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM memberships WHERE block_id = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if !typed {
            self.creator_targets()?;
            self.operations.push(Operation::AddType {
                id: id.into(),
                base_revision: revision,
                title: match kind {
                    CreatorKind::Person => "Person",
                    CreatorKind::Organisation => "Group",
                }
                .into(),
            });
            self.filed_creators.insert(id.into());
            for page in self.pages.values_mut().filter(|page| page.0 == id) {
                page.1 += 1;
            }
        }
        Ok(())
    }

    fn values(
        &mut self,
        metadata: &ExtractedMetadata,
        create: bool,
    ) -> Result<Vec<(&'static str, FieldKind, Vec<String>)>> {
        let mut values = metadata_values(metadata);
        for (label, kind, values) in &mut values {
            let key = label.to_lowercase();
            if let Some(field) = self.fields.get(&key) {
                *kind = field.kind;
            }
            if *kind == FieldKind::Choice {
                let field = self.fields.get_mut(&key).expect("existing choice field");
                for value in values {
                    let option = field.options.iter().find(|option| option.text == *value);
                    if let Some(option) = option {
                        *value = format!("[[{}]]", option.id);
                    } else if create {
                        let id = crate::notebook::new_ulid().to_string();
                        self.operations.push(Operation::Insert {
                            id: id.clone(),
                            parent_id: field.id.clone(),
                            after: field.options.last().map(|option| option.id.clone()),
                            text: value.clone(),
                            heading: None,
                        });
                        field.options.push(crate::FieldOption {
                            id: id.clone(),
                            text: value.clone(),
                        });
                        *value = format!("[[{id}]]");
                    }
                }
                continue;
            }
            if *kind != FieldKind::Instance {
                continue;
            }
            let role = match *label {
                "author" => Some(CreatorRole::Author),
                "editor" => Some(CreatorRole::Editor),
                "translator" => Some(CreatorRole::Translator),
                _ => None,
            };
            let mut creators = metadata
                .creators
                .iter()
                .filter(|creator| Some(creator.role) == role && !creator.name.trim().is_empty());
            for value in values {
                let creator = creators.next();
                if creator.is_some_and(|creator| {
                    !creator.create_page
                        || creator.kind == CreatorKind::Person && combined_creator(&creator.name)
                }) {
                    continue;
                }
                let matches = self.notebook.resolve_name(value)?;
                let page = match matches.as_slice() {
                    [matched] => {
                        let page = self
                            .pages
                            .entry(crate::storage::title_key(value))
                            .or_insert_with(|| (matched.page.id.clone(), matched.page.revision));
                        Some(page.0.clone())
                    }
                    [] => {
                        let key = crate::aliases::fold(value);
                        let cached = self
                            .pages
                            .iter()
                            .find(|(title, _)| crate::aliases::fold(title) == key);
                        if let Some((_, page)) = cached {
                            Some(page.0.clone())
                        } else if create {
                            Some(self.page(value)?.0)
                        } else {
                            None
                        }
                    }
                    _ => {
                        *value = format!("[[{value}]]");
                        continue;
                    }
                };
                if let Some(id) = page {
                    if create && matches!(*label, "author" | "editor" | "translator") {
                        let revision = self
                            .pages
                            .values()
                            .find(|page| page.0 == id)
                            .expect("resolved creator cached")
                            .1;
                        self.file_creator(
                            &id,
                            revision,
                            creator.map_or(CreatorKind::Person, |creator| creator.kind),
                        )?;
                    }
                    *value = format!("[[{id}]]");
                }
            }
        }
        Ok(values)
    }
    fn template(&mut self, format: SourceFormat) -> Result<String> {
        let title = match format {
            SourceFormat::Epub | SourceFormat::Record => "Book",
            SourceFormat::Article => "Article",
        };
        let labels: Vec<(&str, FieldKind)> =
            crate::built_in::schema(&crate::storage::title_key(title))
                .iter()
                .map(|(name, _)| {
                    let field =
                        crate::built_in::field_named(name).expect("schemas name built-in fields");
                    (field.name, field.kind)
                })
                .collect();
        let (id, revision) = self.page(title)?;
        let has: bool = self.notebook.conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM type_fields
                 WHERE type_id = ?1
             )",
            [&id],
            |r| r.get(0),
        )?;
        if !has {
            let fields = labels
                .iter()
                .map(|(label, kind)| self.field(label, *kind))
                .collect();
            self.operations.push(Operation::SetTypeFields {
                type_id: id.clone(),
                base_revision: revision,
                fields,
            });
            self.pages
                .insert(crate::storage::title_key(title), (id, revision + 1));
        }
        for (label, _) in labels {
            if matches!(label, "author" | "editor" | "translator") {
                self.constrain_creator_field(label)?;
            }
        }
        Ok(title.into())
    }
    fn unique_title(&self, title: &str, disambiguator: &str) -> Result<String> {
        let available = |candidate: &str| -> Result<bool> {
            Ok(!self
                .pages
                .contains_key(&crate::storage::title_key(candidate))
                && self.notebook.page_by_title(candidate)?.is_none())
        };
        if available(title)? {
            return Ok(title.into());
        }
        let base = format!("{title} ({disambiguator})");
        if available(&base)? {
            return Ok(base);
        }
        let mut n = 2;
        loop {
            let candidate = format!("{base} ({n})");
            if available(&candidate)? {
                return Ok(candidate);
            }
            n += 1;
        }
    }
}
impl Notebook {
    pub(crate) fn backfill_library_creators(&mut self) -> Result<()> {
        let done: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key = 'library_creator_targets' AND value = 'true')",
            [], |row| row.get(0),
        )?;
        if done {
            return Ok(());
        }
        // A stripped sync clone has history but no local editor cursor yet.
        // Adopt it first so the backfill uses the new device ID and outbox.
        let awaiting_adoption: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM changes) AND NOT EXISTS(SELECT 1 FROM editor_events)",
            [],
            |row| row.get(0),
        )?;
        if awaiting_adoption {
            return Ok(());
        }
        let fields = self
            .conn
            .prepare(
                "SELECT DISTINCT d.id FROM type_fields t
             JOIN blocks p ON p.id = t.type_id JOIN blocks d ON d.id = t.field_id
             JOIN fields f ON f.block_id = d.id
             WHERE p.title_key IN ('book', 'article') AND p.deletion_id IS NULL
             AND d.deletion_id IS NULL AND d.archived = 0 AND f.kind = 'instance'
             AND lower(d.text) IN ('author', 'editor', 'translator')",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if fields.is_empty() {
            return Ok(());
        }
        let mut planner = Planner::new(self)?;
        for field in fields {
            if crate::fields::targets(&self.conn, &field)?.is_empty() {
                let targets = planner.creator_targets()?;
                planner.operations.push(Operation::SetFieldTargets {
                    base_revision: self.block(&field)?.revision,
                    id: field.clone(),
                    targets,
                });
            }
            let creators = self
                .conn
                .prepare(
                    "SELECT DISTINCT p.id, p.revision FROM field_values v
                 JOIN links l ON l.source_id = v.value_id JOIN blocks p ON p.id = l.target_id
                 WHERE v.field_id = ?1 AND p.kind = 'page' AND p.deletion_id IS NULL
                 AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.block_id = p.id)",
                )?
                .query_map([&field], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (id, revision) in creators {
                planner.file_creator(&id, revision, CreatorKind::Person)?;
            }
        }
        planner.operations.push(Operation::SetSetting {
            key: "library_creator_targets".into(),
            value: "true".into(),
            base_revision: None,
        });
        let operations = planner.operations;
        self.apply(&crate::Batch {
            actor: crate::Actor::Client {
                name: "Library creator filing".into(),
            },
            reason: None,
            idempotency_key: None,
            operations,
        })?;
        Ok(())
    }

    pub fn valid_publication_date(value: &str) -> bool {
        crate::fields::partial_date(value)
    }
    /// Normalize lookup and authored identifiers using the field system's rules.
    pub fn normalize_identifier(value: &str) -> Option<String> {
        crate::fields::identifier(value)
    }

    /// Plan a source with no snapshot. Its metadata is stored in ordinary page fields.
    pub fn plan_source_record(&self, metadata: &ExtractedMetadata) -> Result<IngestPlan> {
        let title = metadata
            .title
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| validation("A title is required."))?;
        let mut planner = Planner::new(self)?;
        let values = planner.values(metadata, true)?;
        let title = planner.unique_title(title.trim(), "record")?;
        let id = crate::notebook::new_ulid().to_string();
        planner.operations.push(Operation::CreatePage {
            id: id.clone(),
            title: title.clone(),
        });
        planner.operations.push(Operation::SetSource {
            id: id.clone(),
            base_revision: 1,
            source: Some(SourceState {
                format: SourceFormat::Record,
                state: ReadingState::Inbox,
                origin: None,
                match_key: metadata.identifiers.first().cloned(),
                citation_key: Some(citation_key(self, metadata, &title)?),
            }),
        });
        let mut after = None;
        for (label, kind, values) in values {
            if values.is_empty() {
                continue;
            }
            let field = planner.field(label, kind);
            if matches!(label, "author" | "editor" | "translator") {
                planner.constrain_creator_field(label)?;
            }
            let entry = crate::notebook::new_ulid().to_string();
            planner.operations.push(Operation::Insert {
                id: entry.clone(),
                parent_id: id.clone(),
                after,
                text: format!("[[{field}]]"),
                heading: None,
            });
            after = Some(entry.clone());
            let mut child_after = None;
            for text in values {
                let child = crate::notebook::new_ulid().to_string();
                planner.operations.push(Operation::Insert {
                    id: child.clone(),
                    parent_id: entry.clone(),
                    after: child_after,
                    text,
                    heading: None,
                });
                child_after = Some(child);
            }
        }
        Ok(IngestPlan {
            source_id: id,
            created: true,
            unchanged: false,
            operations: planner.operations,
        })
    }

    /// Pure plan; callers apply the complete operation list under their own actor.
    pub fn plan_ingest(
        &self,
        snapshot: &str,
        target: Option<&str>,
        origin: Option<&str>,
    ) -> Result<IngestPlan> {
        let (format, metadata): (SourceFormat, ExtractedMetadata) = self
            .conn
            .query_row(
                "SELECT format, metadata
                 FROM snapshots
                 WHERE id = ?1",
                [snapshot],
                |r| Ok((enum_at(r, 0)?, json_at(r, 1)?)),
            )
            .optional()?
            .ok_or_else(|| not_found(snapshot))?;
        let match_key = match format {
            SourceFormat::Epub => metadata.unique_id.as_deref(),
            SourceFormat::Article => metadata.url.as_deref(),
            SourceFormat::Record => None,
        };
        let existing = if let Some(target) = target {
            Some(
                source(&self.conn, target)?
                    .ok_or_else(|| validation("The ingestion target is not an active source."))?,
            )
        } else {
            let id: Option<String> = self
                .conn
                .query_row(
                    "SELECT s.block_id
                     FROM sources s
                     JOIN blocks b ON b.id = s.block_id
                     WHERE s.active = 1 AND b.deletion_id IS NULL
                     AND ((?1 IS NOT NULL AND s.match_key = ?1) OR EXISTS(
                         SELECT 1 FROM source_snapshots a
                         WHERE a.source_id = s.block_id AND a.snapshot_id = ?2
                     ))
                     ORDER BY CASE WHEN s.match_key = ?1 THEN 0 ELSE 1 END, s.added_at, s.block_id
                     LIMIT 1",
                    params![match_key, snapshot],
                    |r| r.get(0),
                )
                .optional()?;
            id.map(|id| source(&self.conn, &id)).transpose()?.flatten()
        };
        if let Some(source) = &existing
            && self.conn.query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM source_snapshots
                     WHERE source_id = ?1 AND snapshot_id = ?2
                 )",
                params![source.block_id, snapshot],
                |r| r.get::<_, bool>(0),
            )?
        {
            return Ok(IngestPlan {
                source_id: source.block_id.clone(),
                created: false,
                unchanged: true,
                operations: vec![],
            });
        }
        let mut planner = Planner::new(self)?;
        let created = existing.is_none();
        let (id, old) = if let Some(source) = existing {
            let revision = self.block(&source.block_id)?.revision;
            planner.operations.push(Operation::AttachSnapshot {
                id: source.block_id.clone(),
                base_revision: revision,
                snapshot_id: snapshot.into(),
            });
            let old = source
                .current_snapshot_id
                .as_ref()
                .map(|s| {
                    self.conn.query_row(
                        "SELECT metadata
                             FROM snapshots
                             WHERE id = ?1",
                        [s],
                        |r| json_at(r, 0),
                    )
                })
                .transpose()?
                .unwrap_or_default();
            (source.block_id, old)
        } else {
            let type_title = planner.template(format)?;
            // Resolve people before choosing the source title, so every planned title is unique.
            let _ = planner.values(&metadata, true)?;
            let fallback = origin
                .or(metadata.url.as_deref())
                .map(|s| {
                    if let Some((_, address)) = s.split_once("://") {
                        address.to_owned()
                    } else {
                        std::path::Path::new(s)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or(s)
                            .to_owned()
                    }
                })
                .unwrap_or_else(|| match format {
                    SourceFormat::Epub => "Book".into(),
                    SourceFormat::Article => "Article".into(),
                    SourceFormat::Record => "Source".into(),
                });
            let title = metadata
                .title
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&fallback);
            let disambiguator = metadata
                .published
                .as_deref()
                .and_then(|s| s.get(..4))
                .unwrap_or(match format {
                    SourceFormat::Epub => "epub",
                    SourceFormat::Article => "article",
                    SourceFormat::Record => "record",
                });
            let title = planner.unique_title(title, disambiguator)?;
            let id = crate::notebook::new_ulid().to_string();
            planner.operations.push(Operation::CreatePage {
                id: id.clone(),
                title: title.clone(),
            });
            planner.operations.push(Operation::SetSource {
                id: id.clone(),
                base_revision: 1,
                source: Some(SourceState {
                    format,
                    state: ReadingState::Inbox,
                    origin: origin.map(str::to_owned),
                    match_key: match_key.map(str::to_owned),
                    citation_key: Some(citation_key(self, &metadata, &title)?),
                }),
            });
            planner.operations.push(Operation::AttachSnapshot {
                id: id.clone(),
                base_revision: 2,
                snapshot_id: snapshot.into(),
            });
            planner.operations.push(Operation::AddType {
                id: id.clone(),
                base_revision: 3,
                title: type_title,
            });
            (id, ExtractedMetadata::default())
        };
        let old = planner.values(&old, false)?;
        let values = planner.values(&metadata, true)?;
        let mut after: Option<String> = self
            .conn
            .query_row(
                "SELECT id
                 FROM blocks
                 WHERE parent_id = ?1 AND deletion_id IS NULL
                 ORDER BY ordinal DESC, id DESC
                 LIMIT 1",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        for (label, kind, values) in values {
            let previous = old
                .iter()
                .find(|(name, _, _)| *name == label)
                .map(|(_, _, v)| v.as_slice())
                .unwrap_or_default();
            if values.is_empty() && previous.is_empty() {
                continue;
            }
            let field = planner.field(label, kind);
            if matches!(label, "author" | "editor" | "translator") {
                planner.constrain_creator_field(label)?;
            }
            let entry: Option<String> = self
                .conn
                .query_row(
                    "SELECT b.id
                     FROM blocks b
                     JOIN links l ON l.source_id = b.id
                     WHERE b.parent_id = ?1 AND b.deletion_id IS NULL AND l.target_id = ?2
                     AND (b.text = '[[' || ?2 || ']]' OR b.text LIKE '[[' || ?2 || '|%]]')
                     ORDER BY b.ordinal, b.id
                     LIMIT 1",
                    params![id, field],
                    |r| r.get(0),
                )
                .optional()?;
            let entry = if let Some(entry) = entry {
                entry
            } else if values.is_empty() {
                continue;
            } else {
                let entry = crate::notebook::new_ulid().to_string();
                planner.operations.push(Operation::Insert {
                    id: entry.clone(),
                    parent_id: id.clone(),
                    after: after.clone(),
                    text: format!("[[{field}]]"),
                    heading: None,
                });
                after = Some(entry.clone());
                entry
            };
            let mut statement = self.conn.prepare_cached(
                "SELECT id, text, revision
                 FROM blocks
                 WHERE parent_id = ?1 AND deletion_id IS NULL AND archived = 0
                 ORDER BY ordinal, id",
            )?;
            let current: Vec<(String, String, i64)> = statement
                .query_map([&entry], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let mut value_after = current.last().map(|v| v.0.clone());
            for (i, (value, text, revision)) in current.iter().enumerate().skip(values.len()) {
                if previous.get(i) == Some(text) {
                    planner.operations.push(Operation::SetArchived {
                        id: value.clone(),
                        base_revision: *revision,
                        archived: true,
                    });
                }
            }
            for (i, text) in values.into_iter().enumerate() {
                if let Some((value, old_text, revision)) = current.get(i) {
                    if previous.get(i) == Some(old_text) && *old_text != text {
                        planner.operations.push(Operation::EditText {
                            id: value.clone(),
                            base_revision: *revision,
                            text,
                        });
                    }
                } else {
                    let value = crate::notebook::new_ulid().to_string();
                    planner.operations.push(Operation::Insert {
                        id: value.clone(),
                        parent_id: entry.clone(),
                        after: value_after,
                        text,
                        heading: None,
                    });
                    value_after = Some(value);
                }
            }
        }
        Ok(IngestPlan {
            source_id: id,
            created,
            unchanged: false,
            operations: planner.operations,
        })
    }
    pub fn extracted_values(&self, id: &str) -> Result<Vec<(String, Vec<String>)>> {
        let source = source(&self.conn, id)?.ok_or_else(|| not_found(id))?;
        let Some(snapshot) = source.current_snapshot_id else {
            return Ok(vec![]);
        };
        let metadata = self.conn.query_row(
            "SELECT metadata
             FROM snapshots
             WHERE id = ?1",
            [snapshot],
            |r| json_at(r, 0),
        )?;
        let mut planner = Planner::new(self)?;
        Ok(planner
            .values(&metadata, false)?
            .into_iter()
            .filter(|(_, _, v)| !v.is_empty())
            .map(|(name, _, values)| (name.into(), values))
            .collect())
    }
}
