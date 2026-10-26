use std::collections::HashSet;

use tessera_core::library::{
    CreatorKind, CreatorRole, ExtractedDocument, ExtractedMetadata, MarkKind, PassageKind,
    SourceFormat,
};
use tessera_ingest::{Error, article, page_metadata};

fn invariants(document: &ExtractedDocument) {
    let locators: HashSet<_> = document
        .passages
        .iter()
        .map(|passage| &passage.locator)
        .collect();
    assert_eq!(locators.len(), document.passages.len());
    for passage in &document.passages {
        let units = passage.text.encode_utf16().collect::<Vec<_>>();
        for mark in &passage.marks {
            assert!(mark.start < mark.end);
            assert!(mark.end as usize <= units.len());
            assert!(String::from_utf16(&units[mark.start as usize..mark.end as usize]).is_ok());
            if let MarkKind::Internal { locator } | MarkKind::NoteRef { locator } = &mark.kind {
                assert!(locators.contains(locator));
            }
        }
    }
}

#[test]
fn blog_metadata_passages_and_utf16_links() {
    let document = article(
        include_str!("fixtures/blog.html"),
        "https://marginalia.example/posts/draft",
    )
    .unwrap();
    let metadata = &document.metadata;
    assert_eq!(document.format, SourceFormat::Article);
    assert_eq!(document.media_type, "text/html");
    assert_eq!(metadata.title.as_deref(), Some("Reading carefully"));
    assert_eq!(metadata.site.as_deref(), Some("Marginalia"));
    assert_eq!(
        metadata.url.as_deref(),
        Some("https://marginalia.example/posts/reading")
    );
    assert_eq!(metadata.language.as_deref(), Some("en-GB"));
    assert_eq!(metadata.published.as_deref(), Some("2024-02-29"));
    assert_eq!(
        metadata.description.as_deref(),
        Some("Notes on close reading.")
    );
    assert_eq!(
        metadata.identifiers,
        ["10.1234/reading", "2601.00001", "custom:reading"]
    );
    assert_eq!(metadata.creators.len(), 1);
    assert_eq!(metadata.creators[0].name, "Ada Reader");
    assert_eq!(metadata.creators[0].role, CreatorRole::Author);
    let passages = &document.passages;
    assert_eq!(passages[0].kind, PassageKind::Heading);
    assert_eq!(passages[0].level, Some(1));
    assert_eq!(passages[0].locator, "#start");
    assert_eq!(passages[1].text, "A 😀 brave new idea 1.");
    let emphasis = passages[1]
        .marks
        .iter()
        .find(|mark| mark.kind == MarkKind::Emphasis)
        .unwrap();
    assert_eq!((emphasis.start, emphasis.end), (2, 10));
    let strong = passages[1]
        .marks
        .iter()
        .find(|mark| mark.kind == MarkKind::Strong)
        .unwrap();
    assert_eq!((strong.start, strong.end), (5, 10));
    assert!(
        passages[1]
            .marks
            .iter()
            .any(|mark| mark.kind == MarkKind::Code)
    );
    let note = passages
        .iter()
        .find(|passage| passage.kind == PassageKind::Footnote)
        .unwrap();
    assert_eq!(note.text, "A footnote back.");
    assert!(passages[1].marks.iter().any(|mark| mark.kind
        == MarkKind::NoteRef {
            locator: note.locator.clone()
        }));
    assert!(note.marks.iter().any(|mark| mark.kind
        == MarkKind::Internal {
            locator: "#intro".into()
        }));
    let lists: Vec<_> = passages
        .iter()
        .filter(|passage| passage.kind == PassageKind::ListItem)
        .map(|passage| (passage.text.as_str(), passage.level))
        .collect();
    assert_eq!(
        lists,
        [
            ("First item", Some(1)),
            ("Nested item", Some(2)),
            ("Second item", Some(1))
        ]
    );
    assert!(
        passages
            .iter()
            .any(|passage| passage.kind == PassageKind::Quote && passage.text == "Quoted words.")
    );
    assert!(
        passages
            .iter()
            .any(|passage| passage.kind == PassageKind::Code
                && passage.text == "let x = 1;\n  keep_indent();\nreturn x;")
    );
    assert!(
        passages
            .iter()
            .any(|passage| passage.text == "Term · Meaning")
    );
    let row = passages
        .iter()
        .find(|passage| passage.text == "A · B")
        .unwrap();
    assert_eq!((row.marks[0].start, row.marks[0].end), (4, 5));
    let links = passages
        .iter()
        .find(|passage| passage.text == "Elsewhere and inside.")
        .unwrap();
    assert!(links.marks.iter().any(|mark| mark.kind
        == MarkKind::Link {
            href: "https://example.net/more".into()
        }));
    assert!(links.marks.iter().any(|mark| mark.kind
        == MarkKind::Internal {
            locator: "#target".into()
        }));
    let image = passages
        .iter()
        .find(|passage| passage.kind == PassageKind::Image)
        .unwrap();
    assert_eq!(image.text, "A reading room");
    assert_eq!(
        image.resource.as_deref(),
        Some("https://marginalia.example/images/large.jpg")
    );
    assert!(document.resources.is_empty());
    assert!(
        passages
            .iter()
            .all(|passage| !passage.text.contains("Unwanted"))
    );
    invariants(&document);
}

