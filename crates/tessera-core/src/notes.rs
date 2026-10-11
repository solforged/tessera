//! Notes are titled pages. The index files them by kind: the built-in kinds Person, Group, Concept and Thesis
//! come from type pages with those titles, Question, Source and Project from capabilities on the page, and
//! every other type with a titled page among its members is a kind of its own. Nothing here is stored.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::storage::{not_found, validate_id, validation};
use crate::{Notebook, Result};

/// Built-in kinds read from type pages, by their Unicode-lowercase title: key, singular, plural.
const TYPE_KINDS: [(&str, &str, &str); 4] = [
    ("person", "Person", "People"),
    ("group", "Group", "Groups"),
    ("concept", "Concept", "Concepts"),
    ("thesis", "Thesis", "Theses"),
];
/// Built-in kinds read from capabilities on the page, in index order after the type kinds.
const CAPABILITY_KINDS: [(&str, &str, &str, &str); 3] = [
    ("question", "Question", "Questions", "questions"),
    ("source", "Source", "Sources", "sources"),
    ("project", "Project", "Projects", "projects"),
];
const UNFILED: &str = "unfiled";

/// One kind a note can be filed under. `key` is `person`, `group`, `concept`, `thesis`, `question`,
/// `source`, `project`, `type:<id>` for a type you made, or `unfiled`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteKind {
    pub key: String,
    pub name: String,
    pub plural: String,
    /// The type page a kind reads its members from; capability kinds and Unfiled have none.
    pub type_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexKind {
    #[serde(flatten)]
    pub kind: NoteKind,
    pub count: usize,
}

/// The sidebar index: kinds with at least one note, in index order, and the number of distinct notes listed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteIndex {
    pub kinds: Vec<IndexKind>,
    pub notes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteEntry {
    pub id: String,
    pub title: String,
    pub created_at: i64,
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
}

impl Notebook {
    /// Kinds with their note counts, for the sidebar.
    pub fn note_index(&self) -> Result<NoteIndex> {
        let filing = self.filing()?;
        let mut counts = vec![0; filing.kinds.len()];
        let mut listed = 0;
        for note in &filing.notes {
            for &kind in &note.kinds {
                counts[kind] += 1;
            }
            listed += usize::from(!note.kinds.is_empty());
        }
        Ok(NoteIndex {
            kinds: filing
                .kinds
                .into_iter()
                .zip(counts)
                .filter(|(_, count)| *count > 0)
                .map(|(kind, count)| IndexKind { kind, count })
                .collect(),
            notes: listed,
        })
    }

    /// One kind's notes by title, for its finding aid.
    pub fn kind_notes(&self, key: &str) -> Result<Vec<NoteEntry>> {
        let type_id = key.strip_prefix("type:");
        if let Some(id) = type_id {
            validate_id(id)?;
        } else if !is_named_kind(key) {
            return Err(validation(format!("not a note kind: {key}")));
        }
        let filing = self.filing()?;
        let Some(index) = filing.kinds.iter().position(|kind| kind.key == key) else {
            // A known kind with no notes yet, or a type that no titled page belongs to.
            return match type_id {
                Some(id) => Err(not_found(id)),
                None => Ok(Vec::new()),
            };
        };
        Ok(filing
            .notes
            .into_iter()
            .filter(|note| note.kinds.contains(&index))
            .map(|note| note.entry)
            .collect())
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

        let mut kinds: Vec<NoteKind> = TYPE_KINDS
            .iter()
            .map(|(key, name, plural)| (*key, *name, *plural))
            .chain(
                CAPABILITY_KINDS
                    .iter()
                    .map(|(key, name, plural, _)| (*key, *name, *plural)),
            )
            .map(|(key, name, plural)| NoteKind {
                key: key.into(),
                name: name.into(),
                plural: plural.into(),
                type_id: None,
            })
            .collect();
        // Types you made, ordered by title after the built-in kinds.
        let made: BTreeMap<(&str, &str), &str> = memberships
            .iter()
            .filter(|(_, _, _, title_key)| !TYPE_KINDS.iter().any(|(key, ..)| key == title_key))
            .map(|(_, id, title, title_key)| ((title_key.as_str(), id.as_str()), title.as_str()))
            .collect();
        let mut by_type: HashMap<&str, usize> = HashMap::new();
        for ((_, id), title) in made {
            by_type.insert(id, kinds.len());
            kinds.push(NoteKind {
                key: format!("type:{id}"),
                name: title.to_owned(),
                plural: title.to_owned(),
                type_id: Some(id.to_owned()),
            });
        }
        let unfiled = kinds.len();
        kinds.push(NoteKind {
            key: UNFILED.into(),
            name: "Unfiled".into(),
            plural: "Unfiled".into(),
            type_id: None,
        });

        for (note_id, type_id, _, title_key) in &memberships {
            let Some(&note) = position.get(note_id) else {
                continue;
            };
            let kind = match TYPE_KINDS.iter().position(|(key, ..)| key == title_key) {
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
        for (offset, (_, _, _, table)) in CAPABILITY_KINDS.iter().enumerate() {
            let sql = format!("SELECT block_id FROM {table} WHERE active = 1");
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

        // A type page is listed as its kind, not as an unfiled note.
        let types: HashSet<String> = self
            .conn
            .prepare_cached(
                "SELECT DISTINCT m.type_id FROM memberships m JOIN blocks b ON b.id = m.block_id
                 WHERE m.type_id IS NOT NULL AND b.deletion_id IS NULL",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<_>>()?;
        for note in &mut notes {
            note.kinds.sort_unstable();
            note.kinds.dedup();
            if note.kinds.is_empty() && !types.contains(&note.entry.id) {
                note.kinds.push(unfiled);
            }
        }
        Ok(Filing { kinds, notes })
    }
}

fn is_named_kind(key: &str) -> bool {
    key == UNFILED
        || TYPE_KINDS.iter().any(|(name, ..)| *name == key)
        || CAPABILITY_KINDS.iter().any(|(name, ..)| *name == key)
}
