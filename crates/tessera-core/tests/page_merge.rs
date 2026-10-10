use tessera_core::library::{
    CreatorRole, ExtractedCreator, ExtractedDocument, ExtractedMetadata, ExtractedPassage,
    PassageKind, PassagePoint, SourceFormat,
};
use tessera_core::{
    Actor, Batch, BlockKind, Committed, Error, Filter, FilterOp, Notebook, Operation, Query,
    QueryResult, Reading, ReadingValue, TaskState,
};

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}

fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    }
}

fn apply(nb: &mut Notebook, operations: Vec<Operation>) -> Committed {
    nb.apply(&batch(operations)).unwrap()
}

fn page(value: u128, title: &str) -> Operation {
    Operation::CreatePage {
        id: id(value),
        title: title.into(),
    }
}

fn insert(value: u128, parent: &str, after: Option<u128>, text: &str) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: parent.into(),
        after: after.map(id),
        text: text.into(),
        heading: None,
    }
}

fn edit(nb: &Notebook, value: &str, text: &str) -> Operation {
    Operation::EditText {
        id: value.into(),
        base_revision: nb.block(value).unwrap().revision,
        text: text.into(),
    }
}

fn merge(nb: &Notebook, source: &str, destination: &str) -> Operation {
    Operation::MergePage {
        source_id: source.into(),
        source_revision: nb.block(source).unwrap().revision,
        destination_id: destination.into(),
        destination_revision: nb.block(destination).unwrap().revision,
    }
}

fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Draft"),
            page(2, "Canonical Person"),
            page(3, "Notes"),
            insert(90, &id(3), None, "unchanged sentinel"),
        ],
    );
    (dir, nb)
}

fn field_query(nb: &Notebook, field: &str) -> QueryResult {
    nb.query(&Query {
        r#type: None,
        text: None,
        filters: vec![Filter {
            field: field.into(),
            op: FilterOp::Present,
            value: None,
        }],
        sort: vec![],
        limit: None,
    })
    .unwrap()
}

// Capture public domain reads, including derived indexes and immutable source
// history, so failed batches and replay cannot silently leave partial changes.
fn state(nb: &Notebook) -> serde_json::Value {
    let roots = nb.roots().unwrap();
    let mut pages = Vec::new();
    let mut backlinks = Vec::new();
    let mut memberships = Vec::new();
    let mut types = Vec::new();
    let mut sources = Vec::new();
    for root in &roots {
        let view = nb.page(&root.id).unwrap();
        backlinks.push(nb.backlinks(&root.id, 1000).unwrap());
        for row in &view.rows {
            backlinks.push(nb.backlinks(&row.block.id, 1000).unwrap());
        }
        memberships.push(nb.members(&root.id, 1000).unwrap());
        if root.kind == BlockKind::Page {
            types.push(nb.type_info(&root.id).unwrap());
        }
        if nb.capabilities(&root.id).unwrap().source.is_some() {
            sources.push(nb.source(&root.id).unwrap());
        }
        pages.push(view);
    }
    let fields = nb.fields().unwrap();
    let queries: Vec<_> = fields
        .fields
        .iter()
        .map(|field| field_query(nb, &field.definition.id))
        .collect();
    serde_json::json!({
        "roots": roots,
        "pages": pages,
        "backlinks": backlinks,
        "memberships": memberships,
        "types": types,
        "sources": sources,
        "fields": fields,
        "queries": queries,
        "changes": nb.changes_since(0, 1000).unwrap(),
        "rollback_search": nb.search("rollbacktoken", 100).unwrap(),
    })
}

fn reject_atomically(nb: &mut Notebook, operation: Operation) -> Error {
    let before = state(nb);
    let sentinel = edit(nb, &id(90), "rollbacktoken");
    let error = nb.apply(&batch(vec![sentinel, operation])).unwrap_err();
    assert_eq!(state(nb), before);
    error
}

