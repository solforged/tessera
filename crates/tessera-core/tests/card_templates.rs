use tessera_core::scheduler::Grade;
use tessera_core::{
    Actor, Batch, CardQuery, CardSelection, CardUnit, ChangeStamp, Error, Notebook, Operation,
};

fn id(n: u128) -> String {
    ulid::Ulid::from(n).to_string()
}
fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    }
}
fn apply(nb: &mut Notebook, operations: Vec<Operation>) {
    nb.apply(&batch(operations)).unwrap();
}
fn insert(n: u128, parent: &str, text: &str) -> Operation {
    Operation::Insert {
        id: id(n),
        parent_id: parent.into(),
        after: None,
        text: text.into(),
        heading: None,
    }
}
fn create() -> Operation {
    Operation::CreateCardTemplate {
        id: id(50),
        type_id: id(1),
        name: "Recognition".into(),
        front: format!("{{{}}}", id(10)),
        back: format!("{{{}}}", id(11)),
        new_per_day: 2,
    }
}
fn applied(nb: &mut Notebook, value: bool) {
    let revision = nb.card_template(&id(50)).unwrap().revision;
    apply(
        nb,
        vec![Operation::SetCardTemplateApplied {
            id: id(50),
            base_revision: revision,
            applied: value,
        }],
    );
}
fn edit(nb: &mut Notebook, n: u128, text: &str) {
    let revision = nb.block(&id(n)).unwrap().revision;
    apply(
        nb,
        vec![Operation::EditText {
            id: id(n),
            base_revision: revision,
            text: text.into(),
        }],
    );
}
fn unit(nb: &Notebook, n: u128) -> CardUnit {
    nb.source_cards(&id(n))
        .unwrap()
        .into_iter()
        .find(|c| c.key.starts_with("tpl:"))
        .unwrap()
}
fn queue(nb: &Notebook, now: i64) -> Vec<CardUnit> {
    nb.card_query(
        &CardQuery {
            source: None,
            selection: CardSelection::New,
            limit: None,
        },
        now,
    )
    .unwrap()
    .rows
    .into_iter()
    .map(|row| row.card)
    .collect()
}
fn grade(nb: &mut Notebook, card: &CardUnit, event: u128, at: i64) {
    apply(
        nb,
        vec![Operation::GradeCard {
            id: card.id.clone(),
            base_revision: card.revision,
            definition_revision: card.definition_revision,
            event_id: id(event),
            session_id: None,
            grade: Grade::Good,
            reset: false,
            shown_front: card.front.clone(),
            shown_back: card.back.clone(),
            reviewed_at: at,
        }],
    );
}

fn fixture(count: usize, ready: usize) -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Vocab".into(),
            },
            Operation::CreatePage {
                id: id(2),
                title: "Greek vocabulary".into(),
            },
            insert(10, &fields, "Lemma"),
            insert(11, &fields, "Gloss"),
            insert(12, &fields, "Part of speech"),
            Operation::SetTypeFields {
                type_id: id(1),
                base_revision: 1,
                fields: vec![id(10), id(11), id(12)],
            },
            Operation::SetSetting {
                key: "time_zone".into(),
                base_revision: None,
                value: "UTC".into(),
            },
        ],
    );
    let mut operations = Vec::new();
    for member in 0..count {
        let n = 100 + member as u128 * 10;
        operations.extend([
            insert(n, &id(2), &format!("Lemma {member} #Vocab")),
            insert(n + 1, &id(n), &format!("[[{}]]", id(10))),
            insert(n + 2, &id(n + 1), &format!("λόγος {member}")),
            insert(n + 3, &id(n), &format!("[[{}]]", id(11))),
        ]);
        if member < ready {
            operations.push(insert(n + 4, &id(n + 3), "reason"));
        }
    }
    for chunk in operations.chunks(500) {
        apply(&mut nb, chunk.to_vec());
    }
    apply(&mut nb, vec![create()]);
    (dir, nb)
}

