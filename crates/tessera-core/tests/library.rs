use tessera_core::{
    Actor, Batch, Direction, Error, FieldKind, Notebook, Operation, Query, Reading, ReadingValue,
    library::*,
};
fn id() -> String {
    ulid::Ulid::generate().to_string()
}
fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    }
}
fn apply(n: &mut Notebook, ops: Vec<Operation>) -> tessera_core::Committed {
    n.apply(&batch(ops)).unwrap()
}
fn document() -> ExtractedDocument {
    ExtractedDocument {
        format: SourceFormat::Epub,
        media_type: "application/epub+zip".into(),
        metadata: ExtractedMetadata {
            title: Some("The Evidence & Meaning".into()),
            creators: vec![
                ExtractedCreator {
                    name: "García, Ana".into(),
                    role: CreatorRole::Author,
                },
                ExtractedCreator {
                    name: "John Smith".into(),
                    role: CreatorRole::Author,
                },
                ExtractedCreator {
                    name: "Lee, Pat".into(),
                    role: CreatorRole::Translator,
                },
            ],
            published: Some("2020-04".into()),
            publisher: Some("Original Press".into()),
            language: Some("en".into()),
            identifiers: vec!["9780262033848".into(), "unrecognized:foo".into()],
            unique_id: Some("urn:book:one".into()),
            ..Default::default()
        },
        toc: vec![TocEntry {
            title: "Opening".into(),
            locator: "chapter#first".into(),
            level: 1,
            ordinal: None,
        }],
        passages: vec![
            ExtractedPassage {
                kind: PassageKind::Paragraph,
                level: None,
                text: "First 🦉 evidence".into(),
                locator: "chapter#first".into(),
                anchor: Some("first".into()),
                resource: None,
                marks: vec![],
            },
            ExtractedPassage {
                kind: PassageKind::Paragraph,
                level: None,
                text: "Second evidence".into(),
                locator: "chapter#second".into(),
                anchor: Some("second".into()),
                resource: None,
                marks: vec![],
            },
        ],
        resources: vec![],
    }
}
fn stage(n: &mut Notebook, doc: &ExtractedDocument, bytes: &[u8]) -> String {
    let hash = n.put_object(bytes).unwrap();
    n.stage_snapshot(doc, &hash, &[]).unwrap().id
}
fn ingest(n: &mut Notebook, doc: &ExtractedDocument, bytes: &[u8]) -> (String, String) {
    let snapshot = stage(n, doc, bytes);
    let plan = n
        .plan_ingest(&snapshot, None, Some("evidence.epub"))
        .unwrap();
    let source = plan.source_id.clone();
    if !plan.unchanged {
        apply(n, plan.operations);
    }
    (source, snapshot)
}
fn query(n: &Notebook) -> tessera_core::QueryResult {
    let author = n
        .fields()
        .unwrap()
        .fields
        .into_iter()
        .find(|field| field.definition.name == "Author")
        .unwrap()
        .definition
        .id;
    n.query(&Query {
        r#type: None,
        text: None,
        filters: vec![tessera_core::Filter {
            field: author,
            op: tessera_core::FilterOp::Present,
            value: None,
        }],
        sort: vec![],
        limit: Some(2000),
    })
    .unwrap()
}
fn field(n: &Notebook, source: &str, name: &str) -> Vec<tessera_core::FieldValue> {
    let result = query(n);
    let field = &result.fields.iter().find(|f| f.name == name).unwrap().id;
    result
        .rows
        .iter()
        .find(|r| r.block.block.id == source)
        .unwrap()
        .values
        .get(field)
        .cloned()
        .unwrap_or_default()
}
fn edit(n: &mut Notebook, id: &str, text: &str) {
    let rev = n.block(id).unwrap().revision;
    apply(
        n,
        vec![Operation::EditText {
            id: id.into(),
            base_revision: rev,
            text: text.into(),
        }],
    );
}
fn note(n: &mut Notebook, page: &str, text: &str) -> String {
    let id = id();
    apply(
        n,
        vec![Operation::Insert {
            id: id.clone(),
            parent_id: page.into(),
            after: None,
            text: text.into(),
            heading: None,
        }],
    );
    id
}
fn cite(n: &mut Notebook, block: &str, snapshot: &str) -> String {
    let passages = n.passages(snapshot, 0, 500).unwrap().passages;
    let citation = id();
    let rev = n.block(block).unwrap().revision;
    apply(
        n,
        vec![Operation::Cite {
            id: block.into(),
            base_revision: rev,
            citation_id: citation.clone(),
            snapshot_id: snapshot.into(),
            color: None,
            start: PassagePoint {
                passage_id: passages[0].id.clone(),
                offset: 6,
            },
            end: PassagePoint {
                passage_id: passages[1].id.clone(),
                offset: 6,
            },
        }],
    );
    citation
}

fn highlighted_source() -> (tempfile::TempDir, Notebook, Citation) {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let (source, snapshot) = ingest(&mut n, &document(), b"triage");
    let block = note(&mut n, &source, "highlight");
    cite(&mut n, &block, &snapshot);
    let citation = n.capabilities(&block).unwrap().citations.remove(0);
    (dir, n, citation)
}

fn set_triage(
    n: &mut Notebook,
    citation: &Citation,
    triage: Option<&str>,
) -> tessera_core::Committed {
    let base_revision = n.block(&citation.block_id).unwrap().revision;
    apply(
        n,
        vec![Operation::SetCitationTriage {
            id: citation.id.clone(),
            base_revision,
            triage: triage.map(str::to_owned),
        }],
    )
}

#[test]
fn explicit_processed_wins_without_children() {
    let (_dir, mut n, citation) = highlighted_source();
    let receipt = set_triage(&mut n, &citation, Some("processed"));
    let row = n
        .highlights(&HighlightQuery::default())
        .unwrap()
        .rows
        .remove(0);
    assert!(row.processed);
    assert_eq!(row.triage.as_deref(), Some("processed"));
    assert_eq!(receipt.revisions[0].id, citation.block_id);
    assert_eq!(receipt.revisions[0].revision, 3);
    assert_eq!(receipt.capabilities[0].citations[0].id, citation.id);
    assert_eq!(receipt.capabilities[0].citations[0].triage, row.triage);
    let changes = n.changes_since(receipt.seq - 1, 1).unwrap();
    assert_eq!(changes[0].capabilities[0].citations[0].triage, row.triage);
    assert_eq!(
        n.highlights(&HighlightQuery {
            unprocessed: true,
            ..Default::default()
        })
        .unwrap()
        .total,
        0
    );
    assert_eq!(
        n.library(&LibraryQuery::default()).unwrap().rows[0].unprocessed,
        0
    );
}