fn assert_replay(nb: &mut Notebook, request: &Batch, first: &Committed) {
    let before = state(nb);
    let replay = nb.apply(request).unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.seq, first.seq);
    assert_eq!(replay.revisions, first.revisions);
    assert_eq!(state(nb), before);
}

fn backlink_ids(nb: &Notebook, target: &str) -> Vec<String> {
    let mut ids: Vec<_> = nb
        .backlinks(target, 1000)
        .unwrap()
        .into_iter()
        .map(|link| link.source.id)
        .collect();
    ids.sort();
    ids
}

#[test]
fn merge_rewrites_mixed_links_aliases_tags_and_manual_memberships_and_replays() {
    let (dir, mut nb) = fixture();
    let mixed = format!(
        "[[{}]] [[{}|Draft alias]] #dRaFt #[[DRAFT]] [[{}|Existing alias]] #Other",
        id(1),
        id(1),
        id(2)
    );
    apply(
        &mut nb,
        vec![
            page(4, "Other"),
            insert(10, &id(3), Some(90), &mixed),
            insert(11, &id(3), Some(10), "manual only"),
            insert(12, &id(3), Some(11), "#[[Canonical Person]]"),
            insert(13, &id(3), Some(12), &format!("[[{}]]", id(2))),
            Operation::AddType {
                id: id(10),
                base_revision: 1,
                title: "Draft".into(),
            },
            Operation::AddType {
                id: id(11),
                base_revision: 1,
                title: "DRAFT".into(),
            },
            Operation::AddType {
                id: id(11),
                base_revision: 2,
                title: "Canonical Person".into(),
            },
            insert(
                14,
                &id(3),
                Some(13),
                &format!("[[{}|Deleted alias]] #Draft", id(1)),
            ),
            Operation::Delete {
                id: id(14),
                base_revision: 1,
            },
        ],
    );
    let untouched = nb.block(&id(12)).unwrap();
    let mut request = batch(vec![merge(&nb, &id(1), &id(2))]);
    request.idempotency_key = Some("merge-links".into());
    let first = nb.apply(&request).unwrap();
    assert!(!first.replayed);
    assert_eq!(
        nb.block(&id(10)).unwrap().text,
        format!(
            "[[{}]] [[{}|Draft alias]] #[[Canonical Person]] #[[Canonical Person]] [[{}|Existing alias]] #Other",
            id(2),
            id(2),
            id(2)
        )
    );
    assert_eq!(nb.block(&id(11)).unwrap().text, "manual only");
    assert_eq!(nb.block(&id(12)).unwrap(), untouched);
    let notes = nb.page(&id(3)).unwrap();
    for value in [10, 11] {
        assert_eq!(
            notes
                .rows
                .iter()
                .find(|row| row.block.id == id(value))
                .unwrap()
                .manual_types,
            vec!["Canonical Person"]
        );
    }
    let mut members: Vec<_> = nb
        .members(&id(2), 100)
        .unwrap()
        .into_iter()
        .map(|hit| hit.block.id)
        .collect();
    members.sort();
    assert_eq!(members, vec![id(10), id(11), id(12)]);
    assert_eq!(backlink_ids(&nb, &id(2)), vec![id(10), id(13)]);
    assert!(nb.members(&id(1), 100).unwrap().is_empty());
    assert!(nb.backlinks(&id(1), 100).unwrap().is_empty());
    assert!(nb.page_by_title("Draft").unwrap().is_none());
    assert!(matches!(nb.block(&id(1)), Err(Error::NotFound { .. })));
    assert!(matches!(nb.block(&id(14)), Err(Error::NotFound { .. })));
    assert!(!notes.targets.iter().any(|target| target.id == id(1)));
    assert!(notes.targets.iter().any(|target| target.id == id(2)));
    assert_eq!(nb.members(&id(4), 100).unwrap()[0].block.id, id(10));
    drop(nb);
    let mut nb = Notebook::open(dir.path()).unwrap();
    assert_replay(&mut nb, &request, &first);
}

