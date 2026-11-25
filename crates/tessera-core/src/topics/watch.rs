use std::collections::BTreeSet;

use rusqlite::Connection;
use rusqlite::fallible_streaming_iterator::FallibleStreamingIterator;
use rusqlite::hooks::Action;
use rusqlite::session::{ChangesetItem, Session};
use rusqlite::types::ValueRef;

use super::{BlockChange, TABLES, Topic, classify};
use crate::{Batch, Result};

/// Records a commit's net row changes from before its first write.
pub(crate) struct Watch<'conn> {
    session: Session<'conn>,
}

pub(crate) fn watch<'conn>(conn: &'conn Connection, _batch: &Batch) -> Result<Watch<'conn>> {
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
            topics.insert(Topic::Sync);
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
