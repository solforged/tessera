use tessera_core::{
    Actor, Batch, Committed, Direction, Error, FieldKind, Filter, FilterOp, Notebook, Operation,
    Query, QueryResult, Reading, ReadingValue, Revision, SortBy, SortKey,
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
fn insert(value: u128, parent: u128, text: &str) -> Operation {
    child(value, &id(parent), text)
}
fn child(value: u128, parent: &str, text: &str) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: parent.into(),
        after: None,
        text: text.into(),
        heading: None,
    }
}
fn edit(nb: &mut Notebook, value: u128, text: &str) {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::EditText {
            id: id(value),
            base_revision,
            text: text.into(),
        }],
    );
}
fn archive(nb: &mut Notebook, value: u128, archived: bool) {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::SetArchived {
            id: id(value),
            base_revision,
            archived,
        }],
    );
}
fn move_to(nb: &mut Notebook, value: u128, parent: &str) {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::Move {
            id: id(value),
            base_revision,
            parent_id: parent.into(),
            after: None,
        }],
    );
}
fn kind(nb: &mut Notebook, value: u128, kind: FieldKind) {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::SetFieldKind {
            id: id(value),
            base_revision,
            kind,
        }],
    );
}
fn query() -> Query {
    Query {
        r#type: Some(id(1)),
        text: None,
        filters: vec![],
        sort: vec![],
        limit: None,
    }
}
fn ids(result: QueryResult) -> Vec<String> {
    result.rows.into_iter().map(|r| r.block.block.id).collect()
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            page(1, "Books"),
            page(2, "Notes"),
            child(10, &fields, "Year"),
            insert(100, 2, "alpha #books"),
            insert(200, 100, &format!("[[{}]]", id(10))),
            insert(300, 200, "1970"),
        ],
    );
    (dir, nb)
}
fn reading(nb: &Notebook, field: u128) -> Reading {
    nb.query(&query()).unwrap().rows[0].values[&id(field)][0]
        .reading
        .clone()
}
fn ok(value: ReadingValue, target: Option<String>) -> Reading {
    Reading::Value {
        ok: true,
        value,
        target,
    }
}
fn problem(text: &str) -> Reading {
    Reading::Problem {
        ok: false,
        problem: text.into(),
    }
}
fn indexed(dir: &tempfile::TempDir, owner: u128) -> Vec<String> {
    rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE))
        .unwrap()
        .prepare("SELECT value_id FROM field_values WHERE owner_id = ?1 ORDER BY ordinal, value_id")
        .unwrap()
        .query_map([id(owner)], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn fields_page_is_idempotent_recreated_after_deletion_and_migration_backfills_entries() {
    let (dir, mut nb) = fixture();
    let fields = nb.fields().unwrap().page_id;
    assert_eq!(
        Notebook::open(dir.path())
            .unwrap()
            .fields()
            .unwrap()
            .page_id,
        fields
    );
    // A version-five database with existing Fields content upgrades in place.
    drop(nb);
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    conn.execute_batch(
        "DROP TABLE review_events;
         DROP TABLE review_sessions;
         DROP TABLE card_units;
         DROP TABLE decks;
         DROP TABLE task_views;
         DROP TABLE work_sessions;
         DROP TABLE task_occurrences;
         DROP TABLE tasks;
         DROP TABLE projects;
         DROP TABLE settings;
         DROP TABLE field_values;
         DROP TABLE type_fields;
         DROP TABLE fields;
         DROP TABLE views;
         ALTER TABLE changes DROP COLUMN views;
         PRAGMA user_version = 5;",
    )
    .unwrap();
    drop(conn);
    nb = Notebook::open(dir.path()).unwrap();
    assert_eq!(nb.fields().unwrap().page_id, fields);
    assert_eq!(indexed(&dir, 100), vec![id(300)]);
    assert_eq!(
        reading(&nb, 10),
        ok(ReadingValue::Text("1970".into()), None)
    );
    apply(&mut nb, vec![insert(101, 2, "#fields")]);
    apply(
        &mut nb,
        vec![Operation::Delete {
            id: fields.clone(),
            base_revision: 1,
        }],
    );
    drop(nb);
    let nb = Notebook::open(dir.path()).unwrap();
    let replacement = nb.fields().unwrap().page_id;
    assert_ne!(replacement, fields);
    assert_eq!(nb.members(&replacement, 10).unwrap()[0].block.id, id(101));
    assert_eq!(
        Notebook::open(dir.path())
            .unwrap()
            .fields()
            .unwrap()
            .page_id,
        replacement
    );
    assert!(nb.fields().unwrap().fields.is_empty());
    assert!(indexed(&dir, 100).is_empty());
}

#[test]
fn only_complete_references_to_direct_live_definitions_are_entries() {
    let (dir, mut nb) = fixture();
    for text in [
        format!(" \n[[{}|Published]]\t", id(10)),
        format!("[[{}]]", id(10)),
    ] {
        edit(&mut nb, 200, &text);
        assert_eq!(indexed(&dir, 100), vec![id(300)]);
    }
    for text in [
        format!("prefix [[{}]]", id(10)),
        format!("[[{}]] suffix", id(10)),
        format!("#[[{}]]", id(10)),
        format!("[[{}]][[{}]]", id(10), id(10)),
        format!("[[{}]]", id(2)),
        format!("[[{}]]", id(999)),
        format!("[[{}|a]][[{}|b]]", id(10), id(10)),
    ] {
        edit(&mut nb, 200, &text);
        assert!(indexed(&dir, 100).is_empty(), "{text}");
    }
    edit(&mut nb, 200, &format!("[[{}]]", id(10)));
    let fields = nb.fields().unwrap().page_id;
    move_to(&mut nb, 10, &id(2));
    assert!(indexed(&dir, 100).is_empty());
    move_to(&mut nb, 10, &fields);
    assert_eq!(indexed(&dir, 100), vec![id(300)]);
    archive(&mut nb, 10, true);
    assert!(indexed(&dir, 100).is_empty());
    archive(&mut nb, 10, false);
    assert_eq!(indexed(&dir, 100), vec![id(300)]);
    let field_page = nb.block(&fields).unwrap();
    apply(
        &mut nb,
        vec![Operation::EditText {
            id: fields.clone(),
            base_revision: field_page.revision,
            text: "Former fields".into(),
        }],
    );
    assert!(indexed(&dir, 100).is_empty());
    apply(
        &mut nb,
        vec![Operation::EditText {
            id: fields,
            base_revision: field_page.revision + 1,
            text: "Fields".into(),
        }],
    );
    assert_eq!(indexed(&dir, 100), vec![id(300)]);
}

#[test]
fn every_kind_reads_values_without_rewriting_authored_blocks() {
    let (_dir, mut nb) = fixture();
    let original = nb.block(&id(300)).unwrap();
    kind(&mut nb, 10, FieldKind::Number);
    assert_eq!(reading(&nb, 10), ok(ReadingValue::Number(1970.0), None));
    assert_eq!(nb.block(&id(300)).unwrap(), original);
    for text in ["1,000", "+2", "1e3", ".5", "2.", "NaN", "inf", "--2"] {
        edit(&mut nb, 300, text);
        assert_eq!(reading(&nb, 10), problem("not a number"));
    }
    edit(&mut nb, 300, "  -12.25  ");
    assert_eq!(reading(&nb, 10), ok(ReadingValue::Number(-12.25), None));
    kind(&mut nb, 10, FieldKind::Text);
    assert_eq!(
        reading(&nb, 10),
        ok(ReadingValue::Text("  -12.25  ".into()), None)
    );
    kind(&mut nb, 10, FieldKind::Date);
    for text in ["2023-02-29", "2024-13-01", "0000-01-01", "2024-1-01"] {
        edit(&mut nb, 300, text);
        assert_eq!(reading(&nb, 10), problem("not a date"));
    }
    edit(&mut nb, 300, " 2024-02-29 ");
    assert_eq!(
        reading(&nb, 10),
        ok(ReadingValue::Text("2024-02-29".into()), None)
    );
    apply(
        &mut nb,
        vec![Operation::CreateJournal {
            id: id(50),
            date: "2000-02-29".into(),
        }],
    );
    edit(&mut nb, 300, &format!("[[{}|Leap day]]", id(50)));
    assert_eq!(
        reading(&nb, 10),
        ok(ReadingValue::Text("2000-02-29".into()), Some(id(50)))
    );
    edit(&mut nb, 300, &format!("[[{}]]", id(100)));
    assert_eq!(reading(&nb, 10), problem("not a date"));
    kind(&mut nb, 10, FieldKind::Checkbox);
    for text in ["YES", "true", " x ", "[X]", "Done"] {
        edit(&mut nb, 300, text);
        assert_eq!(reading(&nb, 10), ok(ReadingValue::Checkbox(true), None));
    }
    for text in ["NO", "false", "[ ]"] {
        edit(&mut nb, 300, text);
        assert_eq!(reading(&nb, 10), ok(ReadingValue::Checkbox(false), None));
    }
    edit(&mut nb, 300, "maybe");
    assert_eq!(reading(&nb, 10), problem("not a checkbox"));
    apply(&mut nb, vec![insert(11, 10, "Novel")]);
    assert_eq!(
        nb.fields().unwrap().fields[0].definition.options[0].text,
        "Novel"
    );
    kind(&mut nb, 10, FieldKind::Choice);
    edit(&mut nb, 300, &format!(" [[{}|fiction]] ", id(11)));
    assert_eq!(
        reading(&nb, 10),
        ok(ReadingValue::Text("Novel".into()), Some(id(11)))
    );
    edit(&mut nb, 11, "Fiction");
    assert_eq!(
        reading(&nb, 10),
        ok(ReadingValue::Text("Fiction".into()), Some(id(11)))
    );
    archive(&mut nb, 11, true);
    assert_eq!(reading(&nb, 10), problem("not an option"));
    archive(&mut nb, 11, false);
    edit(&mut nb, 300, "Fiction");
    assert_eq!(reading(&nb, 10), problem("not an option"));
    kind(&mut nb, 10, FieldKind::Instance);
    edit(&mut nb, 300, &format!("[[{}]]", id(100)));
    assert_eq!(
        reading(&nb, 10),
        ok(ReadingValue::Text("alpha #books".into()), Some(id(100)))
    );
    edit(&mut nb, 300, &format!("[[{}]]", id(999)));
    assert_eq!(reading(&nb, 10), problem("not a reference"));
    edit(&mut nb, 300, &format!("[[{}]]", id(11)));
    let revision = nb.block(&id(11)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(11),
            base_revision: revision,
        }],
    );
    assert_eq!(reading(&nb, 10), problem("not a reference"));
}

