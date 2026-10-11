use tessera_core::{
    Actor, Batch, Committed, Error, FieldKind, Notebook, Operation,
    library::{CreatorRole, ExtractedCreator, ExtractedMetadata},
};

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}

fn apply(nb: &mut Notebook, operations: Vec<Operation>) -> Committed {
    nb.apply(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    })
    .unwrap()
}

fn page(value: u128, title: &str) -> Operation {
    Operation::CreatePage {
        id: id(value),
        title: title.into(),
    }
}

fn insert(value: u128, parent: &str, after: Option<String>, text: &str) -> Operation {
    Operation::Insert {
        id: id(value),
        parent_id: parent.into(),
        after,
        text: text.into(),
        heading: None,
    }
}

fn tag(nb: &mut Notebook, value: u128, title: &str) {
    let base_revision = nb.block(&id(value)).unwrap().revision;
    apply(
        nb,
        vec![Operation::AddType {
            id: id(value),
            base_revision,
            title: title.into(),
        }],
    );
}

fn alias(nb: &mut Notebook, value: u128, name: &str) {
    assert!(
        nb.add_alias(&id(value), name, Actor::Person)
            .unwrap()
            .is_some()
    );
}

fn field_id(nb: &Notebook, name: &str) -> String {
    nb.fields()
        .unwrap()
        .fields
        .into_iter()
        .find(|field| field.definition.name == name)
        .unwrap()
        .definition
        .id
}

fn sequence(nb: &Notebook) -> i64 {
    nb.changes_since(0, usize::MAX)
        .unwrap()
        .last()
        .map_or(0, |change| change.seq)
}

#[test]
fn resolves_whole_names_with_case_diacritics_whitespace_and_punctuation_folding() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Cicero"),
            page(2, "Émile"),
            page(3, "東京"),
            page(4, "J. M. Keynes"),
            page(5, "Merleau-Ponty"),
            page(6, "Flann O’Brien"),
        ],
    );
    alias(&mut nb, 1, "Márçus  Tullius");
    let matched = nb.resolve_name("  MARCUS\tTULLIUS  ").unwrap();
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].page.id, id(1));
    assert_eq!(matched[0].alias.as_deref(), Some("Márçus  Tullius"));
    assert!(nb.resolve_name("Tullius").unwrap().is_empty());
    assert_eq!(nb.resolve_name("e\u{301}MILE").unwrap()[0].page.id, id(2));
    assert_eq!(nb.resolve_name("東京").unwrap()[0].page.id, id(3));
    assert!(nb.resolve_name("Dong Jing").unwrap().is_empty());
    assert!(nb.resolve_name(" \n ").unwrap().is_empty());
    assert_eq!(nb.resolve_name("j m keynes").unwrap()[0].page.id, id(4));
    assert_eq!(nb.resolve_name("J.M. Keynes").unwrap()[0].page.id, id(4));
    assert_eq!(nb.resolve_name("merleau ponty").unwrap()[0].page.id, id(5));
    assert_eq!(nb.resolve_name("Flann O'Brien").unwrap()[0].page.id, id(6));
    assert!(nb.resolve_name("...").unwrap().is_empty());
}

#[test]
fn shared_names_return_each_page_once_with_title_matches_first() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Pliny the Elder"),
            page(2, "Pliny the Younger"),
            page(3, "Pliny"),
        ],
    );
    alias(&mut nb, 1, "Pliny");
    alias(&mut nb, 2, "PLÍNY");
    let matches = nb.resolve_name("pliny").unwrap();
    assert_eq!(
        matches
            .iter()
            .map(|matched| matched.page.id.clone())
            .collect::<Vec<_>>(),
        [id(3), id(1), id(2)]
    );
    assert_eq!(matches[0].alias, None);
    assert_eq!(matches[1].alias.as_deref(), Some("Pliny"));
    assert_eq!(matches[2].alias.as_deref(), Some("PLÍNY"));
}

