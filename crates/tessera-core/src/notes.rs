//! Notes are titled pages. The index files them by kind: the built-in kinds Person, Group, Concept and Thesis
//! come from type pages with those titles, Question, Source and Project from capabilities on the page, and
//! every other type with titled-page or tagged-block members is a kind of its own. Nothing here is stored.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::aliases::fold;
use crate::reads::hidden_blocks;
use crate::storage::{not_found, validate_id, validation};
use crate::{Notebook, Result};

/// Built-in kinds read from type pages, by their Unicode-lowercase title: key, singular, plural, icon.
const TYPE_KINDS: [(&str, &str, &str, &str); 4] = [
    ("person", "Person", "People", "person"),
    ("group", "Group", "Groups", "group"),
    ("concept", "Concept", "Concepts", "concept"),
    ("thesis", "Thesis", "Theses", "thesis"),
];

const TYPE_ICONS: [(&str, &str, &str); 3] = [
    ("book", "Book", "book"),
    ("article", "Article", "article"),
    ("collection", "Collection", "shelf"),
];

/// Conservative English suffixes; an explicit plural covers ambiguous and irregular titles.
pub(crate) fn auto_plural(title: &str) -> String {
    if title.is_empty()
        || title.chars().any(|c| {
            c.is_alphabetic() && !matches!(c, 'A'..='Z' | 'a'..='z' | '\u{00c0}'..='\u{024f}')
        })
    {
        return title.to_owned();
    }
    let lower = title.to_lowercase();
    let (stem, suffix) = if lower.ends_with("is") {
        (&title[..title.len() - 2], "es")
    } else if lower.ends_with("ss")
        || lower.ends_with("us")
        || lower.ends_with('x')
        || lower.ends_with('z')
        || lower.ends_with("ch")
        || lower.ends_with("sh")
    {
        (title, "es")
    } else if lower.ends_with('s') {
        return title.to_owned();
    } else if lower.ends_with('y')
        && lower.len() > 1
        && !b"aeiou".contains(&lower.as_bytes()[lower.len() - 2])
        && lower.as_bytes()[lower.len() - 2].is_ascii_alphabetic()
    {
        (&title[..title.len() - 1], "ies")
    } else {
        (title, "s")
    };
    let mut plural = String::with_capacity(stem.len() + suffix.len());
    plural.push_str(stem);
    if title
        .chars()
        .filter(|c| c.is_alphabetic())
        .all(|c| c.is_uppercase())
    {
        plural.extend(suffix.chars().map(|c| c.to_ascii_uppercase()));
    } else {
        plural.push_str(suffix);
    }
    plural
}
/// Built-in kinds read from capabilities on the page, in index order after the type kinds: key,
/// singular, plural, table, icon.
pub(crate) const CAPABILITY_KINDS: [(&str, &str, &str, &str, &str); 4] = [
    ("task", "Task", "Tasks", "tasks", "task"),
    (
        "question",
        "Question",
        "Questions",
        "questions",
        "question-open",
    ),
    ("source", "Source", "Sources", "sources", "library"),
    ("project", "Project", "Projects", "projects", "flag"),
];

pub(crate) fn built_in_tag_name(key: &str) -> Option<&'static str> {
    TYPE_KINDS
        .iter()
        .map(|(key, name, ..)| (*key, *name))
        .chain(CAPABILITY_KINDS.iter().map(|(key, name, ..)| (*key, *name)))
        .chain(TYPE_ICONS.iter().map(|(key, name, _)| (*key, *name)))
        .find_map(|(candidate, name)| (candidate == key).then_some(name))
}
const UNFILED: &str = "unfiled";

/// One kind a note can be filed under. `key` is `person`, `group`, `concept`, `thesis`, `question`,
/// `source`, `project`, `type:<id>` for a type you made, or `unfiled`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteKind {
    pub key: String,
    pub name: String,
    pub plural: String,
    pub icon: Option<String>,
    /// The live page named by this tag; Unfiled has none.
    pub type_id: Option<String>,
}

