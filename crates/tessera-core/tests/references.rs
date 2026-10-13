use tessera_core::{Actor, Batch, Error, Notebook, Operation, ReferenceCount};

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

fn insert(value: u128, parent: u128, after: Option<u128>, text: &str) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: id(parent),
        after: after.map(id),
        text: text.into(),
        heading: None,
    }
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

fn delete(nb: &mut Notebook, value: u128) {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::Delete {
            id: id(value),
            base_revision,
        }],
    );
}

#[test]
fn page_references_group_child_targets_and_limit_sources_in_outline_preorder() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Target"),
            insert(2, 1, None, "Child"),
            page(10, "Older source"),
            insert(11, 10, None, &format!("[[{}]]", id(2))),
            page(20, "Newer source"),
            insert(
                23,
                20,
                None,
                &format!("[[{}]] [[{}]] [[{}|again]]", id(2), id(1), id(2)),
            ),
            insert(21, 20, None, &format!("[[{}]]", id(1))),
            insert(22, 21, None, &format!("[[{}]]", id(2))),
            insert(24, 20, None, "not a source"),
            insert(25, 20, None, &format!("[[{}]]", id(1))),
        ],
    );
    let references = nb.page_references(&id(1), usize::MAX).unwrap();
    assert_eq!(references.total, 5);
    assert_eq!(
        references
            .groups
            .iter()
            .map(|group| group.page.id.clone())
            .collect::<Vec<_>>(),
        [id(20), id(10)]
    );
    assert_eq!(
        references.groups[0]
            .sources
            .iter()
            .map(|source| source.source.id.clone())
            .collect::<Vec<_>>(),
        [id(25), id(21), id(22), id(23)]
    );
    assert_eq!(references.groups[0].sources[3].targets, [id(2), id(1)]);
    assert_eq!(references.groups[1].sources[0].targets, [id(2)]);
    for limit in 0..=6 {
        let limited = nb.page_references(&id(1), limit).unwrap();
        assert_eq!(limited.total, 5);
        assert_eq!(
            limited
                .groups
                .iter()
                .flat_map(|group| &group.sources)
                .collect::<Vec<_>>(),
            references
                .groups
                .iter()
                .flat_map(|group| &group.sources)
                .take(limit)
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn counts_include_same_page_but_not_self_or_duplicate_occurrences() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Target"),
            insert(
                2,
                1,
                None,
                &format!("[[{}]] [[{}]] [[{}]]", id(1), id(2), id(2)),
            ),
            insert(3, 1, None, &format!("[[{}]] [[{}]]", id(2), id(2))),
            page(10, "Other"),
            insert(
                11,
                10,
                None,
                &format!("[[{}]] [[{}]] [[{}]]", id(1), id(2), id(2)),
            ),
        ],
    );
    assert_eq!(nb.page_references(&id(1), 100).unwrap().total, 1);
    assert_eq!(
        nb.reference_counts(&id(1)).unwrap(),
        [
            ReferenceCount {
                block_id: id(1),
                count: 2
            },
            ReferenceCount {
                block_id: id(2),
                count: 2
            }
        ]
    );
}

#[test]
fn references_and_counts_filter_archived_ancestors_and_deleted_sources_and_targets() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Target"),
            insert(2, 1, None, "branch"),
            insert(3, 2, None, "child"),
            page(10, "Other"),
            insert(11, 10, None, "branch"),
            insert(12, 11, None, &format!("[[{}]]", id(3))),
        ],
    );
    for hidden in [11, 10, 2, 1] {
        archive(&mut nb, hidden, true);
        assert_eq!(nb.page_references(&id(1), 1).unwrap().total, 0);
        assert!(nb.reference_counts(&id(1)).unwrap().is_empty());
        archive(&mut nb, hidden, false);
        assert_eq!(nb.page_references(&id(1), 1).unwrap().total, 1);
    }
    delete(&mut nb, 3);
    assert_eq!(nb.page_references(&id(1), 1).unwrap().total, 0);
    assert!(nb.reference_counts(&id(1)).unwrap().is_empty());
    apply(
        &mut nb,
        vec![
            insert(4, 1, None, "live"),
            insert(13, 10, None, &format!("[[{}]]", id(4))),
        ],
    );
    delete(&mut nb, 13);
    assert_eq!(nb.page_references(&id(1), 1).unwrap().total, 0);
    assert!(nb.reference_counts(&id(1)).unwrap().is_empty());
}