#[test]
fn merge_moves_live_subtrees_to_destination_end_with_identity_and_order() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            insert(20, &id(2), None, "existing first"),
            insert(21, &id(20), None, "existing child"),
            insert(22, &id(2), Some(20), "existing last"),
            insert(10, &id(1), None, "source first"),
            insert(11, &id(10), None, "source child"),
            insert(12, &id(11), None, "source grandchild"),
            insert(13, &id(1), Some(10), "source last"),
            insert(14, &id(1), Some(13), "deleted subtree"),
            insert(15, &id(14), None, "deleted descendant"),
            Operation::Delete {
                id: id(14),
                base_revision: 1,
            },
            Operation::SetArchived {
                id: id(13),
                base_revision: 1,
                archived: true,
            },
        ],
    );
    let existing: Vec<_> = [20, 21, 22]
        .map(|value| nb.block(&id(value)).unwrap())
        .into();
    let operation = merge(&nb, &id(1), &id(2));
    apply(&mut nb, vec![operation]);
    let rows = nb.page(&id(2)).unwrap().rows;
    assert_eq!(
        rows.iter()
            .map(|row| (row.block.id.clone(), row.depth))
            .collect::<Vec<_>>(),
        vec![
            (id(20), 0),
            (id(21), 1),
            (id(22), 0),
            (id(10), 0),
            (id(11), 1),
            (id(12), 2),
            (id(13), 0)
        ]
    );
    for value in [10, 11, 12, 13] {
        assert_eq!(nb.block(&id(value)).unwrap().page_id, id(2));
    }
    assert_eq!(nb.block(&id(10)).unwrap().parent_id, Some(id(2)));
    assert_eq!(nb.block(&id(11)).unwrap().parent_id, Some(id(10)));
    assert_eq!(nb.block(&id(12)).unwrap().parent_id, Some(id(11)));
    assert_eq!(nb.block(&id(13)).unwrap().parent_id, Some(id(2)));
    assert!(nb.block(&id(13)).unwrap().archived);
    for block in existing {
        assert_eq!(nb.block(&block.id).unwrap(), block);
    }
    for value in [1, 14, 15] {
        assert!(matches!(nb.block(&id(value)), Err(Error::NotFound { .. })));
    }
    assert_eq!(nb.search("grandchild", 10).unwrap()[0].page.id, id(2));
}

#[test]
fn matching_field_rows_append_values_redirect_row_references_and_replay() {
    let (_dir, mut nb) = fixture();
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            insert(100, &fields, None, "Merge data"),
            insert(101, &fields, Some(100), "Unique data"),
            insert(20, &id(2), None, &format!("[[{}]]", id(100))),
            insert(21, &id(20), None, "destination one"),
            insert(22, &id(20), Some(21), "destination two"),
            insert(10, &id(1), None, &format!("[[{}]]", id(100))),
            insert(11, &id(10), None, "source one"),
            insert(12, &id(10), Some(11), "source two"),
            insert(13, &id(12), None, "nested value note"),
            insert(14, &id(1), Some(10), &format!("[[{}]]", id(101))),
            insert(15, &id(14), None, "unique source value"),
            insert(
                30,
                &id(3),
                Some(90),
                &format!("[[{}]] [[{}|Old field row]]", id(10), id(10)),
            ),
        ],
    );
    let mut request = batch(vec![merge(&nb, &id(1), &id(2))]);
    request.idempotency_key = Some("merge-fields".into());
    let first = nb.apply(&request).unwrap();
    let rows = nb.page(&id(2)).unwrap().rows;
    assert_eq!(
        rows.iter()
            .map(|row| (row.block.id.clone(), row.depth))
            .collect::<Vec<_>>(),
        vec![
            (id(20), 0),
            (id(21), 1),
            (id(22), 1),
            (id(11), 1),
            (id(12), 1),
            (id(13), 2),
            (id(14), 0),
            (id(15), 1)
        ]
    );
    assert!(matches!(nb.block(&id(10)), Err(Error::NotFound { .. })));
    for value in [11, 12] {
        assert_eq!(nb.block(&id(value)).unwrap().parent_id, Some(id(20)));
    }
    assert_eq!(nb.block(&id(13)).unwrap().parent_id, Some(id(12)));
    for value in [11, 12, 13, 14, 15] {
        assert_eq!(nb.block(&id(value)).unwrap().page_id, id(2));
    }
    let result = field_query(&nb, &id(100));
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].block.block.id, id(2));
    assert_eq!(
        result.rows[0].values[&id(100)]
            .iter()
            .map(|value| (value.id.clone(), value.text.clone()))
            .collect::<Vec<_>>(),
        vec![
            (id(21), "destination one".into()),
            (id(22), "destination two".into()),
            (id(11), "source one".into()),
            (id(12), "source two".into())
        ]
    );
    let unique = field_query(&nb, &id(101));
    assert_eq!(unique.rows[0].block.block.id, id(2));
    assert_eq!(unique.rows[0].values[&id(101)][0].id, id(15));
    assert_eq!(
        nb.block(&id(30)).unwrap().text,
        format!("[[{}]] [[{}|Old field row]]", id(20), id(20))
    );
    assert_eq!(backlink_ids(&nb, &id(20)), vec![id(30)]);
    assert!(nb.backlinks(&id(10), 10).unwrap().is_empty());
    assert_replay(&mut nb, &request, &first);
}