#[test]
fn index_tracks_owner_entry_value_edits_moves_deletes_restores_and_archives() {
    for target in [100, 200, 300] {
        let (dir, mut nb) = fixture();
        archive(&mut nb, target, true);
        assert!(indexed(&dir, 100).is_empty());
        archive(&mut nb, target, false);
        assert_eq!(indexed(&dir, 100), vec![id(300)]);
        let revision = nb.block(&id(target)).unwrap().revision;
        let deleted = apply(
            &mut nb,
            vec![Operation::Delete {
                id: id(target),
                base_revision: revision,
            }],
        );
        assert!(indexed(&dir, 100).is_empty());
        apply(
            &mut nb,
            vec![Operation::Restore {
                id: id(target),
                revision: revision + 1,
                deletion_id: deleted.deletions[0].clone(),
            }],
        );
        assert_eq!(indexed(&dir, 100), vec![id(300)]);
    }
    let (dir, mut nb) = fixture();
    edit(&mut nb, 100, "renamed #books");
    edit(&mut nb, 300, "1980");
    assert_eq!(
        reading(&nb, 10),
        ok(ReadingValue::Text("1980".into()), None)
    );
    apply(
        &mut nb,
        vec![
            page(3, "Other"),
            insert(101, 3, "beta #books"),
            insert(201, 101, &format!("[[{}]]", id(10))),
        ],
    );
    move_to(&mut nb, 300, &id(201));
    assert!(indexed(&dir, 100).is_empty());
    assert_eq!(indexed(&dir, 101), vec![id(300)]);
    move_to(&mut nb, 201, &id(100));
    assert!(indexed(&dir, 101).is_empty());
    assert_eq!(indexed(&dir, 100), vec![id(300)]);
    move_to(&mut nb, 100, &id(3));
    assert_eq!(indexed(&dir, 100), vec![id(300)]);
    let result = nb.query(&query()).unwrap();
    assert_eq!(result.rows[0].block.page.id, id(3));
    // Splitting an entry removes its values from the index; merging restores it.
    let revision = nb.block(&id(201)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::Split {
            id: id(201),
            base_revision: revision,
            new_id: id(202),
            left: "[[".into(),
            right: format!("{}]]", id(10)),
        }],
    );
    assert!(indexed(&dir, 100).is_empty());
    apply(
        &mut nb,
        vec![Operation::Merge {
            source_id: id(202),
            source_revision: 1,
            destination_id: id(201),
            destination_revision: revision + 1,
        }],
    );
    assert_eq!(indexed(&dir, 100), vec![id(300)]);
}

