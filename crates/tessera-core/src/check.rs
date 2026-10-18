//! `tessera check`: verify a notebook and repair its derived tables.
//!
//! The read-only check runs SQLite's own file and foreign-key checks, derives
//! every derived table again inside a transaction and compares the result with
//! what was stored, then rolls the transaction back. Repair keeps the
//! transaction instead, recorded as a change by the `check` client so a hub's
//! replicas pull the corrected rows like any other change. Authored blocks and
//! evidence tables are never written: a derivation that would change them
//! fails the whole check before anything is kept.

use std::collections::BTreeSet;
use std::fmt::Write as _;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, ErrorCode, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::notebook::{new_ulid, now_ms};
use crate::replication::applied_tables;
use crate::storage::{derive_links, derive_memberships, validation};
use crate::{Actor, Batch, ChangeStamp, Committed, Notebook, Result, Revision};

/// How many row IDs a difference or violation lists.
pub const SAMPLE_LIMIT: usize = 20;

/// The client recorded as the actor of a repair's change.
pub const ACTOR_NAME: &str = "check";

/// A row of `PRAGMA foreign_key_check`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForeignKeyViolation {
    pub table: String,
    /// The violating row; `None` in a table without rowids.
    pub rowid: Option<i64>,
    pub parent: String,
    /// The constraint's position among the table's foreign keys.
    pub constraint: i64,
}

/// A full-text index that disagrees with the table it indexes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchIndex {
    pub table: String,
    pub error: String,
}

/// How a stored derived table differs from a fresh derivation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DerivedTable {
    pub table: String,
    /// Stored rows a fresh derivation does not produce.
    pub stale: u64,
    /// Rows a fresh derivation produces that were not stored.
    pub missing: u64,
    /// Up to [`SAMPLE_LIMIT`] IDs of differing rows: the block a row derives
    /// from, or the card for `card_units`.
    pub samples: Vec<String>,
}

/// A model rule and the rows that break it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invariant {
    pub name: String,
    pub violations: u64,
    /// Up to [`SAMPLE_LIMIT`] offending IDs, title keys or dates.
    pub samples: Vec<String>,
}

/// SHA-256 over a table's rows in primary-key order, with every column
/// tagged by type, so two devices holding the same rows agree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableHash {
    pub table: String,
    pub rows: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckReport {
    /// True when nothing below found a problem, as the notebook was found.
    pub ok: bool,
    /// Messages from `PRAGMA quick_check`; empty for a sound file.
    pub quick_check: Vec<String>,
    pub foreign_keys: Vec<ForeignKeyViolation>,
    pub search: Vec<SearchIndex>,
    pub derived: Vec<DerivedTable>,
    pub invariants: Vec<Invariant>,
    /// One hash per Applied-class table, in [`crate::replication::TABLES`] order.
    pub hashes: Vec<TableHash>,
    /// The change that replaced the derived tables, when a repair changed anything.
    pub repaired: Option<i64>,
}

impl CheckReport {
    /// Whether problems remain after any repair: a damaged file, a broken
    /// foreign key or invariant, or derived differences that were not repaired.
    pub fn unresolved(&self) -> bool {
        !self.quick_check.is_empty()
            || !self.foreign_keys.is_empty()
            || self.invariants.iter().any(|rule| rule.violations > 0)
            || (self.repaired.is_none()
                && (!self.search.is_empty()
                    || self
                        .derived
                        .iter()
                        .any(|table| table.stale + table.missing > 0)))
    }
}

/// A derived table and how to compare it with a fresh derivation.
struct Derived {
    table: &'static str,
    /// Where the fresh rows are read from: the table itself, or the view the
    /// search triggers maintain `search_blocks` from.
    recomputed: &'static str,
    /// The columns derivation determines, as read from the source.
    columns: &'static str,
    /// The same columns as the copy names them.
    names: &'static str,
    /// The rows derivation owns.
    rows: &'static str,
    /// The ID a sample names.
    sample: &'static str,
    /// The block a row derives from, for the pages a repair reports.
    block: &'static str,
}

