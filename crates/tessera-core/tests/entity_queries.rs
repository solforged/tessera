use serde_json::{Value, json};
use tessera_core::library::*;
use tessera_core::{
    Actor, AssessmentState, Batch, FieldKind, Notebook, Operation, Query, QuestionState,
    RelationKind, RevisitAction, TaskState,
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
fn run(nb: &Notebook, query: Value) -> tessera_core::QueryResult {
    nb.query(&serde_json::from_value(query).unwrap()).unwrap()
}
fn ids(nb: &Notebook, query: Value) -> Vec<String> {
    run(nb, query)
        .rows
        .into_iter()
        .map(|row| row.block.block.id)
        .collect()
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        [
            (1, "Aristotle"),
            (2, "Scribner"),
            (3, "Language"),
            (4, "Politics"),
            (5, "Book"),
            (6, "Program"),
            (7, "Note"),
        ]
        .into_iter()
        .map(|(n, title)| Operation::CreatePage {
            id: id(n),
            title: title.into(),
        })
        .collect(),
    );
    let fields = nb.fields().unwrap().page_id;
    let today = nb.today(tessera_core::now_ms()).unwrap();
    apply(
        &mut nb,
        vec![
            insert(100, fields.clone(), "Gist".into()),
            insert(101, fields.clone(), "Work".into()),
            insert(102, fields.clone(), "When".into()),
            insert(103, fields, "Author".into()),
            Operation::SetFieldKind {
                id: id(102),
                base_revision: 1,
                kind: FieldKind::Date,
            },
            Operation::SetFieldKind {
                id: id(103),
                base_revision: 1,
                kind: FieldKind::Instance,
            },
            insert(10, id(3), format!("[[{}]]", id(1))),
            insert(11, id(3), format!("[[{}]]", id(2))),
            insert(12, id(4), format!("[[{}]]", id(1))),
            insert(20, id(3), "Branch".into()),
            insert(21, id(6), "A dated assessment\nWith a second line".into()),
            insert(30, id(3), "A task".into()),
            insert(40, id(5), "Evidence".into()),
            insert(50, id(11), format!("[[{}]]", id(10))),
            insert(1000, id(10), format!("[[{}]]", id(100))),
            insert(1001, id(1000), "First account".into()),
            insert(1002, id(10), format!("[[{}]]", id(101))),
            insert(1003, id(1002), format!("[[{}]]", id(5))),
            insert(1004, id(11), format!("[[{}]]", id(100))),
            insert(1005, id(1004), "Second account".into()),
            insert(1006, id(11), format!("[[{}]]", id(101))),
            insert(1007, id(1006), format!("[[{}]]", id(5))),
            insert(1008, id(5), format!("[[{}]]", id(103))),
            insert(1009, id(1008), format!("[[{}]]", id(1))),
            insert(1010, id(20), format!("[[{}]]", id(100))),
            insert(1011, id(1010), "Question gist".into()),
            insert(1012, id(40), format!("[[{}]]", id(100))),
            insert(1013, id(1012), "Highlight gist".into()),
            insert(1014, id(30), format!("[[{}]]", id(102))),
            insert(1015, id(1014), today),
        ],
    );
    let mut ops = vec![];
    for n in [10, 11, 12] {
        ops.push(Operation::SetPosition {
            id: id(n),
            base_revision: nb.block(&id(n)).unwrap().revision,
            position: true,
        });
    }
    for n in [6, 20] {
        ops.push(Operation::SetQuestion {
            id: id(n),
            base_revision: nb.block(&id(n)).unwrap().revision,
            question: Some(QuestionState {
                parent: (n == 20).then(|| id(6)),
                ..Default::default()
            }),
        });
    }
    ops.extend([
        Operation::SetTask {
            id: id(30),
            base_revision: nb.block(&id(30)).unwrap().revision,
            task: Some(TaskState {
                deadline: Some(nb.today(tessera_core::now_ms()).unwrap()),
                ..Default::default()
            }),
        },
        Operation::SetRelation {
            id: id(50),
            base_revision: nb.block(&id(50)).unwrap().revision,
            relation: Some(RelationKind::Disputes),
        },
        Operation::SetSource {
            id: id(5),
            base_revision: nb.block(&id(5)).unwrap().revision,
            source: Some(SourceState {
                format: SourceFormat::Record,
                state: ReadingState::Inbox,
                origin: None,
                match_key: None,
                citation_key: Some("book-key".into()),
            }),
        },
    ]);
    apply(&mut nb, ops);
    (dir, nb)
}