#[test]
fn news_selects_prose_and_json_ld_metadata() {
    let document = article(
        include_str!("fixtures/news.html"),
        "https://news.example/draft",
    )
    .unwrap();
    assert_eq!(
        document.metadata.title.as_deref(),
        Some("A useful discovery")
    );
    assert_eq!(
        document.metadata.url.as_deref(),
        Some("https://news.example/science/discovery")
    );
    assert_eq!(document.metadata.published.as_deref(), Some("2025-06-18"));
    let authors: Vec<_> = document
        .metadata
        .creators
        .iter()
        .map(|creator| creator.name.as_str())
        .collect();
    assert_eq!(authors, ["Grace Writer", "Lin Reporter"]);
    assert_eq!(document.passages.len(), 4);
    assert!(
        document
            .passages
            .iter()
            .all(|passage| !passage.text.contains("Unwanted"))
    );
    assert_eq!(document.passages[2].locator, "#result");
    invariants(&document);
}

#[test]
fn note_sections_outside_article_keep_global_numbering() {
    let html = r##"<article><p>Text <a role="doc-noteref" href="#n">note</a>.</p></article>
        <aside role="doc-endnotes"><p id="n">Note.</p><p>Another note.</p></aside>"##;
    let document = article(html, "https://example.org/post").unwrap();
    assert_eq!(document.passages.len(), 3);
    assert_eq!(document.passages[0].locator, "#p1");
    assert_eq!(document.passages[1].locator, "#n");
    assert_eq!(document.passages[2].locator, "#p3");
    assert_eq!(document.passages[1].kind, PassageKind::Footnote);
    assert_eq!(
        document.passages[0].marks[0].kind,
        MarkKind::NoteRef {
            locator: "#n".into()
        }
    );
    invariants(&document);
}

#[test]
fn duplicate_ids_and_synthetic_locator_collisions_are_stable() {
    let html =
        r##"<article><p>One</p><p id="p1">Two</p><p id="p1">Three</p><p>Four</p></article>"##;
    let first = article(html, "https://example.org/").unwrap();
    assert_eq!(first, article(html, "https://example.org/").unwrap());
    assert_eq!(
        first
            .passages
            .iter()
            .map(|p| p.locator.as_str())
            .collect::<Vec<_>>(),
        ["#p1", "#p1~2", "#p1~3", "#p4"]
    );
    invariants(&first);
}

#[test]
fn article_date_precision_and_invalid_dates() {
    for (input, expected) in [
        ("2024", Some("2024")),
        ("2024-02", Some("2024-02")),
        ("2024-02-29T20:15:30.123-05:00", Some("2024-02-29")),
        ("2023-02-29", None),
        ("2024-13", None),
        ("tomorrow", None),
        ("2024-01-01Tnope", None),
        ("2024-01-01T12:30:00Zjunk", None),
    ] {
        let html = format!(
            "<meta property='article:published_time' content='{input}'><article><p>Text</p></article>"
        );
        assert_eq!(
            article(&html, "https://example.org/")
                .unwrap()
                .metadata
                .published
                .as_deref(),
            expected,
            "{input}"
        );
    }
}

