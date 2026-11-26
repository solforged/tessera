//! Which workshop-wide data a commit changed, so a window refetches a list
//! only when that list can differ. A session records the commit's net row
//! changes natively; on `wasm32`, where SQLite sessions are unavailable,
//! `fallback` derives the same net topic set from snapshots of touched rows
//! and the batch's operations, so plain typing names no topic anywhere.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::Result;
use Topic::*;

#[cfg(any(all(target_arch = "wasm32", target_os = "unknown"), test))]
mod fallback;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod watch;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub(crate) use fallback::watch;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub(crate) use watch::watch;

/// Workshop-wide data that a change can alter. A client keys each list it
/// fetches on the topics that list reads.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum Topic {
    /// Field definitions, their entry counts and the types that use them.
    Fields,
    /// Types: members, field templates, card templates and presentation.
    Types,
    /// Pages and journals: titles, aliases, kinds, archiving and deletion.
    Pages,
    /// Positions, questions, criteria, assessments and relations.
    Inquiry,
    /// Tasks, their occurrences, work sessions and projects.
    Tasks,
    /// Cards, decks, card templates and reviews.
    Cards,
    /// Sources, snapshots, citations, metadata and library views.
    Library,
    /// Note states and revisits.
    Revisits,
    /// Saved views.
    Views,
    /// Sync state: a hub or replica has a change to send or serve.
    Sync,
}

/// The data topics: all but `Sync`, which follows the workshop's role.
pub(super) const DATA: &[Topic] = &[
    Fields, Types, Pages, Inquiry, Tasks, Cards, Library, Revisits, Views,
];

/// Tables whose net row changes alter a topic, beside `blocks`, which is
/// classified per row.
pub(super) const TABLES: &[(&str, &[Topic])] = &[
    ("links", &[Fields, Tasks]),
    ("memberships", &[Types, Pages, Library, Tasks]),
    ("deletion_events", &[Pages]),
    ("provisional_pages", &[Pages]),
    ("fields", &[Fields, Types]),
    ("field_targets", &[Fields, Types]),
    ("type_fields", &[Fields, Types]),
    ("type_presentation", &[Types, Pages]),
    ("subject_criteria", &[Inquiry]),
    ("field_values", &[Pages, Library]),
    ("views", &[Views]),
    ("tasks", &[Tasks, Fields]),
    ("projects", &[Tasks, Fields, Pages]),
    ("task_occurrences", &[Tasks]),
    ("work_sessions", &[Tasks]),
    ("task_views", &[Tasks]),
    ("positions", &[Inquiry]),
    ("relations", &[Inquiry]),
    ("questions", &[Inquiry, Pages]),
    ("assessments", &[Inquiry]),
    ("card_units", &[Cards]),
    ("card_templates", &[Cards, Types]),
    ("decks", &[Cards]),
    ("review_sessions", &[Cards]),
    ("review_events", &[Cards]),
    ("review_undos", &[Cards]),
    ("note_states", &[Revisits, Pages]),
    ("revisit_events", &[Revisits]),
    ("sources", &[Library, Pages]),
    ("source_snapshots", &[Library]),
    ("citations", &[Library]),
    ("library_views", &[Library]),
    ("id_aliases", &[Pages]),
    ("spreads", &[Pages]),
    ("sync_conflicts", &[Sync]),
];

/// What a page's title, kind, move or deletion can alter: every list that
/// names pages.
pub(super) const ROOT: &[Topic] = &[Fields, Types, Pages, Inquiry, Tasks, Library, Revisits];

/// One changed `blocks` row.
pub(super) struct BlockChange {
    pub(super) id: String,
    pub(super) root: Option<bool>,
    pub(super) page_id: Option<String>,
    pub(super) whole: bool,
    pub(super) text: bool,
    pub(super) archived: bool,
    pub(super) deleted: bool,
    pub(super) moved: bool,
}