#[test]
fn aliases_ignore_hidden_pages_entries_values_and_nested_fields() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![page(1, "Visible"), page(2, "Archived"), page(3, "Deleted")],
    );
    for value in 1..=3 {
        alias(&mut nb, value, "Shared");
    }
    let archived_revision = nb.block(&id(2)).unwrap().revision;
    let deleted_revision = nb.block(&id(3)).unwrap().revision;
    let field = field_id(&nb, "Aliases");
    let value = nb
        .page(&id(1))
        .unwrap()
        .rows
        .into_iter()
        .find(|row| row.block.text == "Shared")
        .unwrap()
        .block;
    apply(
        &mut nb,
        vec![
            Operation::SetArchived {
                id: id(2),
                base_revision: archived_revision,
                archived: true,
            },
            Operation::Delete {
                id: id(3),
                base_revision: deleted_revision,
            },
            Operation::SetArchived {
                id: value.id,
                base_revision: value.revision,
                archived: true,
            },
            insert(10, &id(1), None, "Nested owner"),
            insert(11, &id(10), None, &format!("[[{field}]]")),
            insert(12, &id(11), None, "Nested alias"),
        ],
    );
    assert!(nb.resolve_name("Shared").unwrap().is_empty());
    assert!(nb.resolve_name("Archived").unwrap().is_empty());
    assert!(nb.resolve_name("Deleted").unwrap().is_empty());
    assert!(nb.resolve_name("Nested alias").unwrap().is_empty());
    assert!(nb.page_aliases(&id(1)).unwrap().is_empty());
    alias(&mut nb, 1, "Visible alias");
    let entry = nb
        .page(&id(1))
        .unwrap()
        .rows
        .into_iter()
        .find(|row| row.block.text == format!("[[{field}]]") && row.depth == 0)
        .unwrap()
        .block;
    apply(
        &mut nb,
        vec![Operation::SetArchived {
            id: entry.id,
            base_revision: entry.revision,
            archived: true,
        }],
    );
    assert!(nb.resolve_name("Visible alias").unwrap().is_empty());
    assert!(nb.complete("Visible alias", 20).unwrap().is_empty());
}

#[test]
fn completion_orders_titles_aliases_then_fts_and_carries_the_stored_alias() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Marcus first"),
            page(2, "Cicero"),
            page(3, "Notes"),
            insert(10, &id(3), None, "Marcus in the body"),
        ],
    );
    alias(&mut nb, 1, "Marcus title alias");
    alias(&mut nb, 2, "Márçus Tullius");
    let rows = nb.complete("marcus", 20).unwrap();
    assert_eq!(rows[0].block.id, id(1));
    assert_eq!(rows[0].alias, None);
    assert_eq!(rows[1].block.id, id(2));
    assert_eq!(rows[1].alias.as_deref(), Some("Márçus Tullius"));
    assert!(
        rows[2..]
            .iter()
            .any(|row| row.block.id == id(10) && row.alias.is_none())
    );
    assert_eq!(rows.iter().filter(|row| row.block.id == id(1)).count(), 1);
    assert_eq!(
        rows.len(),
        3,
        "alias values are not separate FTS block hits"
    );
    let hits = nb.search("marcus", 20).unwrap();
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().any(|hit| hit.block.id == id(10)));
    assert!(
        hits.iter()
            .all(|hit| [id(1), id(10)].contains(&hit.block.id))
    );
    assert_eq!(nb.complete("marcus", 1).unwrap().len(), 1);
    assert_eq!(nb.complete("marcus", 2).unwrap().len(), 2);
    assert!(nb.complete("marcus", 0).unwrap().is_empty());
    let words = nb.complete("tull", 1).unwrap();
    assert_eq!(words[0].block.id, id(2));
    assert_eq!(words[0].alias.as_deref(), Some("Márçus Tullius"));
    assert_eq!(nb.complete(" MARCUS\tTU ", 1).unwrap()[0].block.id, id(2));
    let json = serde_json::to_value(&rows[1]).unwrap();
    assert_eq!(json["id"], id(2));
    assert_eq!(json["alias"], "Márçus Tullius");
    assert!(json.get("block").is_none());
}

