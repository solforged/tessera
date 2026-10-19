use serde_json::{Value, json};
use tessera_core::{Actor, Batch, CardUnit, Committed, DATABASE_FILE, Notebook, Operation};

fn id(n: u128) -> String {
    ulid::Ulid::from(n).to_string()
}
fn op(value: Value) -> Operation {
    serde_json::from_value(value).unwrap()
}
fn apply(nb: &mut Notebook, values: Vec<Value>) -> Committed {
    nb.apply(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations: values.into_iter().map(op).collect(),
    })
    .unwrap()
}
fn insert(n: u128, parent: &str, text: &str) -> Value {
    json!({"op":"insert", "id":id(n), "parent_id":parent, "after":null, "text":text, "heading":null})
}
fn edit(nb: &Notebook, n: u128, text: &str) -> Value {
    json!({"op":"edit_text", "id":id(n), "base_revision":nb.block(&id(n)).unwrap().revision, "text":text})
}
fn recipe(n: u128, reverse: bool) -> Value {
    json!({"op":"create_card_template", "id":id(n), "type_id":id(1), "name":if reverse {"Recall"} else {"Recognize"}, "front":if reverse {format!("{{{}}}",id(10))} else {"{@text}".into()}, "back":if reverse {"{@text}".into()} else {format!("{{{}}}",id(10))}, "hint":id(11), "details":[id(11),id(12)], "new_per_day":20})
}
fn enable(n: u128) -> Value {
    json!({"op":"set_card_template_applied", "id":id(n), "base_revision":1, "applied":true})
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let register = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            json!({"op":"create_page","id":id(1),"title":"Italian word"}),
            json!({"op":"create_page","id":id(2),"title":"Kitchen words"}),
            insert(10, &register, "Meaning"),
            insert(11, &register, "Pronunciation"),
            insert(12, &register, "Example"),
            json!({"op":"set_field_role","id":id(12),"base_revision":1,"role":"prose"}),
            json!({"op":"set_type_fields","type_id":id(1),"base_revision":1,"fields":[id(10),id(11),id(12)]}),
        ],
    );
    (dir, nb)
}
fn member(nb: &mut Notebook, n: u128, text: &str) {
    apply(
        nb,
        vec![
            insert(n, &id(2), text),
            json!({"op":"add_type","id":id(n),"base_revision":1,"title":"Italian word"}),
        ],
    );
}
fn assert_progress(before: &CardUnit, after: &CardUnit) {
    assert_eq!(before.id, after.id);
    assert_eq!(before.schedule, after.schedule);
    assert_eq!(before.held, after.held);
}

#[test]
fn atom_text_patterns_validate_and_resolve_extras_without_making_empty_cards() {
    let (_dir, mut nb) = fixture();
    member(&mut nb, 100, "il lavello");
    apply(
        &mut nb,
        vec![
            insert(110, &id(100), &format!("[[{}]]", id(10))),
            insert(111, &id(110), "the sink"),
            insert(112, &id(100), &format!("[[{}]]", id(11))),
            insert(113, &id(112), "/laˈvɛllo/"),
            insert(114, &id(100), &format!("[[{}]]", id(12))),
            insert(115, &id(114), "Il lavello è sotto la finestra."),
            recipe(50, false),
            enable(50),
        ],
    );
    let card = nb.source_cards(&id(100)).unwrap().remove(0);
    assert_eq!((&*card.front, &*card.back), ("il lavello", "the sink"));
    let provenance = card.template.unwrap();
    assert_eq!(provenance.front_label, "Atom text");
    assert_eq!(provenance.back_label, "Meaning");
    assert_eq!(provenance.hint.unwrap().value, "/laˈvɛllo/");
    assert!(!provenance.details[0].prose);
    assert!(provenance.details[1].prose);
    let change = edit(&nb, 100, "");
    apply(&mut nb, vec![change]);
    assert!(!nb.source_cards(&id(100)).unwrap()[0].active);
    assert_eq!(
        nb.card_templates(&id(1)).unwrap()[0].missing,
        vec!["Atom text"]
    );
    let revision = nb.card_template(&id(50)).unwrap().revision;
    let update = |front: &str| {
        op(
            json!({"op":"update_card_template","id":id(50),"base_revision":revision,"name":"Recognize","front":front,"back":format!("{{{}}}",id(10)),"new_per_day":20}),
        )
    };
    for front in ["{@unknown}", "{@text", "{not-a-field}"] {
        assert!(
            nb.apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: vec![update(front)]
            })
            .is_err()
        );
    }
    let change = edit(&nb, 100, "il lavello");
    apply(
        &mut nb,
        vec![
            change,
            serde_json::to_value(update("\\{@text} {@text}")).unwrap(),
        ],
    );
    assert_eq!(
        nb.source_cards(&id(100)).unwrap()[0].front,
        "{@text} il lavello"
    );
}

#[test]
fn every_explicit_syntax_shape_excludes_recipes_including_invalid_syntax() {
    let (_dir, mut nb) = fixture();
    for (index, text) in [
        "a <> b",
        "a >> b",
        "a << b",
        "a >>>",
        "a >>1.",
        "a ;; b",
        "{{c1::answer}}",
        "a >> b >> c",
    ]
    .into_iter()
    .enumerate()
    {
        let n = 100 + index as u128 * 10;
        member(&mut nb, n, text);
        apply(
            &mut nb,
            vec![
                insert(n + 1, &id(n), &format!("[[{}]]", id(10))),
                insert(n + 2, &id(n + 1), "answer"),
            ],
        );
    }
    apply(&mut nb, vec![recipe(50, false), enable(50)]);
    for index in 0..8 {
        assert!(
            nb.source_cards(&id(100 + index * 10))
                .unwrap()
                .iter()
                .all(|card| !card.key.starts_with("tpl:"))
        );
    }
    member(&mut nb, 200, "`a >> b`");
    apply(
        &mut nb,
        vec![
            insert(201, &id(200), &format!("[[{}]]", id(10))),
            insert(202, &id(201), "literal"),
        ],
    );
    assert_eq!(
        nb.source_cards(&id(200))
            .unwrap()
            .iter()
            .filter(|card| card.key.starts_with("tpl:"))
            .count(),
        1
    );
}

