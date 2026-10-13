use tessera_core::library::{ReadingState, SourceFormat, SourceState};
use tessera_core::{Actor, Batch, Error, Notebook, Operation, ProjectState, QuestionState, Shelf};

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}

fn apply(nb: &mut Notebook, operations: Vec<Operation>) {
    nb.apply(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    })
    .unwrap();
}

fn page(value: u128, title: &str) -> Operation {
    Operation::CreatePage {
        id: id(value),
        title: title.into(),
    }
}

fn revision(nb: &Notebook, value: u128) -> i64 {
    nb.block(&id(value)).unwrap().revision
}

fn tag(nb: &mut Notebook, value: u128, title: &str) {
    let base_revision = revision(nb, value);
    apply(
        nb,
        vec![Operation::AddType {
            id: id(value),
            base_revision,
            title: title.into(),
        }],
    );
}

fn keys(nb: &Notebook) -> Vec<(String, String, usize)> {
    nb.note_index()
        .unwrap()
        .kinds
        .into_iter()
        .map(|kind| (kind.kind.key, kind.kind.plural, kind.count))
        .collect()
}

fn titles(nb: &Notebook, key: &str) -> Vec<String> {
    nb.kind_notes(key)
        .unwrap()
        .notes
        .into_iter()
        .map(|note| note.title)
        .collect()
}

#[test]
fn notes_file_under_built_in_kinds_capabilities_and_types_you_made() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Polybius"),
            page(2, "Plato"),
            page(3, "Anacyclosis"),
            page(4, "Which model fits my work?"),
            page(5, "Ship the notes index"),
            page(6, "Loose thoughts"),
            page(7, "Abandoned draft"),
            Operation::Insert {
                id: id(60),
                parent_id: id(6),
                after: None,
                text: "a block about #Concept is not a concept note".into(),
                heading: None,
            },
        ],
    );
    tag(&mut nb, 1, "Person");
    tag(&mut nb, 1, "Historian");
    tag(&mut nb, 2, "person");
    tag(&mut nb, 3, "Concept");
    let base_revision = revision(&nb, 4);
    apply(
        &mut nb,
        vec![Operation::SetQuestion {
            id: id(4),
            base_revision,
            question: Some(QuestionState::default()),
        }],
    );
    let base_revision = revision(&nb, 5);
    apply(
        &mut nb,
        vec![Operation::SetProject {
            id: id(5),
            base_revision,
            project: Some(ProjectState {
                outcome: "Index ships".into(),
                ..ProjectState::default()
            }),
        }],
    );
    let base_revision = revision(&nb, 7);
    apply(
        &mut nb,
        vec![Operation::SetArchived {
            id: id(7),
            base_revision,
            archived: true,
        }],
    );

    let historian = nb.page_by_title("Historian").unwrap().unwrap().id;
    // Built-in kinds first in their fixed order, listed even while empty, then capability kinds, then
    // types you made, then Unfiled. Type pages (Person, Concept, Historian), the Fields page and
    // archived pages are not listed as notes; a tag inside a page's outline does not file the page.
    assert_eq!(
        keys(&nb),
        vec![
            ("person".into(), "People".into(), 2),
            ("group".into(), "Groups".into(), 0),
            ("concept".into(), "Concepts".into(), 1),
            ("thesis".into(), "Theses".into(), 0),
            ("question".into(), "Questions".into(), 1),
            ("source".into(), "Sources".into(), 0),
            ("project".into(), "Projects".into(), 1),
            (format!("type:{historian}"), "Historians".into(), 1),
            ("unfiled".into(), "Unfiled".into(), 1),
        ]
    );
    assert_eq!(nb.note_index().unwrap().notes, 6);
    assert_eq!(titles(&nb, "person"), ["Plato", "Polybius"]);
    assert_eq!(titles(&nb, "unfiled"), ["Loose thoughts"]);
    assert_eq!(titles(&nb, &format!("type:{historian}")), ["Polybius"]);
    assert!(titles(&nb, "group").is_empty());

    let polybius: Vec<_> = nb
        .note_kinds(&id(1))
        .unwrap()
        .into_iter()
        .map(|kind| kind.name)
        .collect();
    assert_eq!(polybius, ["Person", "Historian"]);
    assert!(
        nb.note_kinds(&id(6)).unwrap().is_empty(),
        "an unfiled note has no kind to show"
    );

    assert!(matches!(
        nb.kind_notes("people"),
        Err(Error::Validation { .. })
    ));
    assert!(matches!(
        nb.kind_notes(&format!("type:{}", id(99))),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn index_lists_tag_only_types_without_changing_note_counts() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Source note"),
            page(2, "Member note"),
            page(3, "Archived source"),
            Operation::Insert {
                id: id(10),
                parent_id: id(1),
                after: None,
                text: "first tagged block".into(),
                heading: None,
            },
            Operation::Insert {
                id: id(11),
                parent_id: id(1),
                after: None,
                text: "second tagged block".into(),
                heading: None,
            },
            Operation::Insert {
                id: id(20),
                parent_id: id(1),
                after: None,
                text: "archived ancestor".into(),
                heading: None,
            },
            Operation::Insert {
                id: id(21),
                parent_id: id(20),
                after: None,
                text: "hidden descendant".into(),
                heading: None,
            },
            Operation::Insert {
                id: id(30),
                parent_id: id(3),
                after: None,
                text: "hidden page member".into(),
                heading: None,
            },
            Operation::Insert {
                id: id(40),
                parent_id: id(1),
                after: None,
                text: "deleted member".into(),
                heading: None,
            },
        ],
    );
    tag(&mut nb, 2, "Book");
    tag(&mut nb, 10, "Book");
    for value in [10, 11, 21, 30, 40] {
        tag(&mut nb, value, "Excerpt");
    }
    tag(&mut nb, 11, "Person");
    tag(&mut nb, 21, "Hidden type");
    let ancestor_revision = revision(&nb, 20);
    let page_revision = revision(&nb, 3);
    let deleted_revision = revision(&nb, 40);
    apply(
        &mut nb,
        vec![
            Operation::SetArchived {
                id: id(20),
                base_revision: ancestor_revision,
                archived: true,
            },
            Operation::SetArchived {
                id: id(3),
                base_revision: page_revision,
                archived: true,
            },
            Operation::Delete {
                id: id(40),
                base_revision: deleted_revision,
            },
        ],
    );

    let index = nb.note_index().unwrap();
    assert_eq!(
        index.notes, 2,
        "tagged blocks never increase the note total"
    );
    assert_eq!(
        index
            .kinds
            .iter()
            .map(|kind| (
                kind.kind.plural.as_str(),
                kind.count,
                kind.tagged_block_count
            ))
            .collect::<Vec<_>>(),
        [
            ("People", 0, 1),
            ("Groups", 0, 0),
            ("Concepts", 0, 0),
            ("Theses", 0, 0),
            ("Questions", 0, 0),
            ("Sources", 0, 0),
            ("Projects", 0, 0),
            ("Books", 1, 1),
            ("Excerpts", 0, 2),
            ("Unfiled", 1, 0),
        ],
    );
    let excerpt = nb.page_by_title("Excerpt").unwrap().unwrap().id;
    let excerpt_kind = index
        .kinds
        .iter()
        .find(|kind| kind.kind.key == format!("type:{excerpt}"))
        .unwrap();
    assert_eq!(excerpt_kind.kind.type_id.as_deref(), Some(excerpt.as_str()));
    assert!(titles(&nb, &excerpt_kind.kind.key).is_empty());
    assert!(titles(&nb, "person").is_empty());
    let book = nb.page_by_title("Book").unwrap().unwrap().id;
    assert_eq!(titles(&nb, &format!("type:{book}")), ["Member note"]);
    assert_eq!(titles(&nb, "unfiled"), ["Source note"]);
}