#[test]
fn unlinked_mentions_confirm_words_alias_precedence_and_ignore_reference_and_tag_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Rome"),
            insert(2, 1, None, "Rome"),
            page(10, "Other"),
            page(30, "Rome in a root"),
        ],
    );
    for alias in ["Roma", "Eternal City", "Ro", "Émile"] {
        nb.add_alias(&id(1), alias, Actor::Person).unwrap();
    }
    let texts = [
        (
            11,
            "Romeo and Jerome; éRome; Rome東京; _Rome; Rome_".to_owned(),
        ),
        (12, "All roads lead to ROME.".to_owned()),
        (13, "Visit Roma".to_owned()),
        (14, "Eternal City; Rome".to_owned()),
        (
            15,
            format!("[[{}|Rome]] #[[Eternal City]] #Roma [[Rome]]", id(10)),
        ),
        (16, format!("Rome [[{}]]", id(2))),
        (17, "Ro is short".to_owned()),
        (18, "An eternal city awaits".to_owned()),
        (19, "ÉMILE!".to_owned()),
        (20, "Rome #Roma".to_owned()),
    ];
    apply(
        &mut nb,
        texts
            .iter()
            .map(|(value, text)| insert(*value, 10, None, text))
            .collect(),
    );
    let mentions = nb.unlinked_mentions(&id(1), 100).unwrap();
    assert_eq!(mentions.total, 6);
    assert_eq!(
        mentions
            .rows
            .iter()
            .map(|row| (row.block.id.clone(), row.term.as_str()))
            .collect::<Vec<_>>(),
        [
            (id(20), "Rome"),
            (id(19), "Émile"),
            (id(18), "Eternal City"),
            (id(14), "Rome"),
            (id(13), "Roma"),
            (id(12), "Rome")
        ]
    );
    assert!(mentions.rows.iter().all(|row| row.page.id == id(10)));
    for limit in [0, 1, 3] {
        let limited = nb.unlinked_mentions(&id(1), limit).unwrap();
        assert_eq!(limited.total, 6);
        assert_eq!(limited.rows, mentions.rows[..limit]);
    }
    archive(&mut nb, 20, true);
    delete(&mut nb, 19);
    assert_eq!(nb.unlinked_mentions(&id(1), 100).unwrap().total, 4);
    archive(&mut nb, 10, true);
    assert_eq!(nb.unlinked_mentions(&id(1), 100).unwrap().total, 0);
}

#[test]
fn unlinked_mentions_exclude_urls_and_code_but_keep_adjacent_prose() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(&mut nb, vec![page(1, "Plato"), page(10, "Notes")]);
    let protected = [
        "https://plato.stanford.edu/entries/linguistics/whorfianism.html",
        "http://example.org/Plato?q=Plato#Plato",
        "`Plato`",
        "``Plato ` literal``",
        "```md\nPlato\n```",
        "~~~md\nPlato\n~~~",
    ];
    for (index, text) in protected.iter().enumerate() {
        apply(
            &mut nb,
            vec![
                insert(20 + index as u128, 10, None, text),
                insert(40 + index as u128, 10, None, &format!("{text}\nPlato")),
            ],
        );
    }
    for (index, text) in ["`Plato", "``Plato`", "```\nPlato", "~~~\nPlato"]
        .iter()
        .enumerate()
    {
        apply(&mut nb, vec![insert(60 + index as u128, 10, None, text)]);
    }
    let mentions = nb.unlinked_mentions(&id(1), 100).unwrap();
    assert_eq!(mentions.total, protected.len());
    assert!(
        mentions
            .rows
            .iter()
            .all(|row| row.block.id >= id(40) && row.block.id < id(60))
    );
    apply(
        &mut nb,
        vec![
            page(2, "New York"),
            insert(80, 10, None, "New `literal` York"),
        ],
    );
    assert_eq!(nb.unlinked_mentions(&id(2), 100).unwrap().total, 0);
}

#[test]
fn page_read_validation_and_ineligible_mention_pages() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "It"),
            insert(2, 1, None, "child"),
            Operation::CreateJournal {
                id: id(3),
                date: "2026-10-12".into(),
            },
            page(10, "Other"),
            insert(11, 10, None, "It Fields 2026-10-12"),
        ],
    );
    for page in [id(1), id(3), nb.fields().unwrap().page_id] {
        assert_eq!(nb.unlinked_mentions(&page, 10).unwrap().total, 0);
    }
    for page in ["bad".to_owned(), id(2)] {
        assert!(matches!(
            nb.page_references(&page, 0),
            Err(Error::Validation { .. })
        ));
        assert!(matches!(
            nb.reference_counts(&page),
            Err(Error::Validation { .. })
        ));
        assert!(matches!(
            nb.unlinked_mentions(&page, 0),
            Err(Error::Validation { .. })
        ));
    }
    delete(&mut nb, 1);
    for page in [id(1), id(99)] {
        assert!(matches!(
            nb.page_references(&page, 0),
            Err(Error::NotFound { .. })
        ));
        assert!(matches!(
            nb.reference_counts(&page),
            Err(Error::NotFound { .. })
        ));
        assert!(matches!(
            nb.unlinked_mentions(&page, 0),
            Err(Error::NotFound { .. })
        ));
    }
}