#[test]
fn templates_validate_definitions_duplicates_roots_and_revisions_atomically() {
    let (_dir, mut nb) = fixture();
    let fields = nb.fields().unwrap().page_id;
    apply(&mut nb, vec![child(12, &fields, "Author")]);
    let saved = apply(
        &mut nb,
        vec![Operation::SetTypeFields {
            type_id: id(1),
            base_revision: 1,
            fields: vec![id(12), id(10)],
        }],
    );
    assert!(saved.revisions.contains(&Revision {
        id: id(1),
        revision: 2
    }));
    let info = nb.type_info(&id(1)).unwrap();
    assert_eq!(info.fields, vec![id(12), id(10)]);
    assert_eq!(info.members, 1);
    for fields in [vec![id(10), id(10)], vec![id(100)], vec![id(999)]] {
        assert!(matches!(
            nb.apply(&batch(vec![Operation::SetTypeFields {
                type_id: id(1),
                base_revision: 2,
                fields
            }])),
            Err(Error::Validation { .. })
        ));
        assert_eq!(nb.type_info(&id(1)).unwrap().fields, info.fields);
    }
    assert!(matches!(
        nb.apply(&batch(vec![Operation::SetTypeFields {
            type_id: id(1),
            base_revision: 1,
            fields: vec![]
        }])),
        Err(Error::Conflict { .. })
    ));
    assert!(matches!(
        nb.apply(&batch(vec![Operation::SetTypeFields {
            type_id: id(100),
            base_revision: 1,
            fields: vec![]
        }])),
        Err(Error::Validation { .. })
    ));
    assert!(matches!(
        nb.apply(&batch(vec![Operation::SetFieldKind {
            id: id(100),
            base_revision: 1,
            kind: FieldKind::Number
        }])),
        Err(Error::Validation { .. })
    ));
    archive(&mut nb, 10, true);
    assert!(matches!(
        nb.apply(&batch(vec![Operation::SetFieldKind {
            id: id(10),
            base_revision: 2,
            kind: FieldKind::Number
        }])),
        Err(Error::Validation { .. })
    ));
    assert!(matches!(
        nb.type_info(&id(100)),
        Err(Error::NotFound { .. })
    ));
    archive(&mut nb, 100, true);
    assert_eq!(nb.type_info(&id(1)).unwrap().members, 0);
}

