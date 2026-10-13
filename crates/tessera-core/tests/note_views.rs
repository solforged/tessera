use tessera_core::library::*;
use tessera_core::{
    Actor, Batch, NoteLayout, NoteView, Notebook, Operation, ProjectState, Query, QuestionState,
};
fn id(n: u128) -> String {
    ulid::Ulid::from(n).to_string()
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
fn insert(n: u128, parent: String, text: String) -> Operation {
    Operation::Insert {
        id: id(n),
        parent_id: parent,
        after: None,
        text,
        heading: None,
    }
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        [
            (1, "Alpha"),
            (2, "Beta"),
            (3, "Gamma"),
            (4, "Delta"),
            (5, "Asabiyya"),
            (6, "Dynasty"),
            (7, "Muqaddimah"),
        ]
        .into_iter()
        .map(|(n, title)| Operation::CreatePage {
            id: id(n),
            title: title.into(),
        })
        .collect(),
    );
    for n in 1..=4 {
        apply(
            &mut nb,
            vec![Operation::AddType {
                id: id(n),
                base_revision: 1,
                title: "Concept".into(),
            }],
        );
    }
    apply(
        &mut nb,
        vec![
            insert(
                11,
                id(1),
                format!("[[{}]] [[{}]] [[{}]]", id(5), id(6), id(7)),
            ),
            insert(12, id(2), format!("[[{}]] [[{}]]", id(5), id(7))),
            insert(13, id(3), format!("[[{}]]", id(6))),
            insert(15, id(5), format!("[[{}]] [[{}]]", id(1), id(3))),
        ],
    );
    apply(
        &mut nb,
        vec![Operation::SetSource {
            id: id(7),
            base_revision: 1,
            source: Some(SourceState {
                format: SourceFormat::Record,
                state: ReadingState::Inbox,
                origin: None,
                match_key: None,
                citation_key: Some("khaldun1377".into()),
            }),
        }],
    );
    nb.add_alias(&id(5), "Group feeling", Actor::Person)
        .unwrap();
    nb.add_alias(&id(7), "Prolegomena", Actor::Person).unwrap();
    (dir, nb)
}
fn query() -> Query {
    Query {
        note_kind: Some("concept".into()),
        ..Query::default()
    }
}
fn members(nb: &Notebook, q: &Query) -> Vec<String> {
    nb.query(q)
        .unwrap()
        .rows
        .into_iter()
        .map(|row| row.block.block.id)
        .collect()
}
#[test]
fn note_predicates_resolve_aliases_and_intersect_all_terms() {
    let (_dir, nb) = fixture();
    assert_eq!(
        members(
            &nb,
            &Query {
                links: vec!["Group feeling".into()],
                ..query()
            }
        ),
        [id(1), id(2)]
    );
    assert_eq!(
        members(
            &nb,
            &Query {
                from: vec!["Group feeling".into()],
                ..query()
            }
        ),
        [id(1), id(3)]
    );
    for name in ["Muqaddimah", "Prolegomena", "khaldun1377"] {
        assert_eq!(
            members(
                &nb,
                &Query {
                    cites: vec![name.into()],
                    ..query()
                }
            ),
            [id(1), id(2)]
        );
    }
    let source = nb.kind_notes("source").unwrap();
    let siglum = &source.summaries[&id(7)].source.as_ref().unwrap().siglum;
    assert_eq!(
        members(
            &nb,
            &Query {
                cites: vec![siglum.clone()],
                ..query()
            }
        ),
        [id(1), id(2)]
    );
    assert_eq!(
        members(
            &nb,
            &Query {
                links: vec!["Group feeling".into(), "Dynasty".into()],
                from: vec![id(5)],
                cites: vec![id(7)],
                ..query()
            }
        ),
        [id(1)]
    );
    assert!(
        members(
            &nb,
            &Query {
                links: vec!["Missing".into()],
                ..query()
            }
        )
        .is_empty()
    );
}
#[test]
fn note_text_matches_title_or_gloss_and_capability_kinds_are_selectable() {
    let (_dir, mut nb) = fixture();
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            insert(30, fields, "Gloss".into()),
            insert(31, id(2), format!("[[{}]]", id(30))),
            insert(32, id(31), "Shared feeling".into()),
        ],
    );
    assert_eq!(
        members(
            &nb,
            &Query {
                text: Some("Beta shared".into()),
                ..query()
            }
        ),
        [id(2)]
    );
    assert!(
        members(
            &nb,
            &Query {
                text: Some("Dynasty".into()),
                ..query()
            }
        )
        .is_empty(),
        "body references do not match plain words"
    );
    let alpha = nb.block(&id(1)).unwrap().revision;
    let beta = nb.block(&id(2)).unwrap().revision;
    apply(
        &mut nb,
        vec![
            Operation::SetQuestion {
                id: id(1),
                base_revision: alpha,
                question: Some(QuestionState::default()),
            },
            Operation::SetProject {
                id: id(2),
                base_revision: beta,
                project: Some(ProjectState::default()),
            },
        ],
    );
    for (kind, n) in [("question", 1), ("project", 2), ("source", 7)] {
        assert_eq!(
            members(
                &nb,
                &Query {
                    note_kind: Some(kind.into()),
                    ..Query::default()
                }
            ),
            [id(n)]
        );
    }
}
#[test]
fn grouping_counts_ties_none_and_multiple_headings_are_stable() {
    let (_dir, mut nb) = fixture();
    let q = Query {
        note_view: Some(NoteView {
            layout: NoteLayout::Index,
            grouping: "link".into(),
        }),
        ..query()
    };
    let result = nb.query(&q).unwrap();
    assert_eq!(result.total, 4);
    assert_eq!(
        result
            .note_groups
            .iter()
            .map(|g| (g.title.as_str(), g.note_ids.len()))
            .collect::<Vec<_>>(),
        [
            ("Asabiyya", 2),
            ("Dynasty", 2),
            ("Muqaddimah", 2),
            ("None", 1)
        ]
    );
    assert!(
        result
            .note_groups
            .iter()
            .take(3)
            .all(|group| group.note_ids.contains(&id(1)))
    );
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            insert(30, fields, "Strand".into()),
            insert(31, id(1), format!("[[{}]]", id(30))),
            insert(32, id(31), "Politics".into()),
            insert(33, id(31), "Culture".into()),
            insert(34, id(2), format!("[[{}]]", id(30))),
            insert(35, id(34), "Culture".into()),
        ],
    );
    let field = nb
        .query(&Query {
            note_view: Some(NoteView {
                layout: NoteLayout::Index,
                grouping: format!("field:{}", id(30)),
            }),
            ..query()
        })
        .unwrap();
    assert_eq!(
        field
            .note_groups
            .iter()
            .map(|g| (g.title.as_str(), g.note_ids.len()))
            .collect::<Vec<_>>(),
        [("Culture", 2), ("Politics", 1), ("None", 2)]
    );
    let sources = nb
        .query(&Query {
            note_view: Some(NoteView {
                layout: NoteLayout::Index,
                grouping: "source".into(),
            }),
            ..query()
        })
        .unwrap();
    assert_eq!(sources.note_groups[0].note_ids, [id(1), id(2)]);
    assert!(sources.note_groups[0].siglum.is_some());
    let months = nb
        .query(&Query {
            note_view: Some(NoteView {
                layout: NoteLayout::Index,
                grouping: "created".into(),
            }),
            ..query()
        })
        .unwrap();
    assert_eq!(months.note_groups[0].note_ids.len(), 4);
    apply(
        &mut nb,
        vec![Operation::SaveView {
            id: id(99),
            base_revision: None,
            name: "Linked concepts".into(),
            query: q.clone(),
        }],
    );
    assert_eq!(nb.view(&id(99)).unwrap().query, q);
    let legacy: Query =
        serde_json::from_str(r#"{"type":null,"text":"Alpha","filters":[],"sort":[],"limit":null}"#)
            .unwrap();
    assert!(legacy.note_view.is_none());
    assert_eq!(members(&nb, &legacy), [id(1), id(15)]);
}
#[test]
fn cites_includes_snapshot_passages_without_a_page_reference() {
    let (_dir, mut nb) = fixture();
    let document = ExtractedDocument {
        format: SourceFormat::Article,
        media_type: "text/html".into(),
        metadata: ExtractedMetadata::default(),
        toc: vec![],
        passages: vec![ExtractedPassage {
            kind: PassageKind::Paragraph,
            level: None,
            text: "Evidence".into(),
            locator: "p1".into(),
            anchor: None,
            resource: None,
            marks: vec![],
        }],
        resources: vec![],
    };
    let hash = nb.put_object(b"note query fixture").unwrap();
    let snapshot = nb.stage_snapshot(&document, &hash, &[]).unwrap();
    let revision = nb.block(&id(7)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::AttachSnapshot {
            id: id(7),
            base_revision: revision,
            snapshot_id: snapshot.id.clone(),
        }],
    );
    let passage = nb.passages(&snapshot.id, 0, 10).unwrap().passages.remove(0);
    let revision = nb.block(&id(13)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::Cite {
            id: id(13),
            base_revision: revision,
            citation_id: id(90),
            snapshot_id: snapshot.id,
            start: PassagePoint {
                passage_id: passage.id.clone(),
                offset: 0,
            },
            end: PassagePoint {
                passage_id: passage.id,
                offset: 8,
            },
            color: None,
        }],
    );
    assert_eq!(
        members(
            &nb,
            &Query {
                cites: vec![id(7)],
                ..query()
            }
        ),
        [id(1), id(2), id(3)]
    );
    assert_eq!(
        members(
            &nb,
            &Query {
                links: vec![id(7)],
                ..query()
            }
        ),
        [id(1), id(2)]
    );
}
