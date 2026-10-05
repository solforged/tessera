use std::collections::{HashMap, HashSet};

use scraper::{ElementRef, Html, Selector};
use tessera_core::library::{ExtractedPassage, Mark, MarkKind, PassageKind};

use crate::location::{Base, Target, normalize};

pub(crate) fn selector(value: &str) -> Selector {
    Selector::parse(value).expect("static HTML selector")
}

pub(crate) fn plain(value: &str) -> String {
    let document = Html::parse_fragment(value);
    normalize(&document.root_element().text().collect::<String>())
}

pub(crate) fn text(element: ElementRef<'_>) -> String {
    normalize(&element.text().collect::<String>())
}

pub(crate) fn is_note(element: ElementRef<'_>) -> bool {
    element.value().attr("epub:type").is_some_and(|value| {
        value.split_whitespace().any(|part| {
            matches!(
                part,
                "footnote" | "endnote" | "rearnote" | "footnotes" | "endnotes" | "rearnotes"
            )
        })
    }) || element
        .value()
        .attr("role")
        .is_some_and(|role| matches!(role, "doc-footnote" | "doc-endnote" | "doc-endnotes"))
        || element.value().classes().any(|class| {
            matches!(
                class,
                "footnote" | "footnotes" | "endnote" | "endnotes" | "footnotes-list"
            )
        })
}

pub(crate) fn noise(element: ElementRef<'_>, article: bool) -> bool {
    let value = element.value();
    if matches!(
        value.name(),
        "script"
            | "style"
            | "template"
            | "noscript"
            | "form"
            | "button"
            | "input"
            | "select"
            | "textarea"
    ) || value.attr("hidden").is_some()
        || value.attr("aria-hidden") == Some("true")
    {
        return true;
    }
    if !article || is_note(element) {
        return false;
    }
    matches!(value.name(), "nav" | "header" | "footer" | "aside")
        || value.attr("role").is_some_and(|role| {
            matches!(
                role,
                "navigation" | "banner" | "contentinfo" | "complementary"
            )
        })
        || value.classes().chain(value.attr("id")).any(|class| {
            class.split(['-', '_']).any(|part| {
                matches!(
                    part,
                    "nav"
                        | "navigation"
                        | "sidebar"
                        | "related"
                        | "share"
                        | "sharing"
                        | "newsletter"
                        | "social"
                        | "comments"
                        | "advert"
                        | "advertisement"
                        | "ads"
                        | "promo"
                        | "subscribe"
                )
            })
        })
}

#[derive(Clone, Copy, Default)]
struct Context {
    quote: bool,
    note: bool,
    list: u8,
    item: bool,
}

#[derive(Default)]
struct Text {
    value: String,
    units: u32,
    space: bool,
    marks: Vec<Mark>,
    active: Vec<usize>,
}

impl Text {
    fn push(&mut self, text: &str, code: bool) {
        for ch in text.chars() {
            if !code && ch.is_whitespace() {
                self.space = !self.value.is_empty();
                continue;
            }
            if self.space {
                self.value.push(' ');
                self.units += 1;
                self.space = false;
            }
            let start = self.units;
            self.value.push(ch);
            self.units += ch.len_utf16() as u32;
            for &index in &self.active {
                let mark = &mut self.marks[index];
                mark.start = mark.start.min(start);
                mark.end = self.units;
            }
        }
    }

    fn start(&mut self, kind: MarkKind) {
        self.active.push(self.marks.len());
        self.marks.push(Mark {
            start: u32::MAX,
            end: 0,
            kind,
        });
    }

    fn take(&mut self) -> Self {
        let mut next = Self::default();
        for &index in &self.active {
            next.start(self.marks[index].kind.clone());
        }
        std::mem::replace(self, next)
    }
}

struct Flow<'a> {
    kind: PassageKind,
    level: Option<u8>,
    anchor: Option<&'a str>,
    buffer: Text,
    flatten: bool,
    code: bool,
}

#[derive(Default)]
pub(crate) struct Passages {
    pub(crate) passages: Vec<ExtractedPassage>,
    targets: HashMap<String, usize>,
    locators: HashSet<String>,
    file_index: usize,
}

impl Passages {
    pub(crate) fn read(&mut self, root: ElementRef<'_>, base: &Base) {
        self.file_index = if matches!(base, Base::Book(_)) {
            0
        } else {
            self.passages.len()
        };
        self.targets
            .entry(base.file().to_owned())
            .or_insert(self.passages.len());
        self.walk(root, base, Context::default());
        // Empty trailing anchors must not spill into the next spine document.
        self.targets.retain(|_, index| *index < self.passages.len());
    }

    fn target(&mut self, id: &str, base: &Base, index: usize) {
        self.targets
            .entry(format!("{}#{id}", base.file()))
            .or_insert(index);
    }

