use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read},
};

use roxmltree::{Document, Node};
use scraper::Html;
use tessera_core::library::{
    CreatorRole, ExtractedCreator, ExtractedDocument, ExtractedMetadata, ExtractedResource,
    PassageKind, SourceFormat, TocEntry,
};
use zip::ZipArchive;

use crate::{
    Error, Result,
    html::{Passages, plain, selector, text},
    location::{Base, Target, date, normalize},
};

const ENTRY_LIMIT: u64 = 64 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 512 * 1024 * 1024;

struct Archive<'a> {
    zip: ZipArchive<Cursor<&'a [u8]>>,
    inflated: u64,
}

fn malformed(message: impl ToString) -> Error {
    Error::Malformed {
        format: "epub",
        message: message.to_string(),
    }
}

fn member(archive: &mut Archive<'_>, path: &str) -> Result<Vec<u8>> {
    let file = archive.zip.by_name(path).map_err(malformed)?;
    if file.size() > ENTRY_LIMIT {
        return Err(malformed("entry exceeds 64 MiB"));
    }
    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.take(ENTRY_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(malformed)?;
    if bytes.len() as u64 > ENTRY_LIMIT {
        return Err(malformed("entry exceeds 64 MiB"));
    }
    archive.inflated += bytes.len() as u64;
    if archive.inflated > TOTAL_LIMIT {
        return Err(malformed("archive exceeds 512 MiB"));
    }
    Ok(bytes)
}

fn member_text(archive: &mut Archive<'_>, path: &str) -> Result<String> {
    String::from_utf8(member(archive, path)?).map_err(malformed)
}

fn xml(text: &str) -> Result<Document<'_>> {
    Document::parse_with_options(
        text,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        },
    )
    .map_err(malformed)
}

struct Item {
    id: String,
    path: String,
    media_type: String,
    properties: String,
}

impl Item {
    fn has(&self, property: &str) -> bool {
        self.properties
            .split_whitespace()
            .any(|value| value == property)
    }
}

struct Navigation {
    title: String,
    target: String,
    level: u8,
}