const DERIVED: &[Derived] = &[
    Derived {
        table: "links",
        recomputed: "links",
        columns: "source_id, occurrence, target_id, alias",
        names: "source_id, occurrence, target_id, alias",
        rows: "1",
        sample: "source_id",
        block: "source_id",
    },
    Derived {
        table: "memberships",
        recomputed: "memberships",
        columns: "block_id, title_key, type_id, manual, title",
        names: "block_id, title_key, type_id, manual, title",
        rows: "manual = 0",
        sample: "block_id",
        block: "block_id",
    },
    Derived {
        table: "field_values",
        recomputed: "field_values",
        columns: "owner_id, field_id, entry_id, value_id, ordinal",
        names: "owner_id, field_id, entry_id, value_id, ordinal",
        rows: "1",
        sample: "entry_id",
        block: "entry_id",
    },
    // Definitions only: schedules and holds are evidence the derivation keeps.
    Derived {
        table: "card_units",
        recomputed: "card_units",
        columns: "id, source_block_id, key, kind, active, front, back",
        names: "id, source_block_id, key, kind, active, front, back",
        rows: "1",
        sample: "id",
        block: "source_block_id",
    },
    Derived {
        table: "search_blocks",
        recomputed: "block_search_text",
        columns: "rowid AS row_id, block_id, text",
        names: "row_id, block_id, text",
        rows: "1",
        sample: "block_id",
        block: "block_id",
    },
];

macro_rules! missing_capabilities {
    () => {
        "SELECT DISTINCT b.id AS block_id, m.title_key FROM blocks b
         JOIN memberships m ON m.block_id = b.id
         WHERE b.deletion_id IS NULL AND (
           (m.title_key = 'task' AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.block_id = b.id AND t.active = 1))
           OR (m.title_key = 'question' AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.block_id = b.id AND q.active = 1))
           OR (m.title_key = 'project' AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.block_id = b.id AND p.active = 1))
           OR (m.title_key = 'source' AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.block_id = b.id AND s.active = 1)))"
    };
}

/// Rules the schema cannot state, each a query listing the rows that break it.
const INVARIANTS: &[(&str, &str)] = &[
    (
        "built_in_tag_keeps_capability",
        concat!(
            "SELECT DISTINCT block_id FROM (",
            missing_capabilities!(),
            ") ORDER BY block_id"
        ),
    ),
    (
        "one_live_page_per_title",
        "SELECT title_key FROM blocks WHERE kind = 'page' AND deletion_id IS NULL
         GROUP BY title_key HAVING COUNT(*) > 1 ORDER BY title_key",
    ),
    (
        "one_live_journal_per_date",
        "SELECT text FROM blocks WHERE kind = 'journal' AND deletion_id IS NULL
         GROUP BY text HAVING COUNT(*) > 1 ORDER BY text",
    ),
    // Roots have page_id = id by constraint, so matching every parent means
    // matching the root.
    (
        "page_id_matches_root",
        "SELECT b.id FROM blocks b JOIN blocks p ON p.id = b.parent_id
         WHERE b.page_id != p.page_id ORDER BY b.id",
    ),
    (
        "no_live_block_under_tombstone",
        "SELECT b.id FROM blocks b JOIN blocks p ON p.id = b.parent_id
         WHERE b.deletion_id IS NULL AND p.deletion_id IS NOT NULL ORDER BY b.id",
    ),
    (
        "reviewed_card_keeps_source",
        "SELECT c.id FROM card_units c
         WHERE EXISTS (SELECT 1 FROM review_events e WHERE e.card_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.id = c.source_block_id)
         ORDER BY c.id",
    ),
];

/// Tables a repair must leave untouched: authored text and evidence.
const GUARDED: &[&str] = &[
    "blocks",
    "deletion_events",
    "review_events",
    "review_undos",
    "task_occurrences",
    "work_sessions",
    "revisit_events",
    "citations",
];

/// The full-text indexes and what they index.
const SEARCH_INDEXES: &[&str] = &["blocks_fts", "passages_fts"];

impl Notebook {
    /// Check the database file, the derived tables and the model's
    /// invariants, and hash every replicated table. With `repair`, replace the
    /// derived tables with freshly derived rows in one change by the `check`
    /// client; authored blocks and evidence are never written.
    pub fn check(&mut self, repair: bool) -> Result<CheckReport> {
        let quick_check = quick_check(&self.conn)?;
        let foreign_keys = foreign_key_check(&self.conn)?;
        let search = search_check(&self.conn)?;
        let invariants = invariants(&self.conn)?;
        let (derived, repaired) = self.compare_derived(repair, !search.is_empty())?;
        let originally_valid = invariants.iter().all(|rule| rule.violations == 0);
        let invariants = if repaired.is_some() {
            self::invariants(&self.conn)?
        } else {
            invariants
        };
        let hashes = applied_tables()
            .map(|table| table_hash(&self.conn, table))
            .collect::<Result<Vec<_>>>()?;
        let ok = quick_check.is_empty()
            && foreign_keys.is_empty()
            && search.is_empty()
            && originally_valid
            && derived.iter().all(|table| table.stale + table.missing == 0);
        Ok(CheckReport {
            ok,
            quick_check,
            foreign_keys,
            search,
            derived,
            invariants,
            hashes,
            repaired,
        })
    }