#[test]
fn view_lifecycle_is_revision_checked_atomic_replayable_and_streamed_separately() {
    let (_dir, mut nb) = fixture();
    let mut create = batch(vec![Operation::SaveView {
        id: id(500),
        base_revision: None,
        name: "  Reading  ".into(),
        query: query(),
    }]);
    create.idempotency_key = Some("create-view".into());
    let committed = nb.apply(&create).unwrap();
    assert_eq!(
        committed.revisions,
        vec![Revision {
            id: id(500),
            revision: 1
        }]
    );
    assert!(nb.apply(&create).unwrap().replayed);
    let view = nb.view(&id(500)).unwrap();
    assert_eq!(view.name, "Reading");
    create.idempotency_key = None;
    assert!(matches!(
        nb.apply(&create),
        Err(Error::Conflict {
            expected: 0,
            found: Some(1),
            ..
        })
    ));
    let event = nb.changes_since(committed.seq - 1, 1).unwrap().remove(0);
    assert_eq!(event.views, vec![id(500)]);
    assert!(event.blocks.is_empty());
    assert!(event.removed.is_empty());
    for (revision, error_conflict) in [(0, true), (1, false)] {
        let result = nb.apply(&batch(vec![Operation::SaveView {
            id: id(500),
            base_revision: Some(revision),
            name: "Updated".into(),
            query: query(),
        }]));
        if error_conflict {
            assert!(matches!(result, Err(Error::Conflict { .. })));
        } else {
            assert_eq!(result.unwrap().revisions[0].revision, 2);
        }
    }
    assert_eq!(nb.view(&id(500)).unwrap().created_at, view.created_at);
    for name in [" ".to_owned(), "a".repeat(121)] {
        assert!(matches!(
            nb.apply(&batch(vec![Operation::SaveView {
                id: id(501),
                base_revision: None,
                name,
                query: query()
            }])),
            Err(Error::Validation { .. })
        ));
    }
    let mut invalid = query();
    invalid.r#type = None;
    assert!(matches!(
        nb.apply(&batch(vec![Operation::SaveView {
            id: id(501),
            base_revision: None,
            name: "bad".into(),
            query: invalid
        }])),
        Err(Error::Validation { .. })
    ));
    apply(
        &mut nb,
        vec![
            Operation::SaveView {
                id: id(501),
                base_revision: None,
                name: "alpha".into(),
                query: query(),
            },
            Operation::SaveView {
                id: id(502),
                base_revision: None,
                name: "ALPHA".into(),
                query: query(),
            },
        ],
    );
    assert_eq!(
        nb.views()
            .unwrap()
            .iter()
            .map(|v| v.id.clone())
            .collect::<Vec<_>>(),
        vec![id(501), id(502), id(500)]
    );
    assert!(matches!(
        nb.apply(&batch(vec![Operation::DeleteView {
            id: id(500),
            base_revision: 1
        }])),
        Err(Error::Conflict { .. })
    ));
    let mut deletion = batch(vec![Operation::DeleteView {
        id: id(500),
        base_revision: 2,
    }]);
    deletion.idempotency_key = Some("delete-view".into());
    let deleted = nb.apply(&deletion).unwrap();
    assert_eq!(deleted.revisions[0].revision, 3);
    assert!(nb.apply(&deletion).unwrap().replayed);
    assert!(matches!(nb.view(&id(500)), Err(Error::NotFound { .. })));
    assert_eq!(
        nb.changes_since(deleted.seq - 1, 1).unwrap()[0].views,
        vec![id(500)]
    );
    deletion.idempotency_key = None;
    assert!(matches!(nb.apply(&deletion), Err(Error::NotFound { .. })));
}

