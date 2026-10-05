use std::{
    collections::HashSet,
    io::{Cursor, Write},
};

use tessera_core::library::{CreatorRole, MarkKind, PassageKind, SourceFormat};
use tessera_ingest::{Error, detect, epub};
use zip::{ZipWriter, write::SimpleFileOptions};

const CONTAINER: &str = r#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;

fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (path, bytes) in entries {
        writer
            .start_file(
                *path,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn epub3() -> Vec<u8> {
    let package = r##"<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title id="title">A Book</dc:title><dc:title id="subtitle">A Closer Look</dc:title>
        <meta refines="#subtitle" property="title-type">subtitle</meta>
        <dc:creator id="a">Alice Author</dc:creator><dc:creator id="b">Bob Writer</dc:creator>
        <dc:creator id="t">Tara Translator</dc:creator><dc:creator id="i">Iris Illustrator</dc:creator>
        <meta refines="#b" property="role">aut</meta><meta refines="#t" property="role">trl</meta>
        <meta refines="#i" property="role">ill</meta>
        <dc:date>2024-02-29T09:00:00Z</dc:date><meta property="dcterms:modified">2026-09-30T00:00:00Z</meta>
        <dc:publisher>Small Press</dc:publisher><dc:language>en</dc:language>
        <dc:description>&lt;p&gt;A &lt;em&gt;useful&lt;/em&gt; book.&lt;/p&gt;</dc:description>
        <dc:identifier id="book-id">urn:isbn:9780000000001</dc:identifier><dc:identifier>custom:book</dc:identifier>
      </metadata>
      <manifest>
        <item id="two" href="text/two.xhtml" media-type="application/xhtml+xml"/>
        <item id="one" href="text/one.xhtml" media-type="application/xhtml+xml"/>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="cover" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
        <item id="art" href="images/art.png" media-type="image/png"/>
        <item id="unused" href="images/unused.png" media-type="image/png"/>
        <item id="appendix" href="text/appendix.xhtml" media-type="application/xhtml+xml"/>
        <item id="skip" href="text/skip.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="one"/><itemref idref="two"/><itemref idref="appendix" linear="no"/><itemref idref="skip" linear="no"/></spine>
    </package>"##;
    let nav = r##"<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>
      <li><a href="text/one.xhtml#chapter">One</a><ol><li><a href="text/one.xhtml#inline">Inline target</a></li></ol></li>
      <li><a href="text/two.xhtml#missing">Two</a></li><li><a href="text/appendix.xhtml">Appendix</a></li>
      <li><a href="missing.xhtml">Missing file</a></li>
    </ol></nav></body></html>"##;
    let one = r##"<html xmlns:epub="http://www.idpf.org/2007/ops"><body>
      <section id="chapter"><h1 id="heading">Chapter One</h1>
      <p id="intro">A <em>😀 <strong id="inline">brave</strong></em> new world <a href="two.xhtml#destination">next</a> <a epub:type="noteref" href="#fn1">1</a>.</p>
      <div>Direct <b>text</b>.<p>Nested paragraph.</p>Trailing text.</div>
      <blockquote><p>Quoted words.</p></blockquote>
      <ol><li>First<ul><li>Nested</li></ul></li><li><p>Second</p></li></ol>
      <pre><code>line 1
  &lt;x&gt;
end</code></pre>
      <table><tr><td>One</td><td><strong>Two</strong></td></tr></table>
      <p><a href="https://example.org/">External</a> <code>inline code</code></p>
      <img src="../images/art.png" alt=" Art "/>
      <svg xmlns:xlink="http://www.w3.org/1999/xlink"><title>Cover illustration</title><image xlink:href="../images/cover.jpg"/></svg>
      <aside epub:type="footnote" id="fn1"><p>A note <a href="#intro">back</a>.</p></aside>
      <p id="intro">Duplicate id.</p><p id="p1">Synthetic collision.</p><span id="at-end"></span>
      </section></body></html>"##;
    let two = r##"<html><body><h2 id="destination">Chapter Two</h2><p><a href="one.xhtml#inline">Return</a></p></body></html>"##;
    archive(&[
        ("mimetype", b"application/epub+zip"),
        ("META-INF/container.xml", CONTAINER.as_bytes()),
        ("OPS/package.opf", package.as_bytes()),
        ("OPS/nav.xhtml", nav.as_bytes()),
        ("OPS/text/one.xhtml", one.as_bytes()),
        ("OPS/text/two.xhtml", two.as_bytes()),
        (
            "OPS/text/appendix.xhtml",
            b"<html><body><p>Appendix text.</p></body></html>",
        ),
        (
            "OPS/text/skip.xhtml",
            b"<html><body><p>Do not include.</p></body></html>",
        ),
        ("OPS/images/cover.jpg", b"cover bytes"),
        ("OPS/images/art.png", b"art bytes"),
        ("OPS/images/unused.png", b"unused bytes"),
    ])
}

#[test]
fn epub3_metadata_navigation_resources_and_spine_order() {
    let bytes = epub3();
    assert_eq!(detect(&bytes, None, None), Some(SourceFormat::Epub));
    let document = epub(&bytes).unwrap();
    let metadata = &document.metadata;
    assert_eq!(document.format, SourceFormat::Epub);
    assert_eq!(document.media_type, "application/epub+zip");
    assert_eq!(metadata.title.as_deref(), Some("A Book"));
    assert_eq!(metadata.subtitle.as_deref(), Some("A Closer Look"));
    assert_eq!(metadata.published.as_deref(), Some("2024-02-29"));
    assert_eq!(metadata.publisher.as_deref(), Some("Small Press"));
    assert_eq!(metadata.language.as_deref(), Some("en"));
    assert_eq!(metadata.description.as_deref(), Some("A useful book."));
    assert_eq!(
        metadata.identifiers,
        ["urn:isbn:9780000000001", "custom:book"]
    );
    assert_eq!(
        metadata.unique_id.as_deref(),
        Some("urn:isbn:9780000000001")
    );
    assert_eq!(
        metadata
            .creators
            .iter()
            .map(|c| (c.name.as_str(), c.role))
            .collect::<Vec<_>>(),
        [
            ("Alice Author", CreatorRole::Author),
            ("Bob Writer", CreatorRole::Author),
            ("Tara Translator", CreatorRole::Translator),
        ]
    );
    assert_eq!(
        document
            .toc
            .iter()
            .map(|entry| (entry.title.as_str(), entry.locator.as_str(), entry.level))
            .collect::<Vec<_>>(),
        [
            ("One", "OPS/text/one.xhtml#heading", 1),
            ("Inline target", "OPS/text/one.xhtml#intro", 2),
            ("Two", "OPS/text/two.xhtml#destination", 1),
            ("Appendix", "OPS/text/appendix.xhtml#p1", 1),
        ]
    );
    assert_eq!(document.passages[0].text, "Chapter One");
    assert_eq!(document.passages.last().unwrap().text, "Appendix text.");
    assert!(
        document
            .passages
            .iter()
            .all(|passage| passage.text != "Do not include.")
    );
    assert_eq!(metadata.cover.as_deref(), Some("OPS/images/cover.jpg"));
    assert_eq!(document.resources.len(), 2);
    assert_eq!(document.resources[0].href, "OPS/images/cover.jpg");
    assert_eq!(document.resources[0].media_type, "image/jpeg");
    assert_eq!(document.resources[0].bytes, b"cover bytes");
    assert_eq!(document.resources[1].bytes, b"art bytes");
    let images: Vec<_> = document
        .passages
        .iter()
        .filter(|p| p.kind == PassageKind::Image)
        .collect();
    assert_eq!(images.len(), 2);
    assert_eq!(images[1].resource.as_deref(), Some("OPS/images/cover.jpg"));
    assert_eq!(images[1].text, "Cover illustration");
}

#[test]
fn epub3_passage_kinds_marks_targets_and_unique_locators() {
    let document = epub(&epub3()).unwrap();
    let passages = &document.passages;
    let intro = &passages[1];
    assert_eq!(intro.text, "A 😀 brave new world next 1.");
    let emphasis = intro
        .marks
        .iter()
        .find(|mark| mark.kind == MarkKind::Emphasis)
        .unwrap();
    assert_eq!((emphasis.start, emphasis.end), (2, 10));
    let strong = intro
        .marks
        .iter()
        .find(|mark| mark.kind == MarkKind::Strong)
        .unwrap();
    assert_eq!((strong.start, strong.end), (5, 10));
    assert!(intro.marks.iter().any(|mark| mark.kind
        == MarkKind::Internal {
            locator: "OPS/text/two.xhtml#destination".into()
        }));
    let note = passages
        .iter()
        .find(|passage| passage.kind == PassageKind::Footnote)
        .unwrap();
    assert_eq!(note.text, "A note back.");
    assert!(intro.marks.iter().any(|mark| mark.kind
        == MarkKind::NoteRef {
            locator: note.locator.clone()
        }));
    let return_link = passages
        .iter()
        .find(|passage| passage.text == "Return")
        .unwrap();
    assert_eq!(
        return_link.marks[0].kind,
        MarkKind::Internal {
            locator: intro.locator.clone()
        }
    );
    assert_eq!(passages[2].text, "Direct text.");
    assert_eq!(passages[3].text, "Nested paragraph.");
    assert_eq!(passages[4].text, "Trailing text.");
    assert_eq!(passages[5].kind, PassageKind::Quote);
    assert_eq!(
        (passages[6].kind, passages[6].level),
        (PassageKind::ListItem, Some(1))
    );
    assert_eq!(
        (passages[7].kind, passages[7].level),
        (PassageKind::ListItem, Some(2))
    );
    assert_eq!(
        (passages[8].kind, passages[8].level),
        (PassageKind::ListItem, Some(1))
    );
    assert_eq!(passages[9].kind, PassageKind::Code);
    assert_eq!(passages[9].text, "line 1\n  <x>\nend");
    assert_eq!(passages[10].text, "One · Two");
    assert_eq!(
        (passages[10].marks[0].start, passages[10].marks[0].end),
        (6, 9)
    );
    let locators: HashSet<_> = passages.iter().map(|passage| &passage.locator).collect();
    assert_eq!(locators.len(), passages.len());
    for passage in passages {
        let utf16 = passage.text.encode_utf16().collect::<Vec<_>>();
        for mark in &passage.marks {
            assert!(mark.start < mark.end && mark.end as usize <= utf16.len());
            assert!(String::from_utf16(&utf16[mark.start as usize..mark.end as usize]).is_ok());
            if let MarkKind::Internal { locator } | MarkKind::NoteRef { locator } = &mark.kind {
                assert!(locators.contains(locator));
            }
        }
    }
}

fn epub2(publication: &str, body: &str) -> Vec<u8> {
    let package = format!(
        r##"<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>Old Book</dc:title><dc:creator opf:role="aut">Author</dc:creator>
        <dc:creator opf:role="edt">Editor</dc:creator><dc:creator opf:role="trl">Translator</dc:creator>
        <dc:creator opf:role="ill">Illustrator</dc:creator><dc:identifier id="uid">raw:id</dc:identifier>
        {publication}<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta><meta name="cover" content="cover"/>
      </metadata><manifest>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        <item id="cover" href="cover.jpg" media-type="image/jpeg"/>
      </manifest><spine toc="ncx"><itemref idref="chapter"/></spine></package>"##
    );
    let ncx = r##"<?xml version="1.0"?><!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd"><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="one"><navLabel><text>Start</text></navLabel><content src="chapter.xhtml#start"/><navPoint id="two"><navLabel><text>Details</text></navLabel><content src="chapter.xhtml#detail"/></navPoint></navPoint><navPoint id="bad"><navLabel><text>Missing</text></navLabel><content src="absent.xhtml"/></navPoint></navMap></ncx>"##;
    archive(&[
        ("mimetype", b"application/epub+zip"),
        ("META-INF/container.xml", CONTAINER.as_bytes()),
        ("OPS/package.opf", package.as_bytes()),
        ("OPS/toc.ncx", ncx.as_bytes()),
        ("OPS/chapter.xhtml", body.as_bytes()),
        ("OPS/cover.jpg", b"old cover"),
    ])
}

#[test]
fn epub2_ncx_roles_and_cover() {
    let bytes = epub2(
        "<dc:date>1998-04</dc:date>",
        r#"<html><body><h1 id="start">Start</h1><p id="detail">Details</p></body></html>"#,
    );
    let document = epub(&bytes).unwrap();
    assert_eq!(document.metadata.published.as_deref(), Some("1998-04"));
    assert_eq!(
        document
            .metadata
            .creators
            .iter()
            .map(|creator| creator.role)
            .collect::<Vec<_>>(),
        [
            CreatorRole::Author,
            CreatorRole::Editor,
            CreatorRole::Translator
        ]
    );
    assert_eq!(document.metadata.cover.as_deref(), Some("OPS/cover.jpg"));
    assert_eq!(document.resources[0].bytes, b"old cover");
    assert_eq!(document.toc.len(), 2);
    assert_eq!(document.toc[0].locator, "OPS/chapter.xhtml#start");
    assert_eq!(document.toc[0].level, 1);
    assert_eq!(document.toc[1].locator, "OPS/chapter.xhtml#detail");
    assert_eq!(document.toc[1].level, 2);
}

#[test]
fn modified_date_is_never_publication_and_empty_books_error() {
    for publication in [
        "",
        "<dc:date>not a date</dc:date>",
        "<dc:date>2023-02-29</dc:date>",
    ] {
        let document = epub(&epub2(
            publication,
            "<html><body><p>Text.</p></body></html>",
        ))
        .unwrap();
        assert_eq!(document.metadata.published, None);
    }
    assert!(matches!(
        epub(&epub2(
            "",
            "<html><body><img src='cover.jpg'/></body></html>"
        )),
        Err(Error::Empty("book"))
    ));
}

#[test]
fn malformed_packages_are_errors() {
    for bytes in [
        b"not a zip".to_vec(),
        archive(&[("mimetype", b"application/epub+zip")]),
        archive(&[("META-INF/container.xml", CONTAINER.as_bytes())]),
        archive(&[("META-INF/container.xml", b"<broken")]),
        archive(&[
            ("META-INF/container.xml", CONTAINER.as_bytes()),
            ("OPS/package.opf", b"<not-package/>"),
        ]),
    ] {
        assert!(matches!(
            epub(&bytes),
            Err(Error::Malformed { format: "epub", .. })
        ));
    }
}

#[test]
fn decompressed_size_limits_are_checked_before_inflation() {
    let mut single = archive(&[("huge", b"x")]);
    let central = single
        .windows(4)
        .position(|bytes| bytes == b"PK\x01\x02")
        .unwrap();
    single[central + 24..central + 28].copy_from_slice(&(64u32 * 1024 * 1024 + 1).to_le_bytes());
    let error = epub(&single).unwrap_err();
    assert!(matches!(error, Error::Malformed { .. }));
    assert!(error.to_string().contains("64 MiB"));
    let names: Vec<_> = (0..9).map(|n| format!("file{n}")).collect();
    let entries: Vec<_> = names
        .iter()
        .map(|name| (name.as_str(), b"x".as_slice()))
        .collect();
    let mut total = archive(&entries);
    let central: Vec<_> = total
        .windows(4)
        .enumerate()
        .filter_map(|(index, bytes)| (bytes == b"PK\x01\x02").then_some(index))
        .collect();
    for index in central {
        total[index + 24..index + 28].copy_from_slice(&(64u32 * 1024 * 1024).to_le_bytes());
    }
    let error = epub(&total).unwrap_err();
    assert!(matches!(error, Error::Malformed { .. }));
    assert!(error.to_string().contains("512 MiB"));
}

#[test]
fn metadata_identifiers_preserve_raw_values() {
    let document = epub(&epub2(
        "<dc:identifier>custom:  spaced identifier</dc:identifier>",
        "<html><body><p>Text.</p></body></html>",
    ))
    .unwrap();
    assert_eq!(
        document.metadata.identifiers,
        ["raw:id", "custom:  spaced identifier"]
    );
}