#[test]
fn field_rows_with_archive_heading_or_capability_state_are_not_discarded() {
    for decoration in ["archived", "heading", "task"] {
        let (_dir, mut nb) = fixture();
        let fields = nb.fields().unwrap().page_id;
        let mut entry = insert(10, &id(1), None, &format!("[[{}]]", id(100)));
        if decoration == "heading" {
            if let Operation::Insert { heading, .. } = &mut entry {
                *heading = Some(2);
            }
        }
        apply(
            &mut nb,
            vec![
                insert(100, &fields, None, "Merge data"),
                insert(20, &id(2), None, &format!("[[{}]]", id(100))),
                insert(21, &id(20), None, "destination value"),
                entry,
                insert(11, &id(10), None, "source value"),
            ],
        );
        match decoration {
            "archived" => {
                apply(
                    &mut nb,
                    vec![Operation::SetArchived {
                        id: id(10),
                        base_revision: 1,
                        archived: true,
                    }],
                );
            }
            "task" => {
                apply(
                    &mut nb,
                    vec![Operation::SetTask {
                        id: id(10),
                        base_revision: 1,
                        task: Some(TaskState::default()),
                    }],
                );
            }
            _ => {}
        }
        let before = nb.block(&id(10)).unwrap();
        let capabilities = nb.capabilities(&id(10)).unwrap();
        let operation = merge(&nb, &id(1), &id(2));
        apply(&mut nb, vec![operation]);
        let after = nb.block(&id(10)).unwrap();
        assert_eq!(after.parent_id, Some(id(2)), "{decoration}");
        assert_eq!(after.page_id, id(2), "{decoration}");
        assert_eq!(after.text, before.text, "{decoration}");
        assert_eq!(after.archived, before.archived, "{decoration}");
        assert_eq!(after.heading, before.heading, "{decoration}");
        assert_eq!(
            nb.capabilities(&id(10)).unwrap(),
            capabilities,
            "{decoration}"
        );
        assert_eq!(
            nb.block(&id(11)).unwrap().parent_id,
            Some(id(10)),
            "{decoration}"
        );
        assert_eq!(nb.block(&id(11)).unwrap().page_id, id(2), "{decoration}");
        assert_eq!(
            nb.block(&id(21)).unwrap().parent_id,
            Some(id(20)),
            "{decoration}"
        );
    }
}

fn record(nb: &mut Notebook, title: &str, author: &str) -> String {
    let metadata = ExtractedMetadata {
        title: Some(title.into()),
        creators: vec![ExtractedCreator {
            name: author.into(),
            role: CreatorRole::Author,
        }],
        ..Default::default()
    };
    let plan = nb.plan_source_record(&metadata).unwrap();
    let source = plan.source_id;
    apply(nb, plan.operations);
    source
}

