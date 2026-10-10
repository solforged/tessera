use std::fmt::Write as _;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use std::io::Write;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

use crate::library::*;
use crate::storage::{not_found, validate_id, validation};
use crate::{BlockKind, Notebook, Operation, Result};

pub(crate) fn json<T: Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value).expect("library values serialize")
}
pub(crate) fn json_at<T: DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    i: usize,
) -> rusqlite::Result<T> {
    let text: String = row.get(i)?;
    serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(i, rusqlite::types::Type::Text, Box::new(error))
    })
}
pub(crate) fn enum_at<T: DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    i: usize,
) -> rusqlite::Result<T> {
    let text: String = row.get(i)?;
    serde_json::from_value(serde_json::Value::String(text)).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(i, rusqlite::types::Type::Text, Box::new(error))
    })
}
pub(crate) fn name<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .expect("enum serializes")
        .as_str()
        .expect("string enum")
        .to_owned()
}
pub(crate) fn validate_sha(sha: &str) -> Result<()> {
    if sha.len() != 64
        || !sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(validation(
            "Object hash must be 64 lowercase hexadecimal characters.",
        ));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            write!(hex, "{byte:02x}").expect("writing to String cannot fail");
            hex
        })
}

/// Content-addressed source bytes live in `objects/` beside the database.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
impl Notebook {
    pub fn object_path(&self, sha: &str) -> Result<PathBuf> {
        validate_sha(sha)?;
        Ok(self.dir.join("objects").join(&sha[..2]).join(&sha[2..]))
    }
    pub fn read_object(&self, sha: &str) -> Result<Vec<u8>> {
        Ok(std::fs::read(self.object_path(sha)?)?)
    }
    pub fn put_object(&self, bytes: &[u8]) -> Result<String> {
        let sha = sha256_hex(bytes);
        let path = self.object_path(&sha)?;
        if path.try_exists()? {
            return Ok(sha);
        }
        let directory = path.parent().expect("object parent");
        std::fs::create_dir_all(directory)?;
        let mut temp = tempfile::NamedTempFile::new_in(directory)?;
        temp.write_all(bytes)?;
        temp.as_file().sync_all()?;
        match temp.persist_noclobber(&path) {
            Ok(_) => (),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.error.into()),
        }
        std::fs::File::open(directory)?.sync_all()?;
        std::fs::File::open(self.dir.join("objects"))?.sync_all()?;
        Ok(sha)
    }
}

/// Browsers have no filesystem beside the database, so objects are rows in
/// the same OPFS-backed SQLite file (`browser_objects`, created on open).
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
impl Notebook {
    pub fn read_object(&self, sha: &str) -> Result<Vec<u8>> {
        validate_sha(sha)?;
        self.conn
            .query_row(
                "SELECT bytes FROM browser_objects WHERE sha256 = ?1",
                [sha],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| not_found(sha))
    }
    pub fn put_object(&self, bytes: &[u8]) -> Result<String> {
        let sha = sha256_hex(bytes);
        self.conn.execute(
            "INSERT INTO browser_objects (sha256, bytes) VALUES (?1, ?2)
             ON CONFLICT (sha256) DO NOTHING",
            params![sha, bytes],
        )?;
        Ok(sha)
    }
}

impl Notebook {
    pub fn stage_snapshot(
        &mut self,
        doc: &ExtractedDocument,
        sha256: &str,
        resources: &[(String, String, String)],
    ) -> Result<StagedSnapshot> {
        validate_sha(sha256)?;
        let tx = self.conn.transaction()?;
        if let Some(id) = tx
            .query_row(
                "SELECT id
                 FROM snapshots
                 WHERE sha256 = ?1",
                [sha256],
                |r| r.get(0),
            )
            .optional()?
        {
            return Ok(StagedSnapshot { id, existing: true });
        }
        let id = crate::notebook::new_ulid().to_string();
        let length: usize = doc
            .passages
            .iter()
            .map(|p| p.text.encode_utf16().count())
            .sum();
        tx.execute(
            "INSERT INTO snapshots
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                sha256,
                name(&doc.format),
                doc.media_type,
                json(&doc.metadata),
                json(&doc.toc),
                doc.passages.len() as i64,
                length as i64,
                crate::notebook::now_ms()
            ],
        )?;
        let mut start = 0i64;
        {
            let mut insert = tx.prepare(
                "INSERT INTO passages(
                     id, snapshot_id, ordinal, kind, level, text,
                     locator, anchor, resource, marks, start
                 )
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )?;
            for (ordinal, p) in doc.passages.iter().enumerate() {
                insert.execute(params![
                    crate::notebook::new_ulid().to_string(),
                    id,
                    ordinal as i64,
                    name(&p.kind),
                    p.level,
                    p.text,
                    p.locator,
                    p.anchor,
                    p.resource,
                    json(&p.marks),
                    start
                ])?;
                start += p.text.encode_utf16().count() as i64;
            }
        }
        for (href, sha, media_type) in resources {
            validate_sha(sha)?;
            tx.execute(
                "INSERT INTO snapshot_resources
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, href, sha, media_type],
            )?;
        }
        tx.commit()?;
        Ok(StagedSnapshot {
            id,
            existing: false,
        })
    }
    pub fn snapshot_resource(&self, snapshot: &str, href: &str) -> Result<(String, String)> {
        self.conn
            .query_row(
                "SELECT sha256, media_type
                 FROM snapshot_resources
                 WHERE snapshot_id = ?1 AND href = ?2",
                params![snapshot, href],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| not_found(href))
    }
}