#[test]
fn explicit_unprocessed_wins_over_a_note() {
    let (_dir, mut n, citation) = highlighted_source();
    note(&mut n, &citation.block_id, "A note");
    set_triage(&mut n, &citation, Some("unprocessed"));
    let result = n
        .highlights(&HighlightQuery {
            source_id: Some(citation.source_id.clone()),
            unprocessed: true,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(result.total, 1);
    assert!(!result.rows[0].processed);
    assert_eq!(result.rows[0].triage.as_deref(), Some("unprocessed"));
    assert_eq!(
        n.highlights(&HighlightQuery {
            source_id: Some(id()),
            ..Default::default()
        })
        .unwrap()
        .total,
        0
    );
}

#[test]
fn null_triage_falls_back_to_derived_processing() {
    let (_dir, mut n, citation) = highlighted_source();
    set_triage(&mut n, &citation, Some("processed"));
    set_triage(&mut n, &citation, None);
    assert!(!n.highlights(&HighlightQuery::default()).unwrap().rows[0].processed);
    note(&mut n, &citation.block_id, "A note");
    set_triage(&mut n, &citation, Some("unprocessed"));
    set_triage(&mut n, &citation, None);
    let row = n
        .highlights(&HighlightQuery::default())
        .unwrap()
        .rows
        .remove(0);
    assert!(row.processed);
    assert_eq!(row.triage, None);
}

#[test]
fn citation_triage_checks_revision_values_and_live_ownership() {
    let (_dir, mut n, citation) = highlighted_source();
    set_triage(&mut n, &citation, Some("processed"));
    assert!(matches!(n.apply(&batch(vec![Operation::SetCitationTriage {
        id: citation.id.clone(), base_revision: 2, triage: None,
    }])), Err(Error::Conflict { id, .. }) if id == citation.block_id));
    assert!(matches!(
        n.apply(&batch(vec![Operation::SetCitationTriage {
            id: citation.id.clone(),
            base_revision: 3,
            triage: Some("other".into()),
        }])),
        Err(Error::Validation { .. })
    ));
    assert_eq!(n.block(&citation.block_id).unwrap().revision, 3);
    assert!(
        set_triage(&mut n, &citation, Some("processed"))
            .revisions
            .is_empty()
    );
    apply(
        &mut n,
        vec![Operation::Uncite {
            id: citation.block_id.clone(),
            base_revision: 3,
            citation_id: citation.id.clone(),
        }],
    );
    assert!(
        n.apply(&batch(vec![Operation::SetCitationTriage {
            id: citation.id,
            base_revision: 4,
            triage: None
        }]))
        .is_err()
    );
}

#[test]
fn highlight_creation_date_uses_citation_change_and_survives_triage() {
    let (dir, mut n, citation) = highlighted_source();
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    conn.execute("UPDATE changes SET created_at = 12345 WHERE seq = (SELECT created_seq FROM citations WHERE id = ?1)", [&citation.id]).unwrap();
    set_triage(&mut n, &citation, Some("processed"));
    edit(&mut n, &citation.block_id, "Edited quote");
    assert_eq!(
        n.highlights(&HighlightQuery::default()).unwrap().rows[0].created_at,
        12345
    );
}

#[test]
fn citation_triage_migration_preserves_existing_evidence() {
    let (dir, n, citation) = highlighted_source();
    drop(n);
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    conn.execute_batch(
        "DROP TABLE positions;
         DROP TABLE highlight_surfacings;
         ALTER TABLE citations DROP COLUMN resurface_muted_at;
         ALTER TABLE citations DROP COLUMN color;
         ALTER TABLE citations DROP COLUMN triage;
         PRAGMA user_version = 12;",
    )
    .unwrap();
    drop(conn);
    let n = Notebook::open(dir.path()).unwrap();
    assert_eq!(
        n.capabilities(&citation.block_id).unwrap().citations,
        vec![citation]
    );
    assert_eq!(
        n.highlights(&HighlightQuery::default()).unwrap().rows[0].triage,
        None
    );
}

fn set_color(
    n: &mut Notebook,
    citation: &Citation,
    color: Option<&str>,
) -> tessera_core::Committed {
    let base_revision = n.block(&citation.block_id).unwrap().revision;
    apply(
        n,
        vec![Operation::SetCitationColor {
            id: citation.id.clone(),
            base_revision,
            color: color.map(str::to_owned),
        }],
    )
}

#[test]
fn citation_color_set_change_clear_receipts_and_inverse_data() {
    let (_dir, mut n, citation) = highlighted_source();
    assert_eq!(citation.color, None);
    let green = set_color(&mut n, &citation, Some("green"));
    assert_eq!(green.revisions[0].id, citation.block_id);
    assert_eq!(green.revisions[0].revision, 3);
    let previous = green.capabilities[0].citations[0].clone();
    assert_eq!(previous.color.as_deref(), Some("green"));
    let blue = set_color(&mut n, &citation, Some("blue"));
    assert_eq!(blue.revisions[0].revision, 4);
    assert_eq!(
        blue.capabilities[0].citations[0].color.as_deref(),
        Some("blue")
    );
    assert_eq!(
        n.changes_since(blue.seq - 1, 1).unwrap()[0].capabilities[0].citations[0]
            .color
            .as_deref(),
        Some("blue")
    );
    let inverse = set_color(&mut n, &citation, previous.color.as_deref());
    assert_eq!(inverse.capabilities[0].citations[0], previous);
    let cleared = set_color(&mut n, &citation, None);
    assert_eq!(cleared.capabilities[0].citations[0].color, None);
    assert!(set_color(&mut n, &citation, None).revisions.is_empty());
}

#[test]
fn citation_color_checks_revision_values_and_live_ownership() {
    let (_dir, mut n, citation) = highlighted_source();
    set_color(&mut n, &citation, Some("yellow"));
    assert!(matches!(n.apply(&batch(vec![Operation::SetCitationColor {
        id: citation.id.clone(), base_revision: 2, color: None,
    }])), Err(Error::Conflict { id, .. }) if id == citation.block_id));
    assert!(matches!(
        n.apply(&batch(vec![Operation::SetCitationColor {
            id: citation.id.clone(),
            base_revision: 3,
            color: Some("orange".into()),
        }])),
        Err(Error::Validation { .. })
    ));
    assert_eq!(n.block(&citation.block_id).unwrap().revision, 3);
    apply(
        &mut n,
        vec![Operation::Uncite {
            id: citation.block_id.clone(),
            base_revision: 3,
            citation_id: citation.id.clone(),
        }],
    );
    assert!(
        n.apply(&batch(vec![Operation::SetCitationColor {
            id: citation.id,
            base_revision: 4,
            color: None,
        }]))
        .is_err()
    );
}

#[test]
fn citation_creation_validates_color_and_defaults_legacy_operations() {
    let (_dir, mut n, citation) = highlighted_source();
    let make = |color| Operation::Cite {
        id: citation.block_id.clone(),
        base_revision: 2,
        citation_id: id(),
        snapshot_id: citation.snapshot_id.clone(),
        start: citation.start.clone(),
        end: citation.end.clone(),
        color,
    };
    assert!(matches!(
        n.apply(&batch(vec![make(Some("orange".into()))])),
        Err(Error::Validation { .. })
    ));
    let mut legacy = serde_json::to_value(make(None)).unwrap();
    legacy.as_object_mut().unwrap().remove("color");
    assert!(matches!(
        serde_json::from_value::<Operation>(legacy).unwrap(),
        Operation::Cite { color: None, .. }
    ));
    let receipt = apply(&mut n, vec![make(Some("purple".into()))]);
    assert_eq!(
        receipt.capabilities[0].citations[1].color.as_deref(),
        Some("purple")
    );
}

#[test]
fn highlight_color_and_tags_survive_text_edits_and_filter_together() {
    let (_dir, mut n, citation) = highlighted_source();
    set_color(&mut n, &citation, Some("green"));
    edit(
        &mut n,
        &citation.block_id,
        "Edited highlight #key #Other #key",
    );
    note(&mut n, &citation.block_id, "Child #child");
    let second = note(&mut n, &citation.source_id, "Another #key");
    cite(&mut n, &second, &citation.snapshot_id);
    let row = n
        .highlights(&HighlightQuery {
            colors: vec!["green".into()],
            ..Default::default()
        })
        .unwrap()
        .rows
        .remove(0);
    assert_eq!(row.color.as_deref(), Some("green"));
    assert_eq!(row.citation.color, row.color);
    assert_eq!(row.citation.quote, citation.quote);
    assert_eq!(row.tags, ["key", "Other"]);
    let query = HighlightQuery {
        colors: vec!["green".into(), "blue".into()],
        tags: vec!["KEY".into(), "other".into()],
        ..Default::default()
    };
    assert_eq!(n.highlights(&query).unwrap().total, 1);
    assert_eq!(
        n.highlights(&HighlightQuery {
            tags: vec!["key".into()],
            ..Default::default()
        })
        .unwrap()
        .total,
        2
    );
    for query in [
        HighlightQuery {
            colors: vec!["red".into()],
            ..Default::default()
        },
        HighlightQuery {
            tags: vec!["child".into()],
            ..Default::default()
        },
        HighlightQuery {
            tags: vec!["key".into(), "missing".into()],
            ..Default::default()
        },
    ] {
        assert_eq!(n.highlights(&query).unwrap().total, 0);
    }
    edit(&mut n, &citation.block_id, "No tags");
    let row = n
        .highlights(&HighlightQuery {
            colors: vec!["green".into()],
            ..Default::default()
        })
        .unwrap()
        .rows
        .remove(0);
    assert!(row.tags.is_empty());
    assert_eq!(row.citation.quote, citation.quote);
}

#[test]
fn citation_color_migration_preserves_existing_evidence_with_null_color() {
    let (dir, n, citation) = highlighted_source();
    drop(n);
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    conn.execute_batch(
        "DROP TABLE positions;
         DROP TABLE highlight_surfacings;
         ALTER TABLE citations DROP COLUMN resurface_muted_at;
         ALTER TABLE citations DROP COLUMN color;
         PRAGMA user_version = 13;",
    )
    .unwrap();
    drop(conn);
    let n = Notebook::open(dir.path()).unwrap();
    assert_eq!(
        n.capabilities(&citation.block_id).unwrap().citations,
        vec![citation]
    );
    assert_eq!(
        n.highlights(&HighlightQuery::default()).unwrap().rows[0].color,
        None
    );
}
#[test]
fn staging_ingestion_fields_and_immutable_objects() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let doc = document();
    let hash = n.put_object(b"book").unwrap();
    let path = n.object_path(&hash).unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    assert_eq!(n.put_object(b"book").unwrap(), hash);
    assert_eq!(
        std::fs::metadata(path).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(n.read_object(&hash).unwrap(), b"book");
    assert!(n.object_path("../bad").is_err());
    let staged = n.stage_snapshot(&doc, &hash, &[]).unwrap();
    assert!(!staged.existing);
    let duplicate = n.stage_snapshot(&doc, &hash, &[]).unwrap();
    assert!(duplicate.existing);
    assert_eq!(duplicate.id, staged.id);
    let plan = n.plan_ingest(&staged.id, None, Some("book.epub")).unwrap();
    assert!(plan.created);
    assert!(n.page_by_title("The Evidence & Meaning").unwrap().is_none());
    let source = plan.source_id.clone();
    let receipt = apply(&mut n, plan.operations);
    let view = n.source(&source).unwrap();
    assert_eq!(
        view.source.citation_key.as_deref(),
        Some("garcia2020evidence")
    );
    assert_eq!(view.source.origin.as_deref(), Some("book.epub"));
    assert_eq!(view.toc[0].title, doc.toc[0].title);
    assert_eq!(view.toc[0].ordinal, Some(0));
    assert!(
        receipt
            .capabilities
            .iter()
            .any(|c| c.source.as_ref().is_some_and(|s| s.block_id == source))
    );
    let authors = field(&n, &source, "Author");
    assert_eq!(authors.len(), 2);
    assert!(
        matches!(&authors[0].reading,Reading::Value{value:ReadingValue::Text(s),target:Some(_),..} if s=="Ana García")
    );
    assert_eq!(
        field(&n, &source, "Identifier")[0].text,
        "isbn:9780262033848"
    );
    assert_eq!(field(&n, &source, "Published")[0].text, "2020-04");
    assert_eq!(field(&n, &source, "Translator").len(), 1);
    let book = n.page_by_title("Book").unwrap().unwrap();
    assert_eq!(n.type_info(&book.id).unwrap().fields.len(), 7);
    assert!(
        n.page(&source)
            .unwrap()
            .capabilities
            .iter()
            .any(|c| c.source.is_some())
    );
    assert!(n.plan_ingest(&staged.id, None, None).unwrap().unchanged);
    assert_eq!(n.locate(&staged.id, "first").unwrap(), Some(0));
    assert_eq!(n.locate(&staged.id, "chapter#second").unwrap(), Some(1));
    assert_eq!(n.passages(&staged.id, 0, 1).unwrap().total, 2);
    assert!(n.passages(&staged.id, 0, 501).is_err());
    let values = n.extracted_values(&source).unwrap();
    assert!(
        values
            .iter()
            .any(|(label, v)| label == "Author" && v[0] == authors[0].text)
    );
}

#[test]
fn epub_toc_ordinals_match_locate_in_each_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let mut doc = document();
    for locator in ["second", "chapter#second", "missing"] {
        doc.toc.push(TocEntry {
            title: locator.into(),
            locator: locator.into(),
            level: 2,
            ordinal: Some(99),
        });
    }
    let (source, snapshot) = ingest(&mut n, &doc, b"toc fixture");
    let page = n.passages(&snapshot, 0, 1).unwrap();
    assert_eq!(page.toc, n.source(&source).unwrap().toc);
    assert_eq!(
        page.toc
            .iter()
            .map(|entry| entry.ordinal)
            .collect::<Vec<_>>(),
        vec![Some(0), Some(1), Some(1), None]
    );
    for entry in &page.toc {
        assert_eq!(entry.ordinal, n.locate(&snapshot, &entry.locator).unwrap());
    }
    doc.passages.swap(0, 1);
    let (_, latest) = ingest(&mut n, &doc, b"reordered toc fixture");
    assert_eq!(n.passages(&snapshot, 0, 1).unwrap().toc, page.toc);
    let current = n.source(&source).unwrap().toc;
    assert_eq!(current, n.passages(&latest, 0, 1).unwrap().toc);
    for entry in current {
        assert_eq!(entry.ordinal, n.locate(&latest, &entry.locator).unwrap());
    }
}
#[test]
fn reingest_updates_only_extracted_values_and_preserves_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let mut doc = document();
    let (source, first) = ingest(&mut n, &doc, b"one");
    let published = field(&n, &source, "Published")[0].id.clone();
    edit(&mut n, &published, "1984");
    n.set_reading_position(&first, 0, (0, 1)).unwrap();
    doc.metadata.published = Some("2024".into());
    doc.metadata.publisher = Some("New Press".into());
    doc.metadata.site = Some("Journal".into());
    let (same, second) = ingest(&mut n, &doc, b"two");
    assert_eq!(same, source);
    assert_ne!(first, second);
    let view = n.source(&source).unwrap();
    assert_eq!(view.snapshots.len(), 2);
    assert_eq!(view.source.state, ReadingState::Reading);
    assert_eq!(view.source.current_snapshot_id, Some(second));
    assert_eq!(field(&n, &source, "Published")[0].text, "1984");
    assert_eq!(field(&n, &source, "Publisher")[0].text, "New Press");
    assert_eq!(field(&n, &source, "Site")[0].text, "Journal");
    assert_eq!(
        view.source.citation_key.as_deref(),
        Some("garcia2020evidence")
    );
    assert!(
        n.plan_ingest(&first, Some(&source), None)
            .unwrap()
            .unchanged
    );
}

