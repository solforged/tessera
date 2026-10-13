use tessera_core::{Actor, Batch, Notebook, Operation};

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
fn insert(value: u128, parent: u128, after: Option<u128>, text: &str) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: id(parent),
        after: after.map(id),
        text: text.into(),
        heading: None,
    }
}
fn fixture() -> (tempfile::TempDir, Notebook) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            Operation::CreatePage {
                id: id(1),
                title: "Reading inbox".into(),
            },
            Operation::CreatePage {
                id: id(2),
                title: "Not a journal".into(),
            },
            Operation::CreateJournal {
                id: id(3),
                date: "2026-10-11".into(),
            },
            Operation::CreateJournal {
                id: id(4),
                date: "2026-10-12".into(),
            },
            Operation::CreateJournal {
                id: id(5),
                date: "2026-01-01".into(),
            },
            insert(
                10,
                3,
                None,
                &format!("Some [[{}]] notes [[{}]]", id(1), id(1)),
            ),
            insert(11, 10, None, "Older first"),
            insert(12, 10, Some(11), "Older second"),
            insert(13, 11, None, "Grandchild, not an arrival"),
            insert(20, 4, None, &format!("[[{}]]", id(1))),
            insert(21, 20, None, "Newer first"),
            insert(22, 20, Some(21), "Newer second"),
            insert(23, 4, Some(20), &format!("[[{}]]", id(1))),
            insert(30, 2, None, &format!("[[{}]]", id(1))),
            insert(31, 30, None, "Not from a journal"),
            insert(40, 5, None, &format!("[[{}]]", id(1))),
            insert(41, 40, None, "Outside the date window"),
        ],
    );
    (dir, nb)
}

#[test]
fn arrivals_are_newest_first_direct_journal_children_and_bounded() {
    let (_dir, nb) = fixture();
    let arrivals = nb.stream_arrivals(&id(1), "2026-10-12", 100, 200).unwrap();
    assert_eq!(
        arrivals
            .iter()
            .map(|row| row.block.id.clone())
            .collect::<Vec<_>>(),
        [21, 22, 11, 12].map(id)
    );
    assert_eq!(arrivals[0].page.text, "2026-10-12");
    assert_eq!(arrivals[0].anchor_id, id(20));
    assert_eq!(
        nb.stream_arrivals(&id(1), "2026-10-12", 1, 200)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        nb.stream_arrivals(&id(1), "2026-10-12", 100, 1).unwrap()[0]
            .block
            .id,
        id(21)
    );
    assert!(
        nb.stream_arrivals(&id(1), "2026-10-12", 100, 0)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        nb.stream_arrivals(&id(1), "2026-10-12", usize::MAX, usize::MAX)
            .unwrap()
            .len(),
        4
    );
}

#[test]
fn filing_excludes_only_whole_row_references_and_undo_restores_arrivals() {
    let (_dir, mut nb) = fixture();
    apply(
        &mut nb,
        vec![
            insert(50, 1, None, "Section"),
            insert(51, 50, None, &format!("\u{a0}[[{}]]\n", id(21))),
            insert(52, 1, Some(50), &format!("Discuss [[{}]]", id(22))),
            insert(53, 1, Some(52), &format!("(({}))", id(11))),
            insert(54, 1, Some(53), &format!("[[{}|alias]]", id(12))),
        ],
    );
    let arrivals = nb.stream_arrivals(&id(1), "2026-10-12", 100, 200).unwrap();
    assert_eq!(
        arrivals
            .iter()
            .map(|row| row.block.id.clone())
            .collect::<Vec<_>>(),
        [22, 11, 12].map(id)
    );
    apply(
        &mut nb,
        vec![Operation::Delete {
            id: id(51),
            base_revision: 1,
        }],
    );
    assert_eq!(
        nb.stream_arrivals(&id(1), "2026-10-12", 100, 200).unwrap()[0]
            .block
            .id,
        id(21)
    );
    assert_eq!(nb.block(&id(21)).unwrap().parent_id, Some(id(20)));
}

#[test]
fn field_entries_under_an_anchor_are_not_arrivals() {
    let (_dir, mut nb) = fixture();
    let fields = nb.fields().unwrap().page_id;
    let definition = ulid::Ulid::from(60u128).to_string();
    apply(
        &mut nb,
        vec![
            Operation::Insert {
                id: definition.clone(),
                parent_id: fields,
                after: None,
                text: "Project".into(),
                heading: None,
            },
            insert(61, 20, Some(22), &format!("[[{definition}]]")),
            insert(62, 61, None, "Tessera Android"),
        ],
    );
    let arrivals = nb.stream_arrivals(&id(1), "2026-10-12", 100, 200).unwrap();
    assert!(arrivals.iter().all(|row| row.block.id != id(61)));
    assert!(arrivals.iter().any(|row| row.block.id == id(22)));
}

#[test]
fn batch_subtrees_preserve_preorder_and_report_each_cap_and_missing_target() {
    let (_dir, nb) = fixture();
    let result = nb.subtrees(&[id(10), id(20), id(999)], 3, 4).unwrap();
    assert!(result.truncated);
    assert_eq!(
        result.trees[0]
            .rows
            .iter()
            .map(|row| (row.block.id.clone(), row.depth))
            .collect::<Vec<_>>(),
        vec![(id(10), 0), (id(11), 1), (id(13), 2)]
    );
    assert_eq!(result.trees[0].page.as_ref().unwrap().id, id(3));
    assert!(result.trees[0].truncated);
    assert_eq!(result.trees[1].rows.len(), 1);
    assert!(result.trees[1].truncated);
    assert!(result.trees[2].rows.is_empty());
    assert!(!result.trees[2].truncated);
    let complete = nb.subtrees(&[id(10), id(10), id(20)], 200, 4096).unwrap();
    assert_eq!(complete.trees.len(), 2);
    assert!(!complete.truncated);
    let empty = nb.subtrees(&[id(10), id(999)], 0, 0).unwrap();
    assert!(empty.trees[0].rows.is_empty());
    assert!(empty.trees[0].truncated);
    assert!(!empty.trees[1].truncated);
    assert!(nb.subtrees(&vec![id(10); 257], 200, 4096).is_err());
}

#[test]
fn batch_and_arrival_hard_caps_cannot_be_raised_by_callers() {
    let (_dir, mut nb) = fixture();
    let mut operations = Vec::new();
    for value in 100..320 {
        operations.push(insert(
            value,
            if value == 100 { 20 } else { value - 1 },
            None,
            "Nested",
        ));
    }
    for value in 400..620 {
        operations.push(insert(
            value,
            20,
            if value == 400 {
                Some(100)
            } else {
                Some(value - 1)
            },
            "Arrival",
        ));
    }
    apply(&mut nb, operations);
    let trees = nb
        .subtrees(
            &(100..122).map(id).collect::<Vec<_>>(),
            usize::MAX,
            usize::MAX,
        )
        .unwrap();
    assert_eq!(
        trees
            .trees
            .iter()
            .map(|tree| tree.rows.len())
            .sum::<usize>(),
        4096
    );
    assert!(trees.trees.iter().all(|tree| tree.rows.len() <= 200));
    assert!(trees.truncated);
    assert_eq!(
        nb.stream_arrivals(&id(1), "2026-10-12", 100, usize::MAX)
            .unwrap()
            .len(),
        200
    );
}