pub(super) fn classify(
    conn: &Connection,
    blocks: &[BlockChange],
    topics: &mut BTreeSet<Topic>,
) -> Result<()> {
    let fields_page: Option<String> = conn
        .query_row(
            "SELECT id FROM blocks
             WHERE parent_id IS NULL AND kind = 'page' AND title_key = 'fields'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let mut place =
        conn.prepare_cached("SELECT parent_id IS NULL, page_id FROM blocks WHERE id = ?1")?;
    let mut roles = conn.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE block_id = ?1)
                    OR EXISTS(SELECT 1 FROM projects WHERE block_id = ?1),
                EXISTS(SELECT 1 FROM positions WHERE block_id = ?1)
                    OR EXISTS(SELECT 1 FROM questions WHERE block_id = ?1),
                EXISTS(SELECT 1 FROM citations WHERE block_id = ?1),
                EXISTS(SELECT 1 FROM links l JOIN blocks d ON d.id = l.target_id
                       WHERE l.source_id = ?1 AND d.page_id = ?2),
                EXISTS(SELECT 1 FROM field_values WHERE value_id = ?1)",
    )?;
    for block in blocks {
        // Archiving hides a whole subtree without touching its other rows.
        if block.archived {
            topics.extend(DATA.iter().copied());
            continue;
        }
        let (root, page_id) = match (block.root, &block.page_id) {
            (Some(root), Some(page)) => (root, Some(page.clone())),
            _ => place
                .query_row([&block.id], |row| Ok((row.get::<_, bool>(0)?, row.get(1)?)))
                .optional()?
                .unwrap_or((block.root.unwrap_or(true), block.page_id.clone())),
        };
        let structural = block.whole || block.deleted || block.moved;
        if !(structural || block.text) {
            continue;
        }
        if root {
            topics.extend(ROOT.iter().copied());
            continue;
        }
        // The note index counts the field definitions.
        if fields_page.is_some() && page_id == fields_page {
            topics.extend([Fields, Types, Pages]);
            continue;
        }
        let (task, inquiry, citation, entry, value): (bool, bool, bool, bool, bool) = roles
            .query_row(params![block.id, fields_page], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })?;
        if task {
            topics.insert(Tasks);
        }
        if inquiry {
            topics.insert(Inquiry);
        }
        if citation {
            topics.insert(Library);
        }
        // A value's text is metadata, an alias or a required field's content;
        // its `field_values` row names only the block, so it does not change.
        if value {
            topics.extend([Library, Types, Pages]);
        }
        // An entry counts toward its field while it and its owner are live.
        if (task || entry) && structural {
            topics.insert(Fields);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Actor, Batch, Operation, Workshop};

    /// Applied tables that never invalidate a workshop-wide topic list because
    /// every commit touches them (`changes`, `change_revisions`) or their state
    /// travels inline on `Committed` (`settings`, `quotes`, `images`, `occlusions`).
    const NEUTRAL_APPLIED: &[&str] = &[
        "changes",
        "change_revisions",
        "settings",
        "quotes",
        "images",
        "occlusions",
    ];

    #[test]
    fn every_applied_table_declares_its_topic_or_neutrality() {
        for table in crate::replication::applied_tables() {
            let covered = table == "blocks"
                || TABLES.iter().any(|(name, _)| *name == table)
                || NEUTRAL_APPLIED.contains(&table);
            assert!(
                covered,
                "Applied table `{table}` must be classified in topics::TABLES or NEUTRAL_APPLIED"
            );
        }
    }

    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    #[test]
    fn fallback_watch_matches_session_watch_for_typing_and_derived_edits() {
        let dir = tempfile::tempdir().unwrap();
        let mut workshop = Workshop::open(dir.path()).unwrap();
        let page = ulid::Ulid::from(1_u128).to_string();
        let line = ulid::Ulid::from(2_u128).to_string();
        let split_right = ulid::Ulid::from(3_u128).to_string();
        let other = ulid::Ulid::from(4_u128).to_string();
        workshop
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: vec![
                    Operation::CreatePage {
                        id: page.clone(),
                        title: "Notes".into(),
                    },
                    Operation::CreatePage {
                        id: other.clone(),
                        title: "Target".into(),
                    },
                    Operation::Insert {
                        id: line.clone(),
                        parent_id: page.clone(),
                        after: None,
                        text: "initial words".into(),
                        heading: None,
                    },
                ],
            })
            .unwrap();

        let cases = vec![
            // Plain typing on an ordinary block emits zero topics.
            vec![Operation::EditText {
                id: line.clone(),
                base_revision: 1,
                text: "updated plain words".into(),
            }],
            // Splitting plain words emits zero topics.
            vec![Operation::Split {
                id: line.clone(),
                base_revision: 2,
                new_id: split_right.clone(),
                left: "updated ".into(),
                right: "plain words".into(),
            }],
            // Adding a reference link alters `links` -> `[Fields, Tasks]`.
            vec![Operation::EditText {
                id: line.clone(),
                base_revision: 3,
                text: format!("see [[{other}]]"),
            }],
            // Adding card syntax alters `card_units` -> `[Cards]`.
            vec![Operation::EditText {
                id: split_right,
                base_revision: 1,
                text: "front >> back".into(),
            }],
            // Adding a tag creates a provisional type page and membership.
            vec![Operation::EditText {
                id: line,
                base_revision: 4,
                text: format!("see [[{other}]] #Topic"),
            }],
            // Renaming a page root touches `ROOT`.
            vec![Operation::EditText {
                id: page,
                base_revision: 1,
                text: "Renamed Notes".into(),
            }],
        ];

        for (index, operations) in cases.into_iter().enumerate() {
            let batch = Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations,
            };
            let fallback = fallback::watch(&workshop.conn, &batch).unwrap();
            let committed = workshop.apply(&batch).unwrap();
            let fallback_topics = fallback.finish(&workshop.conn, false).unwrap();
            assert_eq!(
                Some(&fallback_topics),
                committed.topics.as_ref(),
                "case {index} mismatch"
            );
            if index < 2 {
                assert!(
                    fallback_topics.is_empty(),
                    "plain typing/split case {index} must emit empty topics"
                );
            }
        }
    }
}