#[test]
fn person_merge_redirects_incoming_author_fields_on_two_sources_and_unions_backlinks() {
    let (_dir, mut nb) = fixture();
    let first_book = record(&mut nb, "First source", "Draft");
    let second_book = record(&mut nb, "Second source", "Canonical Person");
    let author = nb
        .fields()
        .unwrap()
        .fields
        .into_iter()
        .find(|field| field.definition.name == "Author")
        .unwrap()
        .definition
        .id;
    let before = field_query(&nb, &author);
    let first_value = before
        .rows
        .iter()
        .find(|row| row.block.block.id == first_book)
        .unwrap()
        .values[&author][0]
        .id
        .clone();
    let second_value = before
        .rows
        .iter()
        .find(|row| row.block.block.id == second_book)
        .unwrap()
        .values[&author][0]
        .id
        .clone();
    let alias = edit(
        &nb,
        &first_value,
        &format!("[[{}|Original attribution]]", id(1)),
    );
    apply(&mut nb, vec![alias]);
    let mut first_source = nb.source(&first_book).unwrap();
    assert_eq!(first_source.source.siglum, "DRA");
    let second_source = nb.source(&second_book).unwrap();
    let mut request = batch(vec![merge(&nb, &id(1), &id(2))]);
    request.idempotency_key = Some("merge-authors".into());
    let first = nb.apply(&request).unwrap();
    assert_eq!(
        nb.block(&first_value).unwrap().text,
        format!("[[{}|Original attribution]]", id(2))
    );
    assert_eq!(
        nb.block(&second_value).unwrap().text,
        format!("[[{}]]", id(2))
    );
    let result = field_query(&nb, &author);
    for (book, value_id) in [(&first_book, &first_value), (&second_book, &second_value)] {
        let row = result
            .rows
            .iter()
            .find(|row| &row.block.block.id == book)
            .unwrap();
        assert_eq!(row.values[&author].len(), 1);
        let value = &row.values[&author][0];
        assert_eq!(&value.id, value_id);
        assert!(
            matches!(&value.reading, Reading::Value { ok: true, value: ReadingValue::Text(_), target: Some(target) } if target == &id(2))
        );
    }
    let mut expected = vec![first_value, second_value];
    expected.sort();
    assert_eq!(backlink_ids(&nb, &id(2)), expected);
    let mut source_pages: Vec<_> = nb
        .backlinks(&id(2), 100)
        .unwrap()
        .into_iter()
        .map(|link| link.page.id)
        .collect();
    source_pages.sort();
    let mut expected_pages = vec![first_book.clone(), second_book.clone()];
    expected_pages.sort();
    assert_eq!(source_pages, expected_pages);
    assert!(nb.backlinks(&id(1), 100).unwrap().is_empty());
    // Sigla are derived from the linked author's surviving title, not the
    // preserved display alias. Immutable source identity and history stay put.
    first_source.source.siglum = "PER".into();
    first_source.source.siglum_basis = "PERSON".into();
    assert_eq!(nb.source(&first_book).unwrap(), first_source);
    assert_eq!(nb.source(&second_book).unwrap(), second_source);
    assert_replay(&mut nb, &request, &first);
}

