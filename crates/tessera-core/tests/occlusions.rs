use base64::Engine;
use tessera_core::card_text::CardKind;
use tessera_core::occlusion::{
    MaskShape, Occlusion, OcclusionGroup, OcclusionMask, OcclusionMode, Rect,
};
use tessera_core::scheduler::Grade;
use tessera_core::{Actor, Batch, CardQuery, CardSelection, CardUnit, Error, Notebook, Operation};

#[allow(dead_code)]
mod common;

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
fn state() -> Occlusion {
    Occlusion {
        mode: OcclusionMode::HideOne,
        groups: vec![
            OcclusionGroup {
                id: "z".into(),
                hint: Some("  hint  ".into()),
                answer: Some("  answer  ".into()),
                area: None,
            },
            OcclusionGroup {
                id: "a".into(),
                hint: None,
                answer: None,
                area: None,
            },
        ],
        masks: vec![
            OcclusionMask {
                id: "one".into(),
                group: "z".into(),
                shape: MaskShape::Rect,
                rect: Rect {
                    x: 0.1,
                    y: 0.2,
                    w: 0.2,
                    h: 0.3,
                },
            },
            OcclusionMask {
                id: "two".into(),
                group: "z".into(),
                shape: MaskShape::Ellipse,
                rect: Rect {
                    x: 0.4,
                    y: 0.2,
                    w: 0.2,
                    h: 0.3,
                },
            },
            OcclusionMask {
                id: "three".into(),
                group: "a".into(),
                shape: MaskShape::Rect,
                rect: Rect {
                    x: 0.7,
                    y: 0.2,
                    w: 0.2,
                    h: 0.3,
                },
            },
        ],
    }
}
fn setup() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    nb.apply(&batch(vec![
        Operation::CreatePage {
            id: id(1),
            title: "Masks".into(),
        },
        Operation::Insert {
            id: id(2),
            parent_id: id(1),
            after: None,
            text: "Question >> Answer".into(),
            heading: None,
        },
    ]))
    .unwrap();
    let bytes = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=").unwrap();
    let image = nb.put_image(&bytes).unwrap();
    nb.apply(&batch(vec![Operation::SetImage {
        id: id(2),
        base_revision: nb.block(&id(2)).unwrap().revision,
        image: Some(image),
    }]))
    .unwrap();
    (dir, nb)
}
fn set(nb: &mut Notebook, occlusion: Option<Occlusion>) {
    let op = Operation::SetOcclusion {
        id: id(2),
        base_revision: nb.block(&id(2)).unwrap().revision,
        occlusion,
    };
    nb.apply(&batch(vec![op])).unwrap();
}
fn card(nb: &Notebook, group: &str) -> CardUnit {
    nb.source_cards(&id(2))
        .unwrap()
        .into_iter()
        .find(|card| card.key == format!("occlusion:{group}"))
        .unwrap()
}
fn grade(nb: &mut Notebook, card: &CardUnit, event: u128) {
    nb.apply(&batch(vec![Operation::GradeCard {
        id: card.id.clone(),
        base_revision: card.revision,
        definition_revision: card.definition_revision,
        event_id: id(event),
        session_id: None,
        grade: Grade::Good,
        reset: false,
        shown_front: card.front.clone(),
        shown_back: card.back.clone(),
        reviewed_at: card.schedule.due_at + 1000,
    }]))
    .unwrap();
}

