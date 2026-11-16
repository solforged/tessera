use std::collections::BTreeSet;

use rusqlite::fallible_streaming_iterator::FallibleStreamingIterator;
use rusqlite::hooks::Action;
use rusqlite::session::{ChangesetItem, Session};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension, params};

use super::Topic::{self, *};
use crate::Result;

/// The data topics: all but `Sync`, which follows the workshop's role.
const DATA: &[Topic] = &[
    Fields, Types, Pages, Inquiry, Tasks, Cards, Library, Revisits, Views,
];

/// Tables whose net row changes alter a topic, beside `blocks`, which is
/// classified per row.
const TABLES: &[(&str, &[Topic])] = &[
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
];

/// What a page's title, kind, move or deletion can alter: every list that
/// names pages.
const ROOT: &[Topic] = &[Fields, Types, Pages, Inquiry, Tasks, Library, Revisits];

/// Records a commit's net row changes from before its first write.
pub(crate) struct Watch<'conn> {
    session: Session<'conn>,
}

pub(crate) fn watch(conn: &Connection) -> Result<Watch<'_>> {
    let mut session = Session::new(conn)?;
    session.attach(Some("blocks"))?;
    for (table, _) in TABLES {
        session.attach(Some(*table))?;
    }
    Ok(Watch { session })
}

/// The `blocks` columns a row classification reads, by position.
struct Columns {
    id: usize,
    parent_id: usize,
    page_id: usize,
    kind: usize,
    text: usize,
    title_key: usize,
    archived: usize,
    deletion_id: usize,
}

impl Columns {
    fn of(conn: &Connection) -> Result<Self> {
        let names: Vec<String> = conn
            .prepare_cached("SELECT name FROM pragma_table_info('blocks') ORDER BY cid")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let at = |name: &str| {
            names
                .iter()
                .position(|column| column == name)
                .expect("blocks has the classified columns")
        };
        Ok(Self {
            id: at("id"),
            parent_id: at("parent_id"),
            page_id: at("page_id"),
            kind: at("kind"),
            text: at("text"),
            title_key: at("title_key"),
            archived: at("archived"),
            deletion_id: at("deletion_id"),
        })
    }
}

/// One changed `blocks` row. An insert or delete carries every column; an
/// update carries its key and the columns it changed.
struct BlockChange {
    id: String,
    root: Option<bool>,
    page_id: Option<String>,
    whole: bool,
    text: bool,
    archived: bool,
    deleted: bool,
    moved: bool,
}

fn owned(value: ValueRef<'_>) -> Option<String> {
    value.as_str().ok().map(str::to_owned)
}

impl BlockChange {
    fn read(item: &ChangesetItem, action: Action, columns: &Columns) -> Self {
        let value = |column: usize| match action {
            Action::SQLITE_INSERT => item.new_value(column).ok(),
            Action::SQLITE_DELETE => item.old_value(column).ok(),
            _ => item
                .new_value(column)
                .ok()
                .or_else(|| item.old_value(column).ok()),
        };
        let changed =
            |column: usize| action != Action::SQLITE_UPDATE || item.new_value(column).is_ok();
        Self {
            id: value(columns.id)
                .and_then(owned)
                .expect("a blocks change names its key"),
            root: value(columns.parent_id).map(|parent| parent == ValueRef::Null),
            page_id: value(columns.page_id).and_then(owned),
            whole: action != Action::SQLITE_UPDATE,
            text: changed(columns.text) || changed(columns.kind) || changed(columns.title_key),
            // Archiving hides a subtree; a new or removed row hides nothing else.
            archived: action == Action::SQLITE_UPDATE && changed(columns.archived),
            deleted: changed(columns.deletion_id),
            moved: changed(columns.parent_id) || changed(columns.page_id),
        }
    }
}

impl Watch<'_> {
    /// The topics the commit's net changes alter. `synced` adds `Sync`: a
    /// hub or replica recorded the commit to send or serve.
    pub(crate) fn finish(mut self, conn: &Connection, synced: bool) -> Result<Vec<Topic>> {
        let mut topics = BTreeSet::new();
        if synced {
            topics.insert(Sync);
        }
        if self.session.is_empty() {
            return Ok(topics.into_iter().collect());
        }
        let changeset = self.session.changeset()?;
        drop(self.session);
        let mut columns = None;
        let mut blocks = Vec::new();
        let mut items = changeset.iter()?;
        while let Some(item) = items.next()? {
            let operation = item.op()?;
            let table = operation.table_name();
            if table == "blocks" {
                let columns = match &columns {
                    Some(columns) => columns,
                    None => columns.insert(Columns::of(conn)?),
                };
                blocks.push(BlockChange::read(item, operation.code(), columns));
            } else if let Some((_, affected)) = TABLES.iter().find(|(name, _)| *name == table) {
                topics.extend(affected.iter().copied());
            }
        }
        if !blocks.is_empty() {
            classify(conn, &blocks, &mut topics)?;
        }
        Ok(topics.into_iter().collect())
    }
}

fn classify(conn: &Connection, blocks: &[BlockChange], topics: &mut BTreeSet<Topic>) -> Result<()> {
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