#[test]
fn index_shelves_types_you_made_by_what_most_of_their_notes_are() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "To Lucilius on travel"),
            page(2, "To Lucilius on old age"),
            page(3, "A letter without a source record"),
            page(4, "Ship the index"),
            page(5, "Rome"),
            page(6, "Ostia"),
            page(7, "Loose thoughts"),
            page(8, "Stoic shelf"),
        ],
    );
    for value in [1, 2, 3] {
        tag(&mut nb, value, "Letter");
    }
    tag(&mut nb, 4, "Sprint");
    tag(&mut nb, 5, "Place");
    tag(&mut nb, 6, "Place");
    // A library type shelves with sources even though no member carries a source record.
    tag(&mut nb, 8, "Collection");
    let source = |nb: &Notebook, value| Operation::SetSource {
        id: id(value),
        base_revision: revision(nb, value),
        source: Some(SourceState {
            format: SourceFormat::Record,
            state: ReadingState::Inbox,
            origin: None,
            match_key: None,
            citation_key: None,
        }),
    };
    let operations = vec![
        source(&nb, 1),
        source(&nb, 2),
        // Half of the places are sources, which is not most of them.
        source(&nb, 6),
        Operation::SetProject {
            id: id(4),
            base_revision: revision(&nb, 4),
            project: Some(ProjectState::default()),
        },
    ];
    apply(&mut nb, operations);

    assert_eq!(
        nb.note_index()
            .unwrap()
            .kinds
            .iter()
            .map(|kind| (kind.kind.plural.as_str(), kind.shelf))
            .collect::<Vec<_>>(),
        [
            ("People", Shelf::Notes),
            ("Groups", Shelf::Notes),
            ("Concepts", Shelf::Notes),
            ("Theses", Shelf::Notes),
            ("Questions", Shelf::Notes),
            ("Sources", Shelf::Sources),
            ("Projects", Shelf::Work),
            ("Collections", Shelf::Sources),
            ("Letters", Shelf::Sources),
            ("Places", Shelf::Tags),
            ("Sprints", Shelf::Work),
            ("Unfiled", Shelf::Loose),
        ]
    );
}

