use tessera_core::{Actor, Batch, Direction, Notebook, library::*};

#[test]
fn metadata_records_use_fields_without_reading_content_and_export() {
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(dir.path()).unwrap();
    let metadata = ExtractedMetadata {
        title: Some("A physical book".into()),
        subtitle: Some("An authored subtitle".into()),
        creators: vec![
            ExtractedCreator::new("Jane Austen".into(), CreatorRole::Author),
            ExtractedCreator::new("Pat Editor".into(), CreatorRole::Editor),
        ],
        published: Some("1813".into()),
        publisher: Some("A press".into()),
        language: Some("en".into()),
        identifiers: vec!["9780141439518".into()],
        cover: Some("/api/library/covers/cover-object".into()),
        ..Default::default()
    };
    let plan = notebook.plan_source_record(&metadata).unwrap();
    let id = plan.source_id;
    notebook
        .apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: plan.operations,
        })
        .unwrap();
    let source = notebook.source(&id).unwrap();
    assert_eq!(source.source.format, SourceFormat::Record);
    assert_eq!(source.source.state, ReadingState::Inbox);
    assert_eq!(source.source.siglum, "AUS");
    assert!(source.source.current_snapshot_id.is_none());
    assert!(source.snapshots.is_empty());
    assert!(source.toc.is_empty());
    assert_eq!(source.progress, 0.0);
    assert_eq!(
        notebook
            .highlights(&HighlightQuery {
                source_id: Some(id.clone()),
                ..Default::default()
            })
            .unwrap()
            .total,
        0
    );
    let row = notebook
        .library(&LibraryQuery::default())
        .unwrap()
        .rows
        .remove(0);
    assert_eq!(row.creators, ["Jane Austen"]);
    assert_eq!(row.published.as_deref(), Some("1813"));
    assert_eq!(row.cover, metadata.cover);
    let bib = notebook
        .export(std::slice::from_ref(&id), ExportFormat::Bibtex)
        .unwrap();
    assert!(bib.contains("@book{"));
    assert!(bib.contains("9780141439518"));
    assert!(bib.contains("Austen, Jane"));
    let mut paper = metadata;
    paper.title = Some("A paper without a PDF".into());
    paper.creators[0].name = "Zara Brown".into();
    paper.published = Some("2024-04".into());
    paper.identifiers = vec!["doi:10.1038/nature14539".into()];
    let plan = notebook.plan_source_record(&paper).unwrap();
    let paper_id = plan.source_id;
    notebook
        .apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: plan.operations,
        })
        .unwrap();
    let csl = notebook
        .export(std::slice::from_ref(&paper_id), ExportFormat::CslJson)
        .unwrap();
    assert!(csl.contains("10.1038/nature14539"));
    assert!(csl.contains("article-journal"));
    for (sort, direction, expected) in [
        (LibrarySort::Author, Direction::Asc, id),
        (LibrarySort::Year, Direction::Desc, paper_id),
    ] {
        assert_eq!(
            notebook
                .library(&LibraryQuery {
                    sort,
                    direction,
                    ..Default::default()
                })
                .unwrap()
                .rows[0]
                .page
                .id,
            expected
        );
    }
}

#[test]
fn identifiers_share_field_normalization_and_date_validation() {
    assert_eq!(
        Notebook::normalize_identifier("https://arxiv.org/pdf/hep-th/9901001v2.pdf").as_deref(),
        Some("arxiv:hep-th/9901001v2")
    );
    assert_eq!(
        Notebook::normalize_identifier("0-8044-2957-X").as_deref(),
        Some("isbn:9780804429573")
    );
    assert!(Notebook::normalize_identifier("9780804429574").is_none());
    assert!(Notebook::valid_publication_date("2024-02-29"));
    assert!(!Notebook::valid_publication_date("2023-02-29"));
    assert!(Notebook::valid_publication_date("1813"));
    assert!(Notebook::valid_publication_date("1813-01"));
    assert!(!Notebook::valid_publication_date("1813-13"));
}