#[test]
fn conversion_and_inverse_replay_keep_identity_schedule_events_and_paused_directions() {
    let (_dir, mut hub) = fixture();
    for (n, text) in [
        (100, "il lavello <> the sink"),
        (200, "misurare >> to measure"),
        (300, "rubinetto << tap"),
    ] {
        member(&mut hub, n, text);
    }
    let first = hub.source_cards(&id(100)).unwrap().remove(0);
    apply(
        &mut hub,
        vec![
            json!({"op":"grade_card","id":first.id,"base_revision":first.revision,"definition_revision":first.definition_revision,"event_id":id(900),"session_id":null,"grade":"good","reset":false,"shown_front":first.front,"shown_back":first.back,"reviewed_at":tessera_core::now_ms()}),
        ],
    );
    let held = hub.source_cards(&id(100)).unwrap().remove(1);
    apply(
        &mut hub,
        vec![json!({"op":"set_card_held","id":held.id,"base_revision":held.revision,"held":true})],
    );
    let originals: Vec<_> = [100, 200, 300]
        .into_iter()
        .flat_map(|n| hub.source_cards(&id(n)).unwrap())
        .collect();
    let events = hub.review_events(&first.id).unwrap();
    let replica_dir = tempfile::tempdir().unwrap();
    let ticket = hub
        .sync_clone(&replica_dir.path().join(DATABASE_FILE))
        .unwrap()
        .finish()
        .unwrap();
    let mut replica = Notebook::open(replica_dir.path()).unwrap();
    replica.sync_adopt("in-process", &ticket).unwrap();
    let mut conversion = vec![recipe(50, false), enable(50), recipe(51, true), enable(51)];
    for (n, text, answer) in [
        (100, "il lavello", "the sink"),
        (200, "misurare", "to measure"),
        (300, "rubinetto", "tap"),
    ] {
        conversion.extend([
            edit(&replica, n, text),
            insert(n + 1, &id(n), &format!("[[{}]]", id(10))),
            insert(n + 2, &id(n + 1), answer),
        ]);
        for (direction, recipe) in [("forward", 50), ("reverse", 51)] {
            let old = originals
                .iter()
                .find(|card| card.source_block_id == id(n) && card.key == direction);
            conversion.push(json!({"op":"transfer_card_key","source_id":id(n),"key":direction,"to_key":format!("tpl:{}",id(recipe)),"base_revision":old.map(|card|card.revision),"held":old.is_none_or(|card|card.held)}));
        }
    }
    apply(&mut replica, conversion);
    replica.sync_with(&mut hub).unwrap();
    for n in [100, 200, 300] {
        let cards = replica.source_cards(&id(n)).unwrap();
        assert_eq!(cards.len(), 2);
        assert_eq!(
            serde_json::to_value(&cards).unwrap(),
            serde_json::to_value(hub.source_cards(&id(n)).unwrap()).unwrap()
        );
        for card in &cards {
            if let Some(old) = originals.iter().find(|old| old.id == card.id) {
                assert_progress(old, card);
            } else {
                assert!(card.held);
                assert!(card.schedule.last_reviewed_at.is_none());
            }
        }
    }
    assert_eq!(hub.review_events(&first.id).unwrap(), events);
    let mut inverse = Vec::new();
    for (n, text) in [
        (100, "il lavello <> the sink"),
        (200, "misurare >> to measure"),
        (300, "rubinetto << tap"),
    ] {
        for card in replica.source_cards(&id(n)).unwrap() {
            let old = originals.iter().find(|old| old.id == card.id);
            inverse.push(json!({"op":"transfer_card_key","source_id":id(n),"key":card.key,"to_key":old.map(|old|&old.key),"base_revision":card.revision,"held":old.is_none_or(|old|old.held)}));
        }
        inverse.push(edit(&replica, n, text));
        inverse.push(json!({"op":"delete","id":id(n+1),"base_revision":replica.block(&id(n+1)).unwrap().revision}));
    }
    for n in [50, 51] {
        inverse.push(json!({"op":"delete_card_template","id":id(n),"base_revision":replica.card_template(&id(n)).unwrap().revision}));
    }
    apply(&mut replica, inverse);
    replica.sync_with(&mut hub).unwrap();
    assert!(hub.card_templates(&id(1)).unwrap().is_empty());
    for old in &originals {
        let restored = replica.card(&old.id).unwrap();
        assert_progress(old, &restored);
        assert_eq!(old.key, restored.key);
        assert_eq!(old.front, restored.front);
        assert_eq!(old.back, restored.back);
        assert!(restored.active);
    }
    for n in [100, 200, 300] {
        assert_eq!(
            replica.block(&id(n)).unwrap().text,
            hub.block(&id(n)).unwrap().text
        );
        assert_eq!(
            replica.source_cards(&id(n)).unwrap().len(),
            originals
                .iter()
                .filter(|card| card.source_block_id == id(n))
                .count()
        );
        assert!(replica.block(&id(n + 1)).is_err());
    }
    assert_eq!(hub.review_events(&first.id).unwrap(), events);
}