#[test]
fn groups_derive_canonical_sides_alongside_text_and_keep_progress_when_restored() {
    let (_dir, mut nb) = setup();
    set(&mut nb, Some(state()));
    let units = nb.source_cards(&id(2)).unwrap();
    assert_eq!(
        units
            .iter()
            .map(|card| card.key.as_str())
            .collect::<Vec<_>>(),
        ["forward", "occlusion:z", "occlusion:a"]
    );
    let first = card(&nb, "z");
    assert_eq!(first.kind, CardKind::Occlusion);
    assert_eq!(first.occlusion_index, Some(0));
    assert_eq!(card(&nb, "a").occlusion_index, Some(1));
    let image = nb.capabilities(&id(2)).unwrap().image.unwrap();
    assert_eq!(
        first.front,
        format!(
            "{{\"image\":{},\"mode\":\"hide_one\",\"tested\":[{{\"shape\":\"rect\",\"x\":0.1,\"y\":0.2,\"w\":0.2,\"h\":0.3}},{{\"shape\":\"ellipse\",\"x\":0.4,\"y\":0.2,\"w\":0.2,\"h\":0.3}}],\"hint\":\"hint\",\"covered\":[]}}",
            serde_json::to_string(&image).unwrap()
        )
    );
    assert_eq!(first.back, "{\"answer\":\"answer\"}");
    assert_eq!(card(&nb, "a").back, "{}");
    assert_eq!(tessera_core::occlusion::card_subject(&first), "answer");
    assert_eq!(
        tessera_core::occlusion::card_subject(&card(&nb, "a")),
        "Mask B"
    );
    grade(&mut nb, &first, 20);
    let schedule = nb.card(&first.id).unwrap().schedule;
    let mut removed = state();
    removed.groups.remove(0);
    removed.masks.retain(|mask| mask.group != "z");
    set(&mut nb, Some(removed));
    assert!(!nb.card(&first.id).unwrap().active);
    assert!(
        nb.source_cards(&id(2))
            .unwrap()
            .iter()
            .any(|card| card.key == "forward" && card.active)
    );
    set(&mut nb, Some(state()));
    let restored = card(&nb, "z");
    assert!(restored.active);
    assert_eq!(restored.id, first.id);
    assert_eq!(restored.schedule, schedule);
    let query = nb
        .card_query(
            &CardQuery {
                source: None,
                selection: CardSelection::All,
                limit: None,
            },
            i64::MAX,
        )
        .unwrap();
    assert_eq!(
        query
            .rows
            .iter()
            .find(|row| row.card.id == restored.id)
            .unwrap()
            .card
            .occlusion_index,
        Some(0)
    );
}

#[test]
fn hide_one_is_independent_and_hide_all_tracks_other_geometry() {
    let (_dir, mut nb) = setup();
    let mut masks = state();
    set(&mut nb, Some(masks.clone()));
    let first = card(&nb, "z");
    masks.masks[2].rect.x = 0.65;
    set(&mut nb, Some(masks.clone()));
    assert_eq!(card(&nb, "z").front, first.front);
    assert_eq!(
        card(&nb, "z").definition_revision,
        first.definition_revision
    );
    masks.mode = OcclusionMode::HideAll;
    set(&mut nb, Some(masks.clone()));
    let all = card(&nb, "z");
    assert_ne!(all.front, first.front);
    masks.masks[2].rect.y = 0.3;
    set(&mut nb, Some(masks));
    assert_ne!(card(&nb, "z").front, all.front);
}

#[test]
fn geometry_edit_rejects_the_previously_shown_card() {
    let (_dir, mut nb) = setup();
    let mut masks = state();
    set(&mut nb, Some(masks.clone()));
    let shown = card(&nb, "z");
    masks.masks[0].rect.x += 0.01;
    set(&mut nb, Some(masks));
    let current = card(&nb, "z");
    let result = nb.apply(&batch(vec![Operation::GradeCard {
        id: shown.id,
        base_revision: current.revision,
        definition_revision: shown.definition_revision,
        event_id: id(30),
        session_id: None,
        grade: Grade::Good,
        reset: false,
        shown_front: shown.front,
        shown_back: shown.back,
        reviewed_at: shown.schedule.due_at + 1000,
    }]));
    assert!(
        matches!(result, Err(Error::Validation { message, .. }) if message == "shown card definition is no longer current")
    );
}

#[test]
fn image_removal_suspends_masks_and_replacement_restores_them() {
    let (_dir, mut nb) = setup();
    set(&mut nb, Some(state()));
    let image = nb.capabilities(&id(2)).unwrap().image.unwrap();
    let first = card(&nb, "z");
    grade(&mut nb, &first, 40);
    let progress = card(&nb, "z").schedule;
    nb.apply(&batch(vec![Operation::SetImage {
        id: id(2),
        base_revision: nb.block(&id(2)).unwrap().revision,
        image: None,
    }]))
    .unwrap();
    assert!(!card(&nb, "z").active);
    assert!(nb.capabilities(&id(2)).unwrap().occlusion.is_some());
    nb.apply(&batch(vec![Operation::SetImage {
        id: id(2),
        base_revision: nb.block(&id(2)).unwrap().revision,
        image: Some(image),
    }]))
    .unwrap();
    assert!(card(&nb, "z").active);
    assert_eq!(card(&nb, "z").schedule, progress);
}