#[test]
fn kind_index_summaries_derive_prose_fields_live_counts_and_distinct_backlinks() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let fields = nb.fields().unwrap().page_id;
    let insert = |value, parent_id: String, after, text: String, heading| Operation::Insert {
        id: id(value),
        parent_id,
        after,
        text,
        heading,
    };
    apply(
        &mut nb,
        vec![
            page(1, "Alpha"),
            page(2, "Beta"),
            page(3, "Blank"),
            page(4, "Referrer"),
            page(5, "Archived referrer"),
            page(6, "Prepended prose"),
            page(10, "Topics"),
            insert(20, fields.clone(), None, "Summary".into(), None),
            Operation::SetFieldRole {
                id: id(20),
                base_revision: 1,
                role: tessera_core::FieldRole::Standfirst,
            },
            insert(21, fields, Some(id(20)), "Area".into(), None),
            insert(100, id(1), None, "Earlier prose".into(), None),
            insert(101, id(1), Some(id(100)), format!("[[{}]]", id(20)), None),
            insert(102, id(101), None, "Preferred gloss".into(), None),
            insert(103, id(1), Some(id(101)), format!("[[{}]]", id(21)), None),
            insert(104, id(103), None, "Architecture".into(), None),
            insert(200, id(2), None, format!("[[{}]]", id(21)), None),
            insert(201, id(200), None, "Not prose".into(), None),
            insert(202, id(2), Some(id(200)), "Heading".into(), Some(2)),
            insert(203, id(202), None, "Nested first prose".into(), None),
            insert(204, id(2), Some(id(202)), "Archived prose".into(), None),
            insert(205, id(204), None, "Hidden descendant".into(), None),
            insert(206, id(2), Some(id(204)), "Deleted prose".into(), None),
            insert(300, id(3), None, "".into(), None),
            insert(
                400,
                id(4),
                None,
                format!("[[{}]] [[{}]]", id(3), id(3)),
                None,
            ),
            insert(401, id(4), Some(id(400)), format!("[[{}]]", id(3)), None),
            insert(500, id(5), None, format!("[[{}]]", id(3)), None),
            insert(600, id(6), None, "Later prose".into(), None),
            insert(601, id(6), None, "Earlier prose".into(), None),
            insert(602, id(6), None, "Earliest prose".into(), None),
            insert(603, id(6), Some(id(600)), "Latest prose".into(), None),
        ],
    );
    tag(&mut nb, 1, "Topics");
    tag(&mut nb, 2, "Topics");
    let type_revision = revision(&nb, 10);
    let archived_revision = revision(&nb, 204);
    let deleted_revision = revision(&nb, 206);
    let referrer_revision = revision(&nb, 5);
    apply(
        &mut nb,
        vec![
            Operation::SetTypeFields {
                type_id: id(10),
                base_revision: type_revision,
                fields: vec![id(20), id(21)],
            },
            Operation::SetArchived {
                id: id(204),
                base_revision: archived_revision,
                archived: true,
            },
            Operation::Delete {
                id: id(206),
                base_revision: deleted_revision,
            },
            Operation::SetArchived {
                id: id(5),
                base_revision: referrer_revision,
                archived: true,
            },
        ],
    );
    let index = nb.kind_notes(&format!("type:{}", id(10))).unwrap();
    assert_eq!(index.summaries.len(), 2);
    let alpha = &index.summaries[&id(1)];
    assert_eq!(alpha.preview.as_deref(), Some("Preferred gloss"));
    assert_eq!(alpha.field.as_ref().unwrap().name, "Area");
    assert_eq!(alpha.field.as_ref().unwrap().value, "Architecture");
    assert_eq!(
        alpha.block_count, 1,
        "field entries and values are not prose"
    );
    assert_eq!(alpha.prose_excerpt, ["Earlier prose"]);
    let beta = &index.summaries[&id(2)];
    assert_eq!(beta.preview.as_deref(), Some("Nested first prose"));
    assert_eq!(
        beta.block_count, 1,
        "headings, fields, archived subtrees and deleted descendants are not prose"
    );
    assert_eq!(
        beta.text_blocks, 4,
        "archived ancestry hides nonempty descendants"
    );
    assert_eq!(beta.prose_excerpt, ["Nested first prose"]);
    let unfiled = nb.kind_notes("unfiled").unwrap();
    assert_eq!(
        unfiled.summaries[&id(6)].preview.as_deref(),
        Some("Earliest prose"),
        "negative sibling ordinals retain outline order"
    );
    assert_eq!(
        unfiled.summaries[&id(6)].prose_excerpt,
        ["Earliest prose", "Earlier prose", "Later prose"],
        "the inspector excerpt keeps the first three prose blocks in outline order"
    );
    let blank = &unfiled.summaries[&id(3)];
    assert_eq!(blank.preview, None);
    assert_eq!(blank.block_count, 0);
    assert!(blank.prose_excerpt.is_empty());
    assert_eq!(blank.text_blocks, 0);
    assert_eq!(
        blank.backlinks, 2,
        "repeat tokens count once per referring block"
    );
    assert_eq!(
        blank.referenced_from.len(),
        1,
        "referring pages deduplicate, archived pages disappear"
    );
    assert_eq!(blank.referenced_from[0].id, id(4));
}

