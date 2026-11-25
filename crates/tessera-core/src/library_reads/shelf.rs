use super::*;

impl Workshop {
    pub fn highlights(&self, query: &HighlightQuery) -> Result<HighlightResult> {
        self.highlight_rows(query, None)
    }
    pub(crate) fn highlight_rows(
        &self,
        query: &HighlightQuery,
        ids: Option<&[String]>,
    ) -> Result<HighlightResult> {
        for color in &query.colors {
            if color != "none" {
                crate::library_store::validate_color(Some(color))?;
            }
        }
        let tags: Vec<_> = query
            .tags
            .iter()
            .map(|tag| crate::storage::title_key(tag))
            .collect();
        let citations = citations(&self.conn, ids, None, true, None)?;
        let ids_json = ids.map(json);
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT ",
            block_columns!("b"),
            ", ",
            block_columns!("p"),
            ", (SELECT COUNT(*) FROM blocks child
                 WHERE child.parent_id = b.id AND child.deletion_id IS NULL AND child.archived = 0
                 AND TRIM(child.text, char(9) || char(10) || char(11) || char(12) || char(13) || ' ') <> ''
             ), EXISTS(
                 SELECT 1 FROM card_units card
                 WHERE card.source_block_id = b.id AND card.active = 1
             ) OR EXISTS(
                 SELECT 1 FROM links l
                 JOIN blocks incoming ON incoming.id = l.source_id
                 WHERE l.target_id = b.id AND incoming.deletion_id IS NULL
             ), (SELECT json_group_array(title) FROM (
                 SELECT DISTINCT t.text AS title, t.title_key, t.id FROM memberships m JOIN blocks t ON t.id = m.type_id
                 WHERE m.block_id = b.id AND t.deletion_id IS NULL ORDER BY t.title_key, t.id
             ))
             FROM blocks b
             JOIN blocks p ON p.id = b.page_id
             WHERE b.deletion_id IS NULL AND b.id NOT IN (SELECT id FROM hidden)
             AND EXISTS(SELECT 1 FROM citations c WHERE c.block_id = b.id AND c.active = 1)
             AND NOT EXISTS(
                 SELECT 1 FROM json_each(?1) wanted
                 WHERE NOT EXISTS(
                     SELECT 1 FROM memberships m JOIN blocks t ON t.id = m.type_id
                     WHERE m.block_id = b.id AND t.title_key = wanted.value AND t.deletion_id IS NULL
                 )
             )
             AND (?2 IS NULL OR b.id IN (SELECT value FROM json_each(?2)))"
        ))?;
        let mut blocks: HashMap<String, (BlockInPage, u32, bool, Vec<String>)> = statement
            .query_map(params![json(&tags), ids_json.as_deref()], |r| {
                let block = block_at(r, 0)?;
                Ok((
                    block.id.clone(),
                    (
                        BlockInPage {
                            block,
                            page: block_at(r, 10)?,
                        },
                        r.get(20)?,
                        r.get(21)?,
                        json_at(r, 22)?,
                    ),
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut statement = self.conn.prepare_cached(
            "SELECT id, text
             FROM blocks
             WHERE kind = 'page' AND (?1 IS NULL OR id IN (
                 SELECT a.source_id FROM source_snapshots a JOIN citations c ON c.snapshot_id = a.snapshot_id
                 WHERE c.block_id IN (SELECT value FROM json_each(?1))
             ))",
        )?;
        let titles: HashMap<String, String> = statement
            .query_map([ids_json.as_deref()], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut statement = self.conn.prepare_cached(
            "SELECT c.id, changes.created_at
             FROM citations c JOIN changes ON changes.seq = c.created_seq
             WHERE c.active = 1 AND (?1 IS NULL OR c.block_id IN (SELECT value FROM json_each(?1)))",
        )?;
        let created: HashMap<String, i64> = statement
            .query_map([ids_json.as_deref()], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut rows = vec![];
        // Newest first; the helper returns creation order.
        for citation in citations.into_iter().rev() {
            if query
                .source_id
                .as_ref()
                .is_some_and(|id| *id != citation.source_id)
            {
                continue;
            }
            if !query.colors.is_empty()
                && !query
                    .colors
                    .iter()
                    .any(|color| match citation.color.as_deref() {
                        Some(value) => value == color,
                        None => color == "none",
                    })
            {
                continue;
            }
            let Some((block, notes, derived, tags)) = blocks.get_mut(&citation.block_id) else {
                continue;
            };
            let processed = citation
                .triage
                .as_deref()
                .map(|value| value == "processed")
                .unwrap_or(*notes > 0 || *derived);
            if query.unprocessed && processed {
                continue;
            }
            rows.push(HighlightRow {
                block: block.clone(),
                source_title: titles.get(&citation.source_id).cloned().unwrap_or_default(),
                triage: citation.triage.clone(),
                color: citation.color.clone(),
                tags: tags.clone(),
                created_at: created[&citation.id],
                citation,
                processed,
                notes: *notes,
            });
        }
        let total = rows.len();
        rows.truncate(query.limit.unwrap_or(100));
        Ok(HighlightResult { rows, total })
    }
    /// Live Collections values, including archived owners/entries/values so
    /// deleting a collection cannot leave hidden memberships as broken links.
    pub fn collection_values(&self, id: &str) -> Result<Vec<crate::Block>> {
        crate::storage::validate_id(id)?;
        let mut statement = self.conn.prepare_cached(concat!(
            "SELECT ",
            block_columns!("v"),
            ", e.text, d.id
             FROM links l JOIN blocks v ON v.id = l.source_id
             JOIN blocks e ON e.id = v.parent_id
             JOIN links el ON el.source_id = e.id AND el.occurrence = 0
             JOIN blocks d ON d.id = el.target_id
             JOIN blocks register ON register.id = d.parent_id
             JOIN fields f ON f.block_id = d.id
             WHERE l.target_id = ?1 AND l.occurrence = 0
             AND v.deletion_id IS NULL AND e.deletion_id IS NULL
             AND d.deletion_id IS NULL AND register.deletion_id IS NULL
             AND register.kind = 'page' AND register.title_key = 'fields'
             AND lower(d.text) = 'collections' AND f.kind = 'instance'
             ORDER BY v.id"
        ))?;
        let rows = statement.query_map([id], |row| {
            Ok((
                block_at(row, 0)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
            ))
        })?;
        let mut values = Vec::new();
        for row in rows {
            let (value, entry, field) = row?;
            if crate::fields::reference(&entry) == Some(field.as_str())
                && crate::fields::reference(&value.text) == Some(id)
            {
                values.push(value);
            }
        }
        Ok(values)
    }

    pub fn library(&self, query: &LibraryQuery) -> Result<LibraryResult> {
        self.library_rows(query, query.limit.unwrap_or(100))
    }
    pub(crate) fn library_rows(&self, query: &LibraryQuery, limit: usize) -> Result<LibraryResult> {
        // Start from links_target, then field_values_value: collection membership
        // narrows the source IDs before loading metadata, snapshots and covers.
        let collection_sources = if let Some(id) = &query.collection_id {
            let mut statement = self.conn.prepare_cached(concat!(
                hidden_blocks!(),
                "SELECT fv.owner_id, v.text FROM links l
                 JOIN field_values fv ON fv.value_id = l.source_id
                 JOIN blocks v ON v.id = fv.value_id
                 JOIN blocks d ON d.id = fv.field_id
                 JOIN fields f ON f.block_id = d.id
                 JOIN blocks c ON c.id = l.target_id
                 WHERE l.target_id = ?1 AND l.occurrence = 0
                 AND lower(d.text) = 'collections' AND f.kind = 'instance'
                 AND d.deletion_id IS NULL AND c.deletion_id IS NULL
                 AND v.id NOT IN (SELECT id FROM hidden)
                 AND d.id NOT IN (SELECT id FROM hidden)"
            ))?;
            let candidates = statement.query_map([id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            let mut owners = Vec::new();
            for candidate in candidates {
                let (owner, text) = candidate?;
                if crate::fields::reference(&text) == Some(id.as_str()) {
                    owners.push(owner);
                }
            }
            Some(json(&owners))
        } else {
            None
        };
        // State tabs remain notebook-wide, even while viewing one collection.
        let mut counts = if query.collection_id.is_some() {
            self.conn
                .prepare_cached(concat!(
                    hidden_blocks!(),
                    "SELECT COUNT(*) FILTER (WHERE s.state = 'inbox'),
                    COUNT(*) FILTER (WHERE s.state = 'reading'),
                    COUNT(*) FILTER (WHERE s.state = 'finished'),
                    COUNT(*) FILTER (WHERE s.state = 'abandoned')
             FROM sources s JOIN blocks b ON b.id = s.block_id
             WHERE s.active = 1 AND b.deletion_id IS NULL
             AND b.id NOT IN (SELECT id FROM hidden)"
                ))?
                .query_row([], |r| {
                    Ok(LibraryCounts {
                        inbox: r.get::<_, i64>(0)? as usize,
                        reading: r.get::<_, i64>(1)? as usize,
                        finished: r.get::<_, i64>(2)? as usize,
                        abandoned: r.get::<_, i64>(3)? as usize,
                    })
                })?
        } else {
            LibraryCounts::default()
        };
        let mut statement = self.conn.prepare_cached(concat!(
            hidden_blocks!(),
            "SELECT ",
            source_columns!(),
            ", ",
            block_columns!("b"),
            " FROM sources s
             JOIN blocks b ON b.id = s.block_id
             WHERE s.active = 1 AND b.deletion_id IS NULL AND b.id NOT IN (SELECT id FROM hidden)
             AND (?1 IS NULL OR b.id IN (SELECT value FROM json_each(?1)))"
        ))?;
        let sources = statement
            .query_map([collection_sources], |r| {
                Ok((source_at(r)?, block_at(r, 10)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let ids: Vec<_> = sources.iter().map(|(s, _)| s.block_id.clone()).collect();
        let mut people_by_source = HashMap::new();
        let mut fields_by_source = crate::library_export::field_readings_with_people(
            &self.conn,
            &ids,
            &mut people_by_source,
        )?;
        let snapshot_ids: Vec<_> = sources
            .iter()
            .filter_map(|(s, _)| s.current_snapshot_id.as_ref())
            .collect();
        let mut statement = self.conn.prepare_cached(
            "SELECT id, format, json_extract(metadata, '$.cover') FROM snapshots
             WHERE id IN (SELECT value FROM json_each(?1))",
        )?;
        let snapshots: HashMap<String, (String, Option<String>)> = statement
            .query_map([json(&snapshot_ids)], |r| {
                Ok((r.get(0)?, (r.get(1)?, r.get(2)?)))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut statement = self.conn.prepare_cached(
            "SELECT s.id, CAST(p.start AS REAL) / s.text_length, rp.passage_ordinal
             FROM snapshots s
             JOIN reading_positions rp ON rp.snapshot_id = s.id
             JOIN passages p ON p.snapshot_id = s.id AND p.ordinal = rp.passage_ordinal
             WHERE s.id IN (SELECT value FROM json_each(?1)) AND s.text_length > 0",
        )?;
        let positions: HashMap<String, (f64, i64)> = statement
            .query_map([json(&snapshot_ids)], |r| {
                Ok((r.get(0)?, (r.get(1)?, r.get(2)?)))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let highlights = self.highlights(&HighlightQuery {
            limit: Some(usize::MAX),
            ..Default::default()
        })?;
        let mut totals: HashMap<String, (usize, usize)> = HashMap::new();
        for h in highlights.rows {
            let n = totals.entry(h.citation.source_id).or_default();
            n.0 += 1;
            n.1 += usize::from(!h.processed);
        }
        let mut rows = vec![];
        let mut linked_people: HashMap<String, PersonFacet> = HashMap::new();
        let mut unlinked_people: HashMap<String, PersonFacet> = HashMap::new();
        let mut decades: HashMap<i32, usize> = HashMap::new();
        let mut years: HashMap<i32, usize> = HashMap::new();
        let mut publishers = HashMap::new();
        let mut languages = HashMap::new();
        let text = query
            .text
            .as_ref()
            .map(|s| crate::aliases::fold(s))
            .filter(|s| !s.is_empty());
        let query_languages: Vec<_> = query
            .languages
            .iter()
            .map(|value| normalize_language_name(value).to_owned())
            .collect();
        for (mut source, page) in sources {
            if query.collection_id.is_none() {
                match source.state {
                    ReadingState::Inbox => counts.inbox += 1,
                    ReadingState::Reading => counts.reading += 1,
                    ReadingState::Finished => counts.finished += 1,
                    ReadingState::Abandoned => counts.abandoned += 1,
                }
            }
            if !query.states.is_empty() && !query.states.contains(&source.state)
                || query.format.is_some_and(|f| f != source.format)
            {
                continue;
            }
            let fields = fields_by_source
                .remove(&source.block_id)
                .unwrap_or_default();
            source_siglum(&mut source, &page.text, &fields);
            let creators = crate::library_export::creators(&fields).to_vec();
            if let Some(text) = &text
                && !crate::aliases::fold(&page.text).contains(text.as_str())
                && !creators
                    .iter()
                    .any(|s| crate::aliases::fold(s).contains(text.as_str()))
            {
                continue;
            }
            let people = people_by_source
                .remove(&source.block_id)
                .unwrap_or_default();
            let published = fields.get("published").and_then(|values| values.first());
            let publisher = fields.get("publisher").and_then(|values| values.first());
            let language = fields
                .get("language")
                .and_then(|values| values.first())
                .map(|value| language_code(value));
            let year = publication_year(published.map(String::as_str));
            let decade = publication_decade(published.map(String::as_str));
            for (index, person) in people.iter().enumerate() {
                if people[..index].iter().any(|previous| match &person.id {
                    Some(id) => previous.id.as_ref() == Some(id),
                    None => previous.id.is_none() && previous.name == person.name,
                }) {
                    continue;
                }
                let (counts, key) = match &person.id {
                    Some(id) => (&mut linked_people, id),
                    None => (&mut unlinked_people, &person.name),
                };
                if let Some(facet) = counts.get_mut(key) {
                    facet.count += 1;
                } else {
                    counts.insert(
                        key.clone(),
                        PersonFacet {
                            id: person.id.clone(),
                            name: person.name.clone(),
                            count: 1,
                        },
                    );
                }
            }
            if let Some(decade) = decade {
                *decades.entry(decade).or_default() += 1;
            }
            if let Some(year) = year {
                *years.entry(year).or_default() += 1;
            }
            count_value(&mut publishers, publisher.map(String::as_str));
            count_value(&mut languages, language.as_deref());
            if (!query.people.is_empty()
                && !people.iter().any(|person| {
                    person
                        .id
                        .as_ref()
                        .is_some_and(|id| query.people.contains(id))
                }))
                || (!query.publishers.is_empty()
                    && !publisher.is_some_and(|value| query.publishers.contains(value)))
                || (!query.decades.is_empty()
                    && !decade.is_some_and(|value| query.decades.contains(&value)))
                || (!query.years.is_empty()
                    && !year.is_some_and(|value| query.years.contains(&value)))
                || (!query.languages.is_empty()
                    && !language
                        .as_ref()
                        .is_some_and(|value| query_languages.contains(value)))
            {
                continue;
            }
            let progress = source
                .current_snapshot_id
                .as_ref()
                .and_then(|id| positions.get(id))
                .map_or(0.0, |(progress, _)| *progress);
            let (highlights, unprocessed) = totals.remove(&source.block_id).unwrap_or_default();
            let snapshot = source
                .current_snapshot_id
                .as_ref()
                .and_then(|id| snapshots.get(id));
            let cover = fields
                .get("cover")
                .and_then(|values| values.first())
                .cloned()
                .or_else(|| snapshot.and_then(|(_, cover)| cover.clone()));
            rows.push(LibraryRow {
                page,
                source,
                creators,
                people,
                publisher: publisher.cloned(),
                language,
                published: published.cloned(),
                site: fields.get("site").and_then(|v| v.first()).cloned(),
                form: fields.get("form").and_then(|v| v.first()).cloned(),
                cover,
                snapshot_format: snapshot.map(|(format, _)| format.clone()),
                progress,
                section: None,
                highlights,
                unprocessed,
            });
        }
        let mut people: Vec<_> = linked_people
            .into_values()
            .chain(unlinked_people.into_values())
            .collect();
        people.sort_by_cached_key(|facet| {
            (
                std::cmp::Reverse(facet.count),
                crate::library_ingest::family_name(&facet.name).to_lowercase(),
                facet.name.clone(),
                facet.id.clone(),
            )
        });
        let mut decades: Vec<_> = decades
            .into_iter()
            .map(|(decade, count)| DecadeFacet { decade, count })
            .collect();
        decades.sort_unstable_by_key(|facet| std::cmp::Reverse(facet.decade));
        let mut years: Vec<_> = years
            .into_iter()
            .map(|(year, count)| YearFacet { year, count })
            .collect();
        years.sort_unstable_by_key(|facet| std::cmp::Reverse(facet.year));
        let facets = LibraryFacets {
            people,
            decades,
            years,
            publishers: value_facets(publishers),
            languages: value_facets(languages),
        };
        if query.sort == LibrarySort::Title {
            rows.sort_by_cached_key(|row| {
                (crate::aliases::fold(&row.page.text), row.page.id.clone())
            });
            if query.direction == Direction::Desc {
                rows.reverse();
            }
        } else {
            rows.sort_by(|a, b| {
                let cmp = match query.sort {
                    LibrarySort::Added => a.source.added_at.cmp(&b.source.added_at),
                    LibrarySort::Title => unreachable!("title sort keys are cached"),
                    LibrarySort::Author => a
                        .creators
                        .first()
                        .map(|s| crate::library_ingest::family_name(s))
                        .into_iter()
                        .flat_map(str::chars)
                        .flat_map(char::to_lowercase)
                        .cmp(
                            b.creators
                                .first()
                                .map(|s| crate::library_ingest::family_name(s))
                                .into_iter()
                                .flat_map(str::chars)
                                .flat_map(char::to_lowercase),
                        ),
                    LibrarySort::Year => a
                        .published
                        .as_deref()
                        .and_then(|s| s.get(..4))
                        .cmp(&b.published.as_deref().and_then(|s| s.get(..4))),
                    LibrarySort::LastRead => a.source.last_read_at.cmp(&b.source.last_read_at),
                    LibrarySort::Progress => a.progress.total_cmp(&b.progress),
                }
                .then_with(|| a.page.id.cmp(&b.page.id));
                if query.direction == Direction::Desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            });
        }
        let total = rows.len();
        rows.truncate(limit);
        // The innermost contents entry at or before the reading position.
        for row in &mut rows {
            if let Some((snapshot, (_, ordinal))) = row
                .source
                .current_snapshot_id
                .as_ref()
                .and_then(|id| positions.get(id).map(|position| (id, position)))
            {
                row.section = toc(&self.conn, snapshot)?
                    .into_iter()
                    .filter(|entry| entry.ordinal.is_some_and(|start| start <= *ordinal))
                    .max_by_key(|entry| entry.ordinal)
                    .map(|entry| entry.title);
            }
        }
        Ok(LibraryResult {
            rows,
            total,
            counts,
            facets,
        })
    }
}