    /// Derive every derived table again and compare with what was stored.
    /// Without `repair`, or when nothing differs, the transaction rolls back.
    fn compare_derived(
        &mut self,
        repair: bool,
        rebuild_search: bool,
    ) -> Result<(Vec<DerivedTable>, Option<i64>)> {
        let now = now_ms();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        let recording = if repair {
            crate::sync::begin_repair(&tx)?
        } else {
            None
        };
        let guarded = guard_digests(&tx)?;
        for derived in DERIVED {
            tx.execute_batch(&format!(
                "DROP TABLE IF EXISTS temp.check_{table};
                 CREATE TEMP TABLE check_{table} AS SELECT {columns} FROM {table} WHERE {rows}",
                table = derived.table,
                columns = derived.columns,
                rows = derived.rows,
            ))?;
        }
        let cards = derive_all(&tx, now)?;
        let missing = tx
            .prepare_cached(concat!(
                missing_capabilities!(),
                " ORDER BY b.id, m.title_key"
            ))?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut blocks = BTreeSet::new();
        for (id, key) in missing {
            if crate::operations::derive_capability(&tx, &id, &key, true, now, 0)? {
                blocks.insert(id);
            }
        }
        let repaired_capabilities = !blocks.is_empty();
        if guard_digests(&tx)? != guarded {
            return Err(validation(
                "deriving again would change authored or evidence rows; nothing was written",
            ));
        }
        let derived = DERIVED
            .iter()
            .map(|table| compare(&tx, table, &mut blocks))
            .collect::<Result<Vec<_>>>()?;
        for derived in DERIVED {
            tx.execute(&format!("DROP TABLE temp.check_{}", derived.table), [])?;
        }
        let differs =
            repaired_capabilities || derived.iter().any(|table| table.stale + table.missing > 0);
        if !repair || !(differs || rebuild_search) {
            return Ok((derived, None));
        }
        // The search triggers keep blocks_fts in step with these rows.
        tx.execute_batch(
            "DELETE FROM search_blocks WHERE NOT EXISTS (
                 SELECT 1 FROM block_search_text v
                 WHERE v.rowid = search_blocks.rowid AND v.block_id = search_blocks.block_id
                   AND v.text = search_blocks.text);
             INSERT INTO search_blocks(rowid, block_id, text)
                 SELECT rowid, block_id, text FROM block_search_text v
                 WHERE NOT EXISTS (SELECT 1 FROM search_blocks s WHERE s.rowid = v.rowid);",
        )?;
        if rebuild_search {
            for table in SEARCH_INDEXES {
                tx.execute(
                    &format!("INSERT INTO {table}({table}) VALUES ('rebuild')"),
                    [],
                )?;
            }
        }
        let (seq, stamp, batch) = record_change(&tx, now, cards, &blocks)?;
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        recording.map_or(Ok(()), |recording| {
            crate::sync::finish(
                &tx,
                recording,
                seq,
                &stamp,
                &batch,
                &crate::operations::Extras::default(),
            )
        })?;
        #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
        let _ = (stamp, batch);
        tx.commit()?;
        Ok((derived, Some(seq)))
    }
}

/// Messages from `PRAGMA quick_check`, without the `ok` a sound file reports.
/// A file too damaged to run the check reports that failure as its message.
pub(crate) fn quick_check(conn: &Connection) -> Result<Vec<String>> {
    let messages = conn
        .prepare("PRAGMA quick_check")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        });
    match messages {
        Ok(messages) => Ok(messages
            .into_iter()
            .filter(|message| message != "ok")
            .collect()),
        Err(rusqlite::Error::SqliteFailure(error, message))
            if error.code == ErrorCode::DatabaseCorrupt =>
        {
            Ok(vec![message.unwrap_or_else(|| error.to_string())])
        }
        Err(error) => Err(error.into()),
    }
}