    fn walk(&mut self, element: ElementRef<'_>, base: &Base, mut context: Context) {
        let article = matches!(base, Base::Article { .. });
        if noise(element, article) {
            return;
        }
        if let Some(id) = element.value().attr("id") {
            self.target(id, base, self.passages.len());
        }
        let tag = element.value().name();
        context.note |= is_note(element) || (!article && tag == "aside");
        context.quote |= tag == "blockquote";
        context.item |= tag == "li";
        if matches!(tag, "ol" | "ul") {
            context.list = context.list.saturating_add(1);
        }
        if matches!(tag, "img" | "image") {
            self.image(element, base);
            return;
        }
        if tag == "svg" {
            for image in element.select(&selector("image")) {
                if let Some(id) = image.value().attr("id") {
                    self.target(id, base, self.passages.len());
                }
                self.image(image, base);
            }
            return;
        }
        let heading = match tag {
            "h1" => Some(1),
            "h2" => Some(2),
            "h3" => Some(3),
            "h4" => Some(4),
            "h5" => Some(5),
            "h6" => Some(6),
            _ => None,
        };
        let kind = if context.note && (is_block(tag) || has_direct_text(element)) {
            Some(PassageKind::Footnote)
        } else if heading.is_some() {
            Some(PassageKind::Heading)
        } else if tag == "pre" {
            Some(PassageKind::Code)
        } else if tag == "li" {
            Some(PassageKind::ListItem)
        } else if tag == "tr" || tag == "p" || has_direct_text(element) {
            Some(if context.item {
                PassageKind::ListItem
            } else if context.quote {
                PassageKind::Quote
            } else {
                PassageKind::Paragraph
            })
        } else {
            None
        };
        if let Some(kind) = kind {
            let level = if kind == PassageKind::Heading {
                heading
            } else if kind == PassageKind::ListItem {
                Some(context.list.max(1))
            } else {
                None
            };
            let mut flow = Flow {
                kind,
                level,
                anchor: element.value().attr("id"),
                buffer: Text::default(),
                flatten: matches!(tag, "pre" | "tr"),
                code: tag == "pre",
            };
            if tag == "tr" {
                for (index, cell) in element
                    .children()
                    .filter_map(ElementRef::wrap)
                    .filter(|cell| matches!(cell.value().name(), "td" | "th"))
                    .enumerate()
                {
                    if index > 0 {
                        flow.buffer.push(" · ", false);
                    }
                    self.inline(cell, base, context, &mut flow);
                }
            } else {
                self.children(element, base, context, &mut flow);
            }
            self.emit(&mut flow, base);
        } else {
            for child in element.children().filter_map(ElementRef::wrap) {
                self.walk(child, base, context);
            }
        }
    }

    fn children(
        &mut self,
        element: ElementRef<'_>,
        base: &Base,
        context: Context,
        flow: &mut Flow<'_>,
    ) {
        for child in element.children() {
            if let Some(text) = child.value().as_text() {
                flow.buffer.push(text, flow.code);
            } else if let Some(child) = ElementRef::wrap(child) {
                self.inline(child, base, context, flow);
            }
        }
    }

    fn inline(
        &mut self,
        element: ElementRef<'_>,
        base: &Base,
        context: Context,
        flow: &mut Flow<'_>,
    ) {
        if noise(element, matches!(base, Base::Article { .. })) {
            return;
        }
        let tag = element.value().name();
        if !flow.flatten
            && (is_block(tag) || matches!(tag, "img" | "image" | "svg") || is_note(element))
        {
            self.emit(flow, base);
            self.walk(element, base, context);
            return;
        }
        if let Some(id) = element.value().attr("id") {
            self.target(id, base, self.passages.len());
        }
        if tag == "br" {
            flow.buffer
                .push(if flow.code { "\n" } else { " " }, flow.code);
        }
        let mark = match tag {
            "em" | "i" => Some(MarkKind::Emphasis),
            "strong" | "b" => Some(MarkKind::Strong),
            "code" if !flow.code => Some(MarkKind::Code),
            "a" => element
                .value()
                .attr("href")
                .and_then(|href| base.resolve(href))
                .map(|target| match target {
                    Target::External(href) => MarkKind::Link { href },
                    Target::Internal(locator) => {
                        if element
                            .value()
                            .attr("epub:type")
                            .is_some_and(|v| v.split_whitespace().any(|v| v == "noteref"))
                            || element.value().attr("role") == Some("doc-noteref")
                        {
                            MarkKind::NoteRef { locator }
                        } else {
                            MarkKind::Internal { locator }
                        }
                    }
                }),
            _ => None,
        };
        let marked = mark.is_some();
        if let Some(mark) = mark {
            flow.buffer.start(mark);
        }
        self.children(element, base, context, flow);
        if marked {
            flow.buffer.active.pop();
        }
    }

