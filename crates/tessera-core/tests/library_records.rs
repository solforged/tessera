use tessera_core::{Actor, Batch, Direction, Notebook, library::*};

#[test]
fn metadata_records_use_fields_without_reading_content_and_export() {
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = Notebook::open(dir.path()).unwrap();
    let metadata = ExtractedMetadata {
        title: Some("A physical book".into()),
        subtitle: Some("An authored subtitle".into()),
        creators: vec![
            ExtractedCreator {
                name: "Jane Austen".into(),
                role: CreatorRole::Author,
            },
            ExtractedCreator {
                name: "Pat Editor".into(),
                role: CreatorRole::Editor,
            },
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