#[test]
fn address_dates_only_fill_a_missing_publication_date() {
    let published = |html: &str, url: &str| article(html, url).unwrap().metadata.published;
    let body = "<article><p>Text</p></article>";
    assert_eq!(
        published(
            body,
            "https://karpathy.github.io/2015/05/21/rnn-effectiveness/"
        )
        .as_deref(),
        Some("2015-05-21")
    );
    assert_eq!(published(body, "https://example.org/2015/13/21/post"), None);
    assert_eq!(published(body, "https://example.org/2015/05/post"), None);
    assert_eq!(
        published(
            &format!("<meta property='article:published_time' content='2016-01-02'>{body}"),
            "https://example.org/2015/05/21/post"
        )
        .as_deref(),
        Some("2016-01-02")
    );
}

#[test]
fn article_errors_and_fallbacks() {
    assert!(matches!(
        article("<article><img src='x'></article>", "https://example.org/"),
        Err(Error::Empty("article"))
    ));
    assert!(matches!(
        article("<p>text</p>", "not a URL"),
        Err(Error::Malformed {
            format: "article",
            ..
        })
    ));
    let document = article(
        "<title>Keep - Another Site</title><div><p>Readable text.</p></div>",
        "https://example.org/",
    )
    .unwrap();
    assert_eq!(
        document.metadata.title.as_deref(),
        Some("Keep - Another Site")
    );
    assert_eq!(document.metadata.site.as_deref(), Some("example.org"));
    assert_eq!(
        document.metadata.url.as_deref(),
        Some("https://example.org/")
    );
    assert_eq!(document.passages[0].text, "Readable text.");
}

#[test]
fn metadata_byline_can_precede_the_article_container() {
    let document = article(
        "<header><span class='byline'>By Jane Writer</span></header><article><p>Text.</p></article>",
        "https://example.org/",
    )
    .unwrap();
    assert_eq!(document.metadata.creators[0].name, "Jane Writer");
    assert_eq!(document.passages[0].text, "Text.");
}

#[test]
fn schema_json_ld_creator_signals_override_unstructured_duplicates() {
    let html = r#"<html><head>
      <title>Structured creator kinds</title>
      <meta name="author" content="Research Institute">
      <script type="application/ld+json">{
        "@type": "ScholarlyArticle",
        "author": [
          {"@type": "Organization", "name": "Research Institute"},
          {"@type": ["Thing", "Person"], "name": "The Editors"},
          {"givenName": "Ada", "familyName": "Reader"},
          {"@type": "https://schema.org/Organization", "name": "A Collective",
           "givenName": "Conflicting", "familyName": "Names"}
        ]
      }</script>
    </head><body>
      <span class="byline">Research Institute</span>
      <article><p>Readable text.</p></article>
    </body></html>"#;
    let document = article(html, "https://example.org/creator-kinds").unwrap();
    let creators = &document.metadata.creators;
    assert_eq!(creators.len(), 4);
    assert_eq!(creators[0].name, "Research Institute");
    assert_eq!(creators[0].kind, CreatorKind::Organisation);
    assert_eq!(creators[1].name, "The Editors");
    assert_eq!(creators[1].kind, CreatorKind::Person);
    assert_eq!(creators[2].name, "Ada Reader");
    assert_eq!(creators[2].kind, CreatorKind::Person);
    assert_eq!(creators[3].kind, CreatorKind::Organisation);
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = tessera_core::Notebook::open(dir.path()).unwrap();
    let plan = notebook.plan_source_record(&document.metadata).unwrap();
    notebook
        .apply(&tessera_core::Batch {
            actor: tessera_core::Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: plan.operations,
        })
        .unwrap();
    let groups = notebook.kind_notes("group").unwrap();
    assert!(
        groups
            .notes
            .iter()
            .any(|note| note.title == "Research Institute")
    );
    assert!(
        !notebook
            .kind_notes("person")
            .unwrap()
            .notes
            .iter()
            .any(|note| note.title == "Research Institute")
    );
}