#[test]
fn filing_queue_create_type_and_membership_share_one_batch_and_keep_links() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Anacyclosis"),
            page(2, "Polybius"),
            Operation::Insert {
                id: id(20),
                parent_id: id(2),
                after: None,
                text: format!("[[{}]]", id(1)),
                heading: None,
            },
        ],
    );
    let base_revision = revision(&nb, 1);
    apply(
        &mut nb,
        vec![
            page(3, "Concept"),
            Operation::AddType {
                id: id(1),
                base_revision,
                title: "Concept".into(),
            },
        ],
    );
    assert_eq!(nb.page_by_title("Concept").unwrap().unwrap().id, id(3));
    assert_eq!(titles(&nb, "unfiled"), ["Polybius"]);
    assert_eq!(titles(&nb, "concept"), ["Anacyclosis"]);
    assert_eq!(
        nb.note_kinds(&id(1)).unwrap()[0].type_id.as_deref(),
        Some(id(3).as_str())
    );
    assert_eq!(
        nb.kind_notes("concept").unwrap().summaries[&id(1)].backlinks,
        1
    );
    assert_eq!(nb.block(&id(20)).unwrap().text, format!("[[{}]]", id(1)));

    // The same membership operation files another note without creating another type page.
    tag(&mut nb, 2, "Concept");
    assert!(titles(&nb, "unfiled").is_empty());
    assert_eq!(titles(&nb, "concept"), ["Anacyclosis", "Polybius"]);
    assert_eq!(nb.page_by_title("Concept").unwrap().unwrap().id, id(3));
}

#[test]
fn type_presentation_defaults_overrides_reset_and_validation() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(&mut nb, vec![page(1, "Book"), page(2, "A book")]);
    tag(&mut nb, 2, "Book");
    let kind = nb.note_kinds(&id(2)).unwrap().remove(0);
    assert_eq!(kind.plural, "Books");
    assert_eq!(kind.icon.as_deref(), Some("book"));
    assert_eq!(nb.type_info(&id(1)).unwrap().plural, None);
    let set =
        |base_revision, plural: Option<&str>, icon: Option<&str>| Operation::SetTypePresentation {
            type_id: id(1),
            base_revision,
            plural: plural.map(str::to_owned),
            icon: icon.map(str::to_owned),
        };
    apply(&mut nb, vec![set(1, Some("  Volumes  "), Some("shelf"))]);
    let info = nb.type_info(&id(1)).unwrap();
    assert_eq!(info.plural.as_deref(), Some("Volumes"));
    assert_eq!(info.icon.as_deref(), Some("shelf"));
    assert_eq!(nb.types().unwrap()[0], info);
    let kind = nb.note_kinds(&id(2)).unwrap().remove(0);
    assert_eq!(kind.plural, "Volumes");
    assert_eq!(kind.icon.as_deref(), Some("shelf"));
    for operation in [
        set(1, None, None),
        set(2, Some(" "), None),
        set(2, None, Some("")),
        set(2, None, Some("not a token")),
        set(2, None, Some(&"x".repeat(65))),
        Operation::SetTypePresentation {
            type_id: id(3),
            base_revision: 1,
            plural: None,
            icon: None,
        },
    ] {
        assert!(
            nb.apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: vec![operation]
            })
            .is_err()
        );
        assert_eq!(nb.type_info(&id(1)).unwrap(), info);
    }
    apply(&mut nb, vec![set(2, None, Some("future-glyph"))]);
    assert_eq!(
        nb.note_kinds(&id(2)).unwrap()[0].icon.as_deref(),
        Some("future-glyph")
    );
    apply(&mut nb, vec![set(3, None, None)]);
    let kind = nb.note_kinds(&id(2)).unwrap().remove(0);
    assert_eq!(kind.plural, "Books");
    assert_eq!(kind.icon.as_deref(), Some("book"));
}