#[test]
fn reingest_shorter_list_archives_extracted_surplus() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let mut doc = document();
    let (source, _) = ingest(&mut n, &doc, b"short-before");
    let before = field(&n, &source, "Author");
    doc.metadata.creators = vec![ExtractedCreator {
        name: "New Author".into(),
        role: CreatorRole::Author,
    }];
    ingest(&mut n, &doc, b"short-after");
    let after = field(&n, &source, "Author");
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].id, before[0].id);
    assert_ne!(after[0].text, before[0].text);
    assert!(n.block(&before[1].id).unwrap().archived);
    assert_eq!(n.block(&before[1].id).unwrap().text, before[1].text);
}

#[test]
fn reingest_longer_list_inserts_missing_positions() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let mut doc = document();
    doc.metadata.creators.truncate(1);
    let (source, _) = ingest(&mut n, &doc, b"long-before");
    let before = field(&n, &source, "Author");
    doc.metadata.creators.push(ExtractedCreator {
        name: "Second Author".into(),
        role: CreatorRole::Author,
    });
    doc.metadata.creators.push(ExtractedCreator {
        name: "Third Author".into(),
        role: CreatorRole::Author,
    });
    ingest(&mut n, &doc, b"long-after");
    let after = field(&n, &source, "Author");
    assert_eq!(after.len(), 3);
    assert_eq!(after[0], before[0]);
    let expected = n
        .extracted_values(&source)
        .unwrap()
        .into_iter()
        .find(|(name, _)| name == "Author")
        .unwrap()
        .1;
    assert_eq!(
        after
            .iter()
            .map(|value| value.text.clone())
            .collect::<Vec<_>>(),
        expected
    );
    // Archived surplus does not occupy a position on the next growth.
    doc.metadata.creators.truncate(1);
    ingest(&mut n, &doc, b"long-shrink");
    doc.metadata.creators.push(ExtractedCreator {
        name: "Fourth Author".into(),
        role: CreatorRole::Author,
    });
    ingest(&mut n, &doc, b"long-regrow");
    let regrown = field(&n, &source, "Author");
    assert_eq!(regrown.len(), 2);
    assert_ne!(regrown[1].id, after[1].id);
    assert!(n.block(&after[1].id).unwrap().archived);
    assert!(n.block(&after[2].id).unwrap().archived);
}