#[test]
fn schema_json_ld_creator_references_keep_the_graph_entity_kind() {
    let html = r##"<script type="application/ld+json">{"@graph": [
      {"@type": "Article", "author": [{"@id": "#org"}, {"@id": "#person"}]},
      {"@id": "#org", "@type": "http://schema.org/Organization", "name": "Editorial Board"},
      {"@id": "#person", "@type": "Person", "givenName": "Grace", "familyName": "Reader"}
    ]}</script><article><p>Text.</p></article>"##;
    let document = article(html, "https://example.org/graph").unwrap();
    assert_eq!(document.metadata.creators.len(), 2);
    assert_eq!(document.metadata.creators[0].name, "Editorial Board");
    assert_eq!(
        document.metadata.creators[0].kind,
        CreatorKind::Organisation
    );
    assert_eq!(document.metadata.creators[1].name, "Grace Reader");
    assert_eq!(document.metadata.creators[1].kind, CreatorKind::Person);
}

#[test]
fn schema_microdata_creator_signals_keep_organisation_and_person_kinds() {
    let html = r#"<div itemprop="author" itemscope itemtype="https://schema.org/Organization">
        <span class="author-name" itemprop="name">University Press</span>
      </div>
      <div itemprop="author" itemscope itemtype="http://schema.org/Person">
        <span itemprop="name">Named Person</span>
      </div>
      <div itemprop="author">
        <span itemprop="givenName">Ada</span><span itemprop="familyName">Reader</span>
      </div>
      <article><p>Text.</p></article>"#;
    let document = article(html, "https://example.org/microdata").unwrap();
    assert_eq!(document.metadata.creators.len(), 3);
    assert_eq!(document.metadata.creators[0].name, "University Press");
    assert_eq!(
        document.metadata.creators[0].kind,
        CreatorKind::Organisation
    );
    assert_eq!(document.metadata.creators[1].name, "Named Person");
    assert_eq!(document.metadata.creators[1].kind, CreatorKind::Person);
    assert_eq!(document.metadata.creators[2].name, "Ada Reader");
    assert_eq!(document.metadata.creators[2].kind, CreatorKind::Person);
}

#[test]
fn unstructured_article_creators_keep_person_default_without_name_guessing() {
    let html = r#"<meta name="citation_author" content="The Editors of Encyclopaedia Britannica">
      <script type="application/ld+json">{"@type": "Article",
        "author": ["Research Institute", {"name": "Editorial Collective"}]
      }</script>
      <span class="byline">University Press</span>
      <article><p>Text.</p></article>"#;
    let document = article(html, "https://example.org/plain-creators").unwrap();
    assert_eq!(document.metadata.creators.len(), 1);
    assert_eq!(
        document.metadata.creators[0].name,
        "The Editors of Encyclopaedia Britannica"
    );
    let html = r#"<script type="application/ld+json">{"@type": "Article",
        "author": ["Research Institute", {"name": "Editorial Collective"}]
      }</script>
      <span class="byline">University Press</span>
      <article><p>Text.</p></article>"#;
    let document = article(html, "https://example.org/plain-creators").unwrap();
    assert_eq!(document.metadata.creators.len(), 2);
    let document = article(
        "<span class='byline'>University Press</span><article><p>Text.</p></article>",
        "https://example.org/plain-creators",
    )
    .unwrap();
    assert_eq!(document.metadata.creators[0].name, "University Press");
    assert_eq!(document.metadata.creators[0].kind, CreatorKind::Person);
}