pub(crate) fn extract(bytes: &[u8]) -> Result<ExtractedDocument> {
    let mut archive = Archive {
        zip: ZipArchive::new(Cursor::new(bytes)).map_err(malformed)?,
        inflated: 0,
    };
    let mut total = 0u64;
    let mut names = HashSet::new();
    for index in 0..archive.zip.len() {
        let file = archive.zip.by_index_raw(index).map_err(malformed)?;
        if file.size() > ENTRY_LIMIT {
            return Err(malformed("entry exceeds 64 MiB"));
        }
        total = total
            .checked_add(file.size())
            .ok_or_else(|| malformed("archive size overflow"))?;
        if total > TOTAL_LIMIT {
            return Err(malformed("archive exceeds 512 MiB"));
        }
        if !names.insert(file.name().to_owned()) {
            return Err(malformed("duplicate archive entry"));
        }
    }
    let container = member_text(&mut archive, "META-INF/container.xml")?;
    let container = xml(&container)?;
    let mut rootfiles = container
        .descendants()
        .filter(|node| node.has_tag_name("rootfile"));
    let preferred = rootfiles
        .clone()
        .find(|node| node.attribute("media-type") == Some("application/oebps-package+xml"));
    let package_path = preferred
        .or_else(|| rootfiles.next())
        .and_then(|node| node.attribute("full-path"))
        .ok_or_else(|| malformed("container has no package path"))?;
    let package = member_text(&mut archive, package_path)?;
    let package = xml(&package)?;
    let root = package.root_element();
    if !root.has_tag_name("package") {
        return Err(malformed("OPF has no package element"));
    }
    let base = Base::Book(package_path.to_owned());
    let manifest = root
        .children()
        .find(|node| node.has_tag_name("manifest"))
        .ok_or_else(|| malformed("OPF has no manifest"))?;
    let items = manifest
        .children()
        .filter(|node| node.has_tag_name("item"))
        .filter_map(|node| {
            Some(Item {
                id: node.attribute("id")?.to_owned(),
                path: base.resource(node.attribute("href")?)?,
                media_type: node.attribute("media-type").unwrap_or("").to_owned(),
                properties: node.attribute("properties").unwrap_or("").to_owned(),
            })
        })
        .collect::<Vec<_>>();
    let by_id: HashMap<_, _> = items.iter().map(|item| (item.id.as_str(), item)).collect();
    let mut metadata = metadata(root);
    let cover_id = root
        .descendants()
        .find(|node| node.has_tag_name("meta") && node.attribute("name") == Some("cover"))
        .and_then(|node| node.attribute("content"));
    metadata.cover = items
        .iter()
        .find(|item| item.has("cover-image"))
        .or_else(|| cover_id.and_then(|id| by_id.get(id).copied()))
        .map(|item| item.path.clone());
    let spine = root
        .children()
        .find(|node| node.has_tag_name("spine"))
        .ok_or_else(|| malformed("OPF has no spine"))?;
    let mut navigation = Vec::new();
    if let Some(nav) = items.iter().find(|item| item.has("nav")) {
        navigation = nav_entries(&member_text(&mut archive, &nav.path)?, &nav.path);
    }
    if navigation.is_empty()
        && let Some(ncx) = spine
            .attribute("toc")
            .and_then(|id| by_id.get(id).copied())
            .or_else(|| {
                items
                    .iter()
                    .find(|item| item.media_type == "application/x-dtbncx+xml")
            })
    {
        navigation = ncx_entries(&member_text(&mut archive, &ncx.path)?, &ncx.path)?;
    }
    let referenced: HashSet<_> = navigation
        .iter()
        .map(|entry| entry.target.split('#').next().unwrap_or(""))
        .collect();
    let mut passages = Passages::default();
    let mut visited = HashSet::new();
    for entry in spine.children().filter(|node| node.has_tag_name("itemref")) {
        let item = entry
            .attribute("idref")
            .and_then(|id| by_id.get(id))
            .ok_or_else(|| malformed("spine item is absent from manifest"))?;
        if entry.attribute("linear") == Some("no") && !referenced.contains(item.path.as_str()) {
            continue;
        }
        if !visited.insert(item.path.as_str()) {
            continue;
        }
        let contents = member_text(&mut archive, &item.path)?;
        let document = Html::parse_document(&contents);
        let body = document
            .select(&selector("body"))
            .next()
            .unwrap_or_else(|| document.root_element());
        passages.read(body, &Base::Book(item.path.clone()));
    }
    if !passages
        .passages
        .iter()
        .any(|passage| passage.kind != PassageKind::Image && !passage.text.trim().is_empty())
    {
        return Err(Error::Empty("book"));
    }
    let toc = navigation
        .into_iter()
        .filter_map(|entry| {
            let passage = passages.resolve(&entry.target)?;
            Some(TocEntry {
                title: entry.title,
                locator: passage.locator.clone(),
                level: entry.level,
            })
        })
        .collect();
    passages.finish();
    let referenced: HashSet<_> = passages
        .passages
        .iter()
        .filter_map(|passage| passage.resource.as_deref())
        .chain(metadata.cover.as_deref())
        .collect();
    let mut resources = Vec::new();
    let mut included = HashSet::new();
    for item in &items {
        if item.media_type.starts_with("image/")
            && referenced.contains(item.path.as_str())
            && included.insert(&item.path)
        {
            resources.push(ExtractedResource {
                href: item.path.clone(),
                media_type: item.media_type.clone(),
                bytes: member(&mut archive, &item.path)?,
            });
        }
    }
    Ok(ExtractedDocument {
        format: SourceFormat::Epub,
        media_type: "application/epub+zip".to_owned(),
        metadata,
        toc,
        passages: passages.passages,
        resources,
    })
}

fn raw_node_text(node: Node<'_, '_>) -> String {
    let mut value = String::new();
    for child in node.descendants().filter(Node::is_text) {
        value.push_str(child.text().unwrap_or(""));
    }
    value
}

fn node_text(node: Node<'_, '_>) -> String {
    normalize(&raw_node_text(node))
}

