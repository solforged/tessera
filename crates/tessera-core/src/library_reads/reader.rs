use super::*;

impl Workshop {
    pub fn source(&self, id: &str) -> Result<SourceView> {
        let page = self.block(id)?;
        let source = source(&self.conn, id)?.ok_or_else(|| not_found_as("source", id))?;
        let mut statement = self.conn.prepare_cached(
            "SELECT s.id, s.sha256, s.format, s.media_type, s.metadata,
                    s.passage_count, s.text_length, a.attached_at, a.change_seq
             FROM source_snapshots a
             JOIN snapshots s ON s.id = a.snapshot_id
             WHERE a.source_id = ?1
             ORDER BY a.change_seq DESC, a.rowid DESC",
        )?;
        let snapshots = statement
            .query_map([id], |r| {
                Ok(SnapshotSummary {
                    id: r.get(0)?,
                    sha256: r.get(1)?,
                    format: enum_at(r, 2)?,
                    media_type: r.get(3)?,
                    metadata: json_at(r, 4)?,
                    passage_count: r.get(5)?,
                    text_length: r.get(6)?,
                    attached_at: r.get(7)?,
                    change_seq: r.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let (toc, pos, progress) = if let Some(snapshot) = &source.current_snapshot_id {
            (
                toc(&self.conn, snapshot)?,
                position(&self.conn, snapshot)?,
                progress(&self.conn, snapshot)?,
            )
        } else {
            (vec![], None, 0.0)
        };
        Ok(SourceView {
            source,
            page,
            snapshots,
            toc,
            position: pos,
            progress,
        })
    }
    pub fn passage(&self, id: &str) -> Result<Passage> {
        passage(&self.conn, id)
    }
    pub fn passages(&self, snapshot: &str, from: i64, limit: usize) -> Result<PassagePage> {
        if from < 0 || limit > 500 {
            return Err(validation(
                "Passages require a nonnegative ordinal and a limit of at most 500.",
            ));
        }
        let total = self
            .conn
            .query_row(
                "SELECT passage_count
                 FROM snapshots
                 WHERE id = ?1",
                [snapshot],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| not_found_as("snapshot", snapshot))?;
        let mut statement = self.conn.prepare_cached(concat!(
            "SELECT ",
            passage_columns!(),
            " FROM passages p
             WHERE p.snapshot_id = ?1 AND p.ordinal >= ?2
             ORDER BY p.ordinal
             LIMIT ?3"
        ))?;
        let passages = statement
            .query_map(params![snapshot, from, limit as i64], |r| passage_at(r, 0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let citations = if passages.is_empty() {
            vec![]
        } else {
            citations(
                &self.conn,
                None,
                Some(snapshot),
                true,
                Some((from, from + passages.len() as i64)),
            )?
        };
        Ok(PassagePage {
            passages,
            citations,
            total,
            toc: toc(&self.conn, snapshot)?,
        })
    }
    /// The ordinal of the passage with this ID, locator or element anchor.
    pub fn locate(&self, snapshot: &str, at: &str) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row(
                "SELECT ordinal
                 FROM passages
                 WHERE snapshot_id = ?1 AND (id = ?2 OR locator = ?2 OR anchor = ?2)
                 ORDER BY ordinal
                 LIMIT 1",
                params![snapshot, at],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn search_passages(
        &self,
        q: &str,
        source_id: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<PassageHit>> {
        let query = fts_query(q);
        if query.is_empty() {
            return Ok(vec![]);
        }
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT s.block_id, b.text, p.snapshot_id, ",
            passage_columns!(),
            ", snippet(passages_fts, 0, ?5, ?6, ' … ', 24)
             FROM passages_fts
             JOIN passages p ON p.rowid = passages_fts.rowid
             JOIN source_snapshots a ON a.snapshot_id = p.snapshot_id
             JOIN sources s ON s.block_id = a.source_id
             JOIN blocks b ON b.id = s.block_id
             WHERE passages_fts MATCH ?1 AND s.active = 1 AND b.deletion_id IS NULL
             AND b.id NOT IN (SELECT id FROM hidden)
             AND ((?2 IS NOT NULL AND s.block_id = ?2) OR (?2 IS NULL AND a.snapshot_id = (
                 SELECT snapshot_id
                 FROM source_snapshots newest
                 WHERE newest.source_id = s.block_id
                 ORDER BY newest.change_seq DESC, newest.rowid DESC
                 LIMIT 1
             )))
             ORDER BY rank, p.ordinal, s.block_id, p.snapshot_id, p.id
             LIMIT ?3 OFFSET ?4"
        ))?;
        // Choose markers absent from every returned passage, including unusual control characters in source text.
        // Only a collision needs another query; the wire response contains structured text, never these markers.
        let mut start = "\u{1f}".to_owned();
        let mut end = "\u{1e}".to_owned();
        loop {
            let rows = statement
                .query_map(
                    params![
                        query,
                        source_id,
                        limit.min(500) as i64,
                        i64::try_from(offset).unwrap_or(i64::MAX),
                        start,
                        end,
                    ],
                    |r| {
                        Ok((
                            PassageHit {
                                source_id: r.get(0)?,
                                title: r.get(1)?,
                                snapshot_id: r.get(2)?,
                                passage: passage_at(r, 3)?,
                                snippet_parts: Vec::new(),
                            },
                            r.get::<_, String>(13)?,
                        ))
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if rows.iter().any(|(hit, _)| {
                hit.passage.text.contains(start.as_str()) || hit.passage.text.contains(end.as_str())
            }) {
                start.push('\u{1f}');
                end.push('\u{1e}');
                continue;
            }
            return Ok(rows
                .into_iter()
                .map(|(mut hit, marked)| {
                    for (index, part) in marked.split(start.as_str()).enumerate() {
                        if index == 0 {
                            if !part.is_empty() {
                                hit.snippet_parts.push(SnippetPart {
                                    text: part.to_owned(),
                                    r#match: false,
                                });
                            }
                        } else if let Some((matched, rest)) = part.split_once(end.as_str()) {
                            hit.snippet_parts.push(SnippetPart {
                                text: matched.to_owned(),
                                r#match: true,
                            });
                            if !rest.is_empty() {
                                hit.snippet_parts.push(SnippetPart {
                                    text: rest.to_owned(),
                                    r#match: false,
                                });
                            }
                        }
                    }
                    hit
                })
                .collect());
        }
    }
    pub fn set_reading_position(
        &mut self,
        snapshot: &str,
        ordinal: i64,
    ) -> Result<ReadingProgress> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT passage_count
                 FROM snapshots
                 WHERE id = ?1",
                [snapshot],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| not_found_as("snapshot", snapshot))?;
        if ordinal < 0 || ordinal >= count {
            return Err(validation("Reading positions must be inside the snapshot."));
        }
        let id: String = self
            .conn
            .query_row(
                "SELECT a.source_id
                 FROM source_snapshots a
                 JOIN sources s ON s.block_id = a.source_id
                 JOIN blocks b ON b.id = s.block_id
                 WHERE a.snapshot_id = ?1 AND s.active = 1 AND b.deletion_id IS NULL
                 ORDER BY a.change_seq, a.rowid
                 LIMIT 1",
                [snapshot],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| not_found_as("snapshot", snapshot))?;
        let source = source(&self.conn, &id)?.ok_or_else(|| not_found_as("source", &id))?;
        let seq = if source.state == ReadingState::Inbox {
            let mut state = source.source_state();
            state.state = ReadingState::Reading;
            Some(
                self.apply(&Batch {
                    actor: Actor::Client {
                        name: "reader".into(),
                    },
                    reason: None,
                    idempotency_key: None,
                    operations: vec![Operation::SetSource {
                        id: id.clone(),
                        base_revision: self.block(&id)?.revision,
                        source: Some(state),
                    }],
                })?
                .seq,
            )
        } else {
            None
        };
        let now = crate::notebook::now_ms();
        let tx = self.conn.transaction()?;
        let stamp = crate::unlogged::stamp(&tx, now)?;
        tx.execute(
            "INSERT INTO reading_positions (snapshot_id, passage_ordinal, updated_at, hlc, device, sync_seq)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(snapshot_id) DO UPDATE
             SET passage_ordinal = excluded.passage_ordinal, updated_at = excluded.updated_at,
                 hlc = excluded.hlc, device = excluded.device, sync_seq = excluded.sync_seq",
            params![snapshot, ordinal, now, stamp.hlc, stamp.device, stamp.seq],
        )?;
        tx.execute(
            "UPDATE sources
             SET last_read_at = ?1
             WHERE block_id = ?2",
            params![now, id],
        )?;
        tx.commit()?;
        Ok(ReadingProgress {
            position: ReadingPosition {
                snapshot_id: snapshot.into(),
                passage_ordinal: ordinal,
                updated_at: now,
            },
            progress: progress(&self.conn, snapshot)?,
            state_changed: seq.is_some(),
            seq,
        })
    }
}