#[test]
fn reingest_empty_list_archives_all_extracted_values() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let mut doc = document();
    let (source, _) = ingest(&mut n, &doc, b"empty-before");
    let before = field(&n, &source, "Author");
    doc.metadata.creators.clear();
    ingest(&mut n, &doc, b"empty-after");
    assert!(field(&n, &source, "Author").is_empty());
    for value in before {
        let block = n.block(&value.id).unwrap();
        assert!(block.archived);
        assert_eq!(block.text, value.text);
    }
}

#[test]
fn reingest_authored_override_survives_shrink() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let mut doc = document();
    let (source, _) = ingest(&mut n, &doc, b"authored-before");
    let before = field(&n, &source, "Author");
    edit(&mut n, &before[1].id, "Authored extra");
    doc.metadata.creators.truncate(1);
    ingest(&mut n, &doc, b"authored-shorter");
    assert_eq!(field(&n, &source, "Author")[1].text, "Authored extra");
    doc.metadata.creators.clear();
    ingest(&mut n, &doc, b"authored-empty");
    let after = field(&n, &source, "Author");
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].id, before[1].id);
    assert_eq!(after[0].text, "Authored extra");
    assert!(!n.block(&after[0].id).unwrap().archived);
}

fn define_field(n: &mut Notebook, name: &str, kind: FieldKind) -> String {
    let fields = n.fields().unwrap();
    let field = fields
        .fields
        .into_iter()
        .find(|field| field.definition.name == name)
        .map(|field| field.definition.id)
        .unwrap_or_else(|| note(n, &fields.page_id, name));
    let revision = n.block(&field).unwrap().revision;
    apply(
        n,
        vec![Operation::SetFieldKind {
            id: field.clone(),
            base_revision: revision,
            kind,
        }],
    );
    field
}

#[test]
fn ingest_preserves_existing_author_kind_and_extracted_text() {
    for kind in [FieldKind::Text, FieldKind::Number, FieldKind::Choice] {
        let dir = tempfile::tempdir().unwrap();
        let mut n = Notebook::open(dir.path()).unwrap();
        let definition = define_field(&mut n, "Author", kind);
        let mut doc = document();
        doc.metadata.creators.truncate(1);
        let (source, _) = ingest(&mut n, &doc, b"existing-kind");
        let value = &field(&n, &source, "Author")[0];
        assert_eq!(
            n.fields()
                .unwrap()
                .fields
                .into_iter()
                .find(|field| field.definition.id == definition)
                .unwrap()
                .definition
                .kind,
            kind
        );
        match kind {
            FieldKind::Number => {
                assert_eq!(value.text, "Ana García");
                assert!(matches!(value.reading, Reading::Problem { .. }));
            }
            FieldKind::Text => {
                assert_eq!(value.text, "Ana García");
                assert_eq!(
                    value.reading,
                    Reading::Value {
                        ok: true,
                        value: ReadingValue::Text("Ana García".into()),
                        target: None,
                    }
                );
                assert!(n.page_by_title("Ana García").unwrap().is_none());
            }
            FieldKind::Choice => assert!(matches!(&value.reading,
                Reading::Value { value: ReadingValue::Text(text), target: Some(_), .. } if text == "Ana García")),
            _ => unreachable!(),
        }
        doc.metadata.creators[0].name = "New Author".into();
        ingest(&mut n, &doc, b"existing-kind-again");
        let values = field(&n, &source, "Author");
        let extracted = n
            .extracted_values(&source)
            .unwrap()
            .into_iter()
            .find(|(name, _)| name == "Author")
            .unwrap()
            .1;
        assert_eq!(values[0].text, extracted[0]);
    }
}