#[test]
fn candidates_intersect_type_and_own_text_and_exclude_hidden_pages_and_ancestors() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            insert(101, 2, "alphabet #books"),
            insert(102, 2, "alpha untyped"),
            insert(103, 2, "other #books"),
            insert(104, 103, "alpha child #books"),
        ],
    );
    assert_eq!(
        ids(nb.query(&query()).unwrap()),
        vec![id(100), id(101), id(103), id(104)]
    );
    let mut q = query();
    q.text = Some("alph".into());
    assert_eq!(ids(nb.query(&q).unwrap()), vec![id(100), id(101), id(104)]);
    q.r#type = None;
    assert_eq!(
        ids(nb.query(&q).unwrap()),
        vec![id(100), id(101), id(102), id(104)]
    );
    q.text = None;
    assert!(matches!(nb.query(&q), Err(Error::Validation { .. })));
    q.text = Some("!!!".into());
    assert_eq!(nb.query(&q).unwrap().total, 0);
    archive(&mut nb, 103, true);
    assert_eq!(ids(nb.query(&query()).unwrap()), vec![id(100), id(101)]);
    archive(&mut nb, 1, true);
    assert_eq!(nb.query(&query()).unwrap().total, 0);
    archive(&mut nb, 1, false);
    archive(&mut nb, 2, true);
    assert_eq!(nb.query(&query()).unwrap().total, 0);
    archive(&mut nb, 2, false);
    apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(2),
            base_revision: 3,
        }],
    );
    assert_eq!(nb.query(&query()).unwrap().total, 0);
}

#[test]
fn filters_use_any_value_except_negative_and_empty_and_validate_even_without_hits() {
    let (_dir, mut nb) = fixture();
    kind(&mut nb, 10, FieldKind::Number);
    apply(
        &mut nb,
        vec![
            insert(301, 200, "1980"),
            insert(101, 2, "beta #books"),
            insert(201, 101, &format!("[[{}]]", id(10))),
            insert(302, 201, "bad"),
            insert(102, 2, "gamma #books"),
        ],
    );
    let cases = [
        (FilterOp::Is, Some("1970"), vec![100]),
        (FilterOp::IsNot, Some("1970"), vec![101, 102]),
        (FilterOp::Contains, Some("98"), vec![100]),
        (FilterOp::Gt, Some("1970"), vec![100]),
        (FilterOp::Gte, Some("1980"), vec![100]),
        (FilterOp::Lt, Some("1980"), vec![100]),
        (FilterOp::Lte, Some("1970"), vec![100]),
        (FilterOp::Set, None, vec![100, 101]),
        (FilterOp::Empty, None, vec![102]),
    ];
    for (op, value, expected) in cases {
        let mut q = query();
        q.filters.push(Filter {
            field: id(10),
            op,
            value: value.map(str::to_owned),
        });
        assert_eq!(
            ids(nb.query(&q).unwrap()),
            expected.into_iter().map(id).collect::<Vec<_>>(),
            "{op:?}"
        );
    }
    let mut q = query();
    q.filters = vec![Filter {
        field: id(10),
        op: FilterOp::Gt,
        value: Some("invalid".into()),
    }];
    q.text = Some("nohits".into());
    assert!(matches!(nb.query(&q), Err(Error::Validation { .. })));
    q.filters[0].value = None;
    assert!(matches!(nb.query(&q), Err(Error::Validation { .. })));
    q.filters[0].field = id(999);
    q.filters[0].op = FilterOp::Empty;
    assert!(matches!(nb.query(&q), Err(Error::Validation { .. })));
    q = query();
    q.sort.push(SortKey {
        by: SortBy::Field,
        field: None,
        direction: Direction::Asc,
    });
    assert!(matches!(nb.query(&q), Err(Error::Validation { .. })));
    kind(&mut nb, 10, FieldKind::Text);
    edit(&mut nb, 300, "Äuthor");
    q = query();
    q.filters.push(Filter {
        field: id(10),
        op: FilterOp::Contains,
        value: Some("ÄUTH".into()),
    });
    assert_eq!(ids(nb.query(&q).unwrap()), vec![id(100)]);
    q.filters.push(Filter {
        field: id(10),
        op: FilterOp::IsNot,
        value: Some("1980".into()),
    });
    assert!(nb.query(&q).unwrap().rows.is_empty());
}