fn foreign_key_check(conn: &Connection) -> Result<Vec<ForeignKeyViolation>> {
    Ok(conn
        .prepare("PRAGMA foreign_key_check")?
        .query_map([], |row| {
            Ok(ForeignKeyViolation {
                table: row.get(0)?,
                rowid: row.get(1)?,
                parent: row.get(2)?,
                constraint: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Ask FTS5 whether each index matches its content table.
fn search_check(conn: &Connection) -> Result<Vec<SearchIndex>> {
    let mut failures = Vec::new();
    for table in SEARCH_INDEXES {
        match conn.execute(
            &format!("INSERT INTO {table}({table}) VALUES ('integrity-check')"),
            [],
        ) {
            Ok(_) => (),
            Err(rusqlite::Error::SqliteFailure(error, message))
                if error.code == ErrorCode::DatabaseCorrupt =>
            {
                failures.push(SearchIndex {
                    table: (*table).to_owned(),
                    error: message.unwrap_or_else(|| error.to_string()),
                });
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(failures)
}

fn invariants(conn: &Connection) -> Result<Vec<Invariant>> {
    INVARIANTS
        .iter()
        .map(|(name, sql)| {
            let mut statement = conn.prepare(sql)?;
            let mut rows = statement.query([])?;
            let mut violations = 0;
            let mut samples = Vec::new();
            while let Some(row) = rows.next()? {
                violations += 1;
                if samples.len() < SAMPLE_LIMIT {
                    samples.push(row.get(0)?);
                }
            }
            Ok(Invariant {
                name: (*name).to_owned(),
                violations,
                samples,
            })
        })
        .collect()
}

/// Derive links, memberships, field values and card definitions for every
/// block, as the migrations do. Returns the cards whose definition changed.
fn derive_all(tx: &Transaction, now: i64) -> Result<Vec<Revision>> {
    let blocks = tx
        .prepare("SELECT id, text FROM blocks ORDER BY id")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, text) in &blocks {
        derive_links(tx, id, text)?;
        // Never create type pages: a repair resolves tags against the pages that exist.
        derive_memberships(tx, id, text, None)?;
    }
    crate::fields::rebuild(tx)?;
    let sources = tx
        .prepare("SELECT id FROM blocks WHERE kind = 'block' ORDER BY id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut cards = crate::card_store::derive_sources(tx, &sources, now)?;
    cards.extend(crate::card_templates::derive(tx, None, None, now)?);
    cards.sort_unstable_by(|left, right| left.id.cmp(&right.id));
    Ok(cards)
}

fn compare(
    tx: &Transaction,
    derived: &Derived,
    blocks: &mut BTreeSet<String>,
) -> Result<DerivedTable> {
    let stored = format!("SELECT {} FROM temp.check_{}", derived.names, derived.table);
    let fresh = format!(
        "SELECT {} FROM {} WHERE {}",
        derived.columns, derived.recomputed, derived.rows
    );
    let mut samples = BTreeSet::new();
    let stale = difference(
        tx,
        &format!("{stored} EXCEPT {fresh}"),
        derived,
        &mut samples,
        blocks,
    )?;
    let missing = difference(
        tx,
        &format!("{fresh} EXCEPT {stored}"),
        derived,
        &mut samples,
        blocks,
    )?;
    Ok(DerivedTable {
        table: derived.table.to_owned(),
        stale,
        missing,
        samples: samples.into_iter().take(SAMPLE_LIMIT).collect(),
    })
}

fn difference(
    tx: &Transaction,
    rows: &str,
    derived: &Derived,
    samples: &mut BTreeSet<String>,
    blocks: &mut BTreeSet<String>,
) -> Result<u64> {
    let mut statement = tx.prepare(&format!(
        "SELECT {}, {} FROM ({rows})",
        derived.sample, derived.block
    ))?;
    let mut cursor = statement.query([])?;
    let mut count = 0;
    while let Some(row) = cursor.next()? {
        count += 1;
        samples.insert(row.get(0)?);
        blocks.insert(row.get(1)?);
    }
    Ok(count)
}

/// Log the repair as a change with no operations, so history, the editor's
/// change stream and a hub's replicas learn which cards and pages it touched.
fn record_change(
    tx: &Transaction,
    now: i64,
    cards: Vec<Revision>,
    blocks: &BTreeSet<String>,
) -> Result<(i64, ChangeStamp, Batch)> {
    let batch = Batch {
        actor: Actor::Client {
            name: ACTOR_NAME.to_owned(),
        },
        reason: Some("repair".to_owned()),
        idempotency_key: None,
        operations: Vec::new(),
    };
    let stamp = ChangeStamp {
        id: new_ulid().to_string(),
        origin: tx.query_row(
            "SELECT device_id FROM replica WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?,
        at: now,
    };
    let operations = serde_json::to_string(&batch.operations).expect("operations serialize");
    tx.execute(
        "INSERT INTO changes(actor, reason, created_at, operations_hash, operations, committed, change_id, origin)
         VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6, ?7)",
        params![
            serde_json::to_string(&batch.actor).expect("actor serializes"),
            batch.reason,
            now,
            crate::operations::operations_hash(&operations),
            operations,
            stamp.id,
            stamp.origin
        ],
    )?;
    let seq = tx.last_insert_rowid();
    let capabilities =
        crate::task_store::capabilities_for(tx, &blocks.iter().cloned().collect::<Vec<_>>())?;
    let blocks = serde_json::to_string(blocks).expect("block IDs serialize");
    let pages = tx
        .prepare(
            "SELECT DISTINCT page_id FROM blocks
             WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY page_id",
        )?
        .query_map([blocks], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let committed = Committed {
        seq,
        revisions: Vec::new(),
        removed: Vec::new(),
        deletions: Vec::new(),
        pages: Some(pages),
        text_rewrites: Vec::new(),
        settings: Vec::new(),
        capabilities,
        cards,
        work_sessions: Vec::new(),
        review_sessions: Vec::new(),
        decks: Vec::new(),
        task_views: Vec::new(),
        library_views: Vec::new(),
        replayed: false,
    };
    tx.execute(
        "UPDATE changes SET committed = ?1 WHERE seq = ?2",
        params![
            serde_json::to_string(&committed).expect("receipt serializes"),
            seq
        ],
    )?;
    crate::reads::record_editor_event(tx, seq, false)?;
    Ok((seq, stamp, batch))
}

/// Digests of everything a repair must not change.
fn guard_digests(conn: &Connection) -> Result<Vec<(String, u64, String)>> {
    let mut digests = Vec::with_capacity(GUARDED.len() + 1);
    for table in GUARDED {
        let hash = table_hash(conn, table)?;
        digests.push((hash.table, hash.rows, hash.sha256));
    }
    let (rows, sha256) = digest(
        conn,
        "SELECT id, schedule, held FROM card_units ORDER BY id",
    )?;
    digests.push(("card_units.schedule".to_owned(), rows, sha256));
    Ok(digests)
}

/// Hash a table's rows in primary-key order, or in the order of all its
/// columns when it declares no primary key.
fn table_hash(conn: &Connection, table: &str) -> Result<TableHash> {
    let mut columns = Vec::new();
    let mut keys = Vec::new();
    {
        let mut info = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
        let mut rows = info.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(1)?;
            let key: i64 = row.get(5)?;
            if key > 0 {
                keys.push((key, name.clone()));
            }
            columns.push(name);
        }
    }
    keys.sort();
    let order: Vec<String> = if keys.is_empty() {
        columns.clone()
    } else {
        keys.into_iter().map(|(_, name)| name).collect()
    };
    let quote = |names: &[String]| {
        names
            .iter()
            .map(|name| format!("\"{name}\""))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let (rows, sha256) = digest(
        conn,
        &format!(
            "SELECT {} FROM \"{table}\" ORDER BY {}",
            quote(&columns),
            quote(&order)
        ),
    )?;
    Ok(TableHash {
        table: table.to_owned(),
        rows,
        sha256,
    })
}

/// SHA-256 over a query's rows. Each value carries a type tag and, for text
/// and blobs, its length, so no two row sequences hash alike.
fn digest(conn: &Connection, sql: &str) -> Result<(u64, String)> {
    let mut statement = conn.prepare(sql)?;
    let width = statement.column_count();
    let mut rows = statement.query([])?;
    let mut hasher = Sha256::new();
    let mut count = 0;
    while let Some(row) = rows.next()? {
        count += 1;
        for index in 0..width {
            match row.get_ref(index)? {
                ValueRef::Null => hasher.update([0u8]),
                ValueRef::Integer(value) => {
                    hasher.update([1u8]);
                    hasher.update(value.to_le_bytes());
                }
                ValueRef::Real(value) => {
                    hasher.update([2u8]);
                    hasher.update(value.to_bits().to_le_bytes());
                }
                ValueRef::Text(text) => {
                    hasher.update([3u8]);
                    hasher.update((text.len() as u64).to_le_bytes());
                    hasher.update(text);
                }
                ValueRef::Blob(bytes) => {
                    hasher.update([4u8]);
                    hasher.update((bytes.len() as u64).to_le_bytes());
                    hasher.update(bytes);
                }
            }
        }
    }
    let hex = hasher
        .finalize()
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            write!(hex, "{byte:02x}").expect("writing to a String cannot fail");
            hex
        });
    Ok((count, hex))
}