#[test]
fn export_field_kind_matrix() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let mut doc = document();
    doc.metadata = ExtractedMetadata {
        title: Some("Kind matrix".into()),
        unique_id: Some("matrix".into()),
        ..Default::default()
    };
    let (source, _) = ingest(&mut n, &doc, b"matrix");
    let mut date_value = String::new();
    for (name, kind, text) in [
        ("Publisher", FieldKind::Text, "Plain Press"),
        ("Language", FieldKind::Number, "001.50"),
        ("Published", FieldKind::Date, "2020"),
        ("Translator", FieldKind::Checkbox, "yes"),
        ("Site", FieldKind::Choice, "Chosen journal"),
        ("Author", FieldKind::Instance, "Ada Reader"),
        ("URL", FieldKind::Url, "https://example.test/matrix"),
        ("Identifier", FieldKind::Identifier, "DOI:10.1234/MATRIX"),
    ] {
        let field = define_field(&mut n, name, kind);
        let text = match kind {
            FieldKind::Instance => {
                let person = id();
                apply(
                    &mut n,
                    vec![Operation::CreatePage {
                        id: person.clone(),
                        title: text.into(),
                    }],
                );
                format!("[[{person}]]")
            }
            FieldKind::Choice => format!("[[{}]]", note(&mut n, &field, text)),
            _ => text.into(),
        };
        let entry = note(&mut n, &source, &format!("[[{field}]]"));
        let value = note(&mut n, &entry, &text);
        if kind == FieldKind::Date {
            date_value = value;
        }
    }
    for (date, parts) in [
        ("2020", vec![2020]),
        ("2020-04", vec![2020, 4]),
        ("2020-04-09", vec![2020, 4, 9]),
    ] {
        edit(&mut n, &date_value, date);
        let bib = n
            .export(std::slice::from_ref(&source), ExportFormat::Bibtex)
            .unwrap();
        let csl: serde_json::Value = serde_json::from_str(
            &n.export(std::slice::from_ref(&source), ExportFormat::CslJson)
                .unwrap(),
        )
        .unwrap();
        for fragment in [
            "publisher = {Plain Press}",
            "language = {001.50}",
            "organization = {Chosen journal}",
            "author = {Reader, Ada}",
            "url = {https://example.test/matrix}",
            "doi = {10.1234/matrix}",
        ] {
            assert!(bib.contains(fragment), "{bib}");
        }
        assert!(bib.contains(&format!("date = {{{date}}}")));
        assert!(!bib.contains("translator"));
        let item = &csl[0];
        assert_eq!(item["publisher"], "Plain Press");
        assert_eq!(item["language"], "001.50");
        assert_eq!(item["container-title"], "Chosen journal");
        assert_eq!(
            item["author"][0],
            serde_json::json!({"family": "Reader", "given": "Ada"})
        );
        assert_eq!(item["URL"], "https://example.test/matrix");
        assert_eq!(item["DOI"], "10.1234/matrix");
        assert_eq!(item["issued"]["date-parts"], serde_json::json!([parts]));
        assert!(item.get("translator").is_none());
    }
}
#[test]
fn collision_titles_and_keys_and_origin_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let mut doc = document();
    let (first, _) = ingest(&mut n, &doc, b"one");
    doc.metadata.unique_id = Some("two".into());
    let (second, _) = ingest(&mut n, &doc, b"two");
    doc.metadata.unique_id = Some("three".into());
    let (third, _) = ingest(&mut n, &doc, b"three");
    assert_eq!(
        n.block(&second).unwrap().text,
        "The Evidence & Meaning (2020)"
    );
    assert_eq!(
        n.block(&third).unwrap().text,
        "The Evidence & Meaning (2020) (2)"
    );
    assert_ne!(first, second);
    assert_eq!(
        n.source(&second).unwrap().source.citation_key.as_deref(),
        Some("garcia2020evidencea")
    );
    assert_eq!(
        n.source(&third).unwrap().source.citation_key.as_deref(),
        Some("garcia2020evidenceb")
    );
    for suffix_index in 3..=27 {
        let unique = format!("collision-{suffix_index}");
        doc.metadata.unique_id = Some(unique.clone());
        let (source, _) = ingest(&mut n, &doc, unique.as_bytes());
        if suffix_index == 26 {
            assert_eq!(
                n.source(&source).unwrap().source.citation_key.as_deref(),
                Some("garcia2020evidencez")
            );
        }
        if suffix_index == 27 {
            assert_eq!(
                n.source(&source).unwrap().source.citation_key.as_deref(),
                Some("garcia2020evidenceaa")
            );
        }
    }
    doc.metadata.title = None;
    doc.metadata.unique_id = Some("four".into());
    let snapshot = stage(&mut n, &doc, b"four");
    let plan = n
        .plan_ingest(&snapshot, None, Some("/tmp/fallback.epub"))
        .unwrap();
    let id = plan.source_id.clone();
    apply(&mut n, plan.operations);
    assert_eq!(n.block(&id).unwrap().text, "fallback");
}
#[test]
fn citation_ranges_reactivation_sidecars_merge_and_visibility() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let doc = document();
    let (source, snapshot) = ingest(&mut n, &doc, b"one");
    let other = stage(&mut n, &doc, b"other");
    let block = note(&mut n, &source, "highlight");
    let passages = n.passages(&snapshot, 0, 10).unwrap().passages;
    let foreign = n.passages(&other, 0, 10).unwrap().passages;
    for (start, end) in [
        (
            PassagePoint {
                passage_id: passages[0].id.clone(),
                offset: 0,
            },
            PassagePoint {
                passage_id: foreign[1].id.clone(),
                offset: 1,
            },
        ),
        (
            PassagePoint {
                passage_id: passages[0].id.clone(),
                offset: 999,
            },
            PassagePoint {
                passage_id: passages[1].id.clone(),
                offset: 1,
            },
        ),
        (
            PassagePoint {
                passage_id: passages[1].id.clone(),
                offset: 0,
            },
            PassagePoint {
                passage_id: passages[0].id.clone(),
                offset: 1,
            },
        ),
        (
            PassagePoint {
                passage_id: passages[0].id.clone(),
                offset: 1,
            },
            PassagePoint {
                passage_id: passages[0].id.clone(),
                offset: 1,
            },
        ),
    ] {
        assert!(matches!(
            n.apply(&batch(vec![Operation::Cite {
                id: block.clone(),
                base_revision: 1,
                citation_id: id(),
                snapshot_id: snapshot.clone(),
                start,
                end,
                color: None,
            }])),
            Err(Error::Validation { .. })
        ));
    }
    let citation_id = cite(&mut n, &block, &snapshot);
    let citation = n.capabilities(&block).unwrap().citations[0].clone();
    assert_eq!(citation.quote, "🦉 evidence\n\nSecond");
    assert_eq!(citation.locator, "chapter#first");
    assert!(!n.capabilities(&block).unwrap().merge_protected);
    let removed = apply(
        &mut n,
        vec![Operation::Uncite {
            id: block.clone(),
            base_revision: 2,
            citation_id: citation_id.clone(),
        }],
    );
    assert!(
        removed
            .capabilities
            .iter()
            .find(|c| c.block_id == block)
            .unwrap()
            .citations
            .is_empty()
    );
    apply(
        &mut n,
        vec![Operation::Cite {
            id: block.clone(),
            base_revision: 3,
            citation_id,
            snapshot_id: snapshot.clone(),
            start: citation.start,
            end: citation.end,
            color: None,
        }],
    );
    let destination = note(&mut n, &source, "destination");
    apply(
        &mut n,
        vec![Operation::Merge {
            source_id: block,
            source_revision: 4,
            destination_id: destination.clone(),
            destination_revision: 1,
        }],
    );
    assert_eq!(n.capabilities(&destination).unwrap().citations.len(), 1);
    assert_eq!(
        n.passages(&snapshot, 1, 1).unwrap().citations[0].block_id,
        destination
    );
    let rev = n.block(&destination).unwrap().revision;
    apply(
        &mut n,
        vec![Operation::SetArchived {
            id: destination,
            base_revision: rev,
            archived: true,
        }],
    );
    assert!(n.passages(&snapshot, 0, 2).unwrap().citations.is_empty());
}
#[test]
fn coverage_changes_state_once_and_library_filters_sort() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let mut doc = document();
    doc.metadata.cover = Some("images/cover.jpg".into());
    let (source, snapshot) = ingest(&mut n, &doc, b"one");
    let first = n.set_reading_position(&snapshot, 0, (0, 1)).unwrap();
    assert!(first.state_changed);
    assert!(first.seq.is_some());
    assert_eq!(first.position.covered, vec![(0, 1)]);
    assert!((first.progress - 17.0 / 32.0).abs() < 1e-8);
    let second = n.set_reading_position(&snapshot, 1, (1, 2)).unwrap();
    assert!(!second.state_changed);
    assert_eq!(second.seq, None);
    assert_eq!(second.position.covered, vec![(0, 2)]);
    assert_eq!(second.progress, 1.0);
    assert_eq!(
        n.changes_since(first.seq.unwrap() - 1, 100).unwrap().len(),
        1
    );
    let mut other = doc.clone();
    other.metadata.unique_id = Some("other".into());
    other.metadata.title = Some("A different book".into());
    other.format = SourceFormat::Article;
    other.media_type = "text/html".into();
    other.metadata.cover = None;
    other.metadata.site = Some("example.org".into());
    ingest(&mut n, &other, b"other");
    let library = n
        .library(&LibraryQuery {
            sort: LibrarySort::Title,
            direction: Direction::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(library.counts.reading, 1);
    assert_eq!(library.counts.inbox, 1);
    assert_eq!(library.total, 2);
    assert_eq!(library.rows[0].page.text, "A different book");
    assert_eq!(library.rows[0].site.as_deref(), Some("example.org"));
    assert_eq!(library.rows[0].cover, None);
    assert_eq!(library.rows[1].site, None);
    assert_eq!(library.rows[1].cover.as_deref(), Some("images/cover.jpg"));
    let filtered = n
        .library(&LibraryQuery {
            states: vec![ReadingState::Reading],
            text: Some("García".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(filtered.total, 1);
    assert_eq!(filtered.rows[0].page.id, source);
    assert_eq!(
        n.library(&LibraryQuery {
            format: Some(SourceFormat::Article),
            ..Default::default()
        })
        .unwrap()
        .total,
        1
    );
}
#[test]
fn highlight_notes_count_only_nonempty_live_unarchived_children() {
    let (_dir, mut n, citation) = highlighted_source();
    assert_eq!(
        n.highlights(&HighlightQuery::default()).unwrap().rows[0].notes,
        0
    );
    note(&mut n, &citation.block_id, "");
    note(&mut n, &citation.block_id, " \t\n ");
    let archived = note(&mut n, &citation.block_id, "Archived note");
    let deleted = note(&mut n, &citation.block_id, "Deleted note");
    apply(
        &mut n,
        vec![
            Operation::SetArchived {
                id: archived,
                base_revision: 1,
                archived: true,
            },
            Operation::Delete {
                id: deleted,
                base_revision: 1,
            },
        ],
    );
    let row = n
        .highlights(&HighlightQuery::default())
        .unwrap()
        .rows
        .remove(0);
    assert_eq!(row.notes, 0);
    assert!(!row.processed);
    let first = note(&mut n, &citation.block_id, "First note");
    note(&mut n, &first, "Nested note");
    assert_eq!(
        n.highlights(&HighlightQuery::default()).unwrap().rows[0].notes,
        1
    );
    note(&mut n, &citation.block_id, "Second note");
    assert_eq!(
        n.highlights(&HighlightQuery::default()).unwrap().rows[0].notes,
        2
    );
}

#[test]
fn highlight_processing_uses_children_cards_and_incoming_links() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let (source, snapshot) = ingest(&mut n, &document(), b"one");
    let highlight = note(&mut n, &source, "highlight");
    cite(&mut n, &highlight, &snapshot);
    let unprocessed = HighlightQuery {
        unprocessed: true,
        ..Default::default()
    };
    assert_eq!(n.highlights(&unprocessed).unwrap().total, 1);
    let child = note(&mut n, &highlight, "  ");
    assert_eq!(
        n.highlights(&unprocessed).unwrap().total,
        1,
        "a blank note is not processing"
    );
    edit(&mut n, &child, "child");
    assert_eq!(n.highlights(&unprocessed).unwrap().total, 0);
    apply(
        &mut n,
        vec![Operation::Delete {
            id: child,
            base_revision: 2,
        }],
    );
    edit(&mut n, &highlight, "Question>>Answer");
    assert_eq!(n.highlights(&unprocessed).unwrap().total, 0);
    edit(&mut n, &highlight, "highlight");
    let incoming = note(&mut n, &source, &format!("[[{highlight}]]"));
    assert_eq!(n.highlights(&unprocessed).unwrap().total, 0);
    apply(
        &mut n,
        vec![Operation::Delete {
            id: incoming,
            base_revision: 1,
        }],
    );
    assert_eq!(n.highlights(&unprocessed).unwrap().total, 1);
    let row = &n.library(&LibraryQuery::default()).unwrap().rows[0];
    assert_eq!((row.highlights, row.unprocessed), (1, 1));
}
#[test]
fn export_reads_authored_fields_and_article_doi_and_search_filters() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let (book, old) = ingest(&mut n, &document(), b"book");
    let publisher = field(&n, &book, "Publisher")[0].id.clone();
    edit(&mut n, &publisher, "Authored {Press} \\ % & $ # _ ^ ~");
    let bib = n
        .export(std::slice::from_ref(&book), ExportFormat::Bibtex)
        .unwrap();
    assert!(bib.starts_with("@book{garcia2020evidence,"));
    assert!(bib.contains("author = {García, Ana and Smith, John}"));
    assert!(bib.contains("translator = {Lee, Pat}"));
    assert!(bib.contains(
        "Authored \\{Press\\} \\\\ \\% \\& \\$ \\# \\_ \\textasciicircum{} \\textasciitilde{}"
    ));
    let mut article = document();
    article.format = SourceFormat::Article;
    article.media_type = "text/html".into();
    article.metadata.title = Some("An Article".into());
    article.metadata.unique_id = None;
    article.metadata.url = Some("https://example.test/story".into());
    article.metadata.site = Some("Science".into());
    article.metadata.identifiers = vec![
        "https://doi.org/10.1234/ABC".into(),
        "arxiv:2401.12345v2".into(),
    ];
    let (source, snapshot) = ingest(&mut n, &article, b"article");
    let csl: serde_json::Value = serde_json::from_str(
        &n.export(&[book.clone(), source.clone()], ExportFormat::CslJson)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(csl[0]["type"], "book");
    assert_eq!(csl[0]["author"][0]["family"], "García");
    assert_eq!(csl[1]["type"], "article-journal");
    assert_eq!(csl[1]["DOI"], "10.1234/abc");
    assert_eq!(csl[1]["container-title"], "Science");
    assert_eq!(csl[1]["archive"], "arXiv");
    assert!(
        n.export(&[], ExportFormat::Bibtex)
            .unwrap()
            .contains("@online")
    );
    let hits = n.search_passages("evidence", None, 10).unwrap();
    assert_eq!(hits.len(), 4);
    let hits = n.search_passages("Second", Some(&source), 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].snapshot_id, snapshot);
    let mut revised = document();
    revised.passages[0].text = "Replacement text".into();
    revised.passages[1].text = "Replacement body".into();
    let (_, new) = ingest(&mut n, &revised, b"revised");
    assert_ne!(new, old);
    assert!(
        n.search_passages("evidence", None, 10)
            .unwrap()
            .iter()
            .all(|h| h.source_id == source)
    );
    assert_eq!(
        n.search_passages("evidence", Some(&book), 10)
            .unwrap()
            .len(),
        2
    );
}

fn freeze_markdown_dates(dir: &std::path::Path, n: &mut Notebook) {
    apply(
        n,
        vec![Operation::SetSetting {
            key: "time_zone".into(),
            base_revision: None,
            value: "Asia/Tokyo".into(),
        }],
    );
    let instant: jiff::Timestamp = "2026-10-02T23:30:00Z".parse().unwrap();
    let conn = rusqlite::Connection::open(dir.join(tessera_core::DATABASE_FILE)).unwrap();
    conn.execute(
        "UPDATE changes SET created_at = ?1 WHERE seq IN (SELECT created_seq FROM citations)",
        [instant.as_millisecond()],
    )
    .unwrap();
}

#[test]
fn export_markdown_document_reading_order_notes_and_locations() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let mut doc = document();
    doc.metadata.url = Some("https://example.test/evidence".into());
    doc.toc[0].locator = "second".into();
    doc.toc[0].title = "Evidence".into();
    doc.passages[1].text = "Second evidence #tag".into();
    let (source, snapshot) = ingest(&mut n, &doc, b"markdown");
    let passages = n.passages(&snapshot, 0, 10).unwrap().passages;
    let later = note(&mut n, &source, "Later highlight");
    apply(
        &mut n,
        vec![Operation::Cite {
            id: later,
            base_revision: 1,
            citation_id: id(),
            snapshot_id: snapshot.clone(),
            start: PassagePoint {
                passage_id: passages[1].id.clone(),
                offset: 7,
            },
            end: PassagePoint {
                passage_id: passages[1].id.clone(),
                offset: 20,
            },
            color: None,
        }],
    );
    let first = note(&mut n, &source, "Edited highlight, not the frozen quote");
    cite(&mut n, &first, &snapshot);
    note(&mut n, &first, "Second note");
    let parent = note(&mut n, &first, "First note #tag");
    let nested = note(&mut n, &parent, "Nested note\ncontinued");
    note(&mut n, &nested, "Deep note");
    note(&mut n, &first, " \t ");
    let deleted = note(&mut n, &first, "Deleted note");
    apply(
        &mut n,
        vec![Operation::Delete {
            id: deleted,
            base_revision: 1,
        }],
    );
    edit(&mut n, &source, "Authored title");
    let published = field(&n, &source, "Published")[0].id.clone();
    edit(&mut n, &published, "2021-05-06");
    freeze_markdown_dates(dir.path(), &mut n);
    assert_eq!(
        n.export(&[source], ExportFormat::Markdown).unwrap(),
        "# Authored title
Ana García, John Smith · 2021-05-06 · `garcia2020evidence`
https://example.test/evidence

## Highlights

> 🦉 evidence
>
> Second

— ¶ 1 · 2026-10-03

First note #tag

  - Nested note
    continued

    - Deep note

Second note

> evidence #tag

— Evidence · 2026-10-03
"
    );
}

#[test]
fn export_markdown_empty_sources_and_query() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let (first, _) = ingest(&mut n, &document(), b"first");
    let mut doc = document();
    doc.metadata = ExtractedMetadata {
        title: Some("Empty source".into()),
        unique_id: Some("empty-source".into()),
        ..Default::default()
    };
    let (second, _) = ingest(&mut n, &doc, b"second");
    let view = n.source(&second).unwrap();
    let mut state = view.source.source_state();
    state.citation_key = Some("empty".into());
    apply(
        &mut n,
        vec![Operation::SetSource {
            id: second.clone(),
            base_revision: view.page.revision,
            source: Some(state),
        }],
    );
    assert_eq!(
        n.export(std::slice::from_ref(&second), ExportFormat::Markdown)
            .unwrap(),
        "# Empty source
`empty`

## Highlights

_No highlights._
"
    );
    let expected = "# Empty source
`empty`

## Highlights

_No highlights._

---

# The Evidence & Meaning
Ana García, John Smith · 2020-04 · `garcia2020evidence`

## Highlights

_No highlights._
";
    assert_eq!(
        n.export(&[second, first], ExportFormat::Markdown).unwrap(),
        expected
    );
    assert_eq!(n.export(&[], ExportFormat::Markdown).unwrap(), expected);
    assert_eq!(
        n.export_query(
            &LibraryQuery {
                sort: LibrarySort::Title,
                direction: Direction::Asc,
                limit: Some(1),
                ..Default::default()
            },
            ExportFormat::Markdown,
        )
        .unwrap(),
        expected
    );
    assert_eq!(
        n.export_query(
            &LibraryQuery {
                text: Some("unmatched".into()),
                ..Default::default()
            },
            ExportFormat::Markdown,
        )
        .unwrap(),
        ""
    );
}