macro_rules! source_columns {
    () => {
        "s.block_id, s.format, s.state, s.origin, s.match_key, s.citation_key,
         s.added_at, s.state_changed_at, s.last_read_at,
         (SELECT snapshot_id
          FROM source_snapshots a
          WHERE a.source_id = s.block_id
          ORDER BY a.change_seq DESC, a.rowid DESC
          LIMIT 1)"
    };
}
pub(crate) use source_columns;
pub(crate) fn source_siglum(
    source: &mut SourceRecord,
    title: &str,
    fields: &crate::library_export::FieldReadings,
) {
    let first = |name: &str| {
        fields
            .get(name)
            .and_then(|values| values.first())
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
    };
    source.siglum_authored = false;
    if let Some(authored) = first("siglum")
        && authored.chars().count() <= 4
        && authored.chars().all(char::is_alphabetic)
    {
        source.siglum = authored.to_uppercase();
        source.siglum_basis = source.siglum.clone();
        source.siglum_authored = true;
        return;
    }
    for candidate in first("author")
        .map(crate::library_ingest::family_name)
        .into_iter()
        .chain(first("editor").map(crate::library_ingest::family_name))
        .chain(first("site"))
        .chain(
            title
                .split_whitespace()
                .filter(|word| word.chars().any(char::is_alphabetic))
                .take(1),
        )
    {
        let mut basis = String::new();
        let mut siglum_end = 0;
        for (index, letter) in candidate
            .chars()
            .filter(|letter| letter.is_alphabetic())
            .enumerate()
        {
            basis.extend(letter.to_uppercase());
            if index < 3 {
                siglum_end = basis.len();
            }
        }
        if !basis.is_empty() {
            source.siglum = basis[..siglum_end].to_owned();
            source.siglum_basis = basis;
            return;
        }
    }
    source.siglum = "?".into();
    source.siglum_basis = "?".into();
}
pub(crate) fn source_at(row: &rusqlite::Row<'_>) -> rusqlite::Result<SourceRecord> {
    Ok(SourceRecord {
        block_id: row.get(0)?,
        format: enum_at(row, 1)?,
        state: enum_at(row, 2)?,
        origin: row.get(3)?,
        match_key: row.get(4)?,
        citation_key: row.get(5)?,
        added_at: row.get(6)?,
        state_changed_at: row.get(7)?,
        last_read_at: row.get(8)?,
        current_snapshot_id: row.get(9)?,
        siglum: String::new(),
        siglum_basis: String::new(),
        siglum_authored: false,
    })
}
pub(crate) fn source(conn: &Connection, id: &str) -> Result<Option<SourceRecord>> {
    let mut statement = conn.prepare_cached(concat!(
        "SELECT ",
        source_columns!(),
        ", b.text FROM sources s
         JOIN blocks b ON b.id = s.block_id
         WHERE s.block_id = ?1 AND s.active = 1 AND b.deletion_id IS NULL"
    ))?;
    let Some((mut source, title)) = statement
        .query_row([id], |row| Ok((source_at(row)?, row.get::<_, String>(10)?)))
        .optional()?
    else {
        return Ok(None);
    };
    let mut fields =
        crate::library_export::field_readings(conn, std::slice::from_ref(&source.block_id))?;
    source_siglum(&mut source, &title, &fields.remove(id).unwrap_or_default());
    Ok(Some(source))
}