#[test]
fn waiting_values_identity_schedule_and_field_renames() {
    let (_dir, mut nb) = fixture(12, 9);
    let now = tessera_core::now_ms();
    let forecast = nb.card_template_forecast(&id(50), 14, now).unwrap();
    assert_eq!(
        (
            forecast.members,
            forecast.ready,
            forecast.waiting_total,
            forecast.cards_to_create
        ),
        (12, 9, 3, 9)
    );
    assert_eq!(forecast.waiting[0].missing, vec!["Gloss"]);
    assert_eq!(forecast.days_to_introduce, 5);
    assert_eq!(forecast.load.iter().map(|day| day.added).sum::<usize>(), 9);
    assert!(nb.source_cards(&id(190)).unwrap().is_empty());
    applied(&mut nb, true);
    assert_eq!(nb.card_templates(&id(1)).unwrap()[0].units_active, 9);
    apply(&mut nb, vec![insert(194, &id(193), "flourishing")]);
    assert_eq!(unit(&nb, 190).back, "flourishing");
    let before = unit(&nb, 100);
    grade(&mut nb, &before, 9000, now + 1_000);
    let reviewed = unit(&nb, 100);
    edit(&mut nb, 104, "ruling faculty");
    let changed = unit(&nb, 100);
    assert_eq!(changed.id, before.id);
    assert_eq!(changed.schedule, reviewed.schedule);
    assert!(changed.definition_revision > reviewed.definition_revision);
    assert_eq!(changed.back, "ruling faculty");
    edit(&mut nb, 11, "Meaning");
    assert_eq!(unit(&nb, 100).id, before.id);
    assert_eq!(
        nb.card_templates(&id(1)).unwrap()[0].back_display,
        "{Meaning}"
    );
    edit(&mut nb, 104, "  ");
    assert!(!unit(&nb, 100).active);
    edit(&mut nb, 104, "ruling faculty");
    assert_eq!(unit(&nb, 100).schedule, reviewed.schedule);
    assert_eq!(unit(&nb, 100).template.unwrap().name, "Recognition");
}

#[test]
fn disable_enable_delete_undo_and_authored_derivation_coexist() {
    let (_dir, mut nb) = fixture(2, 2);
    applied(&mut nb, true);
    let before = unit(&nb, 100);
    edit(&mut nb, 100, "Authored >> answer #Vocab");
    assert_eq!(unit(&nb, 100).id, before.id);
    assert!(unit(&nb, 100).active);
    assert_eq!(nb.source_cards(&id(100)).unwrap().len(), 2);
    applied(&mut nb, false);
    assert!(!unit(&nb, 100).active);
    assert!(
        nb.source_cards(&id(100))
            .unwrap()
            .iter()
            .any(|c| c.key == "forward" && c.active)
    );
    applied(&mut nb, true);
    assert_eq!(unit(&nb, 100).id, before.id);
    let revision = nb.card_template(&id(50)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::DeleteCardTemplate {
            id: id(50),
            base_revision: revision,
        }],
    );
    assert!(!unit(&nb, 100).active);
    assert_eq!(unit(&nb, 100).schedule, before.schedule);
    // Delete's inverse recreates the same template ID, then restores its applied state.
    apply(
        &mut nb,
        vec![
            create(),
            Operation::SetCardTemplateApplied {
                id: id(50),
                base_revision: 1,
                applied: true,
            },
        ],
    );
    assert_eq!(unit(&nb, 100).id, before.id);
    assert_eq!(unit(&nb, 100).schedule, before.schedule);
    applied(&mut nb, false); // Apply's inverse.
    assert!(
        queue(&nb, tessera_core::now_ms())
            .iter()
            .all(|c| !c.key.starts_with("tpl:"))
    );
}

#[test]
fn daily_limit_counts_first_reviews_in_notebook_zone_and_preserves_authored_cards() {
    let (_dir, mut nb) = fixture(5, 5);
    applied(&mut nb, true);
    edit(&mut nb, 100, "one >> two #Vocab");
    let now: i64 = "2026-10-12T03:30:00Z"
        .parse::<jiff::Timestamp>()
        .unwrap()
        .as_millisecond();
    apply(
        &mut nb,
        vec![Operation::SetSetting {
            key: "time_zone".into(),
            base_revision: Some(1),
            value: "America/New_York".into(),
        }],
    );
    let cards = queue(&nb, now);
    assert_eq!(cards.iter().filter(|c| c.template.is_some()).count(), 2);
    assert_eq!(cards.iter().filter(|c| c.template.is_none()).count(), 1);
    let templates: Vec<_> = cards.into_iter().filter(|c| c.template.is_some()).collect();
    grade(&mut nb, &templates[0], 9001, now);
    assert_eq!(
        queue(&nb, now)
            .iter()
            .filter(|c| c.template.is_some())
            .count(),
        1
    );
    grade(&mut nb, &templates[1], 9002, now + 1);
    assert_eq!(
        queue(&nb, now + 2)
            .iter()
            .filter(|c| c.template.is_some())
            .count(),
        0
    );
    let next_day = now + 60 * 60 * 1000;
    assert_eq!(
        queue(&nb, next_day)
            .iter()
            .filter(|c| c.template.is_some())
            .count(),
        2
    );
    let forecast = nb.card_template_forecast(&id(50), 14, now + 2).unwrap();
    assert_eq!(forecast.load[0].added, 0);
    assert_eq!(forecast.load[1].added, 2);
    assert_eq!(forecast.cards_to_create, 0);
    assert_eq!(forecast.existing_units, 5);
}