#[test]
fn export_markdown_current_snapshot_before_history_and_offset_order() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let (source, old) = ingest(&mut n, &document(), b"old");
    let old_block = note(&mut n, &source, "Old highlight");
    cite(&mut n, &old_block, &old);
    let mut doc = document();
    doc.toc[0].title = "Revised opening".into();
    let (_, current) = ingest(&mut n, &doc, b"current");
    let passage = n.passages(&current, 0, 1).unwrap().passages.remove(0);
    for (start, end) in [(6, 8), (0, 5)] {
        let block = note(&mut n, &source, "Current highlight");
        apply(
            &mut n,
            vec![Operation::Cite {
                id: block,
                base_revision: 1,
                citation_id: id(),
                snapshot_id: current.clone(),
                start: PassagePoint {
                    passage_id: passage.id.clone(),
                    offset: start,
                },
                end: PassagePoint {
                    passage_id: passage.id.clone(),
                    offset: end,
                },
                color: None,
            }],
        );
    }
    let hidden = note(&mut n, &source, "Hidden highlight");
    cite(&mut n, &hidden, &current);
    let revision = n.block(&hidden).unwrap().revision;
    apply(
        &mut n,
        vec![Operation::SetArchived {
            id: hidden,
            base_revision: revision,
            archived: true,
        }],
    );
    freeze_markdown_dates(dir.path(), &mut n);
    assert_eq!(
        n.export(&[source], ExportFormat::Markdown).unwrap(),
        "# The Evidence & Meaning
Ana García, John Smith · 2020-04 · `garcia2020evidence`

## Highlights

> First

— Revised opening · 2026-10-03

> 🦉

— Revised opening · 2026-10-03

### Earlier snapshot

> 🦉 evidence
>
> Second

— Opening · 2026-10-03
"
    );
}
#[test]
fn source_validation_revision_noops_and_job_resume_retry() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let (source, snapshot) = ingest(&mut n, &document(), b"book");
    let state = n.source(&source).unwrap().source.source_state();
    let revision = n.block(&source).unwrap().revision;
    let no_op = apply(
        &mut n,
        vec![Operation::SetSource {
            id: source.clone(),
            base_revision: revision,
            source: Some(state.clone()),
        }],
    );
    assert!(no_op.revisions.is_empty());
    assert!(
        n.apply(&batch(vec![Operation::AttachSnapshot {
            id: source.clone(),
            base_revision: revision,
            snapshot_id: snapshot
        }]))
        .is_err()
    );
    for key in ["bad key", "1bad", ""] {
        let mut state = state.clone();
        state.citation_key = Some(key.into());
        assert!(
            n.apply(&batch(vec![Operation::SetSource {
                id: source.clone(),
                base_revision: revision,
                source: Some(state)
            }]))
            .is_err()
        );
    }
    let page = id();
    apply(
        &mut n,
        vec![Operation::CreatePage {
            id: page.clone(),
            title: "Other source".into(),
        }],
    );
    let mut collision = state.clone();
    collision.citation_key = Some(state.citation_key.unwrap().to_uppercase());
    assert!(
        n.apply(&batch(vec![Operation::SetSource {
            id: page,
            base_revision: 1,
            source: Some(collision)
        }]))
        .is_err()
    );
    assert!(
        n.queue_ingest(IngestInput::Url, "file:///etc/passwd", "bad", None)
            .is_err()
    );
    let job = n
        .queue_ingest(IngestInput::Url, "https://example.test/", "example", None)
        .unwrap();
    assert_eq!(n.claim_ingest().unwrap().unwrap().id, job.id);
    drop(n);
    let mut n = Notebook::open(dir.path()).unwrap();
    n.resume_ingest().unwrap();
    assert_eq!(n.ingest_job(&job.id).unwrap().state, IngestJobState::Queued);
    let claimed = n.claim_ingest().unwrap().unwrap();
    assert_eq!(claimed.attempts, 2);
    n.fail_ingest(&job.id, "The server refused the request.", None)
        .unwrap();
    assert_eq!(n.retry_ingest(&job.id).unwrap().attempts, 0);
    assert!(n.retry_ingest(&job.id).is_err());
}