#[test]
fn rename_before_merge_retargets_pending_tag_and_manual_membership_rewrites() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            insert(10, &id(3), Some(90), &format!("#Draft [[{}|Draft]]", id(1))),
            Operation::AddType {
                id: id(10),
                base_revision: 1,
                title: "Draft".into(),
            },
        ],
    );
    let source_revision = nb.block(&id(1)).unwrap().revision;
    let rename = edit(&nb, &id(1), "Intermediate title");
    let destination_revision = nb.block(&id(2)).unwrap().revision;
    apply(
        &mut nb,
        vec![
            rename,
            Operation::MergePage {
                source_id: id(1),
                source_revision: source_revision + 1,
                destination_id: id(2),
                destination_revision,
            },
        ],
    );
    assert_eq!(
        nb.block(&id(10)).unwrap().text,
        format!("#[[Canonical Person]] [[{}|Draft]]", id(2))
    );
    let notes = nb.page(&id(3)).unwrap();
    assert_eq!(
        notes
            .rows
            .iter()
            .find(|row| row.block.id == id(10))
            .unwrap()
            .manual_types,
        vec!["Canonical Person"]
    );
    assert_eq!(nb.members(&id(2), 10).unwrap()[0].block.id, id(10));
    assert!(nb.page_by_title("Draft").unwrap().is_none());
    assert!(nb.page_by_title("Intermediate title").unwrap().is_none());
    assert!(nb.members(&id(1), 10).unwrap().is_empty());
}

#[test]
fn self_journal_fields_and_non_root_endpoints_are_refused_atomically() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            Operation::CreateJournal {
                id: id(4),
                date: "2026-10-10".into(),
            },
            insert(91, &id(3), Some(90), "ordinary block"),
        ],
    );
    let fields = nb.fields().unwrap().page_id;
    let cases = [
        (id(1), id(1)),
        (id(4), id(2)),
        (id(1), id(4)),
        (fields.clone(), id(2)),
        (id(1), fields),
        (id(91), id(2)),
        (id(1), id(91)),
    ];
    for (source, destination) in cases {
        let operation = merge(&nb, &source, &destination);
        let error = reject_atomically(&mut nb, operation);
        assert!(
            matches!(error, Error::Validation { .. }),
            "{source} -> {destination}: {error:?}"
        );
    }
}

#[test]
fn deleted_source_and_destination_are_refused_atomically() {
    for deleted in [1, 2] {
        let (_dir, mut nb) = fixture();
        apply(
            &mut nb,
            vec![Operation::Delete {
                id: id(deleted),
                base_revision: 1,
            }],
        );
        let operation = Operation::MergePage {
            source_id: id(1),
            source_revision: if deleted == 1 { 2 } else { 1 },
            destination_id: id(2),
            destination_revision: if deleted == 2 { 2 } else { 1 },
        };
        reject_atomically(&mut nb, operation);
        assert!(matches!(
            nb.block(&id(deleted)),
            Err(Error::NotFound { .. })
        ));
    }
}

#[test]
fn stale_source_or_destination_revision_rolls_back_the_entire_batch() {
    for stale_source in [true, false] {
        let (_dir, mut nb) = fixture();
        let operation = Operation::MergePage {
            source_id: id(1),
            source_revision: if stale_source { 99 } else { 1 },
            destination_id: id(2),
            destination_revision: if stale_source { 1 } else { 99 },
        };
        let error = reject_atomically(&mut nb, operation);
        assert!(matches!(
            error,
            Error::Conflict {
                expected: 99,
                found: Some(1),
                ..
            }
        ));
    }
}

#[test]
fn a_later_failure_rolls_back_merge_moves_links_fields_memberships_and_tombstones() {
    let (_dir, mut nb) = fixture();
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            insert(100, &fields, None, "Merge data"),
            insert(10, &id(1), None, &format!("[[{}]]", id(100))),
            insert(11, &id(10), None, "source value"),
            insert(20, &id(2), None, &format!("[[{}]]", id(100))),
            insert(21, &id(20), None, "destination value"),
            insert(
                30,
                &id(3),
                Some(90),
                &format!("#Draft [[{}|Old page]] [[{}]]", id(1), id(10)),
            ),
            Operation::AddType {
                id: id(30),
                base_revision: 1,
                title: "Draft".into(),
            },
        ],
    );
    let before = state(&nb);
    let error = nb
        .apply(&batch(vec![
            merge(&nb, &id(1), &id(2)),
            Operation::EditText {
                id: id(90),
                base_revision: 99,
                text: "rollbacktoken".into(),
            },
        ]))
        .unwrap_err();
    assert!(matches!(error, Error::Conflict { op_index: 1, .. }));
    assert_eq!(state(&nb), before);
    let operation = merge(&nb, &id(1), &id(2));
    apply(&mut nb, vec![operation]);
    assert_eq!(nb.block(&id(11)).unwrap().parent_id, Some(id(20)));
    assert!(nb.page_by_title("Draft").unwrap().is_none());
}