#[test]
fn sorting_missing_last_ties_limits_and_columns_are_stable() {
    let (_dir, mut nb) = fixture();
    kind(&mut nb, 10, FieldKind::Number);
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            child(12, &fields, "Author"),
            child(13, &fields, "Genre"),
            child(14, &fields, "Unused"),
            insert(101, 2, "Beta #books"),
            insert(102, 2, "gamma #books"),
            insert(103, 2, "delta #books"),
            insert(201, 101, &format!("[[{}]]", id(10))),
            insert(301, 201, "2000"),
            insert(203, 103, &format!("[[{}]]", id(10))),
            insert(303, 203, "bad"),
            insert(210, 100, &format!("[[{}]]", id(12))),
            insert(310, 210, "Ada"),
            insert(211, 101, &format!("[[{}]]", id(12))),
            insert(311, 211, "Bea"),
            insert(220, 100, &format!("[[{}]]", id(13))),
            insert(320, 220, "Novel"),
            Operation::SetTypeFields {
                type_id: id(1),
                base_revision: 1,
                fields: vec![id(13)],
            },
        ],
    );
    for (direction, expected) in [
        (Direction::Asc, vec![100, 101, 102, 103]),
        (Direction::Desc, vec![101, 100, 102, 103]),
    ] {
        let mut q = query();
        q.sort.push(SortKey {
            by: SortBy::Field,
            field: Some(id(10)),
            direction,
        });
        assert_eq!(
            ids(nb.query(&q).unwrap()),
            expected.into_iter().map(id).collect::<Vec<_>>()
        );
    }
    let mut q = query();
    q.sort.push(SortKey {
        by: SortBy::Title,
        field: None,
        direction: Direction::Asc,
    });
    assert_eq!(
        ids(nb.query(&q).unwrap()),
        vec![id(100), id(101), id(103), id(102)]
    );
    q.sort[0].direction = Direction::Desc;
    assert_eq!(
        ids(nb.query(&q).unwrap()),
        vec![id(102), id(103), id(101), id(100)]
    );
    // Exact timestamps make this independent of clock granularity or scheduling.
    let conn = rusqlite::Connection::open(_dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    for (block, created, updated) in [(100, 4, 1), (101, 3, 2), (102, 2, 3), (103, 1, 4)] {
        conn.execute(
            "UPDATE blocks SET created_at=?2, updated_at=?3 WHERE id=?1",
            rusqlite::params![id(block), created, updated],
        )
        .unwrap();
    }
    for (by, expected) in [
        (SortBy::Created, vec![103, 102, 101, 100]),
        (SortBy::Updated, vec![100, 101, 102, 103]),
    ] {
        q.sort = vec![SortKey {
            by,
            field: None,
            direction: Direction::Asc,
        }];
        assert_eq!(
            ids(nb.query(&q).unwrap()),
            expected.into_iter().map(id).collect::<Vec<_>>()
        );
    }
    q = query();
    let result = nb.query(&q).unwrap();
    assert_eq!(result.columns, vec![id(13), id(10), id(12)]);
    q.sort = vec![
        SortKey {
            by: SortBy::Field,
            field: Some(id(14)),
            direction: Direction::Asc,
        },
        SortKey {
            by: SortBy::Title,
            field: None,
            direction: Direction::Desc,
        },
    ];
    q.limit = Some(2);
    let result = nb.query(&q).unwrap();
    assert_eq!(result.total, 4);
    assert_eq!(
        result
            .rows
            .iter()
            .map(|r| r.block.block.id.clone())
            .collect::<Vec<_>>(),
        vec![id(102), id(103)]
    );
    assert_eq!(result.columns, vec![id(13), id(10)]);
    assert!(result.fields.iter().any(|f| f.id == id(14)));
    q.limit = Some(0);
    let result = nb.query(&q).unwrap();
    assert_eq!(result.total, 4);
    assert!(result.rows.is_empty());
    assert_eq!(result.columns, vec![id(13)]);
    q.limit = Some(2001);
    assert!(matches!(nb.query(&q), Err(Error::Validation { .. })));
    q = query();
    q.r#type = None;
    q.text = Some("#books".into());
    assert_eq!(nb.query(&q).unwrap().columns, vec![id(10), id(12), id(13)]);
}

#[test]
fn field_sorts_compare_dates_booleans_and_casefolded_text_by_first_value() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            insert(101, 2, "beta #books"),
            insert(201, 101, &format!("[[{}]]", id(10))),
            insert(301, 201, ""),
        ],
    );
    let mut q = query();
    q.sort.push(SortKey {
        by: SortBy::Field,
        field: Some(id(10)),
        direction: Direction::Asc,
    });
    for (field_kind, a, b) in [
        (FieldKind::Date, "2000-01-01", "1999-12-31"),
        (FieldKind::Checkbox, "true", "false"),
        (FieldKind::Text, "zebra", "Alpha"),
    ] {
        kind(&mut nb, 10, field_kind);
        edit(&mut nb, 300, a);
        edit(&mut nb, 301, b);
        assert_eq!(ids(nb.query(&q).unwrap()), vec![id(101), id(100)]);
    }
    kind(&mut nb, 10, FieldKind::Number);
    edit(&mut nb, 300, "10");
    edit(&mut nb, 301, "2");
    apply(&mut nb, vec![insert(302, 200, "invalid")]);
    assert_eq!(ids(nb.query(&q).unwrap()), vec![id(101), id(100)]);
    q.sort[0].direction = Direction::Desc;
    assert_eq!(ids(nb.query(&q).unwrap()), vec![id(101), id(100)]);
}