#[test]
fn journal_citations_keep_identity_across_split_delete_and_restore() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let (_, snapshot) = ingest(&mut n, &document(), b"book");
    let journal = id();
    apply(
        &mut n,
        vec![Operation::CreateJournal {
            id: journal.clone(),
            date: "2026-10-04".into(),
        }],
    );
    let block = note(&mut n, &journal, "two words");
    let citation = cite(&mut n, &block, &snapshot);
    let new_id = id();
    apply(
        &mut n,
        vec![Operation::Split {
            id: block.clone(),
            base_revision: 2,
            new_id: new_id.clone(),
            left: "two".into(),
            right: " words".into(),
        }],
    );
    assert_eq!(n.capabilities(&block).unwrap().citations[0].id, citation);
    assert!(n.capabilities(&new_id).unwrap().citations.is_empty());
    let revision = n.block(&block).unwrap().revision;
    let deleted = apply(
        &mut n,
        vec![Operation::Delete {
            id: block.clone(),
            base_revision: revision,
        }],
    );
    assert!(
        n.highlights(&HighlightQuery::default())
            .unwrap()
            .rows
            .is_empty()
    );
    apply(
        &mut n,
        vec![Operation::Restore {
            id: block.clone(),
            deletion_id: deleted.deletions[0].clone(),
            revision: revision + 1,
        }],
    );
    assert_eq!(n.capabilities(&block).unwrap().citations[0].id, citation);
    let source = SourceState {
        format: SourceFormat::Epub,
        state: ReadingState::Inbox,
        origin: None,
        match_key: None,
        citation_key: None,
    };
    assert!(
        n.apply(&batch(vec![Operation::SetSource {
            id: journal,
            base_revision: 1,
            source: Some(source)
        }]))
        .is_err()
    );
}

fn resurface_fixture(count: usize) -> (tempfile::TempDir, Notebook, String, String, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    apply(
        &mut n,
        vec![Operation::SetSetting {
            key: "time_zone".into(),
            base_revision: None,
            value: "UTC".into(),
        }],
    );
    let (source, snapshot) = ingest(&mut n, &document(), b"resurface");
    let mut citations = Vec::new();
    for _ in 0..count {
        let block = note(&mut n, &source, "highlight");
        citations.push(cite(&mut n, &block, &snapshot));
    }
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    conn.execute(
        "UPDATE changes SET created_at = 0 WHERE seq IN (SELECT created_seq FROM citations)",
        [],
    )
    .unwrap();
    (dir, n, source, snapshot, citations)
}