#[test]
fn journal_locators_survive_record_plans_and_citation_exports() {
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(dir.path()).unwrap();
    for (title, volume, issue, locator) in [
        ("Russian blues", "104", "19", "7780-7785"),
        ("Future Tense", "10", "7", "e0132145"),
        ("Massive Migration", "522", "7555", "207-211"),
    ] {
        let metadata: ExtractedMetadata = serde_json::from_value(serde_json::json!({
            "title": title, "creators": [], "identifiers": ["doi:10.1038/nature14539"],
            "site": "Journal", "volume": volume, "issue": issue, "pages": locator
        }))
        .unwrap();
        let plan = notebook.plan_source_record(&metadata).unwrap();
        let id = plan.source_id;
        notebook
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: plan.operations,
            })
            .unwrap();
        let csl: serde_json::Value = serde_json::from_str(
            &notebook
                .export(std::slice::from_ref(&id), ExportFormat::CslJson)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(csl[0]["volume"], volume);
        assert_eq!(csl[0]["issue"], issue);
        assert_eq!(csl[0]["page"], locator);
        assert!(csl[0].get("number-of-pages").is_none());
        let bib = notebook
            .export(std::slice::from_ref(&id), ExportFormat::Bibtex)
            .unwrap();
        let markdown = notebook
            .export(std::slice::from_ref(&id), ExportFormat::Markdown)
            .unwrap();
        assert!(markdown.contains(&format!("Volume: {volume}")));
        assert!(markdown.contains(&format!("Issue: {issue}")));
        assert!(markdown.contains(&format!("Page range: {locator}")));
        for field in [
            format!("volume = {{{volume}}}"),
            format!("number = {{{issue}}}"),
            format!("pages = {{{locator}}}"),
        ] {
            assert!(bib.contains(&field), "{bib}");
        }
    }
}

#[test]
fn bibtex_and_csl_agree_on_source_kind_and_journal_container() {
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(dir.path()).unwrap();
    for (title, identifiers, bib_type, csl_type, container) in [
        (
            "Book",
            vec!["isbn:9780141439518".into()],
            "book",
            "book",
            "organization",
        ),
        (
            "Paper",
            vec!["doi:10.1038/nature14539".into()],
            "article",
            "article-journal",
            "journal",
        ),
        ("Web page", vec![], "online", "webpage", "organization"),
    ] {
        let metadata = ExtractedMetadata {
            title: Some(title.into()),
            identifiers,
            site: Some("Publication".into()),
            ..Default::default()
        };
        let plan = notebook.plan_source_record(&metadata).unwrap();
        let id = plan.source_id;
        notebook
            .apply(&Batch {
                actor: Actor::Person,
                reason: None,
                idempotency_key: None,
                operations: plan.operations,
            })
            .unwrap();
        let bib = notebook
            .export(std::slice::from_ref(&id), ExportFormat::Bibtex)
            .unwrap();
        assert!(bib.starts_with(&format!("@{bib_type}{{")), "{bib}");
        assert!(
            bib.contains(&format!("{container} = {{Publication}}")),
            "{bib}"
        );
        if container == "journal" {
            assert!(!bib.contains("organization ="));
        }
        let csl: serde_json::Value = serde_json::from_str(
            &notebook
                .export(std::slice::from_ref(&id), ExportFormat::CslJson)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(csl[0]["type"], csl_type);
        assert_eq!(csl[0]["container-title"], "Publication");
    }
}

#[test]
fn organisation_and_combined_creators_never_become_individual_people() {
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(dir.path()).unwrap();
    let metadata: ExtractedMetadata = serde_json::from_value(serde_json::json!({
        "title": "Creator kinds", "identifiers": [], "creators": [
            {"name": "Stanford Encyclopedia of Philosophy", "role": "author", "kind": "organisation"},
            {"name": "The Editors of Encyclopaedia Britannica", "role": "editor", "kind": "organisation"},
            {"name": "Berlin and Kay", "role": "author"},
            {"name": "Russel Gray/Laura Weißert", "role": "author"}
        ]
    })).unwrap();
    let plan = notebook.plan_source_record(&metadata).unwrap();
    notebook
        .apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: plan.operations,
        })
        .unwrap();
    assert!(notebook.kind_notes("person").unwrap().notes.is_empty());
    let groups = notebook.kind_notes("group").unwrap();
    assert_eq!(groups.notes.len(), 2);
    assert!(
        groups
            .notes
            .iter()
            .any(|note| note.title == "Stanford Encyclopedia of Philosophy")
    );
    for title in ["Berlin and Kay", "Russel Gray/Laura Weißert"] {
        assert!(notebook.page_by_title(title).unwrap().is_none());
    }
}

