use std::io::{Cursor, Write};

use tessera_core::library::SourceFormat;
use tessera_ingest::detect;
use zip::{ZipWriter, write::SimpleFileOptions};

fn zip(mime: Option<&str>) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("content", SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"content").unwrap();
    if let Some(mime) = mime {
        writer
            .start_file("mimetype", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(mime.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn detect_trusts_actual_content_before_hints() {
    assert_eq!(
        detect(
            &zip(Some("application/epub+zip")),
            Some("text/html"),
            Some("wrong.html")
        ),
        Some(SourceFormat::Epub)
    );
    for bytes in [
        zip(None),
        zip(Some("application/zip")),
        b"PK\x03\x04not a zip".to_vec(),
        b"%PDF-1.7".to_vec(),
        b"plain text".to_vec(),
    ] {
        assert_eq!(
            detect(&bytes, Some("application/epub+zip"), Some("wrong.epub")),
            None
        );
    }
    for html in [
        "\u{feff}  \n<!DoCtYpE HtMl><p>text",
        " \r\n<HTML lang='en'>",
    ] {
        assert_eq!(
            detect(
                html.as_bytes(),
                Some("application/epub+zip"),
                Some("wrong.epub")
            ),
            Some(SourceFormat::Article)
        );
    }
}

#[test]
fn detect_uses_noncontradicting_hints() {
    assert_eq!(
        detect(b"", Some("application/epub+zip"), None),
        Some(SourceFormat::Epub)
    );
    assert_eq!(
        detect(b"PK", None, Some("BOOK.EPUB")),
        Some(SourceFormat::Epub)
    );
    assert_eq!(
        detect(b"<p>fragment</p>", Some("text/html; charset=utf-8"), None),
        Some(SourceFormat::Article)
    );
    assert_eq!(
        detect(
            b"<body>fragment</body>",
            Some("APPLICATION/XHTML+XML"),
            None
        ),
        Some(SourceFormat::Article)
    );
    assert_eq!(detect(b"plain text", None, Some("text.txt")), None);
    assert_eq!(detect(b"", None, None), None);
}
