use base64::Engine;
use tessera_core::{Actor, Batch, Error, ImageRef, Notebook, Operation};

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
fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=").unwrap()
}
fn setup() -> (tempfile::TempDir, Notebook, ImageRef) {
    let dir = tempfile::tempdir().unwrap();
    let mut nb = Notebook::open(dir.path()).unwrap();
    nb.apply(&batch(vec![
        Operation::CreatePage {
            id: id(1),
            title: "Images".into(),
        },
        Operation::Insert {
            id: id(2),
            parent_id: id(1),
            after: None,
            text: "Caption".into(),
            heading: None,
        },
        Operation::Insert {
            id: id(3),
            parent_id: id(1),
            after: Some(id(2)),
            text: "Next".into(),
            heading: None,
        },
    ]))
    .unwrap();
    let image = nb.put_image(&png()).unwrap();
    (dir, nb, image)
}
fn set(nb: &Notebook, n: u128, image: Option<ImageRef>) -> Operation {
    Operation::SetImage {
        id: id(n),
        base_revision: nb.block(&id(n)).unwrap().revision,
        image,
    }
}
fn invalid(nb: &mut Notebook, op: Operation, expected: &str) {
    assert!(
        matches!(nb.apply(&batch(vec![op])), Err(Error::Validation { message, op_index: Some(0) }) if message == expected)
    );
}

#[test]
fn image_set_remove_restore_and_split_keep_identity() {
    let (_dir, mut nb, image) = setup();
    let op = set(&nb, 2, Some(image.clone()));
    nb.apply(&batch(vec![op])).unwrap();
    assert_eq!(nb.capabilities(&id(2)).unwrap().image, Some(image.clone()));
    assert!(
        nb.page(&id(1))
            .unwrap()
            .capabilities
            .iter()
            .any(|c| c.image.is_some())
    );
    let op = set(&nb, 2, None);
    nb.apply(&batch(vec![op])).unwrap();
    assert!(nb.capabilities(&id(2)).unwrap().image.is_none());
    let op = set(&nb, 2, Some(image.clone()));
    nb.apply(&batch(vec![op])).unwrap();
    let revision = nb.block(&id(2)).unwrap().revision;
    nb.apply(&batch(vec![Operation::Split {
        id: id(2),
        base_revision: revision,
        new_id: id(4),
        left: "Cap".into(),
        right: "tion".into(),
    }]))
    .unwrap();
    assert_eq!(nb.capabilities(&id(2)).unwrap().image, Some(image.clone()));
    assert!(nb.capabilities(&id(4)).unwrap().image.is_none());
    for (source, destination) in [(2, 3), (3, 2)] {
        let op = Operation::Merge {
            source_id: id(source),
            source_revision: nb.block(&id(source)).unwrap().revision,
            destination_id: id(destination),
            destination_revision: nb.block(&id(destination)).unwrap().revision,
        };
        invalid(&mut nb, op, "Image atoms can't be merged.");
    }
    let revision = nb.block(&id(2)).unwrap().revision;
    let receipt = nb
        .apply(&batch(vec![Operation::Delete {
            id: id(2),
            base_revision: revision,
        }]))
        .unwrap();
    nb.apply(&batch(vec![Operation::Restore {
        id: id(2),
        deletion_id: receipt.deletions[0].clone(),
        revision: revision + 1,
    }]))
    .unwrap();
    assert_eq!(nb.capabilities(&id(2)).unwrap().image, Some(image));
}
#[test]
fn image_validation_requires_outline_raster_metadata_and_local_bytes() {
    let (_dir, mut nb, image) = setup();
    let op = set(&nb, 1, Some(image.clone()));
    invalid(&mut nb, op, "Only an outline atom can hold an image.");
    for bad in [
        ImageRef {
            width: 0,
            ..image.clone()
        },
        ImageRef {
            height: 32769,
            ..image.clone()
        },
        ImageRef {
            media_type: "image/svg+xml".into(),
            ..image.clone()
        },
        ImageRef {
            sha256: "A".repeat(64),
            ..image.clone()
        },
    ] {
        let op = set(&nb, 2, Some(bad));
        invalid(&mut nb, op, "Choose a PNG, JPEG, WebP or GIF image.");
    }
    let op = set(
        &nb,
        2,
        Some(ImageRef {
            sha256: "0".repeat(64),
            ..image
        }),
    );
    invalid(&mut nb, op, "Upload the image before attaching it.");
    assert!(nb.put_image(b"<svg/>").is_err());
    assert!(nb.put_image(b"not an image").is_err());
}

#[test]
fn image_and_quoted_copy_are_mutually_exclusive() {
    let (_dir, mut nb, image) = setup();
    let quote = nb.quote_snapshot(&id(3), 123).unwrap();
    nb.apply(&batch(vec![
        Operation::EditText {
            id: id(2),
            base_revision: 1,
            text: format!("(({}))", id(3)),
        },
        Operation::SetQuote {
            id: id(2),
            base_revision: 2,
            quote: Some(quote.clone()),
        },
    ]))
    .unwrap();
    let op = set(&nb, 2, Some(image.clone()));
    invalid(&mut nb, op, "A quoted copy can't hold an image.");
    let revision = nb.block(&id(2)).unwrap().revision;
    nb.apply(&batch(vec![Operation::SetQuote {
        id: id(2),
        base_revision: revision,
        quote: None,
    }]))
    .unwrap();
    let op = set(&nb, 2, Some(image));
    nb.apply(&batch(vec![op])).unwrap();
    let op = Operation::SetQuote {
        id: id(2),
        base_revision: nb.block(&id(2)).unwrap().revision,
        quote: Some(quote),
    };
    invalid(&mut nb, op, "A quoted copy can't hold an image.");
}

#[test]
fn image_only_child_is_a_multiline_answer_and_changes_its_definition() {
    let (_dir, mut nb, image) = setup();
    nb.apply(&batch(vec![
        Operation::EditText {
            id: id(2),
            base_revision: 1,
            text: "What is shown? >>>".into(),
        },
        Operation::Insert {
            id: id(4),
            parent_id: id(2),
            after: None,
            text: String::new(),
            heading: None,
        },
        Operation::SetImage {
            id: id(4),
            base_revision: 1,
            image: Some(image.clone()),
        },
    ]))
    .unwrap();
    let card = nb.source_cards(&id(2)).unwrap().remove(0);
    assert_eq!(card.answer_blocks[0].image, Some(image));
    assert!(card.answer_blocks[0].text.is_empty());
    let op = set(&nb, 4, None);
    nb.apply(&batch(vec![op])).unwrap();
    assert!(!nb.card(&card.id).unwrap().active);
}