fn metadata(root: Node<'_, '_>) -> ExtractedMetadata {
    let Some(metadata) = root.children().find(|node| node.has_tag_name("metadata")) else {
        return ExtractedMetadata::default();
    };
    let nodes = metadata
        .children()
        .filter(Node::is_element)
        .collect::<Vec<_>>();
    let dc = |node: &Node<'_, '_>, tag| {
        node.tag_name().name() == tag
            && node
                .tag_name()
                .namespace()
                .is_none_or(|namespace| namespace == "http://purl.org/dc/elements/1.1/")
    };
    let first = |tag| {
        nodes
            .iter()
            .find(|node| dc(node, tag))
            .map(|node| node_text(*node))
            .filter(|value| !value.is_empty())
    };
    let refined = |node: Node<'_, '_>, property: &str| {
        node.attribute("id")
            .map(|id| format!("#{id}"))
            .map_or_else(Vec::new, |id| {
                nodes
                    .iter()
                    .filter(|meta| {
                        meta.has_tag_name("meta")
                            && meta.attribute("refines") == Some(id.as_str())
                            && meta.attribute("property") == Some(property)
                    })
                    .map(|meta| node_text(*meta))
                    .collect::<Vec<_>>()
            })
    };
    let subtitle = nodes
        .iter()
        .filter(|node| dc(node, "title"))
        .skip(1)
        .find(|node| {
            refined(**node, "title-type")
                .iter()
                .any(|value| value == "subtitle")
        })
        .map(|node| node_text(*node));
    let mut creators = Vec::new();
    for node in nodes.iter().filter(|node| dc(node, "creator")) {
        let name = node_text(*node);
        if name.is_empty() {
            continue;
        }
        let mut roles = refined(*node, "role");
        if let Some(role) = node
            .attributes()
            .find(|attribute| attribute.name() == "role")
        {
            roles.push(role.value().to_owned());
        }
        if roles.is_empty() {
            roles.push("aut".to_owned());
        }
        for role in roles {
            let role = match role.as_str() {
                "aut" => CreatorRole::Author,
                "edt" => CreatorRole::Editor,
                "trl" => CreatorRole::Translator,
                _ => continue,
            };
            let creator = ExtractedCreator {
                name: name.clone(),
                role,
            };
            if !creators.contains(&creator) {
                creators.push(creator);
            }
        }
    }
    let unique_id = root.attribute("unique-identifier").and_then(|id| {
        nodes
            .iter()
            .find(|node| dc(node, "identifier") && node.attribute("id") == Some(id))
            .map(|node| raw_node_text(*node))
    });
    ExtractedMetadata {
        title: first("title"),
        subtitle,
        creators,
        published: nodes
            .iter()
            .filter(|node| dc(node, "date"))
            .find_map(|node| date(&node_text(*node))),
        publisher: first("publisher"),
        language: first("language"),
        identifiers: nodes
            .iter()
            .filter(|node| dc(node, "identifier"))
            .map(|node| raw_node_text(*node))
            .collect(),
        unique_id,
        description: first("description").map(|value| plain(&value)),
        ..Default::default()
    }
}

fn nav_entries(contents: &str, path: &str) -> Vec<Navigation> {
    let document = Html::parse_document(contents);
    let Some(nav) = document.select(&selector("nav")).find(|nav| {
        nav.value()
            .attr("epub:type")
            .is_some_and(|value| value.split_whitespace().any(|value| value == "toc"))
            || nav.value().attr("role") == Some("doc-toc")
    }) else {
        return Vec::new();
    };
    let base = Base::Book(path.to_owned());
    nav.select(&selector("a[href]"))
        .filter_map(|link| {
            let Target::Internal(target) = base.resolve(link.value().attr("href")?)? else {
                return None;
            };
            let level = link
                .ancestors()
                .take_while(|node| node.id() != nav.id())
                .filter_map(scraper::ElementRef::wrap)
                .filter(|node| matches!(node.value().name(), "ol" | "ul"))
                .count()
                .clamp(1, u8::MAX as usize) as u8;
            Some(Navigation {
                title: text(link),
                target,
                level,
            })
        })
        .collect()
}

fn ncx_entries(contents: &str, path: &str) -> Result<Vec<Navigation>> {
    let document = xml(contents)?;
    let base = Base::Book(path.to_owned());
    Ok(document
        .descendants()
        .filter(|node| node.has_tag_name("navPoint"))
        .filter_map(|node| {
            let src = node
                .children()
                .find(|child| child.has_tag_name("content"))?
                .attribute("src")?;
            let Target::Internal(target) = base.resolve(src)? else {
                return None;
            };
            let title = node
                .children()
                .find(|child| child.has_tag_name("navLabel"))
                .map(node_text)
                .unwrap_or_default();
            let level = node
                .ancestors()
                .filter(|node| node.has_tag_name("navPoint"))
                .count()
                .clamp(1, u8::MAX as usize) as u8;
            Some(Navigation {
                title,
                target,
                level,
            })
        })
        .collect())
}