#[test]
fn validation_names_missing_images_and_invalid_masks_and_trims_text() {
    let (_dir, mut nb) = setup();
    for (invalid, reason) in [
        (
            {
                let mut value = state();
                value.masks[0].rect.x = 0.99;
                value
            },
            "a mask lies outside the image or is too small",
        ),
        (
            {
                let mut value = state();
                value.masks[0].group = "missing".into();
                value
            },
            "a mask has no group",
        ),
        (
            {
                let mut value = state();
                value.masks.retain(|mask| mask.group != "a");
                value
            },
            "a group has no masks",
        ),
        (
            {
                let mut value = state();
                value.groups[0].answer = Some("x".repeat(201));
                value
            },
            "a hint or answer is longer than 200 characters",
        ),
        (
            {
                let mut value = state();
                value.groups[0].area = Some(Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 0.001,
                    h: 1.0,
                });
                value
            },
            "an area lies outside the image or is too small",
        ),
    ] {
        let op = Operation::SetOcclusion {
            id: id(2),
            base_revision: nb.block(&id(2)).unwrap().revision,
            occlusion: Some(invalid),
        };
        assert!(
            matches!(nb.apply(&batch(vec![op])), Err(Error::Validation { message, .. }) if message == format!("These masks are not valid: {reason}."))
        );
    }
    let mut masks = state();
    masks.groups[0].hint = Some("  ".into());
    set(&mut nb, Some(masks));
    let stored = nb.capabilities(&id(2)).unwrap().occlusion.unwrap();
    assert_eq!(stored.groups[0].hint, None);
    assert_eq!(stored.groups[0].answer.as_deref(), Some("answer"));
    nb.apply(&batch(vec![Operation::SetImage {
        id: id(2),
        base_revision: nb.block(&id(2)).unwrap().revision,
        image: None,
    }]))
    .unwrap();
    let op = Operation::SetOcclusion {
        id: id(2),
        base_revision: nb.block(&id(2)).unwrap().revision,
        occlusion: Some(state()),
    };
    assert!(
        matches!(nb.apply(&batch(vec![op])), Err(Error::Validation { message, .. }) if message == "Add an image before drawing masks.")
    );
}

#[test]
fn migration_preserves_cards_reviews_undos_rowids_and_foreign_keys() {
    let (dir, mut nb) = setup();
    let card = nb.source_cards(&id(2)).unwrap().remove(0);
    grade(&mut nb, &card, 50);
    let graded = nb.card(&card.id).unwrap();
    nb.apply(&batch(vec![Operation::UndoGrade {
        id: card.id.clone(),
        base_revision: graded.revision,
        review_id: id(50),
        event_id: id(51),
        session_revision: None,
        undone_at: graded.schedule.last_reviewed_at.unwrap() + 1000,
    }]))
    .unwrap();
    let before = nb.card(&card.id).unwrap();
    let reviews = nb.review_events(&card.id).unwrap();
    drop(nb);
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    let rows = |conn: &rusqlite::Connection| -> Vec<(String, i64)> {
        ["card_units", "review_events", "review_undos"]
            .into_iter()
            .map(|table| {
                (
                    table.to_owned(),
                    conn.query_row(&format!("SELECT rowid FROM {table} LIMIT 1"), [], |row| {
                        row.get(0)
                    })
                    .unwrap(),
                )
            })
            .collect()
    };
    let before_rows = rows(&conn);
    common::restore_pre_occlusions(&conn);
    conn.pragma_update(None, "user_version", 48).unwrap();
    drop(conn);
    let nb = Notebook::open(dir.path()).unwrap();
    assert_eq!(nb.card(&card.id).unwrap(), before);
    assert_eq!(nb.review_events(&card.id).unwrap(), reviews);
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    assert_eq!(rows(&conn), before_rows);
    assert!(
        conn.prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query([])
            .unwrap()
            .next()
            .unwrap()
            .is_none()
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM effective_review_events", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
}