#[test]
fn entity_rows_keep_field_value_ids_and_attribute_group_counts_before_paging() {
    let (_dir, nb) = fixture();
    let query = json!({"source":"positions", "filters":[{"field":"@holder","op":"is","value":id(1)}], "group":{"key":"@subject"}, "limit":1});
    let result = run(&nb, query);
    assert_eq!(result.total, 2);
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.groups.len(), 2);
    assert!(result.groups.iter().all(|group| group.count == 1));
    assert_eq!(
        result.columns[..4],
        ["@holder", "@subject", &id(100), &id(101)]
    );
    assert_eq!(result.rows[0].values[&id(100)][0].id, id(1001));
    assert_eq!(result.rows[0].values[&id(101)][0].id, id(1003));
    assert_eq!(
        ids(
            &nb,
            json!({"source":"positions","filters":[{"field":"@relation","op":"is","value":"disputes"},{"field":"@target_holder","op":"is","value":id(1)}]})
        ),
        [id(11)]
    );
    assert_eq!(
        ids(&nb, json!({"source":"positions","cites":["book-key"]})),
        [id(10), id(11)]
    );
    assert_eq!(
        ids(&nb, json!({"source":"positions","links":[id(5)]})),
        [id(10), id(11)]
    );
    assert_eq!(
        run(&nb, json!({"source":"questions"}))
            .rows
            .iter()
            .find(|row| row.block.block.id == id(20))
            .unwrap()
            .values[&id(100)][0]
            .id,
        id(1011)
    );
    let sources = run(
        &nb,
        json!({"source":"sources","filters":[{"field":"@creator","op":"is","value":id(1)}]}),
    );
    assert_eq!(sources.total, 1);
    assert_eq!(
        serde_json::to_value(&sources.rows[0].attributes["@cited_by"][0].reading).unwrap()["value"],
        2.0
    );
    let tasks = run(
        &nb,
        json!({"source":"tasks", "filters":[{"field":id(102),"op":"is","value":"today"},{"field":"@due","op":"lte","value":"+7d"}]}),
    );
    assert_eq!(tasks.rows[0].block.block.id, id(30));
}

#[test]
fn relative_assessment_dates_keep_strict_boundaries_and_empty_questions() {
    let (_dir, mut nb) = fixture();
    let today = nb.today(tessera_core::now_ms()).unwrap();
    let query = json!({"source":"questions", "filters":[{"field":"@state","op":"is_not","value":"answered"},{"field":"@last_assessed","op":"lt","value":"-30d","or_empty":true}]});
    assert_eq!(ids(&nb, query.clone()), [id(6), id(20)]);
    for (days, expected) in [
        (-30, vec![id(20)]),
        (-31, vec![id(6), id(20)]),
        (0, vec![id(20)]),
    ] {
        let revision = nb.block(&id(21)).unwrap().revision;
        apply(
            &mut nb,
            vec![Operation::SetAssessment {
                id: id(21),
                base_revision: revision,
                assessment: Some(AssessmentState {
                    assessed_on: tessera_core::calendar::add_days(&today, days).unwrap(),
                    aporia: false,
                }),
            }],
        );
        assert_eq!(ids(&nb, query.clone()), expected);
    }
    let rows = run(
        &nb,
        json!({"source":"questions","group":{"key":"@program"}}),
    );
    assert_eq!(rows.groups.len(), 1);
    assert_eq!(rows.groups[0].key, id(6));
    assert_eq!(rows.groups[0].count, 2);
}