#[test]
fn page_members_membership_changes_and_stale_grades() {
    let (_dir, mut nb) = fixture(1, 1);
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(70),
                title: "εὐδαιμονία".into(),
            },
            Operation::AddType {
                id: id(70),
                base_revision: 1,
                title: "Vocab".into(),
            },
            insert(71, &id(70), &format!("[[{}]]", id(10))),
            insert(72, &id(71), "εὐδαιμονία"),
            insert(73, &id(70), &format!("[[{}]]", id(11))),
            insert(74, &id(73), "flourishing"),
        ],
    );
    applied(&mut nb, true);
    let before = unit(&nb, 70);
    assert!(before.active);
    let revision = nb.block(&id(70)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::RemoveType {
            id: id(70),
            base_revision: revision,
            title: "Vocab".into(),
        }],
    );
    assert!(!unit(&nb, 70).active);
    let revision = nb.block(&id(70)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::AddType {
            id: id(70),
            base_revision: revision,
            title: "Vocab".into(),
        }],
    );
    let card = unit(&nb, 70);
    assert_eq!(card.id, before.id);
    let result = nb.apply(&batch(vec![
        Operation::EditText {
            id: id(74),
            base_revision: 1,
            text: "happiness".into(),
        },
        Operation::GradeCard {
            id: card.id.clone(),
            base_revision: card.revision,
            definition_revision: card.definition_revision,
            event_id: id(9999),
            session_id: None,
            grade: Grade::Good,
            reset: false,
            shown_front: card.front.clone(),
            shown_back: card.back.clone(),
            reviewed_at: tessera_core::now_ms(),
        },
    ]));
    assert!(matches!(result, Err(Error::Conflict { .. })));
    assert_eq!(nb.block(&id(74)).unwrap().text, "flourishing");
}

#[test]
fn patterns_validate_unknown_fields_escapes_revisions_and_linked_values() {
    let (_dir, mut nb) = fixture(1, 1);
    let update = |front: String, revision| Operation::UpdateCardTemplate {
        id: id(50),
        base_revision: revision,
        name: "Recognition".into(),
        front,
        back: format!("{{{}}}", id(11)),
        new_per_day: 2,
    };
    assert!(
        nb.apply(&batch(vec![update(format!("{{{}}}", id(999)), 1)]))
            .is_err()
    );
    assert!(matches!(
        nb.apply(&batch(vec![update("literal".into(), 2)])),
        Err(Error::Conflict { .. })
    ));
    apply(
        &mut nb,
        vec![
            Operation::SetFieldKind {
                id: id(11),
                base_revision: 1,
                kind: tessera_core::FieldKind::Instance,
            },
            Operation::CreatePage {
                id: id(80),
                title: "Ruling faculty".into(),
            },
            update(format!("\\{{literal}} {{{}}}", id(10)), 1),
        ],
    );
    edit(&mut nb, 104, &format!("[[{}]]", id(80)));
    applied(&mut nb, true);
    assert_eq!(unit(&nb, 100).front, "{literal} λόγος 0");
    assert_eq!(unit(&nb, 100).back, "Ruling faculty");
    edit(&mut nb, 80, "Reason");
    assert_eq!(unit(&nb, 100).back, "Reason");
}

#[test]
fn thousand_member_apply_is_one_revisioned_transaction_and_waiting_is_capped() {
    let (_dir, mut nb) = fixture(1000, 940);
    let before = nb.changes_since(0, 10_000).unwrap().len();
    let stamp = ChangeStamp {
        id: id(99000),
        origin: nb.info().unwrap().id,
        at: tessera_core::now_ms(),
    };
    let receipt = nb
        .apply_stamped(
            &batch(vec![Operation::SetCardTemplateApplied {
                id: id(50),
                base_revision: 1,
                applied: true,
            }]),
            &stamp,
        )
        .unwrap();
    assert_eq!(receipt.cards.len(), 940);
    assert_eq!(nb.changes_since(0, 10_000).unwrap().len(), before + 1);
    let forecast = nb.card_template_forecast(&id(50), 14, stamp.at).unwrap();
    assert_eq!(
        (
            forecast.ready,
            forecast.waiting_total,
            forecast.waiting.len()
        ),
        (940, 60, 50)
    );
    assert_eq!(nb.card_templates(&id(1)).unwrap()[0].units_active, 940);
    assert_eq!(queue(&nb, stamp.at).len(), 2);
}
