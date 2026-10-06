use tessera_core::{Actor, Batch, FieldKind, Notebook, Operation, library::*};

fn id() -> String {
    ulid::Ulid::generate().to_string()
}
fn apply(n: &mut Notebook, operations: Vec<Operation>) {
    n.apply(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations,
    })
    .unwrap();
}
fn source(n: &mut Notebook, title: &str) -> String {
    let id = id();
    apply(
        n,
        vec![
            Operation::CreatePage {
                id: id.clone(),
                title: title.into(),
            },
            Operation::SetSource {
                id: id.clone(),
                base_revision: 1,
                source: Some(SourceState {
                    format: SourceFormat::Epub,
                    state: ReadingState::Inbox,
                    origin: None,
                    match_key: None,
                    citation_key: Some(format!("source{id}")),
                }),
            },
        ],
    );
    id
}
fn insert(n: &mut Notebook, parent: &str, after: Option<String>, text: &str) -> String {
    let id = id();
    apply(
        n,
        vec![Operation::Insert {
            id: id.clone(),
            parent_id: parent.into(),
            after,
            text: text.into(),
            heading: None,
        }],
    );
    id
}
fn field(n: &mut Notebook, owner: &str, name: &str, values: &[&str]) -> Vec<String> {
    let fields = n.fields().unwrap();
    let definition = fields
        .fields
        .iter()
        .find(|f| f.definition.name.eq_ignore_ascii_case(name))
        .map(|f| f.definition.id.clone())
        .unwrap_or_else(|| insert(n, &fields.page_id, None, name));
    let entry = insert(n, owner, None, &format!("[[{definition}]]"));
    let mut ids = Vec::new();
    for value in values {
        let id = insert(n, &entry, ids.last().cloned(), value);
        ids.push(id);
    }
    ids
}
fn edit(n: &mut Notebook, id: &str, text: &str) {
    apply(
        n,
        vec![Operation::EditText {
            id: id.into(),
            base_revision: n.block(id).unwrap().revision,
            text: text.into(),
        }],
    );
}
fn assert_siglum(n: &Notebook, id: &str, siglum: &str, basis: &str) {
    let record = n.source(id).unwrap().source;
    assert_eq!(record.siglum, siglum);
    assert_eq!(record.siglum_basis, basis);
    assert_eq!(n.capabilities(id).unwrap().source.unwrap(), record);
    assert_eq!(
        n.page(id)
            .unwrap()
            .capabilities
            .into_iter()
            .find(|c| c.block_id == id)
            .unwrap()
            .source
            .unwrap(),
        record
    );
    assert_eq!(
        n.library(&LibraryQuery::default())
            .unwrap()
            .rows
            .into_iter()
            .find(|r| r.page.id == id)
            .unwrap()
            .source,
        record
    );
}

#[test]
fn authored_siglum_wins_and_uses_the_first_trimmed_case_insensitive_field_value() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let source = source(&mut n, "Source title");
    field(&mut n, &source, "Author", &["Karl Popper"]);
    let values = field(&mut n, &source, "sIgLuM", &["  Po  ", "ignored"]);
    assert_siglum(&n, &source, "Po", "Po");
    edit(&mut n, &values[0], " ");
    assert_siglum(&n, &source, "P", "popper");
}

#[test]
fn siglum_defaults_to_the_first_author_family_name_and_ascii_folds() {
    for (author, siglum, basis) in [
        ("Le Guin, Ursula", "L", "leguin"),
        ("Ursula Le Guin", "G", "guin"),
        ("García, Ana", "G", "garcia"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut n = Notebook::open(dir.path()).unwrap();
        let source = source(&mut n, "Source title");
        field(&mut n, &source, "aUtHoR", &[author, "Karl Popper"]);
        field(&mut n, &source, "Editor", &["Jane Austen"]);
        assert_siglum(&n, &source, siglum, basis);
    }
}

#[test]
fn siglum_falls_back_to_editor_then_site_then_title() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let source = source(&mut n, "Évidence and meaning");
    assert_siglum(&n, &source, "E", "evidenceandmeaning");
    field(&mut n, &source, "sItE", &["Philosophy Journal"]);
    assert_siglum(&n, &source, "P", "philosophyjournal");
    field(&mut n, &source, "eDiToR", &["Mary Shelley", "John Locke"]);
    assert_siglum(&n, &source, "S", "shelley");
}

#[test]
fn editing_current_author_values_and_linked_people_changes_the_default_siglum() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let source = source(&mut n, "Source title");
    let author = field(&mut n, &source, "Author", &["Karl Popper"]);
    assert_siglum(&n, &source, "P", "popper");
    edit(&mut n, &author[0], "Hannah Arendt");
    assert_siglum(&n, &source, "A", "arendt");
    let person = id();
    apply(
        &mut n,
        vec![Operation::CreatePage {
            id: person.clone(),
            title: "Simone Weil".into(),
        }],
    );
    let definition = n
        .fields()
        .unwrap()
        .fields
        .into_iter()
        .find(|f| f.definition.name == "Author")
        .unwrap()
        .definition
        .id;
    let revision = n.block(&definition).unwrap().revision;
    apply(
        &mut n,
        vec![Operation::SetFieldKind {
            id: definition,
            base_revision: revision,
            kind: FieldKind::Instance,
        }],
    );
    edit(&mut n, &author[0], &format!("[[{person}]]"));
    assert_siglum(&n, &source, "W", "weil");
    edit(&mut n, &person, "Simone de Beauvoir");
    assert_siglum(&n, &source, "B", "beauvoir");
}

#[test]
fn siglum_skips_leading_digits_and_never_returns_an_empty_mark_or_basis() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let numbered = source(&mut n, "123 Philosophy");
    assert_siglum(&n, &numbered, "P", "123philosophy");
    field(&mut n, &numbered, "Author", &["123 !!!"]);
    assert_siglum(&n, &numbered, "P", "123philosophy");
    field(&mut n, &numbered, "Site", &["Example Journal"]);
    assert_siglum(&n, &numbered, "E", "examplejournal");
    let unlettered = source(&mut n, "123 !!!");
    assert_siglum(&n, &unlettered, "?", "?");
}

#[test]
fn csl_export_includes_the_effective_citation_label_without_changing_other_formats() {
    let dir = tempfile::tempdir().unwrap();
    let mut n = Notebook::open(dir.path()).unwrap();
    let source = source(&mut n, "Source title");
    field(&mut n, &source, "Author", &["Karl Popper"]);
    let ids = std::slice::from_ref(&source);
    let before_bibtex = n.export(ids, ExportFormat::Bibtex).unwrap();
    let before_markdown = n.export(ids, ExportFormat::Markdown).unwrap();
    let csl: serde_json::Value =
        serde_json::from_str(&n.export(ids, ExportFormat::CslJson).unwrap()).unwrap();
    assert_eq!(csl[0]["citation-label"], "P");
    field(&mut n, &source, "Siglum", &["Po"]);
    let csl: serde_json::Value =
        serde_json::from_str(&n.export(ids, ExportFormat::CslJson).unwrap()).unwrap();
    assert_eq!(csl[0]["citation-label"], "Po");
    assert_eq!(n.export(ids, ExportFormat::Bibtex).unwrap(), before_bibtex);
    assert_eq!(
        n.export(ids, ExportFormat::Markdown).unwrap(),
        before_markdown
    );
}