#[test]
fn plain_creator_opt_in_preserves_long_ordered_bylines_without_entity_pages() {
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(dir.path()).unwrap();
    let metadata = ExtractedMetadata {
        title: Some("Long author list".into()),
        creators: (0..38)
            .map(|index| ExtractedCreator {
                create_page: false,
                ..ExtractedCreator::new(format!("Author Family{index}"), CreatorRole::Author)
            })
            .collect(),
        ..Default::default()
    };
    let plan = notebook.plan_source_record(&metadata).unwrap();
    let id = plan.source_id;
    notebook
        .apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: plan.operations,
        })
        .unwrap();
    assert!(notebook.kind_notes("person").unwrap().notes.is_empty());
    let row = notebook
        .library(&LibraryQuery::default())
        .unwrap()
        .rows
        .remove(0);
    assert_eq!(
        row.creators,
        metadata
            .creators
            .iter()
            .map(|creator| creator.name.clone())
            .collect::<Vec<_>>()
    );
    assert!(row.people.iter().all(|creator| creator.id.is_none()));
    let csl: serde_json::Value = serde_json::from_str(
        &notebook
            .export(std::slice::from_ref(&id), ExportFormat::CslJson)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(csl[0]["author"].as_array().unwrap().len(), 38);
    for index in 0..38 {
        assert_eq!(csl[0]["author"][index]["family"], format!("Family{index}"));
        assert_eq!(csl[0]["author"][index]["given"], "Author");
    }
    let bib = notebook
        .export(std::slice::from_ref(&id), ExportFormat::Bibtex)
        .unwrap();
    let authors = (0..38)
        .map(|index| format!("Family{index}, Author"))
        .collect::<Vec<_>>()
        .join(" and ");
    assert!(bib.contains(&format!("author = {{{authors}}}")), "{bib}");
}

fn id(value: u128) -> String {
    ulid::Ulid::from(value).to_string()
}
fn apply(notebook: &mut Notebook, operations: Vec<tessera_core::Operation>) {
    notebook
        .apply(&Batch {
            actor: Actor::Person,
            reason: None,
            idempotency_key: None,
            operations,
        })
        .unwrap();
}
fn insert(value: u128, parent: &str, text: &str) -> tessera_core::Operation {
    tessera_core::Operation::Insert {
        id: id(value),
        parent_id: parent.into(),
        after: None,
        text: text.into(),
        heading: None,
    }
}
/// A manual record, as `#source` or a source action makes one: no key of its own.
fn record(value: u128, citation_key: Option<&str>) -> tessera_core::Operation {
    tessera_core::Operation::SetSource {
        id: id(value),
        base_revision: 1,
        source: Some(SourceState {
            format: SourceFormat::Record,
            state: ReadingState::Inbox,
            origin: None,
            match_key: None,
            citation_key: citation_key.map(str::to_owned),
        }),
    }
}
fn key(notebook: &Notebook, value: u128) -> Option<String> {
    notebook.source(&id(value)).unwrap().source.citation_key
}
/// An authored edit that clears the key and keeps the rest of the source's state.
fn clear_key(notebook: &mut Notebook, value: u128) {
    let mut state = notebook.source(&id(value)).unwrap().source.source_state();
    state.citation_key = None;
    let base_revision = notebook.block(&id(value)).unwrap().revision;
    apply(
        notebook,
        vec![tessera_core::Operation::SetSource {
            id: id(value),
            base_revision,
            source: Some(state),
        }],
    );
}