#[test]
fn source_endpoints_and_discarded_root_citations_are_refused_atomically() {
    let (_dir, mut nb) = fixture();
    let record = record(&mut nb, "Metadata source", "Writer");
    let document = ExtractedDocument {
        format: SourceFormat::Epub,
        media_type: "application/epub+zip".into(),
        metadata: ExtractedMetadata {
            title: Some("Snapshot source".into()),
            ..Default::default()
        },
        toc: vec![],
        passages: vec![ExtractedPassage {
            kind: PassageKind::Paragraph,
            level: None,
            text: "Immutable source evidence".into(),
            locator: "chapter#first".into(),
            anchor: Some("first".into()),
            resource: None,
            marks: vec![],
        }],
        resources: vec![],
    };
    let hash = nb.put_object(b"page-merge-source-snapshot").unwrap();
    let snapshot = nb.stage_snapshot(&document, &hash, &[]).unwrap().id;
    let plan = nb.plan_ingest(&snapshot, None, Some("merge.epub")).unwrap();
    let source = plan.source_id;
    apply(&mut nb, plan.operations);
    assert!(nb.source(&record).unwrap().snapshots.is_empty());
    assert_eq!(nb.source(&source).unwrap().snapshots.len(), 1);
    let passages = nb.passages(&snapshot, 0, 100).unwrap();
    for endpoint in [&record, &source] {
        for (from, to) in [(endpoint.clone(), id(2)), (id(1), endpoint.clone())] {
            let operation = merge(&nb, &from, &to);
            let error = reject_atomically(&mut nb, operation);
            assert!(matches!(error, Error::Validation { .. }), "{error:?}");
        }
    }
    assert_eq!(nb.passages(&snapshot, 0, 100).unwrap(), passages);
    apply(
        &mut nb,
        vec![Operation::Cite {
            id: id(1),
            base_revision: 1,
            citation_id: id(500),
            snapshot_id: snapshot.clone(),
            start: PassagePoint {
                passage_id: passages.passages[0].id.clone(),
                offset: 0,
            },
            end: PassagePoint {
                passage_id: passages.passages[0].id.clone(),
                offset: 9,
            },
            color: None,
        }],
    );
    let operation = merge(&nb, &id(1), &id(2));
    assert!(matches!(
        reject_atomically(&mut nb, operation),
        Error::Validation { .. }
    ));
    assert_eq!(nb.capabilities(&id(1)).unwrap().citations[0].id, id(500));
}

#[test]
fn discarded_root_task_and_type_schema_are_refused_but_destination_task_is_preserved() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![Operation::SetTask {
            id: id(1),
            base_revision: 1,
            task: Some(TaskState::default()),
        }],
    );
    let operation = merge(&nb, &id(1), &id(2));
    assert!(matches!(
        reject_atomically(&mut nb, operation),
        Error::Validation { .. }
    ));
    let task = nb.capabilities(&id(1)).unwrap().task;
    let operation = merge(&nb, &id(2), &id(1));
    apply(&mut nb, vec![operation]);
    assert_eq!(nb.capabilities(&id(1)).unwrap().task, task);

    let (_dir, mut nb) = fixture();
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            insert(100, &fields, None, "Merge data"),
            Operation::SetTypeFields {
                type_id: id(1),
                base_revision: 1,
                fields: vec![id(100)],
            },
        ],
    );
    let operation = merge(&nb, &id(1), &id(2));
    assert!(matches!(
        reject_atomically(&mut nb, operation),
        Error::Validation { .. }
    ));
}