#[test]
fn date_text_and_boolean_filters_use_readings_and_numeric_zero_is_equal() {
    let (_dir, mut nb) = fixture();
    let mut q = query();
    q.filters.push(Filter {
        field: id(10),
        op: FilterOp::Gte,
        value: Some("2024-01-01".into()),
    });
    kind(&mut nb, 10, FieldKind::Date);
    edit(&mut nb, 300, "2024-02-29");
    assert_eq!(ids(nb.query(&q).unwrap()), vec![id(100)]);
    q.filters[0].op = FilterOp::Lt;
    assert_eq!(nb.query(&q).unwrap().total, 0);
    kind(&mut nb, 10, FieldKind::Text);
    edit(&mut nb, 300, "beta");
    q.filters[0].value = Some("gamma".into());
    assert_eq!(ids(nb.query(&q).unwrap()), vec![id(100)]);
    kind(&mut nb, 10, FieldKind::Checkbox);
    edit(&mut nb, 300, "[X]");
    q.filters[0].op = FilterOp::Is;
    q.filters[0].value = Some("TRUE".into());
    assert_eq!(ids(nb.query(&q).unwrap()), vec![id(100)]);
    kind(&mut nb, 10, FieldKind::Number);
    edit(&mut nb, 300, "-0");
    q.filters[0].op = FilterOp::Gte;
    q.filters[0].value = Some("0".into());
    assert_eq!(ids(nb.query(&q).unwrap()), vec![id(100)]);
    q.filters[0].op = FilterOp::Gt;
    assert_eq!(nb.query(&q).unwrap().total, 0);
}

#[test]
fn columns_count_owners_not_values_and_use_names_for_frequency_ties() {
    let (_dir, mut nb) = fixture();
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            child(12, &fields, "Author"),
            child(13, &fields, "Genre"),
            insert(210, 100, &format!("[[{}]]", id(12))),
            insert(310, 210, "Ada"),
            insert(211, 100, &format!("[[{}]]", id(12))),
            insert(311, 211, "Bea"),
            insert(220, 100, &format!("[[{}]]", id(13))),
            insert(320, 220, "Novel"),
        ],
    );
    let result = nb.query(&query()).unwrap();
    assert_eq!(result.columns, vec![id(12), id(13), id(10)]);
    assert_eq!(
        result.rows[0].values[&id(12)]
            .iter()
            .map(|v| v.id.clone())
            .collect::<Vec<_>>(),
        vec![id(311), id(310)]
    );
    let mut q = query();
    q.filters.push(Filter {
        field: id(12),
        op: FilterOp::IsNot,
        value: Some("ada".into()),
    });
    assert_eq!(nb.query(&q).unwrap().total, 0);
    apply(
        &mut nb,
        vec![Operation::SetTypeFields {
            type_id: id(1),
            base_revision: 1,
            fields: vec![id(13), id(10)],
        }],
    );
    assert_eq!(
        nb.query(&query()).unwrap().columns,
        vec![id(13), id(10), id(12)]
    );
}

#[test]
fn default_limit_does_not_change_total_and_explicit_limit_can_reach_the_maximum() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        (1000..1501)
            .map(|value| insert(value, 2, "#books"))
            .collect(),
    );
    let result = nb.query(&query()).unwrap();
    assert_eq!(result.total, 502);
    assert_eq!(result.rows.len(), 500);
    let mut q = query();
    q.limit = Some(2000);
    let result = nb.query(&q).unwrap();
    assert_eq!(result.total, 502);
    assert_eq!(result.rows.len(), 502);
}