    fn emit(&mut self, flow: &mut Flow<'_>, base: &Base) {
        if flow.buffer.value.trim().is_empty() {
            return;
        }
        let mut text = flow.buffer.take();
        text.marks.retain(|mark| mark.start < mark.end);
        let anchor = flow.anchor.take().map(str::to_owned);
        let locator = self.locator(base, anchor.as_deref());
        self.passages.push(ExtractedPassage {
            kind: flow.kind,
            level: flow.level,
            text: text.value,
            locator,
            anchor,
            resource: None,
            marks: text.marks,
        });
    }

    fn locator(&mut self, base: &Base, anchor: Option<&str>) -> String {
        self.file_index += 1;
        let initial = match anchor {
            Some(id) => format!("{}#{id}", base.file()),
            None => format!("{}#p{}", base.file(), self.file_index),
        };
        let mut locator = initial.clone();
        let mut duplicate = 2;
        while !self.locators.insert(locator.clone()) {
            locator = format!("{initial}~{duplicate}");
            duplicate += 1;
        }
        locator
    }

    fn image(&mut self, element: ElementRef<'_>, base: &Base) {
        let value = element.value();
        let srcset = value.attr("srcset").and_then(|set| {
            set.split(',')
                .filter_map(|candidate| {
                    let mut parts = candidate.split_whitespace();
                    let url = parts.next()?;
                    let score = parts
                        .next()
                        .and_then(|size| size.trim_end_matches(['w', 'x']).parse::<f64>().ok())
                        .unwrap_or(1.0);
                    Some((url, score))
                })
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(url, _)| url)
        });
        let resource = srcset
            .or_else(|| value.attr("src"))
            .or_else(|| value.attr("href"))
            .or_else(|| {
                value.attrs().find_map(|(key, value)| {
                    (key == "href" || key == "xlink:href").then_some(value)
                })
            })
            .and_then(|href| base.resource(href));
        let anchor = value.attr("id").map(str::to_owned);
        let locator = self.locator(base, anchor.as_deref());
        let alt = value
            .attr("alt")
            .or_else(|| value.attr("aria-label"))
            .map(normalize)
            .or_else(|| {
                element
                    .ancestors()
                    .filter_map(ElementRef::wrap)
                    .find(|element| element.value().name() == "svg")
                    .and_then(|svg| {
                        svg.value()
                            .attr("aria-label")
                            .map(normalize)
                            .or_else(|| svg.select(&selector("title")).next().map(text))
                    })
            })
            .unwrap_or_default();
        self.passages.push(ExtractedPassage {
            kind: PassageKind::Image,
            level: None,
            text: alt,
            locator,
            anchor,
            resource,
            marks: Vec::new(),
        });
    }

    pub(crate) fn resolve(&self, target: &str) -> Option<&ExtractedPassage> {
        self.targets
            .get(target)
            .or_else(|| {
                target
                    .split_once('#')
                    .and_then(|(file, _)| self.targets.get(file))
            })
            .and_then(|&index| self.passages.get(index))
    }

    pub(crate) fn finish(&mut self) {
        for index in 0..self.passages.len() {
            let mut marks = std::mem::take(&mut self.passages[index].marks);
            marks.retain_mut(|mark| {
                let (target, explicit_note) = match &mark.kind {
                    MarkKind::Internal { locator } => (locator, false),
                    MarkKind::NoteRef { locator } => (locator, true),
                    _ => return true,
                };
                let Some(passage) = self.resolve(target) else {
                    return false;
                };
                mark.kind = if explicit_note || passage.kind == PassageKind::Footnote {
                    MarkKind::NoteRef {
                        locator: passage.locator.clone(),
                    }
                } else {
                    MarkKind::Internal {
                        locator: passage.locator.clone(),
                    }
                };
                true
            });
            self.passages[index].marks = marks;
        }
    }
}

fn is_block(tag: &str) -> bool {
    matches!(
        tag,
        "h1" | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "p"
            | "div"
            | "blockquote"
            | "li"
            | "ol"
            | "ul"
            | "pre"
            | "table"
            | "tr"
            | "section"
            | "article"
            | "main"
            | "aside"
            | "figure"
            | "figcaption"
            | "dl"
            | "dt"
            | "dd"
    )
}

fn has_direct_text(element: ElementRef<'_>) -> bool {
    element.children().any(|child| {
        child
            .value()
            .as_text()
            .is_some_and(|text| !text.trim().is_empty())
            || ElementRef::wrap(child).is_some_and(|child| {
                !is_block(child.value().name())
                    && !matches!(child.value().name(), "img" | "image" | "svg")
                    && !noise(child, false)
                    && child.text().any(|text| !text.trim().is_empty())
            })
    })
}