#[test]
fn kind_index_merges_alias_targets_filters_redundancy_and_sorts_by_sort_as() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Pliny the Elder"),
            page(2, "Pliny the Younger"),
            page(3, "Paracelsus"),
        ],
    );
    for value in 1..=3 {
        tag(&mut nb, value, "Person");
    }
    alias(&mut nb, 1, "Pliny");
    alias(&mut nb, 2, "PLÍNY");
    alias(&mut nb, 3, "Theophrastus von Hohenheim");
    alias(
        &mut nb,
        3,
        "Philippus Aureolus Theophrastus Bombastus von Hohenheim",
    );
    let fields = nb.fields().unwrap().page_id;
    let aliases = field_id(&nb, "Aliases");
    apply(
        &mut nb,
        vec![
            insert(100, &fields, None, "Sort as"),
            insert(101, &id(2), None, &format!("[[{}]]", id(100))),
            insert(102, &id(101), None, "  Áardvark"),
            insert(103, &id(101), Some(id(102)), "Zulu"),
            insert(104, &id(3), None, &format!("[[{aliases}]]")),
            insert(105, &id(104), None, "PARACÉLSUS"),
            insert(106, &id(104), Some(id(105)), "  "),
            insert(107, &id(1), None, &format!("[[{aliases}]]")),
            insert(108, &id(107), None, "pliny"),
        ],
    );
    let index = nb.kind_notes("person").unwrap();
    assert_eq!(
        index
            .notes
            .iter()
            .map(|note| note.id.clone())
            .collect::<Vec<_>>(),
        [id(2), id(3), id(1)]
    );
    assert_eq!(index.notes[0].sort_as.as_deref(), Some("  Áardvark"));
    assert_eq!(index.notes[1].sort_as, None);
    assert_eq!(index.see.len(), 2);
    assert_eq!(
        index.see[0]
            .targets
            .iter()
            .map(|target| target.id.clone())
            .collect::<Vec<_>>(),
        [id(1), id(2)]
    );
    assert_eq!(index.see[1].alias, "Theophrastus von Hohenheim");
    assert_eq!(index.see[1].targets[0].id, id(3));
    assert_eq!(
        nb.note_index()
            .unwrap()
            .kinds
            .into_iter()
            .find(|kind| kind.kind.key == "person")
            .unwrap()
            .count,
        3
    );
    assert_eq!(
        nb.page_aliases(&id(3)).unwrap().len(),
        3,
        "redundant aliases still resolve"
    );
    assert_eq!(
        nb.resolve_name("Philippus Aureolus Theophrastus Bombastus von Hohenheim")
            .unwrap()[0]
            .page
            .id,
        id(3)
    );
    let completions = nb.complete("hohen", 20).unwrap();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].block.id, id(3));
    assert_eq!(
        completions[0].alias.as_deref(),
        Some("Theophrastus von Hohenheim")
    );
    assert!(nb.search("hohen", 20).unwrap().is_empty());
}

#[test]
fn add_alias_is_one_attributed_batch_and_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![page(1, "Cicero"), insert(10, &id(1), None, "Body")],
    );
    let before = sequence(&nb);
    for name in ["", "  \n ", " CÍCERO "] {
        assert!(nb.add_alias(&id(1), name, Actor::Person).unwrap().is_none());
    }
    assert_eq!(sequence(&nb), before);
    let actor = Actor::Agent {
        name: "Alias helper".into(),
    };
    let committed = nb
        .add_alias(&id(1), "Tully", actor.clone())
        .unwrap()
        .unwrap();
    assert_eq!(committed.seq, before + 1);
    let changes = nb.changes_since(before, 10).unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].actor, actor);
    let field = field_id(&nb, "Aliases");
    let view = nb.page(&id(1)).unwrap();
    assert_eq!(view.rows[0].block.text, format!("[[{field}]]"));
    assert_eq!(view.rows[1].block.text, "Tully");
    assert_eq!(
        view.rows[1].block.parent_id.as_deref(),
        Some(view.rows[0].block.id.as_str())
    );
    assert_eq!(view.rows[2].block.id, id(10));
    let fields = nb.fields().unwrap();
    assert_eq!(
        fields
            .fields
            .iter()
            .find(|f| f.definition.id == field)
            .unwrap()
            .definition
            .kind,
        FieldKind::Text
    );
    assert!(
        nb.add_alias(&id(1), " túLLY ", Actor::Person)
            .unwrap()
            .is_none()
    );
    alias(&mut nb, 1, "Marcus Tullius Cicero");
    assert_eq!(
        nb.page_aliases(&id(1)).unwrap(),
        ["Tully", "Marcus Tullius Cicero"]
    );
    assert_eq!(
        nb.page(&id(1))
            .unwrap()
            .rows
            .iter()
            .filter(|row| row.depth == 0 && row.block.text == format!("[[{field}]]"))
            .count(),
        1
    );
}

#[test]
fn add_alias_follows_gloss_reuses_case_insensitive_field_and_empty_entry() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(&mut nb, vec![page(1, "Cicero"), page(2, "Plato")]);
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            insert(100, &fields, None, "Gloss"),
            insert(101, &fields, Some(id(100)), "aLiAsEs"),
            insert(10, &id(1), None, &format!("[[{}]]", id(100))),
            insert(11, &id(1), Some(id(10)), "Body"),
            insert(20, &id(2), None, &format!("[[{}]]", id(101))),
        ],
    );
    alias(&mut nb, 1, "Tully");
    alias(&mut nb, 2, "Aristocles");
    let view = nb.page(&id(1)).unwrap();
    assert_eq!(view.rows[0].block.id, id(10));
    assert_eq!(view.rows[1].block.text, format!("[[{}]]", id(101)));
    assert_eq!(view.rows[2].block.text, "Tully");
    assert_eq!(view.rows[3].block.id, id(11));
    let plato = nb.page(&id(2)).unwrap();
    assert_eq!(plato.rows.len(), 2);
    assert_eq!(plato.rows[1].block.parent_id, Some(id(20)));
    assert_eq!(nb.fields().unwrap().fields.len(), 2);
}