#[test]
fn blank_values_are_missing_for_rows_filters_columns_and_sorting() {
    let (_dir, mut nb) = fixture();
    kind(&mut nb, 10, FieldKind::Checkbox);
    apply(
        &mut nb,
        vec![
            insert(101, 2, "beta #books"),
            insert(201, 101, &format!("[[{}]]", id(10))),
            insert(301, 201, "yes"),
        ],
    );
    for text in ["", " \t\r\n\u{2003}\u{00a0}"] {
        edit(&mut nb, 300, text);
        let mut q = query();
        q.text = Some("alpha".into());
        let result = nb.query(&q).unwrap();
        assert_eq!(result.total, 1);
        assert!(result.rows[0].values.is_empty());
        assert!(result.columns.is_empty());
        assert!(result.fields.is_empty());
        q.filters.push(Filter {
            field: id(10),
            op: FilterOp::Empty,
            value: None,
        });
        assert_eq!(ids(nb.query(&q).unwrap()), vec![id(100)]);
        q.filters[0].op = FilterOp::Set;
        assert_eq!(nb.query(&q).unwrap().total, 0);
        q = query();
        for direction in [Direction::Asc, Direction::Desc] {
            q.sort = vec![SortKey {
                by: SortBy::Field,
                field: Some(id(10)),
                direction,
            }];
            assert_eq!(ids(nb.query(&q).unwrap()), vec![id(101), id(100)]);
        }
    }
    // A blank leading child does not mask a later nonblank reading.
    apply(
        &mut nb,
        vec![insert(302, 200, "[ ]"), insert(303, 200, "\t")],
    );
    let result = nb.query(&query()).unwrap();
    assert_eq!(
        result.rows[0].values[&id(10)]
            .iter()
            .map(|v| v.id.clone())
            .collect::<Vec<_>>(),
        vec![id(302)]
    );
    assert_eq!(reading(&nb, 10), ok(ReadingValue::Checkbox(false), None));
}

#[test]
fn blank_fields_are_not_definitions_and_edits_refresh_incoming_entries() {
    let (dir, mut nb) = fixture();
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            child(12, &fields, ""),
            insert(212, 100, &format!("[[{}]]", id(12))),
            insert(312, 212, "not a value without a definition"),
        ],
    );
    assert_eq!(
        nb.fields()
            .unwrap()
            .fields
            .iter()
            .map(|f| f.definition.id.clone())
            .collect::<Vec<_>>(),
        vec![id(10)]
    );
    assert_eq!(indexed(&dir, 100), vec![id(300)]);
    assert!(matches!(
        nb.apply(&batch(vec![Operation::SetFieldKind {
            id: id(12),
            base_revision: 1,
            kind: FieldKind::Text
        }])),
        Err(Error::Validation { .. })
    ));
    for text in ["", " \t\r\n\u{2003}\u{00a0}"] {
        edit(&mut nb, 10, text);
        assert!(nb.fields().unwrap().fields.is_empty());
        assert!(indexed(&dir, 100).is_empty());
        let result = nb.query(&query()).unwrap();
        assert!(result.fields.is_empty());
        assert!(result.columns.is_empty());
        assert!(result.rows[0].values.is_empty());
        let revision = nb.block(&id(10)).unwrap().revision;
        assert!(matches!(
            nb.apply(&batch(vec![Operation::SetFieldKind {
                id: id(10),
                base_revision: revision,
                kind: FieldKind::Number
            }])),
            Err(Error::Validation { .. })
        ));
        edit(&mut nb, 10, "Year");
        assert_eq!(indexed(&dir, 100), vec![id(300)]);
        assert_eq!(nb.fields().unwrap().fields[0].definition.name, "Year");
    }
}

#[test]
fn field_presence_includes_empty_entries_but_not_mentions() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            insert(101, 2, "beta #books"),
            insert(201, 101, &format!("[[{}]]", id(10))),
            insert(202, 101, &format!(" [[{}|Year]] ", id(10))),
            insert(102, 2, "mention only #books"),
            insert(203, 102, &format!("Mention [[{}]]", id(10))),
            insert(301, 201, " \t\u{2003}\u{00a0}"),
        ],
    );
    let mut q = query();
    q.filters.push(Filter {
        field: id(10),
        op: FilterOp::Present,
        value: None,
    });
    assert_eq!(ids(nb.query(&q).unwrap()), vec![id(100), id(101)]);
    q.r#type = None;
    assert_eq!(
        nb.query(&q).unwrap().total,
        nb.fields().unwrap().fields[0].owners
    );
    q.filters.push(Filter {
        field: id(10),
        op: FilterOp::Empty,
        value: None,
    });
    assert_eq!(ids(nb.query(&q).unwrap()), vec![id(101)]);
    q.filters.pop();
    archive(&mut nb, 300, true);
    assert_eq!(ids(nb.query(&q).unwrap()), vec![id(100), id(101)]);
    assert_eq!(nb.query(&q).unwrap().columns, vec![id(10)]);
    archive(&mut nb, 100, true);
    assert_eq!(ids(nb.query(&q).unwrap()), vec![id(101)]);
    archive(&mut nb, 2, true);
    assert_eq!(nb.query(&q).unwrap().total, 0);
    assert_eq!(nb.query(&q).unwrap().columns, vec![id(10)]);
    archive(&mut nb, 2, false);
    q.text = Some("beta".into());
    assert_eq!(ids(nb.query(&q).unwrap()), vec![id(101)]);
}