#[test]
fn repeated_line_breaks_form_paragraphs_without_splitting_single_breaks_or_code() {
    let document = article(
        r#"<article><div id="opening"><em>First 😀 line.<br>Still first.<br>
          <br>Second paragraph.</em><br><br><br>Third paragraph.</div>
          <pre>one<br><br>two</pre></article>"#,
        "https://example.org/line-breaks",
    )
    .unwrap();
    assert_eq!(
        document
            .passages
            .iter()
            .map(|passage| passage.text.as_str())
            .collect::<Vec<_>>(),
        [
            "First 😀 line. Still first.",
            "Second paragraph.",
            "Third paragraph.",
            "one\n\ntwo"
        ]
    );
    assert_eq!(document.passages[0].locator, "#opening");
    for passage in &document.passages[..2] {
        assert!(passage.marks.iter().any(|mark| {
            mark.kind == MarkKind::Emphasis
                && mark.start == 0
                && mark.end == passage.text.encode_utf16().count() as u32
        }));
    }
    invariants(&document);
}

#[test]
fn layout_tables_do_not_flatten_line_break_authored_articles() {
    let document = article(
        r#"<html><body><table><tr><td><table><tr><td><font>
          First paragraph.<br><br>Second paragraph.<br><br>Third paragraph.
          </font></td></tr></table></td></tr></table></body></html>"#,
        "https://example.org/layout-table",
    )
    .unwrap();
    assert_eq!(
        document
            .passages
            .iter()
            .map(|passage| passage.text.as_str())
            .collect::<Vec<_>>(),
        ["First paragraph.", "Second paragraph.", "Third paragraph."]
    );
    invariants(&document);
}

#[test]
fn page_metadata_names_a_page_without_readable_text() {
    let html = "<html><head><title>Project Gutenberg | Gutenberg</title><meta property=\"og:site_name\" content=\"Gutenberg\"></head><body><nav>Menu</nav></body></html>";
    assert!(matches!(
        article(html, "https://www.gutenberg.org/ebooks/2680"),
        Err(Error::Empty(_))
    ));
    let metadata = page_metadata(html, "https://www.gutenberg.org/ebooks/2680").unwrap();
    assert_eq!(metadata.title.as_deref(), Some("Project Gutenberg"));
    assert_eq!(metadata.site.as_deref(), Some("Gutenberg"));
}

fn names(metadata: &ExtractedMetadata) -> Vec<(&str, CreatorRole)> {
    metadata
        .creators
        .iter()
        .map(|creator| (creator.name.as_str(), creator.role))
        .collect()
}

#[test]
fn gutenberg_ebook_names_the_book_and_its_catalogue_creators() {
    let metadata = page_metadata(
        include_str!("fixtures/gutenberg-ebook.html"),
        "https://www.gutenberg.org/ebooks/3296",
    )
    .unwrap();
    assert_eq!(
        metadata.title.as_deref(),
        Some("The Confessions of St. Augustine")
    );
    assert_eq!(metadata.site.as_deref(), Some("Project Gutenberg"));
    assert_eq!(
        names(&metadata),
        [
            ("Augustine of Hippo", CreatorRole::Author),
            ("Pusey, E. B.", CreatorRole::Translator),
        ]
    );
    let dir = tempfile::tempdir().unwrap();
    let mut notebook = tessera_core::Notebook::open(dir.path()).unwrap();
    let plan = notebook.plan_source_record(&metadata).unwrap();
    notebook
        .apply(&tessera_core::Batch {
            actor: tessera_core::Actor::Person,
            reason: None,
            idempotency_key: None,
            operations: plan.operations,
        })
        .unwrap();
    let mut people: Vec<_> = notebook
        .kind_notes("person")
        .unwrap()
        .notes
        .into_iter()
        .map(|note| note.title)
        .collect();
    people.sort();
    assert_eq!(people, ["Augustine of Hippo", "E. B. Pusey"]);
}