#[test]
fn starting_templates_use_existing_fields_and_preserve_authored_templates() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Pérson"),
            page(2, "Group"),
            page(3, "Concept"),
            page(4, "Thesis"),
        ],
    );
    let fields = nb.fields().unwrap().page_id;
    apply(
        &mut nb,
        vec![
            insert(100, &fields, None, "Aliases"),
            insert(10, &id(1), None, "Outline block"),
        ],
    );
    for (value, expected) in [
        (
            1,
            vec![
                ("Aliases", FieldKind::Text),
                ("Lived", FieldKind::Text),
                ("Affiliated with", FieldKind::Instance),
            ],
        ),
        (
            2,
            vec![("Aliases", FieldKind::Text), ("Active", FieldKind::Text)],
        ),
        (
            3,
            vec![
                ("Aliases", FieldKind::Text),
                ("Coined by", FieldKind::Instance),
                ("Coined in", FieldKind::Instance),
            ],
        ),
    ] {
        let seq = sequence(&nb);
        let committed = nb
            .apply_starting_template(&id(value), Actor::Person)
            .unwrap()
            .unwrap();
        assert_eq!(committed.seq, seq + 1);
        let template = nb.type_info(&id(value)).unwrap();
        assert_eq!(template.fields[0], id(100));
        let definitions = nb.fields().unwrap();
        let actual: Vec<_> = template
            .fields
            .iter()
            .map(|id| {
                let field = &definitions
                    .fields
                    .iter()
                    .find(|f| &f.definition.id == id)
                    .unwrap()
                    .definition;
                (field.name.as_str(), field.kind)
            })
            .collect();
        assert_eq!(actual, expected);
        assert!(
            nb.apply_starting_template(&id(value), Actor::Person)
                .unwrap()
                .is_none()
        );
        assert_eq!(sequence(&nb), committed.seq);
    }
    assert!(
        nb.apply_starting_template(&id(4), Actor::Person)
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        nb.apply_starting_template(&id(10), Actor::Person),
        Err(Error::Validation { .. })
    ));
    let base_revision = nb.block(&id(1)).unwrap().revision;
    apply(
        &mut nb,
        vec![Operation::SetTypeFields {
            type_id: id(1),
            base_revision,
            fields: vec![id(100)],
        }],
    );
    assert!(
        nb.apply_starting_template(&id(1), Actor::Person)
            .unwrap()
            .is_none()
    );
    assert_eq!(nb.type_info(&id(1)).unwrap().fields, [id(100)]);
}

#[test]
fn ingest_resolves_aliases_preserves_ambiguity_and_turns_creator_names_around() {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    apply(
        &mut nb,
        vec![
            page(1, "Cicero"),
            page(2, "Pliny the Elder"),
            page(3, "Pliny the Younger"),
        ],
    );
    alias(&mut nb, 1, "Marcus Tullius Cicero");
    alias(&mut nb, 1, "Tully");
    alias(&mut nb, 2, "Pliny");
    alias(&mut nb, 3, "Pliny");
    let metadata = ExtractedMetadata {
        title: Some("Collected works".into()),
        creators: [
            "TúLLY",
            "Pliny",
            "Cicero, Marcus Tullius",
            "Austen, Jane",
            "Jane Austen",
        ]
        .into_iter()
        .map(|name| ExtractedCreator {
            name: name.into(),
            role: CreatorRole::Author,
        })
        .collect(),
        ..Default::default()
    };
    let plan = nb.plan_source_record(&metadata).unwrap();
    let source = plan.source_id;
    apply(&mut nb, plan.operations);
    let author = field_id(&nb, "Author");
    let view = nb.page(&source).unwrap();
    let entry = view
        .rows
        .iter()
        .find(|row| row.block.text == format!("[[{author}]]"))
        .unwrap();
    let values: Vec<_> = view
        .rows
        .iter()
        .filter(|row| row.block.parent_id.as_deref() == Some(entry.block.id.as_str()))
        .map(|row| row.block.text.clone())
        .collect();
    let austen = nb.page_by_title("Jane Austen").unwrap().unwrap();
    assert_eq!(
        values,
        [
            format!("[[{}]]", id(1)),
            "[[Pliny]]".into(),
            format!("[[{}]]", id(1)),
            format!("[[{}]]", austen.id),
            format!("[[{}]]", austen.id)
        ]
    );
    assert!(nb.page_by_title("Pliny").unwrap().is_none());
    assert!(nb.page_by_title("TúLLY").unwrap().is_none());
    assert!(nb.page_by_title("Marcus Tullius Cicero").unwrap().is_none());
    assert!(
        nb.page_by_title("Cicero, Marcus Tullius")
            .unwrap()
            .is_none()
    );
}