/// The finding-aid group a kind is listed under in the sidebar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Shelf {
    /// People, groups, concepts, theses and questions.
    Notes,
    /// Sources, and types most of whose notes are sources.
    Sources,
    /// Projects, and types most of whose notes are projects.
    Work,
    /// Other types you made, including ones that only tag blocks.
    Tags,
    /// Unfiled.
    Loose,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexKind {
    #[serde(flatten)]
    pub kind: NoteKind,
    /// Distinct titled notes, independent of tagged non-page blocks.
    pub count: usize,
    pub tagged_block_count: usize,
    /// Live cards on members, which is the kind's tag deck.
    pub cards: usize,
    /// The type page's template, as field definition IDs; empty without a type page.
    pub fields: Vec<String>,
    /// Whether `#name` names this kind: built-in type kinds and types you made, not capabilities or Unfiled.
    pub tag: bool,
    pub shelf: Shelf,
}

/// The sidebar index: every built-in kind, then other kinds with notes or tagged blocks, in index
/// order, and the distinct note total.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteIndex {
    pub kinds: Vec<IndexKind>,
    pub notes: usize,
    pub fields: usize,
    #[serde(default)]
    pub spreads: Vec<SeeTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteEntry {
    pub id: String,
    pub title: String,
    pub sort_as: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeeTarget {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrossReference {
    pub alias: String,
    pub targets: Vec<SeeTarget>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KindIndex {
    pub notes: Vec<NoteEntry>,
    pub see: Vec<CrossReference>,
    /// Batched, derived apparatus for the notes in this read. Nothing is stored.
    pub summaries: HashMap<String, crate::NoteSummary>,
}

struct Note {
    entry: NoteEntry,
    /// Indices into `Filing::kinds`.
    kinds: Vec<usize>,
}

struct Filing {
    /// Built-in kinds first, then types you made by title, then Unfiled.
    kinds: Vec<NoteKind>,
    /// Live titled pages by title, excluding the Fields page.
    notes: Vec<Note>,
    /// Distinct visible non-page members, aligned with `kinds`.
    tagged_block_counts: Vec<usize>,
}

impl Notebook {
    pub(crate) fn query_note_kinds(&self) -> Result<HashMap<String, Vec<String>>> {
        let filing = self.filing()?;
        Ok(filing
            .notes
            .into_iter()
            .map(|note| {
                (
                    note.entry.id,
                    note.kinds
                        .into_iter()
                        .map(|index| filing.kinds[index].key.clone())
                        .collect(),
                )
            })
            .collect())
    }

    /// Kinds with independent note and tagged-block counts, for the sidebar.
    pub fn note_index(&self) -> Result<NoteIndex> {
        let filing = self.filing()?;
        let (task, question, source, project) = (
            TYPE_KINDS.len(),
            TYPE_KINDS.len() + 1,
            TYPE_KINDS.len() + 2,
            TYPE_KINDS.len() + 3,
        );
        let mut counts = vec![0; filing.kinds.len()];
        // Per kind, how many of its notes are also sources or projects; a type you made is shelved by its majority.
        let mut sources = vec![0; filing.kinds.len()];
        let mut projects = vec![0; filing.kinds.len()];
        let mut listed = 0;
        for note in &filing.notes {
            let is_source = note.kinds.contains(&source);
            let is_project = note.kinds.contains(&project);
            for &kind in &note.kinds {
                counts[kind] += 1;
                sources[kind] += usize::from(is_source);
                projects[kind] += usize::from(is_project);
            }
            listed += usize::from(!note.kinds.is_empty());
        }
        counts[question] = self
            .conn
            .prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT COUNT(*) FROM questions q JOIN blocks b ON b.id = q.block_id
             JOIN blocks p ON p.id = b.page_id WHERE q.active = 1
             AND b.deletion_id IS NULL AND p.deletion_id IS NULL
             AND b.rowid NOT IN (SELECT rowid FROM hidden)"
            ))?
            .query_row([], |row| row.get::<_, i64>(0))? as usize;
        let unfiled = filing.kinds.len() - 1;
        // Library types (books, articles, collections) shelve with sources even before their notes carry a source record.
        let shelf = |index: usize, kind: &NoteKind, count: usize| match index {
            _ if index == task => Shelf::Work,
            _ if index <= question => Shelf::Notes,
            _ if index == source => Shelf::Sources,
            _ if index == project => Shelf::Work,
            _ if index == unfiled => Shelf::Loose,
            _ if 2 * sources[index] > count
                || TYPE_ICONS
                    .iter()
                    .any(|(key, ..)| *key == kind.name.to_lowercase()) =>
            {
                Shelf::Sources
            }
            _ if 2 * projects[index] > count => Shelf::Work,
            _ => Shelf::Tags,
        };
        // Cards on members, whatever their page, counted as the tag deck counts them.
        let cards: HashMap<String, usize> = self
            .conn
            .prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT m.type_id, COUNT(DISTINCT c.id)
                 FROM card_units c JOIN blocks b ON b.id = c.source_block_id
                 JOIN blocks p ON p.id = b.page_id
                 JOIN memberships m ON m.block_id = b.id
                 JOIN blocks t ON t.id = m.type_id
                 WHERE c.active = 1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL
                   AND b.rowid NOT IN (SELECT rowid FROM hidden)
                   AND t.kind = 'page' AND t.deletion_id IS NULL
                   AND t.rowid NOT IN (SELECT rowid FROM hidden)
                 GROUP BY m.type_id"
            ))?
            .query_map([], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as usize)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut kinds = Vec::with_capacity(filing.kinds.len());
        for (index, ((kind, count), tagged_block_count)) in filing
            .kinds
            .into_iter()
            .zip(counts)
            .zip(filing.tagged_block_counts)
            .enumerate()
        {
            // Built-in kinds come first in `Filing::kinds` and stay listed while empty.
            if index >= TYPE_KINDS.len() + CAPABILITY_KINDS.len()
                && count == 0
                && tagged_block_count == 0
            {
                continue;
            }
            let (cards, fields) = match &kind.type_id {
                Some(id) => (
                    cards.get(id).copied().unwrap_or(0),
                    crate::query::template(&self.conn, id)?,
                ),
                None => (0, Vec::new()),
            };
            kinds.push(IndexKind {
                shelf: shelf(index, &kind, count),
                tag: index < TYPE_KINDS.len() + CAPABILITY_KINDS.len()
                    || kind.key.starts_with("type:"),
                kind,
                count,
                tagged_block_count,
                cards,
                fields,
            });
        }
        // Match the Fields register: named, undeleted children of its live page,
        // including archived definitions. Read only names, not the full definitions.
        let fields = self
            .conn
            .prepare_cached(
                "SELECT d.text FROM blocks p JOIN blocks d ON d.parent_id = p.id
                 WHERE p.kind = 'page' AND p.title_key = 'fields'
                   AND p.deletion_id IS NULL AND d.deletion_id IS NULL",
            )?
            .query_map([], |row| {
                Ok(usize::from(!row.get_ref(0)?.as_str()?.trim().is_empty()))
            })?
            .try_fold(0, |count, named| named.map(|named| count + named))?;
        Ok(NoteIndex {
            kinds,
            notes: listed,
            fields,
            spreads: self.saved_spreads()?,
        })
    }

    /// One kind's notes and alias cross-references, for its finding aid.
    pub fn kind_notes(&self, key: &str) -> Result<KindIndex> {
        let type_id = key.strip_prefix("type:");
        if let Some(id) = type_id {
            validate_id(id)?;
        } else if !is_named_kind(key) {
            return Err(validation(format!("not a note kind: {key}")));
        }
        let filing = self.filing()?;
        let Some(index) = filing.kinds.iter().position(|kind| kind.key == key) else {
            // A known kind with no members yet, or an unknown custom type.
            return match type_id {
                Some(id) => Err(not_found(id)),
                None => Ok(KindIndex::default()),
            };
        };
        let summary_type = filing.kinds[index].type_id.clone();
        let mut notes: Vec<_> = filing
            .notes
            .into_iter()
            .filter(|note| note.kinds.contains(&index))
            .map(|note| note.entry)
            .collect();
        let mut sort_as = self.named_page_values("sort as", None)?;
        for note in &mut notes {
            note.sort_as = sort_as
                .remove(&note.id)
                .and_then(|values| values.into_iter().next());
        }
        notes.sort_by_cached_key(|note| {
            (
                fold(note.sort_as.as_deref().unwrap_or(&note.title)),
                note.id.clone(),
            )
        });
        let mut aliases = self.aliases_by_page()?;
        let mut see: BTreeMap<String, CrossReference> = BTreeMap::new();
        for note in &notes {
            let names = aliases.remove(&note.id).unwrap_or_default();
            let folded: Vec<_> = names.iter().map(|name| fold(name)).collect();
            let words: Vec<HashSet<_>> = folded
                .iter()
                .map(|name| name.split_whitespace().collect())
                .collect();
            let title = fold(&note.title);
            for (index, alias) in names.into_iter().enumerate() {
                let key = &folded[index];
                if key == &title
                    || words.iter().enumerate().any(|(other, shorter)| {
                        folded[other].len() < key.len() && shorter.is_subset(&words[index])
                    })
                {
                    continue;
                }
                let reference = see.entry(key.clone()).or_insert_with(|| CrossReference {
                    alias,
                    targets: Vec::new(),
                });
                if !reference.targets.iter().any(|target| target.id == note.id) {
                    reference.targets.push(SeeTarget {
                        id: note.id.clone(),
                        title: note.title.clone(),
                    });
                }
            }
        }
        for reference in see.values_mut() {
            reference.targets.sort_by(|left, right| {
                left.title
                    .cmp(&right.title)
                    .then_with(|| left.id.cmp(&right.id))
            });
        }
        let summaries = self.index_summaries(&notes, summary_type.as_deref())?;
        Ok(KindIndex {
            notes,
            see: see.into_values().collect(),
            summaries,
        })
    }

    /// The kinds one titled page is filed under, in index order. Empty for an unfiled note.
    pub fn note_kinds(&self, page_id: &str) -> Result<Vec<NoteKind>> {
        validate_id(page_id)?;
        let filing = self.filing()?;
        let note = filing
            .notes
            .iter()
            .find(|note| note.entry.id == page_id)
            .ok_or_else(|| not_found(page_id))?;
        Ok(note
            .kinds
            .iter()
            .map(|&index| filing.kinds[index].clone())
            .filter(|kind| kind.key != UNFILED)
            .collect())
    }

    pub(crate) fn spread_kinds(&self, ids: &[String]) -> Result<HashMap<String, Vec<NoteKind>>> {
        let filing = self.filing()?;
        Ok(filing
            .notes
            .into_iter()
            .filter(|note| ids.contains(&note.entry.id))
            .map(|note| {
                let kinds = note
                    .kinds
                    .into_iter()
                    .map(|index| &filing.kinds[index])
                    .filter(|kind| kind.key != UNFILED)
                    .cloned()
                    .collect();
                (note.entry.id, kinds)
            })
            .collect())
    }

    fn filing(&self) -> Result<Filing> {
        let mut notes = self
            .conn
            .prepare_cached(
                "SELECT id, text, created_at FROM blocks
                 WHERE parent_id IS NULL AND kind = 'page' AND deletion_id IS NULL AND archived = 0
                   AND title_key <> 'fields'
                 ORDER BY title_key, id",
            )?
            .query_map([], |row| {
                Ok(Note {
                    entry: NoteEntry {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        created_at: row.get(2)?,
                        sort_as: None,
                    },
                    kinds: Vec::new(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let position: HashMap<String, usize> = notes
            .iter()
            .enumerate()
            .map(|(index, note)| (note.entry.id.clone(), index))
            .collect();

        // Memberships of titled pages in live, visible types.
        let memberships = self
            .conn
            .prepare_cached(
                "SELECT DISTINCT m.block_id, t.id, t.text, t.title_key FROM memberships m
                 JOIN blocks b ON b.id = m.block_id JOIN blocks t ON t.id = m.type_id
                 WHERE b.parent_id IS NULL AND b.kind = 'page' AND b.deletion_id IS NULL AND b.archived = 0
                   AND t.kind = 'page' AND t.deletion_id IS NULL AND t.archived = 0",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        // Count tagged blocks in one grouped read, using the same visibility as type tables.
        let tagged_types = self
            .conn
            .prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT t.id, t.text, t.title_key, COUNT(DISTINCT m.block_id)
                 FROM memberships m JOIN blocks b ON b.id = m.block_id
                 JOIN blocks p ON p.id = b.page_id JOIN blocks t ON t.id = m.type_id
                 WHERE b.kind <> 'page' AND t.kind = 'page'
                   AND b.deletion_id IS NULL AND p.deletion_id IS NULL AND t.deletion_id IS NULL
                   AND b.rowid NOT IN (SELECT rowid FROM hidden)
                   AND t.rowid NOT IN (SELECT rowid FROM hidden)
                 GROUP BY t.id",
            ))?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? as usize,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut kinds: Vec<NoteKind> = TYPE_KINDS
            .iter()
            .map(|(key, name, plural, icon)| (*key, *name, *plural, *icon))
            .chain(
                CAPABILITY_KINDS
                    .iter()
                    .map(|(key, name, plural, _, icon)| (*key, *name, *plural, *icon)),
            )
            .map(|(key, name, plural, icon)| NoteKind {
                key: key.into(),
                name: name.into(),
                plural: plural.into(),
                icon: Some(icon.into()),
                type_id: None,
            })
            .collect();
        let mut builtin_page = self.conn.prepare_cached(
            "SELECT id FROM blocks WHERE kind = 'page' AND deletion_id IS NULL AND title_key = ?1",
        )?;
        for kind in &mut kinds {
            kind.type_id = builtin_page
                .query_row([&kind.key], |row| row.get(0))
                .optional()?;
        }
        // Types you made, ordered by title after the built-in kinds.
        let made: BTreeMap<(&str, &str), &str> = memberships
            .iter()
            .map(|(_, id, title, title_key)| (id, title, title_key))
            .chain(
                tagged_types
                    .iter()
                    .map(|(id, title, title_key, _)| (id, title, title_key)),
            )
            .filter(|(_, _, title_key)| !kinds.iter().any(|kind| &kind.key == *title_key))
            .map(|(id, title, title_key)| ((title_key.as_str(), id.as_str()), title.as_str()))
            .collect();
        let mut by_type: HashMap<&str, usize> = HashMap::new();
        for ((_, id), title) in made {
            by_type.insert(id, kinds.len());
            kinds.push(NoteKind {
                key: format!("type:{id}"),
                name: title.to_owned(),
                plural: auto_plural(title),
                icon: None,
                type_id: Some(id.to_owned()),
            });
        }
        let unfiled = kinds.len();
        kinds.push(NoteKind {
            key: UNFILED.into(),
            name: "Unfiled".into(),
            plural: "Unfiled".into(),
            icon: Some("page".into()),
            type_id: None,
        });

        for (note_id, type_id, _, title_key) in &memberships {
            let Some(&note) = position.get(note_id) else {
                continue;
            };
            let kind = match kinds
                .iter()
                .take(TYPE_KINDS.len() + CAPABILITY_KINDS.len())
                .position(|kind| &kind.key == title_key)
            {
                Some(builtin) => {
                    kinds[builtin]
                        .type_id
                        .get_or_insert_with(|| type_id.clone());
                    builtin
                }
                None => by_type[type_id.as_str()],
            };
            notes[note].kinds.push(kind);
        }
        let mut tagged_block_counts = vec![0; kinds.len()];
        for (type_id, _, title_key, count) in &tagged_types {
            let kind = match kinds
                .iter()
                .take(TYPE_KINDS.len() + CAPABILITY_KINDS.len())
                .position(|kind| &kind.key == title_key)
            {
                Some(builtin) => {
                    kinds[builtin]
                        .type_id
                        .get_or_insert_with(|| type_id.clone());
                    builtin
                }
                None => by_type[type_id.as_str()],
            };
            tagged_block_counts[kind] += count;
        }
        // Read overrides together; defaults are derived, so old notebooks need no backfill.
        let presentation: HashMap<String, (Option<String>, Option<String>)> = self
            .conn
            .prepare_cached("SELECT type_id, plural, icon FROM type_presentation")?
            .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?
            .collect::<rusqlite::Result<_>>()?;
        for kind in &mut kinds {
            if let Some((plural, icon)) = kind.type_id.as_ref().and_then(|id| presentation.get(id))
            {
                if let Some(plural) = plural {
                    kind.plural.clone_from(plural);
                }
                if let Some(icon) = icon {
                    kind.icon = Some(icon.clone());
                }
            }
            if kind.icon.is_none() {
                let title_key = kind.name.to_lowercase();
                kind.icon = TYPE_ICONS
                    .iter()
                    .find(|(key, ..)| *key == title_key)
                    .map(|(_, _, icon)| (*icon).to_owned());
            }
        }
        for (offset, (_, _, _, table, _)) in CAPABILITY_KINDS.iter().enumerate() {
            let sql = format!(
                "SELECT block_id FROM {table} WHERE active = 1{}",
                if *table == "tasks" {
                    " AND json_extract(state, '$.status') IS NOT NULL"
                } else {
                    ""
                }
            );
            let ids = self
                .conn
                .prepare_cached(&sql)?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for id in ids {
                if let Some(&note) = position.get(&id) {
                    notes[note].kinds.push(TYPE_KINDS.len() + offset);
                }
            }
        }

        // A type page is listed as its kind and a saved spread under Spreads, not as an unfiled note.
        let listed: HashSet<String> = self
            .conn
            .prepare_cached(
                "SELECT DISTINCT m.type_id FROM memberships m JOIN blocks b ON b.id = m.block_id
                 WHERE m.type_id IS NOT NULL AND b.deletion_id IS NULL
                 UNION SELECT type_id FROM field_targets
                 UNION SELECT block_id FROM spreads WHERE active = 1",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<_>>()?;
        // A built-in tag's page is the kind itself, so it is never an unfiled note.
        for note in &mut notes {
            note.kinds.sort_unstable();
            note.kinds.dedup();
            if note.kinds.is_empty()
                && !listed.contains(&note.entry.id)
                && built_in_tag_name(&crate::storage::title_key(&note.entry.title)).is_none()
            {
                note.kinds.push(unfiled);
            }
        }
        Ok(Filing {
            kinds,
            notes,
            tagged_block_counts,
        })
    }
}

fn is_named_kind(key: &str) -> bool {
    key == UNFILED
        || TYPE_KINDS.iter().any(|(name, ..)| *name == key)
        || CAPABILITY_KINDS.iter().any(|(name, ..)| *name == key)
}

#[cfg(test)]
mod plural_tests {
    use super::auto_plural;

    #[test]
    fn conservative_english_plurals_preserve_case() {
        for (title, expected) in [
            ("Book", "Books"),
            ("BOOK", "BOOKS"),
            ("book", "books"),
            ("Story", "Stories"),
            ("STORY", "STORIES"),
            ("Boy", "Boys"),
            ("Class", "Classes"),
            ("Box", "Boxes"),
            ("Quiz", "Quizes"),
            ("Church", "Churches"),
            ("Wish", "Wishes"),
            ("Thesis", "Theses"),
            ("THESIS", "THESES"),
            ("Analysis", "Analyses"),
            ("Books", "Books"),
            ("Stories", "Stories"),
            ("Bus", "Buses"),
            ("本", "本"),
            ("Книга", "Книга"),
            ("Café", "Cafés"),
            ("CAFÉ", "CAFÉS"),
            ("", ""),
        ] {
            assert_eq!(auto_plural(title), expected, "{title}");
        }
    }
}