#[test]
fn catalogue_headings_become_the_names_readers_write() {
    for (heading, title, name, stripped) in [
        (
            "Marcus Aurelius, Emperor of Rome, 121-180",
            "Meditations by Emperor of Rome Marcus Aurelius",
            "Marcus Aurelius",
            "Meditations",
        ),
        (
            "Dickens, Charles, 1812-1870",
            "Contributions to All The Year Round by Charles Dickens",
            "Dickens, Charles",
            "Contributions to All The Year Round",
        ),
        (
            "Thomas, Aquinas, Saint, 1225?-1274",
            "Summa Theologica, Part I (Prima Pars) by Saint Aquinas Thomas",
            "Thomas Aquinas",
            "Summa Theologica, Part I (Prima Pars)",
        ),
        (
            "Elizabeth I, Queen of England, 1533-1603",
            "Letters by Queen of England Elizabeth I",
            "Elizabeth I",
            "Letters",
        ),
        (
            "Byron, George Gordon Byron, Baron, 1788-1824",
            "Don Juan by Baron George Gordon Byron Byron",
            "George Gordon Byron",
            "Don Juan",
        ),
        (
            "Wells, H. G. (Herbert George), 1866-1946",
            "The Time Machine by H. G. Wells",
            "Wells, H. G.",
            "The Time Machine",
        ),
        (
            "King, Stephen",
            "Stand by Me",
            "King, Stephen",
            "Stand by Me",
        ),
    ] {
        let html = format!(
            "<title>{title} | Project Gutenberg</title>\
             <meta property=\"og:site_name\" content=\"Project Gutenberg\">\
             <table><tr><th>Author</th><td><a rel=\"marcrel:aut\" itemprop=\"creator\">{heading}</a></td></tr></table>"
        );
        let metadata = page_metadata(&html, "https://www.gutenberg.org/ebooks/1").unwrap();
        assert_eq!(metadata.title.as_deref(), Some(stripped), "{heading}");
        assert_eq!(names(&metadata), [(name, CreatorRole::Author)], "{heading}");
    }
}

#[test]
fn news_citation_tags_outrank_the_page_title_and_site_author() {
    let metadata = page_metadata(
        include_str!("fixtures/news-citation.html"),
        "https://gazette.example/science/tides",
    )
    .unwrap();
    assert_eq!(
        metadata.title.as_deref(),
        Some("Tides are rising faster along the coast")
    );
    assert_eq!(metadata.site.as_deref(), Some("The Harbour Gazette"));
    // `Writer, Grace` takes the display name the page's author tag and byline give.
    assert_eq!(
        names(&metadata),
        [
            ("Grace Writer", CreatorRole::Author),
            ("Lin Reporter", CreatorRole::Author),
        ]
    );
    assert!(
        metadata
            .creators
            .iter()
            .all(|creator| creator.kind == CreatorKind::Person)
    );
}

#[test]
fn json_ld_headline_and_author_outrank_tags_that_name_the_site() {
    let document = article(
        include_str!("fixtures/json-ld.html"),
        "https://smallcraft.example/notes/knots",
    )
    .unwrap();
    assert_eq!(
        document.metadata.title.as_deref(),
        Some("Knots that hold: notes from a season of sailing & rigging")
    );
    assert_eq!(
        names(&document.metadata),
        [("Ana Évora", CreatorRole::Author)]
    );
    assert_eq!(document.metadata.creators[0].kind, CreatorKind::Person);
}

#[test]
fn dublin_core_names_a_page_without_citation_or_schema_metadata() {
    let html = r#"<title>Untitled document</title>
      <meta name="DC.title" content="Notes on the river survey">
      <meta name="DC.creator" content="Austen, Jane, 1775-1817">
      <meta name="author" content="Jane Austen">"#;
    let metadata = page_metadata(html, "https://archive.example/item/7").unwrap();
    assert_eq!(metadata.title.as_deref(), Some("Notes on the river survey"));
    assert_eq!(names(&metadata), [("Jane Austen", CreatorRole::Author)]);
}

#[test]
fn the_site_name_is_never_a_creator() {
    let html = r#"<title>About us | Small Craft Press</title>
      <meta property="og:site_name" content="Small Craft Press">
      <meta name="author" content="Small Craft Press">
      <span class="byline">small craft press</span>"#;
    let metadata = page_metadata(html, "https://smallcraft.example/about").unwrap();
    assert_eq!(metadata.title.as_deref(), Some("About us"));
    assert!(metadata.creators.is_empty());
}