#[test]
fn manual_sources_get_a_citation_key_from_their_fields_when_made() {
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(dir.path()).unwrap();
    let fields = notebook.fields().unwrap().page_id;
    apply(
        &mut notebook,
        vec![
            insert(10, &fields, "author"),
            insert(11, &fields, "published"),
        ],
    );
    // A `#source` page filed with its author and date in one change, as agent notes are.
    let filed = |page: u128, title: &str, author: &str, year: &str| {
        vec![
            tessera_core::Operation::CreatePage {
                id: id(page),
                title: title.into(),
            },
            insert(page * 100, &id(page), &format!("[[{}]]", id(10))),
            insert(page * 100 + 1, &id(page * 100), author),
            insert(page * 100 + 2, &id(page), &format!("[[{}]]", id(11))),
            insert(page * 100 + 3, &id(page * 100 + 2), year),
        ]
    };
    apply(
        &mut notebook,
        filed(
            1,
            "Attention Is All You Need #source",
            "Ashish Vaswani",
            "2017-06-12",
        ),
    );
    assert_eq!(key(&notebook, 1).as_deref(), Some("vaswani2017attention"));
    let bib = notebook.export(&[id(1)], ExportFormat::Bibtex).unwrap();
    assert!(bib.contains("{vaswani2017attention,"), "{bib}");

    // A source action's record keys the same way; a collision takes the next suffix.
    let mut operations = filed(2, "Attention, revisited", "Vaswani, Ashish", "2017");
    operations.push(record(2, None));
    apply(&mut notebook, operations);
    assert_eq!(key(&notebook, 2).as_deref(), Some("vaswani2017attentiona"));

    // An authored key wins, and a record with no fields still gets one.
    apply(
        &mut notebook,
        vec![
            tessera_core::Operation::CreatePage {
                id: id(3),
                title: "Chosen".into(),
            },
            record(3, Some("mine")),
            tessera_core::Operation::CreatePage {
                id: id(4),
                title: "The Bare Record".into(),
            },
            record(4, None),
        ],
    );
    assert_eq!(key(&notebook, 3).as_deref(), Some("mine"));
    assert_eq!(key(&notebook, 4).as_deref(), Some("anonndbare"));

    // A key is never recomputed when fields change, and clearing it is an authored edit that stays.
    let value = notebook.block(&id(101)).unwrap();
    apply(
        &mut notebook,
        vec![tessera_core::Operation::EditText {
            id: id(101),
            base_revision: value.revision,
            text: "Noam Shazeer".into(),
        }],
    );
    assert_eq!(key(&notebook, 1).as_deref(), Some("vaswani2017attention"));
    clear_key(&mut notebook, 4);
    assert_eq!(key(&notebook, 4), None);
}

#[test]
fn opening_gives_keyless_sources_a_suggested_key_once() {
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(dir.path()).unwrap();
    let fields = notebook.fields().unwrap().page_id;
    let mut operations = vec![insert(10, &fields, "author")];
    for (page, title) in [(1, "Notes on Keys"), (2, "Notes, again")] {
        operations.extend([
            tessera_core::Operation::CreatePage {
                id: id(page),
                title: title.into(),
            },
            insert(page * 100, &id(page), &format!("[[{}]]", id(10))),
            insert(page * 100 + 1, &id(page * 100), "Jane Doe"),
            record(page, None),
        ]);
    }
    apply(&mut notebook, operations);
    let last = |notebook: &Notebook| {
        notebook
            .changes_since(0, usize::MAX)
            .unwrap()
            .pop()
            .unwrap()
    };
    let before = last(&notebook).seq;
    drop(notebook);
    // Before keys were made with the record, these sources had none.
    let conn = rusqlite::Connection::open(dir.path().join(tessera_core::DATABASE_FILE)).unwrap();
    conn.execute("UPDATE sources SET citation_key = NULL", [])
        .unwrap();
    drop(conn);

    let mut notebook = Notebook::open(dir.path()).unwrap();
    assert_eq!(key(&notebook, 1).as_deref(), Some("doendnotes"));
    assert_eq!(key(&notebook, 2).as_deref(), Some("doendnotesa"));
    let backfill = last(&notebook);
    assert_eq!(backfill.seq, before + 1);
    assert_eq!(
        backfill.actor,
        Actor::Client {
            name: "Citation keys".into()
        }
    );
    let bib = notebook
        .export(&[id(1), id(2)], ExportFormat::Bibtex)
        .unwrap();
    assert!(bib.contains("{doendnotesa,"), "{bib}");

    // Once that has run, a key a person clears stays clear.
    clear_key(&mut notebook, 2);
    drop(notebook);
    let notebook = Notebook::open(dir.path()).unwrap();
    assert_eq!(key(&notebook, 2), None);
}