pub(crate) fn apply(conn: &Connection, operation: &Operation, now: i64, seq: i64) -> Result<bool> {
    match operation {
        Operation::SetSource {
            id, source: state, ..
        } => {
            let block = crate::storage::stored(conn, id)?.ok_or_else(|| not_found(id))?;
            if block.block.kind != BlockKind::Page {
                return Err(validation(
                    "A source must be a page, not a journal or outline row.",
                ));
            }
            let current = source(conn, id)?;
            if current.as_ref().map(SourceRecord::source_state).as_ref() == state.as_ref() {
                return Ok(false);
            }
            let Some(state) = state else {
                conn.execute(
                    "UPDATE sources
                     SET active = 0
                     WHERE block_id = ?1",
                    [id],
                )?;
                return Ok(true);
            };
            if let Some(key) = &state.citation_key {
                if key.is_empty()
                    || key.len() > 64
                    || !key.as_bytes()[0].is_ascii_alphabetic()
                    || !key
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_:-".contains(&b))
                {
                    return Err(validation(concat!(
                        "Citation keys must start with a letter and contain at most 64 ",
                        "letters, digits, underscores, colons or hyphens."
                    )));
                }
                let taken: bool = conn.query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM sources
                         WHERE active = 1 AND citation_key = ?1 COLLATE NOCASE AND block_id <> ?2
                     )",
                    params![key, id],
                    |r| r.get(0),
                )?;
                if taken {
                    return Err(validation(
                        "That citation key is already assigned to another source.",
                    ));
                }
            }
            conn.execute(
                "INSERT INTO sources(
                     block_id, active, format, state, origin, match_key, citation_key,
                     added_at, state_changed_at
                 )
                 VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(block_id) DO UPDATE
                 SET active = 1, format = excluded.format, state = excluded.state,
                     origin = excluded.origin, match_key = excluded.match_key,
                     citation_key = excluded.citation_key,
                     state_changed_at = CASE WHEN sources.state <> excluded.state
                         THEN excluded.state_changed_at ELSE sources.state_changed_at END",
                params![
                    id,
                    name(&state.format),
                    name(&state.state),
                    state.origin,
                    state.match_key,
                    state.citation_key,
                    now
                ],
            )?;
            Ok(true)
        }
        Operation::AttachSnapshot {
            id, snapshot_id, ..
        } => {
            if source(conn, id)?.is_none() {
                return Err(validation("The page has no active source capability."));
            }
            if !conn.query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM snapshots
                     WHERE id = ?1
                 )",
                [snapshot_id],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(validation("The snapshot has not been staged."));
            }
            if conn.query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM source_snapshots
                     WHERE source_id = ?1 AND snapshot_id = ?2
                 )",
                params![id, snapshot_id],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(validation(
                    "The snapshot is already attached to this source.",
                ));
            }
            conn.execute(
                "INSERT INTO source_snapshots
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, snapshot_id, now, seq],
            )?;
            Ok(true)
        }
        Operation::Cite {
            id,
            citation_id,
            snapshot_id,
            start,
            end,
            color,
            ..
        } => {
            validate_id(citation_id)?;
            validate_color(color.as_deref())?;
            let first = crate::library_reads::passage(conn, &start.passage_id)?;
            let last = crate::library_reads::passage(conn, &end.passage_id)?;
            let count: i64 = conn.query_row(
                "SELECT COUNT(*)
                 FROM passages
                 WHERE snapshot_id = ?1 AND id IN (?2, ?3)",
                params![snapshot_id, start.passage_id, end.passage_id],
                |r| r.get(0),
            )?;
            let expected = if start.passage_id == end.passage_id {
                1
            } else {
                2
            };
            if count != expected
                || (first.ordinal, start.offset) >= (last.ordinal, end.offset)
                || start.offset as usize > first.text.encode_utf16().count()
                || end.offset as usize > last.text.encode_utf16().count()
            {
                return Err(validation(
                    "Citation endpoints must form a non-empty, ordered range inside one snapshot.",
                ));
            }
            // Never create evidence without a source identity to navigate to.
            if !conn.query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM source_snapshots
                     WHERE snapshot_id = ?1
                 )",
                [snapshot_id],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(validation("A citation needs an attached snapshot."));
            }
            let prior: Option<(String, bool, String, String, u32, String, u32)> = conn
                .query_row(
                    "SELECT block_id, active, snapshot_id,
                            start_passage, start_offset, end_passage, end_offset
                     FROM citations
                     WHERE id = ?1",
                    [citation_id],
                    |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                        ))
                    },
                )
                .optional()?;
            if let Some((block, active, snapshot, sp, so, ep, eo)) = prior {
                if active
                    || block != *id
                    || snapshot != *snapshot_id
                    || sp != start.passage_id
                    || so != start.offset
                    || ep != end.passage_id
                    || eo != end.offset
                {
                    return Err(validation(
                        "This citation ID is already used for different evidence.",
                    ));
                }
                conn.execute(
                    "UPDATE citations
                     SET active = 1, color = ?2
                     WHERE id = ?1",
                    params![citation_id, color],
                )?;
            } else {
                conn.execute(
                    "INSERT INTO citations(
                         id, block_id, active, snapshot_id, start_passage, start_offset,
                         end_passage, end_offset, created_seq, color
                     ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        citation_id,
                        id,
                        snapshot_id,
                        start.passage_id,
                        start.offset,
                        end.passage_id,
                        end.offset,
                        seq,
                        color
                    ],
                )?;
            }
            Ok(true)
        }
        Operation::Uncite {
            id, citation_id, ..
        } => {
            let belongs: Option<(String, bool)> = conn
                .query_row(
                    "SELECT block_id, active
                     FROM citations
                     WHERE id = ?1",
                    [citation_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            match belongs {
                Some((block, active)) if block == *id => {
                    if active {
                        conn.execute(
                            "UPDATE citations
                             SET active = 0
                             WHERE id = ?1",
                            [citation_id],
                        )?;
                    }
                    Ok(active)
                }
                _ => Err(validation("The citation does not belong to this block.")),
            }
        }
        Operation::SetCitationTriage { id, triage, .. } => {
            if triage
                .as_deref()
                .is_some_and(|value| !matches!(value, "processed" | "unprocessed"))
            {
                return Err(validation(
                    "Citation triage must be processed or unprocessed.",
                ));
            }
            Ok(conn.execute(
                "UPDATE citations SET triage = ?2
                 WHERE id = ?1 AND active = 1 AND triage IS NOT ?2",
                params![id, triage],
            )? > 0)
        }
        Operation::SetCitationRange { id, start, end, .. } => {
            let snapshot: String = conn.query_row(
                "SELECT snapshot_id FROM citations WHERE id = ?1 AND active = 1",
                [id],
                |r| r.get(0),
            )?;
            let first = crate::library_reads::passage(conn, &start.passage_id)?;
            let last = crate::library_reads::passage(conn, &end.passage_id)?;
            let valid: bool = conn.query_row(
                "SELECT COUNT(*) = CASE WHEN ?2 = ?3 THEN 1 ELSE 2 END
                 FROM passages WHERE snapshot_id = ?1 AND id IN (?2, ?3)",
                params![snapshot, start.passage_id, end.passage_id],
                |r| r.get(0),
            )?;
            if !valid
                || (first.ordinal, start.offset) >= (last.ordinal, end.offset)
                || start.offset as usize > first.text.encode_utf16().count()
                || end.offset as usize > last.text.encode_utf16().count()
            {
                return Err(validation(
                    "Citation endpoints must form a non-empty, ordered range inside one snapshot.",
                ));
            }
            Ok(conn.execute(
                "UPDATE citations SET start_passage = ?2, start_offset = ?3, end_passage = ?4, end_offset = ?5
                 WHERE id = ?1 AND (start_passage != ?2 OR start_offset != ?3 OR end_passage != ?4 OR end_offset != ?5)",
                params![id, start.passage_id, start.offset, end.passage_id, end.offset],
            )? > 0)
        }
        Operation::SetCitationColor { id, color, .. } => {
            validate_color(color.as_deref())?;
            Ok(conn.execute(
                "UPDATE citations SET color = ?2
                 WHERE id = ?1 AND active = 1 AND color IS NOT ?2",
                params![id, color],
            )? > 0)
        }
        _ => Err(validation("Not a library operation.")),
    }
}

pub(crate) fn validate_color(color: Option<&str>) -> Result<()> {
    if color.is_some_and(|value| !matches!(value, "yellow" | "green" | "blue" | "red" | "purple")) {
        return Err(validation(
            "Citation colour must be yellow, green, blue, red or purple.",
        ));
    }
    Ok(())
}