#[test]
fn grouping_deduplicates_values_and_recipe_survives_empty_search_and_reopen() {
    let (dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            insert(1100, id(1000), "Other heading".into()),
            insert(1101, id(1000), "First account".into()),
        ],
    );
    let result = run(&nb, json!({"source":"positions","group":{"key":id(100)}}));
    assert_eq!(
        result
            .groups
            .iter()
            .find(|group| group.title == "First account")
            .unwrap()
            .count,
        1
    );
    assert_eq!(
        result
            .groups
            .iter()
            .find(|group| group.title == "Other heading")
            .unwrap()
            .row_ids,
        [id(10)]
    );
    assert_eq!(result.groups.last().unwrap().title, "None");
    let recipe = json!({"source":"positions","layout":"register","columns":[{"key":"@title","width":240},{"key":id(101),"width":320},{"key":"@holder"}],"sort":[{"by":"field","field":"@holder","direction":"desc"},{"by":"field","field":id(100),"direction":"asc"}],"group":{"key":"@subject","collapsed":[id(3)]},"card":[id(100)],"purpose":"Compare accounts."});
    let query: Query = serde_json::from_value(recipe).unwrap();
    apply(
        &mut nb,
        vec![Operation::SaveView {
            id: id(900),
            base_revision: None,
            name: "Accounts".into(),
            query: query.clone(),
        }],
    );
    let columns = nb.query(&query).unwrap().columns;
    let searched = Query {
        text: Some("missingword".into()),
        ..query.clone()
    };
    assert_eq!(nb.query(&searched).unwrap().columns, columns);
    drop(nb);
    let nb = Notebook::open(dir.path()).unwrap();
    assert_eq!(nb.view(&id(900)).unwrap().query, query);
    assert_eq!(serde_json::to_value(&query).unwrap()["layout"], "register");
    let old: Query = serde_json::from_value(json!({"type":null,"text":null,"limit":null})).unwrap();
    assert!(old.layout.is_none());
    for layout in ["table", "register", "matrix", "desk"] {
        let recipe: Query =
            serde_json::from_value(json!({"layout":layout,"type":null,"text":null,"limit":null}))
                .unwrap();
        assert_eq!(serde_json::to_value(recipe).unwrap()["layout"], layout);
    }
    assert_eq!(
        serde_json::to_value(&query).unwrap()["columns"][2],
        json!({"key":"@holder"})
    );
}

#[test]
fn resolved_and_due_note_attributes_use_the_existing_revisit_state() {
    let (_dir, mut nb) = fixture();
    let today = nb.today(tessera_core::now_ms()).unwrap();
    for (n, action, next) in [
        (7, RevisitAction::Resolve, None),
        (6, RevisitAction::Later, Some(today)),
    ] {
        let revision = nb.block(&id(n)).unwrap().revision;
        apply(
            &mut nb,
            vec![Operation::Revisit {
                id: id(n),
                base_revision: revision,
                action,
                next_on: next,
                event_id: None,
            }],
        );
    }
    assert_eq!(
        ids(
            &nb,
            json!({"source":"notes","filters":[{"field":"@resolved","op":"is","value":"true"}]})
        ),
        [id(7)]
    );
    assert_eq!(
        ids(
            &nb,
            json!({"source":"notes","filters":[{"field":"@revisit","op":"lte","value":"today"}]})
        ),
        [id(6)]
    );
    for query in [
        json!({"source":"positions","filters":[{"field":"@state","op":"empty"}]}),
        json!({"source":"questions","sort":[{"by":"field","field":"@holder","direction":"asc"}]}),
        json!({"source":"tasks","group":{"key":"@unknown"}}),
    ] {
        let error = nb
            .query(&serde_json::from_value(query).unwrap())
            .unwrap_err()
            .to_string();
        assert!(error.contains("does not belong to this source"), "{error}");
    }
}

#[test]
fn highlights_are_blocks_with_editable_fields_and_source_attributes() {
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
    let hash = nb.put_object(b"entity query fixture").unwrap();
    let snapshot = nb.stage_snapshot(&document, &hash, &[]).unwrap();
    let revision = nb.block(&id(5)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::AttachSnapshot {
            id: id(5),
            base_revision: revision,
            snapshot_id: snapshot.id.clone(),
        }],
    );
    let passage = nb.passages(&snapshot.id, 0, 10).unwrap().passages.remove(0);
    let revision = nb.block(&id(40)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::Cite {
            id: id(40),
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
            color: Some("yellow".into()),
        }],
    );
    let result = run(
        &nb,
        json!({"source":"highlights","filters":[{"field":"@source","op":"is","value":id(5)}],"group":{"key":"@color"}}),
    );
    assert_eq!(result.rows[0].block.block.id, id(40));
    assert_eq!(result.rows[0].values[&id(100)][0].id, id(1013));
    assert_eq!(result.groups[0].key, "yellow");
}