#[test]
fn resurfacing_keeps_daily_picks_after_new_highlights_and_reload() {
    let (dir, mut n, source, snapshot, _) = resurface_fixture(4);
    let picks = n.resurfacing("2020-01-01", 3).unwrap();
    assert_eq!(picks.len(), 3);
    let block = note(&mut n, &source, "new highlight");
    cite(&mut n, &block, &snapshot);
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    conn.execute(
        "UPDATE changes SET created_at = 0 WHERE seq IN (SELECT created_seq FROM citations)",
        [],
    )
    .unwrap();
    assert_eq!(n.resurfacing("2020-01-01", 3).unwrap(), picks);
    drop(n);
    let mut n = Notebook::open(dir.path()).unwrap();
    assert_eq!(n.resurfacing("2020-01-01", 3).unwrap(), picks);
    assert_eq!(n.resurfacing("2020-01-01", 1).unwrap(), picks[..1]);
}

#[test]
fn resurfacing_uses_notebook_date_and_excludes_same_day_and_newer_highlights() {
    let (dir, mut n, _, _, citations) = resurface_fixture(3);
    apply(
        &mut n,
        vec![Operation::SetSetting {
            key: "time_zone".into(),
            base_revision: Some(1),
            value: "Pacific/Kiritimati".into(),
        }],
    );
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    // Midnight in UTC+14 falls on the previous UTC date.
    let midnight = "2020-01-01T10:00:00Z"
        .parse::<jiff::Timestamp>()
        .unwrap()
        .as_millisecond();
    for (citation, created) in citations
        .iter()
        .zip([midnight - 1, midnight, midnight + 86_400_000])
    {
        conn.execute("UPDATE changes SET created_at = ?2 WHERE seq = (SELECT created_seq FROM citations WHERE id = ?1)", rusqlite::params![citation, created]).unwrap();
    }
    let picks = n.resurfacing("2020-01-02", 3).unwrap();
    assert_eq!(picks.len(), 1);
    assert_eq!(picks[0].row.citation.id, citations[0]);
}

#[test]
fn resurfacing_kept_rests_fourteen_days_without_change_rows() {
    let (dir, mut n, _, _, citations) = resurface_fixture(1);
    let changes = n.changes_since(0, 1000).unwrap();
    let revisions = n
        .block(
            &n.highlights(&HighlightQuery::default()).unwrap().rows[0]
                .citation
                .block_id,
        )
        .unwrap()
        .revision;
    n.resurfacing("2020-01-01", 3).unwrap();
    n.record_surfacing(&citations[0], "2020-01-01", "kept")
        .unwrap();
    assert_eq!(
        n.resurfacing("2020-01-01", 3).unwrap()[0].action.as_deref(),
        Some("kept")
    );
    assert!(n.resurfacing("2020-01-14", 3).unwrap().is_empty());
    let picks = n.resurfacing("2020-01-15", 3).unwrap();
    assert_eq!(picks[0].row.citation.id, citations[0]);
    n.record_surfacing(&citations[0], "2020-01-15", "opened")
        .unwrap();
    assert_eq!(
        n.resurfacing("2020-01-15", 3).unwrap()[0].action.as_deref(),
        Some("opened")
    );
    assert_eq!(n.changes_since(0, 1000).unwrap(), changes);
    assert_eq!(
        n.block(&picks[0].row.citation.block_id).unwrap().revision,
        revisions
    );
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    assert!(
        conn.query_row::<i64, _, _>(
            "SELECT acted_at FROM highlight_surfacings WHERE date = '2020-01-01'",
            [],
            |row| row.get(0)
        )
        .unwrap()
            > 0
    );
}

#[test]
fn resurfacing_muted_never_returns_or_refills_its_day() {
    let (_dir, mut n, _, _, _) = resurface_fixture(4);
    let picks = n.resurfacing("2020-01-01", 3).unwrap();
    let muted = &picks[0].row.citation.id;
    n.record_surfacing(muted, "2020-01-01", "muted").unwrap();
    assert_eq!(n.resurfacing("2020-01-01", 3).unwrap(), picks[1..]);
    let later = n.resurfacing("2020-03-01", 4).unwrap();
    assert_eq!(later.len(), 3);
    assert!(later.iter().all(|pick| &pick.row.citation.id != muted));
}

#[test]
fn resurfacing_future_zero_limit_and_invalid_requests_do_not_record_picks() {
    let (dir, mut n, _, _, citations) = resurface_fixture(4);
    assert!(n.resurfacing("9999-12-31", 3).unwrap().is_empty());
    assert!(n.resurfacing("2020-01-01", 0).unwrap().is_empty());
    for date in ["2020-02-30", "2020-1-01", "0000-01-01", "no-date"] {
        assert!(matches!(
            n.resurfacing(date, 3),
            Err(Error::Validation { .. })
        ));
        assert!(matches!(
            n.record_surfacing(&citations[0], date, "kept"),
            Err(Error::Validation { .. })
        ));
    }
    assert!(matches!(
        n.record_surfacing(&citations[0], "2020-01-01", "keep"),
        Err(Error::Validation { .. })
    ));
    assert!(matches!(
        n.record_surfacing(&citations[0], "9999-12-31", "kept"),
        Err(Error::Validation { .. })
    ));
    assert!(
        n.record_surfacing(&citations[0], "2020-01-01", "kept")
            .is_err()
    );
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    assert_eq!(
        conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM highlight_surfacings", [], |row| row
            .get(0))
            .unwrap(),
        0
    );
    assert_eq!(n.resurfacing("2020-01-01", 2).unwrap().len(), 2);
    assert_eq!(
        conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM highlight_surfacings", [], |row| row
            .get(0))
            .unwrap(),
        2
    );
}

#[test]
fn resurfacing_requires_live_visible_citations_and_sources() {
    for target_source in [false, true] {
        for state in ["archived", "deleted", "inactive"] {
            let (_dir, mut n, source, _, citations) = resurface_fixture(1);
            let highlight = n
                .highlights(&HighlightQuery::default())
                .unwrap()
                .rows
                .remove(0);
            let target = if target_source {
                &source
            } else {
                &highlight.citation.block_id
            };
            let base_revision = n.block(target).unwrap().revision;
            let op = match state {
                "archived" => Operation::SetArchived {
                    id: target.clone(),
                    base_revision,
                    archived: true,
                },
                "deleted" => Operation::Delete {
                    id: target.clone(),
                    base_revision,
                },
                _ if target_source => Operation::SetSource {
                    id: target.clone(),
                    base_revision,
                    source: None,
                },
                _ => Operation::Uncite {
                    id: target.clone(),
                    base_revision,
                    citation_id: citations[0].clone(),
                },
            };
            n.resurfacing("2020-01-01", 3).unwrap();
            apply(&mut n, vec![op]);
            assert!(
                n.resurfacing("2020-01-01", 3).unwrap().is_empty(),
                "{target_source} {state}"
            );
            assert!(
                n.resurfacing("2020-02-01", 3).unwrap().is_empty(),
                "{target_source} {state}"
            );
        }
    }
}

#[test]
fn resurfacing_prioritizes_never_shown_then_oldest_and_shuffles_by_date() {
    let (dir, mut n, _, _, citations) = resurface_fixture(3);
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    for (citation, date) in citations[..2].iter().zip(["2019-01-02", "2019-01-01"]) {
        conn.execute(
            "INSERT INTO highlight_surfacings(citation_id, date, shown_at) VALUES (?1, ?2, 0)",
            rusqlite::params![citation, date],
        )
        .unwrap();
    }
    let picks = n.resurfacing("2020-01-01", 3).unwrap();
    assert_eq!(
        picks
            .iter()
            .map(|pick| &pick.row.citation.id)
            .collect::<Vec<_>>(),
        vec![&citations[2], &citations[1], &citations[0]]
    );
    let mut orders = std::collections::HashSet::new();
    for day in 1..=10 {
        conn.execute("DELETE FROM highlight_surfacings", [])
            .unwrap();
        let date = format!("2020-02-{day:02}");
        let picks = n.resurfacing(&date, 3).unwrap();
        let order: Vec<_> = picks
            .iter()
            .map(|pick| pick.row.citation.id.clone())
            .collect();
        conn.execute("DELETE FROM highlight_surfacings", [])
            .unwrap();
        assert_eq!(n.resurfacing(&date, 3).unwrap(), picks);
        orders.insert(order);
    }
    assert!(orders.len() > 1);
}
